/**
 * Real-Chrome guard for the cold-load waterfall, with a fixed latency on every response:
 * 1. Alpine and the unconditional modules are requested while manifest.json is in flight;
 * 2. component HTML for the first view is requested in one round, nested components in the next;
 * 3. no component file is requested more than twice (loader + utilities scan share in-flight fetches);
 * 4. the hints never delay the first view: its component requests start within two round trips
 *    of the manifest, and every component is in the DOM before Alpine starts;
 * 5. the page still boots: data renders, every component lands, no page errors, no hint left in <head>.
 *
 * Run: node tests/e2e/boot-waterfall.e2e.mjs
 */
import http from 'http'
import path from 'path'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = process.env.BOOT_SRC || path.join(root, 'src')
const LAT = Number(process.env.BOOT_LATENCY || 120)
const ALPINE = path.join(root, 'node_modules/alpinejs/dist/cdn.min.js')
const INDEX = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>boot</title>
<link rel="manifest" href="/manifest.json">
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"></script>
</head><body x-data>
<x-header></x-header>
<main><x-hero></x-hero><x-features></x-features></main>
<x-footer></x-footer>
<p id="d" x-text="$x.site.title"></p>
</body></html>`
const FILES = {
  '/manifest.json': JSON.stringify({ name: 'boot', components: ['components/header.html', 'components/hero.html', 'components/features.html', 'components/card.html', 'components/footer.html', 'components/logo.html'], data: { site: '/data/site.json', nav: '/data/nav.json' } }),
  '/data/site.json': JSON.stringify({ title: 'Boot' }),
  '/data/nav.json': JSON.stringify([{ label: 'Home' }]),
  '/components/header.html': '<header><x-logo></x-logo><nav>nav</nav></header>',
  '/components/logo.html': '<span id="logo">logo</span>',
  '/components/hero.html': '<section>hero</section>',
  '/components/features.html': '<section><x-card></x-card><x-card></x-card></section>',
  '/components/card.html': '<article class="card">card</article>',
  '/components/footer.html': '<footer id="foot">footer</footer>',
}
const server = await new Promise(r => { const s = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); setTimeout(() => {
  if (u.pathname === '/__alpine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(ALPINE)) }
  if (FILES[u.pathname]) { res.writeHead(200, { 'content-type': u.pathname.endsWith('.json') ? 'application/json' : 'text/html' }); return res.end(FILES[u.pathname]) }
  if (/^\/(scripts|styles)\//.test(u.pathname)) { const f = path.join(src, u.pathname); if (!existsSync(f)) { res.writeHead(404); return res.end() } res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/javascript' }); return res.end(readFileSync(f)) }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(INDEX) }
  res.writeHead(404); res.end() }, LAT) }); s.listen(0, '127.0.0.1', () => r(s)) })
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
const runs = []
for (let i = 0; i < 3; i++) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.evaluateOnNewDocument(() => { window.__t = {}; const mark = (k) => { if (!(k in window.__t)) window.__t[k] = Math.round(performance.now()) }
    document.addEventListener('alpine:init', () => mark('alpineInit')); window.addEventListener('manifest:data-ready', () => mark('dataReady')); window.addEventListener('manifest:components-processed', () => mark('componentsProcessed')); window.addEventListener('manifest:ready', () => mark('ready'))
    new MutationObserver(() => { if (document.getElementById('foot') && document.getElementById('logo') && document.querySelectorAll('.card').length === 2) mark('allComponentsInDom') }).observe(document, { childList: true, subtree: true }) })
  await p.goto(`http://127.0.0.1:${server.address().port}/`)
  await p.waitForFunction(() => window.__t.allComponentsInDom && window.__t.alpineInit, { timeout: 20000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 800))
  const out = await p.evaluate(() => { const res = performance.getEntriesByType('resource').map(e => ({ n: new URL(e.name).pathname, s: Math.round(e.startTime), e: Math.round(e.responseEnd), t: e.initiatorType })); const find = (k) => res.filter(r => r.n.includes(k)); return { t: window.__t, alpineStart: find('__alpine')[0]?.s, alpineFetches: find('__alpine').length, manifestEnd: find('manifest.json')[0]?.e, firstModuleStart: Math.min(...res.filter(r => r.n.startsWith('/scripts/manifest.') && r.n !== '/scripts/manifest.js').map(r => r.s)), comp: find('/components/').map(r => `${r.n.split('/').pop().replace('.html', '')}@${r.s}-${r.e}`), requests: res.length, text: document.getElementById('d')?.textContent, hintsLeft: document.querySelectorAll('link[data-mnfst-hint]').length } })
  runs.push({ ...out, errors }); await ctx.close()
}
await browser.close(); server.close()
const fails = []
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
const r = runs[0]
const starts = (name) => r.comp.filter(c => c.startsWith(name + '@')).map(c => Number(c.split('@')[1].split('-')[0]))
check(runs.every(x => x.alpineStart < x.manifestEnd), 'Alpine is requested while manifest.json is in flight', runs.map(x => [x.alpineStart, x.manifestEnd]))
check(runs.every(x => x.firstModuleStart < x.manifestEnd), 'modules are requested while manifest.json is in flight', runs.map(x => [x.firstModuleStart, x.manifestEnd]))
check(runs.every(x => x.alpineFetches === 1), 'Alpine is downloaded once', runs.map(x => x.alpineFetches))
const top = ['header', 'hero', 'features', 'footer'].map(n => Math.min(...starts(n)))
check(Math.max(...top) - Math.min(...top) < LAT / 2, 'first-view components are requested in one round', top)
const nested = ['logo', 'card'].map(n => Math.min(...starts(n)))
check(Math.max(...nested) <= Math.max(...top) + LAT * 1.5 + 60, 'nested components follow within one round', { top, nested })
const counts = Object.fromEntries(['header', 'hero', 'features', 'footer', 'logo', 'card'].map(n => [n, starts(n).length]))
check(['header', 'hero', 'features', 'footer'].every(n => counts[n] === 1) && Object.values(counts).every(c => c <= 2), 'first-view component files are requested once (nested: at most twice)', counts)
check(Math.min(...top) - r.manifestEnd < LAT * 2, 'first-view component requests start within two round trips of the manifest', { manifestEnd: r.manifestEnd, top })
check(runs.every(x => x.t.allComponentsInDom <= x.t.alpineInit + 30), 'every component is in the DOM by the time Alpine starts', runs.map(x => [x.t.allComponentsInDom, x.t.alpineInit]))
check(runs.every(x => x.hintsLeft === 0), 'no hint is left in <head> after boot', runs.map(x => x.hintsLeft))
check(runs.every(x => x.text === 'Boot' && x.t.allComponentsInDom > 0), 'the page boots: data renders and every component lands', runs.map(x => [x.text, x.t.allComponentsInDom]))
check(runs.every(x => x.errors.length === 0), 'no page errors', runs.flatMap(x => x.errors))
console.log(JSON.stringify({ latency: LAT, alpineInit: runs.map(x => x.t.alpineInit), allComponentsInDom: runs.map(x => x.t.allComponentsInDom), ready: runs.map(x => x.t.ready), requests: runs.map(x => x.requests) }))
if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 } else console.log('\nall passed')
