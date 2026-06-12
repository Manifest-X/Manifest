/**
 * Tests for the payments plugin engine (x-pay / $pay).
 *
 * The plugin subscripts are browser-global scripts. We evaluate config +
 * adapters + core in a vm context with minimal mocks (no Alpine, no real
 * provider SDKs) and exercise window.ManifestPayments directly. The Alpine-
 * facing layers (store/magic/directive) are covered by the in-browser QA
 * harness in src/index.html; here we lock down the provider-agnostic engine.
 */

import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach } from 'vitest'
import vm from 'vm'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', 'src', 'scripts', 'payments')
const read = (f) => readFileSync(path.join(SRC, f), 'utf8')

// Build a fresh sandbox so config's module-level cache resets per test.
function makeEnv({ payments, fetchImpl, auth } = {}) {
    const navs = []
    const events = []
    const store = { pay: { loading: false, error: null, last: null, state: null }, auth: auth || null }
    const win = {}
    const ctx = {
        window: win,
        Alpine: { store: (n) => store[n] },
        document: {
            addEventListener() {},
            querySelector: () => null,
            createElement: () => ({ dataset: {}, addEventListener() {}, set onload(_) {}, set onerror(_) {} }),
            head: { appendChild() {} }
        },
        location: { search: '', pathname: '/app', hash: '', assign: (u) => navs.push(u), href: '' },
        history: { replaceState() {} },
        fetch: (...a) => (fetchImpl ? fetchImpl(...a) : Promise.resolve({ ok: true, json: async () => ({}) })),
        URLSearchParams,
        CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail } },
        console,
        setTimeout: (fn) => fn()
    }
    win.Alpine = ctx.Alpine
    win.location = ctx.location
    win.history = ctx.history
    win.dispatchEvent = (e) => events.push(e)
    win.addEventListener = () => {}
    if (payments !== undefined) win.__manifestLoaded = { payments }
    vm.createContext(ctx)
    for (const f of ['config', 'adapters', 'core']) vm.runInContext(read(`manifest.payments.${f}.js`), ctx)
    return { ctx, win, store, navs, events, PAY: win.ManifestPayments }
}

const CFG = { provider: 'mockpay', endpoint: 'https://fn.test/pay', mode: 'redirect' }
const reply = (obj, ok = true, status = 200) => async () => ({ ok, status, json: async () => obj })

describe('payments config', () => {
    it('returns null when no payments block', async () => {
        const { win } = makeEnv({})
        expect(await win.ManifestPaymentsConfig.getPaymentsConfig()).toBe(null)
    })
    it('normalizes provider/endpoint/mode', async () => {
        const { win } = makeEnv({ payments: { provider: 'revolut', endpoint: 'https://x/pay', mode: 'overlay' } })
        const c = await win.ManifestPaymentsConfig.getPaymentsConfig()
        expect(c.provider).toBe('revolut')
        expect(c.endpoint).toBe('https://x/pay')
        expect(c.mode).toBe('overlay')
    })
    it('defaults mode to redirect for unknown values', async () => {
        const { win } = makeEnv({ payments: { endpoint: 'https://x/pay', mode: 'weird' } })
        expect((await win.ManifestPaymentsConfig.getPaymentsConfig()).mode).toBe('redirect')
    })
    it('refuses an unresolved ${VAR} in endpoint', async () => {
        const { win } = makeEnv({ payments: { endpoint: '${PAY_FN}' } })
        expect(await win.ManifestPaymentsConfig.getPaymentsConfig()).toBe(null)
    })
    it('refuses an unresolved ${VAR} in publicKey', async () => {
        const { win } = makeEnv({ payments: { endpoint: 'https://x/pay', publicKey: '${KEY}' } })
        expect(await win.ManifestPaymentsConfig.getPaymentsConfig()).toBe(null)
    })
})

