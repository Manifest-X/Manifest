// mountManifest + fake Appwrite: Manifest's real data plugins in happy-dom
import { describe, it, expect } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import { mountManifest, createFakeAppwrite, makeRows } from '../packages/test/index.mjs'

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib')
const plugins = ['manifest.data.js', 'manifest.appwrite.data.js'].map(f => path.join(LIB, f))
const manifest = {
    appwrite: { projectId: 'p', endpoint: 'https://example.test/v1' },
    data: { tasks: { appwriteDatabaseId: 'main', appwriteTableId: 'tasks', queries: { default: [['orderAsc', 'n'], ['limit', 50]] } },
        paged: { appwriteDatabaseId: 'main', appwriteTableId: 'tasks', queries: { default: [['orderAsc', 'n']] } }
    }
}

describe('mountManifest({ appwrite })', () => {
    it('renders, queries and receives realtime through the real plugins', async () => {
        const fake = createFakeAppwrite({ databases: { main: { tasks: makeRows(80, i => ({ n: i, title: `Task ${i}` })) } } })
        const m = await mountManifest({
            manifest, plugins, appwrite: fake, settle: 300,
            html: `<ul x-data><template x-for="t in $x.tasks" :key="t.$id"><li x-text="t.title"></li></template></ul>`
        })
        const wait = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await m.tick(20) }
        await wait(() => m.$$('li').length === 50)
        expect(m.$$('li')).toHaveLength(50)
        expect(fake.lastQueries('tasks')).toEqual([
            { method: 'orderAsc', attribute: 'n', values: [] },
            { method: 'limit', values: [50] }
        ])
        fake.table('tasks').remove('row000001')
        await wait(() => m.$$('li').length === 49)
        expect(m.$('li').textContent).toBe('Task 1')
        await m.unmount()
    })

    it('runs $query, paging, $search and writes through the real plugins', async () => {
        const m = await mountManifest({
            manifest, plugins, settle: 300,
            appwrite: { databases: { main: { tasks: makeRows(80, i => ({ n: i, title: `Task ${i}`, kind: i % 2 ? 'odd' : 'even' })) } } },
            html: `<ul x-data><template x-for="t in $x.tasks" :key="t.$id"><li x-text="t.title"></li></template></ul>`
        })
        const wait = async (fn) => { for (let i = 0; i < 100 && !(await fn()); i++) await m.tick(20) }
        const x = (expr) => m.window.Alpine.evaluate(m.$('ul'), expr)
        const tasks = () => x('$x.tasks')
        await wait(() => m.$$('li').length === 50)

        // The source's default ['limit', 50] reaches the server first, and Appwrite keeps the first limit
        expect((await tasks().$first(10)).items).toHaveLength(50)
        const paged = () => x('$x.paged')
        await wait(() => paged()?.$ready && typeof paged().$first === 'function')
        const first = await paged().$first(10)
        expect(first).toMatchObject({ total: 80, hasMore: true })
        expect(first.items.map(r => r.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        const next = await paged().$next(first.cursor, 10)
        expect(next.items[0].n).toBe(10)
        const prev = await paged().$prev(next.items[0].$id, 5)
        expect(prev.items.map(r => r.n)).toEqual([5, 6, 7, 8, 9])
        const page = await paged().$page(8, 10)
        expect(page).toMatchObject({ page: 8, totalPages: 8, hasMore: false })

        await tasks().$query([['equal', 'kind', 'odd'], ['greaterThanOrEqual', 'n', 70], ['orderDesc', 'n']])
        await wait(() => m.$$('li').length === 5)
        expect(m.$$('li').map(li => li.textContent)).toEqual(['Task 79', 'Task 77', 'Task 75', 'Task 73', 'Task 71'])
        expect(x(`$x.tasks.$search('77', 'title').length`)).toBe(1)

        await tasks().$update('row000080', { title: 'Renamed' })
        await wait(() => m.$('li').textContent === 'Renamed')
        expect(m.fake.table('tasks').get('row000080').title).toBe('Renamed')
        const made = await tasks().$create({ title: 'Made', kind: 'odd', n: 99 })
        expect(m.fake.table('tasks').get(made.$id).n).toBe(99)
        await m.unmount()
    })
})
