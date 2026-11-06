// @vitest-environment happy-dom
/**
 * Load retry and $reload() (platforms card 03, F5): transient failures retry with
 * backoff before $error shows; client errors fail at once; `retry` configures it;
 * $reload() fetches again what the source shows; $query reports $loading and
 * waits for auth instead of throwing.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { boot, release, settle } from './helpers/appwrite-data-harness.js'

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${i + 1}`, n: i + 1, status: i % 2 ? 'archived' : 'active' }))
const fast = (extra = {}) => ({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n'], ['limit', 100]], retry: { attempts: 3, delay: 5 }, ...extra } })
const state = () => window.Alpine.store('data')._items_state
const x = () => window.Alpine.evaluate(document.body, '$x')

afterEach(release)

describe('retry', () => {
    it('a transient failure retries and the rows land with no $error', async () => {
        const { rows, main, stats } = await boot(fast(), makeRows(10))
        stats.failReads = 2
        await main.loadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(10)
        expect(state().error).toBe(null)
        expect(stats.lists.filter(l => l === 'failed').length).toBe(2)
    })

    it('gives up after the configured attempts and shows $error', async () => {
        const { main, stats } = await boot(fast(), makeRows(10))
        stats.failReads = 10
        await main.loadDataSource('items')
        await settle()
        expect(state().error).toBeTruthy()
        expect(stats.lists.length).toBe(4)
    })

    it('a client error (403) fails at once', async () => {
        const { main, stats } = await boot(fast(), makeRows(10))
        stats.failReads = 1
        stats.failError = { code: 403, message: 'Forbidden' }
        await main.loadDataSource('items')
        await settle()
        expect(state().error).toBeTruthy()
        expect(stats.lists.length).toBe(1)
    })

    it('retry: false turns it off', async () => {
        const { main, stats } = await boot(fast({ retry: false }), makeRows(10))
        stats.failReads = 1
        await main.loadDataSource('items')
        await settle()
        expect(state().error).toBeTruthy()
        expect(stats.lists.length).toBe(1)
    })

    it('paged sources retry each page', async () => {
        const { rows, main, stats } = await boot(fast({ paging: { mode: 'all', size: 1000 } }), makeRows(5000))
        await main.loadDataSource('items')
        stats.failReads = 1
        await main.reloadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(5000)
        expect(state().error).toBe(null)
    })

    it('$query retries transient failures too', async () => {
        const { rows, main, query, stats } = await boot(fast(), makeRows(10))
        await main.loadDataSource('items')
        stats.failReads = 1
        await query('items', [['equal', 'status', 'active'], ['orderAsc', 'n']])
        await settle()
        expect(rows('items').length).toBe(5)
    })
})

describe('$reload()', () => {
    it('fetches the default load again and merges by $id', async () => {
        const table = makeRows(10)
        const { rows, main } = await boot(fast(), table)
        await main.loadDataSource('items')
        await settle()
        const first = rows('items')[0]
        table.push({ $id: 'new', n: 11, status: 'active' })
        await x().items.$reload()
        await settle()
        expect(rows('items').length).toBe(11)
        expect(rows('items')[0]).toBe(first)
    })

    it('keeps the active $query', async () => {
        const table = makeRows(10)
        const { rows, main, query } = await boot(fast(), table)
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['orderAsc', 'n']])
        table.push({ $id: 'new', n: 11, status: 'active' }, { $id: 'nope', n: 12, status: 'archived' })
        await x().items.$reload()
        await settle()
        expect(rows('items').map(r => r.$id)).toContain('new')
        expect(rows('items').map(r => r.$id)).not.toContain('nope')
    })

    it('a paged source keeps the rows it holds', async () => {
        const { rows, main } = await boot(fast({ paging: { mode: 'window', size: 50 } }), makeRows(300))
        await main.loadDataSource('items')
        await main.loadMore('items')
        await settle()
        await x().items.$reload()
        await settle()
        expect(rows('items').length).toBe(100)
    })
})

describe('$query state', () => {
    it('sets $loading while it runs', async () => {
        const { main, query } = await boot(fast(), makeRows(10), { delay: () => 60 })
        await main.loadDataSource('items')
        const run = query('items', [['equal', 'status', 'active']])
        await settle(20)
        expect(state().loading).toBe(true)
        await run
        expect(state().loading).toBe(false)
    })

    it('waits for auth instead of throwing when a $auth. value is not ready', async () => {
        const { rows, main, query, stats } = await boot(fast(), makeRows(10))
        await main.loadDataSource('items')
        window.Alpine.store('auth', { _initialized: false, isAuthenticated: false, user: null, teams: [] })
        const run = query('items', [['equal', 'status', '$auth.user.$id']])
        await settle(30)
        Object.assign(window.Alpine.store('auth'), { _initialized: true, isAuthenticated: true, user: { $id: 'active' }, userId: 'active' })
        window.dispatchEvent(new CustomEvent('manifest:auth:initialized'))
        await run
        await settle()
        expect(rows('items').every(r => r.status === 'active')).toBe(true)
    })
})

describe('review: identity switches and edge cases', () => {
    const signIn = (id, extra = {}) => {
        Object.assign(window.Alpine.store('auth'), { _initialized: true, isAuthenticated: true, user: { $id: id }, userId: id, teams: [], currentTeam: null, ...extra })
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
    }

    it('A to B while a $query waits for auth: the source resets and reads again for B', async () => {
        const { main, query, stats } = await boot(fast(), makeRows(10))
        signIn('A')
        await settle(100)
        await main.loadDataSource('items')
        await settle()
        const gen = window.ManifestDataStore.sourceGeneration('items')
        const waiting = query('items', [['equal', 'status', '$auth.currentTeam.$id']]).catch(() => {})
        await settle(20)
        const before = stats.lists.length
        signIn('B')
        await settle(150)
        expect(window.ManifestDataStore.sourceGeneration('items')).toBeGreaterThan(gen)
        expect(stats.lists.slice(before).some(l => Array.isArray(l) && !l.some(q => q.method === 'equal'))).toBe(true)
        await waiting
    })

    it('A to B with an active $query: B gets the default rows and stays live', async () => {
        const { ids, main, query, rt } = await boot(fast(), makeRows(10))
        signIn('A')
        await settle(100)
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['orderAsc', 'n']])
        await settle()
        signIn('B')
        await settle(200)
        expect(ids('items').length).toBe(10)
        expect(main.getActiveQuery('items')).toBe(null)
        rt().fire('databases.db.tables.items.rows', { events: ['databases.db.tables.items.rows.live.create'], payload: { $id: 'live', n: 99, status: 'archived', $sequence: 999 } })
        await settle()
        expect(ids('items')).toContain('live')
    })

    it('two identical $query calls still retry a transient failure', async () => {
        const { rows, main, query, stats } = await boot(fast(), makeRows(10))
        await main.loadDataSource('items')
        stats.failReads = 1
        const q = [['equal', 'status', 'active'], ['orderAsc', 'n']]
        const results = await Promise.allSettled([query('items', q), query('items', q)])
        await settle()
        expect(results.every(r => r.status === 'fulfilled')).toBe(true)
        expect(rows('items').length).toBe(5)
    })

    it('a failed $query is not re-run by a later sign-in', async () => {
        const { rows, main, query, stats } = await boot(fast(), makeRows(10))
        await main.loadDataSource('items')
        stats.failReads = 1
        stats.failError = { code: 403, message: 'Forbidden' }
        await query('items', [['equal', 'status', 'active']]).catch(() => {})
        signIn('A')
        await settle(200)
        expect(rows('items').length).toBe(10)
    })
})

describe('review: API sources', () => {
    it('retry an HTTP 503 and land', async () => {
        let n = 0
        const realFetch = globalThis.fetch
        globalThis.fetch = window.fetch = async () => (++n < 3
            ? { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) }
            : { ok: true, status: 200, json: async () => [{ id: 1 }, { id: 2 }] })
        try {
            const { rows, main } = await boot({ api: { url: '/api/rows', retry: { attempts: 3, delay: 5 } } }, [])
            await main.loadDataSource('api')
            await settle()
            expect(n).toBe(3)
            expect(rows('api').length).toBe(2)
            expect(window.Alpine.store('data')._api_state.error).toBe(null)
        } finally {
            globalThis.fetch = window.fetch = realFetch
        }
    })

    it('a 404 fails at once', async () => {
        let n = 0
        const realFetch = globalThis.fetch
        globalThis.fetch = window.fetch = async () => { n++; return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } }
        try {
            const { main } = await boot({ api: { url: '/api/rows', retry: { attempts: 3, delay: 5 } } }, [])
            await main.loadDataSource('api')
            await settle()
            expect(n).toBe(1)
        } finally {
            globalThis.fetch = window.fetch = realFetch
        }
    })
})
