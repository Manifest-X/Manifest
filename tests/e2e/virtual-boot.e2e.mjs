/**
 * Real-Chrome guard for x-virtual on a large list:
 * 1. first load never renders the whole list (Alpine queues the template's x-for before
 *    x-virtual runs unless it is taken off as the container is visited);
 * 2. rows follow the source: push, removal, in-place sort/reverse, a replaced array, a filter,
 *    for both `row in items` and `(row, i) in items`;
 * 3. a source change does not read every item through the reactive proxy;
 * 4. an x-for form x-virtual cannot run (destructuring) still renders through Alpine's own x-for;
 * 5. an iterator source renders; rows whose items left the list go even while the container is hidden;
 *    a masonry `height` function re-packs when an item's field changes;
 * 6. the virtualized template: a <thead> x-for before the rows is left to Alpine, a template marked
 *    data-virtual wins, and with neither the first x-for is still the one virtualized, with one warning
 *    naming the marker (none when a marker or the <thead> rule decided, or for a single template).
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

const peak = `<script>window.__peak = 0; new MutationObserver(() => { const n = document.getElementsByClassName('r').length; if (n > window.__peak) window.__peak = n }).observe(document, { childList: true, subtree: true })</script>`
const twoLists = (body) => `<!doctype html><html><head>${peak}<script src="/scripts/manifest.virtual.js"></script><script defer src="/__alpine.js"></script></head><body>
<div id="app" x-data="{ cols: ['a', 'b'], items: Array.from({ length: 2000 }, (_, k) => ({ id: k, name: 'n' + k })) }">${body}</div></body></html>`

const EXTRA = {
    '/thead': twoLists(`<div id="v" x-virtual="{ estimate: 24 }" style="height:300px;overflow:auto"><table>
  <thead><tr><template x-for="c in cols" :key="c"><th class="h" x-text="c"></th></template></tr></thead>
  <tbody><template x-for="row in items" :key="row.id"><tr class="r"><td style="height:24px" x-text="row.name"></td></tr></template></tbody></table></div>`),
    '/marked': twoLists(`<div id="v" x-virtual="{ estimate: 24 }" style="display:grid;grid-template-columns:1fr 1fr;height:300px;overflow:auto">
  <div style="display:contents"><template x-for="c in cols" :key="c"><div class="h" x-text="c"></div></template></div>
  <template data-virtual x-for="row in items" :key="row.id"><div class="r" style="display:contents"><div style="height:24px" x-text="row.name"></div><div>x</div></div></template></div>`),
    '/first': twoLists(`<div id="v" x-virtual="{ estimate: 24 }" style="height:300px;overflow:auto">
  <template x-for="row in items" :key="row.id"><div class="r" style="height:24px" x-text="row.name"></div></template>
  <div><template x-for="c in cols" :key="c"><span class="h" x-text="c"></span></template></div></div>`),
    '/destructure': `<!doctype html><html><head><script src="/scripts/manifest.virtual.js"></script><script defer src="/__alpine.js"></script></head><body>
<div id="app" x-data="{ items: Array.from({ length: 50 }, (_, k) => ({ id: k, name: 'n' + k })) }">
  <div id="v" x-virtual style="height:300px;overflow:auto"><template x-for="({ id, name }, i) in items" :key="id"><div class="r" x-text="name + '#' + i"></div></template></div>
</div></body></html>`,
    '/iterator': `<!doctype html><html><head><script src="/scripts/manifest.virtual.js"></script><script defer src="/__alpine.js"></script></head><body>
<div id="app" x-data="{ n: 40, *gen() { for (let k = 0; k < this.n; k++) yield { id: k, name: 'g' + k } } }">
  <div id="v" x-virtual="{ estimate: 24 }" style="height:300px;overflow:auto"><template x-for="row in gen()" :key="row.id"><div class="r" style="height:24px" x-text="row.name"></div></template></div>
</div></body></html>`,
    '/hidden': `<!doctype html><html><head><script src="/scripts/manifest.virtual.js"></script><script defer src="/__alpine.js"></script></head><body>
<div id="app" x-data="{ show: true, items: Array.from({ length: 2000 }, (_, k) => ({ id: k, name: 'n' + k })) }">
  <div id="v" x-show="show" x-virtual="{ estimate: 24 }" style="height:300px;overflow:auto"><template x-for="row in items" :key="row.id"><div class="r" style="height:24px" x-text="row.name"></div></template></div>
</div></body></html>`,
    '/masonry': `<!doctype html><html><head><script src="/scripts/manifest.virtual.js"></script><script defer src="/__alpine.js"></script></head><body>
<div id="app" x-data="{ items: Array.from({ length: 60 }, (_, k) => ({ id: k, name: 'n' + k, h: 40 })) }">
  <div id="v" x-virtual="{ mode: 'masonry', columns: 3, gap: 0, height: it => it.h }" style="height:300px;width:300px;overflow:auto;position:relative"><template x-for="row in items" :key="row.id"><div class="r" :style="'height:' + row.h + 'px'" x-text="row.name"></div></template></div>
</div></body></html>`,
}

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            if (u.pathname === '/__alpine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(ALPINE)) }
            if (u.pathname === '/scripts/manifest.virtual.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(path.join(SRC, 'scripts/manifest.virtual.js'))) }
            res.writeHead(200, { 'content-type': 'text/html' })
            if (EXTRA[u.pathname]) return res.end(EXTRA[u.pathname])
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
            const errors = [], warns = []
            p.on('pageerror', (e) => errors.push(e.message))
            p.on('console', (m) => { if (m.text().includes('data-virtual')) warns.push(m.text()) })
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
            check(warns.length === 0, `${route}: a single template gives no ambiguity warning`, warns)
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
        // Positive control: the counter does see proxy index reads
        const control = await p.evaluate(() => {
            const data = Alpine.$data(document.getElementById('app'))
            const raw = Alpine.raw(data.items)
            let count = 0
            const original = Reflect.get
            Reflect.get = function (target, key) { if (target === raw && typeof key === 'string' && String(+key) === key) count++; return original.apply(this, arguments) }
            for (let i = 0; i < 50; i++) void data.items[i]
            Reflect.get = original
            return count
        })
        check(control === 50, 'the proxy-read counter counts (control)', control)
        await p.close()

        // 4. A form x-virtual cannot run falls back to Alpine's own x-for
        {
            const q = await browser.newPage()
            const warnings = []
            q.on('console', (m) => { if (m.type() === 'warn' || m.type() === 'warning') warnings.push(m.text()) })
            await q.goto(base + '/destructure', { waitUntil: 'load' })
            await wait(500)
            const rows = await texts(q)
            check(rows.length === 50 && rows[0] === 'n0#0' && rows[49] === 'n49#49', '/destructure: a destructured x-for still renders (unvirtualized)', { rows: rows.length, first: rows[0] })
            check(warnings.some((w) => w.includes('could not parse')), '/destructure: and says why', warnings)
            check(await q.evaluate(() => !document.querySelector('template[data-virtual-for]')), '/destructure: the template keeps its x-for')
            await q.close()
        }

        // 5a. Iterator source
        {
            const q = await browser.newPage()
            await q.goto(base + '/iterator', { waitUntil: 'load' })
            await wait(500)
            const rows = await texts(q)
            check(rows.length > 5 && rows[0] === 'g0', '/iterator: a generator source renders', rows.slice(0, 3))
            await q.close()
        }

        // 5b. Hidden container: rows whose items left the list are removed
        {
            const q = await browser.newPage()
            await q.goto(base + '/hidden', { waitUntil: 'load' })
            await wait(500)
            const before = (await texts(q)).length
            await q.evaluate(() => { const d = Alpine.$data(document.getElementById('app')); d.show = false })
            await wait(200)
            await q.evaluate(() => { const d = Alpine.$data(document.getElementById('app')); d.items = d.items.slice(500) })
            await wait(300)
            const hidden = await texts(q)
            check(before > 5 && hidden.length === 0, '/hidden: no row is left bound to a removed item', { before, whileHidden: hidden.length })
            await q.evaluate(() => { Alpine.$data(document.getElementById('app')).show = true })
            await wait(400)
            check((await texts(q))[0] === 'n500', '/hidden: shown again, the window renders from the new list', (await texts(q)).slice(0, 2))
            await q.close()
        }

        // 5c. Masonry with an author height function re-packs on a field change
        {
            const q = await browser.newPage()
            await q.goto(base + '/masonry', { waitUntil: 'load' })
            await wait(500)
            const top = (name) => q.evaluate((name) => { const n = [...document.querySelectorAll('#v .r')].find((x) => x.textContent === name); return n ? n.style.top + '/' + n.style.left : null }, name)
            const start = await top('n3')
            await q.evaluate(() => { Alpine.$data(document.getElementById('app')).items[0].h = 300 })
            await wait(400)
            const after = await top('n3')
            check(start === '40px/0px' && after !== start, '/masonry: a changed item height re-packs the layout', { start, after })
            await q.close()
        }

        // 6. Which template is virtualized when the container holds two x-for lists
        for (const [route, label] of [['/thead', 'a <thead> x-for before the rows template'], ['/marked', 'the template marked data-virtual, after a header x-for'], ['/first', 'no marker: the first x-for, as before']]) {
            const q = await browser.newPage()
            const errors = [], warns = []
            q.on('pageerror', (e) => errors.push(e.message))
            q.on('console', (m) => { if ((m.type() === 'warn' || m.type() === 'warning') && m.text().includes('data-virtual')) warns.push(m.text()) })
            await q.goto(base + route, { waitUntil: 'load' })
            await wait(500)
            const got = await q.evaluate(() => ({ peak: window.__peak, rows: document.getElementsByClassName('r').length, head: [...document.querySelectorAll('#v .h')].map((n) => n.textContent).join(','), first: document.querySelector('#v .r')?.textContent }))
            check(got.peak < 100 && got.rows > 5 && got.first?.startsWith('n0') && got.head === 'a,b' && errors.length === 0, `${route}: ${label} — rows virtualized, the other list rendered by Alpine`, { ...got, errors })
            const expect = route === '/first' ? 1 : 0
            check(warns.length === expect, `${route}: ${expect ? 'one warning naming data-virtual (only order decided)' : 'no ambiguity warning'}`, warns)
            await q.close()
        }
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 }
    else console.log('\nall passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
