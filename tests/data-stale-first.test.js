// @vitest-environment happy-dom
/**
 * P5 — stale-first `$x`, request dedupe, reload keeps identity
 * (PERF-PRIMITIVES-DESIGN.md §11.1).
 *
 * Same loader pattern as data-landing.test.js, plus the real
 * `manifest.data.main.js` (loadDataSource) and the Appwrite methods handler
 * (`$query`), with the network stubbed at the loader seam
 * (ManifestDataAPI.loadFromAPI / ManifestDataAppwrite.loadTableRows) so
 * requests can be counted and gated.
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
    'shared/manifest.data.proxies.appwrite.js',
    'shared/manifest.data.proxies.magic.state.js',
    'shared/manifest.data.proxies.magic.core.js',
    'shared/manifest.data.main.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const released = []
const tick = () => Alpine.nextTick()
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms))
const rows = (prefix, n, from = 0) => Array.from({ length: n }, (_, i) => ({ $id: `${prefix}${from + i}`, name: `${prefix} ${from + i}`, n: from + i }))

async function load() {
    window.Alpine = Alpine
    Alpine.store('auth', { currentTeam: null })
    const manifest = {
        data: {
            chats: { url: 'https://api.test/chats' },
            contacts: { url: 'https://api.test/contacts' },
            rows: { appwriteTableId: 'rows', appwriteDatabaseId: 'db' },
        }
    }
    // Network seam: counted, gateable, failable
    const net = { calls: 0, byName: {}, rows: rows('c', 2), fail: null, gate: null, tableCalls: 0, tableRows: rows('t', 3), tableGate: null }
    window.ManifestDataConfig = {
        ensureManifest: async () => manifest,
        isAppwriteCollection: ds => !!(ds && typeof ds === 'object' && ds.appwriteTableId),
        getAppwriteConfig: async () => ({ databaseId: 'db' }),
        getAppwriteTableId: ds => ds?.appwriteTableId || null,
        getAppwriteBucketId: () => null,
        getScope: () => null,
        getScopeColumns: () => ({ team: 'teamId', user: 'userId' }),
        getQueries: () => null,
        getDefaultLocale: () => null,
        interpolateEnvVars: v => v,
    }
    window.ManifestDataAPI = {
        loadFromAPI: async (ds) => {
            net.calls++
            const name = ds.url.split('/').pop()
            net.byName[name] = (net.byName[name] || 0) + 1
            if (net.gate) await net.gate
            if (net.fail) throw net.fail
            return net.rows.map(r => ({ ...r }))
        }
    }
    window.ManifestDataAppwrite = {
        loadTableRows: async () => {
            net.tableCalls++
            if (net.tableGate) await net.tableGate
            return net.tableRows.map(r => ({ ...r }))
        }
    }
    window.ManifestDataQueries = { buildAppwriteQueries: async (q) => (q || []).map(String) }
    window.ManifestComponentsRegistry = { manifest }
    delete window.ManifestDataRealtime

    const ctx = {
        window, document, Alpine, console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    // main.js self-initializes (Alpine present); wait for boot to settle
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
    const store = window.ManifestDataStore
    const main = window.ManifestDataMain
    const $x = () => window._$xProxyFactory()
    const effect = (fn) => { const e = Alpine.effect(fn); released.push(e); return e }
    const gate = () => { let open; net.gate = new Promise(r => { open = r }); return () => { net.gate = null; open() } }
    const tableGate = () => { let open; net.tableGate = new Promise(r => { open = r }); return () => { net.tableGate = null; open() } }
    const query = (name) => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler(name, main.reloadDataSource)
    return { store, main, net, gate, tableGate, query, $x, effect, data: () => Alpine.store('data') }
}

afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = '' })

describe('reload keeps identity', () => {
    it('first-ever load keeps today\'s loading behaviour (null + loading:true, then rows)', async () => {
        const { main, data, $x } = await load()
        const p = main.loadDataSource('chats')
        expect(data().chats).toBe(null)
        expect(data()._chats_state.loading).toBe(true)
        await p
        expect($x().chats.length).toBe(2)
        expect($x().chats.$loading).toBe(false)
        expect($x().chats.$ready).toBe(true)
    })

    it('a cache-miss reload keeps rows live, sets only $loading, and merges by $id', async () => {
        const { main, net, gate, data, $x } = await load()
        await main.loadDataSource('chats')
        const r0 = $x().chats[0]
        const arr = data().chats
        net.rows = [{ $id: 'c0', name: 'renamed', n: 0 }, { $id: 'c1', name: 'c 1', n: 1 }, { $id: 'c2', name: 'c 2', n: 2 }]
        const open = gate()
        const p = main.reloadDataSource('chats')
        await settle(5)
        expect(net.calls).toBe(2)
        // in flight: rows never dropped
        expect(data().chats).toBe(arr)
        expect($x().chats.length).toBe(2)
        expect($x().chats.$loading).toBe(true)
        expect($x().chats.$error).toBe(null)
        expect($x().chats.$ready).toBe(true)
        open()
        await p
        expect($x().chats.length).toBe(3)
        expect($x().chats[0]).toBe(r0)
        expect(r0.name).toBe('renamed')
        expect($x().chats.$loading).toBe(false)
    })

    it('a reload with identical membership keeps the source array identity too', async () => {
        const { main, net, data } = await load()
        await main.loadDataSource('chats')
        const arr = data().chats
        net.rows = rows('c', 2).map(r => ({ ...r, name: r.name + '!' }))
        await main.reloadDataSource('chats')
        expect(data().chats).toBe(arr)
        expect(arr[1].name).toBe('c 1!')
    })

    it('a reload that fails leaves the old rows in place with $error set', async () => {
        const { main, net, $x, data } = await load()
        await main.loadDataSource('chats')
        const r0 = $x().chats[0]
        net.fail = new Error('boom')
        const result = await main.reloadDataSource('chats')
        expect(result).toBe(null)
        expect($x().chats.length).toBe(2)
        expect($x().chats[0]).toBe(r0)
        expect($x().chats.$error).toBe('boom')
        expect($x().chats.$loading).toBe(false)
        expect($x().chats.$ready).toBe(true)
        expect(data()._chats_state.errorTime).toBeGreaterThan(0)
    })

    it('a reload whose landing is skipped does not strand the source in $loading', async () => {
        const { main, $x } = await load()
        await main.loadDataSource('chats')
        await main.loadDataSource('nope', 'en', { reload: true }) // no such source
        expect($x().chats.$loading).toBe(false)
    })

    it('mutation-path reloads (_loadDataSource) are the reload variant', async () => {
        const { main } = await load()
        expect(main._loadDataSource).toBe(main.reloadDataSource)
    })
})

describe('request dedupe', () => {
    it('N concurrent initial loads → one request; map cleared on settle', async () => {
        const { main, net, store } = await load()
        const results = await Promise.all(Array.from({ length: 12 }, () => main.loadDataSource('chats')))
        expect(net.calls).toBe(1)
        expect(results.every(r => r === results[0])).toBe(true)
        expect(store.loadingPromises.size).toBe(0)
    })

    it('N concurrent reloads → one request', async () => {
        const { main, net } = await load()
        await main.loadDataSource('chats')
        await Promise.all(Array.from({ length: 8 }, () => main.reloadDataSource('chats')))
        expect(net.calls).toBe(2)
    })

    it('a reload issued while the initial load is in flight shares it', async () => {
        const { main, net, gate } = await load()
        const open = gate()
        const a = main.loadDataSource('chats')
        const b = main.reloadDataSource('chats')
        open()
        expect(await a).toBe(await b)
        expect(net.calls).toBe(1)
    })

    it('the $x read path shares the same in-flight promise as a direct load', async () => {
        const { main, net, gate, $x } = await load()
        const open = gate()
        void $x().chats // pre-data read → loadDataSource(prop, '') → key chats:en
        await settle(5)
        const p = main.loadDataSource('chats')
        open()
        await p
        await settle()
        expect(net.calls).toBe(1)
        expect($x().chats.length).toBe(2)
    })

    it('never dedupes across different keys (locale / source)', async () => {
        const { main, net, gate } = await load()
        const open = gate()
        const loads = [main.loadDataSource('chats', 'en'), main.loadDataSource('chats', 'fr'), main.loadDataSource('contacts', 'en')]
        open()
        await Promise.all(loads)
        expect(net.calls).toBe(3)
        expect(net.byName.chats).toBe(2)
    })

    it('after the map clears, a later reload fetches again', async () => {
        const { main, net, store } = await load()
        await main.loadDataSource('chats')
        expect(store.loadingPromises.size).toBe(0)
        await main.reloadDataSource('chats')
        expect(net.calls).toBe(2)
    })

    it('$query: identical concurrent queries share one request; a different query does not', async () => {
        const { query, net, tableGate, $x } = await load()
        const q = query('rows')
        const open = tableGate()
        const same = [q('$query', ['limit(5)']), q('$query', ['limit(5)']), q('$query', ['limit(5)'])]
        const other = q('$query', ['limit(9)'])
        open()
        const [a, b, c, d] = await Promise.all([...same, other])
        expect(net.tableCalls).toBe(2)
        expect(a).toBe(b)
        expect(b).toBe(c)
        expect(d).not.toBe(a)
        expect($x().rows.length).toBe(3)
        expect($x().rows.$stale).toBe(false)
    })
})

describe('$stale / $fresh', () => {
    it('true/pending before any landing, false/resolved after the first fresh landing', async () => {
        const { main, gate, $x } = await load()
        const open = gate() // the pre-data read itself starts the load
        expect($x().chats.$stale).toBe(true)
        expect($x().chats.$loading).toBe(true)
        const fresh = $x().chats.$fresh
        expect(typeof fresh.then).toBe('function')
        let resolved = false
        fresh.then(() => { resolved = true })
        await settle(5)
        expect(resolved).toBe(false)
        open()
        await main.loadDataSource('chats')
        await settle(5)
        expect(resolved).toBe(true)
        expect($x().chats.$stale).toBe(false)
        expect($x().chats.$fresh).toBe(fresh) // one promise per source per page-load
    })

    it('$stale is reactive: an effect flips when the fresh landing applies', async () => {
        const { main, $x, effect } = await load()
        let seen = null
        effect(() => { seen = $x().chats.$stale })
        expect(seen).toBe(true)
        await main.loadDataSource('chats')
        await tick()
        expect(seen).toBe(false)
    })

    it('a reload keeps $stale false and reports through $loading only', async () => {
        const { main, gate, $x } = await load()
        await main.loadDataSource('chats')
        const open = gate()
        const p = main.reloadDataSource('chats')
        expect($x().chats.$stale).toBe(false)
        expect($x().chats.$loading).toBe(true)
        open()
        await p
        expect($x().chats.$stale).toBe(false)
        expect($x().chats.$loading).toBe(false)
    })

    it('a failed first load leaves $stale true and $fresh pending; never rejects', async () => {
        const { main, net, $x } = await load()
        net.fail = new Error('down')
        let settled = false
        $x().chats.$fresh.then(() => { settled = true }, () => { settled = true })
        await main.loadDataSource('chats')
        await settle(5)
        expect(settled).toBe(false)
        expect($x().chats.$stale).toBe(true)
        expect($x().chats.$error).toBe('down')
    })

    it('$x.$register rows are fresh by definition', async () => {
        const { $x } = await load()
        $x().$register('local', [{ $id: 'l1' }])
        expect($x().local.$stale).toBe(false)
        await expect($x().local.$fresh).resolves.toBeUndefined()
    })

    it('a landed row array exposes $stale/$fresh via `in` (Alpine has-trap parity)', async () => {
        const { main, $x } = await load()
        await main.loadDataSource('chats')
        expect('$stale' in $x().chats).toBe(true)
        expect('$fresh' in $x().chats).toBe(true)
    })
})
