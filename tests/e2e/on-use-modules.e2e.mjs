/**
 * Real-Chrome guard for on-use directive modules (markdown, code, svg, combobox, slides,
 * colorpicker, datepicker, charts, virtual, export):
 * 1. a page that uses none of them requests none of them, and boots;
 * 2. a page that uses one at boot works: the module's visible effect is in the DOM;
 * 3. late content works, including the element that triggered the load: innerHTML, x-html,
 *    x-if template, a component (Manifest.loadUsed before insertion), and markdown output
 *    that needs Code (charts and datepicker for directives, code and markdown for content);
 * 4. a magic read before its module arrives never throws and updates once it lands;
 * 5. no console warnings or errors on any page;
 * 6. mnfst-render (derive path, built lib/): the render pass loads what the page uses and
 *    bakes it; hydration loads the modules the baked page still needs and keeps the content.
 *
 * Run: node tests/e2e/on-use-modules.e2e.mjs      (ONUSE_SRC=<dir with scripts/> to A/B)
 */
import http from 'http'
import path from 'path'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = process.env.ONUSE_SRC || path.join(ROOT, 'src')
const ALPINE = path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js')
const MOVED = ['markdown', 'svg', 'code', 'combobox', 'slides', 'colorpicker', 'datepicker', 'charts', 'virtual', 'export']
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const page = (body, head = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title>
<link rel="manifest" href="/manifest.json">${head}
<script src="/scripts/manifest.js" data-module-base="/scripts" data-alpine="/__alpine.js"></script>
</head><body x-data="{ open: false, html: '', n: 3 }">${body}</body></html>`

const list = (n) => `[${Array.from({ length: n }, (_, k) => `{ id: ${k}, name: 'n${k}' }`).join(',')}]`
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
    // Late content
    '/late/innerhtml': page(`<main id="host"></main>`),
    '/late/xhtml': page(`<main id="host" x-html="html"></main>`),
    '/late/xif': page(`<template x-if="open"><div id="xif"><div id="chart" x-chart="{ type: 'bar', series: [{ data: [1, 2, 3] }] }" style="width:300px"></div><div id="cal" x-date></div><pre id="code" x-code="js"><code>let x = 1</code></pre><div id="md" x-markdown="inline">
## From x-if
</div></div></template>`),
    '/late/component': page(`<main id="host"></main>`),
    '/late/magic': page(`<main id="host"></main><p id="probe" x-text="'v:' + String($date)"></p>`),
}
const FILES = {
    '/manifest.json': JSON.stringify({ name: 'onuse' }),
    '/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    '/components/widget.html': `<section id="widget"><div id="wchart" x-chart="{ type: 'bar', series: [{ data: [3, 1] }] }" style="width:300px"></div><pre id="wcode" x-code="js"><code>var w = 2</code></pre></section>`,
}
const requested = []
const server = await new Promise((r) => {
    const s = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x')
        requested.push(u.pathname)
        if (u.pathname === '/__alpine.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(ALPINE)) }
        if (FILES[u.pathname]) { res.writeHead(200, { 'content-type': u.pathname.endsWith('.json') ? 'application/json' : u.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/html' }); return res.end(FILES[u.pathname]) }
        if (u.pathname.startsWith('/scripts/')) {
            const f = path.join(SRC, u.pathname)
            if (!existsSync(f)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(f))
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

async function open(p) {
    const ctx = await browser.createBrowserContext()
    const pg = await ctx.newPage()
    const logs = []
    pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`) })
    pg.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
    const modules = []
    pg.on('request', (r) => { const m = /\/scripts\/manifest\.([\w.]+)\.js$/.exec(new URL(r.url()).pathname); if (m) modules.push(m[1]) })
    await pg.goto(BASE + p)
    await pg.waitForFunction(() => window.__manifestAlpineStarted, { timeout: 60000 }).catch(() => { })
    return { pg, ctx, logs, modules }
}
const until = (pg, fn, arg, timeout = 30000) => pg.waitForFunction(fn, { timeout, polling: 50 }, arg).then(() => true, () => false)
const quiet = (logs) => logs.filter((l) => !/favicon/.test(l))

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
    check(modules.filter((m) => MOVED.includes(m) && m !== mod).length === 0, `boot: ${name} requests no other on-use module`, modules)
    // Colorpicker's library reads $x, which only exists with the data module: same on the old loader
    const known = name === 'colorpicker' ? quiet(logs).filter((l) => !/\$x is not defined/.test(l)) : quiet(logs)
    check(known.length === 0, `boot: ${name} logs nothing`, known)
    await ctx.close()
}

