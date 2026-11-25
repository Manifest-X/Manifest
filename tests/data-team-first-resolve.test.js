// @vitest-environment happy-dom
/**
 * Team change listener vs. the team resolving at boot: a team-scoped source
 * read under team T is not wiped and refetched when the 2s poller first sees
 * T (it used to treat null → T as a team switch). A source read without the
 * team (or under another one) reloads exactly once; A → B and logout behave
 * as before; a realtime row landed before the first check survives.
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

const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
// Longer than one 2s poll of the team listener
const POLL = 2300
const signedIn = (id = 'u1', team = null) => ({
    _initialized: true, isAuthenticated: true, isAnonymous: false, user: { $id: id },
    currentTeam: team ? { $id: team } : null, teams: team ? [{ $id: team }] : []
})
let iso = null

// Name-keyed like the realtime hub: a re-subscribe replaces the source's registration
function mockRealtime() {
    const cbs = new Map()
    const calls = new Map()
    const sub = (name, cb) => { calls.set(name, (calls.get(name) || 0) + 1); cbs.set(name, cb); return () => cbs.delete(name) }
    return {
        cbs, calls,
        async subscribeToTable(name, db, table, scope, cb) { return sub(name, cb) },
        async subscribeToStorageBucket(name, bucket, scope, cb) { return sub(name, cb) },
        unsubscribeFromDataSource: name => cbs.delete(name),
    }
}

// Rows are tagged with the team the read ran under; hold(table, team) can delay a response
async function load(auth, scope, { appwriteAuth = { teams: {} }, realtime, sources = 0, hold } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', auth)
    window.__manifestRenderReady = false
    const data = { projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope } }
    for (let i = 0; i < sources; i++) data[`s${i}`] = { appwriteTableId: `s${i}`, appwriteDatabaseId: 'db', scope: 'team' }
    const manifest = {
        appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db', auth: appwriteAuth },
        data
    }
    const net = { calls: [] }
    window.ManifestDataAppwrite = {
        loadTableRows: async (db, table, queries) => {
            const team = Alpine.store('auth').currentTeam?.$id || 'none'
            net.calls.push({ table, team, queries: JSON.stringify(queries) })
            if (hold) await hold(table, team)
            return [{ $id: `${team}-0`, teamId: team, userId: 'u1' }, { $id: `${team}-1`, teamId: team, userId: 'u1' }]
        },
        listBucketFiles: async () => []
    }
    if (realtime) window.ManifestDataRealtime = realtime
    else delete window.ManifestDataRealtime
    window.ManifestComponentsRegistry = { manifest }
    window.Appwrite = { Query: {
        equal: (field, value) => `equal(${field},${value})`,
        or: (queries) => `or(${queries.join(',')})`,
    } }

    iso = isolateVm()
    const ctx = {
        window, document, Alpine, console, ...iso.timers, clearTimeout, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        File: window.File, Blob: window.Blob,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
    await settle(200)
    const ids = (name = 'projects') => Array.from(Alpine.store('data')[name] ?? []).map(r => r.$id)
    return { net, ids, main: window.ManifestDataMain }
}

function deferred() { let resolve; const p = new Promise(r => { resolve = r }); return { p, resolve } }

const setTeam = (team) => {
    const auth = Alpine.store('auth')
    auth.currentTeam = team ? { $id: team } : null
    auth.teams = team ? [{ $id: team }] : []
}

afterEach(() => {
    delete window.Appwrite
    iso?.release()
    iso = null
})

describe('team resolves after the listener starts', () => {
    it('a source read under the resolved team is fetched once at boot', async () => {
        const { net, ids, main } = await load(signedIn('u1'), 'team')
        setTeam('t1')
        await main.loadDataSource('projects')
        await settle(60)
        expect(net.calls.length).toBe(1)
        await settle(POLL)
        expect(net.calls.length).toBe(1)
        expect(ids()).toEqual(['t1-0', 't1-1'])
    }, 8000)

    it('a source read without the team reloads exactly once', async () => {
        const { net, ids, main } = await load(signedIn('u1'), ['user', 'team'])
        await main.loadDataSource('projects')
        await settle(60)
        expect(net.calls.length).toBe(1)
        expect(net.calls[0].queries).not.toContain('t1')

        setTeam('t1')
        await settle(POLL)
        expect(net.calls.length).toBe(2)
        expect(net.calls[1].queries).toContain('t1')
        expect(ids()).toEqual(['t1-0', 't1-1'])
        await settle(POLL)
        expect(net.calls.length).toBe(2)
    }, 10000)

    it('a read skipped for want of a team loads once when the team arrives', async () => {
        const { net, ids, main } = await load(signedIn('u1'), 'team')
        await main.loadDataSource('projects')
        await settle(60)
        expect(net.calls.length).toBe(0)

        setTeam('t1')
        window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'))
        await settle(POLL)
        expect(net.calls.length).toBe(1)
        expect(ids()).toEqual(['t1-0', 't1-1'])
    }, 8000)

    it('a realtime row landed before the first check survives', async () => {
        const rt = mockRealtime()
        const { net, ids, main } = await load(signedIn('u1'), 'team', { realtime: rt })
        setTeam('t1')
        await main.loadDataSource('projects')
        await settle(60)
        await rt.cbs.get('projects')('create', { $id: 't1-live', teamId: 't1' })
        await settle(60)
        expect(ids()).toContain('t1-live')
        await settle(POLL)
        expect(net.calls.length).toBe(1)
        expect(ids()).toContain('t1-live')
    }, 8000)
})

describe('real team changes still reload', () => {
    it('A → B reloads under B', async () => {
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(60)
        expect(ids()).toEqual(['tA-0', 'tA-1'])

        setTeam('tB')
        await settle(POLL)
        expect(net.calls.length).toBe(2)
        expect(net.calls[1].team).toBe('tB')
        expect(ids()).toEqual(['tB-0', 'tB-1'])
    }, 8000)

    it('logout after the first resolve reloads once, not again at the next poll', async () => {
        const { net, ids, main } = await load(signedIn('u1'), 'team', { appwriteAuth: { teams: { guests: true } } })
        setTeam('t1')
        await main.loadDataSource('projects')
        await settle(POLL)
        expect(net.calls.length).toBe(1)

        Object.assign(Alpine.store('auth'), { ...signedIn('g1', 'gt1'), isAnonymous: true })
        window.dispatchEvent(new CustomEvent('manifest:auth:logout'))
        await settle(80)
        expect(net.calls.length).toBe(2)
        expect(ids()).toEqual(['gt1-0', 'gt1-1'])
        await settle(POLL)
        expect(net.calls.length).toBe(2)
    }, 10000)
})

// The reporting app: 52 team-scoped sources declared, about 10 read at boot
describe('many declared team-scoped sources, few read', () => {
    const N = 52, K = 10
    const readK = (main) => Promise.all(Array.from({ length: K }, (_, i) => main.loadDataSource(`s${i}`)))

    it('boot issues one request per read source', async () => {
        const rt = mockRealtime()
        const { net, main } = await load(signedIn('u1'), 'team', { sources: N, realtime: rt })
        setTeam('t1')
        await readK(main)
        await settle(POLL)
        expect(net.calls.length).toBe(K)
        expect(new Set(net.calls.map(c => c.table)).size).toBe(K)
        for (let i = 0; i < K; i++) expect(rt.calls.get(`s${i}`)).toBe(1)
        expect(rt.cbs.size).toBe(K)
    }, 10000)

    it('A → B reloads only the read sources; an untouched source later loads for B', async () => {
        const rt = mockRealtime()
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team', { sources: N, realtime: rt })
        await readK(main)
        await settle(60)
        expect(net.calls.length).toBe(K)

        setTeam('tB')
        await settle(POLL)
        expect(net.calls.length).toBe(2 * K)
        expect(net.calls.slice(K).every(c => c.team === 'tB')).toBe(true)
        for (let i = 0; i < K; i++) expect(rt.calls.get(`s${i}`)).toBe(2)
        expect(rt.cbs.size).toBe(K)
        expect(ids('s0')).toEqual(['tB-0', 'tB-1'])

        await main.loadDataSource('s30')
        await settle(60)
        expect(net.calls.length).toBe(2 * K + 1)
        expect(net.calls.at(-1)).toMatchObject({ table: 's30', team: 'tB' })
        expect(ids('s30')).toEqual(['tB-0', 'tB-1'])
    }, 10000)
})

describe('loads in flight across the check', () => {
    it('a load in flight for the current team is not reissued', async () => {
        const gate = deferred()
        const { net, ids, main } = await load(signedIn('u1'), 'team', { hold: () => gate.p })
        setTeam('t1')
        const pending = main.loadDataSource('projects')
        await settle(POLL)
        gate.resolve()
        await pending
        await settle(POLL)
        expect(net.calls.length).toBe(1)
        expect(ids()).toEqual(['t1-0', 't1-1'])
    }, 10000)

    it('a load in flight for the old team never lands over the new team', async () => {
        const gate = deferred()
        let holdA = false
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team', { hold: (t, team) => holdA && team === 'tA' ? gate.p : null })
        await main.loadDataSource('projects')
        await settle(60)
        holdA = true
        const stale = main.loadDataSource('projects', undefined, { reload: true })
        await settle(30)
        setTeam('tB')
        await settle(POLL)
        expect(ids()).toEqual(['tB-0', 'tB-1'])
        gate.resolve()
        await stale
        await settle(100)
        expect(ids()).toEqual(['tB-0', 'tB-1'])
        expect(net.calls.at(-1).team).toBe('tB')
    }, 10000)
})
