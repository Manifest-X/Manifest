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
// per-channel callbacks firable from tests
function mockAppwrite(tables = {}, files = {}) {
    const stats = { instances: [], subscribes: [] }
    class Realtime {
        constructor(client) { this.client = client; this.channels = new Map(); stats.instances.push(this) }
        subscribe(channel, cb) {
            stats.subscribes.push(channel)
            const set = this.channels.get(channel) || new Set()
            set.add(cb)
            this.channels.set(channel, set)
            return () => set.delete(cb)
        }
        fire(channel, response) { [...(this.channels.get(channel) || [])].forEach(cb => cb(response)) }
        liveCount(channel) { return (this.channels.get(channel) || new Set()).size }
    }
    window.Appwrite = {
        Client: class { setEndpoint() { return this } setProject() { return this } },
        TablesDB: class { async listRows({ tableId }) { return { rows: (tables[tableId] || []).map(r => ({ ...r })) } } },
        Storage: class { async listFiles(bucketId) { return { files: (files[bucketId] || []).map(f => ({ ...f })) } } },
        Realtime,
        Query: new Proxy({}, { get: (_, m) => (...a) => ({ m, a }) }),
        Permission: { read: r => `read("${r}")` },
        Role: { user: id => `user:${id}`, team: id => `team:${id}` },
    }
    return stats
}

const signedOut = () => ({ _initialized: true, isAuthenticated: false, isAnonymous: false, user: null, currentTeam: null, teams: [] })

async function boot(dataSources, { tables = {}, files = {}, auth } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', auth || signedOut())
    const stats = mockAppwrite(tables, files)
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

    it('evaluates filter operators against a row', async () => {
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
        expect(m({ a: 2 }, [['between', 'a', 1, 3]])).toBe(true)
        expect(m({ a: 4 }, [['between', 'a', 1, 3]])).toBe(false)
        expect(m({ a: null }, [['isNull', 'a']])).toBe(true)
        expect(m({}, [['isNull', 'a']])).toBe(true)
        expect(m({ a: 1 }, [['isNull', 'a']])).toBe(false)
        expect(m({ a: 1 }, [['isNotNull', 'a']])).toBe(true)
        expect(m({}, [['isNotNull', 'a']])).toBe(false)
        expect(m({ a: 'foobar' }, [['startsWith', 'a', 'foo']])).toBe(true)
        expect(m({ a: 'foobar' }, [['startsWith', 'a', 'bar']])).toBe(false)
        expect(m({ a: 'foobar' }, [['endsWith', 'a', 'bar']])).toBe(true)
        expect(m({ a: 'foobar' }, [['contains', 'a', 'oob']])).toBe(true)
        expect(m({ a: ['x', 'y'] }, [['contains', 'a', 'y']])).toBe(true)
        expect(m({ a: ['x'] }, [['contains', 'a', 'y']])).toBe(false)
        // multiple top-level queries AND together
        expect(m({ a: 1, b: 2 }, [['equal', 'a', 1], ['equal', 'b', 2]])).toBe(true)
        expect(m({ a: 1, b: 3 }, [['equal', 'a', 1], ['equal', 'b', 2]])).toBe(false)
    })

    it('nested and/or', async () => {
        const { queries } = await boot1()
        const m = (row, q) => queries().rowMatchesQueries(row, q)
        expect(m({ a: 1, b: 9 }, [['or', [['equal', 'a', 1], ['equal', 'b', 2]]]])).toBe(true)
        expect(m({ a: 0, b: 9 }, [['or', [['equal', 'a', 1], ['equal', 'b', 2]]]])).toBe(false)
        expect(m({ a: 1, b: 2 }, [['and', [['equal', 'a', 1], ['equal', 'b', 2]]]])).toBe(true)
        expect(m({ a: 1, b: 9 }, [['and', [['equal', 'a', 1], ['equal', 'b', 2]]]])).toBe(false)
        expect(m({ a: 1, b: 2, c: 'x' }, [['or', [['and', [['equal', 'a', 1], ['equal', 'b', 2]]], ['equal', 'c', 'nope']]]])).toBe(true)
    })

    it('non-filter queries are ignored; unevaluable queries match', async () => {
        const { queries } = await boot1()
        const m = (row, q) => queries().rowMatchesQueries(row, q)
        expect(m({ a: 1 }, [['limit', 5], ['offset', 2], ['orderDesc', 'a'], ['select', ['a']], ['cursorAfter', 'x']])).toBe(true)
        expect(m({ a: 1 }, [['search', 'a', 'zzz']])).toBe(true)          // search: unevaluable
        expect(m({ a: 1 }, [['someFutureOp', 'a', 'zzz']])).toBe(true)    // unknown: unevaluable
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
