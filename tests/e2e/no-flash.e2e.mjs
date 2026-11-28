/**
 * No flash of content Alpine hides, on pages with or without the router (real Chrome; slow modules, slow Alpine, fast):
 * 1. x-show false, a closed x-show menu, :hidden true and an inactive tab panel paint 0 frames;
 * 2. x-show truthy content appears when Alpine starts, not later; the default tab panel paints from the first frame;
 * 3. an author's own x-cloak is untouched; no x-cloak is left after Alpine starts;
 * 4. a prerendered page is never cloaked and paints its baked state from the first frame;
 * 5. if Alpine fails to load, every parse-time hide is released;
 * 6. markup a script inserts during parsing, and component markup swapped in before Alpine, are covered too.
 * Prints LCP for a page whose main content is x-show (truthy), and the parse cost on large pages
 * (30k/60k elements, a third with x-show; 60k with none).
 *
 * Run: npm run build && node tests/e2e/no-flash.e2e.mjs
 * FLASH_SRC=<dir> serves another src/ (e.g. the old tree, to compare). FLASH_LARGE=0 skips the large pages.
 */
import http from 'http'
import path from 'path'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = process.env.FLASH_SRC || path.join(root, 'src')
const ALPINE = path.join(root, 'node_modules/alpinejs/dist/cdn.min.js')
const LARGE = process.env.FLASH_LARGE !== '0'

