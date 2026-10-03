/**
 * Real-Chrome guard for the incremental utilities apply (insertRule deltas):
 * 1. after a sequence of deltas, the live @layer rule order equals a full regen's;
 * 2. responsive cascade matches a reload (lg: beats md: regardless of discovery order);
 * 3. inserted rules survive #manifest-styles being moved (anything appended to <head>).
 *
 * Run: node tests/e2e/utilities-delta.e2e.mjs
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

const HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>delta</title>
<link rel="stylesheet" href="/styles/core/manifest.theme.css">
<link rel="stylesheet" href="/styles/utilities/manifest.utilities.css">
<link rel="stylesheet" href="/styles/utilities/manifest.colors.css">
<script src="/scripts/manifest.utilities.js"></script>
<script defer src="/__alpine.js"></script></head>
<body x-data><div id="host" class="p-2 bg-surface-2">x</div></body></html>`

// Discovery order chosen to trip every placement case: later var before earlier, same-slot variants, opacity, custom
const STEPS = [
    'bg-red-100', 'lg:bg-blue-500', 'md:bg-red-500 lg:bg-blue-500', 'text-blue-500', 'text-red-500',
    'hover:bg-blue-500', 'focus:bg-blue-500', 'bg-blue-500/50', 'bg-blue-500/20', 'md:border-green-500',
    'sm:border-green-500', 'hover:text-red-500 md:text-red-500', 'bg-amber-200', 'dark:bg-amber-200', 'md:row lg:col'
]

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            let f = null
            if (u.pathname === '/__alpine.js') f = ALPINE
            else if (/^\/(scripts|styles)\//.test(u.pathname)) f = path.join(SRC, u.pathname)
            if (f) {
                if (!existsSync(f)) { res.writeHead(404); return res.end() }
                res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'text/javascript' })
                return res.end(readFileSync(f))
            }
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(HTML)
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const liveRules = (page) => page.evaluate(() => {
    const layer = [...document.getElementById('manifest-styles').sheet.cssRules].find((r) => r instanceof CSSLayerBlockRule)
    return layer ? [...layer.cssRules].map((r) => r.cssText) : []
})
const add = (page, id, cls) => page.evaluate((id, cls) => {
    const d = document.createElement('div'); d.id = id; d.className = cls; d.textContent = id; document.body.appendChild(d)
}, id, cls)
const bg = (page, id) => page.evaluate((id) => getComputedStyle(document.getElementById(id)).backgroundColor, id)

async function main() {
    const server = await serve()
    const url = `http://127.0.0.1:${server.address().port}/`
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
    const fails = []
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1400, height: 900 })
        const errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        await page.goto(url)
        await wait(2500)
        await page.evaluate(() => { window.__writes = 0; new MutationObserver(() => window.__writes++).observe(document.getElementById('manifest-styles'), { childList: true, characterData: true, subtree: true }) })

        for (let i = 0; i < STEPS.length; i++) { await add(page, 's' + i, STEPS[i]); await wait(400) }
        const writes = await page.evaluate(() => window.__writes)
        const live = await liveRules(page)
        const textMatchesBeforeMove = await page.evaluate(() => !!window.ManifestUtilities._applied && !window.ManifestUtilities._applied.dirty)

        // 3. Anything appended to <head> moves the style element: inserted rules must survive
        await page.evaluate(() => { const m = document.createElement('meta'); m.name = 'probe'; document.head.appendChild(m) })
        await wait(300)
        const afterMove = await liveRules(page)
        if (afterMove.join('\n') !== live.join('\n')) fails.push(`rules changed on head append (${live.length} -> ${afterMove.length})`)
        const s2AfterMove = await bg(page, 's2')

        // 1. Force a full regen from the same DOM and compare rule order
        await page.evaluate(async () => {
            const c = window.ManifestUtilities
            c._applied = null; c.lastClassesHash = 'force'; c.lastCompileTime = 0
            await c.compile()
        })
        const full = await liveRules(page)
        if (full.join('\n') !== live.join('\n')) {
            const i = full.findIndex((r, k) => r !== live[k])
            fails.push(`live order != full regen at #${i}: live ${live[i]} | full ${full[i]}`)
        }

        // 2. Reload: same cascade as live
        const s2Live = await bg(page, 's2')
        const fresh = await browser.newPage()
        await fresh.setViewport({ width: 1400, height: 900 })
        await fresh.goto(url)
        await wait(1500)
        for (let i = 0; i < STEPS.length; i++) await add(fresh, 's' + i, STEPS[i])
        await wait(1500)
        const s2Reload = await bg(fresh, 's2')
        if (s2Live !== s2Reload || s2AfterMove !== s2Live) fails.push(`md/lg cascade differs: live ${s2Live}, after move ${s2AfterMove}, reload ${s2Reload}`)
        if (errors.length) fails.push('page errors: ' + errors.join('; '))

        console.log(JSON.stringify({ steps: STEPS.length, rules: live.length, textWritesDuringDeltas: writes, dirtyBeforeMove: !textMatchesBeforeMove, s2: s2Live }))
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error('FAIL\n  ' + fails.join('\n  ')); process.exitCode = 1 }
    else console.error('PASS')
}

main().catch((e) => { console.error(e); process.exit(1) })
