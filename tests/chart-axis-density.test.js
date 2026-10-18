/**
 * @vitest-environment happy-dom
 *
 * Category x-axis density: long daily ranges (90/365/900 points) drew one label
 * per point and overlapped into a smear. Labels are now thinned to fit the
 * measured width (first + last kept), dense line/area charts drop per-point dots
 * for hover columns, and tooltips carry the point's label as a heading.
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
