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
function mockAppwrite(tables = {}, presenceRows = [], stats) {
    class Realtime {
        constructor(client) { this.client = client; this.channels = new Map(); stats.instances.push(this) }
        subscribe(channel, cb, ...rest) {
            stats.subscribes.push(channel)
            stats.subscribeArgs.push({ channel, argc: 2 + rest.length, queries: rest[0] ?? null })
            const set = this.channels.get(channel) || new Set()
            set.add(cb)
            this.channels.set(channel, set)
            return () => set.delete(cb)
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
            async upsert(args) { stats.upserts.push(args); return { ...args } }
            async delete() { return true }
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

async function boot({ dataSources = {}, tables = {}, presenceRows = [], presencesConfig = true, auth } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', auth || authed())
    const stats = { clients: [], instances: [], subscribes: [], subscribeArgs: [], presencesServices: [], upserts: [] }
    mockAppwrite(tables, presenceRows, stats)
    delete window.ManifestRealtimeHub
    delete window.ManifestDataRealtime
    delete window.ManifestDataAppwrite
    delete window.ManifestAppwriteAuthConfig
    delete window.ManifestDataPersist
    delete window.ManifestPresence
    window.ManifestComponentsRegistry = {
        manifest: { appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db', presences: presencesConfig }, data: dataSources }
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
    // Load order mirrors the loader: auth first, then presences, then data
    vm.runInContext(read(AUTH_CONFIG), ctx, { filename: AUTH_CONFIG })
    vm.runInContext(read(PRESENCES), ctx, { filename: PRESENCES })
    document.dispatchEvent(new window.CustomEvent('alpine:init')) // presences store/effects only — data not loaded yet
    for (const f of DATA_SUBSCRIPTS) vm.runInContext(read(f), ctx, { filename: f })
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
    await settle(50)

    return {
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
        await settle()
        expect(Object.keys(records()).sort()).toEqual(['me', 'u2', 'u5'])
        // delete classifies and removes
        rt().fire('presences', presenceEvt('delete', P('u2', ['read("team:teamA")'])))
        await settle()
        expect(Object.keys(records()).sort()).toEqual(['me', 'u5'])
        // team scope is NOT server-side expressible: the subscription carries no queries
        const sub = stats.subscribeArgs.find(a => a.channel === 'presences')
        expect(sub.argc).toBe(2)
        expect(sub.queries).toBe(null)
        // own write carries the team read scope
        expect(stats.upserts[0].permissions).toContain('read("team:teamA")')
    })

    it("scope 'global' keeps every readable record and writes a users() read grant", async () => {
        const { rt, stats, presence, records } = await boot({ presenceRows: ROWS, auth: authed('teamA') })
        await presence.start({ scope: 'global' })
        await settle()
        expect(Object.keys(records()).sort()).toEqual(['me', 'u2', 'u3', 'u4'])
        rt().fire('presences', presenceEvt('upsert', P('u6', ['read("team:teamB")'])))
        await settle()
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
        await settle()
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
})
