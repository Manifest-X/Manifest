// @vitest-environment happy-dom
/**
 * Unscoped (permission-only) Appwrite tables and buckets across identity changes (the
 * 2026-10-07 review probes): a load or realtime event from a signed-out user never lands
 * after the logout, a guest signing in reloads as them, a guest-auto logout reloads once,
 * and $remove keeps rows whose delete failed, including across a logout.
 * Harness as tests/data-scoped-auth-lifecycle.test.js.
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
const RT_SRC = readFileSync(path.join(DATA, 'appwrite/manifest.data.realtime.js'), 'utf8')
const AUTH_STORE = readFileSync(path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.store.js'), 'utf8')
const AUTH_MAIN = readFileSync(path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.main.js'), 'utf8')

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
    net.appwrite = window.ManifestDataAppwrite
    if (realtime) window.ManifestDataRealtime = realtime
    else delete window.ManifestDataRealtime
    window.ManifestComponentsRegistry = { manifest }

    iso = isolateVm()
    const ctx = {
        window, document, Alpine, console, ...iso.timers, clearTimeout, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        File: window.File, Blob: window.Blob,
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
        // Ignores isCurrent: exercises the loader's own post-subscribe drop
        async subscribeToTable(name, db, table, scope, cb) { this.calls++; if (this.gate) await this.gate; subs.set(name, 1); cbs.set(name, cb); return () => { subs.delete(name); cbs.delete(name) } },
        async subscribeToStorageBucket(name, bucket, scope, cb) { this.calls++; if (this.gate) await this.gate; subs.set(name, 1); cbs.set(name, cb); return () => { subs.delete(name); cbs.delete(name) } },
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


const FILES = { files: { appwriteBucketId: 'files', queries: [['equal', 'ownerId', '$auth.user.$id']] } }
const fileIds = () => Array.from(Alpine.store('data').files ?? []).map(r => r.$id)
const methods = name => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler(name, () => {})
describe('unscoped Appwrite sources across identity changes (review probes)', () => {
    it('P1 in-flight u1 load on an unscoped table resolving after logout never lands', async () => {
        const d = deferred()
        let n = 0
        const { ids, main } = await load(signedIn('u1'), undefined, { loadRows: async () => { const who = Alpine.store('auth').user?.$id || 'anon'; if (n++ === 1) { await d.p; return [{ $id: 'u1-secret' }] } return [{ $id: who + '-0' }] } })
        await main.loadDataSource('projects'); await settle(60)
        main.loadDataSource('projects', 'en', { reload: true })   // u1 reload in flight
        await settle(10)
        logout(); await settle(80)
        d.resolve(); await settle(80)
        expect(ids()).not.toContain('u1-secret')
        expect(ids()).toEqual(['anon-0'])
    })

    it('P2 realtime event via the old u1 callback after logout never lands (unscoped table)', async () => {
        const rt = mockRealtime()
        const { ids, main } = await load(signedIn('u1'), undefined, { realtime: rt })
        await main.loadDataSource('projects'); await settle(60)
        const oldCb = rt.cbs.get('projects')
        logout(); await settle(80)
        await oldCb('create', { $id: 'u1-late' }); await settle(60)
        expect(ids()).not.toContain('u1-late')
    })

    it('P3 guest, then login as u1 (login event only): an unscoped table reloads as u1', async () => {
        const { net, ids, main } = await load({ ...signedOut(), isAuthenticated: true, isAnonymous: true, user: { $id: 'g1' } }, undefined)
        await main.loadDataSource('projects'); await settle(60)
        expect(ids()).toEqual(['g1-0', 'g1-1'])
        Object.assign(Alpine.store('auth'), signedIn('u1'))
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(80)
        expect(ids()).toEqual(['u1-0', 'u1-1'])
        expect(net.tableCalls).toBe(2)
    })

    it('P4 guest-auto logout (anonymous, then logout): one reload, the guest rows', async () => {
        const { net, ids, main } = await load(signedIn('u1'), undefined)
        await main.loadDataSource('projects'); await settle(60)
        const before = net.tableCalls
        Object.assign(Alpine.store('auth'), { ...signedOut(), isAuthenticated: true, isAnonymous: true, user: { $id: 'g1' } })
        window.dispatchEvent(new CustomEvent('manifest:auth:anonymous'))
        await settle(5)
        window.dispatchEvent(new CustomEvent('manifest:auth:logout'))
        await settle(100)
        expect(net.tableCalls - before).toBe(1)
        expect(ids()).toEqual(['g1-0', 'g1-1'])
    })

    it('P5 $remove: a failed delete keeps the row; a partly failed array removes only what was deleted', async () => {
        await load(signedIn('u1'), null, { extra: FILES, listFiles: async () => [{ $id: 'a' }, { $id: 'b' }, { $id: 'c' }] })
        await window.ManifestDataMain.loadDataSource('files'); await settle(60)
        window.ManifestDataAppwrite.deleteFile = async () => { throw new Error('403') }
        await expect(methods('files')('$remove', 'a')).rejects.toThrow()
        await settle(30)
        expect(fileIds()).toEqual(['a', 'b', 'c'])
        const deleted = []
        window.ManifestDataAppwrite.deleteFile = async (b, id) => { if (id === 'c') throw new Error('403'); deleted.push(id); return {} }
        await expect(methods('files')('$remove', ['a', 'c'])).rejects.toThrow()
        await settle(30)
        expect(deleted).toEqual(['a'])
        expect(fileIds()).toEqual(['b', 'c'])
    })

    it('P6 $remove awaiting delete across logout: no landRemove into the guest source', async () => {
        const d = deferred()
        await load(signedIn('u1'), undefined, { extra: { files: { appwriteBucketId: 'files' } }, listFiles: async () => { const who = Alpine.store('auth').user?.$id || 'anon'; return [{ $id: who + '-f' }, { $id: 'shared' }] } })
        await window.ManifestDataMain.loadDataSource('files'); await settle(60)
        window.ManifestDataAppwrite.deleteFile = async () => { await d.p; return {} }
        const p = methods('files')('$remove', 'shared')
        await settle(5)
        logout(); await settle(80)
        d.resolve(); await p; await settle(60)
        expect(fileIds()).toEqual(['anon-f', 'shared'])
    })
})
