/**
 * Real-Chrome guard for on-use directive modules (markdown, code, svg, combobox, slides,
 * colorpicker, datepicker, charts, virtual, export):
 * 1. a page that uses none of them requests none of them, and boots;
 * 2. a page that uses one at boot works: the module's visible effect is in the DOM, and the
 *    module is requested while manifest.json is still in flight;
 * 3. late content (modules served slowly): innerHTML, x-html, x-if, a component through
 *    Manifest.loadUsed, markdown output needing Code. An element whose module has not
 *    registered is held, then started once: its own x-data, x-init and directives (and its
 *    children's) run exactly once, for carousel, virtual, charts and datepicker; virtual never
 *    renders the whole list; held elements inside and around deferred containers start once;
 *    an attribute added to a live element later works;
 * 4. markdown renders in order: a render that resolves after a newer one is dropped;
 * 5. magics: read before the module arrives they never throw and update once it lands; a
 *    first $export/$import call from a script file runs once, after the module arrives; a
 *    captured reference forwards; a magic read only from a script file loads its module;
 * 6. no console warning or error on any page (the only exceptions are named where they occur);
 * 7. mnfst-render (derive path, built lib/): the render pass loads what the page uses and
 *    bakes it; hydration loads the modules the baked page still needs and keeps the content;
 * 8. component HTML fetched before DOMContentLoaded (a slow deferred script) loads its modules
 *    before it is inserted: nothing held, over 20 loads;
 * 9. nested holds: input typed while held reaches each handler once, in either module order;
 * 10. with DOMContentLoaded late, a slow early module or a slow image never holds up Alpine, and
 *    manifest:ready never fires before it; sibling held elements each wait only for their own module;
 * 11. a module whose file runs but registers late or never: content waits at most 1.5 s, then the
 *    hold covers the rest, and one 10 s give-up in all.
 *
 * Run: node tests/e2e/on-use-modules.e2e.mjs      (ONUSE_SRC=<dir with scripts/> to A/B)
 */
