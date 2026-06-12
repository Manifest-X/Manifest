/**
 * Tests for the payments function template (server half) — pure logic + the
 * Revolut adapter, exercised offline. Live sandbox verification (real order +
 * real webhook) needs Revolut Merchant sandbox credentials.
 */

import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
    PRODUCTS, priceForRef, grantForRef, emptyEntitlement,
    applyOrderPaid, applySubscription, revokeSubscription, revokeOrderGrant, consume
} from '../templates/payments-function/src/entitlements.js'
import { createOrder, retrieveOrder, createWebhook, deleteWebhook, verifySignature, parseEvent, orderContext } from '../templates/payments-function/src/revolut.js'
import { buildCheckout, fulfillCompletedOrder, revokeOrder } from '../templates/payments-function/src/fulfillment.js'
import { memoryStore } from '../templates/payments-function/src/store.js'

describe('entitlements — catalogue + math', () => {
    it('prices and grants resolve from PRODUCTS', () => {
        expect(priceForRef('credits-1000')).toEqual({ amount: 500, currency: 'USD' })
        expect(grantForRef('credits-1000')).toEqual({ type: 'credits', amount: 1000 })
        expect(priceForRef('nope')).toBe(null)
        expect(grantForRef('nope')).toEqual({ type: 'unknown' })
    })
    it('applyOrderPaid adds credits + emits a topup ledger row (immutably)', () => {
        const start = emptyEntitlement('w1')
        const { entitlement, ledger } = applyOrderPaid(start, { ref: 'credits-1000', orderId: 'o1', ts: 't' })
        expect(entitlement.credits).toBe(1000)
        expect(start.credits).toBe(0) // input untouched
        expect(ledger).toMatchObject({ workspace_id: 'w1', delta: 1000, reason: 'topup', ref: 'credits-1000' })
    })
    it('applyOrderPaid applies a one-time plan grant with bundled credits', () => {
        const { entitlement, ledger } = applyOrderPaid(emptyEntitlement('w1'), { ref: 'pro-upgrade', orderId: 'o2', ts: 't' })
        expect(entitlement.plan).toBe('pro')
        expect(entitlement.status).toBe('active')
        expect(entitlement.credits).toBe(1000) // bundled credits granted
        expect(ledger.reason).toBe('grant')
    })
    it('revokeOrderGrant reverses a grant without going below zero', () => {
        const granted = applyOrderPaid(emptyEntitlement('w1'), { ref: 'pro-upgrade', orderId: 'o2', ts: 't' }).entitlement
        const { entitlement, ledger } = revokeOrderGrant(granted, { ref: 'pro-upgrade', orderId: 'o2', ts: 't' })
        expect(entitlement).toMatchObject({ plan: 'free', status: 'revoked', credits: 0 })
        expect(ledger).toMatchObject({ delta: -1000, reason: 'refund' })
    })
    it('applySubscription sets plan/status and grants periodic credits', () => {
        const { entitlement } = applySubscription(emptyEntitlement('w1'), { plan: 'pro-annual', monthlyCredits: 500 })
        expect(entitlement).toMatchObject({ plan: 'pro-annual', status: 'active', credits: 500 })
    })
    it('revokeSubscription flips status without touching credits', () => {
        const e = { ...emptyEntitlement('w1'), plan: 'pro-monthly', status: 'active', credits: 42 }
        expect(revokeSubscription(e).entitlement).toMatchObject({ status: 'canceled', credits: 42 })
    })
    it('consume decrements, audits, and rejects overspend / non-positive', () => {
        const e = { ...emptyEntitlement('w1'), credits: 10 }
        const { entitlement, ledger } = consume(e, 3, { ts: 't' })
        expect(entitlement.credits).toBe(7)
        expect(ledger).toMatchObject({ delta: -3, reason: 'usage' })
        expect(() => consume(e, 50)).toThrow(/insufficient/)
        try { consume(e, 50) } catch (err) { expect(err.code).toBe('INSUFFICIENT') }
        expect(() => consume(e, 0)).toThrow(/positive/)
    })
})

