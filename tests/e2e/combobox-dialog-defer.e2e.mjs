/**
 * Regression test for a client-blocking 0.5.208 bug: every `x-combobox` nested inside
 * a `<dialog popover>` was dead. manifest.defer.js auto-stashes every closed popover/
 * dialog's subtree into a `<template data-mnfst-defer>` and speculatively pre-renders
 * (idle "prewarm") pending containers up to a cap, evicting the least-reachable warm
 * one back into its stash when a new one is promoted past that cap. x-combobox's own
 * build() runs one macrotask (setTimeout 0) after its directive fires — so on a page
 * with enough closed dialogs to pressure the cap, a dialog can get prewarmed (which
 * schedules its combobox's build) and then evicted (re-stashing its subtree) BEFORE
 * that build() runs. build() then did `el.closest('[popover]').appendChild(menu)`
 * unconditionally: the closest ancestor resolves fine (same node), but it's now sitting
 * inside a disconnected `<template>.content` fragment, so the generated menu ends up
 * disconnected too. Opening the field later threw
 *   InvalidStateError: Failed to execute 'showPopover' on 'HTMLElement':
 *   Invalid on disconnected popover elements
 * uncaught, from a browser-internal autofocus step — which left the containing
 * dialog's own dismiss handling (its popovertarget hide button, Escape) stranded.
 * And because x-combobox guards against rebuilding an already-built element
 * (`el.__mnfstCombobox`), a field broken this way stayed dead forever, even across
 * later opens of the same dialog.
 *
 * Root cause: src/scripts/manifest.combobox.js resolved the popover attach target
 * once, at build time, and never rechecked it.
 *
 * Fix: resolve the attach target lazily — every time the menu is (re)shown, and on
 * a re-entrant build() call — via a shared `reattach()` helper that always re-reads
 * `el.closest('[popover]') || document.body` and moves the menu there if it isn't
 * already; `openMenu()` also wraps `showPopover()` in try/catch with one
 * resolve-and-retry so a disconnected menu can never throw uncaught and strand the
 * containing dialog's own dismiss handling.
 *
 * Fixtures:
 *  - src/test/combobox-dialog-defer.html: (a) page-level combobox (control — never
 *    deferred, should always work), (b) combobox inside a single closed dialog
 *    popover, (c) combobox inside a dialog nested inside another closed dialog
 *    popover (a settings dialog opening a sub-dialog). A low `prewarmCap` (3) plus 8
 *    padding dialogs (also comboboxes) reproduce the same prewarm/evict pressure a
 *    real page with 60+ dialogs hits against the default cap (48) — the reported app
 *    had 67 comboboxes, all dialog-nested, all dead.
 *  - src/test/combobox-dialog-stress.html: 12 closed dialogs (default-shaped, no
 *    padding needed) with prewarmCap 3, opened+closed one at a time — the same race
 *    at a scale that reproduces it on essentially every run without relying on case
 *    (b)'s specific padding sequence.
 *
 * This test fails on pre-fix code — case (b)'s menu comes back disconnected and the
 * page throws the InvalidStateError above (verified: 3/3 runs) — and passes once
 * manifest.combobox.js resolves the attach target lazily at open time.
 *
 * Run: node tests/e2e/combobox-dialog-defer.e2e.mjs
 */
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.COMBOBOX_DIALOG_DEFER_E2E_PORT || 5318

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function startServer(onAlreadyRunning) {
    const proc = spawn('node', ['packages/run/serve.mjs', 'src', '--port', String(PORT), '--no-open'],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const sniff = (chunk) => {
        out += String(chunk)
        const m = out.match(/already running at (http:\/\/localhost:\d+)/)
        if (m) onAlreadyRunning(m[1])
    }
    proc.stdout.on('data', sniff)
    proc.stderr.on('data', sniff)
    return proc
}

function ping(url) {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200) })
        req.on('error', () => resolve(false))
        req.setTimeout(1000, () => { req.destroy(); resolve(false) })
    })
}

// Idle prewarm only fires on genuine browser idle + a gesture window; a few scattered
// pointer moves/clicks over ~3s reliably lets manifest.defer's scheduler reach and
// warm several pending containers, the way real page-browsing would.
async function settleWithGestures(page, rounds = 8) {
    for (let i = 0; i < rounds; i++) {
        await page.mouse.move(100 + i * 10, 100 + i * 10)
        await page.mouse.click(5, 5).catch(() => {})
        await wait(400)
    }
    await wait(1000)
}

