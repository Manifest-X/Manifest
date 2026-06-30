/*  Manifest Payments — config
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
*/

// Refuse strings still containing an unresolved ${VAR} — fail loud rather than
// POST an undefined env var to the function verbatim.
function resolvedOrNull(value, fieldName) {
    if (typeof value !== 'string') return value;
    if (/\$\{[^}]+\}/.test(value)) {
        console.error(`[Manifest Payments] manifest.payments.${fieldName} references an undefined env var (${value}).`);
        return null;
    }
    return value;
}

async function ensureManifest() {
    if (window.ManifestComponentsRegistry?.manifest) return window.ManifestComponentsRegistry.manifest;
    if (window.__manifestLoaded) return window.__manifestLoaded;
    try {
        const url = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '/manifest.json';
        const res = await fetch(url);
        return await res.json();
    } catch (_) {
        return null;
    }
}

// Normalize manifest.payments into a stable config object.
let _cache = null;
async function getPaymentsConfig() {
    if (_cache) return _cache;
    const manifest = await ensureManifest();
    if (!manifest?.payments || typeof manifest.payments !== 'object') return null;
    const p = manifest.payments;

    const endpoint = p.endpoint ? resolvedOrNull(p.endpoint, 'endpoint') : null;
    const publicKey = p.publicKey ? resolvedOrNull(p.publicKey, 'publicKey') : null;
    if (p.endpoint && endpoint === null) return null;
    if (p.publicKey && publicKey === null) return null;

    _cache = {
        provider: p.provider || null,
        endpoint,
        mode: p.mode === 'overlay' ? 'overlay' : 'redirect',
        publicKey,
        managed: p.managed === true,
        environment: p.environment || (p.managed ? 'live' : 'sandbox'),
        state: p.state && typeof p.state === 'object' ? p.state : null,
        // Pass-through bag for adapter-specific options (locale, theme, etc.)
        options: p.options && typeof p.options === 'object' ? p.options : {}
    };
    return _cache;
}

window.ManifestPaymentsConfig = { getPaymentsConfig, ensureManifest };


/* Manifest Payments — provider adapters (overlay/embedded checkout) */

// Load a CDN script once; resolve when ready. Keeps heavy provider SDKs out of
// the bundle and prerendered output.
const _loaded = {};
function loadScript(src, attrs) {
    if (_loaded[src]) return _loaded[src];
    _loaded[src] = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
            if (existing.dataset.mnfstLoaded) return resolve();
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
            return;
        }
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        if (attrs) for (const k in attrs) s.setAttribute(k, attrs[k]);
        s.onload = () => { s.dataset.mnfstLoaded = '1'; resolve(); };
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
    });
    return _loaded[src];
}

const _registry = {};
function register(name, adapter) { _registry[name] = adapter; }
function get(name) { return name ? _registry[name] || null : null; }
function list() { return Object.keys(_registry).map(n => ({ name: n, overlay: !!_registry[n].supportsOverlay })); }

/* ---- Overlay adapters (programmatic modal + success callback) ------------- */

// Revolut Merchant — popup over an order token.
register('revolut', {
    supportsOverlay: true,
    async open({ params = {}, config }) {
        const env = (config?.environment === 'live') ? 'prod' : 'sandbox';
        await loadScript(env === 'prod'
            ? 'https://merchant.revolut.com/embed.js'
            : 'https://sandbox-merchant.revolut.com/embed.js');
        if (!window.RevolutCheckout) throw new Error('RevolutCheckout SDK unavailable');
        const instance = await window.RevolutCheckout(params.token, env);
        return new Promise((resolve) => {
            instance.payWithPopup({
                onSuccess: () => { instance.destroy?.(); resolve({ status: 'complete' }); },
                onCancel: () => { instance.destroy?.(); resolve({ status: 'cancelled' }); },
                onError: (e) => { instance.destroy?.(); resolve({ status: 'error', error: e?.message }); }
            });
        });
    }
});

// Paddle (MoR) — overlay via Paddle.js.
register('paddle', {
    supportsOverlay: true,
    async open({ params = {}, config }) {
        await loadScript('https://cdn.paddle.com/paddle/v2/paddle.js');
        if (!window.Paddle) throw new Error('Paddle SDK unavailable');
        if (config?.environment !== 'live') window.Paddle.Environment.set('sandbox');
        window.Paddle.Initialize({ token: params.token || config?.publicKey });
        return new Promise((resolve) => {
            window.Paddle.Checkout.open({
                ...params,
                eventCallback: (ev) => {
                    if (ev?.name === 'checkout.completed') resolve({ status: 'complete' });
                    if (ev?.name === 'checkout.closed') resolve({ status: 'cancelled' });
                }
            });
        });
    }
});

