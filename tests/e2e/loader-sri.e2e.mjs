/**
 * Loader Subresource Integrity in real Chromium, against two local cross-origin CDN mirrors.
 *
 *   pinned + integrity     → every injected tag carries integrity + crossorigin; page boots
 *   one mirror tampered    → loud error naming the file, next mirror's verified copy runs
 *   every mirror tampered  → loud error naming the file; the tampered body never runs
 *   module map tampered    → fails closed, nothing injected
 *   @latest, no integrity  → unchanged behaviour, no integrity attributes
 *   integrity + data-version="latest" → fails closed; data-integrity="warn" loads unchecked
 *   plugin third-party files (marked, DOMPurify, highlight.js + a grammar, d3) → verified; tampered → refused
 *   service worker: a stub importing its module cross-origin stays off; a same-origin worker registers
 *
 * Third-party files are proxied from jsDelivr (network needed).
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

const upstream = new Map()
async function vendorBytes(p) {
    if (!upstream.has(p)) upstream.set(p, fetch('https://cdn.jsdelivr.net' + p).then(async (r) => (r.ok ? Buffer.from(await r.arrayBuffer()) : null)))
    return upstream.get(p)
}

// A CDN mirror: jsDelivr-style /npm/<pkg>@<v>/<path>, CORS on, optional tampered files
function mirror() {
    const tampered = new Set()
    const server = http.createServer(async (req, res) => {
        const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        const cors0 = { 'Access-Control-Allow-Origin': '*' }
        if (p.startsWith('/npm/') && !p.startsWith('/npm/mnfst@') && !p.startsWith(`/npm/alpinejs@${ALPINE}/`)) {
            let body = await vendorBytes(p)
            if (!body) { res.writeHead(404, cors0); return res.end() }
            const name = path.basename(p)
            if (tampered.has(name)) body = Buffer.concat([body, Buffer.from('\n;window.__tampered = (window.__tampered || []).concat(' + JSON.stringify(name) + ');')])
            res.writeHead(200, { ...cors0, 'Content-Type': name.endsWith('.json') ? 'application/json' : 'text/javascript', 'Cache-Control': 'no-store' })
            return res.end(body)
        }
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
let swStub = null
function site() {
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p === '/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"name":"x"}') }
        if (p === '/sw.js' && swStub) { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); return res.end(swStub) }
        if (!pages[p]) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        res.end(pages[p])
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
        url: (p) => `http://localhost:${server.address().port}${p}`,
        close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) })
    })))
}

const page = (loaderAttrs, plugins = 'data-plugins="toasts,tooltips"', extra = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<script ${loaderAttrs} ${plugins} data-tailwind></script></head>
<body><div x-data="{ m: 'booted' }"><span id="t" x-text="m"></span>${extra}</div></body></html>`
// Uses every on-use directive module, so the default set plus all of them load
const ON_USE = `<div x-markdown="'# T'"></div><pre x-code="js"><code>1</code></pre><span x-svg.safe="''"></span><input x-combobox="o"><div x-carousel><div class="carousel-slides"><div>a</div></div></div><template x-colorpicker></template><div x-date></div><div x-chart="{ type: 'bar', series: [{ data: [1] }] }"></div><div x-virtual><template x-for="r in []"><p></p></template></div><button x-export.csv>e</button>`

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
        '/pinned-defaults-used': page(pinned, '', ON_USE),
        '/pinned-warn': page(`${pinned} data-version="latest" data-integrity="warn"`),
        '/plugins': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<script ${pinned} data-plugins="markdown,code,charts"></script></head>
<body><div x-data="{ md: '# Title' }"><div id="md" x-markdown="md"></div></div>
<pre><code id="code" x-code="elixir">defmodule Hi do\n  def hi, do: :ok\nend</code></pre>
<div id="chart" x-data x-chart="{ type: 'line', labels: ['a','b','c'], series: [{ name: 's', data: [1, 3, 2] }], height: 120 }"></div>
<span id="t" x-data x-text="'booted'"></span></body></html>`,
        '/sw': page(`${pinned} data-sw="on"`),
    }
    pages['/plugins-unchecked'] = pages['/plugins'].replace(pinned, `src="${a.base}/mnfst@${VERSION}/lib/manifest.min.js" data-version="${VERSION}" ${cdn}`)
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        let r = await visit(browser, s.url('/pinned'))
        const names = r.tags.map((t) => t.src.split('/').pop()).sort()
        check('pinned: page boots', r.booted)
        check('pinned: modules, Tailwind and Alpine injected', ['cdn.min.js', 'manifest.bindings.min.js', 'manifest.defer.min.js', 'manifest.tailwind.min.js', 'manifest.toasts.min.js', 'manifest.tooltips.min.js'].every((n) => names.includes(n)), names.join(', '))
        check('pinned: every injected tag has integrity + crossorigin=anonymous', r.tags.length >= 6 && r.tags.every((t) => /^sha384-/.test(t.integrity) && t.crossorigin === 'anonymous'), JSON.stringify(r.tags.filter((t) => !t.integrity)))
        check('pinned: no console errors', r.errors.length === 0, r.errors.join(' | '))

        r = await visit(browser, s.url('/pinned-defaults'))
        // The default set no longer carries the on-use directive modules: 12 core modules, Tailwind, Alpine
        check('pinned, default module set: boots verified with no errors', r.booted && r.tags.length >= 14 && r.tags.every((t) => t.integrity) && r.errors.length === 0, `${r.tags.length} tags; ${r.errors.join(' | ')}`)
        r = await visit(browser, s.url('/pinned-defaults-used'))
        const used = ['markdown', 'svg', 'code', 'combobox', 'slides', 'colorpicker', 'datepicker', 'charts', 'virtual', 'export'].filter((m) => !r.tags.some((t) => t.src.endsWith(`manifest.${m}.min.js`)))
        check('pinned, default set plus every on-use module (all shipped .min.js): boots verified with no errors', r.booted && used.length === 0 && r.tags.length >= 24 && r.tags.every((t) => t.integrity) && r.errors.length === 0, `${r.tags.length} tags; missing ${used.join(',')}; ${r.errors.join(' | ')}`)

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
        check('integrity + data-version="latest": fails closed with an error naming the fix', !r.booted && r.tags.length === 0 && r.errors.some((e) => e.includes(`Set data-version="${VERSION}" or remove it. No modules were loaded.`)), r.errors.join(' | '))

        r = await visit(browser, s.url('/pinned-warn'))
        check('data-integrity="warn" + data-version="latest": warns, loads unchecked, boots', r.booted && r.tags.every((t) => !t.integrity) && r.logs.some((l) => /warn/.test(l.type) && l.text.includes('data-integrity="warn"')))

        const plugins = async (url = '/plugins') => {
            const ctx = await browser.createBrowserContext()
            const tab = await ctx.newPage()
            const logs = []
            tab.on('console', (m) => { if (!(m.location()?.url || '').endsWith('/favicon.ico')) logs.push({ type: m.type(), text: m.text() }) })
            await tab.goto(s.url(url), { waitUntil: 'load' })
            await tab.waitForFunction(() => document.querySelector('#md h1') && document.querySelector('[class*="hljs-"]') && document.querySelector('#chart svg path'), { timeout: 15000 }).catch(() => { })
            await new Promise((r) => setTimeout(r, 300))
            // DOMPurify loads for .safe content; load it directly through the plugin's shared loader
            const purify = await tab.evaluate(() => window.ManifestDOMPurify.load().then(() => 'ok', (e) => String(e)))
            // Export's libraries as the plugin loads them: html2canvas-pro UMD (was ESM import()) and jsPDF
            const exportLibs = await tab.evaluate(async () => {
                try {
                    await window.ManifestVendor.script('html2canvas-pro@2.6.4/dist/html2canvas-pro.min.js')
                    await window.ManifestVendor.script('jspdf@2.5.2/dist/jspdf.umd.min.js')
                    const canvas = await window.html2canvas(document.getElementById('md'))
                    return canvas instanceof HTMLCanvasElement && typeof window.jspdf.jsPDF === 'function' ? 'ok' : 'bad'
                } catch (e) { return String(e) }
            })
            const st = await tab.evaluate(() => ({
                h1: !!document.querySelector('#md h1'),
                code: !!document.querySelector('[class*="hljs-"]'),
                chart: !!document.querySelector('#chart svg path'),
                tampered: window.__tampered || [],
                vendor: [...document.querySelectorAll('script[src]')].filter((t) => !/\/mnfst@|alpinejs@/.test(t.src)).map((t) => ({ src: t.src, integrity: t.getAttribute('integrity'), crossorigin: t.getAttribute('crossorigin') })),
            }))
            await ctx.close()
            return { ...st, purify, exportLibs, logs, errors: logs.filter((l) => l.type === 'error').map((l) => l.text) }
        }
        let pr = await plugins()
        const vnames = pr.vendor.map((v) => v.src.split('/npm/')[1])
        check('plugins: markdown renders via verified marked; DOMPurify loads verified', pr.h1 && pr.purify === 'ok' && ['marked@15.0.12/marked.min.js', 'dompurify@3.4.10/dist/purify.min.js'].every((n) => vnames.includes(n)), vnames.join(', '))
        check('plugins: code highlights elixir via the verified bundle + grammar', pr.code && vnames.includes('@highlightjs/cdn-assets@11.11.1/highlight.min.js') && vnames.includes('@highlightjs/cdn-assets@11.11.1/languages/elixir.min.js'))
        check('plugins: chart renders via verified d3 UMD builds', pr.chart && vnames.includes('d3-scale@4.0.3/dist/d3-scale.min.js'))
        check('plugins: every third-party tag carries integrity + crossorigin, no esm.run', pr.vendor.length >= 10 && pr.vendor.every((v) => /^sha384-/.test(v.integrity) && v.crossorigin === 'anonymous' && !v.src.includes('esm.run')), JSON.stringify(pr.vendor.filter((v) => !v.integrity)))
        check('plugins: export libraries load verified and work (html2canvas-pro UMD, jsPDF)', pr.exportLibs === 'ok', pr.exportLibs)
        check('plugins: no console errors', pr.errors.length === 0, pr.errors.join(' | '))

        pr = await plugins('/plugins-unchecked')
        check('plugins without checks: markdown, code (esm.run lean, exact pins) and chart still work', pr.h1 && pr.code && pr.chart && pr.exportLibs === 'ok' && pr.errors.length === 0, pr.errors.join(' | '))

        a.tampered.add('marked.min.js'); b.tampered.add('marked.min.js')
        pr = await plugins()
        check('plugins: tampered marked on every mirror is refused, loudly', !pr.h1 && pr.tampered.length === 0 && pr.errors.some((e) => e.includes('marked@15.0.12/marked.min.js did not match its integrity hash on any CDN')), pr.errors.join(' | '))
        check('plugins: the rest of the page still works', pr.chart && pr.code)
        a.tampered.clear(); b.tampered.clear()

        // Service worker (localhost + data-sw="on" forces registration)
        const swVisit = async () => {
            const ctx = await browser.createBrowserContext()
            const tab = await ctx.newPage()
            const logs = []
            tab.on('console', (m) => logs.push({ type: m.type(), text: m.text() }))
            await tab.goto(s.url('/sw'), { waitUntil: 'load' })
            await tab.waitForFunction(() => window.Manifest && window.Manifest.sw && window.Manifest.sw.registered, { timeout: 20000 }).catch(() => { })
            const registered = await tab.evaluate(() => !!(window.Manifest.sw && window.Manifest.sw.registered))
            await ctx.close()
            return { registered, logs }
        }
        swStub = `try { importScripts('${a.base}/mnfst@${VERSION}/lib/manifest.sw.min.js'); } catch (e) { }\nif (!self.__mnfstSw) self.addEventListener('activate', function () { self.registration.unregister(); });\n`
        let sw = await swVisit()
        check('sw: a stub importing its module cross-origin stays off, with a warning naming the fix', !sw.registered && sw.logs.some((l) => /warn/.test(l.type) && l.text.includes('copy lib/manifest.sw.min.js')), sw.logs.map((l) => l.text).filter((t) => t.includes('sw')).join(' | '))
        swStub = fs.readFileSync(path.join(ROOT, 'lib/manifest.sw.min.js'), 'utf8')
        sw = await swVisit()
        check('sw: a worker served from this origin registers', sw.registered)
        swStub = null
    } finally {
        await browser.close()
        await Promise.all([a.close(), b.close(), s.close()])
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
