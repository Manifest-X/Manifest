/* Manifest Data Sources - Magic Method Core Registration */
// Main proxy creation and registration - delegates to helper modules

// Expose $x globally IMMEDIATELY (at module load time) so it's available before Alpine initializes
// This ensures window.$x works in x-data methods and other contexts
if (typeof window !== 'undefined') {
    // Create a cached fallback proxy (reuse same instance for chaining)
    let cachedFallbackProxy = null;

    // Define window.$x getter immediately so it's available as soon as this script loads
    try {
        Object.defineProperty(window, '$x', {
            get: function () {
                // Try multiple methods to get the proxy:

                // 1. Try stored factory function (most reliable)
                if (window._$xProxyFactory && typeof window._$xProxyFactory === 'function') {
                    try {
                        const proxy = window._$xProxyFactory();
                        if (proxy) return proxy;
                    } catch (e) {
                        console.warn('[Manifest Data] Failed to create proxy from factory:', e);
                    }
                }

                // 2. Try Alpine magic method
                try {
                    const magicFn = window.Alpine?.magic?.('x');
                    if (magicFn && typeof magicFn === 'function') {
                        const proxy = magicFn();
                        if (proxy) return proxy;
                    }
                } catch (e) {
                    // Magic method not ready or failed - continue to fallback
                }

                // 3. Fallback: return a safe loading proxy that allows chaining
                // This allows code to run without errors while Alpine initializes
                // Use the same loading proxy pattern used elsewhere in the codebase
                const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
                if (createLoadingProxy) {
                    const loadingProxy = createLoadingProxy();
                    if (loadingProxy) return loadingProxy;
                }

                // Ultimate fallback: return a cached proxy that returns itself for chaining
                // Cache it so chaining works (window.$x.projects.$upload returns the same proxy)
                if (!cachedFallbackProxy) {
                    cachedFallbackProxy = new Proxy({}, {
                        get(target, prop) {
                            // Return the same proxy for chaining (allows window.$x.projects.$upload without errors)
                            return cachedFallbackProxy;
                        },
                        has(target, prop) {
                            // Make all properties appear to exist to prevent Alpine errors
                            return true;
                        }
                    });
                }
                return cachedFallbackProxy;
            },
            configurable: true,
            enumerable: false
        });
    } catch (e) {
        // If defineProperty fails, log warning but continue
        console.warn('[Manifest Data] Failed to define window.$x getter at module load:', e);
    }
}

/**
 * Create a loading proxy with methods for Appwrite data sources
 * @param {string} dataSourceName - Name of the data source
 * @param {Function} reloadDataSource - Function to reload data source
 * @returns {Proxy} Loading proxy with methods
 */
function createAppwriteLoadingProxy(dataSourceName, reloadDataSource) {
    const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
    const createAppwriteMethodsHandler = window.ManifestDataProxiesAppwrite?.createAppwriteMethodsHandler;
    const createStatePropertyHandler = window.ManifestDataProxiesMagic?.createStatePropertyHandler;
    const createFilesMethod = window.ManifestDataProxiesMagic?.createFilesMethod;
    const createUploadMethod = window.ManifestDataProxiesMagic?.createUploadMethod;
    const createPaginationMethod = window.ManifestDataProxiesMagic?.createPaginationMethod;

    if (!createLoadingProxy) {
        return new Proxy({}, { get: () => undefined });
    }

    const methodsHandler = createAppwriteMethodsHandler
        ? createAppwriteMethodsHandler(dataSourceName, reloadDataSource)
        : null;

    const stateHandler = createStatePropertyHandler ? createStatePropertyHandler(dataSourceName) : null;
    const filesMethod = createFilesMethod ? createFilesMethod(dataSourceName) : null;
    const uploadMethod = createUploadMethod ? createUploadMethod(dataSourceName, reloadDataSource) : null;

    return new Proxy(createLoadingProxy(), {
        get(target, key) {
            // Handle state properties
            if (stateHandler) {
                const stateValue = stateHandler(key);
                if (stateValue !== undefined) {
                    return stateValue;
                }
            }

            // Handle $files method for tables (reactive file arrays) - available even when loading
            if (key === '$files' && filesMethod) {
                return filesMethod;
            }

            // Handle $upload method for tables - available even when loading
            if (key === '$upload' && uploadMethod) {
                return uploadMethod;
            }

            // Handle pagination methods
            if ((key === '$first' || key === '$next' || key === '$prev' || key === '$page') && createPaginationMethod) {
                return createPaginationMethod(key, dataSourceName);
            }

            // Handle Appwrite CRUD methods
            if (key === '$create' || key === '$update' || key === '$delete' || key === '$query' ||
                key === '$url' || key === '$download' || key === '$preview' || key === '$filesFor' ||
                key === '$unlinkFrom' || key === '$removeFrom' || key === '$remove') {
                if (methodsHandler) {
                    return methodsHandler.bind(null, key);
                }
            }

            // Fall through to loading proxy
            return target[key];
        }
    });
}

/**
 * Create a loading proxy for non-Appwrite data sources
 * @param {string} dataSourceName - Name of the data source
 * @returns {Proxy} Loading proxy with basic methods
 */
function createBasicLoadingProxy(dataSourceName) {
    const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
    const createStatePropertyHandler = window.ManifestDataProxiesMagic?.createStatePropertyHandler;
    const createFilesMethod = window.ManifestDataProxiesMagic?.createFilesMethod;

    if (!createLoadingProxy) {
        return new Proxy({}, { get: () => undefined });
    }

    const stateHandler = createStatePropertyHandler ? createStatePropertyHandler(dataSourceName) : null;
    const filesMethod = createFilesMethod ? createFilesMethod(dataSourceName) : null;

    return new Proxy(createLoadingProxy(), {
        get(target, key) {
            // Handle state properties
            if (stateHandler) {
                const stateValue = stateHandler(key);
                if (stateValue !== undefined) {
                    return stateValue;
                }
            }

            // Handle $files method for tables (reactive file arrays)
            if (key === '$files' && filesMethod) {
                return filesMethod;
            }

            return target[key];
        }
    });
}

/**
 * Register the $x magic method with Alpine
 * @param {Function} loadDataSource - Function to load data sources
 */
