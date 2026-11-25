/**
 * Real-Chrome guard for the utilities compiler's steady-state cost:
 * 1. the first compile arms delta mode, so the first class added after boot is an
 *    insertRule, not a full document scan + regeneration;
 * 2. with nothing to generate (a complete shipped sheet, or framework classes only) it is armed too;
 * 3. a route change runs no document scan;
 * 4. a script or meta appended to <head> does not move the sheet; a stylesheet does;
 * 5. off a dev host, stylesheets are fetched once, with no cache-busting query;
 * 6. the boot-time unlayered guesses are dropped once real rules exist (a variant beats its base class);
 * 7. a class that forces a full compile after deltas is still styled, and delta mode re-arms;
 * 8. the live rule order equals a forced full regeneration's;
 * 9. a second visit (cache replay) styles everything and arms after its first full write.
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

const page = (extraHead, hostClass = 'p-2 bg-surface-2') => `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>arming</title>
<link rel="stylesheet" href="/styles/core/manifest.theme.css">
<link rel="stylesheet" href="/styles/utilities/manifest.utilities.css">
<link rel="stylesheet" href="/styles/utilities/manifest.colors.css">
${extraHead}
<script src="/scripts/manifest.utilities.js"></script>
<script defer src="/__alpine.js"></script></head>
<body x-data><div id="host" class="${hostClass}">x</div></body></html>`

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
            if (u.pathname === '/bail') return res.end(page('', 'p-2 bg-surface-2 text-red-500 md:text-blue-500 row'))
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
const liveRules = (p) => p.evaluate(() => {
    const layer = [...document.getElementById('manifest-styles').sheet.cssRules].find((r) => r instanceof CSSLayerBlockRule)
    return layer ? [...layer.cssRules].map((r) => r.cssText) : []
})
const armed = (p) => p.evaluate(() => !!window.ManifestUtilities._applied)

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

            // Dropping the boot-time guesses changes the theme text: one full pass re-keys the sheet, then it is quiet
            await p.evaluate(() => document.dispatchEvent(new CustomEvent('manifest:components-processed')))
            await wait(700)
            const settled = await read(p)
            for (let i = 0; i < 3; i++) {
                await p.evaluate(() => document.dispatchEvent(new CustomEvent('manifest:route-change', { detail: { to: '/x' } })))
                await p.evaluate(() => document.dispatchEvent(new CustomEvent('manifest:components-processed')))
                await wait(500)
            }
            const afterRoute = await read(p)
            check(settled.scans <= 1 && afterRoute.scans === settled.scans && afterRoute.writes === settled.writes, `${route}: route changes and component events run no scan`, { settled, afterRoute })

            await p.evaluate(() => { document.head.appendChild(document.createElement('script')); const m = document.createElement('meta'); m.name = 'probe'; document.head.appendChild(m) })
            await wait(300)
            const afterScript = await read(p)
            check(afterScript.moves === 0, `${route}: a script or meta in <head> does not move the sheet`, afterScript)
            await p.evaluate(() => { const s = document.createElement('style'); s.textContent = '.late{color:red}'; document.head.appendChild(s) })
            await wait(700)
            const last = await p.evaluate(() => document.head.lastElementChild === window.ManifestUtilities.styleElement)
            check(last, `${route}: a stylesheet added to <head> still leaves ours last`)
            check((await bg(p, 'n1')) === color, `${route}: inserted rules survive the move`)

            // 6. variant over base: the unlayered boot-time guesses must be gone
            await addClass(p, 'n2', 'bg-red-500 md:bg-blue-500')
            await wait(600)
            const variant = await bg(p, 'n2')
            check(variant !== color && variant !== 'rgba(0, 0, 0, 0)', `${route}: md: beats its base class at 1400px`, { base: color, variant })
            check(await p.evaluate(() => !document.getElementById('manifest-styles-critical')), `${route}: boot-time critical styles are removed`)

            // 7. md:hidden makes the delta path bail (display classes need a full pass)
            await addClass(p, 'n3', 'md:hidden bg-green-500')
            await addClass(p, 'n4', 'bg-green-500')
            await wait(900)
            check((await bg(p, 'n4')) !== 'rgba(0, 0, 0, 0)', `${route}: a class compiled by the full pass after deltas is styled`, await bg(p, 'n4'))
            check((await bg(p, 'n1')) === color, `${route}: earlier delta rules survive the full pass`)
            check(await armed(p), `${route}: delta mode re-arms after the full pass`)
            await addClass(p, 'n5', 'bg-amber-200')
            await wait(500)
            check((await bg(p, 'n5')) !== 'rgba(0, 0, 0, 0)', `${route}: classes after the full pass still compile`)

            // 8. live order equals a forced full regeneration
            const live = await liveRules(p)
            await p.evaluate(async () => { const c = window.ManifestUtilities; c._applied = null; c.lastClassesHash = 'force'; c.lastCompileTime = 0; await c.compile() })
            const full = await liveRules(p)
            const at = full.findIndex((r, k) => r !== live[k])
            check(full.join('\n') === live.join('\n'), `${route}: live rule order equals a full regeneration`, at === -1 ? { rules: live.length } : { at, live: live[at], full: full[at] })

            // 9. second visit in the same context: the cache replays
            if (route === '/') {
                await wait(1500) // cache save is coalesced
                const again = await context.newPage()
                await again.setViewport({ width: 1400, height: 900 })
                await again.goto(`http://127.0.0.1:${port}${route}`)
                await wait(2500)
                await addClass(again, 'n1', 'bg-red-500')
                await addClass(again, 'n2', 'bg-red-500 md:bg-blue-500')
                await wait(900)
                check((await bg(again, 'n1')) === color && (await bg(again, 'n2')) === variant, `${route}: second visit styles the same`, { n1: await bg(again, 'n1'), n2: await bg(again, 'n2') })
                check(await armed(again), `${route}: second visit arms after its first write`)
            }
            check(errors.length === 0, `${route}: no page errors`, errors)
            await context.close()
        }

        // 7b. One delta, then straight into a full pass (its first write must not be undone by the sheet's move)
        {
            const context = await browser.createBrowserContext()
            const p = await context.newPage()
            await p.setViewport({ width: 1400, height: 900 })
            await p.goto(`http://127.0.0.1:${port}/bail`)
            await wait(2500)
            await addClass(p, 'd1', 'bg-red-500')
            await wait(400)
            await addClass(p, 'd2', 'md:hidden bg-green-500')
            await wait(1500)
            const d1 = await bg(p, 'd1'), d2 = await bg(p, 'd2')
            check(d2 !== 'rgba(0, 0, 0, 0)' && d1 !== 'rgba(0, 0, 0, 0)', '/bail: the full pass after one delta keeps both classes', { d1, d2 })
            check(await armed(p), '/bail: delta mode re-arms')
            await context.close()
        }

        // 5. Non-dev host: no cache-busting, one fetch per stylesheet across compiles more than the old TTL apart
        requests.length = 0
        const p = await browser.newPage()
        await p.evaluateOnNewDocument(() => {
            window.__cssFetches = []
            const original = window.fetch
            window.fetch = function (input, ...rest) { const url = String(input && input.url || input); if (url.includes('.css')) window.__cssFetches.push(url); return original.call(this, input, ...rest) }
        })
        await p.goto(`http://app.example:${port}/`)
        await wait(2500)
        await addClass(p, 'n1', 'bg-red-500')
        await wait(6000)
        await addClass(p, 'n2', 'bg-blue-500')
        await wait(800)
        const busted = requests.filter((r) => r.includes('.css') && r.includes('t='))
        check(busted.length === 0, 'non-dev host: no cache-busted stylesheet requests', busted)
        const fetched = await p.evaluate(() => window.__cssFetches)
        check(fetched.length === 3 && new Set(fetched).size === 3, 'non-dev host: the compiler fetches each stylesheet once', fetched)
        check((await bg(p, 'n2')) !== 'rgba(0, 0, 0, 0)', 'non-dev host: classes still compile')
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 }
    else console.log('\nall passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
