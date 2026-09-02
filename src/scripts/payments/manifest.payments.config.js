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
    if (window.__manifestPromise) { const shared = await window.__manifestPromise.catch(() => null); if (shared) return shared; }
    try {
        const url = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '/manifest.json';
        window.__manifestPromise = fetch(url).then(r => r.json());
        return await window.__manifestPromise;
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
