/* Manifest Router */

// Main routing initialization
function initializeRouting() {

    // Mark as initialized
    window.__manifestRoutingInitialized = true;
    window.dispatchEvent(new CustomEvent('manifest:routing-ready'));

}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeRouting);
} else {
    initializeRouting();
}

// Export main routing interface
window.ManifestRouting = {
    initialize: initializeRouting,
    // Route matching utility
    matchesCondition: (path, condition) => {
        // Normalize path consistently - keep '/' as '/' for home route
        const normalizedPath = path === '/' ? '/' : path.replace(/^\/+|\/+$/g, '') || '/';

        // Get localization codes from manifest
        const localizationCodes = [];
        try {
            const manifest = window.ManifestComponentsRegistry?.manifest || window.manifest;
            if (manifest && manifest.data) {
                Object.values(manifest.data).forEach(dataSource => {
                    if (typeof dataSource === 'object' && dataSource !== null) {
                        Object.keys(dataSource).forEach(key => {
                            if (key.match(/^[a-z]{2}(-[A-Z]{2})?$/)) {
                                localizationCodes.push(key);
                            }
                        });
                    }
                });
            }
        } catch (e) {
            // Ignore errors if manifest is not available
        }

        // Check if path starts with a localization code
        let pathToCheck = normalizedPath;
        if (localizationCodes.length > 0) {
            const pathSegments = normalizedPath.split('/').filter(segment => segment);
            if (pathSegments.length > 0 && localizationCodes.includes(pathSegments[0])) {
                // Remove the localization code and check the remaining path
                pathToCheck = pathSegments.slice(1).join('/') || '/';
            }
        }

        // Handle wildcards
        if (condition.includes('*')) {
            if (condition === '*') return true;
            const wildcardPattern = condition.replace('*', '');
            const normalizedPattern = wildcardPattern.replace(/^\/+|\/+$/g, '');
            return pathToCheck.startsWith(normalizedPattern + '/');
        }

        // Handle exact matches (starting with =) - after localization processing
        if (condition.startsWith('=')) {
            const exactPath = condition.slice(1);
            if (exactPath === '/') {
                return pathToCheck === '/' || pathToCheck === '';
            }
            const normalizedExactPath = exactPath.replace(/^\/+|\/+$/g, '');
            return pathToCheck === normalizedExactPath;
        }

        // Handle exact paths (starting with /)
        if (condition.startsWith('/')) {
            if (condition === '/') {
                return pathToCheck === '/' || pathToCheck === '';
            }
            const routePath = condition.replace(/^\//, '');
            return pathToCheck === routePath || pathToCheck.startsWith(routePath + '/');
        }

        // Handle substring matching (default behavior)
        return pathToCheck.includes(condition);
    }
};


// Router position

// Capture initial body order from index.html
function captureBodyOrder() {
    if (window.__manifestBodyOrder) return; // Already captured

    try {
        const req = new XMLHttpRequest();
        req.open('GET', '/index.html', false);
        req.send(null);
        if (req.status === 200) {
            let html = req.responseText;

            // Handle self-closing tags if components plugin isn't available
            if (!window.ManifestComponents) {
                html = html.replace(/<x-([a-z0-9-]+)([^>]*)\s*\/?>/gi, (match, tag, attrs) => `<x-${tag}${attrs}></x-${tag}>`);
            }

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const bodyChildren = Array.from(doc.body.children);

            window.__manifestBodyOrder = bodyChildren.map((el, index) => ({
                index,
                tag: el.tagName.toLowerCase().trim(),
                isComponent: el.tagName.toLowerCase().startsWith('x-'),
                attrs: Array.from(el.attributes).map(attr => [attr.name, attr.value]),
                key: el.getAttribute('data-component-id') || (el.tagName.toLowerCase().startsWith('x-') ? el.tagName.toLowerCase().replace('x-', '').trim() : null),
                position: index,
                content: el.tagName.toLowerCase().startsWith('x-') ? null : el.innerHTML
            }));
        }
    } catch (e) {
        // Failed to load index.html for body order snapshot
    }
}

// Assign data-order attributes to all top-level elements
function assignDataPositions() {
    if (!document.body) return;

    const bodyChildren = Array.from(document.body.children);

    bodyChildren.forEach((element, index) => {
        element.setAttribute('data-order', index.toString());
    });
}

// Initialize position management
function initializePositionManagement() {
    // Capture body order first
    captureBodyOrder();

    // Assign data-order attributes
    assignDataPositions();
}

// Run immediately if DOM is ready, otherwise wait
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializePositionManagement);
} else {
    initializePositionManagement();
}

// Export position management interface
window.ManifestRoutingPosition = {
    initialize: initializePositionManagement,
    captureBodyOrder,
    assignDataPositions
}; 

// Router navigation

// Current route state (logical path, e.g. /gadget; not full pathname when app is in a subpath)
let currentRoute = '/';
let isInternalNavigation = false;

function isPrerenderedStaticBuild() {
    // When prerendered HTML is served as static pages, prefer normal browser navigation (MPA)
    // so each URL loads its own prerendered HTML rather than SPA toggling.
    const prerendered = document.querySelector('meta[name="manifest:prerendered"]');
    const val = (prerendered?.getAttribute('content') || '').trim().toLowerCase();
    if (prerendered && val !== '0' && val !== 'false') return true;
    // Backstop: prerender writes this per-page depth marker.
    return !!document.querySelector('meta[name="manifest:router-base-depth"]');
}

function getBasePath() {
    return (typeof window.getManifestBasePath === 'function' ? window.getManifestBasePath() : '') || '';
}

