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
