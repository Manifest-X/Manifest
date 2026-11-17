/**
 * <template data-head> per route, in real Chromium and through mnfst-render.
 *
 *   a) client-side navigation across sibling routes keeps one <title>, one
 *      description and one og:title, document.title follows the route, and the
 *      static index.html tags come back on a route without its own
 *   b) prerendered pages carry exactly one of each, with the route's values
 *
 * Run: npm run build && node tests/e2e/route-head.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const ROUTES = ['/', 'products', 'services', 'about', 'contact']
const label = (r) => (r === '/' ? 'home' : r)
const headFor = (r) => `<template data-head>
    <title>${label(r)} | Site</title>
    <meta name="description" content="${label(r)} description">
    <meta property="og:title" content="${label(r)} og">
    <meta property="og:description" content="${label(r)} og description">
  </template>`

const html = (fw) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Static title</title>
<meta name="description" content="Static description">
<link rel="stylesheet" href="${fw}/manifest.css">
<script src="${fw}/manifest.js" data-plugin-base="${fw}" data-plugins="router"></script></head>
<body x-data>
  <nav>${ROUTES.map((r) => `<a id="to-${label(r)}" href="/${r === '/' ? '' : r}">${label(r)}</a>`).join(' ')} <a id="to-plain" href="/plain">plain</a></nav>
  ${ROUTES.map((r) => `<div x-route="${r}">${headFor(r)}<h1>${label(r)}</h1></div>`).join('\n  ')}
  <div x-route="plain"><h1>plain</h1></div>
</body></html>`

function serve() {
    const page = html('/fw')
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p.startsWith('/fw/')) {
            const file = path.join(ROOT, 'lib', p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' })
            return res.end(fs.readFileSync(file))
        }
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(page)
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://localhost:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) }) })))
}

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const headState = (page) => page.evaluate(() => ({
    titles: document.head.querySelectorAll('title').length,
    title: document.title,
    descriptions: document.head.querySelectorAll('meta[name="description"]').length,
    description: document.head.querySelector('meta[name="description"]')?.content,
    ogTitles: document.head.querySelectorAll('meta[property="og:title"]').length,
    ogDescriptions: document.head.querySelectorAll('meta[property="og:description"]').length
}))

async function clientNav(browser, base) {
    const page = await browser.newPage()
    try {
        await page.goto(base + '/', { waitUntil: 'load' })
        await wait(800)
        let s = await headState(page)
        check('landing: one title, route title wins over static', s.titles === 1 && s.title === 'home | Site' && s.descriptions === 1 && s.description === 'home description', JSON.stringify(s))
        for (const r of ['products', 'services', 'about', 'contact', '/', 'products']) {
            await page.click(`#to-${label(r)}`)
            await wait(400)
            s = await headState(page)
            check(`nav to ${label(r)}: one of each tag, title follows route`,
                s.titles === 1 && s.title === `${label(r)} | Site` && s.descriptions === 1 && s.description === `${label(r)} description` && s.ogTitles === 1 && s.ogDescriptions === 1,
                JSON.stringify(s))
        }
        await page.click('#to-plain')
        await wait(400)
        s = await headState(page)
        check('route without data-head restores static title and description', s.titles === 1 && s.title === 'Static title' && s.description === 'Static description' && s.ogTitles === 0, JSON.stringify(s))
    } catch (e) {
        check('client nav: run', false, e.message)
    } finally { await page.close() }
}

function prerender() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'mnfst-route-head-'))
    try {
        fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'fw'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'x', render: { paths: ['products', 'about', 'plain'] } }))
        fs.writeFileSync(path.join(dir, 'index.html'), html('/fw'))
        const r = spawnSync('node', [path.join(ROOT, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: dir, encoding: 'utf8', timeout: 240000 })
        check('prerender: exit 0', r.status === 0, r.status === 0 ? '' : (r.stdout + r.stderr).split('\n').slice(-8).join(' / '))
        const read = (p) => { try { return fs.readFileSync(path.join(dir, 'website', p), 'utf8') } catch { return '' } }
        const headOf = (s) => (s.match(/<head[\s\S]*?<\/head>/i) || [''])[0]
        const n = (s, re) => (s.match(re) || []).length
        for (const [file, name] of [['index.html', 'home'], ['products/index.html', 'products'], ['about/index.html', 'about']]) {
            const h = headOf(read(file))
            const titles = n(h, /<title[\s>]/gi)
            const desc = n(h, /<meta[^>]*name="description"/gi)
            const og = n(h, /<meta[^>]*property="og:title"/gi)
            check(`prerender ${file}: one title, description and og:title, with the route's values`,
                titles === 1 && desc === 1 && og === 1 && (h.match(/<title[^>]*>([^<]*)<\/title>/) || [])[1] === `${name} | Site` && h.includes(`content="${name} description"`),
                JSON.stringify({ titles, desc, og, title: (h.match(/<title[^>]*>[^<]*<\/title>/) || [])[0] }))
        }
        const plain = headOf(read('plain/index.html'))
        check('prerender plain/index.html: static title kept, no route tags', n(plain, /<title[\s>]/gi) === 1 && plain.includes('<title>Static title</title>') && !plain.includes('data-route-head'),
            (plain.match(/<title>[^<]*<\/title>/g) || []).join(' '))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

async function main() {
    prerender()
    const srv = await serve()
    try {
        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
        try { await clientNav(browser, srv.url) } finally { await browser.close() }
    } finally { await srv.close() }
    console.log(failed ? `\n${failed} failed` : '\nall passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
