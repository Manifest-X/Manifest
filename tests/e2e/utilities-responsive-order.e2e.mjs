/**
 * Responsive @media order in real Chromium: computed styles follow Tailwind v4
 * (max-* widest first, then min-width ascending) whatever the theme-variable
 * order, at 500 / 700 / 900 / 1000 / 1100 / 1300px.
 *
 * Routes: runtime with data-tailwind on and off (static markup + classes added
 * after load in reverse breakpoint order, i.e. the incremental path), and a
 * page carrying only the node-baked sheet (static bake, no runtime).
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
<p id="l" class="md:lead-b lg:lead-a">l</p>`

// Added after load one class at a time, largest breakpoint first
const DYN = {
    dt: ['xl:text-a', 'lg:text-b', 'md:text-c', 'sm:text-d', 'text-e'],
    dx: ['max-lg:text-c', 'max-md:text-b', 'max-sm:text-a']
}
const DYN_MARKUP = Object.entries(DYN).map(([id, cls]) => `<p id="${id}" class="${cls.join(' ')}">${id}</p>`).join('\n')

// null = falls back to the unstyled value
const EXPECT = {
    500: { t: E, x: A, s: null, m: null, l: null },
    700: { t: D, x: B, s: null, m: null, l: null },
    900: { t: C, x: C, s: B, m: A, l: '20px' },
    1000: { t: C, x: C, s: B, m: B, l: '20px' },
    1100: { t: B, x: null, s: C, m: C, l: '10px' },
    1300: { t: A, x: null, s: C, m: C, l: '10px' }
}
const withDyn = (w) => ({ ...w, dt: w.t, dx: w.x })

const runtimePage = (tw) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">${THEME}
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="utilities"${tw ? ' data-tailwind' : ''}></script></head>
<body>${MARKUP}</body></html>`

async function staticPage() {
    const baseCss = fs.readFileSync(path.join(ROOT, 'lib', 'manifest.css'), 'utf8')
    const html = MARKUP + DYN_MARKUP
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

const READ = (ids) => {
    const out = {}
    for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) continue
        out[id] = id === 'l' ? getComputedStyle(el).lineHeight : getComputedStyle(el).color
    }
    return out
}
const matches = (got, want, base) => Object.entries(want).every(([k, v]) => got[k] === (v === null ? (k === 'l' ? base.lh : base.color) : v))

const liveRules = (p) => p.evaluate(() => {
    const layer = [...document.getElementById('manifest-styles').sheet.cssRules].find((r) => r instanceof CSSLayerBlockRule)
    return layer ? [...layer.cssRules].map((r) => r.cssText) : []
})

async function run(browser, srv, route, width) {
    const ctx = await browser.createBrowserContext()
    const p = await ctx.newPage()
    const errors = []
    p.on('pageerror', (e) => errors.push(e.message))
    await p.setViewport({ width, height: 600 })
    await p.goto(srv.url + route, { waitUntil: 'load' })
    const base = await p.evaluate(() => {
        const q = document.createElement('p'); document.body.appendChild(q)
        const s = getComputedStyle(q); const out = { color: s.color, lh: s.lineHeight }; q.remove()
        return out
    })
    const runtime = route !== '/static'
    if (runtime) {
        await new Promise((r) => setTimeout(r, 800))
        await p.evaluate(() => { for (const id of ['dt', 'dx']) { const d = document.createElement('p'); d.id = id; d.textContent = id; document.body.appendChild(d) } })
        const steps = Math.max(...Object.values(DYN).map((c) => c.length))
        for (let i = 0; i < steps; i++) {
            await p.evaluate((dyn, i) => { for (const [id, cls] of Object.entries(dyn)) if (cls[i]) document.getElementById(id).classList.add(cls[i]) }, DYN, i)
            await new Promise((r) => setTimeout(r, 350))
        }
    }
    const want = withDyn(EXPECT[width])
    const ids = Object.keys(want)
    await p.waitForFunction(`(() => { const READ = ${READ.toString()}; const matches = ${matches.toString()}; return matches(READ(${JSON.stringify(ids)}), ${JSON.stringify(want)}, ${JSON.stringify(base)}) })()`, { timeout: 8000, polling: 50 }).catch(() => { })
    await new Promise((r) => setTimeout(r, 200))
    const got = await p.evaluate(READ, ids)
    check(`${route} @${width}px computed styles`, matches(got, want, base), JSON.stringify({ got, base }))

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
        const after = await p.evaluate(READ, ids)
        check(`${route} @${width}px computed styles after full regen`, matches(after, want, base), JSON.stringify(after))
    }
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
