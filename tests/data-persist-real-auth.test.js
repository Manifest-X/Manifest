// @vitest-environment happy-dom
/**
 * Persisted `$x` with the real auth store (the 2026-10-07 review probes, I2 round 3):
 * an offline boot paints the last-known user's snapshot; the session check, refresh(), a
 * cross-tab sign-in/out or account switch, and a logout each leave only the confirmed
 * identity's rows on the page and in IndexedDB, with one reload where one is due.
 * Data harness as tests/data-persist.test.js; each page load's window listeners are
 * released before the next (a stale load would answer later auth events).
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

const AUTH_STORE = readFileSync(path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.store.js'), 'utf8')
const offlineErr = () => Object.assign(new Error('Failed to fetch'), { code: 0, type: '' })
const noSession = () => Object.assign(new Error('missing scope'), { code: 401, type: 'general_unauthorized_scope' })

// Real auth store on the real happy-dom window
const added = []
const events = []
async function realAuth({ account, guestAuto = false }) {
    const acct = { current: account }
    const win = new Proxy(window, {
        get(t, k) {
            if (k === 'addEventListener') return (type, fn, o) => { added.push([type, fn]); t.addEventListener(type, fn, o) }
            if (k === 'dispatchEvent') return (e) => { events.push(e.type); return t.dispatchEvent(e) }
            const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v
        }
    })
    window.ManifestAppwriteAuthConfig = {
        getAppwriteClient: async () => ({ account: new Proxy({}, { get: (_, k) => acct.current[k] }) }),
        getAppwriteConfig: async () => ({ guestAuto, guestManual: false, teams: false }),
    }
    let initCb = null
    const doc = { visibilityState: 'visible', addEventListener: (ev, cb) => { if (ev === 'alpine:init') initCb = cb } }
    const ctx = { window: win, document: doc, Alpine, console: { ...console, warn: () => {} }, setTimeout, clearTimeout, Promise, Date, localStorage: window.localStorage, sessionStorage: window.sessionStorage, CustomEvent: window.CustomEvent }
    vm.createContext(ctx)
    vm.runInContext(AUTH_STORE, ctx)
    initCb()
    const store = Alpine.store('auth')
    return { store, acct, init: async () => { for (let i = 0; i < 200 && !store._initialized; i++) await settle(2) } }
}
afterEach(() => { for (const [t, fn] of added.splice(0)) window.removeEventListener(t, fn); events.length = 0; delete window.ManifestAppwriteAuthConfig; window.localStorage.removeItem('manifest:auth:state') })

const pub = (tier = 'boot') => ({ appwrite: { auth: {} }, data: { posts: { appwriteTableId: 'posts', persist: { tier } } } })
const lastKnown = (id) => window.localStorage.setItem('manifest:auth:state', JSON.stringify(id ? { isAuthenticated: true, isAnonymous: false, user: { $id: id } } : { isAuthenticated: false, user: null }))
let cookie, calls
beforeEach(() => {
    cookie = null; calls = 0
    window.ManifestDataQueries = { buildAppwriteQueries: async () => [] }
    window.ManifestDataAppwrite = { loadTableRows: async () => { calls++; const who = cookie || 'anon'; await settle(5); if (who === 'OFFLINE') throw Object.assign(new Error('offline'), { code: 0 }); return rows(`${who}-`, 1) } }
})
afterEach(() => { delete window.ManifestDataQueries; delete window.ManifestDataAppwrite })
const u1acct = { get: async () => ({ $id: 'u1' }), listSessions: async () => ({ sessions: [{ $id: 's1', current: true, provider: 'email' }] }) }
const storageEvt = async (value) => { const oldValue = window.localStorage.getItem('manifest:auth:state'); const newValue = JSON.stringify(value); window.localStorage.setItem('manifest:auth:state', newValue); window.dispatchEvent(new window.StorageEvent('storage', { key: 'manifest:auth:state', oldValue, newValue })); await settle(60) }

describe('real auth store', () => {
    for (const guestAuto of [false, true]) it(`A-e2e guestAuto=${guestAuto}: offline boot paints u1, recheck finds no session -> u1 rows gone, nothing saved for u1 rows under other id`, async () => {
        lastKnown('u1'); cookie = 'OFFLINE'
        idb.seed(DB(), record('', 'posts', rows('priv', 2), { identity: 'u1' }))
        const { store, acct, init } = await realAuth({ account: { get: async () => { throw offlineErr() } }, guestAuto })
        await init()
        expect(store._sessionUnverified).toBe(true)
        const { data, main, records, persist } = await load({ manifest: pub(), keepAuth: true })
        main.loadDataSource('posts')
        await settle(60)
        expect(ids(data().posts)).toEqual(['priv0', 'priv1'])
        // back online, session expired
        cookie = null
        let guestN = 0
        acct.current = { get: async () => { if (store.isAnonymous) return { $id: 'g' + guestN }; throw noSession() }, createAnonymousSession: async () => ({ $id: 'gs' + (++guestN) }) }
        if (guestAuto) store._createAnonymousSession = async function () { const s = await this._appwrite.account.createAnonymousSession(); this.session = s; this.isAuthenticated = true; this.isAnonymous = true; this.user = await this._appwrite.account.get(); this._syncStateToStorage(this); window.dispatchEvent(new CustomEvent('manifest:auth:anonymous')) }
        const seen = []
        const e = Alpine.effect(() => { seen.push(ids(data().posts).join(',')) }); released.push(e)
        const callsBefore = calls
        window.dispatchEvent(new window.Event('online'))
        await settle(10)
        const right = ids(data().posts)
        await settle(150)
        await persist.flushPending(); await settle(20)
        expect(events).toContain('manifest:auth:session-cleared')
        expect(right).not.toContain('priv0')
        expect(ids(data().posts)).not.toContain('priv0')
        expect(records().filter(r => r.identity !== 'u1' && ids(r.rows).some(i => i.startsWith('priv')))).toEqual([])
        expect(calls - callsBefore).toBeLessThanOrEqual(2)
    })

    it('refresh() during a network error for a verified u1 keeps rows, no event', async () => {
        lastKnown('u1'); cookie = 'u1'
        const { store, acct, init } = await realAuth({ account: u1acct })
        await init()
        const { data, main } = await load({ manifest: pub(), keepAuth: true })
        await main.loadDataSource('posts'); await settle(60)
        expect(ids(data().posts)).toEqual(['u1-0'])
        events.length = 0
        acct.current = { get: async () => { throw offlineErr() } }
        await expect(store.refresh()).rejects.toThrow()
        await settle(60)
        expect(events).toEqual([])
        expect(ids(data().posts)).toEqual(['u1-0'])
        expect(store.user?.$id).toBe('u1')
        // 5xx without type
        acct.current = { get: async () => { throw Object.assign(new Error('bad gw'), { code: 502 }) } }
        await expect(store.refresh()).rejects.toThrow()
        await settle(30)
        expect(ids(data().posts)).toEqual(['u1-0'])
    })

    it('refresh() 401 for verified u1 drops rows once', async () => {
        lastKnown('u1'); cookie = 'u1'
        const { store, acct, init } = await realAuth({ account: u1acct })
        await init()
        const { data, main } = await load({ manifest: pub(), keepAuth: true })
        await main.loadDataSource('posts'); await settle(60)
        cookie = null
        const before = calls
        acct.current = { get: async () => { throw noSession() } }
        events.length = 0
        await expect(store.refresh()).rejects.toThrow()
        await settle(80)
        expect(ids(data().posts)).toEqual(['anon-0'])
        expect(calls - before).toBe(1)
    })

    it('cross-tab sign-in into a signed-out tab: reload once, then repeated syncs do not reload', async () => {
        lastKnown(null)
        const { store, init } = await realAuth({ account: { get: async () => { throw noSession() } } })
        await init()
        const { data, main } = await load({ manifest: pub(), keepAuth: true })
        await main.loadDataSource('posts'); await settle(60)
        expect(ids(data().posts)).toEqual(['anon-0'])
        const before = calls
        cookie = 'u1'
        const u1state = { isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, session: { $id: 's1' } }
        await storageEvt(u1state)
        expect(ids(data().posts)).toEqual(['u1-0'])
        await storageEvt({ ...u1state, otpSent: false, error: null })
        await storageEvt({ ...u1state })
        expect(calls - before).toBe(1)
        expect(store.user.$id).toBe('u1')
    })

    it('cross-tab account switch u1 -> u2 in a verified tab: u1 rows drop', async () => {
        lastKnown('u1'); cookie = 'u1'
        const { init } = await realAuth({ account: u1acct })
        await init()
        const { data, main } = await load({ manifest: pub(), keepAuth: true })
        await main.loadDataSource('posts'); await settle(60)
        const gateRows = (() => { let open; const p = new Promise(r => { open = r }); window.ManifestDataAppwrite.loadTableRows = async () => { calls++; await p; return rows(`${cookie}-`, 1) }; return open })()
        cookie = 'u2'
        await storageEvt({ isAuthenticated: true, isAnonymous: false, user: { $id: 'u2' } })
        expect(ids(data().posts)).not.toContain('u1-0')
        gateRows(); await settle(40)
        expect(ids(data().posts)).toEqual(['u2-0'])
    })

    it('unverified offline tab painting u1, other tab signs out: rows drop', async () => {
        lastKnown('u1'); cookie = 'OFFLINE'
        idb.seed(DB(), record('', 'posts', rows('priv', 2), { identity: 'u1' }))
        const { init } = await realAuth({ account: { get: async () => { throw offlineErr() } } })
        await init()
        const { data, main } = await load({ manifest: pub(), keepAuth: true })
        main.loadDataSource('posts'); await settle(60)
        expect(ids(data().posts)).toEqual(['priv0', 'priv1'])
        cookie = null
        await storageEvt({ isAuthenticated: false, isAnonymous: false, user: null })
        expect(ids(data().posts)).not.toContain('priv0')
    })

    it('online boot same user: snapshot paints before init and init does not reload twice', async () => {
        lastKnown('u1'); cookie = 'u1'
        idb.seed(DB(), record('', 'posts', rows('u1-', 1), { identity: 'u1' }))
        let release
        const p = new Promise(r => { release = r })
        const { store, init } = await realAuth({ account: { get: async () => { await p; return { $id: 'u1' } }, listSessions: async () => ({ sessions: [{ $id: 's1', current: true, provider: 'email' }] }) } })
        const ip = init()
        const { data, main } = await load({ manifest: pub(), keepAuth: true })
        main.loadDataSource('posts'); await settle(30)
        expect(ids(data().posts)).toEqual(['u1-0'])
        const before = calls
        release(); await ip; await settle(80)
        expect(store.user.$id).toBe('u1')
        expect(ids(data().posts)).toEqual(['u1-0'])
    })

    it('online boot, mirror u1, cookie expired: u1 snapshot gone after init and not re-saved', async () => {
        lastKnown('u1'); cookie = null
        idb.seed(DB(), record('', 'posts', rows('priv', 2), { identity: 'u1' }))
        const { init } = await realAuth({ account: { get: async () => { throw noSession() } } })
        const ip = init()
        const { data, main, records, persist } = await load({ manifest: pub(), keepAuth: true })
        main.loadDataSource('posts')
        await ip; await settle(120)
        await persist.flushPending(); await settle(20)
        expect(ids(data().posts)).not.toContain('priv0')
        expect(records().filter(r => r.identity !== 'u1' && ids(r.rows).some(i => i.startsWith('priv')))).toEqual([])
    })
})

describe('logout through the store', () => {
    it('drops the rows and reloads once as signed out', async () => {
        lastKnown('u1'); cookie = 'u1'
        const { store, acct, init } = await realAuth({ account: { ...u1acct, deleteSession: async () => ({}) } })
        await init()
        const { data, main } = await load({ manifest: pub(), keepAuth: true })
        await main.loadDataSource('posts'); await settle(60)
        cookie = null
        const before = calls
        events.length = 0
        await store.logout()
        await settle(80)
        expect(events).toContain('manifest:auth:logout')
        expect(ids(data().posts)).toEqual(['anon-0'])
        expect(calls - before).toBe(1)
    })
})

// Stubbed auth store, events dispatched by hand (the round-2 probes not already in data-persist.test.js)
describe('identity changes before and during the first load', () => {
    const pub = (tier = 'boot') => ({ data: { posts: { appwriteTableId: 'posts', persist: { tier } } } })
    const lastKnown = (id) => window.localStorage.setItem('manifest:auth:state', JSON.stringify(id ? { isAuthenticated: true, user: { $id: id } } : { isAuthenticated: false, user: null }))
    let cookie, calls
    beforeEach(() => {
        cookie = null; calls = 0
        window.ManifestDataQueries = { buildAppwriteQueries: async () => [] }
        window.ManifestDataAppwrite = { loadTableRows: async () => { calls++; const who = cookie || 'anon'; await settle(5); return rows(`${who}-`, 1) } }
    })
    afterEach(() => { delete window.ManifestDataQueries; delete window.ManifestDataAppwrite; window.localStorage.removeItem('manifest:auth:state') })

    it("a snapshot saved for u1 while the session is u2: u2's rows replace it once auth initializes", async () => {
        lastKnown('u1'); cookie = 'u2'
        idb.seed(DB(), record('', 'posts', rows('priv', 2), { identity: 'u1' }))
        const { data, main, auth, dispatch } = await load({ manifest: pub(), auth: { _initialized: false } })
        main.loadDataSource('posts')
        await settle(2)
        Object.assign(auth(), { _initialized: true, isAuthenticated: true, user: { $id: 'u2' } })
        dispatch('manifest:auth:initialized')
        await settle(120)
        expect(ids(data().posts)).toEqual(['u2-0'])
    })

    it('guest-auto with an expired last-known guest: the new guest\'s rows land', async () => {
        lastKnown('g1')
        idb.seed(DB(), record('', 'posts', rows('g', 2), { identity: 'g1' }))
        const { data, main, auth, dispatch } = await load({ manifest: pub(), auth: { _initialized: false } })
        main.loadDataSource('posts')
        await settle(30)
        Object.assign(auth(), { _initialized: true, isAuthenticated: false, user: null, _signInPendingUntil: Date.now() + 5000 })
        dispatch('manifest:auth:initialized')
        await settle(30)
        cookie = 'g2'
        Object.assign(auth(), { isAuthenticated: true, isAnonymous: true, user: { $id: 'g2' }, _signInPendingUntil: 0 })
        dispatch('manifest:auth:anonymous')
        await settle(80)
        expect(ids(data().posts)).toEqual(['g2-0'])
    })

    it('a sign-in after the signed-out load landed reloads as the signed-in user', async () => {
        lastKnown(null)
        const { data, main, auth, dispatch } = await load({ manifest: pub(), auth: { _initialized: true, isAuthenticated: false, user: null } })
        main.loadDataSource('posts')
        await settle(40)
        cookie = 'u1'
        Object.assign(auth(), { isAuthenticated: true, user: { $id: 'u1' } })
        dispatch('manifest:auth:login')
        await settle(80)
        expect(ids(data().posts)).toEqual(['u1-0'])
        expect(calls).toBe(2)
    })
    // Known bug: the sign-in's reload (setupAuthResetListener → loadDataSource({ reload: true }))
    // joins the signed-out read still in flight (main.js "In flight for this source+locale: share
    // it"), so it never runs: the signed-out rows land, stay, and are saved as u1's snapshot.
    it.fails('a sign-in while the signed-out load is in flight: only the signed-in rows land, and only they are saved for u1', async () => {
        lastKnown(null)
        let open; const gateP = new Promise(r => { open = r })
        window.ManifestDataAppwrite.loadTableRows = async () => { calls++; const who = cookie || 'anon'; await gateP; return rows(`${who}-`, 1) }
        const { data, main, auth, dispatch, persist, records } = await load({ manifest: pub(), auth: { _initialized: true, isAuthenticated: false, user: null } })
        main.loadDataSource('posts')
        await settle(10)
        cookie = 'u1'
        Object.assign(auth(), { isAuthenticated: true, user: { $id: 'u1' } })
        dispatch('manifest:auth:login')
        await settle(10); open(); await settle(80)
        expect(ids(data().posts)).toEqual(['u1-0'])
        await persist.flushPending()
        expect(records().filter(r => r.identity === 'u1' && ids(r.rows).includes('anon-0'))).toEqual([])
    })
})

// The review persist probes: snapshots and saves while the identity is unsettled (network hangs)
describe('snapshots while the identity is unsettled', () => {
    const pub = (tier = 'boot') => ({ data: { posts: { appwriteTableId: 'posts', persist: { tier } } } })
    const signedIn = id => ({ _initialized: true, isAuthenticated: true, user: { $id: id } })
    beforeEach(() => {
        window.ManifestDataQueries = { buildAppwriteQueries: async () => [] }
        window.ManifestDataAppwrite = { loadTableRows: () => new Promise(() => {}) }
    })
    afterEach(() => { delete window.ManifestDataQueries; delete window.ManifestDataAppwrite })

    it("auth still booting: a snapshot saved for u1 is not shown before auth confirms who is signed in", async () => {
        idb.seed(DB(), record('', 'posts', rows('p', 2), { identity: 'u1' }))
        const { data, main } = await load({ manifest: pub(), auth: { _initialized: false } })
        main.loadDataSource('posts')
        await settle(60)
        expect(ids(data().posts)).toEqual([])
    })

    it("guest-auto logout: u1's rows flushed while the identity already reads as the guest are never saved for the guest", async () => {
        window.ManifestDataAppwrite = { loadTableRows: async () => { const who = Alpine.store('auth')?.user?.$id || 'anon'; return rows(`${who}-`, 1) } }
        const { main, persist, auth, dispatch, records } = await load({ manifest: pub('lazy'), auth: signedIn('u1') })
        await main.loadDataSource('posts')
        await settle(20)
        Object.assign(auth(), { isAuthenticated: true, isAnonymous: true, user: { $id: 'g1' } })
        await persist.flushPending()
        expect(records().filter(r => r.identity === 'g1' && ids(r.rows).includes('u1-0'))).toEqual([])
        dispatch('manifest:auth:anonymous')
        await settle(20)
        dispatch('manifest:auth:logout')
        await settle(120)
        await persist.flushPending()
        expect(records().filter(r => r.identity !== 'u1' && ids(r.rows).includes('u1-0'))).toEqual([])
    })
})
