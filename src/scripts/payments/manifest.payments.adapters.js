/* Payments adapters */
//
// An adapter is the ONLY provider-specific client code. It knows how to open a
// provider's overlay/embedded checkout. Link-through (redirect) needs no adapter
// and is the universal floor — ANY provider with a hosted page works without one.
//
// Capability tiers:
//   overlay  (supportsOverlay: true)  — provider exposes a programmatic modal
//                                        with a success/cancel callback. Shipped
//                                        for: revolut, paddle, lemonsqueezy,
//                                        polar, razorpay.
//   redirect (supportsOverlay: false) — no no-mount modal; works via the redirect
//                                        floor (server returns {mode:'redirect',
//                                        url}). Embedded/popup variants (Stripe
//                                        Elements, Square Web Payments, PayPal
//                                        Buttons, …) can be added per-provider via
//                                        $pay.register(name, customAdapter).
//
// Adapter shape:
//   { supportsOverlay: bool,
//     async open({ url, params, config }) -> { status: 'complete'|'cancelled'|… } }
//
// The server (your function) decides modality per response, so adapters never see
// secret keys — only a hosted url, publishable params, or a public token.

// Load a CDN script once; resolve when ready. Adapters call this on first use so
// heavy provider SDKs are never bundled and never appear in prerendered output.
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

// Revolut Merchant — popup over an order token. Function returns
// { provider:'revolut', params:{ token } }  (token = the order's public id).
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

// Paddle (MoR) — overlay via Paddle.js. Function returns
// { provider:'paddle', params:{ token, items, customer, … } }  (token = publishable).
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

// Lemon Squeezy (MoR) — URL-in-a-modal via lemon.js. Function returns
// { provider:'lemonsqueezy', url }  (a hosted checkout URL).
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

// Polar (MoR) — URL-in-a-modal via the embed SDK. Function returns
// { provider:'polar', url }  (a checkout-link/session url).
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

// Razorpay — true modal checkout. Function returns
// { provider:'razorpay', params:{ key, order_id, amount, … } }.
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
// Well-known hosted-page providers with no clean no-mount modal. They work today
// via the redirect floor — the function returns { mode:'redirect', url } (a hosted
// checkout / payment link / order approve url). Registered for discoverability and
// so a mistaken mode:'overlay' degrades cleanly. Add an embedded/popup variant any
// time with $pay.register(name, { supportsOverlay:true, open }).
//
//   stripe     Checkout session url (Elements/embedded = custom adapter)
//   square     Payment Link / Checkout API url (Web Payments SDK = custom)
//   paypal     Orders API approve url (Smart Buttons popup = custom)
//   braintree  hosted / Drop-in (Drop-in needs a mount node = custom)
//   adyen      Pay-by-Link / hosted (Drop-in/Components = custom)
//   mollie     hosted checkout (redirect-first by design)
//
// NOTE: any provider NOT listed here still works with zero config via the same
// redirect floor (absolute-URL ref, or the function returning {mode:'redirect'}).
// Hosted destinations like Patreon / Buy Me a Coffee / Ko-fi / donation pages are
// just link-through: <a x-pay="'https://patreon.com/you'">…</a>. No adapter needed.
['stripe', 'square', 'paypal', 'braintree', 'adyen', 'mollie']
    .forEach((name) => register(name, { supportsOverlay: false, redirectOnly: true }));

window.ManifestPaymentsAdapters = { register, get, list, loadScript };
