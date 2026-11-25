/**
 * @vitest-environment happy-dom
 *
 * x-defer gesture churn: with more near containers than the warm cap, a gesture that
 * reveals nothing renders and evicts nothing (no re-promotion of already-showing or
 * evicted containers, no ping-pong), a pane that a gesture reveals still promotes,
 * an evicted container renders on open, and keydowns do not walk the pending set.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { budget } from './helpers/time-budget.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CAP = 6
window.ManifestDeferConfig = { prewarmCap: CAP }

const idleQueue = []
let idleId = 0
window.requestIdleCallback = (fn) => { const id = ++idleId; idleQueue.push({ id, fn }); return id }
window.cancelIdleCallback = (id) => { const i = idleQueue.findIndex((x) => x.id === id); if (i >= 0) idleQueue.splice(i, 1) }
const BATCH = { didTimeout: false, timeRemaining: () => 50 }
const drain = () => { let n = 0; while (idleQueue.length) { if (n++ > 1000) throw new Error('idle queue never empties: ' + JSON.stringify(window.ManifestDefer.stats())); idleQueue.shift().fn(BATCH) } }

// Controllable IntersectionObserver: tests decide what each target reports
const observers = []
window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this) }
    observe(el) { this.targets.add(el) }
    unobserve(el) { this.targets.delete(el) }
    disconnect() { this.targets.clear() }
}
const NEAR = { top: 40, bottom: 60, left: 10, right: 110, width: 100, height: 20 }
const NONE = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
const shownPane = { on: false }
// Everything is on screen except the pane's contents while the pane is "display: none"
function report() {
    for (const io of observers) {
        const entries = Array.from(io.targets).map((target) => {
            const r = !shownPane.on && target.closest('#pane') ? NONE : NEAR
            return { target, boundingClientRect: r, isIntersecting: r.width > 0 }
        })
        if (entries.length) io.cb(entries)
    }
}

window.__manifestLoaderStarted = true
window.ensureTabsPluginInitialized = () => { }
window.Alpine = Alpine

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.defer.js'), 'utf8')
))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const menus = (n, prefix) => Array.from({ length: n }, (_, i) =>
    `<div class="row"><button popovertarget="${prefix}${i}">...</button><menu popover id="${prefix}${i}"><li>Edit</li><li>Archive</li></menu></div>`).join('')

// Renders = stash templates leaving a container; restashes = stash templates coming back
const churn = { renders: 0, restashes: 0 }
const isStash = (n) => n.nodeType === 1 && n.tagName === 'TEMPLATE' && n.hasAttribute('data-mnfst-defer')
new MutationObserver((list) => {
    for (const m of list) {
        for (const n of m.addedNodes) if (isStash(n) && m.target.__mnfstDefer) churn.restashes++
        for (const n of m.removedNodes) if (isStash(n)) churn.renders++
    }
}).observe(document.body, { childList: true, subtree: true })

const gesture = async (type = 'pointerdown') => {
    document.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { clientX: 50, clientY: 50 }))
    await wait(700) // all three promotion passes (50 / +150 / +400ms)
    drain()
    await wait(0)
}
const counted = async (fn) => { await wait(0); churn.renders = 0; churn.restashes = 0; await fn(); await wait(0); return { ...churn } }

let host
beforeAll(async () => {
    Alpine.start()
    host = document.createElement('div')
    host.setAttribute('x-data', '')
    host.innerHTML = `<div id="list">${menus(20, 'm')}</div><div id="pane">${menus(3, 'p')}</div>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    report()
    window.dispatchEvent(new CustomEvent('manifest:ready'))
    drain()
    await wait(5100) // bootDrained fallback; boot reveals age out of the urgent window
}, budget(10000))
beforeEach(() => { report() })

const st = () => window.ManifestDefer.stats()

describe('plain gestures', () => {
    it('render and evict nothing when warm is at the cap and near containers are pending', async () => {
        expect(st().warm).toBe(CAP)
        expect(st().pending).toBeGreaterThan(CAP)
        const c = await counted(async () => { for (let k = 0; k < 5; k++) await gesture() })
        expect(c).toEqual({ renders: 0, restashes: 0 })
        expect(st().warm).toBe(CAP)
    }, budget(15000))

    it('keydowns do not walk the pending set or read layout', async () => {
        const orig = { closest: Element.prototype.closest, gbcr: Element.prototype.getBoundingClientRect }
        let walks = 0, reads = 0
        Element.prototype.closest = function () { walks++; return orig.closest.apply(this, arguments) }
        Element.prototype.getBoundingClientRect = function () { reads++; return orig.gbcr.apply(this, arguments) }
        try {
            for (let k = 0; k < 30; k++) { document.dispatchEvent(new Event('keydown', { bubbles: true })); await wait(60) }
            await wait(700)
        } finally {
            Element.prototype.closest = orig.closest
            Element.prototype.getBoundingClientRect = orig.gbcr
        }
        expect(walks).toBe(0)
        expect(reads).toBe(0)
        expect(idleQueue.length).toBe(0)
    }, budget(15000))
})

describe('scrolled in', () => {
    it('a container scrolled on screen around a gesture is not promoted', async () => {
        await wait(1600) // outside the last gesture's urgent window, so mounting is not urgent
        const row = document.createElement('div')
        row.innerHTML = menus(1, 's')
        host.querySelector('#list').appendChild(row)
        Alpine.initTree(row)
        const menu = row.querySelector('menu'), btn = row.querySelector('button')
        const at = (r) => observers.forEach((io) => io.targets.has(btn) && io.cb([{ target: btn, boundingClientRect: r, isIntersecting: r.top < window.innerHeight }]))
        at({ top: 5000, bottom: 5020, left: 10, right: 110, width: 100, height: 20 }) // below the fold
        const c = await counted(async () => {
            document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { clientX: 50, clientY: 50 }))
            at(NEAR) // scrolled in while the promotion passes run
            await wait(700)
            drain()
        })
        expect(menu.__mnfstDefer.urgent).toBe(false)
        expect(window.ManifestDefer.isPending(menu)).toBe(true)
        expect(c).toEqual({ renders: 0, restashes: 0 })
    }, budget(10000))
})

describe('revealed pane', () => {
    it('a gesture that shows a pane promotes its menus past the cap, then warm returns to the cap', async () => {
        const pane = Array.from(host.querySelectorAll('#pane menu'))
        expect(pane.every((m) => window.ManifestDefer.isPending(m))).toBe(true)
        const c = await counted(async () => {
            document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { clientX: 50, clientY: 50 }))
            shownPane.on = true
            report() // the pane lays out: its invokers get a box
            await wait(700)
            expect(pane.every((m) => m.__mnfstDefer.urgent)).toBe(true)
            drain()
        })
        expect(pane.every((m) => !window.ManifestDefer.isPending(m))).toBe(true)
        expect(c.renders).toBe(pane.length)
        expect(c.restashes).toBe(pane.length) // evicted to make room, never the pane's own
        expect(st().warm).toBe(CAP)
    }, budget(10000))

    it('evicted containers are not promoted again: later gestures do not ping-pong', async () => {
        const evicted = Array.from(host.querySelectorAll('#list menu')).filter((m) => m.__mnfstDefer.evicted)
        expect(evicted.length).toBeGreaterThan(0)
        const c = await counted(async () => { for (let k = 0; k < 4; k++) await gesture() })
        expect(c).toEqual({ renders: 0, restashes: 0 })
        expect(evicted.every((m) => window.ManifestDefer.isPending(m))).toBe(true)
        expect(st().warm).toBe(CAP)
    }, budget(15000))

    it('an evicted container renders on open', () => {
        const menu = Array.from(host.querySelectorAll('#list menu')).find((m) => m.__mnfstDefer.evicted)
        menu.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' }))
        expect(menu.querySelectorAll('li').length).toBe(2)
        expect(window.ManifestDefer.isPending(menu)).toBe(false)
    })

    it('a slot freed by an open lets plain prewarm refill to the cap, never past it', async () => {
        drain()
        expect(st().warm).toBe(CAP) // the open above took a stashed container: warm unchanged
        const warmMenu = Array.from(host.querySelectorAll('menu')).find((m) => m.__mnfstDefer.rendered && m.__mnfstDefer.pristine)
        warmMenu.dispatchEvent(Object.assign(new Event('beforetoggle'), { newState: 'open' })) // opened: leaves warm
        expect(st().warm).toBe(CAP - 1)
        const c = await counted(async () => { drain() })
        expect(c).toEqual({ renders: 1, restashes: 0 })
        expect(st().warm).toBe(CAP)
    })
})