// Lemon Squeezy (MoR) — URL-in-a-modal via lemon.js.
register('lemonsqueezy', {
    supportsOverlay: true,
    async open({ url }) {
        if (!url) throw new Error('Lemon Squeezy overlay requires a checkout url');
        await loadScript('https://app.lemonsqueezy.com/js/lemon.js');
        if (window.createLemonSqueezy) window.createLemonSqueezy();
        return new Promise((resolve) => {
            const ls = window.LemonSqueezy;
            if (ls?.Setup) ls.Setup({ eventHandler: (e) => {
                if (e?.event === 'Checkout.Success') resolve({ status: 'complete' });
                if (e?.event === 'Checkout.Closed') resolve({ status: 'cancelled' });
            }});
            if (ls?.Url?.Open) ls.Url.Open(url);
            else { window.location.assign(url); resolve({ status: 'redirected' }); }
        });
    }
});

// Polar (MoR) — URL-in-a-modal via the embed SDK.
register('polar', {
    supportsOverlay: true,
    async open({ url }) {
        if (!url) throw new Error('Polar overlay requires a checkout url');
        await loadScript('https://cdn.jsdelivr.net/npm/@polar-sh/checkout@0.3/dist/embed.global.js');
        const Embed = window.Polar?.EmbedCheckout;
        if (!Embed?.create) { window.location.assign(url); return { status: 'redirected' }; }
        const checkout = await Embed.create(url);
        return new Promise((resolve) => {
            checkout.addEventListener('success', () => resolve({ status: 'complete' }));
            checkout.addEventListener('close', () => resolve({ status: 'cancelled' }));
        });
    }
});

// Razorpay — true modal checkout.
register('razorpay', {
    supportsOverlay: true,
    async open({ params = {} }) {
        await loadScript('https://checkout.razorpay.com/v1/checkout.js');
        if (!window.Razorpay) throw new Error('Razorpay SDK unavailable');
        return new Promise((resolve) => {
            const rzp = new window.Razorpay({
                ...params,
                handler: () => resolve({ status: 'complete' }),
                modal: { ...(params.modal || {}), ondismiss: () => resolve({ status: 'cancelled' }) }
            });
            rzp.open();
        });
    }
});

/* ---- Redirect-floor providers --------------------------------------------- */
// Registered for discoverability; no overlay, so they degrade to the redirect
// floor. Unlisted providers work the same way with zero config.
['stripe', 'square', 'paypal', 'braintree', 'adyen', 'mollie']
    .forEach((name) => register(name, { supportsOverlay: false, redirectOnly: true }));

window.ManifestPaymentsAdapters = { register, get, list, loadScript };


/* Manifest Payments — reactive store for $pay */

function initializePaymentsStore() {
    if (typeof Alpine === 'undefined') return;
    if (window.__manifestPaymentsStoreInitialized) return;
    window.__manifestPaymentsStoreInitialized = true;

    Alpine.store('pay', {
        loading: false,   // a checkout/portal flow is in flight
        error: null,      // last error message
        last: null,       // last raw function response
        state: null       // server-defined entitlement record (managed mode / refreshState)
    });
}

document.addEventListener('alpine:init', () => {
    try { initializePaymentsStore(); } catch (_) { /* graceful */ }
});

window.ManifestPaymentsStore = { initialize: initializePaymentsStore };


/* Manifest Payments — core engine (client ↔ function contract) */
//
// CONTRACT (client → your function):
//   POST {endpoint}  { ref, payload, context }
//     → { mode:'redirect', url }                  navigate to a hosted page
//     → { mode:'overlay',  provider, params }      SDK-native overlay
//     → { mode:'overlay',  provider, url }         URL-in-a-modal overlay
//   GET  {state.url}?workspace=…&user=…            → arbitrary entitlement record
//
// `ref` is opaque — Manifest never interprets it. Fulfilment is the webhook, not
// this redirect/callback; always reconcile against state.

const RETURN_PARAM = 'checkout';

function store() { return window.Alpine?.store('pay') || null; }
function setStore(patch) { const s = store(); if (s) Object.assign(s, patch); }

// Navigation indirection; override via setNavigate() for SPA routers or tests.
let _navigate = (url) => window.location.assign(url);
function setNavigate(fn) { if (typeof fn === 'function') _navigate = fn; }

// Identity context, auto-injected from the auth store when present.
function getContext() {
    const ctx = {};
    try {
        const auth = window.Alpine?.store('auth');
        if (auth) {
            if (auth.user?.$id) ctx.userId = auth.user.$id;
            if (auth.currentTeam?.$id) ctx.workspaceId = auth.currentTeam.$id;
        }
    } catch (_) { /* auth optional */ }
    return ctx;
}

