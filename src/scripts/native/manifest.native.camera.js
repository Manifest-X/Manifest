// $camera — capture or pick a photo. Native: Capacitor Camera.getPhoto. Web
// fallback: a file input (with capture hint on mobile) returning a data URL.
// Resolves { dataUrl?, format?, cancelled?, error? }.

function manifestCameraWeb(opts) {
    const o = opts || {};
    return new Promise(resolve => {
        try {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            if (o.source !== 'photos') input.setAttribute('capture', 'environment');
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                window.removeEventListener('focus', onFocus);
                input.remove();
                resolve(result);
            };
            // No 'change' fires when the picker is cancelled; detect it on focus return.
            const onFocus = () => setTimeout(() => { if (!settled && (!input.files || !input.files.length)) done({ cancelled: true }); }, 500);
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                if (!file) { done({ cancelled: true }); return; }
                const reader = new FileReader();
                reader.onload = () => done({ dataUrl: reader.result, format: (file.type.split('/')[1]) || '' });
                reader.onerror = () => done({ cancelled: true, error: 'read-failed' });
                reader.readAsDataURL(file);
            });
            window.addEventListener('focus', onFocus);
            document.body.appendChild(input);
            input.click();
        } catch (e) { resolve({ cancelled: true, error: 'unsupported' }); }
    });
}

function manifestCameraPhoto(opts) {
    const o = opts || {};
    const Cam = manifestNativePlugin('Camera');
    if (Cam) {
        return Cam.getPhoto({ resultType: 'dataUrl', source: o.source === 'photos' ? 'PHOTOS' : 'CAMERA', quality: o.quality || 90 })
            .then(r => ({ dataUrl: r && (r.dataUrl || r.webPath), format: r && r.format }))
            .catch(e => ({ cancelled: true, error: (e && (e.message || e.code)) || 'cancelled' }));
    }
    return manifestCameraWeb(o);
}

function initManifestCamera() {
    window.Alpine.magic('camera', () => ({
        photo: (opts) => manifestCameraPhoto(opts),
        pick: (opts) => manifestCameraPhoto(Object.assign({}, opts || {}, { source: 'photos' }))
    }));
}
