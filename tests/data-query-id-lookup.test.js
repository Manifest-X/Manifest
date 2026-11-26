// @vitest-environment happy-dom
/**
 * Local $query with a leading equal('$id', value) reads the row from the
 * source's $id index instead of scanning every row. Results match the
 * scanning path (randomized differential) after every kind of write.
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

function load() {
    window.Alpine = Alpine
    window.__manifestLoaded = { data: {} }
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
    window.ManifestDataMain = { loadDataSource, _loadDataSource: loadDataSource, orderFor: () => null }
    window.ManifestDataProxies.registerXMagicMethod(loadDataSource)
    const $x = () => window._$xProxyFactory()
    const effect = (fn) => { const e = Alpine.effect(fn); released.push(e); return e }
    return { store, mut: window.ManifestDataMutations, $x, effect }
}

afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); delete window.__manifestLoaded })

// Scanning path: the same operator on a sourceless copy (no memo, no index)
function reference(store, name, queries) {
    const copy = Alpine.raw(store.getRawData(name)).slice()
    return window.ManifestDataProxies.attachArrayMethods(copy, null, () => {}).$query(queries).map(r => Alpine.raw(r))
}
const viaSource = ($x, name, queries) => $x()[name].$query(queries).map(r => Alpine.raw(r))

const rows = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ $id: `r${from + i}`, name: `row ${from + i}`, n: from + i }))

function rng(seed) {
    let s = seed >>> 0
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

describe('$query equal $id: index lookup', () => {
    it('lookups at an unchanged version read no row but the hit', async () => {
        const { store, $x } = load()
        await store.landRows('t', rows(2000), { mode: 'replace' })
        const raw = store.getRawData('t')
        let reads = 0
        const spied = raw[1999]
        let id = spied.$id
        Object.defineProperty(spied, '$id', { enumerable: true, configurable: true, get() { reads++; return id }, set(v) { id = v } })
        expect(viaSource($x, 't', [['equal', '$id', 'r5']])).toEqual([raw[5]]) // warms the index
        reads = 0
        for (let i = 0; i < 50; i++) expect(viaSource($x, 't', [['equal', '$id', `r${i * 3}`]])).toEqual([raw[i * 3]])
        expect(reads).toBe(0)
        expect(viaSource($x, 't', [['equal', '$id', 'r1999']])).toEqual([spied])
    })

    it('many readers, each its own id, re-run after a realtime update without scanning', async () => {
        const { store, $x, effect } = load()
        await store.landRows('t', rows(2000), { mode: 'replace' })
        const raw = store.getRawData('t')
        const seen = new Array(200)
        for (let i = 0; i < 200; i++) effect(() => { seen[i] = $x().t.$query([['equal', '$id', `r${i * 7}`]])[0]?.name })
        let reads = 0
        const spied = raw[1500]
        let id = spied.$id
        Object.defineProperty(spied, '$id', { enumerable: true, configurable: true, get() { reads++; return id }, set(v) { id = v } })
        reads = 0
        await store.landRows('t', [{ $id: 'r14', name: 'renamed', n: 14 }], { mode: 'append' })
        await Alpine.nextTick()
        expect(seen[2]).toBe('renamed')
        expect(seen[3]).toBe('row 21')
        expect(reads).toBeLessThanOrEqual(1)
    })

    it('follows the rest of the query after the lookup', async () => {
        const { store, $x } = load()
        await store.landRows('t', rows(20), { mode: 'replace' })
        for (const q of [
            [['equal', '$id', 'r3'], ['greaterThan', 'n', 2]],
            [['equal', '$id', 'r3'], ['greaterThan', 'n', 3]],
            [['equal', '$id', 'r3'], ['orderDesc', 'n'], ['limit', 1]],
            [['equal', '$id', 'r3'], ['offset', 1]],
            [['equal', '$id', 'nope']],
            [['orderAsc', 'n'], ['equal', '$id', 'r4']],
            [['equal', '$id', 3]],
            [['equal', '$id', NaN]],
            [['equal', '$id', ['r3']]],
            [['equal', '$id']],
        ]) expect(viaSource($x, 't', q)).toEqual(reference(store, 't', q))
    })

    it('repeated ids fall back to the scan and return every match in order', async () => {
        const { store, $x } = load()
        await store.landRows('t', [{ $id: 'a', n: 1 }, { $id: 'b', n: 2 }, { $id: 'a', n: 3 }], { mode: 'replace' })
        const q = [['equal', '$id', 'a']]
        expect(viaSource($x, 't', q).map(r => r.n)).toEqual([1, 3])
        expect(viaSource($x, 't', q)).toEqual(reference(store, 't', q))
    })

    it('rows without a string or number $id still match an undefined or null lookup', async () => {
        const { store, $x } = load()
        await store.landRows('t', [{ n: 1 }, { $id: 'x', n: 2 }, { $id: null, n: 3 }], { mode: 'replace' })
        for (const v of [undefined, null, 'x'])
            expect(viaSource($x, 't', [['equal', '$id', v]])).toEqual(reference(store, 't', [['equal', '$id', v]]))
    })
})

describe('$query equal $id: fresh after every kind of write', () => {
    const check = (ctx, ids) => {
        for (const id of ids) {
            const q = [['equal', '$id', id]]
            expect(viaSource(ctx.$x, 't', q), `${id}`).toEqual(reference(ctx.store, 't', q))
        }
    }

    it('create, realtime update, remove, load-more page, reload', async () => {
        const ctx = load()
        const { store, $x } = ctx
        await store.landRows('t', rows(50), { mode: 'replace' })
        check(ctx, ['r1', 'r60'])
        await store.landRows('t', rows(1, 60), { mode: 'append' }) // realtime create
        check(ctx, ['r60'])
        expect(viaSource($x, 't', [['equal', '$id', 'r60']])).toHaveLength(1)
        await store.landRows('t', [{ $id: 'r1', name: 'changed', n: 1 }], { mode: 'append' }) // realtime update
        expect($x().t.$query([['equal', '$id', 'r1']])[0].name).toBe('changed')
        await store.landRemove('t', ['r1', 'r2']) // realtime delete
        check(ctx, ['r1', 'r2', 'r3'])
        expect(viaSource($x, 't', [['equal', '$id', 'r1']])).toEqual([])
        await store.landRows('t', rows(20, 100), { mode: 'append' }) // next page
        check(ctx, ['r100', 'r119', 'r3'])
        await store.landRows('t', rows(10, 200), { mode: 'replace' }) // reload
        check(ctx, ['r3', 'r200', 'r209'])
        expect(viaSource($x, 't', [['equal', '$id', 'r3']])).toEqual([])
    })

    it('optimistic create (temp id to server id), failed create and failed delete', async () => {
        const ctx = load()
        const { store, mut, $x } = ctx
        await store.landRows('t', rows(10), { mode: 'replace' })
        let tempId = null
        await mut.executeMutation({
            type: 'create', dataSourceName: 't', data: { name: 'new', n: 99 },
            apiCall: async () => { tempId = Alpine.raw(store.getRawData('t')).find(r => String(r.$id).startsWith('temp_')).$id; check(ctx, [tempId]); return { $id: 'srv1', name: 'new', n: 99 } },
        })
        check(ctx, [tempId, 'srv1'])
        expect(viaSource($x, 't', [['equal', '$id', 'srv1']])).toHaveLength(1)
        await mut.executeMutation({
            type: 'create', dataSourceName: 't', data: { $id: 'bad', name: 'bad', n: 1 },
            apiCall: async () => { check(ctx, ['bad']); throw new Error('offline') },
        }).catch(() => {})
        check(ctx, ['bad'])
        expect(viaSource($x, 't', [['equal', '$id', 'bad']])).toEqual([])
        await mut.executeMutation({
            type: 'delete', dataSourceName: 't', entryId: 'r4',
            apiCall: async () => { check(ctx, ['r4']); throw new Error('offline') },
        }).catch(() => {})
        check(ctx, ['r4', 'r5'])
        expect(viaSource($x, 't', [['equal', '$id', 'r4']])).toHaveLength(1)
    })

    it('identity change: a reset source shows only the new identity\'s rows', async () => {
        const ctx = load()
        const { store, $x } = ctx
        await store.landRows('t', rows(10), { mode: 'replace' })
        check(ctx, ['r3'])
        store.resetSource('t')
        await store.landRows('t', rows(5, 500), { mode: 'replace' })
        check(ctx, ['r3', 'r500'])
        expect(viaSource($x, 't', [['equal', '$id', 'r3']])).toEqual([])
    })
})

describe('$query equal $id: randomized differential', () => {
    it('matches the scanning path over random rows, writes and queries', async () => {
        let cases = 0
        for (let seed = 1; seed <= 30; seed++) {
            const r = rng(seed)
            const ctx = load()
            const { store, $x } = ctx
            const pool = Array.from({ length: 40 }, (_, i) => (i % 9 === 0 ? i : `k${i}`))
            const pick = () => pool[Math.floor(r() * pool.length)]
            const mk = () => {
                const row = { name: `n${Math.floor(r() * 50)}`, n: Math.floor(r() * 20), s: r() < 0.5 ? 'a' : 'b' }
                if (r() > 0.05) row.$id = pick()
                return row
            }
            const initial = Array.from({ length: Math.floor(r() * 30) }, mk)
            if (r() < 0.7) { const seen = new Set(); for (const row of initial) { while (seen.has(row.$id)) row.$id = `u${seen.size}_${Math.floor(r() * 1e6)}`; seen.add(row.$id) } }
            await store.landRows('t', initial, { mode: 'replace' })
            for (let step = 0; step < 60; step++) {
                const w = r()
                if (w < 0.25) await store.landRows('t', [mk()], { mode: 'append' })
                else if (w < 0.4) await store.landRows('t', [{ ...mk(), $id: pick() }], { mode: 'append' })
                else if (w < 0.5) await store.landRemove('t', [pick()])
                else if (w < 0.53) await store.landRows('t', Array.from({ length: Math.floor(r() * 15) }, mk), { mode: 'replace' })
                for (let k = 0; k < 4; k++) {
                    const vr = r()
                    const value = vr < 0.75 ? pick() : vr < 0.8 ? 'missing' : vr < 0.85 ? String(pool[0]) : vr < 0.9 ? undefined : vr < 0.95 ? NaN : [pick()]
                    const q = [['equal', '$id', value]]
                    const extra = Math.floor(r() * 3)
                    for (let e = 0; e < extra; e++) {
                        const o = r()
                        q.push(o < 0.25 ? ['equal', 's', 'a'] : o < 0.5 ? ['orderDesc', 'n'] : o < 0.75 ? ['greaterThan', 'n', 5] : ['limit', 1])
                    }
                    expect(viaSource($x, 't', q), `seed ${seed} step ${step} ${JSON.stringify(q)}`).toEqual(reference(store, 't', q))
                    cases++
                }
            }
        }
        expect(cases).toBeGreaterThanOrEqual(7000)
    })
})
