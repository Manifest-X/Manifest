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

// The team a request was built for, read from the query actually sent
const teamOf = (queries) => (JSON.stringify(queries).match(/teamId,([^)]+)\)/) || [])[1] || 'none'

// Rows are tagged with the team in the request's query; hold(table, team) can delay a response
async function load(auth, scope, { appwriteAuth = { teams: {} }, realtime, sources = 0, hold, extra = {}, files = [], fail } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', auth)
    window.__manifestRenderReady = false
    const data = { projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope } }
    for (let i = 0; i < sources; i++) data[`s${i}`] = { appwriteTableId: `s${i}`, appwriteDatabaseId: 'db', scope: 'team' }
    Object.assign(data, extra)
    const manifest = {
        appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db', auth: appwriteAuth },
        data
    }
    const net = { calls: [], lists: [] }
    window.ManifestDataAppwrite = {
        loadTableRows: async (db, table, queries) => {
            const team = teamOf(queries)
            net.calls.push({ table, team, queries: JSON.stringify(queries) })
            if (hold) await hold(table, team)
            if (fail && fail(table, team)) throw new Error('boom')
            return [{ $id: `${team}-0`, teamId: team, userId: 'u1' }, { $id: `${team}-1`, teamId: team, userId: 'u1' }]
        },
        listBucketFiles: async (bucket) => { net.lists.push(bucket); return files.map(f => ({ ...f })) }
    }
    if (realtime) window.ManifestDataRealtime = realtime
    else delete window.ManifestDataRealtime
    window.ManifestComponentsRegistry = { manifest }
    window.Appwrite = {
        Query: {
            equal: (field, value) => `equal(${field},${value})`,
            or: (queries) => `or(${queries.join(',')})`,
            cursorAfter: id => `cursorAfter(${id})`,
            limit: n => `limit(${n})`,
        },
        Permission: { read: role => `read("${role}")` },
        Role: { team: id => `team:${id}`, user: id => `user:${id}` },
    }

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
        expect(net.calls.map(c => c.queries)).toEqual(['["equal(teamId,t1)"]'])
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
        expect(net.calls.map(c => c.queries)).toEqual(['["equal(teamId,tA)"]', '["equal(teamId,tB)"]'])
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

// Auth store whose team switches in a microtask right after the scope builder reads it
function hookedAuth(user, team) {
    const a = signedIn(user, team)
    let cur = a.currentTeam
    delete a.currentTeam
    a._arm = null
    Object.defineProperty(a, 'currentTeam', {
        enumerable: true, configurable: true,
        get() {
            const st = new Error().stack.split('\n').slice(2, 9).join(' | ')
            if (this._arm !== null && /buildQueries/.test(st)) {
                const next = this._arm
                this._arm = null
                queueMicrotask(() => { cur = next ? { $id: next } : null; this.teams = next ? [{ $id: next }] : [] })
            }
            return cur
        },
        set(v) { cur = v }
    })
    return a
}

