/**
 * Real-Chrome guard for x-dropdown triggers whose template-literal menu id changes value:
 * 1. the trigger re-points (popovertarget, aria-controls; a template menu is re-cloned) and opens the new menu;
 * 2. a menu the trigger opened closes when the id changes; a static id never re-points (its open menu stays);
 * 3. over many changes, listener counts on document, window, triggers and menus stay flat and template
 *    clones stay at one per trigger; after the triggers are torn down nothing of theirs is left.
 *
 * Run: node tests/e2e/dropdown-repoint.e2e.mjs   (DROPDOWN_SRC=<dir with scripts/> to A/B)
 */
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SRC = process.env.DROPDOWN_SRC || path.join(ROOT, 'src')
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.js')

const page = (show) => `<!doctype html><html><head><meta charset="utf-8">
<script src="/scripts/manifest.dropdowns.js"></script><script defer src="/__alpine.js"></script></head><body>
<div id="app" x-data="{ n: 0, other: 0, show: ${show} }"><template x-if="show"><div id="wrap">
  <button id="st" x-dropdown="smenu">static</button>
  <button id="dy" x-dropdown="\`dm-\${n % 2}\`">dyn</button>
  <button id="dt" x-dropdown.close="\`dt-\${n % 2}\`">dyn template</button>
  <button id="dh" x-dropdown.hover="\`dm-\${n % 2}\`">dyn hover</button>
  <div id="dc" x-dropdown.context="\`dc-\${n % 2}\`">dyn context</div>
</div></template>
  <menu popover id="smenu"><li>s</li></menu>
  <menu popover id="dm-0"><li><button>d0</button></li></menu><menu popover id="dm-1"><li><button>d1</button></li></menu>
  <menu id="dc-0"><li>c0</li></menu><menu id="dc-1"><li>c1</li></menu>
</div>
<template id="dt-0"><menu class="clone"><li>x0</li></menu></template><template id="dt-1"><menu class="clone"><li>x1</li></menu></template>
</body></html>`

function serve() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const u = new URL(req.url, 'http://x')
            const js = (file) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(file)) }
            if (u.pathname === '/__alpine.js') return js(ALPINE)
            if (u.pathname.startsWith('/scripts/')) return js(path.join(SRC, u.pathname))
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(page(u.searchParams.get('show') !== '0'))
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

const settle = (p) => p.evaluate(() => new Promise((r) => setTimeout(() => setTimeout(r, 20), 20)))

async function listeners(cdp, sels) {
    const out = {}
    for (const s of sels) {
        const expression = s === 'document' || s === 'window' ? s : `document.querySelector(${JSON.stringify(s)})`
        const { result } = await cdp.send('Runtime.evaluate', { expression })
        if (!result.objectId) { out[s] = null; continue }
        const { listeners: ls } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })
        const by = {}
        for (const l of ls) by[l.type] = (by[l.type] || 0) + 1
        out[s] = by
        await cdp.send('Runtime.releaseObject', { objectId: result.objectId })
    }
    return out
}

