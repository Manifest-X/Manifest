/* Payments function — Appwrite entrypoint
 *
 * Implements the Manifest payments contract the client plugin speaks:
 *   POST /          { ref, payload, context }  → { mode:'redirect',url } | { mode:'overlay',provider,params }
 *   POST /webhook   provider webhook            → verify signature, fulfill (idempotent), 200
 *   POST /consume   { workspace, amount }       → burn credits (server-to-server, key-guarded)
 *   GET  /state?workspace=…                     → entitlement record for $pay.state
 *
 * Deploy to Appwrite Functions (Node runtime). Required env vars:
 *   REVOLUT_SECRET_KEY        Merchant API secret (server-only; never sent to client)
 *   REVOLUT_WEBHOOK_SECRET    webhook signing secret (from Create Webhook)
 *   PAYMENTS_ENV              'sandbox' | 'live'        (default 'sandbox')
 *   PAYMENTS_SUCCESS_URL      where Revolut redirects after pay (append ?checkout=1)
 *   PAYMENTS_CONSUME_KEY      optional shared secret for POST /consume (your backend → here)
 *   APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY,
 *   PAY_DATABASE_ID, PAY_ENTITLEMENTS_COLLECTION, PAY_LEDGER_COLLECTION
 */

import { createOrder, retrieveOrder, verifySignature, parseEvent } from './revolut.js'
import { buildCheckout, fulfillCompletedOrder, revokeOrder } from './fulfillment.js'
import { consume } from './entitlements.js'
import { appwriteStore } from './store.appwrite.js'

export default async ({ req, res, log, error }) => {
    const env = {
        secret: process.env.REVOLUT_SECRET_KEY,
        signingSecret: process.env.REVOLUT_WEBHOOK_SECRET,
        environment: process.env.PAYMENTS_ENV || 'sandbox',
        successUrl: process.env.PAYMENTS_SUCCESS_URL,
        consumeKey: process.env.PAYMENTS_CONSUME_KEY
    }
    const store = appwriteStore({
        endpoint: process.env.APPWRITE_ENDPOINT,
        projectId: process.env.APPWRITE_PROJECT,
        apiKey: process.env.APPWRITE_API_KEY,
        databaseId: process.env.PAY_DATABASE_ID,
        entitlementsCollection: process.env.PAY_ENTITLEMENTS_COLLECTION,
        ledgerCollection: process.env.PAY_LEDGER_COLLECTION
    })

    const path = req.path || '/'
    try {
        // 1. Webhook — verify signature against the RAW body, then fulfill.
        //    ORDER_COMPLETED grants (idempotently — redelivered events no-op);
        //    DISPUTE_LOST reverses the grant (chargeback lost = money gone).
        //    Note: Revolut has no refund webhook — if you refund an order from
        //    the dashboard/API, also call revokeOrder for it (or POST /consume).
        if (req.method === 'POST' && path.endsWith('/webhook')) {
            const ok = verifySignature({
                rawBody: req.bodyRaw,
                signingSecret: env.signingSecret,
                signatureHeader: req.headers['revolut-signature'],
                timestamp: req.headers['revolut-request-timestamp']
            })
            if (!ok) return res.json({ ok: false, error: 'bad signature' }, 401)

            const { event, orderId } = parseEvent(req.bodyRaw)
            if (orderId && (event === 'ORDER_COMPLETED' || event === 'DISPUTE_LOST')) {
                const order = await retrieveOrder({ secret: env.secret, environment: env.environment, orderId })
                const ts = new Date().toISOString()
                const result = event === 'ORDER_COMPLETED'
                    ? await fulfillCompletedOrder(store, order, { orderId, ts })
                    : await revokeOrder(store, order, { orderId, ts })
                log(`${event} ${orderId}: ${JSON.stringify(result.skipped || result.entitlement)}`)
            }
            return res.json({ ok: true })
        }

        // 2. Burn credits (pay-as-you-go). Server-to-server only: your backend
        //    calls this with the shared key — never the browser, or buyers
        //    could skip the spend. Rejects on insufficient balance.
        if (req.method === 'POST' && path.endsWith('/consume')) {
            if (!env.consumeKey || req.headers['x-consume-key'] !== env.consumeKey) {
                return res.json({ ok: false, error: 'unauthorized' }, 401)
            }
            const { workspace, amount, reason } = JSON.parse(req.bodyRaw || '{}')
            const current = await store.getEntitlement(workspace)
            if (!current) return res.json({ ok: false, error: 'unknown workspace' }, 404)
            try {
                const { entitlement, ledger } = consume(current, amount, { reason, ts: new Date().toISOString() })
                await store.putEntitlement(entitlement)
                await store.appendLedger(ledger)
                return res.json({ ok: true, credits: entitlement.credits })
            } catch (e) {
                if (e.code === 'INSUFFICIENT') return res.json({ ok: false, error: 'insufficient credits' }, 402)
                throw e
            }
        }

        // 3. Create checkout session for an opaque ref. The portal ref is
        //    answered explicitly: Revolut has no hosted customer portal (use a
        //    provider that does — Stripe, Paddle, Lemon Squeezy, Polar — or
        //    build a billing page from /state + your ledger).
        if (req.method === 'POST') {
            const { ref, context } = JSON.parse(req.bodyRaw || '{}')
            if (ref === 'portal') {
                return res.json({ error: 'portal not available: Revolut has no customer portal' }, 400)
            }
            const response = await buildCheckout({ ref, context, env, createOrderFn: createOrder })
            return res.json(response)
        }

        // 4. State read for $pay.state.
        if (req.method === 'GET') {
            const ws = req.query?.workspace
            const entitlement = ws ? await store.getEntitlement(ws) : null
            return res.json(entitlement || {})
        }

        return res.json({ ok: false, error: 'unsupported method' }, 400)
    } catch (e) {
        error(`payments fn: ${e.message}`)
        const status = e.code === 'UNKNOWN_REF' ? 400 : e.code === 'SIGN_IN_REQUIRED' ? 401 : 500
        return res.json({ ok: false, error: e.message }, status)
    }
}
