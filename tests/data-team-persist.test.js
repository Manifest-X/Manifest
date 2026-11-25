// @vitest-environment happy-dom
/**
 * Persisted snapshots of team-scoped sources carry the team their rows were read
 * for: another team's snapshot (or an unstamped one, with a team to compare) is
 * never shown, after a switch or at boot, and is kept for when that team is
 * current again. Harness from data-persist.test.js.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { createIndexedDB } from './helpers/indexeddb-double.js'
import { isolateVm } from './helpers/vm-isolation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, '../src/scripts/data')
const read = f => [f, readFileSync(path.join(DATA, f), 'utf8')]
const SUBSCRIPTS = [
    'core/manifest.data.store.js',
    'core/manifest.data.persist.js',
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
].map(read)
const API_SUBSCRIPT = read('core/manifest.data.api.js')

const VERSION = '0.5.195'
const DAY = 86400000
const idb = createIndexedDB()
const DB = () => `manifest:${window.location.origin}`
const released = []
let iso = null
const tick = () => Alpine.nextTick()
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms))
const rows = (prefix, n, from = 0) => Array.from({ length: n }, (_, i) => ({ $id: `${prefix}${from + i}`, name: `${prefix} ${from + i}`, n: from + i }))
const ids = (list) => (Array.isArray(list) ? list.map(r => r.$id) : [])
const record = (scope, source, rowsOrObject, extra = {}) => ({
    key: `${scope}|${source}`, scope, source, rows: rowsOrObject, savedAt: Date.now(),
    frameworkVersion: VERSION, deployment: null, locale: 'en', ...extra
})

function defaultManifest() {
    return {
        data: {
            chats: { url: 'https://api.test/chats', persist: { tier: 'boot', maxRows: 3, recent: 'lastMessageAt', strip: ['lastInboundPreview'] } },
            contacts: { url: 'https://api.test/contacts', persist: { tier: 'lazy', strip: ['email', 'custom*'] } },
            settings: { url: 'https://api.test/settings', persist: true },
            plain: { url: 'https://api.test/plain' },
        },
        persistence: { scope: '$auth.currentTeam?.$id' }
    }
}

async function load(opts = {}) {
    window.Alpine = Alpine
    // Silence the previous page-load's instance (shared happy-dom window)
    const prev = window.ManifestDataPersist
    if (prev) { prev.state.enabled = false; prev.state.scopeExpr = null; prev.state.pending.clear(); clearTimeout(prev.state.writeTimer) }
    Alpine.store('auth', opts.auth || { currentTeam: opts.team ? { $id: opts.team } : null })
    const manifest = opts.manifest || defaultManifest()
    const net = {
        calls: 0, byName: {}, fail: null, gate: null,
        rows: { chats: rows('c', 2), contacts: rows('k', 2), settings: { theme: 'dark', apiToken: 'x' }, plain: rows('p', 1) },
        rowsFor: null,
        fetchOk: true,
    }
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
        getNestedValue: (obj, p) => p.split('.').reduce((c, k) => (c && c[k] !== undefined ? c[k] : undefined), obj),
        interpolateEnvVars: v => v,
    }
    if (!opts.realApi) {
        window.ManifestDataAPI = {
            loadFromAPI: async (ds) => {
                const name = ds.url.split('/').pop()
                const team = Alpine.store('auth')?.currentTeam?.$id || null
                net.calls++
                net.byName[name] = (net.byName[name] || 0) + 1
                if (net.gate) await net.gate
                if (net.fail) throw net.fail
                const data = net.rowsFor ? net.rowsFor(name, team) : net.rows[name]
                return Array.isArray(data) ? data.map(r => ({ ...r })) : { ...data }
            }
        }
    }
    window.ManifestComponentsRegistry = { manifest }
    delete window.ManifestDataRealtime
    delete window.ManifestDataPersist

    iso?.release()
    iso = isolateVm()
    const ctx = {
        window, document, Alpine, console, ...iso.timers, clearTimeout, clearInterval, queueMicrotask,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        indexedDB: opts.noIndexedDB ? undefined : idb.indexedDB,
        MANIFEST_BUILD_VERSION: VERSION,
        URL,
        fetch: async (url) => {
            net.calls++
            const name = String(url).split('/').pop()
            net.byName[name] = (net.byName[name] || 0) + 1
            if (net.gate) await net.gate
            if (!net.fetchOk) return { ok: false, status: 500, statusText: 'down', json: async () => null }
            return { ok: true, status: 200, json: async () => (net.rows[name] || []).map(r => ({ ...r })) }
        },
    }
    vm.createContext(ctx)
    const scripts = opts.realApi ? [SUBSCRIPTS[0], SUBSCRIPTS[1], API_SUBSCRIPT, ...SUBSCRIPTS.slice(2)] : SUBSCRIPTS
    for (const [name, src] of scripts) vm.runInContext(src, ctx, { filename: name })
    for (let i = 0; i < 60 && !Alpine.store('data')?._ready; i++) await settle(5)
    const store = window.ManifestDataStore
    const main = window.ManifestDataMain
    const persist = window.ManifestDataPersist
    const $x = () => window._$xProxyFactory()
    const effect = (fn) => { const e = Alpine.effect(fn); released.push(e); return e }
    const gate = () => { let open; net.gate = new Promise(r => { open = r }); return () => { net.gate = null; open() } }
    const auth = () => Alpine.store('auth')
    const dispatch = (type) => window.dispatchEvent(new window.CustomEvent(type))
    return { store, main, persist, net, gate, $x, effect, auth, dispatch, data: () => Alpine.store('data'), records: () => idb.records(DB()) }
}

beforeEach(() => { idb.reset() })
afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = ''; iso?.release(); iso = null })


// Team-scoped `items` (lazy persist) beside a plain team-scoped `other`; rows tagged by the team in the query
function teamSetup() {
    const man = { data: { other: { appwriteTableId: 'other', scope: 'team' }, items: { appwriteTableId: 'items', scope: 'team', persist: { tier: 'lazy' } } } }
    const calls = []
    window.ManifestDataQueries = {
        buildAppwriteQueries: async () => { const t = Alpine.store('auth').currentTeam?.$id || null; if (!t) return null; const q = ['team:' + t]; Object.defineProperty(q, 'scopeTeam', { value: t }); return q },
        tagTeam: (q, t) => { Object.defineProperty(q, 'scopeTeam', { value: t, configurable: true }); return q }
    }
    window.ManifestDataAppwrite = { loadTableRows: async (db, table, q) => { calls.push(table + ':' + q[0]); await settle(300); const t = q[0].slice(5); return [{ $id: `${t}-${table}`, teamId: t }] } }
    return { man, calls }
}
const signedInTo = team => ({ _initialized: true, isAuthenticated: true, user: { $id: 'u1' }, currentTeam: { $id: team }, teams: [{ $id: team }] })

// Samples what `items` shows for ~600ms after its first read
async function watchItems($x, data) {
    void $x().items
    const seen = []
    for (let i = 0; i < 30; i++) { seen.push(ids(data().items).join(',')); await settle(20) }
    return seen
}

describe('persisted snapshot of another team', () => {
    for (const [mode, stamp] of [['switch', 'tA'], ['boot-under-B', 'tA'], ['boot-under-B unstamped', undefined]]) it(`${mode}: never shows team A's snapshot`, async () => {
        idb.seed(DB(), record('', 'items', [{ $id: 'A-old', teamId: 'tA' }], { identity: 'u1', ...(stamp ? { team: stamp } : {}) }))
        const { man, calls } = teamSetup()
        const { data, main, $x, records } = await load({ manifest: man, auth: signedInTo(mode === 'switch' ? 'tA' : 'tB') })
        window.ManifestDataConfig.getScope = ds => ds?.scope || null
        await main.loadDataSource('other')
        await settle(400)
        if (mode === 'switch') {
            Object.assign(Alpine.store('auth'), { currentTeam: { $id: 'tB' }, teams: [{ $id: 'tB' }] })
            await settle(2400)
        }
        const seen = await watchItems($x, data)
        expect(seen.some(v => v.includes('A-old'))).toBe(false)
        expect(seen.at(-1)).toBe('tB-items')
        expect(calls.filter(c => c.startsWith('items'))).toEqual(['items:team:tB'])
    }, 20000)

    it('a refused snapshot is kept: a later page load under its team hydrates it', async () => {
        idb.seed(DB(), record('', 'items', [{ $id: 'A-old', teamId: 'tA' }], { identity: 'u1', team: 'tA' }))
        {
            const { man } = teamSetup()
            const { main, records } = await load({ manifest: man, auth: signedInTo('tB') })
            window.ManifestDataConfig.getScope = ds => ds?.scope || null
            await main.loadDataSource('other')
            await settle(400)
            expect((await records()).find(r => r.source === 'items')?.team).toBe('tA')
        }
        const { man } = teamSetup()
        window.ManifestDataAppwrite.loadTableRows = async () => new Promise(() => {})
        const { data, $x } = await load({ manifest: man, auth: signedInTo('tA') })
        window.ManifestDataConfig.getScope = ds => ds?.scope || null
        const seen = await watchItems($x, data)
        expect(seen.at(-1)).toBe('A-old')
    }, 20000)

    it('a landed load stamps its team on the snapshot', async () => {
        const { man } = teamSetup()
        const { main, records } = await load({ manifest: man, auth: signedInTo('tA') })
        window.ManifestDataConfig.getScope = ds => ds?.scope || null
        await main.loadDataSource('items')
        await settle(1200)
        const rec = (await records()).find(r => r.source === 'items')
        expect(rec?.team).toBe('tA')
        expect(ids(rec?.rows)).toEqual(['tA-items'])
    }, 20000)
})
