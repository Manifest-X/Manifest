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
        const created = []
        window.addEventListener('manifest:file-created', e => created.push(e.detail.fileId))
        await cb('create', { $id: 'late-file' })
        await settle(60)
        expect(Array.from(Alpine.store('data').files ?? [])).toEqual([])
        expect(created).toEqual([])
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

    it('an unscoped Appwrite source reloads as the new identity on logout; an $auth.-query source is reset', async () => {
        const { net, main } = await load(signedIn('u1'), null, { extra: { ...MINE, pub: { appwriteTableId: 'pub', appwriteDatabaseId: 'db' } } })
        await main.loadDataSource('pub')
        await main.loadDataSource('mine')
        await settle(60)
        const before = net.tableCalls
        logout()
        await settle(80)
        expect(net.tableCalls).toBe(before + 1)
        expect(Array.from(Alpine.store('data').pub).map(r => r.$id)).toEqual(['anon-0', 'anon-1'])
        expect(mineIds()).toEqual([])
    })

    it('a non-Appwrite source without $auth. is untouched by logout', async () => {
        let calls = 0
        window.ManifestDataLoaders = { loadLocalFile: async () => { calls++; return [{ $id: 'k' }] } }
        await load(signedIn('u1'), null, { extra: { list: 'list.json' } })
        await window.ManifestDataMain.loadDataSource('list')
        await settle(60)
        const before = calls
        expect(Array.from(Alpine.store('data').list).length).toBe(1)
        logout()
        await settle(80)
        expect(calls).toBe(before)
        expect(Array.from(Alpine.store('data').list).length).toBe(1)
        delete window.ManifestDataLoaders
    })
})

const FILES = { files: { appwriteBucketId: 'files', queries: [['equal', 'ownerId', '$auth.user.$id']] } }
const fileIds = () => Array.from(Alpine.store('data').files ?? []).map(r => r.$id)
const Mut = () => window.ManifestDataMutations
const methods = name => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler(name, () => {})

