/**
 * Real-Chrome guard for x-virtual row heights that change after the first measurement:
 * rows that grow or shrink (at the top, inside, above and below the window), async text,
 * a container width change that re-wraps text, table rows, display:contents grid rows (including
 * a cell added later), gallery and masonry. The offset model must follow: scroll height equals the
 * true total after a full scroll, no blank gap at the window edge, nothing oscillates. The module
 * never writes scrollTop: smooth scrolls and scrollIntoView reach their targets, and holding the view
 * when a row above it grows is left to the browser's scroll anchoring (checked with overflow-anchor
 * auto and none). Stored heights of keys that left the source are dropped.
 *
 * Run: node tests/e2e/virtual-heights.e2e.mjs   (VIRTUAL_SRC=<dir with scripts/> to A/B;
 * VIRTUAL_BASELINE=<dir with scripts/> also times the 100k-item perf check against it)
 */
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SRC = process.env.VIRTUAL_SRC || path.join(ROOT, 'src')
const BASELINE = process.env.VIRTUAL_BASELINE || null
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.js')

// Scroll writes on #v are counted unless the test itself makes them (T.set, T.own): the scrollTop setter,
// scrollTo/scrollBy/scroll on #v, and scrollIntoView on #v or anything inside it
const HELPERS = `<script>
window.__writes = 0; window.__harness = false
const sd = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { return sd.get.call(this) }, set(x) { if (this.id === 'v' && !window.__harness) window.__writes++; sd.set.call(this, x) } })
for (const m of ['scrollTo', 'scrollBy', 'scroll', 'scrollIntoView']) {
  const f = Element.prototype[m]
  Element.prototype[m] = function () { if (!window.__harness && (this.id === 'v' || (m === 'scrollIntoView' && this.closest && this.closest('#v')))) window.__writes++; return f.apply(this, arguments) }
}
window.frames_ = (k = 3) => new Promise((r) => { const f = () => (--k <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) })
window.T = {
  v: () => document.getElementById('v'),
  rows: () => [...document.querySelectorAll('#v .r')],
  set(y) { window.__harness = true; this.v().scrollTop = y; window.__harness = false },
  own(fn) { window.__harness = true; try { return fn() } finally { window.__harness = false } },
  // Probe that the offset model agrees with the DOM: a 1px scroll and back re-renders and must move the first
  // visible row by exactly 1px each way (a model offset that differs from the row's DOM position moves it more)
  async probe() {
    const v = this.v(), top = () => v.getBoundingClientRect().top + v.clientTop
    const f = this.first(); if (!f) return null
    const node = () => document.querySelector('#v .r[data-n="' + f.n + '"]')
    const y0 = this.rect(node()).top - top()
    this.set(v.scrollTop + 1); await frames_(3)
    const n1 = node(); const y1 = n1 ? this.rect(n1).top - top() : null
    this.set(v.scrollTop - 1); await frames_(3)
    const n2 = node(); const y2 = n2 ? this.rect(n2).top - top() : null
    return { n: f.n, down: y1 === null ? null : Math.round((y0 - y1) * 10) / 10, back: y2 === null || y1 === null ? null : Math.round((y2 - y1) * 10) / 10 }
  },
  total: () => [...document.querySelectorAll('#v [data-virtual-spacer]')].reduce((a, s) => a + parseFloat(s.style.height), 0) + [...document.querySelectorAll('#v .r')].reduce((a, r) => a + r.getBoundingClientRect().height, 0),
  rect: (r) => (getComputedStyle(r).display === 'contents' ? r.firstElementChild : r).getBoundingClientRect(),
  first() {
    const top = this.v().getBoundingClientRect().top + this.v().clientTop
    for (const r of this.rows()) { const b = this.rect(r); if (b.bottom > top + 0.5) return { n: r.dataset.n, off: Math.round(b.top - top) } }
    return null
  },
  gap() {
    const v = this.v(), rows = this.rows()
    if (!rows.length) return 0
    const [ts, bs] = v.querySelectorAll('[data-virtual-spacer]')
    const vt = v.getBoundingClientRect().top + v.clientTop, vb = vt + v.clientHeight
    let lo = Infinity, hi = -Infinity
    for (const r of rows) { const b = this.rect(r); if (b.top < lo) lo = b.top; if (b.bottom > hi) hi = b.bottom }
    const gb = parseFloat(bs.style.height) > 0 ? Math.max(0, vb - hi) : 0
    const gt = parseFloat(ts.style.height) > 0 ? Math.max(0, lo - vt) : 0
    return Math.round(Math.max(gb, gt))
  },
  sig() { const v = this.v(); return [Math.round(v.scrollTop), v.scrollHeight, this.rows().length, ...[...v.querySelectorAll('[data-virtual-spacer]')].map((s) => s.style.height), JSON.stringify(this.first())].join('|') },
  // Resolves once nothing moved for \`quiet\` frames (true), or after \`ms\` (false)
  async stable(ms = 6000, quiet = 8) {
    const t0 = performance.now()
    let last = this.sig(), same = 0
    while (performance.now() - t0 < ms) { await frames_(1); const s = this.sig(); same = s === last ? same + 1 : 0; last = s; if (same >= quiet) return true }
    return false
  },
  async through(step = 250) {
    const v = this.v()
    let worst = 0
    this.set(0)
    await this.stable()
    for (let y = 0, i = 0; i < 2000; y += step, i++) {
      this.set(y)
      await frames_(3)
      worst = Math.max(worst, this.gap())
      if (v.scrollTop + v.clientHeight >= v.scrollHeight - 1) break
    }
    for (let i = 0; i < 4; i++) { this.set(v.scrollHeight); await this.stable(3000, 4) }
    return { worst, total: v.scrollHeight }
  },
  async walk(to, step = 100) { for (let y = 0; y <= to; y += step) { this.set(y); await frames_(2) } this.set(to); return this.stable() },
  data: () => Alpine.$data(document.getElementById('app')),
}
</script>`

