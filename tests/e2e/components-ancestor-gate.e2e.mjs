/**
 * Components route gate on ancestors, in real Chromium: a placeholder loads only
 * when its own x-route and every x-route ancestor are active.
 *
 *   a) wrapper sections (incl. deep nesting, comma, negation) gate their components
 *   b) a placeholder nested in an unhydrated gated placeholder stays put
 *   c) a swapped-in component's own routed section gates its nested component
 *   d) navigating into a section hydrates it; a placeholder added after boot
 *      inside a routed wrapper waits for that route
 *   e) the same with the router held back (late) and as an early author tag
 *   f) mnfst-render: each route's page has its own nested components only
 *
 * Run: npm run build && node tests/e2e/components-ancestor-gate.e2e.mjs
 * FW_DIR=<dir> serves another build's lib (e.g. the old one, to see it fail).
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FW = process.env.FW_DIR ? path.resolve(process.env.FW_DIR) : path.join(ROOT, 'lib')
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.min.js')
const ROUTER_DELAY_MS = 1500
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const NAMES = ['wa', 'wb', 'comma', 'neg', 'gate', 'nested', 'inner', 'deep', 'late']
const COMPONENTS = {
    ...Object.fromEntries(NAMES.map((n) => [n, `<div class="c-${n}">${n}</div>`])),
    shell: '<div class="c-shell"><div x-route="/b"><x-inner></x-inner></div></div>',
    nav: '<nav><a id="to-a" href="/a">A</a> <a id="to-b" href="/b">B</a> <a id="to-st" href="/s/t">ST</a></nav>'
}
const MANIFEST = { name: 'x', components: Object.keys(COMPONENTS).map((n) => `components/${n}.html`) }

const page = ({ early = false } = {}) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="manifest" href="/manifest.json">
${early ? '<script src="/fw/manifest.router.js"></script>' : ''}
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="components,router" data-alpine="/alpine.js"></script></head>
<body x-data>
  <x-nav></x-nav>
  <div x-route="/a"><x-wa></x-wa></div>
  <div x-route="/b"><section><x-wb></x-wb></section></div>
  <div x-route="/a,/c"><x-comma></x-comma></div>
  <div x-route="!/a"><x-neg></x-neg></div>
  <x-gate x-route="/a"><x-nested></x-nested></x-gate>
  <x-shell></x-shell>
  <div x-route="/s"><div><div x-route="/s/t"><x-deep></x-deep></div></div></div>
  <div id="pane" x-route="/b"></div>
</body></html>`

function serve() {
    const hits = []
    const server = http.createServer(async (req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        const mode = req.headers.cookie?.match(/mode=(\w+)/)?.[1] || 'late'
        hits.push({ p, at: Date.now() })
        if (p === '/alpine.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(ALPINE)) }
        if (p === '/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(MANIFEST)) }
        const comp = p.match(/^\/components\/(\w+)\.html$/)
        if (comp && COMPONENTS[comp[1]]) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(COMPONENTS[comp[1]]) }
        if (p.startsWith('/fw/')) {
            const file = path.join(FW, p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            if (p === '/fw/manifest.router.js' && mode === 'late') await wait(ROUTER_DELAY_MS)
            res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
            return res.end(fs.readFileSync(file))
        }
        if (['/a', '/b', '/s/t'].includes(p)) {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            return res.end(page({ early: mode === 'early' }))
        }
        res.writeHead(404); res.end()
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
        url: `http://127.0.0.1:${server.address().port}`, hits,
        close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) })
    })))
}

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const rendered = (pg) => pg.evaluate((names) => names.filter((n) => document.querySelector('.c-' + n)), [...NAMES, 'shell'])
const fetched = (srv, since) => [...new Set(srv.hits.filter((h) => h.at >= since && h.p.startsWith('/components/')).map((h) => h.p.slice(12, -5)))].filter((n) => n !== 'nav').sort()
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

async function run(browser, srv, mode) {
    const pg = await browser.newPage()
    await pg.setCookie({ name: 'mode', value: mode, url: srv.url })
    const t0 = Date.now()
    try {
        await pg.goto(srv.url + '/a', { waitUntil: 'domcontentloaded' })
        await pg.waitForFunction(() => !!window.ManifestRouting && document.querySelector('.c-wa'), { timeout: 10000 }).catch(() => {})
        // Added after boot inside the /b wrapper
        await pg.evaluate(() => { document.getElementById('pane').innerHTML = '<div><x-late></x-late></div>' })
        await wait(600)
        const onA = await rendered(pg)
        check(`${mode}: /a renders its own sections only`, same(onA, ['wa', 'comma', 'gate', 'shell']), onA.join(','))
        const gotA = fetched(srv, t0)
        // nested sits under the on-route gate placeholder, so it is eligible (its file may load before gate replaces it)
        check(`${mode}: /a never fetches off-route nested components`, same(gotA.filter((n) => n !== 'nested'), ['wa', 'comma', 'gate', 'shell']), gotA.join(','))

        const t1 = Date.now()
        await pg.click('#to-b')
        await wait(800)
        const onB = await rendered(pg)
        check(`${mode}: navigating into /b hydrates its wrapper, the shell's own /b section and the late placeholder`,
            ['wb', 'neg', 'inner', 'late'].every((n) => onB.includes(n)) && !onB.includes('deep'), onB.join(','))
        check(`${mode}: /b fetches what /b needs, nothing else`, same(fetched(srv, t1), ['wb', 'neg', 'inner', 'late']), fetched(srv, t1).join(','))

        const t2 = Date.now()
        await pg.click('#to-st')
        await wait(800)
        const onST = await rendered(pg)
        check(`${mode}: deep nesting hydrates on /s/t`, onST.includes('deep'), onST.join(','))
        check(`${mode}: /s/t fetches only the deep component`, same(fetched(srv, t2), ['deep']), fetched(srv, t2).join(','))
    } catch (e) {
        check(`${mode}: run`, false, e.message)
    } finally { await pg.close() }

    // A placeholder nested in an unhydrated gated placeholder, booted off-route
    const pg2 = await browser.newPage()
    await pg2.setCookie({ name: 'mode', value: mode, url: srv.url })
    const t3 = Date.now()
    try {
        await pg2.goto(srv.url + '/b', { waitUntil: 'domcontentloaded' })
        await pg2.waitForFunction(() => !!window.ManifestRouting && document.querySelector('.c-wb'), { timeout: 10000 }).catch(() => {})
        await wait(600)
        const got = fetched(srv, t3)
        check(`${mode}: on /b neither the gated placeholder nor its nested child loads`, !got.includes('gate') && !got.includes('nested'), got.join(','))
    } finally { await pg2.close() }
}

function prerender() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'mnfst-components-ancestor-gate-'))
    try {
        fs.cpSync(FW, path.join(dir, 'fw'), { recursive: true })
        fs.mkdirSync(path.join(dir, 'components'))
        for (const [n, html] of Object.entries(COMPONENTS)) fs.writeFileSync(path.join(dir, 'components', n + '.html'), html)
        fs.copyFileSync(ALPINE, path.join(dir, 'alpine.js'))
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...MANIFEST, render: { paths: ['a', 'b', 's/t'] } }))
        fs.writeFileSync(path.join(dir, 'index.html'), page())
        const r = spawnSync('node', [path.join(ROOT, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: dir, encoding: 'utf8', timeout: 240000 })
        check('prerender: exit 0', r.status === 0, r.status === 0 ? '' : (r.stdout + r.stderr).split('\n').slice(-8).join(' / '))
        const read = (p) => { try { return fs.readFileSync(path.join(dir, 'website', p), 'utf8') } catch { return '' } }
        const has = (html, names) => names.filter((n) => html.includes(`class="c-${n}"`))
        const a = read('a/index.html'), b = read('b/index.html'), st = read('s/t/index.html')
        check('prerender: /a has wa, comma, gate, shell only', same(has(a, NAMES.concat('shell')), ['wa', 'comma', 'gate', 'shell']), has(a, NAMES.concat('shell')).join(','))
        check('prerender: /b has wb, neg, shell + its inner', same(has(b, NAMES.concat('shell')), ['wb', 'neg', 'shell', 'inner']), has(b, NAMES.concat('shell')).join(','))
        check('prerender: /s/t has the deep component', has(st, ['deep']).length === 1, has(st, NAMES.concat('shell')).join(','))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

async function main() {
    if (!process.env.SKIP_PRERENDER) prerender()
    const srv = await serve()
    try {
        const chrome = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
        try {
            await run(chrome, srv, 'late')
            await run(chrome, srv, 'early')
        } finally { await chrome.close() }
    } finally { await srv.close() }
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
