// @vitest-environment happy-dom
/**
 * Paged sources (platforms card 03, F1): `paging: "all"` walks every page into
 * the source, `paging: "window"` loads one window and `$more()` appends the
 * next. Pages are ordinary landings: realtime, $query, catch-up all apply.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { boot, release, settle } from './helpers/appwrite-data-harness.js'

const CH = 'databases.db.tables.items.rows'
let seq = 5000
const evt = (type, row) => ({ events: [`databases.db.tables.items.rows.${row.$id}.${type}`], payload: { $sequence: ++seq, ...row } })
const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${String(i + 1).padStart(6, '0')}`, n: i + 1, status: i % 2 ? 'archived' : 'active' }))
const state = () => window.Alpine.store('data')._items_state
const ns = (rows) => rows.map(r => r.n)

afterEach(release)

describe('paging: "all"', () => {
    it('walks every page into the source in order', async () => {
        const { rows, main, stats } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: 'all' } }, makeRows(2350))
        await main.loadDataSource('items')
        await settle()
        expect(ns(rows('items'))).toEqual(Array.from({ length: 2350 }, (_, i) => i + 1))
        expect(stats.lists.length).toBe(24)
        expect(state().hasMore).toBe(false)
        expect(state().total).toBe(2350)
    })

    it('stops at max and says there is more', async () => {
        const { rows, main } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'all', max: 1000, size: 250 } } }, makeRows(2350))
        await main.loadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(1000)
        expect(state().hasMore).toBe(true)
    })

    it('a limit in the queries never caps the walk', async () => {
        const { rows, main } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n'], ['limit', 10]], paging: 'all' } }, makeRows(300))
        await main.loadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(300)
    })
})

describe('paging: "window" and $more()', () => {
    const SRC = { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 50 } } }

    it('loads one window, then each $more() appends the next page until the end', async () => {
        const { rows, main } = await boot(SRC, makeRows(120))
        await main.loadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(50)
        expect(state().hasMore).toBe(true)
        expect(await main.loadMore('items')).toBe(50)
        expect(await main.loadMore('items')).toBe(20)
        await settle()
        expect(ns(rows('items'))).toEqual(Array.from({ length: 120 }, (_, i) => i + 1))
        expect(state().hasMore).toBe(false)
        expect(await main.loadMore('items')).toBe(0)
    })

    it('keeps row identity for the rows already held', async () => {
        const { rows, main } = await boot(SRC, makeRows(120))
        await main.loadDataSource('items')
        await settle()
        const first = rows('items')[0]
        await main.loadMore('items')
        await settle()
        expect(rows('items')[0]).toBe(first)
    })

    it('$query starts the new filter at its first window, and $more() continues inside it', async () => {
        const { rows, main, query } = await boot(SRC, makeRows(300))
        await main.loadDataSource('items')
        await main.loadMore('items')
        await query('items', [['equal', 'status', 'active'], ['orderAsc', 'n']])
        await settle()
        expect(rows('items').length).toBe(50)
        expect(rows('items').every(r => r.status === 'active')).toBe(true)
        expect(state().total).toBe(150)
        await main.loadMore('items')
        await settle()
        expect(rows('items').length).toBe(100)
        expect(rows('items').every(r => r.status === 'active')).toBe(true)
    })

    it('a $more() overtaken by a $query never lands', async () => {
        const delay = qs => qs.some(q => q.method === 'cursorAfter') ? 80 : 5
        const { rows, main, query } = await boot(SRC, makeRows(300), { delay })
        await main.loadDataSource('items')
        const more = main.loadMore('items')
        await query('items', [['equal', 'status', 'archived'], ['orderAsc', 'n']])
        await more
        await settle()
        expect(rows('items').length).toBe(50)
        expect(rows('items').every(r => r.status === 'archived')).toBe(true)
    })

    it('totalCapped when Appwrite caps the count', async () => {
        const { main } = await boot(SRC, makeRows(6000))
        await main.loadDataSource('items')
        await settle()
        expect(state().total).toBe(5000)
        expect(state().totalCapped).toBe(true)
    })

    it('live rows inside the loaded range land; rows past it wait for $more()', async () => {
        const table = makeRows(120)
        const { ids, main, rt } = await boot(SRC, table)
        await main.loadDataSource('items')
        await settle()
        table.push({ $id: 'inside', n: 10.5 }, { $id: 'past', n: 99.5 })
        rt().fire(CH, evt('create', { $id: 'inside', n: 10.5 }))
        rt().fire(CH, evt('create', { $id: 'past', n: 99.5 }))
        await settle()
        expect(ids('items')).toContain('inside')
        expect(ids('items')).not.toContain('past')
        await main.loadMore('items')
        await main.loadMore('items')
        await settle()
        expect(ids('items')).toContain('past')
        rt().fire(CH, evt('create', { $id: 'end', n: 500 }))
        await settle()
        expect(ids('items').at(-1)).toBe('end')
    })

    it('catch-up after reconnect keeps the rows paged in', async () => {
        const { rows, main, stats } = await boot(SRC, makeRows(300))
        await main.loadDataSource('items')
        await main.loadMore('items')
        await main.loadMore('items')
        await settle()
        expect(rows('items').length).toBe(150)
        const before = stats.lists.length
        window.dispatchEvent(new Event('online'))
        await settle(400)
        expect(stats.lists.length).toBeGreaterThan(before)
        expect(rows('items').length).toBe(150)
        expect(state().hasMore).toBe(true)
    })

    it('a source without paging has no $more()', async () => {
        const { main } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 10]] } }, makeRows(30))
        await main.loadDataSource('items')
        await expect(main.loadMore('items')).rejects.toThrow(/paging/)
    })

    it('heavy: 20000 rows, 40 windows of 100 in, 500 live updates — sorted, no repeats', async () => {
        const { rows, main, rt } = await boot(
            { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 100 } } },
            makeRows(20000)
        )
        await main.loadDataSource('items')
        const t0 = performance.now()
        for (let i = 0; i < 39; i++) await main.loadMore('items')
        for (let i = 0; i < 500; i++) rt().fire(CH, evt('update', { $id: `r${String(1 + i * 7).padStart(6, '0')}`, n: 1 + i * 7, status: 'touched' }))
        await settle(200)
        const list = rows('items')
        expect(list.length).toBe(4000)
        expect(new Set(list.map(r => r.$id)).size).toBe(4000)
        expect(ns(list)).toEqual(Array.from({ length: 4000 }, (_, i) => i + 1))
        expect(list.filter(r => r.status === 'touched').length).toBe(500)
        expect(performance.now() - t0).toBeLessThan(5000)
    })
})