// Locale codes from manifest data (same idea as ManifestRouting.matchesCondition).
function getLocalizationCodesFromManifest() {
    const localizationCodes = [];
    try {
        const manifest = window.ManifestComponentsRegistry?.manifest || window.manifest;
        if (manifest?.data && typeof manifest.data === 'object') {
            Object.values(manifest.data).forEach((dataSource) => {
                if (typeof dataSource === 'object' && dataSource !== null) {
                    Object.keys(dataSource).forEach((key) => {
                        if (key.match(/^[a-z]{2}(-[A-Z]{2})?$/)) {
                            localizationCodes.push(key);
                        }
                    });
                }
            });
        }
    } catch {
        /* ignore */
    }
    return [...new Set(localizationCodes)];
}

function logicalSegmentsFromPathname(pathname) {
    const logical = pathnameToLogical(pathname);
    const s = logical.replace(/^\/+|\/+$/g, '');
    return s ? s.split('/') : [];
}

const STICKY_LOCALE_SKIP_FIRST_SEGMENTS = new Set([
    'api',
    'assets',
    'static',
    'public',
    'dist',
    'icons',
    'fonts',
    'media',
    '.well-known',
]);

const STICKY_LOCALE_STATIC_FILE_EXT = new Set([
    'js', 'mjs', 'cjs', 'css', 'map', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico',
    'woff', 'woff2', 'ttf', 'eot', 'json', 'xml', 'txt', 'pdf', 'zip', 'wasm', 'avif',
    'mp4', 'webm', 'mp3',
]);

function shouldSkipStickyLocaleForLogicalSegments(segments) {
    if (!segments.length) return false;
    if (STICKY_LOCALE_SKIP_FIRST_SEGMENTS.has(segments[0])) return true;
    const last = segments[segments.length - 1];
    if (!last || !last.includes('.')) return false;
    const ext = last.slice(last.lastIndexOf('.') + 1).toLowerCase();
    return STICKY_LOCALE_STATIC_FILE_EXT.has(ext);
}

// manifest.prerender.localeRouteExclude → JSON array in meta; logical path prefixes (after locale).
function parseLocaleRouteExcludePatterns() {
    const meta = document.querySelector('meta[name="manifest:locale-route-exclude"]');
    const raw = meta?.getAttribute('content') || '';
    if (raw.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(raw.replace(/&quot;/g, '"'));
            if (Array.isArray(parsed)) {
                return parsed.map((s) => String(s).trim()).filter(Boolean);
            }
        } catch {
            /* fall through */
        }
    }
    const legacy = document.querySelector('meta[name="manifest:locale-sticky-exclude"]');
    const legacyRaw = legacy?.getAttribute('content') || '';
    if (!legacyRaw.trim()) return [];
    return legacyRaw.split(',').map((s) => s.trim().replace(/^\/+/, '').split('/')[0]).filter(Boolean);
}

