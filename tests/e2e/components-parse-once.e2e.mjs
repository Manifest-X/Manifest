/**
 * Components cloned from one parse (real Chrome): many instances of one component render with
 * their own props and Alpine state, nested components and x-for templates work, page custom
 * elements in component markup construct per instance as before (detached, before props resolve),
 * ?v= stamping is kept. Prints the time from boot to manifest:components-processed.
 *
 * Run: npm run build && node tests/e2e/components-parse-once.e2e.mjs
 * COMP_SRC=<dir> serves another src/ (e.g. the old tree, to compare); COMP_N sets the instance count.
 */
import http from 'http'
import path from 'path'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = process.env.COMP_SRC || path.join(root, 'src')
const N = Number(process.env.COMP_N || 300)
const RUNS = Number(process.env.COMP_RUNS || 5)
const ALPINE = path.join(root, 'node_modules/alpinejs/dist/cdn.min.js')

const rows = Array.from({ length: N }, (_, i) => `<x-card label="L${i}" class="i${i}"></x-card>`).join('\n')
const INDEX = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>c</title>
<link rel="manifest" href="/manifest.json">
<script>
customElements.define('probe-el', class extends HTMLElement {
  constructor() { super(); (window.__probes ||= []).push({ connected: this.isConnected, tone: this.getAttribute(':tone') }) }
})
</script>
<script src="/scripts/manifest.js" data-module-base="/scripts" data-modules="components" data-alpine="/__alpine.js"></script>
</head><body x-data>
${rows}
</body></html>`
const FILES = {
  '/manifest.json': JSON.stringify({ name: 'c', version: '7', components: ['components/card.html', 'components/badge.html'] }),
  '/components/card.html': `<article class="card" x-data="{ open: false, items: [1, 2] }" :data-label="$modify('label')">
  <h3 x-text="$modify('label')"></h3>
  <probe-el :tone="$modify('label')" tone="static"></probe-el>
  <ul><template x-for="n in items"><li class="n" x-text="n"></li></template></ul>
  <x-badge></x-badge>
  <button @click="open = !open" x-text="open ? 'on' : 'off'"></button>
</article>`,
  '/components/badge.html': '<span class="badge">b</span>',
}
const requests = []
const server = await new Promise(r => { const s = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); requests.push(u.pathname + u.search)
  if (u.pathname === '/__alpine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(ALPINE)) }
  if (FILES[u.pathname]) { res.writeHead(200, { 'content-type': u.pathname.endsWith('.json') ? 'application/json' : 'text/html' }); return res.end(FILES[u.pathname]) }
  if (u.pathname.startsWith('/scripts/')) { const f = path.join(src, u.pathname); if (!existsSync(f)) { res.writeHead(404); return res.end() } res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(f)) }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(INDEX) }
  res.writeHead(404); res.end() }); s.listen(0, '127.0.0.1', () => r(s)) })
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
const runs = []
for (let i = 0; i < RUNS; i++) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage()
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.evaluateOnNewDocument(() => { window.addEventListener('manifest:components-processed', () => { if (!window.__done) window.__done = Math.round(performance.now()) }) })
  await p.goto(`http://127.0.0.1:${server.address().port}/`)
  await p.waitForFunction(() => window.__done && document.querySelectorAll('.badge').length > 0, { timeout: 20000 }).catch(() => {})
  await new Promise(r => setTimeout(r, 300))
  await p.click('.i3 button')
  await new Promise(r => setTimeout(r, 50))
  const out = await p.evaluate((N) => {
    const cards = [...document.querySelectorAll('article.card')]
    const card = (i) => document.querySelector('.i' + i)
    const cardEnd = performance.getEntriesByType('resource').find(e => e.name.includes('/components/card.html'))?.responseEnd
    return {
      cards: cards.length, badges: document.querySelectorAll('.card .badge').length, placeholders: document.querySelectorAll('x-card, x-badge').length,
      labels: [0, 1, N - 1].map(i => card(i)?.querySelector('h3')?.textContent),
      dataLabel: card(5)?.getAttribute('data-label'),
      ids: [0, 1].map(i => card(i)?.getAttribute('data-component')),
      lis: card(2)?.querySelectorAll('li.n').length,
      toggled: [card(3)?.querySelector('button').textContent, card(4)?.querySelector('button').textContent],
      probes: window.__probes?.length, probesDetached: (window.__probes || []).every(x => !x.connected), probesRaw: (window.__probes || []).every(x => x.tone === "$modify('label')"),
      done: window.__done, afterCard: Math.round(window.__done - cardEnd)
    }
  }, N)
  runs.push({ ...out, errors }); await ctx.close()
}
await browser.close(); server.close()
const fails = []
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
const r = runs[0]
check(runs.every(x => x.cards === N && x.badges === N && x.placeholders === 0), 'every instance and nested component renders', runs.map(x => [x.cards, x.badges, x.placeholders]))
check(JSON.stringify(r.labels) === JSON.stringify(['L0', 'L1', `L${N - 1}`]) && r.dataLabel === 'L5', 'each instance has its own props', [r.labels, r.dataLabel])
check(JSON.stringify(r.ids) === JSON.stringify(['card-1', 'card-2']), 'instance ids are assigned in document order', r.ids)
check(r.lis === 2, 'x-for inside component markup renders', r.lis)
check(JSON.stringify(r.toggled) === JSON.stringify(['on', 'off']), 'each instance has its own Alpine state', r.toggled)
// As with per-instance parsing: constructed per instance while detached, before props resolve (plus one for the parsed source)
check(runs.every(x => x.probes >= N && x.probes <= N + 1 && x.probesDetached && x.probesRaw), 'custom elements in component markup construct per instance, detached, before props resolve', runs.map(x => [x.probes, x.probesDetached, x.probesRaw]))
check(requests.filter(q => q.startsWith('/components/card.html')).every(q => q === '/components/card.html?v=7'), 'component requests keep the ?v= stamp', [...new Set(requests.filter(q => q.startsWith('/components/')))])
check(runs.every(x => x.errors.length === 0), 'no page errors', runs.flatMap(x => x.errors))
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
console.log(JSON.stringify({ instances: N, componentsProcessedMs: runs.map(x => x.done), medianProcessed: med(runs.map(x => x.done)), cardResponseToProcessed: runs.map(x => x.afterCard), medianCardToProcessed: med(runs.map(x => x.afterCard)) }))
if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 } else console.log('\nall passed')
