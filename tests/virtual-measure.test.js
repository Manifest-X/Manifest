/**
 * @vitest-environment happy-dom
 *
 * x-virtual display:contents rows (grid-table) are measured as the union of their
 * cells' rects. A <template> child (nested x-for / x-if) or a display:none cell has
 * no box and reports a 0,0 rect; unioned in, every row measured from the viewport top.
 * happy-dom has no layout, so a small geometry model stands in for the browser.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ROW_H = 44
const VIEW_H = 400
const VIEW_TOP = 120   // scroller sits below a page header, like the real app

window.Alpine = Alpine
const observers = []
window.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this) }
    observe(t) { this.targets.add(t) }
    unobserve(t) { this.targets.delete(t) }
    disconnect() { this.targets.clear() }
}
const resize = (target) => observers.forEach((o) => {
    const hit = target ? (o.targets.has(target) ? [target] : []) : [...o.targets]
    if (hit.length) o.cb(hit.map((t) => ({ target: t })))
})

const load = (file) => import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/' + file), 'utf8')
))
await load('manifest.virtual.js')
window.ensureVirtualPluginInitialized()

// Geometry model: host children stack vertically; spacers use style.height,
// .grid-row contributes ROW_H; box-less nodes report an all-zero rect.
const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }
const box = (top, height) => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top })
let scroller = null
let scrollTop = 0

function rowOf(el) {
    let n = el
    while (n && n !== scroller) { if (n.classList?.contains('grid-row')) return n; n = n.parentElement }
    return null
}
function offsetInHost(target) {
    let y = 0
    for (const c of target.parentElement.children) {
        if (c === target) return y
        if (c.hasAttribute('data-virtual-spacer')) y += parseFloat(c.style.height) || 0
        else if (c.classList.contains('grid-row')) y += ROW_H
    }
    return y
}
const origRect = HTMLElement.prototype.getBoundingClientRect
HTMLElement.prototype.getBoundingClientRect = function () {
    if (!scroller || !scroller.contains(this)) return origRect.call(this)
    if (this === scroller) return box(VIEW_TOP, VIEW_H)
    if (this.tagName === 'TEMPLATE') return zero
    if (getComputedStyle(this).display === 'none' || getComputedStyle(this).display === 'contents') return zero
    if (this.hasAttribute('data-virtual-spacer')) return box(VIEW_TOP + offsetInHost(this) - scrollTop, parseFloat(this.style.height) || 0)
    const row = rowOf(this)
    if (row) {
        // A spacer without grid-column: 1/-1 auto-places into the last row's track and stretches it.
        const bot = spacers()[1]
        const stretched = row.nextElementSibling === bot && bot.style.gridColumn !== '1 / -1'
        return box(VIEW_TOP + offsetInHost(row) - scrollTop, stretched ? Math.max(ROW_H, parseFloat(bot.style.height) || 0) : ROW_H)
    }
    return zero
}

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await frame() }

function mount(rowInner, count, { hidden = false } = {}) {
    const host = document.createElement('div')
    host.innerHTML = `
        <div x-data="{ shown: ${!hidden}, rows: Array.from({ length: ${count} }, (_, i) => ({ $id: 'r' + i, n: i })), columns: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] }">
            <div x-virtual="{ estimate: 44, overscan: 8 }" x-show="shown" class="grid-table" style="overflow: auto">
                <template x-for="row in rows" :key="row.$id">
                    <div class="grid-row" style="display: contents">${rowInner}</div>
                </template>
            </div>
        </div>`
    document.body.appendChild(host)
    scroller = host.querySelector('[x-virtual]')
    scrollTop = 0
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => scroller.style.display === 'none' ? 0 : VIEW_H })
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, get: () => 600 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v) => { scrollTop = v } })
    Alpine.initTree(host)
    return host
}

const spacers = () => scroller.querySelectorAll('[data-virtual-spacer]')
const rowsInDom = () => [...scroller.querySelectorAll(':scope > .grid-row')]
const totalHeight = () => [...spacers()].reduce((s, sp) => s + (parseFloat(sp.style.height) || 0), 0) + rowsInDom().length * ROW_H

async function scrollToEnd() {
    for (let i = 0; i < 6; i++) {
        scrollTop = Math.max(0, totalHeight() - VIEW_H)
        scroller.dispatchEvent(new Event('scroll'))
        await settle(4)
    }
}

const NESTED = `
    <div class="freeze-1" style="position: sticky; left: 0" x-text="row.n"></div>
    <template x-for="(col, idx) in columns" :key="col.key">
        <div :class="idx === 0 ? 'freeze-2' : ''" x-text="col.key"></div>
    </template>`

// x-show strips inline display, so the grid comes from a stylesheet as in real apps.
beforeAll(() => {
    document.head.insertAdjacentHTML('beforeend', '<style>.grid-table { display: grid }</style>')
    Alpine.start()
})
afterEach(() => { document.body.innerHTML = ''; scroller = null; observers.length = 0 })

describe('x-virtual measures display:contents rows with box-less children', { timeout: 20000 }, () => {
    it('nested <template x-for> in each row: sane spacer, end reachable, bounded DOM', async () => {
        const N = 1000
        mount(NESTED, N)
        await settle()
        const rows = rowsInDom()
        expect(rows.length).toBeGreaterThan(0)
        expect(rows[0].querySelector(':scope > template')).toBeTruthy()
        expect(rows.length).toBeLessThan(40)
        const t = totalHeight()
        expect(t).toBeGreaterThan(N * ROW_H / 2)
        expect(t).toBeLessThan(N * ROW_H * 2)

        await scrollToEnd()
        const last = rowsInDom().at(-1)
        expect(last.querySelector('.freeze-1').textContent).toBe(String(N - 1))
        expect(parseFloat(spacers()[1].style.height)).toBe(0)
        expect(rowsInDom().length).toBeLessThan(40)
    })

    it('display:none cell and nested display:contents wrapper do not poison the union', async () => {
        mount(`
            <div x-text="row.n"></div>
            <div style="display: none">hidden</div>
            <div style="display: contents"><template x-if="false"><span></span></template><div>c</div></div>`, 336)
        await settle()
        const t = totalHeight()
        expect(t).toBeGreaterThan(336 * ROW_H / 2)
        expect(t).toBeLessThan(336 * ROW_H * 2)
        await scrollToEnd()
        expect(rowsInDom().at(-1).firstElementChild.textContent).toBe('335')
    })

    it('a row with no boxed children keeps the estimate instead of measuring 0 or -Infinity', async () => {
        mount(`<template x-if="false"><div></div></template>`, 200)
        await settle()
        expect(totalHeight()).toBe(200 * 44)
    })
})

describe('x-virtual mounted while hidden', { timeout: 20000 }, () => {
    it('grid container under x-show=false resolves its kind once shown', async () => {
        const N = 1000
        const host = mount(NESTED, N, { hidden: true })
        await settle(3)
        expect(scroller.style.display).toBe('none')
        expect(rowsInDom().length).toBe(0)

        Alpine.$data(host.firstElementChild).shown = true
        await Alpine.nextTick()
        resize()
        await settle()
        for (const sp of spacers()) expect(sp.style.gridColumn).toBe('1 / -1')
        expect(rowsInDom().length).toBeGreaterThan(0)
        expect(rowsInDom().length).toBeLessThan(40)
        const t = totalHeight()
        expect(t).toBeGreaterThan(N * ROW_H / 2)
        expect(t).toBeLessThan(N * ROW_H * 2)

        await scrollToEnd()
        expect(rowsInDom().at(-1).querySelector('.freeze-1').textContent).toBe(String(N - 1))
        expect(totalHeight()).toBeLessThan(N * ROW_H * 2)
    })
})

describe('x-virtual row host inside the scroller (wrapper, like table > tbody)', { timeout: 20000 }, () => {
    const mountTable = (hidden) => {
        const host = document.createElement('div')
        host.innerHTML = `
            <div x-data="{ shown: ${!hidden}, rows: Array.from({ length: 300 }, (_, i) => ({ id: i })) }">
                <div x-show="shown">
                    <div x-virtual style="overflow: auto">
                        <div class="list">
                            <template x-for="row in rows" :key="row.id"><div class="item" x-text="row.id"></div></template>
                        </div>
                    </div>
                </div>
            </div>`
        document.body.appendChild(host)
        const sc = host.querySelector('[x-virtual]')
        Object.defineProperty(sc, 'clientHeight', { configurable: true, get: () => sc.closest('[x-show]').style.display === 'none' ? 0 : VIEW_H })
        Alpine.initTree(host)
        return { host, sc, list: sc.querySelector('.list') }
    }

    it('a visible mount does not re-render when only the row host resizes', async () => {
        const { sc, list } = mountTable(false)
        await settle(4)
        expect(list.querySelectorAll('.item').length).toBeGreaterThan(0)
        let mutations = 0
        const mo = new MutationObserver((l) => { mutations += l.length })
        mo.observe(list, { childList: true })
        resize(list)
        await new Promise((r) => setTimeout(r, 200))
        await settle(2)
        mo.disconnect()
        expect(mutations).toBe(0)
        expect(observers.some((o) => o.targets.has(list))).toBe(false)
        expect(observers.some((o) => o.targets.has(sc))).toBe(true)
    })

    it('a hidden row host is observed until classified, then released', async () => {
        const host = document.createElement('div')
        host.innerHTML = `
            <div x-data="{ shown: false, rows: Array.from({ length: 300 }, (_, i) => ({ id: i })) }">
                <div x-virtual style="overflow: auto">
                    <div class="list" style="display: none">
                        <template x-for="row in rows" :key="row.id"><div class="item" x-text="row.id"></div></template>
                    </div>
                </div>
            </div>`
        document.body.appendChild(host)
        const sc = host.querySelector('[x-virtual]')
        Object.defineProperty(sc, 'clientHeight', { configurable: true, get: () => VIEW_H })
        Alpine.initTree(host)
        const list = sc.querySelector('.list')
        await settle(3)
        expect(list.querySelectorAll('.item').length).toBe(0)
        expect(observers.some((o) => o.targets.has(list))).toBe(true)

        list.style.display = ''
        resize(list)
        await settle(4)
        expect(list.querySelectorAll('.item').length).toBeGreaterThan(0)
        expect(observers.some((o) => o.targets.has(list))).toBe(false)
    })
})