function logicalPathMatchesLocaleRouteExclude(segments, patterns) {
    if (!patterns.length || !segments.length) return false;
    const lower = segments.map((s) => s.toLowerCase());
    for (const pattern of patterns) {
        const p = String(pattern)
            .trim()
            .replace(/^\/+/, '')
            .split('/')
            .filter(Boolean)
            .map((x) => x.toLowerCase());
        if (p.length === 0) continue;
        if (lower.length < p.length) continue;
        let match = true;
        for (let i = 0; i < p.length; i++) {
            if (lower[i] !== p[i]) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

// /fr/legal/terms → /legal/terms when patterns include "legal" or "legal/terms" (prefix match).
function normalizeRedundantLocalePrefixInUrl() {
    if (!isPrerenderedStaticBuild()) return false;
    const codes = getLocalizationCodesFromManifest();
    const patterns = parseLocaleRouteExcludePatterns();
    if (!codes.length || !patterns.length) return false;

    const segs = logicalSegmentsFromPathname(window.location.pathname);
    if (segs.length < 2) return false;
    if (!codes.includes(segs[0])) return false;
    const rest = segs.slice(1);
    if (!logicalPathMatchesLocaleRouteExclude(rest, patterns)) return false;

    const newLogical = '/' + rest.join('/');
    const base = getBasePath();
    let newPathname = base ? base.replace(/\/+$/, '') + newLogical : newLogical;
    newPathname = newPathname.replace(/\/{2,}/g, '/');
    if (!newPathname.startsWith('/')) newPathname = '/' + newPathname;
    if (newPathname === window.location.pathname) return false;

    const prevLogical = pathnameToLogical(window.location.pathname);
    const u = new URL(window.location.href);
    u.pathname = newPathname;
    history.replaceState(null, '', u.toString());
    currentRoute = pathnameToLogical(newPathname);
    const np = currentRoute === '/' ? '/' : String(currentRoute).replace(/^\/|\/$/g, '');
    window.dispatchEvent(new CustomEvent('manifest:route-change', {
        detail: { from: prevLogical, to: currentRoute, normalizedPath: np }
    }));
    return true;
}

// When the URL already has a locale prefix (e.g. /zh/pricing), keep it for same-origin links
// that omit the prefix (/articles → /zh/articles). No-op on default-locale URLs (/pricing).
function applyStickyLocaleToPathname(absolutePathname) {
    const codes = getLocalizationCodesFromManifest();
    if (!codes.length) return absolutePathname;

    const currentSegs = logicalSegmentsFromPathname(window.location.pathname);
    const sticky = currentSegs.length && codes.includes(currentSegs[0]) ? currentSegs[0] : null;
    if (!sticky) return absolutePathname;

    const targetSegs = logicalSegmentsFromPathname(absolutePathname);
    if (targetSegs.length && codes.includes(targetSegs[0])) {
        return absolutePathname;
    }

    const routeEx = parseLocaleRouteExcludePatterns();
    if (routeEx.length && logicalPathMatchesLocaleRouteExclude(targetSegs, routeEx)) {
        return absolutePathname;
    }

    if (shouldSkipStickyLocaleForLogicalSegments(targetSegs)) {
        return absolutePathname;
    }

    const base = getBasePath();
    const newLogical = targetSegs.length ? `/${sticky}/${targetSegs.join('/')}` : `/${sticky}`;
    const normalizedLogical = newLogical.replace(/\/{2,}/g, '/') || '/';
    if (!base) return normalizedLogical;
    const combined = `${base}${normalizedLogical}`.replace(/([^:])\/{2,}/g, '$1/');
    return combined.startsWith('/') ? combined : `/${combined}`;
}

function pathnameToLogical(pathname) {
    const base = getBasePath();
    if (!base) {
        const p = (pathname || '/').replace(/\/$/, '') || '/';
        if (p === '/' || p === '/index.html' || p === '/index') return '/';
        return p.startsWith('/') ? p : '/' + p;
    }
    if (pathname === base || pathname === base + '/') return '/';
    if (pathname.startsWith(base + '/')) {
        let logical = pathname.slice(base.length) || '/';
        if (logical === '/index.html' || logical === '/index') logical = '/';
        return logical;
    }
    if (pathname === base + '/index.html' || pathname === base + '/index') return '/';
    return pathname;
}

// Handle route changes
async function handleRouteChange() {
    const pathname = window.location.pathname;
    const newRoute = pathnameToLogical(pathname);
    if (newRoute === currentRoute) return;

    const prevRoute = currentRoute;
    currentRoute = newRoute;

    // Handle scrolling based on whether this is an anchor link or route change
    if (!window.location.hash) {
        // This is a route change - scroll to top
        // Use a small delay to ensure content has loaded
        setTimeout(() => {
            // Scroll main page to top
            window.scrollTo({ top: 0, behavior: 'smooth' });

            // Find and scroll scrollable containers to top
            // Use a generic approach that works with any CSS framework
            // Only check elements that are likely to be scrollable containers
            const potentialContainers = document.querySelectorAll('div, main, section, article, aside, nav, header, footer, .prose');
            potentialContainers.forEach(element => {
                const computedStyle = window.getComputedStyle(element);
                const isScrollable = (
                    computedStyle.overflowY === 'auto' ||
                    computedStyle.overflowY === 'scroll' ||
                    computedStyle.overflow === 'auto' ||
                    computedStyle.overflow === 'scroll'
                ) && element.scrollHeight > element.clientHeight;

                if (isScrollable) {
                    element.scrollTop = 0;
                }
            });
        }, 50);
    } else {
        // This is an anchor link - let the browser handle the scroll naturally
        // Use a small delay to ensure content has loaded, then let browser scroll to anchor
        setTimeout(() => {
            // The browser will automatically scroll to the anchor
            // We just need to ensure the content is loaded first
        }, 50);
    }

    // Emit route change event
    window.dispatchEvent(new CustomEvent('manifest:route-change', {
        detail: {
            from: prevRoute,
            to: newRoute,
            normalizedPath: newRoute === '/' ? '/' : newRoute.replace(/^\/|\/$/g, '')
        }
    }));
}

// Resolve internal link to absolute pathname for pushState. Relative hrefs (e.g. "gadget") are resolved against the app base, not the current URL, so we never get additive paths like /src/dist/widget/gadget/widget/...
function resolveHref(href) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return href;
    try {
        const base = getBasePath();
        const baseUrl = base ? (window.location.origin + base + '/') : (window.location.origin + '/');
        const url = new URL(href, baseUrl);
        if (url.origin !== window.location.origin) return href;
        let path = url.pathname.replace(/\/$/, '') || '/';
        let resolved;
        if (!base) {
            resolved = path.startsWith('/') ? path : '/' + path;
        } else if (path === base || path.startsWith(base + '/')) {
            resolved = path;
        } else if (path.startsWith('/')) {
            const pathSegs = path.split('/').filter(Boolean);
            const baseSegs = base.split('/').filter(Boolean);
            let i = 0;
            while (i < baseSegs.length && i < pathSegs.length && baseSegs[i] === pathSegs[i]) i++;
            const routeSegs = pathSegs.slice(i);
            if (routeSegs.length) {
                resolved = base + '/' + routeSegs.join('/');
            } else {
                const out = base + (path.startsWith('/') ? path : '/' + path);
                resolved = out.startsWith('/') ? out : '/' + out;
            }
        } else {
            const out = base + (path.startsWith('/') ? path : '/' + path);
            resolved = out.startsWith('/') ? out : '/' + out;
        }
        return applyStickyLocaleToPathname(resolved);
    } catch {
        const base = getBasePath();
        const safe = (href || '').trim();
        if (!safe) return applyStickyLocaleToPathname(base || '/');
        const raw = base ? (base + (safe.startsWith('/') ? safe : '/' + safe)) : (safe.startsWith('/') ? safe : '/' + safe);
        return applyStickyLocaleToPathname(raw);
    }
}

// Prerendered MPA: same-origin navigations use full page loads; rewrite targets so locale prefix sticks.
function installMpaStickyLocaleLinks() {
    document.addEventListener('click', (event) => {
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const link = event.target.closest('a');
        if (!link || link.closest('[data-manifest-skip-locale-sticky]')) return;
        if (link.hasAttribute('download')) return;

        const hrefAttr = link.getAttribute('href');
        if (!hrefAttr || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:') || hrefAttr.startsWith('javascript:')) return;
        if (hrefAttr.startsWith('#')) return;

        let url;
        try {
            url = new URL(hrefAttr, window.location.href);
        } catch {
            return;
        }
        if (url.origin !== window.location.origin) return;

        const path = url.pathname.replace(/\/$/, '') || '/';
        const adjusted = applyStickyLocaleToPathname(path);
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        // For prerendered MPA builds, directory paths must have a trailing slash so that the
        // static file host (e.g. Appwrite) resolves them to the correct index.html rather than
        // falling back to the root index.html.
        const hasFileExt = /\.[a-zA-Z0-9]+$/.test(adjusted);
        url.pathname = (adjusted !== '/' && !hasFileExt && !adjusted.endsWith('/'))
            ? adjusted + '/'
            : adjusted;

        const dest = url.toString();
        if (link.target === '_blank') {
            const features = link.relList?.contains('noopener') || link.relList?.contains('noreferrer')
                ? 'noopener,noreferrer'
                : undefined;
            window.open(dest, '_blank', features);
        } else {
            window.location.assign(dest);
        }
    }, true);
}

// Intercept link clicks to prevent page reloads
function interceptLinkClicks() {
    // Use capture phase to intercept before other handlers
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a');
        if (!link) return;

        const href = link.getAttribute('href');
        if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;

        // Handle pure anchor links normally - don't intercept them
        if (href.startsWith('#')) return;

        // Check if it's an external link FIRST (before any other processing)
        let isExternalLink = false;
        try {
            const url = new URL(href, window.location.origin);
            if (url.origin !== window.location.origin) {
                isExternalLink = true; // External link
            }
        } catch (e) {
            // Invalid URL, treat as relative
        }

        // If it's an external link, don't intercept it
        if (isExternalLink) {
            return;
        }

        // Handle links with both route and anchor (e.g., /page#section)
        if (href.includes('#')) {
            const [path, hash] = href.split('#');
            const fullHref = resolveHref(path) + (hash ? '#' + hash : '');

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            // Set flag to prevent recursive calls
            isInternalNavigation = true;

            // Update URL without page reload (use base path when app is in a subpath)
            history.pushState(null, '', fullHref);

            // Handle route change (but don't scroll to top since there's an anchor)
            handleRouteChange();

            // Reset flag
            isInternalNavigation = false;

            // After route change, scroll to the anchor
            setTimeout(() => {
                const targetElement = document.getElementById(hash);
                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth' });
                }
            }, 100);

            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        // Set flag to prevent recursive calls
        isInternalNavigation = true;

        // Update URL without page reload (use base path when app is in a subpath, e.g. /src/dist/gadget)
        const fullHref = resolveHref(href);
        history.pushState(null, '', fullHref);

        // Handle route change
        handleRouteChange();

        // Reset flag
        isInternalNavigation = false;

    }, true); // Use capture phase
}

// Initialize navigation
function initializeNavigation() {
    currentRoute = pathnameToLogical(window.location.pathname);
    normalizeRedundantLocalePrefixInUrl();

    // In prerendered/static output, use default browser navigation (no SPA interception)
    if (!isPrerenderedStaticBuild()) {
        interceptLinkClicks();

        window.addEventListener('popstate', () => {
            if (!isInternalNavigation) {
                handleRouteChange();
            }
        });
    } else {
        installMpaStickyLocaleLinks();
    }

    // Handle initial route
    handleRouteChange();
}

// Match the browser URL as soon as this module loads. Later chunks in the same bundle (e.g. router magic)
// may initialize before DOMContentLoaded; getCurrentRoute() must not stay at '/' or $route breaks article pages.
currentRoute = pathnameToLogical(window.location.pathname);

// Run immediately if DOM is ready, otherwise wait
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeNavigation);
} else {
    initializeNavigation();
}

