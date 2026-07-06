// Device signal — $device (os / touch / online / standalone / native / platform).
// Stamps html[data-online|standalone|native] for CSS variants; $device mirrors it reactively.

// Stamp device-state attributes before first paint. Honors values already set
// (prerenderer, the native umbrella, or manual); data-os is set by detectOS.
function stampManifestDeviceAttrs() {
    try {
        const html = document.documentElement;
        if (!html) return;
        const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
        if (standalone && !html.hasAttribute('data-standalone')) html.setAttribute('data-standalone', '');
        if (!html.hasAttribute('data-native')) {
            const cap = window.Capacitor;
            const native = !!(cap && (typeof cap.isNativePlatform !== 'function' || cap.isNativePlatform()));
            if (native) html.setAttribute('data-native', '');
        }
        html.setAttribute('data-online', navigator.onLine === false ? 'false' : 'true');
    } catch (e) {
        // Non-fatal: device-scoped utilities simply won't match.
    }
}
stampManifestDeviceAttrs();

// Keep html[data-online] and the reactive store in sync with connectivity changes.
function syncManifestDeviceOnline() {
    try {
        const online = navigator.onLine !== false;
        document.documentElement.setAttribute('data-online', online ? 'true' : 'false');
        if (window.Alpine && typeof window.Alpine.store === 'function') {
            const store = window.Alpine.store('device');
            if (store) store.online = online;
        }
    } catch (e) {}
}
window.addEventListener('online', syncManifestDeviceOnline);
window.addEventListener('offline', syncManifestDeviceOnline);

// Register $device + its reactive store once Alpine is available.
let manifestDeviceInitialized = false;
function initManifestDeviceSignal() {
    const html = document.documentElement;
    window.Alpine.store('device', { online: navigator.onLine !== false });
    window.Alpine.magic('device', () => ({
        get os() { return html.getAttribute('data-os') || ''; },
        get touch() { return (navigator.maxTouchPoints || 0) > 1 || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || false; },
        get online() { const s = window.Alpine.store('device'); return s ? s.online !== false : navigator.onLine !== false; },
        get standalone() { return html.hasAttribute('data-standalone'); },
        get native() { return html.hasAttribute('data-native'); },
        get platform() { return html.getAttribute('data-platform') || (html.hasAttribute('data-native') ? (html.getAttribute('data-os') || 'native') : 'web'); }
    }));
}
function ensureManifestDeviceInitialized() {
    if (manifestDeviceInitialized) return;
    if (!window.Alpine || typeof window.Alpine.magic !== 'function' || typeof window.Alpine.store !== 'function') return;
    manifestDeviceInitialized = true;
    initManifestDeviceSignal();
}
window.ensureManifestDeviceInitialized = ensureManifestDeviceInitialized;
document.addEventListener('alpine:init', ensureManifestDeviceInitialized);
if (window.Alpine && typeof window.Alpine.magic === 'function') {
    setTimeout(ensureManifestDeviceInitialized, 0);
} else {
    const manifestDeviceCheck = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.magic === 'function') {
            clearInterval(manifestDeviceCheck);
            ensureManifestDeviceInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(manifestDeviceCheck), 5000);
}
