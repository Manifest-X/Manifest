// @vitest-environment happy-dom
/**
 * Shared realtime hub (Playcom 0.5.250 field report, round 2): the data, auth
 * and presences plugins ride ONE Realtime instance (one socket) per tab via
 * window.ManifestRealtimeHub. Covers: instance/client counts across all three
 * plugins, auth subscriptions surviving identity rebuilds, presence roster
 * scoping (client-side permission filter; server-side queries are not
 * expressible for team scope), and classify-once dispatch.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { isolateVm } from './helpers/vm-isolation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.join(__dirname, '../src/scripts')
const DATA_SUBSCRIPTS = [
    'data/core/manifest.data.config.js',
    'data/appwrite/manifest.data.queries.js',
    'data/core/manifest.data.store.js',
    'data/shared/manifest.data.mutations.js',
    'data/shared/manifest.data.proxies.core.js',
    'data/shared/manifest.data.proxies.cache.js',
    'data/shared/proxies/creation/manifest.data.proxies.helpers.js',
    'data/shared/proxies/creation/manifest.data.proxies.array.js',
    'data/shared/proxies/creation/manifest.data.proxies.route.js',
    'data/shared/manifest.data.proxies.appwrite.js',
    'data/shared/manifest.data.proxies.magic.state.js',
    'data/shared/manifest.data.proxies.magic.core.js',
    'data/shared/manifest.data.main.js',
    'data/appwrite/manifest.data.appwrite.js',
    'data/appwrite/manifest.data.realtime.js',
]
const AUTH_CONFIG = 'auth/manifest.appwrite.auth.config.js'
const PRESENCES = 'manifest.appwrite.presences.js'
const read = f => readFileSync(path.join(SCRIPTS, f), 'utf8')

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms))
let iso = null

// Counting Appwrite mock across all three plugins: Client constructions,
// Realtime instances, SDK subscribes, presence upserts.
function mockAppwrite(tables = {}, presenceRows = [], stats, { promiseMode = false } = {}) {
    class Realtime {
        constructor(client) { this.client = client; this.channels = new Map(); stats.instances.push(this) }
        subscribe(channel, cb, ...rest) {
            stats.subscribes.push(channel)
            stats.subscribeArgs.push({ channel, argc: 2 + rest.length, queries: rest[0] ?? null })
            const set = this.channels.get(channel) || new Set()
            set.add(cb)
            this.channels.set(channel, set)
            const drop = () => set.delete(cb)
            // Real Web SDK ≥22.4 returns Promise<RealtimeSubscription> (the 0.5.248 trap)
            return promiseMode ? Promise.resolve({ unsubscribe: drop }) : drop
        }
        fire(channel, response) { [...(this.channels.get(channel) || [])].forEach(cb => cb(response)) }
        liveCount(channel) { return (this.channels.get(channel) || new Set()).size }
    }
    window.Appwrite = {
        Client: class { constructor() { stats.clients.push(this) } setEndpoint() { return this } setProject() { return this } headers = {} },
        Account: class { async get() { return { $id: 'me' } } },
        Teams: class { },
        TablesDB: class { async listRows({ tableId }) { return { rows: (tables[tableId] || []).map(r => ({ ...r })) } } },
        Storage: class { async listFiles() { return { files: [] } } },
        Presences: class {
            constructor() { stats.presencesServices.push(this) }
            async list() { return { presences: presenceRows.map(r => ({ ...r })) } }
            async upsert(args) { stats.calls.push('upsert'); stats.upserts.push(args); return { ...args } }
            async delete(args) { stats.calls.push('delete'); stats.deletes.push(args); return true }
        },
        Realtime,
        Channel: { presences: () => 'presences', presence: id => `presences.${id}` },
        Query: new Proxy({}, { get: (_, m) => (...a) => JSON.stringify({ method: m, args: a }) }),
        Permission: { read: r => `read("${r}")`, update: r => `update("${r}")`, delete: r => `delete("${r}")` },
        Role: { user: id => `user:${id}`, team: (id, role) => role ? `team:${id}/${role}` : `team:${id}`, users: () => 'users' },
        ID: { unique: () => 'uid' },
    }
}

const authed = (team = null) => ({
    _initialized: true, isAuthenticated: true, isAnonymous: false,
    user: { $id: 'me', name: 'Me' },
    currentTeam: team ? { $id: team } : null, teams: [],
})

async function boot({ dataSources = {}, tables = {}, presenceRows = [], presencesConfig = true, auth, appwriteAuth = null, promiseMode = false, deferAuth = false } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', auth || authed())
    const stats = { clients: [], instances: [], subscribes: [], subscribeArgs: [], presencesServices: [], upserts: [], deletes: [], calls: [] }
    mockAppwrite(tables, presenceRows, stats, { promiseMode })
    delete window.ManifestRealtimeHub
    delete window.ManifestDataRealtime
    delete window.ManifestDataAppwrite
    delete window.ManifestAppwriteAuthConfig
    delete window.ManifestDataPersist
    delete window.ManifestPresence
    window.ManifestComponentsRegistry = {
        manifest: { appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db', presences: presencesConfig, ...(appwriteAuth ? { auth: appwriteAuth } : {}) }, data: dataSources }
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
    let loadAuth = null
    if (deferAuth) {
        // Inverted order: data first, auth injected later by the test
        for (const f of DATA_SUBSCRIPTS) vm.runInContext(read(f), ctx, { filename: f })
        document.dispatchEvent(new window.CustomEvent('alpine:init'))
        loadAuth = () => vm.runInContext(read(AUTH_CONFIG), ctx, { filename: AUTH_CONFIG })
    } else {
        // Load order mirrors the loader: auth first, then presences, then data
        vm.runInContext(read(AUTH_CONFIG), ctx, { filename: AUTH_CONFIG })
        vm.runInContext(read(PRESENCES), ctx, { filename: PRESENCES })
        document.dispatchEvent(new window.CustomEvent('alpine:init')) // presences store/effects only — data not loaded yet
        for (const f of DATA_SUBSCRIPTS) vm.runInContext(read(f), ctx, { filename: f })
    }
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
    await settle(50)

    return {
        loadAuth,
        stats,
        rt: () => stats.instances[stats.instances.length - 1],
        hub: () => window.ManifestRealtimeHub,
        main: window.ManifestDataMain,
        presence: window.ManifestPresence,
        records: () => Alpine.store('presence')?.records || {},
    }
}

const T = (tableId) => ({ appwriteTableId: tableId, appwriteDatabaseId: 'db' })
const CH = t => `databases.db.tables.${t}.rows`
let seq = 500
const P = (userId, perms, status = 'online') => ({ $id: userId, userId, status, $permissions: perms, $updatedAt: '2026-10-28T00:00:00.000Z' })
const presenceEvt = (action, rec) => ({
    events: [`presences.${rec.$id}.${action}`, `presences.${rec.$id}`, `presences.${action}`, 'presences'],
    payload: { $sequence: ++seq, ...rec },
})

afterEach(() => {
    iso?.release()
    iso = null
    try { window.ManifestPresence?.stop?.() } catch (e) { }
})

describe('one socket per tab across data + auth + presences', () => {
    it('N data sources + teams/memberships/account + presence = ONE Realtime, ONE Client', async () => {
        const { stats, main, presence } = await boot({
            dataSources: { alpha: T('t1'), beta: T('t2') },
            tables: { t1: [{ $id: 'a1' }], t2: [{ $id: 'b1' }] },
            auth: authed('teamA'),
        })
        await main.loadDataSource('alpha')
        await main.loadDataSource('beta')
        // Auth entity subscriptions, exactly as teams.core calls them
        const services = await window.ManifestAppwriteAuthConfig.getAppwriteClient()
        const authEvents = []
        services.realtime.subscribe('teams', r => authEvents.push(r))
        services.realtime.subscribe('memberships', () => { })
        services.realtime.subscribe('account', () => { })
        await presence.start()
        await settle()
        expect(stats.clients.length).toBe(1)        // presences + data reuse the auth client
        expect(stats.instances.length).toBe(1)      // ONE socket for all three plugins
        expect([...new Set(stats.subscribes)].sort()).toEqual(
            [CH('t1'), CH('t2'), 'account', 'memberships', 'presences', 'teams'].sort()
        )
        const rt = stats.instances[0]
        for (const ch of ['teams', 'memberships', 'account', 'presences', CH('t1'), CH('t2')]) {
            expect(rt.liveCount(ch)).toBe(1)
        }
        // Auth callbacks get the raw SDK response, once per message
        rt.fire('teams', { events: ['teams.team1.update', 'teams.update'], payload: { $id: 'team1' } })
        await settle()
        expect(authEvents.length).toBe(1)
        expect(Array.isArray(authEvents[0].events)).toBe(true)
    })

    it('auth subscriptions survive an identity rebuild on the new instance', async () => {
        const { stats } = await boot({ auth: authed('teamA') })
        const services = await window.ManifestAppwriteAuthConfig.getAppwriteClient()
        const seen = []
        const unsubscribe = services.realtime.subscribe('teams', r => seen.push(r))
        await settle()
        expect(stats.instances.length).toBe(1)
        const old = stats.instances[0]
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(150)
        expect(stats.instances.length).toBe(2)
        const neu = stats.instances[1]
        expect(old.liveCount('teams')).toBe(0)
        expect(neu.liveCount('teams')).toBe(1)
        neu.fire('teams', { events: ['teams.t9.create'], payload: { $id: 't9' } })
        await settle()
        expect(seen.length).toBe(1)
        unsubscribe()
        await settle()
        expect(neu.liveCount('teams')).toBe(0)
    })

    it('presences constructs no Client and no Realtime of its own', async () => {
        const { stats, presence } = await boot({ auth: authed('teamA') })
        const clientsBefore = stats.clients.length
        await presence.start()
        await settle()
        expect(stats.clients.length).toBe(Math.max(clientsBefore, 1)) // only the auth client exists
        expect(stats.clients.length).toBe(1)
        expect(stats.instances.length).toBe(1)
        expect(stats.subscribes).toEqual(['presences'])
    })
})

describe('scoped presence', () => {
    const ROWS = [
        P('me', ['read("team:teamA")']),
        P('u2', ['read("team:teamA")']),
        P('u3', ['read("team:teamB")']),
        P('u4', ['read("users")']), // unscoped legacy write
    ]

    it('default: roster scoped to the current team; cross-team and unscoped records drop (hydrate + events)', async () => {
        const { stats, rt, presence, records } = await boot({ presenceRows: ROWS, auth: authed('teamA') })
        await presence.start()
        await settle()
        expect(Object.keys(records()).sort()).toEqual(['me', 'u2'])
        // live events: in-scope lands, out-of-scope drops before the store
        rt().fire('presences', presenceEvt('upsert', P('u5', ['read("team:teamA")'])))
        rt().fire('presences', presenceEvt('upsert', P('u6', ['read("team:teamB")'])))
        await settle(160) // presence events flush on a 100ms coalescing window
        expect(Object.keys(records()).sort()).toEqual(['me', 'u2', 'u5'])
        // delete classifies and removes
        rt().fire('presences', presenceEvt('delete', P('u2', ['read("team:teamA")'])))
        await settle(160) // presence events flush on a 100ms coalescing window
        expect(Object.keys(records()).sort()).toEqual(['me', 'u5'])
        // team scope is NOT server-side expressible: the subscription carries no queries
        const sub = stats.subscribeArgs.find(a => a.channel === 'presences')
        expect(sub.argc).toBe(2)
        expect(sub.queries).toBe(null)
        // own write carries the team read scope
        expect(stats.upserts[0].permissions).toContain('read("team:teamA")')
    })

    it('a nameless user publishes a null name, never their email', async () => {
        const auth = { ...authed(), user: { $id: 'me', name: '', email: 'me@example.com' } }
        const { stats, presence } = await boot({ auth })
        await presence.start({ scope: 'global' })
        await settle()
        expect(stats.upserts[0].metadata.name).toBe(null)
        expect(JSON.stringify(stats.upserts)).not.toContain('me@example.com')
    })

    it("scope 'global' keeps every readable record and writes a users() read grant", async () => {
        const { rt, stats, presence, records } = await boot({ presenceRows: ROWS, auth: authed('teamA') })
        await presence.start({ scope: 'global' })
        await settle()
        expect(Object.keys(records()).sort()).toEqual(['me', 'u2', 'u3', 'u4'])
        rt().fire('presences', presenceEvt('upsert', P('u6', ['read("team:teamB")'])))
        await settle(160) // presence events flush on a 100ms coalescing window
        expect(Object.keys(records())).toContain('u6')
        expect(stats.upserts[0].permissions).toContain('read("users")')
    })

    it('an explicit team id scope wins over the current team', async () => {
        const { stats, presence, records } = await boot({ presenceRows: ROWS, auth: authed('teamA') })
        await presence.start({ scope: 'teamB' })
        await settle()
        expect(Object.keys(records()).sort()).toEqual(['me', 'u3'])
        expect(stats.upserts[0].permissions).toContain('read("team:teamB")')
    })

    it('manifest appwrite.presences.scope configures the default', async () => {
        const { presence, records } = await boot({ presenceRows: ROWS, auth: authed('teamA'), presencesConfig: { scope: 'global' } })
        await presence.start()
        await settle()
        expect(Object.keys(records()).sort()).toEqual(['me', 'u2', 'u3', 'u4'])
    })

    it('switching the current team rescopes the roster and rewrites own permissions', async () => {
        const { stats, presence, records } = await boot({ presenceRows: ROWS, auth: authed('teamA') })
        await presence.start()
        await settle()
        expect(Object.keys(records()).sort()).toEqual(['me', 'u2'])
        Alpine.store('auth').currentTeam = { $id: 'teamB' }
        await settle(150)
        expect(Object.keys(records()).sort()).toEqual(['me', 'u3'])
        const last = stats.upserts[stats.upserts.length - 1]
        expect(last.permissions).toContain('read("team:teamB")')
    })
})

describe('classify once per message', () => {
    it('a multi-variant presence message yields one filter call and one store write', async () => {
        const { rt, hub, presence, records } = await boot({ presenceRows: [], auth: authed('teamA') })
        await presence.start()
        await settle()
        let filterCalls = 0
        hub().setFilter('presence:roster', () => { filterCalls++; return true })
        rt().fire('presences', presenceEvt('upsert', P('u7', ['read("team:teamA")'])))
        await settle(160) // presence events flush on a 100ms coalescing window
        expect(filterCalls).toBe(1) // 4 event-name variants, one classified dispatch
        expect(Object.keys(records())).toContain('u7')
        hub().setFilter('presence:roster', null)
    })

    it('hub.classify reduces variants to the most specific action (delete > update/upsert > create)', async () => {
        const { hub } = await boot({})
        const c = hub().classify
        expect(c(['presences.u1.upsert', 'presences.upsert', 'presences.u1', 'presences'])).toBe('update')
        expect(c(['tables.rows.create', 'rows.create'])).toBe('create')
        expect(c(['presences.u1.delete', 'presences.u1.upsert'])).toBe('delete')
        expect(c(['rows.create', 'rows.update'])).toBe('update')
        expect(c(['presences'])).toBe(null)
    })

    it('verbs match as path segments, never inside user-chosen ids', async () => {
        const { hub } = await boot({})
        const c = hub().classify
        // a table named deleted_posts: its creates/updates are NOT deletes
        expect(c(['databases.db.tables.deleted_posts.rows.r1.create', 'databases.db.tables.deleted_posts.rows.r1'])).toBe('create')
        expect(c(['databases.db.tables.deleted_posts.rows.r1.update'])).toBe('update')
        // a table named create_log: its deletes are NOT creates
        expect(c(['databases.db.tables.create_log.rows.r1.delete'])).toBe('delete')
        // a user id containing "update"
        expect(c(['presences.user_update_bot.delete'])).toBe('delete')
        // non-final verb segments still classify
        expect(c(['users.u1.update.email'])).toBe('update')
        expect(c(['teams.t1.memberships.m1.update.status'])).toBe('update')
    })
})

describe('canonical client (no split, no rebind churn)', () => {
    it('data loading before auth still lands on the auth client: one Client, one Realtime, no re-subscribes', async () => {
        const { stats, loadAuth, main } = await boot({
            deferAuth: true,
            appwriteAuth: { teams: true },
            dataSources: { alpha: T('t1') },
            tables: { t1: [{ $id: 'a1' }] },
            auth: authed('teamA'),
        })
        // Data starts loading while the auth module is still absent: it must
        // wait for the configured auth plugin, not split onto its own Client
        const loading = main.loadDataSource('alpha')
        await settle(120)
        loadAuth()
        await loading
        const services = await window.ManifestAppwriteAuthConfig.getAppwriteClient()
        services.realtime.subscribe('teams', () => { })
        await settle()
        expect(stats.clients.length).toBe(1)
        expect(stats.instances.length).toBe(1)
        // zero churn: each channel subscribed exactly once
        const counts = stats.subscribes.reduce((m, ch) => (m[ch] = (m[ch] || 0) + 1, m), {})
        expect(counts).toEqual({ [CH('t1')]: 1, teams: 1 })
    })
})

describe('promise-returning SDK subscribe (Web SDK ≥22.4 shape)', () => {
    it('auth adapter and presence teardowns actually unsubscribe', async () => {
        const { stats, presence } = await boot({ promiseMode: true, auth: authed('teamA') })
        const services = await window.ManifestAppwriteAuthConfig.getAppwriteClient()
        const teardown = services.realtime.subscribe('teams', () => { })
        await presence.start()
        await settle()
        const rt = stats.instances[0]
        expect(rt.liveCount('teams')).toBe(1)
        expect(rt.liveCount('presences')).toBe(1)
        teardown()
        presence.stop()
        await settle()
        expect(rt.liveCount('teams')).toBe(0)
        expect(rt.liveCount('presences')).toBe(0)
    })

    it('two auth subscriptions to one channel keep separate handlers and teardowns', async () => {
        const { stats } = await boot({ auth: authed('teamA') })
        const services = await window.ManifestAppwriteAuthConfig.getAppwriteClient()
        const seen1 = [], seen2 = []
        const un1 = services.realtime.subscribe('teams', r => seen1.push(r))
        const un2 = services.realtime.subscribe('teams', r => seen2.push(r))
        await settle()
        const rt = stats.instances[0]
        rt.fire('teams', { events: ['teams.t1.update'], payload: { $id: 't1' } })
        await settle()
        expect(seen1.length).toBe(1)
        expect(seen2.length).toBe(1)
        un1()
        await settle()
        rt.fire('teams', { events: ['teams.t1.update'], payload: { $id: 't1' } })
        await settle()
        expect(seen1.length).toBe(1) // torn down
        expect(seen2.length).toBe(2) // still live
        un2()
    })
})

describe('scope lifecycle', () => {
    it('a known record that leaves scope is removed from the roster', async () => {
        const { rt, presence, records } = await boot({
            presenceRows: [P('u2', ['read("team:teamA")'])], auth: authed('teamA'),
        })
        await presence.start()
        await settle()
        expect(Object.keys(records())).toContain('u2')
        // u2's record moves to another team: delivery of the rewrite carries teamB perms
        rt().fire('presences', presenceEvt('upsert', P('u2', ['read("team:teamB")'])))
        await settle(160) // presence events flush on a 100ms coalescing window
        expect(Object.keys(records())).not.toContain('u2')
    })

    it('read("any") records land in every scope', async () => {
        const { presence, records } = await boot({
            presenceRows: [P('u9', ['read("any")'])], auth: authed('teamA'),
        })
        await presence.start()
        await settle()
        expect(Object.keys(records())).toContain('u9')
    })

    it('team switch deletes the old-scope record before re-upserting', async () => {
        const { stats, presence } = await boot({ auth: authed('teamA') })
        await presence.start()
        await settle()
        const callsBefore = stats.calls.length
        Alpine.store('auth').currentTeam = { $id: 'teamB' }
        await settle(150)
        const calls = stats.calls.slice(callsBefore)
        expect(calls).toEqual(['delete', 'upsert']) // old teammates only ever see the delete
        const last = stats.upserts[stats.upserts.length - 1]
        expect(last.permissions).toContain('read("team:teamB")')
    })

    it('scoped write before teams settle is self-only, then rewrites when the team lands', async () => {
        const { stats, presence } = await boot({
            appwriteAuth: { teams: true },
            auth: { ...authed(), currentTeam: null, teams: [] },
        })
        await presence.start()
        await settle()
        // The leak window: never a users() broadcast while teams are loading
        expect(stats.upserts[0].permissions).toContain('read("user:me")')
        expect(stats.upserts[0].permissions.join()).not.toContain('read("users")')
        // Teams land with a current team: the effect rescopes to the team grant
        Alpine.store('auth').currentTeam = { $id: 'teamA' }
        window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'))
        await settle(150)
        const last = stats.upserts[stats.upserts.length - 1]
        expect(last.permissions).toContain('read("team:teamA")')
    })

    it('scoped with teams resolving to none stays self-only — never the users() grant', async () => {
        const { stats, presence } = await boot({
            appwriteAuth: { teams: true },
            auth: { ...authed(), currentTeam: null, teams: [] },
        })
        await presence.start()
        await settle()
        expect(stats.upserts[0].permissions).toContain('read("user:me")')
        window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'))
        await settle(150)
        for (const u of stats.upserts) expect(u.permissions.join()).not.toContain('read("users")')
        // A team arriving late (slow provisioning) still rescopes to the team grant
        Alpine.store('auth').currentTeam = { $id: 'teamLate' }
        await settle(150)
        const last = stats.upserts[stats.upserts.length - 1]
        expect(last.permissions).toContain('read("team:teamLate")')
    })

    it('scoped team becoming null rescopes to self-only, not users()', async () => {
        const { stats, presence } = await boot({
            appwriteAuth: { teams: true },
            auth: { ...authed(), currentTeam: { $id: 'teamA' }, teams: [{ $id: 'teamA' }] },
        })
        await presence.start()
        await settle()
        expect(stats.upserts[0].permissions).toContain('read("team:teamA")')
        Object.assign(Alpine.store('auth'), { currentTeam: null, teams: [] })
        await settle(150)
        const last = stats.upserts[stats.upserts.length - 1]
        expect(last.permissions).toContain('read("user:me")')
        expect(last.permissions.join()).not.toContain('read("users")')
    })

    it('pre-start set() on a scoped teams project is self-only, never users()', async () => {
        const { stats, presence } = await boot({
            appwriteAuth: { teams: true },
            auth: { ...authed(), currentTeam: null, teams: [] },
        })
        await presence.set('online')
        await settle()
        expect(stats.upserts[0].permissions).toContain('read("user:me")')
        expect(stats.upserts[0].permissions.join()).not.toContain('read("users")')
    })

    it('teams disabled in config writes the global users() grant', async () => {
        const { stats, presence } = await boot({
            appwriteAuth: {},
            auth: { ...authed(), currentTeam: null, teams: [] },
        })
        await presence.start()
        await settle()
        expect(stats.upserts[0].permissions).toContain('read("users")')
    })
})

describe('presence write and flush budget (Playcom many-tab audit)', () => {
    const setVisibility = state => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
        document.dispatchEvent(new window.Event('visibilitychange'))
    }
    afterEach(() => { delete document.visibilityState })

    it('sends on change only: an unchanged set() writes nothing', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global' })
        await settle()
        expect(stats.upserts.length).toBe(1)
        await presence.set('online')
        expect(stats.upserts.length).toBe(1)
        await presence.set('busy', { page: 'x' })
        expect(stats.upserts.length).toBe(2)
        expect(stats.upserts[1].metadata.page).toBe('x')
    })

    it('no fixed heartbeat: nothing is re-sent before the keep-alive', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global', keepAliveMs: 1000 })
        await settle(600)
        expect(stats.upserts.length).toBe(1)
        await settle(700)
        expect(stats.upserts.length).toBe(2) // keep-alive at 1 s
    })

    it('heartbeatMs is still accepted as the keep-alive interval, clamped inside the 15 min TTL', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global', heartbeatMs: 1000 })
        await settle(1300)
        expect(stats.upserts.length).toBe(2)
        presence.stop()
        iso.release() // second boot below: release the first plugin's listeners and timers
        const b = await boot({ auth: authed() })
        await b.presence.start({ scope: 'global', heartbeatMs: 60 * 60 * 1000 })
        await settle(100)
        expect(b.stats.upserts.length).toBe(1) // an hour would outlive the TTL: clamped to 10 min, not sent early
    })

    it('a burst of incoming events is one store flush', async () => {
        const { rt, presence, records } = await boot({ auth: authed() })
        await presence.start({ scope: 'global' })
        await settle(160)
        let flushes = 0
        const stopCount = Alpine.effect(() => { Alpine.store('presence').records; flushes++ })
        flushes = 0
        for (let i = 0; i < 30; i++) rt().fire('presences', presenceEvt('upsert', P('b' + i, ['read("users")'])))
        expect(flushes).toBe(0) // nothing synchronous per event
        await settle(160)
        expect(flushes).toBe(1)
        expect(Object.keys(records()).length).toBe(31)
        Alpine.release?.(stopCount)
    })

    it('auto away follows visibility (debounced) and restores the base status, not "online"', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global' })
        await presence.set('busy')
        const n = stats.upserts.length
        setVisibility('hidden')
        await settle(300)
        expect(stats.upserts.length).toBe(n) // settle debounce absorbs tab switches
        setVisibility('visible')
        await settle(1200)
        expect(stats.upserts.length).toBe(n) // back before the debounce: nothing sent
        setVisibility('hidden')
        await settle(1200)
        expect(stats.upserts.at(-1).status).toBe('away')
        setVisibility('visible')
        await settle(200)
        expect(stats.upserts.at(-1).status).toBe('busy')
    })

    it('solo fallback (no BroadcastChannel) leads its own tab', async () => {
        const { presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global' })
        expect(presence.leader).toBe(true)
    })
})

describe('presence before start()', () => {
    it('a pre-start set() writes the given status, never an auto away', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        try {
            await presence.set('online')
            expect(stats.upserts.at(-1).status).toBe('online')
        } finally { delete document.visibilityState }
    })
})

describe('presence review fixes (9bd5d3d)', () => {
    it('subscribes before listing; a live event during the list beats the stale row', async () => {
        const { stats, rt, presence, records } = await boot({ presenceRows: [P('u2', ['read("users")'])], auth: authed() })
        const proto = window.Appwrite.Presences.prototype
        const orig = proto.list
        let subscribedFirst = null
        proto.list = async function () {
            subscribedFirst = stats.subscribes.includes('presences')
            const res = await orig.call(this)
            // u2 leaves while the list response is in flight
            rt().fire('presences', presenceEvt('delete', P('u2', ['read("users")'])))
            return res
        }
        await presence.start({ scope: 'global' })
        await settle(160)
        expect(subscribedFirst).toBe(true)
        expect(Object.keys(records())).not.toContain('u2')
    })

    it('expired peers drop locally without a delete event', async () => {
        const soon = new Date(Date.now() + 300).toISOString()
        const { presence, records } = await boot({ presenceRows: [{ ...P('u3', ['read("users")']), expiresAt: soon }], auth: authed() })
        await presence.start({ scope: 'global' })
        await settle(100)
        expect(Object.keys(records())).toContain('u3')
        await settle(400)
        expect(Object.keys(records())).not.toContain('u3')
    })

    it('stop() clears the roster and own status', async () => {
        const { presence, records } = await boot({ presenceRows: [P('u2', ['read("users")'])], auth: authed() })
        await presence.start({ scope: 'global' })
        await settle()
        expect(Object.keys(records()).length).toBe(2)
        presence.stop()
        expect(records()).toEqual({})
        expect(Alpine.store('presence').me).toBe(null)
    })

    it('a clear() during an in-flight write ends deleted, not re-written', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global' })
        const proto = window.Appwrite.Presences.prototype
        const orig = proto.upsert
        proto.upsert = async function (args) { await settle(80); return orig.call(this, args) }
        const pending = presence.set('busy')
        await settle(10)
        await presence.clear()
        await pending
        expect(stats.calls.at(-1)).toBe('delete')
        proto.upsert = orig
    })

    it('auth before-logout: the record is deleted (awaited) before the session goes', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global' })
        const pending = []
        window.dispatchEvent(new window.CustomEvent('manifest:auth:before-logout', { detail: { waitUntil: p => pending.push(p) } }))
        expect(pending.length).toBe(1)
        await Promise.all(pending)
        expect(stats.deletes.length).toBe(1)
        expect(Alpine.store('presence').me).toBe(null)
    })

    it('a different user after logout (guest restore) stops tracking for the old one', async () => {
        const { presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global' })
        Alpine.store('auth').user = { $id: 'guest2', name: '' }
        await settle()
        expect(Alpine.store('presence').ready).toBe(false)
        expect(presence.leader).toBe(false)
    })
})

describe('presence second-review fixes (3af8403)', () => {
    it('expiry prunes on server time: a client clock 20 min fast keeps live peers', async () => {
        const serverNow = Date.now() - 20 * 60 * 1000 // client is 20 min ahead
        const row = { ...P('u4', ['read("users")']), expiresAt: new Date(serverNow + 10 * 60 * 1000).toISOString() }
        const { presence, records } = await boot({ presenceRows: [row], auth: authed() })
        const proto = window.Appwrite.Presences.prototype
        const orig = proto.upsert
        proto.upsert = async function (args) { const r = await orig.call(this, args); return { ...r, $updatedAt: new Date(serverNow).toISOString() } }
        await presence.start({ scope: 'global' })
        await settle(160)
        expect(Object.keys(records())).toContain('u4') // client-time pruning would drop it
        proto.upsert = orig
    })

    it('stop() resets own state: the next user in the tab starts clean', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global' })
        await presence.set('busy', { page: 'secret' })
        presence.stop()
        Alpine.store('auth').user = { $id: 'other', name: 'Other' }
        await settle()
        await presence.start({ scope: 'global' })
        const last = stats.upserts.at(-1)
        expect(last.presenceId).toBe('other')
        expect(last.status).toBe('online')
        expect(last.metadata.page).toBe(undefined)
    })

    it('an unchanged set() sends nothing and writes nothing', async () => {
        const { stats, presence } = await boot({ auth: authed() })
        await presence.start({ scope: 'global', status: 'available' })
        const n = stats.upserts.length
        expect(await presence.set('available')).toBe(true)
        expect(stats.upserts.length).toBe(n)
    })
})
