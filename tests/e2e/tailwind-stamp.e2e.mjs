/**
 * Publish-time Tailwind engine skip in real Chromium, for lib/manifest.js and lib/manifest.min.js.
 * Pages are stamped the way the backend will (bakeUtilities + utilitiesStamp from lib/manifest.utilities.node.mjs).
 * 1. no stamp (no sheet, an unstamped sheet, the retired -complete flag): same requests as BASE_LIB, engine once, same styles;
 * 2. matching skip stamp: no engine request, styles equal to the engine run;
 * 3. version mismatch, hash mismatch, unreadable sheet, author text/tailwindcss block: engine once, styled;
 * 4. unknown token later via :class, x-transition, injected HTML, a component: engine once, class styled; remembered next visit;
 * 5. shadow mode: engine as before, verdict readable from Manifest.tailwindStamp;
 * 6. scan parity: tokens the browser module records on a page equal the node scan of its HTML (Chromium serialisation).
 *
 * 7. async loader with a stylesheet still loading: engine at once, Alpine not held back (same timing as unstamped).
 * The bake runs the repo's tailwindcss, pinned to the bundled browser engine's version (tailwind-stamp-seed.test.js).
 * Run: npm run build && node tests/e2e/tailwind-stamp.e2e.mjs   (BASE_LIB=<master lib dir> for the request A/B; STAMP_LIB to serve another lib)
 */
import puppeteer from 'puppeteer'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import * as tailwindcss from 'tailwindcss'
import { serve, ROOT } from './fixtures/tailwind-cache-site.mjs'

// STAMP_LIB=<dir> serves another lib/ (the bake and stamp always come from this checkout's lib/)
const LIB = process.env.STAMP_LIB || path.join(ROOT, 'lib')
const BASE_LIB = process.env.BASE_LIB || null
const HOST = 'app.example'
const ENGINE = fs.readFileSync(path.join(ROOT, 'src/scripts/build.mjs'), 'utf8').match(/TAILWIND_V4_FILE: 'tailwind\.v(\d+\.\d+\.\d+)\.js'/)[1]
const require = createRequire(import.meta.url)
const node = await import(pathToFileURL(path.join(ROOT, 'lib', 'manifest.utilities.node.mjs')).href)
const MANIFEST_CSS = fs.readFileSync(path.join(ROOT, 'lib', 'manifest.css'), 'utf8')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const NODE_VERSION = require('tailwindcss/package.json').version
const injected = (version) => ({
    engine: tailwindcss,
    themeCss: fs.readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8'),
    utilitiesCss: fs.readFileSync(require.resolve('tailwindcss/utilities.css'), 'utf8'),
    version,
})

const BODY = `<div id="a" class="card flex gap-4 p-4 bg-red-500 text-white w-[37px] md:grid hover:bg-blue-600 rounded-lg shadow-md">a</div>
<div id="m" class="bg-surface-2 text-content-stark row">m</div>
<p id="t" class="text-2xl font-bold tracking-tight underline author-hook">t</p>`
const PROBES = ['#a', '#m', '#t']
const PROPS = ['display', 'gap', 'padding-top', 'background-color', 'color', 'width', 'border-top-left-radius', 'box-shadow', 'font-size', 'font-weight', 'letter-spacing', 'text-decoration-line', 'transform', 'flex-direction']

