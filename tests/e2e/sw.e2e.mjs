/**
 * Headless e2e for the app-shell service worker (PERF-PRIMITIVES-DESIGN §13).
 *
 * Copies the src test project to a scratch dir, adds the loader in "loads
 * nothing" mode with data-sw="on" (localhost is a secure context, so no
 * insecure-origin flags are needed), and drives real Chrome through:
 *   a) mnfst-run: dev bypass + the no-op /sw.js removing a stale worker
 *   b) a static server with a local stub: registration, warm-boot request
 *      counts (plain / stamped / stamped+precache), network-first documents,
 *      hard-reload behaviour, offline fallback, kill switch, and the real
 *      CDN stub failing open when the module is unpublished.
 *
 * Run: node tests/e2e/sw.e2e.mjs   (exits non-zero on any failed check)
 */

import { spawn } from 'child_process'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SCRATCH = process.env.SW_E2E_SCRATCH || path.join(tmpdir(), 'mnfst-sw-e2e')
const SITE = path.join(SCRATCH, 'site')
const BASE_PORT = Number(process.env.SW_E2E_PORT || 5120)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
let failed = 0
function check(name, ok, detail = '') {
    results.push({ name, ok, detail })
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ---- scratch site ----
const LOADER_TAG = '<script src="/scripts/manifest.js" data-sw="on" data-plugins="components" data-omit="components"></script>'
function buildSite() {
    fs.rmSync(SCRATCH, { recursive: true, force: true })
    fs.cpSync(path.join(ROOT, 'src'), SITE, { recursive: true })
    const idx = path.join(SITE, 'index.html')
    let html = fs.readFileSync(idx, 'utf8')
    html = html.replace('<link rel="manifest" href="/manifest.json">', '<link rel="manifest" href="/manifest.json">\n  ' + LOADER_TAG)
    fs.writeFileSync(idx, html)
    fs.writeFileSync(path.join(SITE, 'plain.html'), '<!doctype html><html><head><title>plain</title></head><body>plain</body></html>')
}

// ---- static server (the "hosting" side) ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.yaml': 'text/yaml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.md': 'text/plain' }
function staticServer(port, opts = {}) {
    const state = { stamped: false, precache: false, swFalse: false, stub: 'local', hits: [], ...opts }
    const stamp = (html) => !state.stamped ? html
        : html.replace(/src="(\/scripts\/[^"?]+)"/g, 'src="$1?v=e2e"').replace(/href="(\/styles\/[^"?]+)"/g, 'href="$1?v=e2e"')
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`)
        const p = decodeURIComponent(url.pathname)
        state.hits.push(p + url.search)
        const send = (status, type, body) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body) }
        if (p === '/sw.js') {
            if (state.stub === 'local') return send(200, MIME['.js'], "importScripts('/scripts/manifest.sw.js');\n")
            if (state.stub === 'none') return send(404, 'text/html', '<h1>404</h1>')
            return send(200, MIME['.js'], state.stub)
        }
        if (p === '/precache.json') {
            if (!state.precache) return send(404, 'text/plain', 'nf')
            const html = stamp(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'))
            const files = ['/index.html', '/manifest.json']
            for (const m of html.matchAll(/(?:src|href)="(\/(?:scripts|styles)\/[^"]+|https:\/\/cdn\.jsdelivr\.net[^"]+)"/g)) files.push(m[1])
            const manifest = JSON.parse(fs.readFileSync(path.join(SITE, 'manifest.json'), 'utf8'))
            for (const c of [...(manifest.preloadedComponents || []), ...(manifest.components || [])]) files.push(c + (state.stamped ? '?v=e2e' : ''))
            return send(200, MIME['.json'], JSON.stringify({ deployment: '', files }))
        }
        if (p === '/manifest.json') {
            const m = JSON.parse(fs.readFileSync(path.join(SITE, 'manifest.json'), 'utf8'))
            if (state.stamped) m.version = 'e2e'
            if (state.swFalse) m.sw = false
            return send(200, MIME['.json'], JSON.stringify(m))
        }
        let file = path.join(SITE, p)
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
        if (!fs.existsSync(file)) return send(404, 'text/plain', 'nf')
        const ext = path.extname(file).toLowerCase()
        let body = fs.readFileSync(file)
        if (ext === '.html') body = Buffer.from(stamp(body.toString('utf8')))
        send(200, MIME[ext] || 'application/octet-stream', body)
    })
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
        server, state, port, url: `http://localhost:${port}`,
        reset: () => { state.hits = [] },
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }),
    })))
}

