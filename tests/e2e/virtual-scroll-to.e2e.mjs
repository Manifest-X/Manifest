/**
 * Real-Chrome guard for `$virtual(...).scrollToIndex()` / `scrollToKey()` on x-virtual lists: the target row's
 * on-screen position after the jump, within 1px, for uniform and late-measured variable heights, table (sticky
 * header via scroll-padding, and `offset`), display:contents grid rows, grid and flex-wrap galleries, RTL,
 * masonry, a list nested in another scroller, recycle on, top to last and back, a jump during a smooth scroll,
 * smooth scrolls, out-of-range and unknown targets, a hidden list, and source changes during a smooth scroll.
 * Focus never moves. Lists that never call it pay nothing (listeners, observers, boot and scroll time).
 *
 * Run: node tests/e2e/virtual-scroll-to.e2e.mjs   (VIRTUAL_SRC=<dir with scripts/> to A/B;
 * VIRTUAL_BASELINE=<dir with scripts/> also times boot and scroll of a list that never calls it against it)
 */
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, existsSync } from 'fs'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SRC = process.env.VIRTUAL_SRC || path.join(ROOT, 'src')
const BASELINE = process.env.VIRTUAL_BASELINE || null
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.js')

const TOL = 1

// Listeners/observers created for #v, and the harness API
const HELPERS = `<script>
window.__listen = []
const add = EventTarget.prototype.addEventListener
EventTarget.prototype.addEventListener = function (type) { if (this && this.id === 'v') window.__listen.push(type); return add.apply(this, arguments) }
window.__writes = []; window.__harness = false
const sd = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get() { return sd.get.call(this) }, set(x) { if (this.id === 'v' && !window.__harness) window.__writes.push(performance.now()); sd.set.call(this, x) } })
for (const m of ['scrollTo', 'scrollBy', 'scroll']) { const f = Element.prototype[m]; Element.prototype[m] = function () { if (this.id === 'v' && !window.__harness) window.__writes.push(performance.now()); return f.apply(this, arguments) } }
window.__obs = 0
for (const C of ['ResizeObserver', 'MutationObserver', 'IntersectionObserver']) { const O = window[C]; window[C] = class extends O { constructor(cb) { super(cb); window.__obs++ } } }
window.H = (k) => 20 + ((k * 2654435761) >>> 0) % 181
window.frames_ = (k = 3) => new Promise((r) => { const f = () => (--k <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) })
window.T = {
  v: () => document.getElementById('v'),
  data: () => Alpine.$data(document.getElementById('app')),
  api: (t = 'v') => Alpine.evaluate(document.getElementById('app'), '$virtual(' + JSON.stringify(t) + ')'),
  set(y) { window.__harness = true; this.v().scrollTop = y; window.__harness = false },
  row: (n) => document.querySelector('#v .r[data-n="n' + n + '"]'),
  box(r) {
    if (getComputedStyle(r).display !== 'contents') return r.getBoundingClientRect()
    let top = Infinity, bottom = -Infinity
    for (const c of r.children) { const b = c.getBoundingClientRect(); if (!b.height) continue; top = Math.min(top, b.top); bottom = Math.max(bottom, b.bottom) }
    return { top, bottom }
  },
  // Target row relative to the scroller's client box
  at(n) {
    const r = this.row(n); if (!r) return null
    const v = this.v(), b = this.box(r), t = v.getBoundingClientRect().top + v.clientTop
    return { top: Math.round((b.top - t) * 10) / 10, bottom: Math.round((b.bottom - t) * 10) / 10, vh: v.clientHeight, st: Math.round(v.scrollTop), max: v.scrollHeight - v.clientHeight }
  },
  async go(method, arg, opts, t) {
    const el = await this.api(t)[method](arg, opts)
    await frames_(2)
    return { el: el ? (el.dataset.n || el.tagName) : null }
  },
  sig() { const v = this.v(); return [Math.round(v.scrollTop), v.scrollHeight, ...[...v.querySelectorAll('[data-virtual-spacer]')].map((s) => s.style.height)].join('|') },
  async stable(ms = 6000, quiet = 8) {
    const t0 = performance.now(); let last = this.sig(), same = 0
    while (performance.now() - t0 < ms) { await frames_(1); const s = this.sig(); same = s === last ? same + 1 : 0; last = s; if (same >= quiet) return true }
    return false
  },
}
</script>`

const shell = (body, script = '/scripts/manifest.virtual.js', dir = 'ltr') => `<!doctype html><html dir="${dir}"><head><meta charset="utf-8">
<style>body{margin:0;font:16px/20px sans-serif} .r{box-sizing:border-box;overflow:hidden} td,th{padding:0}</style>
${HELPERS}<script src="${script}"></script><script defer src="/__alpine.js"></script></head><body>${body}</body></html>`

const items = (n, h) => `Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, h: ${h === 'v' ? 'H(k)' : h} }))`

