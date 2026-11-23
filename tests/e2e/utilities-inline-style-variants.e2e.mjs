/**
 * Theme vars declared in an inline <style> get variant rules (dark:, hover:, md:),
 * same as vars from a linked stylesheet, in real Chromium.
 *
 * Tailwind's runtime <style> and the baked utilities sheet are not theme sources:
 * new classes on a data-tailwind page keep the theme key and take delta writes,
 * and baked classes don't get variants.
 *
 * Run: npm run build && node tests/e2e/utilities-inline-style-variants.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const THEME = ':root{--color-brand: rgb(255, 0, 0)}'
const BODY = `<body x-data><div id="t" class="dark:bg-brand hover:text-brand md:bg-brand">t</div></body></html>`
const BAKED = '.baked-card{border:1px solid red}'
const head = (style, attrs = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">${style}
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="utilities"${attrs}></script></head>`
const PAGES = {
    '/inline': head(`<style>${THEME}</style>`) + BODY,
    '/linked': head('<link rel="stylesheet" href="/theme.css">') + BODY,
    '/tailwind': head(`<style>${THEME}</style>`, ' data-tailwind') + BODY,
    '/baked': head(`<style data-mnfst-utilities>${BAKED}</style><style>${THEME}</style>`) + BODY
}

async function serve() {
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p.startsWith('/fw/')) {
            const file = path.join(ROOT, 'lib', p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' })
            return res.end(fs.readFileSync(file))
        }
        if (p === '/theme.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(THEME) }
        if (!PAGES[p]) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(PAGES[p])
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://localhost:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) }) })))
}

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const WANT = ['dark\\:bg-brand', 'hover\\:text-brand', 'md\\:bg-brand']

const compiled = (page) => page.evaluate((want) => {
    const text = Array.from(document.styleSheets).map((s) => { try { return Array.from(s.cssRules).map((r) => r.cssText).join('\n') } catch { return '' } }).join('\n')
    return Object.fromEntries(want.map((w) => [w, text.includes(w)]))
}, WANT)

async function main() {
    const srv = await serve()
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        for (const route of ['/linked', '/inline']) {
            const ctx = await browser.createBrowserContext()
            const page = await ctx.newPage()
            await page.setViewport({ width: 1200, height: 800 })
            await page.goto(srv.url + route, { waitUntil: 'load' })
            await page.waitForFunction(() => window.__manifestUtilitiesReady && !window.__manifestUtilitiesPending, { timeout: 10000, polling: 50 }).catch(() => { })
            await new Promise((r) => setTimeout(r, 300))
            const got = await compiled(page)
            for (const w of WANT) check(`${route}: ${w.replace('\\', '')} rule emitted`, got[w])
            const bg = await page.evaluate(() => getComputedStyle(document.getElementById('t')).backgroundColor)
            check(`${route}: md:bg-brand applies at 1200px`, bg === 'rgb(255, 0, 0)', bg)
            await page.hover('#t')
            const color = await page.evaluate(() => getComputedStyle(document.getElementById('t')).color)
            check(`${route}: hover:text-brand applies on hover`, color === 'rgb(255, 0, 0)', color)
            await ctx.close()
        }

        for (const route of ['/tailwind', '/baked']) {
            const ctx = await browser.createBrowserContext()
            const page = await ctx.newPage()
            await page.setViewport({ width: 1200, height: 800 })
            await page.goto(srv.url + route, { waitUntil: 'load' })
            await page.waitForFunction(() => window.__manifestUtilitiesReady && !window.__manifestUtilitiesPending, { timeout: 10000, polling: 50 }).catch(() => { })
            await new Promise((r) => setTimeout(r, 1500))
            const churn = await page.evaluate(async () => {
                const c = window.ManifestUtilities
                const ms = document.getElementById('manifest-styles')
                const keys = new Set([c.lastThemeKey])
                let writes = 0
                new MutationObserver(() => writes++).observe(ms, { childList: true, characterData: true, subtree: true })
                for (let i = 0; i < 6; i++) {
                    const d = document.createElement('div')
                    d.className = `hover:bg-brand md:p-${i + 1} m-${i + 1} md:baked-card`
                    document.body.appendChild(d)
                    await new Promise((r) => setTimeout(r, 400))
                    keys.add(c.lastThemeKey)
                }
                return { keys: keys.size, writes, mdBaked: ms.textContent.includes('md\\:baked-card'), custom: c.customUtilities.has('baked-card') }
            })
            check(`${route}: theme key stable across new classes`, churn.keys <= 2, JSON.stringify(churn))
            check(`${route}: new classes take delta writes, not full rewrites`, churn.writes <= 2, JSON.stringify(churn))
            if (route === '/baked') check('/baked: baked classes are not custom utilities', !churn.mdBaked && !churn.custom, JSON.stringify(churn))
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
