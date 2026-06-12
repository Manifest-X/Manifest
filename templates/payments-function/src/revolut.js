/* Payments function — Revolut Merchant adapter
 *
 * The ONLY Revolut-specific server code. Verified against the Merchant API:
 *   POST {base}/api/orders                 create order → { id, token, checkout_url }
 *   GET  {base}/api/orders/{id}            retrieve order (authoritative metadata + amount)
 *   webhook: Revolut-Signature `v1=<hex>` over `v1.{timestamp}.{rawBody}`, HMAC-SHA256
 *
 * `fetch` is injectable (deps.fetch) so create/retrieve are unit-testable offline.
 * The secret key NEVER leaves the server.
 */

import crypto from 'node:crypto'

const API_VERSION = '2024-09-01'
const base = (environment) => environment === 'live'
    ? 'https://merchant.revolut.com'
    : 'https://sandbox-merchant.revolut.com'

// Create an order. amount is in MINOR units (cents). Returns the public token
// (for the client overlay SDK) and checkout_url (for the redirect floor).
export async function createOrder({ secret, environment, amount, currency, ref, context, redirectUrl }, deps = {}) {
    const fetchFn = deps.fetch || globalThis.fetch
    const res = await fetchFn(`${base(environment)}/api/orders`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${secret}`,
            'Revolut-Api-Version': API_VERSION,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            amount,
            currency,
            redirect_url: redirectUrl,
            // metadata is echoed back on retrieve — our trusted link to the workspace + ref.
            metadata: { workspace_id: context?.workspaceId || '', user_id: context?.userId || '', ref: ref || '' }
        })
    })
    if (!res.ok) throw new Error(`Revolut create order ${res.status}`)
    const order = await res.json()
    return { id: order.id, token: order.token, checkoutUrl: order.checkout_url, state: order.state }
}

// Register a webhook and get its signing secret (one-time setup). Note the path
// asymmetry vs orders: webhooks live under /api/1.0/webhooks (verified live).
export async function createWebhook({ secret, environment, url, events = ['ORDER_COMPLETED', 'DISPUTE_LOST'] }, deps = {}) {
    const fetchFn = deps.fetch || globalThis.fetch
    const res = await fetchFn(`${base(environment)}/api/1.0/webhooks`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${secret}`, 'Revolut-Api-Version': API_VERSION, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, events })
    })
    if (!res.ok) throw new Error(`Revolut create webhook ${res.status}`)
    const wh = await res.json()
    return { id: wh.id, signingSecret: wh.signing_secret, url: wh.url, events: wh.events }
}

// Delete a webhook (teardown after a verification run). 204 on success.
export async function deleteWebhook({ secret, environment, webhookId }, deps = {}) {
    const fetchFn = deps.fetch || globalThis.fetch
    const res = await fetchFn(`${base(environment)}/api/1.0/webhooks/${webhookId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${secret}`, 'Revolut-Api-Version': API_VERSION }
    })
    return res.ok || res.status === 204
}

// Retrieve an order to read its authoritative metadata + amount on webhook.
export async function retrieveOrder({ secret, environment, orderId }, deps = {}) {
    const fetchFn = deps.fetch || globalThis.fetch
    const res = await fetchFn(`${base(environment)}/api/orders/${orderId}`, {
        headers: { 'Authorization': `Bearer ${secret}`, 'Revolut-Api-Version': API_VERSION }
    })
    if (!res.ok) throw new Error(`Revolut retrieve order ${res.status}`)
    return res.json()
}

// Verify a webhook payload signature. payload_to_sign = `v1.{timestamp}.{rawBody}`.
// The header may carry multiple space-separated signatures; any match passes.
// Rejects stale timestamps (replay protection).
export function verifySignature({ rawBody, signingSecret, signatureHeader, timestamp, toleranceMs = 5 * 60 * 1000, now }) {
    if (!signatureHeader || !timestamp || !signingSecret || rawBody == null) return false
    const tsNum = Number(timestamp)
    if (Number.isFinite(tsNum) && Number.isFinite(toleranceMs)) {
        const current = now ?? Date.now()
        if (Math.abs(current - tsNum) > toleranceMs) return false
    }
    const payload = `v1.${timestamp}.${rawBody}`
    const expected = 'v1=' + crypto.createHmac('sha256', signingSecret).update(payload).digest('hex')
    return String(signatureHeader).split(/\s+/).filter(Boolean).some((sig) => timingSafeEqual(sig, expected))
}

function timingSafeEqual(a, b) {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b))
    if (ab.length !== bb.length) return false
    return crypto.timingSafeEqual(ab, bb)
}

// Parse a verified webhook body into { event, orderId }.
export function parseEvent(rawBody) {
    const evt = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody
    return { event: evt.event, orderId: evt.order_id || evt.orderId }
}

// Pull workspace_id + ref out of a retrieved order's metadata.
export function orderContext(order) {
    const m = order?.metadata || {}
    return { workspaceId: m.workspace_id || null, ref: m.ref || null }
}
