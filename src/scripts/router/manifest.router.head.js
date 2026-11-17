// Router head

// Prerendered MPA output has route head content baked in
function headIsPrerenderedMPA() {
    try {
        return document.querySelector('meta[name="manifest:prerendered"][content="1"]') !== null;
    } catch (e) {
        return false;
    }
}

// Check if an element should be visible based on route conditions
function shouldElementBeVisible(element, normalizedPath) {

    // Check if element has x-route attribute
    if (element.hasAttribute('x-route')) {
        const routeCondition = element.getAttribute('x-route');

        if (routeCondition) {
            const conditions = routeCondition.split(',').map(cond => cond.trim());
            const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
            const negativeConditions = conditions
                .filter(cond => cond.startsWith('!'))
                .map(cond => cond.slice(1));

            const hasNegativeMatch = negativeConditions.some(cond => {
                const matches = window.ManifestRouting.matchesCondition(normalizedPath, cond);
                return matches;
            });

            const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond => {
                const matches = window.ManifestRouting.matchesCondition(normalizedPath, cond);
                return matches;
            });

            const result = hasPositiveMatch && !hasNegativeMatch;
            return result;
        }
    }

    // Check parent elements for x-route
    const parentWithRoute = element.closest('[x-route]');
    if (parentWithRoute) {
        return shouldElementBeVisible(parentWithRoute, normalizedPath);
    }

    // If no route conditions, element is visible
    return true;
}

// Resolve :attr and x-bind:attr whose value is $x.path so injected meta/link have real content (SPA + prerender).
function resolveDataHeadBindings(element) {
    const x = typeof window !== 'undefined' && window.$x;
    if (!x) return;
    const toResolve = [];
    for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        const name = attr.name;
        let bindingAttr = null;
        if (name.startsWith(':')) bindingAttr = name.slice(1);
        else if (name.startsWith('x-bind:')) bindingAttr = name.slice(7);
        if (!bindingAttr) continue;
        const expr = (attr.value || '').trim();
        if (!expr.startsWith('$x.')) continue;
        const path = expr.slice(3).trim();
        if (!path) continue;
        toResolve.push({ bindingName: attr.name, attrName: bindingAttr, path });
    }
    for (const { bindingName, attrName, path } of toResolve) {
        let value;
        try {
            value = path.split('.').reduce(function (obj, key) {
                return obj != null && typeof obj === 'object' ? obj[key] : undefined;
            }, x);
        } catch (e) {
            continue;
        }
        if (value === undefined) continue;
        element.setAttribute(attrName, String(value));
        element.removeAttribute(bindingName);
    }
}

// Template id → head elements it owns (attached or superseded)
const injectedHead = new Map();
const templateHeadIds = new WeakMap();
const usedHeadIds = new Set();
// Static index.html tags set aside while a route provides their identity → { key, next }
const supersededStatic = new Map();
let headIdCounter = 0;

// Stable per-template id, so leaving a route finds what it injected
function generateHeadId(template, host) {
    if (templateHeadIds.has(template)) return templateHeadIds.get(template);
    const order = host && host.getAttribute('data-order');
    const componentId = host && host.getAttribute('data-component-id');
    let id = order ? `head-${order}` : componentId ? `head-${componentId}` : '';
    if (!id || usedHeadIds.has(id)) {
        do { id = `head-${++headIdCounter}`; } while (usedHeadIds.has(id));
    }
    usedHeadIds.add(id);
    templateHeadIds.set(template, id);
    return id;
}

// Tags that replace each other by identity
function headIdentity(el) {
    const tag = el.tagName;
    if (tag === 'TITLE') return 'title';
    if (tag === 'META') {
        const name = el.getAttribute('name');
        if (name) return `meta:name:${name.toLowerCase()}|${el.getAttribute('media') || ''}`;
        const prop = el.getAttribute('property');
        if (prop) return `meta:property:${prop.toLowerCase()}`;
        return null;
    }
    if (tag === 'LINK' && (el.getAttribute('rel') || '').toLowerCase() === 'canonical') return 'link:canonical';
    return null;
}

// Route host for a non-component template
function headTemplateHost(template) {
    let element = template.closest('[data-order], [data-component-id], [x-route]');
    if (!element || element === template) {
        if (template.hasAttribute('data-order') || template.hasAttribute('data-component') || template.hasAttribute('x-route')) {
            element = template;
        } else {
            element = template.parentElement;
        }
    }
    return element;
}

function headTemplateIsActive(template, host, normalizedPath) {
    if (template.hasAttribute('data-component')) {
        const componentRoute = template.getAttribute('x-route');
        if (componentRoute) return window.ManifestRouting.matchesCondition(normalizedPath, componentRoute);
        // Rendered component without its own route: active while connected under active routes
        return template.isConnected && shouldElementBeVisible(template, normalizedPath);
    }
    return host ? shouldElementBeVisible(host, normalizedPath) : true;
}

function createHeadElements(template, headId) {
    const created = [];
    Array.from(template.content.children).forEach(child => {
        let el;
        if (child.tagName === 'SCRIPT') {
            // Fresh script so it executes; keep src/type/async/nonce etc.
            el = document.createElement('script');
            for (const attr of child.attributes) el.setAttribute(attr.name, attr.value);
            if (child.textContent) el.textContent = child.textContent;
        } else {
            el = child.cloneNode(true);
            resolveDataHeadBindings(el);
        }
        el.setAttribute('data-route-head', headId);
        document.head.appendChild(el);
        created.push(el);
    });
    return created;
}

// Route element a template answers to, for nesting comparisons
function headRouteHost(template, host) {
    const base = host || template;
    return (base.closest && base.closest('[x-route]')) || base;
}

