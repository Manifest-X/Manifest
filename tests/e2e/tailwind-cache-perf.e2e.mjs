/**
 * Bench: main-thread cost of the Tailwind engine on a warm repeat visit, unthrottled and at 6x CPU.
 *
 * Variants: "engine" (data-tailwind, whatever the lib does), "inline" (no engine; its CSS inlined in
 * <head>: the floor a cache can reach). Reports medians of N measured loads after warm-up loads.
 *
 * Run: npm run build && node tests/e2e/tailwind-cache-perf.e2e.mjs [--lib <dir>] [--runs 5]
 */
import puppeteer from 'puppeteer'
import path from 'path'
import { serve, pageHtml } from './fixtures/tailwind-cache-site.mjs'

const args = process.argv.slice(2)
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const LIB = argVal('--lib', undefined)
const RUNS = Number(argVal('--runs', 5))
const HOST = 'app.example'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const PROBE = `
(function () {
  window.__tw = { styleAt: null, appliedAt: null, cls: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__tw.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  const tick = () => {
    if (window.__tw.styleAt === null) {
      for (const s of document.querySelectorAll('style')) { if ((s.textContent || '').startsWith('/*! tailwindcss')) { window.__tw.styleAt = performance.now(); break; } }
    }
    const el = document.getElementById('probe-w');
    if (el && getComputedStyle(el).width === '37px') { window.__tw.appliedAt = performance.now(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`

function analyse(events) {
    const main = events.find((e) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
    if (!main) return null
    const onMain = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X')
    const nav = events.find((e) => e.name === 'navigationStart' && e.pid === main.pid) || events.find((e) => e.name === 'TracingStartedInBrowser')
    const t0 = nav ? nav.ts : Math.min(...onMain.map((e) => e.ts))
    const tasks = onMain.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask').filter((e) => e.ts >= t0)
    // Top-level tasks only (nested RunTask can appear)
    tasks.sort((a, b) => a.ts - b.ts)
    let busy = 0, end = 0
    for (const t of tasks) { if (t.ts >= end) { busy += t.dur; end = t.ts + t.dur } }
    const isTw = (e) => /tailwind/.test(e.args?.data?.url || e.args?.data?.scriptName || e.args?.fileName || '')
    let engine = 0
    for (const e of onMain) {
        if (e.ts < t0) continue
        if ((e.name === 'EvaluateScript' || e.name === 'v8.compile' || e.name === 'FunctionCall' || e.name === 'v8.parseOnBackground') && isTw(e)) engine += e.dur
    }
    // The engine's first build runs in microtasks of its evaluate task: count that whole task
    const evalTw = onMain.find((e) => e.name === 'EvaluateScript' && isTw(e) && e.ts >= t0)
    let engineTask = 0
    if (evalTw) {
        const host = tasks.find((t) => t.ts <= evalTw.ts && t.ts + t.dur >= evalTw.ts + evalTw.dur)
        if (host) engineTask = host.dur
    }
    const recalc = onMain.filter((e) => e.ts >= t0 && (e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles')).reduce((a, e) => a + e.dur, 0)
    const layout = onMain.filter((e) => e.ts >= t0 && e.name === 'Layout').reduce((a, e) => a + e.dur, 0)
    return { busy: busy / 1000, engine: engine / 1000, engineTask: engineTask / 1000, recalc: recalc / 1000, layout: layout / 1000 }
}

async function measure(browser, url, rate, label) {
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    await page.evaluateOnNewDocument(PROBE)
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setCPUThrottlingRate', { rate })
    const rows = []
    for (let i = 0; i < 2 + RUNS; i++) {
        const measured = i >= 2
        if (measured) await page.tracing.start({ categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'blink.user_timing', 'loading'] })
        await page.goto(url, { waitUntil: 'load' })
        await page.waitForFunction(() => window.__tw.appliedAt !== null, { timeout: 30000 }).catch(() => { })
        await wait(rate > 1 ? 4000 : 1500)
        if (!measured) continue
        const buf = await page.tracing.stop()
        const { traceEvents } = JSON.parse(Buffer.from(buf).toString("utf8"))
        const a = analyse(traceEvents)
        const inPage = await page.evaluate(() => ({ ...window.__tw, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null }))
        rows.push({ ...a, ...inPage })
    }
    await ctx.close()
    const med = (k) => { const v = rows.map((r) => r[k]).filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null }
    const f = (x) => x === null ? 'n/a' : x.toFixed(x < 1 ? 3 : 1)
    const out = { label, rate, busy: med('busy'), engine: med('engine'), engineTask: med('engineTask'), recalc: med('recalc'), layout: med('layout'), styleAt: med('styleAt'), appliedAt: med('appliedAt'), fcp: med('fcp'), cls: med('cls') }
    console.log(`${label.padEnd(8)} ${String(rate).padStart(2)}x  busy ${f(out.busy)}ms  engineJS ${f(out.engine)}ms  engineTask ${f(out.engineTask)}ms  recalc ${f(out.recalc)}ms  layout ${f(out.layout)}ms  twStyle@ ${f(out.styleAt)}ms  applied@ ${f(out.appliedAt)}ms  FCP ${f(out.fcp)}ms  CLS ${f(out.cls)}`)
    return out
}

async function captureEngineCss(browser, url) {
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForFunction(() => [...document.querySelectorAll('style')].some((s) => (s.textContent || '').startsWith('/*! tailwindcss') && s.textContent.includes('37px')), { timeout: 30000 })
    await wait(1000)
    const css = await page.evaluate(() => [...document.querySelectorAll('style')].filter((s) => (s.textContent || '').startsWith('/*! tailwindcss')).pop().textContent)
    await ctx.close()
    return css
}

async function main() {
    let inlineCss = ''
    const srv = await serve({
        libDir: LIB ? path.resolve(LIB) : undefined,
        pages: {
            '/': () => pageHtml({ tailwind: true }),
            '/inline': () => pageHtml({ tailwind: false, extraHead: `<style>${inlineCss}</style>` }),
        },
    })
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })
    try {
        const base = `http://${HOST}:${srv.port}`
        inlineCss = await captureEngineCss(browser, `${base}/`)
        console.log(`engine CSS: ${inlineCss.length} chars; lib: ${LIB || 'lib'}; runs: ${RUNS} (medians, warm repeat visits)`)
        const results = []
        for (const rate of [1, 6]) {
            results.push(await measure(browser, `${base}/`, rate, 'engine'))
            results.push(await measure(browser, `${base}/inline`, rate, 'inline'))
        }
        for (const rate of [1, 6]) {
            const e = results.find((r) => r.label === 'engine' && r.rate === rate)
            const n = results.find((r) => r.label === 'inline' && r.rate === rate)
            console.log(`${rate}x: main-thread busy delta engine - inline = ${(e.busy - n.busy).toFixed(1)}ms; applied@ delta = ${(e.appliedAt - n.appliedAt).toFixed(1)}ms`)
        }
    } finally {
        await browser.close()
        await srv.close()
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