describe('async writes started before logout never land after it', () => {
    it('the store write layer drops writes stamped with an older generation', async () => {
        const { ids, main } = await load(signedIn('u1'), 'user')
        await main.loadDataSource('projects')
        await settle(60)
        const ds = window.ManifestDataStore
        const old = ds.sourceGeneration('projects')
        ds.resetSource('projects')
        ds.updateStore('projects', [{ $id: 'old-update' }], { generation: old })
        expect(ids()).toEqual([])
        await ds.landRows('projects', [{ $id: 'old-land' }], { mode: 'replace', generation: old })
        expect(ids()).toEqual([])
        ds.updateStore('projects', [], { loading: false, ready: true })
        expect(Mut().addEntryToStore('projects', { $id: 'old-add' }, { generation: old })).toBe(false)
        await ds.landRows('projects', [{ $id: 'current' }], { mode: 'append', generation: ds.sourceGeneration('projects') })
        await ds.landRemove('projects', ['current'], { generation: old })
        await settle(30)
        expect(ids()).toEqual(['current'])
    })

    it('a create in flight at logout does not add its row', async () => {
        const { ids, main } = await load(signedIn('u1'), 'user')
        await main.loadDataSource('projects')
        await settle(60)
        const d = deferred()
        const p = Mut().executeMutation({ type: 'create', dataSourceName: 'projects', data: { title: 'secret' }, apiCall: () => d.p })
        await settle(10)
        logout()
        await settle(60)
        d.resolve({ $id: 'u1-new', title: 'secret' })
        await p
        await settle(60)
        expect(ids()).toEqual([])
    })

    it('a delete failing after logout does not roll the row back in', async () => {
        const { ids, main } = await load(signedIn('u1'), 'user')
        await main.loadDataSource('projects')
        await settle(60)
        const d = deferred()
        const p = Mut().executeMutation({ type: 'delete', dataSourceName: 'projects', entryId: 'u1-0', apiCall: () => d.p.then(() => { throw new Error('401') }) })
        await settle(10)
        logout()
        await settle(60)
        d.resolve()
        await p.catch(() => {})
        await settle(60)
        expect(ids()).toEqual([])
    })

    it("an update ack after a reset does not merge into the next load's row", async () => {
        const { main } = await load(signedIn('u1'), 'user')
        await main.loadDataSource('projects')
        await settle(60)
        const d = deferred()
        const p = Mut().executeMutation({ type: 'update', dataSourceName: 'projects', entryId: 'u1-0', data: { title: 'draft' }, apiCall: () => d.p })
        await settle(10)
        window.ManifestDataStore.resetSource('projects')
        await main.loadDataSource('projects')
        await settle(60)
        d.resolve({ $id: 'u1-0', title: 'old-identity' })
        await p
        await settle(30)
        expect(Alpine.store('data').projects.find(r => r.$id === 'u1-0').title).toBeUndefined()
    })

    it('syncEntryFromServer after a reset does not write', async () => {
        const { main } = await load(signedIn('u1'), 'user')
        await main.loadDataSource('projects')
        await settle(60)
        const d = deferred()
        const p = Mut().syncEntryFromServer('projects', 'u1-0', () => d.p)
        window.ManifestDataStore.resetSource('projects')
        await main.loadDataSource('projects')
        await settle(60)
        d.resolve({ $id: 'u1-0', title: 'old-identity' })
        await p
        expect(Alpine.store('data').projects.find(r => r.$id === 'u1-0').title).toBeUndefined()
    })

    it('a $query in flight at logout does not land', async () => {
        let gate = null
        const { ids, main } = await load(signedIn('u1'), 'user', {
            loadRows: async () => { const who = Alpine.store('auth').user?.$id || 'anon'; if (gate) await gate; return [{ $id: `${who}-q` }] }
        })
        await main.loadDataSource('projects')
        await settle(60)
        const d = deferred()
        gate = d.p
        const p = methods('projects')('$query', [['limit', 5]]).catch(() => {})
        await settle(20)
        logout()
        await settle(60)
        gate = null
        d.resolve()
        await p
        await settle(60)
        expect(ids()).toEqual([])
    })

    it('a file upload finishing after logout does not add the file', async () => {
        await load(signedIn('u1'), null, { extra: FILES, listFiles: async () => [{ $id: 'u1-file' }] })
        await window.ManifestDataMain.loadDataSource('files')
        await settle(60)
        const d = deferred()
        window.ManifestDataAppwrite.createFile = () => d.p
        let upErr = null
        const p = methods('files')('$create', 'f1', { name: 'x.txt', size: 1, type: 'text/plain' }).catch(e => { upErr = e })
        await settle(20)
        logout()
        await settle(60)
        d.resolve({ $id: 'f1', name: 'x.txt' })
        await p
        await settle(60)
        expect(upErr).toBeNull()
        expect(fileIds()).toEqual([])
    })

    it("a bucket $remove's parallel listing does not land after logout", async () => {
        let gate = null
        await load(signedIn('u1'), null, { extra: FILES, listFiles: async () => { if (gate) await gate; return [{ $id: 'u1-file' }, { $id: 'u1-other' }] } })
        await window.ManifestDataMain.loadDataSource('files')
        await settle(60)
        const d = deferred()
        gate = d.p
        window.ManifestDataAppwrite.deleteFile = async () => ({})
        const p = methods('files')('$remove', 'u1-file').catch(() => {})
        await settle(20)
        logout()
        await settle(60)
        gate = null
        d.resolve()
        await p
        await settle(60)
        expect(fileIds()).toEqual([])
    })

    it('a realtime event mid-handler when the source resets does not land', async () => {
        const rt = mockRealtime()
        await load(signedIn('u1'), null, { realtime: rt, extra: MINE })
        await window.ManifestDataMain.loadDataSource('mine')
        await settle(60)
        const cb = rt.cbs.get('mine')
        const p = cb('create', { $id: 'mid', ownerId: 'u1' })
        window.ManifestDataStore.resetSource('mine')
        await p
        await settle(60)
        expect(mineIds()).toEqual([])
    })
})

