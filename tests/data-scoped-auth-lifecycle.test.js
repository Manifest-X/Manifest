// @vitest-environment happy-dom
/**
 * Scoped Appwrite sources across the auth lifecycle: logout drops the previous
 * identity's rows at once (user and team scopes), a signed-in user with zero
 * teams settles empty, a pending guest-auto/callback sign-in holds the source
 * unsettled (one render-ready) with a bounded fallback, loads/realtime from a
 * superseded identity never land, the auth store announces every logout, and
 * overlapping locale changes don't clear each other's _localeChanging.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { isolateVm } from './helpers/vm-isolation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, '../src/scripts/data')
const SUBSCRIPTS = [
    'core/manifest.data.config.js',
    'appwrite/manifest.data.queries.js',
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
const AUTH_STORE = readFileSync(path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.store.js'), 'utf8')

const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
const signedOut = () => ({ _initialized: true, isAuthenticated: false, isAnonymous: false, user: null, currentTeam: null, teams: [] })
const signedIn = (id = 'u1', team = null) => ({
    _initialized: true, isAuthenticated: true, isAnonymous: false, user: { $id: id },
    currentTeam: team ? { $id: team } : null, teams: team ? [{ $id: team }] : []
})
let iso = null

// Rows are tagged with the identity the read ran under
async function load(auth, scope, { appwriteAuth, extra = {}, fetch, loadRows, listFiles, realtime } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', auth)
    window.__manifestRenderReady = false

    const manifest = {
        appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db', ...(appwriteAuth ? { auth: appwriteAuth } : {}) },
        data: { projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope }, ...extra }
    }
    const net = { tableCalls: 0 }
    window.ManifestDataAppwrite = {
        loadTableRows: async (...args) => {
            net.tableCalls++
            if (loadRows) return loadRows(...args)
            const a = Alpine.store('auth')
            const who = a.user?.$id || 'anon'
            return [{ $id: `${who}-0` }, { $id: `${who}-1` }]
        },
        listBucketFiles: async (...args) => listFiles ? listFiles(...args) : []
    }
    if (realtime) window.ManifestDataRealtime = realtime
    else delete window.ManifestDataRealtime
    window.ManifestComponentsRegistry = { manifest }

    iso = isolateVm()
    const ctx = {
        window, document, Alpine, console, ...iso.timers, clearTimeout, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        ...(fetch ? { fetch } : {}),
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
    await settle(200)

    const ready = []
    window.addEventListener('manifest:render-ready', e => ready.push(e.detail))
    const ids = () => Array.from(Alpine.store('data').projects ?? []).map(r => r.$id)
    const state = () => Alpine.store('data')._projects_state
    return { net, ready, ids, state, main: window.ManifestDataMain }
}

function deferred() { let resolve; const p = new Promise(r => { resolve = r }); return { p, resolve } }

function mockRealtime() {
    const subs = new Map()
    const cbs = new Map()
    return {
        subs, cbs,
        gate: null,
        calls: 0,
        async subscribeToTable(name, db, table, scope, cb) { this.calls++; if (this.gate) await this.gate; subs.set(name, 1); cbs.set(name, cb) },
        async subscribeToStorageBucket(name, bucket, scope, cb) { this.calls++; if (this.gate) await this.gate; subs.set(name, 1); cbs.set(name, cb) },
        unsubscribeFromDataSource: name => { subs.delete(name); cbs.delete(name) },
    }
}

const MINE = { mine: { appwriteTableId: 'mine', appwriteDatabaseId: 'db', queries: [['equal', 'ownerId', '$auth.user.$id']] } }
const mineIds = () => Array.from(Alpine.store('data').mine ?? []).map(r => r.$id)

function logout(next = signedOut(), type = 'manifest:auth:logout') {
    Object.assign(Alpine.store('auth'), next)
    window.dispatchEvent(new CustomEvent(type))
}

afterEach(() => {
    iso?.release()
    iso = null
})

describe('logout clears scoped rows', () => {
    it('user scope: previous user rows drop at once and the source settles empty', async () => {
        const { net, ids, state, main } = await load(signedIn('u1'), 'user')
        await main.loadDataSource('projects')
        await settle(60)
        expect(ids()).toEqual(['u1-0', 'u1-1'])

        logout()
        await settle(60)
        expect(ids()).toEqual([])
        expect(state().ready).toBe(true)
        expect(state().loading).toBe(false)
        expect(net.tableCalls).toBe(1)
    })

    it('session-cleared does the same', async () => {
        const { ids, main } = await load(signedIn('u1'), 'user')
        await main.loadDataSource('projects')
        await settle(60)
        logout(signedOut(), 'manifest:auth:session-cleared')
        await settle(60)
        expect(ids()).toEqual([])
    })

    it('team scope clears immediately, not after the 2s team poller', async () => {
        const { ids, main } = await load(signedIn('u1', 't1'), 'teams', { appwriteAuth: { teams: {} } })
        await main.loadDataSource('projects')
        await settle(60)
        expect(ids()).toEqual(['u1-0', 'u1-1'])

        logout()
        await settle(60)
        expect(ids()).toEqual([])
    })

    it('guest-auto logout reloads under the new guest, and the team poller does not reload again', async () => {
        const { net, ids, main } = await load(signedIn('u1', 't1'), 'team', { appwriteAuth: { teams: { guests: true } } })
        await main.loadDataSource('projects')
        await settle(60)
        expect(net.tableCalls).toBe(1)

        logout({ ...signedIn('g1', 'gt1'), isAnonymous: true })
        await settle(80)
        expect(ids()).toEqual(['g1-0', 'g1-1'])
        expect(net.tableCalls).toBe(2)

        await settle(2300)
        expect(net.tableCalls).toBe(2)
    }, 5000)

    it('a source never read is left alone', async () => {
        const { net } = await load(signedIn('u1'), 'user')
        logout()
        await settle(60)
        expect(Alpine.store('data')._projects_state).toBeUndefined()
        expect(net.tableCalls).toBe(0)
    })
})

describe('signed in with zero teams', () => {
    it('settles empty once teams have loaded', async () => {
        const { net, ready, state, main } = await load(signedIn('u1'), 'teams', { appwriteAuth: { teams: {} } })
        await main.loadDataSource('projects')
        await settle(60)
        expect(state()?.ready).not.toBe(true)

        window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'))
        await settle(250)
        expect(state().ready).toBe(true)
        expect(state().loading).toBe(false)
        expect(net.tableCalls).toBe(0)
        expect(ready.length).toBe(1)
    })

    it('settles empty at once when teams are not configured', async () => {
        const { state, main } = await load(signedIn('u1'), 'team')
        await main.loadDataSource('projects')
        await settle(60)
        expect(state().ready).toBe(true)
    })

    it('a guest without guest teams settles empty', async () => {
        const { state, main } = await load({ ...signedIn('g1'), isAnonymous: true }, 'team', { appwriteAuth: { teams: { guests: 'false' } } })
        await main.loadDataSource('projects')
        await settle(60)
        expect(state().ready).toBe(true)
    })
})

describe('pending guest-auto / callback sign-in', () => {
    it('holds the source unsettled, then fires render-ready once with the guest rows', async () => {
        const { ready, ids, state, main } = await load(signedOut(), 'user')
        Alpine.store('auth')._signInPendingUntil = Date.now() + 2000
        await main.loadDataSource('projects')
        await settle(250)
        expect(state().ready).not.toBe(true)
        expect(ready.length).toBe(0)

        Object.assign(Alpine.store('auth'), { ...signedIn('g1'), isAnonymous: true })
        window.dispatchEvent(new CustomEvent('manifest:auth:anonymous'))
        await settle(250)
        expect(ids()).toEqual(['g1-0', 'g1-1'])
        expect(ready.length).toBe(1)

        await settle(2000)
        expect(ready.length).toBe(1)
        expect(ids()).toEqual(['g1-0', 'g1-1'])
    }, 5000)

    it('a sign-in that never lands still settles empty after the deadline', async () => {
        const { ready, state, main } = await load(signedOut(), 'user')
        Alpine.store('auth')._signInPendingUntil = Date.now() + 300
        await main.loadDataSource('projects')
        await settle(100)
        expect(state().ready).not.toBe(true)
        await settle(500)
        expect(state().ready).toBe(true)
        expect(Array.from(Alpine.store('data').projects)).toEqual([])
        expect(ready.length).toBe(1)
    })
})

describe('logout races (in-flight loads, realtime, re-login)', () => {
    it('a load in flight at logout neither lands nor re-subscribes realtime', async () => {
        const d = deferred()
        const rt = mockRealtime()
        const { ids, state, main } = await load(signedIn('u1'), 'user', { realtime: rt, loadRows: async () => { await d.p; return [{ $id: 'u1-secret' }] } })
        main.loadDataSource('projects')
        await settle(30)
        logout()
        await settle(60)
        d.resolve()
        await settle(100)
        expect(ids()).toEqual([])
        expect(state().ready).toBe(true)
        expect(rt.subs.has('projects')).toBe(false)
        expect(rt.calls).toBe(0)
    })

    it('logout during the realtime subscribe drops that subscription', async () => {
        const d = deferred()
        const rt = mockRealtime()
        rt.gate = d.p
        const { ids, main } = await load(signedIn('u1'), 'user', { realtime: rt })
        main.loadDataSource('projects')
        await settle(30)
        expect(rt.calls).toBe(1)
        logout()
        await settle(60)
        d.resolve()
        await settle(80)
        expect(rt.subs.has('projects')).toBe(false)
        expect(ids()).toEqual([])
    })

    it('a bucket load in flight at logout neither lands nor subscribes', async () => {
        const d = deferred()
        const rt = mockRealtime()
        await load(signedIn('u1'), null, {
            realtime: rt,
            extra: { files: { appwriteBucketId: 'files', queries: [['equal', 'ownerId', '$auth.user.$id']] } },
            listFiles: async () => { await d.p; return [{ $id: 'u1-file' }] }
        })
        window.ManifestDataMain.loadDataSource('files')
        await settle(30)
        logout()
        await settle(60)
        d.resolve()
        await settle(100)
        expect(Array.from(Alpine.store('data').files ?? [])).toEqual([])
        expect(rt.subs.has('files')).toBe(false)
        expect(rt.calls).toBe(0)
    })

    it('a bucket realtime event captured before logout is dropped', async () => {
        const rt = mockRealtime()
        await load(signedIn('u1'), null, { realtime: rt, extra: { files: { appwriteBucketId: 'files', queries: [['equal', 'ownerId', '$auth.user.$id']] } },
            listFiles: async () => [{ $id: 'u1-file' }] })
        await window.ManifestDataMain.loadDataSource('files')
        await settle(60)
        const cb = rt.cbs.get('files')
        logout()
        await settle(60)
        await cb('create', { $id: 'late-file' })
        await settle(60)
        expect(Array.from(Alpine.store('data').files ?? [])).toEqual([])
    })

    it('logout during a bucket realtime subscribe drops that subscription', async () => {
        const d = deferred()
        const rt = mockRealtime()
        rt.gate = d.p
        await load(signedIn('u1'), null, { realtime: rt, extra: { files: { appwriteBucketId: 'files', queries: [['equal', 'ownerId', '$auth.user.$id']] } } })
        window.ManifestDataMain.loadDataSource('files')
        await settle(30)
        expect(rt.calls).toBe(1)
        logout()
        await settle(60)
        d.resolve()
        await settle(80)
        expect(rt.subs.has('files')).toBe(false)
    })

    it('$auth.-query source: a stale subscription from an in-flight load cannot append the old user rows', async () => {
        const d = deferred()
        const rt = mockRealtime()
        await load(signedIn('u1'), null, { realtime: rt, extra: MINE, loadRows: async () => { await d.p; return [{ $id: 'u1-a', ownerId: 'u1' }] } })
        window.ManifestDataMain.loadDataSource('mine')
        await settle(30)
        logout()
        await settle(80)
        d.resolve()
        await settle(80)
        const cb = rt.cbs.get('mine')
        if (cb) { await cb('create', { $id: 'u1-new-secret', ownerId: 'u1' }); await settle(80) }
        expect(mineIds()).toEqual([])
    })

    it('a realtime event captured before logout is dropped ($auth.-query source has no scope filter)', async () => {
        const rt = mockRealtime()
        await load(signedIn('u1'), null, { realtime: rt, extra: MINE })
        await window.ManifestDataMain.loadDataSource('mine')
        await settle(60)
        const cb = rt.cbs.get('mine')
        logout()
        await settle(60)
        await cb('create', { $id: 'late', ownerId: 'u1' })
        await settle(60)
        expect(mineIds()).toEqual([])
    })

    it('logout then immediate login as another user shows only the new rows', async () => {
        const d = deferred()
        let n = 0
        const { ids, main } = await load(signedIn('u1'), 'user', {
            loadRows: async () => { const who = Alpine.store('auth').user?.$id; if (n++ === 0) await d.p; return [{ $id: `${who}-r` }] }
        })
        main.loadDataSource('projects')
        await settle(30)
        logout()
        Object.assign(Alpine.store('auth'), signedIn('u2'))
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(60)
        d.resolve()
        await settle(150)
        expect(ids()).toEqual(['u2-r'])
    })

    it('the same user signing back in before teams load stays pending, not [] ready', async () => {
        const { state, main } = await load(signedIn('u1', 't1'), 'teams', { appwriteAuth: { teams: {} } })
        window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'))
        await main.loadDataSource('projects')
        await settle(60)
        logout()
        await settle(60)
        Object.assign(Alpine.store('auth'), signedIn('u1'))
        window.ManifestDataStore.resetSource('projects')
        main.loadDataSource('projects')
        await settle(60)
        expect(state().ready).not.toBe(true)
    })

    it('a sign-in deadline already answered does not hold a later logout', async () => {
        const { state, main } = await load(signedOut(), 'user')
        Alpine.store('auth')._signInPendingUntil = Date.now() + 3000
        Object.assign(Alpine.store('auth'), { ...signedIn('g1'), isAnonymous: true })
        window.dispatchEvent(new CustomEvent('manifest:auth:anonymous'))
        await main.loadDataSource('projects')
        await settle(60)
        logout()
        await settle(200)
        expect(state().ready).toBe(true)
    })

    it('prerender does not hold for a pending sign-in', async () => {
        window.__manifestRender = true
        try {
            const { state, main } = await load(signedOut(), 'user')
            Alpine.store('auth')._signInPendingUntil = Date.now() + 3000
            await main.loadDataSource('projects')
            await settle(60)
            expect(state().ready).toBe(true)
        } finally {
            delete window.__manifestRender
        }
    })

    it('an unscoped source is untouched by logout; an $auth.-query source is reset', async () => {
        const { net, main } = await load(signedIn('u1'), null, { extra: { ...MINE, pub: { appwriteTableId: 'pub', appwriteDatabaseId: 'db' } } })
        await main.loadDataSource('pub')
        await main.loadDataSource('mine')
        await settle(60)
        const before = net.tableCalls
        logout()
        await settle(80)
        expect(net.tableCalls).toBe(before)
        expect(Array.from(Alpine.store('data').pub).length).toBe(2)
        expect(mineIds()).toEqual([])
    })
})

describe('auth store marks the pending sign-in', () => {
    async function initStore({ guestAuto = false, callback = false, teamInvite = false } = {}) {
        let store = null
        let alpineInit = null
        let pendingAtInit = null
        const ctx = { console, setTimeout, Promise, Date, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }
        ctx.window = {
            addEventListener: () => {},
            dispatchEvent: e => { if (e.type === 'manifest:auth:initialized') pendingAtInit = store._signInPendingUntil },
            CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d && d.detail } },
            localStorage: ctx.localStorage,
            ManifestAppwriteAuthConfig: {
                getAppwriteClient: async () => ({ account: { get: async () => { throw new Error('no session') } } }),
                getAppwriteConfig: async () => ({ guestAuto, guestManual: false, teams: false }),
            },
            ManifestAppwriteAuthCallbacks: { detect: () => ({ hasCallback: callback, isTeamInvite: teamInvite }) },
        }
        ctx.CustomEvent = ctx.window.CustomEvent
        ctx.document = { addEventListener: (ev, cb) => { if (ev === 'alpine:init') alpineInit = cb } }
        ctx.Alpine = { store: (name, val) => { if (val !== undefined) { store = val; return } return name === 'auth' ? store : null } }
        vm.createContext(ctx)
        vm.runInContext(AUTH_STORE, ctx)
        alpineInit()
        await store.init()
        return pendingAtInit
    }

    it('guest-auto signed-out init sets a bounded deadline before initialized fires', async () => {
        const until = await initStore({ guestAuto: true })
        expect(until).toBeGreaterThan(Date.now())
        expect(until).toBeLessThanOrEqual(Date.now() + 5000)
    })

    it('a magic-link / OAuth callback in the URL does too', async () => {
        expect(await initStore({ callback: true })).toBeGreaterThan(Date.now())
    })

    it('a plain signed-out init does not', async () => {
        expect(await initStore()).toBe(0)
    })

    it('a team-invite callback does not (acceptInvite needs an existing session)', async () => {
        expect(await initStore({ callback: true, teamInvite: true })).toBe(0)
    })
})

describe('auth store always announces a logout', () => {
    function makeStore({ deleteSession = async () => {}, guestAuto = false } = {}) {
        let store = null
        let alpineInit = null
        const events = []
        const listeners = {}
        const ctx = { console, setTimeout, Promise, Date, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, sessionStorage: { removeItem: () => {} } }
        ctx.window = {
            addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
            dispatchEvent: e => { events.push(e.type); (listeners[e.type] || []).forEach(fn => fn(e)) },
            CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d && d.detail } },
            localStorage: ctx.localStorage,
            ManifestAppwriteAuthConfig: { getAppwriteClient: async () => null, getAppwriteConfig: async () => ({}) },
        }
        ctx.CustomEvent = ctx.window.CustomEvent
        ctx.document = { addEventListener: (ev, cb) => { if (ev === 'alpine:init') alpineInit = cb } }
        ctx.Alpine = { store: (name, val) => { if (val !== undefined) { store = val; return } return name === 'auth' ? store : null } }
        vm.createContext(ctx)
        vm.runInContext(AUTH_STORE, ctx)
        alpineInit()
        Object.assign(store, {
            _appwrite: { account: { deleteSession } }, _guestAuto: guestAuto,
            isAuthenticated: true, user: { $id: 'u1' }, session: { $id: 's1' }, teams: [{ $id: 't1' }], currentTeam: { $id: 't1' },
        })
        const storage = value => listeners.storage.forEach(fn => fn({ key: 'manifest:auth:state', newValue: JSON.stringify(value) }))
        return { store, events, storage }
    }
    const expired = async () => { throw new Error('401 session expired') }

    it('logout with an expired session still clears identity and dispatches logout', async () => {
        const { store, events } = makeStore({ deleteSession: expired })
        await store.logout()
        expect(store.user).toBeNull()
        expect(store.isAuthenticated).toBe(false)
        expect(events).toContain('manifest:auth:logout')
    })

    it('a failed guest restore on logout does not leave the old user object behind', async () => {
        const { store, events } = makeStore({ guestAuto: true })
        store._createAnonymousSession = async function () { this.isAuthenticated = false; this.isAnonymous = false; return { success: false } }
        await store.logout()
        expect(store.user).toBeNull()
        expect(events).toContain('manifest:auth:logout')
    })

    it('clearSession with an expired session still dispatches session-cleared', async () => {
        const { store, events } = makeStore({ deleteSession: expired })
        await store.clearSession()
        expect(store.user).toBeNull()
        expect(store.teams).toEqual([])
        expect(events).toContain('manifest:auth:session-cleared')
    })

    it('another tab signing out dispatches session-cleared here', async () => {
        const { store, events, storage } = makeStore()
        storage({ isAuthenticated: false, isAnonymous: false, user: null, session: null })
        expect(store.user).toBeNull()
        expect(store.teams).toEqual([])
        expect(events).toContain('manifest:auth:session-cleared')
    })

    it('a same-user sync from another tab does not', async () => {
        const { events, storage } = makeStore()
        storage({ isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, session: null })
        expect(events).not.toContain('manifest:auth:session-cleared')
    })

    it('an auth event clears the pending sign-in deadline', async () => {
        const { store, events } = makeStore()
        store._signInPendingUntil = Date.now() + 5000
        await store.logout()
        expect(events).toContain('manifest:auth:logout')
        expect(store._signInPendingUntil).toBe(0)
    })
})

describe('overlapping locale changes', () => {
    it("an earlier change finishing does not clear the later one's _localeChanging", async () => {
        let call = 0
        const fetch = async () => {
            const delay = call++ === 0 ? 10 : 300
            await new Promise(r => setTimeout(r, delay))
            return { text: async () => 'name,value\na,1' }
        }
        const { ready } = await load(signedOut(), null, { extra: { list: 'list.csv' }, fetch })
        window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: 'fr' } }))
        window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: 'de' } }))
        await settle(100)
        expect(Alpine.store('data')._localeChanging).toBe(true)
        await settle(500)
        expect(Alpine.store('data')._localeChanging).toBe(false)
        expect(ready.length).toBe(1)
    })
})
