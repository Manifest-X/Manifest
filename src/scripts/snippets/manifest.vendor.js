// mnfst:vendor:start — synced by the build from scripts/snippets/manifest.vendor.js; edit there
// Pinned third-party files (npm paths in src/scripts/vendor.lock.json), loaded with their hash.
// Through the loader when present: CDN fallback, and its integrity map when checks are on.
if (!window.ManifestVendor) {
    const CDN = 'https://cdn.jsdelivr.net/npm/';
    window.ManifestVendor = {
        get checked() { return !!(window.Manifest && window.Manifest.integrity); },
        script(path, hash) {
            const M = window.Manifest;
            if (M && M.loadVendor) return M.loadVendor(path, hash);
            return new Promise((resolve, reject) => {
                const src = CDN + path;
                const found = document.querySelector(`script[src="${src}"]`);
                if (found && found.dataset.vendorLoaded) return resolve();
                const s = found || document.createElement('script');
                s.addEventListener('load', () => { s.dataset.vendorLoaded = '1'; resolve(); });
                s.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
                if (found) return;
                if (hash) { s.integrity = hash; s.crossOrigin = 'anonymous'; }
                s.src = src;
                document.head.appendChild(s);
            });
        },
        fetch(path, hash) {
            const M = window.Manifest;
            if (M && M.fetchVendor) return M.fetchVendor(path, hash);
            return fetch(CDN + path, hash ? { integrity: hash, mode: 'cors', credentials: 'omit' } : undefined)
                .then(r => { if (!r.ok) throw new Error(`Failed to load ${CDN + path}`); return r; });
        }
    };
}
// mnfst:vendor:end