describe('revolut — webhook signature verification', () => {
    const secret = 'wsk_test_secret'
    const body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: 'ord_123' })
    const ts = 1700000000000
    const sign = (b, t, s = secret) => 'v1=' + crypto.createHmac('sha256', s).update(`v1.${t}.${b}`).digest('hex')

    it('accepts a correctly-signed payload (within tolerance)', () => {
        const sig = sign(body, ts)
        expect(verifySignature({ rawBody: body, signingSecret: secret, signatureHeader: sig, timestamp: ts, now: ts + 1000 })).toBe(true)
    })
    it('accepts when the header carries multiple signatures and one matches', () => {
        const header = `v1=deadbeef ${sign(body, ts)}`
        expect(verifySignature({ rawBody: body, signingSecret: secret, signatureHeader: header, timestamp: ts, now: ts })).toBe(true)
    })
    it('rejects a tampered body', () => {
        const sig = sign(body, ts)
        expect(verifySignature({ rawBody: body + ' ', signingSecret: secret, signatureHeader: sig, timestamp: ts, now: ts })).toBe(false)
    })
    it('rejects a wrong secret', () => {
        const sig = sign(body, ts, 'other')
        expect(verifySignature({ rawBody: body, signingSecret: secret, signatureHeader: sig, timestamp: ts, now: ts })).toBe(false)
    })
    it('rejects a stale timestamp (replay)', () => {
        const sig = sign(body, ts)
        expect(verifySignature({ rawBody: body, signingSecret: secret, signatureHeader: sig, timestamp: ts, now: ts + 10 * 60 * 1000 })).toBe(false)
    })
    it('rejects missing header / timestamp / secret', () => {
        expect(verifySignature({ rawBody: body, signingSecret: secret, signatureHeader: '', timestamp: ts })).toBe(false)
        expect(verifySignature({ rawBody: body, signingSecret: secret, signatureHeader: sign(body, ts), timestamp: '' })).toBe(false)
        expect(verifySignature({ rawBody: body, signingSecret: '', signatureHeader: sign(body, ts), timestamp: ts })).toBe(false)
    })
})

