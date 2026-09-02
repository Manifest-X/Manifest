// @vitest-environment happy-dom
/**
 * Operator memo — `$x.<source>.$search / $query / $route` return the same
 * identity for equal arguments while `_v[source]` is unchanged, and recompute
 * exactly once when the source lands, a local write bumps it, or the
 * arguments differ (turnkey; no author annotation).
 *
 * Same vm-context loader as data-landing.test.js: real subscripts on a real
 * Alpine 3.17.1. Recompute counts come from a getter spy on one row's `name`.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, '../src/scripts/data')
const SUBSCRIPTS = [
    'core/manifest.data.store.js',
    'shared/manifest.data.mutations.js',
    'shared/manifest.data.proxies.core.js',
    'shared/manifest.data.proxies.cache.js',
    'shared/proxies/creation/manifest.data.proxies.helpers.js',
    'shared/proxies/creation/manifest.data.proxies.array.js',
    'shared/proxies/creation/manifest.data.proxies.route.js',
    'shared/manifest.data.proxies.magic.state.js',
    'shared/manifest.data.proxies.magic.core.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const released = []
const tick = () => Alpine.nextTick()

function load() {
    window.Alpine = Alpine
    const ctx = {
        window, document, Alpine, console, setTimeout, clearTimeout,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    const store = window.ManifestDataStore
    store.initializeStore()
    const loadDataSource = async () => null
    window.ManifestDataMain = { loadDataSource, _loadDataSource: loadDataSource }
    window.ManifestDataProxies.registerXMagicMethod(loadDataSource)
    const $x = () => window._$xProxyFactory()
    const effect = (fn) => { const e = Alpine.effect(fn); released.push(e); return e }
    // Getter spy on a raw row's `name`: every operator pass over the source reads it once
    const spy = (source, i) => {
        const raw = store.getRawData(source)[i]
        let reads = 0, value = raw.name
        Object.defineProperty(raw, 'name', { enumerable: true, configurable: true, get() { reads++; return value }, set(v) { value = v } })
        return () => reads
    }
    return { store, mut: window.ManifestDataMutations, $x, effect, spy, data: () => Alpine.store('data') }
}

afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = '' })

const rows = (prefix, n, from = 0) => Array.from({ length: n }, (_, i) => ({ $id: `${prefix}${from + i}`, name: `${prefix} ${from + i}`, n: from + i }))

async function seed() {
    const ctx = load()
    await ctx.store.landRows('chats', rows('c', 5), { mode: 'replace' })
    await ctx.store.landRows('contacts', rows('p', 3), { mode: 'replace' })
    return ctx
}

describe('$search memo', () => {
    it('equal args on an unchanged source: same identity, one compute across two bindings', async () => {
        const { $x, effect, spy } = await seed()
        const reads = spy('chats', 0)
        let a, b
        effect(() => { a = $x().chats.$search('c 1', 'name') })
        effect(() => { b = $x().chats.$search('c 1', 'name') })
        expect(a).toBe(b)
        expect(a.map(r => r.$id)).toEqual(['c1'])
        expect(reads()).toBe(1)
        expect($x().chats.$search('c 1', 'name')).toBe(a)
        expect(reads()).toBe(1)
    })

    it('different args produce a different result', async () => {
        const { $x } = await seed()
        const a = $x().chats.$search('c 1', 'name')
        const b = $x().chats.$search('c 2', 'name')
        const c = $x().chats.$search('c 1', 'n')
        expect(a).not.toBe(b)
        expect(a).not.toBe(c)
        expect(b.map(r => r.$id)).toEqual(['c2'])
    })

    it('a landing to the source recomputes once (new identity); an unrelated landing does not', async () => {
        const { store, $x, effect, spy } = await seed()
        const reads = spy('chats', 0)
        let a, b, runsA = 0, runsB = 0
        effect(() => { runsA++; a = $x().chats.$search('c', 'name') })
        effect(() => { runsB++; b = $x().chats.$search('c', 'name') })
        const first = a
        expect(reads()).toBe(1)
        await store.landRows('chats', rows('c', 1, 5), { mode: 'append' })
        await tick()
        expect(runsA).toBe(2)
        expect(runsB).toBe(2)
        expect(reads()).toBe(2)
        expect(a).not.toBe(first)
        expect(a).toBe(b)
        expect(a.length).toBe(6)
        await store.landRows('contacts', rows('p', 1, 3), { mode: 'append' })
        await tick()
        expect(runsA).toBe(2)
        expect(runsB).toBe(2)
        expect(reads()).toBe(2)
        expect($x().chats.$search('c', 'name')).toBe(a)
    })

    it('a local write to the source recomputes once', async () => {
        const { mut, $x, effect, spy } = await seed()
        const reads = spy('chats', 0)
        let a
        effect(() => { a = $x().chats.$search('c', 'name') })
        const first = a
        mut.updateEntryInStore('chats', 'c2', { name: 'renamed' })
        await tick()
        expect(reads()).toBe(2)
        expect(a).not.toBe(first)
        expect(a.map(r => r.$id)).toEqual(['c0', 'c1', 'c3', 'c4'])
        expect($x().chats.$search('c', 'name')).toBe(a)
        expect(reads()).toBe(2)
    })

    it('weighted mode is cached; key is insensitive to weight-object key order', async () => {
        const { $x, spy } = await seed()
        const reads = spy('chats', 0)
        const a = $x().chats.$search('c', { name: 3, n: 1 })
        expect($x().chats.$search('c', { name: 3, n: 1 })).toBe(a)
        expect($x().chats.$search('c', { n: 1, name: 3 })).toBe(a)
        expect(reads()).toBe(1)
        expect(a.length).toBe(5)
    })

    it('an empty term still returns the source array itself', async () => {
        const { $x, data } = await seed()
        expect(Alpine.raw($x().chats.$search('', 'name'))).toBe(Alpine.raw(data().chats))
    })
})

describe('$query memo (local sources)', () => {
    it('equal query lists share one result; different lists do not', async () => {
        const { $x, spy } = await seed()
        const reads = spy('chats', 0)
        const q = [['contains', 'name', 'c'], ['orderDesc', 'n'], ['limit', 2]]
        const a = $x().chats.$query(q)
        expect($x().chats.$query([['contains', 'name', 'c'], ['orderDesc', 'n'], ['limit', 2]])).toBe(a)
        expect(a.map(r => r.$id)).toEqual(['c4', 'c3'])
        expect(reads()).toBe(2) // `contains` reads the field twice per pass; one pass
        expect($x().chats.$query([['contains', 'name', 'c'], ['orderAsc', 'n'], ['limit', 2]])).not.toBe(a)
        expect(reads()).toBe(4)
    })

    it('invalidates on a landing to its source only', async () => {
        const { store, $x } = await seed()
        const a = $x().chats.$query([['orderDesc', 'n']])
        await store.landRows('contacts', rows('p', 1, 3), { mode: 'append' })
        expect($x().chats.$query([['orderDesc', 'n']])).toBe(a)
        await store.landRows('chats', rows('c', 1, 5), { mode: 'append' })
        const b = $x().chats.$query([['orderDesc', 'n']])
        expect(b).not.toBe(a)
        expect(b[0].$id).toBe('c5')
    })

    it('orderRandom is never memoized', async () => {
        const { $x } = await seed()
        const a = $x().chats.$query([['orderRandom']])
        expect($x().chats.$query([['orderRandom']])).not.toBe(a)
    })
})

describe('chaining', () => {
    it('each step is cached against the parent result identity', async () => {
        const { store, $x, spy } = await seed()
        const reads = spy('chats', 0)
        const s = $x().chats.$search('c', 'name')
        const q = s.$query([['orderDesc', 'n'], ['limit', 2]])
        expect($x().chats.$search('c', 'name')).toBe(s)
        expect($x().chats.$search('c', 'name').$query([['orderDesc', 'n'], ['limit', 2]])).toBe(q)
        expect(q.map(r => r.$id)).toEqual(['c4', 'c3'])
        const qs = $x().chats.$query([['limit', 3]]).$search('c 2', 'name')
        expect($x().chats.$query([['limit', 3]]).$search('c 2', 'name')).toBe(qs)
        expect(reads()).toBe(2) // one $search pass + one chained $search pass (the $query steps never read `name`)
        await store.landRows('chats', rows('c', 1, 5), { mode: 'append' })
        const s2 = $x().chats.$search('c', 'name')
        expect(s2).not.toBe(s)
        expect(s2.$query([['orderDesc', 'n'], ['limit', 2]])[0].$id).toBe('c5')
    })
})

describe('$route memo', () => {
    it('is cached per path and invalidated by a landing', async () => {
        const { store, $x } = await seed()
        const a = $x().chats.$route('slug')
        expect($x().chats.$route('slug')).toBe(a)
        expect($x().chats.$route('other')).not.toBe(a)
        const bare = $x().chats.$route()
        expect($x().chats.$route()).toBe(bare)
        await store.landRows('chats', rows('c', 1, 5), { mode: 'append' })
        expect($x().chats.$route('other')).not.toBe(a)
    })
})

describe('fall-through and bounds', () => {
    it('arguments that cannot be stringified deterministically are not cached', async () => {
        const { $x } = await seed()
        const fn = () => 1
        const a = $x().chats.$query([['notEqual', 'name', fn]])
        expect($x().chats.$query([['notEqual', 'name', fn]])).not.toBe(a)
        const sym = Symbol('s')
        const b = $x().chats.$search('c', sym)
        expect($x().chats.$search('c', sym)).not.toBe(b)
    })

    it('arrays without a source version are not cached', async () => {
        const { store } = await seed()
        const arr = rows('g', 3)
        window.ManifestDataProxies.attachArrayMethods(arr, 'ghost', async () => null)
        expect(store.getRawData('ghost')).toBeUndefined()
        const a = arr.$search('g', 'name')
        expect(arr.$search('g', 'name')).not.toBe(a)
        expect(a.length).toBe(3)
    })

    it('LRU keeps the 8 most recent keys per array', async () => {
        const { $x } = await seed()
        const first = $x().chats.$search('c 0', 'name')
        const seen = []
        for (let i = 1; i <= 7; i++) seen.push($x().chats.$search(`c ${i}`, 'name'))
        expect($x().chats.$search('c 0', 'name')).toBe(first) // 8 keys: still cached
        $x().chats.$search('c 8', 'name') // 9th key evicts the least recent: 'c 1'
        expect($x().chats.$search('c 0', 'name')).toBe(first)
        expect($x().chats.$search('c 7', 'name')).toBe(seen[6])
        expect($x().chats.$search('c 1', 'name')).not.toBe(seen[0])
    })
})

describe('bindings', () => {
    it('an x-for over $search renders, keeps row elements on a landing, and follows a row field write', async () => {
        const { store, mut } = await seed()
        document.body.innerHTML = `<div x-data><template x-for="r in $x.chats.$search('c', 'name')" :key="r.$id"><span x-text="r.name"></span></template></div>`
        Alpine.start()
        await tick()
        const spans = () => Array.from(document.querySelectorAll('span'))
        expect(spans().map(s => s.textContent)).toEqual(['c 0', 'c 1', 'c 2', 'c 3', 'c 4'])
        const el0 = spans()[0]
        await store.landRows('chats', rows('c', 1, 5), { mode: 'append' })
        await tick()
        expect(spans().length).toBe(6)
        expect(spans()[0]).toBe(el0)
        mut.updateEntryInStore('chats', 'c0', { name: 'c zero' })
        await tick()
        expect(spans()[0].textContent).toBe('c zero')
        Alpine.destroyTree(document.body.firstElementChild)
    })
})
