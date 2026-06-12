/* Payments main */
//
// Orchestration: settle redirect-returns and pull initial state once Alpine and
// (optionally) auth are ready. Registration of store/magic/directive happens in
// their own subscripts on alpine:init.

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
