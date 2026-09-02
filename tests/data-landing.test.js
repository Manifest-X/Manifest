// @vitest-environment happy-dom
/**
 * P6 — the `$x` landing model (PERF-PRIMITIVES-DESIGN.md §5).
 *
 * Loads the real data subscripts into a vm context that shares happy-dom's
 * window with a real Alpine 3.17.1 (pinned devDependency; the browser build
 * ships from CDN), so `Alpine.store` / `Alpine.effect` / `$x` proxy reads use
 * the same reactivity engine as production.
 *
 * Covers: per-source versioning (a `chats` read does not subscribe to
 * `contacts`), landing coalescing (N page landings in one frame → one store
 * write), identity-preserving upsert (rows and the source array survive a
 * landing), local-last ordering, lazy `$x.all`, the stuck-binding hammer, and
 * Playcom's same-tick list: optimistic write → immediate dependent read,
 * `$nextTick` DOM read after a state write, read-modify-write on a blob field,
 * and a route/show flip rendering in one flush.
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
const frame = () => new Promise(r => setTimeout(r, 80))

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
    return { store, mut: window.ManifestDataMutations, $x, effect, data: () => Alpine.store('data') }
}

afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = '' })

const rows = (prefix, n, from = 0) => Array.from({ length: n }, (_, i) => ({ $id: `${prefix}${from + i}`, name: `${prefix} ${from + i}`, n: from + i }))

describe('per-source versioning', () => {
    it('a landing for source A does not re-run an effect that only reads source B', async () => {
        const { store, $x, effect } = load()
        await store.landRows('a', rows('a', 2), { mode: 'replace' })
        await store.landRows('b', rows('b', 2), { mode: 'replace' })
        let runs = 0
        effect(() => { runs++; void $x().b.length })
        expect(runs).toBe(1)
        await store.landRows('a', rows('a', 3, 2), { mode: 'append' })
        await tick()
        expect(runs).toBe(1)
        await store.landRows('b', rows('b', 1, 2), { mode: 'append' })
        await tick()
        expect(runs).toBe(2)
    })

    it('a `$x` read subscribes to _v[source], never to the legacy _dataVersion', async () => {
        const { store, $x, effect, data } = load()
        await store.landRows('b', rows('b', 1), { mode: 'replace' })
        let runs = 0
        effect(() => { runs++; void $x().b.length })
        data()._dataVersion++
        await tick()
        expect(runs).toBe(1)
        expect(data()._v.b).toBe(1)
    })

    it('_dataVersion still bumps once per flush for external readers', async () => {
        const { store, effect, data } = load()
        let runs = 0
        effect(() => { runs++; void data()._dataVersion })
        await Promise.all([store.landRows('a', rows('a', 1)), store.landRows('b', rows('b', 1))])
        await tick()
        expect(runs).toBe(2)
    })

    it('only load completions arm the post-settle hammer; realtime-shaped landings do not', async () => {
        const { store, data } = load()
        await store.landRows('feed', rows('r', 2), { mode: 'replace', loading: false, error: null, ready: true })
        await new Promise(r => setTimeout(r, 260)) // render-ready (150ms) + hammer (50ms)
        const afterLoad = data()._v.feed
        expect(afterLoad).toBe(2) // landing + hammer
        await store.landRows('feed', [{ $id: 'r0', opens: 1 }], { mode: 'append' })
        await new Promise(r => setTimeout(r, 260))
        expect(data()._v.feed).toBe(afterLoad + 1) // landing only, no hammer
    })

    it('bumpAllVersions re-runs every `$x` reader (stuck-binding hammer, narrowed)', async () => {
        const { store, $x, effect } = load()
        await store.landRows('a', rows('a', 1))
        let runs = 0
        effect(() => { runs++; void $x().a.length })
        store.bumpAllVersions()
        await tick()
        expect(runs).toBe(2)
    })
})

describe('landing coalescing', () => {
    it('N paged landings arriving in one frame produce ONE store write', async () => {
        const { store, $x, effect, data } = load()
        await store.landRows('chats', rows('c', 100), { mode: 'replace' })
        let runs = 0
        effect(() => { runs++; void $x().chats.length })
        const v = data()._v.chats
        const pages = []
        for (let p = 1; p <= 5; p++) pages.push(store.landRows('chats', rows('c', 100, p * 100), { mode: 'append' }))
        expect($x().chats.length).toBe(100) // buffered, not yet applied
        await Promise.all(pages)
        await tick()
        expect($x().chats.length).toBe(600)
        expect(data()._v.chats).toBe(v + 1)
        expect(runs).toBe(2)
    })

    it('landings within one flush apply in arrival order', async () => {
        const { store, $x } = load()
        store.landRows('chats', [{ $id: '1', v: 'first' }], { mode: 'replace' })
        store.landRows('chats', [{ $id: '1', v: 'second' }], { mode: 'append' })
        await store.landRows('chats', [{ $id: '1', v: 'third' }, { $id: '2', v: 'x' }], { mode: 'append' })
        expect($x().chats.map(r => r.v)).toEqual(['third', 'x'])
    })

    it('landRemove drops rows by $id inside the same coalesced flush', async () => {
        const { store, $x } = load()
        await store.landRows('chats', rows('c', 3), { mode: 'replace' })
        store.landRows('chats', rows('c', 1, 3), { mode: 'append' })
        await store.landRemove('chats', ['c1'])
        expect($x().chats.map(r => r.$id)).toEqual(['c0', 'c2', 'c3'])
    })

    it('the landing promise resolves after the write is visible', async () => {
        const { store, $x } = load()
        const p = store.landRows('chats', rows('c', 1), { mode: 'replace' })
        expect($x().chats.length).toBe(0)
        await p
        expect($x().chats.length).toBe(1)
    })
})

describe('identity-preserving upsert', () => {
    it('rows survive a replace landing: same reference, fields merged', async () => {
        const { store, $x } = load()
        await store.landRows('chats', [{ $id: '1', name: 'a', n: 1, tags: ['x'] }], { mode: 'replace' })
        const before = $x().chats[0]
        const tagsBefore = before.tags
        await store.landRows('chats', [{ $id: '1', name: 'b', tags: ['x'] }], { mode: 'replace' })
        const after = $x().chats[0]
        expect(after).toBe(before)
        expect(after.name).toBe('b')
        expect(after.n).toBe(1)
        expect(after.tags).toBe(tagsBefore) // equal primitive list → not reassigned
    })

    it('the source array keeps its identity on append; only new rows are created', async () => {
        const { store, data } = load()
        await store.landRows('chats', rows('c', 2), { mode: 'replace' })
        const arr = data().chats
        const r0 = arr[0]
        await store.landRows('chats', [{ $id: 'c1', name: 'renamed' }, ...rows('c', 2, 2)], { mode: 'append' })
        expect(data().chats).toBe(arr)
        expect(arr.length).toBe(4)
        expect(arr[0]).toBe(r0)
        expect(arr[1].name).toBe('renamed')
    })

    it('a replace landing with identical membership does not touch the array', async () => {
        const { store, effect, data } = load()
        await store.landRows('chats', rows('c', 3), { mode: 'replace' })
        let runs = 0
        effect(() => { runs++; void data().chats.length })
        await store.landRows('chats', rows('c', 3), { mode: 'replace' })
        await tick()
        expect(runs).toBe(1)
    })

    it('a replace landing drops rows missing from the result and keeps server order', async () => {
        const { store, $x } = load()
        await store.landRows('chats', rows('c', 3), { mode: 'replace' })
        const c2 = $x().chats[2]
        await store.landRows('chats', [{ $id: 'c2' }, { $id: 'c0' }], { mode: 'replace' })
        expect($x().chats.map(r => r.$id)).toEqual(['c2', 'c0'])
        expect($x().chats[0]).toBe(c2)
    })

    it('rawDataStore and the store share one array after a landing', async () => {
        const { store, data } = load()
        await store.landRows('chats', rows('c', 2), { mode: 'replace' })
        expect(store.getRawData('chats')).toBe(Alpine.raw(data().chats))
        await store.landRows('chats', rows('c', 1, 2), { mode: 'append' })
        expect(store.getRawData('chats').length).toBe(3)
    })

    it('property-grain: a binding holding a row (x-for child shape) re-runs only when its field lands', async () => {
        const { store, $x, effect } = load()
        await store.landRows('chats', [{ $id: '1', name: 'a', n: 1 }], { mode: 'replace' })
        const row = $x().chats[0]
        let runs = 0
        effect(() => { runs++; void row.name })
        await store.landRows('chats', [{ $id: '1', n: 2 }], { mode: 'append' })
        await tick()
        expect(runs).toBe(1)
        await store.landRows('chats', [{ $id: '1', name: 'b' }], { mode: 'append' })
        await tick()
        expect(runs).toBe(2)
        expect(row.n).toBe(2)
    })
})

describe('local writes stay synchronous (read-your-writes)', () => {
    it('optimistic write then immediate dependent read', async () => {
        const { store, mut, $x } = load()
        await store.landRows('chats', rows('c', 2), { mode: 'replace' })
        expect(mut.addEntryToStore('chats', { $id: 'tmp1', name: 'draft' })).toBe(true)
        expect($x().chats.find(r => r.$id === 'tmp1').name).toBe('draft')
        expect(mut.updateEntryInStore('chats', 'tmp1', { name: 'edited' })).toBe(true)
        expect($x().chats.find(r => r.$id === 'tmp1').name).toBe('edited')
        expect(mut.removeEntryFromStore('chats', 'tmp1').originalEntry.$id).toBe('tmp1')
        expect($x().chats.some(r => r.$id === 'tmp1')).toBe(false)
    })

    it('local update keeps row identity and bumps the source version', async () => {
        const { store, mut, $x, data } = load()
        await store.landRows('chats', rows('c', 1), { mode: 'replace' })
        const row = $x().chats[0]
        const v = data()._v.chats
        mut.updateEntryInStore('chats', 'c0', { name: 'z' })
        expect($x().chats[0]).toBe(row)
        expect(row.name).toBe('z')
        expect(data()._v.chats).toBe(v + 1)
    })

    it('read-modify-write chain on a blob field sees its own prior write', async () => {
        const { store, mut, $x } = load()
        await store.landRows('docs', [{ $id: 'd', blob: { a: 1 } }], { mode: 'replace' })
        const r1 = $x().docs.find(d => d.$id === 'd')
        mut.updateEntryInStore('docs', 'd', { blob: { ...r1.blob, b: 2 } })
        const r2 = $x().docs.find(d => d.$id === 'd')
        mut.updateEntryInStore('docs', 'd', { blob: { ...r2.blob, c: 3 } })
        expect($x().docs.find(d => d.$id === 'd').blob).toEqual({ a: 1, b: 2, c: 3 })
        expect(r2).toBe(r1)
    })

    it('two local writes in one tick render in ONE flush', async () => {
        const { store, mut, $x, effect } = load()
        await Promise.all([store.landRows('chats', rows('c', 1)), store.landRows('flags', [{ $id: 'f', open: false }])])
        let runs = 0
        let seen = null
        effect(() => { runs++; seen = [$x().chats.length, $x().flags[0].open] })
        mut.addEntryToStore('chats', { $id: 'c9' })
        mut.updateEntryInStore('flags', 'f', { open: true })
        await tick()
        expect(runs).toBe(2)
        expect(seen).toEqual([2, true])
    })

    it('a local write racing a landing for the same $id wins, landing fields merged beneath', async () => {
        const { store, mut, $x } = load()
        await store.landRows('chats', [{ $id: '1', a: 0, b: 0 }], { mode: 'replace' })
        const p = store.landRows('chats', [{ $id: '1', a: 1, b: 2 }], { mode: 'append' })
        mut.updateEntryInStore('chats', '1', { a: 5 })
        expect($x().chats[0].a).toBe(5)
        await p
        expect($x().chats[0].a).toBe(5)
        expect($x().chats[0].b).toBe(2)
    })

    it('a local delete racing a landing that re-sends the row wins', async () => {
        const { store, mut, $x } = load()
        await store.landRows('chats', rows('c', 2), { mode: 'replace' })
        const p = store.landRows('chats', [{ $id: 'c1', name: 'echo' }], { mode: 'append' })
        mut.removeEntryFromStore('chats', 'c1')
        await p
        expect($x().chats.map(r => r.$id)).toEqual(['c0'])
    })

    it('a rollback (re-add after delete) racing a landing keeps the restored row', async () => {
        const { store, mut, $x } = load()
        await store.landRows('chats', rows('c', 2), { mode: 'replace' })
        const p = store.landRows('chats', [{ $id: 'c1', name: 'server' }], { mode: 'append' })
        const { originalEntry } = mut.removeEntryFromStore('chats', 'c1')
        mut.addEntryToStore('chats', originalEntry)
        await p
        const c1 = $x().chats.find(r => r.$id === 'c1')
        expect(c1.name).toBe('c 1')
    })
})

describe('lazy $x.all', () => {
    it('is built on first read, versioned by _v.all, and stable between landings', async () => {
        const { store, $x, data } = load()
        expect($x().all.length).toBe(0)
        await store.landRows('a', rows('a', 2))
        await store.landRows('b', rows('b', 3))
        const all = $x().all
        expect(all.map(r => r.$id)).toEqual(['a0', 'a1', 'b0', 'b1', 'b2'])
        expect($x().all).toBe(all)
        expect(all[0]).toBe($x().a[0])
        const v = data()._v.all
        await store.landRows('a', rows('a', 1, 2), { mode: 'append' })
        expect(data()._v.all).toBe(v + 1)
        expect($x().all.length).toBe(6)
    })

    it('an effect on $x.all re-runs on any source landing, and only then', async () => {
        const { store, $x, effect, data } = load()
        await store.landRows('a', rows('a', 1))
        let runs = 0
        effect(() => { runs++; void $x().all.length })
        data()._dataVersion++
        await tick()
        expect(runs).toBe(1)
        await store.landRows('b', rows('b', 1))
        await tick()
        expect(runs).toBe(2)
    })
})

describe('updateStore (synchronous replace) and state', () => {
    it('updateStore replaces synchronously and null data clears the source', async () => {
        const { store, $x, data } = load()
        store.updateStore('chats', rows('c', 2), { loading: false, error: null, ready: true })
        expect($x().chats.length).toBe(2)
        expect(data()._chats_state.ready).toBe(true)
        store.updateStore('chats', null, { loading: true, error: null, ready: false })
        expect(data().chats).toBe(null)
        expect(data()._chats_state.loading).toBe(true)
    })

    it('$loading reflects a state-only write without a data landing', async () => {
        const { store, $x, effect, data } = load()
        await store.landRows('chats', rows('c', 1))
        let seen = null
        effect(() => { seen = $x().chats.$loading })
        expect(seen).toBe(false)
        data()._chats_state = { ...data()._chats_state, loading: true }
        await tick()
        expect(seen).toBe(true)
    })
})

describe('DOM ($nextTick) semantics', () => {
    it('a $nextTick DOM read after a local state write sees the new value', async () => {
        const { store, mut } = load()
        await store.landRows('chats', rows('c', 1))
        document.body.innerHTML = `<div x-data><span id="n" x-text="$x.chats.length"></span><b id="s" x-show="$x.chats.some(c => c.open)">open</b></div>`
        Alpine.start()
        await tick()
        const n = document.getElementById('n'), s = document.getElementById('s')
        expect(n.textContent).toBe('1')
        expect(s.style.display).toBe('none')
        mut.addEntryToStore('chats', { $id: 'c9', open: false })
        mut.updateEntryInStore('chats', 'c9', { open: true })
        await Alpine.nextTick()
        expect(n.textContent).toBe('2')
        expect(s.style.display).toBe('')
        Alpine.destroyTree(document.body.firstElementChild)
    })
})