describe('payments adapters', () => {
    it('ships built-in adapters for the majors', () => {
        const { win } = makeEnv({ payments: CFG })
        const A = win.ManifestPaymentsAdapters
        for (const p of ['revolut', 'paddle', 'lemonsqueezy', 'polar', 'stripe']) expect(A.get(p)).toBeTruthy()
    })
    it('marks stripe as no-overlay (degrades to redirect)', () => {
        const { win } = makeEnv({ payments: CFG })
        expect(win.ManifestPaymentsAdapters.get('stripe').supportsOverlay).toBe(false)
    })
    it('supports custom registration (escape hatch)', () => {
        const { win } = makeEnv({ payments: CFG })
        win.ManifestPaymentsAdapters.register('custom', { supportsOverlay: true, open: async () => ({}) })
        expect(win.ManifestPaymentsAdapters.get('custom')).toBeTruthy()
    })
})

describe('payments engine — initiate', () => {
    let env
    const setOverlayAdapter = () => {
        let opened = null
        env.win.ManifestPaymentsAdapters.register('mockpay', {
            supportsOverlay: true,
            async open(a) { opened = a; return { status: 'complete' } }
        })
        return () => opened
    }

    it('absolute URL ref = zero-server link-through (no fetch)', async () => {
        let hit = false
        env = makeEnv({ payments: CFG, fetchImpl: () => { hit = true; return reply({})() } })
        const r = await env.PAY.initiate('https://buy.example/x')
        expect(env.navs[0]).toBe('https://buy.example/x')
        expect(hit).toBe(false)
        expect(r.status).toBe('redirected')
    })

    it('redirect response navigates', async () => {
        env = makeEnv({ payments: CFG, fetchImpl: reply({ mode: 'redirect', url: 'https://hosted/x' }) })
        await env.PAY.initiate('pro-monthly')
        expect(env.navs[0]).toBe('https://hosted/x')
    })

    it('POST body carries ref, payload and preferMode in context', async () => {
        let body = null
        env = makeEnv({ payments: CFG, fetchImpl: async (u, o) => { body = JSON.parse(o.body); return reply({ mode: 'redirect', url: 'x' })() } })
        await env.PAY.initiate('pro-monthly', { qty: 2 })
        expect(body.ref).toBe('pro-monthly')
        expect(body.payload.qty).toBe(2)
        expect(body.context.preferMode).toBe('redirect')
    })

    it('injects identity context from the auth store', async () => {
        let body = null
        env = makeEnv({
            payments: CFG,
            auth: { user: { $id: 'u1' }, currentTeam: { $id: 'w1' } },
            fetchImpl: async (u, o) => { body = JSON.parse(o.body); return reply({ mode: 'redirect', url: 'x' })() }
        })
        await env.PAY.initiate('p')
        expect(body.context.userId).toBe('u1')
        expect(body.context.workspaceId).toBe('w1')
    })

    it('payload.context overrides auto-injected context', async () => {
        let body = null
        env = makeEnv({
            payments: CFG,
            auth: { user: { $id: 'u1' }, currentTeam: { $id: 'w1' } },
            fetchImpl: async (u, o) => { body = JSON.parse(o.body); return reply({ mode: 'redirect', url: 'x' })() }
        })
        await env.PAY.initiate('p', { context: { workspaceId: 'override' } })
        expect(body.context.workspaceId).toBe('override')
    })

    it('overlay response routes to the adapter', async () => {
        env = makeEnv({ payments: CFG, fetchImpl: reply({ mode: 'overlay', provider: 'mockpay', params: { token: 'T' } }) })
        const getOpened = setOverlayAdapter()
        const r = await env.PAY.initiate('x')
        expect(getOpened().params.token).toBe('T')
        expect(r.status).toBe('complete')
    })

    it('overlay degrades to redirect when no adapter supports it', async () => {
        env = makeEnv({ payments: CFG, fetchImpl: reply({ mode: 'overlay', provider: 'nope', url: 'https://hosted/fallback' }) })
        const r = await env.PAY.initiate('x')
        expect(env.navs[0]).toBe('https://hosted/fallback')
        expect(r.status).toBe('redirected')
    })

    it('overlay with no adapter and no fallback url throws', async () => {
        env = makeEnv({ payments: CFG, fetchImpl: reply({ mode: 'overlay', provider: 'nope' }) })
        await expect(env.PAY.initiate('x')).rejects.toThrow()
    })

    it('throws when endpoint is missing for a server-backed ref', async () => {
        env = makeEnv({ payments: { provider: 'mockpay' } })
        await expect(env.PAY.initiate('x')).rejects.toThrow(/endpoint/i)
    })

    it('throws when redirect response has no url', async () => {
        env = makeEnv({ payments: CFG, fetchImpl: reply({ mode: 'redirect' }) })
        await expect(env.PAY.initiate('x')).rejects.toThrow(/url/i)
    })

    it('error path: throws, sets store.error, emits event, clears loading', async () => {
        env = makeEnv({ payments: CFG, fetchImpl: reply({}, false, 500) })
        await expect(env.PAY.initiate('x')).rejects.toThrow()
        expect(env.store.pay.error).toBeTruthy()
        expect(env.store.pay.loading).toBe(false)
        expect(env.events.some(e => e.type === 'manifest:pay:error')).toBe(true)
    })
})