// Export navigation interface
window.ManifestRoutingNavigation = {
    initialize: initializeNavigation,
    getCurrentRoute: () => currentRoute,
    getBasePath,
    resolveHref,
    pathnameToLogical
}; 

// Router visibility

function isPrerenderedStaticMPA() {
    try {
        return document.querySelector('meta[name="manifest:prerendered"][content="1"]') !== null;
    } catch (e) {
        return false;
    }
}

// Process visibility for all elements with x-route
function processRouteVisibility(normalizedPath) {
    // Static prerender output already contains only this route's sections; x-cloak + toggling here
    // causes a visible flash (content → hidden via x-cloak → shown when Alpine boots).
    if (isPrerenderedStaticMPA()) return;

    const routeElements = document.querySelectorAll('[x-route]');

    // First pass: collect all defined routes (excluding !* and other negative conditions)
    const definedRoutes = [];
    routeElements.forEach(element => {
        const routeCondition = element.getAttribute('x-route');
        if (!routeCondition) return;

        const conditions = routeCondition.split(',').map(cond => cond.trim());
        conditions.forEach(cond => {
            // Only collect positive conditions and wildcards (not negative ones)
            if (!cond.startsWith('!') && cond !== '!*') {
                definedRoutes.push(cond);
            }
        });
    });

    // Extract localization codes from manifest.json data sources
    const localizationCodes = [];
    try {
        // Check if manifest is available and has data sources
        const manifest = window.ManifestComponentsRegistry?.manifest || window.manifest;
        if (manifest && manifest.data) {
            Object.values(manifest.data).forEach(dataSource => {
                if (typeof dataSource === 'object' && dataSource !== null) {
                    Object.keys(dataSource).forEach(key => {
                        // Check if this looks like a localization key (common language codes)
                        if (key.match(/^[a-z]{2}(-[A-Z]{2})?$/)) {
                            localizationCodes.push(key);
                        }
                    });
                }
            });
        }
    } catch (e) {
        // Ignore errors if manifest is not available
    }

    // Check if current route is defined by any route
    let isRouteDefined = definedRoutes.some(route =>
        window.ManifestRouting.matchesCondition(normalizedPath, route)
    );

    // Also check if the route starts with a localization code
    if (!isRouteDefined && localizationCodes.length > 0) {
        const pathSegments = normalizedPath.split('/').filter(segment => segment);
        if (pathSegments.length > 0) {
            const firstSegment = pathSegments[0];
            if (localizationCodes.includes(firstSegment)) {
                // This is a localized route - check if the remaining path is defined
                const remainingPath = pathSegments.slice(1).join('/');

                // If no remaining path, treat as root route
                if (remainingPath === '') {
                    isRouteDefined = definedRoutes.some(route =>
                        window.ManifestRouting.matchesCondition('/', route) ||
                        window.ManifestRouting.matchesCondition('', route)
                    );
                } else {
                    // Check if the remaining path matches any defined route
                    isRouteDefined = definedRoutes.some(route =>
                        window.ManifestRouting.matchesCondition(remainingPath, route)
                    );
                }
            }
        }
    }

    routeElements.forEach(element => {
        const routeCondition = element.getAttribute('x-route');
        if (!routeCondition) return;

        // Parse route conditions
        const conditions = routeCondition.split(',').map(cond => cond.trim());
        const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
        const negativeConditions = conditions
            .filter(cond => cond.startsWith('!'))
            .map(cond => cond.slice(1));

        // Special handling for !* (undefined routes)
        if (conditions.includes('!*')) {
            const shouldShow = !isRouteDefined;
            if (shouldShow) {
                element.removeAttribute('hidden');
                element.style.display = '';
            } else {
                element.setAttribute('hidden', '');
                element.style.display = 'none';
            }
            return;
        }

        // Check conditions
        const hasNegativeMatch = negativeConditions.some(cond =>
            window.ManifestRouting.matchesCondition(normalizedPath, cond)
        );
        const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond =>
            window.ManifestRouting.matchesCondition(normalizedPath, cond)
        );

        const shouldShow = hasPositiveMatch && !hasNegativeMatch;

        // Show/hide element
        if (shouldShow) {
            element.removeAttribute('hidden');
            element.style.display = '';
        } else {
            element.setAttribute('hidden', '');
            element.style.display = 'none';
        }
    });
}

