// @vitest-environment happy-dom
/**
 * $query ordering and live rows (platforms card 03, B1–B3): the last-issued read
 * wins over slower earlier ones, realtime follows the active $query (client
 * matcher and server filter), and live rows land at their sort position.
 */
import { describe, it, expect, afterEach } from 'vitest'

import { boot, release, settle } from './helpers/appwrite-data-harness.js'

const CH = 'databases.db.tables.items.rows'
let seq = 1000
const evt = (type, row) => ({ events: [`databases.db.tables.items.rows.${row.$id}.${type}`], payload: { $sequence: ++seq, ...row } })
const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${i + 1}`, n: i + 1, status: i % 2 ? 'archived' : 'active' }))
const isSorted = (rows, key, dir) => rows.every((r, i) => i === 0 || (dir < 0 ? rows[i - 1][key] >= r[key] : rows[i - 1][key] <= r[key]))

afterEach(release)

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

describe('review follow-ups', () => {
    it('a first load overtaken by $query still subscribes to realtime (x-init $query pattern)', async () => {
        const delay = qs => qs.some(q => q.method === 'equal') ? 5 : 100
        const { ids, main, query, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(10), { delay })
        const load = main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['limit', 100]])
        await load
        await settle()
        expect(ids('items').length).toBe(5)
        expect(rt().subs.size).toBe(1)
        rt().fire(CH, evt('create', { $id: 'live', n: 50, status: 'active' }))
        rt().fire(CH, evt('create', { $id: 'nope', n: 51, status: 'archived' }))
        await settle()
        expect(ids('items')).toContain('live')
        expect(ids('items')).not.toContain('nope')
    })

    it('string sort keys compare case-insensitively, like Appwrite', async () => {
        const table = [{ $id: 'a', name: 'alpha' }, { $id: 'c', name: 'charlie' }]
        const { ids, main, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'name'], ['limit', 100]] } }, table)
        await main.loadDataSource('items')
        await settle()
        rt().fire(CH, evt('create', { $id: 'b', name: 'Bravo' }))
        await settle()
        expect(ids('items')).toEqual(['a', 'b', 'c'])
    })

    it('an update that leaves the sort value alone never moves the row', async () => {
        const table = [{ $id: 'a', name: 'alpha', n: 1 }, { $id: 'b', name: 'Bravo', n: 2 }, { $id: 'c', name: 'charlie', n: 3 }]
        const { ids, main, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['orderAsc', 'name'], ['limit', 100]] } }, table)
        await main.loadDataSource('items')
        await settle()
        rt().fire(CH, evt('update', { $id: 'a', name: 'alpha', n: 9 }))
        await settle()
        expect(ids('items')).toEqual(['a', 'b', 'c'])
    })

    it('a reload that joins an in-flight load makes it the latest read again', async () => {
        const delay = qs => qs.some(q => q.method === 'equal') ? 5 : 80
        const { rows, main, query } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(10), { delay })
        await main.loadDataSource('items')
        const first = main.reloadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['limit', 100]])
        const joined = main.reloadDataSource('items')
        await Promise.all([first, joined])
        await settle()
        expect(rows('items').length).toBe(10)
    })

    it('a source reset forgets its active $query', async () => {
        const { main, query } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', 100]] } }, makeRows(10))
        await main.loadDataSource('items')
        await query('items', [['equal', 'status', 'active'], ['limit', 100]])
        expect(main.getActiveQuery('items')).not.toBe(null)
        window.ManifestDataStore.resetSource('items')
        expect(main.getActiveQuery('items')).toBe(null)
    })
})

describe('realtime caps follow the rows a default reload lands', () => {
    for (const mode of ['window', 'append']) {
        it(`${mode} mode: $query, then a default reload, then live creates land`, async () => {
            const realtime = mode === 'window' ? { mode: 'window' } : {}
            const n = mode === 'window' ? 20 : 600
            const { ids, main, query, rt } = await boot({ items: { appwriteTableId: 'items', queries: [['limit', n]], realtime } }, makeRows(mode === 'window' ? 10 : 600))
            await main.loadDataSource('items')
            await query('items', [['equal', 'n', 1], ['limit', 2]])
            await main.reloadDataSource('items')
            await settle()
            rt().fire(CH, evt('create', { $id: 'after', n: 9999, status: 'active' }))
            await settle()
            expect(ids('items')).toContain('after')
            expect(window.Alpine.store('data')._items_state.realtimeOverflow || 0).toBe(0)
        })
    }
})