describe('payments engine — portal / state / return / navigate', () => {
    it('portal() initiates with the "portal" ref by default', async () => {
        let body = null
        const env = makeEnv({ payments: CFG, fetchImpl: async (u, o) => { body = JSON.parse(o.body); return reply({ mode: 'redirect', url: 'x' })() } })
        await env.PAY.portal()
        expect(body.ref).toBe('portal')
    })

    it('refreshState reads state.url into the store', async () => {
        const env = makeEnv({
            payments: { ...CFG, state: { url: 'https://fn.test/state' } },
            auth: { currentTeam: { $id: 'w1' } },
            fetchImpl: async (u) => reply({ plan: 'pro', credits: 42, ws: new URL(u).searchParams.get('workspace') })()
        })
        const data = await env.PAY.refreshState()
        expect(data.plan).toBe('pro')
        expect(data.ws).toBe('w1')
        expect(env.store.pay.state.credits).toBe(42)
    })

    it('refreshState returns null when no state.url configured', async () => {
        const env = makeEnv({ payments: CFG })
        expect(await env.PAY.refreshState()).toBe(null)
    })

    it('handleReturn strips the marker, keeps other params, emits return', () => {
        const env = makeEnv({ payments: CFG })
        env.ctx.location.search = '?checkout=success&keep=1'
        let replaced = null
        env.ctx.history.replaceState = (_s, _t, url) => { replaced = url }
        env.PAY.handleReturn()
        expect(replaced).toContain('keep=1')
        expect(replaced).not.toContain('checkout')
        expect(env.events.some(e => e.type === 'manifest:pay:return')).toBe(true)
    })

    it('handleReturn is a no-op without the marker', () => {
        const env = makeEnv({ payments: CFG })
        env.ctx.location.search = '?foo=1'
        env.PAY.handleReturn()
        expect(env.events.some(e => e.type === 'manifest:pay:return')).toBe(false)
    })

    it('setNavigate seam overrides redirect navigation', async () => {
        const captured = []
        const env = makeEnv({ payments: CFG, fetchImpl: reply({ mode: 'redirect', url: 'https://hosted/x' }) })
        env.PAY.setNavigate((u) => captured.push(u))
        await env.PAY.initiate('x')
        expect(captured[0]).toBe('https://hosted/x')
        expect(env.navs.length).toBe(0) // default location.assign not used
    })
})

// Browser-ish sandbox where loadScript resolves immediately (appendChild fires
// onload) so overlay adapters can be driven against stubbed provider SDKs.
function makeBrowserEnv() {
    const win = {}
    const ctx = {
        window: win,
        Alpine: { store: () => ({}) },
        document: {
            addEventListener() {},
            querySelector: () => null,
            createElement: () => ({ dataset: {}, setAttribute() {}, _onload: null, set onload(f) { this._onload = f }, set onerror(_) {} }),
            head: { appendChild: (s) => { s.dataset.mnfstLoaded = '1'; if (s._onload) s._onload() } }
        },
        location: { assign() {} },
        console, setTimeout: (fn) => fn(), URLSearchParams,
        CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail } }
    }
    win.location = ctx.location
    vm.createContext(ctx)
    for (const f of ['config', 'adapters', 'core']) vm.runInContext(read(`manifest.payments.${f}.js`), ctx)
    return { win, ctx, A: win.ManifestPaymentsAdapters }
}