// Add x-cloak to route elements that don't have it
function addXCloakToRouteElements() {
    if (isPrerenderedStaticMPA()) return;
    const routeElements = document.querySelectorAll('[x-route]:not([x-cloak])');
    routeElements.forEach(element => {
        element.setAttribute('x-cloak', '');
    });
}

// Initialize visibility management
function initializeVisibility() {
    // Add x-cloak to route elements to prevent flash
    addXCloakToRouteElements();

    // Process initial visibility (use logical path when app is in a subpath)
    const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
    const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');
    processRouteVisibility(normalizedPath);

    // Listen for route changes
    window.addEventListener('manifest:route-change', (event) => {
        if (isPrerenderedStaticMPA()) return;
        processRouteVisibility(event.detail.normalizedPath);
    });

    // Listen for component processing to ensure visibility is applied after components load
    window.addEventListener('manifest:components-processed', () => {
        if (isPrerenderedStaticMPA()) return;
        // Add x-cloak to any new route elements
        addXCloakToRouteElements();

        const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
        const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');
        processRouteVisibility(normalizedPath);
    });
}

// Add x-cloak immediately to prevent flash
if (document.readyState === 'loading') {
    // DOM is still loading, add x-cloak as soon as possible
    document.addEventListener('DOMContentLoaded', () => {
        addXCloakToRouteElements();
        initializeVisibility();
    });
} else {
    // DOM is ready, add x-cloak immediately
    addXCloakToRouteElements();
    initializeVisibility();
}

// Export visibility interface
window.ManifestRoutingVisibility = {
    initialize: initializeVisibility,
    processRouteVisibility,
    isPrerenderedStaticMPA
}; 

// Router head

function isPrerenderedStaticMPA() {
    try {
        if (window.ManifestRoutingVisibility && typeof window.ManifestRoutingVisibility.isPrerenderedStaticMPA === 'function') {
            return window.ManifestRoutingVisibility.isPrerenderedStaticMPA();
        }
        return document.querySelector('meta[name="manifest:prerendered"][content="1"]') !== null;
    } catch (e) {
        return false;
    }
}

// Track injected head content to prevent duplicates
const injectedHeadContent = new Set();

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

