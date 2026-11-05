/**
 * Shared contract e2e: tests/fixtures/contract-app. One shared/contract.js is
 * imported by the page (import map, no build) and by a Worker (bundled).
 *
 *   a) the Worker bundle contains the contract and enforces it
 *   b) the page reads limits and statuses from the same file
 *   c) client and server reject the same input with the same codes
 *
 * The Worker is bundled with esbuild (wrangler's bundler) and served
 * in-process. Set CONTRACT_E2E_WRANGLER=<path to wrangler> to run it under a
 * real `wrangler dev` (workerd) instead. WebKit and Firefox run when
 * playwright-core resolves (MODULES_E2E_PLAYWRIGHT, as in modules.e2e.mjs).
 *
 * Run: npm run build && node tests/e2e/contract.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { build } from 'esbuild'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = path.join(ROOT, 'tests', 'fixtures', 'contract-app')
const SCRATCH = fs.mkdtempSync(path.join(tmpdir(), 'mnfst-contract-e2e-'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const contract = await import(pathToFileURL(path.join(APP, 'shared', 'contract.js')).href)

// Worker: esbuild bundle served in-process, or a real wrangler dev
async function startWorker() {
    const outfile = path.join(SCRATCH, 'worker.mjs')
    await build({ entryPoints: [path.join(APP, 'worker', 'index.js')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'silent' })
    const bundle = fs.readFileSync(outfile, 'utf8')
    check('worker bundle inlines the shared contract', bundle.includes('function validateTask') && !/from\s+["']\.\.\/shared/.test(bundle))

    if (process.env.CONTRACT_E2E_WRANGLER) {
        const port = 8700 + Math.floor(Math.random() * 200)
        const proc = spawn(process.env.CONTRACT_E2E_WRANGLER, ['dev', '--port', String(port), '--ip', '127.0.0.1', '--log-level', 'warn'], { cwd: path.join(APP, 'worker'), stdio: 'ignore' })
        const origin = `http://127.0.0.1:${port}`
        for (let i = 0; i < 120; i++) { if (await fetch(origin + '/api/limits').then((r) => r.ok, () => false)) break; await wait(500) }
        return { origin, label: 'wrangler dev', stop: () => { proc.kill('SIGTERM'); fs.rmSync(path.join(APP, 'worker', '.wrangler'), { recursive: true, force: true }) } }
    }
    const worker = (await import(pathToFileURL(outfile).href)).default
    const server = http.createServer(async (req, res) => {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const request = new Request(`http://worker${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined })
        const response = await worker.fetch(request)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.end(Buffer.from(await response.arrayBuffer()))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    return { origin: `http://127.0.0.1:${server.address().port}`, label: 'esbuild bundle', stop: () => server.close() }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' }

// Site + /fw → lib, /api → Worker
function serve(apiOrigin) {
    const server = http.createServer(async (req, res) => {
        const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        if (p.startsWith('/api/')) {
            const chunks = []
            for await (const c of req) chunks.push(c)
            const r = await fetch(apiOrigin + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined })
            res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' })
            return res.end(Buffer.from(await r.arrayBuffer()))
        }
        let file = p.startsWith('/fw/') ? path.join(ROOT, 'lib', p.slice(4)) : path.join(APP, p)
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
        if (!fs.existsSync(file)) {
            if (path.extname(p)) { res.writeHead(404); return res.end() }
            file = path.join(APP, 'index.html')
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
        res.end(fs.readFileSync(file))
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://localhost:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) }) })))
}

async function poll(page, fn, timeout = 15000) {
    const end = Date.now() + timeout
    while (Date.now() < end) { if (await page.evaluate(fn).catch(() => false)) return true; await wait(100) }
    return false
}
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent.trim() ?? null, sel)

async function journey(b, label, site, apiOrigin) {
    const page = await b.newPage()
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e.message || e)))
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errs.push(m.text()) })
    try {
        await page.goto(site.url + '/', { waitUntil: 'load' })
        await poll(page, () => document.querySelectorAll('#status option').length > 0)
        const max = await page.evaluate(() => document.querySelector('#title').maxLength)
        check(`${label}: page reads limits from the contract`, max === contract.limits.titleMax, String(max))
        const opts = await page.evaluate(() => [...document.querySelectorAll('#status option')].map((o) => o.value))
        check(`${label}: page reads statuses from the contract`, JSON.stringify(opts) === JSON.stringify(contract.statuses))

        await page.click('#save')
        await poll(page, () => document.querySelector('#title-error').textContent !== '')
        const clientCode = await text(page, '#title-error')
        const server = await fetch(apiOrigin + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '', status: 'open' }) }).then((r) => r.json())
        check(`${label}: client and Worker reject empty titles with one code`, clientCode === 'required' && server.errors?.title === 'required', `${clientCode} / ${server.errors?.title}`)

        const long = 'x'.repeat(contract.limits.titleMax + 1)
        const serverLong = await fetch(apiOrigin + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: long, status: 'open' }) }).then((r) => r.status)
        check(`${label}: Worker enforces the same limit the input carries`, serverLong === 422)

        await page.type('#title', 'Ship it')
        await page.click('#save')
        await poll(page, () => document.querySelector('#result').textContent.startsWith('Saved'))
        check(`${label}: valid task saved through the Worker`, await text(page, '#result') === 'Saved: Ship it')
        check(`${label}: no console errors`, errs.length === 0, errs.slice(0, 3).join(' | '))
    } catch (e) {
        check(`${label}: run`, false, e.message)
    } finally { await page.close() }
}

async function main() {
    const worker = await startWorker()
    console.log(`worker: ${worker.label} at ${worker.origin}`)
    const site = await serve(worker.origin)
    try {
        const limits = await fetch(worker.origin + '/api/limits').then((r) => r.json())
        check('worker serves the contract limits', JSON.stringify(limits) === JSON.stringify(contract.limits))
        const bad = await fetch(worker.origin + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', status: 'nope' }) }).then((r) => r.json())
        check('worker validates with the contract', bad.errors?.status === 'unknown-status')

        const chrome = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
        try { await journey(chrome, 'chromium', site, worker.origin) } finally { await chrome.close() }

        let pw = null
        try {
            const where = process.env.MODULES_E2E_PLAYWRIGHT
            pw = where ? await import(pathToFileURL(path.join(where, 'index.mjs')).href) : await import('playwright-core')
        } catch { console.log('SKIP  webkit/firefox — playwright-core not found') }
        for (const name of pw ? ['webkit', 'firefox'] : []) {
            let browser
            try { browser = await pw[name].launch() } catch (e) { console.log(`SKIP  ${name} — ${e.message.split('\n')[0]}`); continue }
            try { const ctx = await browser.newContext(); await journey(ctx, name, site, worker.origin); await ctx.close() } finally { await browser.close() }
        }
    } finally {
        await site.close()
        worker.stop()
        fs.rmSync(SCRATCH, { recursive: true, force: true })
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