describe('team changes right after the scope build reads it', () => {
    it('A → B during a reload: reloads for B', async () => {
        const { net, ids, main } = await load(hookedAuth('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(60)
        Alpine.store('auth')._arm = 'tB'
        await main.loadDataSource('projects', undefined, { reload: true })
        await settle(POLL * 2)
        expect(net.calls.map(c => c.queries)).toEqual(['["equal(teamId,tA)"]', '["equal(teamId,tA)"]', '["equal(teamId,tB)"]'])
        expect(ids()).toEqual(['tB-0', 'tB-1'])
    }, 15000)

    it('dual scope, null → t1 at boot: user-only read is redone with the team', async () => {
        const { net, ids, main } = await load(hookedAuth('u1', null), ['user', 'team'])
        Alpine.store('auth')._arm = 't1'
        await main.loadDataSource('projects')
        await settle(POLL * 2)
        expect(net.calls.map(c => c.queries)).toEqual(['["equal(userId,u1)"]', '["or(equal(userId,u1),equal(teamId,t1))"]'])
        expect(ids()).toEqual(['t1-0', 't1-1'])
    }, 15000)

    it('team scope, null → t1 at boot with no auth event to come: not stranded', async () => {
        const { net, ids, main } = await load(hookedAuth('u1', null), 'team')
        Alpine.store('auth')._arm = 't1'
        await main.loadDataSource('projects')
        await settle(POLL * 2)
        expect(net.calls.map(c => c.queries)).toEqual(['["equal(teamId,t1)"]'])
        expect(ids()).toEqual(['t1-0', 't1-1'])
        expect(Alpine.store('data')._projects_state.loading).toBe(false)
    }, 15000)
})

describe('switches inside one poll and $query', () => {
    it('A → B → A inside one poll with a reload under B ends on A', async () => {
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(2100)
        setTeam('tB')
        await main.loadDataSource('projects', undefined, { reload: true })
        await settle(50)
        setTeam('tA')
        await settle(POLL * 2)
        expect(net.calls.map(c => c.team)).toEqual(['tA', 'tB', 'tA'])
        expect(ids()).toEqual(['tA-0', 'tA-1'])
    }, 15000)

    it('a $query in flight across A → B never lands A rows over B', async () => {
        const gate = deferred()
        let holdA = false
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team', { hold: (t, team) => holdA && team === 'tA' ? gate.p : null })
        await main.loadDataSource('projects')
        await settle(60)
        holdA = true
        const q = window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('projects', main.reloadDataSource)('$query', [['equal', 'kind', 'a']])
        await settle(30)
        setTeam('tB')
        await settle(POLL)
        expect(ids()).toEqual(['tB-0', 'tB-1'])
        gate.resolve()
        await q.catch(() => {})
        await settle(POLL)
        expect(ids()).toEqual(['tB-0', 'tB-1'])
        expect(net.calls.at(-1).queries).toBe('["equal(teamId,tB)"]')
    }, 15000)
})

describe('other source types', () => {
    it('paged: one request at boot, reload for B on a switch', async () => {
        const { net, ids, main } = await load(signedIn('u1'), 'team')
        window.ManifestComponentsRegistry.manifest.data.projects.paging = { mode: 'window', size: 2 }
        window.ManifestDataAppwrite.loadTablePage = async (db, table, queries) => {
            const team = teamOf(queries)
            net.calls.push({ table, team, queries: JSON.stringify(queries) })
            return { rows: [0, 1, 2].map(i => ({ $id: `${team}-${i}`, teamId: team })), total: 3 }
        }
        setTeam('t1')
        await main.loadDataSource('projects')
        await settle(POLL)
        expect(net.calls.map(c => c.team)).toEqual(['t1'])
        setTeam('t2')
        await settle(POLL)
        expect(net.calls.map(c => c.team)).toEqual(['t1', 't2'])
        expect(ids()).toEqual(['t2-0', 't2-1'])
    }, 10000)

    it('bucket: one list at boot, refiltered for B on a switch', async () => {
        const files = [{ $id: 'fa', $permissions: ['read("team:tA")'] }, { $id: 'fb', $permissions: ['read("team:tB")'] }]
        const { net, ids, main } = await load(signedIn('u1'), 'team', { files, extra: { docs: { appwriteBucketId: 'docs', scope: 'team' } } })
        setTeam('tA')
        await main.loadDataSource('docs')
        await settle(POLL)
        expect(net.lists.length).toBe(1)
        expect(ids('docs')).toEqual(['fa'])
        setTeam('tB')
        await settle(POLL)
        expect(net.lists.length).toBe(2)
        expect(ids('docs')).toEqual(['fb'])
    }, 10000)

    it('dual scope A → B reloads with B', async () => {
        const { net, ids, main } = await load(signedIn('u1', 'tA'), ['user', 'team'])
        await main.loadDataSource('projects')
        await settle(60)
        setTeam('tB')
        await settle(POLL)
        expect(net.calls.map(c => c.queries)).toEqual(['["or(equal(userId,u1),equal(teamId,tA))"]', '["or(equal(userId,u1),equal(teamId,tB))"]'])
        expect(ids()).toEqual(['tB-0', 'tB-1'])
    }, 10000)
})

describe('edges', () => {
    it('team → null clears the team rows, without polling reloads after', async () => {
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(60)
        setTeam(null)
        await settle(POLL)
        expect(ids()).toEqual([])
        await settle(POLL)
        expect(net.calls.length).toBe(1)
    }, 10000)

    it('a failed reload after a switch settles with an error, not stuck loading or looping', async () => {
        const { net, main } = await load(signedIn('u1', 'tA'), 'team', { fail: (t, team) => team === 'tB' })
        await main.loadDataSource('projects')
        await settle(60)
        setTeam('tB')
        await settle(POLL)
        const state = Alpine.store('data')._projects_state
        expect(state.loading).toBe(false)
        expect(state.error).toBeTruthy()
        // An emptied source (no rows of any team) is retried once for this team, then left
        await settle(POLL * 2)
        expect(net.calls.map(c => c.team)).toEqual(['tA', 'tB', 'tB'])
    }, 12000)

    it('persist-hydrated rows: read at boot → one request; never read → one revalidation, once', async () => {
        const { net, ids, main } = await load(signedIn('u1'), 'team', { sources: 2 })
        const ds = window.ManifestDataStore
        setTeam('t1')
        await ds.landRows('s0', [{ $id: 'old-0', teamId: 'old' }], { mode: 'replace', ready: true, fresh: false, persistHydration: true, allowDuringInit: true })
        await ds.landRows('s1', [{ $id: 'old-1', teamId: 'old' }], { mode: 'replace', ready: true, fresh: false, persistHydration: true, allowDuringInit: true })
        await main.loadDataSource('s0', undefined, { reload: true })
        await settle(POLL * 2)
        expect(net.calls.map(c => c.table + ':' + c.team).sort()).toEqual(['s0:t1', 's1:t1'])
        expect(ids('s0')).toEqual(['t1-0', 't1-1'])
        expect(ids('s1')).toEqual(['t1-0', 't1-1'])
    }, 10000)

    it('a template bound to a never-read source renders the new team after a switch', async () => {
        const { net, main } = await load(signedIn('u1', 'tA'), 'team', { sources: 6 })
        await main.loadDataSource('s0')
        setTeam('tB')
        await settle(POLL)
        const box = document.createElement('div')
        box.innerHTML = `<span x-data x-text="($x.s5 || []).map(r => r.$id).join(',')"></span>`
        document.body.appendChild(box)
        Alpine.initTree(box)
        await settle(200)
        expect(box.querySelector('span').textContent).toBe('tB-0,tB-1')
        expect(net.calls.filter(c => c.table === 's5').map(c => c.team)).toEqual(['tB'])
        box.remove()
    }, 10000)
})

// Review round 2: the record is the team of the rows on screen, written when they land
const Q = (name, q) => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler(name, window.ManifestDataMain.reloadDataSource)('$query', q)
const seq = (net) => net.calls.map(c => c.queries)

describe('record follows landed rows', () => {
    it('E1 a reload for B that fails keeps A rows; the poll still reloads for B', async () => {
        let failB = false
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team', { fail: (t, team) => failB && team === 'tB' })
        await main.loadDataSource('projects')
        await settle(60)
        failB = true
        setTeam('tB')
        await main.loadDataSource('projects', undefined, { reload: true }).catch(() => {})
        await settle(100)
        expect(ids()).toEqual(['tA-0', 'tA-1'])
        failB = false
        await settle(POLL * 2)
        expect(seq(net)).toEqual(['["equal(teamId,tA)"]', '["equal(teamId,tB)"]', '["equal(teamId,tB)"]'])
        expect(ids()).toEqual(['tB-0', 'tB-1'])
    }, 20000)

    it('E2 a deferred read for B does not vouch for A rows a $query lands', async () => {
        const gate = deferred()
        let holdA = false
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team', { hold: (t, team) => holdA && team === 'tA' ? gate.p : null })
        holdA = true
        const q = Q('projects', [['equal', 'kind', 'a']])
        await settle(20)
        setTeam('tB')
        await main.loadDataSource('projects')
        await settle(20)
        gate.resolve()
        await q.catch(() => {})
        await settle(POLL * 2)
        expect(seq(net)).toEqual(['["equal(teamId,tA)","equal(kind,a)"]', '["equal(teamId,tB)"]', '["equal(teamId,tB)"]'])
        expect(ids()).toEqual(['tB-0', 'tB-1'])
    }, 20000)

    it('E3 A → null → A inside one poll with a reload under null ends on A', async () => {
        const { ids, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(60)
        setTeam(null)
        await main.loadDataSource('projects', undefined, { reload: true })
        await settle(60)
        setTeam('tA')
        await settle(POLL * 2)
        expect(ids()).toEqual(['tA-0', 'tA-1'])
    }, 20000)

    it('E4 null → A → B with a read under A ends on B', async () => {
        const { ids, main } = await load(signedIn('u1'), 'team')
        setTeam('tA')
        await main.loadDataSource('projects')
        await settle(30)
        setTeam('tB')
        await settle(POLL * 2)
        expect(ids()).toEqual(['tB-0', 'tB-1'])
    }, 20000)

    it('E5 A → B → C with a read under B ends on C', async () => {
        const { ids, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(30)
        setTeam('tB')
        await main.loadDataSource('projects', undefined, { reload: true })
        await settle(30)
        setTeam('tC')
        await settle(POLL * 2)
        expect(ids()).toEqual(['tC-0', 'tC-1'])
    }, 20000)

    it('E6 a $query run for B before the poll is not clobbered', async () => {
        const { net, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(30)
        setTeam('tB')
        await Q('projects', [['equal', 'kind', 'a']])
        await settle(POLL * 2)
        expect(seq(net)).toEqual(['["equal(teamId,tA)"]', '["equal(teamId,tB)","equal(kind,a)"]'])
    }, 20000)

    it('E7 no switch: $query rows untouched over polls', async () => {
        const { net, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await Q('projects', [['equal', 'kind', 'a']])
        await settle(POLL * 2)
        expect(net.calls.length).toBe(2)
    }, 20000)

    it('E8 a read that always skips sends nothing over six polls', async () => {
        const { net, main } = await load(signedIn('u1', 'tA'), 'team', { extra: { projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope: 'team', queries: [['equal', 'x', '$auth.session.$id']] } } })
        await main.loadDataSource('projects')
        await settle(POLL * 3)
        setTeam('tB')
        await settle(POLL * 3)
        expect(net.calls.length).toBe(0)
    }, 30000)

    it('E9 a read that always errors is retried a bounded number of times', async () => {
        const { net, main } = await load(signedIn('u1', 'tA'), 'team', { fail: () => true })
        await main.loadDataSource('projects').catch(() => {})
        await settle(POLL * 3)
        setTeam('tB')
        await settle(POLL * 3)
        // Its own load, then one listener retry per team (the emptied source has no team to compare)
        expect(net.calls.map(c => c.team)).toEqual(['tA', 'tA', 'tB'])
    }, 40000)

    it('E10 login as another user with another team shows that team', async () => {
        const { ids, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(POLL)
        Object.assign(Alpine.store('auth'), signedIn('u2', 'tB'))
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(POLL * 2)
        expect(ids()).toEqual(['tB-0', 'tB-1'])
    }, 20000)

    it('E11 session-cleared drops the rows', async () => {
        const { ids, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(POLL)
        Object.assign(Alpine.store('auth'), { isAuthenticated: false, user: null, currentTeam: null, teams: [] })
        window.dispatchEvent(new CustomEvent('manifest:auth:session-cleared'))
        await settle(POLL * 2)
        expect(ids()).toEqual([])
    }, 20000)

    it('E12 logout, then login with the team arriving late, ends on the team', async () => {
        const { ids, main } = await load(signedIn('u1', 'tA'), 'team')
        await main.loadDataSource('projects')
        await settle(POLL)
        Object.assign(Alpine.store('auth'), { isAuthenticated: false, user: null, currentTeam: null, teams: [] })
        window.dispatchEvent(new CustomEvent('manifest:auth:logout'))
        await settle(300)
        Object.assign(Alpine.store('auth'), signedIn('u1', null))
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(300)
        setTeam('tA')
        window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'))
        await settle(POLL * 2)
        expect(ids()).toEqual(['tA-0', 'tA-1'])
    }, 20000)

    it('E13 current team replaced: every read source moves to the new team', async () => {
        const { ids, main } = await load(signedIn('u1', 'tA'), 'team', { sources: 3 })
        await main.loadDataSource('projects'); await main.loadDataSource('s0')
        await settle(60)
        setTeam('tB')
        await settle(POLL * 2)
        expect(ids()).toEqual(['tB-0', 'tB-1'])
        expect(ids('s0')).toEqual(['tB-0', 'tB-1'])
    }, 20000)

    it('E14 paged walk with a switch between pages ends on B', async () => {
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team', { extra: { projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope: 'team', paging: { mode: 'all', size: 1 } } } })
        let pages = 0
        window.ManifestDataAppwrite.loadTablePage = async (db, table, queries) => {
            const team = teamOf(queries)
            net.calls.push({ table, team, queries: JSON.stringify(queries) })
            if (++pages === 2) setTeam('tB')
            await settle(10)
            const all = [0, 1, 2].map(i => ({ $id: `${team}-${i}`, teamId: team }))
            const after = (JSON.stringify(queries).match(/cursorAfter\(([^)]+)\)/) || [])[1]
            const start = after ? all.findIndex(r => r.$id === after) + 1 : 0
            return { rows: all.slice(start, start + 2), total: 3 }
        }
        await main.loadDataSource('projects')
        await settle(POLL * 2)
        expect(ids().length).toBeGreaterThan(0)
        expect(ids().every(id => id.startsWith('tB'))).toBe(true)
    }, 20000)

    it('E15 a switch during the auth-init wait builds for B', async () => {
        const auth = signedIn('u1', 'tA'); auth._initialized = false; auth.isAuthenticated = undefined
        const { net, ids, main } = await load(auth, 'team')
        const p = main.loadDataSource('projects')
        await settle(30)
        Object.assign(Alpine.store('auth'), { _initialized: true, isAuthenticated: true })
        setTeam('tB')
        window.dispatchEvent(new CustomEvent('manifest:auth:initialized', { detail: { isAuthenticated: true } }))
        await p
        await settle(POLL * 2)
        expect(ids()).toEqual(['tB-0', 'tB-1'])
        expect(seq(net)).toEqual(['["equal(teamId,tB)"]'])
    }, 20000)

    it('E16 a switch while the listener reload is in flight ends on the latest team', async () => {
        const gate = deferred()
        let holdB = false
        const { ids, main } = await load(signedIn('u1', 'tA'), 'team', { hold: (t, team) => holdB && team === 'tB' ? gate.p : null })
        await main.loadDataSource('projects')
        await settle(60)
        holdB = true
        setTeam('tB')
        await settle(POLL)
        setTeam('tC')
        await settle(POLL)
        gate.resolve()
        await settle(POLL)
        expect(ids()).toEqual(['tC-0', 'tC-1'])
    }, 20000)

    it('$more: a page appended for another team marks the rows for reload', async () => {
        const { net, ids, main } = await load(signedIn('u1', 'tA'), 'team', { extra: { projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope: 'team', paging: { mode: 'window', size: 2 } } } })
        window.ManifestDataAppwrite.loadTablePage = async (db, table, queries) => {
            const team = teamOf(queries)
            net.calls.push({ table, team, queries: JSON.stringify(queries) })
            const all = [0, 1, 2, 3, 4].map(i => ({ $id: `${team}-${i}`, teamId: team }))
            const after = (JSON.stringify(queries).match(/cursorAfter\(([^)]+)\)/) || [])[1]
            const start = after ? all.findIndex(r => r.$id === after) + 1 : 0
            return { rows: all.slice(start, start + 3), total: 5 }
        }
        await main.loadDataSource('projects')
        await settle(60)
        await settle(2100)
        setTeam('tB')
        await Alpine.store('data').projects.$more()
        await settle(POLL)
        expect(ids().every(id => id.startsWith('tB'))).toBe(true)
    }, 20000)
})
