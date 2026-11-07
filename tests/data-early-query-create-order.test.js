// @vitest-environment happy-dom
/**
 * Card 07 reports: `$query` called before a source's first load must run (and
 * return a promise); a `$create` on a source sorted by `$createdAt` lands at its
 * sort position, before and after Appwrite answers, and stays there on $reload().
 */
import { describe, it, expect, afterEach } from 'vitest'
import { boot, release, settle } from './helpers/appwrite-data-harness.js'

const base = Date.UTC(2026, 0, 1)
const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `t${String(i + 1).padStart(5, '0')}`, n: i + 1, projectId: i % 2 ? 'p2' : 'p1', $createdAt: new Date(base + i * 60000).toISOString() }))
const x = () => window.Alpine.evaluate(document.body, '$x')

afterEach(release)

describe('early $query', () => {
    for (const paging of [null, { mode: 'window', size: 100 }]) {
        it(`runs before the first load and returns a promise (${paging ? 'paged' : 'unpaged'})`, async () => {
            const SRC = { tasks: { appwriteTableId: 'items', queries: [['orderDesc', '$createdAt'], ['limit', 100]], ...(paging ? { paging } : {}) } }
            const { rows, stats } = await boot(SRC, makeRows(300))
            const result = x().tasks.$query([['equal', 'projectId', 'p1'], ['orderDesc', '$createdAt']])
            expect(typeof result?.then).toBe('function')
            await result
            await settle(200)
            expect(stats.lists.some(l => Array.isArray(l) && l.some(q => q.method === 'equal'))).toBe(true)
            expect(rows('tasks').length).toBeGreaterThan(0)
            expect(rows('tasks').every(r => r.projectId === 'p1')).toBe(true)
        })
    }
})

describe('$create on a source sorted by $createdAt', () => {
    for (const paging of [null, { mode: 'window', size: 100 }]) {
        it(`lands first under orderDesc and stays there (${paging ? 'paged' : 'unpaged'})`, async () => {
            const SRC = { tasks: { appwriteTableId: 'items', queries: [['orderDesc', '$createdAt'], ['limit', 100]], ...(paging ? { paging } : {}) } }
            const table = makeRows(3000)
            const { rows, main, call } = await boot(SRC, table, { writeDelay: 40, echoFirst: false })
            await main.loadDataSource('tasks')
            await settle()
            const made = call('tasks', '$create', { n: 0, projectId: 'p1', title: 'New' })
            await settle(10)
            expect(rows('tasks')[0]?.title).toBe('New')
            await made
            await settle(100)
            expect(rows('tasks')[0]?.title).toBe('New')
            await x().tasks.$reload()
            await settle(100)
            expect(rows('tasks')[0]?.title).toBe('New')
            expect(rows('tasks').filter(r => r.title === 'New').length).toBe(1)
        })
    }
})

describe('review: unsorted sources', () => {
    it('two quick creates keep their creation order after Appwrite answers', async () => {
        const SRC = { tasks: { appwriteTableId: 'items', queries: [['limit', 100]] } }
        let n = 0
        const { rows, main, call } = await boot(SRC, makeRows(5), { writeDelay: () => (++n === 1 ? 80 : 20), echoFirst: false })
        await main.loadDataSource('tasks')
        await settle()
        await Promise.all([call('tasks', '$create', { title: 'A' }), call('tasks', '$create', { title: 'B' })])
        await settle(100)
        expect(rows('tasks').slice(-2).map(r => r.title)).toEqual(['A', 'B'])
    })
})