const CSS = '<style>[hidden],[x-cloak]{display:none}</style>'
const BIG = 'Lorem ipsum dolor sit amet. '.repeat(60)
const BODY = `<main x-data="{ open: false, ok: true }">
<p id="plain">plain</p>
<div id="main" x-show="ok"><p>${BIG}</p></div>
<p id="xs" x-show="false">hidden by x-show</p>
<p id="xsi" x-show.important="false">hidden by x-show.important</p>
<button @click="open = !open">menu</button><ul id="menu" x-show="open"><li>item</li></ul>
<p id="hid" :hidden="true">hidden by :hidden</p>
<p id="own" x-cloak>author cloak</p>
<button x-tab="t1">1</button><button x-tab="t2">2</button>
<div id="t1" x-tabpanel="g">tab one</div><div id="t2" x-tabpanel="g">tab two</div>
<button x-tab="sa">a</button><button x-tab="sb">b</button><div data-t="c1" class="sa" x-tabpanel="c">shared a</div><div data-t="c2" class="sa" x-tabpanel="c">shared a2</div><div data-t="c3" class="sb" x-tabpanel="c">b</div>
<div x-data="{ tab_h: 'h2' }"><button x-tab="h1">1</button><button x-tab="h2">2</button><div id="h1" x-tabpanel="h">h one</div><div id="h2" x-tabpanel="h">h two</div></div>
</main>`
const page = ({ modules = '', meta = '', body = BODY } = {}) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>f</title>${meta}${CSS}
<link rel="manifest" href="/manifest.json">
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"${modules}></script>
</head><body>${body}</body></html>`
const PRERENDERED_BODY = `<main x-data="{ open: false, ok: true }"><div id="main" x-show="ok"><p>${BIG}</p></div><p id="xs" x-show="false" style="display: none;">x</p><p id="plain">plain</p></main>`
const large = (n, show = true) => `<main x-data="{ open: false }">${Array.from({ length: n / 3 }, (_, i) => `<div class="r"><span${show ? ' x-show="open"' : ''}>s${i}</span><b>b</b></div>`).join('')}</main>`
// Alpine never arrives: every parse-time hide is released
const ALPINE_FAIL = (modules) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>f</title>${CSS}
<link rel="manifest" href="/manifest.json">
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__missing-alpine.js"${modules}></script>
</head><body x-data><h1 id="af" x-show="true">Main</h1><button x-tab="a1">1</button><button x-tab="a2">2</button><div id="a1" x-tabpanel="a">one</div><div id="a2" x-tabpanel="a">two</div></body></html>`
// Markup a script inserts while the document parses, then a slow blocking script
const INSERTED = (blocker) => page({ modules: ' data-modules="tooltips"', body: `<div id="host"></div>
<script>document.getElementById('host').innerHTML = '<div x-data="{ o: false }"><div id="ins" x-show="o">HIDDEN</div><div id="insT" x-show="true">shown</div></div>'</script>
<template id="tp"><div x-data="{ o: false }"><div id="tins" x-show="o">HIDDEN</div></div></template><div id="host2"></div>
<script>document.getElementById('host2').appendChild(document.getElementById('tp').content.cloneNode(true))</script>
${blocker ? '<script src="/slow.js"></script>' : ''}<p id="after">after</p>` })
// x-show inside component markup, swapped in before Alpine starts
const COMPONENT_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>f</title>${CSS}
<link rel="manifest" href="/manifest.json?kind=comp">
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"></script>
</head><body><main x-data="{ open: false }"><x-card></x-card><x-plain></x-plain></main><x-loose></x-loose></body></html>`
const COMPONENTS = {
  card: '<div x-data="{ o: false }"><p id="cx" x-show="o">C</p><p id="ct" x-show="true">T</p><p id="cown" x-cloak>own</p><div x-ignore><p id="cign" x-show="false">ignored</p></div></div>',
  plain: '<p id="cp" x-show="open">uses the page scope</p>',
  loose: '<p id="cl" x-show="false">no scope</p>',
}
const PAGES = {
  alpineFail: ALPINE_FAIL(' data-modules="tabs"'),
  alpineFailDerived: ALPINE_FAIL(''),
  inserted: INSERTED(true),
  insertedNoBlocker: INSERTED(false),
  components: COMPONENT_PAGE,
  derived: page(),
  tabsOnly: page({ modules: ' data-modules="tabs"' }),
  noTabs: page({ modules: ' data-modules="tooltips"' }),
  prerendered: page({ meta: '<meta name="manifest:prerendered" content="1">', body: PRERENDERED_BODY }),
  large30k: page({ modules: ' data-modules="tooltips"', body: large(30000) }),
  large60k: page({ modules: ' data-modules="tooltips"', body: large(60000) }),
  large60kPlain: page({ modules: ' data-modules="tooltips"', body: large(60000, false) }),
}
const SCENARIOS = { slowModules: { mod: 400, alp: 0 }, slowAlpine: { mod: 0, alp: 1500 }, fast: { mod: 0, alp: 0 } }
let delay = SCENARIOS.slowModules

const server = await new Promise(r => { const s = http.createServer((req, res) => { const u = new URL(req.url, 'http://x')
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body) }
  const kind = u.searchParams.get('kind')
  if (kind && PAGES[kind]) return send('text/html', PAGES[kind])
  if (u.pathname === '/manifest.json') return send('application/json', u.searchParams.get('kind') === 'comp' ? JSON.stringify({ name: 'f', components: Object.keys(COMPONENTS).map(n => `components/${n}.html`) }) : '{"name":"f"}')
  const comp = u.pathname.match(/^\/components\/(\w+)\.html$/)
  if (comp && COMPONENTS[comp[1]]) return send('text/html', COMPONENTS[comp[1]])
  if (u.pathname === '/slow.js') return setTimeout(() => send('text/javascript', 'window.__slow = 1'), 1200)
  if (u.pathname === '/scripts/manifest.js') return send('text/javascript', readFileSync(path.join(src, 'scripts/manifest.js')))
  if (u.pathname === '/__alpine.js') return setTimeout(() => send('text/javascript', readFileSync(ALPINE)), delay.alp)
  if (u.pathname.startsWith('/scripts/')) return setTimeout(() => { const f = path.join(src, u.pathname); if (!existsSync(f)) { res.writeHead(404); return res.end() } send('text/javascript', readFileSync(f)) }, delay.mod)
  res.writeHead(404); res.end()
}); s.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
const ids = ['plain', 'main', 'xs', 'xsi', 'menu', 'hid', 'own', 't1', 't2', 'h1', 'h2', 'c1', 'c2', 'c3']

async function run(kind) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.evaluateOnNewDocument((ids) => {
    window.__frames = []; window.__lcp = 0
    document.addEventListener('alpine:init', () => { window.__alpineAt = performance.now() })
    document.addEventListener('DOMContentLoaded', () => { window.__dcl = performance.now() })
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = Math.round(e.startTime) }).observe({ type: 'largest-contentful-paint', buffered: true })
    const tick = () => {
      if (document.body) { const f = { t: Math.round(performance.now()) }; for (const id of ids) { const el = document.getElementById(id) || document.querySelector(`[data-t="${id}"]`); f[id] = el ? el.getClientRects().length > 0 : null } window.__frames.push(f) }
      if (window.__frames.length < 600) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, ids)
  await p.goto(base + '/?kind=' + kind, { waitUntil: 'load', timeout: 60000 })
  await p.waitForFunction(() => window.Alpine && window.__frames.length > 0, { timeout: 20000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 900))
  const out = await p.evaluate((ids) => {
    const f = window.__frames.filter(x => ids.some(id => x[id] !== null))
    const per = {}
    for (const id of ids) per[id] = { frames: f.filter(x => x[id]).length, first: f[0]?.[id], firstShown: f.find(x => x[id])?.t ?? null }
    const end = Object.fromEntries(ids.map(id => { const el = document.getElementById(id) || document.querySelector(`[data-t="${id}"]`); return [id, el ? el.getClientRects().length > 0 : null] }))
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime
    return { per, end, cloaked: [...document.querySelectorAll('[x-cloak]')].map(e => e.id || e.outerHTML.slice(0, 40)), lcp: window.__lcp, alpineAt: Math.round(window.__alpineAt), dcl: Math.round(window.__dcl), fcp: Math.round(fcp || 0), firstFrame: f[0]?.t }
  }, ids)
  await ctx.close()
  return { ...out, errors }
}

const fails = []
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
const metrics = {}
for (const [name, d] of Object.entries(SCENARIOS)) {
  delay = d
  for (const kind of ['derived', 'tabsOnly', 'noTabs']) {
    const r = await run(kind)
    const label = `${name} ${kind}`
    const tabs = kind !== 'noTabs'
    const never = ['xs', 'xsi', 'menu', 'hid', ...(tabs ? ['t2', 'h1', 'c3'] : [])]
    metrics[label] = { lcp: r.lcp, alpineAt: r.alpineAt, mainFirstShown: r.per.main.firstShown, framesPainted: Object.fromEntries(never.map(id => [id, r.per[id].frames])) }
    check(never.every(id => !r.per[id].frames), `${label}: content Alpine hides paints 0 frames`, never.filter(id => r.per[id].frames).map(id => [id, r.per[id].frames]))
    check(r.per.plain.first && (!tabs || (r.per.t1.first && r.per.c1.first && r.per.c2.first)), `${label}: plain content${tabs ? ' and default tab panels (by id or shared class)' : ''} paint from the first frame`, [r.per.plain.first, r.per.t1.first, r.per.c1.first, r.per.c2.first])
    check(r.per.main.firstShown !== null && r.per.main.firstShown <= r.alpineAt + 60, `${label}: x-show truthy content appears at Alpine start`, { firstShown: r.per.main.firstShown, alpineAt: r.alpineAt })
    check(r.end.main && r.end.plain && !r.end.xs && !r.end.xsi && !r.end.menu && !r.end.hid && (!tabs || (r.end.t1 && !r.end.t2 && r.end.h2 && !r.end.h1 && r.end.c1 && r.end.c2 && !r.end.c3)), `${label}: state after Alpine`, r.end)
    check((r.per.own.firstShown ?? Infinity) >= r.alpineAt - 20 && r.cloaked.length === 0, `${label}: author x-cloak kept until Alpine, none left after`, { own: r.per.own.frames, cloaked: r.cloaked })
    check(r.errors.length === 0, `${label}: no page errors`, r.errors)
  }
}
delay = SCENARIOS.slowModules
// Frames for listed ids on one page, recorded until settleMs after load
async function frames(kind, ids, settleMs) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.evaluateOnNewDocument((ids) => {
    window.__frames = []
    document.addEventListener('alpine:init', () => { window.__alpineAt = performance.now() })
    const tick = () => {
      if (document.body) { const f = { t: Math.round(performance.now()) }; for (const id of ids) { const el = document.getElementById(id); f[id] = el ? el.getClientRects().length > 0 : null } window.__frames.push(f) }
      if (window.__frames.length < 900) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, ids)
  await p.goto(base + '/?kind=' + kind, { waitUntil: 'load', timeout: 60000 })
  await new Promise(r => setTimeout(r, settleMs))
  const out = await p.evaluate((ids) => {
    const f = window.__frames
    const per = {}
    for (const id of ids) per[id] = { frames: f.filter(x => x[id]).length, firstShown: f.find(x => x[id])?.t ?? null, blinks: f.filter((x, i) => i > 0 && f[i - 1][id] && !x[id]).length }
    const end = Object.fromEntries(ids.map(id => { const el = document.getElementById(id); return [id, el ? el.getClientRects().length > 0 : null] }))
    return { per, end, alpineAt: window.__alpineAt ? Math.round(window.__alpineAt) : null, cloaked: [...document.querySelectorAll('[x-cloak]')].map(e => e.id) }
  }, ids)
  await ctx.close()
  return { ...out, errors }
}
delay = SCENARIOS.fast
for (const kind of ['alpineFail', 'alpineFailDerived']) {
  const r = await frames(kind, ['af', 'a1', 'a2'], 2500)
  metrics[kind] = r.per
  check(r.end.af && r.end.a1 && r.end.a2 && r.cloaked.length === 0, `${kind}: Alpine fails to load, every parse-time hide is released`, { end: r.end, cloaked: r.cloaked })
}
for (const kind of ['inserted', 'insertedNoBlocker']) {
  const r = await frames(kind, ['ins', 'insT', 'tins', 'after'], 600)
  metrics[kind] = r.per
  check(!r.per.ins.frames && !r.per.tins.frames, `${kind}: x-show false in script-inserted markup paints 0 frames`, [r.per.ins, r.per.tins])
  check(r.per.insT.blinks === 0 && r.end.insT && r.end.after, `${kind}: its truthy sibling never blinks`, r.per.insT)
}
for (const [name, d] of [['slowAlpine', SCENARIOS.slowAlpine], ['slowModules', SCENARIOS.slowModules], ['fast', SCENARIOS.fast]]) {
  delay = d
  const r = await frames('components', ['cx', 'ct', 'cown', 'cign', 'cp', 'cl'], d.alp + 2000)
  metrics[`components ${name}`] = r.per
  check(!r.per.cx.frames && !r.per.cp.frames, `components ${name}: x-show false in component markup paints 0 frames`, [r.per.cx, r.per.cp])
  // As master: author x-cloak released by Alpine, x-ignore content untouched, scope-less x-show evaluated by the processor's initTree
  check(JSON.stringify(r.end) === JSON.stringify({ cx: false, ct: true, cown: true, cign: true, cp: false, cl: false }), `components ${name}: state after Alpine as on master`, r.end)
  check(r.errors.length === 0, `components ${name}: no page errors`, r.errors)
}
delay = SCENARIOS.slowModules
const pre = await run('prerendered')
check(pre.per.main.first && pre.per.plain.first && !pre.per.xs.frames && pre.cloaked.length === 0, 'prerendered: baked state from the first frame, never cloaked', { per: pre.per, cloaked: pre.cloaked })
if (LARGE) {
  delay = SCENARIOS.fast
  for (const kind of ['large30k', 'large60k', 'large60kPlain']) {
    const runs = []
    for (let i = 0; i < 3; i++) runs.push(await run(kind))
    const med = (k) => runs.map(x => x[k]).sort((a, b) => a - b)[1]
    metrics[kind] = { dcl: med('dcl'), fcp: med('fcp'), alpineAt: med('alpineAt') }
  }
}
await browser.close(); server.close()
console.log(JSON.stringify(metrics))
if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 } else console.log('\nall passed')