describe('revolut — order API (injected fetch)', () => {
    it('createOrder posts to the sandbox endpoint with auth + version + metadata', async () => {
        let captured = null
        const fetchFn = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ id: 'o1', token: 'tok_pub', checkout_url: 'https://checkout/x', state: 'pending' }) } }
        const r = await createOrder({ secret: 'sk', environment: 'sandbox', amount: 500, currency: 'USD', ref: 'credits-1000', context: { workspaceId: 'w1', userId: 'u1' }, redirectUrl: 'https://app/done' }, { fetch: fetchFn })
        expect(captured.url).toBe('https://sandbox-merchant.revolut.com/api/orders')
        expect(captured.opts.method).toBe('POST')
        expect(captured.opts.headers.Authorization).toBe('Bearer sk')
        expect(captured.opts.headers['Revolut-Api-Version']).toBeTruthy()
        const sent = JSON.parse(captured.opts.body)
        expect(sent).toMatchObject({ amount: 500, currency: 'USD', redirect_url: 'https://app/done' })
        expect(sent.metadata).toMatchObject({ workspace_id: 'w1', user_id: 'u1', ref: 'credits-1000' })
        expect(r).toEqual({ id: 'o1', token: 'tok_pub', checkoutUrl: 'https://checkout/x', state: 'pending' })
    })
    it('createOrder targets the live host when environment=live', async () => {
        let url = null
        await createOrder({ secret: 'sk', environment: 'live', amount: 1, currency: 'USD' }, { fetch: async (u) => { url = u; return { ok: true, json: async () => ({}) } } })
        expect(url).toBe('https://merchant.revolut.com/api/orders')
    })
    it('createOrder throws on a non-ok response', async () => {
        await expect(createOrder({ secret: 'sk', environment: 'sandbox', amount: 1, currency: 'USD' }, { fetch: async () => ({ ok: false, status: 422 }) })).rejects.toThrow(/422/)
    })
    it('retrieveOrder GETs by id with auth', async () => {
        let captured = null
        await retrieveOrder({ secret: 'sk', environment: 'sandbox', orderId: 'o9' }, { fetch: async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ id: 'o9' }) } } })
        expect(captured.url).toBe('https://sandbox-merchant.revolut.com/api/orders/o9')
        expect(captured.opts.headers.Authorization).toBe('Bearer sk')
    })
    it('createWebhook posts to /api/1.0/webhooks and maps signing_secret', async () => {
        let captured = null
        const fetchFn = async (url, opts) => { captured = { url, opts }; return { ok: true, json: async () => ({ id: 'wh1', url: 'https://app/webhook', events: ['ORDER_COMPLETED'], signing_secret: 'wsk_live_value' }) } }
        const r = await createWebhook({ secret: 'sk', environment: 'sandbox', url: 'https://app/webhook' }, { fetch: fetchFn })
        expect(captured.url).toBe('https://sandbox-merchant.revolut.com/api/1.0/webhooks')
        expect(JSON.parse(captured.opts.body)).toEqual({ url: 'https://app/webhook', events: ['ORDER_COMPLETED', 'DISPUTE_LOST'] })
        expect(r).toEqual({ id: 'wh1', signingSecret: 'wsk_live_value', url: 'https://app/webhook', events: ['ORDER_COMPLETED'] })
    })
    it('deleteWebhook issues a DELETE and treats 204 as success', async () => {
        let captured = null
        const ok = await deleteWebhook({ secret: 'sk', environment: 'sandbox', webhookId: 'wh1' }, { fetch: async (url, opts) => { captured = { url, method: opts.method }; return { ok: false, status: 204 } } })
        expect(captured).toEqual({ url: 'https://sandbox-merchant.revolut.com/api/1.0/webhooks/wh1', method: 'DELETE' })
        expect(ok).toBe(true)
    })
    it('parseEvent + orderContext extract the right fields', () => {
        expect(parseEvent('{"event":"ORDER_COMPLETED","order_id":"o1"}')).toEqual({ event: 'ORDER_COMPLETED', orderId: 'o1' })
        expect(orderContext({ metadata: { workspace_id: 'w1', ref: 'credits-1000' } })).toEqual({ workspaceId: 'w1', ref: 'credits-1000' })
        expect(orderContext({})).toEqual({ workspaceId: null, ref: null })
    })
})

describe('fulfillment — checkout building (server-authoritative pricing)', () => {
    const env = { secret: 'sk', environment: 'sandbox', successUrl: 'https://app/done' }
    const fakeCreate = async (args) => ({ id: 'o1', token: 'tok', checkoutUrl: 'https://checkout/x', _args: args })

    it('defaults to a redirect response', async () => {
        const r = await buildCheckout({ ref: 'credits-1000', context: { workspaceId: 'w1' }, env, createOrderFn: fakeCreate })
        expect(r).toEqual({ mode: 'redirect', url: 'https://checkout/x' })
    })
    it('returns an overlay token when the client prefers overlay', async () => {
        const r = await buildCheckout({ ref: 'credits-1000', context: { workspaceId: 'w1', preferMode: 'overlay' }, env, createOrderFn: fakeCreate })
        expect(r).toEqual({ mode: 'overlay', provider: 'revolut', params: { token: 'tok' } })
    })
    it('uses the SERVER price, never a client-sent amount', async () => {
        let seenAmount = null
        await buildCheckout({ ref: 'credits-1000', context: { workspaceId: 'w1', amount: 1 }, env, createOrderFn: async (a) => { seenAmount = a.amount; return { token: 't', checkoutUrl: 'u' } } })
        expect(seenAmount).toBe(PRODUCTS['credits-1000'].price.amount) // 500, not 1
    })
    it('rejects an unknown ref', async () => {
        await expect(buildCheckout({ ref: 'mystery', context: { workspaceId: 'w1' }, env, createOrderFn: fakeCreate })).rejects.toThrow(/unknown ref/)
    })
})

