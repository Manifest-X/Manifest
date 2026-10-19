/**
 * @vitest-environment happy-dom
 *
 * Category x-axis density: long daily ranges (90/365/900 points) drew one label
 * per point and overlapped into a smear. Labels are now thinned evenly to fit the
 * measured width (first + last kept, equal gaps), authors can pick their own
 * `ticks`, dense line/area charts drop per-point dots for hover columns, and
 * tooltips carry the point's full label as a heading.
 *
 * d3 is stubbed with minimal scale/shape implementations (loadD3 short-circuits
 * on window.__manifestD3). happy-dom has no text metrics, so labelWidth falls
 * back to 7px per character — the assertions below use the same estimate.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

window.IntersectionObserver = class {
    constructor(cb) { this._cb = cb }
    observe(el) { this._cb([{ isIntersecting: true, target: el, checkVisibility: () => true }], this) }
    unobserve() { }
    disconnect() { }
}
window.ResizeObserver = class { observe() { } unobserve() { } disconnect() { } }

function scaleLinear() {
    let d = [0, 1], r = [0, 1]
    const s = v => r[0] + (v - d[0]) / (d[1] - d[0]) * (r[1] - r[0])
    s.domain = x => x ? (d = x, s) : d
    s.range = x => x ? (r = x, s) : r
    s.nice = () => s
    s.ticks = n => Array.from({ length: n + 1 }, (_, i) => d[0] + (d[1] - d[0]) * i / n)
    return s
}
function ordinal(point) {
    let d = [], idx = new Map(), r = [0, 1], p = 0
    const step = () => point ? (r[1] - r[0]) / Math.max(1, d.length - 1 + 2 * p) : (r[1] - r[0]) / (d.length + p)
    const s = v => idx.has(v) ? r[0] + p * step() + idx.get(v) * step() : undefined
    s.domain = x => { d = x; idx = new Map(x.map((v, i) => [v, i])); return s }
    s.range = x => (r = x, s)
    s.padding = x => (p = x, s)
    s.step = step
    s.bandwidth = () => point ? 0 : step() * (1 - p)
    return s
}
function shape() {
    const g = pts => 'M' + pts.map(q => g._x(q) + ',' + g._y(q)).join('L')
    g._x = q => q[0]; g._y = q => q[1]
    g.x = f => (g._x = f, g); g.y = f => (g._y = f, g); g.y0 = () => g; g.y1 = f => (g._y = f, g); g.curve = () => g
    return g
}
window.__manifestD3 = {
    scaleLinear, scaleBand: () => ordinal(false), scalePoint: () => ordinal(true),
    line: shape, area: shape, curveMonotoneX: {}, curveLinear: {}
}
window.ManifestUI = { resolve: () => ({}) }

window.Alpine = Alpine
await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.charts.js'), 'utf8')
))
window.ensureChartsPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }

const days = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10))

async function render(cfg, width = 800) {
    const host = document.createElement('div')
    host.innerHTML = '<div x-chart="cfg"></div>'
    host.setAttribute('x-data', '{ cfg: ' + JSON.stringify(cfg) + ' }')
    document.body.appendChild(host)
    const el = host.querySelector('[x-chart]')
    Object.defineProperty(el, 'clientWidth', { value: width, configurable: true })
    Alpine.initTree(host)
    await settle()
    return el
}

const xLabels = (el) => [...el.querySelectorAll('svg text[text-anchor="middle"]')]
    .map(t => ({ s: t.textContent, x: Number(t.getAttribute('x')) }))
    .sort((a, b) => a.x - b.x)

beforeAll(() => { Alpine.start() })

describe('category x-axis thinning', () => {
    it('365 daily labels at 800px: bounded, non-overlapping, first and last included', async () => {
        const labels = days(365)
        const el = await render({ type: 'area', labels, series: [{ name: 'Visitors', data: labels.map((_, i) => i % 50) }], height: 220 })
        const xs = xLabels(el)
        expect(xs.length).toBeGreaterThan(2)
        expect(xs.length).toBeLessThanOrEqual(12)
        expect(xs[0].s).toBe(labels[0])
        expect(xs[xs.length - 1].s).toBe(labels[364])
        for (let i = 1; i < xs.length; i++) {
            const gap = xs[i].x - xs[i - 1].x
            expect(gap).toBeGreaterThanOrEqual((xs[i].s.length + xs[i - 1].s.length) * 7 / 2)
        }
        // Inside the 800px frame (plot is translated by the 40px left margin).
        for (const l of xs) {
            expect(l.x + 40 - l.s.length * 3.5).toBeGreaterThanOrEqual(0)
            expect(l.x + 40 + l.s.length * 3.5).toBeLessThanOrEqual(800)
        }
    })

    it('365 daily labels at 800px: gaps are equal to within one point step', async () => {
        const labels = days(365)
        const el = await render({ type: 'line', labels, series: [{ data: labels.map((_, i) => i) }] })
        const xs = xLabels(el)
        expect(xs[0].s).toBe(labels[0])
        expect(xs[xs.length - 1].s).toBe(labels[364])
        const step = (xs[xs.length - 1].x - xs[0].x) / 364
        const gaps = xs.slice(1).map((l, i) => l.x - xs[i].x)
        expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(step + 1e-6)
        for (const l of xs) expect(l.x + 40 + l.s.length * 3.5).toBeLessThanOrEqual(800)
    })

    it('900+ points stays bounded and the line still draws every value', async () => {
        const labels = days(930)
        const el = await render({ type: 'line', labels, series: [{ data: labels.map((_, i) => i) }] })
        expect(xLabels(el).length).toBeLessThanOrEqual(12)
        const d = el.querySelector('path.line').getAttribute('d')
        expect(d.split('L').length).toBe(930)
    })

    it('7 labels that fit all render', async () => {
        const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        const el = await render({ type: 'line', labels, series: [{ data: [3, 5, 2, 8, 6, 4, 7] }] })
        expect(xLabels(el).map(l => l.s)).toEqual(labels)
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(7)
    })

    it('thins bar chart labels too', async () => {
        const labels = days(90)
        const el = await render({ type: 'bar', labels, series: [{ data: labels.map(() => 1) }] })
        const xs = xLabels(el)
        expect(xs.length).toBeLessThan(90)
        expect(xs[0].s).toBe(labels[0])
        expect(el.querySelectorAll('rect').length).toBe(90)
    })
})

const monthStarts = (labels) => {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return labels.flatMap((d, i) => d.endsWith('-01') ? [{ at: i, label: names[Number(d.slice(5, 7)) - 1] }] : [])
}

describe('author ticks', () => {
    it('draws only the given ticks with their labels, at their points', async () => {
        const labels = days(365)
        const ticks = monthStarts(labels)
        const el = await render({ type: 'area', labels, ticks, series: [{ name: 'Visitors', data: labels.map((_, i) => i) }] })
        const xs = xLabels(el)
        expect(xs.map(l => l.s)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
        const step = (xs[11].x - xs[0].x) / (ticks[11].at - ticks[0].at)
        xs.forEach((l, k) => expect(l.x - xs[0].x).toBeCloseTo((ticks[k].at - ticks[0].at) * step, 6))
    })

    it('tooltip heading is still the full label', async () => {
        const labels = days(365)
        const el = await render({ type: 'line', labels, ticks: monthStarts(labels), series: [{ name: 'Visitors', data: labels.map((_, i) => i) }] })
        el.querySelectorAll('rect.hit')[45].dispatchEvent(new MouseEvent('mouseenter', { clientX: 100, clientY: 50 }))
        expect(el.querySelector('.tooltip strong').textContent).toBe(labels[45])
    })

    it('plain indices use labels[at]; out-of-range and duplicates are ignored', async () => {
        const labels = days(30)
        const el = await render({ type: 'bar', labels, ticks: [20, 0, 10, 10, 99, -1], series: [{ data: labels.map(() => 1) }] })
        expect(xLabels(el).map(l => l.s)).toEqual([labels[0], labels[10], labels[20]])
    })

    it('dense ticks are thinned evenly without overlap, first and last kept', async () => {
        const labels = days(365)
        const ticks = labels.map((d, i) => ({ at: i, label: i % 2 ? d : 'W' + i }))
        const el = await render({ type: 'line', labels, ticks, series: [{ data: labels.map((_, i) => i) }] })
        const xs = xLabels(el)
        expect(xs.length).toBeGreaterThan(2)
        expect(xs.length).toBeLessThan(365)
        expect(xs[0].s).toBe('W0')
        expect(xs[xs.length - 1].s).toBe('W364')
        for (let i = 1; i < xs.length; i++) {
            expect(xs[i].x - xs[i - 1].x).toBeGreaterThanOrEqual((xs[i].s.length + xs[i - 1].s.length) * 7 / 2)
        }
    })

    it('applies to bar and combo charts', async () => {
        const labels = days(365)
        const ticks = monthStarts(labels)
        const bar = await render({ type: 'bar', labels, ticks, series: [{ data: labels.map(() => 1) }] })
        expect(xLabels(bar).map(l => l.s)[0]).toBe('Jan')
        expect(xLabels(bar).length).toBe(12)
        const combo = await render({
            type: 'combo', labels, ticks, series: [
                { name: 'Orders', type: 'bar', data: labels.map(() => 1) },
                { name: 'Trend', type: 'line', data: labels.map(() => 2) }
            ]
        })
        expect(xLabels(combo).map(l => l.s)).toEqual(ticks.map(t => t.label))
    })
})

describe('index-keyed x scheme', () => {
    const dup = ['Mon', 'Tue', 'Wed', 'Mon', 'Tue', 'Wed']
    const centres = (els) => [...els].map(r => Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2)

    it('bar: duplicate labels get distinct bars, each labelled at its centre', async () => {
        const el = await render({ type: 'bar', labels: dup, series: [{ data: [1, 2, 3, 4, 5, 6] }] })
        const cx = centres(el.querySelectorAll('rect'))
        expect(new Set(cx).size).toBe(6)
        const xs = xLabels(el)
        expect(xs.map(l => l.s)).toEqual(dup)
        xs.forEach((l, i) => expect(l.x).toBeCloseTo(cx[i], 6))
    })

    it('line and scatter: axis labels sit on the points', async () => {
        for (const type of ['line', 'scatter']) {
            const el = await render({ type, labels: dup, series: [{ data: [1, 2, 3, 4, 5, 6] }] })
            const cx = [...el.querySelectorAll('circle:not(.focus)')].map(c => Number(c.getAttribute('cx')))
            expect(new Set(cx).size).toBe(6)
            xLabels(el).forEach((l, i) => expect(l.x).toBeCloseTo(cx[i], 6))
        }
    })

    it('candlestick: axis labels sit on the candles', async () => {
        const el = await render({ type: 'candlestick', labels: dup, series: [{ data: dup.map((_, i) => [i, i + 2, i - 1, i + 1]) }] })
        const cx = centres(el.querySelectorAll('rect'))
        expect(new Set(cx).size).toBe(6)
        xLabels(el).forEach((l, i) => expect(l.x).toBeCloseTo(cx[i], 6))
    })

    it('combo: line points sit on the bar centres and the axis labels', async () => {
        const el = await render({
            type: 'combo', labels: dup, series: [
                { name: 'Orders', type: 'bar', data: [1, 2, 3, 4, 5, 6] },
                { name: 'Trend', type: 'line', data: [2, 3, 4, 5, 6, 7] }
            ]
        })
        const bars = centres(el.querySelectorAll('rect'))
        const pts = [...el.querySelectorAll('circle:not(.focus)')].map(c => Number(c.getAttribute('cx')))
        pts.forEach((x, i) => expect(x).toBeCloseTo(bars[i], 6))
        xLabels(el).forEach((l, i) => expect(l.x).toBeCloseTo(bars[i], 6))
    })
})

describe('narrow charts with long end labels', () => {
    const long = Array.from({ length: 12 }, (_, i) => 'Wednesday, September ' + (10 + i) + ', 2026')
    for (const width of [120, 200, 300]) {
        it(`${width}px: no negative widths, plot keeps a positive width`, async () => {
            const bar = await render({ type: 'bar', labels: long, series: [{ data: long.map((_, i) => i + 1) }] }, width)
            for (const r of bar.querySelectorAll('rect')) {
                expect(Number(r.getAttribute('width'))).toBeGreaterThanOrEqual(0)
                expect(Number(r.getAttribute('height'))).toBeGreaterThanOrEqual(0)
            }
            const line = await render({ type: 'line', labels: long, series: [{ data: long.map((_, i) => i + 1) }] }, width)
            const xs = line.querySelector('path.line').getAttribute('d').slice(1).split('L').map(p => Number(p.split(',')[0]))
            expect(xs[xs.length - 1] - xs[0]).toBeGreaterThan(0)
            expect(xLabels(line).length).toBeGreaterThanOrEqual(1)
        })
    }
})

describe('ticks validation', () => {
    it('accepts only finite numbers and numeric strings', async () => {
        const labels = ['a', 'b', 'c', 'd', 'e']
        const el = await render({ type: 'bar', labels, ticks: [null, false, '', [], true, '2', 3, NaN, { at: null }], series: [{ data: [1, 2, 3, 4, 5] }] })
        expect(xLabels(el).map(l => l.s)).toEqual(['c', 'd'])
    })

    it('an empty ticks array hides the x labels', async () => {
        const el = await render({ type: 'line', labels: ['a', 'b', 'c'], ticks: [], series: [{ data: [1, 2, 3] }] })
        expect(xLabels(el).length).toBe(0)
    })
})

describe('map height default', () => {
    it('800px map without height sizes from width (416px)', async () => {
        const proj = () => null
        window.__manifestGeo = {
            world: { objects: { countries: {} } }, meta: {},
            topojson: { feature: () => ({ features: [] }) },
            geoNaturalEarth1: () => ({ fitSize: () => proj }),
            geoPath: () => () => ''
        }
        try {
            const el = await render({ type: 'map', data: {} })
            expect(el.style.minHeight).toBe('416px')
            expect(el.querySelector('svg').getAttribute('height')).toBe('416')
        } finally { delete window.__manifestGeo }
    })
})

describe('height default', () => {
    it('missing height falls back to 240', async () => {
        const el = await render({ type: 'bar', labels: ['a', 'b'], series: [{ data: [1, 2] }] })
        expect(el.querySelector('svg').getAttribute('height')).toBe('240')
        for (const r of el.querySelectorAll('rect')) expect(Number(r.getAttribute('height') || 0)).toBeGreaterThanOrEqual(0)
    })
})

describe('dense points + tooltip heading', () => {
    it('drops per-point dots when spacing is tight, hover columns still tooltip', async () => {
        const labels = days(365)
        const el = await render({ type: 'area', labels, series: [{ name: 'Visitors', data: labels.map((_, i) => i) }] })
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(0)
        const hits = el.querySelectorAll('rect.hit')
        expect(hits.length).toBe(365)
        hits[100].dispatchEvent(new MouseEvent('mouseenter', { clientX: 300, clientY: 50 }))
        const tip = el.querySelector('.tooltip')
        expect(tip.querySelector('strong').textContent).toBe(labels[100])
        expect(tip.textContent).toContain('Visitors: 100')
        expect(el.querySelector('circle.focus').hasAttribute('display')).toBe(false)
        hits[100].dispatchEvent(new MouseEvent('mouseleave'))
        expect(el.querySelector('circle.focus').getAttribute('display')).toBe('none')
    })

    it('point tooltip shows the label as its heading', async () => {
        const labels = ['Mon', 'Tue', 'Wed']
        const el = await render({ type: 'line', labels, series: [{ name: 'Sales', data: [1, 2, 3] }] })
        const dot = el.querySelectorAll('circle')[1]
        expect(dot.getAttribute('aria-label')).toBe('Tue · Sales: 2')
        dot.dispatchEvent(new MouseEvent('mouseenter', { clientX: 100, clientY: 50 }))
        const tip = el.querySelector('.tooltip')
        expect(tip.querySelector('strong').textContent).toBe('Tue')
        expect(tip.textContent).toContain('Sales: 2')
    })

    it('omits the heading when the chart has no labels', async () => {
        const el = await render({ type: 'line', series: [{ name: 'Sales', data: [1, 2, 3] }] })
        const dot = el.querySelectorAll('circle')[1]
        expect(dot.getAttribute('aria-label')).toBe('Sales: 2')
        dot.dispatchEvent(new MouseEvent('mouseenter', { clientX: 100, clientY: 50 }))
        const tip = el.querySelector('.tooltip')
        expect(tip.querySelector('strong')).toBeNull()
        expect(tip.textContent).toBe('Sales: 2')
    })

    it('mousemove over the same target repositions without rebuilding', async () => {
        const labels = days(365)
        const el = await render({ type: 'line', labels, series: [{ data: labels.map((_, i) => i) }] })
        const hit = el.querySelectorAll('rect.hit')[5]
        hit.dispatchEvent(new MouseEvent('mouseenter', { clientX: 10, clientY: 50 }))
        const head = el.querySelector('.tooltip strong')
        hit.dispatchEvent(new MouseEvent('mousemove', { clientX: 12, clientY: 60 }))
        expect(el.querySelector('.tooltip strong')).toBe(head)
        expect(el.querySelector('.tooltip').style.top).toBe('60px')
    })

    it('hover columns are transparent inline, so unlayered rect fills cannot paint them', async () => {
        const labels = days(200)
        const el = await render({ type: 'area', labels, series: [{ data: labels.map(() => 1) }] })
        const hit = el.querySelector('rect.hit')
        expect(hit.getAttribute('style')).toContain('fill:transparent')
    })

    it('dense combo: one tooltip lists bar and line values, and highlights the bars', async () => {
        const labels = days(365)
        const el = await render({
            type: 'combo', labels, series: [
                { name: 'Orders', type: 'bar', data: labels.map((_, i) => i) },
                { name: 'Trend', type: 'line', data: labels.map((_, i) => i * 2) }
            ]
        })
        const hit = el.querySelectorAll('rect.hit')[10]
        hit.dispatchEvent(new MouseEvent('mouseenter', { clientX: 50, clientY: 50 }))
        const tip = el.querySelector('.tooltip')
        expect(tip.querySelector('strong').textContent).toBe(labels[10])
        expect(tip.textContent).toContain('Orders: 10')
        expect(tip.textContent).toContain('Trend: 20')
        expect(el.querySelectorAll('circle.focus').length).toBe(1)
        const active = el.querySelectorAll('rect.active')
        expect(active.length).toBe(1)
        expect(active[0].getAttribute('aria-label')).toBe(labels[10] + ' · Orders: 10')
        hit.dispatchEvent(new MouseEvent('mouseleave'))
        expect(el.querySelectorAll('rect.active').length).toBe(0)
    })
})
