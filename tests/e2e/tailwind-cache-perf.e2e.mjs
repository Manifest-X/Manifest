/**
 * Bench: warm repeat visits, master lib vs this lib, runs interleaved in one session.
 *
 * Per load: main-thread busy (top-level tasks, navigation to settle), style recalc, time to the
 * Tailwind styles applying, CLS. Also an "inline" floor: no engine, its CSS inlined in <head>.
 *
 * Run: npm run build && node tests/e2e/tailwind-cache-perf.e2e.mjs --master <lib dir> [--branch <lib dir>] [--runs 9] [--rates 1,6] [--page default|app|sized:<KB>]
 */
import puppeteer from 'puppeteer'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { serve, pageHtml, sitePage, twClasses } from './fixtures/tailwind-cache-site.mjs'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const MASTER = arg('--master')
const BRANCH = arg('--branch')
const RUNS = Number(arg('--runs', 9))
const RATES = arg('--rates', '1,6').split(',').map(Number)
const PAGE = arg('--page', 'default')
const HOST = 'app.example'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
if (!MASTER) { console.error('--master <lib dir> required'); process.exit(1) }

// Many distinct real utilities with variants, to reach a given engine output size
function sizedClasses(kb) {
    const base = twClasses()
    const variants = ['', 'hover:', 'md:', 'lg:', 'focus:', 'dark:', 'sm:', 'xl:', 'group-hover:', 'active:', 'disabled:', 'first:', 'last:', 'odd:', 'even:', '2xl:', 'peer-hover:', 'focus-visible:', 'aria-selected:', 'print:']
    const out = []
    for (const v of variants) for (const c of base) out.push(v + c)
    for (let i = 1; out.length < kb * 22; i++) out.push(`w-[${i}px]`, `h-[${i}px]`, `mt-[${i}px]`)
    return out.slice(0, kb * 22)
}

const APP_BODY = fs.readFileSync(new URL('./tailwind-cache-cases.e2e.mjs', import.meta.url), 'utf8').match(/const APP_BODY = `([\s\S]*?)`/)[1]

const PROBE = `(function () {
  window.__tw = { appliedAt: null, cls: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__tw.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  const tick = () => { const el = document.getElementById('probe-w'); if (el && getComputedStyle(el).width === '37px') { window.__tw.appliedAt = performance.now(); return; } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();`

// The renderer that navigated to url (several contexts are open, so several renderers are traced)
function analyse(events, url) {
    const nav = events.filter((e) => e.name === 'navigationStart' && (e.args?.data?.documentLoaderURL || '') === url).pop()
    if (!nav) throw new Error('navigationStart not found for ' + url)
    const main = events.find((e) => e.name === 'thread_name' && e.pid === nav.pid && e.args?.name === 'CrRendererMain')
    const onMain = events.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && e.ts >= nav.ts)
    const tasks = onMain.filter((e) => e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask').sort((a, b) => a.ts - b.ts)
    let busy = 0, end = 0
    for (const t of tasks) if (t.ts >= end) { busy += t.dur; end = t.ts + t.dur }
    const recalc = onMain.filter((e) => e.name === 'UpdateLayoutTree').reduce((a, e) => a + e.dur, 0)
    return { busy: busy / 1000, recalc: recalc / 1000 }
}