// Generate unique identifier for head content
function generateHeadId(element) {
    const position = element.getAttribute('data-order');
    const componentId = element.getAttribute('data-component-id');
    const tagName = element.tagName.toLowerCase();

    if (position) {
        return `${tagName}-${position}`;
    } else if (componentId) {
        return `${tagName}-${componentId}`;
    } else {
        return `${tagName}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

// Process head content for a single element
function processElementHeadContent(element, normalizedPath) {
    let headTemplate = null;

    // Check if the element itself is a template with data-head
    if (element.tagName === 'TEMPLATE' && element.hasAttribute('data-head')) {
        headTemplate = element;
    } else {
        // Look for a template with data-head inside the element
        headTemplate = element.querySelector('template[data-head]');
    }

    if (!headTemplate) {
        return;
    }

    const headId = generateHeadId(element);
    const isVisible = shouldElementBeVisible(element, normalizedPath);

    if (isVisible) {
        // Skip if already injected (in-memory) or already present in DOM (e.g. prerendered)
        if (injectedHeadContent.has(headId)) {
            return;
        }
        if (document.head.querySelector(`[data-route-head="${headId}"]`)) {
            injectedHeadContent.add(headId);
            return;
        }

        // Add new head content
        Array.from(headTemplate.content.children).forEach(child => {
            if (child.tagName === 'SCRIPT') {
                // For scripts, create and execute directly
                const script = document.createElement('script');
                script.textContent = child.textContent;
                script.setAttribute('data-route-head', headId);
                document.head.appendChild(script);
            } else {
                // For other elements, clone and add (resolve $x bindings so meta/link have real values in SPA)
                const clonedChild = child.cloneNode(true);
                resolveDataHeadBindings(clonedChild);
                clonedChild.setAttribute('data-route-head', headId);
                document.head.appendChild(clonedChild);
            }
        });

        injectedHeadContent.add(headId);
    } else {
        // Element is not visible, remove any existing head content for this element
        const existingHead = document.head.querySelectorAll(`[data-route-head="${headId}"]`);
        existingHead.forEach(el => {
            el.remove();
        });
        injectedHeadContent.delete(headId);
    }
}

// Process all head content in the DOM
function processAllHeadContent(normalizedPath) {
    if (isPrerenderedStaticMPA()) return;

    // Find all elements with head templates
    const elementsWithHead = document.querySelectorAll('template[data-head]');

    // Debug: Let's see what's actually in the DOM
    const allTemplates = document.querySelectorAll('template');
    allTemplates.forEach((template, index) => {
        if (template.hasAttribute('data-head')) {
        } else {
            // Check if this might be the about template
            if (template.getAttribute('x-route') === 'about') {
            }
        }
    });

    // Also try a more specific selector to see if we can find the about template
    const aboutTemplate = document.querySelector('template[x-route="about"]');
    if (aboutTemplate) {
    }

    // Process each element's head content
    elementsWithHead.forEach((template, index) => {

        // For component templates, we need to check if the component should be visible
        // based on the current route, not just the template's own attributes
        let element = template;
        let shouldProcess = true;

        // If this is a component template (has data-component), check if the component
        // should be visible for the current route
        if (template.hasAttribute('data-component')) {
            const componentId = template.getAttribute('data-component');
            const componentRoute = template.getAttribute('x-route');

            // Check if this component should be visible for the current route
            if (componentRoute) {
                const isVisible = window.ManifestRouting.matchesCondition(normalizedPath, componentRoute);
                shouldProcess = isVisible;
            } else {
                shouldProcess = false;
            }
        } else {
            // For non-component templates, use the existing logic
            element = template.closest('[data-order], [data-component-id], [x-route]');

            // If the template itself has the attributes we need, use it directly
            if (!element || element === template) {
                if (template.hasAttribute('data-order') || template.hasAttribute('data-component') || template.hasAttribute('x-route')) {
                    element = template;
                } else {
                    element = template.parentElement;
                }
            }

            if (element) {
                const isVisible = shouldElementBeVisible(element, normalizedPath);
                shouldProcess = isVisible;
            }
        }

        if (shouldProcess) {
            // For component templates, process them directly since we've already determined visibility
            if (template.hasAttribute('data-component')) {
                processElementHeadContent(template, normalizedPath);
            } else {
                // For non-component templates, use the existing logic
                processElementHeadContent(element, normalizedPath);
            }
        }
    });
}

// Initialize head content management
function initializeHeadContent() {
    // Wait for components to be ready before processing head content
    function processHeadContentAfterComponentsReady() {
        // Process initial head content after a longer delay to let components settle
        setTimeout(() => {
            if (isPrerenderedStaticMPA()) return;
            const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
            const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');

            // Debug: Check if about component exists
            const aboutComponent = document.querySelector('[data-component="about-1"]');
            if (aboutComponent) {
            }

            // Debug: Check what placeholders exist
            const placeholders = document.querySelectorAll('x-about, x-home, x-ui');
            placeholders.forEach((placeholder, index) => {
            });

            processAllHeadContent(normalizedPath);
        }, 200);
    }

    // Function to process head content immediately (for projects without components)
    function processHeadContentImmediately() {
        if (isPrerenderedStaticMPA()) return;
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
            if (isPrerenderedStaticMPA()) return;
            // Process head content immediately to catch components before they're reverted
            const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
            const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');

            // Debug: Check if about component exists
            const aboutComponent = document.querySelector('[data-component="about-1"]');
            if (aboutComponent) {
            }

            // Debug: Check what placeholders exist
            const placeholders = document.querySelectorAll('x-about, x-home, x-ui');
            placeholders.forEach((placeholder, index) => {
            });

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

// Router anchors

// Parse pipeline syntax: 'scope | targets' (shared for directive and route-change handler)
function parseAnchorsExpression(expr) {
    if (!expr || expr.trim() === '') {
        return { scope: '', targets: 'h1, h2, h3, h4, h5, h6' };
    }
    if (expr.includes('|')) {
        const parts = expr.split('|').map(p => p.trim());
        return {
            scope: parts[0] || '',
            targets: parts[1] || 'h1, h2, h3, h4, h5, h6'
        };
    }
    return { scope: '', targets: expr };
}

function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

// Anchors functionality
function initializeAnchors() {

    // Register anchors directive  
    Alpine.directive('anchors', (el, { expression, modifiers }, { effect, evaluateLater, Alpine }) => {


        try {
            const parseExpression = parseAnchorsExpression;

            // Extract anchors function (only from visible scope containers to avoid prior-route content)
            const extractAnchors = (expr) => {
                const parsed = parseExpression(expr);

                let containers = [];
                if (!parsed.scope) {
                    containers = [document.body];
                } else {
                    const all = Array.from(document.querySelectorAll(parsed.scope));
                    containers = all.filter(isVisible);
                }

                let elements = [];
                const targets = parsed.targets.split(',').map(t => t.trim());

                containers.forEach(container => {
                    // Query all targets at once, then filter and sort by DOM order
                    const allMatches = [];
                    targets.forEach(target => {
                        const matches = container.querySelectorAll(target);
                        allMatches.push(...Array.from(matches));
                    });

                    // Remove duplicates and sort by DOM order
                    const uniqueMatches = [...new Set(allMatches)];
                    uniqueMatches.sort((a, b) => {
                        const position = a.compareDocumentPosition(b);
                        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                        return 0;
                    });

                    elements.push(...uniqueMatches);
                });

                return elements.map((element, index) => {
                    // Generate simple ID
                    let id = element.id;
                    if (!id) {
                        id = element.textContent.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
                        if (id) element.id = id;
                    }

                    // Selected state will be managed by intersection observer

                    return {
                        id: id,
                        text: element.textContent,
                        link: `#${id}`,
                        tag: element.tagName.toLowerCase(),
                        class: element.className.split(' ')[0] || '',
                        classes: Array.from(element.classList),
                        index: index,
                        element: element,

                    };
                });
            };

            // Track rendered elements to prevent duplicates
            let renderedElements = [];

            // Update Alpine data with anchors
            const updateAnchors = (anchors) => {
                // Remove existing rendered elements if they exist
                renderedElements.forEach(element => {
                    if (element.parentElement) {
                        element.remove();
                    }
                });
                renderedElements = [];

                // Set Alpine reactive property for anchor count
                Alpine.store('anchors', { count: anchors.length });

                // Render using the template element's structure and classes
                if (anchors.length > 0) {
                    // Find the container div inside the template
                    const templateContent = el.content || el;
                    const containerTemplate = templateContent.querySelector('div') || el.querySelector('div');

                    if (containerTemplate) {
                        // Clone the container div from the template
                        const containerElement = containerTemplate.cloneNode(false); // Don't clone children

                        // Remove Alpine directives from the container
                        containerElement.removeAttribute('x-show');

                        anchors.forEach(anchor => {
                            // Find the <a> element inside the template
                            const anchorTemplate = templateContent.querySelector('a') || el.querySelector('a');

                            if (anchorTemplate) {
                                // Clone the <a> element from inside the template
                                const linkElement = anchorTemplate.cloneNode(true);

                                // Remove Alpine directives
                                linkElement.removeAttribute('x-text');
                                linkElement.removeAttribute(':href');

                                // Set the actual href and text content
                                linkElement.href = anchor.link;
                                linkElement.textContent = anchor.text;

                                // Evaluate :class binding if present
                                if (linkElement.hasAttribute(':class')) {
                                    const classBinding = linkElement.getAttribute(':class');
                                    linkElement.removeAttribute(':class');

                                    try {
                                        // Create a simple evaluator for class bindings
                                        const evaluateClassBinding = (binding, anchor) => {
                                            // Replace anchor.property references with actual values
                                            let evaluated = binding
                                                .replace(/anchor\.tag/g, `'${anchor.tag}'`)
                                                .replace(/anchor\.selected/g, anchor.selected ? 'true' : 'false')
                                                .replace(/anchor\.index/g, anchor.index)
                                                .replace(/anchor\.id/g, `'${anchor.id}'`)
                                                .replace(/anchor\.text/g, `'${anchor.text.replace(/'/g, "\\'")}'`)
                                                .replace(/anchor\.link/g, `'${anchor.link}'`)
                                                .replace(/anchor\.class/g, `'${anchor.class}'`);

                                            // Simple object evaluation for class bindings
                                            if (evaluated.includes('{') && evaluated.includes('}')) {
                                                // Extract the object part
                                                const objectMatch = evaluated.match(/\{([^}]+)\}/);
                                                if (objectMatch) {
                                                    const objectContent = objectMatch[1];
                                                    const classPairs = objectContent.split(',').map(pair => pair.trim());

                                                    classPairs.forEach(pair => {
                                                        const [className, condition] = pair.split(':').map(s => s.trim());
                                                        if (condition && eval(condition)) {
                                                            linkElement.classList.add(className.replace(/['"]/g, ''));
                                                        }
                                                    });
                                                }
                                            }
                                        };

                                        evaluateClassBinding(classBinding, anchor);
                                    } catch (error) {
                                        console.warn('[Manifest Anchors] Could not evaluate class binding:', classBinding, error);
                                    }
                                }

                                containerElement.appendChild(linkElement);
                            }
                        });

                        // Insert the container before the template element
                        el.parentElement.insertBefore(containerElement, el);
                        renderedElements.push(containerElement);
                    } else {
                        // Fallback: insert links directly if no container found
                        anchors.forEach(anchor => {
                            const templateContent = el.content || el;
                            const anchorTemplate = templateContent.querySelector('a') || el.querySelector('a');

                            if (anchorTemplate) {
                                const linkElement = anchorTemplate.cloneNode(true);
                                linkElement.removeAttribute('x-text');
                                linkElement.removeAttribute(':href');
                                linkElement.href = anchor.link;
                                linkElement.textContent = anchor.text;

                                // Evaluate :class binding if present
                                if (linkElement.hasAttribute(':class')) {
                                    const classBinding = linkElement.getAttribute(':class');
                                    linkElement.removeAttribute(':class');

                                    try {
                                        // Create a simple evaluator for class bindings
                                        const evaluateClassBinding = (binding, anchor) => {
                                            // Replace anchor.property references with actual values
                                            let evaluated = binding
                                                .replace(/anchor\.tag/g, `'${anchor.tag}'`)
                                                .replace(/anchor\.selected/g, anchor.selected ? 'true' : 'false')
                                                .replace(/anchor\.index/g, anchor.index)
                                                .replace(/anchor\.id/g, `'${anchor.id}'`)
                                                .replace(/anchor\.text/g, `'${anchor.text.replace(/'/g, "\\'")}'`)
                                                .replace(/anchor\.link/g, `'${anchor.link}'`)
                                                .replace(/anchor\.class/g, `'${anchor.class}'`);

                                            // Simple object evaluation for class bindings
                                            if (evaluated.includes('{') && evaluated.includes('}')) {
                                                // Extract the object part
                                                const objectMatch = evaluated.match(/\{([^}]+)\}/);
                                                if (objectMatch) {
                                                    const objectContent = objectMatch[1];
                                                    const classPairs = objectContent.split(',').map(pair => pair.trim());

                                                    classPairs.forEach(pair => {
                                                        const [className, condition] = pair.split(':').map(s => s.trim());
                                                        if (condition && eval(condition)) {
                                                            linkElement.classList.add(className.replace(/['"]/g, ''));
                                                        }
                                                    });
                                                }
                                            }
                                        };

                                        evaluateClassBinding(classBinding, anchor);
                                    } catch (error) {
                                        console.warn('[Manifest Anchors] Could not evaluate class binding:', classBinding, error);
                                    }
                                }

                                el.parentElement.insertBefore(linkElement, el);
                                renderedElements.push(linkElement);
                            }
                        });
                    }

                    el.style.display = 'none'; // Hide template
                } else {
                    // No anchors - ensure template is visible and elements are cleared
                    el.style.display = '';
                }
            };

            // Try extraction and update data
            const tryExtraction = () => {
                const anchors = extractAnchors(expression);
                updateAnchors(anchors);
                return anchors;
            };

            // Try extraction with progressive delays and content detection
            const attemptExtraction = (attempt = 1, maxAttempts = 10) => {
                const anchors = extractAnchors(expression);

                if (anchors.length > 0) {
                    updateAnchors(anchors);
                    return true;
                } else if (attempt < maxAttempts) {
                    setTimeout(() => {
                        attemptExtraction(attempt + 1, maxAttempts);
                    }, attempt * 200); // Progressive delay: 200ms, 400ms, 600ms, etc.
                } else {
                    // No anchors found after all attempts, update store to clear previous state
                    updateAnchors([]);
                }
                return false;
            };

            // Store refresh function on element for route changes
            el._x_anchorRefresh = () => {
                attemptExtraction();
            };

            // Start extraction attempts
            attemptExtraction();


        } catch (error) {
            console.error('[Manifest Anchors] Error in directive:', error);
        }
    });
}

