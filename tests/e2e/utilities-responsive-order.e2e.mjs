/**
 * Responsive @media order in real Chromium: computed styles follow Tailwind v4
 * (max-* widest first, then min-width ascending) whatever the theme-variable
 * order, at 500 / 700 / 900 / 1000 / 1100 / 1300px.
 *
 * Routes: runtime with data-tailwind on and off (static markup + never-seen classes
 * added after load in reverse breakpoint order, applied by compileDelta), and a
 * page carrying only the node-baked sheet (static bake, no runtime).
 * #v: Tailwind display classes added after load next to the display block (lg:hidden, xl:block).
 * Other at-rules sort after breakpoints: #q container query, #o portrait (every width is portrait,
 * height 1400), #pr print (checked under print media emulation).
 *
 * Run: npm run build && node tests/e2e/utilities-responsive-order.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'
import { compileUtilities, scanClasses } from '../../lib/manifest.utilities.node.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Declared a→e so variable order alone would emit larger breakpoints first
const VARS = ':root{--color-a:rgb(255, 0, 0);--color-b:rgb(0, 0, 255);--color-c:rgb(0, 128, 0);--color-d:rgb(255, 215, 0);--color-e:rgb(128, 0, 128)}'
const CUSTOM = '.lead-a{line-height:10px}.lead-b{line-height:20px}'
const THEME = `<style>${VARS}${CUSTOM}</style>`
const [A, B, C, D, E] = ['rgb(255, 0, 0)', 'rgb(0, 0, 255)', 'rgb(0, 128, 0)', 'rgb(255, 215, 0)', 'rgb(128, 0, 128)']

const MARKUP = `<p id="t" class="text-e sm:text-d md:text-c lg:text-b xl:text-a">t</p>
<p id="x" class="max-sm:text-a max-md:text-b max-lg:text-c">x</p>
<p id="s" class="md:text-a md:max-lg:text-b lg:text-c">s</p>
<p id="m" class="md:text-a min-[950px]:text-b lg:text-c">m</p>
<p id="l" class="md:lead-b lg:lead-a">l</p>
<div id="v" class="col md:row">v</div>
<div style="container-type:inline-size;width:500px"><p id="q" class="md:text-a @sm:text-b">q</p></div>
<p id="o" class="lg:text-b portrait:text-a">o</p>
<p id="pr" class="lg:text-b print:text-a">pr</p>`

// Never in MARKUP; added after load one class at a time, largest breakpoint first
const DYN = {
    dt: ['xl:bg-a', 'lg:bg-b', 'md:bg-c', 'sm:bg-d', 'bg-e'],
    dx: ['max-lg:bg-c', 'max-md:bg-b', 'max-sm:bg-a'],
    v: ['lg:hidden', 'xl:block']
}

// null = falls back to the unstyled value
const EXPECT = {
    500: { t: E, x: A, s: null, m: null, l: null, v: 'flex', q: B, o: A, pr: null },
    700: { t: D, x: B, s: null, m: null, l: null, v: 'flex', q: B, o: A, pr: null },
    900: { t: C, x: C, s: B, m: A, l: '20px', v: 'flex', q: B, o: A, pr: null },
    1000: { t: C, x: C, s: B, m: B, l: '20px', v: 'flex', q: B, o: A, pr: null },
    1100: { t: B, x: null, s: C, m: C, l: '10px', v: 'none', q: B, o: A, pr: B },
    1300: { t: A, x: null, s: C, m: C, l: '10px', v: 'block', q: B, o: A, pr: B }
}
const withDyn = (w) => ({ ...w, dt: w.t, dx: w.x })
const PROP = { l: 'lineHeight', dt: 'backgroundColor', dx: 'backgroundColor', v: 'display' }

const runtimePage = (tw) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">${THEME}
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="utilities"${tw ? ' data-tailwind' : ''}></script></head>
<body>${MARKUP}</body></html>`

async function staticPage() {
    const baseCss = fs.readFileSync(path.join(ROOT, 'lib', 'manifest.css'), 'utf8')
    // Final classes baked up front
    const html = MARKUP.replace('class="col md:row"', `class="col md:row ${DYN.v.join(' ')}"`) +
        ['dt', 'dx'].map((id) => `<p id="${id}" class="${DYN[id].join(' ')}">${id}</p>`).join('\n')
    const css = await compileUtilities({ classes: scanClasses(html), themeCss: VARS + CUSTOM, baseCss })
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">${THEME}<style>${css}</style></head><body>${html}</body></html>`
}

async function serve() {
    const pages = { '/tw': runtimePage(true), '/plain': runtimePage(false), '/static': await staticPage() }
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p.startsWith('/fw/')) {
            const file = path.join(ROOT, 'lib', p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' })
            return res.end(fs.readFileSync(file))
        }
        if (!pages[p]) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(pages[p])
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://localhost:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) }) })))
}

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const READ = (ids, prop) => {
    const out = {}
    for (const id of ids) {
        const el = document.getElementById(id)
        if (el) out[id] = getComputedStyle(el)[prop[id] || 'color']
    }
    return out
}
const matches = (got, want, base, prop) => Object.entries(want).every(([k, v]) => got[k] === (v === null ? base[prop[k] || 'color'] : v))

// First compile settled and nothing queued
const idle = (p) => p.waitForFunction(() => window.__manifestUtilitiesReady && !window.__manifestUtilitiesPending, { timeout: 8000, polling: 50 })

const liveRules = (p) => p.evaluate(() => {
    const layer = [...document.getElementById('manifest-styles').sheet.cssRules].find((r) => r instanceof CSSLayerBlockRule)
    return layer ? [...layer.cssRules].map((r) => r.cssText) : []
})

async function run(browser, srv, route, width) {
    const ctx = await browser.createBrowserContext()
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.setViewport({ width, height: 1400 })
    await p.goto(srv.url + route, { waitUntil: 'load' })
    const base = await p.evaluate(() => {
        const q = document.createElement('p'); document.body.appendChild(q)
        const s = getComputedStyle(q); const out = { color: s.color, lineHeight: s.lineHeight, backgroundColor: s.backgroundColor }; q.remove()
        return out
    })
    const runtime = route !== '/static'
    if (runtime) {
        await idle(p)
        await p.evaluate(() => {
            const c = window.ManifestUtilities, orig = c.compileDelta
            window.__deltaOk = 0
            c.compileDelta = function (...a) { const ok = orig.apply(this, a); if (ok) window.__deltaOk++; return ok }
            for (const id of ['dt', 'dx']) { const d = document.createElement('p'); d.id = id; d.textContent = id; document.body.appendChild(d) }
        })
        const steps = Math.max(...Object.values(DYN).map((c) => c.length))
        for (let i = 0; i < steps; i++) {
            await p.evaluate((dyn, i) => { for (const [id, cls] of Object.entries(dyn)) if (cls[i]) document.getElementById(id).classList.add(cls[i]) }, DYN, i)
            await new Promise((r) => setTimeout(r, 250))
            await idle(p)
        }
    }
    const want = withDyn(EXPECT[width])
    const ids = Object.keys(want)
    await p.waitForFunction(`(() => { const READ = ${READ.toString()}; const matches = ${matches.toString()}; return matches(READ(${JSON.stringify(ids)}, ${JSON.stringify(PROP)}), ${JSON.stringify(want)}, ${JSON.stringify(base)}, ${JSON.stringify(PROP)}) })()`, { timeout: 8000, polling: 50 }).catch(() => { })
    await new Promise((r) => setTimeout(r, 200))
    const got = await p.evaluate(READ, ids, PROP)
    check(`${route} @${width}px computed styles`, matches(got, want, base, PROP), JSON.stringify({ got, base }))
    if (runtime) {
        const deltas = await p.evaluate(() => window.__deltaOk)
        check(`${route} @${width}px dynamic classes applied by compileDelta`, deltas >= 1, `${deltas} delta applies`)
    }

    if (runtime) {
        // Incremental inserts must leave the same rule order a full regen writes
        const live = await liveRules(p)
        await p.evaluate(async () => {
            const c = window.ManifestUtilities
            c._applied = null; c.lastClassesHash = 'force'; c.lastCompileTime = 0
            await c.compile()
        })
        const full = await liveRules(p)
        const i = full.findIndex((r, k) => r !== live[k])
        check(`${route} @${width}px live rule order equals full regen`, live.length > 0 && live.length === full.length && i === -1, i === -1 ? `${live.length} vs ${full.length} rules` : `#${i}: live ${live[i]} | full ${full[i]}`)
        const after = await p.evaluate(READ, ids, PROP)
        check(`${route} @${width}px computed styles after full regen`, matches(after, want, base, PROP), JSON.stringify(after))
    }
    await p.emulateMediaType('print')
    const printed = await p.evaluate(() => getComputedStyle(document.getElementById('pr')).color)
    check(`${route} @${width}px print: beats lg: in print`, printed === A, printed)
    await p.emulateMediaType('screen')
    check(`${route} @${width}px no page errors`, errors.length === 0, errors.join(' | '))
    await ctx.close()
}

async function main() {
    const srv = await serve()
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        for (const route of ['/tw', '/plain', '/static']) {
            for (const width of Object.keys(EXPECT).map(Number)) await run(browser, srv, route, width)
        }
    } finally {
        await browser.close()
        await srv.close()
    }
    console.log(failed ? `\n${failed} failed` : '\nall passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
