/* Payments function — fulfillment (testable, storage-injected)
 *
 * The two flows that touch the store, factored out of the HTTP wrapper so they
 * can be unit-tested with memoryStore + stubbed provider calls.
 */

import { priceForRef, applyOrderPaid, revokeOrderGrant, emptyEntitlement } from './entitlements.js'
import { orderContext } from './revolut.js'

// Build a checkout response for an opaque ref. Pricing is SERVER-AUTHORITATIVE:
// we look the price up here and ignore any client-sent amount. Returns the
// client contract shape ({mode:'redirect',url} or {mode:'overlay',provider,params}).
//
// A workspace is REQUIRED: fulfillment grants to context.workspaceId, so an
// anonymous checkout would take money and grant nothing. Refusing here turns
// that silent loss into a clear error the page can show ("sign in first").
export async function buildCheckout({ ref, context, env, createOrderFn }) {
    if (!context?.workspaceId) {
        const e = new Error('sign in required: checkout needs a workspace to credit')
        e.code = 'SIGN_IN_REQUIRED'
        throw e
    }
    const price = priceForRef(ref)
    if (!price) { const e = new Error(`unknown ref: ${ref}`); e.code = 'UNKNOWN_REF'; throw e }
    const order = await createOrderFn({
        secret: env.secret, environment: env.environment,
        amount: price.amount, currency: price.currency,
        ref, context, redirectUrl: env.successUrl
    })
    if (context?.preferMode === 'overlay') {
        return { mode: 'overlay', provider: 'revolut', params: { token: order.token } }
    }
    return { mode: 'redirect', url: order.checkoutUrl }
}

// Apply a completed (retrieved) order to the store: webhook is the source of
// truth, so we update entitlement + ledger from the order's trusted metadata.
// IDEMPOTENT: webhook delivery is at-least-once (providers redeliver on
// timeouts), so a redelivered event must not grant twice — the ledger row for
// this order id is the dedupe record.
export async function fulfillCompletedOrder(store, order, { orderId, ts }) {
    const { workspaceId, ref } = orderContext(order)
    if (!workspaceId) return { skipped: 'no workspace_id in order metadata' }
    if (await store.hasLedger({ orderId, reason: undefined })) {
        return { skipped: 'already fulfilled (duplicate webhook delivery)' }
    }
    const current = (await store.getEntitlement(workspaceId)) || emptyEntitlement(workspaceId)
    const { entitlement, ledger } = applyOrderPaid(current, { ref, orderId, ts })
    await store.putEntitlement(entitlement)
    if (ledger) await store.appendLedger(ledger)
    return { entitlement, ledger }
}

// Reverse a granted order after a lost chargeback (DISPUTE_LOST) or a refund
// you issued. Idempotent via the 'refund' ledger row; no-ops if the order was
// never granted.
export async function revokeOrder(store, order, { orderId, ts }) {
    const { workspaceId, ref } = orderContext(order)
    if (!workspaceId) return { skipped: 'no workspace_id in order metadata' }
    if (!(await store.hasLedger({ orderId }))) return { skipped: 'order was never granted' }
    if (await store.hasLedger({ orderId, reason: 'refund' })) {
        return { skipped: 'already revoked' }
    }
    const current = (await store.getEntitlement(workspaceId)) || emptyEntitlement(workspaceId)
    const { entitlement, ledger } = revokeOrderGrant(current, { ref, orderId, ts })
    await store.putEntitlement(entitlement)
    if (ledger) await store.appendLedger(ledger)
    return { entitlement, ledger }
}
