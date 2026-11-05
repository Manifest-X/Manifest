// Appwrite data-plugin harness: the data subscripts in a vm context against a
// mock SDK that filters, sorts, pages and echoes writes like the server
import { readFileSync } from 'fs'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { isolateVm } from './vm-isolation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, '../../src/scripts/data')
const SUBSCRIPTS = [
    'core/manifest.data.config.js',
    'core/manifest.data.api.js',
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
    'shared/manifest.data.proxies.magic.pagination.js',
    'shared/manifest.data.main.js',
    'appwrite/manifest.data.appwrite.js',
    'appwrite/manifest.data.realtime.js',
    'appwrite/manifest.data.pagination.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

export const settle = (ms = 60) => new Promise(r => setTimeout(r, ms))
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
// Options: delay(queries) per list call; writeDelay ms per write; echoFirst: the
// realtime echo of a write fires before the HTTP reply (as Appwrite usually does)
function mockAppwrite(table, { delay = () => 0, writeDelay = 0, echoFirst = true } = {}) {
    const stats = { lists: [], instances: [], writes: [], failWrites: false }
    const channel = 'databases.db.tables.items.rows'
    const echo = (type, row) => {
        const rt = stats.instances[stats.instances.length - 1]
        rt?.fire(channel, { events: [`databases.db.tables.items.rows.${row.$id}.${type}`], payload: { ...row, $sequence: Date.now() + Math.random() } })
    }
    const wait = () => writeDelay ? new Promise(r => setTimeout(r, writeDelay)) : Promise.resolve()
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
                    const key = r => (typeof r[q.attribute] === 'string' ? r[q.attribute].toLowerCase() : r[q.attribute])
                    rows = rows.slice().sort((a, b) => (key(a) > key(b) ? d : key(a) < key(b) ? -d : 0))
                }
                const total = rows.length
                const arg = q => (q.values ? q.values[0] : q.attribute)
                const lim = qs.filter(q => q.method === 'limit').pop()
                const n = lim ? arg(lim) : 25
                const off = qs.find(q => q.method === 'offset')
                const after = qs.find(q => q.method === 'cursorAfter')
                const before = qs.find(q => q.method === 'cursorBefore')
                if (before) {
                    const end = rows.findIndex(r => r.$id === arg(before))
                    rows = rows.slice(Math.max(0, end - n), end)
                } else {
                    // Appwrite refuses a cursor row that no longer matches / exists
                    if (after && !rows.some(r => r.$id === arg(after))) throw Object.assign(new Error(`Document with the requested ID '${arg(after)}' could not be found.`), { code: 400 })
                    if (n > 5000) throw Object.assign(new Error('Invalid limit'), { code: 400 })
                    const start = after ? rows.findIndex(r => r.$id === arg(after)) + 1 : (off ? arg(off) : 0)
                    rows = rows.slice(start, start + n)
                }
                const ms = delay(qs)
                if (ms) await new Promise(r => setTimeout(r, ms))
                return { rows: rows.map(r => ({ ...r })), total: Math.min(total, 5000) }
            }
            async createRow({ rowId, data }) {
                stats.writes.push(['create', rowId])
                const row = { ...data, $id: rowId || `srv${stats.writes.length}` }
                if (stats.failWrites) { await wait(); throw Object.assign(new Error('mock fail'), { code: 500 }) }
                // echoFirst: committed and announced before the reply; otherwise committed at the reply
                if (echoFirst) { table.push(row); echo('create', row) }
                await wait()
                if (!echoFirst) { table.push(row); setTimeout(() => echo('create', row), 0) }
                return { ...row }
            }
            async updateRow({ rowId, data }) {
                stats.writes.push(['update', rowId, data])
                await (typeof writeDelay === 'function' ? new Promise(r => setTimeout(r, writeDelay(rowId, data))) : wait())
                if (stats.failWrites) throw Object.assign(new Error('mock fail'), { code: 500 })
                const row = table.find(r => r.$id === rowId)
                if (!row) throw Object.assign(new Error('not found'), { code: 404 })
                Object.assign(row, data)
                return { ...row }
            }
            async deleteRow({ rowId }) {
                stats.writes.push(['delete', rowId])
                await wait()
                if (stats.failWrites) throw Object.assign(new Error('mock fail'), { code: 500 })
                const i = table.findIndex(r => r.$id === rowId)
                if (i !== -1) table.splice(i, 1)
                return {}
            }
        },
        Realtime: RealtimeQ,
        Query: new Proxy({}, { get: (_, m) => (...a) => Q(m, a) }),
        ID: { unique: () => `id${Math.random().toString(36).slice(2, 10)}` },
        Permission: { read: r => `read("${r}")` },
        Role: { user: id => `user:${id}`, team: id => `team:${id}` },
    }
    return stats
}

export async function boot(dataSources, table, opts) {
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
    // document listeners (visibilitychange) are released with the rest
    const docListeners = []
    const docAdd = document.addEventListener
    document.addEventListener = function (type, fn, opts) { docListeners.push([type, fn, opts]); return docAdd.call(this, type, fn, opts) }
    const winRelease = iso.release
    iso.release = () => {
        winRelease()
        document.addEventListener = docAdd
        docListeners.splice(0).forEach(([type, fn, opts]) => document.removeEventListener(type, fn, opts))
    }
    const ctx = {
        window, document, Alpine, console, ...iso.timers, clearTimeout, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        File: window.File, Blob: window.Blob, URL, Date, fetch: (...a) => window.fetch(...a),
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
        call: (name, method, ...args) => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler(name, window.ManifestDataMain.reloadDataSource)(method, ...args),
        page: (name, method, ...args) => window.ManifestDataProxiesMagic.createPaginationMethod(method, name)(...args),
    }
}


export function release() { iso?.release(); iso = null }