async function main() {
    let inlineCss = ''
    const bodyFor = () => PAGE === 'app' ? sitePage({ body: APP_BODY }) : PAGE.startsWith('sized:') ? pageHtml({ classes: sizedClasses(Number(PAGE.split(':')[1])) }) : pageHtml()
    const html = bodyFor()
    const pages = { '/': html, '/inline': () => html.replace(' data-tailwind', '').replace('</head>', `<style>${inlineCss}</style></head>`) }
    const servers = { master: await serve({ libDir: path.resolve(MASTER), pages }), branch: await serve(BRANCH ? { libDir: path.resolve(BRANCH), pages } : { pages }) }
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })
    const url = (k, p = '/') => `http://${HOST}:${servers[k].port}${p}`
    const interact = PAGE === 'app' ? async (p) => {
        await p.click('#dd'); await wait(400); await p.click('#dd'); await wait(300)
        await p.click('#tb'); await wait(500); await p.click('#tb'); await wait(300)
    } : null
    try {
        {
            const c = await browser.createBrowserContext(); const p = await c.newPage()
            await p.goto(url('master'), { waitUntil: 'load' })
            await p.waitForFunction(() => [...document.querySelectorAll('style')].some((s) => (s.textContent || '').startsWith('/*! tailwindcss') && s.textContent.includes('37px')), { timeout: 30000 })
            await wait(1500)
            inlineCss = await p.evaluate(() => [...document.querySelectorAll('style')].filter((s) => (s.textContent || '').startsWith('/*! tailwindcss')).pop().textContent)
            await c.close()
        }
        console.log(`page ${PAGE}: engine CSS ${(inlineCss.length / 1024).toFixed(1)} KB, ${RUNS} interleaved runs per variant, warm repeat visits${interact ? ', load + interaction' : ''}`)
        for (const rate of RATES) {
            const variants = { master: url('master'), branch: url('branch'), inline: url('branch', '/inline') }
            const ctx = {}
            for (const [k, u] of Object.entries(variants)) {
                const c = await browser.createBrowserContext(); const p = await c.newPage()
                await p.evaluateOnNewDocument(PROBE)
                for (let i = 0; i < 3; i++) { await p.goto(u, { waitUntil: 'load' }); await wait(1500); if (interact && k !== 'inline') { await interact(p); await wait(1500) } }
                const cdp = await p.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate })
                ctx[k] = { c, p, rows: [] }
            }
            for (let i = 0; i < RUNS; i++) {
                for (const k of i % 2 ? ['branch', 'master', 'inline'] : ['master', 'branch', 'inline']) {
                    const { p, rows } = ctx[k]
                    await p.tracing.start({ categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'loading'] })
                    await p.goto(variants[k], { waitUntil: 'load' })
                    await p.waitForFunction(() => window.__tw.appliedAt !== null, { timeout: 30000 }).catch(() => { })
                    await wait(rate > 1 ? 3000 : 1200)
                    if (interact && k !== 'inline') { await interact(p); await wait(rate > 1 ? 3000 : 1200) }
                    const a = analyse(JSON.parse(Buffer.from(await p.tracing.stop()).toString('utf8')).traceEvents, variants[k])
                    rows.push({ ...a, ...(await p.evaluate(() => ({ appliedAt: window.__tw.appliedAt, cls: window.__tw.cls, engine: document.querySelectorAll('script[src*="tailwind"]').length }))) })
                }
            }
            const stat = (rows, key) => { const v = rows.map((r) => r[key]).sort((a, b) => a - b); return { med: v[Math.floor(v.length / 2)], min: v[0], max: v[v.length - 1] } }
            const f = (s, d = 1) => `${s.med.toFixed(d)} (${s.min.toFixed(d)}–${s.max.toFixed(d)})`
            for (const k of ['master', 'branch', 'inline']) {
                const r = ctx[k].rows
                console.log(`${rate}x ${k.padEnd(7)} busy ${f(stat(r, 'busy'))} ms  recalc ${f(stat(r, 'recalc'))} ms  applied@ ${f(stat(r, 'appliedAt'))} ms  CLS ${f(stat(r, 'cls'), 3)}  engine loads/visit ${f(stat(r, 'engine'), 0)}`)
                await ctx[k].c.close()
            }
            const d = ctx.master.rows.map((r, i) => r.busy - ctx.branch.rows[i].busy)
            console.log(`${rate}x paired busy saving (master - branch): ${f(stat(d.map((busy) => ({ busy })), 'busy'))} ms`)
        }
    } finally {
        await browser.close()
        await servers.master.close()
        await servers.branch.close()
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
