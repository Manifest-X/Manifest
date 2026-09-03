/**
 * Regression test for the 0.5.206 client-blocking bug: a page-level
 * `<template x-if>` fed by a `$route()` proxy never renders after an in-app
 * SPA navigation, even though other bindings (a header's x-text) reading the
 * exact same data update correctly.
 *
 * Root cause (see src/scripts/data/shared/proxies/creation/manifest.data.proxies.route.js):
 * Alpine 3.x's scheduler dedupes queueJob() by reference against the queue
 * array, which is only cleared at the end of the current flush. When an x-if
 * effect ALSO depends on a plain store flag that changes in the same
 * synchronous navigation event (e.g. a "loaded" guard), that flag's write
 * lets x-if's job run — with STALE $route() data — in the same flush as the
 * $route() proxy's own effect, which runs after and updates the real data.
 * x-if's re-queue from that later write is silently dropped because its job
 * reference is already in the (not-yet-cleared) queue. The stranded x-if
 * never re-evaluates again, even though the header (a plain x-text effect,
 * not "structural" like x-if/x-for) picks up the fresh value normally.
 *
 * mnfst@0.5.206 didn't introduce this bug — it made the utilities JIT fast
 * enough that page components mount (and x-if evaluates once, falsy) before
 * the user navigates, exposing a pre-existing, unmitigated gap: the data
 * store's post-settle "bumpAllVersions()" hammer (added for the exact same
 * scheduler swallow elsewhere) never touched the $route() proxy's own
 * reactive graph.
 *
 * Fixture: src/test/xif-remount.html — two routes; route B's x-if depends on
 * both `productsLoaded` (a plain store-backed flag) and `$x.products.$route('path')`.
 *
 * This test fails on the pre-fix code (the body never appears) and passes
 * once `manifest.data.proxies.route.js` re-arms $route() consumers with a
 * post-settle version bump.
 *
 * Run: node tests/e2e/xif-remount.e2e.mjs
 */
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.XIF_REMOUNT_E2E_PORT || 5316

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function startServer(onAlreadyRunning) {
    const proc = spawn('node', ['packages/run/serve.mjs', 'src', '--port', String(PORT), '--no-open'],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const sniff = (chunk) => {
        out += String(chunk)
        const m = out.match(/already running at (http:\/\/localhost:\d+)/)
        if (m) onAlreadyRunning(m[1])
    }
    proc.stdout.on('data', sniff)
    proc.stderr.on('data', sniff)
    return proc
}

function ping(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200) })
        req.on('error', () => resolve(false))
        req.setTimeout(1000, () => { req.destroy(); resolve(false) })
    })
}

async function main() {
    let baseUrl = `http://localhost:${PORT}`
    let ownsServer = true
    const proc = startServer((existingUrl) => { baseUrl = existingUrl; ownsServer = false })

    try {
        let up = false
        for (let i = 0; i < 40 && !up; i++) {
            up = await ping(`${baseUrl}/`)
            if (!up) await wait(250)
        }
        if (!up) throw new Error(`dev server never came up at ${baseUrl}`)

        const browser = await puppeteer.launch({ headless: 'new' })
        try {
            const page = await browser.newPage()
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))

            await page.goto(`${baseUrl}/test/xif-remount.html`, { waitUntil: 'domcontentloaded' })

            // Let the page fully settle on route A (home) — products data loaded,
            // manifest:ready fired — BEFORE navigating. The bug only manifests once
            // the route-B pane's x-if has already run at least once while inactive;
            // navigating before settle would confound the result with "data not
            // loaded yet" rather than the scheduler swallow.
            await page.waitForFunction(
                () => window.__events && window.__events.some((e) => e[0] === 'manifest:render-ready'),
                { timeout: 15000 }
            )
            await wait(300)

            const before = await page.evaluate(() => ({
                bodyExists: !!document.querySelector('[data-testid="body"]'),
                headerText: document.querySelector('[data-testid="header"]')?.textContent.trim(),
            }))
            if (before.bodyExists) throw new Error(`expected route B body to be absent before navigation, got: ${JSON.stringify(before)}`)

            // Real click → pushState + manifest:route-change, exactly like production.
            await page.click('#link-widget')

            // Give the post-settle version bump (setTimeout 0) and any resulting
            // re-flush plenty of room, well beyond what a single microtask needs.
            await wait(500)

            const after = await page.evaluate(() => ({
                bodyExists: !!document.querySelector('[data-testid="body"]'),
                bodyText: document.querySelector('[data-testid="body"]')?.textContent.trim(),
                headerText: document.querySelector('[data-testid="header"]')?.textContent.trim(),
            }))

            if (pageErrors.length) {
                throw new Error(`page threw errors: ${pageErrors.join('; ')}`)
            }
            if (after.headerText !== 'Widget') {
                throw new Error(`header did not update (sanity check on the harness itself): ${JSON.stringify(after)}`)
            }
            if (!after.bodyExists || after.bodyText !== 'Widget') {
                throw new Error(
                    `x-if never rendered after navigation (Alpine scheduler swallow reproduced): ${JSON.stringify(after)}`
                )
            }

            console.log('PASS: x-if re-rendered after navigation —', JSON.stringify(after))
        } finally {
            await browser.close()
        }
    } finally {
        if (ownsServer) proc.kill()
    }
}

main().catch((err) => {
    console.error('FAIL:', err.message)
    process.exit(1)
})
