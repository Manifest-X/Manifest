/**
 * @vitest-environment happy-dom
 *
 * $virtual scrollToIndex / scrollToKey: how a list is found, what each call resolves to,
 * and that a list never asked to scroll gets no extra listeners. Positions in a real browser
 * are covered by tests/e2e/virtual-scroll-to.e2e.mjs; here a stacked 40px-row model stands in.
 */
import { readFileSync } from 'fs'
import { it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const frame = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 20)) }
const ROW = 40, VIEW = 200

window.Alpine = Alpine
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

let v, data
const listeners = []
beforeAll(async () => {
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(readFileSync(path.join(dir, '../src/scripts/manifest.virtual.js'), 'utf8')))
    window.ensureVirtualPluginInitialized()
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return ROW } })
    document.body.innerHTML = `<main id=m x-data="{ shown: true, rows: Array.from({length:500},(_,i)=>({id:'r'+i})) }">
        <button id=out></button>
        <div id=list x-virtual="{estimate:40,overscan:1}" style="overflow:auto"><template x-for="row in rows" :key="row.id"><div class=r x-text="row.id"><button class=in></button></div></template></div>
        <div id=other x-virtual style="overflow:auto"><template x-for="row in rows" :key="row.id"><div x-text="row.id"></div></template></div>
    </main>`
    v = document.getElementById('list')
    const add = v.addEventListener
    v.addEventListener = function (type) { listeners.push(type); return add.apply(this, arguments) }
    // Stacked geometry: scroller at 0, host children in order (spacers by style.height, rows ROW)
    const offsetOf = (n) => { let y = 0; for (const c of v.children) { if (c === n) return y; y += c.hasAttribute('data-virtual-spacer') ? parseFloat(c.style.height) || 0 : c.tagName === 'TEMPLATE' ? 0 : ROW } return y }
    const rect = (top, h) => ({ top, bottom: top + h, left: 0, right: 300, width: 300, height: h, x: 0, y: top })
    const orig = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
        if (this === v) return rect(0, VIEW)
        if (this.parentElement === v && this.tagName !== 'TEMPLATE') return rect(offsetOf(this) - v.scrollTop, this.hasAttribute('data-virtual-spacer') ? parseFloat(this.style.height) || 0 : ROW)
        return orig.call(this)
    }
    for (const el of [v, document.getElementById('other')]) {
        let shown = true
        Object.defineProperty(el, 'clientHeight', { configurable: true, get() { return shown ? VIEW : 0 } })
        el.hide = (h) => { shown = !h }
    }
    Object.defineProperty(v, 'scrollHeight', { configurable: true, get() { return offsetOf(null) } })
    let top = 0
    Object.defineProperty(v, 'scrollTop', { configurable: true, get() { return top }, set(y) { top = Math.max(0, Math.min(v.scrollHeight - VIEW, y)); setTimeout(() => v.dispatchEvent(new Event('scroll'))) } })
    v.scrollTo = function (o) { this.scrollTop = o.top }
    Alpine.start()
    await frame()
    data = Alpine.$data(document.getElementById('m'))
})

// Alpine.evaluate awaits a returned promise and gives undefined: take $virtual out, call it here
const api = (expr, el = document.getElementById('out')) => {
    const m = /^\$virtual(?:\((.*?)\))?\.(\w+)\((.*)\)$/.exec(expr)
    const { v: magic, a, args } = Alpine.evaluate(el, `{ v: $virtual, a: [${m[1] ?? ''}], args: [${m[3]}] }`)
    const target = m[1] === undefined ? magic : magic(...a)
    return target[m[2]](...args)
}
const topOf = (id) => { const r = [...v.querySelectorAll('.r')].find(e => e.textContent === id); return r ? r.getBoundingClientRect().top : null }

it('a list that is never asked to scroll adds only its scroll listener', () => {
    expect(listeners).toEqual(['scroll'])
})

it('scrollToIndex puts the row at the top and resolves with it', async () => {
    const el = await api(`$virtual('list').scrollToIndex(250)`)
    expect(el && el.textContent).toBe('r250')
    expect(topOf('r250')).toBe(0)
    expect(v.scrollTop).toBe(250 * ROW)
})

it('aligns center, end and nearest', async () => {
    await api(`$virtual('list').scrollToIndex(100, { align: 'center' })`)
    expect(topOf('r100')).toBe((VIEW - ROW) / 2)
    await api(`$virtual('list').scrollToIndex(300, { align: 'end' })`)
    expect(topOf('r300')).toBe(VIEW - ROW)
    const before = v.scrollTop
    await api(`$virtual('list').scrollToIndex(298, { align: 'nearest' })`)
    expect(v.scrollTop).toBe(before)
    await api(`$virtual('list').scrollToIndex(310, { align: 'nearest' })`)
    expect(topOf('r310')).toBe(VIEW - ROW)
})

