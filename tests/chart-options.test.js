/**
 * @vitest-environment happy-dom
 *
 * Chart options: `points: false` (no dots, shared hover-column tooltip),
 * cartesian `min`/`max` (widen the y-domain for shared fixed scales; gauge and
 * gantt keep their meaning), and `format` (Intl.NumberFormat options for tooltip
 * and data-label values; the axis adds compact notation).
 *
 * d3 is stubbed (loadD3 short-circuits on window.__manifestD3); the linear stub's
 * nice() is a no-op, so the y-axis tick labels expose the raw domain.
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
    let d = [0, 1], r = [0, 1], c = false
    const s = v => { const t = (v - d[0]) / (d[1] - d[0]); return r[0] + (c ? Math.max(0, Math.min(1, t)) : t) * (r[1] - r[0]) }
    s.domain = x => x ? (d = x, s) : d
    s.range = x => x ? (r = x, s) : r
    s.clamp = x => (c = x, s)
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
function arc() {
    const a = () => 'M0,0'
    a.innerRadius = () => a; a.outerRadius = () => a; a.cornerRadius = () => a; a.centroid = () => [0, 0]
    return a
}
window.__manifestD3 = {
    scaleLinear, scaleBand: () => ordinal(false), scalePoint: () => ordinal(true),
    line: shape, area: shape, curveMonotoneX: {}, curveLinear: {},
    arc, pie: () => { const p = data => data.map((v, i) => ({ value: v, index: i })); p.sort = () => p; p.value = () => p; return p }
}
window.ManifestUI = { resolve: () => ({}) }

window.Alpine = Alpine
await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.charts.js'), 'utf8')
))
window.ensureChartsPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }

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

const yTicks = (el) => [...el.querySelectorAll('svg text[text-anchor="end"]')].map(t => t.textContent)
const hover = (node) => node.dispatchEvent(new MouseEvent('mouseenter', { clientX: 100, clientY: 50 }))
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
const three = [
    { name: 'Base', data: [100, 120, 140, 160, 180, 200] },
    { name: 'Low', data: [80, 90, 100, 110, 120, 130] },
    { name: 'High', data: [120, 150, 180, 210, 240, 270] }
]
const eur = (v, o = { maximumFractionDigits: 0 }) => new Intl.NumberFormat('en', { style: 'currency', currency: 'EUR', ...o }).format(v)

beforeAll(() => { Alpine.start() })

describe('points: false', () => {
    it('line: no dots, one hover column per label with every series', async () => {
        const el = await render({ type: 'line', labels: months, points: false, series: three })
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(0)
        const hits = el.querySelectorAll('rect.hit')
        expect(hits.length).toBe(6)
        hover(hits[2])
        const tip = el.querySelector('.tooltip')
        expect(tip.querySelector('strong').textContent).toBe('Mar')
        expect([...tip.querySelectorAll('div')].map(d => d.textContent)).toEqual(['Base: 140', 'Low: 100', 'High: 180'])
        const focus = [...el.querySelectorAll('circle.focus')]
        expect(focus.length).toBe(3)
        focus.forEach(f => expect(f.hasAttribute('display')).toBe(false))
        expect(new Set(focus.map(f => f.getAttribute('cx'))).size).toBe(1)
        hits[2].dispatchEvent(new MouseEvent('mouseleave'))
        focus.forEach(f => expect(f.getAttribute('display')).toBe('none'))
    })

    it('area: same hover columns', async () => {
        const el = await render({ type: 'area', labels: months, points: false, series: three })
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(0)
        expect(el.querySelectorAll('rect.hit').length).toBe(6)
    })

    it('combo: line parts drop dots, columns list bar and line series', async () => {
        const el = await render({
            type: 'combo', labels: months, points: false, series: [
                { name: 'Orders', type: 'bar', data: [1, 2, 3, 4, 5, 6] },
                { name: 'Trend', type: 'line', data: [2, 3, 4, 5, 6, 7] }
            ]
        })
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(0)
        const hits = el.querySelectorAll('rect.hit')
        expect(hits.length).toBe(6)
        hover(hits[1])
        expect(el.querySelector('.tooltip').textContent).toContain('Orders: 2')
        expect(el.querySelector('.tooltip').textContent).toContain('Trend: 3')
        expect(el.querySelectorAll('rect:not(.hit).active').length).toBe(1)
    })

    it('data labels still draw without dots', async () => {
        const el = await render({ type: 'line', labels: months, points: false, dataLabels: true, series: [three[0]] })
        expect([...el.querySelectorAll('text.value')].map(t => t.textContent)).toEqual(['100', '120', '140', '160', '180', '200'])
    })

    it('default keeps per-point dots and no columns', async () => {
        const el = await render({ type: 'line', labels: months, series: three })
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(18)
        expect(el.querySelectorAll('rect.hit').length).toBe(0)
    })
})

describe('cartesian min / max', () => {
    it('max widens the domain above the data', async () => {
        const el = await render({ type: 'line', labels: months, max: 500, series: three })
        const t = yTicks(el)
        expect(t[0]).toBe('0')
        expect(t[t.length - 1]).toBe('500')
    })

    it('data beyond max still extends the domain', async () => {
        const el = await render({ type: 'line', labels: months, max: 200, series: three })
        expect(yTicks(el).at(-1)).toBe('270')
    })

    it('min widens below zero; a positive min does not lift the baseline', async () => {
        const neg = await render({ type: 'bar', labels: months, min: -100, series: [three[0]] })
        expect(yTicks(neg)[0]).toBe('-100')
        const pos = await render({ type: 'area', labels: months, min: 50, series: [three[0]] })
        expect(yTicks(pos)[0]).toBe('0')
    })

    it('two charts with different data share one scale', async () => {
        const a = await render({ type: 'line', labels: months, min: 0, max: 400, series: [three[1]] })
        const b = await render({ type: 'line', labels: months, min: 0, max: 400, series: [three[2]] })
        expect(yTicks(a)).toEqual(yTicks(b))
        expect(yTicks(a).at(-1)).toBe('400')
    })

    it('applies to combo and scatter; numeric strings accepted, junk ignored', async () => {
        const combo = await render({ type: 'combo', labels: months, max: '1000', series: [{ name: 'A', type: 'bar', data: [1, 2, 3, 4, 5, 6] }] })
        expect(yTicks(combo).at(-1)).toBe('1K')
        const scatter = await render({ type: 'scatter', labels: months, max: 'abc', min: true, series: [three[0]] })
        expect(yTicks(scatter)[0]).toBe('0')
        expect(yTicks(scatter).at(-1)).toBe('200')
    })

    it('gauge keeps min/max as its range', async () => {
        const el = await render({ type: 'gauge', value: 30, min: 20, max: 40 })
        const texts = [...el.querySelectorAll('text')].map(t => t.textContent)
        expect(texts).toContain('20')
        expect(texts).toContain('40')
    })
})

describe('format', () => {
    const format = { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }

    it('tooltips and data labels use the options; axis is compact', async () => {
        const el = await render({ type: 'line', labels: months, points: false, dataLabels: true, max: 1500, format, series: three })
        hover(el.querySelectorAll('rect.hit')[0])
        expect([...el.querySelector('.tooltip').querySelectorAll('div')].map(d => d.textContent))
            .toEqual(['Base: ' + eur(100), 'Low: ' + eur(80), 'High: ' + eur(120)])
        expect(el.querySelector('text.value').textContent).toBe(eur(100))
        const compact = (v) => eur(v, { notation: 'compact', maximumFractionDigits: 1 })
        expect(yTicks(el)).toEqual([0, 300, 600, 900, 1200, 1500].map(compact))
    })

    it('axis keeps one decimal so close ticks stay distinct', async () => {
        const el = await render({ type: 'line', labels: months, min: 1000, max: 2000, format, series: [{ data: [1000, 2000] }] })
        expect(new Set(yTicks(el)).size).toBe(yTicks(el).length)
    })

    it('dot tooltips, bars, scatter and pie use it too', async () => {
        const line = await render({ type: 'line', labels: months, format, series: [three[0]] })
        expect(line.querySelector('circle').getAttribute('aria-label')).toBe('Jan · Base: ' + eur(100))
        const bar = await render({ type: 'bar', labels: months, format, series: [three[0]] })
        expect(bar.querySelector('rect').getAttribute('aria-label')).toBe('Jan · Base: ' + eur(100))
        const stacked = await render({ type: 'bar', stacked: true, labels: months, format, series: [three[0], three[1]] })
        expect(stacked.querySelector('rect').getAttribute('aria-label')).toBe('Jan · Base: ' + eur(100))
        const scatter = await render({ type: 'scatter', labels: months, format, series: [three[0]] })
        expect(scatter.querySelector('circle').getAttribute('aria-label')).toBe('Jan · Base: ' + eur(100))
        const pie = await render({ type: 'pie', labels: ['A', 'B'], format, series: [{ data: [1200, 300] }] })
        expect(pie.querySelector('path.slice').getAttribute('aria-label')).toBe('A: ' + eur(1200))
    })

    it('default leaves raw values and the compact axis', async () => {
        const el = await render({ type: 'line', labels: months, max: 1500, series: [{ name: 'S', data: [1234.5] }] })
        expect(el.querySelector('circle').getAttribute('aria-label')).toBe('Jan · S: 1234.5')
        expect(yTicks(el).at(-1)).toBe('1.5K')
    })

    it('invalid options fall back to the default', async () => {
        const el = await render({ type: 'line', labels: months, format: { style: 'currency' }, series: [{ name: 'S', data: [1234.5] }] })
        expect(el.querySelector('circle').getAttribute('aria-label')).toBe('Jan · S: 1234.5')
        const plain = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
        expect(yTicks(el).at(-1)).toBe(plain.format(1234.5))
    })

    it('follows the document locale', async () => {
        document.documentElement.lang = 'de'
        try {
            const el = await render({ type: 'line', labels: months, format, series: [{ name: 'S', data: [1234] }] })
            const de = new Intl.NumberFormat('de', format).format(1234)
            expect(el.querySelector('circle').getAttribute('aria-label')).toBe('Jan · S: ' + de)
        } finally { document.documentElement.lang = '' }
    })
})

describe('review follow-ups', () => {
    const format = { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }

    it('points: false on a dense series: no dots, no data-label clutter, one column per label', async () => {
        const labels = Array.from({ length: 200 }, (_, i) => 'd' + i)
        const el = await render({ type: 'line', labels, points: false, dataLabels: true, series: [{ name: 'S', data: labels.map((_, i) => i) }] })
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(0)
        expect(el.querySelectorAll('text.value').length).toBe(0)
        expect(el.querySelectorAll('rect.hit').length).toBe(200)
    })

    it('format reaches candlestick, heatmap (cells + legend) and gauge', async () => {
        const candle = await render({ type: 'candlestick', labels: ['a'], format, series: [{ data: [[1000, 1200, 900, 1100]] }] })
        expect(candle.querySelector('rect').getAttribute('aria-label')).toBe(`a · O ${eur(1000)} H ${eur(1200)} L ${eur(900)} C ${eur(1100)}`)
        const heat = await render({ type: 'heatmap', labels: ['x', 'y'], format, series: [{ name: 'r', data: [100, 1500] }] })
        expect(heat.querySelector('rect.heat-cell').getAttribute('aria-label')).toBe('r · x: ' + eur(100))
        expect([...heat.querySelectorAll('.heat-legend span')].map(s => s.textContent)).toEqual([eur(100), eur(1500)])
        const gauge = await render({ type: 'gauge', value: 1234, min: 0, max: 2000, format })
        expect(gauge.querySelector('text.gauge-label').textContent).toBe(eur(1234))
    })

    it('min/max ignore non-numeric values (dates, arrays, blanks)', async () => {
        const el = await render({ type: 'line', labels: months, min: [-50], max: '2026-01-01', series: [three[0]] })
        expect(yTicks(el)[0]).toBe('0')
        expect(yTicks(el).at(-1)).toBe('200')
        const blank = await render({ type: 'candlestick', labels: ['a'], min: ' ', series: [{ data: [[100, 120, 90, 110]] }] })
        expect(Number(yTicks(blank)[0])).toBeGreaterThan(50)
    })
})