// ---- mnfst-run ----
function ping(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200) })
        req.on('error', () => resolve(false))
        req.setTimeout(1000, () => { req.destroy(); resolve(false) })
    })
}
async function startMnfstRun(port) {
    const proc = spawn('node', ['packages/run/serve.mjs', SITE, '--port', String(port), '--no-open', '--no-idle-shutdown'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', (c) => { out += c })
    proc.stderr.on('data', (c) => { out += c })
    for (let i = 0; i < 60; i++) { if (await ping(`http://localhost:${port}/__mnfst_run__`)) break; await wait(250) }
    if (!await ping(`http://localhost:${port}/__mnfst_run__`)) throw new Error('mnfst-run never came up: ' + out)
    let exited = false
    proc.once('exit', () => { exited = true })
    return { proc, stop: () => new Promise((r) => { if (exited) return r(); proc.once('exit', () => r()); proc.kill('SIGTERM') }) }
}
async function waitPortFree(port) {
    for (let i = 0; i < 40; i++) { if (!await ping(`http://localhost:${port}/`)) return; await wait(250) }
}

// ---- page helpers ----
function track(page) {
    const t = { total: 0, fromSW: 0, fromCache: 0 }
    page.on('response', (r) => {
        t.total++
        if (r.fromServiceWorker()) t.fromSW++
        else if (r.fromCache()) t.fromCache++
    })
    return { t, reset: () => { t.total = 0; t.fromSW = 0; t.fromCache = 0 } }
}
const swInfo = (page) => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration('/')
    const w = reg && (reg.active || reg.waiting || reg.installing)
    const names = (await caches.keys()).filter((n) => n.startsWith('mnfst-sw:'))
    let entries = 0
    for (const n of names) entries += (await (await caches.open(n)).keys()).length
    return {
        registered: !!(window.Manifest && window.Manifest.sw && window.Manifest.sw.registered),
        hasRegistration: !!reg,
        scriptURL: w ? w.scriptURL : null,
        state: w ? w.state : null,
        controlled: !!navigator.serviceWorker.controller,
        caches: names, entries,
        devMarker: !!window.__mnfstRun,
        alpine: !!window.Alpine,
    }
})
const shellHits = (hits) => hits.filter((h) => /^\/(scripts|styles|test\/components)\//.test(h)).length
const summarize = (hits) => ({ total: hits.length, shell: shellHits(hits), docs: hits.filter((h) => h === '/index.html' || h === '/' || h === '/manifest.json').length })

async function settled(page, ms = 2500) {
    // The loader infers after window load; give it and the worker a moment.
    await page.waitForFunction(() => window.Manifest && window.Manifest.sw, { timeout: 15000 })
    await wait(ms)
}
async function waitActivated(page) {
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration('/'); return !!(r && r.active && r.active.state === 'activated') }, { timeout: 15000 })
}
async function load(page, url, tracker, srv, label) {
    tracker.reset(); srv.reset()
    await page.goto(url, { waitUntil: 'load', timeout: 60000 })
    await settled(page)
    const info = await swInfo(page)
    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => ({ name: e.name, transferSize: e.transferSize })))
    const zero = resources.filter((r) => r.transferSize === 0).length
    const row = { label, server: summarize(srv.state.hits), page: { ...tracker.t, resources: resources.length, transferSizeZero: zero }, controlled: info.controlled }
    console.log(`  ${label}: server hits total=${row.server.total} shell=${row.server.shell} docs=${row.server.docs} | page responses=${row.page.total} fromSW=${row.page.fromSW} resources=${row.page.resources} transferSize0=${zero} controlled=${info.controlled}`)
    return { ...row, info }
}

async function warmBootRun(browser, port, opts, label) {
    const srv = await staticServer(port, opts)
    const page = await browser.newPage()
    const tracker = track(page)
    const url = `${srv.url}/index.html`
    const rows = []
    try {
        rows.push(await load(page, url, tracker, srv, `${label} load 1 (cold, registers)`))
        check(`${label}: loader registered`, rows[0].info.registered && rows[0].info.scriptURL?.includes('/sw.js?v=latest&d='), String(rows[0].info.scriptURL))
        check(`${label}: first load is not controlled`, rows[0].info.controlled === false)
        await waitActivated(page)
        if (opts.precache) {
            // Wait for the background warm-up to fill the caches.
            await page.waitForFunction(async () => { let n = 0; for (const k of await caches.keys()) if (k.startsWith('mnfst-sw:')) n += (await (await caches.open(k)).keys()).length; return n > 20 }, { timeout: 20000 })
        }
        rows.push(await load(page, url, tracker, srv, `${label} load 2`))
        check(`${label}: second load controlled by the worker`, rows[1].info.controlled === true)
        rows.push(await load(page, url, tracker, srv, `${label} load 3 (warm)`))
        return { srv, page, tracker, rows }
    } catch (e) {
        check(`${label}: run`, false, e.message)
        await srv.close()
        await page.close()
        throw e
    }
}

