/**
 * Components vs router load order, in real Chromium. The server holds the
 * router script back so the components plugin boots first (the order that
 * hydrated every route-hidden component), or serves it as an early author tag.
 *
 *   a) late router: off-route components never load; on-route ones do
 *   b) late router: placeholders added after boot inside a hidden route stay put
 *   c) late router: route change still swaps in / reverts (listener registered)
 *   d) late router: ungated components don't wait for it
 *   e) early router: same result
 *   f) no router: everything swaps in
 *   g) mnfst-render: each route's page has only its own components
 *
 * Run: npm run build && node tests/e2e/components-router-race.e2e.mjs
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

const COMPONENTS = {
    free: '<div class="c-free">free</div>',
    a: '<div class="c-a">a</div>',
    b: '<div class="c-b">b</div>',
    late: '<div class="c-late">late</div>',
    nav: '<nav><a id="to-a" href="/a">A</a> <a id="to-b" href="/b">B</a></nav>'
}
const MANIFEST = { name: 'x', components: Object.keys(COMPONENTS).map((n) => `components/${n}.html`) }

const page = ({ plugins, early = false }) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="manifest" href="/manifest.json">
${early ? '<script src="/fw/manifest.router.js"></script>' : ''}
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="${plugins}" data-alpine="/alpine.js"></script></head>
<body x-data>
  <x-nav></x-nav>
  <x-free></x-free>
  <x-a x-route="/a"></x-a>
  <x-b x-route="/b"></x-b>
  <div id="pane-b" x-route="/b"></div>
</body></html>`

function serve() {
    const hits = []
    const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://x')
        const p = u.pathname
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
        if (p === '/a' || p === '/b' || p === '/') {
            const html = mode === 'none' ? page({ plugins: 'components' })
                : mode === 'early' ? page({ plugins: 'components,router', early: true })
                : page({ plugins: 'components,router' })
            res.writeHead(200, { 'Content-Type': 'text/html' })
            return res.end(html)
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

const state = (pg) => pg.evaluate(() => ({
    routing: !!window.ManifestRouting,
    rendered: ['free', 'a', 'b', 'late'].filter((n) => document.querySelector('.c-' + n))
}))
const fetched = (srv, since) => [...new Set(srv.hits.filter((h) => h.at >= since && h.p.startsWith('/components/')).map((h) => h.p.slice(12, -5)))].sort()

async function boot(browser, srv, mode, route) {
    const pg = await browser.newPage()
    await pg.setCookie({ name: 'mode', value: mode, url: srv.url })
    const t0 = Date.now()
    await pg.goto(srv.url + route, { waitUntil: 'domcontentloaded' })
    return { pg, t0 }
}

async function run(browser, srv) {
    // a, d: late router
    {
        const { pg, t0 } = await boot(browser, srv, 'late', '/a')
        await pg.waitForSelector('.c-free', { timeout: 10000 }).catch(() => {})
        const early = await state(pg)
        check('late router: probe — components booted before the router', !early.routing, JSON.stringify(early))
        check('late router: ungated component swapped in without waiting', early.rendered.includes('free'), JSON.stringify(early))
        check('late router: no gated component before the router', !early.rendered.includes('a') && !early.rendered.includes('b'), JSON.stringify(early))
        // b: added after boot inside a hidden route, before the router arrives
        await pg.evaluate(() => { document.getElementById('pane-b').innerHTML = '<x-late x-route="/b"></x-late>' })
        await pg.waitForFunction(() => !!window.ManifestRouting, { timeout: 10000 }).catch(() => {})
        await wait(600)
        const after = await state(pg)
        check('late router: on-route component swaps in once it arrives', after.rendered.includes('a'), JSON.stringify(after))
        check('late router: off-route component never rendered', !after.rendered.includes('b'), JSON.stringify(after))
        const got = fetched(srv, t0)
        check('late router: off-route components never fetched (incl. one added after boot)', !got.includes('b') && !got.includes('late'), got.join(','))
        // c: route change after a late router
        await pg.click('#to-b')
        await wait(600)
        const onB = await state(pg)
        check('late router: route change swaps in b and reverts a', onB.rendered.includes('b') && !onB.rendered.includes('a') && onB.rendered.includes('late'), JSON.stringify(onB))
        await pg.close()
    }
    // e: early router
    {
        const { pg, t0 } = await boot(browser, srv, 'early', '/a')
        await pg.waitForSelector('.c-a', { timeout: 10000 }).catch(() => {})
        await wait(500)
        const s = await state(pg)
        check('early router: on-route + ungated in, off-route out', s.rendered.join() === 'free,a', JSON.stringify(s))
        check('early router: off-route never fetched', !fetched(srv, t0).includes('b'), fetched(srv, t0).join(','))
        await pg.close()
    }
    // f: no router
    {
        const { pg } = await boot(browser, srv, 'none', '/a')
        await pg.waitForSelector('.c-b', { timeout: 10000 }).catch(() => {})
        const s = await state(pg)
        check('no router: every component swaps in', s.rendered.join() === 'free,a,b' && !s.routing, JSON.stringify(s))
        await pg.close()
    }
}

function prerender() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'mnfst-components-router-race-'))
    try {
        fs.cpSync(FW, path.join(dir, 'fw'), { recursive: true })
        fs.mkdirSync(path.join(dir, 'components'))
        for (const [n, html] of Object.entries(COMPONENTS)) fs.writeFileSync(path.join(dir, 'components', n + '.html'), html)
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...MANIFEST, render: { paths: ['a', 'b'] } }))
        fs.copyFileSync(ALPINE, path.join(dir, 'alpine.js'))
        fs.writeFileSync(path.join(dir, 'index.html'), page({ plugins: 'components,router' }))
        const r = spawnSync('node', [path.join(ROOT, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: dir, encoding: 'utf8', timeout: 240000 })
        check('prerender: exit 0', r.status === 0, r.status === 0 ? '' : (r.stdout + r.stderr).split('\n').slice(-8).join(' / '))
        const read = (p) => { try { return fs.readFileSync(path.join(dir, 'website', p), 'utf8') } catch { return '' } }
        const a = read('a/index.html'), b = read('b/index.html')
        check('prerender: /a has free + a, not b', a.includes('c-free') && a.includes('c-a') && !a.includes('c-b'))
        check('prerender: /b has free + b, not a', b.includes('c-free') && b.includes('c-b') && !b.includes('c-a'))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

async function main() {
    if (!process.env.SKIP_PRERENDER) prerender()
    const srv = await serve()
    try {
        const chrome = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
        try { await run(chrome, srv) } finally { await chrome.close() }
    } finally { await srv.close() }
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
