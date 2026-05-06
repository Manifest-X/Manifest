/* Manifest Components */

// Base URL for manifest-relative paths (e.g. "../" when viewing dist/index.html). Used by component loader, data loaders, localization.
window.getManifestBase = function getManifestBase() {
    const href = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
    const lastSlash = href.lastIndexOf('/');
    return lastSlash >= 0 ? href.slice(0, lastSlash + 1) : '/';
};

// Absolute pathname prefix for the app root (e.g. "/src/dist"). Used by router for links and route matching.
// Prerender injects <meta name="manifest:router-base" content="/path"> from manifest.prerender.routerBase or root+output. If present, use it; else fall back to depth or manifest link.
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
    initialize() {
        // Use loader-provided manifest if set; otherwise load synchronously (standalone)
        let manifest = window.__manifestLoaded || this.manifest;
        if (!manifest) {
            try {
                const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
                const req = new XMLHttpRequest();
                req.open('GET', manifestUrl + (manifestUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), false);
                req.setRequestHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                req.setRequestHeader('Pragma', 'no-cache');
                req.setRequestHeader('Expires', '0');
                req.send(null);
                if (req.status === 200) {
                    manifest = JSON.parse(req.responseText);
                } else {
                    console.warn('[Manifest] Failed to load manifest.json (HTTP', req.status + ')');
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
    initialize() {
        this.cache = {};
        this._loading = {};
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
        if (!registry || !registry.manifest) {
            console.warn('[Manifest] Manifest not loaded, cannot load component:', name);
            return null;
        }
        const path = (registry.manifest.preloadedComponents || []).concat(registry.manifest.components || [])
            .find(p => p.split('/').pop().replace('.html', '') === name);
        if (!path) {
            console.warn('[Manifest] Component', name, 'not found in manifest.');
            return null;
        }
        const base = (typeof window.getManifestBase === 'function' ? window.getManifestBase() : '') || '/';
        const url = path.startsWith('/') || path.startsWith('http') ? path : base + path;
        const promise = (async () => {
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    console.warn('[Manifest] HTML file not found for component', name, 'at path:', path, '(HTTP', response.status + ')');
                    return null;
                }
                const content = await response.text();
                this.cache[name] = content;
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
window.ManifestComponentsProcessor = {
    async processComponent(element, instanceId) {
        const name = element.tagName.toLowerCase().replace('x-', '');
        const registry = window.ManifestComponentsRegistry;
        const loader = window.ManifestComponentsLoader;
        if (!registry || !loader) {
            return;
        }
        if (!registry.registered.has(name)) {
            return;
        }
        if (element.hasAttribute('data-pre-rendered') || element.hasAttribute('data-processed')) {
            // Pre-rendered components skip re-fetching, but hydrate-marked content
            // still needs Alpine initialization (x-data, @click, :class, x-theme etc.).
            if (element.hasAttribute('data-pre-rendered') && window.Alpine && typeof window.Alpine.initTree === 'function') {
                try { window.Alpine.initTree(element); } catch (e) { /* graceful */ }
            }
            return;
        }
        const content = await loader.loadComponent(name);
        if (!content) {
            element.replaceWith(document.createComment(` Failed to load component: ${name} `));
            return;
        }
        const container = document.createElement('div');
        container.innerHTML = content.trim();
        const topLevelElements = Array.from(container.children);
        if (topLevelElements.length === 0) {
            element.replaceWith(document.createComment(` Empty component: ${name} `));
            return;
        }

        // Extract and prepare scripts for execution
        const scripts = [];
        const processScripts = (el) => {
            if (el.tagName.toLowerCase() === 'script') {
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
        // Collect properties from placeholder attributes
        const props = {};
        Array.from(element.attributes).forEach(attr => {
            if (attr.name !== name && attr.name !== 'class' && !attr.name.startsWith('data-')) {
                // Store both original case and lowercase for flexibility
                props[attr.name] = attr.value;
                props[attr.name.toLowerCase()] = attr.value;
                // For Alpine bindings (starting with :), also store without the : prefix
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
                                        // If value starts with $, it's an Alpine expression - don't quote
                                        if (val.startsWith('$')) {
                                            // Special handling for x-for, x-if, and x-show with $x data source expressions
                                            // Add safe fallbacks to prevent errors during initial render when data source hasn't loaded yet
                                            if ((attr.name === 'x-for' || attr.name === 'x-if' || attr.name === 'x-show') && val.startsWith('$x') && !val.includes('??')) {
                                                // Convert regular property access dots to optional chaining for safe navigation
                                                let safeVal = val.replace(/\./g, '?.');
                                                // Add fallback based on directive type (only if user hasn't already provided one)
                                                if (attr.name === 'x-for') {
                                                    // x-for needs an iterable, so fallback to empty array
                                                    return `${safeVal} ?? []`;
                                                } else {
                                                    // x-if and x-show evaluate to boolean, fallback to false
                                                    return `${safeVal} ?? false`;
                                                }
                                            }
                                            return val;
                                        }
                                        // Special handling for x-for, x-if, and x-show - these can contain expressions
                                        // that reference data sources or other dynamic content
                                        if (attr.name === 'x-for' || attr.name === 'x-if' || attr.name === 'x-show') {
                                            // For these directives, preserve the value as-is to allow Alpine to evaluate it
                                            // This is critical for x-for expressions like "card in $x.data.items"
                                            return val;
                                        }
                                        // Always quote string values to ensure they're treated as strings, not variables
                                        return `'${val.replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`;
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
                                        const quotedValue = `'${propValue.replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`;
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
            // Set data-component=instanceId if provided
            if (instanceId) {
                rootElement.setAttribute('data-component', instanceId);
            }
        });
        // After rendering, copy all attributes from the original placeholder to the first top-level element
        // Note: This block ensures the first element has all attributes, including those that might have been
        // skipped by the first loop due to conditions. Classes are already handled in the first loop, so we skip them here.
        if (topLevelElements.length > 0) {
            const firstRoot = topLevelElements[0];
            Array.from(element.attributes).forEach(attr => {
                // Skip attributes that were already handled in the first loop
                // Classes are always handled in the first loop, so skip them here to avoid duplication
                if (attr.name === 'class') {
                    return; // Skip - already handled in first loop
                }

                // Preserve important attributes including data-order, x-route, and other routing/data attributes
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

                // Only apply if: (1) it wasn't handled in first loop, OR (2) it should be preserved, AND (3) it's not in the skip list
                if ((!alreadyHandledInFirstLoop || shouldPreserve) &&
                    !['data-original-placeholder', 'data-pre-rendered', 'data-processed'].includes(attr.name)) {
                    if (attr.name.startsWith('x-') || attr.name.startsWith(':') || attr.name.startsWith('@')) {
                        // For Alpine directives, merge if they already exist (for x-data, combine objects)
                        if (attr.name === 'x-data' && firstRoot.hasAttribute('x-data')) {
                            // For x-data, we need to merge the objects - this is complex, so for now we'll append
                            // The user should structure their x-data to avoid conflicts
                            const existing = firstRoot.getAttribute('x-data');
                            // If both are objects, try to merge them
                            if (existing.trim().startsWith('{') && attr.value.trim().startsWith('{')) {
                                // Remove outer braces and merge
                                const existingContent = existing.trim().slice(1, -1).trim();
                                const newContent = attr.value.trim().slice(1, -1).trim();
                                const merged = `{ ${existingContent}${existingContent && newContent ? ', ' : ''}${newContent} }`;
                                firstRoot.setAttribute('x-data', merged);
                            } else {
                                // If not both objects, replace (user should handle this case)
                                firstRoot.setAttribute(attr.name, attr.value);
                            }
                        } else {
                            // For other Alpine directives, replace if they exist
                            firstRoot.setAttribute(attr.name, attr.value);
                        }
                    } else {
                        // For other attributes, replace if they exist
                        firstRoot.setAttribute(attr.name, attr.value);
                    }
                }
            });
        }
        const parent = element.parentElement;
        if (!parent || !document.contains(element)) {
            return;
        }
        // Replace the placeholder element with the component content
        const fragment = document.createDocumentFragment();
        topLevelElements.forEach(el => fragment.appendChild(el));

        // Replace the placeholder element with the component content
        // Alpine will auto-initialize on DOM insertion, but we need to ensure
        // magic methods are ready first. If data plugin is ready, give it a tick
        // to ensure Alpine has processed the magic method registration.
        parent.replaceChild(fragment, element);

        // Manually initialize Alpine on the swapped-in elements after ensuring
        // magic methods are available. This prevents "i is not a function" errors.
        if (window.Alpine && typeof window.Alpine.initTree === 'function') {
            const initAlpine = () => {
                // CRITICAL: Ensure auth convenience methods are initialized before Alpine evaluates expressions
                // This prevents "$auth.isCreatingTeam is not a function" errors after idle/reinitialization
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

                // Re-initialize Alpine on the swapped elements
                // This ensures magic methods are available when expressions are evaluated
                topLevelElements.forEach(el => {
                    if (!el.__x) { // Only init if not already initialized
                        try {
                            window.Alpine.initTree(el);
                        } catch (e) {
                            console.error(`[Manifest Components] Error initializing Alpine for component "${name}":`, e);
                        }
                    }
                });
            };

            // If data plugin is ready, wait a tick to ensure magic method is processed
            if (window.__manifestDataMagicRegistered) {
                if (window.Alpine.nextTick) {
                    window.Alpine.nextTick(initAlpine);
                } else {
                    setTimeout(initAlpine, 0);
                }
            } else {
                // Data plugin not ready, initialize immediately (will fail gracefully)
                initAlpine();
            }
        }

        // Execute scripts after component is rendered
        if (scripts.length > 0) {
            // Use a small delay to ensure DOM is updated
            setTimeout(() => {
                scripts.forEach(script => {
                    if (script.src) {
                        // External script - create and append to head
                        const scriptEl = document.createElement('script');
                        scriptEl.src = script.src;
                        scriptEl.type = script.type;
                        if (script.async) scriptEl.async = true;
                        if (script.defer) scriptEl.defer = true;
                        document.head.appendChild(scriptEl);
                    } else if (script.content) {
                        // Inline script - execute directly
                        try {
                            // Create a function to execute the script in the global scope
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

// Components swapping
(function () {
    let componentInstanceCounters = {};
    const swappedInstances = new Set();
    const instanceRouteMap = new Map();
    const placeholderMap = new Map();

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
            if (placeholder.hasAttribute('data-swapped')) return;
            const processor = window.ManifestComponentsProcessor;
            if (!processor) return;
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
            if (!swappedInstances.has(instanceId)) return;
            // Remove all elements with data-component=instanceId
            const rendered = Array.from(document.querySelectorAll(`[data-component="${instanceId}"]`));
            if (rendered.length === 0) return;
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
        // Main swapping logic
        async processAll(normalizedPathFromEvent = null) {
            componentInstanceCounters = {};
            const registry = window.ManifestComponentsRegistry;
            if (!registry) return;
            const routing = window.ManifestRouting;

            // Use normalized path from event if provided, otherwise compute from window.location
            let normalizedPath;
            if (normalizedPathFromEvent !== null) {
                normalizedPath = normalizedPathFromEvent;
            } else {
                const currentPath = window.location.pathname;
                normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');
            }

            const placeholders = Array.from(document.querySelectorAll('*')).filter(el =>
                el.tagName.toLowerCase().startsWith('x-') &&
                !el.hasAttribute('data-pre-rendered') &&
                !el.hasAttribute('data-processed')
            );
            // First pass: revert any swapped-in instances that no longer match
            if (routing) {
                for (const instanceId of Array.from(swappedInstances)) {
                    const xRoute = instanceRouteMap.get(instanceId);
                    if (!xRoute) {
                        // No route condition means always visible, don't revert
                        continue;
                    }
                    // Parse route conditions the same way as route visibility
                    const conditions = xRoute.split(',').map(cond => cond.trim());
                    const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
                    const negativeConditions = conditions
                        .filter(cond => cond.startsWith('!'))
                        .map(cond => cond.slice(1));

                    const hasNegativeMatch = negativeConditions.some(cond =>
                        window.ManifestRouting.matchesCondition(normalizedPath, cond)
                    );
                    const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond =>
                        window.ManifestRouting.matchesCondition(normalizedPath, cond)
                    );

                    const matches = hasPositiveMatch && !hasNegativeMatch;
                    if (!matches) {
                        this.revert(instanceId);
                    }
                }
            }
            // Second pass: swap in any placeholders that match
            for (const placeholder of placeholders) {
                const name = placeholder.tagName.toLowerCase().replace('x-', '');
                let instanceId = placeholder.getAttribute('data-component');
                if (!instanceId) {
                    instanceId = getComponentInstanceId(name);
                    placeholder.setAttribute('data-component', instanceId);
                }
                const xRoute = placeholder.getAttribute('x-route');
                if (!routing) {
                    // No routing: always swap in
                    await this.swapIn(placeholder);
                } else {
                    // Routing present: check route using same logic as route visibility
                    // Handle comma-separated route conditions (e.g., "/,page-1,page-2")
                    let matches = !xRoute;
                    if (xRoute) {
                        const conditions = xRoute.split(',').map(cond => cond.trim());
                        const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
                        const negativeConditions = conditions
                            .filter(cond => cond.startsWith('!'))
                            .map(cond => cond.slice(1));

                        // Check negative conditions first
                        const hasNegativeMatch = negativeConditions.some(cond =>
                            window.ManifestRouting.matchesCondition(normalizedPath, cond)
                        );

                        // Check positive conditions
                        const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond =>
                            window.ManifestRouting.matchesCondition(normalizedPath, cond)
                        );

                        matches = hasPositiveMatch && !hasNegativeMatch;
                    }

                    if (matches) {
                        await this.swapIn(placeholder);
                    }
                }
            }
        },
        initialize() {
            // On init, process all
            this.processAll().then(() => {
                // Dispatch event when components are fully processed
                window.dispatchEvent(new CustomEvent('manifest:components-processed'));
            });
            // If routing is present, listen for route changes
            if (window.ManifestRouting) {
                window.addEventListener('manifest:route-change', (event) => {
                    // Use normalized path from event detail if available
                    const normalizedPath = event.detail?.normalizedPath || null;
                    this.processAll(normalizedPath).then(() => {
                        // Dispatch event when components are fully processed after route change
                        window.dispatchEvent(new CustomEvent('manifest:components-processed'));
                    });
                });
            }
        }
    };
})(); 

// Components mutation observer
window.ManifestComponentsMutation = {
    async processAllPlaceholders() {
        const processor = window.ManifestComponentsProcessor;
        const routing = window.ManifestRouting;
        if (!processor) return;
        const placeholders = Array.from(document.querySelectorAll('*')).filter(el =>
            el.tagName.toLowerCase().startsWith('x-') &&
            !el.hasAttribute('data-pre-rendered') &&
            !el.hasAttribute('data-processed')
        );
        for (const el of placeholders) {
            if (routing) {
                // Only process if route matches
                const xRoute = el.getAttribute('x-route');
                const currentPath = window.location.pathname;
                const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/+|\/+$/g, '');
                const matches = !xRoute || window.ManifestRouting.matchesCondition(normalizedPath, xRoute);
                if (!matches) continue;
            }
            await processor.processComponent(el);
        }
    },
    initialize() {
        const processor = window.ManifestComponentsProcessor;
        const routing = window.ManifestRouting;
        if (!processor) return;
        // Initial scan
        this.processAllPlaceholders();
        // Mutation observer for new placeholders
        const observer = new MutationObserver(async mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1 && node.tagName.toLowerCase().startsWith('x-')) {
                        if (!node.hasAttribute('data-pre-rendered') && !node.hasAttribute('data-processed')) {
                            if (routing) {
                                const xRoute = node.getAttribute('x-route');
                                const currentPath = window.location.pathname;
                                const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/+|\/+$/g, '');
                                const matches = !xRoute || window.ManifestRouting.matchesCondition(normalizedPath, xRoute);
                                if (!matches) continue;
                            }
                            await processor.processComponent(node);
                        }
                    }
                    // Also check for any <x-*> descendants
                    if (node.nodeType === 1) {
                        const descendants = Array.from(node.querySelectorAll('*')).filter(el =>
                            el.tagName.toLowerCase().startsWith('x-') &&
                            !el.hasAttribute('data-pre-rendered') &&
                            !el.hasAttribute('data-processed')
                        );
                        for (const el of descendants) {
                            if (routing) {
                                const xRoute = el.getAttribute('x-route');
                                const currentPath = window.location.pathname;
                                const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/+|\/+$/g, '');
                                const matches = !xRoute || window.ManifestRouting.matchesCondition(normalizedPath, xRoute);
                                if (!matches) continue;
                            }
                            await processor.processComponent(el);
                        }
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

// Main initialization for Manifest Components
function initializeComponents() {
    if (window.ManifestComponentsRegistry) window.ManifestComponentsRegistry.initialize();
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