async function menuState(page, inputId) {
    return page.evaluate((id) => {
        const input = document.getElementById(id)
        if (!input) return { hasInput: false }
        const controls = input.getAttribute('aria-controls')
        const menu = controls ? document.getElementById(controls) : null
        return { hasInput: true, controls, connected: !!menu, menuOpen: menu ? menu.matches(':popover-open') : false }
    }, inputId)
}

async function testDeferFixture(page, errors) {
    await page.goto(`http://localhost:${PORT}/test/combobox-dialog-defer.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__events && window.__events.some((e) => e[0] === 'manifest:ready'), { timeout: 15000, polling: 100 })
    await settleWithGestures(page)

    // --- Case (a): page-level combobox — never deferred, always worked; sanity control ---
    await page.click('#input-page')
    await page.type('#input-page', 'a')
    await wait(150)
    const a = await menuState(page, 'input-page')
    if (!a.connected || !a.menuOpen) throw new Error(`case (a) page-level combobox broken (should never regress): ${JSON.stringify(a)}`)

    // --- Sequential real open/close of 8 padding dialogs (each with their own combobox)
    //     — ordinary page-browsing, the exact pattern that pressures the prewarm cap. ---
    for (let i = 0; i < 8; i++) {
        await page.click(`button[popovertarget="pad-${i}"]`)
        await wait(120)
        await page.evaluate((i) => document.getElementById('pad-' + i).hidePopover(), i)
        await wait(60)
    }

    // --- Case (b): combobox inside a single closed dialog popover ---
    await page.click('button[popovertarget="dialog-b"]')
    await wait(200)
    const bAfterOpen = await menuState(page, 'input-b')
    if (!bAfterOpen.connected) {
        throw new Error(`case (b): generated menu disconnected right after the dialog opened — ${JSON.stringify(bAfterOpen)}`)
    }
    await page.click('#input-b')
    await page.type('#input-b', 'x')
    await wait(150)
    const bAfterType = await menuState(page, 'input-b')
    if (!bAfterType.connected || !bAfterType.menuOpen) {
        throw new Error(`case (b): dropdown did not open on click+type — ${JSON.stringify(bAfterType)}`)
    }
    const bOptions = await page.evaluate(() => {
        const input = document.getElementById('input-b')
        const menu = document.getElementById(input.getAttribute('aria-controls'))
        return Array.from(menu.querySelectorAll('li[role=option]')).filter((li) => !li.hidden).map((li) => li.dataset.label)
    })
    if (JSON.stringify(bOptions) !== JSON.stringify(['Xray'])) {
        throw new Error(`case (b): typing "x" should filter to just Xray, got ${JSON.stringify(bOptions)}`)
    }
    // Escape closes the combobox dropdown first (top layer), dialog stays open...
    await page.keyboard.press('Escape')
    await wait(150)
    const bMenuAfterEscape = await menuState(page, 'input-b')
    if (bMenuAfterEscape.menuOpen) throw new Error('case (b): Escape did not close the combobox dropdown')
    const dialogBOpenBeforeClose = await page.evaluate(() => document.getElementById('dialog-b').matches(':popover-open'))
    if (!dialogBOpenBeforeClose) throw new Error('case (b): dialog closed on the combobox\'s own Escape (should take two)')
    // ...its own popovertarget hide button must still work (the reported symptom:
    // touching a broken combobox left the containing dialog unable to dismiss).
    await page.click('#close-b')
    await wait(150)
    const dialogBOpenAfterClose = await page.evaluate(() => document.getElementById('dialog-b').matches(':popover-open'))
    if (dialogBOpenAfterClose) throw new Error('case (b): dialog\'s own close button stopped working after the combobox was used')

    // --- Case (c): combobox inside a dialog nested inside another closed dialog popover ---
    await page.click('button[popovertarget="dialog-outer"]')
    await wait(150)
    await page.click('button[popovertarget="dialog-c"]')
    await wait(200)
    const cAfterOpen = await menuState(page, 'input-c')
    if (!cAfterOpen.connected) throw new Error(`case (c): generated menu disconnected — ${JSON.stringify(cAfterOpen)}`)
    await page.click('#input-c')
    await page.type('#input-c', 'p')
    await wait(150)
    const cAfterType = await menuState(page, 'input-c')
    if (!cAfterType.connected || !cAfterType.menuOpen) throw new Error(`case (c): dropdown did not open on click+type — ${JSON.stringify(cAfterType)}`)
    // Dismiss the inner dialog via Escape (closes combobox), Escape again (closes dialog-c),
    // then the outer dialog's own close button.
    await page.keyboard.press('Escape')
    await wait(100)
    await page.keyboard.press('Escape')
    await wait(150)
    const dialogCOpen = await page.evaluate(() => document.getElementById('dialog-c').matches(':popover-open'))
    if (dialogCOpen) throw new Error('case (c): dialog-c did not dismiss via Escape after the combobox was used')
    await page.click('#close-outer')
    await wait(150)
    const dialogOuterOpen = await page.evaluate(() => document.getElementById('dialog-outer').matches(':popover-open'))
    if (dialogOuterOpen) throw new Error('case (c): outer dialog\'s own close button stopped working')

    if (errors.length) throw new Error(`page threw errors during the defer fixture: ${errors.join('; ')}`)
    console.log('PASS: combobox-dialog-defer.html — cases (a)/(b)/(c) all connect, open, filter, and dismiss cleanly')
}

async function testStressFixture(page, errors) {
    errors.length = 0
    await page.goto(`http://localhost:${PORT}/test/combobox-dialog-stress.html`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__events && window.__events.some((e) => e[0] === 'manifest:ready'), { timeout: 15000, polling: 100 })
    await settleWithGestures(page)

    const n = await page.evaluate(() => window.__dialogCount)
    const broken = []
    for (let i = 0; i < n; i++) {
        await page.click(`button[popovertarget="dlg-${i}"]`)
        await wait(120)
        await page.click(`#input-${i}`)
        await page.type(`#input-${i}`, 'x')
        await wait(100)
        const state = await menuState(page, `input-${i}`)
        if (!state.connected || !state.menuOpen) broken.push({ i, state })
        // Collapse the dropdown first — while open it can overlap the close button
        // (no fixture CSS), which would land the click on the menu instead.
        await page.keyboard.press('Escape')
        await wait(60)
        await page.click(`#close-${i}`)
        await wait(60)
        const stillOpen = await page.evaluate((i) => document.getElementById('dlg-' + i).matches(':popover-open'), i)
        if (stillOpen) broken.push({ i, dismissBroken: true })
    }

    if (broken.length) throw new Error(`${broken.length}/${n} dialog-nested comboboxes broken: ${JSON.stringify(broken)}`)
    if (errors.length) throw new Error(`page threw errors during the stress fixture: ${errors.join('; ')}`)
    console.log(`PASS: combobox-dialog-stress.html — all ${n} dialog-nested comboboxes connected, opened, filtered, and dismissed cleanly`)
}

async function main() {
    let baseUrl = `http://localhost:${PORT}`
    let ownsServer = true
    const proc = startServer((existingUrl) => { baseUrl = existingUrl; ownsServer = false })

    try {
        let up = false
        for (let i = 0; i < 40 && !up; i++) {
            up = await ping(`${baseUrl}/`)
            if (!up) await wait(250)
        }
        if (!up) throw new Error(`dev server never came up at ${baseUrl}`)

        const browser = await puppeteer.launch({ headless: 'new' })
        try {
            const page = await browser.newPage()
            // This repo's dev server live-reloads on any change under src/ — other
            // sessions/tooling touching files there mid-run (this repo is worked
            // concurrently, per CLAUDE.md) can otherwise fire a page reload mid-test
            // and destroy Puppeteer's execution context. Neutralize its EventSource
            // before any page script runs, so our own pages never navigate underneath us.
            await page.evaluateOnNewDocument(() => {
                window.EventSource = function () { return { close() {}, addEventListener() {}, onmessage: null } }
            })
            const errors = []
            page.on('pageerror', (err) => errors.push(err.message))

            await testDeferFixture(page, errors)
            await testStressFixture(page, errors)
        } finally {
            await browser.close()
        }
    } finally {
        if (ownsServer) proc.kill()
    }
}

main().catch((err) => {
    console.error('FAIL:', err.message)
    process.exit(1)
})
