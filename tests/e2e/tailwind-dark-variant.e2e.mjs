/**
 * Tailwind dark: under data-tailwind follows $color's .dark class, not the OS, in real Chromium.
 *
 *   OS light + theme dark  → dark: applies
 *   OS dark  + theme light → dark: does not apply
 *   x-color toggle flips it either way
 *
 * Run: npm run build && node tests/e2e/tailwind-dark-variant.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ON = 'underline'

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="utilities,color" data-tailwind></script></head>
<body x-data><div id="t" class="dark:underline">t</div><button id="toggle" x-color="toggle">toggle</button></body></html>`

async function serve() {
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p.startsWith('/fw/')) {
            const file = path.join(ROOT, 'lib', p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' })
            return res.end(fs.readFileSync(file))
        }
        if (p !== '/') { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(PAGE)
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://localhost:${server.address().port}/`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) }) })))
}

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const state = (page) => page.evaluate(() => ({
    html: document.documentElement.className,
    deco: getComputedStyle(document.getElementById('t')).textDecorationLine
}))

async function expectDark(page, on, label) {
    await page.waitForFunction((want) => {
        const el = document.getElementById('t')
        const deco = getComputedStyle(el).textDecorationLine
        const compiled = Array.from(document.styleSheets).some((s) => { try { return Array.from(s.cssRules).some((r) => r.cssText.includes('dark\\:underline')) } catch { return false } })
        return compiled && (deco === 'underline') === want
    }, { timeout: 10000, polling: 50 }, on).catch(() => { })
    const got = await state(page)
    check(label, (got.deco === ON) === on, JSON.stringify(got))
}

async function main() {
    const srv = await serve()
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        for (const [os, theme, on] of [['light', 'dark', true], ['dark', 'light', false]]) {
            const ctx = await browser.createBrowserContext()
            const page = await ctx.newPage()
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: os }])
            await page.evaluateOnNewDocument((t) => localStorage.setItem('theme', t), theme)
            await page.goto(srv.url, { waitUntil: 'load' })
            await expectDark(page, on, `OS ${os} + theme ${theme}: dark: ${on ? 'applies' : 'stays off'}`)
            await page.click('#toggle')
            await expectDark(page, !on, `OS ${os} + toggled to ${on ? 'light' : 'dark'}: dark: ${on ? 'stays off' : 'applies'}`)
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
