// @vitest-environment happy-dom
/**
 * Identity changes while a load is in flight: a reload under a new identity never joins the
 * read started under the old one. The old read never lands, binds realtime or saves a snapshot;
 * callers awaiting it get the fresh result. Harness as tests/data-persist.test.js.
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

let pageIso = null
async function load(opts = {}) {
    window.Alpine = Alpine
    if (pageIso) pageIso.release()
    pageIso = isolateVm()
    // Silence the previous page-load's instance (shared happy-dom window)
    const prev = window.ManifestDataPersist
    if (prev) { prev.state.enabled = false; prev.state.scopeExpr = null; prev.state.pending.clear(); clearTimeout(prev.state.writeTimer) }
    if (!opts.keepAuth) Alpine.store('auth', opts.auth || { currentTeam: opts.team ? { $id: opts.team } : null })
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
afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = ''; if (pageIso) { pageIso.release(); pageIso = null } })


const lastKnown = (id) => window.localStorage.setItem('manifest:auth:state', JSON.stringify(id ? { isAuthenticated: true, user: { $id: id } } : { isAuthenticated: false, user: null }))
const signedOut = () => ({ _initialized: true, isAuthenticated: false, user: null })
const signedIn = id => ({ _initialized: true, isAuthenticated: true, user: { $id: id } })
const pub = (tier = 'boot') => ({ data: { posts: { appwriteTableId: 'posts', persist: { tier } } } })

// Every read is held until released; it reads as whoever is signed in when it is issued
let reads
const who = () => Alpine.store('auth')?.user?.$id || 'anon'
const releaseAll = async () => { reads.forEach(r => r.open()); await settle(80) }
beforeEach(() => {
    reads = []
    window.ManifestDataQueries = { buildAppwriteQueries: async () => [] }
    window.ManifestDataAppwrite = {
        loadTableRows: async () => {
            const read = { who: who() }
            read.gate = new Promise(r => { read.open = r })
            reads.push(read)
            await read.gate
            return rows(`${read.who}-`, 1)
        }
    }
})
afterEach(() => { delete window.ManifestDataQueries; delete window.ManifestDataAppwrite; delete window.ManifestDataRealtime; window.localStorage.removeItem('manifest:auth:state') })

const signIn = (auth, dispatch, id) => { Object.assign(auth(), signedIn(id)); dispatch('manifest:auth:login') }
const signOut = (auth, dispatch) => { Object.assign(auth(), signedOut()); dispatch('manifest:auth:logout') }
const savedFor = (records, id, prefix) => records().filter(r => r.identity === id && ids(r.rows).some(i => i.startsWith(prefix)))

describe('identity change during an in-flight load', () => {
    it('a sign-in while the signed-out load is in flight: only the signed-in rows land, and only they are saved for u1', async () => {
        lastKnown(null)
        const { data, main, auth, dispatch, persist, records } = await load({ manifest: pub(), auth: signedOut() })
        main.loadDataSource('posts')
        await settle(10)
        signIn(auth, dispatch, 'u1')
        await settle(10)
        expect(reads.map(r => r.who)).toEqual(['anon', 'u1'])
        await releaseAll()
        expect(ids(data().posts)).toEqual(['u1-0'])
        await persist.flushPending()
        expect(savedFor(records, 'u1', 'anon')).toEqual([])
        expect(savedFor(records, 'u1', 'u1')).toHaveLength(1)
    })

    it('the stale signed-out read landing after the fresh one never overwrites it', async () => {
        lastKnown(null)
        const { data, main, auth, dispatch, persist, records } = await load({ manifest: pub(), auth: signedOut() })
        main.loadDataSource('posts')
        await settle(10)
        signIn(auth, dispatch, 'u1')
        await settle(10)
        reads[1].open(); await settle(60)
        expect(ids(data().posts)).toEqual(['u1-0'])
        reads[0].open(); await settle(60)
        expect(ids(data().posts)).toEqual(['u1-0'])
        expect(data()._posts_state?.loading).toBe(false)
        await persist.flushPending()
        expect(savedFor(records, 'u1', 'anon')).toEqual([])
    })

    it('a caller awaiting the abandoned load gets the fresh rows', async () => {
        lastKnown(null)
        const { main, auth, dispatch } = await load({ manifest: pub(), auth: signedOut() })
        const first = main.loadDataSource('posts')
        await settle(10)
        signIn(auth, dispatch, 'u1')
        await settle(10)
        await releaseAll()
        expect(ids(await first)).toEqual(['u1-0'])
    })

    it('a reload that joined the abandoned load gets the fresh rows', async () => {
        lastKnown(null)
        const { main, auth, dispatch } = await load({ manifest: pub(), auth: signedOut() })
        main.loadDataSource('posts')
        await settle(10)
        const joiner = main.loadDataSource('posts', 'en', { reload: true })
        expect(reads).toHaveLength(1)
        signIn(auth, dispatch, 'u1')
        await settle(10)
        await releaseAll()
        expect(ids(await joiner)).toEqual(['u1-0'])
    })

    it('a sign-in while the signed-out landing is queued: it never applies or saves for u1', async () => {
        lastKnown(null)
        const { data, main, auth, dispatch, persist, records, store } = await load({ manifest: pub(), auth: signedOut() })
        const landRows = store.landRows
        let fired = false
        store.landRows = (name, list, options) => {
            const queued = landRows(name, list, options)
            if (!fired && ids(list).includes('anon-0')) { fired = true; signIn(auth, dispatch, 'u1') }
            return queued
        }
        main.loadDataSource('posts')
        await settle(10)
        reads[0].open(); await settle(80)
        expect(fired).toBe(true)
        expect(ids(data().posts)).not.toContain('anon-0')
        await persist.flushPending()
        expect(savedFor(records, 'u1', 'anon')).toEqual([])
        store.landRows = landRows
        await releaseAll()
        expect(ids(data().posts)).toEqual(['u1-0'])
        await persist.flushPending()
        expect(savedFor(records, 'u1', 'anon')).toEqual([])
    })

    it('a sign-out while the signed-in load is in flight: u1 rows never show and are never saved signed out', async () => {
        lastKnown('u1')
        const { data, main, auth, dispatch, persist, records } = await load({ manifest: pub(), auth: signedIn('u1') })
        main.loadDataSource('posts')
        await settle(10)
        signOut(auth, dispatch)
        await settle(10)
        expect(reads.map(r => r.who)).toEqual(['u1', 'anon'])
        reads[1].open(); await settle(60)
        reads[0].open(); await settle(60)
        expect(ids(data().posts)).toEqual(['anon-0'])
        await persist.flushPending()
        expect(records().filter(r => r.identity !== 'u1' && ids(r.rows).includes('u1-0'))).toEqual([])
    })

    it('an account switch u1 -> u2 mid-load: only u2 rows land', async () => {
        lastKnown('u1')
        const { data, main, auth, dispatch, persist, records } = await load({ manifest: pub(), auth: signedIn('u1') })
        main.loadDataSource('posts')
        await settle(10)
        signIn(auth, dispatch, 'u2')
        await settle(10)
        await releaseAll()
        expect(ids(data().posts)).toEqual(['u2-0'])
        await persist.flushPending()
        expect(savedFor(records, 'u2', 'u1')).toEqual([])
    })

    it('rapid sign-in then sign-out mid-load: ends signed out, nothing saved for u1', async () => {
        lastKnown(null)
        const { data, main, auth, dispatch, persist, records } = await load({ manifest: pub(), auth: signedOut() })
        main.loadDataSource('posts')
        await settle(10)
        signIn(auth, dispatch, 'u1')
        signOut(auth, dispatch)
        await settle(10)
        await releaseAll()
        expect(ids(data().posts)).toEqual(['anon-0'])
        await persist.flushPending()
        expect(records().filter(r => r.identity === 'u1')).toEqual([])
    })

    it('rapid sign-in, sign-out, sign-in as u2 with every read held: only u2 rows land, in any release order', async () => {
        lastKnown(null)
        const { data, main, auth, dispatch, persist, records } = await load({ manifest: pub(), auth: signedOut() })
        main.loadDataSource('posts')
        await settle(10)
        signIn(auth, dispatch, 'u1'); await settle(5)
        signOut(auth, dispatch); await settle(5)
        signIn(auth, dispatch, 'u2'); await settle(10)
        const last = reads[reads.length - 1]
        expect(last.who).toBe('u2')
        last.open(); await settle(40)
        for (const r of [...reads].reverse()) { r.open(); await settle(20) }
        await settle(60)
        expect(ids(data().posts)).toEqual(['u2-0'])
        await persist.flushPending()
        expect(records().filter(r => r.identity !== 'u2' || ids(r.rows).some(i => !i.startsWith('u2')))).toEqual([])
    })

    it('realtime binds only for the fresh load, never the abandoned one', async () => {
        lastKnown(null)
        const { data, main, auth, dispatch } = await load({ manifest: pub(), auth: signedOut() })
        const subs = []
        window.ManifestDataRealtime = {
            subscriptions: new Map(),
            async subscribeToTable(name, db, table, scope, cb, isCurrent) { const s = { who: who(), isCurrent, live: true }; subs.push(s); return () => { s.live = false } },
            unsubscribeFromDataSource() {}
        }
        main.loadDataSource('posts')
        await settle(10)
        signIn(auth, dispatch, 'u1')
        await settle(10)
        reads[0].open(); await settle(40)
        expect(subs).toEqual([])
        reads[1].open(); await settle(60)
        expect(subs.map(s => s.who)).toEqual(['u1'])
        expect(subs[0].isCurrent()).toBe(true)
        expect(ids(data().posts)).toEqual(['u1-0'])
    })

    it('a REST source with $auth. queries: a sign-in mid-load reloads as the signed-in user', async () => {
        lastKnown(null)
        const manifest = { data: { feed: { url: 'https://api.test/feed', queries: [['equal', 'owner', '$auth.user.$id']], persist: true } } }
        const { data, main, auth, dispatch, net, gate, persist, records } = await load({ manifest, auth: signedOut() })
        net.rowsFor = (name, _team) => rows(`${who()}-`, 1)
        const open = gate()
        main.loadDataSource('feed')
        await settle(10)
        signIn(auth, dispatch, 'u1')
        await settle(10)
        open(); await settle(80)
        expect(net.byName.feed).toBe(2)
        expect(ids(data().feed)).toEqual(['u1-0'])
        await persist.flushPending()
        expect(savedFor(records, 'u1', 'anon')).toEqual([])
    })

    it('a REST source not bound to identity: a reload mid-load still joins it', async () => {
        lastKnown(null)
        const manifest = { data: { plain: { url: 'https://api.test/plain' } } }
        const { data, main, auth, dispatch, net, gate } = await load({ manifest, auth: signedOut() })
        const open = gate()
        main.loadDataSource('plain')
        await settle(10)
        signIn(auth, dispatch, 'u1')
        main.reloadDataSource('plain')
        await settle(10)
        open(); await settle(80)
        expect(net.byName.plain).toBe(1)
        expect(ids(data().plain)).toEqual(['p0'])
    })

    it('a static source: an auth change mid-load leaves it alone', async () => {
        lastKnown(null)
        const manifest = { data: { local: '/data/local.json' } }
        let open; const p = new Promise(r => { open = r }); let n = 0
        const { data, main, auth, dispatch } = await load({ manifest, auth: signedOut() })
        window.ManifestDataLoaders = { loadLocalFile: async () => { n++; await p; return [{ $id: 'l0' }] } }
        main.loadDataSource('local')
        await settle(10)
        signIn(auth, dispatch, 'u1')
        main.reloadDataSource('local')
        await settle(10)
        open(); await settle(80)
        expect(n).toBe(1)
        expect(ids(data().local)).toEqual(['l0'])
        delete window.ManifestDataLoaders
    })
})