const shell = (body, script = '/scripts/manifest.virtual.js') => `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;font:16px/20px sans-serif} #v[data-anchor=none]{overflow-anchor:none} .r{box-sizing:border-box;overflow:hidden} .w{word-break:break-word} td,th{padding:0} .g{flex:0 0 100px}</style>
${HELPERS}<script src="${script}"></script><script defer src="/__alpine.js"></script></head><body>${body}</body></html>`

const fixed = (n, h) => shell(`<div id="app" x-data="{ items: Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, h: ${h} })) }">
  <div id="v" x-virtual="{ estimate: 30 }" style="height:300px;width:400px;overflow:auto">
    <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template>
  </div></div>`)

const words = (k) => Array.from({ length: (k * 7) % 23 + 1 }, (_, j) => 'word' + j).join(' ')
const text = (n) => shell(`<div id="app" x-data="{ items: Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, body: (${words.toString()})(k) })) }">
  <div id="v" x-virtual="{ estimate: 40 }" style="height:300px;width:400px;overflow:auto">
    <template x-for="row in items" :key="row.id"><div class="r w" :data-n="row.name" x-text="row.name + ' ' + row.body"></div></template>
  </div>
  <div id="ref" class="w" style="position:absolute;left:0;top:0;visibility:hidden;width:400px">
    <template x-for="row in items" :key="row.id"><div class="w" x-text="row.name + ' ' + row.body"></div></template>
  </div></div>`)

const table = (n) => shell(`<div id="app" x-data="{ items: Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, h: 30 })) }">
  <div id="v" x-virtual="{ estimate: 30 }" style="height:300px;width:400px;overflow:auto">
    <table style="width:100%;border-collapse:collapse;border-spacing:0"><thead><tr><th style="height:30px">h</th><th>x</th></tr></thead>
    <tbody><template x-for="row in items" :key="row.id"><tr class="r" :data-n="row.name"><td :style="'height:' + row.h + 'px'" x-text="row.name"></td><td>x</td></tr></template></tbody></table>
  </div></div>`)

const grid = (n) => shell(`<div id="app" x-data="{ items: Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, h: 30, extra: false })) }">
  <div id="v" x-virtual="{ estimate: 30 }" style="display:grid;grid-template-columns:1fr 1fr;align-content:start;height:300px;width:400px;overflow:auto">
    <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" style="display:contents"><div :style="'height:' + row.h + 'px'" x-text="row.name"></div><div>x</div><template x-if="row.extra"><div style="grid-column:1 / -1;height:300px">late</div></template></div></template>
  </div></div>`)

const masonry = (fn) => shell(`<script>window.__observed = 0; const o = ResizeObserver.prototype.observe; ResizeObserver.prototype.observe = function (t) { if (t.classList && t.classList.contains('r')) window.__observed++; return o.apply(this, arguments) }</script>
  <div id="app" x-data="{ items: Array.from({ length: 60 }, (_, k) => ({ id: k, name: 'n' + k, h: 40 })) }">
  <div id="v" x-virtual="{ mode: 'masonry', columns: 3, gap: 0${fn ? ', height: it => it.h' : ''} }" style="height:300px;width:300px;overflow:auto;position:relative">
    <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template>
  </div></div>`)

const gallery = (n) => shell(`<div id="app" x-data="{ items: Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, h: 30 })) }">
  <div id="v" x-virtual="{ estimate: { width: 100, height: 30 } }" style="display:flex;flex-wrap:wrap;align-content:flex-start;height:300px;width:400px;overflow-y:scroll;overflow-x:hidden;scrollbar-width:none">
    <template x-for="row in items" :key="row.id"><div class="r g" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template>
  </div></div>`)

// Every Map the page creates is recorded, to find the per-key height store by its keys
const churn = () => shell(`<script>window.__maps = []; const M = window.Map; window.Map = class extends M { constructor(a) { super(a); window.__maps.push(this) } }</script>
  <div id="app" x-data="{ gen: 0, items: [], page(n, h) { const g = ++this.gen; this.items = Array.from({ length: n }, (_, k) => ({ id: 'c' + g + '-' + k, name: 'n' + k, h })) } }" x-init="page(100, 30)">
  <div id="v" x-virtual="{ estimate: 30 }" style="height:300px;width:400px;overflow:auto">
    <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template>
  </div></div>
  <script>window.heightStore = () => Math.max(0, ...window.__maps.filter((m) => m.size && [...m.keys()].every((k) => /^c\\d+-\\d+$/.test(k)) && [...m.values()].every((x) => typeof x === 'number')).map((m) => m.size))</script>`)

