// @vitest-environment happy-dom
/**
 * Shared-realtime layer (Playcom field report: 16-23 sockets/tab, unbounded $x
 * growth under bulk imports): one Realtime instance per tab, ref-counted
 * channels (one SDK subscribe per distinct channel), rebuild on identity
 * change, query-aware event filtering, bounded growth with $realtimeOverflow,
 * realtime:false opt-out and the setFilter pre-filter hook.
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

describe('one shared realtime client per tab', () => {
    it('N sources, one Realtime instance; one subscribe per DISTINCT channel', async () => {
        const { stats, main } = await boot(
            { alpha: T('t1'), beta: T('t2'), gamma: T('t2') },
            { tables: { t1: [{ $id: 'a1' }], t2: [{ $id: 'b1' }] } }
        )
        await main.loadDataSource('alpha')
        await main.loadDataSource('beta')
        await main.loadDataSource('gamma')
        await settle()
        expect(stats.instances.length).toBe(1)
        expect(stats.subscribes).toEqual([CH('t1'), CH('t2')])
    })

    it('one event on a shared channel reaches each source exactly once', async () => {
        const { rt, rows, main, realtime } = await boot(
            { beta: T('t2'), gamma: T('t2') },
            { tables: { t2: [{ $id: 'b1' }] } }
        )
        await main.loadDataSource('beta')
        await main.loadDataSource('gamma')
        await settle()
        const seen = { beta: 0, gamma: 0 }
        realtime().setFilter('beta', () => { seen.beta++; return true })
        realtime().setFilter('gamma', () => { seen.gamma++; return true })
        rt().fire(CH('t2'), evt('create', { $id: 'n1' }))
        await settle()
        expect(seen).toEqual({ beta: 1, gamma: 1 })
        expect(rows('beta')).toEqual(['b1', 'n1'])
        expect(rows('gamma')).toEqual(['b1', 'n1'])
    })

    it('ref-count: unsubscribing one source keeps the channel for the other', async () => {
        const { rt, rows, main, realtime } = await boot(
            { beta: T('t2'), gamma: T('t2') },
            { tables: { t2: [{ $id: 'b1' }] } }
        )
        await main.loadDataSource('beta')
        await main.loadDataSource('gamma')
        await settle()
        realtime().unsubscribeFromDataSource('beta')
        expect(rt().liveCount(CH('t2'))).toBe(1)
        rt().fire(CH('t2'), evt('create', { $id: 'n1' }))
        await settle()
        expect(rows('gamma')).toEqual(['b1', 'n1'])
        expect(rows('beta')).toEqual(['b1'])
        realtime().unsubscribeFromDataSource('gamma')
        expect(rt().liveCount(CH('t2'))).toBe(0)
    })

    it('identity reset rebuilds the instance and resubscribes channels on it', async () => {
        const { stats, rows, main } = await boot(
            { alpha: T('t1'), beta: T('t2') },
            { tables: { t1: [{ $id: 'a1' }], t2: [{ $id: 'b1' }] } }
        )
        await main.loadDataSource('alpha')
        await main.loadDataSource('beta')
        await settle()
        expect(stats.instances.length).toBe(1)
        const old = stats.instances[0]
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle()
        expect(stats.instances.length).toBe(2)
        const neu = stats.instances[1]
        expect(old.liveCount(CH('t1'))).toBe(0)
        expect(old.liveCount(CH('t2'))).toBe(0)
        expect(neu.liveCount(CH('t1'))).toBe(1)
        expect(neu.liveCount(CH('t2'))).toBe(1)
        neu.fire(CH('t1'), evt('create', { $id: 'n1' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'n1'])
    })

    it('a multi-variant Appwrite message is classified once: one filter call, one handler call, one merge', async () => {
        const { rt, rows, main, realtime } = await boot({ alpha: T('t1') }, { tables: { t1: [{ $id: 'a1' }] } })
        await main.loadDataSource('alpha')
        await settle()
        const ds = window.ManifestDataStore
        const orig = ds.landRows
        let lands = 0
        ds.landRows = (...a) => { lands++; return orig(...a) }
        const filterCalls = []
        realtime().setFilter('alpha', (type, row) => { filterCalls.push([type, row.$id]); return true })
        let handlerCalls = 0
        const hubSources = window.ManifestRealtimeHub._sources
        const src = hubSources.get('alpha')
        const origHandler = src.handler
        src.handler = (...a) => { handlerCalls++; return origHandler(...a) }
        const entry = window.ManifestRealtimeHub._entries.get(CH('t1'))
        entry.handlers.set('alpha', src.handler)
        try {
            // Appwrite sends several event-name variants for one change
            rt().fire(CH('t1'), {
                events: [
                    'databases.db.tables.t1.rows.n1.create',
                    'tables.rows.create',
                    'rows.create',
                ],
                payload: { $id: 'n1', $sequence: ++seq },
            })
            await settle()
        } finally {
            ds.landRows = orig
            realtime().setFilter('alpha', null)
        }
        expect(filterCalls).toEqual([['create', 'n1']]) // classified once, not once per variant
        expect(handlerCalls).toBe(1)
        expect(lands).toBe(1)
        expect(rows('alpha')).toEqual(['a1', 'n1'])
    })

    it('storage buckets share the same instance', async () => {
        const { stats, rt, rows, main } = await boot(
            { alpha: T('t1'), docs: { appwriteBucketId: 'bk' } },
            { tables: { t1: [{ $id: 'a1' }] }, files: { bk: [{ $id: 'f1' }] } }
        )
        await main.loadDataSource('alpha')
        await main.loadDataSource('docs')
        await settle()
        expect(stats.instances.length).toBe(1)
        expect(stats.subscribes).toEqual([CH('t1'), 'buckets.bk.files'])
        rt().fire('buckets.bk.files', evt('create', { $id: 'f2' }))
        await settle()
        expect(rows('docs')).toEqual(['f1', 'f2'])
    })
})

describe('query matcher', () => {
    const boot1 = (auth) => boot({ alpha: T('t1') }, { tables: { t1: [] }, auth })

    it('evaluates the operators the load serializes (queryMap set)', async () => {
        const { queries } = await boot1()
        const m = (row, q) => queries().rowMatchesQueries(row, q)
        expect(m({ a: 1 }, [['equal', 'a', 1]])).toBe(true)
        expect(m({ a: 2 }, [['equal', 'a', 1]])).toBe(false)
        expect(m({ a: 1 }, [['equal', 'a', [1, 2]]])).toBe(true)
        expect(m({ a: [1, 3] }, [['equal', 'a', 3]])).toBe(true)
        expect(m({ a: 2 }, [['notEqual', 'a', 1]])).toBe(true)
        expect(m({ a: 1 }, [['notEqual', 'a', 1]])).toBe(false)
        expect(m({ a: 1 }, [['lessThan', 'a', 2]])).toBe(true)
        expect(m({ a: 2 }, [['lessThan', 'a', 2]])).toBe(false)
        expect(m({ a: 2 }, [['lessThanEqual', 'a', 2]])).toBe(true)
        expect(m({ a: 3 }, [['greaterThan', 'a', 2]])).toBe(true)
        expect(m({ a: 2 }, [['greaterThanEqual', 'a', 2]])).toBe(true)
        expect(m({ a: 'foobar' }, [['contains', 'a', 'oob']])).toBe(true)
        expect(m({ a: ['x', 'y'] }, [['contains', 'a', 'y']])).toBe(true)
        expect(m({ a: ['x'] }, [['contains', 'a', 'y']])).toBe(false)
        // multiple top-level queries AND together
        expect(m({ a: 1, b: 2 }, [['equal', 'a', 1], ['equal', 'b', 2]])).toBe(true)
        expect(m({ a: 1, b: 3 }, [['equal', 'a', 1], ['equal', 'b', 2]])).toBe(false)
    })

    it('strings compare case-insensitively (Appwrite ci collation); other types strictly', async () => {
        const { queries } = await boot1()
        const m = (row, q) => queries().rowMatchesQueries(row, q)
        expect(m({ a: 'Chat' }, [['equal', 'a', 'chat']])).toBe(true)
        expect(m({ a: 'Chat' }, [['notEqual', 'a', 'chat']])).toBe(false)
        expect(m({ a: 'FooBar' }, [['contains', 'a', 'oob']])).toBe(true)
        expect(m({ a: ['X', 'Y'] }, [['contains', 'a', 'y']])).toBe(true)
        expect(m({ a: '1' }, [['equal', 'a', 1]])).toBe(false) // no cross-type coercion
        expect(m({ a: 1 }, [['equal', 'a', 1]])).toBe(true)
    })

    it('nested or evaluates; and is not serialized by the load so it matches', async () => {
        const { queries } = await boot1()
        const m = (row, q) => queries().rowMatchesQueries(row, q)
        expect(m({ a: 1, b: 9 }, [['or', [['equal', 'a', 1], ['equal', 'b', 2]]]])).toBe(true)
        expect(m({ a: 0, b: 9 }, [['or', [['equal', 'a', 1], ['equal', 'b', 2]]]])).toBe(false)
        expect(m({ a: 0, b: 9 }, [['and', [['equal', 'a', 1], ['equal', 'b', 2]]]])).toBe(true)
        // an unevaluable branch inside or counts as a match
        expect(m({ a: 0 }, [['or', [['equal', 'a', 1], ['isNull', 'zzz']]]])).toBe(true)
    })

    it('non-filter queries are ignored; operators the load drops match regardless', async () => {
        const { queries } = await boot1()
        const m = (row, q) => queries().rowMatchesQueries(row, q)
        expect(m({ a: 1 }, [['limit', 5], ['offset', 2], ['orderDesc', 'a'], ['select', ['a']], ['cursorAfter', 'x']])).toBe(true)
        expect(m({ a: 1 }, [['search', 'a', 'zzz']])).toBe(true)          // search: unevaluable
        expect(m({ a: 1 }, [['someFutureOp', 'a', 'zzz']])).toBe(true)    // unknown: unevaluable
        // Not in toAppwriteQuery's queryMap -> dropped at load -> never drop rows here
        for (const q of [['between', 'a', 2, 3], ['isNull', 'a'], ['isNotNull', 'zzz'], ['startsWith', 'a', 'z'], ['endsWith', 'a', 'z']]) {
            expect(queries().toAppwriteQuery(q)).toBe(null)
            expect(m({ a: 1 }, [q])).toBe(true)
        }
        // $auth. arg unresolved (signed out): unevaluable -> match
        expect(m({ owner: 'u9' }, [['equal', 'owner', '$auth.user.$id']])).toBe(true)
    })

    it('a resolvable $auth. arg is interpolated and evaluated', async () => {
        const { queries } = await boot1({ _initialized: true, isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, currentTeam: null, teams: [] })
        const m = (row, q) => queries().rowMatchesQueries(row, q)
        expect(m({ owner: 'u1' }, [['equal', 'owner', '$auth.user.$id']])).toBe(true)
        expect(m({ owner: 'u2' }, [['equal', 'owner', '$auth.user.$id']])).toBe(false)
    })
})

describe('query-aware merge', () => {
    const SRC = { alpha: T('t1', { queries: [['equal', 'status', 'active']] }) }
    const LIVE = { t1: [{ $id: 'a1', status: 'active' }, { $id: 'a2', status: 'active' }] }

    it('create outside the queries does not land; matching create does', async () => {
        const { rt, rows, main } = await boot(SRC, { tables: LIVE })
        await main.loadDataSource('alpha')
        await settle()
        rt().fire(CH('t1'), evt('create', { $id: 'nope', status: 'archived' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2'])
        rt().fire(CH('t1'), evt('create', { $id: 'n1', status: 'active' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'n1'])
    })

    it('update that stops matching removes the held row', async () => {
        const { rt, rows, main } = await boot(SRC, { tables: LIVE })
        await main.loadDataSource('alpha')
        await settle()
        rt().fire(CH('t1'), evt('update', { $id: 'a1', status: 'archived' }))
        await settle()
        expect(rows('alpha')).toEqual(['a2'])
    })

    it('update that matches an unknown row appends it; a known row updates in place', async () => {
        const { rt, rows, main } = await boot(SRC, { tables: LIVE })
        await main.loadDataSource('alpha')
        await settle()
        rt().fire(CH('t1'), evt('update', { $id: 'n1', status: 'active' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'n1'])
        rt().fire(CH('t1'), evt('update', { $id: 'a2', status: 'active', title: 'x' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'n1'])
        expect(Alpine.store('data').alpha.find(r => r.$id === 'a2').title).toBe('x')
    })

    it('string equality in the merge is case-insensitive', async () => {
        const { rt, rows, main } = await boot(
            { alpha: T('t1', { queries: [['equal', 'kind', 'chat']] }) },
            { tables: { t1: [{ $id: 'a1', kind: 'chat' }] } }
        )
        await main.loadDataSource('alpha')
        await settle()
        rt().fire(CH('t1'), evt('create', { $id: 'n1', kind: 'Chat' })) // server would include it (ci collation)
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'n1'])
    })

    it('operators the load drops (startsWith/isNull) never drop events either', async () => {
        const { rt, rows, main } = await boot(
            { alpha: T('t1', { queries: [['startsWith', 'title', 'Z'], ['isNull', 'deletedAt']] }) },
            { tables: { t1: [{ $id: 'a1', title: 'abc' }] } }
        )
        await main.loadDataSource('alpha')
        await settle()
        // the load dropped both queries, so the server never filtered on them:
        // events must match regardless of value, and updates must not evict held rows
        rt().fire(CH('t1'), evt('create', { $id: 'n1', title: 'other', deletedAt: '2026-01-01' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'n1'])
        rt().fire(CH('t1'), evt('update', { $id: 'a1', title: 'renamed', deletedAt: '2026-01-02' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'n1'])
        expect(Alpine.store('data').alpha.find(r => r.$id === 'a1').title).toBe('renamed')
    })
})

describe('bounded growth', () => {
    it('append mode: cap blocks appends, $realtimeOverflow counts reactively; held rows still update/delete', async () => {
        const { rt, rows, state, main } = await boot(
            { alpha: T('t1', { realtime: { mode: 'append', maxRows: 3 } }) },
            { tables: { t1: [{ $id: 'a1' }, { $id: 'a2' }] } }
        )
        await main.loadDataSource('alpha')
        await settle()
        expect(state('alpha').realtimeOverflow).toBe(0)
        rt().fire(CH('t1'), evt('create', { $id: 'n1' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'n1'])
        const before = state('alpha')
        rt().fire(CH('t1'), evt('create', { $id: 'n2' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'n1'])
        expect(state('alpha').realtimeOverflow).toBe(1)
        expect(state('alpha')).not.toBe(before) // state object replaced -> Alpine tracks it
        expect(window.ManifestDataProxiesMagic.getStateProperty('$realtimeOverflow', 'alpha')).toBe(1)
        rt().fire(CH('t1'), evt('create', { $id: 'n3' }))
        await settle()
        expect(state('alpha').realtimeOverflow).toBe(2)
        // updates/deletes to HELD rows apply regardless of the cap
        rt().fire(CH('t1'), evt('update', { $id: 'a1', title: 'x' }))
        await settle()
        expect(Alpine.store('data').alpha.find(r => r.$id === 'a1').title).toBe('x')
        rt().fire(CH('t1'), evt('delete', { $id: 'a2' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'n1'])
    })

    it('no config: default cap is max(500, 2x initial rows)', async () => {
        const initial = Array.from({ length: 260 }, (_, i) => ({ $id: `i${i}` }))
        const { rt, rows, state, main } = await boot({ alpha: T('t1') }, { tables: { t1: initial } })
        await main.loadDataSource('alpha')
        await settle()
        for (let i = 0; i < 265; i++) rt().fire(CH('t1'), evt('create', { $id: `n${i}` }))
        await settle(150)
        expect(rows('alpha').length).toBe(520) // 2x260 > 500
        expect(state('alpha').realtimeOverflow).toBe(5)
    })

    it('maxRows 0 restores unbounded legacy growth', async () => {
        const { rt, rows, state, main } = await boot(
            { alpha: T('t1', { realtime: { mode: 'append', maxRows: 0 } }) },
            { tables: { t1: [{ $id: 'a1' }] } }
        )
        await main.loadDataSource('alpha')
        await settle()
        for (let i = 0; i < 10; i++) rt().fire(CH('t1'), evt('create', { $id: `n${i}` }))
        await settle()
        expect(rows('alpha').length).toBe(11)
        expect(state('alpha').realtimeOverflow || 0).toBe(0)
    })

    it('window mode: evicts oldest realtime-appended rows first, never initial rows', async () => {
        const { rt, rows, main } = await boot(
            { alpha: T('t1', { realtime: { mode: 'window', maxRows: 5 } }) },
            { tables: { t1: [{ $id: 'a1' }, { $id: 'a2' }, { $id: 'a3' }] } }
        )
        await main.loadDataSource('alpha')
        await settle()
        rt().fire(CH('t1'), evt('create', { $id: 'r1' }))
        rt().fire(CH('t1'), evt('create', { $id: 'r2' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'a3', 'r1', 'r2'])
        rt().fire(CH('t1'), evt('create', { $id: 'r3' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'a3', 'r2', 'r3'])
        rt().fire(CH('t1'), evt('create', { $id: 'r4' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'a3', 'r3', 'r4'])
    })

    it('window mode with 0 initial rows and no limit query stays bounded at the default cap', async () => {
        const { rt, rows, state, main } = await boot(
            { alpha: T('t1', { realtime: { mode: 'window' } }) },
            { tables: { t1: [] } }
        )
        await main.loadDataSource('alpha')
        await settle()
        for (let i = 0; i < 505; i++) rt().fire(CH('t1'), evt('create', { $id: `n${i}` }))
        await settle(200)
        // a computed window of 0 is no window: fall back to max(500, 2x initial)
        expect(rows('alpha').length).toBe(500)
        expect(state('alpha').realtimeOverflow).toBe(5)
    })

    it('explicit maxRows 0 in window mode is a contradiction: normalized to the default cap', async () => {
        const warns = []
        const orig = console.warn
        console.warn = (...a) => { warns.push(a.join(' ')) }
        try {
            const { rt, rows, main } = await boot(
                { alpha: T('t1', { realtime: { mode: 'window', maxRows: 0 } }) },
                { tables: { t1: [] } }
            )
            await main.loadDataSource('alpha')
            await settle()
            rt().fire(CH('t1'), evt('create', { $id: 'n1' }))
            await settle()
            expect(rows('alpha')).toEqual(['n1']) // bounded window, not unbounded
            expect(warns.some(w => w.includes('maxRows 0 contradicts window mode'))).toBe(true)
        } finally {
            console.warn = orig
        }
    })

    it('window mode with no evictable rows overflows instead of dropping initial rows', async () => {
        const { rt, rows, state, main } = await boot(
            { alpha: T('t1', { realtime: { mode: 'window' }, queries: [['limit', 3]] }) },
            { tables: { t1: [{ $id: 'a1' }, { $id: 'a2' }, { $id: 'a3' }] } }
        )
        await main.loadDataSource('alpha')
        await settle()
        rt().fire(CH('t1'), evt('create', { $id: 'r1' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'a2', 'a3'])
        expect(state('alpha').realtimeOverflow).toBe(1)
    })
})

describe('opt-out and pre-filter', () => {
    it('realtime: false -> no subscription at all', async () => {
        const { stats, main, realtime } = await boot(
            { alpha: T('t1', { realtime: false }), beta: T('t2') },
            { tables: { t1: [{ $id: 'a1' }], t2: [{ $id: 'b1' }] } }
        )
        await main.loadDataSource('alpha')
        await main.loadDataSource('beta')
        await settle()
        expect(stats.subscribes).toEqual([CH('t2')])
        expect(realtime().subscriptions.has('alpha')).toBe(false)
    })

    it('server filtering unavailable (legacy SDK): channel-only subscribe, zero queries sent', async () => {
        const { stats, main } = await boot(
            { alpha: T('t1', { queries: [['equal', 'status', 'active']], scope: null }) },
            { tables: { t1: [{ $id: 'a1', status: 'active' }] } } // plain mock: no query markers
        )
        await main.loadDataSource('alpha')
        await settle()
        expect(stats.subscribeArgs).toEqual([{ channel: CH('t1'), argc: 2, queries: null }])
    })

    it('setFilter drops before merge/dedupe; null clears it', async () => {
        const { rt, rows, main, realtime } = await boot(
            { alpha: T('t1') },
            { tables: { t1: [{ $id: 'a1' }] } }
        )
        await main.loadDataSource('alpha')
        await settle()
        const calls = []
        realtime().setFilter('alpha', (type, row) => { calls.push([type, row.$id]); return false })
        const e = evt('create', { $id: 'n1' })
        rt().fire(CH('t1'), e)
        await settle()
        expect(calls).toEqual([['create', 'n1']])
        expect(rows('alpha')).toEqual(['a1'])
        // dropped BEFORE dedupe: the same event still lands once the filter clears
        realtime().setFilter('alpha', null)
        rt().fire(CH('t1'), e)
        await settle()
        expect(rows('alpha')).toEqual(['a1', 'n1'])
    })
})

describe('server-side realtime queries (query-capable SDK)', () => {
    const parse = q => typeof q === 'string' ? JSON.parse(q) : q
    const authed = (id = 'u1') => ({ _initialized: true, isAuthenticated: true, isAnonymous: false, user: { $id: id }, currentTeam: null, teams: [] })

    it("serverFilter 'all': expressible user filters ride the subscription; unexpressible ops are omitted", async () => {
        const { stats, main } = await boot(
            { alpha: T('t1', { queries: [['equal', 'status', 'active'], ['search', 'title', 'x'], ['limit', 5]], realtime: { serverFilter: 'all' } }) },
            { tables: { t1: [] }, realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        expect(stats.subscribeArgs.length).toBe(1)
        expect(stats.subscribeArgs[0].queries.map(parse)).toEqual([
            { method: 'equal', attribute: 'status', values: ['active'] },
        ])
    })

    it('scope queries are filtered server-side (the bulk-import billing case)', async () => {
        const { stats, main } = await boot(
            { alpha: T('t1', { scope: 'user' }) },
            { tables: { t1: [] }, auth: authed('u1'), realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        expect(stats.subscribeArgs.length).toBe(1)
        expect(stats.subscribeArgs[0].queries.map(parse)).toEqual([
            { method: 'equal', attribute: 'userId', values: ['u1'] },
        ])
    })

    it('same channel, different filters: two subscriptions on ONE client; identical filters shared', async () => {
        const { stats, rt, rows, main } = await boot(
            {
                active: T('t1', { queries: [['equal', 'status', 'active']], realtime: { serverFilter: 'all' } }),
                archived: T('t1', { queries: [['equal', 'status', 'archived']], realtime: { serverFilter: 'all' } }),
                active2: T('t1', { queries: [['equal', 'status', 'active']], realtime: { serverFilter: 'all' } }),
            },
            { tables: { t1: [{ $id: 'a1', status: 'active' }] }, realtimeQueries: true }
        )
        await main.loadDataSource('active')
        await main.loadDataSource('archived')
        await main.loadDataSource('active2')
        await settle()
        expect(stats.instances.length).toBe(1)
        expect(rt().liveCount(CH('t1'))).toBe(2)
        // server routes per subscription: an archived create reaches only the archived source
        rt().fire(CH('t1'), evt('create', { $id: 'n1', status: 'archived' }))
        await settle()
        expect(rows('active')).toEqual(['a1'])
        expect(rows('active2')).toEqual(['a1'])
        expect(rows('archived')).toContain('n1')
    })

    it('entirely unexpressible filters subscribe channel-only', async () => {
        const { stats, main } = await boot(
            { alpha: T('t1', { queries: [['search', 'title', 'x'], ['limit', 9]], realtime: { serverFilter: 'all' } }) },
            { tables: { t1: [] }, realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        expect(stats.subscribeArgs).toEqual([{ channel: CH('t1'), argc: 2, queries: [] }])
    })

    it('realtime: { serverFilter: false } opts a source out of server filtering', async () => {
        const { stats, main } = await boot(
            { alpha: T('t1', { queries: [['equal', 'status', 'active']], realtime: { serverFilter: false } }) },
            { tables: { t1: [] }, realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        expect(stats.subscribeArgs).toEqual([{ channel: CH('t1'), argc: 2, queries: [] }])
    })

    it('client matcher still filters what the server cannot express (defense in depth)', async () => {
        const { rt, rows, main } = await boot(
            { alpha: T('t1', { queries: [['equal', 'status', 'active'], ['contains', 'title', 'x']], realtime: { serverFilter: 'all' } }) },
            { tables: { t1: [] }, realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        rt().fire(CH('t1'), evt('create', { $id: 'n1', status: 'active', title: 'nope' })) // passes the server filter, fails contains
        rt().fire(CH('t1'), evt('create', { $id: 'n2', status: 'active', title: 'xy' }))
        await settle()
        expect(rows('alpha')).toEqual(['n2'])
    })

    it('$auth. values resolve into the subscription and re-resolve on identity events', async () => {
        const { stats, rt, main } = await boot(
            { alpha: T('t1', { queries: [['equal', 'owner', '$auth.user.$id']], realtime: { serverFilter: 'all' } }) },
            { tables: { t1: [] }, auth: authed('u1'), realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        expect(rt().liveQueries(CH('t1'))[0].map(parse)).toEqual([
            { method: 'equal', attribute: 'owner', values: ['u1'] },
        ])
        Alpine.store('auth', authed('u2'))
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(200)
        expect(stats.instances.length).toBe(2)
        const inst = stats.instances[1]
        const queries = inst.liveQueries(CH('t1')).map(qs => qs.map(parse))
        expect(queries).toEqual([[{ method: 'equal', attribute: 'owner', values: ['u2'] }]])
    })

    it('filter change resubscribes new-first (no event gap); overlap double-delivery lands once', async () => {
        const { stats, rt, main, realtime } = await boot(
            { alpha: T('t1', { queries: [['equal', 'status', 'active']], realtime: { serverFilter: 'all' } }) },
            { tables: { t1: [{ $id: 'a1', status: 'active' }] }, realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        const inst = rt()
        const ds = window.ManifestDataStore
        const origLand = ds.landRows
        let n1Lands = 0
        ds.landRows = (name, rowsArr, opts) => { if (rowsArr.some(r => r?.$id === 'n1')) n1Lands++; return origLand(name, rowsArr, opts) }
        let delivered = 0
        realtime().setFilter('alpha', () => { delivered++; return true })
        // The overlap event matches BOTH filter sets (different attributes)
        const E = { events: ['tables.rows.create'], payload: { $id: 'n1', $sequence: ++seq, status: 'active', kind: 'x' } }
        const origSub = inst.subscribe.bind(inst)
        // Fires the instant the replacement subscription goes live, old one still attached
        inst.subscribe = (ch, cb, queries) => { const r = origSub(ch, cb, queries); inst.fire(ch, E); return r }
        try {
            window.ManifestComponentsRegistry.manifest.data.alpha.queries = [['equal', 'kind', 'x']]
            await main.loadDataSource('alpha', 'en', { reload: true })
            await settle()
        } finally {
            inst.subscribe = origSub
            ds.landRows = origLand
        }
        const subIdx = stats.timeline.findIndex(t => t.op === 'sub' && (t.queries || []).some(q => String(q).includes('kind')))
        const unsubIdx = stats.timeline.findIndex(t => t.op === 'unsub' && (t.queries || []).some(q => String(q).includes('status')))
        expect(subIdx).toBeGreaterThan(-1)
        expect(unsubIdx).toBeGreaterThan(subIdx) // new live before old detached
        expect(delivered).toBe(1) // delivered through the old subscription during the overlap
        expect(n1Lands).toBe(1)
        // replayed through the replacement subscription inside the dedupe window: absorbed
        inst.fire(CH('t1'), E)
        await settle()
        expect(delivered).toBe(2)
        expect(n1Lands).toBe(1)
        realtime().setFilter('alpha', null)
    })

    it("default 'scope': scope rides server-side, user queries stay client-side; stop-matching rows still drop live", async () => {
        const { stats, rt, rows, main, realtime } = await boot(
            { alpha: T('t1', { scope: 'user', queries: [['equal', 'status', 'active']] }) },
            { tables: { t1: [{ $id: 'a1', userId: 'u1', status: 'active' }] }, auth: authed('u1'), realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        // only the scope filter is on the subscription — the user query stays client-side
        expect(stats.subscribeArgs[0].queries.map(parse)).toEqual([
            { method: 'equal', attribute: 'userId', values: ['u1'] },
        ])
        let delivered = 0
        realtime().setFilter('alpha', () => { delivered++; return true })
        // cross-scope flood: never delivered (the billing case)
        rt().fire(CH('t1'), evt('create', { $id: 'x1', userId: 'u2', status: 'active' }))
        // in-scope stop-matching update: delivered, and the client matcher removes the row live
        rt().fire(CH('t1'), evt('update', { $id: 'a1', userId: 'u1', status: 'archived' }))
        await settle()
        expect(delivered).toBe(1)
        expect(rows('alpha')).toEqual([])
        realtime().setFilter('alpha', null)
    })

    it("serverFilter 'all': a stop-matching update is not delivered — the held row lingers until the next load", async () => {
        const { rt, rows, main } = await boot(
            { alpha: T('t1', { queries: [['equal', 'status', 'active']], realtime: { serverFilter: 'all' } }) },
            { tables: { t1: [{ $id: 'a1', status: 'active' }] }, realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        rt().fire(CH('t1'), evt('update', { $id: 'a1', status: 'archived' }))
        await settle()
        expect(rows('alpha')).toEqual(['a1']) // the documented 'all' trade: corrects on the next load
    })

    it("serverFilter true normalizes to 'all'", async () => {
        const { stats, main } = await boot(
            { alpha: T('t1', { queries: [['equal', 'status', 'active']], realtime: { serverFilter: true } }) },
            { tables: { t1: [] }, realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        expect(stats.subscribeArgs[0].queries.map(parse)).toEqual([
            { method: 'equal', attribute: 'status', values: ['active'] },
        ])
    })

    it('double teardown is idempotent and never drops a peer', async () => {
        const { rt, rows, main, realtime } = await boot(
            { beta: T('t2'), gamma: T('t2') },
            { tables: { t2: [{ $id: 'b1' }] }, realtimeQueries: true }
        )
        await main.loadDataSource('beta')
        await main.loadDataSource('gamma')
        await settle()
        const stored = realtime().subscriptions.get('beta')
        realtime().unsubscribeFromDataSource('beta')
        realtime().unsubscribeFromDataSource('beta')
        stored() // stale closure after teardown: token-guarded no-op
        await settle()
        expect(rt().liveCount(CH('t2'))).toBe(1)
        rt().fire(CH('t2'), evt('create', { $id: 'n1' }))
        await settle()
        expect(rows('gamma')).toEqual(['b1', 'n1'])
        expect(rows('beta')).toEqual(['b1'])
    })

    it('teardown during an in-flight subscribe lands nothing', async () => {
        const { rt, main, realtime, queries } = await boot(
            { alpha: T('t1') },
            { tables: { t1: [] }, realtimeQueries: true }
        )
        await main.loadDataSource('alpha')
        await settle()
        const q = queries()
        const orig = q.buildRealtimeQueries
        let release
        q.buildRealtimeQueries = (...a) => new Promise(resolve => { release = () => resolve(orig(...a)) })
        const p = realtime().subscribeToTable('late', 'db', 't9', null, () => {}, null, { queriesConfig: [['equal', 'a', 1]], mode: 'all' })
        await settle(20)
        realtime().unsubscribeFromDataSource('late') // torn down while filters resolve
        release()
        const unsub = await p
        q.buildRealtimeQueries = orig
        expect(unsub).toBe(null)
        expect(rt().liveCount(CH('t9'))).toBe(0)
        expect(realtime().subscriptions.has('late')).toBe(false)
    })

    it('an identity rebuild finishing during filter resolution lands the subscription on the active instance', async () => {
        const { stats, main, realtime, queries } = await boot(
            { alpha: T('t1') },
            { tables: { t1: [] }, auth: authed('u1'), realtimeQueries: true }
        )
        await main.loadDataSource('alpha') // keeps sources non-empty so the identity listener rebinds
        await settle()
        const q = queries()
        const orig = q.buildRealtimeQueries
        let release = null
        q.buildRealtimeQueries = (...a) => release
            ? orig(...a) // later calls (rebind, retry) resolve immediately
            : new Promise(resolve => { release = () => resolve(orig(...a)) })
        const p = realtime().subscribeToTable('beta', 'db', 't2', null, () => {}, null, { queriesConfig: [['equal', 'a', 1]], mode: 'all' })
        await settle(20) // beta is now awaiting its filter resolution
        window.dispatchEvent(new CustomEvent('manifest:auth:login')) // client memo dropped; rebind on a new instance
        await settle(100)
        release()
        const unsub = await p
        q.buildRealtimeQueries = orig
        expect(typeof unsub).toBe('function')
        expect(stats.instances.length).toBe(2)
        expect(stats.instances[0].liveCount(CH('t2'))).toBe(0) // not stranded on the dead instance
        expect(stats.instances[1].liveCount(CH('t2'))).toBe(1)
        realtime().unsubscribeFromDataSource('beta')
    })
})
