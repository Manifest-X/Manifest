/**
 * Row-select perf probe (Playcom Records shape): ~29k elements, 43 [x-route] areas,
 * a list whose row click navigates to a sub-route (/records/contacts/<id>).
 * Counts gBCR / gCS / querySelector* per click and main-thread time (CDP metrics +
 * CPU profile self time attributed to /scripts/manifest.*).
 *
 * Run: node tests/e2e/row-select-perf.e2e.mjs [--clicks 10] [--cadence 400] [--throttle 4] [--json] [--assert]
 * --assert fails on forced-layout / query counts per click (machine-independent), stale JIT styling or errors.
 */
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, existsSync } from 'fs'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.js')

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def }
const CLICKS = arg('clicks', 10)
const CADENCE = arg('cadence', 400)
const JSON_OUT = process.argv.includes('--json')
const THROTTLE = arg('throttle', 1)
const ASSERT = process.argv.includes('--assert')
const BUDGET = { gbcrPerClick: 20, gcsPerClick: 20, qsPerClick: 50, styleWrites: 0.5 }

const ROWS = 200
const PAGES = 42
const CARDS = 56
const STATUSES = ['bg-surface-2', 'bg-surface-3', 'text-content-subtle', 'border', 'rounded', 'font-medium']
const HUES = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'slate', 'gray', 'zinc', 'neutral', 'stone']
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const PALETTE = HUES.flatMap((h) => SHADES.map((s) => h + '-' + s))
const VARIANTS = ['hover', 'focus', 'active', 'md', 'lg', 'dark']
// Static JIT load (~Playcom-sized #manifest-styles): cards cycle palette classes
const cardClasses = (p, c) => { const k = p * 56 + c; return `bg-${PALETTE[k % PALETTE.length]} hover:text-${PALETTE[(k * 3) % PALETTE.length]}` }

// ---- Fixture ----

function card(p, c) {
    const id = `p${p}c${c}`
    return `<div class="col gap-2 p-3 border rounded ${cardClasses(p, c)}">
  <div class="row items-center gap-2"><span class="w-6 h-6 rounded-full bg-surface-2"></span><strong class="text-sm">Card ${c}</strong><button popovertarget="${id}m" class="text-xs">...</button></div>
  <menu popover id="${id}m"><li><button>Open</button></li><li><button>Share</button></li><li><button>Remove</button></li></menu>
  <p class="text-xs text-content-subtle">Lorem ipsum <em>dolor</em> sit <b>amet</b></p>
  <details><summary class="text-xs">More</summary><ul><li>One</li><li>Two</li><li>Three</li></ul></details>
</div>`
}

function page(p) {
    const cards = Array.from({ length: CARDS }, (_, c) => card(p, c)).join('\n')
    return `<section x-route="page-${p}" class="col gap-4">
  <h1>Page ${p}</h1>
  <dialog id="p${p}d"><form><p>Dialog</p><button>OK</button></form></dialog>
  <div hidden><p>Hidden block</p><span>Filler</span></div>
  <div class="grid gap-3" style="grid-template-columns:repeat(4,1fr)">${cards}</div>
</section>`
}

function row(i) {
    const id = `c${i}`
    return `<div class="row items-center gap-2 px-3 py-2 border-b" x-data="{ id: '${id}' }" :class="$route.endsWith('/' + id) ? 'bg-surface-3' : ''">
  <a id="r${i}" href="/records/contacts/${id}" class="row items-center gap-2 no-underline" style="flex:1"><span class="w-6 h-6 rounded-full bg-surface-2"></span><span class="text-sm font-medium">Contact ${i}</span><span class="text-xs text-content-subtle">contact${i}@example.com</span><span class="text-xs">Active</span></a>
  <button popovertarget="m${i}" class="text-xs">...</button>
  <menu popover id="m${i}"><li><button>Edit</button></li><li><button>Archive</button></li><li><button>Delete</button></li></menu>
</div>`
}

function toolbar() {
    let out = ''
    for (let i = 0; i < 12; i++) out += `<details class="text-xs"><summary>Filter ${i}</summary><ul><li>A</li><li>B</li><li>C</li></ul></details>`
    for (let i = 0; i < 8; i++) out += `<dialog><p>Toolbar dialog ${i}</p><button>Close</button></dialog>`
    for (let i = 0; i < 8; i++) out += `<menu popover><li><button>Orphan ${i}</button></li></menu>`
    for (let i = 0; i < 8; i++) out += `<div hidden><p>Hidden hint ${i}</p></div>`
    return out
}

