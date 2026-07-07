// Manifest Native — umbrella core: Capacitor detection + $device enrichment.
// Capacitor injects window.Capacitor (+ window.Capacitor.Plugins.<Name>) in the
// native container. Every capability degrades to a web equivalent when absent,
// so this plugin is safe to load on the web build too.

function manifestNativeIsNative() {
    const cap = window.Capacitor;
    return !!(cap && (typeof cap.isNativePlatform !== 'function' || cap.isNativePlatform()));
}
function manifestNativePlugin(name) {
    const cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins[name]) || null;
}
function manifestNativePlatform() {
    const cap = window.Capacitor;
    if (cap && typeof cap.getPlatform === 'function') { try { return cap.getPlatform(); } catch (e) {} }
    return manifestNativeIsNative() ? (document.documentElement.getAttribute('data-os') || 'native') : 'web';
}

// Authoritatively stamp container/platform for $device + CSS variants.
function manifestNativeStamp() {
    try {
        if (!manifestNativeIsNative()) return;
        const html = document.documentElement;
        html.setAttribute('data-native', '');
        const p = manifestNativePlatform();
        if (p && p !== 'web') html.setAttribute('data-platform', p);
    } catch (e) {}
}
manifestNativeStamp();
if (typeof initManifestNativeNetwork === 'function') initManifestNativeNetwork();

// Register capability magics once Alpine is available.
let manifestNativeInitialized = false;
function initManifestNative() {
    if (typeof initManifestShare === 'function') initManifestShare();
    if (typeof initManifestSecure === 'function') initManifestSecure();
    if (typeof initManifestLinks === 'function') initManifestLinks();
}
function ensureManifestNativeInitialized() {
    if (manifestNativeInitialized) return;
    if (!window.Alpine || typeof window.Alpine.magic !== 'function') return;
    manifestNativeInitialized = true;
    initManifestNative();
}
window.ensureManifestNativeInitialized = ensureManifestNativeInitialized;
document.addEventListener('alpine:init', ensureManifestNativeInitialized);
if (window.Alpine && typeof window.Alpine.magic === 'function') {
    setTimeout(ensureManifestNativeInitialized, 0);
} else {
    const manifestNativeCheck = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.magic === 'function') {
            clearInterval(manifestNativeCheck);
            ensureManifestNativeInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(manifestNativeCheck), 5000);
}


// $share — native share sheet (Capacitor Share) → Web Share API → clipboard.
// Resolves to { shared, method: 'native'|'web'|'clipboard'|'none', cancelled? }.

function manifestShareCancelled(e) {
    return !!(e && (e.code === 'CANCELED' || e.name === 'AbortError' || /cancel|abort/i.test(e.message || '')));
}
function manifestShareClipboard(payload) {
    const text = payload.url || payload.text || payload.title || '';
    if (text && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
            .then(() => ({ shared: true, method: 'clipboard' }))
            .catch(() => ({ shared: false, method: 'none' }));
    }
    return Promise.resolve({ shared: false, method: 'none' });
}
function manifestShareWeb(payload) {
    if (navigator.share) {
        return navigator.share({ title: payload.title, text: payload.text, url: payload.url })
            .then(() => ({ shared: true, method: 'web' }))
            .catch(e => manifestShareCancelled(e)
                ? { shared: false, method: 'web', cancelled: true }
                : manifestShareClipboard(payload));
    }
    return manifestShareClipboard(payload);
}
function manifestShare(opts) {
    const payload = opts || {};
    const Share = manifestNativePlugin('Share');
    if (Share) {
        return Share.share({ title: payload.title, text: payload.text, url: payload.url, dialogTitle: payload.dialogTitle })
            .then(() => ({ shared: true, method: 'native' }))
            .catch(e => manifestShareCancelled(e)
                ? { shared: false, method: 'native', cancelled: true }
                : manifestShareWeb(payload));
    }
    return manifestShareWeb(payload);
}
function initManifestShare() {
    window.Alpine.magic('share', () => manifestShare);
}


// Network — higher-fidelity connectivity via Capacitor Network, feeding $device.
// On the web the base $device signal already tracks navigator online/offline;
// this only upgrades fidelity inside the native container.

function manifestNativeApplyOnline(connected) {
    const online = connected !== false;
    try {
        document.documentElement.setAttribute('data-online', online ? 'true' : 'false');
        if (window.Alpine && typeof window.Alpine.store === 'function') {
            const store = window.Alpine.store('device');
            if (store) store.online = online;
        }
    } catch (e) {}
}
function initManifestNativeNetwork() {
    const Network = manifestNativePlugin('Network');
    if (!Network) return;
    try { Network.getStatus().then(s => manifestNativeApplyOnline(s && s.connected)).catch(() => {}); } catch (e) {}
    try { Network.addListener('networkStatusChange', s => manifestNativeApplyOnline(s && s.connected)); } catch (e) {}
}


// $secure — Keychain/Keystore-backed key/value storage (native) with a
// namespaced localStorage fallback on the web. Intended for session tokens etc.
// Native: install a Capacitor secure-storage plugin registered as
// window.Capacitor.Plugins.SecureStorage; if its method shape differs from the
// adapters below, override with $secure.use(adapter). Verify on device.
// The web fallback is NOT encrypted — it degrades honestly, not securely.

