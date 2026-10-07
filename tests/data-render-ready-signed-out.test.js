// @vitest-environment happy-dom
/**
 * A user/team-scoped Appwrite source with auth settled signed-out (a logged-out
 * visitor, or an anonymous mnfst-render prerender) settles empty instead of
 * staying $loading forever — so manifest:render-ready fires — and still loads
 * on sign-in. Auth not yet settled keeps the source pending (data-auth-retry).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach } from 'vitest'
import { isolateVm } from './helpers/vm-isolation.js'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

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

const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ $id: `${prefix}${i}` }))
let iso = null

async function load(auth, scope = ['user', 'teams'], source, appwriteAuth) {
    window.Alpine = Alpine
    Alpine.store('auth', auth)
    window.__manifestRender = true
    window.__manifestRenderReady = false

    const manifest = {
        appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db', ...(appwriteAuth ? { auth: appwriteAuth } : {}) },
        data: { projects: source || { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope } }
    }
    const net = { tableCalls: 0, fileCalls: 0 }
    window.ManifestDataAppwrite = {
        loadTableRows: async () => { net.tableCalls++; return rows('p', 2) },
        listBucketFiles: async () => { net.fileCalls++; return rows('f', 2) }
    }
    delete window.ManifestDataRealtime
    window.ManifestComponentsRegistry = { manifest }

    iso = isolateVm()
    const ctx = {
        window, document, Alpine, console, ...iso.timers, clearTimeout, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)

    const ready = []
    window.addEventListener('manifest:render-ready', e => ready.push(e.detail))
    return { net, ready, main: window.ManifestDataMain, data: () => Alpine.store('data') }
}

afterEach(() => {
    iso?.release()
    iso = null
    delete window.__manifestRender
})

describe('render-ready with a signed-out scoped Appwrite source', () => {
    it('no auth plugin settles empty; an auth store arriving later reloads', async () => {
        const { net, ready, main, data } = await load(undefined, null, { appwriteTableId: 'late', appwriteDatabaseId: 'db', scope: 'user' })
        await main.loadDataSource('projects')
        await settle(300)
        expect(data()._projects_state?.ready).toBe(true)
        expect(ready.length).toBeGreaterThan(0)

        Alpine.store('auth', { _initialized: true, isAuthenticated: true, user: { $id: 'u1' }, currentTeam: null, teams: [] })
        window.dispatchEvent(new CustomEvent('manifest:auth:initialized'))
        await settle(80)
        expect(net.tableCalls).toBe(1)
        expect(data().projects?.map(r => r.$id)).toEqual(['p0', 'p1'])
    })

    it('settles empty (no network, no error) and fires render-ready', async () => {
        const { net, ready, main, data } = await load({ _initialized: true, isAuthenticated: false, user: null, currentTeam: null, teams: [] })

        await main.loadDataSource('projects')
        await settle(300)

        expect(net.tableCalls).toBe(0)
        expect(data()._projects_state?.loading).toBe(false)
        expect(data()._projects_state?.error ?? null).toBeNull()
        expect(Array.from(data().projects ?? ['missing'])).toEqual([])
        expect(ready.length).toBeGreaterThan(0)
        expect(window.__manifestRenderReady).toBe(true)
    })

    it('single user scope settles the same way', async () => {
        const { ready, main, data } = await load({ _initialized: true, isAuthenticated: false, user: null, currentTeam: null, teams: [] }, 'user')
        await main.loadDataSource('projects')
        await settle(300)
        expect(data()._projects_state?.loading).toBe(false)
        expect(ready.length).toBeGreaterThan(0)
    })

    it('loads the rows once the visitor signs in', async () => {
        const { net, main, data } = await load({ _initialized: true, isAuthenticated: false, user: null, currentTeam: null, teams: [] })
        await main.loadDataSource('projects')
        await settle(50)

        Object.assign(Alpine.store('auth'), { isAuthenticated: true, user: { $id: 'u1' } })
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(80)

        expect(net.tableCalls).toBe(1)
        expect(data().projects?.map(r => r.$id)).toEqual(['p0', 'p1'])
    })

    it('a signed-in user whose teams have not loaded stays pending', async () => {
        const { net, main, data } = await load({ _initialized: true, isAuthenticated: true, user: { $id: 'u1' }, currentTeam: null, teams: [] }, 'team', undefined, { teams: {} })
        await main.loadDataSource('projects')
        await settle(50)
        expect(net.tableCalls).toBe(0)
        expect(data()._projects_state?.ready).not.toBe(true)
    })

    it('auth still hydrating when the init wait ends stays pending', async () => {
        const { net, main, data } = await load({ _initialized: false, isAuthenticated: false, user: null, currentTeam: null, teams: [] }, 'user')
        const pending = main.loadDataSource('projects')
        await settle(10)
        window.dispatchEvent(new CustomEvent('manifest:auth:initialized'))
        await pending
        await settle(50)
        expect(net.tableCalls).toBe(0)
        expect(data()._projects_state?.ready).not.toBe(true)
    })

    it('a bucket with an unresolved $auth query settles empty without a network read', async () => {
        const { net, main, data } = await load(
            { _initialized: true, isAuthenticated: false, user: null, currentTeam: null, teams: [] }, null,
            { appwriteBucketId: 'files', queries: [['equal', 'ownerId', '$auth.user.$id']] })
        await main.loadDataSource('projects')
        await settle(50)
        expect(net.fileCalls).toBe(0)
        expect(data()._projects_state?.loading).toBe(false)
        expect(data()._projects_state?.ready).toBe(true)
    })

    it('a guest session (manifest:auth:anonymous) reloads once', async () => {
        const { net, main, data } = await load({ _initialized: true, isAuthenticated: false, user: null, currentTeam: null, teams: [] }, null,
            { appwriteTableId: 'guest', appwriteDatabaseId: 'db', scope: 'user' })
        await main.loadDataSource('projects')
        await settle(50)

        Object.assign(Alpine.store('auth'), { isAuthenticated: true, isAnonymous: true, user: { $id: 'g1' } })
        window.dispatchEvent(new CustomEvent('manifest:auth:anonymous'))
        await settle(80)
        expect(net.tableCalls).toBe(1)
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'))
        await settle(80)
        expect(net.tableCalls).toBe(1)
        expect(data().projects?.map(r => r.$id)).toEqual(['p0', 'p1'])
    })
})

describe('vm isolation between tests', () => {
    it('arms a retry (signed-out scoped load)', async () => {
        const { main, data } = await load({ _initialized: true, isAuthenticated: false, user: null, currentTeam: null, teams: [] }, 'user')
        await main.loadDataSource('projects')
        await settle(50)
        expect(data()._projects_state?.ready).toBe(true)
    })

    it("an earlier test's armed retry does not fire into this one", async () => {
        const { net } = await load({ _initialized: true, isAuthenticated: true, user: { $id: 'u1' }, currentTeam: null, teams: [] }, 'user')
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(80)
        expect(net.tableCalls).toBe(0)
    })
})
