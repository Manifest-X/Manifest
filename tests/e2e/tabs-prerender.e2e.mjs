/**
 * Tabs after mnfst-render in real Chromium: prerendered tab sets show the first panel and switch on a real click,
 * matching the live (unrendered) page.
 *
 * Run: npm run build && node tests/e2e/tabs-prerender.e2e.mjs
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabs-prerender-'))
fs.symlinkSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'))
fs.copyFileSync(path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js'), path.join(dir, 'alpine.js'))
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'tabs', prerender: { wait: 300 } }))
fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>tabs</title>
<script src="/lib/manifest.js" data-plugins="tabs" data-plugin-base="/lib" data-alpine="/alpine.js"></script></head>
<body><main>
<section id="plain">
  <button x-tab="first">First</button><button x-tab="second">Second</button>
  <div x-tabpanel id="first">First content</div><div x-tabpanel id="second">Second content</div>
</section>
<section id="named" x-data="{ other: 1 }">
  <div role="tablist"><button x-tab="a">A</button><button x-tab="b">B</button></div>
  <div x-tabpanel="set-1" id="a">A content</div><div x-tabpanel="set-1" id="b">B content</div>
</section>
</main></body></html>`)

const r = spawnSync('node', [path.join(ROOT, 'packages/render/bin/mnfst-render.js')], { cwd: dir, encoding: 'utf8', timeout: 180_000 })
const out = path.join(dir, 'website')
if (r.status !== 0 || !fs.existsSync(path.join(out, 'index.html'))) {
    console.error('render failed', r.status, ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-20).join('\n'))
    process.exit(1)
}

const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    const file = url.startsWith('/lib/') ? path.join(ROOT, url) : path.join(out, url === '/' ? 'index.html' : url)
    fs.readFile(file, (err, body) => {
        if (err) { res.statusCode = 404; return res.end() }
        res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
        res.end(body)
    })
}).listen(0)
const base = `http://localhost:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const tab = await browser.newPage()
    const errors = []
    tab.on('pageerror', e => errors.push(e.message))
    tab.on('console', m => m.type() === 'error' && errors.push(m.text()))
    await tab.setRequestInterception(true)
    tab.on('request', q => q.url().startsWith(base) ? q.continue() : q.abort())
    await tab.goto(`${base}/`, { waitUntil: 'load' })
    await wait(2500)
    const shown = () => tab.evaluate(() => Object.fromEntries(['first', 'second', 'a', 'b'].map(id => [id, getComputedStyle(document.getElementById(id)).display !== 'none'])))
    const s0 = await shown()
    check('first panel of each set shows after hydration', s0.first && !s0.second && s0.a && !s0.b, s0)
    const click = async (sel) => {
        const box = await (await tab.$(sel)).boundingBox()
        await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await wait(300)
    }
    await click('#plain button:nth-of-type(2)')
    const s1 = await shown()
    check('clicking Second shows the second panel', !s1.first && s1.second, s1)
    await click('#named [role=tablist] button:nth-of-type(2)')
    const s2 = await shown()
    check('clicking B in a named set shows B', !s2.a && s2.b && s2.second, s2)
    const aria = await tab.evaluate(() => [...document.querySelectorAll('#named [role=tab]')].map(b => b.getAttribute('aria-selected')))
    check('no page errors', errors.length === 0, errors)
    check('tablist buttons keep their aria state', JSON.stringify(aria) === '["false","true"]', aria)
} finally {
    await browser.close()
    server.close()
    if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true }); else console.log(dir)
}
if (failures.length) { console.log(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nall passed')
