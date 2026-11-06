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
