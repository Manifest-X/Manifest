/**
 * Native-module app e2e: tests/fixtures/modules-app (import map + type="module"
 * app code, no build) against the built lib/.
 *
 *   a) live SPA: data, router navigation, store, shared helpers, an inline
 *      module inside a component, and a deliberately slow module graph
 *   b) mnfst-render prerender: baked content, then hydration in the browser
 *   c) service worker: second load controlled, then offline reload still runs
 *
 * Chromium via puppeteer always. WebKit and Firefox too when playwright-core
 * resolves (set MODULES_E2E_PLAYWRIGHT to its directory if it isn't installed
 * here); browsers come from the usual ms-playwright cache.
 *
 * Run: npm run build && node tests/e2e/modules.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'modules-app')
const SCRATCH = fs.mkdtempSync(path.join(tmpdir(), 'mnfst-modules-e2e-'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png' }

// Site root + /fw → lib (or the prerender's own copy), /sw.js stub, SPA fallback
function serve(site, fw, opts = {}) {
    const server = http.createServer(async (req, res) => {
        const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        if (p === '/sw.js') { res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' }); return res.end("importScripts('/fw/manifest.sw.js');\n") }
        if (opts.slow && p.startsWith('/app/')) await wait(opts.slow)
        let file = p.startsWith('/fw/') ? path.join(fw, p.slice(4)) : path.join(site, p)
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
        if (!fs.existsSync(file)) {
            if (path.extname(p)) { res.writeHead(404); return res.end() }
            file = path.join(site, 'index.html')
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
        res.end(fs.readFileSync(file))
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
        url: `http://localhost:${server.address().port}`,
        close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) }),
    })))
}

// Minimal driver over puppeteer and playwright pages
async function poll(page, fn, arg, timeout = 15000) {
    const end = Date.now() + timeout
    let last
    while (Date.now() < end) {
        last = await page.evaluate(fn, arg).catch(() => undefined)
        if (last) return last
        await wait(100)
    }
    return last
}
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent.trim() ?? null, sel)
const items = (page) => page.evaluate(() => [...document.querySelectorAll('#tasks li')].filter((li) => li.offsetParent !== null).map((li) => li.textContent.trim()))
const errorsOf = (page) => {
    const errs = []
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
    page.on('pageerror', (e) => errs.push(String(e.message || e)))
    page.on('response', (r) => { if (r.status() >= 400) errs.push(`${r.status()} ${r.url()}`) })
    return errs
}
const relevant = (errs) => errs.filter((e) => !/favicon|^Failed to load resource/i.test(e))

async function liveSpa(b, label) {
    const srv = await serve(FIXTURE, path.join(ROOT, 'lib'))
    const page = await b.newPage()
    const errs = errorsOf(page)
    try {
        await page.goto(srv.url + '/', { waitUntil: 'load' })
        const listed = await poll(page, () => document.querySelectorAll('#tasks li').length === 3)
        check(`${label} live: data source renders through a module component`, !!listed)
        check(`${label} live: module helpers compute the summary`, await text(page, '#summary') === '2 open tasks of 3')

        await page.type('input[type=search]', 'ship')
        await poll(page, () => document.querySelectorAll('#tasks li').length === 1)
        check(`${label} live: reactive filter`, JSON.stringify(await items(page)) === '["Ship the release"]')

        await page.evaluate(() => { const i = document.querySelector('input[type=search]'); i.value = ''; i.dispatchEvent(new Event('input')) })
        await poll(page, () => document.querySelectorAll('#tasks li').length === 3)
        await page.click('#tasks a[href="/tasks/2"]')
        await poll(page, () => document.querySelector('#task-title')?.textContent === 'Review the draft')
        check(`${label} live: router navigation without reload`, await page.evaluate(() => location.pathname) === '/tasks/2' && await text(page, '#task-due') === 'Due 20 Nov 2026')

        await page.click('#star')
        await poll(page, () => document.querySelector('#star')?.textContent === 'Unstar')
        await page.click('nav a[href="/about"]')
        await poll(page, () => document.querySelector('#starred')?.textContent === '1 task starred')
        check(`${label} live: store shared across screens`, await text(page, '#starred') === '1 task starred')
        check(`${label} live: inline module in a component imports via the import map`, await page.evaluate(() => document.documentElement.dataset.statsModule) === '2 modules')
        check(`${label} live: no console errors`, relevant(errs).length === 0, relevant(errs).slice(0, 3).join(' | '))
    } catch (e) {
        check(`${label} live: run`, false, e.message)
    } finally {
        await page.close()
        await srv.close()
    }

    // Module graph slower than every plugin: registration must still precede Alpine
    const slow = await serve(FIXTURE, path.join(ROOT, 'lib'), { slow: 600 })
    const page2 = await b.newPage()
    const errs2 = errorsOf(page2)
    try {
        await page2.goto(slow.url + '/tasks/3', { waitUntil: 'load', timeout: 60000 })
        await poll(page2, () => document.querySelector('#task-title')?.textContent === 'Ship the release', undefined, 30000)
        check(`${label} slow graph: components registered before Alpine started`, await text(page2, '#task-title') === 'Ship the release' && relevant(errs2).length === 0, relevant(errs2).slice(0, 3).join(' | '))
    } catch (e) {
        check(`${label} slow graph: run`, false, e.message)
    } finally {
        await page2.close()
        await slow.close()
    }
}

function prerender() {
    const site = path.join(SCRATCH, 'site')
    fs.cpSync(FIXTURE, site, { recursive: true })
    fs.cpSync(path.join(ROOT, 'lib'), path.join(site, 'fw'), { recursive: true })
    const r = spawnSync('node', [path.join(ROOT, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: site, encoding: 'utf8', timeout: 240000 })
    const out = path.join(site, 'website')
    check('prerender: exit 0', r.status === 0, r.status === 0 ? '' : (r.stdout + r.stderr).split('\n').slice(-10).join(' / '))
    const page = (p) => { try { return fs.readFileSync(path.join(out, p), 'utf8') } catch { return '' } }
    const task = page('tasks/2/index.html')
    check('prerender: baked task detail', task.includes('>Review the draft</h1>') && task.includes('>Due 20 Nov 2026</p>'))
    check('prerender: import map and module entry kept', /<script type="importmap">/.test(task) && /<script type="module" src="[^"]*app\/main\.js">/.test(task))
    check('prerender: baked task list', (page('index.html').match(/<li>/g) || []).length === 3)
    check('prerender: .mjs module served as JavaScript (summary baked)', page('index.html').includes('>2 open tasks of 3</p>'))
    check('prerender: app modules copied to output', fs.existsSync(path.join(out, 'app', 'lib', 'tasks.mjs')))
    return out
}

async function hydrated(b, label, out) {
    const srv = await serve(out, path.join(out, 'fw'))
    const page = await b.newPage()
    const errs = errorsOf(page)
    try {
        const html = await (await fetch(srv.url + '/tasks/2')).text()
        check(`${label} prerendered: served page carries baked content`, html.includes('>Review the draft</h1>'))
        await page.goto(srv.url + '/tasks/2', { waitUntil: 'load' })
        const title = await poll(page, () => document.querySelector('#task-title')?.textContent === 'Review the draft')
        check(`${label} prerendered: title after hydration`, !!title)
        await poll(page, () => !!document.querySelector('#star') && !!window.Alpine && document.querySelector('#star').textContent === 'Star')
        await page.click('#star')
        const live = await poll(page, () => document.querySelector('#star')?.textContent === 'Unstar')
        check(`${label} prerendered: hydrated and interactive`, !!live)

        await page.goto(srv.url + '/', { waitUntil: 'load' })
        await poll(page, () => !!window.Alpine && document.querySelector('#summary')?.textContent === '2 open tasks of 3')
        await wait(500)
        check(`${label} prerendered: list not duplicated by hydration`, (await items(page)).length === 3)
        check(`${label} prerendered: no console errors`, relevant(errs).length === 0, relevant(errs).slice(0, 3).join(' | '))
    } catch (e) {
        check(`${label} prerendered: run`, false, e.message)
    } finally {
        await page.close()
        await srv.close()
    }
}

async function offline(b, label, setOffline) {
    const srv = await serve(FIXTURE, path.join(ROOT, 'lib'))
    const page = await b.newPage()
    try {
        await page.goto(srv.url + '/', { waitUntil: 'load' })
        const active = await poll(page, async () => {
            const r = await navigator.serviceWorker.getRegistration('/')
            return !!(r && r.active && r.active.state === 'activated')
        }, undefined, 20000)
        check(`${label} sw: registered and activated`, !!active)
        await page.goto(srv.url + '/about', { waitUntil: 'load' })
        await poll(page, () => document.querySelector('#stats')?.textContent === '3 tasks in total')
        check(`${label} sw: second load controlled`, await page.evaluate(() => !!navigator.serviceWorker.controller))
        await wait(1000)
        await setOffline(page, true)
        await page.reload({ waitUntil: 'load' })
        const ok = await poll(page, () => document.querySelectorAll('#tasks li').length === 3 || document.querySelector('#stats')?.textContent === '3 tasks in total', undefined, 20000)
        check(`${label} sw: offline reload runs the module app`, !!ok)
        await setOffline(page, false)
    } catch (e) {
        check(`${label} sw: run`, false, e.message)
    } finally {
        await page.close()
        await srv.close()
    }
}

async function loadPlaywright() {
    const where = process.env.MODULES_E2E_PLAYWRIGHT
    try {
        return where ? await import(pathToFileURL(path.join(where, 'index.mjs')).href) : await import('playwright-core')
    } catch { return null }
}

async function main() {
    const out = prerender()

    const chrome = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        await liveSpa(chrome, 'chromium')
        await hydrated(chrome, 'chromium', out)
        const ctx = await chrome.createBrowserContext()
        await offline(ctx, 'chromium', (page, v) => page.setOfflineMode(v))
        await ctx.close()
    } finally { await chrome.close() }

    const pw = await loadPlaywright()
    if (!pw) console.log('SKIP  webkit/firefox — playwright-core not found')
    for (const name of pw ? ['webkit', 'firefox'] : []) {
        let browser
        try { browser = await pw[name].launch() } catch (e) { console.log(`SKIP  ${name} — ${e.message.split('\n')[0]}`); continue }
        try {
            const context = await browser.newContext()
            await liveSpa(context, name)
            await hydrated(context, name, out)
            await context.close()
            const swCtx = await browser.newContext()
            await offline(swCtx, name, (page, v) => page.context().setOffline(v))
            await swCtx.close()
        } finally { await browser.close() }
    }

    fs.rmSync(SCRATCH, { recursive: true, force: true })
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
