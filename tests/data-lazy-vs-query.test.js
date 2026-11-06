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
