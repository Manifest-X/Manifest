/**
 * x-defer.priority in real Chromium: authored priorities prewarm before unprioritized containers, lower n first.
 *
 * Run: node tests/e2e/defer-priority.e2e.mjs
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const menu = (id, attr = '') => `<menu popover ${attr} id="${id}"><li x-init="window.__order.push('${id}')">${id}</li></menu>`
const page = `<!doctype html><html><head>
<script>window.__order = []</script>
<script src="/src/scripts/manifest.defer.js"></script>
<script defer src="/node_modules/alpinejs/dist/cdn.min.js"></script>
<script>document.addEventListener('alpine:initialized', () => setTimeout(() => window.dispatchEvent(new CustomEvent('manifest:ready')), 50))</script>
</head><body x-data>
${menu('plain-a')}
${menu('p2', 'x-defer.priority="2"')}
${menu('plain-b')}
${menu('p1', 'x-defer.priority="1"')}
${menu('first', 'x-defer.priority="-1"')}
</body></html>`

const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page) }
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]))
    if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end() }
    fs.readFile(file, (err, body) => {
        if (err) { res.statusCode = 404; return res.end() }
        res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(body)
    })
}).listen(0)
const base = `http://localhost:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const tab = await browser.newPage()
    await tab.goto(`${base}/`, { waitUntil: 'load' })
    await tab.waitForFunction(() => window.__order.length === 5, { timeout: 15000 }).catch(() => { })
    const order = await tab.evaluate(() => window.__order)
    check('authored priorities prewarm first, lower n first, then document order', JSON.stringify(order) === JSON.stringify(['first', 'p1', 'p2', 'plain-a', 'plain-b']), order)
} finally {
    await browser.close()
    server.close()
}
if (failures.length) { console.log(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nall passed')
