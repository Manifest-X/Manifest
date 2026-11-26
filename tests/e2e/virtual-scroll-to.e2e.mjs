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
import { readFileSync } from 'fs'
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
window.__obs = 0
for (const C of ['ResizeObserver', 'MutationObserver', 'IntersectionObserver']) { const O = window[C]; window[C] = class extends O { constructor(cb) { super(cb); window.__obs++ } } }
window.H = (k) => 20 + ((k * 2654435761) >>> 0) % 181
window.frames_ = (k = 3) => new Promise((r) => { const f = () => (--k <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) })
window.T = {
  v: () => document.getElementById('v'),
  data: () => Alpine.$data(document.getElementById('app')),
  api: (t = 'v') => Alpine.evaluate(document.getElementById('app'), '$virtual(' + JSON.stringify(t) + ')'),
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
    const box = 'height:600px;width:400px;overflow:auto'
    let list
    if (layout === 'block') list = `<div id="v" x-virtual="{ estimate: ${est}${rec} }" style="${box}">
      <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template></div>`
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
    return shell(`<button id="outside">outside</button><div id="app" x-data="{ shown: ${wrap === 'hidden' ? 'false' : 'true'}, items: ${items(n, h)} }">${list}</div>`,
        q.get('base') ? '/baseline/scripts/manifest.virtual.js' : '/scripts/manifest.virtual.js', q.get('rtl') ? 'rtl' : 'ltr')
}

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            const js = (file) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(file)) }
            if (u.pathname === '/__alpine.js') return js(ALPINE)
            if (u.pathname === '/scripts/manifest.virtual.js') return js(path.join(SRC, 'scripts/manifest.virtual.js'))
            if (u.pathname === '/baseline/scripts/manifest.virtual.js' && BASELINE) return js(path.join(BASELINE, 'scripts/manifest.virtual.js'))
            const layout = u.pathname.slice(1)
            const ok = ['block', 'table', 'contents', 'grid', 'flex', 'masonry'].includes(layout)
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
    const open = async (route, ready = true) => {
        const p = await browser.newPage()
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
            // A user wheel cancels a smooth scroll
            const r3 = await run(p, async () => {
                const pr = T.api().scrollToIndex(10, { behavior: 'smooth' })
                await frames_(4)
                T.v().dispatchEvent(new WheelEvent('wheel', { deltaY: 10 }))
                const el = await pr
                return { el: el && el.dataset.n }
            })
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