import http from 'http'
import path from 'path'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, cpSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = process.env.ONUSE_SRC || path.join(ROOT, 'src')
const ALPINE = path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js')
const MOVED = ['markdown', 'svg', 'code', 'combobox', 'slides', 'colorpicker', 'datepicker', 'charts', 'virtual', 'export']
const SLOW = 700
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// count() and the peak row count are recorded from the first node on
const HEAD = `<script>window.__c = {}; window.count = (k) => { window.__c[k] = (window.__c[k] || 0) + 1 }; window.__peak = 0
new MutationObserver(() => { const n = document.querySelectorAll('.r').length; if (n > window.__peak) window.__peak = n }).observe(document, { childList: true, subtree: true })</script>`
const page = (body, head = '', attrs = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title>
<link rel="manifest" href="/manifest.json">${HEAD}${head}
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js" ${attrs}></script>
</head><body x-data="{ open: false, html: '', n: 3 }">${body}</body></html>`

const list = (n) => `[${Array.from({ length: n }, (_, k) => `{ id: ${k}, name: 'n${k}' }`).join(',')}]`
// Each element's own x-data, x-init and a child's x-init are counted
const ONCE = (p) => `<div id="${p}car" x-carousel x-data="{ d: 'x' }" x-init="count('${p}car')"><div class="carousel-slides"><div><span x-init="count('${p}carKid')">One</span></div><div>Two</div></div><p id="${p}count" x-text="totalSlides"></p></div>
<div x-data="{ items: ${list(2000)} }"><div id="${p}v" x-virtual="{ estimate: 20 }" x-init="count('${p}v')" style="height:200px;overflow:auto"><template x-for="row in items" :key="row.id"><div class="r" style="height:20px" x-text="row.name"></div></template></div></div>
<div id="${p}ch" x-data="{ c: 1 }" x-init="count('${p}ch'); fetch('/ping/' + '${p}')" x-chart="{ type: 'bar', series: [{ data: [1, 2, 3] }] }" style="width:300px"></div>
<div id="${p}cal" x-data="{ q: 1 }" x-init="count('${p}cal')" x-date></div>`
const MD_APP = `document.addEventListener('alpine:init', () => {
  Alpine.data('exp', () => ({ result: 'none', async go() { const r = await this.$export({ format: 'csv', data: [{ a: 1 }], filename: 'x.csv' }); this.result = 'done:' + typeof r } }))
  Alpine.data('cap', () => ({ e: null, init() { this.e = this.$export }, async run() { await this.e({ format: 'csv', data: [{ b: 2 }], filename: 'y.csv' }) } }))
  Alpine.data('imp', () => ({ async pick() { window.__impCalled = (window.__impCalled || 0) + 1; this.$import({ accept: '.csv' }) } }))
  Alpine.data('probe', () => ({ seen: '', init() { this.seen = 'read:' + String(this.$date) } }))
})`

const PAGES = {
    '/none': page(`<h1 x-text="'Plain ' + n">Plain</h1><button x-tooltip="'tip'">b</button><p x-show="!open">shown</p>
<pre><code>not highlighted</code></pre><p>Text that mentions $chart and x-markdown is not usage.</p><span data-x-chart="1" x-chartreuse="1"></span>`),
    '/boot/markdown': page(`<div id="t" x-markdown="inline">
# Title

Some *text*.
</div>`),
    '/boot/code': page(`<pre id="t" x-code="js"><code>const answer = 42</code></pre>`),
    '/boot/code-plain': page(`<pre id="t"><code class="language-js">const answer = 42</code></pre>`),
    '/boot/svg': page(`<span id="t" x-svg="'/icon.svg'"></span>`),
    '/boot/combobox': page(`<input id="t" x-combobox="opts"><datalist id="opts"><option value="Apple"></option><option value="Pear"></option></datalist>`),
    '/boot/slides': page(`<div id="t" x-carousel><div class="carousel-slides"><div>One</div><div>Two</div></div><p id="count" x-text="totalSlides"></p></div>`),
    '/boot/colorpicker': page(`<div id="t" x-colorpicker></div>`),
    '/boot/datepicker': page(`<div id="t" x-date></div>`),
    '/boot/charts': page(`<div id="t" x-chart="{ type: 'bar', series: [{ data: [1, 2, 3] }] }" style="width:300px"></div>`),
    '/boot/virtual': page(`<div x-data="{ items: ${list(2000)} }"><div id="t" x-virtual="{ estimate: 20 }" style="height:200px;overflow:auto"><template x-for="row in items" :key="row.id"><div class="r" style="height:20px" x-text="row.name"></div></template></div></div>`),
    '/boot/export': page(`<button id="t" x-export.csv="{ data: [{ a: 1 }] }">Export</button><p id="m" x-text="typeof $export"></p>`),
    // Late content: on-use modules are served slowly for /late/ pages
    '/late/innerhtml': page(`<main id="host"></main><div id="sib" x-data x-init="count('sib')"></div>`),
    '/late/xhtml': page(`<main id="host" x-html="html"></main>`),
    '/late/xif': page(`<template x-if="open"><div id="xif">${ONCE('i')}</div></template>`),
    '/late/component': page(`<main id="host"></main>`),
    '/late/attr': page(`<div id="cal" x-data x-init="count('attr')"></div>`),
    '/late/js-only': page(`<div id="p" x-data="probe" x-text="seen"></div>`, '<script src="/app.js"></script>'),
    '/late/magic': page(`<main id="host"></main>`),
    '/late/script': page(`<div id="e" x-data="exp"><button id="go" @click="go()">Export</button><p id="res" x-text="result"></p></div>
<div id="c" x-data="cap"><button id="run" @click="run()">Run</button></div><div id="i" x-data="imp"><button id="pick" @click="pick()">Import</button></div>`, '<script src="/app.js"></script>'),
    '/cfg/explicit': page(`<p id="d" x-text="'d=' + $date.value"></p>`, '', 'data-modules="tooltips"'),
    '/cfg/omit': page(`<p id="d" x-text="'d=' + $date.value"></p>`, '', 'data-omit="datepicker"'),
    '/giveup/never': page(`<main id="host" x-html="html"></main>`),
    '/giveup/late': page(`<main id="host" x-html="html"></main>`),
    '/nest/same': page(`<form id="nf"><main id="host" x-html="html"></main></form>`),
    '/nest/outer': page(`<form id="nf"><main id="host" x-html="html"></main></form>`),
    '/md/race': page(`<div x-data="{ src: '', tick: 0 }" id="w"><div id="md" x-markdown="src + (tick > -1 ? '' : '')"></div></div><div id="mi" x-markdown="inline">warm</div>`),
}
// Component HTML served at once; DOMContentLoaded waits on a slow deferred script
const PF = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title><link rel="manifest" href="/manifest-pf.json">
<script>window.__c = {}; window.count = (k) => { window.__c[k] = (window.__c[k] || 0) + 1 }; window.__ev = []; const T = () => performance.now(); document.addEventListener('DOMContentLoaded', () => __ev.push(['dcl', T()]))
new MutationObserver(() => { if (!window.__ins && document.getElementById('pf')) { window.__ins = 1; __ev.push(['inserted', T(), !!window.ensureChartsPluginInitialized]) } }).observe(document, { childList: true, subtree: true })</script>
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"></script><script defer src="/pf-slow.js"></script>
</head><body x-data>${body}</body></html>`
PAGES['/pf/xif'] = PF('<template x-if="true"><x-pfpanel></x-pfpanel></template>')
PAGES['/pf/direct'] = PF('<x-pfpanel></x-pfpanel>')
PAGES['/pf/s2500'] = PAGES['/pf/s5000'] = PAGES['/pf/never'] = PAGES['/pf/at3'] = PAGES['/pf/xif']
PAGES['/pf/img'] = PF('<p id="live" x-text="\'live\'">raw</p><img src="/pf-big.svg">')
const FILES = {
    '/manifest-pf.json': JSON.stringify({ name: 'pf', components: ['components/pfpanel.html'], preloadedComponents: ['components/pfpanel.html'], data: { m: '/data-pf.json' } }),
    '/data-pf.json': JSON.stringify({ v: 1 }),
    '/components/pfpanel.html': `<section id="pf" x-data x-init="count('pf')"><div id="pfch" x-init="count('pfch')" x-chart="{ type: 'bar', series: [{ data: [1, 2, 3] }] }" style="width:300px"></div></section>`,
    '/pf-slow.js': 'window.__slow = 1',
    '/manifest.json': JSON.stringify({ name: 'onuse' }),
    '/app.js': MD_APP,
    '/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    '/components/widget.html': `<section id="widget" x-data x-init="count('widget')"><div id="wchart" x-chart="{ type: 'bar', series: [{ data: [3, 1] }] }" style="width:300px"></div><pre id="wcode" x-code="js"><code>var w = 2</code></pre></section>`,
}
const requested = []
const server = await new Promise((r) => {
    const s = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x')
        requested.push(u.pathname)
        const ref = req.headers.referer ? new URL(req.headers.referer).pathname : ''
        if (u.pathname === '/__alpine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(ALPINE)) }
        if (u.pathname.startsWith('/ping/')) { res.writeHead(204); return res.end() }
        // Latency on the manifest, so the request order of the boot shows
        if (u.pathname === '/pf-big.svg') return setTimeout(() => { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg"/>') }, 3000)
        if (u.pathname === '/pf-slow.js') return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(FILES[u.pathname]) }, 1200)
        if (u.pathname === '/manifest.json') return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(FILES[u.pathname]) }, 250)
        if (FILES[u.pathname]) { res.writeHead(200, { 'content-type': u.pathname.endsWith('.json') ? 'application/json' : u.pathname.endsWith('.svg') ? 'image/svg+xml' : u.pathname.endsWith('.js') ? 'text/javascript' : 'text/html' }); return res.end(FILES[u.pathname]) }
        // Svg that loads but never registers, or registers 11 s after loading
        if (u.pathname === '/scripts/manifest.svg.js' && ref.startsWith('/giveup/')) {
            res.writeHead(200, { 'content-type': 'text/javascript' })
            return res.end(ref === '/giveup/never' ? '/* never registers */' : 'setTimeout(() => {\n' + readFileSync(path.join(SRC, u.pathname), 'utf8') + '\n}, 11000)')
        }
        // Charts whose file runs but registers 3 s later, or never
        if (u.pathname === '/scripts/manifest.charts.js' && (ref === '/pf/never' || ref === '/pf/at3')) {
            res.writeHead(200, { 'content-type': 'text/javascript' })
            return res.end('window.ensureChartsPluginInitialized = () => {};' + (ref === '/pf/at3' ? 'setTimeout(() => {\n' + readFileSync(path.join(SRC, u.pathname), 'utf8') + '\n}, 3000)' : ''))
        }
        if (u.pathname.startsWith('/scripts/')) {
            const f = path.join(SRC, u.pathname)
            if (!existsSync(f)) { res.writeHead(404); return res.end() }
            const mod = /manifest\.([\w.]+)\.js$/.exec(u.pathname)
            const slow = mod && MOVED.includes(mod[1]) && (ref.startsWith('/late/') || (ref.startsWith('/md/') && mod[1] === 'code'))
            const nest = { '/nest/same': { slides: 1500, export: 500 }, '/nest/outer': { slides: 300, export: 1500 } }[ref]
            const ms = nest && mod ? nest[mod[1]] || 0 : ref.startsWith('/pf/') && mod && mod[1] === 'charts' ? (Number(ref.slice(5)) || 300) : slow ? SLOW : 0
            return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(f)) }, ms)
        }
        if (PAGES[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGES[u.pathname]) }
        res.writeHead(404); res.end()
    })
    s.listen(0, '127.0.0.1', () => r(s))
})
const BASE = `http://127.0.0.1:${server.address().port}`

