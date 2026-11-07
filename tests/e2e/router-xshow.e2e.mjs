/**
 * Router visibility vs x-show (and author inline display), in real browsers.
 *
 *   a) x-route + x-show on one element: visible only when both say so,
 *      including with a class that sets display
 *   b) an author's inline display survives route hide/show
 *   c) without manifest.css, an inactive route with a display class stays hidden
 *   d) mnfst-render keeps x-show content on its own route's page (even when
 *      x-show is false) and drops other routes' sections
 *
 * Chromium via puppeteer; WebKit and Firefox when playwright-core resolves
 * (MODULES_E2E_PLAYWRIGHT, as in modules.e2e.mjs).
 *
 * Run: npm run build && node tests/e2e/router-xshow.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGES = {
    '/with-css': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="router"></script></head>
<body x-data="{ open: false }">
  <a id="to-a" href="/with-css/a">A</a> <a id="to-b" href="/with-css/b">B</a>
  <button id="toggle" @click="open = !open">toggle</button>
  <section id="plain" x-route="with-css/a" x-show="open">plain</section>
  <section id="flex" class="row" x-route="with-css/a" x-show="open">flex</section>
  <section id="grid" x-route="with-css/a" style="display: grid">grid</section>
  <section id="b" x-route="with-css/b">b</section>
</body></html>`,
    '/no-css': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<style>.boxed { display: flex }</style>
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="router"></script></head>
<body x-data>
  <a id="to-a" href="/no-css/a">A</a> <a id="to-b" href="/no-css/b">B</a>
  <section id="boxed" class="boxed" x-route="no-css/a">boxed</section>
  <section id="b" x-route="no-css/b">b</section>
</body></html>`
}

function serve() {
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p.startsWith('/fw/')) {
            const file = path.join(ROOT, 'lib', p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' })
            return res.end(fs.readFileSync(file))
        }
        const page = Object.keys(PAGES).find((k) => p === k || p.startsWith(k + '/'))
        if (!page) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(PAGES[page])
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://localhost:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) }) })))
}

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const shown = (page, ids) => page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, getComputedStyle(document.getElementById(id)).display])), ids)

async function run(b, label, base) {
    const page = await b.newPage()
    try {
        await page.goto(base + '/with-css/a', { waitUntil: 'load' })
        await wait(800)
        const ids = ['plain', 'flex', 'grid', 'b']
        const is = async (want, step) => {
            const got = await shown(page, ids)
            const vis = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v !== 'none']))
            check(`${label}: ${step}`, JSON.stringify(vis) === JSON.stringify(want), JSON.stringify(got))
            return got
        }
        await is({ plain: false, flex: false, grid: true, b: false }, 'route active, x-show false: hidden')
        await page.click('#toggle'); await wait(200)
        await is({ plain: true, flex: true, grid: true, b: false }, 'route active, x-show true: shown')
        await page.click('#to-b'); await wait(400)
        await is({ plain: false, flex: false, grid: false, b: true }, 'route inactive, x-show true: hidden')
        await page.click('#toggle'); await wait(200); await page.click('#toggle'); await wait(200)
        await is({ plain: false, flex: false, grid: false, b: true }, 'route inactive, x-show toggled to true: still hidden')
        await page.click('#toggle'); await wait(200)
        await page.click('#to-a'); await wait(400)
        const back = await is({ plain: false, flex: false, grid: true, b: false }, 'route re-activated with x-show false: hidden')
        check(`${label}: author inline display survives hide/show`, back.grid === 'grid', back.grid)

        await page.goto(base + '/no-css/b', { waitUntil: 'load' })
        await wait(800)
        const noCss = await shown(page, ['boxed', 'b'])
        check(`${label}: without manifest.css an inactive route with a display class stays hidden`, noCss.boxed === 'none' && noCss.b !== 'none', JSON.stringify(noCss))
        await page.click('#to-a'); await wait(400)
        const noCssA = await shown(page, ['boxed', 'b'])
        check(`${label}: and shows with its own display when active`, noCssA.boxed === 'flex' && noCssA.b === 'none', JSON.stringify(noCssA))
    } catch (e) {
        check(`${label}: run`, false, e.message)
    } finally { await page.close() }
}

function prerender() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'mnfst-router-xshow-'))
    try {
        fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'fw'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'x', render: { paths: ['a', 'b'] } }))
        fs.writeFileSync(path.join(dir, 'index.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="router"></script></head>
<body x-data="{ open: false }">
  <section id="ra" x-route="a"><p>route a</p><p id="tip" x-show="open">tip on a</p></section>
  <section id="both" class="row" x-route="a" x-show="open">x-route and x-show on a</section>
  <section id="rb" x-route="b">route b</section>
</body></html>`)
        const r = spawnSync('node', [path.join(ROOT, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: dir, encoding: 'utf8', timeout: 240000 })
        check('prerender: exit 0', r.status === 0, r.status === 0 ? '' : (r.stdout + r.stderr).split('\n').slice(-8).join(' / '))
        const read = (p) => { try { return fs.readFileSync(path.join(dir, 'website', p), 'utf8') } catch { return '' } }
        const a = read('a/index.html'), b = read('b/index.html')
        check('prerender: /a keeps its x-show content (x-show false at render time)', a.includes('id="tip"') && a.includes('id="both"'))
        check('prerender: /a drops route b', !a.includes('id="rb"'))
        check('prerender: /b drops route a sections, including x-route + x-show', b.includes('id="rb"') && !b.includes('id="ra"') && !b.includes('id="both"'))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

async function main() {
    prerender()
    const srv = await serve()
    try {
        const chrome = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
        try { await run(chrome, 'chromium', srv.url) } finally { await chrome.close() }
        let pw = null
        try {
            const where = process.env.MODULES_E2E_PLAYWRIGHT
            pw = where ? await import(pathToFileURL(path.join(where, 'index.mjs')).href) : await import('playwright-core')
        } catch { console.log('SKIP  webkit/firefox — playwright-core not found') }
        for (const name of pw ? ['webkit', 'firefox'] : []) {
            let browser
            try { browser = await pw[name].launch() } catch (e) { console.log(`SKIP  ${name} — ${e.message.split('\n')[0]}`); continue }
            try { const ctx = await browser.newContext(); await run(ctx, name, srv.url); await ctx.close() } finally { await browser.close() }
        }
    } finally { await srv.close() }
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
