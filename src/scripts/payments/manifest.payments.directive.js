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