let failed = 0
const check = (ok, label, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`); if (!ok) failed++ }
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })

async function open(p, { before } = {}) {
    const ctx = await browser.createBrowserContext()
    const pg = await ctx.newPage()
    const logs = []
    pg.on('console', (m) => { if (['error', 'warn', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`) })
    pg.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
    const modules = []
    pg.on('request', (r) => { const m = /\/scripts\/manifest\.([\w.]+)\.js$/.exec(new URL(r.url()).pathname); if (m) modules.push(m[1]) })
    if (before) await before(pg)
    await pg.goto(BASE + p)
    await pg.waitForFunction(() => window.__manifestAlpineStarted, { timeout: 60000 }).catch(() => { })
    return { pg, ctx, logs, modules }
}
const until = (pg, fn, arg, timeout = 30000) => pg.waitForFunction(fn, { timeout, polling: 50 }, arg).then(() => true, () => false)
const quiet = (logs) => logs.filter((l) => !/favicon/.test(l))
const counts = (pg) => pg.evaluate(() => window.__c)

// 1. A page using none of them
{
    const { pg, ctx, logs, modules } = await open('/none')
    await wait(1500)
    const moved = modules.filter((m) => MOVED.includes(m))
    check(moved.length === 0, 'a page that uses no on-use module requests none of them', moved)
    check(await pg.evaluate(() => document.querySelector('h1').textContent) === 'Plain 3', 'that page boots')
    check(quiet(logs).length === 0, 'that page logs nothing', quiet(logs))
    await ctx.close()
}

// 2. Each module used at boot works
const EFFECTS = {
    markdown: () => document.querySelector('#t h1')?.textContent === 'Title' && !!document.querySelector('#t em'),
    code: () => document.querySelector('#t')?.dataset.codeProcessed === 'yes' && !!document.querySelector('#t [class*="hljs-"]'),
    'code-plain': () => document.querySelector('#t')?.dataset.codeProcessed === 'yes' && !!document.querySelector('#t [class*="hljs-"]'),
    svg: () => !!document.querySelector('#t svg circle'),
    combobox: () => document.querySelector('#t')?.getAttribute('role') === 'combobox',
    slides: () => document.getElementById('count')?.textContent === '2',
    colorpicker: () => !!document.querySelector('#t')?._colorpickerState && document.querySelector('#t').children.length > 0,
    datepicker: () => !!document.querySelector('#t')?._dateState && document.querySelector('#t').querySelectorAll('button').length > 20,
    charts: () => !!document.querySelector('#t svg') && document.querySelector('#t').classList.contains('chart'),
    virtual: () => { const n = document.querySelectorAll('#t .r').length; return n > 0 && n < 100 && !!document.querySelector('#t [data-virtual-spacer]') },
    export: () => document.getElementById('m')?.textContent === 'function',
}
const MODULE_OF = { 'code-plain': 'code' }
for (const [name, effect] of Object.entries(EFFECTS)) {
    const { pg, ctx, logs, modules } = await open('/boot/' + name)
    const ok = await until(pg, effect)
    const mod = MODULE_OF[name] || name
    check(ok, `boot: ${name} works`, await pg.evaluate(() => document.body.innerHTML.slice(0, 400)))
    check(modules.filter((m) => m === mod).length === 1, `boot: ${name} requests its module once`, modules)
    const order = await pg.evaluate((m) => { const e = performance.getEntriesByType('resource'); const f = (k) => e.find((r) => new URL(r.name).pathname.endsWith(k)); return { mod: f(`/manifest.${m}.js`)?.startTime, manifest: f('/manifest.json')?.responseEnd } }, mod)
    check(order.mod < order.manifest, `boot: ${name} is requested while manifest.json is in flight`, order)
    check(modules.filter((m) => MOVED.includes(m) && m !== mod).length === 0, `boot: ${name} requests no other on-use module`, modules)
    if (name === 'virtual') check(await pg.evaluate(() => window.__peak) < 100, 'boot: virtual never renders the whole list', await pg.evaluate(() => window.__peak))
    // Only exception: Colorpicker's library reads $x, which exists only with the data module (same on the old loader)
    const known = name === 'colorpicker' ? quiet(logs).filter((l) => !/\$x is not defined/.test(l)) : quiet(logs)
    check(known.length === 0, `boot: ${name} logs nothing`, known)
    await ctx.close()
}

// 3. Late content: each held element and its children start exactly once
const ONCE_EFFECTS = {
    car: (p) => document.getElementById(p + 'count')?.textContent === '2',
    v: (p) => { const n = document.querySelectorAll('#' + p + 'v .r').length; return n > 0 && n < 100 && !!document.querySelector('#' + p + 'v [data-virtual-spacer]') },
    ch: (p) => !!document.querySelector('#' + p + 'ch svg'),
    cal: (p) => !!document.getElementById(p + 'cal')?._dateState && document.getElementById(p + 'cal').querySelectorAll('button').length > 20,
}
async function once(label, p, prefix, act, sniffed = false) {
    requested.length = 0
    const { pg, ctx, logs, modules } = await open(p)
    await wait(300)
    const before = modules.filter((m) => MOVED.includes(m))
    await pg.evaluate(act, ONCE(prefix))
    for (const [k, fn] of Object.entries(ONCE_EFFECTS)) {
        check(await until(pg, fn, prefix), `late ${label}: ${k} works`, await pg.evaluate((i) => document.getElementById(i)?.outerHTML.slice(0, 200), prefix + k))
    }
    await wait(600)
    const c = await counts(pg)
    const want = ['car', 'carKid', 'v', 'ch', 'cal'].map((k) => prefix + k)
    check(want.every((k) => c[k] === 1), `late ${label}: every held element's own and children's x-init ran exactly once`, c)
    check(requested.filter((x) => x === '/ping/' + prefix).length === 1, `late ${label}: x-init side effects ran once`, requested.filter((x) => x.startsWith('/ping/')))
    check(await pg.evaluate(() => window.__peak) < 100, `late ${label}: virtual never rendered the whole list`, await pg.evaluate(() => window.__peak))
    if (sniffed) check(['slides', 'virtual', 'charts', 'datepicker'].every((m) => before.includes(m)), `late ${label}: template content is sniffed at boot`, before)
    else check(before.length === 0, `late ${label}: nothing loaded before the content arrived`, before)
    check(quiet(logs).length === 0, `late ${label}: logs nothing`, quiet(logs))
    return { pg, ctx, c }
}
{
    const { pg, ctx, c } = await once('innerHTML', '/late/innerhtml', 'h', (m) => { document.getElementById('host').innerHTML = m })
    check(c.sib === 1, 'late innerHTML: a sibling started once, at boot', c)
    await ctx.close()
}
await (await once('x-html', '/late/xhtml', 'x', (m) => { Alpine.$data(document.body).html = m })).ctx.close()
await (await once('x-if', '/late/xif', 'i', () => { Alpine.$data(document.body).open = true }, true)).ctx.close()

