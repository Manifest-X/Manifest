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
// Whether a plugin exposes a native method. Bundled apps get a registerPlugin
// Proxy where every property is a function, so prefer the native header.
function manifestNativeHas(name, plugin, method) {
    const headers = window.Capacitor && window.Capacitor.PluginHeaders;
    const h = Array.isArray(headers) && headers.find(x => x && x.name === name);
    if (h && Array.isArray(h.methods)) return h.methods.some(m => m && m.name === method);
    return !!plugin && typeof plugin[method] === 'function';
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

// Register capability magics once Alpine is available.
let manifestNativeInitialized = false;
function initManifestNative() {
    // Network runs here (not at load) so the Capacitor Network reading can reach
    // the $device store, which utilities registers on alpine:init.
    if (typeof initManifestNativeNetwork === 'function') initManifestNativeNetwork();
    if (typeof initManifestShare === 'function') initManifestShare();
    if (typeof initManifestSecure === 'function') initManifestSecure();
    if (typeof initManifestLinks === 'function') initManifestLinks();
    if (typeof initManifestPush === 'function') initManifestPush();
    if (typeof initManifestApp === 'function') initManifestApp();
    if (typeof initManifestHaptics === 'function') initManifestHaptics();
    if (typeof initManifestBiometric === 'function') initManifestBiometric();
    if (typeof initManifestCamera === 'function') initManifestCamera();
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