// 3. Late content
const LATE_EFFECTS = {
    chart: (id) => !!document.querySelector(`#${id} svg`) && document.getElementById(id).classList.contains('chart'),
    cal: (id) => !!document.getElementById(id)?._dateState && document.getElementById(id).querySelectorAll('button').length > 20,
    code: (id) => document.getElementById(id)?.dataset.codeProcessed === 'yes' && !!document.querySelector(`#${id} [class*="hljs-"]`),
    md: (id) => !!document.querySelector(`#${id} h2`),
}
const MARKUP = `<div id="chart" x-chart="{ type: 'bar', series: [{ data: [1, 2, 3] }] }" style="width:300px"></div><div id="cal" x-date></div><pre id="code" x-code="js"><code>let x = 1</code></pre><div id="md" x-markdown="inline">
## Late
</div>`
async function late(label, p, act, sniffed = false) {
    const { pg, ctx, logs, modules } = await open(p)
    await wait(300)
    const before = modules.filter((m) => MOVED.includes(m))
    await pg.evaluate(act, MARKUP)
    for (const [kind, id] of [['chart', 'chart'], ['cal', 'cal'], ['code', 'code'], ['md', 'md']]) {
        check(await until(pg, LATE_EFFECTS[kind], id), `late ${label}: ${kind} works`, await pg.evaluate((i) => document.getElementById(i)?.outerHTML.slice(0, 300), id))
    }
    if (sniffed) check(['charts', 'datepicker', 'code', 'markdown'].every((m) => before.includes(m)), `late ${label}: template content is sniffed at boot`, before)
    else check(before.length === 0, `late ${label}: nothing loaded before the content arrived`, before)
    check(quiet(logs).length === 0, `late ${label}: logs nothing`, quiet(logs))
    await ctx.close()
}
await late('innerHTML', '/late/innerhtml', (m) => { document.getElementById('host').innerHTML = m })
await late('x-html', '/late/xhtml', (m) => { Alpine.$data(document.body).html = m })
await late('x-if', '/late/xif', () => { Alpine.$data(document.body).open = true }, true)

// Component: markup goes through Manifest.loadUsed before insertion
{
    const { pg, ctx, logs } = await open('/late/component')
    await wait(300)
    const order = await pg.evaluate(async () => {
        const html = await (await fetch('/components/widget.html')).text()
        await window.Manifest.loadUsed(html)
        const ready = !!window.ensureChartsPluginInitialized && !!window.ManifestCode
        document.getElementById('host').innerHTML = html
        return ready
    })
    check(order, 'late component: Manifest.loadUsed resolves once the modules are in')
    check(await until(pg, LATE_EFFECTS.chart, 'wchart'), 'late component: chart works')
    check(await until(pg, LATE_EFFECTS.code, 'wcode'), 'late component: code works')
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

// Scope-providing and template-owning directives inserted late: the subtree is walked again
{
    const { pg, ctx, logs } = await open('/late/innerhtml')
    await wait(300)
    await pg.evaluate((items) => {
        document.getElementById('host').innerHTML = `<div id="car" x-carousel><div class="carousel-slides"><div>One</div><div>Two</div><div>Three</div></div><p id="count" x-text="totalSlides"></p></div>
<div x-data="{ items: ${items} }"><div id="v" x-virtual="{ estimate: 20 }" style="height:200px;overflow:auto"><template x-for="row in items" :key="row.id"><div class="r" style="height:20px" x-text="row.name"></div></template></div></div>`
    }, list(2000))
    check(await until(pg, () => document.getElementById('count')?.textContent === '3'), 'late innerHTML: carousel scope reaches its children')
    check(await until(pg, () => { const n = document.querySelectorAll('#v .r').length; return n > 0 && n < 100 && !!document.querySelector('#v [data-virtual-spacer]') }), 'late innerHTML: virtual takes over a list x-for already rendered', await pg.evaluate(() => document.querySelectorAll('#v .r').length))
    // Expression errors from the first walk (before the module existed) are expected here
    const real = quiet(logs).filter((l) => !/Alpine Expression Error: totalSlides is not defined|totalSlides is not defined/.test(l))
    check(real.length === 0, 'late innerHTML: carousel and virtual log nothing else', real)
    await ctx.close()
}

// 4. A magic read before its module arrives
{
    const { pg, ctx, logs } = await open('/late/magic')
    await wait(300)
    check(await pg.evaluate(() => document.getElementById('probe').textContent) === 'v:', 'magic: $date reads as empty before Datepicker arrives')
    await pg.evaluate(() => { document.getElementById('host').innerHTML = '<div id="cal" x-date></div>' })
    check(await until(pg, LATE_EFFECTS.cal, 'cal'), 'magic: datepicker loads for later content')
    check(await until(pg, () => document.getElementById('probe').textContent !== 'v:' || !!window.ensureDatepickerPluginInitialized), 'magic: the reader re-runs against the real magic')
    check(quiet(logs).length === 0, 'magic: logs nothing (no expression errors)', quiet(logs))
    await ctx.close()
}

// 6. Prerender and hydration (needs npm run build)
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
    const needed = ['code', 'charts']
    check(needed.every((m) => mods.includes(m)), 'hydrated: the modules the baked page still uses are loaded', mods)
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
