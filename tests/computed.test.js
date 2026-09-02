/**
 * @vitest-environment happy-dom
 *
 * $computed: a cached derivation recomputed once per flush when a tracked
 * dependency changes — never once per binding read (the Alpine getter storm).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.computed.js'), 'utf8')

beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    new Function(SRC)()
    Alpine.start()
})

let n = 0
function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    return root.firstElementChild
}

function list() {
    const name = `list${n++}`
    const calls = { n: 0 }
    Alpine.data(name, () => ({
        items: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }],
        other: 0,
        rows: window.$computed(function () { calls.n++; return this.items.filter(i => i.v > 1) }),
    }))
    const el = mount(`<div x-data="${name}"><i x-text="rows.length"></i><b x-text="rows.length"></b><u x-text="rows.map(r => r.id).join()"></u></div>`)
    return { el, data: Alpine.$data(el), calls }
}

describe('$computed', () => {
    it('recomputes once per flush, not once per binding', async () => {
        const { el, data, calls } = list()
        expect(calls.n).toBe(1)
        expect(el.querySelector('u').textContent).toBe('b')
        data.items.push({ id: 'c', v: 3 })
        await Alpine.nextTick()
        expect(calls.n).toBe(2)
        expect(el.querySelector('i').textContent).toBe('2')
        expect(el.querySelector('u').textContent).toBe('b,c')
    })

    it('keeps value identity across unrelated writes', async () => {
        const { data, calls } = list()
        const before = data.rows
        data.other++
        await Alpine.nextTick()
        expect(data.rows).toBe(before)
        expect(calls.n).toBe(1)
    })

    it('invalidates at property grain — in-place row mutation, no row replacement', async () => {
        const { el, data, calls } = list()
        data.items[0].v = 5
        await Alpine.nextTick()
        expect(calls.n).toBe(2)
        expect(el.querySelector('u').textContent).toBe('a,b')
        data.items[0].extra = 'ignored'
        await Alpine.nextTick()
        expect(calls.n).toBe(2)
    })

    it('works inline through the $computed magic with `this` bound to the scope', async () => {
        const el = mount(`<div x-data="{ q: 'b', items: ['a', 'b', 'bb'], hits: $computed(function () { return this.items.filter(i => i.includes(this.q)) }) }"><span x-text="hits.join()"></span></div>`)
        expect(el.querySelector('span').textContent).toBe('b,bb')
        Alpine.$data(el).q = 'bb'
        await Alpine.nextTick()
        expect(el.querySelector('span').textContent).toBe('bb')
    })

    it('x-computed:name defines a cached value on the nearest scope from a plain expression', async () => {
        const el = mount(`<div x-data="{ q: 'b', items: ['a', 'b', 'bb'], calls: 0 }" x-computed:hits="(calls++, items.filter(i => i.includes(q)))"><span x-text="hits.join()"></span><i x-text="hits.length"></i><b x-text="calls"></b></div>`)
        expect(el.querySelector('span').textContent).toBe('b,bb')
        const data = Alpine.$data(el)
        const before = data.hits
        data.q = 'bb'
        await Alpine.nextTick()
        expect(el.querySelector('span').textContent).toBe('bb')
        expect(data.hits).not.toBe(before)
        data.items.push('x')
        await Alpine.nextTick()
        expect(el.querySelector('i').textContent).toBe('1')
    })

    it('$computed accepts an arrow that receives the scope', async () => {
        const name = `arrow${n++}`
        Alpine.data(name, () => ({ items: [1, 2, 3], big: window.$computed((s) => s.items.filter((i) => i > 1)) }))
        const el = mount(`<div x-data="${name}"><span x-text="big.join()"></span></div>`)
        expect(el.querySelector('span').textContent).toBe('2,3')
        Alpine.$data(el).items.push(9)
        await Alpine.nextTick()
        expect(el.querySelector('span').textContent).toBe('2,3,9')
    })

    it('a throwing computed keeps its last value', async () => {
        const name = `boom${n++}`
        Alpine.data(name, () => ({
            ok: true,
            v: window.$computed(function () { if (!this.ok) throw new Error('nope'); return 'fine' }),
        }))
        const el = mount(`<div x-data="${name}"><span x-text="v"></span></div>`)
        const data = Alpine.$data(el)
        data.ok = false
        await Alpine.nextTick()
        expect(data.v).toBe('fine')
        expect(el.querySelector('span').textContent).toBe('fine')
    })

    it('releases its effect with the element', async () => {
        const { el, data, calls } = list()
        Alpine.destroyTree(el)
        data.items.push({ id: 'z', v: 9 })
        await Alpine.nextTick()
        expect(calls.n).toBe(1)
    })
})