it('offset leaves room above the row', async () => {
    await api(`$virtual('list').scrollToIndex(50, { offset: 20 })`)
    expect(topOf('r50')).toBe(20)
})

it('clamps at the end of the list', async () => {
    const el = await api(`$virtual('list').scrollToIndex(499)`)
    expect(el.textContent).toBe('r499')
    expect(v.scrollTop).toBe(500 * ROW - VIEW)
})

it('scrollToKey follows the item, and finds an item added in the same tick', async () => {
    const el = await api(`$virtual('list').scrollToKey('r77')`)
    expect(el.textContent).toBe('r77')
    data.rows.push({ id: 'new' })
    const added = await api(`$virtual('list').scrollToKey('new')`)
    expect(added && added.textContent).toBe('new')
})

it('resolves null and warns for an index out of range, a bad index or an unknown key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const st = v.scrollTop
    for (const expr of [`scrollToIndex(9999)`, `scrollToIndex(-1)`, `scrollToIndex(2.5)`, `scrollToIndex('x3')`, `scrollToKey('nope')`]) {
        expect(await api(`$virtual('list').${expr}`)).toBe(null)
    }
    expect(v.scrollTop).toBe(st)
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith('[x-virtual]')).length).toBe(5)
    warn.mockRestore()
})

it('finds the list around the element, by id or by element; an unknown list resolves null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const inner = v.querySelector('.r')
    expect((await api(`$virtual.scrollToIndex(20)`, inner)).textContent).toBe('r20')
    expect((await api(`$virtual(document.getElementById('list')).scrollToIndex(30)`)).textContent).toBe('r30')
    expect(await api(`$virtual('missing').scrollToIndex(1)`)).toBe(null)
    expect(await api(`$virtual.scrollToIndex(1)`)).toBe(null)
    expect(warn.mock.calls.some(c => String(c[0]).includes('"missing"'))).toBe(true)
    warn.mockRestore()
})

it('a newer call supersedes one in progress, which resolves null', async () => {
    const a = api(`$virtual('list').scrollToIndex(400, { behavior: 'smooth' })`)
    await frame(1)
    const b = api(`$virtual('list').scrollToIndex(10)`)
    expect(await a).toBe(null)
    expect((await b).textContent).toBe('r10')
    expect(topOf('r10')).toBe(0)
})

it('a smooth call lands', async () => {
    const el = await api(`$virtual('list').scrollToIndex(200, { behavior: 'smooth' })`)
    expect(el.textContent).toBe('r200')
    expect(topOf('r200')).toBe(0)
})

it('waits while the list is hidden, then lands', async () => {
    v.hide(true)
    let done = false
    const p = api(`$virtual('list').scrollToIndex(120)`).then((e) => { done = true; return e })
    await frame(4)
    expect(done).toBe(false)
    v.hide(false)
    v.dispatchEvent(new Event('scroll'))   // a render, as showing it would cause
    expect((await p).textContent).toBe('r120')
    expect(topOf('r120')).toBe(0)
})

it('removes its input listeners when done, and does not take focus', async () => {
    const out = document.getElementById('out')
    out.focus()
    const removed = []
    const rm = v.removeEventListener
    v.removeEventListener = function (type) { removed.push(type); return rm.apply(this, arguments) }
    await api(`$virtual('list').scrollToIndex(60)`)
    await frame(30)
    v.removeEventListener = rm
    expect([...new Set(removed)].sort()).toEqual(['touchstart', 'wheel'])
    expect(document.activeElement).toBe(out)
})

it('a scroll key cancels a smooth call; typing in a field does not', async () => {
    const p = api(`$virtual('list').scrollToIndex(450, { behavior: 'smooth' })`)
    await frame(1)
    const input = document.createElement('input'); document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await frame(1)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
    expect(await p).toBe(null)
    input.remove()
})

it('accepts an integer-valued numeric string as an index', async () => {
    expect((await api(`$virtual('list').scrollToIndex('42')`)).textContent).toBe('r42')
})

it('a scroll it did not write cancels a smooth call', async () => {
    const p = api(`$virtual('list').scrollToIndex(450, { behavior: 'smooth' })`)
    await frame(1)
    v.scrollTop = 0
    expect(await p).toBe(null)
    expect(v.scrollTop).toBe(0)
})