// One page per layout; q: n, h ('v' varied or px), recycle, est, wrap (nested|hidden), rtl
function page(layout, q) {
    const n = Number(q.get('n')) || 3000, h = q.get('h') || 'v', est = Number(q.get('est')) || 40
    const rec = q.get('recycle') ? ', recycle: true' : ''
    const box = 'height:600px;width:400px;overflow:auto;' + (q.get('style') || '')
    const rowAttr = q.get('row') || ''
    let list
    if (layout === 'block') list = `<div id="v" x-virtual="{ estimate: ${est}${rec} }" style="${box}">
      <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template></div>`
    else if (layout === 'auto') list = `<div id="v" x-virtual="{ estimate: ${est}${rec} }" style="${box}">
      <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" ${rowAttr}><span x-text="row.name"></span><div class="pad" :style="'height:' + row.h + 'px'"></div></div></template></div>`
    else if (layout === 'snap') list = `<div id="v" x-virtual="{ estimate: ${est}${rec} }" style="${box};scroll-snap-type:y ${q.get('snap') || 'mandatory'}">
      <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'scroll-snap-align:start;height:' + row.h + 'px'" x-text="row.name"></div></template></div>`
    else if (layout === 'table') list = `<div id="v" x-virtual="{ estimate: ${est}${rec} }" style="${box};scroll-padding-top:30px">
      <table style="width:100%;border-collapse:collapse;border-spacing:0"><thead style="position:sticky;top:0;background:#fff"><tr><th style="height:30px">h</th><th>x</th></tr></thead>
      <tbody><template x-for="row in items" :key="row.id"><tr class="r" :data-n="row.name"><td :style="'height:' + row.h + 'px'" x-text="row.name"></td><td>x</td></tr></template></tbody></table></div>`
    else if (layout === 'contents') list = `<div id="v" x-virtual="{ estimate: ${est}${rec} }" style="display:grid;grid-template-columns:1fr 1fr;align-content:start;${box}">
      <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" style="display:contents"><div :style="'height:' + row.h + 'px'" x-text="row.name"></div><div>x</div></div></template></div>`
    else if (layout === 'grid') list = `<div id="v" x-virtual="{ mode: 'gallery', estimate: { width: 90, height: ${est} }${rec} }" style="display:grid;grid-template-columns:repeat(4, 1fr);gap:4px;align-content:start;align-items:start;${box}">
      <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template></div>`
    else if (layout === 'flex') list = `<div id="v" x-virtual="{ estimate: { width: 100, height: ${est} }${rec} }" style="display:flex;flex-wrap:wrap;align-content:flex-start;align-items:flex-start;${box.replace('overflow:auto', 'overflow-y:scroll;overflow-x:hidden;scrollbar-width:none')}">
      <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'flex:0 0 100px;height:' + row.h + 'px'" x-text="row.name"></div></template></div>`
    else if (layout === 'masonry') list = `<div id="v" x-virtual="{ mode: 'masonry', columns: 3, gap: 0 }" style="${box};position:relative">
      <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template></div>`
    const wrap = q.get('wrap')
    if (wrap === 'nested') list = `<div id="outer" style="height:500px;overflow:auto"><div style="height:300px">above</div>${list}<div style="height:800px">below</div></div>`
    if (wrap === 'hidden') list = `<div x-show="shown">${list}</div>`
    return shell(`${q.get('body') || ''}<button id="outside">outside</button><div id="app" x-data="{ shown: ${wrap === 'hidden' ? 'false' : 'true'}, items: ${items(n, h)} }">${list}</div>`,
        q.get('base') ? '/baseline/scripts/manifest.virtual.js' : '/scripts/manifest.virtual.js', q.get('rtl') ? 'rtl' : 'ltr')
}

// On-use loader, no x-virtual on the page until the list is added later (as a route or component would)
const ONUSE_LIST = `<div id="v" x-virtual="{ estimate: 40 }" style="height:600px;width:400px;overflow:auto"><template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template></div>`
const ONUSE = `<!doctype html><html><head><meta charset="utf-8">${HELPERS}<link rel="manifest" href="/manifest.json"><script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"></script></head><body>
<div id="app" x-data="{ items: ${items(3000, 'v')} }">
  <button id="early" @click="window.__early = $virtual('v').scrollToIndex(10)">early</button>
  <button id="go" @click="window.__go = $virtual('v').scrollToIndex(1200)">go</button>
  <div id="slot"></div>
</div>
<script>window.addList = () => { const s = document.getElementById('slot'); s.innerHTML = atob('${Buffer.from(ONUSE_LIST).toString('base64')}') }</script></body></html>`

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            const js = (file) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(file)) }
            if (u.pathname === '/__alpine.js') return js(ALPINE)
            if (u.pathname === '/scripts/manifest.virtual.js') return js(path.join(SRC, 'scripts/manifest.virtual.js'))
            if (u.pathname === '/baseline/scripts/manifest.virtual.js' && BASELINE) return js(path.join(BASELINE, 'scripts/manifest.virtual.js'))
            if (u.pathname === '/manifest.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"name":"v"}') }
            if (/^\/scripts\/manifest(\.[\w.]+)?\.js$/.test(u.pathname)) { const f = path.join(SRC, u.pathname); if (!existsSync(f)) { res.writeHead(404); return res.end() } return js(f) }
            if (u.pathname === '/onuse') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(ONUSE) }
            const layout = u.pathname.slice(1)
            const ok = ['block', 'auto', 'snap', 'table', 'contents', 'grid', 'flex', 'masonry'].includes(layout)
            res.writeHead(ok ? 200 : 404, { 'content-type': 'text/html' })
            res.end(ok ? page(layout, u.searchParams) : 'not found')
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

