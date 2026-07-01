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
