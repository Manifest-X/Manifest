/**
 * Route flash before the router and Alpine (real Chrome; slow modules, slow Alpine, fast):
 * 1. a route that surely doesn't match the URL never renders in any frame;
 * 2. the matching route renders from the first frame and never blinks;
 * 3. inside routes, content Alpine hides (x-show false, a closed x-show menu, an inactive tab panel)
 *    and an x-show route never render before Alpine;
 * 4. the '!*' catch-all never renders when another route matches, and shows on a real 404;
 * 5. conditions: exact, subpaths, substring, comma lists, '!', wildcards, a locale prefix (/fr/about);
 * 6. after boot the router's state is unchanged and client navigation still swaps routes;
 * 7. prerendered pages and pages without the router keep every route painted from the first frame.
 * Prints frames painted per element kind and LCP (also for a route whose main content is x-show).
 *
 * Run: npm run build && node tests/e2e/route-flash.e2e.mjs
 * ROUTE_SRC=<dir> serves another src/ (e.g. the old tree, to compare).
 */
import http from 'http'
import path from 'path'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = process.env.ROUTE_SRC || path.join(root, 'src')
const ALPINE = path.join(root, 'node_modules/alpinejs/dist/cdn.min.js')

// The rules manifest.css ships for cloak and route hiding
const CSS = '<style>[hidden],[x-cloak]{display:none}[x-route][hidden]{display:none!important}section{min-height:20px}</style>'
const BIG = 'Lorem ipsum dolor sit amet. '.repeat(60)
const ROUTES = {
  home: '/', about: 'about', docs: '/docs', list: 'pricing,about', not: '!about', wild: 'docs/*',
}
// Content Alpine (or the tabs module) hides, inside each route
const inner = (id) => `<div x-data="{ open: false }">
<p id="${id}-xs" x-show="false">hidden by x-show</p>
<button @click="open = !open">menu</button><ul id="${id}-menu" x-show="open"><li>item</li></ul>
<button x-tab="${id}-t1">1</button><button x-tab="${id}-t2">2</button>
<div id="${id}-t1" x-tabpanel="${id}">tab one</div><div id="${id}-t2" x-tabpanel="${id}">tab two</div>
</div>`
const section = (id, r, mainXShow) => mainXShow
  ? `<section id="r-${id}" x-route="${r}" x-data><div x-show="true"><p>${id}: ${BIG}</p></div></section>`
  : `<section id="r-${id}" x-route="${r}"><p>${id}: ${BIG}</p>${inner(id)}</section>`
