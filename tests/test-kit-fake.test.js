// mnfst-test fake Appwrite backend: SDK shape, query semantics, paging, realtime.
import { describe, it, expect } from 'vitest'
import { createFakeAppwrite } from '../packages/test/fake.mjs'
import { makeRows, heavyTenant, emptyTenant } from '../packages/test/fixtures.mjs'

const tasks = () => createFakeAppwrite({
    databases: {
        main: {
            tasks: [
                { $id: 'a', title: 'Write docs', status: 'open', priority: 3, tags: ['docs'], due: null },
                { $id: 'b', title: 'Fix login', status: 'done', priority: 5, tags: ['auth', 'bug'] },
                { $id: 'c', title: 'Ship kit', status: 'open', priority: 1, tags: [] },
                { $id: 'd', title: 'write tests', status: 'OPEN', priority: 4, tags: ['docs', 'qa'] }
            ]
        }
    }
})
const list = (fake, queries, extra = {}) => fake.tablesDB.listRows({ databaseId: 'main', tableId: 'tasks', queries, ...extra })
const ids = (r) => r.rows.map(x => x.$id)

describe('Query strings match the Appwrite Web SDK (29.x)', () => {
    it('serialises like the SDK', () => {
        const { Query } = createFakeAppwrite().sdk
        expect(Query.equal('a', 'x')).toBe('{"method":"equal","attribute":"a","values":["x"]}')
        expect(Query.limit(5)).toBe('{"method":"limit","values":[5]}')
        expect(Query.cursorAfter('id1')).toBe('{"method":"cursorAfter","values":["id1"]}')
        expect(Query.or([Query.equal('a', 1), Query.isNull('b')])).toBe('{"method":"or","values":[{"method":"equal","attribute":"a","values":[1]},{"method":"isNull","attribute":"b"}]}')
        expect(Query.between('p', 1, 5)).toBe('{"method":"between","attribute":"p","values":[1,5]}')
        expect(Query.orderRandom()).toBe('{"method":"orderRandom"}')
        expect(Query.select(['a'])).toBe('{"method":"select","values":["a"]}')
    })
})

