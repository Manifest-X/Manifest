// @vitest-environment happy-dom
/**
 * Operators compute on raw rows: `$search` / `$query` read no row through a
 * reactive proxy, results still carry the array's own (live) rows, `$search`
 * lowercases each row once per source version, and object-typed fields are
 * not searched as "[object Object]".
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
    const effect = (fn) => { const e = Alpine.effect(fn); released.push(e); return e }
    return { store, effect, data: () => Alpine.store('data'), realm: (code) => vm.runInContext(code, ctx) }
}

afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)) })

const people = () => [
    { $id: 'a', name: 'Ada Lovelace', email: 'ada@example.com', status: 'open', n: 3, tags: ['vip', 'math'], meta: { channel: 'web' } },
    { $id: 'b', name: 'Grace Hopper', email: 'grace@example.com', status: 'closed', n: 1, tags: ['navy'], meta: { channel: 'object store' } },
    { $id: 'c', name: 'Alan Turing', email: 'alan@example.com', status: 'open', n: 2, tags: [], meta: null },
]

// The source as a consumer holds it: the reactive array, with the operators attached to it
async function live() {
    const ctx = load()
    await ctx.store.landRows('people', people(), { mode: 'replace' })
    const array = ctx.data().people
    window.ManifestDataProxies.attachArrayMethods(array, 'people', async () => null)
    expect(Alpine.raw(array)).not.toBe(array)
    return { ...ctx, array, raw: Alpine.raw(array) }
}

// Reads of a field through a reactive row proxy (what a tracked computation would do)
function countProxyReads(raw, run) {
    let reads = 0
    const proto = Object.getPrototypeOf(raw[0])
    const original = Reflect.get
    Reflect.get = function (target, key, receiver) {
        if (raw.includes(target) && receiver !== target && key !== '__v_raw' && key !== '__v_isReactive' && key !== '__v_skip') reads++
        return original.apply(this, arguments)
    }
    try { run() } finally { Reflect.get = original }
    void proto
    return reads
}

describe('$search on raw rows', () => {
    it('returns the array’s own live rows, and a binding on a result row updates', async () => {
        const { array, effect, store } = await live()
        const found = array.$search('ada', 'name')
        expect(found).toHaveLength(1)
        expect(found[0]).toBe(array[0])
        expect(Alpine.raw(found[0])).not.toBe(found[0])
        let shown = null
        effect(() => { shown = found[0].email })
        store.mergeRowFields(array[0], { email: 'countess@example.com' }, 'people')
        await tick()
        expect(shown).toBe('countess@example.com')
    })

    it('reads no field through a row proxy', async () => {
        const { array, raw } = await live()
        expect(countProxyReads(raw, () => array.$search('grace', 'name', 'email'))).toBe(0)
        expect(countProxyReads(raw, () => array.$search('turing'))).toBe(0)
        expect(countProxyReads(raw, () => array.$search('ada', { name: 3, email: 1 }))).toBe(0)
    })

    it('lowercases each row once per source version, not once per keystroke', async () => {
        const { array, store, realm } = await live()
        // The subscripts run in their own realm: count on its String
        const proto = realm('String.prototype')
        const original = proto.toLowerCase
        let calls = 0
        proto.toLowerCase = function () { calls++; return original.call(this) }
        try {
            array.$search('a', 'name', 'email')
            const first = calls
            calls = 0
            array.$search('ad', 'name', 'email')
            array.$search('ada', 'name', 'email')
            expect(calls).toBeLessThanOrEqual(2) // the two terms only
            expect(first).toBeGreaterThan(calls)
            await store.landRows('people', [{ $id: 'a', name: 'Augusta' }], { mode: 'append' })
            calls = 0
            expect(array.$search('augusta', 'name', 'email')).toHaveLength(1)
            expect(calls).toBeGreaterThan(2) // new version: rebuilt
        } finally { proto.toLowerCase = original }
    })

    it('does not match object-typed fields as "[object Object]"; lists of scalars still match', async () => {
        const { array } = await live()
        expect(array.$search('object')).toHaveLength(0)
        expect(array.$search('[object')).toHaveLength(0)
        expect(array.$search('navy').map(r => r.$id)).toEqual(['b'])
        expect(array.$search('math', 'tags').map(r => r.$id)).toEqual(['a'])
        expect(array.$search('example.com').map(r => r.$id)).toEqual(['a', 'b', 'c'])
        expect(array.$search('2', 'n').map(r => r.$id)).toEqual(['c'])
    })

    it('weighted search ranks by field weight and still returns live rows', async () => {
        const { array } = await live()
        const ranked = array.$search('a', { name: 1, email: 5 })
        expect(ranked.map(r => r.$id)).toEqual(['a', 'c', 'b'])
        expect(ranked[0]).toBe(array[0])
    })
})

describe('$query on raw rows', () => {
    it('filters, sorts and pages like before, on the source’s own rows, without touching the source order', async () => {
        const { array, raw } = await live()
        const before = raw.map(r => r.$id)
        const open = array.$query([['equal', 'status', 'open'], ['orderAsc', 'n']])
        expect(open.map(r => r.$id)).toEqual(['c', 'a'])
        expect(Alpine.raw(open[1])).toBe(raw[0])
        expect(array.$query([['orderDesc', 'name'], ['limit', 2]]).map(r => r.$id)).toEqual(['b', 'c'])
        expect(array.$query([['orderAsc', 'name'], ['offset', 1]]).map(r => r.$id)).toEqual(['c', 'b'])
        expect(array.$query([['contains', 'email', 'GRACE']]).map(r => r.$id)).toEqual(['b'])
        expect(array.$query([['between', 'n', 2, 3], ['isNotNull', 'meta']]).map(r => r.$id)).toEqual(['a'])
        expect(raw.map(r => r.$id)).toEqual(before)
    })

    it('reads no field through a row proxy', async () => {
        const { array, raw } = await live()
        expect(countProxyReads(raw, () => array.$query([['equal', 'status', 'open'], ['orderDesc', 'n'], ['limit', 1]]))).toBe(0)
    })

    it('a query with only an order returns a new array, never the source itself', async () => {
        const { array, raw } = await live()
        const sorted = array.$query([['orderAsc', 'n']])
        expect(sorted).not.toBe(array)
        expect(Alpine.raw(sorted)).not.toBe(raw)
        const same = array.$query([['limit', 10]])
        expect(Alpine.raw(same)).not.toBe(raw)
    })

    it('chains across results: $search().$query() and $query().$search()', async () => {
        const { array } = await live()
        expect(array.$search('example', 'email').$query([['equal', 'status', 'open'], ['orderAsc', 'n']]).map(r => r.$id)).toEqual(['c', 'a'])
        const chained = array.$query([['equal', 'status', 'open']]).$search('alan', 'name')
        expect(chained.map(r => r.$id)).toEqual(['c'])
        expect(Alpine.raw(chained[0])).toBe(Alpine.raw(array[2]))
    })
})

describe('raw arrays', () => {
    it('a raw source array still returns its own raw rows', async () => {
        const ctx = load()
        await ctx.store.landRows('people', people(), { mode: 'replace' })
        const raw = ctx.store.getRawData('people')
        const found = raw.$search('grace', 'name')
        expect(found[0]).toBe(raw[1])
        expect(raw.$query([['orderDesc', 'n']]).map(r => r.$id)).toEqual(['a', 'c', 'b'])
    })
})