// Held while the module loads: inert, then started once with the module present
{
    const { pg, ctx, logs } = await open('/late/innerhtml')
    await wait(300)
    const during = await pg.evaluate(async () => {
        document.getElementById('host').innerHTML = `<div id="hc" x-data="{ s: 'live' }" x-init="count('hc')" x-chart="{ type: 'bar', series: [{ data: [1] }] }" style="width:200px"><span id="hk" x-text="s">raw</span></div>`
        await new Promise((r) => setTimeout(r, 200))
        return { init: window.__c.hc || 0, text: document.getElementById('hk').textContent, charts: !!window.ensureChartsPluginInitialized }
    })
    check(during.init === 0 && during.text === 'raw' && !during.charts, 'held: inert while its module loads (markup shown as authored)', during)
    check(await until(pg, () => window.__c.hc === 1 && document.getElementById('hc') && !!document.querySelector('#hc svg')), 'held: started once the module registered')
    check(quiet(logs).length === 0, 'held: logs nothing', quiet(logs))
    await ctx.close()
}

// Defer: a held element inside a closed container, and a closed container inside a held element
{
    const { pg, ctx, logs } = await open('/late/innerhtml')
    await wait(300)
    await pg.evaluate(() => {
        document.getElementById('host').innerHTML = `<details id="dt"><summary>s</summary><div id="dch" x-data x-init="count('dch')" x-chart="{ type: 'bar', series: [{ data: [1, 2] }] }" style="width:200px"></div></details>
<div id="dcar" x-carousel x-init="count('dcar')"><div class="carousel-slides"><div><details id="dd"><summary>s</summary><p id="ddp" x-data x-init="count('ddp')" x-text="totalSlides"></p></details></div></div></div>`
    })
    await until(pg, () => !!window.ensureChartsPluginInitialized && !!window.ensureSlidesPluginInitialized)
    await wait(400)
    await pg.evaluate(() => { document.getElementById('dt').open = true; document.getElementById('dd').open = true })
    check(await until(pg, () => !!document.querySelector('#dch svg') && document.getElementById('ddp').textContent === '1'), 'defer: held content in and around closed containers works once opened')
    await wait(400)
    const c = await counts(pg)
    check(c.dch === 1 && c.dcar === 1 && c.ddp === 1, 'defer: each element started exactly once', c)
    check(quiet(logs).length === 0, 'defer: logs nothing', quiet(logs))
    await ctx.close()
}

// Component: markup goes through Manifest.loadUsed before insertion, so nothing is held
{
    const { pg, ctx, logs } = await open('/late/component')
    await wait(300)
    const order = await pg.evaluate(async () => {
        const html = await (await fetch('/components/widget.html')).text()
        await window.Manifest.loadUsed(html)
        const ready = !!window.ensureChartsPluginInitialized && !!window.ManifestCode
        document.getElementById('host').innerHTML = html
        await new Promise((r) => setTimeout(r, 0))
        return { ready, held: typeof window.__manifestHeld === 'function' ? window.__manifestHeld(document.getElementById('widget')) : 'n/a', init: window.__c.widget }
    })
    check(order.ready, 'late component: Manifest.loadUsed resolves once the modules are in')
    check(order.held === false && order.init === 1, 'late component: nothing held, started on insertion', order)
    check(await until(pg, () => !!document.querySelector('#wchart svg')), 'late component: chart works')
    check(await until(pg, () => document.getElementById('wcode')?.dataset.codeProcessed === 'yes'), 'late component: code works')
    check(quiet(logs).length === 0, 'late component: logs nothing', quiet(logs))
    await ctx.close()
}

// Markdown output that needs Code: loaded before the rendered HTML lands
{
    const { pg, ctx, logs, modules } = await open('/late/innerhtml')
    await wait(300)
    await pg.evaluate(() => {
        new MutationObserver(() => { if (window.__codeAtInsert === undefined && document.querySelector('#md pre')) window.__codeAtInsert = !!window.ManifestCode }).observe(document.body, { childList: true, subtree: true })
        window.__src = '# Doc\n\n```js\nconst fenced = 1\n```'
        document.getElementById('host').innerHTML = '<div x-data="{ src: window.__src }"><div id="md" x-markdown="src"></div></div>'
    })
    const ok = await until(pg, () => { const pre = document.querySelector('#md pre'); return !!pre && pre.dataset.codeProcessed === 'yes' && !!pre.querySelector('[class*="hljs-"]') })
    check(ok, 'late markdown: fenced code in rendered markdown is highlighted', await pg.evaluate(() => document.getElementById('md')?.innerHTML.slice(0, 300)))
    check(modules.includes('markdown') && modules.includes('code'), 'late markdown: markdown then code requested', modules)
    check(await pg.evaluate(() => window.__codeAtInsert) === true, 'late markdown: Code is in before the rendered HTML lands')
    check(quiet(logs).length === 0, 'late markdown: logs nothing', quiet(logs))
    await ctx.close()
}

// An on-use attribute added to a live element later
{
    const { pg, ctx, logs } = await open('/late/attr')
    await wait(500)
    await pg.evaluate(() => document.getElementById('cal').setAttribute('x-date', ''))
    check(await until(pg, () => !!document.getElementById('cal')._dateState && document.getElementById('cal').querySelectorAll('button').length > 20), 'attribute added later: the directive runs once its module arrives')
    check((await counts(pg)).attr === 1, 'attribute added later: the element is not re-initialised', await counts(pg))
    check(quiet(logs).length === 0, 'attribute added later: logs nothing', quiet(logs))
    await ctx.close()
}

