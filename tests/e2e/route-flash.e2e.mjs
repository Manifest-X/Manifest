/**
 * Route flash before the router (real Chrome, slow modules or slow Alpine):
 * 1. a route that surely doesn't match the URL never renders in any frame;
 * 2. the matching route renders from the first frame and never blinks (LCP stays at first paint);
 * 3. conditions: exact, subpaths, substring, comma lists, '!', wildcards, a locale prefix (/fr/about);
 * 4. after boot the router's state is unchanged, x-show routes never paint before Alpine,
 *    client navigation still swaps routes;
 * 5. prerendered pages and pages without the router keep every route painted from the first frame.
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
const page = ({ modules = '', meta = '' } = {}) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>r</title>${meta}${CSS}
<link rel="manifest" href="/manifest.json">
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"${modules}></script>
</head><body x-data="{ show: false }">
<nav><a id="to-about" href="/about">About</a></nav>
${Object.entries(ROUTES).map(([id, r]) => `<section id="r-${id}" x-route="${r}"><p>${id}: ${BIG}</p></section>`).join('\n')}
<section id="r-missing" x-route="!*">missing</section>
<section id="r-show" x-route="*" x-show="show">x-show false</section>
</body></html>`
const PAGES = {
  routed: page(),
  explicit: page({ modules: ' data-modules="router"' }),
  prerendered: page({ meta: '<meta name="manifest:prerendered" content="1">' }),
  norouter: page({ modules: ' data-modules="tooltips"' }),
}
const MATCH = {
  '/': ['home', 'not'],
  '/about': ['about', 'list'],
  '/fr/about': ['about', 'list'],
  '/docs/guide': ['docs', 'not', 'wild'],
}
const MANIFEST = JSON.stringify({ name: 'r', data: { strings: { en: '/en.json', fr: '/fr.json' } } })
const SCENARIOS = { slowModules: { mod: 400, alp: 0 }, slowAlpine: { mod: 0, alp: 1500 } }
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
const ids = [...Object.keys(ROUTES), 'missing', 'show']

async function run(kind, urlPath = '/', nav = false) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.evaluateOnNewDocument((ids) => {
    window.__frames = []; window.__lcp = 0
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = Math.round(e.startTime) }).observe({ type: 'largest-contentful-paint', buffered: true })
    const tick = () => {
      if (document.body) { const f = { t: Math.round(performance.now()), router: !!window.ManifestRoutingVisibility }; for (const id of ids) { const el = document.getElementById('r-' + id); f[id] = el ? el.getClientRects().length > 0 : null } window.__frames.push(f) }
      if (window.__frames.length < 600) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, ids)
  await p.goto(base + urlPath + '?kind=' + kind, { waitUntil: 'load' })
  await p.waitForFunction(() => window.Alpine && window.__frames.length > 0, { timeout: 20000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 600))
  const out = await p.evaluate((ids) => {
    const f = window.__frames.filter(x => ids.some(id => x[id] !== null))
    const vis = (id) => document.getElementById('r-' + id).getClientRects().length > 0
    const per = {}
    for (const id of ids) per[id] = { ever: f.some(x => x[id]), first: f[0]?.[id], firstShown: f.find(x => x[id])?.t ?? null, blinks: f.filter((x, i) => i > 0 && f[i - 1][id] && !x[id]).length }
    return { frames: f.length, beforeRouter: f.filter(x => !x.router).length, per, end: Object.fromEntries(ids.map(id => [id, vis(id)])), cloaked: document.querySelectorAll('[x-cloak]').length, lcp: window.__lcp, firstFrame: f[0]?.t }
  }, ids)
  if (nav) {
    await p.click('#to-about'); await new Promise(r => setTimeout(r, 400))
    out.afterNav = await p.evaluate(() => ({ home: document.getElementById('r-home').getClientRects().length > 0, about: document.getElementById('r-about').getClientRects().length > 0, list: document.getElementById('r-list').getClientRects().length > 0 }))
  }
  await ctx.close()
  return { ...out, errors }
}

const fails = []
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
const metrics = {}
for (const [name, d] of Object.entries(SCENARIOS)) {
  delay = d
  for (const [urlPath, matching] of Object.entries(MATCH)) {
    for (const kind of urlPath === '/' ? ['routed', 'explicit'] : ['routed']) {
      const r = await run(kind, urlPath, urlPath === '/' && kind === 'routed')
      const label = `${name} ${kind} ${urlPath}`
      const others = Object.keys(ROUTES).filter(id => !matching.includes(id))
      metrics[label] = { lcp: r.lcp, firstFrame: r.firstFrame, matchFirstShown: Object.fromEntries(matching.map(id => [id, r.per[id].firstShown])), beforeRouter: r.beforeRouter, offRoutePaintedFrames: others.filter(id => r.per[id].ever), blinks: matching.reduce((n, id) => n + r.per[id].blinks, 0) }
      check(r.beforeRouter > 0, `${label}: frames painted before the router (the test can see a flash)`, r.beforeRouter)
      check(others.every(id => !r.per[id].ever), `${label}: off-route sections never render`, others.filter(id => r.per[id].ever))
      check(matching.every(id => r.per[id].first && r.per[id].blinks === 0), `${label}: matching sections render from the first frame, no blink`, matching.map(id => [id, r.per[id].first, r.per[id].blinks]))
      check(!r.per.show.ever, `${label}: an x-show=false route never renders`, r.per.show)
      check(matching.every(id => r.end[id]) && others.every(id => !r.end[id]) && !r.end.missing && !r.end.show, `${label}: router state after boot`, r.end)
      check(r.cloaked === 0, `${label}: no x-cloak left after Alpine starts`, r.cloaked)
      if (r.afterNav) check(r.afterNav.about && r.afterNav.list && !r.afterNav.home, `${label}: client navigation still swaps routes`, r.afterNav)
      check(r.errors.length === 0, `${label}: no page errors`, r.errors)
    }
  }
}
delay = SCENARIOS.slowModules
for (const kind of ['prerendered', 'norouter']) {
  const r = await run(kind)
  check(ids.filter(id => id !== 'show' && id !== 'missing').every(id => r.per[id].first) && r.cloaked === 0, `${kind}: every route paints from the first frame, never cloaked`, { per: Object.fromEntries(ids.map(id => [id, r.per[id].first])), cloaked: r.cloaked })
}
await browser.close(); server.close()
console.log(JSON.stringify(metrics))
if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 } else console.log('\nall passed')
