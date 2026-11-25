/**
 * Real-Chrome guard for x-virtual on a large list:
 * 1. first load never renders the whole list (Alpine queues the template's x-for before
 *    x-virtual runs unless it is taken off as the container is visited);
 * 2. rows follow the source: push, removal, in-place sort/reverse, a replaced array, a filter,
 *    for both `row in items` and `(row, i) in items`;
 * 3. a source change does not read every item through the reactive proxy.
 *
 * Run: node tests/e2e/virtual-boot.e2e.mjs      (VIRTUAL_SRC=<dir with scripts/> to A/B)
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
const N = 5000

const page = (forExpr, key) => `<!doctype html><html><head><meta charset="utf-8">
<script>
// Peak row count from the first node on, and every row ever created
window.__peak = 0; window.__created = 0
new MutationObserver((records) => {
  for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList && n.classList.contains('r')) window.__created++
  const now = document.getElementsByClassName('r').length
  if (now > window.__peak) window.__peak = now
}).observe(document, { childList: true, subtree: true })
</script>
<script src="/scripts/manifest.virtual.js"></script><script defer src="/__alpine.js"></script></head><body>
<div id="app" x-data="{ items: Array.from({ length: ${N} }, (_, k) => ({ id: k, name: 'n' + k })) }">
  <div id="v" x-virtual="{ estimate: 24 }" style="height:300px;overflow:auto">
    <template x-for="${forExpr}" :key="${key}"><div class="r" style="height:24px" x-text="${forExpr.includes(',') ? "row.name + '#' + i" : 'row.name'}"></div></template>
  </div>
</div>
<script>document.addEventListener('alpine:initialized', () => { window.__atInit = document.getElementsByClassName('r').length })</script>
</body></html>`

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            if (u.pathname === '/__alpine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(ALPINE)) }
            if (u.pathname === '/scripts/manifest.virtual.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(path.join(SRC, 'scripts/manifest.virtual.js'))) }
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(u.pathname === '/tuple' ? page('(row, i) in items', 'row.id') : page('row in items', 'row.id'))
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const texts = (p) => p.evaluate(() => [...document.querySelectorAll('#v .r')].map((n) => n.textContent))
const items = (p, fn) => p.evaluate(fn)

async function main() {
    const server = await serve()
    const base = `http://127.0.0.1:${server.address().port}`
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
    const fails = []
    const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
    try {
        for (const route of ['/plain', '/tuple']) {
            const tuple = route === '/tuple'
            const label = (name, i) => (tuple ? `${name}#${i}` : name)
            const p = await browser.newPage()
            const errors = []
            p.on('pageerror', (e) => errors.push(e.message))
            await p.goto(base + route, { waitUntil: 'load' })
            await wait(600)
            const boot = await p.evaluate(() => ({ atInit: window.__atInit, peak: window.__peak, created: window.__created, now: document.getElementsByClassName('r').length }))
            check(boot.peak < 100 && boot.created < 100, `${route}: first load renders only the window, never the whole list`, boot)
            check((await texts(p))[0] === label('n0', 0), `${route}: first row is the first item`, (await texts(p)).slice(0, 2))

            await p.evaluate(() => { document.getElementById('v').scrollTop = 24 * 2500 })
            await wait(300)
            const mid = await texts(p)
            check(mid.includes(label('n2500', 2500)), `${route}: scrolled to the middle`, mid.slice(0, 3))
            await p.evaluate(() => { document.getElementById('v').scrollTop = 0 })
            await wait(300)

            const data = 'Alpine.$data(document.getElementById("app"))'
            await p.evaluate(`${data}.items.unshift({ id: 'new', name: 'new' })`)
            await wait(300)
            check((await texts(p))[0] === label('new', 0) && (await texts(p))[1] === label('n0', 1), `${route}: an item added at the front shows, and indexes shift`, (await texts(p)).slice(0, 2))

            await p.evaluate(`${data}.items.splice(0, 2)`)
            await wait(300)
            check((await texts(p))[0] === label('n1', 0), `${route}: removed items leave`, (await texts(p)).slice(0, 2))

            await p.evaluate(`${data}.items.reverse()`)
            await wait(300)
            check((await texts(p))[0] === label('n4999', 0), `${route}: an in-place reverse is followed`, (await texts(p)).slice(0, 2))

            await p.evaluate(`${data}.items.sort((a, b) => a.id - b.id)`)
            await wait(300)
            check((await texts(p))[0] === label('n1', 0), `${route}: an in-place sort is followed`, (await texts(p)).slice(0, 2))

            await p.evaluate(`${data}.items[0] = { id: 'swap', name: 'swap' }`)
            await wait(300)
            check((await texts(p))[0] === label('swap', 0), `${route}: an item replaced in place is followed`, (await texts(p)).slice(0, 2))

            await p.evaluate(`${data}.items[1].name = 'edited'`)
            await wait(300)
            check((await texts(p))[1] === label('edited', 1), `${route}: a field edit on a visible row shows`, (await texts(p)).slice(0, 2))

            await p.evaluate(`${data}.items = ${data}.items.filter(r => typeof r.id === 'number' && r.id % 1000 === 0)`)
            await wait(300)
            check(JSON.stringify(await texts(p)) === JSON.stringify(['n1000', 'n2000', 'n3000', 'n4000'].map(label)), `${route}: a replaced (filtered) array renders exactly its rows`, await texts(p))

            await p.evaluate(`${data}.items = []`)
            await wait(300)
            check((await texts(p)).length === 0, `${route}: an emptied list renders nothing`)
            check(errors.length === 0, `${route}: no page errors`, errors)
            await p.close()
        }

        // 3. One source change on a large list: proxy index reads stay bounded by the window
        const p = await browser.newPage()
        await p.goto(base + '/plain', { waitUntil: 'load' })
        await wait(600)
        const reads = await p.evaluate(async () => {
            const data = Alpine.$data(document.getElementById('app'))
            const raw = Alpine.raw(data.items)
            let count = 0
            const original = Reflect.get
            Reflect.get = function (target, key, receiver) { if (target === raw && typeof key === 'string' && key !== 'length' && String(+key) === key) count++; return original.apply(this, arguments) }
            data.items.push({ id: 'tail', name: 'tail' })
            await new Promise((r) => setTimeout(r, 200))
            Reflect.get = original
            return count
        })
        check(reads < 200, 'a source change reads only the window through the proxy', { proxyIndexReads: reads, items: N })
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 }
    else console.log('\nall passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
