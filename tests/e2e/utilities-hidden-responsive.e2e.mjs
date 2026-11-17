/**
 * Responsive Manifest display classes vs Tailwind's unprefixed `hidden`, in real Chromium.
 *
 *   hidden lg:row  → none below lg, flex at lg
 *   row lg:hidden  → flex below lg, none at lg
 *   col md:row     → flex at both
 *
 * Cases: runtime with data-tailwind on and off, each with a Tailwind sheet loaded
 * after Manifest's; and a publish-style static bake (compileUtilities) linked
 * before a later Tailwind sheet.
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

const MARKUP = '<div id="a" class="hidden lg:row">a</div><div id="b" class="row lg:hidden">b</div><div id="c" class="col md:row">c</div>'
const LATE_TAILWIND = '<style>@layer utilities{.hidden{display:none}.lg\\:hidden{@media (width >= 64rem){display:none}}}</style>'

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
        classes: ['hidden', 'lg:row', 'row', 'lg:hidden', 'col', 'md:row'],
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

async function main() {
    const srv = await serve()
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        for (const route of ['/tw', '/plain', '/baked']) {
            for (const [width, want] of [[800, { a: 'none', b: 'flex', c: 'flex' }], [1200, { a: 'flex', b: 'none', c: 'flex' }]]) {
                const page = await browser.newPage()
                await page.setViewport({ width, height: 600 })
                await page.goto(srv.url + route, { waitUntil: 'load' })
                await wait(route === '/baked' ? 200 : 1500)
                const got = await page.evaluate(() => Object.fromEntries(['a', 'b', 'c'].map((id) => [id, getComputedStyle(document.getElementById(id)).display])))
                check(`${route} @${width}px: hidden lg:row / row lg:hidden / col md:row`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got))
                await page.close()
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