// Initialize anchors when Alpine is ready
document.addEventListener('alpine:init', () => {

    try {
        initializeAnchors();

    } catch (error) {
        console.error('[Manifest Anchors] Failed to initialize:', error);
    }
});

// Refresh anchors when route changes — wait for scope DOM to update (e.g. x-markdown) to avoid showing prior page's anchors
window.addEventListener('manifest:route-change', () => {
    Alpine.store('anchors', { count: 0 });

    const runWhenScopeReady = (el) => {
        const expression = el.getAttribute('x-anchors');
        if (!expression || !el._x_anchorRefresh) return;
        const { scope } = parseAnchorsExpression(expression);
        if (!scope) {
            setTimeout(() => el._x_anchorRefresh(), 400);
            return;
        }
        const containers = Array.from(document.querySelectorAll(scope)).filter(isVisible);
        const container = containers[0];
        if (!container) {
            el._x_anchorRefresh();
            return;
        }
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            observer?.disconnect();
            clearTimeout(fallback);
            el._x_anchorRefresh();
        };
        let t = 0;
        const observer = new MutationObserver(() => {
            clearTimeout(t);
            t = setTimeout(finish, 50);
        });
        observer.observe(container, { childList: true, subtree: true });
        const fallback = setTimeout(finish, 800);
    };

    requestAnimationFrame(() => {
        document.querySelectorAll('[x-anchors]').forEach(runWhenScopeReady);
    });
});

