/* Manifest Data Sources - Array Proxy Creation */
// Create proxies for arrays with $route() support and array method attachment
// Use a Map for caching when dataSourceName is provided (since WeakMap can't use string keys)
const arrayProxyCacheWithDataSource = new Map();

// Array methods to attach to proxies (shared constant)
const ARRAY_METHODS = ['map', 'filter', 'find', 'findIndex', 'some', 'every',
    'reduce', 'forEach', 'slice', 'includes', 'indexOf',
    'concat', 'join', 'push', 'pop', 'shift', 'unshift',
    'splice', 'sort', 'reverse', 'flat', 'flatMap',
    'entries', 'keys', 'values', 'copyWithin', 'fill'];

// Clear array proxy cache for a specific data source (called when store updates)
function clearArrayProxyCacheForDataSource(dataSourceName) {
    if (!dataSourceName) return;
    const keysToDelete = [];
    for (const [key] of arrayProxyCacheWithDataSource.entries()) {
        if (key.endsWith(`:${dataSourceName}`)) {
            keysToDelete.push(key);
        }
    }
    keysToDelete.forEach(key => arrayProxyCacheWithDataSource.delete(key));
}

// Track which arrays have methods attached to avoid re-attaching
const arraysWithMethodsAttached = new WeakSet();

