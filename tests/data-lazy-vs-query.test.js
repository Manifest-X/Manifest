// @vitest-environment happy-dom
/**
 * A source's first, lazy load never replaces rows an explicit $query asked for:
 * a component that calls $query on open, while the template's first read starts
 * the default load, shows the $query's rows.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { boot, release, settle } from './helpers/appwrite-data-harness.js'

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${i + 1}`, n: i + 1, projectId: i % 2 ? 'p2' : 'p1' }))
const slowDefault = qs => qs.some(q => q.method === 'equal') ? 5 : 80

afterEach(release)

for (const paging of [null, { mode: 'window', size: 100 }]) {
    describe(`lazy load vs $query (${paging ? 'paged' : 'unpaged'})`, () => {
        const SRC = { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n'], ['limit', 100]], ...(paging ? { paging } : {}) } }

        it('$query first, lazy default load second (slower): the $query rows stand', async () => {
            const { rows, main, query } = await boot(SRC, makeRows(20), { delay: slowDefault })
            const q = query('items', [['equal', 'projectId', 'p1'], ['orderAsc', 'n']])
            const lazy = main.loadDataSource('items')
            await Promise.all([q, lazy])
            await settle(150)
            expect(rows('items').length).toBe(10)
            expect(rows('items').every(r => r.projectId === 'p1')).toBe(true)
        })

        it('lazy default load first, $query second: the $query rows stand', async () => {
            const { rows, main, query } = await boot(SRC, makeRows(20), { delay: slowDefault })
            const lazy = main.loadDataSource('items')
            const q = query('items', [['equal', 'projectId', 'p1'], ['orderAsc', 'n']])
            await Promise.all([q, lazy])
            await settle(150)
            expect(rows('items').every(r => r.projectId === 'p1')).toBe(true)
        })

        it('the source still goes live after the lazy load is skipped', async () => {
            const { ids, main, query, rt } = await boot(SRC, makeRows(20), { delay: slowDefault })
            const q = query('items', [['equal', 'projectId', 'p1'], ['orderAsc', 'n']])
            await Promise.all([q, main.loadDataSource('items')])
            await settle(150)
            rt().fire('databases.db.tables.items.rows', { events: ['databases.db.tables.items.rows.new.create'], payload: { $id: 'new', n: 0.5, projectId: 'p1', $sequence: 999 } })
            rt().fire('databases.db.tables.items.rows', { events: ['databases.db.tables.items.rows.other.create'], payload: { $id: 'other', n: 0.6, projectId: 'p2', $sequence: 1000 } })
            await settle()
            expect(ids('items')).toContain('new')
            expect(ids('items')).not.toContain('other')
        })

        it('an explicit reload still brings the defaults back', async () => {
            const { rows, main, query } = await boot(SRC, makeRows(20))
            await query('items', [['equal', 'projectId', 'p1'], ['orderAsc', 'n']])
            await main.reloadDataSource('items')
            await settle()
            expect(rows('items').length).toBe(20)
        })
    })
}

describe('review: paths that clear the rows and load without reload', () => {
    const SRC = { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n'], ['limit', 100]] } }
    const state = () => window.Alpine.store('data')._items_state

    it('a locale change after a $query lands the defaults (never an empty source)', async () => {
        const { rows, main, query } = await boot(SRC, makeRows(20))
        await main.loadDataSource('items')
        await query('items', [['equal', 'projectId', 'p1']])
        await settle()
        window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: 'fr' } }))
        await settle(300)
        expect(rows('items').length).toBe(20)
        expect(state().ready).toBe(true)
    })

    it('a team-style clear-and-load after a $query lands the defaults', async () => {
        const { rows, main, query } = await boot(SRC, makeRows(20))
        await main.loadDataSource('items')
        await query('items', [['equal', 'projectId', 'p1']])
        await settle()
        window.ManifestDataStore.dataSourceCache.clear()
        delete window.Alpine.store('data').items
        await main.loadDataSource('items')
        await settle(200)
        expect(rows('items').length).toBe(20)
        expect(state().ready).toBe(true)
    })

    it('a failed $query while the lazy load deferred: the defaults land', async () => {
        const { rows, main, query, stats } = await boot(SRC, makeRows(20), { delay: () => 40 })
        stats.failReads = 1
        stats.failError = { code: 400, message: 'bad' }
        const q = query('items', [['equal', 'projectId', 'p1']]).catch(() => 'failed')
        const lazy = main.loadDataSource('items')
        expect(await q).toBe('failed')
        await lazy
        await settle(200)
        expect(rows('items').length).toBe(20)
        expect(state().ready).toBe(true)
    })

    it('the memory-cache path never lands cached defaults over a showing $query', async () => {
        const { rows, main, query } = await boot(SRC, makeRows(20))
        await main.loadDataSource('items')
        await query('items', [['equal', 'projectId', 'p1']])
        await settle()
        await main.loadDataSource('items')
        await settle()
        expect(rows('items').length).toBe(10)
    })

    it('an explicit reload while a deferred lazy load is in flight still brings the defaults', async () => {
        const { rows, main, query } = await boot(SRC, makeRows(20), { delay: qs => qs.some(q => q.method === 'equal') ? 5 : 80 })
        await query('items', [['equal', 'projectId', 'p1']])
        await settle()
        window.ManifestDataStore.dataSourceCache.clear()
        const lazy = main.loadDataSource('items')
        await settle(10)
        await main.reloadDataSource('items')
        await lazy
        await settle(200)
        expect(rows('items').length).toBe(20)
    })
})

describe('review 2: a reload waiting on a deferred load keeps its place in line', () => {
    it('$query after that reload wins', async () => {
        const SRC = { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n'], ['limit', 100]] } }
        const { rows, main, query } = await boot(SRC, makeRows(20), { delay: qs => qs.some(q => q.method === 'equal') ? 5 : 80 })
        await query('items', [['equal', 'projectId', 'p1']])
        await settle()
        window.ManifestDataStore.dataSourceCache.clear()
        const lazy = main.loadDataSource('items')
        await settle(10)
        const reload = main.reloadDataSource('items')
        const q2 = query('items', [['equal', 'projectId', 'p2']])
        await Promise.all([lazy, reload, q2])
        await settle(200)
        expect(rows('items').length).toBe(10)
        expect(rows('items').every(r => r.projectId === 'p2')).toBe(true)
    })
})
