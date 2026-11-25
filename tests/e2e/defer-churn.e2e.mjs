/**
 * Defer churn probe: a table whose row click writes one piece of state, beside well over
 * PREWARM_CAP deferred menus (130 options each) and dialogs, most of them near the rows.
 * Real input only (CDP Input.dispatchMouseEvent / dispatchKeyEvent).
 *
 * Per plain row click: containers rendered / restashed, Alpine effects created, elements
 * added / removed, main-thread task ms. Also: a revealed pane's menus still render promptly,
 * click-to-open latency of a never-rendered menu, and the cost of typing 30 characters.
 *
 * Run: node tests/e2e/defer-churn.e2e.mjs [--clicks 12] [--throttle 6] [--json] [--assert]
 * DEFER_FILE=/path/to/manifest.defer.js serves another build of the module (before/after runs).
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
const DEFER_FILE = process.env.DEFER_FILE || null

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? Number(process.argv[i + 1]) : def }
const CLICKS = arg('clicks', 12)
const THROTTLE = arg('throttle', 1)
const CAP = arg('cap', 0)
const JSON_OUT = process.argv.includes('--json')
const ASSERT = process.argv.includes('--assert')

const ROWS = 40
const TOOL_MENUS = 40
const OPTIONS = 130
const PANE_MENUS = 6

// ---- Fixture ----

// ~6 elements and 6 effects per option (the reporting app's menus: 132 options, ~924 nodes)
const options = (key) => `<template x-for="o in opts" :key="o"><li :data-value="o" :data-label="o"><span x-show="o !== ''"><i></i></span><b x-text="o"></b><small x-text="'${key}'"></small><em x-show="false">x</em></li></template>`

function row(i) {
    return `<tr id="r${i}" x-data="{ id: ${i} }" @click="$store.sel.id = id" :class="$store.sel.id === id && 'selected'">
  <td>Record ${i}</td><td>record${i}@example.com</td>
  <td><button popovertarget="rm${i}">...</button><menu popover id="rm${i}">${options('row')}</menu></td>
</tr>`
}

function buildFixture() {
    const tools = Array.from({ length: TOOL_MENUS }, (_, i) => `<button popovertarget="tm${i}">F${i}</button><menu popover id="tm${i}">${options('tool')}</menu>`).join('')
    const dialogs = Array.from({ length: 4 }, (_, i) => `<dialog id="d${i}"><form method="dialog"><h3>Dialog ${i}</h3><ul>${options('dlg')}</ul><button>OK</button></form></dialog>`).join('')
    const pane = Array.from({ length: PANE_MENUS }, (_, i) => `<button popovertarget="pm${i}">P${i}</button><menu popover id="pm${i}">${options('pane')}</menu>`).join('')
    const rows = Array.from({ length: ROWS }, (_, i) => row(i)).join('\n')
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Defer churn</title>
<style>body{margin:0;font:13px sans-serif}.tools{display:flex;flex-wrap:wrap;gap:2px;padding:4px}table{border-collapse:collapse}td{padding:2px 6px;border-bottom:1px solid #ddd}tr.selected{background:#def}menu{margin:0;padding:4px;max-height:200px;overflow:auto}</style>
<script>
${CAP ? `window.ManifestDeferConfig = { prewarmCap: ${CAP} };` : ''}
document.addEventListener('alpine:init', () => {
  Alpine.store('sel', { id: -1 });
  window.opts = Array.from({ length: ${OPTIONS} }, (_, i) => 'Option ' + i);
});
</script>
<script src="/scripts/manifest.defer.js"></script>
<script defer src="/__alpine.js"></script>
</head>
<body x-data="{ opts: window.opts, tab: 'a' }">
<div class="tools">${tools}</div>
${dialogs}
<div style="display:flex;gap:16px;padding:4px">
  <table id="list"><tbody>${rows}</tbody></table>
  <div>
    <input id="q" placeholder="Search">
    <button id="show-pane" @click="tab = 'b'">Show pane</button>
    <div id="pane" x-show="tab === 'b'">${pane}</div>
  </div>
</div>
</body>
</html>`
}

// ---- Server ----

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }

function serve(html) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://x')
            let file = null
            if (url.pathname === '/__alpine.js') file = ALPINE
            else if (url.pathname === '/scripts/manifest.defer.js' && DEFER_FILE) file = DEFER_FILE
            else if (/^\/scripts\//.test(url.pathname)) file = path.join(SRC, url.pathname)
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

// ---- Instrumentation: effect census (reactivity engine wrapped before start) + DOM / stash churn ----

const HOOKS = `(() => {
  const S = window.__churn = { on: false, created: 0, runs: 0, add: 0, rem: 0, renders: 0, restashes: 0, live: 0 };
  let A;
  Object.defineProperty(window, 'Alpine', { configurable: true, get() { return A; }, set(v) { A = v; install(v); } });
  function install(Al) {
    if (!Al || Al.__hooked || typeof Al.setReactivityEngine !== 'function') return;
    Al.__hooked = true;
    const prev = Al.effect, release = Al.release;
    Al.setReactivityEngine({ reactive: Al.reactive, raw: Al.raw,
      release: (r) => { if (r && r.__counted) { r.__counted = false; S.live--; } return release(r); },
      effect: (cb) => { if (S.on) S.created++; S.live++; const r = prev(function () { if (S.on) S.runs++; return cb.apply(this, arguments); }); if (r) r.__counted = true; return r; } });
  }
  const isStash = (n) => n.nodeType === 1 && n.tagName === 'TEMPLATE' && n.hasAttribute('data-mnfst-defer');
  const size = (n) => n.nodeType === 1 ? 1 + n.getElementsByTagName('*').length : 0;
  const start = () => new MutationObserver((list) => {
    if (!S.on) return;
    for (const m of list) {
      for (const n of m.addedNodes) { if (isStash(n)) S.restashes++; else S.add += size(n); }
      for (const n of m.removedNodes) { if (isStash(n)) S.renders++; else S.rem += size(n); }
    }
  }).observe(document.documentElement, { subtree: true, childList: true });
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
})();`

const ARM = `(() => { const S = window.__churn; Object.assign(S, { created: 0, runs: 0, add: 0, rem: 0, renders: 0, restashes: 0, on: true }); })()`
const READ = `(() => { const S = window.__churn; S.on = false; return { ...S, stats: window.ManifestDefer.stats() }; })()`

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// Headless Chrome runs idle callbacks only around frames; keep frames coming like a live page would
async function frames(page, ms) {
    await page.evaluate((ms) => { const end = performance.now() + ms; const tick = () => { if (performance.now() < end) requestAnimationFrame(tick) }; requestAnimationFrame(tick) }, ms)
    await wait(ms)
}

async function taskMs(cdp) {
    const { metrics } = await cdp.send('Performance.getMetrics')
    return metrics.find((m) => m.name === 'TaskDuration').value * 1000
}

async function click(cdp, x, y) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const center = (page, sel) => page.$eval(sel, (el) => { el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(20, r.width / 2)), y: Math.round(r.top + r.height / 2) } })

function deferSelf(profile) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    let ms = 0
    for (let i = 0; i < profile.samples.length; i++) {
        const n = byId.get(profile.samples[i])
        if (/manifest\.defer\.js/.test(n.callFrame.url || '')) ms += (profile.timeDeltas[i + 1] ?? 0) / 1000
    }
    return ms
}

// Click an invoker; pointerdown to the frame after the popover opened
async function openTimed(page, cdp, id) {
    const pendingBefore = await page.evaluate((id) => {
        const m = document.getElementById(id)
        window.__t0 = window.__t1 = 0
        document.addEventListener('pointerdown', () => { window.__t0 = performance.now() }, { capture: true, once: true })
        m.addEventListener('toggle', (e) => { if (e.newState === 'open') requestAnimationFrame(() => setTimeout(() => { window.__t1 = performance.now() })) }, { once: true })
        return window.ManifestDefer.isPending(m)
    }, id)
    const b = await center(page, `[popovertarget="${id}"]`)
    await click(cdp, b.x, b.y)
    await page.waitForFunction(() => window.__t1, { timeout: 20000 })
    const out = await page.evaluate((id) => ({ id, ms: Math.round((window.__t1 - window.__t0) * 10) / 10, options: document.getElementById(id).querySelectorAll('li').length }), id)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await wait(1500)
    return { ...out, pendingBefore }
}

async function main() {
    const server = await serve(buildFixture())
    const base = `http://127.0.0.1:${server.address().port}`
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'] })
    const errors = []
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1400, height: 1000 })
        await page.evaluateOnNewDocument(HOOKS)
        page.on('pageerror', (e) => errors.push(String(e.message)))
        const cdp = await page.createCDPSession()
        await cdp.send('Performance.enable')
        const bootStart = Date.now()
        await page.goto(base + '/', { waitUntil: 'load' })
        await page.waitForFunction(() => window.Alpine && window.ManifestDefer && window.ManifestDefer.stats().ready, { timeout: 15000 })
        // Boot prewarm settles: nothing armed and warm stable
        await page.waitForFunction(() => { const s = window.ManifestDefer.stats(); return !s.armed && (s.warm >= s.cap || s.pending === 0) }, { timeout: 60000, polling: 100 })
        const bootPrewarmMs = Date.now() - bootStart
        await wait(5500) // bootDrained fallback timer
        const boot = await page.evaluate(() => ({ stats: window.ManifestDefer.stats(), liveEffects: window.__churn.live, elements: document.getElementsByTagName('*').length, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e5) / 10 : null }))
        if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })

        // First open of the same never-rendered menu straight after boot (same state before/after a fix)
        const firstOpenBoot = await openTimed(page, cdp, 'rm20')

        // A: plain row clicks, 1.2s window each (covers the 50/200/600ms promotion passes and idle slices)
        const clicks = []
        for (let k = 0; k < CLICKS; k++) {
            const { x, y } = await center(page, `#r${(k * 7) % ROWS} td`)
            await page.evaluate(ARM)
            const t0 = await taskMs(cdp)
            await click(cdp, x, y)
            await frames(page, 1200 * Math.max(1, THROTTLE / 3))
            const t1 = await taskMs(cdp)
            const r = await page.evaluate(READ)
            clicks.push({ renders: r.renders, restashes: r.restashes, created: r.created, runs: r.runs, add: r.add, rem: r.rem, taskMs: t1 - t0, warm: r.stats.warm, pending: r.stats.pending })
        }
        const sel = await page.evaluate(() => Alpine.store('sel').id)

        // B: typing 30 characters
        const q = await center(page, '#q')
        await click(cdp, q.x, q.y)
        await wait(800)
        await cdp.send('Profiler.enable')
        await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
        await page.evaluate(ARM)
        const ty0 = await taskMs(cdp)
        await cdp.send('Profiler.start')
        for (const ch of 'the quick brown fox jumps over') {
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch })
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
            await wait(60)
        }
        await wait(1000)
        const { profile } = await cdp.send('Profiler.stop')
        const ty1 = await taskMs(cdp)
        const typed = await page.evaluate(READ)
        const typing = { taskMs: ty1 - ty0, deferSelfMs: deferSelf(profile), renders: typed.renders, restashes: typed.restashes, value: await page.$eval('#q', (el) => el.value) }

        // C: first open of a never-rendered menu, after the clicks
        const target = await page.evaluate(() => {
            const m = [...document.querySelectorAll('menu[popover]')].find((m) => !m.closest('#pane') && window.ManifestDefer.isPending(m))
            return m ? m.id : null
        })
        const firstOpen = target ? await openTimed(page, cdp, target) : null

        // D: a revealed pane's menus render promptly
        const sp = await center(page, '#show-pane')
        await page.evaluate(ARM)
        await click(cdp, sp.x, sp.y)
        await frames(page, 1500 * Math.max(1, THROTTLE / 2))
        const revealedRead = await page.evaluate(READ)
        const revealed = { rendered: await page.evaluate(() => [...document.querySelectorAll('#pane menu')].filter((m) => !window.ManifestDefer.isPending(m)).length), of: PANE_MENUS, warm: revealedRead.stats.warm }
        // After the reveal, plain clicks settle back to zero
        const after = []
        for (let k = 0; k < 4; k++) {
            const { x, y } = await center(page, `#r${(k * 3) % ROWS} td`)
            await page.evaluate(ARM)
            await click(cdp, x, y)
            await frames(page, 1200 * Math.max(1, THROTTLE / 3))
            const r = await page.evaluate(READ)
            after.push({ renders: r.renders, restashes: r.restashes, warm: r.stats.warm })
        }

        const avg = (xs, k) => Math.round(xs.reduce((s, x) => s + x[k], 0) / xs.length * 10) / 10
        const steady = clicks.slice(2)
        const result = {
            deferFile: DEFER_FILE ? path.basename(path.dirname(DEFER_FILE)) + '/' + path.basename(DEFER_FILE) : 'src',
            throttle: THROTTLE, boot: { ...boot, prewarmSettledMs: bootPrewarmMs },
            perClick: { renders: avg(steady, 'renders'), restashes: avg(steady, 'restashes'), effectsCreated: avg(steady, 'created'), effectRuns: avg(steady, 'runs'), added: avg(steady, 'add'), removed: avg(steady, 'rem'), taskMs: avg(steady, 'taskMs'), maxWarm: Math.max(...clicks.map((c) => c.warm)) },
            clicks, selected: sel, typing, firstOpenBoot, firstOpen, revealed, afterReveal: after, errors
        }
        console.log(JSON_OUT ? JSON.stringify(result) : JSON.stringify(result, null, 2))
        if (ASSERT) {
            const fails = []
            if (steady.some((c) => c.renders || c.restashes)) fails.push('plain clicks rendered or restashed containers: ' + JSON.stringify(steady.map((c) => [c.renders, c.restashes])))
            if (after.some((c) => c.renders || c.restashes)) fails.push('clicks after a reveal still churn: ' + JSON.stringify(after))
            if (steady.some((c) => c.created > 20)) fails.push('plain clicks created effects: ' + steady.map((c) => c.created).join(','))
            if (steady.some((c) => c.add > 10 || c.rem > 10)) fails.push('plain clicks churned elements')
            if (typing.renders || typing.restashes) fails.push('typing rendered or restashed')
            if (typing.value.length !== 30) fails.push('typing lost characters: ' + typing.value.length)
            if (revealed.rendered < Math.min(PANE_MENUS, 8)) fails.push(`revealed pane rendered ${revealed.rendered}/${PANE_MENUS}`)
            if (!firstOpenBoot.pendingBefore || firstOpenBoot.options !== OPTIONS) fails.push('boot first open: ' + JSON.stringify(firstOpenBoot))
            if (!firstOpen || firstOpen.options !== OPTIONS) fails.push('first open did not render the menu: ' + JSON.stringify(firstOpen))
            if (errors.length) fails.push('page errors: ' + errors.join('; '))
            if (fails.length) { console.error('FAIL\n  ' + fails.join('\n  ')); process.exitCode = 1 } else console.error('PASS')
        }
    } finally {
        await browser.close()
        server.close()
    }
}

main().catch((e) => { console.error(e); process.exit(1) })