async function main() {
    const server = await serve()
    const base = `http://127.0.0.1:${server.address().port}`
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
    const fails = []
    const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
    const open = async (route, ready = true, dpr) => {
        const p = await browser.newPage()
        if (dpr) await p.setViewport({ width: 1000, height: 800, deviceScaleFactor: dpr })
        p.errors = []; p.warns = []
        p.on('pageerror', (e) => p.errors.push(e.message))
        p.on('console', (m) => { if ((m.type() === 'warning' || m.type() === 'warn')) p.warns.push(m.text()) })
        await p.goto(base + route, { waitUntil: 'load' })
        await p.waitForFunction(() => window.Alpine && document.querySelector('#v [data-virtual-spacer]') && window.T, { timeout: 10000 })
        if (ready) await p.evaluate(() => T.stable())
        return p
    }
    const run = (p, fn, ...args) => p.evaluate(fn, ...args).catch((e) => ({ error: e.message.split('\n')[0] }))
    const done = async (p, label) => {
        check(p.errors.length === 0, `${label}: no page errors`, p.errors)
        await p.close()
    }
    // Aligned: start = top at pad, end = bottom at the view's bottom, center = centred; clamped at either end
    const aligned = (a, align = 'start', pad = 0) => {
        if (!a) return false
        if (a.st <= 0 && a.top >= pad - TOL) return true
        if (a.st >= a.max - 1 && a.bottom <= a.vh + TOL) return true
        if (align === 'start') return Math.abs(a.top - pad) <= TOL
        if (align === 'end') return Math.abs(a.bottom - a.vh) <= TOL
        if (align === 'center') return Math.abs((a.top + a.bottom) / 2 - (a.vh + pad) / 2) <= TOL
        return a.top >= pad - TOL && a.bottom <= a.vh + TOL
    }
    const land = async (p, label, n, opts, method = 'scrollToIndex', arg = n, pad = 0) => {
        const r = await run(p, async (m, a, o) => T.go(m, a, o), method, arg, opts || {})
        const a = await run(p, (n) => T.at(n), n)
        check(!r.error && r.el === 'n' + n && aligned(a, opts && opts.align, pad), label, { r, at: a })
        return a
    }
    try {
        // Uniform heights
        {
            const p = await open('/block?h=30&est=30&n=5000')
            await land(p, 'uniform: index 2500, start', 2500)
            await land(p, 'uniform: index 1000, center', 1000, { align: 'center' })
            await land(p, 'uniform: index 4000, end', 4000, { align: 'end' })
            const a0 = await run(p, () => T.at(4000))
            await land(p, 'uniform: index 3995 (on screen), nearest: no move', 3995, { align: 'nearest' })
            const a1 = await run(p, () => T.at(4000))
            check(a0 && a1 && a0.st === a1.st, 'uniform: nearest on a visible row leaves scrollTop as it was', { a0, a1 })
            await land(p, 'uniform: scrollToKey(1234)', 1234, {}, 'scrollToKey', 1234)
            await done(p, 'uniform')
        }

        // Variable heights, measured late; top to last and back
        for (const rec of ['', '&recycle=1']) {
            const tag = rec ? 'variable + recycle' : 'variable'
            const p = await open('/block?h=v' + rec)
            await land(p, `${tag}: index 2000 (estimate 40, true 20..200), start`, 2000)
            await land(p, `${tag}: index 1500, center`, 1500, { align: 'center' })
            await land(p, `${tag}: index 700, end`, 700, { align: 'end' })
            const last = await land(p, `${tag}: last index, start (clamped to the end)`, 2999)
            check(last && last.st >= last.max - 1 && Math.abs(last.bottom - last.vh) <= TOL, `${tag}: last row's bottom is the view's bottom`, last)
            await land(p, `${tag}: back to index 0`, 0)
            const top = await run(p, () => T.v().scrollTop)
            check(top === 0, `${tag}: back at scrollTop 0`, top)
            // Positions hold once the browser is idle
            await run(p, () => T.go('scrollToIndex', 2400))
            await run(p, () => T.stable())
            const held = await run(p, () => T.at(2400))
            check(aligned(held), `${tag}: index 2400 is still at the top once idle`, held)
            if (rec) {
                const rows = await run(p, () => document.querySelectorAll('#v .r').length)
                check(rows < 60, 'recycle: the window stays bounded after jumps', rows)
            }
            await done(p, tag)
        }

        // Table with a sticky header (scroll-padding-top) and an offset
        {
            const p = await open('/table?h=v')
            await land(p, 'table: index 1800 sits below the sticky header (scroll-padding-top 30)', 1800, {}, 'scrollToIndex', 1800, 30)
            await land(p, 'table: offset 20 adds to it', 900, { offset: 20 }, 'scrollToIndex', 900, 50)
            await done(p, 'table')
        }

        // display:contents grid rows; gallery grid (4 per line); flex-wrap gallery; RTL; masonry
        for (const [route, label] of [['/contents?h=v', 'grid-table rows'], ['/grid?h=v&n=8000', 'grid gallery, 4 per line'], ['/flex?h=v&n=8000', 'flex-wrap gallery'], ['/flex?h=v&n=8000&rtl=1', 'flex-wrap gallery, RTL'], ['/masonry?h=v&n=2000', 'masonry, measured heights']]) {
            const p = await open(route)
            await land(p, `${label}: index 1234, start`, 1234)
            await land(p, `${label}: index 1802, center`, 1802, { align: 'center' })
            await land(p, `${label}: index 77, end`, 77, { align: 'end' })
            await done(p, label)
        }

        // Nested in another scroller: only the list scrolls
        {
            const p = await open('/block?h=v&wrap=nested')
            await run(p, () => { document.getElementById('outer').scrollTop = 120 })
            await land(p, 'nested: index 2100 at the top of the list', 2100)
            const outer = await run(p, () => document.getElementById('outer').scrollTop)
            check(outer === 120, 'nested: the outer scroller does not move', outer)
            await done(p, 'nested')
        }

        // No visible oscillation: an instant jump is final in the first frame; a smooth one only moves forward
        {
            const p = await open('/block?h=v')
            const r = await run(p, async () => {
                const seen = []; let on = true
                const tick = () => { if (!on) return; seen.push(T.at(2200)?.top ?? null); requestAnimationFrame(tick) }
                const pr = T.api().scrollToIndex(2200)
                requestAnimationFrame(tick)
                await pr; await frames_(10); on = false
                return seen
            })
            check(Array.isArray(r) && r.length > 3 && r.every((t) => t !== null && Math.abs(t) <= TOL), 'instant jump into unmeasured rows: the target is in place from the first frame', r)
            const s = await run(p, async () => {
                T.v().scrollTop = 0; await T.stable()
                const seen = []; let on = true
                const tick = () => { if (!on) return; seen.push(Math.round(T.v().scrollTop)); requestAnimationFrame(tick) }
                requestAnimationFrame(tick)
                const el = await T.api().scrollToIndex(1900, { behavior: 'smooth' })
                await frames_(4); on = false
                const back = seen.slice(1).map((y, i) => seen[i] - y).filter((d) => d > 0)
                return { frames: seen.length, back, el: el && el.dataset.n, at: T.at(1900) }
            })
            check(!s.error && s.el === 'n1900' && aligned(s.at) && s.back.every((d) => d <= TOL), 'smooth jump into unmeasured rows: never moves backwards, lands', s)
            await done(p, 'oscillation')
        }

        // Smooth, and a jump while a smooth scroll is in flight
        {
            const p = await open('/block?h=v')
            await land(p, 'smooth: index 1600 lands', 1600, { behavior: 'smooth' })
            const r = await run(p, async () => {
                const first = T.api().scrollToIndex(2800, { behavior: 'smooth' })
                await frames_(6)
                const mid = T.v().scrollTop
                const second = T.api().scrollToIndex(300)
                const [a, b] = await Promise.all([first, second])
                await T.stable()
                return { first: a && a.dataset.n, second: b && b.dataset.n, mid: Math.round(mid), at: T.at(300) }
            })
            check(!r.error && r.first === null && r.second === 'n300' && aligned(r.at), 'smooth in flight, then an instant jump: the first resolves null, the second lands and holds', r)
            const r2 = await run(p, async () => {
                const first = T.api().scrollToIndex(100, { behavior: 'smooth' })
                await frames_(4)
                const second = T.api().scrollToIndex(2500, { behavior: 'smooth' })
                const [a, b] = await Promise.all([first, second])
                await T.stable()
                return { first: a && a.dataset.n, second: b && b.dataset.n, at: T.at(2500) }
            })
            check(!r2.error && r2.first === null && r2.second === 'n2500' && aligned(r2.at), 'smooth in flight, then another smooth: the second lands', r2)
            // A real wheel by the user cancels a smooth scroll
            await run(p, () => { window.__w = undefined; T.api().scrollToIndex(10, { behavior: 'smooth' }).then((e) => { window.__w = e ? e.dataset.n : null }) })
            await run(p, () => frames_(4))
            const vb = await (await p.$('#v')).boundingBox()
            await p.mouse.move(vb.x + 100, vb.y + 300)
            await p.mouse.wheel({ deltaY: 120 })
            await p.waitForFunction(() => window.__w !== undefined, { timeout: 3000 }).catch(() => null)
            const r3 = { el: await run(p, () => window.__w) }
            check(!r3.error && r3.el === null, 'smooth: a wheel by the user cancels it (resolves null)', r3)
            await done(p, 'smooth')
        }

        // Out of range, unknown key, bad input
        {
            const p = await open('/block?h=v')
            const r = await run(p, async () => {
                T.v().scrollTop = 500; await T.stable()
                const out = []
                for (const [m, a] of [['scrollToIndex', 3000], ['scrollToIndex', -1], ['scrollToIndex', 1.5], ['scrollToIndex', 'x'], ['scrollToKey', 'nope']]) out.push(await T.api()[m](a))
                return { out: out.map((e) => e === null), st: T.v().scrollTop }
            })
            check(!r.error && r.out.every(Boolean) && r.st === 500, 'out of range / unknown key: resolves null, does not scroll', r)
            check(p.warns.filter((w) => w.includes('[x-virtual]')).length >= 5, 'out of range / unknown key: each warns', p.warns)
            const none = await run(p, async () => (await T.api('missing').scrollToIndex(1)) === null)
            check(none === true && p.warns.some((w) => w.includes('missing')), '$virtual(unknown id): resolves null and warns', none)
            await done(p, 'out of range')
        }

        // Hidden list: waits until shown
        {
            const p = await open('/block?h=v&wrap=hidden', false)
            const r = await run(p, async () => {
                let settled = false
                const pr = T.api().scrollToIndex(700).then((e) => { settled = true; return e })
                await frames_(10)
                const early = settled
                T.data().shown = true
                const el = await pr
                await frames_(2)
                return { early, el: el && el.dataset.n, at: T.at(700) }
            })
            check(!r.error && r.early === false && r.el === 'n700' && aligned(r.at), 'hidden list: waits while hidden, lands once shown', r)
            await done(p, 'hidden')
        }

        // Source changes during a smooth scroll
        {
            const p = await open('/block?h=v')
            const r = await run(p, async () => {
                const pr = T.api().scrollToKey(2000, { behavior: 'smooth' })
                await frames_(5)
                const d = T.data()
                d.items.unshift(...Array.from({ length: 50 }, (_, k) => ({ id: 'u' + k, name: 'u' + k, h: 60 })))
                await frames_(3)
                d.items.splice(100, 10)
                await frames_(3)
                d.items.push({ id: 'z', name: 'z', h: 30 })
                const el = await pr
                await T.stable()
                return { el: el && el.dataset.n, at: T.at(2000) }
            })
            check(!r.error && r.el === 'n2000' && aligned(r.at), 'source change mid-scroll (unshift 50, remove 10 before, push): the same item lands', r)
            const r2 = await run(p, async () => {
                const pr = T.api().scrollToIndex(2900, { behavior: 'smooth' })
                await frames_(4)
                const d = T.data()
                const gone = d.items[2900].name
                d.items.splice(2900, 1)
                const el = await pr
                return { el: el && el.dataset.n, left: d.items.some((x) => x.name === gone) }
            })
            check(!r2.error && r2.el === null, 'target removed mid-scroll: resolves null', r2)
            await done(p, 'source change')
        }

        // Focus stays where it was
        {
            const p = await open('/block?h=v&recycle=1')
            const r = await run(p, async () => {
                document.getElementById('outside').focus()
                await T.go('scrollToIndex', 1700)
                const same = document.activeElement.id
                const el = await T.api().scrollToIndex(1700)
                el.tabIndex = -1; el.focus({ preventScroll: true })
                await frames_(2)
                return { same, now: document.activeElement === el, at: T.at(1700) }
            })
            check(!r.error && r.same === 'outside' && r.now && aligned(r.at), 'focus: not moved by the jump; focus({ preventScroll }) on the resolved row keeps it in place', r)
            await done(p, 'focus')
        }

        // Rows that size late, after the target first landed: followed until quiet
        {
            const grow = encodeURIComponent(`x-init="setTimeout(() => $el.querySelector('.pad').style.height = (row.h + 80) + 'px', 120)"`)
            const img = encodeURIComponent(`x-init="const i = new Image(); i.style.display = 'block'; i.width = 50; setTimeout(() => { i.height = 50 + (row.id % 7) * 20; $el.appendChild(i) }, 40 + (row.id % 5) * 30)"`)
            for (const [route, label, n, opts] of [[`/auto?row=${grow}`, 'rows grow 80px 120ms after mount, center', 1800, { align: 'center' }], [`/auto?row=${grow}`, 'rows grow 80px 120ms after mount, start', 1400, {}], [`/auto?row=${grow}`, 'rows grow, smooth', 600, { behavior: 'smooth' }], [`/auto?row=${img}`, 'late images 40..160ms, end', 1000, { align: 'end' }], [`/auto?row=${img}`, 'late images, start', 2000, {}]]) {
                const p = await open(route)
                const r = await run(p, async (n, o) => { const el = await T.api().scrollToIndex(n, o); await new Promise((r) => setTimeout(r, 1500)); await T.stable(); return { el: el && el.dataset.n, at: T.at(n) } }, n, opts)
                check(!r.error && r.el === 'n' + n && aligned(r.at, opts.align), `late sizing: ${label}: still aligned once idle`, r)
                await done(p, `late sizing ${label}`)
            }
            // Rows that never stop changing: the follow is bounded, writes stop
            const p = await open('/auto?style=overflow-anchor:none&row=' + encodeURIComponent(`x-init="const f = () => { if (!$el.isConnected) return; $el.querySelector('.pad').style.height = (row.h + (Math.random() * 30 | 0)) + 'px'; requestAnimationFrame(f) }; requestAnimationFrame(f)"`), false)
            const r = await run(p, async () => {
                const el = await Promise.race([T.api().scrollToIndex(1500, { align: 'center' }), new Promise((r) => setTimeout(() => r('TIMEOUT'), 8000))])
                await new Promise((r) => setTimeout(r, 4000))
                const w = window.__writes.length; await frames_(30)
                return { el: el === 'TIMEOUT' ? el : el && el.dataset.n, writesLater: window.__writes.length - w }
            })
            check(!r.error && r.el === 'n1500' && r.writesLater === 0, 'late sizing: rows changing every frame: resolves, and stops writing within the cap', r)
            await p.close()
        }

        // Outside scrolling cancels: keys with focus on <body>, author code; no misfire on DPR, clamping, anchoring
        {
            for (const key of ['PageDown', 'End']) {
                const p = await open('/block')
                const vb = await (await p.$('#v')).boundingBox()
                await p.mouse.click(vb.x + 100, vb.y + 100)
                await run(p, () => T.stable())
                await run(p, () => { window.__k = undefined; T.api().scrollToIndex(2000, { behavior: 'smooth' }).then((e) => { window.__k = e ? e.dataset.n : null }) })
                await run(p, () => frames_(10))
                const active = await run(p, () => document.activeElement.tagName)
                await run(p, () => { window.__mark = performance.now() })
                await p.keyboard.press(key)
                await run(p, () => new Promise((r) => setTimeout(r, 1200)))
                const r = await run(p, () => ({ el: window.__k, writesAfter: window.__writes.filter((t) => t > window.__mark + 50).length }))
                check(!r.error && active === 'BODY' && r.el === null && r.writesAfter === 0, `${key} with focus on <body> during a smooth scroll: cancels (null), no more writes`, { active, ...r })
                await p.close()
            }
            const p = await open('/block')
            const r = await run(p, async () => {
                const pr = T.api().scrollToIndex(2500, { behavior: 'smooth' })
                await frames_(8)
                T.set(100)
                const el = await pr
                const w = window.__writes.length; await frames_(20)
                return { el: el && el.dataset.n, st: T.v().scrollTop, writesLater: window.__writes.length - w }
            })
            check(!r.error && r.el === null && r.st === 100 && r.writesLater === 0, 'author scrollTop = 100 mid-flight: cancels and stays where the author put it', r)
            await p.close()
            for (const dpr of [1.25, 1.5, 2.625]) {
                const q = await open('/auto', true, dpr)
                for (const [n, o] of [[1700, {}], [900, { behavior: 'smooth', align: 'center' }], [2999, {}], [0, { behavior: 'smooth' }]]) {
                    const r = await run(q, async (n, o) => { const el = await T.api().scrollToIndex(n, o); await T.stable(); return { el: el && el.dataset.n, at: T.at(n) } }, n, o)
                    check(!r.error && r.el === 'n' + n && aligned(r.at, o.align), `DPR ${dpr}: index ${n} ${JSON.stringify(o)} lands (no false cancel)`, r)
                }
                await done(q, `DPR ${dpr}`)
            }
            // Mandatory scroll snap: the snapped position is accepted, nothing fights it
            const sn = await open('/snap')
            const rs = await run(sn, async () => {
                const t0 = performance.now()
                const el = await T.api().scrollToIndex(1500)
                const ms = performance.now() - t0
                await new Promise((r) => setTimeout(r, 500))
                const w = window.__writes.length; await frames_(20)
                return { el: el && el.dataset.n, ms: Math.round(ms), writesLater: window.__writes.length - w, at: T.at(1500) }
            })
            check(!rs.error && rs.el === 'n1500' && rs.ms < 2000 && rs.writesLater === 0 && rs.at && rs.at.top > -rs.at.vh && rs.at.top < rs.at.vh, 'scroll-snap mandatory: resolves with the row near the top, then stops', rs)
            await done(sn, 'scroll snap')
        }

        // Odd inputs always settle with null and never throw
        {
            const p = await open('/block')
            const r = await run(p, async () => {
                const api = T.api(), out = {}
                const tryCall = async (label, fn) => { try { const pr = fn(); const v = await Promise.race([pr, new Promise((r) => setTimeout(() => r('PENDING'), 2000))]); out[label] = v === null ? 'null' : v === 'PENDING' ? v : 'value' } catch (e) { out[label] = 'THREW ' + e.message } }
                await tryCall('key null-proto', () => api.scrollToKey(Object.create(null)))
                await tryCall('key throwing toString', () => api.scrollToKey({ toString() { throw new Error('boom') } }))
                await tryCall('key symbol', () => api.scrollToKey(Symbol('x')))
                await tryCall('offset symbol', () => api.scrollToIndex(12, { offset: Symbol() }))
                await tryCall('throwing getter', () => api.scrollToIndex(13, { get align() { throw new Error('g') } }))
                await tryCall('list null-proto', () => Alpine.evaluate(document.getElementById('app'), '{ f: $virtual }').f(Object.create(null)).scrollToIndex(5))
                await tryCall('list symbol', () => Alpine.evaluate(document.getElementById('app'), '{ f: $virtual }').f(Symbol('s')).scrollToIndex(5))
                return out
            })
            check(!r.error && Object.values(r).every((v) => v === 'null'), 'odd keys, options and list targets: settle null, never throw', r)
            await done(p, 'odd inputs')
        }

        // scroll-padding in %, numeric strings, warnings once, repeated smooth calls join
        {
            const p = await open('/block?style=scroll-padding-top:10%')
            await land(p, 'scroll-padding-top 10% (60px of 600)', 1000, {}, 'scrollToIndex', 1000, 60)
            await p.close()
            const q = await open('/block')
            await land(q, "scrollToIndex('1234') (x-model without .number)", 1234, {}, 'scrollToIndex', '1234')
            const nowarn = q.warns.filter((w) => w.includes('[x-virtual]')).length
            await run(q, async () => { await T.api().scrollToIndex(9999); await T.api().scrollToIndex(9999); await T.api().scrollToKey('nope'); await T.api().scrollToKey('nope') })
            const warns = q.warns.filter((w) => w.includes('[x-virtual]'))
            check(nowarn === 0 && warns.length === 2, 'numeric string warns nothing; a repeated warning shows once per list and reason', warns)
            const r = await run(q, async () => {
                T.set(0); await T.stable()
                const all = []; let on = true
                const tick = () => { if (!on) return; all.push(T.api().scrollToIndex(800, { behavior: 'smooth' })); requestAnimationFrame(tick) }
                tick()
                await new Promise((r) => setTimeout(r, 2500)); on = false
                const res = await Promise.all(all)
                await T.stable()
                return { calls: all.length, landed: res.filter((e) => e && e.dataset.n === 'n800').length, at: T.at(800) }
            })
            check(!r.error && r.landed === r.calls && aligned(r.at), 'the same smooth call every frame joins the one in flight and arrives', r)
            await done(q, 'padding, strings, warnings, joins')
        }

        // On-use loader: $virtual before the module or the list exists
        {
            const p = await browser.newPage()
            p.errors = []
            p.on('pageerror', (e) => p.errors.push(e.message))
            await p.goto(base + '/onuse', { waitUntil: 'load' })
            await p.waitForFunction(() => window.Alpine && document.getElementById('early'), { timeout: 10000 })
            await p.click('#early')
            const early = await run(p, async () => { const v = window.__early; return { isPromise: !!v && typeof v.then === 'function', el: v && typeof v.then === 'function' ? await v : 'n/a' } })
            const loadedEarly = await run(p, () => typeof window.ensureVirtualPluginInitialized)
            await run(p, () => window.addList())
            await p.waitForFunction(() => document.querySelector('#v [data-virtual-spacer]'), { timeout: 10000 })
            await run(p, () => T.stable())
            await p.click('#go')
            const go = await run(p, async () => { const el = await window.__go; return { el: el && el.dataset.n, at: T.at(1200) } })
            check(!early.error && early.isPromise && early.el === null && loadedEarly === 'function', 'on use: $virtual(id).scrollToIndex() before the module or list exists returns a promise resolving null (module loaded by the call)', { ...early, loadedEarly })
            check(!go.error && go.el === 'n1200' && aligned(go.at), 'on use: once the list is shown, the call lands', go)
            check(p.errors.length === 0, 'on use: no page errors', p.errors)
            await p.close()
        }

        // Round 2: the rect is at the requested alignment AT resolve, every layout, recycle on and off
        {
            const targets = [[1777, {}], [1200, { align: 'center' }], [400, { align: 'end' }], [2500, {}], [60, { align: 'center' }], [1900, { behavior: 'smooth' }], [1300, { align: 'nearest' }]]
            for (const layout of ['block', 'auto', 'table', 'contents', 'grid', 'flex', 'masonry']) for (const rec of ['', '&recycle=1']) {
                if (layout === 'masonry' && rec) continue
                const pad = layout === 'table' ? 30 : 0
                const p = await open(`/${layout}?h=v&n=${layout === 'grid' || layout === 'flex' ? 8000 : 3000}${rec}`)
                const bad = []
                for (const [n, o] of targets) {
                    const r = await run(p, async (n, o) => { const e = await T.api().scrollToIndex(n, o); return { el: e && e.dataset.n, at: T.at(n) } }, n, o)
                    if (r.error || r.el !== 'n' + n || !aligned(r.at, o.align, pad)) bad.push({ n, o, ...r })
                }
                check(bad.length === 0, `at resolve: ${layout}${rec ? ' + recycle' : ''}: the row's rect is at the alignment when the promise resolves (${targets.length} targets)`, bad.slice(0, 3))
                await done(p, `at resolve ${layout}${rec}`)
            }
            for (const rec of ['&recycle=1', '']) {
                const p = await open('/block?h=v' + rec)
                const r = await run(p, async () => {
                    const out = []
                    for (const n of [1777, 2500, 400]) {
                        const e = await T.api().scrollToIndex(n); const a = T.at(n)
                        e.tabIndex = -1; e.focus()
                        await frames_(30)
                        out.push({ n, a: a && [a.top, a.bottom], b: T.at(n) && [T.at(n).top, T.at(n).bottom], focused: document.activeElement === e })
                    }
                    return out
                })
                check(Array.isArray(r) && r.every((x) => x.a && Math.abs(x.a[0]) <= TOL && x.b && Math.abs(x.b[0]) <= TOL && x.focused), `focus at resolve${rec ? ' (recycle)' : ''}: focusing the resolved row does not move it`, r)
                await done(p, `focus at resolve${rec}`)
            }
        }

        // Round 2: keys only cancel when they would scroll this list
        {
            const body = encodeURIComponent('<div id="other" tabindex="0" style="height:100px;overflow:auto"><div style="height:2000px">other</div></div><div id="slider" tabindex="0" role="slider" style="height:20px">w</div>')
            const p = await open('/block?h=v&wrap=hidden&body=' + body, false)
            await run(p, () => { window.__d = 'pending'; T.api().scrollToIndex(1300).then((e) => { window.__d = e ? e.dataset.n : null }) })
            await p.click('#other'); await p.keyboard.press('Space')
            await p.focus('#slider'); await p.keyboard.press('ArrowDown')
            await run(p, () => frames_(5))
            const waiting = await run(p, () => window.__d)
            await run(p, () => { T.data().shown = true })
            await p.waitForFunction(() => window.__d !== 'pending', { timeout: 5000 }).catch(() => null)
            const r = await run(p, () => ({ el: window.__d, at: T.at(1300) }))
            check(waiting === 'pending' && r.el === 'n1300' && aligned(r.at), 'hidden list waiting: Space in another scroller and ArrowDown on a slider do not cancel it; it lands when shown', { waiting, ...r })
            await p.close()
            const q = await open('/block?h=v&body=' + body)
            await q.focus('#slider')
            await run(q, () => { window.__d = 'pending'; T.api().scrollToIndex(2400, { behavior: 'smooth' }).then((e) => { window.__d = e ? e.dataset.n : null }) })
            await run(q, () => frames_(5))
            await q.keyboard.press('ArrowRight'); await q.keyboard.press('ArrowDown')
            await q.waitForFunction(() => window.__d !== 'pending', { timeout: 5000 }).catch(() => null)
            const r2 = await run(q, () => ({ el: window.__d, at: T.at(2400) }))
            check(r2.el === 'n2400' && aligned(r2.at), 'visible smooth scroll: arrows on an unrelated slider do not cancel it', r2)
            await q.close()
            // Body focus PageDown / End still cancel, every time
            const miss = []
            for (let i = 0; i < 10; i++) for (const key of ['PageDown', 'End']) {
                const b = await open('/block')
                const vb = await (await b.$('#v')).boundingBox()
                await b.mouse.click(vb.x + 100, vb.y + 100)
                await run(b, () => { window.__k = undefined; T.api().scrollToIndex(2000, { behavior: 'smooth' }).then((e) => { window.__k = e ? e.dataset.n : null }) })
                await run(b, () => frames_(10))
                await run(b, () => { window.__mark = performance.now() })
                await b.keyboard.press(key)
                await run(b, () => new Promise((r) => setTimeout(r, 900)))
                const r = await run(b, () => ({ el: window.__k, active: document.activeElement.tagName, writesAfter: window.__writes.filter((t) => t > window.__mark + 50).length }))
                if (r.el !== null || r.writesAfter || r.active !== 'BODY') miss.push({ i, key, ...r })
                await b.close()
            }
            check(miss.length === 0, 'PageDown / End with focus on <body>: cancel in 20 of 20 runs', miss)
        }

        // Round 2: scroll snap, one instant jump, the snapped position accepted
        for (const type of ['mandatory', 'proximity']) {
            const p = await open(`/snap?h=v&snap=${type}`)
            const bad = []
            for (const beh of ['instant', 'smooth']) for (const align of ['start', 'center', 'end', 'nearest']) {
                const r = await run(p, async (beh, align) => {
                    T.set(3000); await new Promise((r) => setTimeout(r, 150))
                    const t0 = performance.now(), w0 = window.__writes.length
                    const e = await T.api().scrollToIndex(1700, { behavior: beh, align })
                    const ms = performance.now() - t0, a = T.at(1700), w = window.__writes.length - w0
                    await new Promise((r) => setTimeout(r, 300))
                    return { el: e && e.dataset.n, ms: Math.round(ms), writes: w, later: window.__writes.length - w0 - w, a }
                }, beh, align)
                const vis = r.a && r.a.bottom > 0 && r.a.top < r.a.vh
                if (r.error || r.el !== 'n1700' || !vis || r.ms > 300 || r.writes > 6 || r.later) bad.push({ beh, align, ...r })
            }
            check(bad.length === 0, `scroll-snap ${type}: every align, instant and smooth: resolves fast with the row visible, a few writes, none after`, bad.slice(0, 3))
            await done(p, `snap ${type}`)
        }

        // Round 2: repeated call after the item moved; numeric strings; calc() padding; anchoring restored
        {
            const p = await open('/block?h=v')
            const r = await run(p, async () => {
                const a = await T.api().scrollToKey(1700, { align: 'center' })
                T.data().items.unshift(...Array.from({ length: 30 }, (_, k) => ({ id: 'm' + k, name: 'm' + k, h: 33 })))
                const b = await T.api().scrollToKey(1700, { align: 'center' })
                return { a: a && a.dataset.n, b: b && b.dataset.n, at: T.at(1700) }
            })
            check(!r.error && r.a === 'n1700' && r.b === 'n1700' && aligned(r.at, 'center'), 'the same call again after the item moved during the follow: lands it again', r)
            await done(p, 'repeat after move')
            const ps = await open('/block?h=v')
            const s1 = await run(ps, async () => {
                const out = {}
                for (const v of [' 5 ', '5.0', '+7', '1e3', '0x10', '5px', '', '-0']) { const e = await T.api().scrollToIndex(v); out[JSON.stringify(v)] = e ? e.dataset.n : null }
                return out
            })
            const w = ps.warns.filter((x) => x.includes('whole number'))
            check(s1['" 5 "'] === 'n5' && Object.entries(s1).filter(([k]) => k !== '" 5 "').every(([, v]) => v === null) && w.some((x) => x.includes("'5px'")) && w.some((x) => x.includes("'+7'")), "numeric strings: only digits (spaces around allowed); the warning quotes the value", { s1, w })
            await done(ps, 'numeric strings')
            const c = await open('/block?h=v&style=' + encodeURIComponent('scroll-padding-top:calc(5% + 10px)'))
            await land(c, 'scroll-padding-top calc(5% + 10px) = 40px', 1000, {}, 'scrollToIndex', 1000, 40)
            await c.close()
            const an = await open('/block?h=v')
            const ra = await run(an, async () => {
                const v = T.v(), pr = T.api().scrollToIndex(2000, { behavior: 'smooth' })
                await frames_(4)
                v.setAttribute('style', v.getAttribute('style').replace(/overflow-anchor:[^;]*;?/, ''))
                await frames_(2)
                const during = v.style.overflowAnchor
                await pr; await new Promise((r) => setTimeout(r, 3600))
                return { during, after: v.style.overflowAnchor }
            })
            check(ra.during === 'none' && ra.after === '', 'a style rewrite mid-seek: anchoring stays off during the seek and is restored after', ra)
            await an.close()
        }

        // Round 3: last item from random positions with recycle (layout clamps are not outside scrolls)
        for (const layout of ['block', 'contents']) {
            const p = await open(`/${layout}?h=v&recycle=1`)
            const r = await run(p, async () => {
                const bad = []
                for (let i = 0; i < 30; i++) {
                    const align = ['end', 'start', 'center', 'nearest'][i % 4]
                    T.set(Math.floor(Math.random() * 300000)); await frames_(3)
                    const n = T.data().items.length - 1 - (i % 3)
                    const e = await T.api().scrollToIndex(n, { align }); const a = T.at(n)
                    const ok = e && e.dataset.n === 'n' + n && a && (align === 'nearest' ? a.top >= -1 && a.bottom <= a.vh + 1 : Math.abs(a.bottom - a.vh) <= 1 || Math.abs(a.st - a.max) <= 1 || Math.abs(a.top) <= 1 || Math.abs((a.top + a.bottom) / 2 - a.vh / 2) <= 1)
                    if (!ok) bad.push({ i, n, align, el: e && e.dataset.n, a })
                }
                const e3 = await T.api().scrollToIndex(3)
                const e = await T.api().scrollToIndex(2997, { align: 'center' }); const a = T.at(2997)
                return { bad, det: { e3: e3 && e3.dataset.n, el: e && e.dataset.n, a } }
            })
            check(!r.error && r.bad.length === 0, `${layout} + recycle: the last items from 30 random positions resolve with the row in place`, r.bad && r.bad.slice(0, 3))
            check(!r.error && r.det.el === 'n2997' && aligned(r.det.a, 'center'), `${layout} + recycle: scrollToIndex(3) then (2997, center) lands`, r.det)
            await done(p, `last item ${layout} recycle`)
        }

        // Round 3: a throw mid snap pass leaves snapping on; x-axis snap on a vertical list takes the normal path
        {
            const p = await open('/snap?h=v')
            const r = await run(p, async () => {
                const v = T.v(), orig = v.getBoundingClientRect, before = v.style.scrollSnapType
                let armed = false, thrown = false
                v.getBoundingClientRect = function () { if (armed && v.style.scrollSnapType === 'none' && !thrown) { thrown = true; throw new Error('probe throw') } return orig.call(this) }
                armed = true
                const el = await Promise.race([T.api().scrollToIndex(1500), new Promise((r) => setTimeout(() => r('PENDING'), 2000))])
                v.getBoundingClientRect = orig
                return { thrown, el: el === 'PENDING' ? el : el && el.dataset.n, before, inline: v.style.scrollSnapType, computed: getComputedStyle(v).scrollSnapType }
            })
            check(!r.error && r.thrown && r.el !== 'PENDING' && r.inline === r.before && r.computed.includes('mandatory'), 'snap: a throw during the snap pass still restores scroll-snap-type and settles', r)
            p.errors = p.errors.filter((e) => !e.includes('probe throw'))
            await done(p, 'snap throw')
            const x = await open('/block?h=v&style=' + encodeURIComponent('scroll-snap-type:x mandatory'))
            const rx = await run(x, async () => {
                T.set(0); await T.stable()
                const seen = []; let on = true
                const tick = () => { if (!on) return; seen.push(Math.round(T.v().scrollTop)); requestAnimationFrame(tick) }
                requestAnimationFrame(tick)
                const el = await T.api().scrollToIndex(1900, { behavior: 'smooth' })
                on = false
                const steps = new Set(seen).size
                return { el: el && el.dataset.n, steps, at: T.at(1900) }
            })
            check(!rx.error && rx.el === 'n1900' && rx.steps > 8 && aligned(rx.at), 'scroll-snap-type: x on a vertical list: the normal smooth path (many steps), lands', rx)
            await done(x, 'x snap')
        }

        // Round 3: the cap for sizes that never settle is time-based (~1.5 s)
        {
            const p = await open('/auto?style=overflow-anchor:none&row=' + encodeURIComponent(`x-init="const f = () => { if (!$el.isConnected) return; $el.querySelector('.pad').style.height = (row.h + (Math.random() * 30 | 0)) + 'px'; requestAnimationFrame(f) }; requestAnimationFrame(f)"`), false)
            const r = await run(p, async () => {
                let frames = 0, on = true; const f = () => { if (on) { frames++; requestAnimationFrame(f) } }; requestAnimationFrame(f)
                const t0 = performance.now()
                const el = await T.api().scrollToIndex(1500, { align: 'center' })
                on = false
                return { el: el && el.dataset.n, ms: Math.round(performance.now() - t0), frames }
            })
            check(!r.error && r.el === 'n1500' && r.ms >= 1400 && r.ms <= 1800, 'sizes that never settle: resolves after about 1.5 s of trying', r)
            await p.close()
        }

        // Round 4: at the end, outside upward scrolls during the follow cancel; hidden time is not settle time
        {
            const grow = encodeURIComponent(`x-init="let k = 0; const t = setInterval(() => { if (!$el.isConnected || ++k > 40) return clearInterval(t); $el.querySelector('.pad').style.height = (row.h + k * 2) + 'px' }, 70)"`)
            const sb = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] })
            try {
                for (const [label, route] of [['rows sizing', `/auto?row=${grow}`], ['no late sizing', '/auto']]) {
                    for (const how of ['own code scrollTop -= 500', 'scrollbar track click']) {
                        const p = await sb.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message))
                        await p.goto(base + route, { waitUntil: 'load' })
                        await p.waitForFunction(() => window.Alpine && document.querySelector('#v [data-virtual-spacer]') && window.T, { timeout: 10000 })
                        const b = await (await p.$('#v')).boundingBox()
                        const bad = []
                        for (let i = 0; i < 6; i++) {
                            await run(p, () => T.set(100000 + Math.random() * 100000))
                            await run(p, () => T.api().scrollToIndex(T.data().items.length - 1, { align: 'end' }).then(() => new Promise((r) => setTimeout(r, 150))))
                            await run(p, () => { window.__mark = performance.now(); window.__st0 = T.v().scrollTop; window.__min = Infinity; if (!window.__minOn) { window.__minOn = true; T.v().addEventListener('scroll', () => { window.__min = Math.min(window.__min, T.v().scrollTop) }) } })
                            if (how.startsWith('own')) await run(p, () => { T.set(T.v().scrollTop - 500) })
                            else await p.mouse.click(b.x + b.width - 4, b.y + 100)
                            await run(p, () => new Promise((r) => setTimeout(r, 1200)))
                            const r = await run(p, () => ({ moved: Math.round(window.__st0 - window.__min), writes: window.__writes.filter((t) => t > window.__mark).length }))
                            if (!(r.moved > 50) || r.writes) bad.push({ i, ...r })
                        }
                        check(bad.length === 0 && p.errors.length === 0, `end + follow (${label}): ${how} moves the list up and the seek stops (0 writes after), 6 of 6`, bad)
                        await p.close()
                    }
                }
            } finally { await sb.close() }
            const p = await open('/auto?row=' + encodeURIComponent(`x-init="setTimeout(() => $el.querySelector('.pad').style.height = (row.h + 50) + 'px', 30 + (row.id % 4) * 20)"`))
            const r = await run(p, async () => {
                let at = null, el = 'pending'
                T.api().scrollToIndex(1800, { align: 'center' }).then((e) => { el = e ? e.dataset.n : null; at = T.at(1800) })
                await frames_(1); T.v().style.display = 'none'
                await new Promise((r) => setTimeout(r, 5000))
                const whileHidden = el
                T.v().style.display = ''
                await new Promise((r) => setTimeout(r, 2500))
                return { whileHidden, el, at }
            })
            check(!r.error && r.whileHidden === 'pending' && r.el === 'n1800' && aligned(r.at, 'center'), 'hidden 5 s one frame into a seek: lands centred when shown (hidden time is not settle time)', r)
            await done(p, 'hidden settle time')
        }

        // No cost when unused: no listener or observer beyond what the list already had
        {
            const pb = BASELINE ? await open('/block?h=v&base=1') : null
            const p = await open('/block?h=v')
            const take = (q) => q.evaluate(async () => { for (let y = 0; y < 30000; y += 3000) { T.v().scrollTop = y; await frames_(2) } return { listen: [...window.__listen].sort(), obs: window.__obs } })
            const now = await take(p)
            check(now.listen.join() === 'scroll', 'unused: the list registers only its scroll listener', now)
            if (pb) { const old = await take(pb); check(JSON.stringify(old) === JSON.stringify(now), 'unused: same listeners and observers as the baseline', { now, old }); await pb.close() }
            await done(p, 'unused')
        }

        // Boot and scroll time of a list that never calls it, against the baseline
        if (BASELINE) {
            const time = async (route) => {
                const p = await browser.newPage()
                const t0 = Date.now()
                await p.goto(base + route + '&n=100000&h=24&est=24', { waitUntil: 'load' })
                await p.waitForFunction(() => window.Alpine && document.querySelector('#v .r'), { timeout: 20000 })
                const boot = (await p.metrics()).TaskDuration * 1000
                const s0 = (await p.metrics()).TaskDuration * 1000
                await p.evaluate(async () => { const v = T.v(); for (let i = 1; i <= 60; i++) { v.scrollTop = i * 40000; await frames_(2) } for (let i = 59; i >= 0; i--) { v.scrollTop = i * 40000; await frames_(2) } })
                const scroll = (await p.metrics()).TaskDuration * 1000 - s0
                await p.close()
                return { boot: Math.round(boot), scroll: Math.round(scroll), wall: Date.now() - t0 }
            }
            const best = (a, b) => (a ? { boot: Math.min(a.boot, b.boot), scroll: Math.min(a.scroll, b.scroll), wall: Math.min(a.wall, b.wall) } : b)
            let now = null, old = null
            for (let i = 0; i < 5; i++) { old = best(old, await time('/block?base=1')); now = best(now, await time('/block?x=1')) }
            console.log('perf, 100k rows, list never calls it: this build', now, 'baseline', old)
            check(now.boot <= old.boot * 1.15 + 20 && now.scroll <= old.scroll * 1.15 + 20, 'unused: boot and fast-scroll main-thread time within noise of the baseline', { now, old })
        }
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 }
    else console.log('\nall passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
