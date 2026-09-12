/**
 * @vitest-environment happy-dom
 *
 * Client report: a chart bound to an expression that reads shared reactive state
 * (realtime rows, presence ticks, staged $x hydration) redraws on every touch of
 * that state even when the resulting config is value-identical — bindReactive()'s
 * Alpine.effect() had no comparison against the previous config. On a map chart
 * (seconds-class draw: topojson.feature + fitSize over ~175 world-atlas polygons,
 * every redraw) this pegs the main thread and Chrome shows the "page unresponsive"
 * dialog. Canvas-cheap chart types hide the problem; it's the map's geometry
 * rebuild that turns "extra redraw" into "hung tab".
 *
 * Two independent fixes, two suites here:
 *  A. A structural config-signature short-circuit in bindReactive()/update() skips
 *     schedule() when the normalized config hasn't actually changed.
 *  B. The map's derived geometry (feature collection, fitted projection, path) is
 *     memoized per element, keyed on [atlas, width, height] — a data-only redraw
 *     reuses it instead of rebuilding from scratch.
 *
 * d3 and the geo atlas are both lazy-loaded from a CDN in real use; both loaders
 * short-circuit to `window.__manifest{D3,Geo}` when already set, so tests stub
 * those instead of hitting the network. IntersectionObserver/ResizeObserver are
 * stubbed the way defer.test.js stubs requestIdleCallback: synchronous and
 * inspectable, since happy-dom has no real layout/intersection engine.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fires isIntersecting synchronously on observe() — real activation would wait for
// a real intersection, but happy-dom never computes one.
window.IntersectionObserver = class {
    constructor(cb) { this._cb = cb }
    observe(el) { this._cb([{ isIntersecting: true, target: el, checkVisibility: () => true }], this) }
    unobserve() { }
    disconnect() { }
}

// Captured so a test can fire a resize for a specific element on demand.
const roInstances = []
window.ResizeObserver = class {
    constructor(cb) { this._cb = cb; roInstances.push(this) }
    observe(el) { this._el = el }
    unobserve() { }
    disconnect() { const i = roInstances.indexOf(this); if (i >= 0) roInstances.splice(i, 1) }
    fire() { this._cb([], this) }
}
const fireResize = (el) => { const ro = roInstances.find(r => r._el === el); if (!ro) throw new Error('no ResizeObserver for element'); ro.fire() }

// loadD3()/loadGeo() both short-circuit when these are already set, so no network
// fetch happens. `{}` is enough for D3 here: the redraw-signature suite stubs
// state.draw() before any real rendering runs, and the map suite only exercises
// drawMap's geometry path (drawChart only requires d3 to be truthy to get there).
window.__manifestD3 = {}

// manifest.localization.js (not loaded here) normally registers the `$locale` magic
// that ManifestUI.resolve() probes as a reactive dependency. Stub resolve() so the
// plugin's own `if (!window.ManifestUI)` guard skips installing that code path —
// the map suite doesn't exercise locale overrides.
window.ManifestUI = { resolve: () => ({}) }

window.Alpine = Alpine
await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.charts.js'), 'utf8')
))
window.ensureChartsPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }

function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

beforeAll(() => { Alpine.start() })
beforeEach(() => { roInstances.length = 0 })

describe('config-signature short-circuit (reactive bind)', () => {
    it('does not redraw when the resolved config is value-identical across effect re-runs', async () => {
        const host = mount(`
            <div x-data="{ n: 0, cfg() { void this.n; return { type: 'line', series: [{ data: [1, 2, 3] }] } } }">
                <div x-chart="cfg()"></div>
            </div>`)
        const el = host.querySelector('[x-chart]')
        const state = el._chartState
        expect(state).toBeTruthy()

        let draws = 0
        state.draw = () => { draws++ }

        await settle() // flush activation (loadD3 microtask) + first effect run + first schedule()
        expect(draws).toBe(1) // first draw is unconditional

        const root = host.querySelector('[x-data]')
        for (let i = 0; i < 5; i++) {
            Alpine.evaluate(root, 'n++') // touches the reactive dep cfg() reads, without changing cfg()'s return value
            await settle()
        }

        // Failing on unpatched master: 6 (1 initial + 5 value-identical re-fires).
        // Passing after the fix: 1 (the 5 re-fires are recognized as no-ops).
        expect(draws).toBe(1)
    })

    it('DOES redraw when the resolved config genuinely changes', async () => {
        const host = mount(`
            <div x-data="{ n: 0, cfg() { return { type: 'line', series: [{ data: [1, 2, this.n] }] } } }">
                <div x-chart="cfg()"></div>
            </div>`)
        const el = host.querySelector('[x-chart]')
        const state = el._chartState
        let draws = 0
        state.draw = () => { draws++ }
        await settle()
        expect(draws).toBe(1)

        const root = host.querySelector('[x-data]')
        for (let i = 1; i <= 3; i++) {
            Alpine.evaluate(root, 'n++')
            await settle()
            expect(draws).toBe(1 + i)
        }
    })

    it('DOES redraw on a locale change even with an unchanged config', async () => {
        const host = mount(`<div x-chart="{ type: 'line', series: [{ data: [1, 2, 3] }] }"></div>`)
        const el = host.querySelector('[x-chart]')
        const state = el._chartState
        let draws = 0
        state.draw = () => { draws++ }
        await settle()
        expect(draws).toBe(1)

        window.dispatchEvent(new Event('localechange'))
        await settle()
        expect(draws).toBe(2)
    })

    it('DOES redraw on a container resize even with an unchanged config', async () => {
        const host = mount(`<div x-chart="{ type: 'line', series: [{ data: [1, 2, 3] }] }"></div>`)
        const el = host.querySelector('[x-chart]')
        const state = el._chartState
        let draws = 0
        state.draw = () => { draws++ }
        await settle()
        expect(draws).toBe(1)

        fireResize(el)
        await settle()
        expect(draws).toBe(2)
    })
})

describe('map geometry memoization', () => {
    it('re-derives the feature collection/projection only when [atlas, width, height] changes', async () => {
        const calls = { feature: 0, fitSize: 0 }
        window.__manifestGeo = {
            topojson: { feature: () => { calls.feature++; return { features: [] } } },
            geoNaturalEarth1: () => ({ fitSize: () => { calls.fitSize++; return {} } }),
            geoPath: () => () => '',
            world: { objects: { countries: { geometries: [] } } },
            meta: { a2: {}, a3: {}, num2a2: {}, members: {}, idToCont: {} }
        }

        const host = mount(`<div x-chart="{ type: 'map', data: {} }"></div>`)
        const el = host.querySelector('[x-chart]')
        const state = el._chartState
        await settle() // first (automatic) draw, at happy-dom's default 0 clientWidth -> width falls back to 600

        expect(calls.feature).toBe(1)
        expect(calls.fitSize).toBe(1)

        // Several data-only redraws at the SAME size: no re-derivation.
        Object.defineProperty(el, 'clientWidth', { value: 600, configurable: true })
        for (let i = 0; i < 4; i++) state.draw()
        expect(calls.feature).toBe(1)
        expect(calls.fitSize).toBe(1)

        // N distinct sizes: one re-derivation each.
        const sizes = [400, 800, 500]
        sizes.forEach((w, i) => {
            Object.defineProperty(el, 'clientWidth', { value: w, configurable: true })
            state.draw()
            expect(calls.feature).toBe(2 + i)
            expect(calls.fitSize).toBe(2 + i)
        })

        // Back to a previously-seen size: still a fresh derivation (cache holds only
        // the most recent size, not a history) — documents current behavior, not a
        // requirement; the redraw-signature suite is what keeps a stable size cheap.
        Object.defineProperty(el, 'clientWidth', { value: 600, configurable: true })
        state.draw()
        expect(calls.feature).toBe(5)
        expect(calls.fitSize).toBe(5)
    })
})