// Refresh anchors when hash changes (for active state updates)
window.addEventListener('hashchange', () => {
    const anchorElements = document.querySelectorAll('[x-anchors]');
    anchorElements.forEach(el => {
        if (el._x_anchorRefresh) {
            el._x_anchorRefresh();
        }
    });
});

// Also refresh anchors when components are processed
window.addEventListener('manifest:components-processed', () => {
    setTimeout(() => {
        const anchorElements = document.querySelectorAll('[x-anchors]');
        anchorElements.forEach(el => {
            const expression = el.getAttribute('x-anchors');
            if (expression && el._x_anchorRefresh) {
                el._x_anchorRefresh();
            }
        });
    }, 100);
});

// Export anchors interface
window.ManifestRoutingAnchors = {
    initialize: initializeAnchors
};


// Router magic property

// Initialize router magic property
function initializeRouterMagic() {
    // Check if Alpine is available
    if (typeof Alpine === 'undefined') {
        console.error('[Manifest Router Magic] Alpine is not available');
        return;
    }
    if (window.__manifestRouterMagicInitialized) return;
    window.__manifestRouterMagicInitialized = true;

    // Create a reactive object for route data (use logical path when app is in a subpath)
    const route = Alpine.reactive({
        current: window.ManifestRoutingNavigation?.getCurrentRoute() || window.location.pathname,
        segments: [],
        params: {},
        matches: null
    });

    // Update route when route changes
    const updateRoute = () => {
        const currentRoute = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;

        // Strip localization codes and other injected segments to get the logical route
        let logicalRoute = currentRoute;

        // Check if there's a localization code at the start of the path
        const pathParts = currentRoute.split('/').filter(Boolean);
        if (pathParts.length > 0) {
            // Check if first segment is a language code (2-5 characters, alphanumeric with hyphens/underscores)
            const firstSegment = pathParts[0];
            if (/^[a-zA-Z0-9_-]{2,5}$/.test(firstSegment)) {
                // This might be a language code, check if it's in the available locales
                const store = Alpine.store('locale');
                if (store && store.available && store.available.includes(firstSegment)) {
                    // Remove the language code from the path
                    logicalRoute = '/' + pathParts.slice(1).join('/');
                    if (logicalRoute === '/') logicalRoute = '/';
                }
            }
        }

        const normalizedPath = logicalRoute === '/' ? '' : logicalRoute.replace(/^\/|\/$/g, '');
        const segments = normalizedPath ? normalizedPath.split('/').filter(segment => segment) : [];

        route.current = logicalRoute;
        route.segments = segments;
        route.params = {};
    };

    // Listen for route changes
    window.addEventListener('manifest:route-change', updateRoute);
    window.addEventListener('popstate', updateRoute);

    // Align with navigation + locale stripping; initial reactive value can be wrong if magic ran before DOMContentLoaded.
    updateRoute();

    // Register $route magic property - return the route string directly
    Alpine.magic('route', () => route.current);
}

// Initialize when Alpine is ready and router is ready
document.addEventListener('alpine:init', () => {
    // Wait for router to be ready
    const waitForRouter = () => {
        if (window.ManifestRoutingNavigation && window.ManifestRouting) {
            try {
                initializeRouterMagic();
            } catch (error) {
                console.error('[Manifest Router Magic] Failed to initialize:', error);
            }
        } else {
            // Wait a bit more for router to initialize
            setTimeout(waitForRouter, 50);
        }
    };

    waitForRouter();
});

// Also try to initialize immediately if Alpine and router are already available
if (typeof Alpine !== 'undefined' && window.ManifestRoutingNavigation && window.ManifestRouting) {
    try {
        initializeRouterMagic();
    } catch (error) {
        console.error('[Manifest Router Magic] Failed to initialize immediately:', error);
    }
}

// Export magic property interface
window.ManifestRoutingMagic = {
    initialize: initializeRouterMagic
};
