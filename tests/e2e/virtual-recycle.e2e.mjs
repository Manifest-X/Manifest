/**
 * Real-Chrome guard for x-virtual `recycle: true` (rows leaving the window are rebound to rows entering it):
 * 1. after jumps and small steps every row shows its own item (text, attributes, index, nested x-for, x-if),
 *    DOM order equals data order, the row count stays bounded, and nodes are reused (a full-window jump
 *    creates ~0 row nodes) in block, table, display:contents grid and gallery layouts;
 * 2. variable heights: a reused row is measured afresh for its new item, rows sit at their true offsets after
 *    scrolling down and back, and a jump sequence lands exactly where the non-recycle build does;
 * 3. source changes (push, removal, in-place sort/reverse, replaced array, filter, new keys, empty);
 * 4. a row holding focus, an open <details> or an open popover is destroyed, not reused;
 * 5. x-defer: a popover opened (rendered) for one item shows the new item after reuse, a stashed one too;
 * 6. teardown: emptied list, destroyed container and a switch to the non-recycle container leave no
 *    observed row nodes, and every row node is collectable;
 * 7. the default (no recycle) creates nodes as before; the source effect never re-runs on a scroll;
 * 8. x-dropdown per-row menu ids, open menus elsewhere, teleported content, the manifest:virtual-recycle
 *    event, x-transition / x-init warnings, and a throwing mount.
 *
 * Run: node tests/e2e/virtual-recycle.e2e.mjs   (VIRTUAL_SRC=<dir with scripts/> to A/B)
 */
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SRC = process.env.VIRTUAL_SRC || path.join(ROOT, 'src')
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.js')

// Row nodes ever created (moves are not creations), weakly held; active ResizeObserver targets inside rows
const HELPERS = `<script>
// A batch (one render pass) that both destroys and creates rows is a missed reuse: __mixed
window.__created = 0; window.__refs = []; window.__mixed = 0
const seen = new WeakSet()
new MutationObserver((records) => {
  let made = 0, gone = 0
  for (const r of records) {
    for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('r') && !seen.has(n)) { seen.add(n); made++; window.__refs.push(new WeakRef(n)) }
    for (const n of r.removedNodes) if (n.nodeType === 1 && n.classList.contains('r') && !n.isConnected) gone++
  }
  window.__created += made
  if (made && gone) window.__mixed++
}).observe(document, { childList: true, subtree: true })
window.__roRow = 0
const rowish = (t) => !!(t && t.closest && t.closest('.r'))
const RO = ResizeObserver.prototype, obs = RO.observe, unobs = RO.unobserve, disc = RO.disconnect
RO.observe = function (t) { const s = this.__s || (this.__s = new Set()); if (rowish(t) && !s.has(t)) { s.add(t); window.__roRow++ } return obs.apply(this, arguments) }
RO.unobserve = function (t) { if (this.__s && this.__s.delete(t)) window.__roRow--; return unobs.apply(this, arguments) }
RO.disconnect = function () { if (this.__s) { window.__roRow -= this.__s.size; this.__s.clear() } return disc.apply(this, arguments) }
window.frames_ = (k = 3) => new Promise((r) => { const f = () => (--k <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f) })
window.T = {
  v: () => document.getElementById('v'),
  rows: () => [...document.querySelectorAll('#v .r')],
  data: () => Alpine.$data(document.getElementById('app')),
  box: (r) => (getComputedStyle(r).display === 'contents' ? r.firstElementChild : r).getBoundingClientRect(),
  sig() { const v = this.v(); if (!v) return 'none'; const rs = this.rows(); return [Math.round(v.scrollTop), v.scrollHeight, rs.length, rs[0] && rs[0].dataset.n, ...[...v.querySelectorAll('[data-virtual-spacer]')].map((s) => s.style.height)].join('|') },
  async stable(ms = 6000, quiet = 6) {
    const t0 = performance.now(); let last = this.sig(), same = 0
    while (performance.now() - t0 < ms) { await frames_(1); const s = this.sig(); same = s === last ? same + 1 : 0; last = s; if (same >= quiet) return true }
    return false
  },
  async go(y) { this.v().scrollTop = y; await frames_(2); return this.stable() },
  // Every row against its item: name, index, nested x-for, x-if; consecutive indices = DOM order is data order
  check() {
    const items = this.data().items, errs = []
    let prev = null
    for (const r of this.rows()) {
      const n = r.dataset.n, i = r.dataset.i === undefined ? items.findIndex((x) => x.name === n) : +r.dataset.i, it = items[i]
      if (!it || it.name !== n) { errs.push(['index', n, i]); continue }
      const name = r.querySelector('.name') || r
      if (name.textContent !== n) errs.push(['text', n, name.textContent])
      if (it.tags) { const tags = [...r.querySelectorAll('.tags b')].map((b) => b.textContent).join(); if (tags !== it.tags.join()) errs.push(['tags', n, tags]) }
      if ('flag' in it) { const em = r.querySelector('em'); if (!!em !== it.flag || (em && em.textContent !== 'flag ' + n)) errs.push(['x-if', n]) }
      if (prev !== null && i !== prev + 1) errs.push(['order', prev, i])
      prev = i
    }
    return { errs: errs.slice(0, 5), count: this.rows().length }
  },
}
</script>`

