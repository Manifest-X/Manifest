/* manifest.components.js — built from scripts/components/ */

(function () {

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
        if (!manifest && window.__manifestPromise) manifest = await window.__manifestPromise.catch(() => null);
        if (!manifest) {
            try {
                const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
                const res = await fetch(manifestUrl + (manifestUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), {
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache' }
                });
                if (res.ok) {
                    manifest = await res.json();
                    // No-loader path: resolve ${VAR} placeholders the dynamic loader would have.
                    window.ManifestDataConfig?.interpolateManifest?.(manifest);
                    window.__manifestPromise = Promise.resolve(manifest);   // share with plugins that init after us
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

// Components loader
// Uses cache for resolved content and _loading for in-flight promises so duplicate
// loadComponent(name) calls share one network request.
window.ManifestComponentsLoader = {
    cache: {},
    _loading: {},
    _missing: null,
    initialize() {
        this.cache = {};
        this._loading = {};
        this._missing = new Set();
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
    }
}; 

// Components processor

// Escape a value for safe interpolation in single-quoted JS strings AND
// backtick template literals. Backslash, backtick, and ${ must be escaped or a
// bound value like `${alert(1)}` becomes code execution; escape backslash FIRST.
function escapeForSingleQuotedJsString(s) {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

// Framework web components (not project components) — never fetched.
const FRAMEWORK_COMPONENT_TAGS = new Set(['code', 'code-group']);

// Classic JS or module; anything else (JSON, templates) is a data block
function isExecutableScript(el) {
    const type = (el.getAttribute('type') || '').split(';')[0].trim().toLowerCase();
    return type === '' || type === 'module' || /^(text|application)\/(x-)?(javascript|ecmascript)$/.test(type) ||
        /^text\/(javascript1\.[0-5]|jscript|livescript)$/.test(type);
}

// The <template x-if>/<template x-for> whose tracked clone is `el`, if any.
function findOwningTemplate(el) {
    if (!el._x_dataStack) return null;
    for (let n = el.previousElementSibling; n; n = n.previousElementSibling) {
        if (n.tagName !== 'TEMPLATE') continue;
        if (n._x_currentIfEl === el) return { tpl: n, type: 'if' };
        const lookup = el._x_refreshXForScope && n._x_lookup;
        if (lookup) {
            // Map since Alpine 3.16, plain object before
            const entries = lookup instanceof Map ? lookup : Object.entries(lookup);
            for (const [key, value] of entries) if (value === el) return { tpl: n, type: 'for', key };
        }
    }
    return null;
}

// Point Alpine's clone bookkeeping at the swapped-in node.
function repointTemplateClone(owner, placeholder, node) {
    const { tpl } = owner;
    if (owner.type === 'if') {
        const undo = tpl._x_undoIf;
        tpl._x_currentIfEl = node;
        tpl._x_lastRenderedEl = node;
        tpl._x_undoIf = () => {
            const A = window.Alpine;
            const teardown = () => {
                if (A && A.destroyTree) A.destroyTree(node);
                node.remove();
            };
            A && A.mutateDom ? A.mutateDom(teardown) : teardown();
            if (undo) undo();
        };
    } else {
        if (tpl._x_lookup instanceof Map) tpl._x_lookup.set(owner.key, node);
        else tpl._x_lookup[owner.key] = node;
        node._x_refreshXForScope = placeholder._x_refreshXForScope;
        if (tpl._x_lastRenderedEl === placeholder) tpl._x_lastRenderedEl = node;
    }
}

window.ManifestComponentsProcessor = {
    async processComponent(element, instanceId) {
        const name = element.tagName.toLowerCase().replace('x-', '');
        const registry = window.ManifestComponentsRegistry;
        const loader = window.ManifestComponentsLoader;
        if (!registry || !loader) {
            console.debug('[Manifest Components] skipped: registry or loader unavailable', element);
            return;
        }
        if (FRAMEWORK_COMPONENT_TAGS.has(name)) return;
        if (element.hasAttribute('data-pre-rendered') || element.hasAttribute('data-processed')) {
            // Pre-rendered content skips re-fetch but still needs Alpine init.
            if (element.hasAttribute('data-pre-rendered') && window.Alpine && typeof window.Alpine.initTree === 'function') {
                try { window.Alpine.initTree(element); } catch (e) { /* graceful */ }
            }
            console.debug('[Manifest Components] skipped: already pre-rendered/processed', element);
            return;
        }
        // Unregistered names still try the loader's components/<name>.html
        // convention; a miss leaves the element alone (it may be someone else's).
        const wasRegistered = registry.registered.has(name);
        const content = await loader.loadComponent(name);
        if (!content) {
            if (!wasRegistered) {
                console.debug('[Manifest Components] skipped: component not registered', element);
                return;
            }
            console.debug('[Manifest Components] skipped: failed to load component', element);
            element.replaceWith(document.createComment(` Failed to load component: ${name} `));
            return;
        }
        const container = document.createElement('div');
        container.innerHTML = content.trim();
        let topLevelElements = Array.from(container.children);
        if (topLevelElements.length === 0) {
            console.debug('[Manifest Components] skipped: empty component template', element);
            element.replaceWith(document.createComment(` Empty component: ${name} `));
            return;
        }

        // Extract and prepare scripts for execution
        const scripts = [];
        const processScripts = (el) => {
            if (el.tagName.toLowerCase() === 'script') {
                // Data blocks (JSON, templates) are dropped, never run
                if (!isExecutableScript(el)) { el.remove(); return; }
                scripts.push({
                    content: el.textContent,
                    type: el.getAttribute('type') || 'text/javascript',
                    src: el.getAttribute('src'),
                    async: el.hasAttribute('async'),
                    defer: el.hasAttribute('defer')
                });
                // Remove script from DOM to avoid duplication
                el.remove();
            } else {
                Array.from(el.children).forEach(processScripts);
            }
        };
        topLevelElements.forEach(processScripts);
        topLevelElements = Array.from(container.children);
        // Collect properties from placeholder attributes
        const props = {};
        Array.from(element.attributes).forEach(attr => {
            if (attr.name !== name && attr.name !== 'class' && !attr.name.startsWith('data-')) {
                // Store original case and lowercase
                props[attr.name] = attr.value;
                props[attr.name.toLowerCase()] = attr.value;
                // Alpine bindings (:foo): also store without the colon
                if (attr.name.startsWith(':')) {
                    const keyWithoutColon = attr.name.substring(1);
                    props[keyWithoutColon] = attr.value;
                    props[keyWithoutColon.toLowerCase()] = attr.value;
                }
            }
        });
        // Process $modify usage in all elements
        const processElementProps = (el) => {
            Array.from(el.attributes).forEach(attr => {
                const value = attr.value.trim();
                if (value.includes('$modify(')) {
                    const propMatch = value.match(/\$modify\(['"]([^'"]+)['"]\)/);
                    if (propMatch) {
                        const propName = propMatch[1].toLowerCase();
                        const propValue = props[propName] || '';
                        if (attr.name === 'class') {
                            const existingClasses = el.getAttribute('class') || '';
                            const newClasses = existingClasses
                                .replace(new RegExp(`\$modify\(['"]${propName}['"]\)`, 'i'), propValue)
                                .split(' ')
                                .filter(Boolean)
                                .join(' ');
                            el.setAttribute('class', newClasses);
                        } else if (attr.name === 'x-icon') {
                            // x-icon should get the raw value, not wrapped for Alpine evaluation
                            el.setAttribute(attr.name, propValue);
                        } else if (attr.name === 'x-show' || attr.name === 'x-if') {
                            // x-show and x-if expect boolean expressions, convert string to boolean check
                            if (value !== `$modify('${propName}')`) {
                                const newValue = value.replace(
                                    /\$modify\(['"]([^'"]+)['"]\)/g,
                                    (_, name) => {
                                        const val = props[name.toLowerCase()] || '';
                                        // Convert to boolean check - true if value exists and is not empty
                                        return val ? 'true' : 'false';
                                    }
                                );
                                el.setAttribute(attr.name, newValue);
                            } else {
                                // Simple replacement - check if prop exists and is not empty
                                const booleanValue = propValue && propValue.trim() !== '' ? 'true' : 'false';
                                el.setAttribute(attr.name, booleanValue);
                            }
                        } else if (
                            attr.name.startsWith('x-') ||
                            attr.name.startsWith(':') ||
                            attr.name.startsWith('@') ||
                            attr.name.startsWith('x-bind:') ||
                            attr.name.startsWith('x-on:')
                        ) {
                            // For Alpine directives, properly quote string values
                            if (value !== `$modify('${propName}')`) {
                                // Handle mixed content with multiple $modify() calls
                                const newValue = value.replace(
                                    /\$modify\(['"]([^'"]+)['"]\)/g,
                                    (_, name) => {
                                        const val = props[name.toLowerCase()] || '';
                                        // For expressions with fallbacks (||), use null for empty/whitespace values
                                        if (!val || val.trim() === '' || /^[\r\n\t\s]+$/.test(val)) {
                                            return value.includes('||') ? 'null' : "''";
                                        }
                                        // $-prefixed values are Alpine expressions — don't quote.
                                        if (val.startsWith('$')) {
                                            // Guard $x data-source expressions on x-for/if/show against
                                            // errors before the source loads: optional-chain + fallback.
                                            if ((attr.name === 'x-for' || attr.name === 'x-if' || attr.name === 'x-show') && val.startsWith('$x') && !val.includes('??')) {
                                                let safeVal = val.replace(/\./g, '?.');
                                                if (attr.name === 'x-for') {
                                                    return `${safeVal} ?? []`;
                                                } else {
                                                    return `${safeVal} ?? false`;
                                                }
                                            }
                                            return val;
                                        }
                                        // x-for/if/show can hold expressions (e.g. "card in $x.data.items") — preserve as-is.
                                        if (attr.name === 'x-for' || attr.name === 'x-if' || attr.name === 'x-show') {
                                            return val;
                                        }
                                        // Quote everything else so it's treated as a string.
                                        return `'${escapeForSingleQuotedJsString(val)}'`;
                                    }
                                );
                                el.setAttribute(attr.name, newValue);
                            } else {
                                // Simple $modify() replacement
                                if (!propValue || propValue.trim() === '' || /^[\r\n\t\s]+$/.test(propValue)) {
                                    // For empty/whitespace values, remove the attribute
                                    el.removeAttribute(attr.name);
                                } else {
                                    // If value starts with $, it's an Alpine expression - don't quote
                                    if (propValue.startsWith('$')) {
                                        el.setAttribute(attr.name, propValue);
                                    } else {
                                        // Always quote string values and escape special characters
                                        const quotedValue = `'${escapeForSingleQuotedJsString(propValue)}'`;
                                        el.setAttribute(attr.name, quotedValue);
                                    }
                                }
                            }
                        } else {
                            el.setAttribute(attr.name, propValue);
                        }
                    }
                }
            });
            Array.from(el.children).forEach(processElementProps);
        };
        topLevelElements.forEach(processElementProps);
        // Apply attributes from placeholder to root elements
        const host = { roots: topLevelElements };
        topLevelElements.forEach(rootElement => {
            Array.from(element.attributes).forEach(attr => {
                if (attr.name === 'class') {
                    const existingClass = rootElement.getAttribute('class') || '';
                    const newClasses = `${existingClass} ${attr.value}`.trim();
                    rootElement.setAttribute('class', newClasses);
                } else if (attr.name.startsWith('x-') || attr.name.startsWith(':') || attr.name.startsWith('@')) {
                    rootElement.setAttribute(attr.name, attr.value);
                } else if (attr.name !== name && !attr.name.startsWith('data-')) {
                    rootElement.setAttribute(attr.name, attr.value);
                }
                // Preserve important data attributes including data-order
                else if (attr.name === 'data-order' || attr.name === 'x-route' || attr.name === 'data-head') {
                    rootElement.setAttribute(attr.name, attr.value);
                }
            });
            // The file this markup came from (Edit writes regions authored in it back there)
            rootElement._manifestComponent = name;
            rootElement._manifestHost = host;
            // Set data-component=instanceId if provided
            if (instanceId) {
                rootElement.setAttribute('data-component', instanceId);
            }
        });
        // Copy any placeholder attributes the first loop skipped onto the first
        // root element (classes already handled there, so skip them).
        if (topLevelElements.length > 0) {
            const firstRoot = topLevelElements[0];
            Array.from(element.attributes).forEach(attr => {
                if (attr.name === 'class') {
                    return;
                }

                // Routing/data attributes to preserve
                const preserveAttributes = [
                    'data-order', 'x-route', 'data-component', 'data-head',
                    'x-route-*', 'data-route-*', 'x-tabpanel'
                ];
                const shouldPreserve = preserveAttributes.some(preserveAttr =>
                    attr.name === preserveAttr || attr.name.startsWith(preserveAttr.replace('*', ''))
                );

                // Check if this attribute was already handled in the first loop
                const alreadyHandledInFirstLoop =
                    attr.name.startsWith('x-') || attr.name.startsWith(':') || attr.name.startsWith('@') ||
                    (attr.name !== name && !attr.name.startsWith('data-')) ||
                    attr.name === 'data-order' || attr.name === 'x-route' || attr.name === 'data-head';

                // Apply if unhandled or preserved, and not in the skip list.
                if ((!alreadyHandledInFirstLoop || shouldPreserve) &&
                    !['data-original-placeholder', 'data-pre-rendered', 'data-processed'].includes(attr.name)) {
                    if (attr.name.startsWith('x-') || attr.name.startsWith(':') || attr.name.startsWith('@')) {
                        // x-data: merge two object literals; otherwise replace.
                        if (attr.name === 'x-data' && firstRoot.hasAttribute('x-data')) {
                            const existing = firstRoot.getAttribute('x-data');
                            if (existing.trim().startsWith('{') && attr.value.trim().startsWith('{')) {
                                const existingContent = existing.trim().slice(1, -1).trim();
                                const newContent = attr.value.trim().slice(1, -1).trim();
                                const merged = `{ ${existingContent}${existingContent && newContent ? ', ' : ''}${newContent} }`;
                                firstRoot.setAttribute('x-data', merged);
                            } else {
                                firstRoot.setAttribute(attr.name, attr.value);
                            }
                        } else {
                            firstRoot.setAttribute(attr.name, attr.value);
                        }
                    } else {
                        firstRoot.setAttribute(attr.name, attr.value);
                    }
                }
            });
        }
        const parent = element.parentElement;
        if (!parent || !document.contains(element)) {
            console.debug('[Manifest Components] skipped: element detached before swap', element);
            return;
        }
        // Replace the placeholder element with the component content
        const fragment = document.createDocumentFragment();
        topLevelElements.forEach(el => fragment.appendChild(el));

        // Sole child of x-if/x-for: Alpine tracks one node per clone, so a
        // multi-root component keeps a host; the clone's scope carries over.
        const owner = findOwningTemplate(element);
        let swapped = fragment;
        if (owner && topLevelElements.length) {
            swapped = topLevelElements[0];
            if (topLevelElements.length > 1) {
                swapped = document.createElement(element.tagName.toLowerCase());
                swapped.setAttribute('data-processed', '');
                swapped.style.display = 'contents';
                swapped.appendChild(fragment);
            }
            swapped._x_dataStack = element.hasAttribute('x-data') ? element._x_dataStack.slice(1) : element._x_dataStack;
            repointTemplateClone(owner, element, swapped);
        }

        parent.replaceChild(swapped, element);

        // Manually init Alpine on the swapped-in elements once magic methods are
        // ready — prevents "i is not a function" errors.
        if (window.Alpine && typeof window.Alpine.initTree === 'function') {
            const initAlpine = () => {
                // Init auth convenience methods before Alpine evaluates expressions,
                // else "$auth.isCreatingTeam is not a function" after reinit.
                if (window.ManifestAppwriteAuthTeamsConvenience && window.ManifestAppwriteAuthTeamsConvenience.initialize) {
                    try {
                        const authStore = window.Alpine.store('auth');
                        if (authStore && (!authStore.isCreatingTeam || typeof authStore.isCreatingTeam !== 'function')) {
                            window.ManifestAppwriteAuthTeamsConvenience.initialize();
                        }
                    } catch (error) {
                        // Failed to reinitialize, continue anyway
                    }
                }

                topLevelElements.forEach(el => {
                    if (!el.__x) {
                        try {
                            window.Alpine.initTree(el);
                        } catch (e) {
                            console.error(`[Manifest Components] Error initializing Alpine for component "${name}":`, e);
                        }
                    }
                });
            };

            // If the data plugin is ready, wait a tick for its magic method.
            if (window.__manifestDataMagicRegistered) {
                if (window.Alpine.nextTick) {
                    window.Alpine.nextTick(initAlpine);
                } else {
                    setTimeout(initAlpine, 0);
                }
            } else {
                initAlpine();
            }
        }

        // Execute component scripts after render (small delay for the DOM swap)
        if (scripts.length > 0) {
            setTimeout(() => {
                scripts.forEach(script => {
                    if (script.src) {
                        // External script → append to head
                        const scriptEl = document.createElement('script');
                        scriptEl.src = script.src;
                        scriptEl.type = script.type;
                        if (script.async) scriptEl.async = true;
                        if (script.defer) scriptEl.defer = true;
                        document.head.appendChild(scriptEl);
                    } else if (script.content && script.type.trim().toLowerCase() === 'module') {
                        // Once per page, like an external module
                        const seen = Array.from(document.head.querySelectorAll('script[data-component-module]'));
                        if (seen.some(s => s.textContent === script.content)) return;
                        const scriptEl = document.createElement('script');
                        scriptEl.setAttribute('data-component-module', name);
                        scriptEl.type = 'module';
                        scriptEl.textContent = script.content;
                        document.head.appendChild(scriptEl);
                    } else if (script.content) {
                        // Inline script → run in global scope
                        try {
                            const executeScript = new Function(script.content);
                            executeScript();
                        } catch (error) {
                            console.error(`[Manifest] Error executing script in component ${name}:`, error);
                        }
                    }
                });
            }, 0);
        }
    },
    initialize() {
    }
}; 

// Components routing gate
// The router may load before or after this plugin; never capture it once.
window.ManifestComponentsRouting = (function () {
    const ROUTER_SRC = /(^|\/)manifest\.router(\.min)?\.js(\?|#|$)/;
    const LATE_MS = 10000;
    let givenUp = false;
    let settled = null;
    let rerunQueued = false;

    function routerScripts() {
        return Array.from(document.querySelectorAll('script[src]')).filter(s => ROUTER_SRC.test(s.getAttribute('src') || ''));
    }

    // No router yet, but a router script is still to run
    function pending() {
        if (window.ManifestRouting || givenUp) return false;
        return routerScripts().some(s => !s.hasAttribute('data-mnfst-loaded'));
    }

    // Resolves once the router has arrived or is known not to be coming
    function whenSettled() {
        if (!pending()) return Promise.resolve();
        if (settled) return settled;
        settled = new Promise(resolve => {
            const watched = new WeakSet();
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                window.removeEventListener('manifest:routing-ready', check);
                window.removeEventListener('load', onLoad);
                settled = null;
                resolve();
            };
            const watch = () => routerScripts().forEach(s => {
                if (watched.has(s)) return;
                watched.add(s);
                s.addEventListener('load', check);
                s.addEventListener('error', check);
            });
            // A failed CDN tag is swapped for the next one: re-scan a tick later
            function check() { setTimeout(() => { if (pending()) watch(); else finish(); }, 0); }
            // Window load waits for in-flight scripts: a router not here by then isn't coming
            function onLoad() { setTimeout(() => { if (done) return; if (pending()) givenUp = true; finish(); }, 0); }
            watch();
            window.addEventListener('manifest:routing-ready', check);
            // Inserted after load (Manifest.loadPlugin): its own load/error decides, bounded
            if (document.readyState === 'complete') setTimeout(onLoad, LATE_MS);
            else window.addEventListener('load', onLoad);
        });
        return settled;
    }

    // The router's own element matcher; memo is per pass (path fixed)
    function pass(path) {
        const vis = window.ManifestRoutingVisibility;
        const memo = new Map();
        let defined;
        const definedFor = () => {
            if (defined === undefined) defined = vis.routesDefined ? !!vis.routesDefined(path) : undefined;
            return defined;
        };
        return function active(el) {
            let hit = memo.get(el);
            if (hit !== undefined) return hit;
            if (vis && vis.routeMatches) {
                const cond = el.getAttribute('x-route') || '';
                hit = vis.routeMatches(el, path, cond.includes('!*') ? definedFor() : undefined) !== false;
            } else {
                // Router predating the export: its condition matcher, comma list and ! only
                const routing = window.ManifestRouting;
                const conds = (el.getAttribute('x-route') || '').split(',').map(c => c.trim()).filter(Boolean);
                const pos = conds.filter(c => !c.startsWith('!'));
                hit = !conds.some(c => c.startsWith('!') && routing.matchesCondition(path, c.slice(1))) &&
                    (pos.length === 0 || pos.some(c => routing.matchesCondition(path, c)));
            }
            memo.set(el, hit);
            return hit;
        };
    }

    // A route string checked as if on an element (reverts know only the string)
    function matches(xRoute, path) {
        if (!xRoute || !window.ManifestRouting) return true;
        const probe = document.createElement('div');
        probe.setAttribute('x-route', xRoute);
        return pass(path)(probe);
    }

    // One swapping pass once the router settles, for every placeholder deferred meanwhile
    function rerunWhenSettled() {
        if (rerunQueued) return;
        rerunQueued = true;
        whenSettled().then(() => {
            rerunQueued = false;
            const swapping = window.ManifestComponentsSwapping;
            return swapping && swapping.processAll().then(() => {
                window.dispatchEvent(new CustomEvent('manifest:components-processed'));
            });
        });
    }

    // Logical route (router base stripped), as route visibility reads it
    function currentPath() {
        const p = window.ManifestRoutingNavigation?.getCurrentRoute?.() ?? window.location.pathname;
        return p === '/' ? '/' : p.replace(/^\/+|\/+$/g, '');
    }

    // 'swap' | 'skip' | 'defer': own x-route and every x-route ancestor must be active.
    // Reuse one gate(path) across a pass so ancestors are matched once.
    function gate(path) {
        let active = null;
        return function decide(el) {
            let n = el.closest('[x-route]');
            if (!n) return 'swap';
            if (!window.ManifestRouting) {
                if (!pending()) return 'swap';
                rerunWhenSettled();
                return 'defer';
            }
            if (!active) active = pass(path ?? currentPath());
            for (; n; n = n.parentElement && n.parentElement.closest('[x-route]')) {
                if (!active(n)) return 'skip';
            }
            return 'swap';
        };
    }

    const decide = (el, path) => gate(path)(el);

    return { pending, whenSettled, matches, gate, decide, currentPath };
})();


// Components swapping
(function () {
    // Never reset — ids must stay unique for the life of the page so overlapping
    // processAll runs can't mint a colliding id for a live instance.
    let componentInstanceCounters = {};
    const swappedInstances = new Set();
    const instanceRouteMap = new Map();
    const placeholderMap = new Map();

    // Serialises processAll: a call while one is in flight coalesces into a
    // single trailing re-run (latest path wins) instead of interleaving.
    let activeRun = null;
    let trailingRun = null;
    let trailingPath = null;
    let hasTrailing = false;
    let trailingSettlers = null;

    function getComponentInstanceId(name) {
        if (!componentInstanceCounters[name]) componentInstanceCounters[name] = 1;
        else componentInstanceCounters[name]++;
        return `${name}-${componentInstanceCounters[name]}`;
    }

    function logSiblings(parent, context) {
        if (!parent) return;
        const siblings = Array.from(parent.children).map(el => `${el.tagName}[data-component=${el.getAttribute('data-component') || ''}]`).join(', ');
    }

    window.ManifestComponentsSwapping = {
        // Swap in source code for a placeholder
        async swapIn(placeholder) {
            if (placeholder.hasAttribute('data-swapped')) {
                console.debug('[Manifest Components] skipped swapIn: already marked data-swapped', placeholder);
                return;
            }
            const processor = window.ManifestComponentsProcessor;
            if (!processor) {
                console.debug('[Manifest Components] skipped swapIn: processor unavailable', placeholder);
                return;
            }
            const name = placeholder.tagName.toLowerCase().replace('x-', '');
            let instanceId = placeholder.getAttribute('data-component');
            if (!instanceId) {
                instanceId = getComponentInstanceId(name);
                placeholder.setAttribute('data-component', instanceId);
            }
            // Save placeholder for reversion in the map
            if (!placeholderMap.has(instanceId)) {
                const clone = placeholder.cloneNode(true);
                clone.setAttribute('data-original-placeholder', '');
                clone.setAttribute('data-component', instanceId);
                placeholderMap.set(instanceId, clone);
            }
            // Log before swap
            logSiblings(placeholder.parentNode, `Before swapIn for ${instanceId}`);
            // Process and swap in source code, passing instanceId
            await processor.processComponent(placeholder, instanceId);
            swappedInstances.add(instanceId);
            // Track the route for this instance
            const xRoute = placeholder.getAttribute('x-route');
            instanceRouteMap.set(instanceId, xRoute);
            // Log after swap
            logSiblings(placeholder.parentNode || document.body, `After swapIn for ${instanceId}`);
        },
        // Revert to placeholder
        revert(instanceId) {
            if (!swappedInstances.has(instanceId)) {
                console.debug('[Manifest Components] skipped revert: instance not tracked', instanceId);
                return;
            }
            // Remove all elements with data-component=instanceId
            const rendered = Array.from(document.querySelectorAll(`[data-component="${instanceId}"]`));
            if (rendered.length === 0) {
                console.debug('[Manifest Components] skipped revert: no rendered elements found', instanceId);
                return;
            }
            const first = rendered[0];
            const parent = first.parentNode;
            // Retrieve the original placeholder from the map
            const placeholder = placeholderMap.get(instanceId);
            // Log before revert
            logSiblings(parent, `Before revert for ${instanceId}`);
            // Remove all rendered elements
            rendered.forEach(el => {
                el.remove();
            });
            // Restore the placeholder at the correct position if not present
            if (placeholder && parent && !parent.contains(placeholder)) {
                const targetPosition = parseInt(placeholder.getAttribute('data-order')) || 0;
                let inserted = false;

                // Find the correct position based on data-order
                for (let i = 0; i < parent.children.length; i++) {
                    const child = parent.children[i];
                    const childPosition = parseInt(child.getAttribute('data-order')) || 0;

                    if (targetPosition < childPosition) {
                        parent.insertBefore(placeholder, child);
                        inserted = true;
                        break;
                    }
                }

                // If not inserted (should be at the end), append to parent
                if (!inserted) {
                    parent.appendChild(placeholder);
                }

            }
            swappedInstances.delete(instanceId);
            instanceRouteMap.delete(instanceId);
            placeholderMap.delete(instanceId);
            // Log after revert
            logSiblings(parent, `After revert for ${instanceId}`);
        },
        // Main swapping logic — single pass. Call via processAll(), not directly:
        // this has no re-entrancy guard of its own.
        async _runProcessAll(normalizedPathFromEvent) {
            const registry = window.ManifestComponentsRegistry;
            if (!registry) {
                console.debug('[Manifest Components] skipped processAll: registry unavailable');
                return;
            }
            const gate = window.ManifestComponentsRouting;

            // Path from the route-change event, else the router's current route
            const normalizedPath = normalizedPathFromEvent !== null ? normalizedPathFromEvent : gate.currentPath();

            const placeholders = Array.from(document.querySelectorAll('*')).filter(el =>
                el.tagName.toLowerCase().startsWith('x-') &&
                !el.hasAttribute('data-pre-rendered') &&
                !el.hasAttribute('data-processed')
            );
            // First pass: revert any swapped-in instances that no longer match
            if (window.ManifestRouting) {
                for (const instanceId of Array.from(swappedInstances)) {
                    const xRoute = instanceRouteMap.get(instanceId);
                    if (xRoute && !gate.matches(xRoute, normalizedPath)) this.revert(instanceId);
                }
            }
            const decide = gate.gate(normalizedPath);
            // Second pass: swap in matches. Routing is read per placeholder: it may arrive mid-pass.
            for (const placeholder of placeholders) {
                const name = placeholder.tagName.toLowerCase().replace('x-', '');
                let instanceId = placeholder.getAttribute('data-component');
                if (!instanceId) {
                    instanceId = getComponentInstanceId(name);
                    placeholder.setAttribute('data-component', instanceId);
                }
                // 'defer' queues a re-run for when the router settles
                if (decide(placeholder) === 'swap') await this.swapIn(placeholder);
            }
        },
        // Public entry point. Coalesces overlapping calls: while a run is active,
        // later calls don't start their own interleaved run — they queue exactly
        // one trailing re-run (latest path wins) and resolve when it finishes.
        async processAll(normalizedPathFromEvent = null) {
            if (activeRun) {
                hasTrailing = true;
                trailingPath = normalizedPathFromEvent;
                if (!trailingRun) {
                    trailingRun = new Promise((resolve, reject) => {
                        trailingSettlers = { resolve, reject };
                    });
                }
                return trailingRun;
            }
            activeRun = this._runProcessAll(normalizedPathFromEvent);
            let error = null;
            try {
                await activeRun;
            } catch (e) {
                error = e;
            } finally {
                activeRun = null;
            }
            if (hasTrailing) {
                hasTrailing = false;
                const path = trailingPath;
                const settlers = trailingSettlers;
                trailingRun = null;
                trailingSettlers = null;
                trailingPath = null;
                this.processAll(path).then(settlers.resolve, settlers.reject);
            }
            if (error) throw error;
        },
        initialize() {
            // On init, process all
            this.processAll().then(() => {
                // Dispatch event when components are fully processed
                window.dispatchEvent(new CustomEvent('manifest:components-processed'));
            });
            // Only the router dispatches route changes, whenever it arrives
            window.addEventListener('manifest:route-change', (event) => {
                const normalizedPath = event.detail?.normalizedPath || null;
                this.processAll(normalizedPath).then(() => {
                    window.dispatchEvent(new CustomEvent('manifest:components-processed'));
                });
            });
        }
    };
})(); 

// Components mutation observer
// Deferred placeholders are left for swapping's post-router pass.
window.ManifestComponentsMutation = {
    async processAllPlaceholders() {
        const processor = window.ManifestComponentsProcessor;
        const gate = window.ManifestComponentsRouting;
        if (!processor) return;
        const placeholders = Array.from(document.querySelectorAll('*')).filter(el =>
            el.tagName.toLowerCase().startsWith('x-') &&
            !el.hasAttribute('data-pre-rendered') &&
            !el.hasAttribute('data-processed')
        );
        const decide = gate.gate();
        for (const el of placeholders) {
            if (decide(el) !== 'swap') continue;
            await processor.processComponent(el);
        }
    },
    initialize() {
        const processor = window.ManifestComponentsProcessor;
        const gate = window.ManifestComponentsRouting;
        if (!processor) return;
        // Initial scan
        this.processAllPlaceholders();
        const isPlaceholder = el => el.tagName.toLowerCase().startsWith('x-') &&
            !el.hasAttribute('data-pre-rendered') && !el.hasAttribute('data-processed');
        // Mutation observer for new placeholders
        const observer = new MutationObserver(async mutations => {
            const decide = gate.gate();
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (isPlaceholder(node) && decide(node) === 'swap') {
                        await processor.processComponent(node);
                    }
                    // Also check for any <x-*> descendants
                    const descendants = Array.from(node.querySelectorAll('*')).filter(isPlaceholder);
                    for (const el of descendants) {
                        if (decide(el) !== 'swap') continue;
                        await processor.processComponent(el);
                    }
                }
            }
        });

        // Ensure document.body exists before observing
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        } else {
            // Wait for body to be available
            document.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.body, { childList: true, subtree: true });
            });
        }
    }
};


