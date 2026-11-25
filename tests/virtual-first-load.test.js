/**
 * @vitest-environment happy-dom
 *
 * x-virtual never renders the whole list at first load (Alpine queues the template's
 * x-for before x-virtual runs unless it is taken off as the container is visited), and
 * an x-for form it cannot run is left for Alpine's own x-for.
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

// Mounts a list and reports every row element ever created for it
async function mount(forExpr, key, text, attrs = 'x-virtual="{estimate:40,overscan:1}"') {
    const box = document.createElement('div')
    box.innerHTML = `<main x-data="{ rows: Array.from({length:400},(_,i)=>({id:'q'+i})) }"><div class=v ${attrs} style="overflow:auto"><template x-for="${forExpr}" :key="${key}"><div class=r x-text="${text}"></div></template></div></main>`
    const v = box.querySelector('.v')
    Object.defineProperty(v, 'clientHeight', { configurable: true, get() { return 200 } })
    let created = 0
    const seen = new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('r')) created++ })
    seen.observe(box, { childList: true, subtree: true })
    document.body.appendChild(box)
    await frame()
    seen.disconnect()
    return { v, created: () => created, rows: () => [...v.querySelectorAll('.r')].map(e => e.textContent) }
}

describe('x-virtual first load', () => {
    it('creates only the window for a 400-item list', async () => {
        const { created, rows } = await mount('row in rows', 'row.id', 'row.id')
        expect(rows()[0]).toBe('q0')
        expect(created()).toBeLessThan(30)
        expect(created()).toBe(rows().length)
    })

    it('does the same for the (row, i) form and with a modifier on the directive', async () => {
        const tuple = await mount('(row, i) in rows', 'row.id', "i + ':' + row.id")
        expect(tuple.rows()[0]).toBe('0:q0')
        expect(tuple.created()).toBeLessThan(30)
        const modified = await mount('row in rows', 'row.id', 'row.id', 'x-virtual.fast="{estimate:40,overscan:1}"')
        expect(modified.created()).toBeLessThan(30)
    })

    it('leaves a form it cannot run to Alpine’s own x-for', async () => {
        const { v, rows } = await mount('({ id }, i) in rows', 'id', "i + ':' + id")
        expect(rows()).toHaveLength(400)
        expect(rows()[399]).toBe('399:q399')
        expect(v.querySelector('template').hasAttribute('data-virtual-for')).toBe(false)
    })

    it('leaves the template of an x-ignored container alone', async () => {
        const { v } = await mount('row in rows', 'row.id', 'row.id', 'x-virtual x-ignore')
        expect(v.querySelector('template').getAttribute('x-for')).toBe('row in rows')
    })
})
