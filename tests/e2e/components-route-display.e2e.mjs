/**
 * A routed component placeholder hidden by the router, then swapped in after
 * client-side navigation, shows: the router's inline display:none travels to
 * the component root along with its hide record.
 *
 * Run: npm run build && node tests/e2e/components-route-display.e2e.mjs
 * FW_DIR=<dir> serves another build's lib (e.g. the old one, to see it fail).
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FW = process.env.FW_DIR ? path.resolve(process.env.FW_DIR) : path.join(ROOT, 'lib')
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.min.js')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const COMPONENTS = {
    nav: '<nav><a id="to-home" href="/">Home</a> <a id="to-docs" href="/docs">Docs</a> <a id="to-guide" href="/guide">Guide</a></nav>',
    home: '<section><h1 id="home-h">Home</h1></section>',
    docs: '<section class="docs"><h1 id="docs-h">Docs</h1></section>',
    guide: '<div><h1 id="guide-a">Guide A</h1></div><div><h1 id="guide-b">Guide B</h1></div>'
}
const MANIFEST = { name: 'x', components: ['components/nav.html', 'components/home.html', 'components/docs.html', 'components/guide.html'] }

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="manifest" href="/manifest.json">
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="components,router" data-alpine="/alpine.js"></script></head>
<body x-data>
  <x-nav></x-nav>
  <main>
    <x-home x-route="/"></x-home>
    <x-docs x-route="=docs"></x-docs>
    <x-guide x-route="guide"></x-guide>
  </main>
</body></html>`

function serve() {
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p === '/alpine.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(ALPINE)) }
        if (p === '/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(MANIFEST)) }
        const comp = p.match(/^\/components\/(\w+)\.html$/)
        if (comp && COMPONENTS[comp[1]]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(COMPONENTS[comp[1]]) }
        if (p.startsWith('/fw/')) {
            const file = path.join(FW, p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(file))
        }
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE)
    })
    return new Promise((r) => server.listen(0, () => r(server)))
}

const visible = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s)
    return !!el && el.getClientRects().length > 0
}, sel)

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }

const server = await serve()
const base = `http://localhost:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const page = await browser.newPage()
    await page.goto(base + '/', { waitUntil: 'networkidle0' })
    await wait(500)
    check('home shows on load', await visible(page, '#home-h'))

    await page.click('#to-docs'); await wait(1500)
    check('docs shows after navigating from home', await visible(page, '#docs-h'))
    check('home hides', !(await visible(page, '#home-h')))

    await page.click('#to-guide'); await wait(1500)
    check('every root of a multi-root component shows', (await visible(page, '#guide-a')) && (await visible(page, '#guide-b')))
    check('docs hides again', !(await visible(page, '#docs-h')))

    await page.click('#to-home'); await wait(1000)
    check('home shows again', await visible(page, '#home-h'))

    await page.click('#to-docs'); await wait(1000)
    check('docs shows on a second visit', await visible(page, '#docs-h'))
} finally {
    await browser.close(); server.close()
}
if (failed) { console.error(`${failed} failed`); process.exit(1) }
console.log('all passed')
