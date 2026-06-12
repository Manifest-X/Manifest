/**
 * Headless e2e for the payments plugin.
 *
 * Boots the dev server, loads src/index.html in real Chromium (puppeteer), and
 * asserts the in-page QA harness (window.__paymentsQA) reports zero failures.
 * This automates the browser layer the node unit tests can't cover: real Alpine,
 * real directive/magic registration, real DOM reactivity.
 *
 * Run: npm run test:e2e   (exits non-zero on any failure or payments console error)
 */

import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.PAY_E2E_PORT || 5099

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// serve.mjs enforces one instance per root: if src is already being served
// (e.g. the dev/preview server), it prints "already running at <url>" and
// exits. Capture that and reuse the existing server instead of failing.
function startServer(onAlreadyRunning) {
    const proc = spawn('node', ['packages/run/serve.mjs', 'src', '--port', String(PORT)],
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

async function main() {
    let baseUrl = `http://localhost:${PORT}`
    const server = startServer((existing) => { baseUrl = existing })
    let browser
    let failed = false
    try {
        let up = false
        for (let i = 0; i < 40 && !up; i++) { up = await ping(`${baseUrl}/index.html`); if (!up) await wait(250) }
        if (!up) throw new Error(`dev server never came up (tried ${baseUrl})`)
        const pageUrl = `${baseUrl}/index.html`

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
        const page = await browser.newPage()

        const payErrors = []
        page.on('console', (m) => {
            if (m.type() === 'error' && /pay|payment/i.test(m.text())) payErrors.push(m.text())
        })
        page.on('pageerror', (e) => { if (/pay|payment/i.test(String(e))) payErrors.push(String(e)) })

        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForFunction('window.__paymentsQA !== undefined', { timeout: 20000 })
        const qa = await page.evaluate(() => window.__paymentsQA)

        console.log(`\nPayments e2e — ${qa.pass} passed, ${qa.fail} failed`)
        for (const r of qa.results) {
            console.log(`  ${r.pass ? '✓' : '✗ FAIL'} ${r.name}${r.note ? ' — ' + r.note : ''}`)
        }
        if (payErrors.length) {
            console.log('\nPayments console errors:')
            payErrors.forEach((e) => console.log('  ✗ ' + e))
        }
        failed = qa.fail > 0 || payErrors.length > 0
    } catch (err) {
        console.error('Payments e2e ERROR:', err.message)
        failed = true
    } finally {
        if (browser) await browser.close()
        server.kill('SIGTERM')
    }
    process.exit(failed ? 1 : 0)
}

main()