// Attach methods directly to an array (no proxy wrapper)
// This allows Alpine to track the array directly for reactivity
function attachArrayMethods(array, dataSourceName, reloadDataSource) {
    // Skip if already has methods attached
    if (arraysWithMethodsAttached.has(array)) {
        return array;
    }

    // Check if it's an array (Alpine proxies might not pass Array.isArray check)
    const isArray = Array.isArray(array) || (
        array && typeof array === 'object' &&
        'length' in array && typeof array.length === 'number' &&
        array.length >= 0
    );

    // Skip if not an array-like object
    if (!isArray) {
        return array;
    }

    // Mark as having methods attached
    arraysWithMethodsAttached.add(array);

    // Attach state properties ($loading, $error, $ready) as getters
    // These need to be accessible on the array for Alpine expressions like $x.assets.$ready
    Object.defineProperty(array, '$loading', {
        enumerable: false,
        configurable: true,
        get: function () {
            const store = Alpine.store('data');
            if (!store) return false;
            const stateKey = `_${dataSourceName}_state`;
            const state = store[stateKey] || { loading: false, error: null, ready: false };
            return state.loading || false;
        }
    });

    Object.defineProperty(array, '$error', {
        enumerable: false,
        configurable: true,
        get: function () {
            const store = Alpine.store('data');
            if (!store) return null;
            const stateKey = `_${dataSourceName}_state`;
            const state = store[stateKey] || { loading: false, error: null, ready: false };
            return state.error || null;
        }
    });

    Object.defineProperty(array, '$ready', {
        enumerable: false,
        configurable: true,
        get: function () {
            const store = Alpine.store('data');
            if (!store) return false;
            const stateKey = `_${dataSourceName}_state`;
            const state = store[stateKey] || { loading: false, error: null, ready: false };
            return state.ready || false;
        }
    });

    // Attach $search method for client-side text filtering
    Object.defineProperty(array, '$search', {
        enumerable: false,
        configurable: true,
        writable: false,
        value: function (searchTerm, ...attributes) {
            if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.trim() === '') {
                return array;
            }

            const term = searchTerm.toLowerCase().trim();
            const attrs = attributes.length > 0 ? attributes : Object.keys(array[0] || {});

            const filtered = array.filter(item => {
                if (!item || typeof item !== 'object') return false;
                return attrs.some(attr => {
                    const value = item[attr];
                    if (value == null) return false;
                    return String(value).toLowerCase().includes(term);
                });
            });

            // Attach methods to the filtered result so chaining works (e.g., .$search().$query())
            // This ensures the returned array has $query, $route, and other methods available
            attachArrayMethods(filtered, dataSourceName, reloadDataSource);

            return filtered;
        }
    });

    // Attach $route method
    Object.defineProperty(array, '$route', {
        enumerable: false,
        configurable: true,
        writable: false,
        value: function (pathKey) {
            const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
            if (!createRouteProxy) {
                return new Proxy({}, {
                    get() { return undefined; }
                });
            }
            if (array && typeof array === 'object') {
                // Get raw data to ensure we have the actual array (not Alpine proxy)
                const getRawData = window.ManifestDataStore?.getRawData;
                let dataToUse = array;

                // CRITICAL: Always try to get raw data first - this ensures we have the real array
                if (dataSourceName && getRawData) {
                    const rawData = getRawData(dataSourceName);
                    if (rawData && (Array.isArray(rawData) || (rawData.length !== undefined && rawData.length >= 0))) {
                        dataToUse = rawData;
                    }
                }

                // If we still don't have raw data, try to convert the proxy to a real array
                if (!Array.isArray(dataToUse) && dataToUse && typeof dataToUse === 'object' && 'length' in dataToUse) {
                    try {
                        // Try Array.from first (works for most iterables including Alpine proxies)
                        dataToUse = Array.from(dataToUse);
                    } catch (e) {
                        // Fallback: manual conversion
                        try {
                            const arr = [];
                            for (let i = 0; i < dataToUse.length; i++) {
                                arr[i] = dataToUse[i];
                            }
                            dataToUse = arr;
                        } catch (e2) {
                            // Last resort: try getting from store
                            const store = Alpine.store('data');
                            if (store && store[dataSourceName] && Array.isArray(store[dataSourceName])) {
                                dataToUse = Array.from(store[dataSourceName]);
                            }
                        }
                    }
                }

                // Ensure we have a real array before passing to createRouteProxy
                if (!Array.isArray(dataToUse) && dataToUse && typeof dataToUse === 'object' && 'length' in dataToUse) {
                    // Final attempt: convert to array
                    dataToUse = Array.from(dataToUse);
                }

                // Use the array directly - it should be the actual array, not a proxy
                // since attachArrayMethods is called on the array from the store
                return createRouteProxy(
                    dataToUse,
                    pathKey,
                    dataSourceName || undefined  // Always pass dataSourceName for proper raw data lookup
                );
            }
            return new Proxy({}, {
                get() { return undefined; }
            });
        }
    });

    // Attach $files method (for tables)
    if (dataSourceName) {
        const createFilesMethod = window.ManifestDataProxiesMagic?.createFilesMethod;
        if (createFilesMethod) {
            Object.defineProperty(array, '$files', {
                enumerable: false,
                configurable: true,
                writable: false,
                value: createFilesMethod(dataSourceName)
            });
        }

        // Attach $upload method (for tables only - checked at runtime)
        const createUploadMethod = window.ManifestDataProxiesMagic?.createUploadMethod;
        if (createUploadMethod) {
            Object.defineProperty(array, '$upload', {
                enumerable: false,
                configurable: true,
                writable: false,
                value: createUploadMethod(dataSourceName, reloadDataSource)
            });
        }
    }

    // Attach client-side $query (overridden by Appwrite if source is Appwrite)
    // Always attach even if dataSourceName empty (enables method chaining: .$search().$query())
    //
    // IMPORTANT: use the SYNCHRONOUS manifest accessor, not ensureManifest().
    // ensureManifest() is `async function` — calling it without `await` returns
    // a Promise, and `Promise.data` is undefined, so the Appwrite-detection
    // block silently fell through and isAppwriteSource stayed `false` for
    // EVERY source — including real Appwrite collections. That caused the
    // client-side $query to be attached to Appwrite arrays. The client-side
    // $query sorts/filters in-memory and returns the result (without mutating
    // the source), while demo code calls $query as a fire-and-forget store
    // mutation. Result: sort buttons silently no-op'd.
    //
    // window.__manifestLoaded and window.ManifestComponentsRegistry.manifest
    // are populated synchronously by the loader after the manifest fetch
    // resolves (see manifest.js loader: `window.__manifestLoaded = manifest`).
    // By the time any data source is being attached, they're available.
    let isAppwriteSource = false;
    if (dataSourceName) {
        try {
            const manifest = window.__manifestLoaded
                || window.ManifestComponentsRegistry?.manifest
                || null;
            const dataSource = manifest?.data?.[dataSourceName];
            if (dataSource && window.ManifestDataConfig?.isAppwriteCollection?.(dataSource)) {
                isAppwriteSource = true;
            }
        } catch (e) {
            // Manifest not ready yet - will attach client-side version, Appwrite can override later
        }
    }

    // Only attach client-side $query for non-Appwrite sources
    // Appwrite sources will get their $query from the Appwrite plugin (attached later)
    if (!isAppwriteSource && !array.hasOwnProperty('$query')) {
        Object.defineProperty(array, '$query', {
            enumerable: false,
            configurable: true,
            writable: false,
            value: function (queries) {
                if (!Array.isArray(queries) || queries.length === 0) {
                    return array;
                }

                let result = [...array];

                // Process each query in order
                for (const query of queries) {
                    if (!Array.isArray(query) || query.length === 0) continue;

                    const [method, ...args] = query;

                    // Filtering methods
                    if (method === 'equal' && args.length >= 2) {
                        const [attr, value] = args;
                        result = result.filter(item => item && item[attr] === value);
                    } else if (method === 'notEqual' && args.length >= 2) {
                        const [attr, value] = args;
                        result = result.filter(item => item && item[attr] !== value);
                    } else if (method === 'greaterThan' && args.length >= 2) {
                        const [attr, value] = args;
                        result = result.filter(item => item && item[attr] != null && item[attr] > value);
                    } else if (method === 'greaterThanOrEqual' && args.length >= 2) {
                        const [attr, value] = args;
                        result = result.filter(item => item && item[attr] != null && item[attr] >= value);
                    } else if (method === 'lessThan' && args.length >= 2) {
                        const [attr, value] = args;
                        result = result.filter(item => item && item[attr] != null && item[attr] < value);
                    } else if (method === 'lessThanOrEqual' && args.length >= 2) {
                        const [attr, value] = args;
                        result = result.filter(item => item && item[attr] != null && item[attr] <= value);
                    } else if (method === 'contains' && args.length >= 2) {
                        const [attr, value] = args;
                        const searchValue = String(value).toLowerCase();
                        result = result.filter(item => item && item[attr] != null && String(item[attr]).toLowerCase().includes(searchValue));
                    } else if (method === 'startsWith' && args.length >= 2) {
                        const [attr, value] = args;
                        const searchValue = String(value).toLowerCase();
                        result = result.filter(item => item && item[attr] != null && String(item[attr]).toLowerCase().startsWith(searchValue));
                    } else if (method === 'endsWith' && args.length >= 2) {
                        const [attr, value] = args;
                        const searchValue = String(value).toLowerCase();
                        result = result.filter(item => item && item[attr] != null && String(item[attr]).toLowerCase().endsWith(searchValue));
                    } else if (method === 'isNull' && args.length >= 1) {
                        const [attr] = args;
                        result = result.filter(item => item && (item[attr] == null || item[attr] === ''));
                    } else if (method === 'isNotNull' && args.length >= 1) {
                        const [attr] = args;
                        result = result.filter(item => item && item[attr] != null && item[attr] !== '');
                    } else if (method === 'between' && args.length >= 3) {
                        const [attr, min, max] = args;
                        result = result.filter(item => item && item[attr] != null && item[attr] >= min && item[attr] <= max);
                    }
                    // Sorting methods
                    else if (method === 'orderAsc' && args.length >= 1) {
                        const [attr] = args;
                        result.sort((a, b) => {
                            const aVal = a && a[attr];
                            const bVal = b && b[attr];
                            if (aVal == null && bVal == null) return 0;
                            if (aVal == null) return 1;
                            if (bVal == null) return -1;
                            if (typeof aVal === 'string' && typeof bVal === 'string') {
                                return aVal.localeCompare(bVal);
                            }
                            return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
                        });
                    } else if (method === 'orderDesc' && args.length >= 1) {
                        const [attr] = args;
                        result.sort((a, b) => {
                            const aVal = a && a[attr];
                            const bVal = b && b[attr];
                            if (aVal == null && bVal == null) return 0;
                            if (aVal == null) return 1;
                            if (bVal == null) return -1;
                            if (typeof aVal === 'string' && typeof bVal === 'string') {
                                return bVal.localeCompare(aVal);
                            }
                            return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
                        });
                    } else if (method === 'orderRandom') {
                        // Fisher-Yates shuffle
                        for (let i = result.length - 1; i > 0; i--) {
                            const j = Math.floor(Math.random() * (i + 1));
                            [result[i], result[j]] = [result[j], result[i]];
                        }
                    }
                    // Pagination methods
                    else if (method === 'limit' && args.length >= 1) {
                        const [limit] = args;
                        result = result.slice(0, parseInt(limit, 10));
                    } else if (method === 'offset' && args.length >= 1) {
                        const [offset] = args;
                        result = result.slice(parseInt(offset, 10));
                    }
                }

                // Attach methods to the filtered result so chaining works (e.g., .$query().$search())
                // This ensures the returned array has $search, $route, and other methods available
                attachArrayMethods(result, dataSourceName, reloadDataSource);

                return result;
            }
        });
    }

    // Attach Appwrite methods ($create, $update, $delete, etc.)
    if (dataSourceName) {
        // Check if this is an Appwrite source. Same sync-manifest fix as
        // the block above — ensureManifest() is async and returned a Promise
        // here too, so isAppwriteSource was always false and the Appwrite
        // $query was never attached, leaving sort/query buttons to silently
        // fall through to the client-side $query that returns a discarded
        // sorted array.
        let isAppwriteSource = false;
        try {
            const manifest = window.__manifestLoaded
                || window.ManifestComponentsRegistry?.manifest
                || null;
            const dataSource = manifest?.data?.[dataSourceName];
            if (dataSource && window.ManifestDataConfig?.isAppwriteCollection?.(dataSource)) {
                isAppwriteSource = true;
            }
        } catch (e) {
            // Manifest not ready yet - assume not Appwrite
        }

        const createAppwriteMethodsHandler = window.ManifestDataProxiesAppwrite?.createAppwriteMethodsHandler;
        if (createAppwriteMethodsHandler) {
            const methodsHandler = createAppwriteMethodsHandler(dataSourceName, reloadDataSource);
            // For Appwrite sources, include $query. For local sources, exclude it (base plugin handles it)
            const appwriteMethods = isAppwriteSource
                ? ['$create', '$update', '$delete', '$duplicate', '$query', '$url', '$download', '$preview', '$openUrl', '$openPreview', '$openDownload', '$filesFor', '$unlinkFrom', '$removeFrom', '$remove']
                : ['$create', '$update', '$delete', '$duplicate', '$url', '$download', '$preview', '$openUrl', '$openPreview', '$openDownload', '$filesFor', '$unlinkFrom', '$removeFrom', '$remove'];
            appwriteMethods.forEach(methodName => {
                // Skip if method already exists (e.g., base plugin's $query for local sources)
                if (methodName === '$query' && array.hasOwnProperty('$query') && !isAppwriteSource) {
                    return; // Don't override base plugin's $query for local sources
                }
                Object.defineProperty(array, methodName, {
                    enumerable: false,
                    configurable: true,
                    writable: false,
                    value: async function (...args) {
                        // Safe wrapper: methods handler will handle all checks internally
                        try {
                            return await methodsHandler(methodName, ...args);
                        } catch (error) {
                            // Log error but don't throw - allow caller to handle gracefully
                            console.error(`[Manifest Data] ${methodName} failed for ${dataSourceName}:`, error);
                            throw error; // Re-throw so caller can handle (e.g., show error message)
                        }
                    }
                });
            });
        } else {
            // Appwrite plugin not loaded - attach safe no-op methods that log warnings
            // Exclude $query for local sources (base plugin handles it)
            const appwriteMethods = isAppwriteSource
                ? ['$create', '$update', '$delete', '$duplicate', '$query', '$url', '$download', '$preview', '$openUrl', '$openPreview', '$openDownload', '$filesFor', '$unlinkFrom', '$removeFrom', '$remove']
                : ['$create', '$update', '$delete', '$duplicate', '$url', '$download', '$preview', '$openUrl', '$openPreview', '$openDownload', '$filesFor', '$unlinkFrom', '$removeFrom', '$remove'];
            appwriteMethods.forEach(methodName => {
                // Skip if method already exists (e.g., base plugin's $query for local sources)
                if (methodName === '$query' && array.hasOwnProperty('$query') && !isAppwriteSource) {
                    return; // Don't override base plugin's $query for local sources
                }
                Object.defineProperty(array, methodName, {
                    enumerable: false,
                    configurable: true,
                    writable: false,
                    value: async function (...args) {
                        console.warn(`[Manifest Data] Appwrite methods require manifest.appwrite.data.js plugin. Method "${methodName}" is not available for "${dataSourceName}".`);
                        return undefined;
                    }
                });
            });
        }

        // Attach pagination methods
        const createPaginationMethod = (methodName) => {
            return async function (...args) {
                const manifest = await window.ManifestDataConfig.ensureManifest();
                if (!manifest?.data) {
                    throw new Error('[Manifest Data] Manifest not available');
                }
                const dataSource = manifest.data[dataSourceName];
                if (!dataSource || !window.ManifestDataConfig.isAppwriteCollection(dataSource)) {
                    throw new Error(`[Manifest Data] Pagination is only supported for Appwrite data sources`);
                }
                const scope = window.ManifestDataConfig.getScope(dataSource);
                const queriesConfig = window.ManifestDataConfig.getQueries(dataSource);
                const baseQueries = queriesConfig
                    ? await window.ManifestDataQueries.buildAppwriteQueries(queriesConfig.default || queriesConfig, scope)
                    : await window.ManifestDataQueries.buildAppwriteQueries([], scope);

                if (methodName === '$first') {
                    const limit = args[0] || 10;
                    return await window.ManifestDataPagination.getFirstPage(dataSourceName, limit, baseQueries);
                } else if (methodName === '$next') {
                    const [cursor, limit = 10] = args;
                    if (!cursor) {
                        throw new Error('[Manifest Data] Cursor is required for $next');
                    }
                    return await window.ManifestDataPagination.getNextPage(dataSourceName, cursor, limit, baseQueries);
                } else if (methodName === '$prev') {
                    const [cursor, limit = 10] = args;
                    if (!cursor) {
                        throw new Error('[Manifest Data] Cursor is required for $prev');
                    }
                    return await window.ManifestDataPagination.getPrevPage(dataSourceName, cursor, limit, baseQueries);
                } else if (methodName === '$page') {
                    const [pageNumber, limit = 10] = args;
                    if (!pageNumber || pageNumber < 1) {
                        throw new Error('[Manifest Data] Page number must be >= 1');
                    }
                    return await window.ManifestDataPagination.getPage(dataSourceName, pageNumber, limit, baseQueries);
                }
            };
        };

        ['$first', '$next', '$prev', '$page'].forEach(methodName => {
            Object.defineProperty(array, methodName, {
                enumerable: false,
                configurable: true,
                writable: false,
                value: createPaginationMethod(methodName)
            });
        });
    }

    return array;
}