// 4. Markdown renders in order (Code served slowly)
async function mdRace(label, act, want, { abortCode = false, allow = null } = {}) {
    const before = abortCode ? async (pg) => { await pg.setRequestInterception(true); pg.on('request', (r) => /manifest\.code\.js/.test(r.url()) ? r.abort() : r.continue()) } : undefined
    const { pg, ctx, logs } = await open('/md/race', { before })
    await until(pg, () => !!document.querySelector('#mi p'))
    await pg.evaluate(act)
    await wait(SLOW + 1800)
    const got = await pg.evaluate(() => ({ md: document.querySelector('#md h1')?.textContent || null, mi: document.querySelector('#mi h1')?.textContent || null }))
    check(Object.entries(want).every(([k, v]) => got[k] === v), `markdown: ${label}`, got)
    const rest = quiet(logs).filter((l) => !(allow && allow.test(l)))
    check(rest.length === 0, `markdown: ${label}: logs nothing else`, rest)
    await ctx.close()
}
const FENCE = (h) => `# ${h}\n\n\`\`\`js\nconst a = 1\n\`\`\``
await mdRace('a newer render wins over an older one waiting for Code', `(() => { const d = Alpine.$data(document.getElementById('w')); d.src = ${JSON.stringify(FENCE('First'))}; setTimeout(() => { d.src = '# Second' }, 50) })()`, { md: 'Second' })
await mdRace('three rapid changes end on the last', `(() => { const d = Alpine.$data(document.getElementById('w')); d.src = ${JSON.stringify(FENCE('A'))}; setTimeout(() => { d.src = ${JSON.stringify(FENCE('B'))} }, 30); setTimeout(() => { d.src = '# C' }, 60) })()`, { md: 'C' })
await mdRace('inline content changed mid-render ends on the latest', `(() => { const el = document.getElementById('mi'); el.textContent = ${JSON.stringify(FENCE('One'))}; setTimeout(() => { el.textContent = '# Two' }, 40) })()`, { mi: 'Two' })
await mdRace('a change during a failed Code load still ends on the last', `(() => { const d = Alpine.$data(document.getElementById('w')); d.src = ${JSON.stringify(FENCE('Broken'))}; setTimeout(() => { d.src = '# After' }, 50) })()`, { md: 'After' }, { abortCode: true, allow: /Failed to load (plugin code|resource)|manifest\.code\.js/ })
await mdRace('the same content again while Code loads still renders', `(() => { const d = Alpine.$data(document.getElementById('w')); d.src = ${JSON.stringify(FENCE('Alpha'))}; setTimeout(() => { d.tick++ }, 50) })()`, { md: 'Alpha' })
await mdRace('A, B, then A again ends on A', `(() => { const d = Alpine.$data(document.getElementById('w')); d.src = ${JSON.stringify(FENCE('Alpha'))}; setTimeout(() => { d.src = '# Beta' }, 50); setTimeout(() => { d.src = ${JSON.stringify(FENCE('Alpha'))} }, 120) })()`, { md: 'Alpha' })

// A module that loads but never registers, or registers after the 10 s give-up
for (const [p, svgs] of [['/giveup/never', 0], ['/giveup/late', 1]]) {
    const { pg, ctx, logs } = await open(p)
    await wait(300)
    await pg.evaluate(() => { Alpine.$data(document.body).html = `<div id="w" x-data="{ c: 0 }" x-init="count('gw')"><span id="sv" x-svg="'/icon.svg'" x-init="count('gs')"></span><b id="gt" x-text="'c=' + c"></b></div>` })
    await wait(9000)
    const held = await pg.evaluate(() => ({ gs: window.__c.gs || 0, pend: window.ManifestPending.labels() }))
    check(held.gs === 0 && held.pend.includes('held'), `give-up ${p}: held before 10 s`, held)
    await wait(SLOW + 4500)
    const r = await pg.evaluate(() => ({ c: window.__c, svgs: document.querySelectorAll('#sv svg').length, pend: window.ManifestPending.labels(), text: document.getElementById('gt').textContent }))
    check(r.c.gw === 1 && r.c.gs === 1 && r.text === 'c=0' && !r.pend.includes('held'), `give-up ${p}: started exactly once, ManifestPending released`, r)
    check(r.svgs === svgs, `give-up ${p}: ${svgs ? 'the late directive applied once' : 'no directive ever applied'}`, r)
    const l = quiet(logs)
    check(l.length === 1 && /svg has not started 10 s after loading: starting the elements that use it now; it applies to them if it starts later/.test(l[0]), `give-up ${p}: one accurate warning`, l)
    await ctx.close()
}

// $refs into a held element, and input typed while held
{
    const { pg, ctx, logs } = await open('/late/innerhtml')
    await wait(300)
    await pg.evaluate(() => {
        document.getElementById('host').innerHTML = `<div x-data="{ seen: '' }" id="xr" x-init="seen = $refs.c ? 'has' : 'no'"><div x-ref="c" x-date></div><span id="xs" x-text="seen"></span></div>
<div x-data id="xr2"><input id="rin" x-ref="inp" x-date><button id="rb" @click="$refs.inp.focus()">f</button></div>
<div x-data="{ t: 'init', on: false }"><div x-carousel id="form"><div class="carousel-slides"><div><input id="ti" x-model="t"><input id="tc" type="checkbox" x-model="on"><input id="tf" type="file" @change="count('file')"></div></div></div><p id="tv" x-text="t + ':' + on"></p></div>`
    })
    await wait(100)
    await pg.click('#rb')
    await pg.type('#ti', 'typed')
    await pg.click('#tc')
    writeFileSync(path.join(tmpdir(), 'onuse-upload.txt'), 'x')
    await (await pg.$('#tf')).uploadFile(path.join(tmpdir(), 'onuse-upload.txt'))
    const during = await pg.evaluate(() => ({ seen: document.getElementById('xs').textContent, focused: document.activeElement && document.activeElement.id }))
    check(during.seen === 'has', '$refs: a ref inside a held element is there during the hold', during)
    check(await until(pg, () => document.getElementById('tv').textContent === 'typed:true'), 'held input: typed text and a ticked box win over the model\'s initial value', await pg.evaluate(() => [document.getElementById('ti').value, document.getElementById('tv').textContent]))
    check(await until(pg, () => window.__c.file === 1 && !window.ManifestPending.labels().includes('held')), 'held input: a file picked while held is announced once and the hold is released', await pg.evaluate(() => [window.__c.file, window.ManifestPending.labels()]))
    check(await pg.evaluate(() => document.activeElement && document.activeElement.id) === 'tf' || await pg.evaluate(() => document.activeElement && document.activeElement.id) === 'tc', 'held input: focus kept')
    check(quiet(logs).length === 0, '$refs and held input: logs nothing', quiet(logs))
    await ctx.close()
}

