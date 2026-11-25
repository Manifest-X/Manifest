// Components loader
// Uses cache for resolved content and _loading for in-flight promises so duplicate
// loadComponent(name) calls share one network request.
window.ManifestComponentsLoader = {
    // Framework web components (not project components): never fetched
    frameworkTags: new Set(['code', 'code-group']),
    cache: {},
    _loading: {},
    _missing: null,
    initialize() {
        // Keeps anything fetched before init (early prefetch)
        if (!this._missing) this._missing = new Set();
        // Preload components listed in registry.preloaded
        const registry = window.ManifestComponentsRegistry;
        if (registry && Array.isArray(registry.preloaded)) {
            registry.preloaded.forEach(name => {
                this.loadComponent(name).then(() => {
                    // Preloaded component
                });
            });
        }
    },
    async loadComponent(name) {
        if (this.cache[name]) {
            return this.cache[name];
        }
        if (this._loading[name]) {
            return this._loading[name];
        }
        const registry = window.ManifestComponentsRegistry;
        if (!registry) {
            console.warn('[Manifest] Registry unavailable, cannot load component:', name);
            return null;
        }
        // No manifest.json is fine — the convention fallback below still resolves.
        const mf = registry.manifest || {};
        let path = (mf.preloadedComponents || []).concat(mf.components || [])
            .find(p => p.split('/').pop().replace('.html', '') === name);
        // Convention fallback: unlisted names resolve to components/<name>.html.
        let convention = false;
        if (!path) {
            if (!this._missing) this._missing = new Set();
            if (this._missing.has(name)) return null;
            path = 'components/' + name + '.html';
            convention = true;
        }
        const base = (typeof window.getManifestBase === 'function' ? window.getManifestBase() : '') || '/';
        let url = path.startsWith('/') || path.startsWith('http') ? path : base + path;
        // Version stamp (publish-injected `deployment`, or authored `version`) busts browser-cached component HTML
        const stamp = mf.deployment || mf.version;
        if (stamp) url += (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(String(stamp));
        const promise = (async () => {
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    if (convention) {
                        this._missing.add(name);
                        console.warn('[Manifest] Component', name, 'is not listed in manifest.json and', path, 'was not found (HTTP', response.status + ')');
                    } else {
                        console.warn('[Manifest] HTML file not found for component', name, 'at path:', path, '(HTTP', response.status + ')');
                    }
                    return null;
                }
                const content = await response.text();
                // SPA-fallback guard: servers answer missing paths with the app
                // shell (200 + index.html). A whole document is never a component
                // — swapping it in nests the page inside itself recursively.
                if (/^\s*(<!doctype|<html[\s>])/i.test(content)) {
                    if (convention) this._missing.add(name);
                    console.warn('[Manifest] Component', name, 'at', path, 'returned a full HTML document (SPA fallback?) — treated as missing');
                    return null;
                }
                this.prefetchNested(content);
                // On-use plugins the component references load before it is inserted
                if (window.Manifest && typeof window.Manifest.loadUsed === 'function') {
                    try { await window.Manifest.loadUsed(content); } catch (_) { /* never blocks the component */ }
                }
                this.cache[name] = content;
                if (convention) registry.registered.add(name);
                return content;
            } catch (error) {
                console.warn('[Manifest] Failed to load component', name, 'from', path + ':', error.message);
                return null;
            } finally {
                delete this._loading[name];
            }
        })();
        this._loading[name] = promise;
        return promise;
    },
    // Start fetching every placeholder that will swap now, so the swap loop's awaits find them loaded
    prefetchPlaceholders(placeholders, decide) {
        for (const el of placeholders) {
            if (el.closest('[x-route]')) {
                // Route-gated: only once a router can say it is active (never queue a re-run from here)
                if (!decide || !window.ManifestRouting) continue;
                try { if (decide(el) !== 'swap') continue; } catch (_) { continue; }
            }
            const name = el.localName.slice(2);
            if (!this.frameworkTags.has(name)) this.loadComponent(name);
        }
    },
    // Registered components named in a component's markup, fetched before the parent is inserted
    prefetchNested(content) {
        const registry = window.ManifestComponentsRegistry;
        if (!registry || !registry.registered.size || content.indexOf('<x-') === -1) return;
        const tag = /<x-([a-z0-9][\w-]*)\b([^>]*)>/gi;
        let match;
        while ((match = tag.exec(content)) !== null) {
            const name = match[1].toLowerCase();
            if (!registry.registered.has(name) || /\bx-route\b/.test(match[2])) continue;
            this.loadComponent(name);
        }
    }
}; 