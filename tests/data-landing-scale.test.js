// @vitest-environment happy-dom
/**
 * Landing cost at scale: structural edits are one reactive write, a flush's
 * same-source realtime ops apply together, row lookups use the $id index,
 * the post-settle bump covers only settled sources, and realtime rows back
 * off after a long flush.
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
const wait = (ms) => new Promise(r => setTimeout(r, ms))

function load({ now, order } = {}) {
    window.Alpine = Alpine
    const ctx = {
        window, document, Alpine, console, setTimeout, clearTimeout,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        performance: now ? { now } : performance,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    const store = window.ManifestDataStore
    store.initializeStore()
    const loadDataSource = async () => null
    window.ManifestDataMain = { loadDataSource, _loadDataSource: loadDataSource, orderFor: () => order || null }
    window.ManifestDataProxies.registerXMagicMethod(loadDataSource)
    const $x = () => window._$xProxyFactory()
    const effect = (fn) => { const e = Alpine.effect(fn); released.push(e); return e }
    return { store, mut: window.ManifestDataMutations, $x, effect, data: () => Alpine.store('data'), raw: (name) => Alpine.raw(Alpine.store('data'))[name] }
}

afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = '' })

const rows = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ $id: `r${from + i}`, name: `row ${from + i}`, n: from + i }))

function countReruns(effect, read) {
    let runs = 0
    effect(() => { runs++; read() })
    return () => runs - 1
}

// Structural array methods called through the reactive proxy (one reactive write per shifted row)
async function proxiedStructuralCalls(rawArray, run) {
    const proto = Array.prototype
    const originals = { splice: proto.splice, unshift: proto.unshift, shift: proto.shift }
    let calls = 0
    for (const name of Object.keys(originals)) {
        proto[name] = function (...args) {
            if (this !== rawArray && Alpine.raw(this) === rawArray) calls++
            return originals[name].apply(this, args)
        }
    }
    try { await run() } finally { Object.assign(proto, originals) }
    return calls
}

// writeSource runs once per applied group: it clears the source's access cache each time
async function sourceWrites(run) {
    const proxies = window.ManifestDataProxies
    const original = proxies.clearAccessCache
    let calls = 0
    proxies.clearAccessCache = (...args) => { calls++; return original?.(...args) }
    try { await run() } finally { proxies.clearAccessCache = original }
    return calls
}

describe('structural edits are one reactive write', () => {
    it('a realtime remove of many rows re-runs a list reader once and keeps the survivors', async () => {
        const { store, $x, effect, raw } = load()
        await store.landRows('chats', rows(2000))
        const kept = raw('chats')[1500]
        const before = raw('chats')
        let held = 0, heldRuns = 0
        const list = Alpine.store('data').chats // held directly, not re-read through $x
        effect(() => { heldRuns++; held = list.length })
        let first = null
        effect(() => { first = list[0].$id })
        const reruns = countReruns(effect, () => { for (const r of $x().chats) void r.$id })
        const proxied = await proxiedStructuralCalls(before, () => store.landRemove('chats', rows(100).map(r => r.$id)))
        expect(proxied).toBe(0)
        await tick()
        expect(reruns()).toBe(1)
        expect(raw('chats')).toBe(before) // same array: a holder of it stays live
        expect(raw('chats')).toHaveLength(1900)
        expect(raw('chats')[1400]).toBe(kept)
        expect(held).toBe(1900)
        expect(heldRuns).toBe(2)
        expect(first).toBe('r100')
        expect(store.getRawData('chats')).toBe(raw('chats'))
        expect(typeof $x().chats.$search).toBe('function')
    })

    it('a failed delete returns the row to its place, and methods stay attached', async () => {
        const { store, mut, raw, $x } = load()
        await store.landRows('chats', rows(5))
        let during = null
        const proxied = await proxiedStructuralCalls(raw('chats'), () => mut.executeMutation({
            type: 'delete', dataSourceName: 'chats', entryId: 'r2',
            apiCall: async () => { during = raw('chats').map(r => r.$id); throw new Error('offline') },
        }).catch(() => {}))
        expect(proxied).toBe(0)
        expect(during).toEqual(['r0', 'r1', 'r3', 'r4'])
        expect(raw('chats').map(r => r.$id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
        expect($x().chats.length).toBe(5)
        expect(typeof $x().chats.$search).toBe('function')
        expect(store.getRawData('chats')).toBe(raw('chats'))
    })

    it('a local create on a sorted source lands at its sort position in one write', async () => {
        const { store, mut, raw, $x, effect } = load({ order: [['n', -1]] })
        await store.landRows('chats', rows(50).reverse())
        const reruns = countReruns(effect, () => { for (const r of $x().chats) void r.$id })
        const held = raw('chats')
        expect(await proxiedStructuralCalls(held, async () => { mut.addEntryToStore('chats', { $id: 'new', name: 'new', n: 999 }) })).toBe(0)
        expect(raw('chats')).toBe(held)
        expect(raw('chats')[0].$id).toBe('new')
        expect($x().chats[0].name).toBe('new') // read-your-writes, same tick
        await tick()
        expect(reruns()).toBe(1)
    })

    it('removing every row, then inserting into the empty source, reaches a direct holder', async () => {
        const { store, mut, effect } = load({ order: [['n', -1]] })
        await store.landRows('chats', rows(2))
        const list = Alpine.store('data').chats
        let len = -1
        effect(() => { len = list.length })
        await store.landRemove('chats', ['r0', 'r1'])
        await tick()
        expect(len).toBe(0)
        mut.addEntryToStore('chats', { $id: 'a', n: 1 })
        await tick()
        expect(len).toBe(1)
    })

    it('an unsorted local create still appends to the same array', async () => {
        const { store, mut, raw } = load()
        await store.landRows('chats', rows(3))
        const before = raw('chats')
        mut.addEntryToStore('chats', { $id: 'new', name: 'new' })
        expect(raw('chats')).toBe(before)
        expect(store.indexOfRow(raw('chats'), 'new')).toBe(3)
    })
})

describe('$id index', () => {
    it('finds rows after appends, removes, an id change and a replace', async () => {
        const { store, raw } = load()
        await store.landRows('t', rows(100))
        expect(store.findRow('t', 'r42')).toBe(raw('t')[42])
        await store.landRows('t', rows(10, 100), { mode: 'append' })
        expect(store.findRow('t', 'r105')).toBe(raw('t')[105])
        await store.landRemove('t', ['r0', 'r1'])
        expect(store.findRow('t', 'r0')).toBe(null)
        expect(store.indexOfRow(raw('t'), 'r42')).toBe(40)
        store.mergeRowFields(Alpine.store('data').t[0], { $id: 'renamed' }, 't')
        expect(store.findRow('t', 'renamed')).toBe(raw('t')[0])
        expect(store.findRow('t', 'r2')).toBe(null)
        await store.landRows('t', rows(3, 500), { mode: 'replace' })
        expect(store.findRow('t', 'r501')).toBe(raw('t')[1])
        expect(store.findRow('t', 'r42')).toBe(null)
    })

    it('a stale hit (rows reordered in place by the app) is corrected, not trusted', async () => {
        const { store, raw } = load()
        await store.landRows('t', rows(4))
        expect(store.indexOfRow(raw('t'), 'r3')).toBe(3)
        raw('t').reverse()
        expect(store.indexOfRow(raw('t'), 'r3')).toBe(0)
        expect(store.indexOfRow(raw('t'), 'r0')).toBe(3)
    })

    it('the create ack swaps the placeholder for the server row in place', async () => {
        const { store, mut, raw } = load()
        await store.landRows('t', rows(3))
        await mut.executeMutation({
            type: 'create', dataSourceName: 't', data: { name: 'draft' },
            apiCall: async () => ({ $id: 'server1', name: 'draft', n: 9 }),
        })
        expect(raw('t').map(r => r.$id)).toEqual(['r0', 'r1', 'r2', 'server1'])
        expect(store.findRow('t', 'server1').n).toBe(9)
    })
})

describe('one write per source per flush', () => {
    it('100 single-row realtime updates in one flush merge every row and bump once', async () => {
        const { store, raw, data } = load()
        await store.landRows('t', rows(500))
        const v = data()._v.t
        const before = raw('t')
        const writes = await sourceWrites(() => Promise.all(rows(100).map(r => store.landRows('t', [{ $id: r.$id, name: 'x' + r.n }], { mode: 'append' }))))
        expect(writes).toBe(1)
        expect(data()._v.t).toBe(v + 1)
        expect(raw('t')).toBe(before)
        expect(raw('t')[99].name).toBe('x99')
        expect(raw('t')[100].name).toBe('row 100')
    })

    it('interleaved creates, updates and a remove apply in arrival order', async () => {
        const { store, raw } = load()
        await store.landRows('t', rows(3))
        await Promise.all([
            store.landRows('t', [{ $id: 'a', name: 'a1' }], { mode: 'append' }),
            store.landRows('t', [{ $id: 'a', name: 'a2' }], { mode: 'append' }),
            store.landRemove('t', ['r1']),
            store.landRows('t', [{ $id: 'r1', name: 'back' }], { mode: 'append' }),
            store.landRemove('t', ['r0']),
            store.landRemove('t', ['a']),
        ])
        expect(raw('t').map(r => [r.$id, r.name])).toEqual([['r2', 'row 2'], ['r1', 'back']])
    })

    it('sorted realtime rows in one flush land in order', async () => {
        const { store, raw } = load()
        const order = [['n', -1]]
        await store.landRows('t', rows(5).reverse(), { mode: 'replace', order })
        await Promise.all([
            store.landRows('t', [{ $id: 'r1', n: 50 }], { mode: 'append', order }),
            store.landRows('t', [{ $id: 'n1', n: 60 }], { mode: 'append', order }),
            store.landRows('t', [{ $id: 'r3', n: 55 }], { mode: 'append', order }),
        ])
        expect(raw('t').map(r => r.$id)).toEqual(['n1', 'r3', 'r1', 'r4', 'r2', 'r0'])
    })

    it('a load landing is never merged into realtime rows', async () => {
        const { store, raw } = load()
        await store.landRows('t', rows(3))
        const results = await Promise.all([
            store.landRows('t', [{ $id: 'x', name: 'x' }], { mode: 'append' }),
            store.landRows('t', rows(2), { mode: 'replace', loading: false, ready: true }),
            store.landRows('t', [{ $id: 'y', name: 'y' }], { mode: 'append' }),
        ])
        expect(results).toEqual([true, true, true])
        expect(raw('t').map(r => r.$id)).toEqual(['r0', 'r1', 'y'])
    })
})

describe('rows still queued', () => {
    it('isRowPending sees a realtime row before its flush, not after', async () => {
        const { store } = load()
        await store.landRows('t', rows(2))
        const landing = store.landRows('t', [{ $id: 'q', name: 'q' }], { mode: 'append' })
        expect(store.findRow('t', 'q')).toBe(null)
        expect(store.isRowPending('t', 'q')).toBe(true)
        expect(store.isRowPending('other', 'q')).toBe(false)
        await landing
        expect(store.isRowPending('t', 'q')).toBe(false)
        expect(store.findRow('t', 'q').name).toBe('q')
    })
})

describe('post-settle bump', () => {
    it('a source written synchronously since the last settle is bumped with the next one', async () => {
        const { store, mut, data } = load()
        await store.landRows('a', rows(2), { mode: 'replace', loading: false, ready: true })
        await store.landRows('b', rows(2), { mode: 'replace', loading: false, ready: true })
        await wait(280)
        mut.updateEntryInStore('a', 'r0', { name: 'local' }) // may have run inside an Alpine flush
        const a = data()._v.a, b = data()._v.b
        store.updateStore('c', rows(1))
        await wait(280)
        expect(data()._v.a).toBe(a + 1)
        expect(data()._v.b).toBe(b)
    })


    it('covers every source on the first settle, then only the sources that settled', async () => {
        const { store, data } = load()
        await store.landRows('a', rows(2), { mode: 'replace', loading: false, ready: true })
        await store.landRows('b', rows(2), { mode: 'replace', loading: false, ready: true })
        await wait(280)
        const a = data()._v.a, b = data()._v.b
        store.updateStore('c', rows(1)) // e.g. $x.$register of an unrelated source
        await wait(280)
        expect(data()._v.a).toBe(a)
        expect(data()._v.b).toBe(b)
        expect(data()._v.c).toBe(2) // write + its own bump
        await store.landRows('b', rows(3), { mode: 'replace', loading: false, ready: true })
        await wait(280)
        expect(data()._v.a).toBe(a)
        expect(data()._v.b).toBe(b + 2)
    })
})

describe('realtime backpressure', () => {
    it('after a long flush, realtime rows wait and land together; a load cuts the wait', async () => {
        let t = 1000
        const { store, data } = load({ now: () => t })
        await store.landRows('t', rows(10))
        t += 60 // the flush and its effects took 60ms
        await wait(5) // cost is measured on the next task
        const v = data()._v.t
        let landed = 0
        store.landRows('t', [{ $id: 'r0', name: 'a' }], { mode: 'append' }).then(() => landed++)
        await wait(60)
        store.landRows('t', [{ $id: 'r1', name: 'b' }], { mode: 'append' }).then(() => landed++)
        await wait(20)
        expect(landed).toBe(0) // 120ms window still open
        await wait(80)
        expect(landed).toBe(2)
        expect(data()._v.t).toBe(v + 1)

        t += 60
        await wait(5)
        store.landRows('t', [{ $id: 'r2', name: 'c' }], { mode: 'append' }).then(() => landed++)
        const loaded = store.landRows('t', rows(10), { mode: 'replace', loading: false, ready: true })
        await wait(40)
        expect(landed).toBe(3)
        expect(await loaded).toBe(true)
    })

    it('a row arriving after the cool-down has passed lands on the next frame', async () => {
        let t = 1000
        const { store } = load({ now: () => t })
        await store.landRows('t', rows(10))
        t += 60
        await wait(5)
        t += 500 // idle since: the cool-down (120ms) is over
        let landed = false
        store.landRows('t', [{ $id: 'r0', name: 'a' }], { mode: 'append' }).then(() => { landed = true })
        await wait(70)
        expect(landed).toBe(true)
    })

    it('a cheap flush leaves the next realtime row on the frame path', async () => {
        let t = 1000
        const { store } = load({ now: () => t })
        await store.landRows('t', rows(10))
        t += 2
        await wait(5)
        let landed = false
        store.landRows('t', [{ $id: 'r0', name: 'a' }], { mode: 'append' }).then(() => { landed = true })
        await wait(70)
        expect(landed).toBe(true)
    })
})
