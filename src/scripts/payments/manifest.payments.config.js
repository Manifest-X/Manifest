/*  Manifest Payments
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Provider-agnostic payments surface (x-pay / $pay).
/*  The client only ever talks to YOUR function endpoint — never a provider's
/*  secret API directly. Session creation, fulfilment webhooks and any mutation
/*  live server-side. See manifest.payments.core.js for the contract.
*/

/* Payments config */

// Refuse strings still containing an unresolved ${VAR}. The loader interpolates
// against window.env before caching the manifest, so a literal ${VAR} here means
// an undefined env var — fail loud rather than POST it to the function verbatim.
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
//   provider   default adapter key (e.g. "revolut", "stripe", "paddle")
//   endpoint   YOUR function base — mints checkout/portal sessions, verifies webhooks
//   mode       default modality hint: "redirect" | "overlay" (server may override)
//   publicKey  publishable key for overlay SDK init (safe to expose; NOT a secret key)
//   managed    true = Manifest-hosted server moment (endpoint inferred)
//   state      optional reactive-state source for $pay.state: { url } (GET) — for
//              managed mode. Appwrite-backed projects read state via $x instead.
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
