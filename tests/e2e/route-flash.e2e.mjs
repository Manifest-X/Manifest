/**
 * Route flash before the router (real Chrome, modules delayed):
 * 1. a non-matching x-route never renders in any frame on a client-routed page;
 * 2. after boot the matching route shows, the other hides, navigation still works;
 * 3. prerendered pages and pages without the router keep their routes painted from the first frame.
 *
 * Run: npm run build && node tests/e2e/route-flash.e2e.mjs
 * ROUTE_SRC=<dir> serves another src/ (e.g. a checkout of the old tree, to see it fail).
 */
import http from 'http'
import path from 'path'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = process.env.ROUTE_SRC || path.join(root, 'src')
const LAT = Number(process.env.ROUTE_LATENCY || 400)
const ALPINE = path.join(root, 'node_modules/alpinejs/dist/cdn.min.js')

// The two rules manifest.css ships for cloak and route hiding
const CSS = '<style>[hidden],[x-cloak]{display:none}[x-route][hidden]{display:none!important}</style>'
const page = ({ modules = '', meta = '' } = {}) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>r</title>${meta}${CSS}
<link rel="manifest" href="/manifest.json">
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"${modules}></script>
</head><body x-data>
<nav><a id="to-about" href="/about">About</a></nav>
<p id="plain">plain</p>
<section id="r-home" x-route="/">home</section>
<section id="r-about" x-route="about">about</section>
<section id="r-missing" x-route="!*">missing</section>
</body></html>`
const PAGES = {
  routed: page(),
  explicit: page({ modules: ' data-modules="router"' }),
  prerendered: page({ meta: '<meta name="manifest:prerendered" content="1">' }),
  norouter: page({ modules: ' data-modules="tooltips"' }),
}
const server = await new Promise(r => { const s = http.createServer((req, res) => { const u = new URL(req.url, 'http://x')
  const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body) }
  if (u.pathname === '/' && PAGES[u.searchParams.get('kind')]) return send('text/html', PAGES[u.searchParams.get('kind')])
  if (u.pathname === '/manifest.json') return send('application/json', JSON.stringify({ name: 'r' }))
  if (u.pathname === '/scripts/manifest.js') return send('text/javascript', readFileSync(path.join(src, 'scripts/manifest.js')))
  // Everything after the loader lands late, so the browser paints before the router runs
  setTimeout(() => {
    if (u.pathname === '/__alpine.js') return send('text/javascript', readFileSync(ALPINE))
    if (u.pathname.startsWith('/scripts/')) { const f = path.join(src, u.pathname); if (!existsSync(f)) { res.writeHead(404); return res.end() } return send('text/javascript', readFileSync(f)) }
    res.writeHead(404); res.end()
  }, LAT)
}); s.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })

async function run(kind) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.evaluateOnNewDocument(() => {
    window.__frames = []
    const seen = (id) => { const el = document.getElementById(id); return el ? el.getClientRects().length > 0 : null }
    const tick = () => { if (document.body) window.__frames.push({ t: Math.round(performance.now()), plain: seen('plain'), home: seen('r-home'), about: seen('r-about'), missing: seen('r-missing'), router: !!window.ManifestRoutingVisibility, alpine: !!window.Alpine }); if (window.__frames.length < 400) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  await p.goto(base + '/?kind=' + kind, { waitUntil: 'load' })
  await p.waitForFunction(() => window.Alpine && window.__frames.length > 0, { timeout: 15000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 500))
  const out = await p.evaluate(() => {
    const vis = (id) => document.getElementById(id).getClientRects().length > 0
    const f = window.__frames
    const before = f.filter(x => !x.router)
    return { frames: f.length, framesBeforeRouter: before.length, firstFrame: f[0], aboutEverShown: f.some(x => x.about), missingEverShown: f.some(x => x.missing), homeFirstShown: f.find(x => x.home)?.t, homeBlinks: f.filter((x, i) => i > 0 && f[i - 1].home && !x.home).length, plainFirstShown: f.find(x => x.plain)?.t, alpineAt: f.find(x => x.alpine)?.t, end: { home: vis('r-home'), about: vis('r-about'), missing: vis('r-missing') }, cloaked: document.querySelectorAll('[x-cloak]').length }
  })
  if (kind === 'routed') {
    await p.click('#to-about'); await new Promise(r => setTimeout(r, 400))
    out.afterNav = await p.evaluate(() => ({ home: document.getElementById('r-home').getClientRects().length > 0, about: document.getElementById('r-about').getClientRects().length > 0 }))
  }
  await ctx.close()
  return { ...out, errors }
}

const fails = []
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
const res = {}
for (const kind of Object.keys(PAGES)) res[kind] = await run(kind)
await browser.close(); server.close()

const { routed, explicit, prerendered, norouter } = res
check(routed.framesBeforeRouter > 0, 'frames were painted before the router loaded (the test can see a flash)', routed.framesBeforeRouter)
check(!routed.aboutEverShown && !routed.missingEverShown, 'derived modules: a non-matching route never renders', { about: routed.aboutEverShown, missing: routed.missingEverShown, firstFrame: routed.firstFrame })
check(!explicit.aboutEverShown && !explicit.missingEverShown, 'data-modules with router: a non-matching route never renders', { about: explicit.aboutEverShown, missing: explicit.missingEverShown })
check(routed.end.home && !routed.end.about && !routed.end.missing, 'after boot the matching route shows and the rest hide', routed.end)
check(routed.cloaked === 0 && explicit.cloaked === 0, 'no x-cloak left after Alpine starts', [routed.cloaked, explicit.cloaked])
check(routed.afterNav?.about && !routed.afterNav?.home, 'client navigation still swaps routes', routed.afterNav)
check(prerendered.firstFrame?.home && prerendered.firstFrame?.about && prerendered.cloaked === 0, 'prerendered page: routes paint from the first frame, never cloaked', { firstFrame: prerendered.firstFrame, cloaked: prerendered.cloaked })
check(norouter.firstFrame?.home && norouter.firstFrame?.about && norouter.cloaked === 0, 'page without the router: routes paint from the first frame, never cloaked', { firstFrame: norouter.firstFrame, cloaked: norouter.cloaked })
check(Object.values(res).every(x => x.errors.length === 0), 'no page errors', Object.values(res).flatMap(x => x.errors))
console.log(JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { framesBeforeRouter: v.framesBeforeRouter, homeFirstShown: v.homeFirstShown, homeBlinks: v.homeBlinks, plainFirstShown: v.plainFirstShown, alpineAt: v.alpineAt }]))))
if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 } else console.log('\nall passed')