async function main() {
    buildSite()
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    const runs = {}
    try {
        // ---- b1) plain (unstamped same-origin scripts → stale-while-revalidate) ----
        const plain = await warmBootRun(browser, BASE_PORT, {}, 'plain')
        runs.plain = plain.rows
        check('plain: warm load serves the shell from the worker', plain.rows[2].page.fromSW >= plain.rows[2].page.resources * 0.8, `${plain.rows[2].page.fromSW}/${plain.rows[2].page.resources} responses from SW`)
        check('plain: warm load still revalidates unstamped assets in the background (SWR)', plain.rows[2].server.shell > 0, `${plain.rows[2].server.shell} shell revalidations`)

        // network-first documents: edit index.html, reload, see the change
        const marker = 'e2e-marker-' + Date.now()
        const idx = path.join(SITE, 'index.html')
        fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('</body>', `<!-- ${marker} --></body>`))
        await plain.page.reload({ waitUntil: 'load' })
        await settled(plain.page, 500)
        const seen = await plain.page.evaluate(() => document.documentElement.outerHTML)
        check('documents are network first (edited index.html visible on reload while controlled)', seen.includes(marker) && (await swInfo(plain.page)).controlled)

        // hard reload: does Chrome bypass the worker?
        plain.tracker.reset(); plain.srv.reset()
        const cdp = await plain.page.createCDPSession()
        await cdp.send('Page.reload', { ignoreCache: true })
        await plain.page.waitForNavigation({ waitUntil: 'load' }).catch(() => { })
        await settled(plain.page, 1500)
        const hard = { fromSW: plain.tracker.t.fromSW, total: plain.tracker.t.total, server: summarize(plain.srv.state.hits) }
        console.log(`  hard reload (ignoreCache): page responses=${hard.total} fromSW=${hard.fromSW} server shell hits=${hard.server.shell}`)
        runs.hardReload = hard

        // offline: shell from cache
        let offlineOk = false, offlineDetail = ''
        try {
            await plain.page.setOfflineMode(true)
            await plain.page.reload({ waitUntil: 'load', timeout: 20000 })
            offlineOk = await plain.page.evaluate(() => document.title.length > 0 && !!document.querySelector('script[src*="manifest.js"]'))
            offlineDetail = 'document served from the pages cache'
        } catch (e) { offlineDetail = e.message } finally { await plain.page.setOfflineMode(false) }
        check('offline navigation falls back to the cached document', offlineOk, offlineDetail)

        // kill switch: manifest.json "sw": false
        plain.srv.state.swFalse = true
        await plain.page.reload({ waitUntil: 'load' })
        await settled(plain.page, 500)
        await plain.page.waitForFunction(async () => !(await navigator.serviceWorker.getRegistration('/')), { timeout: 15000 }).catch(() => { })
        let after = await swInfo(plain.page)
        check('kill switch: registration removed on the load that saw "sw": false', !after.hasRegistration, JSON.stringify({ hasRegistration: after.hasRegistration, caches: after.caches }))
        await plain.page.reload({ waitUntil: 'load' })
        await settled(plain.page, 2000)
        after = await swInfo(plain.page)
        check('kill switch: next navigation is uncontrolled with no Manifest caches', !after.controlled && after.caches.length === 0, JSON.stringify(after.caches))
        plain.srv.state.swFalse = false
        const realStub = await plain.page.evaluate((v) => window.Manifest.swStub(v), '0.5.198')
        await plain.page.close()
        await plain.srv.close()

        // ---- b2) stamped (?v= on scripts/styles + manifest version → immutable) ----
        const stamped = await warmBootRun(browser, BASE_PORT + 1, { stamped: true }, 'stamped')
        runs.stamped = stamped.rows
        const stampedWarm = stamped.srv.state.hits
        runs.stampedWarmServerHits = [...new Set(stampedWarm)].sort()
        check('stamped: warm load serves every stamped asset from the worker', !stampedWarm.some((h) => /[?&]v=e2e/.test(h)), `${stampedWarm.filter((h) => /[?&]v=e2e/.test(h)).length} stamped hits; unstamped shell revalidations: ${shellHits(stampedWarm)}; hits: ${runs.stampedWarmServerHits.slice(0, 60).join(' ')}`)
        await stamped.page.close(); await stamped.srv.close()

        // ---- b3) stamped + precache.json (warm on the SECOND load) ----
        const pre = await warmBootRun(browser, BASE_PORT + 2, { stamped: true, precache: true }, 'stamped+precache')
        runs.precache = pre.rows
        check('precache: second load already serves stamped assets from the worker', !pre.srv.state.hits.some((h) => /[?&]v=e2e/.test(h)) && pre.rows[1].server.total < stamped.rows[1].server.total, `load 2 server hits ${pre.rows[1].server.total} vs ${stamped.rows[1].server.total} without precache`)
        await pre.page.close(); await pre.srv.close()

        // ---- b4) real CDN stub (module not yet published → importScripts fails → install fails → fail open) ----
        const real = await staticServer(BASE_PORT + 3, { stub: realStub })
        const rp = await browser.newPage()
        const logs = []
        rp.on('console', (m) => logs.push(m.text()))
        await rp.goto(`${real.url}/index.html`, { waitUntil: 'load', timeout: 60000 })
        await settled(rp, 4000)
        const rinfo = await swInfo(rp)
        check('real stub with unpublished module fails open: page loads, nothing registered', rinfo.alpine && !rinfo.registered && !rinfo.hasRegistration, JSON.stringify({ registered: rinfo.registered, hasRegistration: rinfo.hasRegistration, state: rinfo.state }))
        runs.realStubLogs = logs.filter((l) => /sw|service ?worker|importScripts/i.test(l)).slice(0, 5)
        await rp.close(); await real.close()

        // ---- b5) no stub → nothing happens ----
        const none = await staticServer(BASE_PORT + 4, { stub: 'none' })
        const np = await browser.newPage()
        const nlogs = []
        np.on('console', (m) => { if (m.type() === 'error') nlogs.push(m.text()) })
        await np.goto(`${none.url}/index.html`, { waitUntil: 'load', timeout: 60000 })
        await settled(np, 1500)
        const ninfo = await swInfo(np)
        check('missing stub: no registration, no console error about sw.js', !ninfo.registered && !ninfo.hasRegistration && !nlogs.some((l) => l.includes('sw.js')))
        await np.close(); await none.close()

        // ---- a) mnfst-run: dev bypass, then the no-op stub removing a stale worker ----
        const devPort = BASE_PORT + 5
        // Install a "production" worker on this origin first.
        const pre2 = await staticServer(devPort)
        const dp = await browser.newPage()
        await dp.goto(`${pre2.url}/index.html`, { waitUntil: 'load', timeout: 60000 })
        await settled(dp)
        await waitActivated(dp)
        await dp.reload({ waitUntil: 'load' }); await settled(dp, 1000)
        const stale = await swInfo(dp)
        check('dev setup: a worker is installed and controlling the origin', stale.hasRegistration && stale.controlled && stale.entries > 0, `${stale.entries} cached entries`)
        await pre2.close(); await waitPortFree(devPort)
        const run = await startMnfstRun(devPort)
        try {
            // No loader on this page: only the browser's update check + the no-op stub are in play.
            await dp.goto(`http://localhost:${devPort}/plain.html`, { waitUntil: 'load' })
            const before = await swInfo(dp)
            await dp.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/'); if (r) await r.update() })
            await dp.waitForFunction(async () => !(await navigator.serviceWorker.getRegistration('/')), { timeout: 15000 }).catch(() => { })
            const noop = await swInfo(dp)
            check('mnfst-run no-op /sw.js unregisters the stale worker and clears its caches', before.hasRegistration && !noop.hasRegistration && noop.caches.length === 0, JSON.stringify({ before: before.hasRegistration, after: noop.hasRegistration, caches: noop.caches }))

            await dp.goto(`http://localhost:${devPort}/index.html`, { waitUntil: 'load', timeout: 60000 })
            await settled(dp, 1500)
            const dev = await swInfo(dp)
            check('mnfst-run page carries the dev marker and the loader does not register (data-sw="on" notwithstanding)', dev.devMarker && !dev.registered && !dev.hasRegistration)

            // Loader-side removal: install a worker again, then let the loader see the dev marker.
            await run.stop(); await waitPortFree(devPort)
            const pre3 = await staticServer(devPort)
            await dp.goto(`${pre3.url}/index.html`, { waitUntil: 'load', timeout: 60000 }); await settled(dp); await waitActivated(dp)
            await pre3.close(); await waitPortFree(devPort)
            const run2 = await startMnfstRun(devPort)
            try {
                await dp.goto(`http://localhost:${devPort}/index.html`, { waitUntil: 'load', timeout: 60000 })
                await settled(dp, 500)
                await dp.waitForFunction(async () => !(await navigator.serviceWorker.getRegistration('/')) && !(await caches.keys()).some((k) => k.startsWith('mnfst-sw:')), { timeout: 15000 }).catch(() => { })
                const killed = await swInfo(dp)
                check('loader on a dev origin unregisters an existing worker itself', !killed.hasRegistration && killed.caches.length === 0, JSON.stringify(killed.caches))
            } finally { await run2.stop() }
        } finally { try { await run.stop() } catch (_) { } }
        await dp.close()
    } finally {
        await browser.close()
    }

    console.log('\n---- numbers ----')
    console.log(JSON.stringify(runs, null, 2))
    console.log(`\n${results.length - failed}/${results.length} checks passed`)
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
