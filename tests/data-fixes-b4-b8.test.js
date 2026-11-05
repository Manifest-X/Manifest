// @vitest-environment happy-dom
/**
 * Data-layer fixes from platforms card 03: create + realtime echo never
 * duplicates a row (B4), batch $update takes ids with shared data (B5), live
 * sources catch up after reconnect or wake (B6), paging follows the active
 * $query with honest hasMore (B7), relative API urls resolve (B8).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { boot, release, settle } from './helpers/appwrite-data-harness.js'

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${String(i + 1).padStart(5, '0')}`, n: i + 1, status: i % 2 ? 'archived' : 'active' }))
const SRC = { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n'], ['limit', 100]] } }

afterEach(release)

describe('B4: optimistic create and its realtime echo', () => {
    for (const echoFirst of [true, false]) {
        it(`one row per $id when the echo lands ${echoFirst ? 'before' : 'after'} the HTTP reply`, async () => {
            const { rows, main, call } = await boot(SRC, makeRows(5), { writeDelay: 40, echoFirst })
            await main.loadDataSource('items')
            await settle()
            const created = await call('items', '$create', { n: 99, name: 'new' })
            await settle(100)
            const matches = rows('items').filter(r => r.name === 'new')
            expect(matches.length).toBe(1)
            expect(matches[0].$id).toBe(created.$id)
            expect(rows('items').some(r => String(r.$id).startsWith('temp_'))).toBe(false)
        })
    }

    it('heavy: 200 concurrent creates into 5000 rows leave no duplicates', async () => {
        const { rows, main, call } = await boot(
            { items: { appwriteTableId: 'items', queries: [['limit', 5000]], realtime: { maxRows: 0 } } },
            makeRows(5000), { writeDelay: 20 }
        )
        await main.loadDataSource('items')
        await settle()
        await Promise.all(Array.from({ length: 200 }, (_, i) => call('items', '$create', { n: 10000 + i })))
        await settle(200)
        const ids = rows('items').map(r => r.$id)
        expect(ids.length).toBe(5200)
        expect(new Set(ids).size).toBe(5200)
    })
})

describe('B5: batch $update', () => {
    it('ids with shared data (the documented form)', async () => {
        const { rows, main, call, stats } = await boot(SRC, makeRows(5))
        await main.loadDataSource('items')
        await call('items', '$update', ['r00001', 'r00002'], { status: 'done' })
        await settle()
        expect(stats.writes.filter(w => w[0] === 'update').map(w => [w[1], w[2].status])).toEqual([['r00001', 'done'], ['r00002', 'done']])
        expect(rows('items').filter(r => r.status === 'done').map(r => r.$id)).toEqual(['r00001', 'r00002'])
    })

    it('[{ id, data }] entries still work', async () => {
        const { main, call, stats } = await boot(SRC, makeRows(5))
        await main.loadDataSource('items')
        await call('items', '$update', [{ id: 'r00003', data: { status: 'a' } }, { $id: 'r00004', data: { status: 'b' } }])
        expect(stats.writes.map(w => [w[1], w[2].status])).toEqual([['r00003', 'a'], ['r00004', 'b']])
    })

    it('an id with no data is refused before any write', async () => {
        const { main, call, stats } = await boot(SRC, makeRows(5))
        await main.loadDataSource('items')
        await expect(call('items', '$update', ['r00001'])).rejects.toThrow(/id and data/)
        expect(stats.writes.length).toBe(0)
    })
})

describe('B6: catch-up after reconnect or wake', () => {
    it('going back online refetches live sources, keeping the active $query', async () => {
        const table = makeRows(10)
        const { rows, main, query, stats } = await boot(SRC, table)
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['limit', 100]])
        await settle()
        table.push({ $id: 'missed', n: 0, status: 'active' }, { $id: 'missed2', n: 0, status: 'archived' })
        const before = stats.lists.length
        window.dispatchEvent(new Event('online'))
        await settle(400)
        expect(stats.lists.length).toBe(before + 1)
        const ids = rows('items').map(r => r.$id)
        expect(ids).toContain('missed')
        expect(ids).not.toContain('missed2')
    })

    it('a short tab switch does not refetch', async () => {
        const { main, stats } = await boot(SRC, makeRows(10))
        await main.loadDataSource('items')
        await settle()
        const before = stats.lists.length
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        document.dispatchEvent(new Event('visibilitychange'))
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
        document.dispatchEvent(new Event('visibilitychange'))
        await settle(400)
        expect(stats.lists.length).toBe(before)
        delete document.hidden
    })
})

describe('B7: paging', () => {
    it('pages follow the active $query and send a single limit', async () => {
        const { main, query, page, stats } = await boot(SRC, makeRows(40))
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['orderAsc', 'n'], ['limit', 100]])
        const first = await page('items', '$first', 5)
        expect(first.items.every(r => r.status === 'active')).toBe(true)
        const sent = stats.lists.at(-1)
        expect(sent.filter(q => q.method === 'limit').length).toBe(1)
        expect(first.total).toBe(20)
    })

    it('hasMore is exact on the last page, and walking pages covers every row once', async () => {
        const { main, page } = await boot(SRC, makeRows(30))
        await main.loadDataSource('items')
        let p = await page('items', '$first', 10)
        const seen = [...p.items.map(r => r.$id)]
        let pages = 1
        while (p.hasMore) { p = await page('items', '$next', p.cursor, 10); seen.push(...p.items.map(r => r.$id)); pages++ }
        expect(pages).toBe(3)
        expect(new Set(seen).size).toBe(30)
    })

    it('$prev reports whether earlier rows exist', async () => {
        const { main, page } = await boot(SRC, makeRows(30))
        await main.loadDataSource('items')
        const second = await page('items', '$page', 2, 10)
        const back = await page('items', '$prev', second.items[0].$id, 10)
        expect(back.items.map(r => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        expect(back.hasMore).toBe(false)
        const third = await page('items', '$page', 3, 10)
        const mid = await page('items', '$prev', third.items[0].$id, 10)
        expect(mid.items[0].n).toBe(11)
        expect(mid.hasMore).toBe(true)
    })

    it('$page reports hasMore and totalPages', async () => {
        const { main, page } = await boot(SRC, makeRows(25))
        await main.loadDataSource('items')
        const last = await page('items', '$page', 3, 10)
        expect(last.items.length).toBe(5)
        expect(last.totalPages).toBe(3)
        expect(last.hasMore).toBe(false)
    })

    it('heavy: 5000 rows walk in 50 pages of 100 with no gaps or repeats', async () => {
        const { main, page } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']] } }, makeRows(5000))
        await main.loadDataSource('items')
        let p = await page('items', '$first', 100)
        const seen = [...p.items]
        let pages = 1
        while (p.hasMore) { p = await page('items', '$next', p.cursor, 100); seen.push(...p.items); pages++ }
        expect(pages).toBe(50)
        expect(seen.map(r => r.n)).toEqual(Array.from({ length: 5000 }, (_, i) => i + 1))
    })
})

describe('B8: relative API urls', () => {
    it('resolve against the page', async () => {
        const calls = []
        const realFetch = globalThis.fetch
        globalThis.fetch = window.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => [{ id: 1 }] } }
        try {
            const { rows, main } = await boot({ api: { url: '/api/rows?limit=5' } }, [])
            await main.loadDataSource('api')
            await settle()
            expect(calls[0]).toBe(new URL('/api/rows?limit=5', window.location.href).href)
            expect(rows('api').length).toBe(1)
        } finally {
            globalThis.fetch = window.fetch = realFetch
        }
    })
})
