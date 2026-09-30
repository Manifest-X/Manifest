/**
 * @vitest-environment happy-dom
 *
 * x-defer gesture promotion on a large page (Playcom Records shape): once an
 * IntersectionObserver has reported, a pointerdown's promotion passes read no
 * layout (0 getBoundingClientRect) and do not re-query invokers per record;
 * evicted urgent containers never ping-pong between render and restash.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const idleQueue = []
let idleId = 0
window.requestIdleCallback = (fn) => { const id = ++idleId; idleQueue.push({ id, fn }); return id }
window.cancelIdleCallback = (id) => { const i = idleQueue.findIndex((x) => x.id === id); if (i >= 0) idleQueue.splice(i, 1) }
const BATCH = { didTimeout: false, timeRemaining: () => 50 }
const drain = () => { let n = 0; while (idleQueue.length) { if (n++ > 1000) throw new Error('idle queue never empties: ' + JSON.stringify(window.ManifestDefer.stats())); idleQueue.shift().fn(BATCH) } return n }

// Controllable IntersectionObserver: tests decide what each anchor reports
const observers = []
window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this) }
    observe(el) { this.targets.add(el) }
    unobserve(el) { this.targets.delete(el) }
    disconnect() { this.targets.clear() }
}
const OFF = { top: 5000, bottom: 5020, left: 0, right: 100, width: 100, height: 20 }
function report(rectFor) {
    for (const io of observers) {
        const entries = Array.from(io.targets).map((target) => {
            const r = rectFor(target) || OFF
            return { target, boundingClientRect: r, isIntersecting: r.bottom > 0 && r.top < window.innerHeight }
        })
        if (entries.length) io.cb(entries)
    }
}

const counts = { gbcr: 0, qs: 0 }
const wrap = (proto, name, key) => { const orig = proto[name]; proto[name] = function () { counts[key]++; return orig.apply(this, arguments) } }
wrap(Element.prototype, 'getBoundingClientRect', 'gbcr')
wrap(Element.prototype, 'querySelector', 'qs')
wrap(Document.prototype, 'querySelector', 'qs')

window.__manifestLoaderStarted = true
window.ensureTabsPluginInitialized = () => { }
window.Alpine = Alpine
window.counts = {}

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.defer.js'), 'utf8')
))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}
const rows = (n, prefix) => Array.from({ length: n }, (_, i) =>
    `<div class="row"><button id="${prefix}b${i}" popovertarget="${prefix}m${i}">...</button><menu popover id="${prefix}m${i}"><li x-init="counts.${prefix} = (counts.${prefix} || 0) + 1">Edit</li></menu></div>`).join('')

beforeAll(async () => {
    Alpine.start()
    window.dispatchEvent(new CustomEvent('manifest:ready'))
    drain()
    await wait(5100) // bootDrained fallback timer
}, 10000)
beforeEach(() => { counts.gbcr = 0; counts.qs = 0 })

describe('gesture promotion geometry', () => {
    it('reads no layout and queries no invokers per record once geometry is observed', async () => {
        const host = mount(`<div x-data>${rows(300, 'g')}</div>`)
        drain() // prewarm fills the cap; the rest stay pending
        const pending = Array.from(host.querySelectorAll('menu')).filter((m) => window.ManifestDefer.isPending(m))
        expect(pending.length).toBeGreaterThan(200)
        // The last 12 invokers sit under the pointer; everything else is off-screen
        const near = new Set(pending.slice(-12).map((m) => document.querySelector(`[popovertarget="${m.id}"]`)))
        report((el) => near.has(el) ? { top: 40, bottom: 60, left: 10, right: 110, width: 100, height: 20 } : null)

        counts.gbcr = 0; counts.qs = 0
        document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { clientX: 50, clientY: 50 }))
        await wait(700) // all three promotion passes (50 / +150 / +400ms)

        expect(counts.gbcr).toBe(0)
        expect(counts.qs).toBeLessThanOrEqual(1)
        const urgent = pending.filter((m) => m.__mnfstDefer.urgent)
        expect(urgent.length).toBeGreaterThanOrEqual(8) // cap per pass; later passes pick up the rest
        expect(urgent.every((m) => near.has(document.querySelector(`[popovertarget="${m.id}"]`)))).toBe(true)
    }, 10000)

    it('falls back to synchronous reads for records the observer has not reported yet', async () => {
        const host = mount(`<div x-data><div id="late-pane"><menu popover id="late-m"><li>x</li></menu></div></div>`)
        const menu = host.querySelector('#late-m')
        host.querySelector('#late-pane').getBoundingClientRect = () => ({ top: 10, bottom: 200, left: 10, right: 300, width: 290, height: 190 })
        document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { clientX: 50, clientY: 50 }))
        await wait(700)
        expect(menu.__mnfstDefer.urgent).toBe(true)
    }, 10000)
})

describe('eviction', () => {
    it('an evicted urgent container does not re-render and re-evict forever', async () => {
        drain()
        const host = mount(`<div x-data>${rows(80, 'e')}</div>`)
        const all = Array.from(host.querySelectorAll('button'))
        const NEAR = { top: 40, bottom: 60, left: 10, right: 110, width: 100, height: 20 }
        all.forEach((b) => { b.getBoundingClientRect = () => NEAR })
        report((el) => all.includes(el) ? NEAR : null)
        // Enough gestures that urgent containers outnumber the warm cap
        for (let k = 0; k < 8; k++) {
            document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { clientX: 50, clientY: 50 }))
            await wait(700)
            drain() // throws if render/evict ping-pongs
        }
        const st = window.ManifestDefer.stats()
        expect(st.warm).toBeLessThanOrEqual(st.cap)
        expect(idleQueue.length).toBe(0)
    }, 30000)
})