const item = `(_, k) => ({ id: k, name: 'n' + k, tags: Array.from({ length: k % 4 }, (_, j) => 't' + k + '-' + j), flag: k % 3 === 0 })`
const ROW_INNER = `<span class="tags"><template x-for="t in row.tags" :key="t"><b x-text="t"></b></template></span><template x-if="row.flag"><em x-text="'flag ' + row.name"></em></template>`
const rowFor = (layout) => ({
    block: `<div class="r" :data-n="row.name" :data-i="i" x-init="$el.dataset.born = row.name" style="height:30px;overflow:hidden;display:flex;gap:4px;white-space:nowrap"><span class="name" x-text="row.name"></span>${ROW_INNER}<input class="in" :value="row.name" size="4"><details class="d"><summary>s</summary><span class="ds" x-text="'det ' + row.name"></span></details><div popover class="pop"><span class="pt" x-text="'pop ' + row.name"></span></div><div popover x-defer.lazy class="pop2"><span class="pt2" x-text="'lazy ' + row.name"></span></div></div>`,
    table: `<tr class="r" :data-n="row.name" :data-i="i"><td class="name" style="height:30px" x-text="row.name"></td><td>${ROW_INNER}</td></tr>`,
    // A flagged row adds a full-width grid line: heights vary with the item
    contents: `<div class="r" :data-n="row.name" :data-i="i" style="display:contents"><div class="name" style="height:30px" x-text="row.name"></div><div class="tags"><template x-for="t in row.tags" :key="t"><b x-text="t"></b></template></div><template x-if="row.flag"><em style="grid-column:1 / -1;height:30px" x-text="'flag ' + row.name"></em></template></div>`,
    gallery: `<div class="r" :data-n="row.name" :data-i="i" style="flex:0 0 100px;height:30px;overflow:hidden"><span class="name" x-text="row.name"></span>${ROW_INNER}</div>`,
}[layout])
const boxFor = (layout, opts, inner) => ({
    block: `<div id="v" x-virtual="${opts}" style="height:300px;width:400px;overflow:auto">${inner}</div>`,
    table: `<div id="v" x-virtual="${opts}" style="height:300px;width:400px;overflow:auto"><table style="width:100%;border-collapse:collapse"><tbody>${inner}</tbody></table></div>`,
    contents: `<div id="v" x-virtual="${opts}" style="display:grid;grid-template-columns:1fr 1fr;align-content:start;height:300px;width:400px;overflow:auto">${inner}</div>`,
    gallery: `<div id="v" x-virtual="${opts}" style="display:flex;flex-wrap:wrap;align-content:flex-start;height:300px;width:400px;overflow-y:scroll;overflow-x:hidden">${inner}</div>`,
}[layout])

const shell = (body, defer) => `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;font:14px/20px sans-serif} td{padding:0} .r{box-sizing:border-box}</style>
${HELPERS}${defer ? '<script src="/scripts/manifest.defer.js"></script>' : ''}<script src="/scripts/manifest.virtual.js"></script><script defer src="/__alpine.js"></script></head><body>${body}</body></html>`

const opts = (recycle, extra = '') => `{ estimate: 30${extra}${recycle ? ', recycle: true' : ''} }`

// The source getter counts source effect runs
const list = (layout, recycle, n, defer) => shell(`<div id="app" x-data="{ items: Array.from({ length: ${n} }, ${item}), get list() { window.__src = (window.__src || 0) + 1; return this.items } }">
  ${boxFor(layout, opts(recycle, layout === 'gallery' ? ', estimate: { width: 100, height: 30 }' : ''), `<template x-for="(row, i) in list" :key="row.id">${rowFor(layout)}</template>`)}
</div>`, defer)

// Heights 20..200 from a hash; TOP[k] is row k's true offset. `row in items` form (no index)
const varied = (recycle, n) => shell(`<script>window.H = (k) => 20 + ((k * 2654435761) >>> 0) % 181; window.TOP = [0]; for (let k = 0; k < ${n}; k++) TOP.push(TOP[k] + H(k))</script>
  <div id="app" x-data="{ items: Array.from({ length: ${n} }, (_, k) => ({ id: k, name: 'n' + k, h: H(k) })) }">
  <div id="v" x-virtual="${opts(recycle)}" style="height:600px;width:400px;overflow:auto">
    <template x-for="row in items" :key="row.id"><div class="r" :data-n="row.name" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template>
  </div></div>`)

