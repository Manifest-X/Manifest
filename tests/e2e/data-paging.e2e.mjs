/**
 * Paged sources and optimistic writes in real Chromium, against the built lib and
 * a mock Appwrite SDK: x-virtual's `virtual-end` drives $more() while scrolling,
 * live rows past the loaded range wait for their page, and an unsettled write
 * holds through a reload with $saving / $pending.
 *
 * Run: node tests/e2e/data-paging.e2e.mjs   (after npm run build)
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const MANIFEST = JSON.stringify({
    appwrite: { projectId: 'mock', endpoint: 'http://localhost/v1', databaseId: 'main' },
    data: { paged: { appwriteTableId: 'items', queries: [['orderAsc', 'n']], paging: { mode: 'window', size: 50 } } }
})
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script src="/mock-appwrite.js"></script>
<script src="/lib/manifest.js" data-plugin-base="/lib/" data-plugins="data,appwrite-data,virtual"></script>
</head><body><div x-data>
<p>held <b id="held" x-text="$x.paged.length"></b> more <b id="more" x-text="$x.paged.$hasMore"></b> total <b id="total" x-text="$x.paged.$total"></b> pending <b id="pending" x-text="$x.paged.$pending"></b></p>
<div id="scroller" x-virtual style="height:300px;overflow:auto" @virtual-end="$x.paged.$more()">
<template x-for="r in $x.paged" :key="r.$id"><div style="height:24px" x-text="r.name + ($x.paged.$saving(r.$id) ? ' (saving)' : '')"></div></template>
</div></div></body></html>`

const types = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/manifest.json') { res.setHeader('content-type', 'application/json'); return res.end(MANIFEST) }
    if (u.pathname === '/mock-appwrite.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(path.join(ROOT, 'tests/e2e/fixtures/mock-appwrite.js'))) }
    if (u.pathname.startsWith('/lib/')) {
        const p = path.join(ROOT, u.pathname)
        if (!fs.existsSync(p)) { res.statusCode = 404; return res.end() }
        res.setHeader('content-type', types[path.extname(p)] || 'text/plain')
        return res.end(fs.readFileSync(p))
    }
    res.setHeader('content-type', 'text/html')
    res.end(PAGE)
})
await new Promise(r => server.listen(0, r))
const base = `http://localhost:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const page = await browser.newPage()
    page.on('pageerror', e => check('no page errors', false, e.message))
    await page.goto(`${base}/?rows=5000`)
    await page.waitForFunction(() => document.getElementById('held')?.textContent === '50', { timeout: 10000 })
    const text = (id) => page.$eval(`#${id}`, el => el.textContent)
    check('first window: 50 of 5000, more to come', (await text('total')) === '5000' && (await text('more')) === 'true')

    // Scroll with the wheel: each end-of-list render asks for the next page
    await page.hover('#scroller')
    for (let i = 0; i < 40 && Number(await text('held')) < 200; i++) {
        await page.mouse.wheel({ deltaY: 4000 })
        await new Promise(r => setTimeout(r, 150))
    }
    const held = Number(await text('held'))
    check('scrolling to the end pages in more rows', held >= 200, held)
    const ordered = await page.evaluate(() => {
        const rows = Alpine.evaluate(document.body.firstElementChild, '$x.paged')
        return rows.every((r, i) => r.n === i + 1) && new Set(rows.map(r => r.$id)).size === rows.length
    })
    check('paged rows are in order with no repeats', ordered)
    const lastShown = await page.evaluate(() => [...document.getElementById('scroller').children].map(d => d.textContent).filter(Boolean).at(-1))
    check('the list renders the newly paged rows', /Row (1[5-9]\d|[2-9]\d\d)/.test(lastShown || ''), lastShown)

    // Live rows: inside the loaded range land at their place; past it, they wait for their page
    const live = await page.evaluate(async () => {
        const add = (row) => { __rows.push(row); __emit('create', row) }
        add({ $id: 'liveIn', name: 'Live inside', n: 3.5, status: 'active' })
        add({ $id: 'livePast', name: 'Live past', n: 4999.5, status: 'active' })
        await new Promise(r => setTimeout(r, 300))
        const rows = Alpine.evaluate(document.body.firstElementChild, '$x.paged')
        return { inside: rows.findIndex(r => r.$id === 'liveIn'), past: rows.some(r => r.$id === 'livePast') }
    })
    check('a live row inside the range lands in order', live.inside === 3, live)
    check('a live row past the range waits for $more()', live.past === false, live)

    // Optimistic write holds through a reload until the server answers
    const opt = await page.evaluate(async () => {
        const ev = (e) => Alpine.evaluate(document.body.firstElementChild, e)
        window.__delay = (op) => op === 'update' ? 600 : 20
        const id = ev('$x.paged[0].$id')
        const write = ev('$x.paged').$update(id, { name: 'Optimistic' })
        await new Promise(r => setTimeout(r, 50))
        await window.ManifestDataMain.reloadDataSource('paged')
        await new Promise(r => setTimeout(r, 50))
        const during = { name: ev('$x.paged[0].name'), saving: ev(`$x.paged.$saving('${id}')`), pending: document.getElementById('pending').textContent }
        await write
        await new Promise(r => setTimeout(r, 100))
        return { during, after: { name: ev('$x.paged[0].name'), saving: ev(`$x.paged.$saving('${id}')`), pending: document.getElementById('pending').textContent } }
    })
    check('an unsettled write holds through a reload', opt.during.name === 'Optimistic' && opt.during.saving === true && opt.during.pending === '1', opt.during)
    check('settled: server value stands, nothing pending', opt.after.name === 'Optimistic' && opt.after.saving === false && opt.after.pending === '0', opt.after)

    // A $query replaces the list: scrolling to its end pages again (virtual-end fires anew)
    await page.evaluate(async () => {
        window.__delay = () => 20
        await Alpine.evaluate(document.body.firstElementChild, '$x.paged').$query([['equal', 'status', 'archived'], ['orderAsc', 'n']])
    })
    await page.waitForFunction(() => document.getElementById('held')?.textContent === '50', { timeout: 5000 })
    await page.evaluate(() => { document.getElementById('scroller').scrollTop = 0 })
    await page.hover('#scroller')
    for (let i = 0; i < 40 && Number(await text('held')) <= 50; i++) {
        await page.mouse.wheel({ deltaY: 4000 })
        await new Promise(r => setTimeout(r, 150))
    }
    const afterQuery = await page.evaluate(() => {
        const rows = Alpine.evaluate(document.body.firstElementChild, '$x.paged')
        return { held: rows.length, allArchived: rows.every(r => r.status === 'archived') }
    })
    check('after a $query, scrolling to the end pages within the new filter', afterQuery.held > 50 && afterQuery.allArchived, afterQuery)

    // F3: one array per landing; F5: $reload() retries a flaky read
    const f35 = await page.evaluate(async () => {
        const ev = (e) => Alpine.evaluate(document.body.firstElementChild, e)
        const same = ev('$x.paged') === ev('$x.paged')
        const before = ev('$x.paged')
        window.__failReads = 2
        await ev('$x.paged').$reload()
        await new Promise(r => setTimeout(r, 100))
        return { same, changed: ev('$x.paged') !== before, failed: __calls.filter(c => c.op === 'list:fail').length, error: ev('$x.paged.$error'), held: ev('$x.paged.length') }
    })
    check('$x.<source> keeps its identity between landings', f35.same, f35)
    check('$reload() retries transient failures and lands without $error', f35.failed === 2 && f35.error === null && f35.held >= 50 && f35.changed, f35)
} finally {
    await browser.close()
    server.close()
}
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1) }
console.log('\nall passed')
