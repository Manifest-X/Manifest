/**
 * Localization CSV fetches on a cold load (real Chrome, fixed latency per response):
 * 1. locale discovery fetches every CSV in one round, not one after another (a stored locale applies sooner);
 * 2. each CSV is downloaded once per load (discovery, data content and header checks share it);
 * 3. resolved values and $locale.available order are unchanged, with and without a stored locale;
 * 4. a boot load for the old locale that resolves after the switch never lands over the new locale;
 * 5. without a locale change, a source always lands (even when an author's locale store disagrees with <html lang>).
 *
 * Run: npm run build && node tests/e2e/localization-fetch.e2e.mjs
 * LOC_SRC=<dir> serves another src/ (e.g. the old tree, to see it fail).
 */
import http from 'http'
import path from 'path'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = process.env.LOC_SRC || path.join(root, 'src')
const LAT = Number(process.env.LOC_LATENCY || 150)
const ALPINE = path.join(root, 'node_modules/alpinejs/dist/cdn.min.js')

const page = (head = '', modules = '') => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>loc</title>
<link rel="manifest" href="/manifest.json">
${head}<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"${modules}></script>
</head><body x-data>
<p id="s" x-text="$x.strings.hello"></p>
<p id="l" x-text="$x.labels.title"></p>
<p id="t" x-text="$x.table[1]?.name"></p>
<p id="si" x-text="$x.site.title"></p>
<p id="av" x-text="$locale.available.join(',')"></p>
<p id="cur" x-text="$locale.current"></p>
</body></html>`
// An author-set locale store that disagrees with <html lang>, no localechange after
const STORE_FR = `<script>document.addEventListener('alpine:init', () => Alpine.store('locale', { current: 'fr', available: [], direction: 'ltr', _initialized: false }))</script>`
const PAGES = { '': page(), storeFr: page(STORE_FR), dataOnly: page(STORE_FR, ' data-modules="data"') }
const FILES = {
  '/manifest.json': JSON.stringify({ name: 'loc', data: { strings: { locales: '/strings.csv' }, labels: '/labels.csv', table: '/table.csv', site: { en: '/site.en.json', fr: '/site.fr.json' } } }),
  '/strings.csv': 'key,de,en,fr\nhello,Hallo,Hello,Bonjour\n',
  '/labels.csv': 'key,en,es\ntitle,Title,Titulo\n',
  '/table.csv': 'id,name\n1,Ada\n2,Grace\n',
  '/site.en.json': JSON.stringify({ title: 'Site' }),
  '/site.fr.json': JSON.stringify({ title: 'Le site' }),
}
const type = (p) => p.endsWith('.json') ? 'application/json' : p.endsWith('.csv') ? 'text/csv' : p.endsWith('.css') ? 'text/css' : 'text/javascript'
const server = await new Promise(r => { const s = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); setTimeout(() => {
  if (u.pathname === '/__alpine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(ALPINE)) }
  if (FILES[u.pathname]) { res.writeHead(200, { 'content-type': type(u.pathname), 'cache-control': 'no-store' }); return res.end(FILES[u.pathname]) }
  if (u.pathname.startsWith('/scripts/')) { const f = path.join(src, u.pathname); if (!existsSync(f)) { res.writeHead(404); return res.end() } res.writeHead(200, { 'content-type': type(f) }); return res.end(readFileSync(f)) }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGES[u.searchParams.get('v') || '']) }
  res.writeHead(404); res.end() }, LAT) }); s.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })

async function run(stored, parserDelay = 0, variant = '') {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  const csv = []
  await p.setRequestInterception(true)
  p.on('request', (req) => {
    const n = new URL(req.url()).pathname
    if (n.endsWith('.csv')) csv.push(n)
    // The CSV parser arrives after both locales' files: their parses resolve back to back
    if (parserDelay && n.includes('papaparse')) return setTimeout(() => req.continue(), parserDelay)
    req.continue()
  })
  if (stored) await p.evaluateOnNewDocument((l) => { try { localStorage.setItem('lang', l) } catch (_) { } }, stored)
  await p.evaluateOnNewDocument(() => { window.__t = {}; window.addEventListener('manifest:ready', () => { window.__t.ready = Math.round(performance.now()) }); window.addEventListener('localechange', () => { if (!window.__t.lc) window.__t.lc = Math.round(performance.now()) }) })
  await p.goto(base + '/' + (variant ? '?v=' + variant : ''))
  await p.waitForFunction(() => window.__t.ready, { timeout: 20000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 600))
  const out = await p.evaluate(() => {
    const txt = (id) => document.getElementById(id)?.textContent
    const res = performance.getEntriesByType('resource').filter(e => e.name.endsWith('.csv')).map(e => ({ n: new URL(e.name).pathname, s: Math.round(e.startTime), e: Math.round(e.responseEnd) }))
    return { values: { s: txt('s'), l: txt('l'), t: txt('t'), si: txt('si'), av: txt('av'), cur: txt('cur') }, res, ready: window.__t.ready, lc: window.__t.lc }
  })
  await ctx.close()
  const counts = {}; for (const n of csv) counts[n] = (counts[n] || 0) + 1
  return { ...out, counts, errors }
}

const fails = []
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
const plain = await run(null)
const fr = await run('fr')
const frSlowParser = await run('fr', LAT * 5)
const es = await run('es', LAT * 5)
const storeFr = await run('fr', 0, 'storeFr')
const dataOnly = await run(null, 0, 'dataOnly')
await browser.close(); server.close()

// Discovery gates the stored locale's switch: one round after the first CSV request, not one per CSV
const firstCsv = (r) => Math.min(...r.res.map(x => x.s))
check(fr.lc - firstCsv(fr) < LAT * 2, 'stored locale applies within two round trips of the first CSV request', { firstCsv: firstCsv(fr), localechange: fr.lc })
check(Object.values(plain.counts).every(c => c === 1) && Object.keys(plain.counts).length === 3, 'default locale: each CSV downloaded once', plain.counts)
check(Object.values(fr.counts).every(c => c === 1) && Object.keys(fr.counts).length === 3, 'stored locale: each CSV downloaded once', fr.counts)
check(JSON.stringify(plain.values) === JSON.stringify({ s: 'Hello', l: 'Title', t: '', si: 'Site', av: 'de,en,fr,es', cur: 'en' }), 'default locale: resolved values unchanged', plain.values)
check(JSON.stringify(fr.values) === JSON.stringify({ s: 'Bonjour', l: 'Title', t: '', si: 'Le site', av: 'de,en,fr,es', cur: 'fr' }), 'stored locale: resolved values unchanged', fr.values)
check(frSlowParser.values.s === 'Bonjour' && frSlowParser.values.si === 'Le site', 'stored locale, slow CSV parser: the boot load of the old locale never lands over the new one', frSlowParser.values)
check(es.values.l === 'Titulo', 'stored locale, bare localized CSV: the old locale never lands over the new one', es.values)
// Master's values: a store/<html lang> mismatch without a localechange never leaves a source empty
check(storeFr.values.s === 'Hello' && storeFr.values.si === 'Site', 'author-set locale store: sources still land', storeFr.values)
check(dataOnly.values.s === 'Hello', 'data module only, author-set locale store: sources still land', dataOnly.values)
const all = [plain, fr, frSlowParser, es, storeFr]
check(all.every(r => r.errors.length === 0), 'no page errors', all.flatMap(r => r.errors))
console.log(JSON.stringify({ latency: LAT, ready: [plain.ready, fr.ready], localechangeAfterFirstCsv: fr.lc - firstCsv(fr), csvRequests: [Object.values(plain.counts).reduce((a, b) => a + b, 0), Object.values(fr.counts).reduce((a, b) => a + b, 0)], plain: plain.res, fr: fr.res }))
if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 } else console.log('\nall passed')