// Review follow-ups. A list of plain rows with extra row markup; `scripts` adds modules before the virtual one
const plainItem = `(_, k) => ({ id: k, slot: k, name: 'n' + k, ex: k % 2 === 0 })`
const extraList = (recycle, rowInner, { rowAttrs = '', scripts = '', after = '', key = 'row.id' } = {}) => `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;font:14px/20px sans-serif} .r{box-sizing:border-box;height:30px;overflow:hidden;display:flex;gap:4px}</style>
${HELPERS}${scripts}<script src="/scripts/manifest.virtual.js"></script><script defer src="/__alpine.js"></script></head><body>
<div id="app" x-data="{ tick: 0, done: 0, items: Array.from({ length: 2000 }, ${plainItem}) }">
  <div id="v" x-virtual="${opts(recycle)}" style="height:300px;width:400px;overflow:auto">
    <template x-for="(row, i) in items" :key="${key}"><div class="r" :data-n="row.name" :data-i="i" ${rowAttrs}><span class="name" x-text="row.name"></span>${rowInner}</div></template>
  </div>${after}
</div></body></html>`
const DROPDOWNS = '<script src="/scripts/manifest.dropdowns.js"></script>'
const EXTRA_PAGES = {
    // Per-row menu id read from the item; a shared menu outside the list
    dropdown: (r) => extraList(r, '<button class="dd" x-dropdown="`m-${row.slot}`">menu</button><menu popover :id="\'m-\' + row.slot"><li class="mi" x-text="\'menu \' + row.name"></li></menu><button class="sh" x-dropdown="shared">shared</button>',
        { scripts: DROPDOWNS, after: '<menu popover id="shared"><li>shared</li></menu>' }),
    teleport: (r) => extraList(r, '<template x-teleport="body"><div class="tw"><input class="ti" :value="row.name"><div popover class="tp" :data-for="row.name"><span x-text="\'tele \' + row.name"></span></div></div></template>'),
    hook: (r) => extraList(r, '<b class="st" x-text="open ? \'open\' : \'closed\'"></b>',
        { rowAttrs: 'x-data="{ open: false, got: null, seen: null }" x-init="$el.dataset.born = row.name" @manifest:virtual-recycle="open = false; got = $event.detail.key + \':\' + $event.detail.index; seen = row.name" :data-got="got" :data-seen="seen"' }),
    transition: (r) => extraList(r, '<em x-show="row.ex" x-transition>ex</em>'),
    // Handlers that change the source or scroll, or read the row's DOM (must see the new item's)
    hooksplice: (r) => extraList(r, '', { rowAttrs: '@manifest:virtual-recycle="if (!done++) items.splice(0, 1)"' }),
    hookscroll: (r) => extraList(r, '', { rowAttrs: '@manifest:virtual-recycle="if (!done++) document.getElementById(\'v\').scrollTop += 300"' }),
    hookboth: (r) => extraList(r, '', { rowAttrs: '@manifest:virtual-recycle="if (!done++) { items.splice(0, 1); document.getElementById(\'v\').scrollTop += 300 }"' }),
    hooksaw: (r) => extraList(r, '', { rowAttrs: '@manifest:virtual-recycle="$el.dataset.saw = $el.querySelector(\'.name\').textContent + \'|\' + $el.dataset.n"' }),
    // An author's own aria-expanded (no aria-controls/popovertarget) is row data, not an open trigger
    expanded: (r) => extraList(r, '<span class="ex" :aria-expanded="row.ex ? \'true\' : \'false\'" x-text="row.ex ? \'expanded\' : \'collapsed\'"></span>'),
    initnested: (r) => extraList(r, '<em x-init="$el.dataset.born = row.name" @manifest:virtual-recycle="$el.dataset.born = row.name">i</em>'),
    initmod: (r) => extraList(r, '', { rowAttrs: 'x-init.once="$el.dataset.born = row.name"' }),
    init: (r) => extraList(r, '<em x-init="$el.dataset.born = row.name">i</em>'),
    // An engine that keeps a failed effect live (as older reactivity did), and one row init that throws
    throwing: (r) => extraList(r, '', { scripts: `<script>document.addEventListener('alpine:init', () => {
      const eff = Alpine.effect
      const wrapped = (cb) => { let err = null; const run = eff(() => { try { cb() } catch (e) { err = e } }); if (err) throw err; return run }
      Object.defineProperty(Alpine, 'effect', { configurable: true, get: () => wrapped })
      const init = Alpine.initTree
      Alpine.initTree = function (node) { if (window.__throwNext && node.classList && node.classList.contains('r')) { void Alpine.$data(document.getElementById('app')).tick; window.__throwNext = false; throw new Error('row init failed') } return init.apply(this, arguments) }
    })</script>` }),
}

// Two containers behind x-if: recycle on, recycle off; 'off' shows neither
const teardown = () => shell(`<div id="app" x-data="{ mode: 'recycle', items: Array.from({ length: 2000 }, ${item}) }">
  <template x-if="mode === 'recycle'">${boxFor('block', opts(true), `<template x-for="(row, i) in items" :key="row.id">${rowFor('block')}</template>`)}</template>
  <template x-if="mode === 'plain'">${boxFor('block', opts(false), `<template x-for="(row, i) in items" :key="row.id">${rowFor('block')}</template>`)}</template>
</div>`)

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            const js = (file) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(file)) }
            if (u.pathname === '/__alpine.js') return js(ALPINE)
            if (u.pathname.startsWith('/scripts/')) return js(path.join(SRC, u.pathname))
            const q = (k, d) => u.searchParams.get(k) ?? d
            const r = q('r', '1') === '1'
            const html = {
                '/list': () => list(q('layout', 'block'), r, Number(q('n', 2000)), q('defer') === '1'),
                '/varied': () => varied(r, Number(q('n', 3000))),
                '/teardown': () => teardown(),
                '/extra': () => EXTRA_PAGES[q('page')](r),
            }[u.pathname]
            res.writeHead(html ? 200 : 404, { 'content-type': 'text/html' })
            res.end(html ? html() : 'not found')
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