function registerXMagicMethod(loadDataSource) {
    // Ensure Alpine is loaded before registering magic method
    if (typeof Alpine === 'undefined') {
        console.error('[Manifest Data] Alpine.js must be loaded before manifest.data.js');
        return;
    }

    // Store the proxy-creating function so we can access it directly
    let $xProxyFactory = null;

    // CRITICAL: Return the same proxy instance every time so the re-entrancy guard (magicGetDepth)
    // works. If we created a new proxy per magic('x') call, each would have its own depth and we'd
    // never see depth > 1 when Alpine re-enters during store reads.
    let cachedMagicProxy = null;

    const magicFunction = (el) => {
        if (cachedMagicProxy) return cachedMagicProxy;

        // Alpine passes the element as the first parameter, but we don't need it
        if (!window._manifestXAccessed) {
            window._manifestXAccessed = true;
        }
        const pendingLoads = new Map();
        const store = Alpine.store('data');

        // Store loadDataSource in closure for Appwrite methods
        const reloadDataSource = loadDataSource;

        // Track active property accesses to prevent circular references
        // Use a symbol to store the active props set on each proxy call
        const ACTIVE_PROPS = Symbol('activeProps');

        // Re-entrancy guard: deep recursion when reading the store can cause stack overflow.
        // Use a high threshold so we only break true overflow; Alpine may re-enter once when
        // we read Alpine.store('data'), and we must return real data for that to render.
        let magicGetDepth = 0;
        const MAGIC_GET_MAX_DEPTH = 12;


        cachedMagicProxy = new Proxy({}, {
            get(target, prop) {
                magicGetDepth++;
                const propStr = String(prop);
                if (magicGetDepth > MAGIC_GET_MAX_DEPTH) {
                    magicGetDepth--;
                    const fallback = window.ManifestDataProxiesCore?.getChainingFallback?.();
                    return fallback !== undefined ? fallback : '';
                }
                try {
                    // Handle special keys
                    if (prop === Symbol.iterator || prop === 'then' || prop === 'catch' || prop === 'finally') {
                        return undefined;
                    }

                    // CRITICAL: Resolve from raw data and cache BEFORE reading Alpine.store('data').
                    // Reading the store registers a reactive dependency and can trigger Alpine to re-run
                    // the current effect (e.g. :aria-label="$x.content.theme.light"). If we haven't cached
                    // yet, the re-run calls get(proxy, 'content') again and we read the store again → stack overflow.
                    // By using getRawData (non-reactive) first and caching the nested proxy, the re-run hits
                    // the cache and returns without touching the store.
                    const getRawDataEarly = window.ManifestDataStore?.getRawData;
                    const rawValueEarly = getRawDataEarly ? getRawDataEarly(prop) : null;
                    if (!window.ManifestDataProxiesCore.nestedDataSourceProxyCache) {
                        window.ManifestDataProxiesCore.nestedDataSourceProxyCache = new Map();
                    }
                    const nestedCache = window.ManifestDataProxiesCore.nestedDataSourceProxyCache;
                    const hasData = rawValueEarly !== undefined && rawValueEarly !== null;
                    {
                        if (nestedCache.has(prop) && hasData) {
                            const cachedProxy = nestedCache.get(prop);
                            if (cachedProxy) {
                                // Subscribe to store so locale change (updateStore) triggers re-run; we only read _dataVersion, still return cached proxy.
                                const store = Alpine.store('data');
                                void (store && store._dataVersion);
                                return cachedProxy;
                            }
                        }
                        if (nestedCache.has(prop) && !hasData) nestedCache.delete(prop);
                        // Build and cache from raw before any store read, for object data sources (e.g. content, manifest)
                        if (hasData && rawValueEarly && typeof rawValueEarly === 'object' && !Array.isArray(rawValueEarly)) {
                            const createNestedObjectProxy = window.ManifestDataProxies?.createNestedObjectProxy;
                            if (createNestedObjectProxy) {
                                try {
                                    const nestedProxy = createNestedObjectProxy(rawValueEarly, prop, reloadDataSource, []);
                                    if (nestedProxy) {
                                        nestedCache.set(prop, nestedProxy);
                                        void (Alpine.store('data') && Alpine.store('data')._dataVersion); // reactivity only
                                        return nestedProxy;
                                    }
                                } catch (e) {
                                    // fall through to normal path
                                }
                            }
                        }
                    }

                    // When we have no raw data yet: start load, subscribe so effect re-runs when data loads, then return loading proxy.
                    // We must read a store primitive (_dataVersion) so Alpine tracks the dependency; otherwise when
                    // updateStore runs the effect never re-runs and UI stays on loading proxy. We only read the version,
                    // never return store data, so no re-entry/stack overflow.
                    if (!hasData) {
                        if (!pendingLoads.has(prop)) {
                            const locale = typeof document !== 'undefined' && document.documentElement
                                ? document.documentElement.lang
                                : (typeof Alpine !== 'undefined' && Alpine.store('locale')?.current) || 'en';
                            pendingLoads.set(prop, Promise.resolve(loadDataSource(prop, locale)));
                            pendingLoads.get(prop).finally(() => {
                                setTimeout(() => pendingLoads.delete(prop), 1000);
                            });
                        }
                        const store = Alpine.store('data');
                        void (store && store._dataVersion);
                        const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
                        if (createLoadingProxy) {
                            return createLoadingProxy(prop);
                        }
                        return window.ManifestDataProxiesCore?.getChainingFallback?.() ?? '';
                    }

                    // Get current store for paths that need it (arrays, or object with raw data for cache/consistency)
                    const currentStoreForCache = Alpine.store('data');
                    void (currentStoreForCache && currentStoreForCache._dataVersion);

                    // Don't use activeProps circular check here: reading Alpine.store() can trigger Alpine to
                    // re-run effects that evaluate $x.json again, so we get re-entrant get(proxy, 'json') while
                    // the first call is still running. Treating that as "circular" returned a loading proxy and
                    // broke rendering. Stack overflow is prevented by MAGIC_GET_MAX_DEPTH instead.
                    const propKey = String(prop);
                    const activeProps = target[ACTIVE_PROPS] || (target[ACTIVE_PROPS] = new Set());

                    try {
                        // Use store already read above (currentStoreForCache) for reactivity; use same ref for consistency
                        const currentStore = currentStoreForCache;

                        // Handle state properties ($loading, $error, $ready)
                        if (prop === '$loading' || prop === '$error' || prop === '$ready') {
                            return undefined;
                        }

                        // Get raw data first (unproxied) to check if it's an array
                        const getRawData = window.ManifestDataStore?.getRawData;
                        const rawValue = getRawData ? getRawData(prop) : null;

                        // Get value from Alpine store (may be proxied)
                        // CRITICAL: We need to access currentStore[prop] for Alpine reactivity to work
                        // But we'll use rawValue when creating nested proxies to avoid circular references
                        let value = currentStore[prop];

                        // If value exists in store, return it immediately with proper proxy
                        if (value !== undefined && value !== null || rawValue !== undefined && rawValue !== null) {
                            // Clear any cached loading proxy for this data source
                            const globalAccessCache = window.ManifestDataProxies?.globalAccessCache;
                            const cache = globalAccessCache?.get(prop);
                            if (cache && globalAccessCache) {
                                globalAccessCache.delete(prop);
                            }

                            // Check if it's an array - prefer raw value check (unproxied)
                            const rawIsArray = rawValue !== null && rawValue !== undefined && Array.isArray(rawValue);
                            const valueIsArray = Array.isArray(value);

                            // Check for array-like properties
                            const checkArrayLike = (val) => {
                                if (!val || typeof val !== 'object') return false;
                                const hasLength = 'length' in val && typeof val.length === 'number' &&
                                    val.length >= 0 && !isNaN(val.length);
                                if (!hasLength) return false;
                                const hasNumericIndices = val.length === 0 ||
                                    (val.length > 0 && (
                                        '0' in val ||
                                        0 in val ||
                                        typeof val[0] !== 'undefined' ||
                                        typeof val['0'] !== 'undefined'
                                    ));
                                return hasNumericIndices;
                            };

                            const rawIsArrayLike = rawValue !== null && rawValue !== undefined && checkArrayLike(rawValue);
                            const valueIsArrayLike = value !== null && value !== undefined && checkArrayLike(value);

                            const isArray = rawIsArray || valueIsArray || rawIsArrayLike || valueIsArrayLike;

                            // For arrays, use the specialized array proxy which has better iteration support
                            if (isArray) {
                                const createArrayProxyWithRoute = window.ManifestDataProxies?.createArrayProxyWithRoute;
                                if (createArrayProxyWithRoute) {
                                    // Use raw value for proxy creation to avoid Alpine proxy issues
                                    let arrayToProxy = null;
                                    if (rawIsArray) {
                                        arrayToProxy = rawValue;
                                    } else if (valueIsArray) {
                                        arrayToProxy = value;
                                    } else if (rawIsArrayLike && rawValue) {
                                        try {
                                            arrayToProxy = Array.from(rawValue);
                                        } catch (e) {
                                            try {
                                                arrayToProxy = [];
                                                for (let i = 0; i < rawValue.length; i++) {
                                                    arrayToProxy[i] = rawValue[i];
                                                }
                                            } catch (e2) {
                                                arrayToProxy = rawValue;
                                            }
                                        }
                                    } else if (valueIsArrayLike && value) {
                                        try {
                                            arrayToProxy = Array.from(value);
                                        } catch (e) {
                                            try {
                                                arrayToProxy = [];
                                                for (let i = 0; i < value.length; i++) {
                                                    arrayToProxy[i] = value[i];
                                                }
                                            } catch (e2) {
                                                arrayToProxy = value;
                                            }
                                        }
                                    }

                                    if (arrayToProxy && (Array.isArray(arrayToProxy) || rawIsArrayLike || valueIsArrayLike)) {
                                        // CRITICAL CHANGE: Use attachArrayMethods instead of createArrayProxyWithRoute
                                        // Alpine wraps our proxy and can't see methods defined on the proxy object
                                        // By attaching methods directly to the array, Alpine can see them even when it wraps
                                        const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
                                        const arrayForMethods = valueIsArray ? value : (rawIsArray ? rawValue : arrayToProxy);

                                        if (attachArrayMethods) {
                                            const arrayWithMethods = attachArrayMethods(arrayForMethods, prop, loadDataSource);
                                            // CRITICAL: Wrap in a proxy with has() trap so Alpine can see $search, $query, etc.
                                            // Alpine uses has() to check if properties exist before accessing them
                                            return new Proxy(arrayWithMethods, {
                                                get(target, key) {
                                                    // CRITICAL: Explicitly handle base plugin methods first
                                                    if (key === '$search' || key === '$query' || key === '$route') {
                                                        if (key in target && typeof target[key] === 'function') {
                                                            return target[key].bind(target);
                                                        }
                                                        // Appwrite sources intentionally skip the client-side
                                                        // $query attachment (see attachArrayMethods comment:
                                                        // "Appwrite sources will get their $query from the
                                                        // Appwrite plugin"). Delegate to the Appwrite methods
                                                        // handler so the click hits the backend instead of
                                                        // silently falling through to `undefined` or, in some
                                                        // proxy paths, a no-op `() => []`. Without this, demo
                                                        // sort/query buttons appear to do nothing — no console
                                                        // error, no network request — because the call resolves
                                                        // to the chaining fallback's stub `queryFn`.
                                                        if (key === '$query' || key === '$search') {
                                                            const createAppwriteMethodsHandler = window.ManifestDataProxiesAppwrite?.createAppwriteMethodsHandler;
                                                            if (createAppwriteMethodsHandler) {
                                                                try {
                                                                    const manifest = window.ManifestComponentsRegistry?.manifest || null;
                                                                    const dataSource = manifest?.data?.[prop] || manifest?.appwrite?.[prop];
                                                                    if (dataSource && window.ManifestDataConfig?.isAppwriteCollection?.(dataSource)) {
                                                                        const methodsHandler = createAppwriteMethodsHandler(prop, loadDataSource);
                                                                        return methodsHandler.bind(null, key);
                                                                    }
                                                                } catch { /* fall through */ }
                                                            }
                                                        }
                                                    }
                                                    // Forward all other property access to the target array
                                                    const value = target[key];
                                                    // If it's a function, bind it to the target
                                                    if (typeof value === 'function') {
                                                        return value.bind(target);
                                                    }
                                                    return value;
                                                },
                                                has(target, key) {
                                                    // Report that base plugin methods exist
                                                    if (key === '$search' || key === '$query' || key === '$route' ||
                                                        key === '$loading' || key === '$error' || key === '$ready') {
                                                        return key in target;
                                                    }
                                                    // Report that array methods exist
                                                    if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                                                        return true;
                                                    }
                                                    // Check if key exists on target
                                                    return key in target;
                                                },
                                                getOwnPropertyDescriptor(target, prop) {
                                                    // Return descriptor if it exists on target
                                                    const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
                                                    if (descriptor) return descriptor;
                                                    // For base plugin methods, return a descriptor even if not found
                                                    if (prop === '$search' || prop === '$query' || prop === '$route') {
                                                        return {
                                                            enumerable: false,
                                                            configurable: true,
                                                            get: function () {
                                                                return target[prop];
                                                            }
                                                        };
                                                    }
                                                    return undefined;
                                                }
                                            });
                                        } else {
                                            return arrayForMethods;
                                        }
                                    }
                                }
                            }

                            // For non-arrays (objects), check if they contain nested arrays
                            if (value && typeof value === 'object' && !Array.isArray(value) && value !== null) {
                                // Use nested object proxy to handle arrays within objects
                                // CRITICAL: Cache nested proxies at $x level to prevent infinite loops
                                // When Alpine re-evaluates expressions, it accesses $x.example again
                                // If we create a new proxy each time, Alpine sees it as a "new" object and re-evaluates again
                                if (!window.ManifestDataProxiesCore.nestedDataSourceProxyCache) {
                                    window.ManifestDataProxiesCore.nestedDataSourceProxyCache = new Map();
                                }
                                const nestedCache = window.ManifestDataProxiesCore.nestedDataSourceProxyCache;

                                // Check cache first - use data source name as key
                                // CRITICAL: Always return cached proxy if it exists to prevent infinite loops
                                // When Alpine re-evaluates expressions, it accesses $x.example again
                                // If we return the same proxy instance, Alpine won't see it as "new" and won't re-evaluate
                                // NOTE: This cache check is redundant now (we check earlier), but keeping for safety
                                if (nestedCache.has(prop)) {
                                    const cachedProxy = nestedCache.get(prop);
                                    if (cachedProxy) {
                                        activeProps.delete(propKey);
                                        return cachedProxy;
                                    } else {
                                    }
                                } else {
                                }

                                // Clear cache entry if it exists but is invalid (safety check)
                                if (nestedCache.has(prop) && !nestedCache.get(prop)) {
                                    nestedCache.delete(prop);
                                }

                                const createNestedObjectProxy = window.ManifestDataProxies?.createNestedObjectProxy;
                                if (createNestedObjectProxy) {

                                    // CRITICAL: MUST use rawValue, never value (Alpine-wrapped)
                                    // Using Alpine-wrapped value causes infinite recursion when Alpine wraps our proxy
                                    // and accesses properties (e.g. :aria-label="$x.content.theme.light"), triggering
                                    // reactivity that re-evaluates the expression and re-enters this get → stack overflow.
                                    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
                                        activeProps.delete(propKey);
                                        const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
                                        return createLoadingProxy ? createLoadingProxy(prop) : (window.ManifestDataProxiesCore?.getChainingFallback?.() ?? '');
                                    }

                                    const objectToProxy = rawValue;

                                    // Pass empty path array for top-level data sources
                                    let nestedProxy;
                                    try {
                                        nestedProxy = createNestedObjectProxy(objectToProxy, prop, loadDataSource, []);
                                    } catch (e) {
                                        // Fallback: return raw value directly
                                        activeProps.delete(propKey);
                                        return rawValue;
                                    }

                                    // Cache the nested proxy - this prevents creating new proxies on each access
                                    if (nestedProxy) {
                                        nestedCache.set(prop, nestedProxy);
                                    } else {
                                        // If nested proxy creation failed, return raw value as fallback
                                        activeProps.delete(propKey);
                                        return rawValue;
                                    }

                                    // CRITICAL: Remove from activeProps AFTER caching but BEFORE returning
                                    // This ensures the proxy is cached before Alpine can trigger another access
                                    activeProps.delete(propKey);

                                    // CRITICAL: Return the cached proxy immediately
                                    // Don't do anything else that might trigger Alpine reactivity
                                    return nestedProxy;
                                }
                            }

                            // For non-arrays, return value directly (will be proxied later if needed)
                            activeProps.delete(propKey); // Remove from active set before returning
                            return value !== undefined && value !== null ? value : rawValue;
                        } else {
                            // Check if we have a cached loading proxy
                            const globalAccessCache = window.ManifestDataProxies?.globalAccessCache;
                            const cache = globalAccessCache?.get(prop);
                            if (cache && cache.has('loading')) {
                                return cache.get('loading');
                            }
                        }

                        // Check for recent error BEFORE attempting to load (prevents infinite retries)
                        const stateKey = `_${prop}_state`;
                        const state = currentStore[stateKey] || {};
                        const hasRecentError = state.error && state.errorTime && (Date.now() - state.errorTime < 10000);

                        // If there's a recent error, return a loading proxy that shows the error state
                        if (hasRecentError) {
                            const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
                            if (createLoadingProxy) {
                                const errorProxy = new Proxy(createLoadingProxy(prop), {
                                    get(target, key) {
                                        if (key === '$loading') return false;
                                        if (key === '$error') return state.error;
                                        if (key === '$ready') return false;
                                        return target[key];
                                    }
                                });
                                // Cache this error proxy to prevent repeated creation
                                const globalAccessCache = window.ManifestDataProxies?.globalAccessCache;
                                if (globalAccessCache) {
                                    if (!globalAccessCache.has(prop)) {
                                        globalAccessCache.set(prop, new Map());
                                    }
                                    globalAccessCache.get(prop).set('error', errorProxy);
                                }
                                return errorProxy;
                            }
                        }

                        // Use HTML lang as source of truth, fallback to Alpine store, then 'en'
                        const currentLocale = document.documentElement.lang || Alpine.store('locale')?.current || 'en';

                        // If not in raw store, try to load it
                        if (!value && !pendingLoads.has(prop) && !hasRecentError) {
                            // Check if this is an Appwrite data source - if so, attach methods even before loading
                            let isAppwriteSource = false;
                            let isArrayDataSource = false;
                            try {
                                // Check both manifest.data and manifest.appwrite for data sources
                                const manifest = window.ManifestComponentsRegistry?.manifest || null;
                                let dataSource = null;

                                if (manifest) {
                                    // First check manifest.data (for local files, APIs, etc.)
                                    if (manifest.data?.[prop]) {
                                        dataSource = manifest.data[prop];
                                    }
                                    // Then check manifest.appwrite (for Appwrite collections/buckets)
                                    else if (manifest.appwrite?.[prop]) {
                                        dataSource = manifest.appwrite[prop];
                                    }

                                    if (dataSource) {
                                        isAppwriteSource = window.ManifestDataConfig.isAppwriteCollection(dataSource);
                                        // Check if this should be an array (CSV, JSON array, or Appwrite collection)
                                        // Objects (key-value) are not arrays
                                        const sourceType = dataSource.type || dataSource.source;
                                        isArrayDataSource = sourceType === 'csv' ||
                                            sourceType === 'json' ||
                                            sourceType === 'yaml' ||
                                            isAppwriteSource;
                                    }
                                }
                            } catch (e) {
                                // Silently handle errors
                            }

                            // Wait a tick to ensure localization plugin has initialized
                            const loadPromise = new Promise(resolve => {
                                setTimeout(() => {
                                    const finalLocale = document.documentElement.lang || Alpine.store('locale')?.current || 'en';
                                    const result = loadDataSource(prop, finalLocale);
                                    resolve(result);
                                }, 0);
                            });
                            pendingLoads.set(prop, loadPromise);

                            // For array data sources, return an empty array with methods attached
                            // This allows .map(), .filter(), etc. to work even before data loads
                            // CRITICAL: Use attachArrayMethods to attach methods directly to the array
                            // This ensures Alpine can see them even when it wraps the array
                            if (isArrayDataSource) {
                                const emptyArray = [];
                                const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
                                if (attachArrayMethods) {
                                    const arrayWithMethods = attachArrayMethods(emptyArray, prop, reloadDataSource);
                                    // CRITICAL: Wrap in a proxy with has() trap so Alpine can see $search, $query, etc.
                                    return new Proxy(arrayWithMethods, {
                                        get(target, key) {
                                            // CRITICAL: Explicitly handle base plugin methods first
                                            if (key === '$search' || key === '$query' || key === '$route') {
                                                if (key in target && typeof target[key] === 'function') {
                                                    return target[key].bind(target);
                                                }
                                            }
                                            const value = target[key];
                                            if (typeof value === 'function') {
                                                return value.bind(target);
                                            }
                                            return value;
                                        },
                                        has(target, key) {
                                            // Always report that base plugin methods exist (we provide fallbacks)
                                            if (key === '$search' || key === '$query' || key === '$route' ||
                                                key === '$loading' || key === '$error' || key === '$ready') {
                                                return true;
                                            }
                                            if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                                                return true;
                                            }
                                            return key in target;
                                        },
                                        getOwnPropertyDescriptor(target, prop) {
                                            const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
                                            if (descriptor) return descriptor;
                                            if (prop === '$search' || prop === '$query' || prop === '$route') {
                                                return {
                                                    enumerable: false,
                                                    configurable: true,
                                                    get: function () {
                                                        return target[prop];
                                                    }
                                                };
                                            }
                                            return undefined;
                                        }
                                    });
                                }
                                return emptyArray;
                            }

                            // Create loading proxy with or without Appwrite methods
                            let proxy;
                            if (isAppwriteSource) {
                                proxy = createAppwriteLoadingProxy(prop, reloadDataSource);
                            } else {
                                proxy = createBasicLoadingProxy(prop);
                            }

                            // Cache loading proxy globally
                            const globalAccessCache = window.ManifestDataProxies?.globalAccessCache;
                            if (globalAccessCache) {
                                if (!globalAccessCache.has(prop)) {
                                    globalAccessCache.set(prop, new Map());
                                }
                                globalAccessCache.get(prop).set('loading', proxy);
                            }

                            // Clear cache when loaded (or failed)
                            loadPromise.finally(() => {
                                const globalAccessCache = window.ManifestDataProxies?.globalAccessCache;
                                const cache = globalAccessCache?.get(prop);
                                if (cache) {
                                    cache.delete('loading');
                                    if (cache.size === 0 && globalAccessCache) {
                                        globalAccessCache.delete(prop);
                                    }
                                }
                                // Only clear pendingLoads after a delay to prevent rapid retries
                                setTimeout(() => {
                                    pendingLoads.delete(prop);
                                }, 1000);
                            });

                            activeProps.delete(propKey); // Remove from active set before returning
                            return proxy;
                        }

                        // This code should not be reached if value exists (handled above)
                        // But keeping as fallback for edge cases
                        if (value !== undefined && value !== null) {
                            // For arrays, attach methods directly (no proxy wrapper)
                            if (Array.isArray(value)) {
                                const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
                                if (attachArrayMethods) {
                                    const arrayWithMethods = attachArrayMethods(value, prop, loadDataSource);
                                    // CRITICAL: Wrap in a proxy with has() trap so Alpine can see $search, $query, etc.
                                    return new Proxy(arrayWithMethods, {
                                        get(target, key) {
                                            // Handle base plugin methods with fallbacks
                                            if (key === '$search' || key === '$query') {
                                                if (target && typeof target === 'object' && key in target && typeof target[key] === 'function') {
                                                    return target[key].bind(target);
                                                }
                                                // Appwrite-source delegation: $query is intentionally
                                                // not attached to Appwrite arrays by attachArrayMethods
                                                // (it requires a backend round-trip). Route to the
                                                // Appwrite methods handler instead of the no-op fallback
                                                // so sort/query/search buttons actually fire requests.
                                                const createAppwriteMethodsHandler = window.ManifestDataProxiesAppwrite?.createAppwriteMethodsHandler;
                                                if (createAppwriteMethodsHandler) {
                                                    try {
                                                        const manifest = window.ManifestComponentsRegistry?.manifest || null;
                                                        const dataSource = manifest?.data?.[prop] || manifest?.appwrite?.[prop];
                                                        if (dataSource && window.ManifestDataConfig?.isAppwriteCollection?.(dataSource)) {
                                                            const methodsHandler = createAppwriteMethodsHandler(prop, loadDataSource);
                                                            return methodsHandler.bind(null, key);
                                                        }
                                                    } catch { /* fall through */ }
                                                }
                                                // Fallback: return safe function that returns empty array
                                                return function () {
                                                    return [];
                                                };
                                            }
                                            if (key === '$route') {
                                                if (target && typeof target === 'object' && key in target && typeof target[key] === 'function') {
                                                    return target[key].bind(target);
                                                }
                                                // Fallback for $route
                                                return function (pathKey) {
                                                    const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                                                    return createRouteProxy ? createRouteProxy(target, pathKey, prop) : new Proxy({}, { get: () => undefined });
                                                };
                                            }
                                            // Handle array methods
                                            if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                                                if (typeof target[key] === 'function') {
                                                    return target[key].bind(target);
                                                }
                                                return Array.prototype[key].bind(target);
                                            }
                                            return target[key];
                                        },
                                        has(target, key) {
                                            // Always report that base plugin methods exist (we provide fallbacks)
                                            if (key === '$search' || key === '$query' || key === '$route' ||
                                                key === '$loading' || key === '$error' || key === '$ready') {
                                                return true;
                                            }
                                            // Report that array methods exist
                                            if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                                                return true;
                                            }
                                            return key in target;
                                        },
                                        getOwnPropertyDescriptor(target, prop) {
                                            const descriptor = Reflect.getOwnPropertyDescriptor(target, prop);
                                            if (descriptor) return descriptor;
                                            // For base plugin methods, return a descriptor even if not found
                                            if (prop === '$search' || prop === '$query' || prop === '$route') {
                                                return {
                                                    enumerable: false,
                                                    configurable: true,
                                                    get: function () {
                                                        if (prop === '$search' || prop === '$query') {
                                                            return target[prop] || function () { return []; };
                                                        }
                                                        return target[prop] || function (pathKey) {
                                                            const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                                                            return createRouteProxy ? createRouteProxy(target, pathKey, prop) : new Proxy({}, { get: () => undefined });
                                                        };
                                                    }
                                                };
                                            }
                                            return undefined;
                                        }
                                    });
                                }
                                return value;

                                // Create data source proxy for arrays
                                const dataSourceProxy = new Proxy(value, {
                                    get(target, key) {
                                        // Handle special keys
                                        if (key === 'then' || key === 'catch' || key === 'finally') {
                                            return undefined;
                                        }

                                        // Handle state properties
                                        const stateHandler = window.ManifestDataProxiesMagic?.createStatePropertyHandler;
                                        if (stateHandler) {
                                            const stateValue = stateHandler(prop)(key);
                                            if (stateValue !== undefined) {
                                                return stateValue;
                                            }
                                        }

                                        // CRITICAL: Handle base plugin methods ($search, $route, $query) FIRST
                                        // These are attached directly to arrays by attachArrayMethods
                                        // Check BEFORE other handlers to ensure they're accessible even if Alpine wraps the array
                                        if (key === '$search' || key === '$query') {
                                            // Check if method exists on target (works even if Alpine wrapped it)
                                            if (target && typeof target === 'object' && key in target && typeof target[key] === 'function') {
                                                return target[key].bind(target);
                                            }
                                            // Fallback: return safe function that returns empty array
                                            // This prevents Alpine errors when method doesn't exist yet (during loading)
                                            return function () {
                                                return [];
                                            };
                                        }

                                        // Handle $route function
                                        if (key === '$route') {
                                            // First check if it exists as a method on the array
                                            if (target && typeof target === 'object' && key in target && typeof target[key] === 'function') {
                                                return target[key].bind(target);
                                            }
                                            // Otherwise create the function
                                            return function (pathKey) {
                                                if (target && typeof target === 'object') {
                                                    const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                                                    return createRouteProxy ? createRouteProxy(target, pathKey, prop) : new Proxy({}, { get: () => undefined });
                                                }
                                                return new Proxy({}, { get: () => undefined });
                                            };
                                        }

                                        // Handle pagination methods
                                        if ((key === '$first' || key === '$next' || key === '$prev' || key === '$page')) {
                                            const createPaginationMethod = window.ManifestDataProxiesMagic?.createPaginationMethod;
                                            if (createPaginationMethod) {
                                                return createPaginationMethod(key, prop);
                                            }
                                        }

                                        // Handle $files method
                                        if (key === '$files') {
                                            const createFilesMethod = window.ManifestDataProxiesMagic?.createFilesMethod;
                                            if (createFilesMethod) {
                                                return createFilesMethod(prop);
                                            }
                                        }

                                        // Handle Appwrite CRUD methods - delegate to Appwrite methods handler
                                        if (key === '$create' || key === '$update' || key === '$delete' || key === '$query' ||
                                            key === '$url' || key === '$download' || key === '$preview' || key === '$filesFor' ||
                                            key === '$unlinkFrom' || key === '$removeFrom' || key === '$remove') {
                                            const createAppwriteMethodsHandler = window.ManifestDataProxiesAppwrite?.createAppwriteMethodsHandler;
                                            if (createAppwriteMethodsHandler) {
                                                const methodsHandler = createAppwriteMethodsHandler(prop, reloadDataSource);
                                                return methodsHandler.bind(null, key);
                                            }
                                            // Fallback: throw helpful error if Appwrite plugin not loaded
                                            return async function (...args) {
                                                throw new Error(`[Manifest Data] Appwrite methods require manifest.appwrite.data.js plugin. Method "${key}" is not available.`);
                                            };
                                        }

                                        // Handle toPrimitive for text content
                                        if (key === Symbol.toPrimitive) {
                                            return function () { return ''; };
                                        }

                                        // Handle array-like behavior
                                        if (Array.isArray(target)) {
                                            if (key === 'length') {
                                                return target.length;
                                            }
                                            // Handle Symbol.iterator for array iteration
                                            if (key === Symbol.iterator) {
                                                return target[Symbol.iterator].bind(target);
                                            }
                                            // Handle numeric keys for array access
                                            if (typeof key === 'string' && !isNaN(Number(key))) {
                                                const index = Number(key);
                                                if (index >= 0 && index < target.length) {
                                                    const item = target[index];
                                                    // Return primitives directly, arrays via array proxy, objects via item proxy
                                                    if (item === null || item === undefined || typeof item !== 'object') {
                                                        return item;
                                                    }
                                                    if (Array.isArray(item)) {
                                                        const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
                                                        return attachArrayMethods ? attachArrayMethods(item, prop, reloadDataSource) : item;
                                                    }
                                                    const createArrayItemProxy = window.ManifestDataProxiesCore?.createArrayItemProxy;
                                                    return createArrayItemProxy ? createArrayItemProxy(item) : item;
                                                }
                                                const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
                                                return createLoadingProxy ? createLoadingProxy(prop) : {};
                                            }
                                            // CRITICAL: Handle ALL array methods - Alpine may access these before other handlers
                                            // Check if this is ANY array method from Array.prototype (like createArrayProxyWithRoute does)
                                            if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                                                // First try to use the method from the target if it exists and is callable
                                                if (typeof target[key] === 'function') {
                                                    const bound = target[key].bind(target);
                                                    // Ensure function has proper prototype for Alpine's instanceof checks
                                                    Object.setPrototypeOf(bound, Function.prototype);
                                                    return bound;
                                                }
                                                // Fallback: use Array.prototype method bound to target
                                                // This ensures methods work even if Alpine proxies the array
                                                const bound = Array.prototype[key].bind(target);
                                                Object.setPrototypeOf(bound, Function.prototype);
                                                return bound;
                                            }
                                        }

                                        // Handle undefined/null target gracefully
                                        if (target === null || target === undefined) {
                                            const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
                                            return createLoadingProxy ? createLoadingProxy(prop) : {};
                                        }

                                        // CRITICAL: If target is frozen, return properties directly without proxying
                                        // Frozen objects are plain copies returned from nested proxies to prevent recursion
                                        if (Object.isFrozen(target)) {
                                            const value = target[key];
                                            // Return primitives directly, don't proxy anything from frozen objects
                                            return value;
                                        }

                                        // Handle nested objects
                                        const nestedValue = target[key];

                                        if (nestedValue !== undefined && nestedValue !== null) {
                                            if (Array.isArray(nestedValue)) {
                                                // CRITICAL: For arrays accessed from dataSourceProxy (like $x.json.products),
                                                // we need to wrap them in a proxy that handles $route and array methods
                                                // at the proxy level, just like we do in createNestedObjectProxy
                                                const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
                                                let arrayWithMethods = nestedValue;
                                                if (attachArrayMethods) {
                                                    arrayWithMethods = attachArrayMethods(nestedValue, prop, reloadDataSource);
                                                }

                                                // Create a proxy that handles $route and array methods at the top level
                                                // This ensures Alpine's wrapper can see them (like Appwrite methods)
                                                const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                                                const dataSourceName = prop; // Capture outer prop (data source name like 'json')
                                                const arrayKey = key; // Capture the array property name (like 'products')

                                                // CRITICAL: Create a Proxy that properly forwards array methods AND Appwrite methods
                                                // This ensures both work even when Alpine wraps this proxy
                                                // We use a Proxy with proper get/has/getOwnPropertyDescriptor traps
                                                const appwriteMethodNames = ['$create', '$update', '$delete', '$query', '$url', '$download', '$preview', '$openUrl', '$openPreview', '$openDownload', '$filesFor', '$unlinkFrom', '$removeFrom', '$remove'];
                                                const baseMethodNames = ['$search', '$route', '$query']; // Base plugin methods available for all data sources

                                                return new Proxy(arrayWithMethods, {
                                                    get(target, prop) {
                                                        // Handle base plugin methods ($search, $route, $query)
                                                        if (prop === '$route' || prop === '$search' || prop === '$query') {
                                                            // Check if method exists on target
                                                            if (target && typeof target === 'object' && prop in target && typeof target[prop] === 'function') {
                                                                return target[prop].bind(target);
                                                            }
                                                            // Fallback: return safe function that returns empty array
                                                            // This prevents Alpine errors when method doesn't exist yet (during loading)
                                                            if (prop === '$search' || prop === '$query') {
                                                                return function () {
                                                                    return [];
                                                                };
                                                            }
                                                            // For $route, return a safe proxy
                                                            return function (pathKey) {
                                                                const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                                                                return createRouteProxy ? createRouteProxy(target, pathKey, dataSourceName) : new Proxy({}, { get: () => undefined });
                                                            };
                                                        }

                                                        // Handle state properties - access store directly to ensure Alpine tracks reactivity
                                                        if (prop === '$loading' || prop === '$error' || prop === '$ready') {
                                                            // Access the store directly so Alpine can track it
                                                            const store = Alpine.store('data');
                                                            if (!store) {
                                                                return prop === '$loading' ? false : (prop === '$error' ? null : false);
                                                            }
                                                            const stateKey = `_${dataSourceName}_state`;
                                                            const state = store[stateKey] || { loading: false, error: null, ready: false };
                                                            if (prop === '$loading') return state.loading || false;
                                                            if (prop === '$error') return state.error || null;
                                                            if (prop === '$ready') return state.ready || false;
                                                        }

                                                        // Handle Appwrite methods - these are attached to the array by attachArrayMethods
                                                        if (typeof prop === 'string' && appwriteMethodNames.includes(prop)) {
                                                            if (target && typeof target === 'object' && prop in target && typeof target[prop] === 'function') {
                                                                return target[prop].bind(target);
                                                            }
                                                            // Fallback for Appwrite methods
                                                            return async function (...args) {
                                                                throw new Error(`[Manifest Data] Appwrite methods require manifest.appwrite.data.js plugin. Method "${prop}" is not available.`);
                                                            };
                                                        }

                                                        // Handle base plugin methods - these are attached to the array by attachArrayMethods
                                                        if (typeof prop === 'string' && baseMethodNames.includes(prop)) {
                                                            if (target && typeof target === 'object' && prop in target && typeof target[prop] === 'function') {
                                                                return target[prop].bind(target);
                                                            }
                                                            // Fallback: return safe function that returns empty array
                                                            return function () {
                                                                return [];
                                                            };
                                                        }

                                                        // Handle array methods - ensure they're accessible
                                                        if (typeof prop === 'string' && typeof Array.prototype[prop] === 'function') {
                                                            // Try to get from target first (works if it's a real array)
                                                            if (typeof target[prop] === 'function') {
                                                                const bound = target[prop].bind(target);
                                                                Object.setPrototypeOf(bound, Function.prototype);
                                                                return bound;
                                                            }
                                                            // Fallback: bind from Array.prototype
                                                            const bound = Array.prototype[prop].bind(target);
                                                            Object.setPrototypeOf(bound, Function.prototype);
                                                            return bound;
                                                        }

                                                        // Forward all other properties
                                                        return target[prop];
                                                    },
                                                    has(target, prop) {
                                                        // State properties always exist
                                                        if (prop === '$loading' || prop === '$error' || prop === '$ready') {
                                                            return true;
                                                        }
                                                        // Base plugin methods always exist (we provide fallbacks)
                                                        if (typeof prop === 'string' && baseMethodNames.includes(prop)) {
                                                            return true;
                                                        }
                                                        // Array methods always exist
                                                        if (typeof prop === 'string' && typeof Array.prototype[prop] === 'function') {
                                                            return true;
                                                        }
                                                        // Appwrite methods exist if attached
                                                        if (typeof prop === 'string' && appwriteMethodNames.includes(prop)) {
                                                            return prop in target;
                                                        }
                                                        return prop in target;
                                                    },
                                                    getOwnPropertyDescriptor(target, prop) {
                                                        // Return descriptors for state properties
                                                        if (prop === '$loading' || prop === '$error' || prop === '$ready') {
                                                            // Return a getter descriptor that accesses the store
                                                            return {
                                                                enumerable: false,
                                                                configurable: true,
                                                                get: function () {
                                                                    const store = Alpine.store('data');
                                                                    if (!store) {
                                                                        return prop === '$loading' ? false : (prop === '$error' ? null : false);
                                                                    }
                                                                    const stateKey = `_${dataSourceName}_state`;
                                                                    const state = store[stateKey] || { loading: false, error: null, ready: false };
                                                                    if (prop === '$loading') return state.loading || false;
                                                                    if (prop === '$error') return state.error || null;
                                                                    if (prop === '$ready') return state.ready || false;
                                                                }
                                                            };
                                                        }
                                                        // Return descriptors for array methods
                                                        if (typeof prop === 'string' && typeof Array.prototype[prop] === 'function') {
                                                            const method = Array.prototype[prop];
                                                            return {
                                                                enumerable: false,
                                                                configurable: true,
                                                                writable: true,
                                                                value: method.bind(target)
                                                            };
                                                        }
                                                        // Return descriptors for base plugin methods if they exist
                                                        if (typeof prop === 'string' && baseMethodNames.includes(prop) && prop in target) {
                                                            return Reflect.getOwnPropertyDescriptor(target, prop);
                                                        }
                                                        // Return descriptors for Appwrite methods if they exist
                                                        if (typeof prop === 'string' && appwriteMethodNames.includes(prop) && prop in target) {
                                                            return Reflect.getOwnPropertyDescriptor(target, prop);
                                                        }
                                                        return Reflect.getOwnPropertyDescriptor(target, prop);
                                                    }
                                                });
                                            }
                                            // Only create proxy for objects, return primitives directly
                                            if (typeof nestedValue === 'object' && nestedValue !== null) {
                                                // CRITICAL: If object is frozen, return it directly without proxying
                                                // Frozen objects are plain copies returned from nested proxies to prevent recursion
                                                if (Object.isFrozen(nestedValue)) {
                                                    return nestedValue;
                                                }
                                                const createNestedObjectProxy = window.ManifestDataProxies?.createNestedObjectProxy;
                                                if (createNestedObjectProxy) {
                                                    try {
                                                        return createNestedObjectProxy(nestedValue, prop, reloadDataSource);
                                                    } catch (error) {
                                                        throw error;
                                                    }
                                                }
                                                return nestedValue;
                                            }
                                            // Return primitive values directly
                                            return nestedValue;
                                        }
                                        // When nestedValue is undefined/null, return an empty array with methods attached
                                        // This ensures ($x.example.products || []) works correctly - the array will have $search/$query methods
                                        // We can't know if it should be an array, but returning an array with methods is safer than undefined
                                        // because it allows method chaining without errors
                                        const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
                                        const emptyArray = [];
                                        if (attachArrayMethods) {
                                            return attachArrayMethods(emptyArray, prop, reloadDataSource);
                                        }
                                        return emptyArray;
                                    }
                                });

                                // Cache the proxy before returning
                                window.ManifestDataProxiesCore.dataSourceProxyCache.set(value, dataSourceProxy);
                                return dataSourceProxy;
                            }

                            // Handle non-array objects - use nested object proxy
                            const createNestedObjectProxy = window.ManifestDataProxies?.createNestedObjectProxy;
                            if (createNestedObjectProxy) {
                                const nestedProxy = createNestedObjectProxy(value, prop, reloadDataSource);
                                window.ManifestDataProxiesCore.dataSourceProxyCache.set(value, nestedProxy);
                                return nestedProxy;
                            }
                            return value;
                        }

                        // Handle undefined/null values - return loading proxy
                        activeProps.delete(propKey); // Remove from active set before returning
                        const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
                        return createLoadingProxy ? createLoadingProxy(prop) : {};
                    } catch (e) {
                        // If any error occurs, clean up and return loading proxy
                        activeProps.delete(propKey);
                        const createLoadingProxy = window.ManifestDataProxiesCore?.createLoadingProxy;
                        return createLoadingProxy ? createLoadingProxy(prop) : {};
                    } finally {
                        // Always remove so the same prop can be read again (e.g. Alpine re-evaluating $x.products).
                        // Without this, NO_STORE_DATA and other paths left prop in activeProps and the next
                        // get(proxy, prop) was wrongly treated as CIRCULAR.
                        activeProps.delete(propKey);
                    }
                } finally {
                    magicGetDepth--;
                }
            },
            has(target, prop) {
                // For arrays, check if property exists on the array
                if (Array.isArray(target)) {
                    if (prop === 'length' || typeof prop === 'number' || prop === Symbol.iterator) {
                        return prop in target;
                    }
                }
                // Make all string properties appear to exist to prevent Alpine from trying to access them
                if (typeof prop === 'string') {
                    return true;
                }
                return prop === Symbol.iterator || prop === Symbol.toPrimitive;
            }
        });
        return cachedMagicProxy;
    };

    // Store the factory function for direct access
    $xProxyFactory = magicFunction;

    // Register with Alpine
    Alpine.magic('x', magicFunction);

    // Also store it on window for direct access (bypasses Alpine magic method system)
    if (typeof window !== 'undefined') {
        window._$xProxyFactory = $xProxyFactory;
        window.__manifestDataMagicRegistered = true;
        // manifest:data-ready is dispatched by the data plugin after init (including content pre-load), not here
    }
}

