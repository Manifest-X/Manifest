/* Manifest Data Sources - Route Proxy Creation */
// Creates proxies for route-specific data lookups ($route() method)

// Shared revision, read (transparently) by every $route() proxy's get/has trap.
// Alpine 3.x scheduler bug: queueJob dedupes by reference against the current
// flush's queue array (cleared only at flush end), so if a sibling effect
// (e.g. an x-if that also reads a plain store flag) already ran earlier in
// the SAME flush, this proxy's own updateReactiveTarget() write later in that
// flush can't re-queue it — the re-trigger is silently dropped and the
// directive is stranded on stale (often empty) data forever, even though
// later reads (e.g. a header's x-text) see the correct value. Bumping this
// counter on a fresh macrotask after the proxy settles re-arms anything
// dropped, mirroring the data store's bumpAllVersions() post-settle hammer —
// but scoped to the $route() reactive graph, which bumpAllVersions() never
// touches (it only bumps store._v[source]).
let routeProxyVersion = null;
function getRouteProxyVersion() {
    if (!routeProxyVersion) routeProxyVersion = Alpine.reactive ? Alpine.reactive({ n: 0 }) : { n: 0 };
    return routeProxyVersion;
}
let routeProxyVersionBumpTimer = null;
function scheduleRouteProxyVersionBump() {
    if (routeProxyVersionBumpTimer) return;
    routeProxyVersionBumpTimer = setTimeout(() => {
        routeProxyVersionBumpTimer = null;
        getRouteProxyVersion().n++;
    }, 0);
}

// Global debounce mechanism shared across all route proxies
if (!window.ManifestDataRouteProxyUpdateQueue) {
    window.ManifestDataRouteProxyUpdateQueue = {
        pending: new Set(),
        timeout: null,
        update() {
            // Clear timeout if exists
            if (this.timeout) {
                clearTimeout(this.timeout);
            }

            // Debounce all updates
            this.timeout = setTimeout(() => {
                this.flushSync();
            }, 0);
        },
        // Run all pending proxy updates immediately (e.g. on route change so content updates without refresh)
        flushSync() {
            if (this.timeout) {
                clearTimeout(this.timeout);
                this.timeout = null;
            }
            const proxiesToUpdate = Array.from(this.pending);
            this.pending.clear();
            proxiesToUpdate.forEach(updateFn => {
                try {
                    updateFn();
                } catch (error) {
                    console.error('[Manifest Data] Error updating route proxy:', error);
                }
            });
        }
    };
}

// Cache for route proxies to prevent recreating them on every access
// Key format: `${dataSourceName}:${pathKey}`
const routeProxyCache = new Map();

// Clear route proxy cache for a specific data source (called when store updates)
function clearRouteProxyCacheForDataSource(dataSourceName) {
    if (!dataSourceName) return;
    const keysToDelete = [];
    for (const [key] of routeProxyCache.entries()) {
        if (key.startsWith(`${dataSourceName}:`)) {
            keysToDelete.push(key);
        }
    }
    keysToDelete.forEach(key => routeProxyCache.delete(key));
}

