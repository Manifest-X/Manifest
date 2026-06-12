/**
 * Real-SDK surface check for overlay adapters (NO provider accounts needed).
 *
 * Loads each overlay provider's LIVE SDK from its CDN in real Chromium and
 * asserts the global + method our adapter calls still exist. This catches the
 * #1 client-side drift risk — a provider renaming its global or changing its
 * API shape — which the stubbed unit/contract tests cannot see. It does NOT
 * complete a payment (that needs an account-bound secret + a minted token).
 *
 * Network-dependent (hits provider CDNs), so it's a separate check, not part of
 * `npm test`. Run: npm run test:e2e:sdk
 *
 * The expectations below MUST stay in lockstep with manifest.payments.adapters.js.
 */

import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const PORT = process.env.PAY_SDK_PORT || 5098
const ORIGIN = `http://localhost:${PORT}/`

// provider → { url, check } where check runs in-page and returns true if the
// global + method our adapter relies on are present.
const SDKS = [
    { name: 'revolut', url: 'https://sandbox-merchant.revolut.com/embed.js',
      check: () => typeof window.RevolutCheckout === 'function' },
    { name: 'paddle', url: 'https://cdn.paddle.com/paddle/v2/paddle.js',
      check: () => !!(window.Paddle && window.Paddle.Checkout && typeof window.Paddle.Checkout.open === 'function' && typeof window.Paddle.Initialize === 'function') },
    { name: 'lemonsqueezy', url: 'https://app.lemonsqueezy.com/js/lemon.js',
      check: () => typeof window.createLemonSqueezy === 'function' },
    { name: 'polar', url: 'https://cdn.jsdelivr.net/npm/@polar-sh/checkout@0.3/dist/embed.global.js',
      check: () => !!(window.Polar && window.Polar.EmbedCheckout && typeof window.Polar.EmbedCheckout.create === 'function') },
    { name: 'razorpay', url: 'https://checkout.razorpay.com/v1/checkout.js',
      check: () => typeof window.Razorpay === 'function' }
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const ping = (url) => new Promise((res) => {
    const req = http.get(url, (r) => { r.resume(); res(r.statusCode === 200) })
    req.on('error', () => res(false)); req.setTimeout(1000, () => { req.destroy(); res(false) })
})

async function main() {
    // Reuse an existing src server if serve.mjs reports one (single-instance).
    let origin = ORIGIN
    const server = spawn('node', ['packages/run/serve.mjs', 'src', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const sniff = (c) => { out += String(c); const m = out.match(/already running at (http:\/\/localhost:\d+)/); if (m) origin = m[1] + '/' }
    server.stdout.on('data', sniff)
    server.stderr.on('data', sniff)
    let browser, failed = false
    try {
        let up = false
        for (let i = 0; i < 40 && !up; i++) { up = await ping(origin); if (!up) await wait(250) }
        if (!up) throw new Error(`dev server never came up (tried ${origin})`)
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })

        console.log('\nReal-SDK surface check (live provider CDNs):')
        for (const sdk of SDKS) {
            const page = await browser.newPage()
            let ok = false, note = ''
            try {
                await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 })
                await page.addScriptTag({ url: sdk.url })
                // Some SDKs initialize a tick after load.
                await wait(400)
                ok = await page.evaluate(sdk.check)
            } catch (e) {
                note = e.message
            } finally {
                await page.close()
            }
            console.log(`  ${ok ? '✓' : '✗ FAIL'} ${sdk.name} — ${sdk.url}${note ? ' (' + note + ')' : ''}`)
            if (!ok) failed = true
        }
    } catch (err) {
        console.error('SDK surface check ERROR:', err.message)
        failed = true
    } finally {
        if (browser) await browser.close()
        server.kill('SIGTERM')
    }
    if (failed) console.log('\nA failure means a provider changed its SDK URL/global/shape — update manifest.payments.adapters.js to match.')
    process.exit(failed ? 1 : 0)
}

main()
