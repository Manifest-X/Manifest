/**
 * Loader Subresource Integrity in real Chromium, against two local cross-origin CDN mirrors.
 *
 *   pinned + integrity     → every injected tag carries integrity + crossorigin; page boots
 *   one mirror tampered    → loud error naming the file, next mirror's verified copy runs
 *   every mirror tampered  → loud error naming the file; the tampered body never runs
 *   module map tampered    → fails closed, nothing injected
 *   @latest, no integrity  → unchanged behaviour, no integrity attributes
 *   integrity + data-version="latest" → warns, loads unverified
 *
 * Run: npm run build && node tests/e2e/loader-sri.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const ALPINE = fs.readFileSync(path.join(ROOT, 'src/scripts/manifest.js'), 'utf8').match(/const DEFAULT_ALPINE_VERSION = '([^']+)'/)[1]
const sri = (buf) => `sha384-${createHash('sha384').update(buf).digest('base64')}`
const LOADER_SRI = sri(fs.readFileSync(path.join(ROOT, 'lib/manifest.min.js')))

// A CDN mirror: jsDelivr-style /npm/<pkg>@<v>/<path>, CORS on, optional tampered files
function mirror() {
    const tampered = new Set()
    const server = http.createServer((req, res) => {
        const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        let file = null
        let m = p.match(/^\/npm\/mnfst@[^/]+\/lib\/([\w.-]+)$/)
        if (m) file = path.join(ROOT, 'lib', m[1])
        m = p.match(/^\/npm\/alpinejs@([^/]+)\/dist\/cdn\.min\.js$/)
        if (m && m[1] === ALPINE) file = path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js')
        const cors = { 'Access-Control-Allow-Origin': '*' }
        if (!file || !fs.existsSync(file)) { res.writeHead(404, cors); return res.end() }
        let body = fs.readFileSync(file)
        const name = path.basename(file)
        if (tampered.has(name)) body = Buffer.concat([body, Buffer.from(name.endsWith('.json') ? '' : '\n;window.__tampered = (window.__tampered || []).concat(' + JSON.stringify(name) + ');')])
        if (tampered.has(name) && name.endsWith('.json')) body = Buffer.from(body.toString().replace(/sha384-[A-Za-z0-9+/]/, 'sha384-X'))
        res.writeHead(200, { ...cors, 'Content-Type': name.endsWith('.json') ? 'application/json' : 'text/javascript', 'Cache-Control': 'no-store' })
        res.end(body)
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
        base: `http://127.0.0.1:${server.address().port}/npm`,
        tampered,
        close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) })
    })))
}

let pages = {}
function site() {
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p === '/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"name":"x"}') }
        if (!pages[p]) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        res.end(pages[p])
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
        url: (p) => `http://localhost:${server.address().port}${p}`,
        close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) })
    })))
}

const page = (loaderAttrs, plugins = 'data-plugins="toasts,tooltips"') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<script ${loaderAttrs} ${plugins} data-tailwind></script></head>
<body><div x-data="{ m: 'booted' }"><span id="t" x-text="m"></span></div></body></html>`

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function visit(browser, url) {
    const ctx = await browser.createBrowserContext()
    const tab = await ctx.newPage()
    const logs = []
    tab.on('console', (m) => { if (!(m.location()?.url || '').endsWith('/favicon.ico')) logs.push({ type: m.type(), text: m.text() }) })
    tab.on('pageerror', (e) => logs.push({ type: 'pageerror', text: String(e) }))
    await tab.goto(url, { waitUntil: 'load' })
    await tab.waitForFunction(() => document.getElementById('t').textContent === 'booted', { timeout: 8000 }).catch(() => { })
    await new Promise((r) => setTimeout(r, 400))
    const state = await tab.evaluate(() => ({
        booted: document.getElementById('t').textContent === 'booted',
        tampered: window.__tampered || [],
        tags: [...document.querySelectorAll('script[data-mnfst-loaded], script[data-mnfst-loading]')].map((s) => ({ src: s.src, integrity: s.getAttribute('integrity'), crossorigin: s.getAttribute('crossorigin') })),
        toasts: !!(window.Alpine && window.Alpine.magic && document.querySelector('script[src*="manifest.toasts"]')),
    }))
    await ctx.close()
    return { ...state, logs, errors: logs.filter((l) => l.type === 'error').map((l) => l.text) }
}

async function main() {
    const a = await mirror(), b = await mirror(), s = await site()
    const cdn = `data-cdn="${a.base},${b.base}"`
    const pinned = `src="${a.base}/mnfst@${VERSION}/lib/manifest.min.js" integrity="${LOADER_SRI}" crossorigin="anonymous" ${cdn}`
    pages = {
        '/pinned': page(pinned),
        '/latest': page(`src="${a.base}/mnfst@latest/lib/manifest.min.js" ${cdn}`),
        '/pinned-latest-modules': page(`${pinned} data-version="latest"`),
        '/pinned-defaults': page(pinned, ''),
    }
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        let r = await visit(browser, s.url('/pinned'))
        const names = r.tags.map((t) => t.src.split('/').pop()).sort()
        check('pinned: page boots', r.booted)
        check('pinned: modules, Tailwind and Alpine injected', ['cdn.min.js', 'manifest.bindings.min.js', 'manifest.defer.min.js', 'manifest.tailwind.min.js', 'manifest.toasts.min.js', 'manifest.tooltips.min.js'].every((n) => names.includes(n)), names.join(', '))
        check('pinned: every injected tag has integrity + crossorigin=anonymous', r.tags.length >= 6 && r.tags.every((t) => /^sha384-/.test(t.integrity) && t.crossorigin === 'anonymous'), JSON.stringify(r.tags.filter((t) => !t.integrity)))
        check('pinned: no console errors', r.errors.length === 0, r.errors.join(' | '))

        r = await visit(browser, s.url('/pinned-defaults'))
        check('pinned, default module set (all shipped .min.js): boots verified with no errors', r.booted && r.tags.length >= 20 && r.tags.every((t) => t.integrity) && r.errors.length === 0, `${r.tags.length} tags; ${r.errors.join(' | ')}`)

        a.tampered.add('manifest.toasts.min.js')
        r = await visit(browser, s.url('/pinned'))
        check('one mirror tampered: page boots from the next mirror', r.booted && r.tags.some((t) => t.src.startsWith(b.base) && t.src.endsWith('manifest.toasts.min.js')))
        check('one mirror tampered: tampered body never runs', r.tampered.length === 0, r.tampered.join(','))
        check('one mirror tampered: loud error naming the file', r.errors.some((e) => e.includes('[Manifest Loader] manifest.toasts.min.js failed its integrity check')), r.errors.join(' | '))

        b.tampered.add('manifest.toasts.min.js')
        r = await visit(browser, s.url('/pinned'))
        check('every mirror tampered: tampered body never runs', r.tampered.length === 0, r.tampered.join(','))
        check('every mirror tampered: error says the file was not loaded', r.errors.some((e) => e.includes('manifest.toasts.min.js did not match its integrity hash on any CDN — not loaded')), r.errors.join(' | '))
        check('every mirror tampered: the rest of the page still boots', r.booted)
        a.tampered.clear(); b.tampered.clear()

        a.tampered.add('manifest.modules.integrity.json'); b.tampered.add('manifest.modules.integrity.json')
        r = await visit(browser, s.url('/pinned'))
        check('module map tampered: fails closed, nothing injected', r.tags.length === 0 && !r.booted, `${r.tags.length} tags`)
        check('module map tampered: loud error', r.errors.some((e) => e.includes('manifest.modules.integrity.json could not be verified')), r.errors.join(' | '))
        a.tampered.clear(); b.tampered.clear()

        r = await visit(browser, s.url('/latest'))
        check('@latest without integrity: boots as before', r.booted)
        check('@latest without integrity: no integrity attributes, modules at @latest', r.tags.every((t) => !t.integrity && !t.crossorigin) && r.tags.filter((t) => t.src.includes('/mnfst@')).every((t) => t.src.includes('/mnfst@latest/')))

        r = await visit(browser, s.url('/pinned-latest-modules'))
        check('integrity + data-version="latest": warns', r.logs.some((l) => (l.type === 'warning' || l.type === 'warn') && l.text.includes(`set data-version="${VERSION}"`)))
        check('integrity + data-version="latest": loads unverified and boots', r.booted && r.tags.every((t) => !t.integrity))
    } finally {
        await browser.close()
        await Promise.all([a.close(), b.close(), s.close()])
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
