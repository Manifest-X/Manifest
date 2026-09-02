// Router visibility

function isPrerenderedStaticMPA() {
    try {
        return document.querySelector('meta[name="manifest:prerendered"][content="1"]') !== null;
    } catch (e) {
        return false;
    }
}

// Logical path for the current URL, normalized the way route conditions expect
function currentNormalizedPath() {
    const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
    return currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');
}

// Localization codes from manifest.json data sources
function getLocalizationCodes() {
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
    return localizationCodes;
}

// Positive conditions of every route, including routes stashed inside a deferred route
function collectDefinedRoutes() {
    const definedRoutes = [];
    const collect = (element) => {
        const routeCondition = element.getAttribute('x-route');
        if (!routeCondition) return;
        routeCondition.split(',').map(cond => cond.trim()).forEach(cond => {
            if (!cond.startsWith('!') && cond !== '!*') definedRoutes.push(cond);
        });
    };
    document.querySelectorAll('[x-route]').forEach(collect);
    document.querySelectorAll('[x-route] > template[data-mnfst-defer]').forEach(tpl => {
        tpl.content.querySelectorAll('[x-route]').forEach(collect);
    });
    return definedRoutes;
}

// Whether any defined route (or its localized form) covers the path — drives x-route="!*"
function isRouteDefined(normalizedPath, definedRoutes) {
    let defined = definedRoutes.some(route =>
        window.ManifestRouting.matchesCondition(normalizedPath, route)
    );
    const localizationCodes = getLocalizationCodes();
    if (!defined && localizationCodes.length > 0) {
        const pathSegments = normalizedPath.split('/').filter(segment => segment);
        if (pathSegments.length > 0 && localizationCodes.includes(pathSegments[0])) {
            const remainingPath = pathSegments.slice(1).join('/');
            if (remainingPath === '') {
                defined = definedRoutes.some(route =>
                    window.ManifestRouting.matchesCondition('/', route) ||
                    window.ManifestRouting.matchesCondition('', route)
                );
            } else {
                defined = definedRoutes.some(route =>
                    window.ManifestRouting.matchesCondition(remainingPath, route)
                );
            }
        }
    }
    return defined;
}

// Match one route element against a path: true/false, or null when it carries no condition
function routeMatches(element, normalizedPath, defined) {
    const routeCondition = element.getAttribute('x-route');
    if (!routeCondition) return null;

    const conditions = routeCondition.split(',').map(cond => cond.trim());
    if (conditions.includes('!*')) {
        if (defined === undefined) defined = isRouteDefined(normalizedPath, collectDefinedRoutes());
        return !defined;
    }

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
    return hasPositiveMatch && !hasNegativeMatch;
}

// Cooperative check (defer plugin): is this route active for the current URL? Static MPA output always is.
function isRouteActive(element, normalizedPath) {
    if (isPrerenderedStaticMPA()) return true;
    return routeMatches(element, normalizedPath === undefined ? currentNormalizedPath() : normalizedPath) !== false;
}

// Activation hook fires before the route becomes visible so deferred content renders first
function showRoute(element) {
    element.dispatchEvent(new CustomEvent('manifest:route-activate'));
    element.removeAttribute('hidden');
    element.style.display = '';
}

function hideRoute(element) {
    element.setAttribute('hidden', '');
    element.style.display = 'none';
}

// Process visibility for all elements with x-route
function processRouteVisibility(normalizedPath) {
    // Static prerender output already contains only this route's sections; x-cloak + toggling here
    // causes a visible flash (content → hidden via x-cloak → shown when Alpine boots).
    if (isPrerenderedStaticMPA()) return;

    const defined = isRouteDefined(normalizedPath, collectDefinedRoutes());

    // Worklist: activating a deferred route can reveal nested routes that need this pass too
    const seen = new Set();
    const queue = Array.from(document.querySelectorAll('[x-route]'));
    while (queue.length) {
        const element = queue.shift();
        if (seen.has(element)) continue;
        seen.add(element);
        const match = routeMatches(element, normalizedPath, defined);
        if (match === null) continue;
        if (match) {
            showRoute(element);
            element.querySelectorAll('[x-route]').forEach(nested => { if (!seen.has(nested)) queue.push(nested); });
        } else {
            hideRoute(element);
        }
    }
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
    processRouteVisibility(currentNormalizedPath());

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
        processRouteVisibility(currentNormalizedPath());
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
    isRouteActive,
    isPrerenderedStaticMPA
};
