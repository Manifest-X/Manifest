// @vitest-environment happy-dom
/**
 * Paged sources (platforms card 03, F1): `paging: "all"` walks every page into
 * the source, `paging: "window"` loads one window and `$more()` appends the
 * next. Pages are ordinary landings: realtime, $query, catch-up all apply.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { boot, release, settle } from './helpers/appwrite-data-harness.js'
import { budget } from './helpers/time-budget.js'

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

    it('stops at max: no more to load, $total still tells the whole count', async () => {
        const { rows, main } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'all', max: 1000, size: 250 } } }, makeRows(2350))
        await main.loadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(1000)
        expect(state().hasMore).toBe(false)
        expect(state().total).toBe(2350)
        expect(await main.loadMore('items')).toBe(0)
        expect(rows('items').length).toBe(1000)
    })

    it('window $more() never passes max', async () => {
        const { rows, main } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 40, max: 100 } } }, makeRows(300))
        await main.loadDataSource('items')
        while (await main.loadMore('items')) { /* page until stopped */ }
        await settle()
        expect(rows('items').length).toBe(100)
        expect(state().hasMore).toBe(false)
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
        expect(performance.now() - t0).toBeLessThan(budget(5000))
    })
})

describe('review: the cursor stays on server rows', () => {
    const UNSORTED = { items: { appwriteTableId: 'items', paging: { mode: 'window', size: 50 } } }
    const SORTED = { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 50 } } }
    const walk = async (main) => { while (await main.loadMore('items')) { /* next page */ } }

    it('a local $create on an unsorted paged source never cuts off the unloaded rows', async () => {
        const table = makeRows(120)
        const { rows, main, call } = await boot(UNSORTED, table)
        await main.loadDataSource('items')
        await call('items', '$create', { n: 1000, name: 'mine' })
        await settle()
        await walk(main)
        await settle()
        const ids = rows('items').map(r => r.$id)
        expect(new Set(ids).size).toBe(ids.length)
        for (let i = 1; i <= 120; i++) expect(ids).toContain(`r${String(i).padStart(6, '0')}`)
    })

    it('a local $create on a sorted paged source lands in order and $more() leaves no gap', async () => {
        const { rows, main, call } = await boot(SORTED, makeRows(120))
        await main.loadDataSource('items')
        await call('items', '$create', { n: 10.5 })
        await settle()
        expect(rows('items').findIndex(r => r.n === 10.5)).toBe(10)
        await walk(main)
        await settle()
        expect(ns(rows('items'))).toEqual([...Array.from({ length: 10 }, (_, i) => i + 1), 10.5, ...Array.from({ length: 110 }, (_, i) => i + 11)])
    })

    it('a $query issued before $more() lands first: $more() continues inside the new filter', async () => {
        const delay = qs => qs.some(q => q.method === 'equal') ? 5 : 40
        const { rows, main, query } = await boot(SORTED, makeRows(300), { delay })
        await main.loadDataSource('items')
        const q = query('items', [['equal', 'status', 'archived'], ['orderAsc', 'n']])
        const more = main.loadMore('items')
        await Promise.all([q, more])
        await settle(150)
        expect(rows('items').every(r => r.status === 'archived')).toBe(true)
    })

    it('$more() while a reload is in flight waits for it: no gap', async () => {
        const delay = qs => qs.some(q => q.method === 'cursorAfter') ? 5 : 60
        const { rows, main } = await boot(SORTED, makeRows(300), { delay })
        await main.loadDataSource('items')
        await main.loadMore('items')
        await settle()
        const reload = main.reloadDataSource('items')
        await main.loadMore('items')
        await reload
        await settle(200)
        const list = ns(rows('items'))
        expect(list).toEqual(Array.from({ length: list.length }, (_, i) => i + 1))
    })

    it('a held row updated past the loaded end leaves, and every row stays reachable', async () => {
        const table = makeRows(200)
        const { rows, main, rt } = await boot(SORTED, table)
        await main.loadDataSource('items')
        await settle()
        table[4].n = 1000
        rt().fire(CH, evt('update', { ...table[4] }))
        await settle()
        expect(rows('items').some(r => r.$id === table[4].$id)).toBe(false)
        await walk(main)
        await settle()
        expect(rows('items').length).toBe(200)
        expect(rows('items').at(-1).$id).toBe(table[4].$id)
    })

    it('a live row that ties with the last loaded row is never lost or repeated', async () => {
        const table = Array.from({ length: 80 }, (_, i) => ({ $id: `t${String(i).padStart(3, '0')}`, n: i < 40 ? i : 40 }))
        const { rows, main, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 45 } } }, table)
        await main.loadDataSource('items')
        await settle()
        const live = { $id: 't999', n: 40 }
        table.push(live)
        rt().fire(CH, evt('create', live))
        await settle()
        await walk(main)
        await settle()
        expect(new Set(rows('items').map(r => r.$id)).size).toBe(81)
    })
})

describe('review 2: ties, local rows past the boundary, overtaken $more()', () => {
    it('a live update to a held row that ties with the boundary keeps it (its sort value did not move)', async () => {
        const table = Array.from({ length: 60 }, (_, i) => ({ $id: `k${String(i).padStart(3, '0')}`, k: 1, name: `n${i}` }))
        const { rows, main, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'k']], paging: { mode: 'window', size: 50 } } }, table)
        await main.loadDataSource('items')
        await settle()
        rt().fire(CH, evt('update', { ...table[10], name: 'renamed' }))
        await settle()
        expect(rows('items').find(r => r.$id === 'k010')?.name).toBe('renamed')
        while (await main.loadMore('items')) { /* rest */ }
        await settle()
        expect(new Set(rows('items').map(r => r.$id)).size).toBe(60)
    })

    it('tied live rows land now, wherever the server places them, and paging never repeats them', async () => {
        const table = Array.from({ length: 60 }, (_, i) => ({ $id: `k${String(i).padStart(3, '0')}`, k: 1, $sequence: (i + 1) * 10 }))
        const { ids, main, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'k']], paging: { mode: 'window', size: 50 } } }, table)
        await main.loadDataSource('items')
        await settle()
        const early = { $id: 'early', k: 1, $sequence: 15 }
        const late = { $id: 'late', k: 1, $sequence: 9999 }
        table.push(early, late)
        rt().fire(CH, evt('update', early)) // matches now, not held
        rt().fire(CH, evt('create', late))
        await settle()
        expect(ids('items')).toContain('early')
        expect(ids('items')).toContain('late')
        while (await main.loadMore('items')) { /* rest */ }
        await settle()
        expect(new Set(ids('items')).size).toBe(62)
        expect(ids('items').length).toBe(62)
    })

    it('a local create past the boundary, then $more(): the list stays in order', async () => {
        const { rows, main, call } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 50 } } }, makeRows(200))
        await main.loadDataSource('items')
        await call('items', '$create', { n: 150.5 })
        await settle()
        while (await main.loadMore('items')) { /* rest */ }
        await settle()
        const list = ns(rows('items'))
        expect(list.length).toBe(201)
        expect(list).toEqual([...list].sort((a, b) => a - b))
    })

    it('a $more() overtaken mid-fetch runs again after the newer window lands', async () => {
        const delay = qs => qs.some(q => q.method === 'cursorAfter') ? 60 : 5
        const { rows, main } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 50 } } }, makeRows(300), { delay })
        await main.loadDataSource('items')
        const more = main.loadMore('items')
        await settle(10)
        await main.reloadDataSource('items')
        await more
        await settle(300)
        expect(rows('items').length).toBe(100)
    })
})
