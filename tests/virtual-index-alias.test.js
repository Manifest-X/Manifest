/**
 * @vitest-environment happy-dom
 *
 * x-virtual accepts x-for's tuple form, `(row, i) in items` (parenthesised or not): both
 * names are in each row's scope and in :key, and the index follows scrolling and source changes.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const frame = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 20)) }

window.Alpine = Alpine
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
// No layout in happy-dom: the top spacer sits at content offset 0 of its scroller
const origRect = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute('data-virtual-spacer') && !this.previousElementSibling) {
        const top = -(this.closest('.v')?.scrollTop || 0)
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top }
    }
    return origRect.call(this)
}

beforeAll(async () => {
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(readFileSync(path.join(dir, '../src/scripts/manifest.virtual.js'), 'utf8')))
    window.ensureVirtualPluginInitialized()
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 40 } })
    Alpine.start()
})

const mount = async (forExpr, key) => {
    const box = document.createElement('div')
    box.innerHTML = `<main x-data="{ rows: Array.from({length:100},(_,i)=>({id:'q'+i})) }"><div class=v x-virtual="{estimate:40,overscan:1}" style="overflow:auto"><template x-for="${forExpr}" :key="${key}"><div class=r x-text="i + ':' + row.id"></div></template></div></main>`
    const v = box.querySelector('.v')
    Object.defineProperty(v, 'clientHeight', { configurable: true, get() { return 200 } })
    document.body.appendChild(box)
    Alpine.initTree(box)
    await frame()
    return { v, data: Alpine.$data(box.firstElementChild) }
}
const scrollTo = async (v, top) => { v.scrollTop = top; v.dispatchEvent(new Event('scroll')); await frame() }
const shown = (v) => [...v.querySelectorAll('.r')].map(e => e.textContent)
// Every rendered row reads "<its index in rows>:<its id>"
const consistent = (v, rows) => shown(v).every(t => { const [i, id] = t.split(':'); return rows[+i]?.id === id })

describe('x-virtual (item, index) form', () => {
    for (const forExpr of ['(row, i) in rows', 'row, i in rows']) {
        it(`renders item and index for "${forExpr}", after a scroll and a source change`, async () => {
            const { v, data } = await mount(forExpr, 'row.id')
            expect(shown(v)[0]).toBe('0:q0')
            expect(consistent(v, data.rows)).toBe(true)

            await scrollTo(v, 1200)
            expect(shown(v).length).toBeGreaterThan(3)
            expect(shown(v)[0]).not.toBe('0:q0')
            expect(consistent(v, data.rows)).toBe(true)

            data.rows = [{ id: 'new' }, ...data.rows]
            await frame()
            await scrollTo(v, 1200)
            expect(consistent(v, data.rows)).toBe(true)

            await scrollTo(v, 0)
            expect(shown(v)[0]).toBe('0:new')
            expect(shown(v)[1]).toBe('1:q0')
        })
    }

    it('lets :key use the index name', async () => {
        const { v, data } = await mount('(row, i) in rows', "'k' + i")
        expect(shown(v).slice(0, 2)).toEqual(['0:q0', '1:q1'])
        data.rows = data.rows.slice().reverse()
        await frame()
        await scrollTo(v, 0)
        expect(shown(v)[0]).toBe('0:q99')
        expect(consistent(v, data.rows)).toBe(true)
    })

    it('still renders the plain form', async () => {
        const box = document.createElement('div')
        box.innerHTML = `<main x-data="{ rows: [{id:'a'},{id:'b'}] }"><div class=v x-virtual style="overflow:auto"><template x-for="row in rows" :key="row.id"><div class=r x-text="row.id"></div></template></div></main>`
        const v = box.querySelector('.v')
        Object.defineProperty(v, 'clientHeight', { configurable: true, get() { return 200 } })
        document.body.appendChild(box)
        Alpine.initTree(box)
        await frame()
        expect(shown(v)).toEqual(['a', 'b'])
    })
})