function buildFixture() {
    const nav = Array.from({ length: PAGES }, (_, p) => `<a href="/page-${p}" class="px-2 py-1 text-sm">Page ${p}</a>`).join('')
    const rows = Array.from({ length: ROWS }, (_, i) => row(i)).join('\n')
    const pages = Array.from({ length: PAGES }, (_, p) => page(p)).join('\n')
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Row select perf</title>
<link rel="stylesheet" href="/styles/core/manifest.theme.css">
<link rel="stylesheet" href="/styles/core/manifest.reset.css">
<link rel="stylesheet" href="/styles/utilities/manifest.utilities.css">
<link rel="stylesheet" href="/styles/utilities/manifest.colors.css">
<style>html,body{height:100%;margin:0}.shell{display:flex;height:100vh}.shell>nav{width:180px;overflow:auto;display:flex;flex-direction:column}.shell>main{flex:1;overflow:auto;padding:1rem}.list{height:70vh;overflow:auto;width:520px}.detail{flex:1}</style>
<script>
document.addEventListener('alpine:init', () => {
  const STATUSES = ${JSON.stringify(STATUSES)};
  const PALETTE = ${JSON.stringify(PALETTE)};
  const VARIANTS = ${JSON.stringify(VARIANTS)};
  Alpine.data('detail', () => ({
    get current() {
      const id = this.$route.split('/').pop();
      if (!/^c\\d+$/.test(id)) return [];
      const n = Number(id.slice(1));
      // Each record brings classes the JIT has not seen yet
      const fresh = VARIANTS[n % VARIANTS.length] + ':border-' + PALETTE[(n * 7) % PALETTE.length];
      return [{ id, name: 'Contact ' + n, badge: STATUSES[n % STATUSES.length] + ' ' + fresh,
        fields: Array.from({ length: 40 }, (_, k) => ({ k: 'field' + k, v: id + '-' + k })) }];
    }
  }));
});
</script>
<script src="/scripts/manifest.utilities.js"></script>
<script src="/scripts/manifest.router.js"></script>
<script src="/scripts/manifest.defer.js"></script>
<script defer src="/__alpine.js"></script>
</head>
<body x-data>
<div class="shell">
<nav>${nav}<a href="/records" class="px-2 py-1 text-sm">Records</a></nav>
<main>
<section x-route="records" class="col gap-4">
  <div class="row gap-2">${toolbar()}</div>
  <div class="row gap-4">
    <div class="list" id="list">${rows}</div>
    <section x-route="records/contacts/*" class="detail col gap-3 p-4" x-data="detail">
      <template x-for="rec in current" :key="rec.id">
        <div class="col gap-3">
          <h2 x-text="rec.name"></h2>
          <span :class="rec.badge" class="text-xs px-2">status</span>
          <button :popovertarget="rec.id + 'dm'" class="text-xs">Actions</button>
          <menu popover :id="rec.id + 'dm'"><li><button>Merge</button></li><li><button>Export</button></li></menu>
          <template x-for="f in rec.fields" :key="f.k"><div class="row gap-2 text-sm" x-data><span class="text-content-subtle" style="width:8rem" x-text="f.k"></span><span x-text="f.v"></span></div></template>
          <details><summary>History</summary><ul><li>Created</li><li>Updated</li><li>Merged</li></ul></details>
        </div>
      </template>
    </section>
  </div>
</section>
${pages}
</main>
</div>
</body>
</html>`
}

// ---- Server ----

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' }

function serve(html) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://x')
            let file = null
            if (url.pathname === '/__alpine.js') file = ALPINE
            else if (/^\/(scripts|styles)\//.test(url.pathname)) file = path.join(SRC, url.pathname)
            if (file) {
                if (!existsSync(file)) { res.writeHead(404); res.end(); return }
                res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
                res.end(readFileSync(file))
                return
            }
            if (path.extname(url.pathname)) { res.writeHead(404); res.end(); return }
            res.writeHead(200, { 'content-type': 'text/html' })
            res.end(html)
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

// ---- Instrumentation ----

const COUNTERS = `
(() => {
  const c = window.__perfCounts = { gbcr: 0, gcs: 0, qs: 0, qsa: 0, styleWrites: 0 };
  let watched = null;
  new MutationObserver(() => {
    const el = document.getElementById('manifest-styles');
    if (!el || el === watched) return;
    watched = el;
    new MutationObserver(() => { c.styleWrites++; }).observe(el, { childList: true, characterData: true, subtree: true });
  }).observe(document, { childList: true, subtree: true });
  const wrap = (proto, name, key) => {
    const orig = proto[name];
    proto[name] = function () { c[key]++; return orig.apply(this, arguments); };
  };
  wrap(Element.prototype, 'getBoundingClientRect', 'gbcr');
  wrap(Element.prototype, 'querySelector', 'qs');
  wrap(Element.prototype, 'querySelectorAll', 'qsa');
  wrap(Document.prototype, 'querySelector', 'qs');
  wrap(Document.prototype, 'querySelectorAll', 'qsa');
  wrap(DocumentFragment.prototype, 'querySelector', 'qs');
  wrap(DocumentFragment.prototype, 'querySelectorAll', 'qsa');
  const gcs = window.getComputedStyle;
  window.getComputedStyle = function () { c.gcs++; return gcs.apply(window, arguments); };
})();
`

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function metrics(cdp) {
    const { metrics } = await cdp.send('Performance.getMetrics')
    const m = {}
    for (const { name, value } of metrics) m[name] = value
    return m
}

function attribute(profile) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const self = new Map()
    for (let i = 0; i < profile.samples.length; i++) {
        const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000
        self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + dt)
    }
    const out = { manifest: 0, alpine: 0, other: 0, byFile: {}, byFn: {} }
    for (const [id, ms] of self) {
        const n = byId.get(id)
        const url = n.callFrame.url || ''
        const fn = n.callFrame.functionName
        if (fn === '(idle)' || fn === '(program)' || fn === '(garbage collector)' || fn === '(root)') continue
        if (/\/scripts\/manifest\./.test(url)) {
            out.manifest += ms
            const f = url.split('/').pop()
            out.byFile[f] = (out.byFile[f] || 0) + ms
            const fk = f + ':' + (fn || '(anon)') + ':' + (n.callFrame.lineNumber + 1)
            out.byFn[fk] = (out.byFn[fk] || 0) + ms
        } else if (/__alpine/.test(url)) out.alpine += ms
        else out.other += ms
    }
    return out
}

const clickRow = async (page, i) => {
    const box = await page.$eval(`#r${i}`, (el) => { el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })
    await page.mouse.click(box.x, box.y)
}