const page = ({ modules = '', meta = '', mainXShow = false } = {}) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>r</title>${meta}${CSS}
<link rel="manifest" href="/manifest.json">
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"${modules}></script>
</head><body x-data="{ show: false }">
<nav><a id="to-about" href="/about">About</a></nav>
${Object.entries(ROUTES).map(([id, r]) => section(id, r, mainXShow)).join('\n')}
<section id="r-missing" x-route="!*">missing</section>
<section id="r-show" x-route="!zzz" x-show="show">x-show false</section>
</body></html>`
const PAGES = {
  routed: page(),
  explicit: page({ modules: ' data-modules="router"' }),
  mainXShow: page({ mainXShow: true }),
  prerendered: page({ meta: '<meta name="manifest:prerendered" content="1">' }),
  norouter: page({ modules: ' data-modules="tooltips"' }),
}
const MATCH = {
  '/': ['home', 'not'],
  '/about': ['about', 'list'],
  '/fr/about': ['about', 'list'],
  '/docs/guide': ['docs', 'not', 'wild'],
  '/nope': ['not', 'missing'],
}
const MANIFEST = JSON.stringify({ name: 'r', data: { strings: { en: '/en.json', fr: '/fr.json' } } })
const SCENARIOS = { slowModules: { mod: 400, alp: 0 }, slowAlpine: { mod: 0, alp: 1500 }, fast: { mod: 0, alp: 0 } }
let delay = SCENARIOS.slowModules

const server = await new Promise(r => { const s = http.createServer((req, res) => { const u = new URL(req.url, 'http://x')
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body) }
  const kind = u.searchParams.get('kind')
  if (kind && PAGES[kind]) return send('text/html', PAGES[kind])
  if (u.pathname === '/manifest.json') return send('application/json', MANIFEST)
  if (u.pathname === '/en.json' || u.pathname === '/fr.json') return send('application/json', '{"t":"x"}')
  if (u.pathname === '/scripts/manifest.js') return send('text/javascript', readFileSync(path.join(src, 'scripts/manifest.js')))
  if (u.pathname === '/__alpine.js') return setTimeout(() => send('text/javascript', readFileSync(ALPINE)), delay.alp)
  if (u.pathname.startsWith('/scripts/')) return setTimeout(() => { const f = path.join(src, u.pathname); if (!existsSync(f)) { res.writeHead(404); return res.end() } send('text/javascript', readFileSync(f)) }, delay.mod)
  res.writeHead(404); res.end()
}); s.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
const routeIds = [...Object.keys(ROUTES), 'missing', 'show']
const innerIds = Object.keys(ROUTES).flatMap(id => ['xs', 'menu', 't1', 't2'].map(k => `${id}-${k}`))
const ids = [...routeIds.map(id => 'r-' + id), ...innerIds]

async function run(kind, urlPath = '/', nav = false) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.evaluateOnNewDocument((ids) => {
    window.__frames = []; window.__lcp = 0
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = Math.round(e.startTime) }).observe({ type: 'largest-contentful-paint', buffered: true })
    const tick = () => {
      if (document.body) { const f = { t: Math.round(performance.now()), router: !!window.ManifestRoutingVisibility, alpine: !!window.Alpine }; for (const id of ids) { const el = document.getElementById(id); f[id] = el ? el.getClientRects().length > 0 : null } window.__frames.push(f) }
      if (window.__frames.length < 600) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, ids)
  await p.goto(base + urlPath + '?kind=' + kind, { waitUntil: 'load' })
  await p.waitForFunction(() => window.Alpine && window.__frames.length > 0, { timeout: 20000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 600))
  const out = await p.evaluate((ids) => {
    const f = window.__frames.filter(x => ids.some(id => x[id] !== null))
    const vis = (id) => { const el = document.getElementById(id); return el ? el.getClientRects().length > 0 : null }
    const per = {}
    for (const id of ids) per[id] = { frames: f.filter(x => x[id]).length, first: f[0]?.[id], firstShown: f.find(x => x[id])?.t ?? null, blinks: f.filter((x, i) => i > 0 && f[i - 1][id] && !x[id]).length }
    return { frames: f.length, beforeRouter: f.filter(x => !x.router).length, routerAt: f.find(x => x.router)?.t, per, end: Object.fromEntries(ids.map(id => [id, vis(id)])), cloaked: document.querySelectorAll('[x-cloak]').length, lcp: window.__lcp, firstFrame: f[0]?.t }
  }, ids)
  if (nav) {
    await p.click('#to-about'); await new Promise(r => setTimeout(r, 400))
    out.afterNav = await p.evaluate(() => ({ home: document.getElementById('r-home').getClientRects().length > 0, about: document.getElementById('r-about').getClientRects().length > 0, list: document.getElementById('r-list').getClientRects().length > 0, aboutT1: document.getElementById('about-t1').getClientRects().length > 0, aboutT2: document.getElementById('about-t2').getClientRects().length > 0 }))
  }
  await ctx.close()
  return { ...out, errors }
}

const fails = []
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
const sum = (r, list) => list.reduce((n, id) => n + r.per[id].frames, 0)
const metrics = {}
for (const [name, d] of Object.entries(SCENARIOS)) {
  delay = d
  for (const [urlPath, matching] of Object.entries(MATCH)) {
    for (const kind of urlPath === '/' ? ['routed', 'explicit'] : ['routed']) {
      const r = await run(kind, urlPath, urlPath === '/' && kind === 'routed')
      const label = `${name} ${kind} ${urlPath}`
      const on = matching.filter(id => id !== 'missing')
      const off = Object.keys(ROUTES).filter(id => !matching.includes(id))
      const hiddenInside = on.flatMap(id => [`${id}-xs`, `${id}-menu`, ...(kind === 'routed' ? [`${id}-t2`] : [])])
      metrics[label] = {
        lcp: r.lcp, routerAt: r.routerAt,
        matchFirstShown: Math.max(...on.map(id => r.per['r-' + id].firstShown ?? -1)),
        framesPainted: { offRoute: sum(r, off.map(id => 'r-' + id)), catchAll: r.per['r-missing'].frames, xShowRoute: r.per['r-show'].frames, xShowInside: sum(r, on.map(id => `${id}-xs`)), closedMenu: sum(r, on.map(id => `${id}-menu`)), inactiveTab: kind === 'routed' ? sum(r, on.map(id => `${id}-t2`)) : null },
        blinks: on.reduce((n, id) => n + r.per['r-' + id].blinks, 0),
        catchAllFirstShown: matching.includes('missing') ? r.per['r-missing'].firstShown : undefined,
      }
      if (name !== 'fast') check(r.beforeRouter > 0, `${label}: frames painted before the router (the test can see a flash)`, r.beforeRouter)
      check(off.every(id => !r.per['r-' + id].frames), `${label}: off-route sections never render`, off.filter(id => r.per['r-' + id].frames))
      check(on.every(id => r.per['r-' + id].first && r.per['r-' + id].blinks === 0), `${label}: matching sections render from the first frame, no blink`, on.map(id => [id, r.per['r-' + id].first, r.per['r-' + id].blinks]))
      check(hiddenInside.every(id => !r.per[id].frames), `${label}: x-show false, a closed menu and an inactive tab inside a route never render`, hiddenInside.filter(id => r.per[id].frames))
      check(!r.per['r-show'].frames, `${label}: an x-show=false route never renders`, r.per['r-show'])
      if (matching.includes('missing')) check(r.end['r-missing'] && r.per['r-missing'].blinks === 0, `${label}: the catch-all shows on a real 404`, r.per['r-missing'])
      else check(!r.per['r-missing'].frames, `${label}: the catch-all never renders when another route matches`, r.per['r-missing'])
      check(on.every(id => r.end['r-' + id]) && off.every(id => !r.end['r-' + id]) && !r.end['r-show'], `${label}: router state after boot`, r.end)
      if (kind === 'routed') check(on.every(id => r.end[`${id}-t1`] && !r.end[`${id}-t2`] && !r.end[`${id}-xs`]), `${label}: tabs and x-show settle after Alpine`, on.map(id => [r.end[`${id}-t1`], r.end[`${id}-t2`], r.end[`${id}-xs`]]))
      check(r.cloaked === 0, `${label}: no x-cloak left after Alpine starts`, r.cloaked)
      if (r.afterNav) check(r.afterNav.about && r.afterNav.list && !r.afterNav.home && r.afterNav.aboutT1 && !r.afterNav.aboutT2, `${label}: client navigation still swaps routes`, r.afterNav)
      check(r.errors.length === 0, `${label}: no page errors`, r.errors)
    }
  }
  const x = await run('mainXShow', '/')
  metrics[`${name} mainXShow /`] = { lcp: x.lcp, routerAt: x.routerAt, matchFirstShown: x.per['r-home'].firstShown }
  check(!x.per['r-about'].frames && x.end['r-home'], `${name} mainXShow /: off-route never renders, home shows after boot`, x.per['r-about'])
}
delay = SCENARIOS.slowModules
for (const kind of ['prerendered', 'norouter']) {
  const r = await run(kind)
  check(routeIds.filter(id => id !== 'show' && id !== 'missing').every(id => r.per['r-' + id].first) && r.cloaked === 0, `${kind}: every route paints from the first frame, never cloaked`, { cloaked: r.cloaked })
}
await browser.close(); server.close()
console.log(JSON.stringify(metrics))
if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 } else console.log('\nall passed')