// Late cases: [body, token that first needs the engine (null: any of the transition classes), property it sets]
// The bake sees this markup, as the backend would; the token only exists once the page runs.
const LATE = {
    bind: [`<div x-data="{ n: 0 }"><div id="late" :class="n ? 'skew-x-' + n : 'p-1'">b</div><button id="go" @click="n = 12">go</button></div>`, 'skew-x-12', 'transform'],
    transition: [`<div id="host"></div><button id="go" onclick="addLate()">go</button><script>
function addLate() {
  const d = document.createElement('div')
  d.id = 'late'
  d.setAttribute('x-data', '{ o: false }')
  d.setAttribute('x-init', '$nextTick(() => o = true)')
  d.setAttribute('x-show', 'o')
  const t = 'x-trans' + 'ition:enter'
  d.setAttribute(t, ['transition-transform', 'duration-' + 1000].join(' '))
  d.setAttribute(t + '-start', 'skew-y-' + 6)
  d.setAttribute(t + '-end', 'skew-y-' + 0)
  d.textContent = 't'
  document.getElementById('host').appendChild(d)
}
</script>`, null, 'transition-duration'],
    inject: [`<div id="host"></div><button id="go" onclick="document.getElementById('host').innerHTML = '<span id=late class=&quot;rotate-6 inline-block&quot;>i</span>'">go</button>`, 'rotate-6', 'rotate'],
    component: [`<div id="host" x-data="{ show: false }"><button id="go" @click="show = true">go</button><template x-if="show"><x-late-card></x-late-card></template></div>`, 'tracking-widest', 'letter-spacing'],
}
const LATE_CARD = '<div id="late" class="tracking-widest">component</div>'

function headFor({ loader, stamp, sheetHref = '/manifest.utilities.css?v=1', sheet = true, legacyComplete = false, author = '', alpine = true, async = false, pre = '' }) {
    const link = !sheet ? '' : `<link rel="stylesheet" href="${sheetHref}" data-mnfst-utilities${legacyComplete ? ' data-mnfst-utilities-complete' : ''}${stamp ? ' ' + stamp.linkAttributes : ''}>${stamp ? stamp.tokensHtml : ''}`
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>s</title>
<link rel="manifest" href="/manifest.json">${pre}
<link rel="stylesheet" href="/fw/manifest.css">${link}${author}
<script${async ? ' async' : ''} src="/fw/${loader}" data-plugin-base="/fw" data-cdn="/cdn"${alpine ? ' data-alpine="/alpine.js"' : ''} data-tailwind></script>
</head>`
}
const page = (opts, body) => `${headFor(opts)}<body>${BODY}\n${body || ''}</body></html>`

async function bake(html, { version = NODE_VERSION, mode = 'skip', sources } = {}) {
    const result = await node.bakeUtilities({ classes: node.scanClasses(html), baseCss: MANIFEST_CSS, tailwind: injected(version) })
    return { css: `@layer base, components, utilities;\n${result.css}`, stamp: node.utilitiesStamp(result, { mode, sources: sources || [html] }) }
}

async function buildPages(loader) {
    const pages = { '/manifest.json': JSON.stringify({ name: 's' }), '/components/late-card.html': LATE_CARD }
    // Bake the page as served (minus the sheet), then serve it with its own stamped sheet
    async function stamped(route, opts, body, bakeOpts = {}, edit = (x) => x) {
        const b = await bake(page({ ...opts, sheet: false }, body), bakeOpts)
        const href = `/u${route}.css`
        pages[href] = b.css
        pages[route] = page({ ...opts, sheetHref: opts.sheetHref || href, stamp: edit(b.stamp) }, body)
        return b
    }
    const plainHtml = page({ loader, sheet: false })
    pages['/manifest.utilities.css'] = (await bake(plainHtml)).css
    pages['/none'] = plainHtml
    pages['/unstamped'] = page({ loader })
    pages['/legacy-complete'] = page({ loader, legacyComplete: true })
    await stamped('/skip', { loader })
    await stamped('/shadow', { loader }, '', { mode: 'shadow' })
    await stamped('/v-mismatch', { loader }, '', { version: '4.3.3' })
    const badSeed = `${ENGINE}:zzzzzz`
    await stamped('/h-mismatch', { loader }, '', {}, (st) => ({ linkAttributes: st.linkAttributes.replace(st.seed, badSeed), tokensHtml: st.tokensHtml.replace(st.seed, badSeed) }))
    await stamped('/unreadable', { loader, sheetHref: '/missing.css' })
    const authorBlock = '<style type="text/tailwindcss">@theme { --color-accent: #123456; }</style>'
    // The backend refuses to stamp a page with an author block: this stamp comes from the page without it
    await stamped('/author', { loader }, '', {}, (st) => st)
    pages['/author'] = pages['/author'].replace('<script src="/fw/', `${authorBlock}\n<script src="/fw/`)
    pages['/author-ref'] = page({ loader, sheet: false, author: authorBlock })
    for (const [name, [body]] of Object.entries(LATE)) {
        await stamped(`/late-${name}`, { loader }, body)
        pages[`/late-${name}-ref`] = page({ loader, sheet: false }, body)
        await stamped(`/shadow-late-${name}`, { loader }, body, { mode: 'shadow' })
    }
    // Async loader, stylesheet slow to arrive (the timing script sits before the sheets: an inline script after one waits for it)
    const timing = '<script>document.addEventListener("alpine:init", () => { window.__alpineAt = performance.now() })</script>'
    await stamped('/async-slow', { loader, async: true, pre: timing, sheetHref: '/slow/stamped.css' })
    pages['/slow/stamped.css'] = pages['/u/async-slow.css']
    pages['/slow/ref.css'] = pages['/u/async-slow.css']
    pages['/async-slow-ref'] = page({ loader, async: true, pre: timing, sheetHref: '/slow/ref.css' })
    // Parity: tokens recorded on a page vs the node scan of its HTML
    const parityBody = `<div class="[&>*]:p-2 [&amp;_p]:mt-2 content-['>'] data-[x=a&gt;b]:flex" x-transition:enter="opacity-0 scale-90"></div>
<div :class="{ 'ring-2 ring-blue-500': true, hidden: false }"></div><span class='size-6 !font-bold'></span>`
    pages['/parity'] = page({ loader, sheet: false }, parityBody)
    return { pages }
}

