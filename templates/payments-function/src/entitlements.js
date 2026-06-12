/* Payments function — entitlements + credit ledger (pure, provider-agnostic)
 *
 * This is where ALL commerce semantics live — never in the client plugin. Edit
 * PRODUCTS to match what you sell. Everything here is pure and unit-tested:
 * pricing is server-authoritative (the client's `ref` is opaque; we look up the
 * price here and NEVER trust a client-sent amount).
 */

// ─── EDIT: your catalogue. Map each opaque `ref` to its server price (minor
// units, e.g. cents) and what completing it grants. Add/rename freely.
//
// Grant types:
//   credits  — one-time credit top-up
//   plan     — one-time plan unlock (lifetime), optionally bundling credits
//   subscription — recurring plan; needs a provider with real recurring
//                  billing (an MoR like Paddle/Polar, or Stripe). Revolut
//                  orders are one-time, so don't sell subscriptions on the
//                  Revolut adapter — nothing would renew or expire them.
export const PRODUCTS = {
    'credits-1000': { price: { amount: 500, currency: 'USD' }, grant: { type: 'credits', amount: 1000 } },
    'credits-5000': { price: { amount: 2000, currency: 'USD' }, grant: { type: 'credits', amount: 5000 } },
    'pro-upgrade':  { price: { amount: 4900, currency: 'USD' }, grant: { type: 'plan', plan: 'pro', credits: 1000 } }
}

export function priceForRef(ref) { return PRODUCTS[ref]?.price || null }
export function grantForRef(ref) { return PRODUCTS[ref]?.grant || { type: 'unknown' } }

// A fresh workspace-scoped entitlement record.
export function emptyEntitlement(workspaceId) {
    return { workspace_id: workspaceId, plan: 'free', status: 'inactive', period_end: null, credits: 0 }
}

// Apply a paid one-time order (e.g. a credit top-up). Pure: returns the next
// entitlement and an optional ledger entry; never mutates the input.
export function applyOrderPaid(entitlement, { ref, orderId, ts }) {
    const grant = grantForRef(ref)
    const e = { ...entitlement }
    let ledger = null
    if (grant.type === 'credits') {
        e.credits = (e.credits || 0) + grant.amount
        ledger = { workspace_id: e.workspace_id, delta: grant.amount, reason: 'topup', ref, orderId, ts }
    } else if (grant.type === 'plan') {
        e.plan = grant.plan
        e.status = 'active'
        if (grant.credits) e.credits = (e.credits || 0) + grant.credits
        ledger = { workspace_id: e.workspace_id, delta: grant.credits || 0, reason: 'grant', ref, orderId, ts }
    } else if (grant.type === 'subscription') {
        return applySubscription(e, { plan: grant.plan, status: 'active', monthlyCredits: grant.monthlyCredits, orderId, ts })
    }
    return { entitlement: e, ledger }
}

// Reverse a previously-granted order (refund issued, or chargeback lost).
// Pure inverse of applyOrderPaid for the same ref; never drops below zero.
export function revokeOrderGrant(entitlement, { ref, orderId, ts }) {
    const grant = grantForRef(ref)
    const e = { ...entitlement }
    let delta = 0
    if (grant.type === 'credits') delta = grant.amount
    else if (grant.type === 'plan') { delta = grant.credits || 0; e.plan = 'free'; e.status = 'revoked' }
    else if (grant.type === 'subscription') { e.status = 'canceled' }
    if (delta) e.credits = Math.max(0, (e.credits || 0) - delta)
    const ledger = { workspace_id: e.workspace_id, delta: -delta, reason: 'refund', ref, orderId, ts }
    return { entitlement: e, ledger }
}

// Activate / change a subscription, optionally granting a periodic credit allotment.
export function applySubscription(entitlement, { plan, status, periodEnd, monthlyCredits, orderId, ts }) {
    const e = { ...entitlement, plan, status: status || 'active', period_end: periodEnd || null }
    let ledger = null
    if (monthlyCredits) {
        e.credits = (e.credits || 0) + monthlyCredits
        ledger = { workspace_id: e.workspace_id, delta: monthlyCredits, reason: 'grant', plan, orderId, ts }
    }
    return { entitlement: e, ledger }
}

// Mark a subscription cancelled/expired (from a revoke webhook).
export function revokeSubscription(entitlement, { status = 'canceled' } = {}) {
    return { entitlement: { ...entitlement, status }, ledger: null }
}

// Burn credits (PAYG). Pure; throws on insufficient balance so the caller can
// reject the privileged usage call. Returns next entitlement + a debit ledger.
export function consume(entitlement, n, { reason = 'usage', ts } = {}) {
    if (!(n > 0)) throw new Error('consume amount must be positive')
    const have = entitlement.credits || 0
    if (have < n) { const err = new Error('insufficient credits'); err.code = 'INSUFFICIENT'; throw err }
    const e = { ...entitlement, credits: have - n }
    return { entitlement: e, ledger: { workspace_id: e.workspace_id, delta: -n, reason, ts } }
}
