/* Manifest Components */

// Base URL for manifest-relative paths (e.g. "../" when viewing dist/index.html). Used by component loader, data loaders, localization.
window.getManifestBase = function getManifestBase() {
    const href = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
    const lastSlash = href.lastIndexOf('/');
    return lastSlash >= 0 ? href.slice(0, lastSlash + 1) : '/';
};

// Absolute pathname prefix for the app root (e.g. "/src/dist"). Used by router for links and route matching.
// Prerender injects <meta name="manifest:router-base" content="/path"> from manifest.render.routerBase or root+output. If present, use it; else fall back to depth or manifest link.
window.getManifestBasePath = function getManifestBasePath() {
    const baseMeta = document.querySelector('meta[name="manifest:router-base"]');
    const content = baseMeta?.getAttribute('content');
    if (content != null && content !== '') {
        const base = '/' + String(content).replace(/^\/+|\/+$/g, '').trim();
        return base || '';
    }
    const meta = document.querySelector('meta[name="manifest:router-base-depth"]');
    const depth = meta ? parseInt(meta.getAttribute('content'), 10) : NaN;
    if (!Number.isNaN(depth) && depth >= 0) {
        const pathname = (window.location.pathname || '/').replace(/\/$/, '') || '/';
        const segments = pathname.split('/').filter(Boolean);
        if (depth === 0) {
            try {
                const link = document.querySelector('link[rel="manifest"]');
                const href = (link?.getAttribute('href')) || '/manifest.json';
                const url = new URL(href, window.location.href);
                const basePath = url.pathname.replace(/\/[^/]*$/, '') || '/';
                return basePath === '/' ? '' : basePath;
            } catch {
                return '';
            }
        }
        const keep = Math.max(0, segments.length - depth);
        return keep === 0 ? '' : '/' + segments.slice(0, keep).join('/');
    }
    try {
        const link = document.querySelector('link[rel="manifest"]');
        const href = (link?.getAttribute('href')) || '/manifest.json';
        const url = new URL(href, window.location.href);
        const pathname = url.pathname.replace(/\/[^/]*$/, '') || '/';
        return pathname === '/' ? '' : pathname;
    } catch {
        return '';
    }
};

// Components registry
window.ManifestComponentsRegistry = {
    manifest: null,
    registered: new Set(),
    preloaded: [],
    async initialize() {
        // Use loader-provided manifest if set; otherwise fetch it (standalone
        // usage, or a boot race where the loader/data plugin hasn't cached the
        // manifest on window yet).  This must be async — a synchronous XHR on
        // the main thread is deprecated and was flagged by PageSpeed.
        let manifest = window.__manifestLoaded || this.manifest;
        if (!manifest) {
            try {
                const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
                const res = await fetch(manifestUrl + (manifestUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), {
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache' }
                });
                if (res.ok) {
                    manifest = await res.json();
                } else {
                    console.warn('[Manifest] Failed to load manifest.json (HTTP', res.status + ')');
                }
            } catch (e) {
                console.warn('[Manifest] Failed to load manifest.json:', e.message);
            }
        }
        if (manifest) {
            this.manifest = manifest;
            const allComponents = [
                ...(this.manifest?.preloadedComponents || []),
                ...(this.manifest?.components || [])
            ];
            allComponents.forEach(path => {
                const name = path.split('/').pop().replace('.html', '');
                this.registered.add(name);
            });
            this.preloaded = (this.manifest?.preloadedComponents || []).map(path => path.split('/').pop().replace('.html', ''));
        }
    }
}; 