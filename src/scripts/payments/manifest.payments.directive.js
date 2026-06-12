/* Payments directive (x-pay) */
//
// Sugar for "on click, initiate this ref". Markup is provider- AND modality-
// agnostic — switching either is a config/server change, never an HTML change.
//   <button x-pay="'pro-monthly'">Subscribe</button>
//   <button x-pay="'credits-1000'">Buy credits</button>
//   <button x-pay.portal>Manage billing</button>
//   <button x-pay.overlay="'pro-monthly'">Subscribe</button>   modality hint
//   <a x-pay="cart.token">Checkout</a>
//
// Modifiers:
//   .portal           treat as a portal flow (ref defaults to "portal")
//   .overlay/.redirect  hint preferred modality to the function (server decides)

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

        // Busy guard: ignore clicks while a flow is in flight and disable the
        // element, so double-clicks can't mint duplicate checkout sessions.
        // On failure, surface feedback automatically via the toasts plugin
        // when it's loaded ($toast resolved through this element's Alpine
        // scope); programmatic $pay() callers handle their own rejections.
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