const sample = (page) => page.evaluate((probes, props) => probes.map((sel) => {
    const el = document.querySelector(sel)
    const cs = getComputedStyle(el)
    return props.map((p) => cs.getPropertyValue(p)).join('|')
}), PROBES, PROPS)
const engineTags = (page) => page.evaluate(() => document.querySelectorAll('script[src*="tailwind"]').length)
const verdict = (page) => page.evaluate(() => window.Manifest && window.Manifest.tailwindStamp)
const ready = (page) => page.waitForFunction(() => window.__manifestReady === true, { timeout: 20000 }).catch(() => { })

async function run(loader) {
    console.log(`\n=== ${loader} ===`)
    const { pages } = await buildPages(loader)
    const srv = await serve({ libDir: LIB, pages, delayPaths: { '/slow/stamped.css': 2500, '/slow/ref.css': 2500 } })
    const base = BASE_LIB ? await serve({ libDir: BASE_LIB, pages }) : null
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })

    async function visit(server, route, { ctx, settle = 1200, keep = false } = {}) {
        const context = ctx || await browser.createBrowserContext()
        const p = await context.newPage()
        const requests = []
        p.on('request', (r) => { const u = new URL(r.url()); if (u.hostname === HOST) requests.push(u.pathname + u.search) })
        const errors = []
        p.on('pageerror', (e) => errors.push(String(e)))
        server.counts.engine = 0
        await p.goto(`http://${HOST}:${server.port}${route}`, { waitUntil: 'load' })
        await ready(p)
        await wait(settle)
        const out = { page: p, ctx: context, requests, errors, engine: server.counts.engine, tags: await engineTags(p), styles: await sample(p), verdict: await verdict(p) }
        if (!keep) { await p.close(); if (!ctx) await context.close() }
        return out
    }

    try {
        // 1. Inert without a stamp
        const reference = await visit(srv, '/none')
        for (const route of ['/none', '/unstamped', '/legacy-complete']) {
            const r = route === '/none' ? reference : await visit(srv, route)
            check(`${route}: engine requested once`, r.engine === 1 && r.tags === 1, `server ${r.engine}, tags ${r.tags}`)
            check(`${route}: no verdict`, r.verdict === null, JSON.stringify(r.verdict))
            check(`${route}: no page errors`, r.errors.length === 0, r.errors.join('; '))
            if (base) {
                const m = await visit(base, route)
                // Base lib: the retired watcher saw author classes over a -complete sheet and fetched the engine a second time
                if (route === '/legacy-complete') {
                    const i = m.requests.indexOf('/fw/manifest.tailwind.js')
                    // Only manifest.js: the retired watcher's selector never matched manifest.min.js
                    if (loader === 'manifest.js') check('/legacy-complete: the base lib fetched the engine twice; this one once', i > -1 && !r.requests.includes('/fw/manifest.tailwind.js'), JSON.stringify(m.requests.filter((u) => /tailwind/.test(u))))
                    if (i > -1) m.requests.splice(i, 1)
                }
                const same = JSON.stringify(m.requests) === JSON.stringify(r.requests)
                const sameSet = JSON.stringify([...m.requests].sort()) === JSON.stringify([...r.requests].sort())
                check(`${route}: same requests as the base lib (set)`, sameSet, sameSet ? `${r.requests.length} requests` : `base ${JSON.stringify(m.requests)}\n      this ${JSON.stringify(r.requests)}`)
                check(`${route}: same requests as the base lib (order)`, same || sameSet, same ? '' : 'same set, order differs')
                check(`${route}: same computed styles as the base lib`, JSON.stringify(m.styles) === JSON.stringify(r.styles))
            }
        }

        // 2. Matching skip stamp
        const skip = await visit(srv, '/skip')
        check('/skip: engine never requested', skip.engine === 0 && skip.tags === 0, `server ${skip.engine}, tags ${skip.tags}`)
        check('/skip: verdict accepted, skipped', skip.verdict && skip.verdict.accepted === true && skip.verdict.engine === 'skipped' && skip.verdict.wouldSkip === true, JSON.stringify(skip.verdict))
        const diff = reference.styles.map((v, i) => v === skip.styles[i] ? null : `${PROBES[i]}: ${JSON.stringify(v)}  vs  ${JSON.stringify(skip.styles[i])}`).filter(Boolean)
        check('/skip: computed styles equal the engine run', diff.length === 0, diff.join('\n      '))
        check('/skip: no page errors', skip.errors.length === 0, skip.errors.join('; '))
        {
            const unstamped = await visit(srv, '/unstamped')
            const norm = (list) => list.filter((u) => !/utilities\.css|^\/u\//.test(u)).sort()
            const missing = norm(unstamped.requests).filter((u) => u !== '/unstamped' && !norm(skip.requests).includes(u))
            const extra = norm(skip.requests).filter((u) => u !== '/skip' && !norm(unstamped.requests).includes(u))
            check('/skip: only the engine request is gone (vs the unstamped page)', missing.length === 1 && /tailwind/.test(missing[0]) && extra.length === 0, `missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`)
        }
        {
            const r = await visit(srv, '/skip', { keep: true })
            await r.page.hover('#a')
            const hover = await r.page.$eval('#a', (e) => getComputedStyle(e).backgroundColor)
            await r.page.close(); await r.ctx.close()
            const ref = await visit(srv, '/none', { keep: true })
            await ref.page.hover('#a')
            const refHover = await ref.page.$eval('#a', (e) => getComputedStyle(e).backgroundColor)
            await ref.page.close(); await ref.ctx.close()
            check('/skip: hover: variant equals the engine run', hover === refHover, `${hover} vs ${refHover}`)
        }

        // 3. Any doubt loads the engine
        for (const [route, reason] of [['/v-mismatch', 'seed'], ['/h-mismatch', 'seed'], ['/unreadable', 'sheet'], ['/author', 'author-block']]) {
            const r = await visit(srv, route, { settle: route === '/unreadable' ? 2000 : 1200 })
            const ref = route === '/author' ? await visit(srv, '/author-ref') : reference
            check(`${route}: engine requested once`, r.engine === 1 && r.tags === 1, `server ${r.engine}, tags ${r.tags}`)
            check(`${route}: refused for ${reason}`, r.verdict && r.verdict.accepted === false && r.verdict.reason === reason, JSON.stringify(r.verdict))
            check(`${route}: styled like the engine run`, JSON.stringify(r.styles) === JSON.stringify(ref.styles), r.styles.filter((v, i) => v !== ref.styles[i]).join(' / '))
        }

        // 4. A token outside the stamp later
        for (const [name, [, token, prop]] of Object.entries(LATE)) {
            const ctx = await browser.createBrowserContext()
            const r = await visit(srv, `/late-${name}`, { ctx, keep: true })
            check(`late ${name}: engine not requested at boot`, r.engine === 0 && r.tags === 0, `server ${r.engine}, tags ${r.tags}`)
            srv.counts.engine = 0
            await r.page.click('#go')
            await r.page.waitForFunction(() => document.querySelector('#late'), { timeout: 5000 }).catch(() => { })
            await wait(name === 'transition' ? 500 : 1500)
            const v = await verdict(r.page)
            const tags = await engineTags(r.page)
            check(`late ${name}: engine loaded once`, srv.counts.engine === 1 && tags === 1, `server ${srv.counts.engine}, tags ${tags}`)
            check(`late ${name}: trigger recorded`, v && v.trigger && v.trigger.reason === 'token' && (token ? v.trigger.token === token : ['transition-transform', 'duration-1000', 'skew-y-6', 'skew-y-0'].includes(v.trigger.token)), JSON.stringify(v && v.trigger))
            const got = await r.page.$eval('#late', (e, p) => getComputedStyle(e).getPropertyValue(p), prop)
            const unstyled = await r.page.evaluate((p) => { const d = document.createElement('div'); document.body.appendChild(d); const v = getComputedStyle(d).getPropertyValue(p); d.remove(); return v }, prop)
            if (name === 'transition') {
                // The first run may start before the engine's CSS lands (Alpine reads the duration at start); the next one is styled
                await r.page.evaluate(() => { document.getElementById('late').id = 'late-first'; addLate() })
                await wait(300)
                const again = await r.page.$eval('#late', (e) => getComputedStyle(e).transitionDuration)
                check(`late transition: duration-1000 styled on the next transition`, again === '1s', `${again} (first run ${got}), unstyled ${unstyled}`)
            } else {
                const ref = await visit(srv, `/late-${name}-ref`, { keep: true })
                await ref.page.click('#go')
                await ref.page.waitForFunction(() => document.querySelector('#late'), { timeout: 5000 }).catch(() => { })
                await wait(1500)
                const want = await ref.page.$eval('#late', (e, p) => getComputedStyle(e).getPropertyValue(p), prop)
                await ref.page.close(); await ref.ctx.close()
                check(`late ${name}: ${token} styled (${prop})`, got === want && got !== unstyled, `${got} vs engine ${want}, unstyled ${unstyled}`)
            }
            check(`late ${name}: no page errors`, r.errors.length === 0, r.errors.join('; '))
            await r.page.close()
            if (name === 'bind') {
                const again = await visit(srv, `/late-${name}`, { ctx, settle: 800 })
                check('remembered: next visit loads the engine at boot', again.tags === 1 && again.verdict.reason === 'remembered', JSON.stringify(again.verdict))
                const other = await visit(srv, '/skip', { ctx })
                check('remembered: per sheet, so /skip (another sheet) still skips', other.tags === 0 && other.verdict.accepted === true, JSON.stringify(other.verdict))
            }
            await ctx.close()
        }

        // 5. Shadow mode
        const shadow = await visit(srv, '/shadow')
        check('/shadow: engine requested once (as today)', shadow.engine === 1 && shadow.tags === 1, `server ${shadow.engine}`)
        check('/shadow: reports it would have skipped', shadow.verdict && shadow.verdict.mode === 'shadow' && shadow.verdict.accepted === true && shadow.verdict.wouldSkip === true && shadow.verdict.trigger === null, JSON.stringify(shadow.verdict))
        {
            const unstamped = await visit(srv, '/unstamped')
            const norm = (list) => list.map((u) => u.replace(/^\/u\/shadow\.css$|^\/manifest\.utilities\.css\?v=1$/, '<sheet>').replace(/^\/(shadow|unstamped)$/, '<page>')).sort()
            check('/shadow: same requests as the unstamped page', JSON.stringify(norm(shadow.requests)) === JSON.stringify(norm(unstamped.requests)), `${JSON.stringify(norm(shadow.requests))}\n      vs ${JSON.stringify(norm(unstamped.requests))}`)
        }
        for (const [name, [, token]] of Object.entries(LATE)) {
            const r = await visit(srv, `/shadow-late-${name}`, { keep: true })
            await r.page.click('#go')
            await wait(name === 'transition' ? 500 : 1500)
            const v = await verdict(r.page)
            const tags = await engineTags(r.page)
            await r.page.close(); await r.ctx.close()
            check(`/shadow-late-${name}: engine once, trigger reported`, tags === 1 && v.accepted === true && v.wouldSkip === false && v.trigger && (!token || v.trigger.token === token), JSON.stringify(v))
        }

        // 7. Async loader, sheet still loading
        {
            const r = await visit(srv, '/async-slow', { keep: true })
            const at = await r.page.evaluate(() => window.__alpineAt)
            await r.page.close(); await r.ctx.close()
            const ref = await visit(srv, '/async-slow-ref', { keep: true })
            const refAt = await ref.page.evaluate(() => window.__alpineAt)
            await ref.page.close(); await ref.ctx.close()
            check('async + slow sheet: refused for sheet, engine once', r.verdict && r.verdict.reason === 'sheet' && r.tags === 1, JSON.stringify(r.verdict))
            check('async + slow sheet: Alpine not held back by the sheet', at < 1500 && Math.abs(at - refAt) < 400, `alpine:init ${Math.round(at)} ms vs unstamped ${Math.round(refAt)} ms`)
        }

        // 6. Scan parity in Chromium
        {
            const r = await visit(srv, '/parity', { keep: true })
            const browserTokens = await r.page.evaluate(async () => {
                const c = window.ManifestUtilities
                await c.scanStaticClasses()
                return [...new Set([...c.staticClassCache, ...c.dynamicClassCache])].sort()
            })
            await r.page.close(); await r.ctx.close()
            const nodeTokens = node.scanClasses(pages['/parity'])
            const onlyNode = nodeTokens.filter((t) => !browserTokens.includes(t))
            // $color adds light/dark to <html> at runtime
            const onlyBrowser = browserTokens.filter((t) => !nodeTokens.includes(t) && t !== 'light' && t !== 'dark')
            for (const t of ['[&>*]:p-2', '[&_p]:mt-2', "content-['>']", 'data-[x=a>b]:flex']) check(`parity: ${t} on both sides`, nodeTokens.includes(t) && browserTokens.includes(t))
            check('parity: browser records no token the node scan missed', onlyBrowser.length === 0, JSON.stringify(onlyBrowser))
            check('parity: node scan has no token the browser misses', onlyNode.length === 0, JSON.stringify(onlyNode))
        }
    } finally {
        await browser.close()
        await srv.close()
        if (base) await base.close()
    }
}

for (const loader of ['manifest.js', 'manifest.min.js']) await run(loader)
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
