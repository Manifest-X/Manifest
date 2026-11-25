/**
 * Real-Chrome guard for the utilities compiler's steady-state cost:
 * 1. the first compile arms delta mode, so the first class added after boot is an
 *    insertRule, not a full document scan + regeneration;
 * 2. with nothing to generate (a complete shipped sheet, or framework classes only) it is armed too;
 * 3. a route change runs no document scan;
 * 4. a script or meta appended to <head> does not move the sheet; a stylesheet does;
 * 5. off a dev host, stylesheets are fetched once, with no cache-busting query.
 *
 * Run: node tests/e2e/utilities-delta-arming.e2e.mjs
 */
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, existsSync } from 'fs'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.js')

const page = (extraHead) => `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>arming</title>
<link rel="stylesheet" href="/styles/core/manifest.theme.css">
<link rel="stylesheet" href="/styles/utilities/manifest.utilities.css">
<link rel="stylesheet" href="/styles/utilities/manifest.colors.css">
${extraHead}
<script src="/scripts/manifest.utilities.js"></script>
<script defer src="/__alpine.js"></script></head>
<body x-data><div id="host" class="p-2 bg-surface-2">x</div></body></html>`

// A manifest component: its classes are known before the first compile, which generates their rules
const REGISTRY = `<script>window.ManifestComponentsRegistry = { manifest: { components: ['card.html'] } }</script>`

const BAKED = `<style data-mnfst-utilities data-mnfst-utilities-complete>@layer utilities { .p-2 { padding: calc(var(--spacing) * 2); } .bg-surface-2 { background-color: var(--color-surface-2); } }</style>`

function serve(requests) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            requests.push(u.pathname + u.search)
            let f = null
            if (u.pathname === '/__alpine.js') f = ALPINE
            else if (/^\/(scripts|styles)\//.test(u.pathname)) f = path.join(SRC, u.pathname)
            if (f) {
                if (!existsSync(f)) { res.writeHead(404); return res.end() }
                res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/javascript', 'cache-control': 'max-age=600' })
                return res.end(readFileSync(f))
            }
            res.writeHead(200, { 'content-type': 'text/html' })
            if (u.pathname === '/card.html') return res.end('<div class="bg-amber-200 md:text-red-500">card</div>')
            res.end(page(u.pathname === '/baked' ? BAKED : u.pathname === '/generated' ? REGISTRY : ''))
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Arms counters after boot; returns the compiler's state at that point
const arm = (p) => p.evaluate(() => {
    const c = window.ManifestUtilities
    window.__scans = 0
    const scan = c.getUsedClasses
    c.getUsedClasses = function (...a) { window.__scans++; return scan.apply(this, a) }
    window.__writes = 0
    new MutationObserver(() => window.__writes++).observe(c.styleElement, { childList: true, characterData: true, subtree: true })
    window.__moves = 0
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n === c.styleElement) window.__moves++ }).observe(document.head, { childList: true })
    return { armed: !!c._applied, entries: c._applied ? c._applied.entries.length : -1 }
})
const addClass = (p, id, cls) => p.evaluate((id, cls) => {
    const d = document.createElement('div'); d.id = id; d.className = cls; d.textContent = id; document.body.appendChild(d)
}, id, cls)
const read = (p) => p.evaluate(() => ({ scans: window.__scans, writes: window.__writes, moves: window.__moves }))
const bg = (p, id) => p.evaluate((id) => getComputedStyle(document.getElementById(id)).backgroundColor, id)

async function main() {
    const requests = []
    const server = await serve(requests)
    const port = server.address().port
    // app.example resolves to the test server: a non-dev hostname
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', `--host-resolver-rules=MAP app.example 127.0.0.1`] })
    const fails = []
    const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
    try {
        for (const route of ['/', '/generated', '/baked']) {
            const context = await browser.createBrowserContext() // own localStorage: no cache replay from the page before
            const p = await context.newPage()
            await p.setViewport({ width: 1400, height: 900 })
            const errors = []
            p.on('pageerror', (e) => errors.push(e.message))
            await p.goto(`http://127.0.0.1:${port}${route}`)
            await wait(2500)
            const state = await arm(p)
            check(state.armed, `${route}: delta mode is armed after boot`, state)
            if (route === '/baked') check(state.entries === 0, `${route}: nothing generated over a complete sheet`, state)
            if (route === '/generated') check(state.entries > 0, `${route}: the first compile's rules are recorded`, state)

            await addClass(p, 'n1', 'bg-red-500')
            await wait(500)
            const afterClass = await read(p)
            const color = await bg(p, 'n1')
            check(afterClass.scans === 0 && afterClass.writes === 0, `${route}: a new class after boot is inserted without a scan or a sheet rewrite`, afterClass)
            check(color !== 'rgba(0, 0, 0, 0)', `${route}: the new class is styled`, color)

            await p.evaluate(() => document.dispatchEvent(new CustomEvent('manifest:route-change', { detail: { to: '/x' } })))
            await p.evaluate(() => document.dispatchEvent(new CustomEvent('manifest:components-processed')))
            await wait(700)
            const afterRoute = await read(p)
            check(afterRoute.scans === 0 && afterRoute.writes === 0, `${route}: route change and component events run no scan`, afterRoute)

            await p.evaluate(() => { document.head.appendChild(document.createElement('script')); const m = document.createElement('meta'); m.name = 'probe'; document.head.appendChild(m) })
            await wait(300)
            const afterScript = await read(p)
            check(afterScript.moves === 0, `${route}: a script or meta in <head> does not move the sheet`, afterScript)
            await p.evaluate(() => { const s = document.createElement('style'); s.textContent = '.late{color:red}'; document.head.appendChild(s) })
            await wait(700)
            const last = await p.evaluate(() => document.head.lastElementChild === window.ManifestUtilities.styleElement)
            check(last, `${route}: a stylesheet added to <head> still leaves ours last`)
            check((await bg(p, 'n1')) === color, `${route}: inserted rules survive the move`)
            check(errors.length === 0, `${route}: no page errors`, errors)
            await context.close()
        }

        // 5. Non-dev host: no cache-busting, one fetch per stylesheet across compiles more than the old TTL apart
        requests.length = 0
        const p = await browser.newPage()
        await p.goto(`http://app.example:${port}/`)
        await wait(2500)
        await addClass(p, 'n1', 'bg-red-500')
        await wait(6000)
        await addClass(p, 'n2', 'bg-blue-500')
        await wait(800)
        const css = requests.filter((r) => r.includes('.css'))
        const busted = css.filter((r) => r.includes('t='))
        check(busted.length === 0, 'non-dev host: no cache-busted stylesheet requests', busted)
        check(css.length <= 3, 'non-dev host: stylesheets are not re-downloaded by the compiler', css)
        check((await bg(p, 'n2')) !== 'rgba(0, 0, 0, 0)', 'non-dev host: classes still compile')
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 }
    else console.log('\nall passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
