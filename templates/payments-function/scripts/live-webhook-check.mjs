/**
 * Live webhook round-trip check (run on your own machine).
 *
 * Proves the real function modules end-to-end against Revolut sandbox:
 * registers a webhook → creates a $0.05 order → receives Revolut's signed
 * ORDER_COMPLETED → verifies the signature → fulfils into an in-memory store.
 *
 * Prereqs:
 *   1. A public tunnel to this script's PORT (e.g. `cloudflared tunnel --url http://localhost:8787`
 *      or `ngrok http 8787`). Copy the https URL it prints.
 *   2. Run with your SANDBOX secret + that tunnel URL:
 *
 *      PUBLIC_URL="https://<your-tunnel>" \
 *      REVOLUT_SECRET_KEY="sk_...sandbox..." \
 *      node templates/payments-function/scripts/live-webhook-check.mjs
 *
 *   3. Open the checkout URL it prints, pay with a Revolut SANDBOX test card
 *      (any future expiry + any CVV; click "Approve" on the simulated 3DS):
 *      https://developer.revolut.com/docs/guides/accept-payments/get-started/test-implementation/test-cards
 *
 * It prints only non-secret results, then tears the webhook down and exits.
 */

import http from 'node:http'
import { createWebhook, deleteWebhook, createOrder, retrieveOrder, verifySignature, parseEvent } from '../src/revolut.js'
import { fulfillCompletedOrder } from '../src/fulfillment.js'
import { memoryStore } from '../src/store.js'

const PUBLIC_URL = process.env.PUBLIC_URL
const secret = process.env.REVOLUT_SECRET_KEY
const environment = process.env.PAYMENTS_ENV || 'sandbox'
const currency = process.env.CURRENCY || 'USD'
const PORT = Number(process.env.PORT || 8787)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 5 * 60 * 1000)

if (!PUBLIC_URL || !secret) {
    console.error('Set PUBLIC_URL (your tunnel https base) and REVOLUT_SECRET_KEY (sandbox).')
    process.exit(2)
}

const store = memoryStore()
let webhook = null
let timer = null

async function cleanup(code) {
    clearTimeout(timer)
    if (webhook) { try { await deleteWebhook({ secret, environment, webhookId: webhook.id }) } catch (_) {} }
    process.exit(code)
}

const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/webhook')) {
        // The post-checkout return lands here. In a real app this URL is YOUR
        // success page, where the plugin's handleReturn() sees ?checkout=1,
        // refreshes $pay.state and strips the marker. This is just the tool's stub.
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end('<h2>✅ Back from checkout</h2><p>Verification stub. In your app this is your success page — the payments plugin reads <code>?checkout=1</code> and refreshes <code>$pay.state</code>. Check your terminal for the webhook result; you can close this tab.</p>')
    }
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
        res.writeHead(200); res.end('ok') // ack fast
        const valid = verifySignature({
            rawBody: raw,
            signingSecret: webhook.signingSecret,
            signatureHeader: req.headers['revolut-signature'],
            timestamp: req.headers['revolut-request-timestamp']
        })
        const { event, orderId } = parseEvent(raw)
        console.log(`\n✓ webhook received  | event: ${event}  | signature valid: ${valid}`)
        if (valid && event === 'ORDER_COMPLETED' && orderId) {
            const order = await retrieveOrder({ secret, environment, orderId })
            const r = await fulfillCompletedOrder(store, order, { orderId, ts: new Date().toISOString() })
            console.log(`  fulfilled → ${JSON.stringify(r.skipped || r.entitlement)}`)
            console.log(valid && r.entitlement?.credits ? '\nLOOP CLOSED ✅' : '\nReceived, but check fulfillment above.')
            await cleanup(valid ? 0 : 1)
        }
    })
})

server.listen(PORT, async () => {
    try {
        webhook = await createWebhook({ secret, environment, url: `${PUBLIC_URL.replace(/\/$/, '')}/webhook`, events: ['ORDER_COMPLETED'] })
        console.log(`webhook registered (${webhook.id}) → ${PUBLIC_URL}/webhook`)
        const order = await createOrder({
            secret, environment, amount: 5, currency, ref: 'credits-1000',
            context: { workspaceId: 'ws_demo', userId: 'u_demo' },
            redirectUrl: `${PUBLIC_URL.replace(/\/$/, '')}/done?checkout=1`
        })
        console.log(`order created (${order.id})`)
        console.log(`\n▶ Open and pay $0.05 with a SANDBOX test card:\n  ${order.checkoutUrl}\n  (any future expiry + any CVV; click "Approve" on the simulated 3DS)\n`)
        console.log('Listening for the signed webhook… (Ctrl-C to abort)')
        timer = setTimeout(() => { console.error('\nTimed out waiting for webhook.'); cleanup(1) }, TIMEOUT_MS)
    } catch (e) {
        console.error('setup failed:', e.message); cleanup(2)
    }
})