async function postSession(config, ref, payload, preferMode) {
    const context = { ...getContext(), ...(payload?.context || {}) };
    if (preferMode) context.preferMode = preferMode;
    const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ref, payload: payload || null, context })
    });
    if (!res.ok) {
        // Surface the function's own { error }/{ message } over a bare status code.
        let message = '';
        try {
            const body = await res.json();
            message = body && (body.message || body.error);
        } catch (_) { /* non-JSON body */ }
        throw new Error(message || "Checkout couldn't be started. Please try again.");
    }
    return res.json();
}

// Drive a server response into the right modality; overlay degrades to redirect
// when no adapter supports it.
async function dispatch(response, config) {
    const mode = response?.mode || 'redirect';
    if (mode === 'overlay') {
        const provider = response.provider || config.provider;
        const adapter = window.ManifestPaymentsAdapters.get(provider);
        if (adapter?.supportsOverlay && typeof adapter.open === 'function') {
            const result = await adapter.open({ url: response.url, params: response.params, config });
            if (result?.status === 'complete') await refreshState();
            window.dispatchEvent(new CustomEvent('manifest:pay:result', { detail: { ...result, provider } }));
            return result;
        }
        if (response.url) { _navigate(response.url); return { status: 'redirected' }; }
        throw new Error(`No overlay adapter for "${provider}" and no fallback url`);
    }
    if (!response?.url) throw new Error('Redirect response missing url');
    _navigate(response.url);
    return { status: 'redirected' };
}

// Public: initiate a payment flow for an opaque ref (or an absolute URL for a
// zero-server link-through).
async function initiate(ref, payload = {}) {
    setStore({ loading: true, error: null });
    try {
        // Zero-server link-through: an absolute URL just navigates.
        if (typeof ref === 'string' && /^https?:\/\//i.test(ref)) {
            _navigate(ref);
            return { status: 'redirected' };
        }
        const config = await window.ManifestPaymentsConfig.getPaymentsConfig();
        if (!config) throw new Error('No "payments" config in manifest.json');
        if (!config.endpoint) throw new Error('payments.endpoint is required for server-backed refs');

        const preferMode = payload.mode || config.mode;
        const response = await postSession(config, ref, payload, preferMode);
        setStore({ last: response });
        return await dispatch(response, config);
    } catch (err) {
        setStore({ error: err.message || String(err) });
        window.dispatchEvent(new CustomEvent('manifest:pay:error', { detail: { ref, error: err.message } }));
        throw err;
    } finally {
        setStore({ loading: false });
    }
}

// Convenience: open the billing/customer portal (just another ref).
function portal(ref = 'portal', payload = {}) { return initiate(ref, payload); }

// Read server-defined entitlement state into $pay.state (managed mode).
async function refreshState() {
    const config = await window.ManifestPaymentsConfig.getPaymentsConfig();
    if (!config?.state?.url) return null;
    try {
        const ctx = getContext();
        const q = new URLSearchParams();
        if (ctx.workspaceId) q.set('workspace', ctx.workspaceId);
        if (ctx.userId) q.set('user', ctx.userId);
        const url = config.state.url + (q.toString() ? `?${q}` : '');
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        const data = await res.json();
        setStore({ state: data });
        return data;
    } catch (_) {
        return null;
    }
}

// On return from a redirect checkout (success_url carries ?checkout=…), re-pull
// state and strip the marker. The webhook can land seconds after the buyer, so
// re-poll on a backoff to absorb the lag; each refresh overwrites $pay.state.
const RETURN_POLL_MS = [2000, 5000, 10000];
function handleReturn() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (!params.has(RETURN_PARAM)) return;
        const status = params.get(RETURN_PARAM);
        refreshState();
        RETURN_POLL_MS.forEach((ms) => setTimeout(() => { refreshState(); }, ms));
        window.dispatchEvent(new CustomEvent('manifest:pay:return', { detail: { status } }));
        params.delete(RETURN_PARAM);
        const qs = params.toString();
        const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
        window.history.replaceState({}, '', clean);
    } catch (_) { /* graceful */ }
}

window.ManifestPayments = { initiate, portal, refreshState, handleReturn, getContext, setNavigate };


/* Manifest Payments — $pay magic (callable + reactive props) */
//
//   $pay(ref|url)                  initiate a flow → Promise
//   $pay.portal()                  open the billing/customer portal
//   $pay.refresh()                 re-pull server state into $pay.state
//   $pay.register(name, adapter)   add/override an overlay adapter
//   $pay.state / .loading / .error / .last   reactive (tracked in x-show/x-text)

