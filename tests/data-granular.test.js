// @vitest-environment happy-dom
/**
 * Granular sources (manifest.json `data.<source>.granular: true`): a change to row
 * fields alone re-runs the readers of those fields and the operator memos, not every
 * reader of the list. Membership, order and loads still announce on the list version.
 * Sources that do not opt in behave exactly as before.
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

function load(order) {
    window.Alpine = Alpine
    window.ManifestDataConfig = { getManifest: () => ({ data: { fine: { granular: true }, plain: {}, odd: { granular: 'yes' } } }) }
    const ctx = {
        window, document, Alpine, console, setTimeout, clearTimeout, performance,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    const store = window.ManifestDataStore
    store.initializeStore()
    const loadDataSource = async () => null
    window.ManifestDataMain = { loadDataSource, _loadDataSource: loadDataSource, orderFor: () => order || null }
    window.ManifestDataProxies.registerXMagicMethod(loadDataSource)
    const $x = () => window._$xProxyFactory()
    const effect = (fn) => { let runs = 0; const e = Alpine.effect(() => { runs++; fn() }); released.push(e); return () => runs }
    return { store, mut: window.ManifestDataMutations, $x, effect, data: () => Alpine.store('data') }
}

afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); delete window.ManifestDataConfig })

const rows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${i}`, name: `row ${i}`, status: i % 2 ? 'open' : 'closed', n: i }))

// Four readers of one source: the list length, every row's status, one row's name, a search
function readers({ $x, effect }, source) {
    let names = ''
    return {
        length: effect(() => { void $x()[source].length }),
        statuses: effect(() => { for (const row of $x()[source]) void row.status }),
        name: effect(() => { names = $x()[source][1].name }),
        search: effect(() => { void $x()[source].$search('row', 'name').length }),
        names: () => names,
    }
}

describe('a granular source', () => {
    it('a realtime field update re-runs the readers of that field and the search, not the list readers', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(50))
        const r = readers(ctx, 'fine')
        const v = ctx.data()._v.fine
        await ctx.store.landRows('fine', [{ $id: 'r1', name: 'renamed' }], { mode: 'append' })
        await tick()
        expect(ctx.data()._v.fine).toBe(v)
        expect(ctx.data()._f.fine).toBe(1)
        expect(r.length()).toBe(1)
        expect(r.statuses()).toBe(1)
        expect(r.name()).toBe(2)
        expect(r.names()).toBe('renamed')
        expect(r.search()).toBe(2)
    })

    it('a status change re-runs the status readers only', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(50))
        const r = readers(ctx, 'fine')
        await ctx.store.landRows('fine', [{ $id: 'r7', status: 'archived' }], { mode: 'append' })
        await tick()
        expect(r.statuses()).toBe(2)
        expect(r.length()).toBe(1)
        expect(r.name()).toBe(1)
    })

    it('hands back the same array across a field-only change, and a new one after a structural change', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(5))
        const before = ctx.$x().fine
        await ctx.store.landRows('fine', [{ $id: 'r1', name: 'x' }], { mode: 'append' })
        expect(ctx.$x().fine).toBe(before)
        await ctx.store.landRows('fine', [{ $id: 'new', name: 'new' }], { mode: 'append' })
        expect(ctx.$x().fine).not.toBe(before)
    })

    it('an added row, a removed row and a load still re-run every reader', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(10))
        const r = readers(ctx, 'fine')
        await ctx.store.landRows('fine', [{ $id: 'new', name: 'new', status: 'open' }], { mode: 'append' })
        await tick()
        expect([r.length(), r.statuses(), r.search()]).toEqual([2, 2, 2])
        const beforeRemove = ctx.data()._v.fine
        await ctx.store.landRemove('fine', ['r3'])
        await tick()
        expect(ctx.data()._v.fine).toBe(beforeRemove + 1)
        expect([r.length(), r.statuses(), r.search()]).toEqual([3, 3, 3])
        const v = ctx.data()._v.fine
        await ctx.store.landRows('fine', rows(9), { mode: 'replace', loading: false, ready: true })
        expect(ctx.data()._v.fine).toBeGreaterThan(v)
    })

    it('a field update that moves a row on a sorted source is structural', async () => {
        const order = [['n', -1]]
        const ctx = load(order)
        await ctx.store.landRows('fine', rows(10).reverse(), { mode: 'replace', order })
        const r = readers(ctx, 'fine')
        const v = ctx.data()._v.fine
        await ctx.store.landRows('fine', [{ $id: 'r2', name: 'same place' }], { mode: 'append', order })
        await tick()
        expect(ctx.data()._v.fine).toBe(v)
        expect(r.length()).toBe(1)
        await ctx.store.landRows('fine', [{ $id: 'r2', n: 99 }], { mode: 'append', order })
        await tick()
        expect(ctx.data()._v.fine).toBe(v + 1)
        expect(r.length()).toBe(2)
        expect(Alpine.raw(ctx.data().fine)[0].$id).toBe('r2')
    })

    it('a local update is field-only; a local create and delete are structural', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(10))
        const r = readers(ctx, 'fine')
        const v = ctx.data()._v.fine
        ctx.mut.updateEntryInStore('fine', 'r1', { name: 'local' })
        expect(ctx.$x().fine[1].name).toBe('local') // read-your-writes
        await tick()
        expect(ctx.data()._v.fine).toBe(v)
        expect(r.length()).toBe(1)
        expect(r.name()).toBe(2)
        expect(r.search()).toBe(2)
        ctx.mut.addEntryToStore('fine', { $id: 'local', name: 'local row', status: 'open' })
        await tick()
        expect(ctx.data()._v.fine).toBe(v + 1)
        expect(r.length()).toBe(2)
        ctx.mut.removeEntryFromStore('fine', 'local')
        await tick()
        expect(ctx.data()._v.fine).toBe(v + 2)
    })

    it('a row Alpine cannot track (frozen) announces on the list version', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(3))
        Object.freeze(Alpine.raw(ctx.data().fine)[0])
        const sealed = Object.seal({ $id: 'r1', name: 'row 1', status: 'open', n: 1 })
        Alpine.raw(ctx.data().fine)[1] = sealed
        const v = ctx.data()._v.fine
        await ctx.store.landRows('fine', [{ $id: 'r1', name: 'sealed change' }], { mode: 'append' })
        expect(sealed.name).toBe('sealed change')
        expect(ctx.data()._v.fine).toBe(v + 1)
    })

    it('operator results follow a field-only change: contents, not just re-runs', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(6))
        const open = () => ctx.$x().fine.$query([['equal', 'status', 'open']]).map(r => r.$id)
        let shown = null, firstName = null
        ctx.effect(() => { shown = open() })
        ctx.effect(() => { firstName = ctx.$x().fine.$query([['equal', 'status', 'open']])[0].name })
        expect(shown).toEqual(['r1', 'r3', 'r5'])
        await ctx.store.landRows('fine', [{ $id: 'r1', status: 'closed' }, { $id: 'r3', name: 'renamed' }], { mode: 'append' })
        await tick()
        expect(shown).toEqual(['r3', 'r5'])
        expect(firstName).toBe('renamed')
        expect(open()).toEqual(['r3', 'r5']) // a fresh call is not served the old result either
        expect(ctx.$x().fine.$search('renamed', 'name').map(r => r.$id)).toEqual(['r3'])
        ctx.mut.updateEntryInStore('fine', 'r5', { status: 'closed' })
        await tick()
        expect(shown).toEqual(['r3'])
    })

    it('$x.all operators follow a field-only change', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(4))
        let open = null
        ctx.effect(() => { open = ctx.$x().all.$query([['equal', 'status', 'open']]).map(r => r.$id) })
        expect(open).toEqual(['r1', 'r3'])
        await ctx.store.landRows('fine', [{ $id: 'r1', status: 'closed', name: 'renamed' }], { mode: 'append' })
        await tick()
        expect(open).toEqual(['r3'])
        expect(ctx.$x().all.$search('renamed', 'name')).toHaveLength(1)
    })

    it('a replace landing that changes membership, an id change and a held delete are structural', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(5))
        let v = ctx.data()._v.fine
        await ctx.store.landRows('fine', rows(4), { mode: 'replace' }) // no loading flag (a $query landing)
        expect(ctx.data()._v.fine).toBe(v + 1)
        v = ctx.data()._v.fine
        await ctx.store.landRows('fine', rows(4), { mode: 'replace' }) // same membership: fields only
        expect(ctx.data()._v.fine).toBe(v)
        ctx.store.mergeRowFields(ctx.data().fine[0], { $id: 'renamed-id' }, 'fine')
        ctx.store.touchSource('fine', true)
        expect(ctx.data()._v.fine).toBe(v + 1)
        v = ctx.data()._v.fine
        ctx.store.holdWrite('fine', 'r2', 'delete', null)
        await ctx.store.landRows('fine', [{ $id: 'r2', name: 'still here?' }], { mode: 'append' })
        expect(Alpine.raw(ctx.data().fine).some(r => r.$id === 'r2')).toBe(false)
        expect(ctx.data()._v.fine).toBe(v + 1)
    })

    it('a manifest lookup that throws never stalls a landing', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(2))
        window.ManifestDataConfig = { getManifest: () => { throw new Error('boom') } }
        const v = ctx.data()._v.fine
        expect(await ctx.store.landRows('fine', [{ $id: 'r1', name: 'x' }], { mode: 'append' })).toBe(true)
        expect(ctx.data()._v.fine).toBe(v + 1)
    })

    it('the post-settle bump and a reset still move the list version', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(3))
        const v = ctx.data()._v.fine
        ctx.store.bumpAllVersions(new Set(['fine']))
        expect(ctx.data()._v.fine).toBe(v + 1)
        ctx.store.resetSource('fine')
        expect(ctx.data()._v.fine).toBe(v + 2)
    })
})

describe('sources that do not opt in', () => {
    for (const source of ['plain', 'odd', 'unlisted']) {
        it(`"${source}": a field update re-runs every reader, as before`, async () => {
            const ctx = load()
            await ctx.store.landRows(source, rows(20))
            const r = readers(ctx, source)
            const v = ctx.data()._v[source]
            await ctx.store.landRows(source, [{ $id: 'r1', name: 'renamed' }], { mode: 'append' })
            await tick()
            expect(ctx.data()._v[source]).toBe(v + 1)
            expect(ctx.data()._f[source]).toBeUndefined()
            expect([r.length(), r.statuses(), r.name(), r.search()]).toEqual([2, 2, 2, 2])
            ctx.mut.updateEntryInStore(source, 'r2', { name: 'local' })
            await tick()
            expect(ctx.data()._v[source]).toBe(v + 2)
            expect(r.length()).toBe(3)
        })
    }

    it('a granular source in the same flush does not change how another source is bumped', async () => {
        const ctx = load()
        await ctx.store.landRows('fine', rows(5))
        await ctx.store.landRows('plain', rows(5))
        const vf = ctx.data()._v.fine, vp = ctx.data()._v.plain
        await Promise.all([
            ctx.store.landRows('fine', [{ $id: 'r1', name: 'a' }], { mode: 'append' }),
            ctx.store.landRows('plain', [{ $id: 'r1', name: 'b' }], { mode: 'append' }),
        ])
        expect(ctx.data()._v.fine).toBe(vf)
        expect(ctx.data()._v.plain).toBe(vp + 1)
    })
})
