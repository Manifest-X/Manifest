/**
 * x-markdown.safe in real Chromium with the pinned DOMPurify: untrusted markdown can't run code,
 * overlay or restyle the page, submit forms, play media or drive the host's dialogs; markdown survives.
 *
 * Run: node tests/e2e/markdown-safe.e2e.mjs
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const hostile = [
    `<img src="x" onerror="hit('onerror')"><details open ontoggle="hit('ontoggle')">d</details>`,
    `<x-foo x-init="hit('custom')">c</x-foo><span x-init="hit('xinit')" :class="hit('bind')" x-icon="hit('icon')">s</span>`,
    `<svg width="1" height="1" overflow="visible"><a href="https://evil.test/p"><rect x="-3000" y="-3000" width="6000" height="6000" fill="red"/></a></svg>`,
    `<svg><g transform="translate(-2000,-2000) scale(400)"><rect width="10" height="10" fill="red"/></g></svg>`,
    `<div class="fixed inset-0 z-[9999] bg-red-500" style="position:fixed;inset:0">overlay</div>`,
    `<style>body{display:none}</style>`,
    `<form action="https://evil.test/s"><input name="password"><button>go</button></form>`,
    `<template data-head><style>body{color:red}</style></template>`,
    `<div popover id="p">p</div><button id="cmd" popovertarget="p" commandfor="dlg" command="show-modal">open</button>`,
    `<video autoplay src="https://evil.test/v.mp4"></video><audio autoplay src="https://evil.test/a.mp3"></audio>`,
    `<a id="config" name="config" data-component="x" href="https://ok.test">link</a>`,
    `<input type="image" src="https://evil.test/i.png"><table background="https://evil.test/t.png"><tr><td>t</td></tr></table>`,
].join('\n\n')
const benign = '# Intro\n\n[jump](#intro) [site](https://ok.test) <a href="#%E0%A4%A">odd</a>\n\n- [ ] task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![alt](/i.png)\n\n::: brand\nnote\n:::\n\n```js\nlet a = 1\n```'

const page = `<!doctype html><html><head>
<script>window.__hits=[];window.hit=(n)=>window.__hits.push(n);window.D=${JSON.stringify({ ready: false, hostile, benign })}</script>
<script src="/node_modules/marked/lib/marked.umd.js"></script>
<script src="/node_modules/dompurify/dist/purify.min.js"></script>
<script src="/src/scripts/manifest.markdown.js"></script>
<script defer src="/node_modules/alpinejs/dist/cdn.min.js"></script>
</head><body x-data="D" x-init="setTimeout(() => ready = true, 300)" style="margin:0">
<p id="own">Operator content</p>
<dialog id="dlg">host dialog</dialog>
<template x-if="ready"><div>
<div id="h" x-markdown.safe="hostile"></div>
<div id="b" x-markdown.safe="benign"></div>
</div></template>
</body></html>`

const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page) }
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]))
    if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end() }
    fs.readFile(file, (err, body) => {
        if (err) { res.statusCode = 404; return res.end() }
        res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(body)
    })
}).listen(0)
const base = `http://localhost:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1200, height: 900 })
    const external = []
    await tab.setRequestInterception(true)
    tab.on('request', r => {
        if (r.url().startsWith(base)) return r.continue()
        external.push(r.url()); r.abort()
    })
    await tab.goto(`${base}/`, { waitUntil: 'load' })
    await tab.waitForFunction(() => document.querySelector('#b h1') && document.querySelector('#h').childNodes.length, { timeout: 15000 })
    await wait(500)
    const cmd = await tab.$('#h button')
    if (cmd) await cmd.click().catch(() => cmd.evaluate(el => el.click()))
    await wait(300)

    const r = await tab.evaluate(() => {
        const h = document.querySelector('#h'), b = document.querySelector('#b')
        const probes = [[5, 5], [600, 450], [1190, 890]].map(([x, y]) => document.elementFromPoint(x, y)?.closest('#h svg, #h a[href*="evil"], #h div') ? 'content' : 'host')
        return {
            hits: window.__hits,
            hostile: h ? h.innerHTML : '<missing>',
            ownTop: document.querySelector('#own') && document.elementFromPoint(20, document.querySelector('#own').getBoundingClientRect().top + 5)?.id,
            probes,
            dialogOpen: document.querySelector('#dlg')?.open,
            bodyDisplay: getComputedStyle(document.body).display,
            headStyles: document.head.querySelectorAll('style').length,
            configGlobal: typeof window.config,
            anchor: b?.querySelector('a[href^="#"]')?.getAttribute('href'), h1: b?.querySelector('h1')?.id,
            site: !!b?.querySelector('a[href="https://ok.test"]'),
            checkbox: b?.querySelector('input[type="checkbox"]')?.disabled,
            cell: b?.querySelector('td')?.textContent,
            img: b?.querySelector('img')?.getAttribute('src'),
            callout: b?.querySelector('aside')?.getAttribute('class'),
            code: b?.querySelector('pre code')?.textContent,
            escaped: (b?.innerHTML || '').includes('&lt;h1'),
        }
    })

    if (!r.hits) r.hits = ['navigated away']
    check('host and content still on the page', r.hostile !== '<missing>' && r.dialogOpen !== undefined)
    check('no script or directive ran', r.hits.length === 0, r.hits)
    for (const banned of ['<svg', 'evil.test', '<style', 'style=', '<form', '<template', 'popover', 'command', '<video', '<audio', '<x-foo', 'x-init', ':class', 'x-icon', 'data-', 'class=']) {
        check(`hostile output drops ${banned}`, !r.hostile.includes(banned))
    }
    check('nothing overlays the page', r.probes.every(p => p === 'host') && r.ownTop === 'own', { probes: r.probes, ownTop: r.ownTop })
    check('host dialog stays closed', r.dialogOpen === false, r.dialogOpen)
    check('page styling untouched', r.bodyDisplay === 'block' && r.headStyles === 0, r)
    check('ids cannot claim window globals', r.configGlobal === 'undefined', r.configGlobal)
    check('no requests leave the page', external.length === 0, external)
    check('a malformed anchor leaves the message rendered', r.escaped === false && !!r.h1)
    check('in-content heading link follows its heading', r.anchor === '#' + r.h1 && !!r.h1, [r.anchor, r.h1])
    check('links, task list, table, image, callout and code survive',
        r.site && r.checkbox === false && r.cell === '1' && r.img === '/i.png' && r.callout === 'brand' && /let a = 1/.test(r.code || ''), r)
} finally {
    await browser.close()
    server.close()
}
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1) }
console.log('\nall passed')