function initializePaymentsMagic() {
    if (typeof Alpine === 'undefined') return;
    if (window.__manifestPaymentsMagicInitialized) return;
    window.__manifestPaymentsMagicInitialized = true;

    Alpine.magic('pay', () => {
        const api = window.ManifestPayments;
        const fn = (ref, payload) => api.initiate(ref, payload);
        fn.portal = (ref, payload) => api.portal(ref, payload);
        fn.refresh = () => api.refreshState();
        fn.register = (name, adapter) => window.ManifestPaymentsAdapters.register(name, adapter);
        Object.defineProperties(fn, {
            state:   { get: () => Alpine.store('pay')?.state },
            loading: { get: () => Alpine.store('pay')?.loading },
            error:   { get: () => Alpine.store('pay')?.error },
            last:    { get: () => Alpine.store('pay')?.last }
        });
        return fn;
    });
}

document.addEventListener('alpine:init', () => {
    try { initializePaymentsMagic(); } catch (_) { /* graceful */ }
});

window.ManifestPaymentsMagic = { initialize: initializePaymentsMagic };


/* Manifest Payments — x-pay directive (click → initiate a ref) */
//
// Modifiers:
//   .portal             portal flow (ref defaults to "portal")
//   .overlay/.redirect  hint preferred modality (server decides)

function initializePaymentsDirective() {
    if (typeof Alpine === 'undefined') return;
    if (window.__manifestPaymentsDirectiveInitialized) return;
    window.__manifestPaymentsDirectiveInitialized = true;

    Alpine.directive('pay', (el, { expression, modifiers }, { evaluateLater, cleanup }) => {
        const isPortal = modifiers.includes('portal');
        const modeHint = modifiers.includes('overlay') ? 'overlay'
            : modifiers.includes('redirect') ? 'redirect' : null;

        const hasExpr = expression && expression.trim().length > 0;
        const getRef = hasExpr ? evaluateLater(expression) : null;

        // Busy guard: ignore clicks and disable the element while in flight, so
        // double-clicks can't mint duplicate sessions. On failure, surface a
        // toast if the toasts plugin is loaded.
        const run = async (ref) => {
            if (el.getAttribute('aria-busy') === 'true') return;
            const payload = modeHint ? { mode: modeHint } : {};
            const api = window.ManifestPayments;
            if (!api) { console.warn('[x-pay] payments core not loaded'); return; }
            if (!isPortal && (ref === undefined || ref === null || ref === '')) {
                console.warn('[x-pay] no ref provided'); return;
            }
            el.setAttribute('aria-busy', 'true');
            const hadDisabled = 'disabled' in el ? el.disabled : null;
            if (hadDisabled === false) el.disabled = true;
            try {
                if (isPortal) await api.portal(typeof ref === 'string' && ref ? ref : 'portal', payload);
                else await api.initiate(ref, payload);
            } catch (err) {
                try {
                    const toast = Alpine.evaluate(el, '$toast');
                    if (toast?.negative) toast.negative(err?.message || 'Payment could not be started');
                } catch (_) { /* toasts plugin not loaded */ }
            } finally {
                el.removeAttribute('aria-busy');
                if (hadDisabled === false) el.disabled = false;
            }
        };

        const handler = (e) => {
            e.preventDefault();
            if (getRef) getRef((ref) => run(ref));
            else run('portal'); // bare x-pay.portal
        };

        el.addEventListener('click', handler);
        cleanup(() => el.removeEventListener('click', handler));
    });
}

document.addEventListener('alpine:init', () => {
    try { initializePaymentsDirective(); } catch (_) { /* graceful */ }
});

window.ManifestPaymentsDirective = { initialize: initializePaymentsDirective };


/* Manifest Payments — boot (settle redirect-returns, pull initial state) */

function bootPayments() {
    if (window.__manifestPaymentsBooted) return;
    window.__manifestPaymentsBooted = true;

    // Settle any redirect-return immediately (webhook is truth — this re-pulls state).
    try { window.ManifestPayments?.handleReturn(); } catch (_) { /* graceful */ }

    // Initial managed-mode state pull. If auth is present, wait for it so the
    // identity context (user/workspace) is populated before the request.
    const pull = () => { try { window.ManifestPayments?.refreshState(); } catch (_) {} };
    if (window.Alpine?.store && Alpine.store('auth')) {
        window.addEventListener('manifest:auth:initialized', pull, { once: true });
        // Fallback in case auth already initialized before this listener attached.
        setTimeout(pull, 1500);
    } else {
        pull();
    }
}

document.addEventListener('alpine:init', () => {
    try { bootPayments(); } catch (_) { /* graceful */ }
});

// Cover the case where Alpine already initialized before this script ran.
if (typeof Alpine !== 'undefined') {
    try { bootPayments(); } catch (_) { /* graceful */ }
}

window.ManifestPaymentsMain = { boot: bootPayments };