// Restore replays stop at the held root; a control its directive made read-only is not written
{
    const { pg, ctx, logs } = await open('/late/innerhtml')
    await wait(300)
    await pg.evaluate(() => {
        document.getElementById('host').innerHTML = `<form id="of"><div x-data="{ t: '', r: 'a', d: '2026-01-02' }"><div x-carousel id="ecar" @change="count('rootCh')"><div class="carousel-slides"><div>
<input id="ef" type="file" @change="count('fileCh')"><input id="et" x-model="t" @input="count('tIn')">
<input id="ra" type="radio" name="r" value="a" x-model="r" checked @change="count('raCh')"><input id="rb" type="radio" name="r" value="b" x-model="r" @change="count('rbCh')">
</div></div></div><input id="ed" x-date x-model="d"><p id="ev" x-text="t + ':' + r + ':' + d"></p></div></form>`
        window.__outer = { input: 0, change: 0, file: 0 }
        const f = document.getElementById('of')
        f.addEventListener('input', () => window.__outer.input++)
        f.addEventListener('change', (e) => { window.__outer.change++; if (e.target.id === 'ef') window.__outer.file++ })
    })
    await wait(100)
    writeFileSync(path.join(tmpdir(), 'onuse-upload.txt'), 'x')
    await (await pg.$('#ef')).uploadFile(path.join(tmpdir(), 'onuse-upload.txt'))
    await pg.click('#rb')
    await pg.type('#et', 'ab')
    await pg.type('#ed', 'typed!')
    const live = await pg.evaluate(() => ({ ...window.__outer }))
    check(await until(pg, () => document.getElementById('ev').textContent === 'ab:b:2026-01-02' && !window.ManifestPending.labels().includes('held')), 'restore: typed values win, the read-only date field keeps its model', await pg.evaluate(() => document.getElementById('ev').textContent))
    await wait(300)
    const after = await pg.evaluate(() => ({ outer: window.__outer, c: window.__c }))
    check(JSON.stringify(after.outer) === JSON.stringify(live) && after.outer.file === 1, 'restore: listeners outside the held element see each edit once (file change once)', { live, after: after.outer })
    check(after.c.fileCh === 1 && after.c.tIn === 1 && after.c.rbCh === 1 && !after.c.raCh, 'restore: handlers on the controls run once; the radio the pick unchecked gets none', after.c)
    check(after.c.rootCh === 3, 'restore: a handler on the held root runs once per restored control', after.c)
    check(quiet(logs).length === 0, 'restore: logs nothing', quiet(logs))
    await ctx.close()
}

// 5. Magics
{
    const { pg, ctx, logs } = await open('/late/magic')
    await wait(300)
    // Inserted after boot (a boot read would load Datepicker before Alpine starts)
    const first = await pg.evaluate(async () => { document.getElementById('host').innerHTML = '<p id="probe" x-text="typeof $date.value"></p>'; await new Promise((r) => setTimeout(r, 50)); return { text: document.getElementById('probe').textContent, loaded: !!window.ensureDatepickerPluginInitialized } })
    check(first.text === 'function' && !first.loaded, 'magic: $date.value reads through the stand-in before Datepicker arrives', first)
    check(await until(pg, () => document.getElementById('probe').textContent === 'undefined'), 'magic: the reader re-ran against the real magic', await pg.evaluate(() => document.getElementById('probe').textContent))
    check(quiet(logs).length === 0, 'magic: logs nothing (no expression errors)', quiet(logs))
    await ctx.close()
}
{
    const hook = (pg) => pg.evaluateOnNewDocument(() => {
        window.__dl = 0
        const ac = HTMLAnchorElement.prototype.click
        HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl++; return } return ac.apply(this, arguments) }
        const ic = HTMLInputElement.prototype.click
        HTMLInputElement.prototype.click = function () { if (this.type === 'file') { window.__picker = (window.__picker || 0) + 1; return } return ic.apply(this, arguments) }
        if (window.showOpenFilePicker) window.showOpenFilePicker = () => { window.__picker = (window.__picker || 0) + 1; return new Promise(() => { }) }
    })
    const { pg, ctx, logs, modules } = await open('/late/script', { before: hook })
    await wait(100)
    const early = await pg.evaluate(() => !!window.ensureExportPluginInitialized)
    await pg.click('#go')
    await pg.click('#pick')
    check(!early, 'script-file magic: Export not loaded before the first click', modules)
    check(await until(pg, () => window.__dl === 1 && document.getElementById('res').textContent === 'done:undefined'), 'script-file magic: the first $export click downloads once, after Export arrives', await pg.evaluate(() => ({ dl: window.__dl, res: document.getElementById('res').textContent })))
    check(await until(pg, () => window.__picker === 1), 'script-file magic: the first $import click opens the file picker', await pg.evaluate(() => window.__picker))
    await pg.click('#run')
    check(await until(pg, () => window.__dl === 2), 'script-file magic: a $export captured before Export arrived forwards to it')
    await pg.click('#go')
    await wait(500)
    check(await pg.evaluate(() => window.__dl === 3 && window.__picker === 1 && window.__impCalled === 1), 'script-file magic: nothing ran twice', await pg.evaluate(() => ({ dl: window.__dl, picker: window.__picker })))
    check(quiet(logs).length === 0, 'script-file magic: logs nothing', quiet(logs))
    await ctx.close()
}
{
    const { pg, ctx, logs, modules } = await open('/late/js-only')
    check(await until(pg, () => !!window.ensureDatepickerPluginInitialized), 'js-only magic: reading $date from a script file loads Datepicker', modules)
    check(await pg.evaluate(() => document.getElementById('p').textContent) === 'read:', 'js-only magic: the first read answered empty')
    check(quiet(logs).length === 0, 'js-only magic: logs nothing', quiet(logs))
    await ctx.close()
}

// A magic whose module will not load says so once, with the fix
for (const [p, fix] of [['/cfg/explicit', 'add data-modules="+datepicker"'], ['/cfg/omit', 'remove it from data-omit']]) {
    const { pg, ctx, logs, modules } = await open(p)
    await wait(800)
    const l = quiet(logs)
    check(l.length === 1 && l[0].includes('$date') === (p === '/cfg/explicit') && l[0].includes(fix), `misconfigured ${p}: one warning naming the fix`, l)
    check(await pg.evaluate(() => document.getElementById('d').textContent) === 'd=' && !modules.includes('datepicker'), `misconfigured ${p}: reads empty, nothing loaded`)
    await ctx.close()
}

