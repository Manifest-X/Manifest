/**
 * @vitest-environment happy-dom
 *
 * x-defer gesture follow-ups: a re-anchor to a late-found invoker is not a reveal; slots freed
 * inside a gesture window are not refilled by plain prewarm; a real reveal or a navigation
 * clears the evicted flag; a restarted pass chain keeps pending reveals; a details element
 * keeps its summary out of the stash.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { budget } from './helpers/time-budget.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CAP = 4
window.ManifestDeferConfig = { prewarmCap: CAP }

const idleQueue = []
let idleId = 0
window.requestIdleCallback = (fn) => { const id = ++idleId; idleQueue.push({ id, fn }); return id }
window.cancelIdleCallback = (id) => { const i = idleQueue.findIndex((x) => x.id === id); if (i >= 0) idleQueue.splice(i, 1) }
const BATCH = { didTimeout: false, timeRemaining: () => 50 }
const drain = () => { let n = 0; while (idleQueue.length) { if (n++ > 1000) throw new Error('idle queue never empties'); idleQueue.shift().fn(BATCH) } }

// Controllable IntersectionObserver: elements inside a [data-off] subtree have no box
const observers = []
window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this) }
    observe(el) { this.targets.add(el) }
    unobserve(el) { this.targets.delete(el) }
    disconnect() { this.targets.clear() }
}
const NEAR = { top: 40, bottom: 60, left: 10, right: 110, width: 100, height: 20 }
const NONE = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
function report() {
    for (const io of observers) {
        const entries = Array.from(io.targets).map((target) => {
            const r = target.closest('[data-off]') ? NONE : NEAR
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
    `<div><button popovertarget="${prefix}${i}">...</button><menu popover id="${prefix}${i}"><li>Edit</li></menu></div>`).join('')
function mount(html, parent = document.body) {
    const host = document.createElement('div')
    host.innerHTML = html
    parent.appendChild(host)
    Alpine.initTree(host)
    return host
}
const pointer = () => document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { clientX: 50, clientY: 50 }))
const st = () => window.ManifestDefer.stats()

const churn = { renders: 0, restashes: 0 }
const isStash = (n) => n.nodeType === 1 && n.tagName === 'TEMPLATE' && n.hasAttribute('data-mnfst-defer')
new MutationObserver((list) => {
    for (const m of list) {
        for (const n of m.addedNodes) if (isStash(n) && m.target.__mnfstDefer) churn.restashes++
        for (const n of m.removedNodes) if (isStash(n)) churn.renders++
    }
}).observe(document.body, { childList: true, subtree: true })
const counted = async (fn) => { await wait(0); churn.renders = 0; churn.restashes = 0; await fn(); await wait(0); return { ...churn } }

let filler
beforeAll(async () => {
    Alpine.start()
    filler = mount(menus(CAP, 'f'))
    report()
    window.dispatchEvent(new CustomEvent('manifest:ready'))
    drain()
    await wait(5100) // bootDrained fallback
}, budget(10000))

describe('late-found invokers', () => {
    it('re-anchoring a record to an invoker found on the next gesture is not a reveal', async () => {
        expect(st().warm).toBe(CAP)
        // Ids bound after registration (x-for rows with :id / :popovertarget)
        const host = mount(`<div>${Array.from({ length: 6 }, (_, i) => `<div><button popovertarget="late${i}">...</button><menu popover><li>x</li></menu></div>`).join('')}</div>`)
        host.querySelectorAll('menu').forEach((m, i) => { m.id = 'late' + i })
        report()
        drain()
        await wait(1600)
        const recs = Array.from(host.querySelectorAll('menu')).map((m) => m.__mnfstDefer)
        expect(recs.every((r) => !r.rendered && !r.invoker)).toBe(true)
        const c = await counted(async () => {
            pointer()
            await wait(80)   // first pass re-anchors to the invokers
            report()         // the observer's first report for each new anchor
            await wait(700)
            drain()
        })
        expect(recs.every((r) => r.invoker && r.invoker.tagName === 'BUTTON')).toBe(true)
        expect(recs.some((r) => r.urgent)).toBe(false)
        expect(c).toEqual({ renders: 0, restashes: 0 })
    }, budget(10000))
})

describe('gesture window', () => {
    it('a warm slot freed during a gesture is not refilled by plain prewarm until the window ends', async () => {
        await wait(1600)
        expect(st().warm).toBe(CAP)
        expect(st().pending).toBeGreaterThan(0)
        const c1 = await counted(async () => {
            pointer()
            filler.querySelector('menu').parentElement.remove() // a panel menu removed by the click
            await wait(0)
            expect(st().warm).toBe(CAP - 1)
            await wait(700)
            drain()
        })
        expect(c1).toEqual({ renders: 0, restashes: 0 })
        await wait(1000)
        const c2 = await counted(async () => { drain() })
        expect(c2).toEqual({ renders: 1, restashes: 0 })
        expect(st().warm).toBe(CAP)
    }, budget(10000))
})

describe('evicted flag', () => {
    it('a hidden pane shown again makes its evicted containers promotable', async () => {
        await wait(1600)
        const host = mount(`<div data-off id="hp">${menus(2, 'hp')}</div>`)
        report()
        drain()
        const recs = Array.from(host.querySelectorAll('menu')).map((m) => m.__mnfstDefer)
        expect(recs.every((r) => !r.rendered)).toBe(true)
        recs.forEach((r) => { r.evicted = true }) // evicted in an earlier session of churn
        await wait(1600)
        pointer()
        host.firstElementChild.removeAttribute('data-off') // the click shows the pane
        report()
        await wait(700)
        expect(recs.every((r) => !r.evicted && r.urgent)).toBe(true)
        drain()
        expect(recs.every((r) => r.rendered)).toBe(true)
    }, budget(10000))

    it('a navigation clears the evicted flag', () => {
        const host = mount(menus(1, 'nav'))
        const rec = host.querySelector('menu').__mnfstDefer
        rec.evicted = true
        window.dispatchEvent(new CustomEvent('manifest:route-change'))
        expect(rec.evicted).toBe(false)
    })
})

describe('restarted pass chain', () => {
    it('a second gesture 350ms after the first keeps a reveal that landed between them', async () => {
        await wait(1600)
        drain()
        const host = mount(`<div data-off>${menus(2, 'dbl')}</div>`)
        report()
        drain()
        await wait(1600)
        const recs = Array.from(host.querySelectorAll('menu')).map((m) => m.__mnfstDefer)
        pointer()
        await wait(250)
        host.firstElementChild.removeAttribute('data-off')
        report() // revealed after the first gesture's second pass
        await wait(100)
        pointer() // restarts the passes before the first chain's last pass
        await wait(700)
        expect(recs.every((r) => r.urgent)).toBe(true)
    }, budget(10000))
})

describe('details', () => {
    it('keeps its summary out of the stash, initialized, through render and eviction', async () => {
        const host = mount(`<div x-data="{ label: 'Filters' }"><details id="dt"><summary x-text="label">x</summary><p x-init="window.__dt = (window.__dt || 0) + 1">body</p></details></div>`)
        const dt = host.querySelector('#dt')
        const rec = dt.__mnfstDefer
        expect(rec).toBeTruthy()
        expect(dt.firstElementChild.tagName).toBe('SUMMARY')
        expect(dt.firstElementChild.textContent).toBe('Filters')
        expect(rec.tpl.content.querySelector('summary')).toBeNull()
        expect(window.__dt).toBeUndefined()
        dt.setAttribute('open', '')
        await wait(0)
        expect(window.__dt).toBe(1)
        expect(Array.from(dt.children).map((c) => c.tagName)).toEqual(['SUMMARY', 'P'])
        // Discard-style teardown keeps the summary live
        const d2 = mount(`<div x-data="{ label: 'More' }"><details x-defer.discard id="dt2"><summary x-text="label">x</summary><p>body</p></details></div>`).querySelector('#dt2')
        d2.setAttribute('open', ''); await wait(0)
        d2.removeAttribute('open'); await wait(0)
        expect(Array.from(d2.children).map((c) => c.tagName)).toEqual(['SUMMARY', 'TEMPLATE'])
        expect(d2.firstElementChild.textContent).toBe('More')
        Alpine.$data(d2).label = 'Less'
        await wait(0)
        expect(d2.firstElementChild.textContent).toBe('Less')
    })

    it('a details with only a summary is left alone', () => {
        const host = mount(`<div x-data><details id="only"><summary>S</summary></details></div>`)
        expect(host.querySelector('#only').__mnfstDefer).toBeFalsy()
    })
})
