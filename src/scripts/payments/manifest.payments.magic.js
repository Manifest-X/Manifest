/* Payments magic ($pay) */
//
// $pay is a callable magic with reactive properties:
//   $pay('pro-monthly')            initiate a flow for an opaque ref → Promise
//   $pay('https://buy.…')          absolute URL → plain link-through, no server
//   $pay.portal()                  open the billing/customer portal
//   $pay.refresh()                 re-pull server state into $pay.state
//   $pay.register(name, adapter)   add/override an overlay adapter (escape hatch)
//   $pay.state                     server-defined entitlement record (schema-less)
//   $pay.loading / $pay.error / $pay.last
//
// Reads of .state/.loading/etc. go through the reactive 'pay' store, so Alpine
// tracks them in x-show / x-text. State for Appwrite projects is read via $x.

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