// 8. Component HTML that arrives before DOMContentLoaded
for (const [p, runs] of [['/pf/xif', 20], ['/pf/direct', 5]]) {
    const bad = []
    for (let i = 0; i < runs; i++) {
        const holds = []
        const { pg, ctx, logs, modules } = await open(p, { before: (pg) => pg.evaluateOnNewDocument(() => {
            const iv = setInterval(() => { if (!window.ManifestPending) return; clearInterval(iv); const h = window.ManifestPending.hold; window.ManifestPending.hold = function (l) { if (l === 'held') window.__ev.push(['held', performance.now()]); return h.apply(this, arguments) } }, 0)
        }) })
        const drawn = await until(pg, () => !!document.querySelector('#pfch svg') && window.__manifestReady)
        const r = await pg.evaluate(() => { const e = performance.getEntriesByType('resource'); const f = (k) => e.find((x) => new URL(x.name).pathname.endsWith(k)); return { ev: window.__ev, charts: f('/manifest.charts.js')?.startTime, comp: f('/components/pfpanel.html')?.responseEnd, init: window.__c.pf } })
        const ins = r.ev.find((x) => x[0] === 'inserted'), dcl = r.ev.find((x) => x[0] === 'dcl')
        holds.push(...r.ev.filter((x) => x[0] === 'held'))
        const ok = drawn && r.comp < dcl[1] && ins && ins[2] && r.charts < ins[1] && holds.length === 0 && r.init === 1 && modules.filter((m) => m === 'charts').length === 1 && quiet(logs).length === 0
        if (!ok) bad.push({ i, drawn, ...r, charts: modules.filter((m) => m === 'charts').length, logs: quiet(logs) })
        await ctx.close()
    }
    check(bad.length === 0, `prefetched component ${p}: HTML in before DOMContentLoaded, module registered before insertion, nothing held, charts once, ${runs} loads`, bad.slice(0, 2))
}

// 10. Late DOMContentLoaded: a slow early module or image never holds up Alpine
for (const p of ['/pf/s2500', '/pf/s5000', '/pf/img']) {
    const { pg, ctx, logs } = await open(p, { before: (pg) => pg.evaluateOnNewDocument(() => {
        window.__tt = {}; const T = () => performance.now()
        document.addEventListener('alpine:init', () => { window.__tt.alpine = T() }); window.addEventListener('manifest:ready', () => { window.__tt.ready = T() })
        const iv = setInterval(() => { if (!window.ManifestPending) return; clearInterval(iv); const h = window.ManifestPending.hold; window.ManifestPending.hold = function (l) { if (l === 'held') window.__tt.held = (window.__tt.held || 0) + 1; return h.apply(this, arguments) } }, 0)
    }) })
    const done = p === '/pf/img' ? () => document.getElementById('live')?.textContent === 'live' && window.__manifestReady : () => !!document.querySelector('#pfch svg') && window.__manifestReady
    check(await until(pg, done), `late DOMContentLoaded ${p}: boots`)
    const r = await pg.evaluate(() => ({ ...window.__tt, dcl: window.__ev.find((x) => x[0] === 'dcl')[1], ins: window.__ev.find((x) => x[0] === 'inserted') }))
    check(r.alpine - r.dcl < 300 && r.ready > r.alpine, `late DOMContentLoaded ${p}: Alpine starts with DOMContentLoaded, manifest:ready after it`, r)
    // A module slower than 1.5 s: the content shows then, its element held until the module arrives
    if (p !== '/pf/img') check(r.held === 1 && r.ins && r.ins[1] - r.dcl < 600, `late DOMContentLoaded ${p}: ordinary content shown by 1.5 s, the chart element held until its module`, r)
    check(quiet(logs).length === 0, `late DOMContentLoaded ${p}: logs nothing`, quiet(logs))
    await ctx.close()
}
{
    const { pg, ctx, logs } = await open('/nest/same')
    await until(pg, () => window.__manifestReady); await wait(200)
    await pg.evaluate(() => { Alpine.$data(document.body).html = `<div id="sc" x-carousel x-data x-init="window.__sAt = performance.now()"><div class="carousel-slides"><div>a</div></div></div><button id="se" x-export.csv="{ data: [] }" x-data x-init="window.__eAt = performance.now()">e</button>` })
    check(await until(pg, () => window.__sAt && window.__eAt), 'siblings held: both start')
    const r = await pg.evaluate(() => ({ s: window.__sAt, e: window.__eAt, slides: performance.getEntriesByType('resource').find((x) => /manifest\.slides\.js$/.test(x.name))?.responseEnd }))
    check(r.e < r.slides - 500, 'siblings held: export starts on its own module, not behind slides', r)
    check(quiet(logs).length === 0, 'siblings held: logs nothing', quiet(logs))
    await ctx.close()
}

// 11. A module that registers late or never
for (const p of ['/pf/never', '/pf/at3']) {
    const { pg, ctx, logs } = await open(p, { before: (pg) => pg.evaluateOnNewDocument(() => {
        window.__tt = {}; const T = () => performance.now()
        new MutationObserver(() => { if (!window.__tt.svg && document.querySelector('#pfch svg')) window.__tt.svg = T() }).observe(document, { childList: true, subtree: true })
    }) })
    const started = await until(pg, (p) => window.__c.pfch === 1 && (p === '/pf/never' || window.__tt.svg) && !window.ManifestPending.labels().some((l) => l === 'held' || l === 'module'), p, 15000)
    const r = await pg.evaluate(() => ({ ins: window.__ev.find((x) => x[0] === 'inserted')?.[1], ran: performance.getEntriesByType('resource').find((x) => /manifest\.charts\.js$/.test(x.name))?.responseEnd, svg: window.__tt.svg, now: performance.now(), c: window.__c }))
    check(started && r.ins - r.ran < 1800, `late module ${p}: ordinary content shown within 1.5 s of the file running`, r)
    if (p === '/pf/never') {
        check(r.now - r.ran < 10800 && r.c.pfch === 1 && r.c.pf === 1, `late module ${p}: the chart element started without it by 10 s in all, pending clear`, r)
        const l = quiet(logs)
        check(l.length === 1 && /charts has not started 10 s after loading/.test(l[0]), `late module ${p}: one warning`, l)
    } else {
        check(r.svg - r.ran > 2700 && r.svg - r.ran < 3600 && r.c.pfch === 1 && r.c.pf === 1, `late module ${p}: the chart is live when it registers, started once`, r)
        await wait(500)
        check((await counts(pg)).pfch === 1 && quiet(logs).length === 0, `late module ${p}: no second start, logs nothing`, quiet(logs))
    }
    await ctx.close()
}

