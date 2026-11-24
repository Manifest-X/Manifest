/**
 * Tailwind v4 breakpoint ranges in real Chromium: no "Unknown variant" warning,
 * and computed styles match at 600 / 900 / 1200px.
 *
 *   max-md:text-4xl lg:text-5xl max-lg:leading-tight lg:leading-none (the reported markup)
 *   max-md:text-brand, md:max-lg:text-accent, min-[1100px]:text-brand, max-lg:row
 *
 * Routes: data-tailwind on and off (theme vars inline so Manifest compiles them alone).
 *
 * Run: npm run build && node tests/e2e/utilities-breakpoint-range.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const THEME = `<style>:root{--color-brand:rgb(0, 0, 255);--color-accent:rgb(255, 0, 0);--text-4xl:36px;--text-5xl:48px;--leading-tight:1.25;--leading-none:1}</style>`
const MARKUP = `<h1 id="h" class="max-md:text-4xl lg:text-5xl max-lg:leading-tight lg:leading-none">Heading</h1>
<p id="c" class="max-md:text-brand md:max-lg:text-accent ">c</p>
<p id="m" class="min-[1100px]:text-brand">m</p>
<div id="r" class="max-lg:row">r</div>`

const page = (tw) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">${THEME}
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="utilities"${tw ? ' data-tailwind' : ''}></script></head>
<body>${MARKUP}</body></html>`

const EXPECT = {
    600: { size: '36px', lh: '45px', color: 'rgb(0, 0, 255)', min: null, display: 'flex' },
    900: { size: null, lh: null, color: 'rgb(255, 0, 0)', min: null, display: 'flex' },
    1200: { size: '48px', lh: '48px', color: null, min: 'rgb(0, 0, 255)', display: 'block' }
}

async function serve() {
    const pages = { '/tw': page(true), '/plain': page(false) }
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

const read = (p) => p.evaluate(() => {
    const h = getComputedStyle(document.getElementById('h'))
    const c = getComputedStyle(document.getElementById('c'))
    return {
        size: h.fontSize, lh: h.lineHeight, color: c.color,
        min: getComputedStyle(document.getElementById('m')).color, display: getComputedStyle(document.getElementById('r')).display
    }
})

// null = "not the range value" (falls back to the base style)
const matches = (got, want, base) => Object.entries(want).every(([k, v]) => v === null ? got[k] === base[k] : got[k] === v)

async function main() {
    const srv = await serve()
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        for (const route of ['/tw', '/plain']) {
            for (const width of [600, 900, 1200]) {
                const ctx = await browser.createBrowserContext()
                const p = await ctx.newPage()
                const warnings = []
                p.on('console', (m) => { if (/Unknown variant/.test(m.text())) warnings.push(m.text()) })
                await p.setViewport({ width, height: 600 })
                await p.goto(srv.url + route, { waitUntil: 'load' })
                // Baseline: what the elements look like with no range class applying
                const base = await p.evaluate(() => {
                    const el = document.createElement('h1'); el.textContent = 'x'; document.body.appendChild(el)
                    const s = getComputedStyle(el); const out = { size: s.fontSize, lh: s.lineHeight }; el.remove()
                    const q = document.createElement('p'); document.body.appendChild(q)
                    out.color = out.min = getComputedStyle(q).color; q.remove()
                    return out
                })
                await p.waitForFunction((want, base) => {
                    const h = getComputedStyle(document.getElementById('h'))
                    const c = getComputedStyle(document.getElementById('c'))
                    const got = { size: h.fontSize, lh: h.lineHeight, color: c.color, min: getComputedStyle(document.getElementById('m')).color, display: getComputedStyle(document.getElementById('r')).display }
                    return Object.entries(want).every(([k, v]) => v === null ? got[k] === base[k] : got[k] === v)
                }, { timeout: 10000, polling: 50 }, EXPECT[width], base).catch(() => { })
                await new Promise((r) => setTimeout(r, 300))
                const got = await read(p)
                check(`${route} @${width}px computed styles`, matches(got, EXPECT[width], base), JSON.stringify({ got, base }))
                check(`${route} @${width}px no "Unknown variant" warning`, warnings.length === 0, warnings.join(' | '))
                await ctx.close()
            }
        }
    } finally {
        await browser.close()
        await srv.close()
    }
    console.log(failed ? `\n${failed} failed` : '\nall passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
