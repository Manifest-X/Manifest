/**
 * Responsive Manifest display classes vs Tailwind's unprefixed `hidden`, in real Chromium.
 *
 *   hidden lg:row          → none, none, flex   (at 600 / 800 / 1200px)
 *   row lg:hidden          → flex, flex, none
 *   col md:row             → flex, flex, flex
 *   col md:row lg:hidden   → flex, flex, none
 *   hidden md:row lg:hidden → none, flex, none
 *
 * Cases: runtime with data-tailwind on and off, each with a Tailwind sheet loaded
 * after Manifest's (fresh storage per page, plus one reload on the localStorage
 * cached path); and a publish-style static bake (compileUtilities) linked before
 * a later Tailwind sheet.
 *
 * Run: npm run build && node tests/e2e/utilities-hidden-responsive.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const { compileUtilities } = await import(pathToFileURL(path.join(ROOT, 'lib', 'manifest.utilities.node.mjs')).href)

const CASES = {
    a: ['hidden lg:row', ['none', 'none', 'flex']],
    b: ['row lg:hidden', ['flex', 'flex', 'none']],
    c: ['col md:row', ['flex', 'flex', 'flex']],
    d: ['col md:row lg:hidden', ['flex', 'flex', 'none']],
    e: ['hidden md:row lg:hidden', ['none', 'flex', 'none']]
}
const WIDTHS = [600, 800, 1200]
const MARKUP = Object.entries(CASES).map(([id, [cls]]) => `<div id="${id}" class="${cls}">${id}</div>`).join('')
const ALL_CLASSES = [...new Set(Object.values(CASES).flatMap(([cls]) => cls.split(' ')))]
const LATE_TAILWIND = '<style>@layer utilities{.hidden{display:none}.md\\:flex{@media (width >= 48rem){display:flex}}.lg\\:hidden{@media (width >= 64rem){display:none}}}</style>'

const runtimePage = (tw) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="utilities"${tw ? ' data-tailwind' : ''}></script></head>
<body>${MARKUP}${LATE_TAILWIND}</body></html>`

const bakedPage = () => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">
<link rel="stylesheet" href="/baked.css" data-mnfst-utilities>
<link rel="stylesheet" href="/late-tailwind.css"></head>
<body>${MARKUP}</body></html>`

async function serve() {
    const baked = await compileUtilities({
        classes: ALL_CLASSES,
        baseCss: fs.readFileSync(path.join(ROOT, 'lib', 'manifest.css'), 'utf8')
    })
    const late = LATE_TAILWIND.replace(/<\/?style>/g, '')
    const pages = { '/tw': runtimePage(true), '/plain': runtimePage(false), '/baked': bakedPage() }
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p.startsWith('/fw/')) {
            const file = path.join(ROOT, 'lib', p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' })
            return res.end(fs.readFileSync(file))
        }
        if (p === '/baked.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(baked) }
        if (p === '/late-tailwind.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(late) }
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

const displays = (page) => page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, getComputedStyle(document.getElementById(id)).display])), Object.keys(CASES))

// Poll until the expected displays land (compiles are async), then report what's there
async function expectDisplays(page, width, label) {
    const i = WIDTHS.indexOf(width)
    const want = Object.fromEntries(Object.entries(CASES).map(([id, [, d]]) => [id, d[i]]))
    await page.waitForFunction((want) => Object.entries(want).every(([id, d]) => getComputedStyle(document.getElementById(id)).display === d), { timeout: 10000, polling: 50 }, want).catch(() => { })
    const got = await displays(page)
    check(`${label} @${width}px`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
}

async function main() {
    const srv = await serve()
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        for (const route of ['/tw', '/plain', '/baked']) {
            for (const width of WIDTHS) {
                // Fresh context: empty localStorage, so each page takes the cold compile path
                const ctx = await browser.createBrowserContext()
                const page = await ctx.newPage()
                await page.setViewport({ width, height: 600 })
                await page.goto(srv.url + route, { waitUntil: 'load' })
                await expectDisplays(page, width, route)
                await ctx.close()
            }
        }
        for (const route of ['/tw', '/plain']) {
            const ctx = await browser.createBrowserContext()
            const page = await ctx.newPage()
            await page.setViewport({ width: 1200, height: 600 })
            await page.goto(srv.url + route, { waitUntil: 'load' })
            await expectDisplays(page, 1200, `${route} cold`)
            const cached = await page.evaluate(() => Object.keys(localStorage).some((k) => /tailwind|utilit/i.test(k)))
            check(`${route}: utilities cache written to localStorage`, cached)
            await page.reload({ waitUntil: 'load' })
            await expectDisplays(page, 1200, `${route} cached reload`)
            await page.setViewport({ width: 800, height: 600 })
            await expectDisplays(page, 800, `${route} cached reload`)
            await ctx.close()
        }
    } finally {
        await browser.close()
        await srv.close()
    }
    console.log(failed ? `\n${failed} failed` : '\nall passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
