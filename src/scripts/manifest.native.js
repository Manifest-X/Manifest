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