describe('fulfillment — completed order → store', () => {
    it('credits a workspace and appends a ledger row', async () => {
        const store = memoryStore()
        const order = { metadata: { workspace_id: 'w1', ref: 'credits-1000' }, state: 'completed' }
        await fulfillCompletedOrder(store, order, { orderId: 'o1', ts: 't' })
        const dump = store._dump()
        expect(dump.entitlements[0]).toMatchObject({ workspace_id: 'w1', credits: 1000 })
        expect(dump.ledger[0]).toMatchObject({ delta: 1000, reason: 'topup', orderId: 'o1' })
    })
    it('accumulates across multiple top-ups', async () => {
        const store = memoryStore()
        const order = { metadata: { workspace_id: 'w1', ref: 'credits-1000' } }
        await fulfillCompletedOrder(store, order, { orderId: 'o1', ts: 't' })
        await fulfillCompletedOrder(store, order, { orderId: 'o2', ts: 't' })
        expect(store._dump().entitlements[0].credits).toBe(2000)
    })
    it('activates a plan from a plan-grant ref', async () => {
        const store = memoryStore()
        const order = { metadata: { workspace_id: 'w1', ref: 'pro-upgrade' } }
        await fulfillCompletedOrder(store, order, { orderId: 'o3', ts: 't' })
        expect(store._dump().entitlements[0]).toMatchObject({ plan: 'pro', status: 'active', credits: 1000 })
    })
    it('is idempotent: a redelivered webhook for the same order grants once', async () => {
        const store = memoryStore()
        const order = { metadata: { workspace_id: 'w1', ref: 'credits-1000' } }
        await fulfillCompletedOrder(store, order, { orderId: 'oDup', ts: 't' })
        const second = await fulfillCompletedOrder(store, order, { orderId: 'oDup', ts: 't' })
        expect(second.skipped).toMatch(/already fulfilled/)
        expect(store._dump().entitlements[0].credits).toBe(1000)
        expect(store._dump().ledger.length).toBe(1)
    })
    it('refuses anonymous checkouts (no workspace to credit)', async () => {
        const env2 = { secret: 'sk', environment: 'sandbox', successUrl: 'x' }
        await expect(buildCheckout({ ref: 'credits-1000', context: {}, env: env2, createOrderFn: async () => ({}) }))
            .rejects.toMatchObject({ code: 'SIGN_IN_REQUIRED' })
    })
    it('revokeOrder reverses a granted order exactly once', async () => {
        const store = memoryStore()
        const order = { metadata: { workspace_id: 'w1', ref: 'credits-1000' } }
        await fulfillCompletedOrder(store, order, { orderId: 'oRev', ts: 't' })
        await revokeOrder(store, order, { orderId: 'oRev', ts: 't' })
        expect(store._dump().entitlements[0].credits).toBe(0)
        const again = await revokeOrder(store, order, { orderId: 'oRev', ts: 't' })
        expect(again.skipped).toMatch(/already revoked/)
        const never = await revokeOrder(store, order, { orderId: 'oNever', ts: 't' })
        expect(never.skipped).toMatch(/never granted/)
    })
    it('skips orders with no workspace_id in metadata', async () => {
        const store = memoryStore()
        const r = await fulfillCompletedOrder(store, { metadata: {} }, { orderId: 'o4', ts: 't' })
        expect(r.skipped).toBeTruthy()
        expect(store._dump().entitlements.length).toBe(0)
    })
})