describe('listRows', () => {
    it('filters case-insensitively like the default collation', async () => {
        const fake = tasks()
        const { Query } = fake.sdk
        expect(ids(await list(fake, [Query.equal('status', 'open')]))).toEqual(['a', 'c', 'd'])
        expect(ids(await list(fake, [Query.notEqual('status', 'open')]))).toEqual(['b'])
        expect(ids(await list(fake, [Query.startsWith('title', 'write')]))).toEqual(['a', 'd'])
        expect(ids(await list(fake, [Query.contains('tags', 'docs')]))).toEqual(['a', 'd'])
        expect(ids(await list(fake, [Query.contains('title', 'IX')]))).toEqual(['b'])
        expect(ids(await list(fake, [Query.isNull('due')]))).toEqual(['a', 'b', 'c', 'd'])
        expect(ids(await list(fake, [Query.between('priority', 3, 4)]))).toEqual(['a', 'd'])
        expect(ids(await list(fake, [Query.greaterThanEqual('priority', 4)]))).toEqual(['b', 'd'])
        expect(ids(await list(fake, [Query.search('title', 'shi')]))).toEqual(['c'])
        expect(ids(await list(fake, [Query.or([Query.equal('priority', 1), Query.equal('priority', 5)])]))).toEqual(['b', 'c'])
    })

    it('sorts, tie-breaks by insertion order, and selects', async () => {
        const fake = tasks()
        const { Query } = fake.sdk
        expect(ids(await list(fake, [Query.orderDesc('priority')]))).toEqual(['b', 'd', 'a', 'c'])
        expect(ids(await list(fake, [Query.orderAsc('status')]))).toEqual(['b', 'a', 'c', 'd'])
        const sel = await list(fake, [Query.select(['title'])])
        expect(Object.keys(sel.rows[0]).filter(k => !k.startsWith('$'))).toEqual(['title'])
    })

    it('defaults to 25 rows, caps total, and rejects oversize limits', async () => {
        const fake = createFakeAppwrite({ databases: { main: { big: makeRows(6000, i => ({ n: i })) } } })
        const r = await fake.tablesDB.listRows({ databaseId: 'main', tableId: 'big' })
        expect(r.rows).toHaveLength(25)
        expect(r.total).toBe(5000)
        await expect(fake.tablesDB.listRows({ databaseId: 'main', tableId: 'big', queries: [fake.sdk.Query.limit(5001)] }))
            .rejects.toMatchObject({ code: 400, type: 'general_query_invalid' })
    })

    it('pages by offset and by cursor in both directions', async () => {
        const fake = createFakeAppwrite({ databases: { main: { big: makeRows(30, i => ({ n: i })) } } })
        const { Query } = fake.sdk
        const page = (q) => fake.tablesDB.listRows({ databaseId: 'main', tableId: 'big', queries: q })
        const first = await page([Query.orderDesc('n'), Query.limit(10)])
        expect(first.rows.map(r => r.n)).toEqual([29, 28, 27, 26, 25, 24, 23, 22, 21, 20])
        const next = await page([Query.orderDesc('n'), Query.cursorAfter(first.rows[9].$id), Query.limit(10)])
        expect(next.rows[0].n).toBe(19)
        const prev = await page([Query.orderDesc('n'), Query.cursorBefore(next.rows[0].$id), Query.limit(3)])
        expect(prev.rows.map(r => r.n)).toEqual([22, 21, 20])
        const third = await page([Query.orderDesc('n'), Query.offset(20), Query.limit(10)])
        expect(third.rows.map(r => r.n)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
        await expect(page([Query.cursorAfter('nope')])).rejects.toMatchObject({ code: 400 })
    })

    it('throws Appwrite-shaped errors', async () => {
        const fake = tasks()
        await expect(fake.tablesDB.listRows({ databaseId: 'main', tableId: 'missing' })).rejects.toMatchObject({ code: 404, type: 'table_not_found' })
        await expect(list(fake, ['{"method":"fuzzy","attribute":"x","values":[1]}'])).rejects.toMatchObject({ code: 400 })
        await expect(fake.tablesDB.getRow({ databaseId: 'main', tableId: 'tasks', rowId: 'zz' })).rejects.toMatchObject({ code: 404, type: 'row_not_found' })
        fake.failNext('listRows', { code: 503, message: 'down' })
        await expect(list(fake, [])).rejects.toMatchObject({ code: 503 })
        expect(ids(await list(fake, []))).toHaveLength(4)
    })
})

describe('writes and realtime', () => {
    it('creates, updates, deletes with system fields and conflict errors', async () => {
        const fake = tasks()
        const db = fake.tablesDB
        const row = await db.createRow({ databaseId: 'main', tableId: 'tasks', rowId: fake.sdk.ID.unique(), data: { title: 'New', $id: 'ignored' } })
        expect(row).toMatchObject({ title: 'New', $tableId: 'tasks', $databaseId: 'main' })
        expect(row.$createdAt).toMatch(/\+00:00$/)
        await expect(db.createRow({ databaseId: 'main', tableId: 'tasks', rowId: 'a', data: {} })).rejects.toMatchObject({ code: 409 })
        const upd = await db.updateRow('main', 'tasks', 'a', { status: 'done' })
        expect(upd.status).toBe('done')
        expect(upd.$updatedAt > upd.$createdAt).toBe(true)
        await db.deleteRow({ databaseId: 'main', tableId: 'tasks', rowId: 'b' })
        expect(fake.table('tasks').count()).toBe(4)
    })

    it('delivers row events with Appwrite event names, channels and server-side filters', async () => {
        const fake = tasks()
        const rt = new fake.sdk.Realtime(new fake.sdk.Client())
        const all = []
        const open = []
        await rt.subscribe('databases.main.tables.tasks.rows', m => all.push(m))
        const sub = await rt.subscribe(['databases.main.tables.tasks.rows'], m => open.push(m), [fake.sdk.Query.equal('status', 'open')])
        fake.table('tasks').insert({ title: 'From another tab', status: 'open' })
        fake.table('tasks').update('b', { title: 'Done thing' })
        fake.table('tasks').remove('c')
        await new Promise(r => setTimeout(r, 0))
        expect(all).toHaveLength(3)
        expect(all[0].events).toContain('databases.main.tables.tasks.rows.*.create')
        expect(all[0].events).toContain(`databases.*.tables.*.rows.${all[0].payload.$id}.create`)
        expect(all[2].events).toContain('databases.main.tables.tasks.rows.c.delete')
        expect(all[0].channels).toContain('databases.main.tables.tasks.rows')
        expect(open.map(m => m.payload.title)).toEqual(['From another tab', 'Ship kit'])
        await sub.unsubscribe()
        fake.table('tasks').insert({ status: 'open' })
        await new Promise(r => setTimeout(r, 0))
        expect(open).toHaveLength(2)
        expect(rt.pendingSubscribes).toBeInstanceOf(Map)
    })
})

describe('fixtures', () => {
    it('builds deterministic heavy and empty tenants', () => {
        const schema = { main: { tasks: (i, h) => ({ title: h.words(2), priority: h.int(1, 5) }) } }
        const a = heavyTenant(schema, { rows: 2000 })
        const b = heavyTenant(schema, { rows: 2000 })
        expect(a.databases.main.tasks).toHaveLength(2000)
        expect(a).toEqual(b)
        expect(emptyTenant(schema).databases.main.tasks).toEqual([])
        const fake = createFakeAppwrite(a)
        expect(fake.table('tasks').count()).toBe(2000)
    })
})