describe('dropping a superseded subscription', () => {
    // Realtime that ignores isCurrent: the loader's own post-subscribe drop runs
    function mapRealtime(owner) {
        const subscriptions = new Map()
        let gate = null
        return {
            subscriptions,
            hold() { const d = deferred(); gate = d.p; return d },
            async subscribeToTable(name) {
                if (gate) await gate
                const mine = () => {}
                subscriptions.set(name, owner === 'newer' ? () => {} : mine)
                return mine
            },
            unsubscribeFromDataSource: name => subscriptions.delete(name),
        }
    }

    for (const owner of ['self', 'newer']) {
        it(owner === 'self' ? 'removes its own map entry' : "leaves a newer load's map entry alone", async () => {
            const rt = mapRealtime(owner)
            await load(signedIn('u1'), 'user', { realtime: rt })
            const d = rt.hold()
            window.ManifestDataMain.loadDataSource('projects')
            await settle(30)
            window.ManifestDataStore.resetSource('projects')
            d.resolve()
            await settle(60)
            expect(rt.subscriptions.has('projects')).toBe(owner === 'newer')
        })
    }
})

describe('real realtime module across logout + re-login', () => {
    for (const order of ['new identity subscribes first', 'old identity subscribes first']) {
        it(`${order}: one live subscription, and the next logout leaves none`, async () => {
            await load(signedIn('u1'), 'user')
            const active = new Map()
            let n = 0
            const gates = []
            window.ManifestDataAppwrite.getAppwriteDataServices = async () => {
                const d = deferred(); gates.push(d); await d.p
                return { realtime: { subscribe(ch, cb) { const id = ++n; active.set(id, cb); return () => active.delete(id) } } }
            }
            new Function(RT_SRC)()
            window.ManifestDataMain.loadDataSource('projects')
            await settle(30)
            logout()
            await settle(30)
            Object.assign(Alpine.store('auth'), signedIn('u2'))
            window.dispatchEvent(new CustomEvent('manifest:auth:login'))
            await settle(60)
            if (order.startsWith('new')) { gates[1].resolve(); await settle(30); gates[0].resolve() }
            else { gates[0].resolve(); await settle(30); gates[1].resolve() }
            await settle(100)
            expect(active.size).toBe(1)
            logout()
            await settle(60)
            expect(active.size).toBe(0)
        })
    }
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
                getAppwriteClient: async () => ({ account: { get: async () => { throw Object.assign(new Error('no session'), { code: 401 }) } } }),
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

describe('auth store: a network failure is not a logout', () => {
    const offline = () => Object.assign(new Error('Failed to fetch'), { code: 0, type: '' })
    const noSession = () => Object.assign(new Error('User (role: guests) missing scope (account)'), { code: 401, type: 'general_unauthorized_scope' })

    async function boot(getError, { guestAuto = false, timers = null } = {}) {
        let store = null
        let alpineInit = null
        const writes = []
        const events = []
        const listeners = {}
        const ls = { getItem: () => null, setItem: (k, v) => { if (k === 'manifest:auth:state') writes.push(JSON.parse(v)) }, removeItem: () => {} }
        const ctx = { console: { ...console, warn: () => {} }, setTimeout, clearTimeout, Promise, Date, localStorage: ls, sessionStorage: ls, ...(timers || {}) }
        let account = { get: async () => { throw getError() }, deleteSession: async () => {} }
        const docListeners = {}
        ctx.window = {
            addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
            dispatchEvent: e => { events.push(e.type); (listeners[e.type] || []).forEach(fn => fn(e)) },
            CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d && d.detail } },
            localStorage: ls,
            ManifestAppwriteAuthConfig: {
                getAppwriteClient: async () => ({ account: new Proxy({}, { get: (_, k) => account[k] }) }),
                getAppwriteConfig: async () => ({ guestAuto, guestManual: false, teams: false }),
            },
        }
        ctx.CustomEvent = ctx.window.CustomEvent
        ctx.document = { visibilityState: 'visible', addEventListener: (ev, cb) => { if (ev === 'alpine:init') alpineInit = cb; else (docListeners[ev] ||= []).push(cb) } }
        ctx.Alpine = { store: (name, val) => { if (val !== undefined) { store = val; return } return name === 'auth' ? store : null } }
        vm.createContext(ctx)
        vm.runInContext(AUTH_STORE, ctx)
        alpineInit()
        await store.init()
        const visible = async () => { (docListeners.visibilitychange || []).forEach(fn => fn()); await settle(10) }
        const fire = async (type, e = {}) => { (listeners[type] || []).forEach(fn => fn(e)); await settle(10) }
        const storage = value => fire('storage', { key: 'manifest:auth:state', newValue: JSON.stringify(value) })
        const setAccount = a => { account = { deleteSession: async () => {}, ...a } }
        return { store, writes, events, setAccount, fire, storage, visible, listeners }
    }
    const manualTimers = () => {
        const queue = new Map()
        let id = 0
        return {
            queue,
            timers: { setTimeout: (fn, ms) => { queue.set(++id, { fn, ms }); return id }, clearTimeout: t => { queue.delete(t) } },
            delays: () => [...queue.values()].map(t => t.ms),
            async tick() { const [[t, { fn }]] = queue; queue.delete(t); fn(); await settle(10) },
        }
    }
    const u1 = { isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, session: { $id: 's1' } }
    const online = (id = 'u1', provider = 'email') => ({
        get: async () => ({ $id: id }),
        listSessions: async () => ({ sessions: [{ $id: 's1', current: true, provider }] }),
    })

    it('offline init: signed out locally, nothing broadcast to other tabs', async () => {
        const { store, writes, events } = await boot(offline)
        expect(store.isAuthenticated).toBe(false)
        expect(store._initialized).toBe(true)
        expect(events).toContain('manifest:auth:initialized')
        expect(writes).toEqual([])
    })

    it('a later state sync from that tab stays local too', async () => {
        const { store, writes } = await boot(offline)
        store._syncStateToStorage(store)
        expect(writes).toEqual([])
    })

    it('a genuine 401 at init still broadcasts signed out', async () => {
        const { store, writes } = await boot(noSession)
        expect(store.isAuthenticated).toBe(false)
        expect(writes).toHaveLength(1)
        expect(writes[0].isAuthenticated).toBe(false)
    })

    it('refresh() offline keeps the identity and broadcasts nothing; a 401 signs out', async () => {
        const { store, writes, setAccount } = await boot(noSession)
        writes.length = 0
        Object.assign(store, { isAuthenticated: true, user: { $id: 'u1' }, session: { $id: 's1' } })
        setAccount({ get: async () => { throw offline() } })
        await expect(store.refresh()).rejects.toThrow('Failed to fetch')
        expect(store.user).toEqual({ $id: 'u1' })
        expect(writes).toEqual([])
        setAccount({ get: async () => { throw noSession() } })
        await expect(store.refresh()).rejects.toThrow()
        expect(store.user).toBeNull()
        expect(writes.map(w => w.isAuthenticated)).toEqual([false])
    })

    it('offline boot, then another tab signs in: logout here broadcasts signed out', async () => {
        const { store, writes, events, storage } = await boot(offline)
        await storage(u1)
        await store.logout()
        expect(writes.map(w => w.isAuthenticated)).toEqual([false])
        expect(events).toContain('manifest:auth:logout')
    })

    it('offline boot, adopt u1 from another tab, then a 401 on refresh() broadcasts signed out', async () => {
        const { store, writes, storage, setAccount } = await boot(offline)
        await storage(u1)
        setAccount({ get: async () => { throw noSession() } })
        await expect(store.refresh()).rejects.toThrow()
        expect(writes.map(w => w.isAuthenticated)).toEqual([false])
    })

    it('the same through a failing logout (expired session)', async () => {
        const { store, writes, storage, setAccount } = await boot(offline)
        await storage(u1)
        setAccount({ deleteSession: async () => { throw noSession() } })
        await store.logout()
        expect(writes.map(w => w.isAuthenticated)).toEqual([false])
    })

    it('clearSession() after an offline boot broadcasts signed out', async () => {
        const { store, writes, storage } = await boot(offline)
        await storage(u1)
        await store.clearSession()
        expect(writes.map(w => w.isAuthenticated)).toEqual([false])
    })

    it('a successful refresh() verifies the session', async () => {
        const { store, writes, setAccount } = await boot(offline)
        Object.assign(store, u1)
        setAccount(online())
        await store.refresh()
        expect(store._sessionUnverified).toBe(false)
        writes.length = 0
        store._clearIdentity()
        store._syncStateToStorage(store)
        expect(writes.map(w => w.isAuthenticated)).toEqual([false])
    })

    it('coming back online re-runs the session check and signs in as the real user', async () => {
        const { store, writes, events, fire, setAccount } = await boot(offline)
        await fire('online')
        expect(store.isAuthenticated).toBe(false)
        expect(store._sessionUnverified).toBe(true)
        expect(writes).toEqual([])
        setAccount(online())
        await fire('online')
        expect(store.user).toEqual({ $id: 'u1' })
        expect(store._sessionUnverified).toBe(false)
        expect(writes.map(w => w.isAuthenticated)).toEqual([true])
        expect(events).toContain('manifest:auth:login')
    })

    it('a late 401 from a recheck superseded by another tab signing in is dropped', async () => {
        const { store, writes, storage, setAccount, listeners } = await boot(offline)
        let rejectGet
        setAccount({ get: () => new Promise((_, rej) => { rejectGet = rej }) })
        listeners.online.forEach(fn => fn({}))
        await settle(5)
        await storage({ ...u1, user: { $id: 'u2' } })
        writes.length = 0
        rejectGet(noSession())
        await settle(10)
        expect(store.user).toEqual({ $id: 'u2' })
        expect(writes).toEqual([])
    })

    it('a late success from a recheck superseded by a sign-in here does not adopt the stale user', async () => {
        const { store, writes, events, setAccount, listeners } = await boot(offline)
        let resolveGet
        setAccount({ get: () => new Promise(res => { resolveGet = res }), listSessions: online().listSessions })
        listeners.online.forEach(fn => fn({}))
        await settle(5)
        Object.assign(store, u1, { user: { $id: 'u2' } })
        listeners['manifest:auth:login'].forEach(fn => fn({}))
        events.length = 0
        writes.length = 0
        resolveGet({ $id: 'u1' })
        await settle(10)
        expect(store.user).toEqual({ $id: 'u2' })
        expect(events).toEqual([])
        expect(writes).toEqual([])
    })

    it('rechecks on a bounded backoff while unreachable, and stops once verified', async () => {
        const t = manualTimers()
        const { store, setAccount } = await boot(offline, { timers: t.timers })
        const seen = []
        for (let i = 0; i < 5; i++) { seen.push(...t.delays()); await t.tick() }
        expect(seen).toEqual([2000, 5000, 15000, 60000, 60000])
        expect(store._sessionUnverified).toBe(true)
        setAccount(online())
        await t.tick()
        expect(store.user).toEqual({ $id: 'u1' })
        expect(t.queue.size).toBe(0)
    })

    it('returning to the tab rechecks; a sign-in elsewhere cancels the pending retry', async () => {
        const t = manualTimers()
        const { store, setAccount, visible } = await boot(offline, { timers: t.timers })
        setAccount(online())
        await visible()
        expect(store.user).toEqual({ $id: 'u1' })
        expect(t.queue.size).toBe(0)
        const b = manualTimers()
        const other = await boot(offline, { timers: b.timers })
        expect(b.queue.size).toBe(1)
        await other.storage(u1)
        expect(b.queue.size).toBe(0)
    })

    it('a 401 on refresh() in an unverified tab is a genuine signed-out: broadcast and verified', async () => {
        const { store, writes, setAccount } = await boot(offline)
        setAccount({ get: async () => { throw noSession() } })
        await store.refresh().catch(() => {})
        expect(store._sessionUnverified).toBe(false)
        expect(writes.map(w => w.isAuthenticated)).toEqual([false])
    })

    it('a recovered check that finds no session broadcasts signed out, then guest-auto runs', async () => {
        const { store, writes, fire, setAccount } = await boot(offline, { guestAuto: true })
        let guests = 0
        store._createAnonymousSession = async () => { guests++ }
        setAccount({ get: async () => { throw noSession() } })
        await fire('online')
        expect(store._sessionUnverified).toBe(false)
        expect(writes.map(w => w.isAuthenticated)).toEqual([false])
        expect(guests).toBe(1)
    })
})