const MANIFEST_SECURE_NS = 'mnfst:';

function manifestSecureWebBackend() {
    const ls = () => window.localStorage;
    return {
        async get(key) { try { return ls().getItem(MANIFEST_SECURE_NS + key); } catch (e) { return null; } },
        async set(key, value) { try { ls().setItem(MANIFEST_SECURE_NS + key, String(value)); } catch (e) {} },
        async remove(key) { try { ls().removeItem(MANIFEST_SECURE_NS + key); } catch (e) {} },
        async keys() {
            try { return Object.keys(ls()).filter(k => k.indexOf(MANIFEST_SECURE_NS) === 0).map(k => k.slice(MANIFEST_SECURE_NS.length)); }
            catch (e) { return []; }
        },
        async clear() { try { const ks = await this.keys(); ks.forEach(k => ls().removeItem(MANIFEST_SECURE_NS + k)); } catch (e) {} }
    };
}

// Adapts the two common Capacitor secure-storage plugin shapes: localStorage-like
// (getItem/setItem/removeItem) or object-arg (get/set/remove with {key,value}).
function manifestSecureNativeBackend(plugin) {
    const itemApi = typeof plugin.getItem === 'function';
    return {
        async get(key) {
            try {
                if (itemApi) { const v = await plugin.getItem(key); return v == null ? null : v; }
                const r = await plugin.get({ key }); return r && typeof r.value !== 'undefined' ? r.value : (r == null ? null : r);
            } catch (e) { return null; }
        },
        async set(key, value) {
            try { if (itemApi) await plugin.setItem(key, String(value)); else await plugin.set({ key, value: String(value) }); } catch (e) {}
        },
        async remove(key) {
            try { if (typeof plugin.removeItem === 'function') await plugin.removeItem(key); else await plugin.remove({ key }); } catch (e) {}
        },
        async keys() { try { const r = await plugin.keys(); return Array.isArray(r) ? r : (r && r.value) || []; } catch (e) { return []; } },
        async clear() { try { await plugin.clear(); } catch (e) {} }
    };
}

let _manifestSecureBackend = null;
function manifestSecureBackend() {
    if (_manifestSecureBackend) return _manifestSecureBackend;
    const plugin = manifestNativePlugin('SecureStorage');
    _manifestSecureBackend = plugin ? manifestSecureNativeBackend(plugin) : manifestSecureWebBackend();
    return _manifestSecureBackend;
}

function initManifestSecure() {
    window.Alpine.magic('secure', () => ({
        get: (k) => manifestSecureBackend().get(k),
        set: (k, v) => manifestSecureBackend().set(k, v),
        remove: (k) => manifestSecureBackend().remove(k),
        keys: () => manifestSecureBackend().keys(),
        clear: () => manifestSecureBackend().clear(),
        use: (adapter) => { _manifestSecureBackend = adapter; }
    }));
}


// $links — deep / universal links. Native: Capacitor App fires appUrlOpen (and a
// cold-start launch URL); Manifest extracts the path and hands off to the router.
// $links.on(fn) lets the author take over routing (e.g. load data for /order/123).
// On the web there's no bridge, but $links.open(url) still works for programmatic
// deep-linking and testing. Couples with lifecycle + push (tap → route).

function manifestLinkPath(url) {
    try { const u = new URL(url, window.location.origin); return u.pathname + u.search + u.hash; }
    catch (e) {
        const m = String(url).match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/[^\s]*)?$/i);
        return (m && m[1]) || '/';
    }
}

// Faithful SPA navigation: route through the router's own click interceptor.
function manifestNavigateTo(path) {
    const nav = window.ManifestRoutingNavigation;
    if (nav) {
        const a = document.createElement('a');
        a.setAttribute('href', path);
        document.body.appendChild(a);
        a.click();
        a.remove();
    } else {
        window.location.assign(path);
    }
}

let _manifestLinkHandler = null;
function manifestHandleUrl(url) {
    const path = manifestLinkPath(url);
    try { const s = window.Alpine && window.Alpine.store('links'); if (s) s.last = url; } catch (e) {}
    if (typeof _manifestLinkHandler === 'function') { try { _manifestLinkHandler({ url, path }); } catch (e) {} return; }
    manifestNavigateTo(path);
}

function initManifestLinks() {
    window.Alpine.store('links', { last: null });
    window.Alpine.magic('links', () => ({
        on: (fn) => { _manifestLinkHandler = typeof fn === 'function' ? fn : null; },
        open: (url) => manifestHandleUrl(url),
        get last() { const s = window.Alpine.store('links'); return s ? s.last : null; }
    }));

    const App = manifestNativePlugin('App');
    if (App) {
        try { App.addListener('appUrlOpen', (data) => { if (data && data.url) manifestHandleUrl(data.url); }); } catch (e) {}
        try { App.getLaunchUrl().then(r => { if (r && r.url) manifestHandleUrl(r.url); }).catch(() => {}); } catch (e) {}
    }
}