async function main() {
    const server = await serve()
    const base = `http://127.0.0.1:${server.address().port}`
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
    const fails = []
    const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) fails.push(label) }
    const open = async (q = '') => {
        const p = await browser.newPage()
        p.errors = []
        p.on('pageerror', (e) => p.errors.push(e.message))
        await p.goto(base + '/' + q, { waitUntil: 'load' })
        await p.waitForFunction(() => window.Alpine && Alpine.$data(document.getElementById('app')))
        await settle(p)
        return p
    }
    const bump = async (p, key = 'n') => { await p.evaluate((key) => { Alpine.$data(document.getElementById('app'))[key]++ }, key); await settle(p) }
    const wiring = (p) => p.evaluate(() => {
        const n = Alpine.$data(document.getElementById('app')).n % 2, g = (s, a) => document.querySelector(s).getAttribute(a)
        const dtMenu = document.getElementById(g('#dt', 'popovertarget'))
        return { n, dy: g('#dy', 'popovertarget'), dyAria: g('#dy', 'aria-controls'), dh: g('#dh', 'popovertarget'), dt: dtMenu && dtMenu.textContent.trim(), clones: document.querySelectorAll('body > menu.clone').length }
    })
    const openIds = (p) => p.evaluate(() => [...document.querySelectorAll(':popover-open')].map((m) => m.id || m.className))

    try {
        // 1. Re-pointing
        {
            const p = await open()
            const states = []
            for (let i = 0; i < 3; i++) { states.push(await wiring(p)); await bump(p) }
            const ok = states.every((s) => s.dy === 'dm-' + s.n && s.dyAria === s.dy && s.dh === s.dy && s.dt === 'x' + s.n && s.clones === 1)
            check(ok, 'a trigger follows its template-literal id (popovertarget, aria-controls, hover, template clone)', states)
            await p.click('#dy'); await settle(p)
            const opened = await openIds(p)
            const n = await p.evaluate(() => Alpine.$data(document.getElementById('app')).n % 2)
            check(opened.length === 1 && opened[0] === 'dm-' + n, 'clicking the re-pointed trigger opens the new menu', { opened, n })
            await p.keyboard.press('Escape'); await settle(p)

            // 2. Open menu closes on re-point; a static id is never re-pointed
            await p.click('#dy'); await settle(p)
            const before = await openIds(p)
            await bump(p)
            const after = await p.evaluate(() => ({ open: [...document.querySelectorAll(':popover-open')].map((m) => m.id), expanded: document.getElementById('dy').getAttribute('aria-expanded'), target: document.getElementById('dy').getAttribute('popovertarget') }))
            check(before.length === 1 && after.open.length === 0 && after.expanded === 'false', 'a menu the trigger opened closes when its id changes', { before, after })
            await p.click('#st'); await settle(p)
            await bump(p); await bump(p, 'other')
            const st = await openIds(p)
            check(st.length === 1 && st[0] === 'smenu', 'a static-id trigger is never re-pointed: its open menu stays open across changes', st)
            await p.keyboard.press('Escape'); await settle(p)
            check(p.errors.length === 0, 're-pointing: no page errors', p.errors)
            await p.close()
        }

        // 3. Leaks: flat over many changes, nothing left after teardown
        {
            const SEL = ['document', 'window', '#dy', '#dt', '#dh', '#dc', '#dm-0', '#dm-1', '#dc-0', '#dc-1', '#smenu']
            const baseP = await open('?show=0')
            const baseCdp = await baseP.target().createCDPSession()
            const baseline = await listeners(baseCdp, ['document', 'window'])
            await baseP.close()

            const p = await open()
            const cdp = await p.target().createCDPSession()
            await bump(p); await bump(p)
            const early = await listeners(cdp, SEL)
            for (let i = 0; i < 50; i++) await bump(p)
            const late = await listeners(cdp, SEL)
            const clones = (await wiring(p)).clones
            check(JSON.stringify(early) === JSON.stringify(late) && clones === 1, '50 id changes: listener counts on document, window, triggers and menus stay flat; one template clone', { early, late, clones })

            await p.evaluate(() => { Alpine.$data(document.getElementById('app')).show = false })
            await settle(p); await settle(p)
            const gone = await listeners(cdp, ['document', 'window', '#dm-0', '#dm-1', '#dc-0', '#dc-1', '#smenu'])
            const perTrigger = ['keydown', 'toggle', 'mouseenter', 'mouseleave', 'pointerdown']
            const menuLeft = Object.entries(gone).filter(([k]) => k.startsWith('#')).flatMap(([k, by]) => perTrigger.filter((t) => by && by[t]).map((t) => k + ':' + t))
            const docSame = JSON.stringify({ document: gone.document, window: gone.window }) === JSON.stringify(baseline)
            const left = await p.evaluate(() => ({ clones: document.querySelectorAll('body > menu.clone').length, open: document.querySelectorAll(':popover-open').length }))
            check(docSame && menuLeft.length === 0 && left.clones === 0, 'teardown: document/window listeners back to a page that never had the triggers; no per-trigger listeners on menus; no clones', { baseline, gone, menuLeft, left })
            check(p.errors.length === 0, 'leaks: no page errors', p.errors)
            await p.close()
        }
    } finally {
        await browser.close()
        server.close()
    }
    if (fails.length) { console.error(`\n${fails.length} failed`); process.exitCode = 1 }
    else console.log('\nall passed')
}

main().catch((e) => { console.error(e); process.exit(1) })
