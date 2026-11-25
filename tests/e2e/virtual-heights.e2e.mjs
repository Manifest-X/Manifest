/**
 * Real-Chrome guard for x-virtual row heights that change after the first measurement:
 * rows that grow or shrink (at the top, inside, above and below the window), async text,
 * a container width change that re-wraps text, table rows and display:contents grid rows.
 * The offset model must follow: scroll height equals the true total after a full scroll,
 * no blank gap at the window edge, no jump when a row above the viewport grows.
 * Stored heights of keys that left the source are dropped, and stop counting toward the estimate.
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

const HELPERS = `<script>
window.frames_ = (k = 3) => new Promise((r) => { const f = () => (--k <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) })
window.T = {
  v: () => document.getElementById('v'),
  rows: () => [...document.querySelectorAll('#v .r')],
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
  async through(step = 250) {
    const v = this.v()
    let worst = 0
    v.scrollTop = 0
    await frames_(4)
    for (let y = 0, i = 0; i < 2000; y += step, i++) {
      v.scrollTop = y
      await frames_(3)
      worst = Math.max(worst, this.gap())
      if (v.scrollTop + v.clientHeight >= v.scrollHeight - 1) break
    }
    for (let i = 0; i < 4; i++) { v.scrollTop = v.scrollHeight; await frames_(3) }
    return { worst, total: v.scrollHeight }
  },
  data: () => Alpine.$data(document.getElementById('app')),
}
</script>`

const shell = (body, script = '/scripts/manifest.virtual.js') => `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;font:16px/20px sans-serif} #v{overflow-anchor:auto} .r{box-sizing:border-box;overflow:hidden} .w{word-break:break-word} td,th{padding:0} .g{flex:0 0 100px}</style>
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

const grid = (n) => shell(`<div id="app" x-data="{ items: Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, h: 30 })) }">
  <div id="v" x-virtual="{ estimate: 30 }" style="display:grid;grid-template-columns:1fr 1fr;align-content:start;height:300px;width:400px;overflow:auto">
    <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" style="display:contents"><div :style="'height:' + row.h + 'px'" x-text="row.name"></div><div>x</div></div></template>
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
                '/perf': () => perf('/scripts/manifest.virtual.js'),
                '/perf-baseline': () => perf('/baseline/scripts/manifest.virtual.js'),
            }[u.pathname]
            res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' })
            res.end(html ? html() : 'not found')
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
        await wait(500)
        return p
    }
    const settle = (p) => p.evaluate(() => frames_(6)).then(() => wait(150))
    try {
        // Rows that grow after the first paint: at the top, inside, below the window
        for (const [where, k] of [['top (row 0)', 0], ['inside the window', 3], ['below the viewport', 12]]) {
            const p = await open('/fixed?n=300')
            const mounted = await p.evaluate((k) => !!document.querySelector(`#v .r[data-n="n${k}"]`), k)
            await p.evaluate((k) => { T.data().items[k].h = 200 }, k)
            await settle(p)
            const r = await p.evaluate(() => T.through())
            check(mounted && r.total === 299 * 30 + 200, `fixed rows, grow ${where}: scroll height equals the true total after a full scroll`, { rendered: mounted, total: r.total, expected: 299 * 30 + 200 })
            check(r.worst === 0, `fixed rows, grow ${where}: no blank gap while scrolling through`, r.worst)
            check(p.errors.length === 0, `fixed rows, grow ${where}: no page errors`, p.errors)
            await p.close()
        }

        // A row above the viewport grows: the first visible row stays put
        {
            const p = await open('/fixed?n=300')
            await p.evaluate(() => { T.v().scrollTop = 30 * 150 })
            await settle(p)
            const before = await p.evaluate(() => ({ first: T.first(), top: T.v().scrollTop, mounted: !!document.querySelector('#v .r[data-n="n148"]') }))
            await p.evaluate(() => { T.data().items[148].h = 230 })
            await settle(p)
            const after = await p.evaluate(() => ({ first: T.first(), top: T.v().scrollTop }))
            check(before.mounted && before.first.n === after.first.n && Math.abs(before.first.off - after.first.off) <= 1, 'fixed rows, grow above the viewport: no scroll jump', { before, after })
            // Scroll on in steps while the grown row leaves the window: the content moves by the step, never more
            const steps = await p.evaluate(async () => {
                const v = T.v(), at = () => { const f = T.first(), k = +f.n.slice(1); return 30 * k + (k > 148 ? 200 : 0) - f.off }
                const moved = []
                let prev = at()
                for (let i = 0; i < 16; i++) { v.scrollTop += 50; await frames_(3); const now = at(); moved.push(Math.round(now - prev)); prev = now }
                return moved
            })
            check(steps.every((d) => Math.abs(d - 50) <= 1), 'fixed rows, grow above the viewport: scrolling on as the grown row leaves moves the content by the scroll step only', steps)
            const r = await p.evaluate(() => T.through())
            check(r.total === 299 * 30 + 230, 'fixed rows, grow above the viewport: scroll height equals the true total', { total: r.total, expected: 299 * 30 + 230 })
            await p.close()
        }

        // Rows that shrink: the window refills, no blank space at its edge
        {
            const p = await open('/fixed?n=300&h=100')
            await p.evaluate(() => { for (const it of T.data().items) it.h = 10 })
            await settle(p)
            const gap = await p.evaluate(() => T.gap())
            check(gap === 0, 'fixed rows, shrink in the window: no blank gap at the window edge', gap)
            const r = await p.evaluate(() => T.through())
            check(r.total === 3000 && r.worst === 0, 'fixed rows, shrink: true total and no gap after a full scroll', r)
            await p.close()
        }

        // Async content: a row's text arrives later and wraps
        {
            const p = await open('/text?n=200')
            await p.evaluate(() => { T.data().items[2].body = 'late '.repeat(300) })
            await settle(p)
            const r = await p.evaluate(() => T.through())
            const truth = await p.evaluate(() => { const ref = document.getElementById('ref'); ref.style.width = T.v().clientWidth + 'px'; return ref.scrollHeight })
            check(r.total === truth && r.worst === 0, 'text rows, content arrives after mount: true total, no gap', { ...r, truth })
            await p.close()
        }

        // Container width change re-wraps text: heights measured at the old width are stale
        {
            const p = await open('/text?n=200')
            await p.evaluate(() => T.through())
            await p.evaluate(() => { T.v().scrollTop = T.v().scrollHeight / 2 })
            await settle(p)
            // The browser re-wraps the rendered rows itself in the resize frame; dropping stale heights must not move on from there
            const native = await p.evaluate(async () => { T.v().style.width = '160px'; await frames_(1); return T.first() })
            await wait(400)
            await settle(p)
            const after = await p.evaluate(() => T.first())
            check(native.n === after.n && Math.abs(native.off - after.off) <= 1, 'text rows, narrower container: forgetting stale heights does not scroll away', { native, after })
            const r = await p.evaluate(() => T.through())
            const truth = await p.evaluate(() => { const ref = document.getElementById('ref'); ref.style.width = T.v().clientWidth + 'px'; return ref.scrollHeight })
            check(r.total === truth && r.worst === 0, 'text rows, narrower container: true total, no gap after a full scroll', { ...r, truth })
            await p.evaluate(() => { T.v().style.width = '400px' })
            await wait(400)
            await settle(p)
            const r2 = await p.evaluate(() => T.through())
            const truth2 = await p.evaluate(() => { const ref = document.getElementById('ref'); ref.style.width = T.v().clientWidth + 'px'; return ref.scrollHeight })
            check(r2.total === truth2 && r2.worst === 0, 'text rows, wider again: true total, no gap', { ...r2, truth: truth2 })
            check(p.errors.length === 0, 'text rows: no page errors', p.errors)
            await p.close()
        }

        // Table rows and display:contents grid rows
        for (const route of ['/table', '/grid']) {
            const p = await open(route + '?n=300')
            // Row 3 leaves and comes back first: a remounted row is observed too
            await p.evaluate(async () => { T.v().scrollTop = 3000; await frames_(4); T.v().scrollTop = 0; await frames_(4) })
            await p.evaluate(() => { T.data().items[3].h = 200 })
            await settle(p)
            const r = await p.evaluate(() => T.through())
            const head = route === '/table' ? 30 : 0
            check(r.total === head + 299 * 30 + 200 && r.worst === 0, `${route}: a grown row keeps the true total and no gap`, { ...r, expected: head + 299 * 30 + 200 })
            await p.evaluate(() => { T.v().scrollTop = 30 * 150 })
            await settle(p)
            const before = await p.evaluate(() => T.first())
            await p.evaluate(() => { T.data().items[148].h = 130 })
            await settle(p)
            const after = await p.evaluate(() => T.first())
            check(before.n === after.n && Math.abs(before.off - after.off) <= 1, `${route}: a row above the viewport grows without a jump`, { before, after })
            check(p.errors.length === 0, `${route}: no page errors`, p.errors)
            await p.close()
        }

        // 100,000 items: a fast scroll and a push stay as fast as before
        // Gallery (flex-wrap): a taller item makes its line taller
        {
            const p = await open('/gallery?n=200')
            await p.evaluate(() => { T.data().items[5].h = 200 })
            await settle(p)
            const r = await p.evaluate(() => T.through())
            check(r.total === 49 * 30 + 200 && r.worst === 0, '/gallery: a grown item keeps the true total and no gap', { ...r, expected: 49 * 30 + 200 })
            await p.close()
        }

        // Masonry: measured items re-pack when one grows; with an author height function nothing is observed
        {
            const p = await open('/masonry')
            const at = () => p.evaluate(() => { const n = document.querySelector('#v .r[data-n="n3"]'); return n.style.top + '/' + n.style.left })
            const start = await at()
            await p.evaluate(() => { T.data().items[0].h = 140 })
            await settle(p)
            const after = await at()
            check(start === '40px/0px' && after === '40px/100px', '/masonry: a measured item that grows re-packs the layout', { start, after })
            await p.close()
            const q = await open('/masonry-fn')
            const observed = await q.evaluate(() => window.__observed)
            check(observed === 0 && (await q.evaluate(() => T.rows().length)) > 0, '/masonry with a height function: items are not observed or measured', observed)
            await q.close()
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
            // Stale keys stop counting toward the estimate for unmeasured rows
            // A page of 600 tall rows, all rendered once (a container tall enough for them) so all are measured
            await p.evaluate(async () => { T.data().page(600, 100); await frames_(3); T.v().style.height = '70000px' })
            await wait(400)
            const measured = await p.evaluate(async () => { await frames_(6); const n = heightStore(); T.v().style.height = '300px'; return n })
            await wait(400)
            check(measured >= 600, 'churn: the tall page was measured in full (setup)', measured)
            await p.evaluate(async () => { T.data().page(200, 20); await frames_(8) })
            await settle(p)
            const total = await p.evaluate(() => T.v().scrollHeight)
            check(total === 200 * 20, 'churn: after a page of new keys, unmeasured rows are estimated from live rows only', { total, expected: 200 * 20 })
            check(p.errors.length === 0, 'churn: no page errors', p.errors)
            await p.close()
        }

        // Main-thread task time (CDP), so the numbers do not depend on the frame rate
        const timeIt = async (route) => {
            const p = await open(route)
            const task = async () => (await p.metrics()).TaskDuration * 1000
            let t0 = await task()
            await p.evaluate(async () => {
                const v = T.v()
                for (let i = 1; i <= 60; i++) { v.scrollTop = i * 40000; await frames_(2) }
                for (let i = 59; i >= 0; i--) { v.scrollTop = i * 40000; await frames_(2) }
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