// Later candidate wins, unless the current owner's route is nested inside it
function headOutranks(candidate, current, routeHosts) {
    const a = routeHosts.get(candidate), b = routeHosts.get(current);
    if (a && b && a !== b && a.contains(b)) return false;
    return true;
}

// Per identity, the winning active template keeps all its tags for it (og:image ×2,
// theme-color by media…); static tags of that identity step aside as a group
function applyHeadIdentities(activeIds, routeHosts) {
    const owner = new Map();
    for (const id of activeIds) {
        const keys = new Set();
        for (const el of injectedHead.get(id) || []) {
            const key = headIdentity(el);
            if (key) keys.add(key);
        }
        for (const key of keys) {
            if (!owner.has(key) || headOutranks(id, owner.get(key), routeHosts)) owner.set(key, id);
        }
    }
    for (const id of activeIds) {
        for (const el of injectedHead.get(id) || []) {
            const key = headIdentity(el);
            if (!key) continue;
            if (owner.get(key) === id) {
                if (!el.isConnected) document.head.appendChild(el);
            } else if (el.isConnected) {
                el.remove();
            }
        }
    }
    // Remember each static tag's place by the next sibling that stays, so a group restores in order
    const aside = Array.from(document.head.children).filter(el => {
        if (el.hasAttribute('data-route-head') || supersededStatic.has(el)) return false;
        const key = headIdentity(el);
        return !!key && owner.has(key);
    });
    const asideSet = new Set(aside);
    for (const el of aside) {
        let next = el.nextElementSibling;
        while (next && asideSet.has(next)) next = next.nextElementSibling;
        supersededStatic.set(el, { key: headIdentity(el), next });
    }
    aside.forEach(el => el.remove());
    // A tag of the same identity added meanwhile takes the set-aside one's place
    const taken = new Set();
    for (const el of Array.from(document.head.children)) {
        if (!el.hasAttribute('data-route-head')) taken.add(headIdentity(el));
    }
    for (const [el, { key, next }] of supersededStatic) {
        if (owner.has(key)) continue;
        supersededStatic.delete(el);
        if (el.isConnected || taken.has(key)) continue;
        if (next && next.parentNode === document.head) document.head.insertBefore(el, next);
        else document.head.appendChild(el);
    }
}

// Sync document.head with the route's active <template data-head> blocks
function processAllHeadContent(normalizedPath) {
    if (headIsPrerenderedMPA()) return;

    const activeIds = [];
    const active = new Map();
    const routeHosts = new Map();
    document.querySelectorAll('template[data-head]').forEach(template => {
        const host = template.hasAttribute('data-component') ? template : headTemplateHost(template);
        if (!headTemplateIsActive(template, host, normalizedPath)) return;
        const headId = generateHeadId(template, host);
        if (active.has(headId)) return;
        active.set(headId, template);
        routeHosts.set(headId, headRouteHost(template, host));
        activeIds.push(headId);
    });

    for (const [id, els] of injectedHead) {
        if (active.has(id)) continue;
        els.forEach(el => el.remove());
        injectedHead.delete(id);
    }
    document.head.querySelectorAll('[data-route-head]').forEach(el => {
        if (!active.has(el.getAttribute('data-route-head'))) el.remove();
    });

    for (const id of activeIds) {
        if (injectedHead.has(id)) continue;
        const existing = Array.from(document.head.querySelectorAll(`[data-route-head="${id}"]`));
        injectedHead.set(id, existing.length ? existing : createHeadElements(active.get(id), id));
    }

    applyHeadIdentities(activeIds, routeHosts);
}

// Single-template entry point (kept for the public interface)
function processElementHeadContent(element, normalizedPath) {
    processAllHeadContent(normalizedPath);
}

// Initialize head content management
function initializeHeadContent() {
    // Wait for components to be ready before processing head content
    function processHeadContentAfterComponentsReady() {
        // Process initial head content after a longer delay to let components settle
        setTimeout(() => {
            if (headIsPrerenderedMPA()) return;
            const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
            const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');

            processAllHeadContent(normalizedPath);
        }, 200);
    }

    // Function to process head content immediately (for projects without components)
    function processHeadContentImmediately() {
        if (headIsPrerenderedMPA()) return;
        const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
        const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');
        processAllHeadContent(normalizedPath);
    }

    // Check if components system exists
    if (window.ManifestComponents) {
        // Components system exists - wait for it to be fully processed
        if (window.__manifestComponentsInitialized) {
            // Components are initialized, but we need to wait for them to be processed
            // Check if components have already been processed
            if (document.querySelector('[data-component]')) {
                processHeadContentAfterComponentsReady();
            } else {
                // Wait for components to be processed
                window.addEventListener('manifest:components-processed', processHeadContentAfterComponentsReady);
            }
        } else {
            // Wait for components to be ready, then wait for them to be processed
            window.addEventListener('manifest:components-ready', () => {
                window.addEventListener('manifest:components-processed', processHeadContentAfterComponentsReady);
            });
        }
    } else {
        // No components system - process immediately
        processHeadContentImmediately();
    }

    // Listen for route changes - process immediately after components are ready
    window.addEventListener('manifest:route-change', (event) => {

        // Wait a bit for components to settle after route change
        setTimeout(() => {
            if (headIsPrerenderedMPA()) return;
            // Process head content immediately to catch components before they're reverted
            const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
            const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');

            processAllHeadContent(normalizedPath);
        }, 100);
    });
}

// Run immediately if DOM is ready, otherwise wait
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeHeadContent);
} else {
    initializeHeadContent();
}

// Export head content interface
window.ManifestRoutingHead = {
    initialize: initializeHeadContent,
    processElementHeadContent,
    processAllHeadContent
}; 