async function main() {
    const html = buildFixture()
    const server = await serve(html)
    const base = `http://127.0.0.1:${server.address().port}`
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1400, height: 900 })
        await page.evaluateOnNewDocument(COUNTERS)
        const errors = []
        page.on('pageerror', (e) => errors.push(String(e.message)))
        await page.goto(`${base}/records/contacts/c0`, { waitUntil: 'load' })
        await page.waitForFunction(() => window.Alpine && window.ManifestDefer && document.querySelector('.detail h2')?.textContent === 'Contact 0', { timeout: 15000 })
        await wait(6000) // boot drain + first compile + bootDrained timer
        const elements = await page.evaluate(() => document.getElementsByTagName('*').length)
        const routes = await page.evaluate(() => document.querySelectorAll('[x-route]').length)
        const cdp = await page.createCDPSession()
        await cdp.send('Performance.enable')
        if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })

        // Warm-up: every badge class seen once
        for (let i = 1; i <= STATUSES.length + 1; i++) { await clickRow(page, i); await wait(900) }
        const stats = await page.evaluate(() => window.ManifestDefer.stats())

        // A: isolated clicks, 1s quiet window each
        const iso = []
        for (let k = 0; k < CLICKS; k++) {
            const i = 20 + k
            await page.evaluate(() => { const c = window.__perfCounts; c.gbcr = c.gcs = c.qs = c.qsa = c.styleWrites = 0 })
            const before = await metrics(cdp)
            await clickRow(page, i)
            await wait(1000)
            const after = await metrics(cdp)
            const counts = await page.evaluate(() => ({ ...window.__perfCounts }))
            const ok = await page.evaluate((id) => document.querySelector('.detail h2')?.textContent === 'Contact ' + id, i)
            iso.push({
                ok, ...counts,
                task: (after.TaskDuration - before.TaskDuration) * 1000,
                script: (after.ScriptDuration - before.ScriptDuration) * 1000,
                style: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
                layout: (after.LayoutDuration - before.LayoutDuration) * 1000
            })
        }

        // B: cadence run under the CPU profiler
        await cdp.send('Profiler.enable')
        await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
        await page.evaluate(() => { const c = window.__perfCounts; c.gbcr = c.gcs = c.qs = c.qsa = c.styleWrites = 0 })
        const before = await metrics(cdp)
        await cdp.send('Profiler.start')
        for (let k = 0; k < CLICKS; k++) { await clickRow(page, 60 + k); await wait(CADENCE) }
        await wait(1000)
        const { profile } = await cdp.send('Profiler.stop')
        const after = await metrics(cdp)
        const cadCounts = await page.evaluate(() => ({ ...window.__perfCounts }))
        const attr = attribute(profile)
        const ok = await page.evaluate((id) => document.querySelector('.detail h2')?.textContent === 'Contact ' + id, 60 + CLICKS - 1)

        // Fresh JIT classes from the last clicks must actually style the badge (lg: and md: variants active at 1400px)
        const freshApplied = []
        for (const i of [99, 100, 105]) {
            await clickRow(page, i)
            await wait(700)
            freshApplied.push(await page.evaluate((n, P, V) => {
                const color = P[(n * 7) % P.length]
                const badge = document.querySelector('.detail span[class*="border-"]')
                const probe = document.createElement('span')
                probe.style.color = 'var(--color-' + color + ')'
                document.body.appendChild(probe)
                const want = getComputedStyle(probe).color
                probe.remove()
                const got = getComputedStyle(badge).borderTopColor
                return { cls: V[n % V.length] + ':border-' + color, ok: got === want, got, want }
            }, i, PALETTE, VARIANTS))
        }
        const utilitiesText = await page.evaluate(() => document.getElementById('manifest-styles').textContent.length)

        const avg = (xs, k) => xs.reduce((s, x) => s + x[k], 0) / xs.length
        const r1 = (x) => Math.round(x * 10) / 10
        const result = {
            fixture: { throttle: THROTTLE, elements, routes, deferPending: stats.pending, deferWarm: stats.warm },
            isolated: {
                allRendered: iso.every((x) => x.ok),
                styleWrites: r1(avg(iso, 'styleWrites')), gbcr: r1(avg(iso, 'gbcr')), gcs: r1(avg(iso, 'gcs')), qs: r1(avg(iso, 'qs')), qsa: r1(avg(iso, 'qsa')),
                taskMs: r1(avg(iso, 'task')), scriptMs: r1(avg(iso, 'script')), styleMs: r1(avg(iso, 'style')), layoutMs: r1(avg(iso, 'layout'))
            },
            cadence: {
                cadenceMs: CADENCE, clicks: CLICKS, lastRendered: ok,
                taskMsPerClick: r1((after.TaskDuration - before.TaskDuration) * 1000 / CLICKS),
                manifestMsPerClick: r1(attr.manifest / CLICKS),
                alpineMsPerClick: r1(attr.alpine / CLICKS),
                manifestByFile: Object.fromEntries(Object.entries(attr.byFile).map(([f, ms]) => [f, r1(ms / CLICKS)])),
                topFns: Object.entries(attr.byFn).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f, ms]) => f + ' ' + r1(ms / CLICKS)),
                gbcrPerClick: r1(cadCounts.gbcr / CLICKS), gcsPerClick: r1(cadCounts.gcs / CLICKS),
                qsPerClick: r1((cadCounts.qs + cadCounts.qsa) / CLICKS)
            },
            freshApplied, utilitiesText,
            errors
        }
        console.log(JSON_OUT ? JSON.stringify(result) : JSON.stringify(result, null, 2))
        if (ASSERT) {
            const fails = []
            for (const k of ['gbcrPerClick', 'gcsPerClick', 'qsPerClick']) if (result.cadence[k] > BUDGET[k]) fails.push(`${k} ${result.cadence[k]} > ${BUDGET[k]}`)
            if (result.isolated.styleWrites > BUDGET.styleWrites) fails.push(`styleWrites ${result.isolated.styleWrites} > ${BUDGET.styleWrites}`)
            if (!result.isolated.allRendered || !result.cadence.lastRendered) fails.push('detail pane did not follow the route')
            if (!freshApplied.every((f) => f.ok)) fails.push('fresh JIT class not applied')
            if (errors.length) fails.push('page errors: ' + errors.join('; '))
            if (fails.length) { console.error('FAIL\n  ' + fails.join('\n  ')); process.exitCode = 1 }
            else console.error('PASS')
        }
    } finally {
        await browser.close()
        server.close()
    }
}

if (process.env.SERVE_ONLY) { serve(buildFixture()).then((s) => console.log("http://127.0.0.1:" + s.address().port)) } else main().catch((e) => { console.error(e); process.exit(1) })