// Register $try magic method for cleaner async error handling
// Usage: $try(() => $x.assets.$removeFrom(...), 'assetsError')
if (typeof Alpine !== 'undefined' && typeof Alpine.magic === 'function') {
    if (!window.__manifestTryMagicRegistered) {
        window.__manifestTryMagicRegistered = true;
        Alpine.magic('try', (el) => {
            return async (asyncFn, errorVar = null) => {
                try {
                    const result = await (typeof asyncFn === 'function' ? asyncFn() : asyncFn);
                    if (errorVar && el) {
                        const scope = Alpine.$data(el);
                        if (scope && typeof scope[errorVar] !== 'undefined') {
                            scope[errorVar] = null;
                        }
                    }
                    return result;
                } catch (error) {
                    if (errorVar && el) {
                        const scope = Alpine.$data(el);
                        if (scope && typeof scope[errorVar] !== 'undefined') {
                            scope[errorVar] = error.message || 'Operation failed';
                        }
                    }
                    // Don't throw - return undefined on error so caller can handle gracefully
                    return undefined;
                }
            };
        });
    }

    // Note: window.$x getter is defined at module load time (top of file)
    // so it's available immediately, even before registerXMagicMethod is called
}

// Clear nested proxy cache for a specific data source (called when store updates)
function clearNestedProxyCacheForDataSource(dataSourceName) {
    if (!dataSourceName || !window.ManifestDataProxiesCore?.nestedDataSourceProxyCache) return;
    window.ManifestDataProxiesCore.nestedDataSourceProxyCache.delete(dataSourceName);
}

// Export function to window for use by other subscripts
if (!window.ManifestDataProxies) {
    window.ManifestDataProxies = {};
}
window.ManifestDataProxies.registerXMagicMethod = registerXMagicMethod;
window.ManifestDataProxies.clearNestedProxyCacheForDataSource = clearNestedProxyCacheForDataSource;