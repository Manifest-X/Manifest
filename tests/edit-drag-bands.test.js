/**
 * @vitest-environment happy-dom
 *
 * Drop placement with a reflowing mock layout:
 *   - a card dragged by its top padding across a grid stays in the grid (over the stand-in it
 *     stays put; over the container it came from it stays in, by reading order);
 *   - in a stacked list, the stand-in passes a row at the row's middle wherever the pointer is
 *     across (as from a grip at the rows' inline-start edge).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'

const flush = () => new Promise(r => setTimeout(r, 0))
beforeAll(async () => {
    new Function(EDIT_SRC)()
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))
})
let restore = null
afterEach(() => { document.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true })); if (restore) restore(); restore = null; document.body.innerHTML = '' })

async function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    await flush(); await flush()
    return root
}
const R = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top })
// Rects from a layout function, recomputed on every read; elementFromPoint takes the deepest hit.
function useLayout(layout) {
    const proto = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { return layout().get(this) || proto.call(this) }
    document.elementFromPoint = (x, y) => {
        let best = null, depth = -1
        for (const [el, r] of layout()) {
            if (el.hasAttribute('data-edit-dragging') || x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue
            let d = 0; for (let n = el; n; n = n.parentElement) d++
            if (d > depth) { best = el; depth = d }
        }
        return best
    }
    restore = () => { Element.prototype.getBoundingClientRect = proto; delete document.elementFromPoint }
}
const ev = (type, x, y, target = document) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }))
const live = (c) => [...c.children].filter(k => !k.hasAttribute('data-edit-dragging') && !k.hasAttribute('data-edit-handle'))

describe('a card dragged by its top padding across a grid', () => {
    it('keeps its stand-in in the grid, and lands there', async () => {
        const root = await mount(`<section x-edit.move="gb"><div class="grid" style="display: grid"><article id="a"><h3>A</h3></article><article id="b"><h3>B</h3></article><article id="c"><h3>C</h3></article></div><p>After</p></section>`)
        const section = root.querySelector('section'), grid = root.querySelector('.grid')
        useLayout(() => {
            const m = new Map()
            m.set(section, R(0, 0, 400, 160)); m.set(grid, R(0, 0, 340, 100))
            live(grid).forEach((card, i) => {
                const left = 10 + i * 110; m.set(card, R(left, 10, left + 100, 90))
                const h3 = card.querySelector('h3'); if (h3) m.set(h3, R(left + 10, 20, left + 90, 40))
            })
            m.set(section.querySelector('p'), R(0, 110, 400, 150))
            return m
        })
        const a = root.querySelector('#a')
        ev('pointerdown', 60, 14, a)
        const seen = []
        for (let x = 66; x <= 280; x += 6) { ev('pointermove', x, 14); const g = document.querySelector('[data-edit-ghost]'); seen.push(!!g && grid.contains(g)) }
        expect(seen.every(Boolean)).toBe(true)
        ev('pointerup', 280, 14)
        expect(a.parentElement).toBe(grid)
    })
})

describe('in a stacked list', () => {
    it('the stand-in passes a row at its middle, even with the pointer beside the rows', async () => {
        const root = await mount(`<ul x-edit.move="gl"><li id="one">One</li><li>Two</li><li>Three</li></ul>`)
        const ul = root.querySelector('ul')
        useLayout(() => {
            const m = new Map(); m.set(ul, R(0, 0, 300, 120))
            const rows = live(ul); rows.forEach((li, i) => m.set(li, R(20, i * 40, 300, i * 40 + 40)))
            return m
        })
        const one = root.querySelector('#one')
        ev('pointerdown', 100, 20, one)
        ev('pointermove', 5, 30); ev('pointermove', 5, 58)
        const order = () => live(ul).map(c => c.hasAttribute('data-edit-ghost') ? 'ghost' : c.textContent)
        expect(order()).toEqual(['ghost', 'Two', 'Three'])        // before Two's middle (60)
        ev('pointermove', 5, 62)
        expect(order()).toEqual(['Two', 'ghost', 'Three'])        // past it
        ev('pointerup', 5, 62)
        expect(live(ul).map(c => c.textContent)).toEqual(['Two', 'One', 'Three'])
    })
})