// Varying heights 20..200 from a hash; TOP[k] is row k's true offset
const varied = (n, overscan) => shell(`<script>window.H = (k) => 20 + ((k * 2654435761) >>> 0) % 181; window.TOP = [0]; for (let k = 0; k < ${n}; k++) TOP.push(TOP[k] + H(k))</script>
  <div id="app" x-data="{ items: Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, h: H(k) })) }">
  <div id="v" x-virtual="{ estimate: 40, overscan: ${overscan} }" style="height:600px;width:400px;overflow:auto">
    <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template>
  </div></div>`)

const perf = (script) => shell(`<div id="app" x-data="{ items: Array.from({ length: 100000 }, (_, k) => ({ id: k, name: 'n' + k })) }">
  <div id="v" x-virtual="{ estimate: 24 }" style="height:600px;width:400px;overflow:auto">
    <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" style="height:24px" x-text="row.name"></div></template>
  </div></div>`, script)

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            const js = (file) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(file)) }
            if (u.pathname === '/__alpine.js') return js(ALPINE)
            if (u.pathname === '/scripts/manifest.virtual.js') return js(path.join(SRC, 'scripts/manifest.virtual.js'))
            if (u.pathname === '/baseline/scripts/manifest.virtual.js' && BASELINE) return js(path.join(BASELINE, 'scripts/manifest.virtual.js'))
            const n = Number(u.searchParams.get('n')) || 300
            const html = {
                '/fixed': () => fixed(n, Number(u.searchParams.get('h')) || 30),
                '/text': () => text(n),
                '/table': () => table(n),
                '/grid': () => grid(n),
                '/masonry': () => masonry(false),
                '/masonry-fn': () => masonry(true),
                '/gallery': () => gallery(n),
                '/churn': () => churn(),
                '/varied': () => varied(Number(u.searchParams.get('n')) || 3000, Number(u.searchParams.get('o')) || 3),
                '/perf': () => perf('/scripts/manifest.virtual.js'),
                '/perf-baseline': () => perf('/baseline/scripts/manifest.virtual.js'),
            }[u.pathname]
            const anchor = u.searchParams.get('a')
            res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' })
            res.end(html ? (anchor ? html().replace('id="v" ', `id="v" data-anchor="${anchor}" `) : html()) : 'not found')
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
    const server = await serve()
    const base = `http://127.0.0.1:${server.address().port}`
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
    const fails = []
    const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
    const open = async (route) => {
        const p = await browser.newPage()
        p.errors = []
        p.on('pageerror', (e) => p.errors.push(e.message))
        await p.goto(base + route, { waitUntil: 'load' })
        await p.waitForFunction(() => window.Alpine && document.querySelector('#v [data-virtual-spacer]') && window.T, { timeout: 10000 })
        await p.evaluate(() => T.stable())
        return p
    }
    const stable = (p) => p.evaluate(() => T.stable())
    // Every page ends here: the module never wrote scrollTop
    const done = async (p, label) => {
        const w = await p.evaluate(() => window.__writes)
        check(w === 0 && p.errors.length === 0, `${label}: the module never writes scrollTop, no page errors`, { writes: w, errors: p.errors })
        await p.close()
    }
    try {
        // Rows that grow after the first paint: at the top, inside, below the window
        for (const [where, k] of [['top (row 0)', 0], ['inside the window', 3], ['below the viewport', 12]]) {
            const p = await open('/fixed?n=300')
            const mounted = await p.evaluate((k) => !!document.querySelector(`#v .r[data-n="n${k}"]`), k)
            await p.evaluate((k) => { T.data().items[k].h = 200 }, k)
            await stable(p)
            const r = await p.evaluate(() => T.through())
            check(mounted && r.total === 299 * 30 + 200, `fixed rows, grow ${where}: scroll height equals the true total after a full scroll`, { rendered: mounted, total: r.total, expected: 299 * 30 + 200 })
            check(r.worst === 0, `fixed rows, grow ${where}: no blank gap while scrolling through`, r.worst)
            await done(p, `fixed rows, grow ${where}`)
        }

        // A row above the viewport grows. With native scroll anchoring (auto) the view holds; without it
        // (none, as in Safari) the content moves down by the growth. Either way the model stays true and settles.
        for (const anchor of ['auto', 'none']) {
            const p = await open(`/fixed?n=300&a=${anchor}`)
            await p.evaluate(() => T.walk(4500))
            const before = await p.evaluate(() => ({ first: T.first(), mounted: !!document.querySelector('#v .r[data-n="n148"]') }))
            await p.evaluate(() => { T.data().items[148].h = 230 })
            const settled = await stable(p)
            const after = await p.evaluate(() => T.first())
            if (anchor === 'auto') check(before.mounted && before.first.n === 'n150' && after.n === 'n150' && after.off === before.first.off, 'grow above the viewport, overflow-anchor auto: the browser keeps the first visible row', { before, after })
            else check(before.mounted && after.n === 'n148' && after.off === -60, 'grow above the viewport, overflow-anchor none: the content moves down by the growth (row 148 now spans the top)', { before, after })
            const idle = await p.evaluate(async () => { let n = 0; const on = () => n++; T.v().addEventListener('scroll', on); const s = T.sig(); await frames_(20); T.v().removeEventListener('scroll', on); return { scrolls: n, same: s === T.sig() } })
            check(settled && idle.scrolls === 0 && idle.same, `grow above the viewport, ${anchor}: settles, nothing oscillates`, idle)
            // Scroll on in steps while the grown row leaves the window: the content moves by the step only
            const steps = await p.evaluate(async () => {
                const at = () => { const f = T.first(), k = +f.n.slice(1); return 30 * k + (k > 148 ? 200 : 0) - f.off }
                const moved = []
                let prev = at()
                for (let i = 0; i < 16; i++) { T.set(T.v().scrollTop + 50); await frames_(3); const now = at(); moved.push(Math.round(now - prev)); prev = now }
                return moved
            })
            check(steps.every((d) => Math.abs(d - 50) <= 1), `grow above the viewport, ${anchor}: scrolling on moves the content by the scroll step only`, steps)
            const r = await p.evaluate(() => T.through())
            check(r.total === 299 * 30 + 230 && r.worst === 0, `grow above the viewport, ${anchor}: true total, no gap`, { ...r, expected: 299 * 30 + 230 })
            await done(p, `grow above the viewport, ${anchor}`)
        }

        // The same after a jump to the middle (rows above unmeasured): reported, the model must still settle true
        for (const anchor of ['auto', 'none']) {
            const p = await open(`/fixed?n=300&a=${anchor}`)
            await p.evaluate(() => { T.set(4500); return T.stable() })
            const before = await p.evaluate(() => T.first())
            await p.evaluate(() => { T.data().items[148].h = 230 })
            const settled = await stable(p)
            const after = await p.evaluate(() => T.first())
            if (anchor === 'auto') check(after.n === before.n && after.off === before.off, 'grow above after a jump, auto: the browser keeps the first visible row', { before, after })
            else check(after.n === 'n148' && after.off === -60, 'grow above after a jump, none: the content moves down by exactly the growth', { before, after })
            const r = await p.evaluate(() => T.through())
            check(settled && r.total === 299 * 30 + 230 && r.worst === 0, `grow above after a jump, ${anchor}: settles; true total, no gap`, r)
            await done(p, `grow above after a jump, ${anchor}`)
        }

        // Rows that shrink: the window refills, no blank space at its edge
        {
            const p = await open('/fixed?n=300&h=100')
            await p.evaluate(() => { for (const it of T.data().items) it.h = 10 })
            await stable(p)
            const gap = await p.evaluate(() => T.gap())
            check(gap === 0, 'fixed rows, shrink in the window: no blank gap at the window edge', gap)
            const r = await p.evaluate(() => T.through())
            check(r.total === 3000 && r.worst === 0, 'fixed rows, shrink: true total and no gap after a full scroll', r)
            await done(p, 'fixed rows, shrink')
        }

        const truth = (p) => p.evaluate(() => { const ref = document.getElementById('ref'); ref.style.width = T.v().clientWidth + 'px'; return ref.scrollHeight })

        // Async content: a row's text arrives later and wraps
        {
            const p = await open('/text?n=200')
            await p.evaluate(() => { T.data().items[2].body = 'late '.repeat(300) })
            await stable(p)
            const r = await p.evaluate(() => T.through())
            const t = await truth(p)
            check(r.total === t && r.worst === 0, 'text rows, content arrives after mount: true total, no gap', { ...r, truth: t })
            await done(p, 'text rows, async content')
        }

        // Container width change re-wraps text: rows measured at the old width re-measure when rendered again.
        // Rows are measured by walking down (a fast scroll-through makes Chrome turn its anchoring off for the scroller).
        for (const anchor of ['auto', 'none']) {
            const p = await open(`/text?n=200&a=${anchor}`)
            await p.evaluate(() => T.walk(4350))
            const before = await p.evaluate(() => T.first())
            const sh0 = await p.evaluate(() => T.v().scrollHeight)
            // Chrome does not anchor across the resize itself: the frame after it is what the browser shows
            const native = await p.evaluate(async () => { T.v().style.width = '160px'; await frames_(1); return T.first() })
            await p.evaluate(() => T.stable(6000, 20))
            const after = await p.evaluate(() => T.first())
            if (anchor === 'auto') check(native.n === after.n && Math.abs(native.off - after.off) <= 1, 'text rows, narrower container (auto): re-measuring moves the view no further than the browser\'s own re-wrap', { before, native, after })
            // Without anchoring, the rendered rows above the view (overscan 3) re-wrap in place, and rows mounted above
            // with heights from the old width add their difference: bounded by two overscans of rows
            else check(+after.n.slice(1) >= +before.n.slice(1) - 6 && +after.n.slice(1) <= +before.n.slice(1), 'text rows, narrower container (none): the first visible row moves back at most 6 rows (2 x overscan)', { before, after })
            const r = await p.evaluate(() => T.through())
            const t = await truth(p)
            check(r.total === t && r.worst === 0, `text rows, narrower container (${anchor}): after scrolling through, the total converges to the true total`, { ...r, truth: t, before: sh0 })
            await p.evaluate(() => { T.v().style.width = '400px' })
            await p.evaluate(() => T.stable(6000, 20))
            const r2 = await p.evaluate(() => T.through())
            const t2 = await truth(p)
            check(r2.total === t2 && r2.worst === 0, `text rows, wider again (${anchor}): true total, no gap`, { ...r2, truth: t2 })
            await done(p, `text rows, width change (${anchor})`)
        }

        // Table rows and display:contents grid rows
        for (const route of ['/table', '/grid']) {
            const p = await open(route + '?n=300')
            // Row 3 leaves and comes back first: a remounted row is observed too
            await p.evaluate(async () => { T.set(3000); await frames_(4); T.set(0); await T.stable() })
            await p.evaluate(() => { T.data().items[3].h = 200 })
            await stable(p)
            const r = await p.evaluate(() => T.through())
            const head = route === '/table' ? 30 : 0
            check(r.total === head + 299 * 30 + 200 && r.worst === 0, `${route}: a grown row keeps the true total and no gap`, { ...r, expected: head + 299 * 30 + 200 })
            await p.evaluate(() => T.walk(4500))
            const before = await p.evaluate(() => T.first())
            await p.evaluate(() => { T.data().items[148].h = 130 })
            await stable(p)
            const after = await p.evaluate(() => T.first())
            check(before.n === after.n && Math.abs(before.off - after.off) <= 1, `${route}: a row above the viewport grows, the browser keeps the view (anchor auto)`, { before, after })
            await done(p, route)
        }

        // A cell added later to a display:contents row (x-if inside the row) counts toward its height
        {
            const p = await open('/grid?n=300')
            await p.evaluate(() => { T.data().items[1].extra = true })
            await stable(p)
            const r = await p.evaluate(() => T.through())
            check(r.total === 300 * 30 + 300 && r.worst === 0, '/grid: a cell added later to a display:contents row is measured', { ...r, expected: 300 * 30 + 300 })
            await done(p, '/grid late cell')
        }

        // Gallery (flex-wrap): a taller item makes its line taller
        {
            const p = await open('/gallery?n=200')
            await p.evaluate(() => { T.data().items[5].h = 200 })
            await stable(p)
            const r = await p.evaluate(() => T.through())
            check(r.total === 49 * 30 + 200 && r.worst === 0, '/gallery: a grown item keeps the true total and no gap', { ...r, expected: 49 * 30 + 200 })
            await done(p, '/gallery')
        }

        // Masonry: measured items re-pack when one grows; with an author height function nothing is observed
        {
            const p = await open('/masonry')
            const at = () => p.evaluate(() => { const n = document.querySelector('#v .r[data-n="n3"]'); return n.style.top + '/' + n.style.left })
            const start = await at()
            await p.evaluate(() => { T.data().items[0].h = 140 })
            await stable(p)
            const after = await at()
            check(start === '40px/0px' && after === '40px/100px', '/masonry: a measured item that grows re-packs the layout', { start, after })
            await done(p, '/masonry')
            const q = await open('/masonry-fn')
            const observed = await q.evaluate(() => window.__observed)
            check(observed === 0 && (await q.evaluate(() => T.rows().length)) > 0, '/masonry with a height function: items are not observed or measured', observed)
            await done(q, '/masonry-fn')
        }

        // Programmatic and wheel scrolling over 3,000 rows of varying height
        for (const anchor of ['auto', 'none']) {
            const p = await open(`/varied?a=${anchor}`)
            const smooth = await p.evaluate(async () => {
                for (let i = 0; i < 5; i++) { T.set(1e9); await T.stable(3000, 4) }
                const v = T.v()
                T.own(() => v.scrollTo({ top: 0, behavior: 'smooth' }))
                const t0 = performance.now()
                while (v.scrollTop > 0 && performance.now() - t0 < 8000) await frames_(2)
                await T.stable()
                return { st: v.scrollTop, first: T.first() }
            })
            check(smooth.st === 0 && smooth.first.n === 'n0', `varied, ${anchor}: a smooth scrollTo({ top: 0 }) from the end reaches the top`, smooth)
            await done(p, `varied smooth scrollTo, ${anchor}`)

            // scrollIntoView on a row ~40 rows above the viewport (overscan 40 keeps it rendered): the smooth scroll
            // runs its whole distance. With the rows between measured it lands exactly; unmeasured rows mounting on
            // the way are placed by estimate, so where it lands then depends on the estimate (reported)
            for (const measured of [true, false]) {
                const q = await open(`/varied?a=${anchor}&o=40`)
                const siv = await q.evaluate(async (measured) => {
                    for (let i = 0; i < 5; i++) { T.set(1e9); await T.stable(3000, 4) }
                    if (measured) { const end = T.v().scrollTop; for (let y = end; y > end - 12000; y -= 150) { T.set(y); await frames_(2) } T.set(1e9); await T.stable() }
                    const target = T.rows()[0], n = target.dataset.n
                    const st0 = T.v().scrollTop
                    const dist = Math.round(T.v().getBoundingClientRect().top - target.getBoundingClientRect().top)
                    T.own(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }))
                    await frames_(4)
                    await T.stable(8000, 10)
                    return { n, dist, travelled: Math.round(st0 - T.v().scrollTop), first: T.first() }
                }, measured)
                if (measured) check(siv.dist > 2000 && siv.first.n === siv.n && Math.abs(siv.first.off) <= 2, `varied, ${anchor}: scrollIntoView({ behavior: 'smooth' }) on a row ${siv.dist}px away, rows between measured, lands on it`, siv)
                else {
                    check(siv.dist > 2000 && Math.abs(siv.travelled - siv.dist) <= 2, `varied, ${anchor}: scrollIntoView({ behavior: 'smooth' }) through unmeasured rows runs its whole distance (not cancelled)`, siv)
                    // Rows mounting on the way are placed by estimate: it lands within 5 rows of the target
                    check(Math.abs(+siv.first.n.slice(1) - +siv.n.slice(1)) <= 5, `varied, ${anchor}: through unmeasured rows it lands within 5 rows of the target`, siv)
                }
                await done(q, `varied scrollIntoView (${measured ? 'measured' : 'unmeasured'}), ${anchor}`)
            }

            // Wheel up from the end through unmeasured rows: progress is monotonic (no reversal over one row)
            const w = await open(`/varied?a=${anchor}`)
            await w.evaluate(async () => { for (let i = 0; i < 5; i++) { T.set(1e9); await T.stable(3000, 4) } })
            const box = await w.evaluate(() => { const b = T.v().getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })
            await w.mouse.move(box.x, box.y)
            await w.evaluate(() => {
                window.__rec = []; window.__recOn = true
                const loop = () => requestAnimationFrame(() => { if (!window.__recOn) return; const f = T.first(); if (f) { const k = +f.n.slice(1); __rec.push(TOP[k] - f.off) } loop() })
                loop()
            })
            for (let i = 0; i < 150; i++) { await w.mouse.wheel({ deltaY: -100 }); await wait(16) }
            await w.evaluate(() => T.stable())
            const rec = await w.evaluate(() => { window.__recOn = false; return __rec })
            let maxBack = 0
            for (let i = 1; i < rec.length; i++) maxBack = Math.max(maxBack, rec[i] - rec[i - 1])
            const travelled = Math.round(rec[0] - rec[rec.length - 1])
            check(maxBack <= 200 && travelled > 5000, `varied, ${anchor}: wheel up from the end makes monotonic progress (largest reversal ${Math.round(maxBack)}px, one row is up to 200)`, { maxBack: Math.round(maxBack), travelled, frames: rec.length })
            await done(w, `varied wheel up, ${anchor}`)
        }

        // Source and size changes after a jump keep the view: rows before the window keep their offset steps
        for (const anchor of ['auto', 'none']) {
            const same = (a, b) => a && b && a.n === b.n && a.off === b.off
            // Infinite scroll: jump to the end, wheel up a little, a page arrives
            {
                const p = await open(`/varied?n=20000&a=${anchor}`)
                const r = await p.evaluate(async () => {
                    window.__ends = []
                    T.v().addEventListener('virtual-end', (e) => __ends.push(e.detail.length))
                    for (let i = 0; i < 5; i++) { T.set(1e9); await T.stable(3000, 4) }
                    for (let i = 0; i < 40; i++) { T.set(T.v().scrollTop - 120); await frames_(2) }
                    await T.stable()
                    const before = T.first()
                    const items = T.data().items
                    for (let i = 0; i < 50; i++) items.push({ id: 'x' + i, name: 'x' + i, h: 100 })
                    await T.stable()
                    const after = T.first(), endsAfterPush = __ends.filter((n) => n === 20050).length
                    for (let i = 0; i < 6; i++) { T.set(1e9); await T.stable(3000, 4) }
                    return { before, after, endsAfterPush, endsAtEnd: __ends.filter((n) => n === 20050).length }
                })
                check(same(r.before, r.after) && r.endsAfterPush === 0 && r.endsAtEnd === 1, `infinite scroll, ${anchor}: a pushed page keeps the view; virtual-end fires once for the new length when its end is reached`, r)
                await done(p, `infinite scroll, ${anchor}`)
            }
            // Jump to the middle, push 1 then 100 (a chat, a live feed)
            {
                const p = await open(`/varied?a=${anchor}`)
                const r = await p.evaluate(async () => {
                    T.set(T.v().scrollHeight / 2); await T.stable()
                    const a = T.first()
                    T.data().items.push({ id: 'one', name: 'one', h: 50 }); await T.stable()
                    const b = T.first()
                    for (let i = 0; i < 100; i++) T.data().items.push({ id: 'm' + i, name: 'm' + i, h: 60 })
                    await T.stable()
                    return { a, b, c: T.first() }
                })
                check(same(r.a, r.b) && same(r.a, r.c), `jump to the middle, ${anchor}: pushing 1 then 100 items keeps the first visible row and its offset`, r)
                await done(p, `push after a jump, ${anchor}`)
            }
            // Rows grown at the top, jump to the middle, then a container height change, and separately a push
            for (const trigger of ['height', 'push']) {
                const p = await open(`/varied?a=${anchor}`)
                const r = await p.evaluate(async (trigger) => {
                    for (let k = 0; k < 6; k++) T.data().items[k].h += 150
                    await T.stable()
                    T.set(T.v().scrollHeight / 2); await T.stable()
                    const a = T.first()
                    if (trigger === 'height') { T.v().style.height = '560px'; await T.stable(6000, 20) }
                    else { T.data().items.push({ id: 'z', name: 'z', h: 80 }); await T.stable() }
                    return { a, b: T.first() }
                }, trigger)
                check(same(r.a, r.b), `rows grown at the top, jump to the middle, then a ${trigger === 'height' ? 'container height change' : 'push'} (${anchor}): the view is unchanged`, r)
                await done(p, `grown top then ${trigger}, ${anchor}`)
            }
            // A drift rebuild: rows from the first visible one down grow a lot, so the estimate for unmeasured rows
            // moves past 10% and everything below the window is re-estimated
            {
                const p = await open(`/varied?a=${anchor}`)
                const r = await p.evaluate(async () => {
                    T.set(T.v().scrollHeight / 2); await T.stable()
                    const a = T.first(), sh0 = T.v().scrollHeight
                    const k0 = +a.n.slice(1)
                    let grown = 0
                    for (let k = k0; k < k0 + 12; k++) { T.data().items[k].h += 600; grown += 600 }
                    await T.stable()
                    return { a, b: T.first(), grown, shDelta: T.v().scrollHeight - sh0 }
                })
                check(same(r.a, r.b) && r.shDelta > r.grown * 2, `drift rebuild while in the middle (${anchor}): the view is unchanged (rows below were re-estimated: height +${r.shDelta} for +${r.grown} grown)`, r)
                await done(p, `drift rebuild, ${anchor}`)
            }
            // A prepend changes the key at index 0, so the offsets are rebuilt from scratch, as in the previous
            // release: the prepended row and the re-estimated rows above shift the window's spacer; the model and
            // the DOM still agree
            {
                const p = await open(`/varied?a=${anchor}`)
                const r = await p.evaluate(async () => {
                    T.set(T.v().scrollHeight / 2); await T.stable()
                    const sp = () => parseFloat(T.v().querySelector('[data-virtual-spacer]').style.height)
                    const a = T.first(), s0 = sp(), st0 = T.v().scrollTop
                    T.data().items.unshift({ id: 'u', name: 'u', h: 77 }); await T.stable()
                    return { a, b: T.first(), spacerDelta: Math.round(sp() - s0), scrollDelta: Math.round(T.v().scrollTop - st0), probe: await T.probe(), gap: T.gap() }
                })
                const held = r.a.n === r.b.n && r.a.off === r.b.off
                if (anchor === 'auto') check(held && r.spacerDelta !== 0 && Math.abs(r.scrollDelta - r.spacerDelta) <= 1, 'prepend after a jump, auto: offsets rebuilt (the spacer moves), Chrome\'s anchoring follows it and keeps the row', r)
                else check(!held && r.spacerDelta !== 0 && r.scrollDelta === 0, 'prepend after a jump, none: offsets rebuilt, the view moves by the spacer change (as in the previous release)', r)
                check(r.probe && r.probe.down === 1 && r.probe.back === 1 && r.gap === 0, `prepend after a jump, ${anchor}: model and DOM agree, no gap`, r)
                await done(p, `prepend, ${anchor}`)
            }
            // Random operations: after each, the model agrees with the DOM (1px probe), no gap, the scroll height is
            // spacers plus rows, and after a full walk the total equals the sum of the true heights
            {
                const p = await open(`/varied?a=${anchor}`)
                let seed = 11
                const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
                const bad = []
                for (let step = 0; step < 40; step++) {
                    const r = rnd(), a = rnd(), b = rnd()
                    const op = await p.evaluate(async (r, a, b, step) => {
                        const v = T.v(), items = T.data().items
                        let op
                        if (r < 0.2) { op = 'jump'; T.set(v.scrollHeight * a) }
                        else if (r < 0.3) { op = 'scroll'; for (let i = 0; i < 10; i++) { T.set(v.scrollTop + (a < 0.5 ? -90 : 90)); await frames_(1) } }
                        else if (r < 0.45) { op = 'resizeRow'; const rows = T.rows(); const n = rows[Math.floor(a * rows.length)].dataset.n; const it = items.find((x) => x.name === n); if (it) it.h = Math.round(20 + b * 250) }
                        else if (r < 0.55) { op = 'push'; for (let i = 0; i < 10; i++) items.push({ id: 's' + step + '-' + i, name: 's' + step + '-' + i, h: 20 + i * 17 }) }
                        else if (r < 0.62) { op = 'unshift'; items.unshift({ id: 'u' + step, name: 'u' + step, h: 66 }) }
                        else if (r < 0.7) { op = 'splice'; items.splice(Math.floor(a * items.length), 4) }
                        else if (r < 0.77) { op = 'edit'; items[Math.floor(a * items.length)].name += '' }
                        else if (r < 0.88) { op = 'width'; v.style.width = Math.round(260 + a * 300) + 'px' }
                        else { op = 'height'; v.style.height = Math.round(400 + a * 300) + 'px' }
                        await T.stable(6000, 20)
                        return op
                    }, r, a, b, step)
                    const c = await p.evaluate(async () => ({ probe: await T.probe(), gap: T.gap(), sh: T.v().scrollHeight, sum: Math.round(T.total()) }))
                    if (!c.probe || c.probe.down !== 1 || c.probe.back !== 1 || c.gap !== 0 || Math.abs(c.sh - c.sum) > 1) bad.push({ step, op, ...c })
                }
                const fin = await p.evaluate(async () => { const r = await T.through(); return { ...r, truth: T.data().items.reduce((s, x) => s + x.h, 0) } })
                check(bad.length === 0, `random operations (${anchor}): after each, model and DOM agree, no gap, scroll height = spacers + rows`, bad.slice(0, 4))
                check(fin.total === fin.truth && fin.worst === 0, `random operations (${anchor}): after a full walk the total equals the true total`, fin)
                await done(p, `random operations, ${anchor}`)
            }
        }

        // A long-lived list with churn: the height store stays bounded by the list, not by every key ever seen
        {
            const p = await open('/churn')
            const sizes = await p.evaluate(async () => {
                const out = []
                for (let g = 0; g < 150; g++) { T.data().page(100, 30); await frames_(3); if (g % 50 === 49) out.push(heightStore()) }
                return out
            })
            check(sizes.every((n) => n > 0 && n <= 2 * 100 + 100 + 30), 'churn: 150 replaced pages keep the height store bounded', sizes)
            // A page of 600 tall rows, all rendered once (a container tall enough for them) so all are measured
            await p.evaluate(async () => { T.data().page(600, 100); await frames_(3); T.v().style.height = '70000px'; await T.stable(6000, 20) })
            const measured = await p.evaluate(async () => { const n = heightStore(); T.v().style.height = '300px'; await T.stable(6000, 20); return n })
            check(measured >= 600, 'churn: the tall page was measured in full (setup)', measured)
            // Stale keys stop counting toward the estimate for unmeasured rows
            await p.evaluate(async () => { T.data().page(200, 20); await T.stable() })
            const total = await p.evaluate(() => T.v().scrollHeight)
            check(total === 200 * 20, 'churn: after a page of new keys, unmeasured rows are estimated from live rows only', { total, expected: 200 * 20 })
            await done(p, 'churn')
        }

        // Main-thread task time (CDP), so the numbers do not depend on the frame rate
        const timeIt = async (route) => {
            const p = await open(route)
            const task = async () => (await p.metrics()).TaskDuration * 1000
            let t0 = await task()
            await p.evaluate(async () => {
                const v = T.v()
                for (let i = 1; i <= 60; i++) { T.set(i * 40000); await frames_(2) }
                for (let i = 59; i >= 0; i--) { T.set(i * 40000); await frames_(2) }
                await frames_(3)
            })
            const scroll = (await task()) - t0
            t0 = await task()
            await p.evaluate(async () => { for (let i = 0; i < 20; i++) { T.data().items.push({ id: 'p' + i, name: 'p' + i }); await frames_(2) } })
            const push = ((await task()) - t0) / 20
            const rows = await p.evaluate(() => T.rows().length)
            await p.close()
            return { scroll: Math.round(scroll), push: Math.round(push * 10) / 10, rows }
        }
        // Alternate builds and keep each one's best run: the machine may be busy
        const best = (a, b) => (a ? { scroll: Math.min(a.scroll, b.scroll), push: Math.min(a.push, b.push), rows: b.rows } : b)
        let now = null, old = null
        for (let round = 0; round < (BASELINE ? 3 : 1); round++) {
            if (BASELINE) old = best(old, await timeIt('/perf-baseline'))
            now = best(now, await timeIt('/perf'))
        }
        console.log('perf (this build): 120 fast-scroll frames', now.scroll, 'ms main thread; per push', now.push, 'ms; rows in DOM', now.rows)
        check(now.rows < 200, '100k items: the window stays bounded', now.rows)
        if (BASELINE) {
            console.log('perf (baseline):   120 fast-scroll frames', old.scroll, 'ms main thread; per push', old.push, 'ms; rows in DOM', old.rows)
            check(now.scroll <= old.scroll * 1.3 + 50 && now.push <= old.push * 1.3 + 5, '100k items: fast scroll and push not slower than the baseline', { now, old })
        }
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 }
    else console.log('\nall passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