describe('auth main: guest-auto after init', () => {
    async function run(unverified) {
        let guests = 0
        const listeners = {}
        const store = { _initialized: true, isAuthenticated: false, _guestAuto: true, _sessionUnverified: unverified, _createAnonymousSession: async () => { guests++ } }
        let alpineInit = null
        const ctx = { console, setTimeout, Promise }
        ctx.window = {
            addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
            ManifestAppwriteAuthConfig: {},
        }
        ctx.document = { readyState: 'complete', addEventListener: (ev, cb) => { if (ev === 'alpine:init') alpineInit = cb } }
        ctx.Alpine = { store: () => store }
        vm.createContext(ctx)
        vm.runInContext(AUTH_MAIN, ctx)
        alpineInit()
        await settle(200)
        for (const fn of listeners['manifest:auth:initialized'] || []) await fn()
        return guests
    }

    it('a genuine signed-out init creates the guest', async () => {
        expect(await run(false)).toBe(1)
    })

    it('an unverified (offline) init does not', async () => {
        expect(await run(true)).toBe(0)
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

describe('permission-scoped sources (no scope, no $auth. query)', () => {
    const PERM_FILES = { files: { appwriteBucketId: 'files' } }
    const tagged = () => { const who = Alpine.store('auth').user?.$id || 'anon'; return [{ $id: `${who}-file` }] }

    it("logout drops the previous user's table rows and reloads as the new identity", async () => {
        const { net, ids, state, main } = await load(signedIn('u1'), undefined)
        await main.loadDataSource('projects')
        await settle(60)
        expect(ids()).toEqual(['u1-0', 'u1-1'])

        logout()
        await settle(80)
        expect(ids()).toEqual(['anon-0', 'anon-1'])
        expect(state().ready).toBe(true)
        expect(net.tableCalls).toBe(2)
    })

    it("session-cleared drops an unscoped bucket's files", async () => {
        await load(signedIn('u1'), undefined, { extra: PERM_FILES, listFiles: async () => tagged() })
        await window.ManifestDataMain.loadDataSource('files')
        await settle(60)
        expect(fileIds()).toEqual(['u1-file'])

        logout(signedOut(), 'manifest:auth:session-cleared')
        await settle(80)
        expect(fileIds()).toEqual(['anon-file'])
    })

    it('a public table still renders its rows for a signed-out visitor (never settles empty)', async () => {
        const { net, ids, state, main } = await load(signedOut(), undefined)
        await main.loadDataSource('projects')
        await settle(60)
        expect(ids()).toEqual(['anon-0', 'anon-1'])
        expect(state().ready).toBe(true)
        expect(net.tableCalls).toBe(1)
    })

    it('a public table loaded signed out reloads after a later logout (guest restored)', async () => {
        const { net, ids, main } = await load(signedOut(), undefined)
        await main.loadDataSource('projects')
        await settle(60)
        logout({ ...signedOut(), isAuthenticated: true, isAnonymous: true, user: { $id: 'g1' } })
        await settle(80)
        expect(ids()).toEqual(['g1-0', 'g1-1'])
        expect(net.tableCalls).toBe(2)
    })
})

describe('bucket $remove keeps the source filter', () => {
    it("refreshes without an unfiltered listing: other users' readable files never appear", async () => {
        window.Appwrite = { Query: { equal: (attr, value) => JSON.stringify(['equal', attr, value]) } }
        const all = [{ $id: 'u1-file', ownerId: 'u1' }, { $id: 'u1-other', ownerId: 'u1' }, { $id: 'shared-file', ownerId: 'u2' }]
        const listings = []
        await load(signedIn('u1'), null, {
            extra: FILES,
            listFiles: async (bucket, queries) => {
                listings.push(queries.length)
                return queries.length ? all.filter(f => f.ownerId === 'u1') : all.slice()
            }
        })
        await window.ManifestDataMain.loadDataSource('files')
        await settle(60)
        expect(fileIds()).toEqual(['u1-file', 'u1-other'])

        window.ManifestDataAppwrite.deleteFile = async (bucket, id) => { all.splice(all.findIndex(f => f.$id === id), 1); return {} }
        await methods('files')('$remove', 'u1-file')
        await settle(60)
        expect(fileIds()).toEqual(['u1-other'])
        expect(listings.every(n => n > 0)).toBe(true)
        delete window.Appwrite
    })

    it('removes every file of an array $remove', async () => {
        await load(signedIn('u1'), null, { extra: FILES, listFiles: async () => [{ $id: 'a' }, { $id: 'b' }, { $id: 'c' }] })
        await window.ManifestDataMain.loadDataSource('files')
        await settle(60)
        window.ManifestDataAppwrite.deleteFile = async () => ({})
        await methods('files')('$remove', ['a', { $id: 'c' }])
        await settle(60)
        expect(fileIds()).toEqual(['b'])
    })
})
