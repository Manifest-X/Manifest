// @vitest-environment happy-dom
/**
 * Optimistic writes that hold (platforms card 03, F2): an unsettled write wins
 * over any landing until it settles; a failed update restores only its own
 * fields; a failed delete puts the row back in place; $saving(id) / $pending.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { boot, release, settle } from './helpers/appwrite-data-harness.js'

const CH = 'databases.db.tables.items.rows'
let seq = 9000
const evt = (type, row) => ({ events: [`databases.db.tables.items.rows.${row.$id}.${type}`], payload: { $sequence: ++seq, ...row } })
const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${String(i + 1).padStart(5, '0')}`, n: i + 1, name: `Row ${i + 1}`, status: 'open' }))
const SRC = { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n'], ['limit', 5000]] } }
const row = (rows, id) => rows('items').find(r => r.$id === id)
const saving = (id) => window.ManifestDataProxiesMagic.createSavingMethod('items')(id)
const pending = () => window.ManifestDataProxiesMagic.getStateProperty('$pending', 'items')

afterEach(release)

describe('an unsettled write wins over landings', () => {
    it('a reload fetched before the write lands without undoing it', async () => {
        const table = makeRows(5)
        const { rows, main, call } = await boot(SRC, table, { writeDelay: 150 })
        await main.loadDataSource('items')
        const write = call('items', '$update', 'r00002', { status: 'done' })
        await settle(20)
        expect(row(rows, 'r00002').status).toBe('done')
        await main.reloadDataSource('items') // server still says 'open'
        await settle(30)
        expect(row(rows, 'r00002').status).toBe('done')
        await write
        await settle()
        expect(row(rows, 'r00002').status).toBe('done')
    })

    it('a live change to another field merges; the pending field holds', async () => {
        const { rows, main, call, rt } = await boot(SRC, makeRows(5), { writeDelay: 150 })
        await main.loadDataSource('items')
        const write = call('items', '$update', 'r00001', { status: 'done' })
        await settle(20)
        rt().fire(CH, evt('update', { $id: 'r00001', n: 1, name: 'Renamed elsewhere', status: 'open' }))
        await settle(30)
        expect(row(rows, 'r00001').name).toBe('Renamed elsewhere')
        expect(row(rows, 'r00001').status).toBe('done')
        await write
    })

    it('a pending delete stays deleted through a reload', async () => {
        const { ids, main, call } = await boot(SRC, makeRows(5), { writeDelay: 150 })
        await main.loadDataSource('items')
        const del = call('items', '$delete', 'r00003')
        await settle(20)
        await main.reloadDataSource('items')
        await settle(30)
        expect(ids('items')).not.toContain('r00003')
        await del
    })

    it('a pending create keeps its placeholder through a reload, then becomes the server row', async () => {
        const { rows, main, call } = await boot(SRC, makeRows(5), { writeDelay: 150, echoFirst: false })
        await main.loadDataSource('items')
        const made = call('items', '$create', { n: 6, name: 'New' })
        await settle(20)
        await main.reloadDataSource('items')
        await settle(30)
        expect(rows('items').filter(r => r.name === 'New').length).toBe(1)
        const result = await made
        await settle(60)
        const news = rows('items').filter(r => r.name === 'New')
        expect(news.length).toBe(1)
        expect(news[0].$id).toBe(result.$id)
    })
})

describe('failures', () => {
    it('a failed update restores only its own fields', async () => {
        const { rows, main, call, rt, stats } = await boot(SRC, makeRows(5), { writeDelay: 100 })
        await main.loadDataSource('items')
        stats.failWrites = true
        const write = call('items', '$update', 'r00001', { status: 'done' })
        await settle(20)
        rt().fire(CH, evt('update', { $id: 'r00001', n: 1, name: 'Renamed elsewhere', status: 'open' }))
        await expect(write).rejects.toThrow('mock fail')
        await settle()
        expect(row(rows, 'r00001').status).toBe('open')
        expect(row(rows, 'r00001').name).toBe('Renamed elsewhere')
    })

    it('a failed update leaves a field a later unsettled write still covers', async () => {
        const delays = { first: 60, second: 200 }
        let n = 0
        const { rows, main, call, stats } = await boot(SRC, makeRows(5), { writeDelay: () => (++n === 1 ? delays.first : delays.second) })
        await main.loadDataSource('items')
        stats.failWrites = true
        const first = call('items', '$update', 'r00001', { status: 'a' })
        await settle(10)
        const second = call('items', '$update', 'r00001', { status: 'b' })
        await expect(first).rejects.toThrow()
        await settle(20)
        expect(row(rows, 'r00001').status).toBe('b')
        await expect(second).rejects.toThrow()
    })

    it('a failed delete puts the row back where it was', async () => {
        const { ids, main, call, stats } = await boot(SRC, makeRows(5), { writeDelay: 50 })
        await main.loadDataSource('items')
        stats.failWrites = true
        await expect(call('items', '$delete', 'r00003')).rejects.toThrow()
        await settle()
        expect(ids('items')).toEqual(['r00001', 'r00002', 'r00003', 'r00004', 'r00005'])
    })
})

describe('$saving and $pending', () => {
    it('track unsettled writes per row', async () => {
        const { main, call } = await boot(SRC, makeRows(5), { writeDelay: 80 })
        await main.loadDataSource('items')
        expect(saving('r00001')).toBe(false)
        const a = call('items', '$update', 'r00001', { status: 'x' })
        const b = call('items', '$update', 'r00002', { status: 'y' })
        await settle(10)
        expect(saving('r00001')).toBe(true)
        expect(saving('r00003')).toBe(false)
        expect(pending()).toBe(2)
        await Promise.all([a, b])
        expect(saving('r00001')).toBe(false)
        expect(pending()).toBe(0)
    })
})

describe('heavy', () => {
    it('5000 rows: 200 slow concurrent updates hold through a reload, then settle to the server values', async () => {
        const { rows, main, call } = await boot(SRC, makeRows(5000), { writeDelay: 120 })
        await main.loadDataSource('items')
        const t0 = performance.now()
        const writes = Array.from({ length: 200 }, (_, i) => call('items', '$update', `r${String(1 + i * 25).padStart(5, '0')}`, { status: `s${i}` }))
        await settle(20)
        await main.reloadDataSource('items')
        await settle(30)
        const held = rows('items').filter(r => r.status.startsWith('s')).length
        expect(held).toBe(200)
        await Promise.all(writes)
        await settle()
        expect(rows('items').filter(r => r.status.startsWith('s')).length).toBe(200)
        expect(pending()).toBe(0)
        expect(performance.now() - t0).toBeLessThan(5000)
    })
})

describe('review: overlapping writes and settle window', () => {
    for (const order of ['AB', 'BA']) {
        it(`two failed writes on one field unwind to the value before both (${order})`, async () => {
            let n = 0
            const delays = order === 'AB' ? [40, 120] : [120, 40]
            const { rows, main, call, stats } = await boot(SRC, makeRows(5), { writeDelay: () => delays[n++] })
            await main.loadDataSource('items')
            stats.failWrites = true
            const a = call('items', '$update', 'r00001', { status: 'done' })
            await settle(5)
            const b = call('items', '$update', 'r00001', { status: 'x' })
            await Promise.allSettled([a, b])
            await settle()
            expect(row(rows, 'r00001').status).toBe('open')
        })
    }

    it('a pending create never shows under a $query that excludes it', async () => {
        const { rows, main, call, query } = await boot(SRC, makeRows(5), { writeDelay: 150, echoFirst: false })
        await main.loadDataSource('items')
        const made = call('items', '$create', { n: 6, name: 'New', status: 'open' })
        await settle(10)
        await query('items', [['equal', 'status', 'closed'], ['orderAsc', 'n']])
        await settle(30)
        expect(rows('items').some(r => r.name === 'New')).toBe(false)
        await made
    })

    it('a reload issued before a delete settled never brings the row back', async () => {
        const delay = () => 120
        const { ids, main, call } = await boot(SRC, makeRows(5), { delay, writeDelay: 20 })
        await main.loadDataSource('items')
        const reload = main.reloadDataSource('items') // reads before the delete commits
        await settle(10)
        await call('items', '$delete', 'r00002')
        await reload
        await settle()
        expect(ids('items')).not.toContain('r00002')
    })
})

describe('review 2: a settled write never overrides a newer live value', () => {
    it('a later $more() page does not re-apply it to rows outside that page', async () => {
        const { rows, main, call, rt } = await boot(
            { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 50 } } },
            makeRows(200), { writeDelay: 10 }
        )
        await main.loadDataSource('items')
        await call('items', '$update', 'r00003', { status: 'done' })
        await settle()
        rt().fire(CH, evt('update', { $id: 'r00003', n: 3, name: 'Row 3', status: 'x' }))
        await settle()
        await main.loadMore('items')
        await settle()
        expect(row(rows, 'r00003').status).toBe('x')
    })
})