// 9. Nested holds (slides outside, export inside): each handler sees typed input once
for (const p of ['/nest/same', '/nest/outer']) {
    const { pg, ctx, logs } = await open(p)
    await until(pg, () => window.__manifestReady); await wait(200)
    await pg.evaluate(() => {
        window.__live = 0
        document.getElementById('nf').addEventListener('input', () => window.__live++)
        Alpine.$data(document.body).html = `<div id="ncar" x-carousel x-data="{ t: '' }" @input="count('oIn')"><div class="carousel-slides"><div @input="count('midIn')"><div id="ninner" x-export.csv="{ data: [] }" @input="count('iIn')"><input id="nfld" x-model="t" @input="count('fIn')" @change="count('fCh')"></div></div></div><p id="nv" x-text="t"></p></div>`
    })
    await wait(100)
    await pg.type('#nfld', 'ab')
    check(await until(pg, () => document.getElementById('nv')?.textContent === 'ab' && !window.ManifestPending.labels().includes('held') && !!window.ensureExportPluginInitialized), `nested ${p}: typed text reaches the model`)
    await wait(400)
    const c = await pg.evaluate(() => ({ ...window.__c, live: window.__live }))
    check(['fIn', 'fCh', 'iIn', 'midIn', 'oIn'].every((k) => c[k] === 1) && c.live === 2, `nested ${p}: the control's, inner, middle and outer handlers each run once; outside sees only the live input`, c)
    check(quiet(logs).length === 0, `nested ${p}: logs nothing`, quiet(logs))
    await ctx.close()
}

// 7. Prerender and hydration (needs npm run build)
{
    const site = mkdtempSync(path.join(tmpdir(), 'onuse-render-'))
    cpSync(process.env.ONUSE_LIB || path.join(ROOT, 'lib'), path.join(site, 'fw'), { recursive: true })
    cpSync(ALPINE, path.join(site, 'fw', 'alpine.js'))
    writeFileSync(path.join(site, 'manifest.json'), JSON.stringify({ name: 'onuse' }))
    writeFileSync(path.join(site, 'icon.svg'), FILES['/icon.svg'])
    // Inline x-markdown re-renders from baked text at hydration on the old loader too, so a file source here
    writeFileSync(path.join(site, 'doc.md'), '# Rendered\n\n```js\nconst baked = 1\n```\n')
    writeFileSync(path.join(site, 'index.html'), `<!DOCTYPE html><html><head><meta charset="utf-8"><title>r</title><link rel="manifest" href="/manifest.json">
<script src="/fw/manifest.js" data-module-base="/fw" data-alpine="/fw/alpine.js"></script></head><body x-data="{ n: 2 }">
<div id="md" x-markdown="doc.md"></div>
<div id="ch" x-chart="{ type: 'bar', series: [{ data: [1, 2, n] }] }" style="width:300px"></div>
<span id="sv" x-svg="'/icon.svg'"></span>
<p id="plain" x-text="'n=' + n"></p>
</body></html>`)
    const r = spawnSync('node', [path.join(ROOT, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: site, encoding: 'utf8', timeout: 300000 })
    check(r.status === 0, 'prerender: exit 0', (r.stdout + r.stderr).split('\n').slice(-12).join(' / '))
    const out = path.join(site, 'website')
    const html = existsSync(path.join(out, 'index.html')) ? readFileSync(path.join(out, 'index.html'), 'utf8') : ''
    check(/<h1[^>]*>Rendered<\/h1>/.test(html), 'prerender: markdown baked in the render pass', html.slice(0, 200))
    check(/hljs-/.test(html), 'prerender: fenced code highlighted in the render pass')
    check(/<svg[^>]*>[\s\S]*<circle/.test(html.split('id="sv"')[1] || ''), 'prerender: svg inlined in the render pass')
    check(/id="ch"[^>]*>[\s\S]*?<svg/.test(html), 'prerender: chart drawn in the render pass')
    const srv = await new Promise((res) => {
        const s2 = http.createServer((req, rs) => {
            let f = path.join(out, decodeURIComponent(new URL(req.url, 'http://x').pathname))
            if (existsSync(f) && !path.extname(f)) f = path.join(f, 'index.html')
            if (!existsSync(f)) { rs.writeHead(404); return rs.end() }
            const ext = path.extname(f)
            rs.writeHead(200, { 'content-type': ext === '.js' ? 'text/javascript' : ext === '.json' ? 'application/json' : ext === '.svg' ? 'image/svg+xml' : ext === '.md' ? 'text/markdown' : 'text/html' })
            rs.end(readFileSync(f))
        })
        s2.listen(0, '127.0.0.1', () => res(s2))
    })
    const ctx = await browser.createBrowserContext()
    const pg = await ctx.newPage()
    const logs = []
    pg.on('console', (m) => { if (['error', 'warn', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`) })
    pg.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
    const mods = []
    pg.on('request', (q) => { const m = /\/fw\/manifest\.([\w.]+)\.js$/.exec(new URL(q.url()).pathname); if (m) mods.push(m[1]) })
    await pg.goto(`http://127.0.0.1:${srv.address().port}/`)
    await pg.waitForFunction(() => window.__manifestReady, { timeout: 60000 }).catch(() => { })
    await wait(800)
    const after = await pg.evaluate(() => ({
        h1: document.querySelector('#md h1')?.textContent,
        code: !!document.querySelector('#md pre [class*="hljs-"]'),
        chart: !!document.querySelector('#ch svg'),
        svg: !!document.querySelector('#sv svg circle'),
        plain: document.getElementById('plain')?.textContent,
    }))
    check(after.h1 === 'Rendered' && after.code && after.chart && after.svg && after.plain === 'n=2', 'hydrated: baked content kept and live', after)
    // The render strips x-markdown from baked file content, so hydration needs Code but not Markdown
    check(!mods.includes('markdown'), 'hydrated: Markdown is not loaded for baked markdown', mods)
    check(['code', 'charts'].every((m) => mods.includes(m)), 'hydrated: the modules the baked page still uses are loaded', mods)
    check(mods.filter((m) => MOVED.includes(m) && !['markdown', 'code', 'charts', 'svg'].includes(m)).length === 0, 'hydrated: no unused on-use module is loaded', mods)
    check(quiet(logs).length === 0, 'hydrated: logs nothing', quiet(logs))
    console.log('      hydration requested on-use modules:', mods.filter((m) => MOVED.includes(m)).join(', '))
    await ctx.close()
    srv.close()
    rmSync(site, { recursive: true, force: true })
}

await browser.close()
server.close()
if (failed) { console.error(`\n${failed} failed`); process.exitCode = 1 } else console.log('\nall passed')
