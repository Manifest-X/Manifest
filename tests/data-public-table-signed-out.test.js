// @vitest-environment happy-dom
/**
 * A public Appwrite table (no scope, no $auth. query) reads for a visitor with no
 * session while the auth plugin is loaded: the real loadTableRows skips the
 * account.get() pre-flight; scoped sources keep it.
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
    'appwrite/manifest.data.appwrite.js',
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
let iso = null

async function load(source) {
    window.Alpine = Alpine
    Alpine.store('auth', { _initialized: true, isAuthenticated: false, user: null, currentTeam: null, teams: [] })
    const net = { accountGets: 0, listRows: 0 }
    const unauthorized = () => { const e = new Error('Unauthorized'); e.code = 401; return e }
    window.Appwrite = {
        Client: class { setEndpoint() { return this } setProject() { return this } },
        Account: class { async get() { net.accountGets++; throw unauthorized() } },
        TablesDB: class { async listRows() { net.listRows++; return { rows: [{ $id: 'pub0' }, { $id: 'pub1' }] } } },
        Query: new Proxy({}, { get: (_, op) => (...a) => JSON.stringify([op, ...a]) }),
    }
    window.ManifestAppwriteAuthConfig = { getAppwriteClient: async () => ({ client: {} }) }
    delete window.ManifestDataRealtime
    window.ManifestComponentsRegistry = {
        manifest: { appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db' }, data: { posts: source } }
    }

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
    return { net, main: window.ManifestDataMain, data: () => Alpine.store('data') }
}

afterEach(() => {
    iso?.release()
    iso = null
    delete window.ManifestAppwriteAuthConfig
})

describe('public table, signed out, auth plugin loaded', () => {
    it('the loader reads public rows with no pre-flight and no $error', async () => {
        const { net, main, data } = await load({ appwriteTableId: 'posts', appwriteDatabaseId: 'db' })
        await main.loadDataSource('posts')
        await settle(50)
        expect(net.accountGets).toBe(0)
        expect(net.listRows).toBe(1)
        expect(data().posts?.map(r => r.$id)).toEqual(['pub0', 'pub1'])
        expect(data()._posts_state?.error ?? null).toBeNull()
    })

    it('$query reads public rows with no pre-flight', async () => {
        const { net } = await load({ appwriteTableId: 'posts', appwriteDatabaseId: 'db' })
        const handle = window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('posts', async () => {})
        const rows = await handle('$query', [['equal', 'status', 'live']])
        expect(net.accountGets).toBe(0)
        expect(rows.map(r => r.$id)).toEqual(['pub0', 'pub1'])
    })

    it('$query with an $auth. arg keeps the pre-flight', async () => {
        const { net } = await load({ appwriteTableId: 'posts', appwriteDatabaseId: 'db' })
        Object.assign(Alpine.store('auth'), { isAuthenticated: true, user: { $id: 'u1' } })
        const handle = window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('posts', async () => {})
        await expect(handle('$query', [['equal', 'ownerId', '$auth.user.$id']])).rejects.toThrow(/not authenticated/)
        expect(net.accountGets).toBe(1)
        expect(net.listRows).toBe(0)
    })
})
