// @vitest-environment happy-dom
/**
 * Scoped Appwrite sources across the auth lifecycle: logout drops the previous
 * identity's rows at once (user and team scopes), a signed-in user with zero
 * teams settles empty, a pending guest-auto/callback sign-in holds the source
 * unsettled (one render-ready) with a bounded fallback, and overlapping locale
 * changes don't clear each other's _localeChanging.
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
async function load(auth, scope, { appwriteAuth, extra = {}, fetch } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', auth)
    window.__manifestRenderReady = false

    const manifest = {
        appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db', ...(appwriteAuth ? { auth: appwriteAuth } : {}) },
        data: { projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope }, ...extra }
    }
    const net = { tableCalls: 0 }
    window.ManifestDataAppwrite = {
        loadTableRows: async () => {
            net.tableCalls++
            const a = Alpine.store('auth')
            const who = a.user?.$id || 'anon'
            return [{ $id: `${who}-0` }, { $id: `${who}-1` }]
        }
    }
    delete window.ManifestDataRealtime
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
        const { ready, ids, state, main } = await load({ ...signedOut(), _signInPendingUntil: Date.now() + 2000 }, 'user')
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
        const { ready, state, main } = await load({ ...signedOut(), _signInPendingUntil: Date.now() + 300 }, 'user')
        await main.loadDataSource('projects')
        await settle(100)
        expect(state().ready).not.toBe(true)
        await settle(500)
        expect(state().ready).toBe(true)
        expect(Array.from(Alpine.store('data').projects)).toEqual([])
        expect(ready.length).toBe(1)
    })
})

describe('auth store marks the pending sign-in', () => {
    async function initStore({ guestAuto = false, callback = false } = {}) {
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
            ManifestAppwriteAuthCallbacks: { detect: () => ({ hasCallback: callback }) },
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
