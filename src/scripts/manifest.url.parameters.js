/* Manifest URL Parameters */

function initializeUrlParametersPlugin() {
    const DEBOUNCE_DELAY = 300;

    // Parse query string; comma-separated values become arrays
    function parseQueryString(queryString) {
        const params = new URLSearchParams(queryString);
        const result = {};
        for (const [key, value] of params.entries()) {
            if (value.includes(',')) {
                result[key] = value.split(',').filter(Boolean);
            } else {
                result[key] = value;
            }
        }
        return result;
    }

    function stringifyQueryObject(query) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (Array.isArray(value)) {
                if (value.filter(Boolean).length) params.set(key, value.filter(Boolean).join(','));
            } else if (value != null && value !== '') {
                params.set(key, value);
            }
        }
        return params.toString();
    }

    function ensureArray(value) {
        if (Array.isArray(value)) return value;
        if (value == null || value === '') return [];
        if (typeof value === 'string' && value.includes(',')) return value.split(',').filter(Boolean);
        return [value];
    }

    // Single reactive source of truth. Reads through $url register as Alpine
    // dependencies; location is a debounced mirror of this state, not the store.
    const params = Alpine.reactive({
        current: parseQueryString(window.location.search),
        _initialized: true
    });
    Alpine.store('urlParams', params);

    // ---- location mirror (debounced, coalesces multi-key writes) ------------
    let mirrorTimer = null;
    function mirror() {
        clearTimeout(mirrorTimer);
        mirrorTimer = setTimeout(() => {
            mirrorTimer = null;
            const url = new URL(window.location.href);
            const qs = stringifyQueryObject(params.current);
            url.search = qs ? `?${qs}` : '';
            if (url.toString() !== window.location.href) {
                history.pushState({}, '', url.toString());
            }
        }, DEBOUNCE_DELAY);
    }

    // ---- rehydrate from location (back/forward, router go/replace) ----------
    function rehydrate() {
        if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }   // navigation wins over pending writes
        const next = parseQueryString(window.location.search);
        if (stringifyQueryObject(next) !== stringifyQueryObject(params.current)) {
            params.current = next;
        }
    }
    window.addEventListener('popstate', rehydrate);

    // Router go()/replace() (and any third party) drive history directly with
    // no popstate — wrap so $url reads stay fresh. Our own mirror round-trips
    // through this harmlessly (equality check above makes it a no-op).
    for (const method of ['pushState', 'replaceState']) {
        const original = history[method].bind(history);
        history[method] = function (...args) {
            const result = original(...args);
            rehydrate();
            return result;
        };
    }

    // ---- mutations (synchronous into reactive state) ------------------------
    function apply(prop, value, action) {
        const next = Object.assign({}, params.current);
        switch (action) {
            case 'add': {
                const merged = [...new Set([...ensureArray(next[prop]), ...ensureArray(value)])];
                if (merged.length) next[prop] = merged; else delete next[prop];
                break;
            }
            case 'remove': {
                const remaining = ensureArray(next[prop]).filter(v => !ensureArray(value).includes(v));
                if (remaining.length) next[prop] = remaining; else delete next[prop];
                break;
            }
            case 'clear':
                delete next[prop];
                break;
            case 'set':
            default:
                if (value == null || value === '' || (Array.isArray(value) && !value.length)) {
                    delete next[prop];
                } else {
                    next[prop] = value;
                }
                break;
        }
        params.current = next;
        mirror();
        document.dispatchEvent(new CustomEvent('url-updated', {
            detail: { updates: { [prop]: value }, action }
        }));
    }

    // ---- $url magic ---------------------------------------------------------
    Alpine.magic('url', () => {
        return new Proxy({}, {
            get(target, prop) {
                if (prop === Symbol.iterator || prop === 'then' || prop === 'catch' || prop === 'finally') {
                    return undefined;
                }
                return new Proxy({}, {
                    get(t, key) {
                        // reads happen at access time so effects track them
                        if (key === 'value') {
                            const value = params.current[prop];
                            if (Array.isArray(value)) return value;
                            if (typeof value === 'string' && value.includes(',')) return value.split(',').filter(Boolean);
                            return value;
                        }
                        if (key === 'first') {
                            const all = ensureArray(params.current[prop]);
                            return all.length ? all[0] : null;
                        }
                        if (key === 'all') return ensureArray(params.current[prop]);
                        if (key === 'set') return (v) => apply(prop, v, 'set');
                        if (key === 'add') return (v) => apply(prop, v, 'add');
                        // no-arg remove clears the whole param
                        if (key === 'remove') return (v) => apply(prop, v, v === undefined ? 'clear' : 'remove');
                        if (key === 'clear') return () => apply(prop, null, 'clear');
                        return undefined;
                    },
                    set(t, key, v) {
                        // settable value for x-model compatibility
                        if (key === 'value') { apply(prop, v, 'set'); return true; }
                        return false;
                    }
                });
            }
        });
    });
}

// Track initialization to prevent duplicates
let urlParametersPluginInitialized = false;

function ensureUrlParametersPluginInitialized() {
    if (urlParametersPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;

    urlParametersPluginInitialized = true;
    initializeUrlParametersPlugin();
}

// Expose on window for loader to call if needed
window.ensureUrlParametersPluginInitialized = ensureUrlParametersPluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureUrlParametersPluginInitialized);
}

document.addEventListener('alpine:init', ensureUrlParametersPluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately.
// Otherwise ALWAYS poll until Alpine is available — the previous logic gated the
// polling on `document.readyState === 'complete'`, which produced a dead window
// when the loader injected this plugin script after DOMContentLoaded but before
// document complete: alpine:init had already fired, the readyState gate failed,
// and the plugin sat unregistered for the lifetime of the page.
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureUrlParametersPluginInitialized, 0);
} else {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureUrlParametersPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}
