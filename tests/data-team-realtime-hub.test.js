// @vitest-environment happy-dom
/**
 * Team listener with the real realtime hub: read sources subscribe once at boot
 * (team resolving after the listener starts, or known), a switch re-subscribes
 * each read source exactly once and leaves unread sources unsubscribed, and an
 * event for the old team never lands after the switch.
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
    'appwrite/manifest.data.appwrite.js',
    'appwrite/manifest.data.realtime.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const settle = (ms = 60) => new Promise(r => setTimeout(r, ms))
let iso = null

// Counting Appwrite mock: Realtime instances created, SDK subscribe calls,
// per-channel callbacks firable from tests. realtimeQueries: true swaps in the
// query-capable Realtime (SDK >=25 shape: pendingSubscribes marker, queries as
// third subscribe arg, Promise<{unsubscribe, close}> return, server-side
// payload filtering ANDed per subscription — mirrors RuntimeQuery::filter).
function serverMatch(row, q) {
    if (typeof q === 'string') q = JSON.parse(q)
    const val = row?.[q.attribute]
    const vals = q.values || []
    const eq = v => Array.isArray(val) ? val.includes(v) : val === v
    switch (q.method) {
        case 'equal': return vals.some(eq)
        case 'notEqual': return !vals.some(eq)
        case 'lessThan': return val < vals[0]
        case 'lessThanEqual': return val <= vals[0]
        case 'greaterThan': return val > vals[0]
        case 'greaterThanEqual': return val >= vals[0]
        case 'isNull': return val === null || val === undefined
        case 'isNotNull': return val !== null && val !== undefined
        case 'and': return vals.every(sub => serverMatch(row, sub))
        case 'or': return vals.some(sub => serverMatch(row, sub))
        default: return true
    }
}

function mockAppwrite(tables = {}, files = {}, { realtimeQueries = false } = {}) {
    const stats = { instances: [], subscribes: [], subscribeArgs: [], timeline: [] }
    let subSeq = 0
    class Realtime {
        constructor(client) { this.client = client; this.channels = new Map(); stats.instances.push(this) }
        subscribe(channel, cb, ...rest) {
            stats.subscribes.push(channel)
            stats.subscribeArgs.push({ channel, argc: 2 + rest.length, queries: rest[0] ?? null })
            stats.timeline.push({ op: 'sub', channel, queries: rest[0] ?? null })
            const set = this.channels.get(channel) || new Set()
            set.add(cb)
            this.channels.set(channel, set)
            return () => { set.delete(cb); stats.timeline.push({ op: 'unsub', channel, queries: null }) }
        }
        fire(channel, response) { [...(this.channels.get(channel) || [])].forEach(cb => cb(response)) }
        liveCount(channel) { return (this.channels.get(channel) || new Set()).size }
    }
    class RealtimeQ {
        constructor(client) { this.client = client; this.pendingSubscribes = new Map(); this.subs = new Map(); stats.instances.push(this) }
        subscribe(channel, cb, queries = []) {
            stats.subscribes.push(channel)
            stats.subscribeArgs.push({ channel, argc: arguments.length, queries })
            stats.timeline.push({ op: 'sub', channel, queries })
            const id = `s${++subSeq}`
            this.subs.set(id, { channel, cb, queries })
            const drop = async () => { if (this.subs.delete(id)) stats.timeline.push({ op: 'unsub', channel, queries }) }
            return Promise.resolve({ unsubscribe: drop, close: drop })
        }
        fire(channel, response) {
            for (const sub of [...this.subs.values()]) {
                if (sub.channel !== channel) continue
                if (sub.queries.length && !sub.queries.every(q => serverMatch(response.payload, q))) continue
                sub.cb(response)
            }
        }
        liveCount(channel) { return [...this.subs.values()].filter(s => s.channel === channel).length }
        liveQueries(channel) { return [...this.subs.values()].filter(s => s.channel === channel).map(s => s.queries) }
    }
    // Query strings mirror the real SDK wire shape: JSON {method, attribute, values}
    const Q = (m, a) => m === 'or' || m === 'and'
        ? JSON.stringify({ method: m, values: (a[0] || []).map(s => typeof s === 'string' ? JSON.parse(s) : s) })
        : JSON.stringify({ method: m, attribute: a[0], ...(a.length > 1 && { values: Array.isArray(a[1]) ? a[1] : [a[1]] }) })
    window.Appwrite = {
        Client: class { setEndpoint() { return this } setProject() { return this } },
        TablesDB: class { async listRows({ tableId }) { return { rows: (tables[tableId] || []).map(r => ({ ...r })) } } },
        Storage: class { async listFiles(bucketId) { return { files: (files[bucketId] || []).map(f => ({ ...f })) } } },
        Realtime: realtimeQueries ? RealtimeQ : Realtime,
        Query: new Proxy({}, { get: (_, m) => (...a) => Q(m, a) }),
        Permission: { read: r => `read("${r}")` },
        Role: { user: id => `user:${id}`, team: id => `team:${id}` },
    }
    return stats
}

const signedOut = () => ({ _initialized: true, isAuthenticated: false, isAnonymous: false, user: null, currentTeam: null, teams: [] })

async function boot(dataSources, { tables = {}, files = {}, auth, realtimeQueries = false } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', auth || signedOut())
    const stats = mockAppwrite(tables, files, { realtimeQueries })
    delete window.ManifestRealtimeHub
    delete window.ManifestDataRealtime
    delete window.ManifestDataAppwrite
    delete window.ManifestAppwriteAuthConfig
    delete window.ManifestDataPersist
    window.ManifestComponentsRegistry = { manifest: { appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db' }, data: dataSources } }

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
    await settle(50)

    return {
        stats,
        rt: () => stats.instances[stats.instances.length - 1],
        rows: name => Array.from(Alpine.store('data')[name] ?? []).map(r => r.$id),
        state: name => Alpine.store('data')[`_${name}_state`],
        main: window.ManifestDataMain,
        realtime: () => window.ManifestDataRealtime,
        queries: () => window.ManifestDataQueries,
    }
}

const T = (tableId, extra = {}) => ({ appwriteTableId: tableId, appwriteDatabaseId: 'db', ...extra })
const CH = t => `databases.db.tables.${t}.rows`
let seq = 100
const evt = (type, row) => ({ events: [`tables.rows.${type}`], payload: { $sequence: ++seq, ...row } })

afterEach(() => {
    iso?.release()
    iso = null
})


const auth = (team) => ({ _initialized: true, isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, currentTeam: team ? { $id: team } : null, teams: team ? [{ $id: team }] : [] })
const setTeam = (team) => { const a = Alpine.store('auth'); a.currentTeam = team ? { $id: team } : null; a.teams = team ? [{ $id: team }] : [] }
describe('real hub vs team listener', () => {
    for (const startTeam of [null, 'tA']) it(`boot (${startTeam}) then switch`, async () => {
        const srcs = {}
        for (let i = 0; i < 12; i++) srcs[`s${i}`] = T(`t${i}`, { scope: 'team' })
        const tables = {}
        for (let i = 0; i < 12; i++) tables[`t${i}`] = [{ $id: `r${i}`, teamId: 'tA' }]
        const { stats, rt, rows, main } = await boot(srcs, { tables, auth: auth(startTeam) })
        if (!startTeam) setTeam('tA')
        await Promise.all([0, 1, 2].map(i => main.loadDataSource(`s${i}`)))
        await settle(2300)
        const bootSubs = stats.subscribes.length
        const live = [0, 1, 2, 3].map(i => rt()?.liveCount(CH(`t${i}`)) ?? 0)
        setTeam('tB')
        await settle(2400)
        expect(bootSubs).toBe(3)
        expect(live).toEqual([1, 1, 1, 0])
        const live2 = [0, 1, 2, 3].map(i => rt()?.liveCount(CH(`t${i}`)) ?? 0)
        rt().fire(CH('t0'), evt('create', { $id: 'oldA', teamId: 'tA' }))
        rt().fire(CH('t0'), evt('create', { $id: 'newB', teamId: 'tB' }))
        await settle(200)
        expect(live2).toEqual([1, 1, 1, 0])
        expect(rows('s0')).not.toContain('oldA')
    }, 15000)
})