/* Manifest Components — route-level prefetch (batch on route change + on hover) */

(function () {
    'use strict';

    // <x-*> tag pattern — lowercase, hyphenated.
    const TAG_RE = /^x-[a-z][a-z0-9-]*$/;

    // Framework web components (not project components) — skip when scanning.
    const FRAMEWORK_TAGS = new Set(['code', 'code-group']);

    // Anchors already hover-prefetched. WeakSet so detached nodes GC naturally.
    const prefetchedAnchors = new WeakSet();

    function loader() { return window.ManifestComponentsLoader; }

    // Match a route pattern against a normalized pathname. Mirrors router visibility.
    function routeMatches(routeValue, pathname) {
        const pieces = String(routeValue || '').split(',').map((s) => s.trim()).filter(Boolean);
        let matched = false;
        let negated = false;
        for (const piece of pieces) {
            if (piece === '!*') continue; // catch-all only handled by visibility plugin
            if (piece.startsWith('!')) {
                if (piece.slice(1) === pathname) negated = true;
                continue;
            }
            if (piece.startsWith('=')) {
                if (piece.slice(1) === pathname) matched = true;
                continue;
            }
            if (piece.endsWith('/*')) {
                const prefix = piece.slice(0, -2);
                if (pathname === prefix || pathname.startsWith(prefix + '/')) matched = true;
                continue;
            }
            if (piece === pathname) { matched = true; continue; }
            if (pathname.startsWith(piece + '/')) matched = true;
        }
        return matched && !negated;
    }

    function findRouteSubtrees(pathname) {
        const normalized = (pathname || '/') === '/' ? '/' : pathname.replace(/^\/|\/$/g, '');
        const out = [];
        document.querySelectorAll('[x-route]').forEach((el) => {
            const value = el.getAttribute('x-route') || '';
            if (routeMatches(value, normalized)) out.push(el);
        });
        return out;
    }

    function discoverComponentNames(root) {
        const names = new Set();
        if (!root || !root.querySelectorAll) return names;
        // No CSS selector for "tag starts with x-", so scan all and filter in JS.
        root.querySelectorAll('*').forEach((el) => {
            const tag = el.tagName.toLowerCase();
            if (!tag.startsWith('x-') || !TAG_RE.test(tag)) return;
            const name = tag.slice(2);
            if (!FRAMEWORK_TAGS.has(name)) names.add(name);
        });
        return names;
    }

    function prefetchForRoute(pathname) {
        const L = loader();
        if (!L || typeof L.loadComponent !== 'function') return;
        const subtrees = findRouteSubtrees(pathname);
        if (!subtrees.length) return;
        const names = new Set();
        for (const subtree of subtrees) {
            discoverComponentNames(subtree).forEach((n) => names.add(n));
        }
        names.forEach((name) => {
            try { L.loadComponent(name); } catch { /* swallow — dedup is internal */ }
        });
    }

    function hrefToPathname(href) {
        if (!href) return null;
        if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return null;
        try {
            const url = new URL(href, window.location.href);
            if (url.origin !== window.location.origin) return null;
            return url.pathname || '/';
        } catch {
            return null;
        }
    }

    function initialize() {
        // 1) Parallel batch on route change.
        window.addEventListener('manifest:route-change', (event) => {
            const detail = (event && event.detail) || {};
            const path = detail.normalizedPath || detail.to || '/';
            const pathname = String(path).startsWith('/') ? String(path) : '/' + String(path);
            prefetchForRoute(pathname);
        });

        // 2) Hover prefetch. pointerover bubbles (pointerenter doesn't); WeakSet dedups.
        document.addEventListener('pointerover', (e) => {
            if (!e.target || !e.target.closest) return;
            const a = e.target.closest('a[href]');
            if (!a || prefetchedAnchors.has(a)) return;
            // Author opt-out: `data-no-prefetch` skips this anchor.
            if (a.hasAttribute('data-no-prefetch')) return;
            const href = a.getAttribute('href');
            const pathname = hrefToPathname(href);
            if (!pathname) return;
            prefetchedAnchors.add(a);
            prefetchForRoute(pathname);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();


// Main initialization for Manifest Components
async function initializeComponents() {
    // Registry.initialize() may fetch manifest.json (async) when the loader
    // hasn't cached it yet; await it so the steps below see registry.manifest.
    if (window.ManifestComponentsRegistry) await window.ManifestComponentsRegistry.initialize();
    if (window.ManifestComponentsLoader) window.ManifestComponentsLoader.initialize();
    if (window.ManifestComponentsProcessor) window.ManifestComponentsProcessor.initialize();
    if (window.ManifestComponentsSwapping) window.ManifestComponentsSwapping.initialize();
    if (window.ManifestComponentsMutation) window.ManifestComponentsMutation.initialize();
    if (window.ManifestComponentsUtils) window.ManifestComponentsUtils.initialize?.();
    window.__manifestComponentsInitialized = true;
    window.dispatchEvent(new CustomEvent('manifest:components-ready'));
}

// When data plugin is loaded: wait for manifest:data-ready so $x.content is ready before components render.
// When data plugin is absent: init immediately (no artificial delay).
function waitForDataThenInitialize() {
    const hasDataPlugin = typeof window.ManifestDataConfig !== 'undefined';

    if (!hasDataPlugin) {
        initializeComponents();
        return;
    }

    window.addEventListener('manifest:data-ready', () => {
        initializeComponents();
    }, { once: true });

    // Fallback: if data plugin never fires (e.g. slow network, error), initialize anyway
    const fallbackMs = 5000;
    setTimeout(() => {
        if (!window.__manifestComponentsInitialized) {
            initializeComponents();
        }
    }, fallbackMs);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForDataThenInitialize);
} else {
    waitForDataThenInitialize();
}

window.ManifestComponents = {
    initialize: initializeComponents
};

})();
