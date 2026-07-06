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
