// @vitest-environment happy-dom
/**
 * Stable array identity (platforms card 03, F3): `$x.<source>` returns the same
 * array between landings, so identity-keyed memos hit; a landing hands out a
 * new one, so memos see the change.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { boot, release, settle } from './helpers/appwrite-data-harness.js'

const CH = 'databases.db.tables.items.rows'
let seq = 20000
const evt = (type, row) => ({ events: [`databases.db.tables.items.rows.${row.$id}.${type}`], payload: { $sequence: ++seq, ...row } })
const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ $id: `r${i + 1}`, n: i + 1 }))
const SRC = { items: { appwriteTableId: 'items', queries: [['orderAsc', 'n'], ['limit', 5000]] }, other: { appwriteTableId: 'other', queries: [['limit', 10]] } }
const x = () => window.Alpine.evaluate(document.body, '$x')

afterEach(release)

describe('$x.<source> identity', () => {
    it('is the same array across reads until the source lands again', async () => {
        const { main } = await boot(SRC, makeRows(20))
        await main.loadDataSource('items')
        await settle()
        const a = x().items
        expect(x().items).toBe(a)
        expect(x().items).toBe(a)
    })

    it('a realtime landing hands out a new array that includes the change', async () => {
        const { main, rt } = await boot(SRC, makeRows(20))
        await main.loadDataSource('items')
        await settle()
        const before = x().items
        rt().fire(CH, evt('create', { $id: 'live', n: 100 }))
        await settle()
        const after = x().items
        expect(after).not.toBe(before)
        expect(after.some(r => r.$id === 'live')).toBe(true)
        expect(x().items).toBe(after)
    })

    it('a landing on another source leaves this one unchanged', async () => {
        const { main } = await boot(SRC, makeRows(20))
        await main.loadDataSource('items')
        await main.loadDataSource('other')
        await settle()
        const a = x().items
        await main.reloadDataSource('other')
        await settle()
        expect(x().items).toBe(a)
    })

    it('a local write hands out a new array', async () => {
        const { main, call } = await boot(SRC, makeRows(20), { writeDelay: 20 })
        await main.loadDataSource('items')
        await settle()
        const a = x().items
        await call('items', '$update', 'r1', { n: 0.5 })
        expect(x().items).not.toBe(a)
    })

    it('an identity memo over 5000 rows recomputes only after a landing', async () => {
        const { main, rt } = await boot(SRC, makeRows(5000))
        await main.loadDataSource('items')
        await settle()
        let runs = 0
        const memo = new WeakMap()
        const evens = () => { const arr = x().items; if (!memo.has(arr)) { runs++; memo.set(arr, arr.filter(r => r.n % 2 === 0).length) } return memo.get(arr) }
        for (let i = 0; i < 50; i++) evens()
        expect(runs).toBe(1)
        expect(evens()).toBe(2500)
        rt().fire(CH, evt('create', { $id: 'live', n: 6000 }))
        await settle()
        expect(evens()).toBe(2501)
        expect(runs).toBe(2)
    })
})