// Each entry stubs the provider's SDK global and drives a success.
const OVERLAY_CONTRACTS = [
    { name: 'revolut', params: { token: 't' }, setup: (w) => { w.RevolutCheckout = async () => ({ payWithPopup: (c) => c.onSuccess(), destroy() {} }) } },
    { name: 'paddle', params: { token: 't' }, setup: (w) => { w.Paddle = { Environment: { set() {} }, Initialize() {}, Checkout: { open: (o) => o.eventCallback({ name: 'checkout.completed' }) } } } },
    { name: 'lemonsqueezy', url: 'https://x', setup: (w) => { w.createLemonSqueezy = () => {}; let h; w.LemonSqueezy = { Setup: ({ eventHandler }) => { h = eventHandler }, Url: { Open: () => h && h({ event: 'Checkout.Success' }) } } } },
    { name: 'polar', url: 'https://x', setup: (w) => { w.Polar = { EmbedCheckout: { create: async () => ({ addEventListener: (ev, cb) => { if (ev === 'success') cb() } }) } } } },
    { name: 'razorpay', params: { key: 'k', order_id: 'o' }, setup: (w) => { w.Razorpay = function (opts) { this.open = () => opts.handler && opts.handler({}) } } }
]

describe('overlay adapter contracts (stubbed SDKs)', () => {
    for (const c of OVERLAY_CONTRACTS) {
        it(`${c.name}: declares overlay support`, () => {
            const { A } = makeBrowserEnv()
            expect(A.get(c.name).supportsOverlay).toBe(true)
        })
        it(`${c.name}: loads SDK and resolves complete on success`, async () => {
            const { win, A } = makeBrowserEnv()
            c.setup(win)
            const r = await A.get(c.name).open({ params: c.params, url: c.url, config: { environment: 'sandbox' } })
            expect(r.status).toBe('complete')
        })
        it(`${c.name}: fails safely when its SDK global is absent`, async () => {
            const { A } = makeBrowserEnv() // no setup → SDK global missing
            // Acceptable non-crash outcomes: throw a descriptive error, or (for
            // url-based adapters) fall back to a redirect. (instanceof is unsafe
            // across vm realms, so assert on the shape instead.)
            let outcome
            try { outcome = (await A.get(c.name).open({ params: c.params, url: c.url, config: {} })).status }
            catch (e) { outcome = 'threw:' + (e && e.message) }
            expect(outcome === 'redirected' || /^threw:.+/.test(outcome)).toBe(true)
        })
    }
})

describe('provider roster', () => {
    const ALL = ['stripe', 'revolut', 'paddle', 'lemonsqueezy', 'polar', 'razorpay', 'square', 'paypal', 'braintree', 'adyen', 'mollie']
    const OVERLAY = ['lemonsqueezy', 'paddle', 'polar', 'razorpay', 'revolut']

    it('registers every major SaaS / merchant / donation provider', () => {
        const names = makeBrowserEnv().A.list().map(p => p.name)
        for (const p of ALL) expect(names).toContain(p)
    })
    it('reports overlay capability correctly per provider', () => {
        const { A } = makeBrowserEnv()
        expect(A.list().filter(p => p.overlay).map(p => p.name).sort()).toEqual(OVERLAY)
        for (const p of ALL.filter(n => !OVERLAY.includes(n))) expect(A.get(p).supportsOverlay).toBe(false)
    })
    it('does NOT predefine niche/hosted-only providers (they ride the generic floor)', () => {
        const { A } = makeBrowserEnv()
        for (const p of ['checkoutcom', 'fastspring', 'gumroad', 'donorbox', 'patreon', 'buymeacoffee', 'kofi']) {
            expect(A.get(p)).toBe(null)
        }
    })
})
