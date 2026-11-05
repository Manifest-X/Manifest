// @vitest-environment happy-dom
/**
 * $query ordering and live rows (platforms card 03, B1–B3): the last-issued read
 * wins over slower earlier ones, realtime follows the active $query (client
 * matcher and server filter), and live rows land at their sort position.
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

function match(row, q) {
    const v = row?.[q.attribute]
    const vals = q.values || []
    switch (q.method) {
        case 'equal': return vals.includes(v)
        case 'notEqual': return !vals.includes(v)
        case 'greaterThan': return v > vals[0]
        case 'lessThan': return v < vals[0]
        case 'and': return vals.every(s => match(row, s))
        case 'or': return vals.some(s => match(row, s))
        default: return true
    }
}
const PAGING = new Set(['limit', 'offset', 'cursorAfter', 'cursorBefore', 'orderAsc', 'orderDesc', 'orderRandom'])

// Appwrite mock that filters, sorts and limits like the server (25 by default);
// delay(queries) sets per-call latency; RealtimeQ is the query-capable SDK shape
function mockAppwrite(table, { delay = () => 0 } = {}) {
    const stats = { lists: [], instances: [] }
    class RealtimeQ {
        constructor() { this.pendingSubscribes = new Map(); this.subs = new Map(); this.seq = 0; stats.instances.push(this) }
        subscribe(channel, cb, queries = []) {
            const id = ++this.seq
            this.subs.set(id, { channel, cb, queries: queries.map(q => JSON.parse(q)) })
            const drop = async () => { this.subs.delete(id) }
            return Promise.resolve({ unsubscribe: drop, close: drop })
        }
        fire(channel, response) {
            for (const s of [...this.subs.values()]) {
                if (s.channel !== channel) continue
                if (s.queries.length && !s.queries.every(q => match(response.payload, q))) continue
                s.cb(response)
            }
        }
        liveQueries() { return [...this.subs.values()].map(s => s.queries) }
    }
    const Q = (m, a) => m === 'or' || m === 'and'
        ? JSON.stringify({ method: m, values: (a[0] || []).map(s => JSON.parse(s)) })
        : JSON.stringify({ method: m, attribute: a[0], ...(a.length > 1 && { values: Array.isArray(a[1]) ? a[1] : [a[1]] }) })
    window.Appwrite = {
        Client: class { setEndpoint() { return this } setProject() { return this } },
        TablesDB: class {
            async listRows({ queries = [] }) {
                const qs = queries.map(q => JSON.parse(q))
                stats.lists.push(qs)
                let rows = table.filter(r => qs.every(q => PAGING.has(q.method) || match(r, q)))
                for (const q of qs) {
                    if (q.method !== 'orderAsc' && q.method !== 'orderDesc') continue
                    const d = q.method === 'orderAsc' ? 1 : -1
                    rows = rows.slice().sort((a, b) => (a[q.attribute] > b[q.attribute] ? d : a[q.attribute] < b[q.attribute] ? -d : 0))
                }
                const lim = qs.filter(q => q.method === 'limit').pop()
                rows = rows.slice(0, lim ? (lim.values ? lim.values[0] : lim.attribute) : 25)
                const ms = delay(qs)
                if (ms) await new Promise(r => setTimeout(r, ms))
                return { rows: rows.map(r => ({ ...r })), total: rows.length }
            }
        },
        Realtime: RealtimeQ,
        Query: new Proxy({}, { get: (_, m) => (...a) => Q(m, a) }),
        Permission: { read: r => `read("${r}")` },
        Role: { user: id => `user:${id}`, team: id => `team:${id}` },
    }
    return stats
}

async function boot(dataSources, table, opts) {
    window.Alpine = Alpine
    Alpine.store('auth', { _initialized: true, isAuthenticated: false, isAnonymous: false, user: null, currentTeam: null, teams: [] })
    const stats = mockAppwrite(table, opts)
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
        rows: name => Array.from(Alpine.store('data')[name] ?? []),
        ids: name => Array.from(Alpine.store('data')[name] ?? []).map(r => r.$id),
        main: window.ManifestDataMain,
        query: (name, q) => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler(name, window.ManifestDataMain.reloadDataSource)('$query', q),
    }
}

const CH = 'databases.db.tables.items.rows'
let seq = 1000
const evt = (type, row) => ({ events: [`databases.db.tables.items.rows.${row.$id}.${type}`], payload: { $sequence: ++seq, ...row } })
const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${i + 1}`, n: i + 1, status: i % 2 ? 'archived' : 'active' }))
const isSorted = (rows, key, dir) => rows.every((r, i) => i === 0 || (dir < 0 ? rows[i - 1][key] >= r[key] : rows[i - 1][key] <= r[key]))

afterEach(() => { iso?.release(); iso = null })

describe('B1: last-issued read wins', () => {
    it('a slow earlier $query never lands over a faster later one', async () => {
        const slow = qs => qs.some(q => q.method === 'equal' && q.values?.[0] === 'archived') ? 200 : 5
        const { rows, main, query } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(40), { delay: slow })
        await main.loadDataSource('items')
        const a = query('items', [['equal', 'status', 'archived'], ['limit', 100]])
        const b = query('items', [['equal', 'status', 'active'], ['limit', 100]])
        await Promise.all([a, b])
        await settle()
        expect(new Set(rows('items').map(r => r.status))).toEqual(new Set(['active']))
    })

    it('repeating the same $query while it is in flight still lands', async () => {
        const { rows, main, query } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(10), { delay: () => 30 })
        await main.loadDataSource('items')
        const q = [['equal', 'status', 'active'], ['limit', 100]]
        await Promise.all([query('items', q), query('items', q)])
        await settle()
        expect(rows('items').length).toBe(5)
    })

    it('a default reload issued after a $query replaces it; one issued before never lands over it', async () => {
        let slowDefault = false
        const delay = qs => (slowDefault && !qs.some(q => q.method === 'equal')) ? 200 : 5
        const { rows, main, query } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(10), { delay })
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['limit', 100]])
        await main.reloadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(10)

        slowDefault = true
        const reload = main.reloadDataSource('items')
        await query('items', [['equal', 'status', 'archived'], ['limit', 100]])
        await reload
        await settle()
        expect(new Set(rows('items').map(r => r.status))).toEqual(new Set(['archived']))
    })
})

describe('B2: realtime follows the active $query', () => {
    it('a live create that matches the defaults but not the active $query never lands', async () => {
        const { ids, main, query, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(10))
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['limit', 100]])
        await settle()
        rt().fire(CH, evt('create', { $id: 'x1', n: 99, status: 'archived' }))
        rt().fire(CH, evt('create', { $id: 'x2', n: 98, status: 'active' }))
        await settle()
        expect(ids('items')).not.toContain('x1')
        expect(ids('items')).toContain('x2')
    })

    it('a held row updated out of the active $query is removed', async () => {
        const { ids, main, query, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(10))
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['limit', 100]])
        await settle()
        expect(ids('items')).toContain('r1')
        rt().fire(CH, evt('update', { $id: 'r1', n: 1, status: 'archived' }))
        await settle()
        expect(ids('items')).not.toContain('r1')
    })

    it("serverFilter 'all' re-binds the subscription to the active $query's filters", async () => {
        const { main, query, rt } = await boot(
            { items: { appwriteTableId: 'items', queries: [['equal', 'status', 'active'], ['limit', 100]], realtime: { serverFilter: 'all' } } },
            makeRows(10)
        )
        await main.loadDataSource('items')
        await settle()
        await query('items', [['equal', 'status', 'archived'], ['limit', 100]])
        await settle()
        const live = rt().liveQueries()
        expect(live.length).toBe(1)
        expect(live[0]).toEqual([{ method: 'equal', attribute: 'status', values: ['archived'] }])
    })

    it('a default reload drops the active $query again', async () => {
        const { ids, main, query, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(10))
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['limit', 100]])
        await main.reloadDataSource('items')
        await settle()
        rt().fire(CH, evt('create', { $id: 'x1', n: 99, status: 'archived' }))
        await settle()
        expect(ids('items')).toContain('x1')
    })
})

describe('B3: live rows keep the sort order', () => {
    const SRC = { items: { appwriteTableId: 'items', queries: [['orderDesc', 'n'], ['limit', 100]] } }

    it('a live create lands at its sort position, not at the end', async () => {
        const { ids, main, rt } = await boot(SRC, makeRows(10))
        await main.loadDataSource('items')
        await settle()
        rt().fire(CH, evt('create', { $id: 'top', n: 50 }))
        rt().fire(CH, evt('create', { $id: 'mid', n: 5.5 }))
        await settle()
        const list = ids('items')
        expect(list[0]).toBe('top')
        expect(list.indexOf('mid')).toBe(list.indexOf('r6') + 1)
    })

    it('an update that changes the sort key moves the row and keeps its identity', async () => {
        const { ids, rows, main, rt } = await boot(SRC, makeRows(10))
        await main.loadDataSource('items')
        await settle()
        const before = rows('items').find(r => r.$id === 'r2')
        rt().fire(CH, evt('update', { $id: 'r2', n: 100, status: 'archived' }))
        await settle()
        expect(ids('items')[0]).toBe('r2')
        expect(rows('items')[0]).toBe(before)
        expect(isSorted(rows('items'), 'n', -1)).toBe(true)
    })

    it('the order of the active $query wins over the default order', async () => {
        const { ids, main, query, rt } = await boot(SRC, makeRows(10))
        await main.loadDataSource('items')
        await query('items', [['orderAsc', 'n'], ['limit', 100]])
        await settle()
        rt().fire(CH, evt('create', { $id: 'low', n: 0 }))
        await settle()
        expect(ids('items')[0]).toBe('low')
    })

    it('unsorted sources still append at the end', async () => {
        const { ids, main, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(5))
        await main.loadDataSource('items')
        await settle()
        rt().fire(CH, evt('create', { $id: 'z', n: 0 }))
        await settle()
        expect(ids('items').at(-1)).toBe('z')
    })

    it('heavy: 5000 sorted rows stay sorted through 500 live creates and 500 sort-key updates', async () => {
        const { rows, main, rt } = await boot(
            { items: { appwriteTableId: 'items', queries: [['orderDesc', 'n'], ['limit', 5000]], realtime: { maxRows: 0 } } },
            makeRows(5000)
        )
        await main.loadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(5000)
        const t0 = performance.now()
        for (let i = 0; i < 500; i++) rt().fire(CH, evt('create', { $id: `c${i}`, n: Math.random() * 6000 }))
        for (let i = 0; i < 500; i++) rt().fire(CH, evt('update', { $id: `r${1 + i * 9}`, n: Math.random() * 6000 }))
        await settle(200)
        const ms = performance.now() - t0
        const list = rows('items')
        expect(list.length).toBe(5500)
        expect(new Set(list.map(r => r.$id)).size).toBe(5500)
        expect(isSorted(list, 'n', -1)).toBe(true)
        expect(ms).toBeLessThan(3000)
    })
})
