/**
 * @vitest-environment happy-dom
 *
 * Chart `dashFrom`: line/area (and combo line/area parts) split at a label
 * index into a solid part and a dashed/faded part, clipped either side of that
 * label's x from the same path data. Hover columns, dots, tooltips and the
 * legend stay one per series. Invalid values change nothing.
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


const clipX = (el, url) => {
    const id = url.slice(5, -1)
    const r = el.querySelector(`clipPath[id="${id}"] rect`)
    return { x: +r.getAttribute('x'), right: +r.getAttribute('x') + +r.getAttribute('width') }
}
const xOf = (el, i) => +el.querySelectorAll('rect.hit')[i].getAttribute('x') + +el.querySelectorAll('rect.hit')[i].getAttribute('width') / 2

describe('dashFrom', () => {
    it('area: each series gets a solid and a dashed line and fill, split at the index', async () => {
        const el = await render({ type: 'area', labels: months, points: false, dashFrom: 3, series: three })
        const solid = el.querySelectorAll('path.line:not(.dashed)'), dashed = el.querySelectorAll('path.line.dashed')
        const fill = el.querySelectorAll('path.area:not(.dashed)'), faded = el.querySelectorAll('path.area.dashed')
        expect([solid.length, dashed.length, fill.length, faded.length]).toEqual([3, 3, 3, 3])
        const xk = xOf(el, 3)
        for (let k = 0; k < 3; k++) {
            expect(dashed[k].getAttribute('d')).toBe(solid[k].getAttribute('d'))
            expect(faded[k].getAttribute('d')).toBe(fill[k].getAttribute('d'))
            expect(dashed[k].getAttribute('style')).toContain(`--color-chart-color:var(--color-chart-${k + 1})`)
            expect(clipX(el, solid[k].getAttribute('clip-path')).right).toBeCloseTo(xk + 1, 6)
            expect(clipX(el, fill[k].getAttribute('clip-path')).right).toBeCloseTo(xk, 6)
            expect(clipX(el, dashed[k].getAttribute('clip-path')).x).toBeCloseTo(xk, 6)
            expect(clipX(el, faded[k].getAttribute('clip-path')).x).toBeCloseTo(xk, 6)
        }
    })

    it('hover, tooltip, focus dots and legend are unchanged', async () => {
        const el = await render({ type: 'area', labels: months, points: false, dashFrom: 3, series: three })
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(0)
        const hits = el.querySelectorAll('rect.hit')
        expect(hits.length).toBe(6)
        hover(hits[4])
        const tip = el.querySelector('.tooltip')
        expect(tip.querySelector('strong').textContent).toBe('May')
        expect([...tip.querySelectorAll('div')].map(d => d.textContent)).toEqual(['Base: 180', 'Low: 120', 'High: 240'])
        expect(el.querySelectorAll('circle.focus').length).toBe(3)
        expect([...el.querySelectorAll('footer > span')].map(s => s.textContent)).toEqual(['Base', 'Low', 'High'])
    })

    it('line with points keeps one dot per point', async () => {
        const el = await render({ type: 'line', labels: months, dashFrom: 2, series: three })
        expect(el.querySelectorAll('circle:not(.focus)').length).toBe(18)
        expect(el.querySelectorAll('path.line.dashed').length).toBe(3)
        expect(el.querySelectorAll('path.area').length).toBe(0)
    })

    it('combo: line and area parts split, bars untouched', async () => {
        const el = await render({
            type: 'combo', labels: months, dashFrom: 4, series: [
                { name: 'Orders', type: 'bar', data: [1, 2, 3, 4, 5, 6] },
                { name: 'Trend', type: 'line', data: [2, 3, 4, 5, 6, 7] },
                { name: 'Band', type: 'area', data: [1, 1, 2, 2, 3, 3] }
            ]
        })
        expect(el.querySelectorAll('path.line.dashed').length).toBe(2)
        expect(el.querySelectorAll('path.area.dashed').length).toBe(1)
        expect([...el.querySelectorAll('rect:not(.hit)')].filter(r => !r.closest('clipPath')).length).toBe(6)
    })

    it('works with min/max and format', async () => {
        const format = { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }
        const el = await render({ type: 'area', labels: months, points: false, dashFrom: 3, max: 500, format, series: three })
        expect(yTicks(el).at(-1)).toBe(eur(500, { notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 }))
        hover(el.querySelectorAll('rect.hit')[5])
        expect(el.querySelector('.tooltip div').textContent).toBe('Base: ' + eur(200))
        expect(el.querySelectorAll('path.line.dashed').length).toBe(3)
    })

    it('index 0 and the last index are in range', async () => {
        const first = await render({ type: 'area', labels: months, dashFrom: 0, series: [three[0]] })
        expect(first.querySelectorAll('path.line.dashed').length).toBe(1)
        expect(clipX(first, first.querySelector('path.line.dashed').getAttribute('clip-path')).x).toBeCloseTo(xOfDot(first, 0), 6)
        expect(clipX(first, first.querySelector('path.area:not(.dashed)').getAttribute('clip-path')).right).toBeCloseTo(xOfDot(first, 0), 6)
        const last = await render({ type: 'area', labels: months, dashFrom: 5, series: [three[0]] })
        expect(last.querySelectorAll('path.line.dashed').length).toBe(1)
        expect(clipX(last, last.querySelector('path.line.dashed').getAttribute('clip-path')).x).toBeCloseTo(xOfDot(last, 5), 6)
        expect(clipX(last, last.querySelector('path.line:not(.dashed)').getAttribute('clip-path')).right).toBeCloseTo(xOfDot(last, 5) + 1, 6)
    })

    it('absent, out of range or not an integer: nothing changes', async () => {
        const base = await render({ type: 'area', labels: months, points: false, series: three })
        const plain = base.querySelector('svg').innerHTML
        expect(plain).not.toContain('clip-path')
        for (const dashFrom of [6, -1, '3', 2.5, NaN, null, true, [3]]) {
            const el = await render({ type: 'area', labels: months, points: false, dashFrom, series: three })
            expect(el.querySelectorAll('.dashed, clipPath').length, String(dashFrom)).toBe(0)
            expect(el.querySelectorAll('path.line[clip-path], path.area[clip-path]').length).toBe(0)
        }
    })

    it('ignored by bar and scatter', async () => {
        const bar = await render({ type: 'bar', labels: months, dashFrom: 2, series: three })
        const scatter = await render({ type: 'scatter', labels: months, dashFrom: 2, series: three })
        expect(bar.querySelectorAll('.dashed, clipPath').length).toBe(0)
        expect(scatter.querySelectorAll('.dashed, clipPath').length).toBe(0)
    })

    it('dash pattern starts at the index point', async () => {
        // Straight path along x: length at x equals x
        const proto = Object.getPrototypeOf(document.createElementNS('http://www.w3.org/2000/svg', 'path'))
        const saved = [proto.getTotalLength, proto.getPointAtLength]
        proto.getTotalLength = function () { return 1000 }
        proto.getPointAtLength = function (s) { return { x: s, y: 0 } }
        try {
            const el = await render({ type: 'line', labels: months, dashFrom: 3, series: [three[0]] })
            const off = Number(el.querySelector('path.line.dashed').getAttribute('stroke-dashoffset'))
            expect(off).toBeCloseTo(-xOfDot(el, 3), 3)
        } finally { [proto.getTotalLength, proto.getPointAtLength] = saved }
    })

    it('redraws when dashFrom changes', async () => {
        const host = document.createElement('div')
        host.setAttribute('x-data', '{ cfg: ' + JSON.stringify({ type: 'line', labels: months, series: three }) + ' }')
        host.innerHTML = '<div x-chart="cfg"></div>'
        document.body.appendChild(host)
        const el = host.querySelector('[x-chart]')
        Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
        Alpine.initTree(host)
        await settle()
        expect(el.querySelectorAll('path.line.dashed').length).toBe(0)
        Alpine.$data(host).cfg.dashFrom = 2
        await settle(6)
        expect(el.querySelectorAll('path.line.dashed').length).toBe(3)
    })
})

const xOfDot = (el, i) => +el.querySelectorAll('circle:not(.focus)')[i].getAttribute('cx')