async function main() {
    const server = await serve()
    const base = `http://127.0.0.1:${server.address().port}`
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--js-flags=--expose-gc'] })
    const fails = []
    const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
    const open = async (route) => {
        const p = await browser.newPage()
        p.errors = []
        p.on('pageerror', (e) => p.errors.push(e.message))
        await p.goto(base + route, { waitUntil: 'load' })
        await p.waitForFunction(() => window.Alpine && document.querySelector('#v .r') && window.T, { timeout: 10000 }).catch(async (e) => { throw new Error(route + ': no rows rendered ' + JSON.stringify(p.errors) + await p.evaluate(() => document.body.innerHTML.slice(0, 800) + ' alpine:' + !!window.Alpine)) })
        await p.evaluate(() => T.stable())
        return p
    }
    const done = async (p, label) => { check(p.errors.length === 0, `${label}: no page errors`, p.errors); await p.close() }
    // Jumps past the whole window, then small steps; every stop checked
    const tour = (p) => p.evaluate(async () => {
        const out = { errs: [], maxRows: 0, jumpCreated: [], jumpGrew: [], srcRuns: 0 }
        const src0 = window.__src, mixed0 = window.__mixed
        const look = () => { const c = T.check(); out.errs.push(...c.errs); out.maxRows = Math.max(out.maxRows, c.count) }
        const h = T.v().scrollHeight
        for (const f of [0.25, 0.5, 0.1, 0.99, 0.6, 0]) { const c0 = window.__created, n0 = T.rows().length; await T.go(Math.round(h * f)); out.jumpCreated.push(window.__created - c0); out.jumpGrew.push(Math.max(0, T.rows().length - n0)); look() }
        await T.go(Math.round(h * 0.3))
        for (let s = 0; s < 30; s++) { await T.go(T.v().scrollTop + 37); look() }
        for (let s = 0; s < 30; s++) { await T.go(T.v().scrollTop - 23); look() }
        out.srcRuns = window.__src - src0
        out.mixed = window.__mixed - mixed0
        out.errs = out.errs.slice(0, 5)
        return out
    })

    try {
        // 1. Rows show their own items; nodes reused; default creates nodes as before
        for (const layout of ['block', 'table', 'contents', 'gallery']) {
            for (const r of [1, 0]) {
                const label = `${layout}, recycle ${r ? 'on' : 'off'}`
                const p = await open(`/list?layout=${layout}&r=${r}`)
                const t = await tour(p)
                check(t.errs.length === 0, `${label}: every row shows its own item, DOM order is data order`, t.errs)
                check(t.maxRows > 5 && t.maxRows < (layout === 'gallery' ? 120 : 40), `${label}: row count bounded`, t.maxRows)
                check(t.srcRuns === 0, `${label}: scrolling never re-runs the source effect`, t.srcRuns)
                const full = t.jumpCreated.slice(0, 5)
                // Rows are created only beyond the leaving supply (the window at the top has no overscan above)
                const made = t.jumpCreated.reduce((a, b) => a + b, 0)
                if (r) check(t.mixed === 0 && made < t.maxRows, `${label}: no pass both destroys and creates rows; six full-window jumps create under one window of nodes`, { mixed: t.mixed, created: t.jumpCreated, grew: t.jumpGrew })
                else check(full.every((c) => c >= 8) && t.mixed > 0, `${label}: full-window jumps create a window of row nodes (default path)`, { mixed: t.mixed, created: t.jumpCreated })
                await done(p, label)
            }
        }

        // A visible row node survives a full jump showing another item (on), or is gone (off)
        for (const r of [1, 0]) {
            const p = await open(`/list?r=${r}`)
            const res = await p.evaluate(async () => {
                const node = T.rows()[3], before = node.dataset.n
                await T.go(T.v().scrollHeight / 2)
                return { connected: node.isConnected, before, born: node.dataset.born, after: node.dataset.n, text: node.querySelector('.name').textContent, ok: T.check().errs }
            })
            if (r) check(res.connected && res.after !== res.before && res.text === res.after && res.ok.length === 0, 'recycle on: a row node is handed to a new item and shows it', res)
            if (r) check(res.born === res.before, 'recycle on: x-init ran once, for the first item (documented limitation)', res)
            else check(!res.connected, 'recycle off: a row node leaving the window is destroyed', res)
            await done(p, `node identity, recycle ${r ? 'on' : 'off'}`)
        }

        // 2. Heights: true offsets after walking down and back; identical landing to the default build
        {
            const offsets = async (p) => p.evaluate(() => {
                const ts = T.v().querySelector('[data-virtual-spacer]').getBoundingClientRect().top
                let worst = 0
                for (const r of T.rows()) { const k = +r.dataset.n.slice(1); worst = Math.max(worst, Math.abs(r.getBoundingClientRect().top - ts - TOP[k])) }
                return Math.round(worst * 10) / 10
            })
            const runs = {}
            for (const r of [1, 0]) {
                const p = await open(`/varied?r=${r}`)
                const walk = await p.evaluate(async () => { for (let y = 0; y <= 30000; y += 150) { T.v().scrollTop = y; await frames_(2) } return T.stable() })
                const down = await offsets(p)
                const back = []
                for (const y of [20000, 9000, 2500, 0]) { await p.evaluate(async (y) => { while (T.v().scrollTop > y) { T.v().scrollTop = Math.max(y, T.v().scrollTop - 150); await frames_(2) } return T.stable() }, y); back.push(await offsets(p)) }
                check(walk && down === 0 && back.every((d) => d === 0), `varied heights, recycle ${r ? 'on' : 'off'}: rows sit at their true offsets after scrolling down and back`, { down, back })
                const seq = await p.evaluate(async () => {
                    const out = []
                    for (const y of [150000, 60000, 300000, 12000, 225000, 40000]) { await T.go(y); const rs = T.rows(); out.push([Math.round(T.v().scrollTop), T.v().scrollHeight, rs[0].dataset.n, Math.round(T.box(rs[0]).top - T.v().getBoundingClientRect().top), rs.length].join('|')) }
                    return out
                })
                const through = await p.evaluate(async () => { for (let y = 0; y < T.v().scrollHeight; y += 400) { T.v().scrollTop = y; await frames_(2) } T.v().scrollTop = 1e9; await T.stable(); return { total: T.v().scrollHeight, want: TOP[TOP.length - 1] } })
                check(through.total === through.want, `varied heights, recycle ${r ? 'on' : 'off'}: scroll height equals the true total after a full scroll`, through)
                // Rows reused on the way up, then grown in place: the observer must report them under their new key
                const grow = await p.evaluate(async () => {
                    T.v().style.overflowAnchor = 'none'
                    const was = new Map(T.rows().map((r) => [r, r.dataset.n]))
                    for (let i = 0; i < 25; i++) { T.v().scrollTop -= 150; await frames_(2) }
                    await T.stable()
                    const vt = T.v().getBoundingClientRect().top
                    const inView = T.rows().filter((r) => { const b = r.getBoundingClientRect(); return b.top >= vt && b.bottom <= vt + T.v().clientHeight })
                    const reused = inView.filter((r) => was.has(r) && was.get(r) !== r.dataset.n)
                    const rs = (reused.length ? reused : inView).slice(0, 3)
                    const items = T.data().items
                    for (const r of rs) items[+r.dataset.n.slice(1)].h += 100
                    await frames_(2); await T.stable()
                    // Scrolling on past the grown rows moves the content by the step only (the model has their new height)
                    const TOP2 = [0]; for (const it of items) TOP2.push(TOP2[TOP2.length - 1] + it.h)
                    const at = () => { for (const r of T.rows()) { const b = r.getBoundingClientRect(); if (b.bottom > vt + 0.5) return TOP2[+r.dataset.n.slice(1)] - (b.top - vt) } }
                    const moved = []
                    let prev = at()
                    for (let s = 0; s < 40; s++) { T.v().scrollTop += 50; await frames_(3); const now = at(); moved.push(Math.round(now - prev)); prev = now }
                    T.v().style.overflowAnchor = ''
                    return { bad: moved.filter((d) => Math.abs(d - 50) > 1).length, reused: reused.length, grown: rs.length, moved: moved.join(',') }
                })
                check(grow.bad === 0 && grow.grown > 0 && (!r || grow.reused > 0), `varied heights, recycle ${r ? 'on' : 'off'}: rows grown in place (reused rows with recycle) shift the offsets by the growth`, grow)
                // Items resized while off-window, entering on nodes of the same box size (no resize to observe):
                // their stored heights are stale, so a reused row must be measured afresh
                const stale = await p.evaluate(async () => {
                    const items = T.data().items
                    T.v().style.overflowAnchor = 'none'   // anchoring would hide a stale offset
                    await T.go(0)
                    for (const r of T.rows()) items[+r.dataset.n.slice(1)].h = 50
                    await frames_(2); await T.stable()
                    for (let k = 1990; k < 2070; k++) items[k].h = 50
                    const TOP2 = [0]; for (const it of items) TOP2.push(TOP2[TOP2.length - 1] + it.h)
                    const vt = () => T.v().getBoundingClientRect().top
                    const at = () => { for (const r of T.rows()) { const b = r.getBoundingClientRect(); if (b.bottom > vt() + 0.5) return TOP2[+r.dataset.n.slice(1)] - (b.top - vt()) } }
                    await T.go(TOP2[1990])
                    const moved = []
                    let prev = at()
                    for (let s = 0; s < 70; s++) { T.v().scrollTop += 50; await frames_(3); const now = at(); moved.push(Math.round(now - prev)); prev = now }
                    return { bad: moved.filter((d) => Math.abs(d - 50) > 1).length, moved: moved.join(',') }
                })
                check(stale.bad === 0, `varied heights, recycle ${r ? 'on' : 'off'}: items resized off-window are measured afresh on entry (scrolling moves by the step only)`, stale)
                runs[r] = seq
                await done(p, `varied heights, recycle ${r ? 'on' : 'off'}`)
            }
            check(JSON.stringify(runs[1]) === JSON.stringify(runs[0]), 'varied heights: a jump sequence lands exactly as without recycle', runs)
        }

        // display:contents rows whose height changes with the item (x-if grid line): true total, bounded observers
        {
            const p = await open('/list?layout=contents&n=600')
            const res = await p.evaluate(async () => {
                for (let i = 0; i < 40; i++) await T.go((i * 7919) % (T.v().scrollHeight - 300))
                for (let y = 0; y < T.v().scrollHeight; y += 200) { T.v().scrollTop = y; await frames_(2) }
                T.v().scrollTop = 1e9; await T.stable()
                const want = T.data().items.reduce((a, it) => a + (it.flag ? 60 : 30), 0)
                return { total: T.v().scrollHeight, want, observed: window.__roRow, rows: T.rows().length, errs: T.check().errs }
            })
            // A reused row's x-if cell toggled in place: found through the row's child watcher under its new key
            const toggle = await p.evaluate(async () => {
                for (let i = 0; i < 20; i++) { T.v().scrollTop -= 90; await frames_(2) }
                await T.stable()
                const sh0 = T.v().scrollHeight, it = T.data().items[+T.rows()[3].dataset.i]
                it.flag = !it.flag
                await frames_(2); await T.stable()
                return { delta: T.v().scrollHeight - sh0, want: it.flag ? 30 : -30, errs: T.check().errs }
            })
            check(toggle.delta === toggle.want && toggle.errs.length === 0, 'display:contents rows: an x-if cell toggled in a reused row re-measures it', toggle)
            check(res.total === res.want && res.errs.length === 0, 'display:contents rows: reused rows re-measured for their item (true total)', res)
            check(res.observed <= res.rows * 4, 'display:contents rows: observed cells stay bounded across reuse (dropped x-if cells unobserved)', res)
            await done(p, 'display:contents heights')
        }

        // 3. Source changes with recycle on
        {
            const p = await open('/list?r=1')
            const step = (label, fn, scroll) => p.evaluate(async (fn, scroll) => {
                const c0 = window.__created
                ;(0, eval)('(' + fn + ')')(T.data())
                await frames_(2); await T.stable()
                const created = window.__created - c0
                const a = T.check()
                if (scroll) { await T.go(T.v().scrollTop + 900); await T.go(T.v().scrollTop - 450) }
                const b = T.check()
                return { created, errs: [...a.errs, ...b.errs], count: b.count }
            }, fn.toString(), scroll)
            await p.evaluate(() => T.go(6000))
            const ops = [
                ['push', (d) => { for (let k = 0; k < 5; k++) d.items.push({ id: 'p' + k, name: 'p' + k, tags: [], flag: false }) }],
                ['removal in the window', (d) => { const n = +T.rows()[4].dataset.i; d.items.splice(n, 3) }],
                ['in-place sort', (d) => { d.items.sort((a, b) => (a.name < b.name ? 1 : -1)) }],
                ['in-place reverse', (d) => { d.items.reverse() }],
                ['replaced array, same keys', (d) => { d.items = d.items.map((x) => ({ ...x, tags: [...x.tags] })) }],
                ['filter', (d) => { d.items = d.items.filter((x) => typeof x.id !== 'number' || x.id % 2 === 1) }],
                ['all new keys', (d) => { d.items = Array.from({ length: 1500 }, (_, k) => ({ id: 'x' + k, name: 'x' + k, tags: k % 2 ? ['x' + k] : [], flag: k % 5 === 0 })) }],
            ]
            for (const [label, fn] of ops) {
                const res = await step(label, fn, true)
                check(res.errs.length === 0 && res.count > 5, `source change with recycle: ${label}`, res)
                if (label === 'all new keys') check(res.created <= 2, 'source change with recycle: a list of all new keys reuses the rows (data-driven reuse)', res)
            }
            const empty = await step('empty', (d) => { d.items = [] }, false)
            const observed = await p.evaluate(() => window.__roRow)
            check(empty.count === 0 && observed === 0, 'source change with recycle: an emptied list leaves no rows and no observed row nodes', { ...empty, observed })
            await done(p, 'source changes')
        }

        // 4. Focus, open details, open popover: those rows are destroyed, not reused
        {
            const p = await open('/list?r=1')
            for (const [label, arm] of [
                ['focus', (r) => r.querySelector('.in').focus()],
                ['open <details>', (r) => { r.querySelector('.d').open = true }],
                ['open popover', (r) => r.querySelector('.pop').showPopover()],
            ]) {
                const res = await p.evaluate(async (arm) => {
                    await T.go(3000)
                    const rows = T.rows(), busy = rows[5], plain = rows[6]
                    ;(0, eval)('(' + arm + ')')(busy)
                    await frames_(2)
                    await T.go(30000)
                    return { busy: busy.isConnected, plain: plain.isConnected, errs: T.check().errs, focusInRow: !!document.activeElement.closest('.r'), open: !!document.querySelector('#v .r details[open], #v .r :popover-open') }
                }, arm.toString())
                check(!res.busy && res.plain && !res.focusInRow && !res.open && res.errs.length === 0, `a row holding ${label} is destroyed, not reused (a plain neighbour is reused)`, res)
            }
            await done(p, 'busy rows')
        }

        // 5. x-defer: rendered and stashed popover/details contents follow the reused row's item
        {
            const p = await open('/list?r=1&defer=1')
            const res = await p.evaluate(async () => {
                const stashed = (el) => !!el.querySelector(':scope > template[data-mnfst-defer]')
                const first = T.rows()
                const wasStashed = stashed(first[2].querySelector('.pop2'))
                for (let i = 0; i < 60 && !ManifestDefer.stats().warm; i++) await new Promise((r) => setTimeout(r, 50))
                const warm = ManifestDefer.stats().warm
                // Opened then closed: rendered for the old item
                const node = first[2], pop = node.querySelector('.pop')
                pop.showPopover(); await frames_(2)
                const openText = pop.querySelector('.pt')?.textContent
                pop.hidePopover(); await frames_(2)
                const before = node.dataset.n
                await T.go(20000)
                await frames_(4)
                const rendered = [], stale = []
                for (const r of T.rows()) {
                    const pt = r.querySelector('.pop .pt')
                    if (pt) { rendered.push(r.dataset.n); if (pt.textContent !== 'pop ' + r.dataset.n) stale.push([r.dataset.n, pt.textContent]) }
                }
                if (!node.isConnected) return { wasStashed, warm, openText, before, reused: false }
                // A still-stashed (lazy) one opened after reuse
                const lp = node.querySelector('.pop2'), lazyStashed = stashed(lp)
                lp.showPopover(); await frames_(2)
                const laterText = [node.dataset.n, lp.querySelector('.pt2')?.textContent]; lp.hidePopover()
                // A stashed details opened after reuse
                const d = node.querySelector('.d'); d.open = true; await frames_(3)
                const detText = d.querySelector('.ds')?.textContent; d.open = false
                return { wasStashed, warm, lazyStashed, openText, before, reused: node.isConnected, after: node.dataset.n, nodePop: node.querySelector('.pop .pt')?.textContent, rendered: rendered.length, stale, laterText, detText, errs: T.check().errs }
            })
            check(res.wasStashed && res.warm > 0 && res.openText === 'pop ' + res.before, 'x-defer: popovers in rows are deferred, some prewarmed, and render for their item (setup)', res)
            check(res.reused && res.after !== res.before && res.nodePop === 'pop ' + res.after && res.stale.length === 0, 'x-defer: a rendered popover in a reused row shows the new item', res)
            check(res.lazyStashed && res.laterText[1] === 'lazy ' + res.laterText[0] && res.detText === 'det ' + res.after && res.errs.length === 0, 'x-defer: a stashed popover/details in a reused row renders the new item when opened', res)
            await done(p, 'x-defer')
        }

        // 8. Review follow-ups
        const openExtra = async (page, r) => {
            const p = await browser.newPage()
            p.errors = []; p.warns = []
            p.on('pageerror', (e) => p.errors.push(e.message))
            p.on('console', (m) => { if ((m.type() === 'warn' || m.type() === 'warning') && m.text().includes('[x-virtual]')) p.warns.push(m.text()) })
            await p.goto(`${base}/extra?page=${page}&r=${r}`, { waitUntil: 'load' })
            await p.waitForFunction(() => window.Alpine && document.querySelector('#v .r') && window.T, { timeout: 10000 })
            await p.evaluate(() => T.stable())
            await new Promise((res) => setTimeout(res, 60))   // x-dropdown sets up in a timeout
            return p
        }
        // x-dropdown with a per-row menu id follows the row's item (recycle on), and a changed id on a kept row (off)
        for (const r of [1, 0]) {
            const p = await openExtra('dropdown', r)
            const res = await p.evaluate(async (r) => {
                const wiring = () => T.rows().map((row) => { const dd = row.querySelector('.dd'), m = row.querySelector('menu'); return [dd.getAttribute('popovertarget'), dd.getAttribute('aria-controls'), m.id, 'm-' + T.data().items[+row.dataset.i].slot] }).filter((w) => !(w[0] === w[2] && w[1] === w[2] && w[2] === w[3]))
                const out = {}
                if (r) { await T.go(20000); await new Promise((res) => setTimeout(res, 60)); out.afterJump = wiring() }
                // A kept row whose id expression changes value
                const row = T.rows()[4], it = T.data().items[+row.dataset.i]
                it.slot = 'x' + it.id
                await frames_(2); await new Promise((res) => setTimeout(res, 60))
                out.afterChange = wiring()
                out.row = row.dataset.n
                return out
            }, r)
            // Real clicks: the trigger of a reused/changed row opens its own menu, once
            const click = async (n) => {
                await p.click(`#v .r[data-n="${n}"] .dd`)
                await new Promise((res) => setTimeout(res, 50))
                const open = await p.evaluate(() => [...document.querySelectorAll('menu:popover-open')].map((m) => m.querySelector('.mi')?.textContent || m.id))
                await p.keyboard.press('Escape'); await new Promise((res) => setTimeout(res, 30))
                return open
            }
            const visible = await p.evaluate(() => T.rows().slice(4, 7).map((r) => r.dataset.n))
            const opened = []
            for (const n of visible) opened.push([n, await click(n)])
            if (r) check(res.afterJump.length === 0, 'x-dropdown, recycle on: every reused row\'s trigger targets its own menu', res.afterJump.slice(0, 3))
            check(res.afterChange.length === 0, `x-dropdown, recycle ${r ? 'on' : 'off'}: a trigger follows its id expression when the value changes on a kept row`, res.afterChange.slice(0, 3))
            check(opened.every(([n, o]) => o.length === 1 && o[0] === 'menu ' + n), `x-dropdown, recycle ${r ? 'on' : 'off'}: clicking a trigger opens exactly its own row's menu`, opened)
            await done(p, `x-dropdown, recycle ${r ? 'on' : 'off'}`)
        }
        // A row whose trigger has a menu open elsewhere (aria-expanded) is not reused
        {
            const p = await openExtra('dropdown', 1)
            const n = await p.evaluate(() => T.rows()[5].dataset.n)
            await p.click(`#v .r[data-n="${n}"] .sh`)
            await new Promise((res) => setTimeout(res, 50))
            const res = await p.evaluate(async () => {
                const row = T.rows()[5], plain = T.rows()[6], expanded = row.querySelector('.sh').getAttribute('aria-expanded')
                await T.go(20000)
                return { expanded, busy: row.isConnected, plain: plain.isConnected }
            })
            check(res.expanded === 'true' && !res.busy && res.plain, 'x-dropdown, recycle on: a row whose trigger has its menu open (aria-expanded) is destroyed, not reused', res)
            await done(p, 'x-dropdown open shared menu')
        }

        // Teleported content open or focused keeps its row from reuse
        for (const arm of ['popover', 'focus']) {
            const p = await openExtra('teleport', 1)
            const res = await p.evaluate(async (arm) => {
                await T.go(3000)
                const row = T.rows()[5], clone = row.querySelector('template[x-teleport]')._x_teleport
                if (arm === 'popover') clone.querySelector('.tp').showPopover()
                else clone.querySelector('.ti').focus()
                const was = row.dataset.n
                await frames_(2)
                await T.go(30000)
                const open = [...document.querySelectorAll('.tp:popover-open')].map((t) => [t.dataset.for, t.textContent])
                return { was, rowConnected: row.isConnected, cloneConnected: clone.isConnected, cloneFor: clone.querySelector('.tp').dataset.for, open, focusedTeleport: !!document.activeElement.closest('.tw') }
            }, arm)
            check(!res.rowConnected && !res.cloneConnected && res.open.length === 0 && !res.focusedTeleport, `x-teleport, recycle on: a row whose teleported content holds ${arm === 'popover' ? 'an open popover' : 'focus'} is destroyed, not reused`, res)
            await done(p, `x-teleport ${arm}`)
        }

        // manifest:virtual-recycle: fires on reused rows only, with the new item bound; row-local state resets through it
        for (const r of [1, 0]) {
            const p = await openExtra('hook', r)
            const res = await p.evaluate(async () => {
                const old = new WeakSet(T.rows())
                for (const row of T.rows()) Alpine.$data(row).open = true
                await frames_(2)
                await T.go(20000)
                const rows = T.rows()
                const reused = rows.filter((row) => old.has(row)), fresh = rows.filter((row) => !old.has(row))
                const bad = []
                for (const row of reused) {
                    const want = T.data().items[+row.dataset.i].id + ':' + row.dataset.i
                    if (row.dataset.got !== want || row.dataset.seen !== row.dataset.n || row.querySelector('.st').textContent !== 'closed') bad.push([row.dataset.n, row.dataset.got, row.dataset.seen, row.querySelector('.st').textContent])
                }
                return { reused: reused.length, fresh: fresh.length, bad: bad.slice(0, 3), freshFired: fresh.filter((row) => row.dataset.got !== undefined).length, born: reused[0] && [reused[0].dataset.born, reused[0].dataset.n] }
            })
            if (r) {
                check(res.reused > 5 && res.bad.length === 0, 'recycle hook: @manifest:virtual-recycle resets row-local x-data on reuse; detail is the new key and index; the scope reads the new item', res)
                check(res.freshFired === 0, 'recycle hook: not fired for freshly mounted rows', res)
            } else check(res.reused === 0 && res.freshFired === 0, 'recycle hook, recycle off: never fired', res)
            check(p.warns.length === 0, `recycle hook, recycle ${r ? 'on' : 'off'}: no x-init warning when the template handles the event`, p.warns)
            await done(p, `recycle hook, recycle ${r ? 'on' : 'off'}`)
        }

        // The hook fires after the pass's row updates: handlers that splice or scroll leave no stale bindings,
        // and see the new item's DOM
        {
            const rowsTrue = () => {
                const items = T.data().items, bad = []
                let prev = null
                for (const row of T.rows()) {
                    const i = +row.dataset.i, it = items[i]
                    if (!it || it.name !== row.dataset.n || row.querySelector('.name').textContent !== row.dataset.n) bad.push([row.dataset.n, i, it && it.name])
                    if (prev !== null && i !== prev + 1) bad.push(['order', prev, i])
                    prev = i
                }
                return bad
            }
            for (const page of ['hooksplice', 'hookscroll', 'hookboth']) {
                const p = await openExtra(page, 1)
                const res = await p.evaluate(async (fn) => {
                    const rowsTrue = (0, eval)('(' + fn + ')')
                    await T.go(60000)
                    await frames_(4); await T.stable()
                    const settled = rowsTrue()
                    T.data().items.push({ id: 'p', slot: 'p', name: 'p', ex: false })
                    await frames_(4); await T.stable()
                    return { fired: T.data().done, settled: settled.slice(0, 4), bad: settled.length, afterPush: rowsTrue().length }
                }, rowsTrue.toString())
                check(res.fired > 0 && res.bad === 0 && res.afterPush === 0, `recycle hook timing: a handler that ${page === 'hooksplice' ? 'splices the source' : page === 'hookscroll' ? 'scrolls' : 'splices and scrolls'} leaves every row on its own item`, res)
                await done(p, `hook timing ${page}`)
            }
            const p = await openExtra('hooksaw', 1)
            const saw = await p.evaluate(async () => {
                await T.go(20000)
                await frames_(2)
                const rows = T.rows().filter((row) => row.dataset.saw !== undefined)
                return { fired: rows.length, stale: rows.filter((row) => row.dataset.saw !== row.dataset.n + '|' + row.dataset.n).map((row) => [row.dataset.n, row.dataset.saw]).slice(0, 3) }
            })
            check(saw.fired > 5 && saw.stale.length === 0, 'recycle hook timing: the handler reads the new item\'s DOM (text and bound attributes)', saw)
            await done(p, 'hook timing DOM')
        }

        // A data-bound aria-expanded (no aria-controls/popovertarget) does not stop reuse
        {
            const p = await openExtra('expanded', 1)
            const res = await p.evaluate(async () => {
                await T.go(3000)
                const row = T.rows().find((r) => r.querySelector('.ex').getAttribute('aria-expanded') === 'true')
                const was = row.dataset.n
                await T.go(30000)
                const it = T.data().items[+row.dataset.i]
                return { was, reused: row.isConnected, now: row.dataset.n, aria: row.querySelector('.ex').getAttribute('aria-expanded'), text: row.querySelector('.ex').textContent, want: it.ex }
            })
            check(res.reused && res.now !== res.was && res.aria === String(res.want) && res.text === (res.want ? 'expanded' : 'collapsed'), 'aria-expanded bound to row data (no aria-controls): the row is reused and shows the new item\'s value', res)
            await done(p, 'data-bound aria-expanded')
        }

        // x-init warning: a handler on a nested element (the event does not bubble) does not silence it; x-init.once counts
        for (const page of ['initnested', 'initmod']) {
            const p = await openExtra(page, 1)
            check(p.warns.length === 1 && /x-init/.test(p.warns[0]), `x-init warning: ${page === 'initnested' ? 'a recycle handler on a nested element does not silence it' : 'x-init.once counts as x-init'}`, p.warns)
            await done(p, `x-init warning ${page}`)
        }

        // x-transition in rows: recycle stays off for the list, with one warning; x-init without the hook warns once
        {
            const p = await openExtra('transition', 1)
            const res = await p.evaluate(async () => { const c0 = window.__created, n0 = T.rows().length; await T.go(20000); return { created: window.__created - c0, rows: T.rows().length, n0 } })
            check(res.created >= res.n0 && p.warns.length === 1 && /x-transition/.test(p.warns[0]), 'x-transition in rows: recycle is off for the list (rows recreated), one warning naming x-transition', { ...res, warns: p.warns })
            await done(p, 'x-transition rows')
            const q = await openExtra('init', 1)
            check(q.warns.length === 1 && /x-init/.test(q.warns[0]) && /manifest:virtual-recycle/.test(q.warns[0]), 'x-init in rows with recycle: one warning naming x-init and the event', q.warns)
            await done(q, 'x-init warning')
            const o = await openExtra('init', 0)
            check(o.warns.length === 0, 'x-init in rows without recycle: no warning', o.warns)
            await done(o, 'x-init no recycle')
        }

        // A row init that throws during a recycle mount leaves no live effect behind to mount it again
        {
            const p = await openExtra('throwing', 1)
            const res = await p.evaluate(async () => {
                window.__throwNext = true
                await T.go(20000)
                const c0 = window.__created, n0 = document.querySelectorAll('#v .r').length
                T.data().tick++
                await frames_(4)
                return { created: window.__created - c0, rows: document.querySelectorAll('#v .r').length, n0 }
            })
            check(p.errors.length === 1 && /row init failed/.test(p.errors[0]), 'throwing mount: the init error surfaces once (setup)', p.errors)
            check(res.created === 0 && res.rows === res.n0, 'throwing mount: a later change does not re-run the failed mount', res)
            await p.close()
        }

        // 6. Teardown: destroyed container, switch to the non-recycle container, both gone; nodes collectable
        {
            const p = await open('/teardown')
            const res = await p.evaluate(async () => {
                const gc = async () => { for (let i = 0; i < 6; i++) { window.gc(); await new Promise((r) => setTimeout(r, 30)) } }
                for (const y of [9000, 30000, 1200, 45000]) await T.go(y)
                const recycleRefs = window.__refs.slice()
                const d = T.data()
                d.mode = 'plain'; await frames_(3); await T.stable()
                const plainRows = T.rows().length, observedPlain = window.__roRow
                await T.go(20000)
                d.mode = 'off'; await frames_(3)
                const rowsOff = document.querySelectorAll('.r').length, observedOff = window.__roRow
                window.__refs = window.__refs.filter((r) => !recycleRefs.includes(r))
                const plainRefs = window.__refs
                await gc()
                return { plainRows, observedPlain, rowsOff, observedOff, aliveRecycle: recycleRefs.filter((r) => r.deref()).length, ofRecycle: recycleRefs.length, aliveAll: [...recycleRefs, ...plainRefs].filter((r) => r.deref()).length }
            })
            check(res.plainRows > 5 && res.observedPlain <= res.plainRows * 2, 'teardown: switching recycle off (re-init) leaves only the new container\'s rows observed', res)
            check(res.rowsOff === 0 && res.observedOff === 0, 'teardown: destroyed containers leave no rows and no observed row nodes', res)
            check(res.aliveAll === 0, 'teardown: every row node ever created is collectable', res)
            await done(p, 'teardown')
        }
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 }
    else console.log('\nall passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
