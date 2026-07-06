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
