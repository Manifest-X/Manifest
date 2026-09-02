// @vitest-environment happy-dom
/**
 * Persisted `$x` (PERF-PRIMITIVES-DESIGN.md §12.2).
 *
 * Same loader pattern as data-stale-first.test.js (real subscripts on real
 * Alpine in a vm context) plus `core/manifest.data.persist.js` and an
 * in-memory IndexedDB double (tests/helpers/indexeddb-double.js) that
 * survives across "page loads" so warm reloads can be replayed.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { createIndexedDB } from './helpers/indexeddb-double.js'

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
    Alpine.store('auth', { currentTeam: opts.team ? { $id: opts.team } : null })
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

    const ctx = {
        window, document, Alpine, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
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
afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = '' })

describe('off by default', () => {
    it('a manifest without `persist` never touches IndexedDB', async () => {
        const { main, persist, $x } = await load({ manifest: { data: { chats: { url: 'https://api.test/chats' } } } })
        await main.loadDataSource('chats')
        await persist.flushPending()
        await settle(20)
        expect(idb.opens).toBe(0)
        expect($x().chats.length).toBe(2)
        expect(window.ManifestData.persistence()).toEqual({ enabled: false, scope: '', sources: [] })
    })

    it('no IndexedDB at all → disabled, loads unaffected', async () => {
        const { main, persist, $x } = await load({ noIndexedDB: true })
        await main.loadDataSource('chats')
        await persist.flushPending()
        expect($x().chats.length).toBe(2)
        expect(persist.persistence().enabled).toBe(false)
    })
})

describe('boot tier', () => {
    it('hydrates before the network with $stale true, then the fresh landing reconciles by replacement', async () => {
        idb.seed(DB(), record('', 'chats', [...rows('c', 2), { $id: 'gone', name: 'stale only' }]))
        const { $x, net, gate, data, effect } = await load()
        expect(net.calls).toBe(0)
        expect(ids(data().chats)).toEqual(['c0', 'c1', 'gone'])
        const open = gate()
        let seen = null
        effect(() => { seen = { stale: $x().chats.$stale, n: $x().chats.length } })
        expect(seen).toEqual({ stale: true, n: 3 })
        await settle(10)
        expect(net.byName.chats).toBe(1) // the first read kicked the network load once
        const c0 = data().chats[0]
        const arr = data().chats
        expect($x().chats.$loading).toBe(true)
        net.rows.chats = [{ $id: 'c0', name: 'renamed', n: 0 }, { $id: 'c1', name: 'c 1', n: 1 }, { $id: 'c2', name: 'c 2', n: 2 }]
        open()
        await settle(60)
        await tick()
        expect(ids(data().chats)).toEqual(['c0', 'c1', 'c2'])
        expect(data().chats[0]).toBe(c0)
        expect(c0.name).toBe('renamed')
        expect(seen).toEqual({ stale: false, n: 3 })
        expect($x().chats.$stale).toBe(false)
        expect($x().chats.$loading).toBe(false)
        expect(net.byName.chats).toBe(1)
        void arr
    })

    it('all boot-tier keys are read in one transaction; a miss costs no network and no rows', async () => {
        const { data, net, persist } = await load()
        expect(data().chats).toBeUndefined()
        expect(data().settings).toBeUndefined()
        expect(net.calls).toBe(0)
        expect(persist.state.hydrated.has('chats')).toBe(true)
        expect(persist.state.hydrated.has('settings')).toBe(true)
        expect(persist.state.hydrated.has('contacts')).toBe(false) // lazy
        expect(idb.opens).toBe(1)
    })

    it('object sources hydrate whole', async () => {
        idb.seed(DB(), record('', 'settings', { theme: 'light', contentType: 'settings' }))
        const { data, persist } = await load()
        expect(data().settings.theme).toBe('light')
        expect(persist.persistence().sources.find(s => s.source === 'settings')).toMatchObject({ rows: 1, stale: true })
    })

    it('a late hydration is discarded once a fresh landing has happened', async () => {
        idb.seed(DB(), record('', 'chats', [...rows('c', 2), { $id: 'gone', name: 'late' }]))
        idb.delayMs = 40 // IndexedDB slower than the network and the boot cap
        const { main, data, $x } = await load()
        expect(data().chats).toBeUndefined()
        await main.loadDataSource('chats')
        expect($x().chats.$stale).toBe(false)
        await settle(200)
        expect(ids(data().chats)).toEqual(['c0', 'c1'])
        expect($x().chats.$stale).toBe(false)
    })
})

describe('lazy tier', () => {
    it('hydrates on the first $x.<source> read and races the network', async () => {
        idb.seed(DB(), record('', 'contacts', rows('k', 3)))
        const { $x, data, net, gate } = await load()
        expect(data().contacts).toBeUndefined()
        const open = gate()
        void $x().contacts
        await settle(30)
        expect(ids(data().contacts)).toEqual(['k0', 'k1', 'k2'])
        expect($x().contacts.$stale).toBe(true)
        expect(net.byName.contacts).toBe(1)
        open()
        await settle(60)
        expect(ids(data().contacts)).toEqual(['k0', 'k1'])
        expect($x().contacts.$stale).toBe(false)
    })
})

describe('write path', () => {
    it('writes are debounced 500ms after the last landing of that source; due sources share one transaction', async () => {
        const { main, records } = await load()
        await main.loadDataSource('chats')
        await settle(300)
        expect(records()).toEqual([])
        await main.loadDataSource('settings')
        await settle(250)
        expect(records().map(r => r.key)).toEqual(['|chats']) // only its own landings restart a source's debounce
        await settle(300)
        expect(records().map(r => r.key).sort()).toEqual(['|chats', '|settings'])
    })

    it('strips configured names, globs and the built-in secret patterns', async () => {
        const { main, persist, records, net } = await load()
        net.rows.contacts = [{ $id: 'k0', name: 'Ann', email: 'a@x', customFields: { a: 1 }, customNote: 'n', apiToken: 't', clientSecret: 's', PASSWORD: 'p', credentialsBlob: 'c', ok: true }]
        await main.loadDataSource('contacts')
        await persist.flushPending()
        const rec = records().find(r => r.source === 'contacts')
        expect(rec.scope).toBe('')
        expect(rec.frameworkVersion).toBe(VERSION)
        expect(typeof rec.savedAt).toBe('number')
        expect(Object.keys(rec.rows[0]).sort()).toEqual(['$id', '_loadedFrom', '_locale', '_sourceType', 'contentType', 'name', 'ok'])
    })

    it('an object source persists whole after strip', async () => {
        const { main, persist, records } = await load()
        await main.loadDataSource('settings')
        await persist.flushPending()
        const rec = records().find(r => r.source === 'settings')
        expect(rec.rows.theme).toBe('dark')
        expect('apiToken' in rec.rows).toBe(false)
    })

    it('maxRows keeps the most recent by `recent`, in their original order', async () => {
        const { main, persist, records, net } = await load()
        net.rows.chats = [
            { $id: 'c0', lastMessageAt: '2026-09-01T00:00:00Z' },
            { $id: 'c1', lastMessageAt: '2026-09-05T00:00:00Z' },
            { $id: 'c2', lastMessageAt: '2026-08-01T00:00:00Z' },
            { $id: 'c3', lastMessageAt: '2026-09-03T00:00:00Z' },
            { $id: 'c4', lastMessageAt: '2026-09-02T00:00:00Z' },
        ]
        await main.loadDataSource('chats')
        await persist.flushPending()
        expect(ids(records().find(r => r.source === 'chats').rows)).toEqual(['c1', 'c3', 'c4'])
    })

    it('persistFilter returning null skips a row', async () => {
        const { main, persist, records } = await load()
        window.ManifestData.persistFilter('chats', row => (row.$id === 'c0' ? null : row))
        await main.loadDataSource('chats')
        await persist.flushPending()
        expect(ids(records().find(r => r.source === 'chats').rows)).toEqual(['c1'])
    })

    it('a quota error disables persistence for the session silently; loads are unaffected', async () => {
        const { main, persist, records, $x, net } = await load()
        idb.failPut = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
        await main.loadDataSource('chats')
        await persist.flushPending()
        expect(records()).toEqual([])
        const diag = persist.persistence()
        expect(diag.enabled).toBe(false)
        expect(diag.disabledReason).toBe('QuotaExceededError')
        net.rows.contacts = rows('k', 4)
        await main.loadDataSource('contacts')
        expect($x().contacts.length).toBe(4)
        await main.reloadDataSource('chats')
        expect($x().chats.length).toBe(2)
    })

    it('realtime-shaped landings re-snapshot; local optimistic writes alone do not', async () => {
        const { main, store, persist, records, data } = await load()
        await main.loadDataSource('chats')
        await persist.flushPending()
        window.ManifestDataMutations.updateEntryInStore('chats', 'c0', { name: 'local' })
        await settle(20)
        expect(persist.state.pending.size).toBe(0)
        await store.landRows('chats', [{ $id: 'c9', name: 'rt' }], { mode: 'append' })
        expect(persist.state.pending.size).toBe(1)
        await persist.flushPending()
        const rec = records().find(r => r.source === 'chats')
        expect(ids(rec.rows)).toEqual(['c0', 'c1', 'c9'])
        expect(rec.rows[0].name).toBe('local') // the next landing carries local writes
        void data
    })
})

describe('validity', () => {
    it('expired entries are ignored and deleted', async () => {
        idb.seed(DB(), record('', 'chats', rows('c', 2), { savedAt: Date.now() - 8 * DAY }))
        const { data, records } = await load()
        await settle(30)
        expect(data().chats).toBeUndefined()
        expect(records()).toEqual([])
    })

    it('a frameworkVersion major/minor mismatch is ignored and deleted', async () => {
        idb.seed(DB(), record('', 'chats', rows('c', 2), { frameworkVersion: '0.4.9' }))
        idb.seed(DB(), record('', 'settings', { theme: 'x' }, { frameworkVersion: '0.5.1' }))
        const { data, records } = await load()
        await settle(30)
        expect(data().chats).toBeUndefined()
        expect(data().settings.theme).toBe('x')
        expect(records().map(r => r.source)).toEqual(['settings'])
    })

    it('ttl is per source and parsed from duration strings', async () => {
        const manifest = defaultManifest()
        manifest.data.chats.persist.ttl = '1h'
        idb.seed(DB(), record('', 'chats', rows('c', 2), { savedAt: Date.now() - 2 * 3600000 }))
        const { data, persist } = await load({ manifest })
        expect(persist.state.sources.get('chats').ttl).toBe(3600000)
        expect(persist.state.sources.get('settings').ttl).toBe(7 * DAY)
        expect(data().chats).toBeUndefined()
    })
})

describe('scope', () => {
    it('is the expression value, "" while null/undefined, keyed into the record', async () => {
        const { persist, main, records } = await load({ team: 'A' })
        expect(persist.persistence().scope).toBe('A')
        await main.loadDataSource('chats')
        await persist.flushPending()
        expect(records()[0].key).toBe('A|chats')
        expect(records()[0].scope).toBe('A')
    })

    it('a scope change wipes the previous scope, clears memory rows, and rehydrates — no cross-scope row at any step', async () => {
        idb.seed(DB(), record('A', 'chats', rows('a', 2)))
        idb.seed(DB(), record('B', 'chats', rows('b', 1)))
        idb.seed(DB(), record('B', 'settings', { theme: 'b' }))
        const { $x, data, net, gate, auth, dispatch, records, effect, persist } = await load({ team: 'A' })
        // the response is shaped by the team the REQUEST was made for (a real server ignores later switches)
        net.rowsFor = (name, team) => (team === 'B' ? { chats: rows('b', 2) }[name] : { chats: rows('a', 3) }[name]) || []
        expect(ids(data().chats)).toEqual(['a0', 'a1'])
        const open = gate() // the A request stays in flight across the switch
        void $x().chats
        await settle(10)
        expect(net.byName.chats).toBe(1)

        // Observe every version of the source from the switch on
        const seen = []
        effect(() => { seen.push(ids(data().chats)) })
        expect(seen).toEqual([['a0', 'a1']])
        seen.length = 0

        auth().currentTeam = { $id: 'B' }
        dispatch('manifest:auth:teams-loaded')
        // synchronously after the event: memory cleared, nothing from A
        expect(data().chats).toBe(null)
        expect(persist.persistence().scope).toBe('B')
        for (let i = 0; i < 30 && !(data().chats && data().chats.length); i++) await settle(5)
        expect(ids(data().chats)).toEqual(['b0'])
        expect($x().chats.$stale).toBe(true)
        expect(data().settings.theme).toBe('b')
        expect(records().map(r => r.key).sort()).toEqual(['B|chats', 'B|settings'])
        await settle(10)
        expect(net.byName.chats).toBe(2) // B's own request, kicked by the read of hydrated rows

        open() // A's response (superseded) lands nowhere; B's reconciles
        await settle(60)
        expect(ids(data().chats)).toEqual(['b0', 'b1'])
        expect($x().chats.$loading).toBe(false)
        expect($x().chats.$stale).toBe(false)
        for (const snapshot of seen) expect(snapshot.some(id => id.startsWith('a'))).toBe(false)
        expect(seen.length).toBeGreaterThan(2)
    })

    it('re-evaluates reactively when the auth store changes without an event', async () => {
        idb.seed(DB(), record('B', 'chats', rows('b', 1)))
        const { data, auth, persist } = await load({ team: 'A' })
        auth().currentTeam = { $id: 'B' }
        await settle(30)
        expect(persist.persistence().scope).toBe('B')
        expect(ids(data().chats)).toEqual(['b0'])
    })

    it('evaluation errors fall back to "" without throwing', async () => {
        const manifest = defaultManifest()
        manifest.persistence.scope = '$nothing.here.$id'
        const { persist } = await load({ manifest })
        expect(persist.persistence().scope).toBe('')
    })
})

describe('$wipe', () => {
    async function seeded() {
        const ctx = await load({ team: 'A' })
        idb.seed(DB(), record('A', 'chats', rows('a', 2)))
        idb.seed(DB(), record('A', 'settings', { theme: 'a' }))
        idb.seed(DB(), record('B', 'chats', rows('b', 2)))
        return ctx
    }
    it('$wipe(source) deletes that source in the current scope only', async () => {
        const { $x, records } = await seeded()
        await $x().$wipe('chats')
        expect(records().map(r => r.key).sort()).toEqual(['A|settings', 'B|chats'])
    })
    it('$wipe() deletes every persisted source of the current scope', async () => {
        const { $x, records } = await seeded()
        await $x().$wipe()
        expect(records().map(r => r.key)).toEqual(['B|chats'])
    })
    it('$wipe({ all: true }) clears every scope', async () => {
        const { $x, records } = await seeded()
        await $x().$wipe({ all: true })
        expect(records()).toEqual([])
    })
    it('a pending debounced write does not resurrect a wiped source', async () => {
        const { $x, main, persist, records } = await seeded()
        await main.loadDataSource('chats')
        expect(persist.state.pending.has('chats')).toBe(true)
        await $x().$wipe('chats')
        await settle(600)
        expect(records().map(r => r.key).sort()).toEqual(['A|settings', 'B|chats'])
    })
})

describe('auth events', () => {
    it('logout wipes the scope and clears memory rows', async () => {
        const { main, persist, records, auth, dispatch, data } = await load({ team: 'A' })
        idb.seed(DB(), record('B', 'chats', rows('b', 2)))
        await main.loadDataSource('chats')
        await persist.flushPending()
        expect(records().map(r => r.key).sort()).toEqual(['A|chats', 'B|chats'])
        auth().currentTeam = null
        dispatch('manifest:auth:logout')
        await settle(40)
        expect(records().map(r => r.key)).toEqual(['B|chats'])
        expect(data().chats).toBe(null)
        expect(persist.persistence().scope).toBe('')
    })

    it('session-cleared wipes the single-tenant scope too', async () => {
        const manifest = defaultManifest()
        delete manifest.persistence
        const { main, persist, records, dispatch } = await load({ manifest })
        await main.loadDataSource('chats')
        await persist.flushPending()
        expect(records().map(r => r.key)).toEqual(['|chats'])
        dispatch('manifest:auth:session-cleared')
        await settle(40)
        expect(records()).toEqual([])
    })
})

describe('diagnostics', () => {
    it('ManifestData.persistence() reports scope, tiers, row counts and staleness', async () => {
        const savedAt = Date.now() - 1000
        idb.seed(DB(), record('A', 'chats', rows('a', 2), { savedAt }))
        const { main, persist } = await load({ team: 'A' })
        const before = window.ManifestData.persistence()
        expect(before.enabled).toBe(true)
        expect(before.scope).toBe('A')
        expect(before.sources.find(s => s.source === 'chats')).toEqual({ source: 'chats', tier: 'boot', rows: 2, savedAt, stale: true })
        expect(before.sources.find(s => s.source === 'contacts')).toEqual({ source: 'contacts', tier: 'lazy', rows: null, savedAt: null, stale: true })
        await main.loadDataSource('chats')
        await persist.flushPending()
        const after = window.ManifestData.persistence().sources.find(s => s.source === 'chats')
        expect(after.stale).toBe(false)
        expect(after.savedAt).toBeGreaterThan(savedAt)
    })
})

describe('shared record store (primitive 3 surface)', () => {
    it('reads/writes stamped records under the scope prefix; scope wipes cover them', async () => {
        const { persist, records, auth, dispatch } = await load({ team: 'A' })
        const r = persist.records
        expect(r.enabled()).toBe(true)
        expect(r.key('chat', 'conv1')).toBe('A|chat|conv1')
        await r.put([{ key: r.key('chat', 'conv1'), rows: [{ id: 'm1' }] }, { key: r.key('chat', 'conv2'), rows: [] }])
        const stored = records().find(x => x.key === 'A|chat|conv1')
        expect(stored).toMatchObject({ scope: 'A', frameworkVersion: VERSION, locale: 'en', rows: [{ id: 'm1' }] })
        expect(typeof stored.savedAt).toBe('number')
        const [hit, miss] = await r.get(['A|chat|conv1', 'A|chat|nope'])
        expect(hit.rows).toEqual([{ id: 'm1' }])
        expect(miss).toBeUndefined()
        expect(r.valid(hit)).toBe(true)
        expect(r.valid({ ...hit, savedAt: Date.now() - 2 * DAY }, DAY)).toBe(false)
        expect(await r.keys('A|chat|')).toEqual(['A|chat|conv1', 'A|chat|conv2'])
        await r.delete(['A|chat|conv2'])
        expect(await r.keys('A|chat|')).toEqual(['A|chat|conv1'])
        auth().currentTeam = { $id: 'B' }
        dispatch('manifest:auth:teams-loaded')
        await settle(40)
        expect(records().map(x => x.key)).toEqual([])
        expect(r.key('chat', 'conv1')).toBe('B|chat|conv1')
    })

    it('enable() turns the store on when no $x source opted in', async () => {
        const { persist } = await load({ manifest: { data: { chats: { url: 'https://api.test/chats' } } } })
        expect(persist.records.enabled()).toBe(false)
        expect(persist.records.enable()).toBe(true)
        await persist.records.put([{ key: persist.records.key('chat', 'c'), rows: [] }])
        expect(await persist.records.keys('|chat|')).toEqual(['|chat|c'])
    })
})

describe('API-URL sources (P5 follow-up)', () => {
    it('a failed reload keeps live rows and sets $error — never the default value', async () => {
        const manifest = defaultManifest()
        manifest.data.chats.defaultValue = []
        const { main, net, $x, data } = await load({ manifest, realApi: true })
        await main.loadDataSource('chats')
        const c0 = data().chats[0]
        expect($x().chats.length).toBe(2)
        net.fetchOk = false
        const result = await main.reloadDataSource('chats')
        expect(result).toBe(null)
        expect($x().chats.length).toBe(2)
        expect(data().chats[0]).toBe(c0)
        expect($x().chats.$error).toMatch(/500/)
        expect($x().chats.$loading).toBe(false)
        expect($x().chats.$stale).toBe(false)
    })

    it('a failed first load lands the default value with $error set and stays stale', async () => {
        const manifest = defaultManifest()
        manifest.data.plain.defaultValue = [{ $id: 'fallback' }]
        const { main, net, $x } = await load({ manifest, realApi: true })
        net.fetchOk = false
        await main.loadDataSource('plain')
        expect(ids(Alpine.store('data').plain)).toEqual(['fallback'])
        expect($x().plain.$error).toMatch(/500/)
        expect($x().plain.$stale).toBe(true)
        expect($x().plain.$ready).toBe(true)
    })
})
