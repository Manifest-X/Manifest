/**
 * @vitest-environment happy-dom
 *
 * Teardown leaks: a removed x-dropdown trigger or x-chart element must not stay reachable.
 *
 * Found in Playcom (staging, mnfst 0.5.258): every inbox chat switch kept ~120-315 listeners and
 * ~430-574 DOM nodes alive after GC, and every analytics page cycle ~54 listeners / ~356 nodes.
 * Heap-snapshot retainer paths pinned three plugin-held references that are never released:
 *
 *   1. x-dropdown.context binds document pointerdown/keydown dismiss listeners through an
 *      AbortController that nothing ever aborts. The closures share the directive's V8 context, so
 *      each one pins its menu, its trigger and both whole subtrees after they are removed.
 *   2. Every trigger adds keydown + toggle (and, with .hover, mouseenter/mouseleave/defer-render)
 *      listeners to its menu with no guard and no removal. A menu that outlives its triggers (one
 *      shared menu, triggers in a re-rendered x-for) collects two closures per trigger ever mounted.
 *   3. x-chart's bindReactive() creates a global Alpine.effect() that cleanup() never releases. It
 *      stays subscribed to the data store's _dataVersion, pinning the chart state and its element
 *      (and redrawing the detached chart on every data change).
 *
 * Listener counts are tracked by wrapping EventTarget.prototype.addEventListener before the plugins
 * load (honouring removeEventListener and AbortSignal), so the assertions count exactly what a
 * removed element leaves behind on long-lived targets.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── listener registry ────────────────────────────────────────────────────────────────────────────
const live = new Map() // target -> Set(record)
const owners = new Set()
for (const t of [document, document.createElement('div'), window]) {
    let o = t; while (o && !Object.prototype.hasOwnProperty.call(o, 'addEventListener')) o = Object.getPrototypeOf(o)
    if (o) owners.add(o)
}
for (const proto of owners) {
    const add0 = proto.addEventListener, rem0 = proto.removeEventListener
    proto.addEventListener = function (type, fn, opts) {
        const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
        const signal = typeof opts === 'object' ? opts?.signal : undefined
        if (signal?.aborted) return
        let set = live.get(this); if (!set) live.set(this, (set = new Set()))
        const rec = { type, fn, capture }
        set.add(rec)
        signal?.addEventListener('abort', () => set.delete(rec), { once: true })
        return add0.call(this, type, fn, opts)
    }
    proto.removeEventListener = function (type, fn, opts) {
        const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
        const set = live.get(this)
        if (set) for (const r of set) if (r.type === type && r.fn === fn && r.capture === capture) { set.delete(r); break }
        return rem0.call(this, type, fn, opts)
    }
}
const count = (t) => live.get(t)?.size || 0

// Popover polyfill (see dropdown-context-longpress.test.js).
const openPopovers = new WeakSet()
const origMatches = Element.prototype.matches
HTMLElement.prototype.showPopover = function () {
    if (openPopovers.has(this)) return
    openPopovers.add(this)
    this.dispatchEvent(Object.assign(new Event('toggle'), { oldState: 'closed', newState: 'open' }))
}
HTMLElement.prototype.hidePopover = function () {
    if (!openPopovers.has(this)) return
    openPopovers.delete(this)
    this.dispatchEvent(Object.assign(new Event('toggle'), { oldState: 'open', newState: 'closed' }))
}
Element.prototype.matches = function (sel) {
    if (sel === ':popover-open') return openPopovers.has(this)
    return origMatches.call(this, sel)
}
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }

window.__manifestLoaderStarted = true
window.Alpine = Alpine
// d3 stub: charts only needs the object to exist for bindReactive(); drawing is not under test.
window.__manifestD3 = {}

const load = (file) => import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/' + file), 'utf8')
))
await load('manifest.dropdowns.js')
await load('manifest.charts.js')
window.ensureDropdownPluginInitialized()
window.ensureChartsPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }

function mount(html, parent = document.body) {
    const host = document.createElement('div')
    host.innerHTML = html
    parent.appendChild(host)
    Alpine.initTree(host)
    return host
}
async function unmount(host) { Alpine.destroyTree(host); host.remove(); await settle() }

beforeAll(() => { Alpine.start() })

describe('x-dropdown teardown', () => {
    it('removing a .context trigger with its menu releases its document listeners', async () => {
        const base = count(document)
        for (let i = 0; i < 20; i++) {
            const host = mount(`<div x-data>
                <div id="t-${i}" x-dropdown.context="m-${i}">row</div>
                <menu popover id="m-${i}"><li>Copy</li></menu>
            </div>`)
            await settle()
            await unmount(host)
        }
        expect(count(document) - base).toBe(0)
    })

    it('control: while mounted, the .context menu does hold document listeners (the count can move)', async () => {
        const base = count(document)
        const host = mount(`<div x-data><div x-dropdown.context="m-ctl">row</div><menu popover id="m-ctl"><li>Copy</li></menu></div>`)
        await settle()
        expect(count(document) - base).toBeGreaterThan(0)
        await unmount(host)
        expect(count(document) - base).toBe(0)
    })

    it('a menu that outlives its triggers does not collect listeners from removed triggers', async () => {
        const keep = mount(`<div x-data><menu popover id="shared"><li>One</li></menu></div>`)
        const menu = keep.querySelector('#shared')
        const first = mount(`<div x-data><button x-dropdown="shared">open</button></div>`)
        await settle()
        const withOne = count(menu)
        for (let i = 0; i < 25; i++) {
            const h = mount(`<div x-data><button x-dropdown="shared">open</button></div>`)
            await settle()
            await unmount(h)
        }
        expect(count(menu)).toBe(withOne)
        await unmount(first)
        await unmount(keep)
    })

    it('a shared .context menu keeps dismissing after its first trigger is removed', async () => {
        const keep = mount(`<div x-data><menu popover id="shared-ctx"><li>One</li></menu></div>`)
        const menu = keep.querySelector('#shared-ctx')
        const a = mount(`<div x-data><div id="ctx-a" x-dropdown.context="shared-ctx">a</div></div>`)
        const b = mount(`<div x-data><div id="ctx-b" x-dropdown.context="shared-ctx">b</div></div>`)
        await settle()
        await unmount(a)
        const trigger = b.querySelector('#ctx-b')
        trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
        await settle()
        expect(menu.matches(':popover-open')).toBe(true)
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        expect(menu.matches(':popover-open')).toBe(false)
        trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
        await settle()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(menu.matches(':popover-open')).toBe(false)
        await unmount(b)
        await unmount(keep)
    })
})

describe('x-chart teardown', () => {
    it('removing an activated chart releases its reactive effect (no redraw after removal)', async () => {
        Alpine.store('data', { _dataVersion: 0 })
        const evals = { n: 0 }
        window.__chartEvals = evals
        const hosts = []
        for (let i = 0; i < 10; i++) {
            const h = mount(`<div x-data="{ cfg() { window.__chartEvals.n++; return { type: 'line', series: [] } } }"><div x-chart="cfg()"></div></div>`)
            hosts.push(h)
        }
        await settle()
        // happy-dom has no IntersectionObserver delivery: activate the way the observer would.
        for (const h of hosts) h.querySelector('[x-chart]')._chartState.activate()
        await settle(10)
        const st = hosts.map((h) => h.querySelector('[x-chart]')._chartState)
        Alpine.store('data')._dataVersion++
        await settle()
        const live1 = evals.n
        expect(live1).toBeGreaterThan(0) // control: mounted charts re-evaluate on a data change
        for (const h of hosts) await unmount(h)
        evals.n = 0
        Alpine.store('data')._dataVersion++
        await settle()
        expect(evals.n).toBe(0)
        expect(st.every((s) => !s._effect)).toBe(true)
    })
})