// Create proxy for route-specific lookups
function createRouteProxy(dataSourceData, pathKey, dataSourceName) {
    // Use cache if dataSourceName is provided to avoid recreating proxies
    if (dataSourceName && pathKey) {
        const cacheKey = `${dataSourceName}:${pathKey}`;
        if (routeProxyCache.has(cacheKey)) {
            return routeProxyCache.get(cacheKey);
        }
    }

    // Get helper functions
    const findItemByPath = window.ManifestDataProxiesHelpers?.findItemByPath;
    const findGroupContainingItem = window.ManifestDataProxiesHelpers?.findGroupContainingItem;
    const convertProxyToArray = window.ManifestDataProxiesHelpers?.convertProxyToArray;

    // Create a reactive object that Alpine can track
    // This ensures Alpine re-evaluates when the URL changes
    const reactiveTarget = Alpine.reactive ? Alpine.reactive({}) : {};

    // Track last update URL for this specific proxy
    let lastUpdateUrl = null;

    // Function to update the reactive target with current route data
    function updateReactiveTarget() {
        // Read current URL from reactive route tracker first (Alpine can track this)
        const routeTracker = window.ManifestDataRouteTracker;
        let currentPath = null;

        if (routeTracker && routeTracker.currentUrl) {
            currentPath = routeTracker.currentUrl;
        } else {
            const store = Alpine.store('data');
            const currentUrlValue = store?._currentUrl;
            currentPath = currentUrlValue || window.location.pathname;
        }

        // Skip if URL hasn't changed for this proxy
        if (currentPath === lastUpdateUrl) {
            return;
        }
        lastUpdateUrl = currentPath;

        let pathSegments = currentPath.split('/').filter(segment => segment);

        // Filter out language codes from path segments for route matching
        const localeStore = Alpine.store('locale');
        if (localeStore && localeStore.available && pathSegments.length > 0) {
            const firstSegment = pathSegments[0];
            if (localeStore.available.includes(firstSegment)) {
                pathSegments = pathSegments.slice(1);
            }
        }

        // Ensure we have the actual array data (not Alpine proxy)
        // This is critical for findItemByPath to work correctly
        let dataToSearch = dataSourceData;
        if (dataSourceData && typeof dataSourceData === 'object') {
            // If it's an Alpine proxy, try to get raw data
            const getRawData = window.ManifestDataStore?.getRawData;
            if (getRawData && dataSourceName) {
                const rawData = getRawData(dataSourceName);
                if (rawData && (Array.isArray(rawData) || (rawData.length !== undefined && rawData.length >= 0))) {
                    dataToSearch = rawData;
                } else {
                    dataToSearch = convertProxyToArray ? convertProxyToArray(dataSourceData) : dataSourceData;
                }
            } else {
                dataToSearch = convertProxyToArray ? convertProxyToArray(dataSourceData) : dataSourceData;
            }
        }

        // Find the matching item based on current URL
        let foundItem = null;
        if (dataToSearch && typeof dataToSearch === 'object' && findItemByPath) {
            foundItem = findItemByPath(dataToSearch, pathKey, pathSegments);
        }

        // Update reactive target with all found item properties
        // Clear all properties first, then set new ones to ensure Alpine detects the change
        const previousKeys = Object.keys(reactiveTarget);
        const newData = {};

        if (foundItem) {
            Object.keys(foundItem).forEach(key => {
                newData[key] = foundItem[key];
            });
            // Also set group property if needed
            if (findGroupContainingItem) {
                const groupItem = findGroupContainingItem(dataSourceData, foundItem);
                if (groupItem?.group) {
                    newData.group = groupItem.group;
                }
            }
        }

        // Clear old keys that no longer exist
        previousKeys.forEach(key => {
            if (!(key in newData)) {
                delete reactiveTarget[key];
            }
        });

        // Set new values - replace all at once to ensure Alpine detects changes
        // Use a timestamp property to force Alpine to recognize the change
        const timestamp = Date.now();
        Object.assign(reactiveTarget, newData, { _timestamp: timestamp });

        // Remove timestamp immediately after (it's just to trigger reactivity)
        delete reactiveTarget._timestamp;

        // Post-settle hammer (see getRouteProxyVersion above): a sibling
        // effect sharing this same flush may have already run before this
        // write and had its re-trigger dropped by Alpine's scheduler.
        scheduleRouteProxyVersionBump();
    }

    // Initial update to populate reactiveTarget immediately
    // This ensures reactiveTarget has values even before Alpine.effect() runs
    updateReactiveTarget();

    // Set up Alpine effect to watch route tracker and update reactive target
    // CRITICAL: Alpine tracks dependencies accessed inside Alpine.effect(), so accessing
    // routeTracker.currentUrl here establishes the dependency. When routeTracker.currentUrl
    // changes, Alpine automatically re-runs this effect, which updates reactiveTarget.
    // Then Alpine re-evaluates expressions that access reactiveTarget properties.
    if (typeof Alpine !== 'undefined' && Alpine.effect) {
        Alpine.effect(() => {
            // Access route tracker to establish dependency tracking
            // Alpine will track this access and re-run the effect when it changes
            const routeTracker = window.ManifestDataRouteTracker;
            let currentPath = null;

            if (routeTracker && routeTracker.currentUrl) {
                // Access currentUrl - Alpine tracks this and re-runs effect when it changes
                currentPath = routeTracker.currentUrl;
            } else {
                const store = Alpine.store('data');
                if (store) {
                    // Access _currentUrl - Alpine tracks this
                    currentPath = store._currentUrl || window.location.pathname;
                } else {
                    currentPath = window.location.pathname;
                }
            }

            // Update reactive target when route changes
            // This runs automatically when Alpine detects route tracker changes
            updateReactiveTarget();
        });
    } else {
        // Fallback: event listeners if Alpine.effect not available
        // Initial update already called above
        const routeChangeHandler = () => {
            window.ManifestDataRouteProxyUpdateQueue.pending.add(updateReactiveTarget);
            window.ManifestDataRouteProxyUpdateQueue.update();
        };
        window.addEventListener('manifest:data-url-change', routeChangeHandler);
        window.addEventListener('manifest:route-change', routeChangeHandler);
    }

    const proxy = new Proxy(reactiveTarget, {
        get(target, prop) {
            try {
                // Transparent dependency on the shared post-settle revision (see
                // getRouteProxyVersion above) — every reader of this proxy
                // implicitly re-arms on a bump, no `void` pin required in markup.
                void getRouteProxyVersion().n;

                // CRITICAL: Return value from reactiveTarget, not computed synchronously
                // Alpine tracks property access on reactiveTarget, so when reactiveTarget[prop]
                // changes (via Alpine.effect() updating it), Alpine re-evaluates expressions.
                // If we computed synchronously here, Alpine wouldn't track the route tracker
                // dependency because Proxy traps execute outside Alpine's evaluation context.

                // Return value from reactive target (Alpine tracks this)
                if (prop in target) {
                    return target[prop];
                }

                // Return empty string for string properties, undefined otherwise
                if (typeof prop === 'string' && prop !== Symbol.iterator && prop !== 'then') {
                    return '';
                }
                return undefined;
            } catch (error) {
                console.error('[Manifest Data] Error:', error);
                return undefined;
            }
        },
        // Add has trap to help Alpine track property existence
        has(target, prop) {
            // Same transparent dependency as get() — see getRouteProxyVersion above.
            void getRouteProxyVersion().n;

            // Check reactiveTarget first (which Alpine tracks)
            // This ensures consistency with the get trap
            if (prop in target) {
                return true;
            }

            // Fallback: compute synchronously if not in reactiveTarget yet
            // This handles cases where the property hasn't been populated yet
            const routeTracker = window.ManifestDataRouteTracker;
            let currentPath = null;

            if (routeTracker && routeTracker.currentUrl) {
                currentPath = routeTracker.currentUrl;
            } else {
                const store = Alpine.store('data');
                const currentUrlValue = store?._currentUrl;
                currentPath = currentUrlValue || window.location.pathname;
            }

            let pathSegments = currentPath.split('/').filter(segment => segment);

            // Filter out language codes
            const localeStore = Alpine.store('locale');
            if (localeStore && localeStore.available && pathSegments.length > 0) {
                const firstSegment = pathSegments[0];
                if (localeStore.available.includes(firstSegment)) {
                    pathSegments = pathSegments.slice(1);
                }
            }

            const getRawData = window.ManifestDataStore?.getRawData;
            let dataToSearch = dataSourceData;
            if (dataSourceData && typeof dataSourceData === 'object' && getRawData && dataSourceName) {
                const rawData = getRawData(dataSourceName);
                if (rawData && (Array.isArray(rawData) || (rawData.length !== undefined && rawData.length >= 0))) {
                    dataToSearch = rawData;
                } else {
                    dataToSearch = convertProxyToArray ? convertProxyToArray(dataSourceData) : dataSourceData;
                }
            } else if (dataSourceData && typeof dataSourceData === 'object') {
                dataToSearch = convertProxyToArray ? convertProxyToArray(dataSourceData) : dataSourceData;
            }

            const foundItem = dataToSearch && typeof dataToSearch === 'object' && findItemByPath
                ? findItemByPath(dataToSearch, pathKey, pathSegments)
                : null;

            if (foundItem) {
                return prop in foundItem || prop === 'group';
            }
            return false;
        }
    });

    // Cache the proxy if dataSourceName and pathKey are provided
    if (dataSourceName && pathKey) {
        const cacheKey = `${dataSourceName}:${pathKey}`;
        routeProxyCache.set(cacheKey, proxy);
    }

    return proxy;
}

// Export functions to window for use by other subscripts
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxies) {
        window.ManifestDataProxies = {};
    }
    window.ManifestDataProxies.createRouteProxy = createRouteProxy;
    window.ManifestDataProxies.clearRouteProxyCacheForDataSource = clearRouteProxyCacheForDataSource;
}