// Export for use in other modules
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxies) window.ManifestDataProxies = {};
    window.ManifestDataProxies.clearArrayProxyCacheForDataSource = clearArrayProxyCacheForDataSource;
    window.ManifestDataProxies.attachArrayMethods = attachArrayMethods;
}

function createArrayProxyWithRoute(arrayTarget, dataSourceName = null, reloadDataSource = null) {
    // When dataSourceName is provided, use a Map with composite key (array + dataSourceName)
    // When dataSourceName is null, use WeakMap (original behavior)
    if (dataSourceName) {
        // Create a composite key using array identity and dataSourceName
        // Use a WeakMap to store a unique ID for each array, then use that ID + dataSourceName in Map
        if (!window._arrayProxyIdMap) {
            window._arrayProxyIdMap = new WeakMap();
            window._arrayProxyIdCounter = 0;
        }
        let arrayId = window._arrayProxyIdMap.get(arrayTarget);
        if (!arrayId) {
            arrayId = `array_${window._arrayProxyIdCounter++}`;
            window._arrayProxyIdMap.set(arrayTarget, arrayId);
        }
        const cacheKey = `${arrayId}:${dataSourceName}`;

        if (arrayProxyCacheWithDataSource.has(cacheKey)) {
            const cached = arrayProxyCacheWithDataSource.get(cacheKey);
            return cached;
        }
    } else {
        // Original WeakMap cache for cases without dataSourceName
        if (window.ManifestDataProxiesCore.arrayProxyCache.has(arrayTarget)) {
            return window.ManifestDataProxiesCore.arrayProxyCache.get(arrayTarget);
        }
    }

    // Attach array methods directly to target BEFORE creating proxy (ensures Alpine compatibility)
    if (Array.isArray(arrayTarget) && !arraysWithMethodsAttached.has(arrayTarget)) {
        // Attach all standard array methods directly to the array
        // This is a safety net in case Alpine accesses methods directly on the array
        const attachedMethods = [];
        ARRAY_METHODS.forEach(methodName => {
            if (!(methodName in arrayTarget) || typeof arrayTarget[methodName] !== 'function') {
                // Only attach if not already present (to avoid overwriting)
                try {
                    Object.defineProperty(arrayTarget, methodName, {
                        enumerable: false,
                        configurable: true,
                        writable: false,
                        value: Array.prototype[methodName].bind(arrayTarget)
                    });
                    attachedMethods.push(methodName);
                } catch (e) {
                    console.warn(`[Array Proxy] Failed to attach ${methodName}:`, e);
                }
            }
        });

        // Mark as having methods attached
        arraysWithMethodsAttached.add(arrayTarget);
    } else {
    }

    // Pre-create $files function if this is a table data source
    // Always create it, even if manifest isn't loaded yet - the function will handle it internally
    if (dataSourceName) {
        const createFilesMethod = window.ManifestDataProxiesMagic?.createFilesMethod;
        if (createFilesMethod && !arrayTarget._$filesFunction) {
            arrayTarget._$filesFunction = createFilesMethod(dataSourceName);
            Object.defineProperty(arrayTarget._$filesFunction, 'name', { value: '$files', configurable: true });
            Object.setPrototypeOf(arrayTarget._$filesFunction, Function.prototype);
            // Also define it directly on the array target so it's accessible without going through proxy
            Object.defineProperty(arrayTarget, '$files', {
                enumerable: true,
                configurable: true,
                writable: false,
                value: arrayTarget._$filesFunction
            });
        }
    }

    // Attach $route directly to the array target (like attachArrayMethods does)
    // This ensures $route() works even if Alpine proxies the proxy
    // Always attach it, even if createRouteProxy isn't available yet (it will be checked at call time)
    if (!arrayTarget.hasOwnProperty('$route')) {
        Object.defineProperty(arrayTarget, '$route', {
            enumerable: false,
            configurable: true,
            writable: false,
            value: function (pathKey) {
                const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                if (!createRouteProxy) {
                    return new Proxy({}, {
                        get() { return undefined; }
                    });
                }
                if (arrayTarget && typeof arrayTarget === 'object') {
                    // Get raw data to ensure we have the actual array (not Alpine proxy)
                    const getRawData = window.ManifestDataStore?.getRawData;
                    let dataToUse = arrayTarget;

                    // CRITICAL: Always try to get raw data first - this ensures we have the real array
                    if (dataSourceName && getRawData) {
                        const rawData = getRawData(dataSourceName);
                        if (rawData && (Array.isArray(rawData) || (rawData.length !== undefined && rawData.length >= 0))) {
                            dataToUse = rawData;
                        }
                    }

                    // If we still don't have raw data, try to convert the proxy to a real array
                    if (!Array.isArray(dataToUse) && dataToUse && typeof dataToUse === 'object' && 'length' in dataToUse) {
                        try {
                            dataToUse = Array.from(dataToUse);
                        } catch (e) {
                            const arr = [];
                            for (let i = 0; i < dataToUse.length; i++) {
                                arr[i] = dataToUse[i];
                            }
                            dataToUse = arr;
                        }
                    }

                    return createRouteProxy(
                        dataToUse,
                        pathKey,
                        dataSourceName || undefined
                    );
                }
                return new Proxy({}, {
                    get() { return undefined; }
                });
            }
        });
    }

    // Create the base array proxy
    const baseProxy = Object.setPrototypeOf(
        new Proxy(arrayTarget, {
            get(target, key, receiver) {

                // Handle special keys - but allow Symbol.iterator for array iteration
                if (key === 'then' || key === 'catch' || key === 'finally') {
                    return undefined;
                }

                // Allow Symbol.iterator for proper array iteration (needed for Alpine's x-for)
                if (key === Symbol.iterator) {
                    const manifest = window.ManifestDataConfig?.getManifest?.();
                    const ds = manifest?.data?.[dataSourceName];
                    const isStorageBucket = ds && window.ManifestDataConfig?.getAppwriteBucketId?.(ds);
                    if (isStorageBucket) {
                    }
                    const iterator = target[Symbol.iterator].bind(target);
                    // Ensure iterator function has proper prototype for Alpine's instanceof checks
                    if (iterator && typeof iterator === 'function') {
                        Object.setPrototypeOf(iterator, Function.prototype);
                    }
                    return iterator;
                }

                // Handle Symbol.toPrimitive - MUST return a function, not an object
                if (key === Symbol.toPrimitive) {
                    return function (hint) {
                        // For arrays, return a string representation
                        if (hint === 'string' || hint === 'default') {
                            return target.join(', ');
                        }
                        return target;
                    };
                }

                // Handle Alpine-specific DOM properties that may be accessed during iteration
                if (key === 'after' || key === 'before' || key === 'parentNode' || key === 'nextSibling' ||
                    key === 'previousSibling' || key === 'firstChild' || key === 'lastChild') {
                    return null;
                }

                // Handle $route function for route-specific lookups on arrays
                // Also check if it's attached directly to the target (for nested arrays)
                if (key === '$route') {
                    // First check if it's attached directly to the target
                    if (target.$route && typeof target.$route === 'function') {
                        return target.$route;
                    }
                    // Otherwise, return the function from the proxy handler
                    const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                    if (!createRouteProxy) {
                        // Return a function that returns a safe proxy (not a proxy directly)
                        return function (pathKey) {
                            return new Proxy({}, {
                                get() { return undefined; }
                            });
                        };
                    }
                    return function (pathKey) {
                        // Only create route proxy if we have valid data
                        if (target && typeof target === 'object') {
                            // Get raw data to avoid Alpine proxy issues with Array.isArray() checks
                            const getRawData = window.ManifestDataStore?.getRawData;
                            let dataToUse = target;

                            // Try to get raw data if available (for better route matching)
                            if (dataSourceName && getRawData) {
                                const rawData = getRawData(dataSourceName);
                                if (rawData && Array.isArray(rawData)) {
                                    dataToUse = rawData;
                                }
                            }

                            // Get data source name from the first item's contentType metadata
                            return createRouteProxy(
                                dataToUse,
                                pathKey,
                                (Array.isArray(dataToUse) && dataToUse.length > 0 && dataToUse[0] && dataToUse[0].contentType)
                                    ? dataToUse[0].contentType
                                    : dataSourceName || undefined
                            );
                        }
                        // Return a safe fallback proxy
                        return new Proxy({}, {
                            get() { return undefined; }
                        });
                    };
                }

                if (key === 'length') {
                    // Always return a number, even if target is not an array
                    return Array.isArray(target) ? target.length : (target && typeof target === 'object' && 'length' in target ? target.length : 0);
                }
                if (typeof key === 'string' && !isNaN(Number(key))) {
                    const index = Number(key);
                    // Ensure target is an array and index is valid
                    if (Array.isArray(target) && index >= 0 && index < target.length) {
                        const item = target[index];
                        // Return primitives directly - no proxy needed
                        if (item === null || item === undefined || typeof item !== 'object') {
                            return item;
                        }
                        // For objects/arrays, check cache first to prevent recursion
                        // If it's an array, use array proxy (which has its own cache)
                        // Pass dataSourceName to nested arrays
                        if (Array.isArray(item)) {
                            return createArrayProxyWithRoute(item, dataSourceName, reloadDataSource);
                        }
                        // For objects, use array item proxy (which has its own cache)
                        return window.ManifestDataProxiesCore.createArrayItemProxy(item);
                    }
                    // Return undefined for out-of-bounds indices (Alpine handles this gracefully)
                    return undefined;
                }
                // Handle array methods (Alpine may access before other handlers)
                if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                    // First try to use the method from the target if it exists and is callable
                    if (Array.isArray(target)) {
                        if (typeof target[key] === 'function') {
                            const bound = target[key].bind(target);
                            // Ensure function has proper prototype for Alpine's instanceof checks
                            Object.setPrototypeOf(bound, Function.prototype);
                            return bound;
                        }
                    }
                    // Fallback: use Array.prototype method bound to target
                    // This ensures methods work even if Alpine proxies the array or target doesn't have the method
                    if (target && typeof target === 'object' && 'length' in target && typeof target.length === 'number') {
                        const bound = Array.prototype[key].bind(target);
                        // Ensure function has proper prototype
                        Object.setPrototypeOf(bound, Function.prototype);
                        return bound;
                    }
                    // Return undefined if target is invalid
                    console.warn(`[Array Proxy] Could not provide array method: ${key}`, {
                        targetType: typeof target,
                        hasLength: target && 'length' in target,
                        lengthType: target && typeof target.length
                    });
                    return undefined;
                }

                // Handle state properties ($loading, $error, $ready)
                if (key === '$loading' || key === '$error' || key === '$ready') {
                    const store = Alpine.store('data');
                    // Safely access dataSourceName - if it's not defined, use null
                    let safeDataSourceName;
                    try {
                        safeDataSourceName = dataSourceName;
                    } catch (e) {
                        safeDataSourceName = null;
                    }
                    const stateKey = `_${safeDataSourceName}_state`;
                    const state = store[stateKey] || { loading: false, error: null, ready: false };

                    if (key === '$loading') {
                        return state.loading || false;
                    } else if (key === '$error') {
                        return state.error || null;
                    } else if (key === '$ready') {
                        return state.ready || false;
                    }
                }

                // Handle pagination methods
                if (key === '$first' || key === '$next' || key === '$prev' || key === '$page') {
                    return async function (...args) {
                        const manifest = await window.ManifestDataConfig.ensureManifest();
                        if (!manifest?.data) {
                            throw new Error('[Manifest Data] Manifest not available');
                        }

                        const dataSource = manifest.data[dataSourceName];
                        if (!dataSource || !window.ManifestDataConfig.isAppwriteCollection(dataSource)) {
                            throw new Error(`[Manifest Data] Pagination is only supported for Appwrite data sources`);
                        }

                        // Get base queries (from manifest or scope)
                        const scope = window.ManifestDataConfig.getScope(dataSource);
                        const queriesConfig = window.ManifestDataConfig.getQueries(dataSource);
                        const baseQueries = queriesConfig
                            ? await window.ManifestDataQueries.buildAppwriteQueries(queriesConfig.default || queriesConfig, scope)
                            : await window.ManifestDataQueries.buildAppwriteQueries([], scope);

                        if (key === '$first') {
                            const limit = args[0] || 10;
                            return await window.ManifestDataPagination.getFirstPage(dataSourceName, limit, baseQueries);
                        } else if (key === '$next') {
                            const [cursor, limit = 10] = args;
                            if (!cursor) {
                                throw new Error('[Manifest Data] Cursor is required for $next');
                            }
                            return await window.ManifestDataPagination.getNextPage(dataSourceName, cursor, limit, baseQueries);
                        } else if (key === '$prev') {
                            const [cursor, limit = 10] = args;
                            if (!cursor) {
                                throw new Error('[Manifest Data] Cursor is required for $prev');
                            }
                            return await window.ManifestDataPagination.getPrevPage(dataSourceName, cursor, limit, baseQueries);
                        } else if (key === '$page') {
                            const [pageNumber, limit = 10] = args;
                            if (!pageNumber || pageNumber < 1) {
                                throw new Error('[Manifest Data] Page number must be >= 1');
                            }
                            return await window.ManifestDataPagination.getPage(dataSourceName, pageNumber, limit, baseQueries);
                        }
                    };
                }

                // $files handler for tables
                if (dataSourceName && key === '$files') {
                    // Check if $files is directly defined on target (from pre-creation)
                    const hasDirectFiles = target.hasOwnProperty ? target.hasOwnProperty('$files') : ('$files' in target);
                    if (hasDirectFiles && typeof target.$files === 'function') {
                        const filesFunc = target.$files;
                        if (Object.getPrototypeOf(filesFunc) !== Function.prototype) {
                            Object.setPrototypeOf(filesFunc, Function.prototype);
                        }
                        return filesFunc;
                    }
                    // Use cached function if available
                    if (target._$filesFunction) {
                        return target._$filesFunction;
                    }
                    // Create function if not cached using factory
                    if (!target || (typeof target !== 'object' && !Array.isArray(target))) {
                        return undefined;
                    }
                    const createFilesMethod = window.ManifestDataProxiesMagic?.createFilesMethod;
                    if (createFilesMethod) {
                        target._$filesFunction = createFilesMethod(dataSourceName);
                        Object.defineProperty(target._$filesFunction, 'name', { value: '$files', configurable: true });
                        Object.setPrototypeOf(target._$filesFunction, Function.prototype);
                        return target._$filesFunction;
                    }
                    return undefined;
                }

                // $upload handler for tables
                if (dataSourceName && key === '$upload') {
                    // Use cached function if available
                    if (target._$uploadFunction) {
                        return target._$uploadFunction;
                    }
                    // Create function using factory
                    const createUploadMethod = window.ManifestDataProxiesMagic?.createUploadMethod;
                    if (createUploadMethod) {
                        target._$uploadFunction = createUploadMethod(dataSourceName, reloadDataSource);
                        Object.defineProperty(target._$uploadFunction, 'name', { value: '$upload', configurable: true });
                        Object.setPrototypeOf(target._$uploadFunction, Function.prototype);
                        return target._$uploadFunction;
                    }
                    return undefined;
                }

                // Handle Appwrite methods for arrays (when data source is an Appwrite table or bucket)
                // These methods are called on the array itself (e.g., $x.assets.$create(file))
                // Only available if Appwrite plugin is loaded
                if (dataSourceName && (key === '$create' || key === '$update' || key === '$delete' || key === '$duplicate' || key === '$query' ||
                    key === '$url' || key === '$download' || key === '$preview' || key === '$filesFor' || key === '$unlinkFrom' || key === '$removeFrom' || key === '$remove')) {
                    // Check if Appwrite methods handler is available
                    const createAppwriteMethodsHandler = window.ManifestDataProxiesAppwrite?.createAppwriteMethodsHandler;
                    if (createAppwriteMethodsHandler) {
                        // Return async function that calls the Appwrite methods handler
                        return async function (...args) {
                            const methodsHandler = createAppwriteMethodsHandler(dataSourceName, reloadDataSource);
                            return await methodsHandler(key, ...args);
                        };
                    } else {
                        // Appwrite plugin not loaded - return function that throws helpful error
                        return async function (...args) {
                            throw new Error(`[Manifest Data] Appwrite methods require manifest.appwrite.data.js plugin. Method "${key}" is not available.`);
                        };
                    }
                }
                // For any other property access, try to get it from the target
                // This allows Alpine to access array properties naturally
                if (key in target) {
                    const value = target[key];
                    // If it's a function, bind it to the target
                    if (typeof value === 'function') {
                        return value.bind(target);
                    }
                    return value;
                }
                // For array methods/properties that might not be explicitly handled, try to get from target
                if (Array.isArray(target) && key in target) {
                    const value = target[key];
                    if (typeof value === 'function') {
                        // Ensure function has proper prototype for Alpine's instanceof checks
                        const bound = value.bind(target);
                        // Set prototype to ensure instanceof works - check if prototype exists first
                        const proto = value.prototype || Function.prototype;
                        if (proto && typeof proto === 'object') {
                            Object.setPrototypeOf(bound, proto);
                        }
                        return bound;
                    }
                    return value;
                }

                // Return undefined for unknown properties to let Alpine handle it
                // But ensure we don't return functions without prototypes
                return undefined;
            },
            has(target, key) {
                // For arrays, check if the key actually exists (numeric indices, length, methods, etc.)
                if (Array.isArray(target)) {
                    // Check numeric indices
                    if (typeof key === 'number' || (typeof key === 'string' && !isNaN(Number(key)))) {
                        const index = typeof key === 'number' ? key : Number(key);
                        return index >= 0 && index < target.length;
                    }
                    // Check standard array properties
                    if (key === 'length' || key === Symbol.iterator || key === Symbol.toPrimitive) {
                        return true;
                    }
                    // Return true for array methods (Alpine checks has() before get())
                    if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                        return true;
                    }
                    // Also check if it's directly on the target (for custom methods or overrides)
                    if (typeof key === 'string' && typeof target[key] === 'function') {
                        return true;
                    }
                    // For table data sources, $files and $upload should be available
                    // Always return true if dataSourceName is provided - the function will validate at runtime
                    if (dataSourceName && (key === '$files' || key === '$upload')) {
                        return true;
                    }
                    // Check custom methods we've added
                    if (key === '$route' || key === '$loading' || key === '$error' || key === '$ready') {
                        return true;
                    }
                    // For other string keys, check if they exist on the array
                    return key in target;
                }
                // For array-like objects (not arrays but have length), also return true for array methods
                if (target && typeof target === 'object' && 'length' in target && typeof target.length === 'number') {
                    if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                        return true;
                    }
                }
                // For non-arrays, make all string keys appear to exist to prevent Alpine errors
                if (typeof key === 'string') {
                    return true;
                }
                return key in target || key === Symbol.iterator || key === Symbol.toPrimitive;
            },
            getOwnPropertyDescriptor(target, key) {

                // Return descriptor for array methods (Alpine checks via getOwnPropertyDescriptor)
                if (Array.isArray(target) && typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                    const descriptor = {
                        enumerable: false,
                        configurable: true,
                        writable: false,
                        value: (() => {
                            if (typeof target[key] === 'function') {
                                return target[key].bind(target);
                            }
                            return Array.prototype[key].bind(target);
                        })()
                    };
                    return descriptor;
                }
                // For $files, return descriptor with the actual function
                if (dataSourceName && key === '$files') {
                    // Check if $files is directly defined on target first (from pre-creation)
                    const hasDirectFiles = target.hasOwnProperty ? target.hasOwnProperty('$files') : ('$files' in target);
                    let filesFunc = null;
                    if (hasDirectFiles && typeof target.$files === 'function') {
                        filesFunc = target.$files;
                    } else if (target._$filesFunction) {
                        filesFunc = target._$filesFunction;
                    } else {
                    // Create function if it doesn't exist using factory
                    const createFilesMethod = window.ManifestDataProxiesMagic?.createFilesMethod;
                    if (createFilesMethod) {
                        target._$filesFunction = createFilesMethod(dataSourceName);
                        Object.defineProperty(target._$filesFunction, 'name', { value: '$files', configurable: true });
                        Object.setPrototypeOf(target._$filesFunction, Function.prototype);
                        filesFunc = target._$filesFunction;
                    }
                    }
                    // Ensure function has proper prototype
                    if (filesFunc && Object.getPrototypeOf(filesFunc) !== Function.prototype) {
                        Object.setPrototypeOf(filesFunc, Function.prototype);
                    }
                    const descriptor = {
                        enumerable: true,
                        configurable: true,
                        writable: false,
                        value: filesFunc
                    };
                    return descriptor;
                }
                // For $upload, return descriptor with the actual function
                if (dataSourceName && key === '$upload') {
                    // Ensure function exists using factory
                    if (!target._$uploadFunction) {
                        const createUploadMethod = window.ManifestDataProxiesMagic?.createUploadMethod;
                        if (createUploadMethod) {
                            target._$uploadFunction = createUploadMethod(dataSourceName, reloadDataSource);
                            Object.defineProperty(target._$uploadFunction, 'name', { value: '$upload', configurable: true });
                            Object.setPrototypeOf(target._$uploadFunction, Function.prototype);
                        }
                    }
                    if (target._$uploadFunction) {
                        return {
                            enumerable: true,
                            configurable: true,
                            writable: false,
                            value: target._$uploadFunction
                        };
                    }
                    return undefined;
                }
                // For other properties, use default behavior
                return Object.getOwnPropertyDescriptor(target, key);
            },
            ownKeys(target) {
                // Include $files and $upload in the list of own keys if dataSourceName exists
                const keys = Reflect.ownKeys(target);
                const additionalKeys = [];

                // Include array methods in ownKeys (ensures Alpine compatibility)
                if (Array.isArray(target)) {
                    ARRAY_METHODS.forEach(methodName => {
                        if (typeof Array.prototype[methodName] === 'function' && !keys.includes(methodName)) {
                            additionalKeys.push(methodName);
                        }
                    });
                }

                if (dataSourceName) {
                    // Check if this is a table (not a bucket) for $upload
                    const manifest = window.ManifestDataConfig?.getManifest?.();
                    if (manifest?.data?.[dataSourceName]) {
                        const dataSource = manifest.data[dataSourceName];
                        const isTable = window.ManifestDataConfig.getAppwriteTableId(dataSource);
                        if (isTable && !keys.includes('$upload') && !additionalKeys.includes('$upload')) {
                            additionalKeys.push('$upload');
                        }
                    }
                    if (!keys.includes('$files') && !additionalKeys.includes('$files')) {
                        additionalKeys.push('$files');
                    }
                }
                return additionalKeys.length > 0 ? [...keys, ...additionalKeys] : keys;
            }
        }),
        Array.prototype
    );

    // Define array methods directly on proxy (Alpine may bypass get handler)
    if (Array.isArray(arrayTarget)) {
        ARRAY_METHODS.forEach(methodName => {
            if (typeof Array.prototype[methodName] === 'function') {
                try {
                    // Define directly on the proxy object
                    Object.defineProperty(baseProxy, methodName, {
                        enumerable: false,
                        configurable: true,
                        writable: false,
                        value: (() => {
                            if (typeof arrayTarget[methodName] === 'function') {
                                return arrayTarget[methodName].bind(arrayTarget);
                            }
                            return Array.prototype[methodName].bind(arrayTarget);
                        })()
                    });
                } catch (e) {
                    console.warn(`[Array Proxy] Failed to define ${methodName} on proxy:`, e);
                }
            }
        });
    }

    // Cache the base proxy IMMEDIATELY after creation, before returning
    // This ensures the cache is available if the proxy's get handler is called recursively
    // SKIP CACHE for 'projects' to ensure Alpine gets fresh proxy reference for reactivity
    if (dataSourceName && dataSourceName !== 'projects') {
        // Use Map cache with composite key
        if (!window._arrayProxyIdMap) {
            window._arrayProxyIdMap = new WeakMap();
            window._arrayProxyIdCounter = 0;
        }
        let arrayId = window._arrayProxyIdMap.get(arrayTarget);
        if (!arrayId) {
            arrayId = `array_${window._arrayProxyIdCounter++}`;
            window._arrayProxyIdMap.set(arrayTarget, arrayId);
        }
        const cacheKeyForSet = `${arrayId}:${dataSourceName}`;
        arrayProxyCacheWithDataSource.set(cacheKeyForSet, baseProxy);

        // Define $files directly on proxy (ensures Alpine compatibility)
        if (arrayTarget.$files && typeof arrayTarget.$files === 'function') {
            try {
                Object.defineProperty(baseProxy, '$files', {
                    enumerable: true,
                    configurable: true,
                    writable: false,
                    value: arrayTarget.$files
                });
            } catch (e) {
                // Failed to define $files on proxy - non-critical
            }
        }
    } else {
        // Use WeakMap cache for cases without dataSourceName
        window.ManifestDataProxiesCore.arrayProxyCache.set(arrayTarget, baseProxy);
    }

    return baseProxy;
}

// Export functions to window for use by other subscripts
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxies) {
        window.ManifestDataProxies = {};
    }
    window.ManifestDataProxies.clearArrayProxyCacheForDataSource = clearArrayProxyCacheForDataSource;
    window.ManifestDataProxies.attachArrayMethods = attachArrayMethods;
    window.ManifestDataProxies.createArrayProxyWithRoute = createArrayProxyWithRoute;
}
