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
