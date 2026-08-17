/* Manifest Data Sources - Object Proxy Creation */
// Proxies nested objects/arrays for $x access. path = keys from the source root,
// used to resolve values from the raw store without triggering Alpine reactivity.
// Note (applies throughout): Alpine may wrap our proxies in its own, so always read
// via rawTarget/the raw store — never `target` — and cache one proxy per raw object,
// or Alpine sees a "new" object each access and re-evaluates forever.
function createNestedObjectProxy(objTarget, dataSourceName = null, reloadDataSource = null, path = []) {
    if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(objTarget)) {
        return window.ManifestDataProxiesCore.nestedObjectProxyCache.get(objTarget);
    }

    // Resolve the raw object from the store by path (objTarget may be Alpine-wrapped)
    let rawObjectForCache = objTarget;
    if (path.length >= 0 && window.ManifestDataStore?.getRawData && dataSourceName) {
        const rawDataSource = window.ManifestDataStore.getRawData(dataSourceName);
        if (rawDataSource && typeof rawDataSource === 'object') {
            let current = rawDataSource;
            let pathValid = true;
            for (let i = 0; i < path.length; i++) {
                const pathKey = path[i];
                if (current && typeof current === 'object' && pathKey in current) {
                    current = current[pathKey];
                } else {
                    pathValid = false;
                    break;
                }
            }
            if (pathValid && current) {
                rawObjectForCache = current;
            }
        }
    }

    // Cache check keyed by raw object
    if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(rawObjectForCache)) {
        const cached = window.ManifestDataProxiesCore.nestedObjectProxyCache.get(rawObjectForCache);

        return cached;
    }

    // Active property accesses per raw target (circular-reference guard)
    if (!window.ManifestDataProxiesCore) {
        window.ManifestDataProxiesCore = {};
    }
    if (!window.ManifestDataProxiesCore.nestedProxyActiveProps) {
        window.ManifestDataProxiesCore.nestedProxyActiveProps = new WeakMap();
    }
    const activePropsMap = window.ManifestDataProxiesCore.nestedProxyActiveProps;

    if (!activePropsMap.has(rawObjectForCache)) {
        activePropsMap.set(rawObjectForCache, new Set());
    }

    // rawTarget: the true raw data (see header note); also used as the Proxy target
    const rawTarget = rawObjectForCache;

    const proxyTarget = rawTarget;

    // Track call depth for debugging recursion
    if (!window.__manifestProxyCallDepth) {
        window.__manifestProxyCallDepth = new WeakMap();
    }
    const callDepthMap = window.__manifestProxyCallDepth;
    const currentDepth = (callDepthMap.get(rawTarget) || 0) + 1;
    callDepthMap.set(rawTarget, currentDepth);

    // Re-entry guard: when get-trap call depth exceeds threshold, resolve directly from raw store
    // and return (no proxy creation) to break recursion (e.g. :aria-label="$x.content.theme.light").
    const NESTED_GET_REENTRY_THRESHOLD = 10;
    if (typeof window !== 'undefined') {
        window.__manifestNestedGetDepth = window.__manifestNestedGetDepth || 0;
    }

    const proxy = new Proxy(proxyTarget, {
        get(target, key) {
            const nestedDepth = typeof window !== 'undefined' ? (window.__manifestNestedGetDepth = (window.__manifestNestedGetDepth || 0) + 1) : 0;
            try {
                const fullPath = dataSourceName ? `${dataSourceName}.${path.join('.')}.${String(key)}` : String(key);

                // Re-entry guard: resolve from raw and return to break recursion
                if (nestedDepth > NESTED_GET_REENTRY_THRESHOLD && dataSourceName && window.ManifestDataStore?.getRawData) {
                    try {
                        const raw = window.ManifestDataStore.getRawData(dataSourceName);
                        if (raw && typeof raw === 'object') {
                            const fullPathKeys = [...path, key];
                            let v = raw;
                            for (const k of fullPathKeys) {
                                if (v == null || typeof v !== 'object') break;
                                v = Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined;
                            }
                            if (v === null || typeof v !== 'object') {
                                return v !== undefined ? v : '';
                            }
                            const plain = {};
                            for (const k of Object.keys(v)) {
                                if (Object.prototype.hasOwnProperty.call(v, k)) plain[k] = v[k];
                            }
                            return plain;
                        }
                    } catch (e) { /* ignore */ }
                }

                const isRawTargetProxied = window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(rawTarget);

                // Required by handleCircularReference (no debug stack capture)
                const triggeredBy = 'Unknown';

                // Handle special keys
                if (key === Symbol.iterator || key === 'then' || key === 'catch' || key === 'finally') {
                    return undefined;
                }

                // Handle toPrimitive for text content
                if (key === Symbol.toPrimitive) {
                    return function () {
                        try {
                            const getRawData = window.ManifestDataStore?.getRawData;
                            if (getRawData && dataSourceName && path.length >= 0) {
                                const rawDataSource = getRawData(dataSourceName);
                                if (rawDataSource && typeof rawDataSource === 'object') {
                                    // Safe property access without triggering proxies
                                    const safeGet = (obj, prop) => {
                                        if (obj && typeof obj === 'object' && prop in obj) {
                                            try {
                                                if (Object.prototype.hasOwnProperty.call(obj, prop)) {
                                                    return obj[prop];
                                                }
                                                return obj[prop];
                                            } catch (e) {
                                                return undefined;
                                            }
                                        }
                                        return undefined;
                                    };

                                    let current = rawDataSource;
                                    let pathValid = true;
                                    const fullPath = [...path, key];
                                    for (let i = 0; i < fullPath.length; i++) {
                                        const pathKey = fullPath[i];
                                        const nextValue = safeGet(current, pathKey);
                                        if (nextValue !== undefined) {
                                            current = nextValue;
                                        } else {
                                            pathValid = false;
                                            break;
                                        }
                                    }
                                    if (pathValid && current !== undefined && current !== null) {
                                        return String(current) || '';
                                    }
                                }
                            }
                        } catch (e) {
                            // Fallback
                        }
                        return '';
                    };
                }

                // Circular reference check
                const activeProps = activePropsMap.get(rawTarget);
                const propKey = String(key);

                const handleCircularReference = window.ManifestDataProxiesHandlers?.handleCircularReference;
                if (handleCircularReference) {
                    const circularResult = handleCircularReference({
                        activeProps,
                        propKey,
                        rawTarget,
                        path,
                        key,
                        fullPath,
                        currentDepth,
                        triggeredBy,
                        shouldLog: false,
                    });
                    // null means not circular; any other value (incl. undefined) is the result
                    if (circularResult !== null) {
                        return circularResult;
                    }
                } else {
                    // Inline fallback if handler unavailable
                    if (activeProps && activeProps.has(propKey)) {
                        if (activeProps) {
                            activeProps.delete(propKey);
                        }
                        return undefined;
                    }
                }

                // Mark property as in-flight before any proxy creation (re-entry guard)
                if (activeProps) {
                    activeProps.add(propKey);
                }

                let value;

                try {
                    const safeGet = (obj, prop) => {
                        if (!obj || typeof obj !== 'object') return undefined;
                        if (Object.prototype.hasOwnProperty.call(obj, prop)) {
                            return obj[prop];
                        }
                        return undefined;
                    };

                    // rawTarget is already the object at `path`; just read the requested key
                    value = safeGet(rawTarget, key);
                } catch (e) {
                    // Silently handle errors
                }

                // content.theme: return plain object so .light/.dark/.system are plain reads; avoids Alpine
                // wrapping a proxy and re-running, which caused stack overflow for :aria-label.
                if (dataSourceName === 'content' && key === 'theme' && value != null && typeof value === 'object' && !Array.isArray(value)) {
                    const theme = value;
                    const plain = {
                        light: (theme.light != null ? String(theme.light) : '') || 'Light',
                        dark: (theme.dark != null ? String(theme.dark) : '') || 'Dark',
                        system: (theme.system != null ? String(theme.system) : '') || 'System'
                    };
                    if (activeProps) activeProps.delete(propKey);
                    callDepthMap.delete(rawTarget);
                    return plain;
                }

                // When key is missing, return chaining fallback so deep paths like .another.deep.level don't throw
                if (value === undefined) {
                    if (activeProps) activeProps.delete(propKey);
                    callDepthMap.delete(rawTarget);
                    const fallback = window.ManifestDataProxiesCore?.getChainingFallback?.();
                    return fallback !== undefined ? fallback : '';
                }

                // Primitives return immediately (must precede array/object checks)
                if (value === null ||
                    typeof value === 'string' || typeof value === 'number' ||
                    typeof value === 'boolean' || typeof value === 'symbol') {
                    if (activeProps) {
                        activeProps.delete(propKey);
                    }
                    callDepthMap.delete(rawTarget);
                    return value;
                }

                // Arrays: proxy with array methods and $route handled at the top level
                if (Array.isArray(value)) {
                    let arrayWithMethods = value;
                    try {
                        const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
                        if (attachArrayMethods) {
                            arrayWithMethods = attachArrayMethods(value, dataSourceName, reloadDataSource);
                        }
                    } catch (error) {
                        // Silently handle error attaching methods
                    }

                    const arrayKey = key;
                    const arrayDataSourceName = dataSourceName;

                    // toJSON must exist before proxying — JSON.stringify checks it first
                    if (typeof arrayWithMethods.toJSON !== 'function') {
                        Object.defineProperty(arrayWithMethods, 'toJSON', {
                            enumerable: false,
                            configurable: true,
                            writable: false,
                            value: function () {
                                // Serialize from the raw store array
                                try {
                                    const getRawData = window.ManifestDataStore?.getRawData;
                                    if (getRawData && arrayDataSourceName) {
                                        const rawDataSource = getRawData(arrayDataSourceName);
                                        if (rawDataSource && typeof rawDataSource === 'object') {
                                            const rawArray = rawDataSource[arrayKey];
                                            if (Array.isArray(rawArray)) {
                                                return rawArray;
                                            }
                                        }
                                    }
                                } catch (e) {
                                    // Fallback
                                }
                                return Array.isArray(arrayWithMethods) ? arrayWithMethods : arrayWithMethods;
                            }
                        });
                    }

                    const arrayProxy = new Proxy(arrayWithMethods, {
                        get(proxyTarget, prop) {
                            if (prop === 'toJSON') {
                                return proxyTarget.toJSON;
                            }

                            // String conversion
                            if (prop === Symbol.toPrimitive) {
                                return function (hint) {
                                    if (hint === 'string' || hint === 'default') {
                                        if (typeof proxyTarget.toJSON === 'function') {
                                            return JSON.stringify(proxyTarget.toJSON());
                                        }
                                        return JSON.stringify(proxyTarget);
                                    }
                                    return proxyTarget;
                                };
                            }

                            // $search/$query with empty-array fallback while loading
                            if (prop === '$search' || prop === '$query') {
                                if (proxyTarget && typeof proxyTarget === 'object' && prop in proxyTarget && typeof proxyTarget[prop] === 'function') {
                                    return proxyTarget[prop].bind(proxyTarget);
                                }
                                return function () {
                                    return [];
                                };
                            }

                            if (prop === '$route') {
                                const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                                if (!createRouteProxy) {
                                    return new Proxy({}, { get: () => undefined });
                                }
                                const routeFunction = function (pathKey) {
                                    if (proxyTarget && Array.isArray(proxyTarget)) {
                                        const getRawData = window.ManifestDataStore?.getRawData;
                                        let dataToUse = proxyTarget;
                                        if (dataSourceName && getRawData) {
                                            const rawData = getRawData(dataSourceName);
                                            if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
                                                if (rawData[key] && Array.isArray(rawData[key])) {
                                                    dataToUse = rawData[key];
                                                }
                                            } else if (rawData && Array.isArray(rawData)) {
                                                dataToUse = rawData;
                                            }
                                        }
                                        const result = createRouteProxy(
                                            dataToUse,
                                            pathKey,
                                            (Array.isArray(dataToUse) && dataToUse.length > 0 && dataToUse[0] && dataToUse[0].contentType)
                                                ? dataToUse[0].contentType
                                                : dataSourceName || undefined
                                        );
                                        return result;
                                    }
                                    return new Proxy({}, { get: () => undefined });
                                };
                                // Proper Function prototype for Alpine's instanceof checks
                                Object.setPrototypeOf(routeFunction, Function.prototype);
                                routeFunction.call = Function.prototype.call;
                                routeFunction.apply = Function.prototype.apply;
                                routeFunction.bind = Function.prototype.bind;
                                return routeFunction;
                            }

                            // Array methods bound to the target
                            if (typeof prop === 'string' && typeof Array.prototype[prop] === 'function') {
                                if (typeof proxyTarget[prop] === 'function') {
                                    const bound = proxyTarget[prop].bind(proxyTarget);
                                    Object.setPrototypeOf(bound, Function.prototype);
                                    return bound;
                                }
                                const bound = Array.prototype[prop].bind(proxyTarget);
                                Object.setPrototypeOf(bound, Function.prototype);
                                return bound;
                            }

                            // Fall through (including numeric indices)
                            return proxyTarget[prop];
                        },
                        // Alpine checks has() before property access
                        has(target, prop) {
                            if (prop === '$route' || prop === '$search' || prop === '$query') {
                                return true;
                            }
                            if (typeof prop === 'string' && typeof Array.prototype[prop] === 'function') {
                                return true;
                            }
                            return prop in target;
                        },
                        // Alpine introspects via getOwnPropertyDescriptor; mirror get()
                        getOwnPropertyDescriptor(target, prop) {
                            if (prop === '$route') {
                                const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                                if (!createRouteProxy) {
                                    return {
                                        enumerable: false,
                                        configurable: true,
                                        writable: false,
                                        value: function (pathKey) {
                                            return new Proxy({}, { get: () => undefined });
                                        }
                                    };
                                }
                                const routeFunction = function (pathKey) {
                                    if (target && Array.isArray(target)) {
                                        const getRawData = window.ManifestDataStore?.getRawData;
                                        let dataToUse = target;
                                        if (dataSourceName && getRawData) {
                                            const rawData = getRawData(dataSourceName);
                                            if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
                                                if (rawData[key] && Array.isArray(rawData[key])) {
                                                    dataToUse = rawData[key];
                                                }
                                            } else if (rawData && Array.isArray(rawData)) {
                                                dataToUse = rawData;
                                            }
                                        }
                                        return createRouteProxy(
                                            dataToUse,
                                            pathKey,
                                            (Array.isArray(dataToUse) && dataToUse.length > 0 && dataToUse[0] && dataToUse[0].contentType)
                                                ? dataToUse[0].contentType
                                                : dataSourceName || undefined
                                        );
                                    }
                                    return new Proxy({}, { get: () => undefined });
                                };
                                Object.setPrototypeOf(routeFunction, Function.prototype);
                                routeFunction.call = Function.prototype.call;
                                routeFunction.apply = Function.prototype.apply;
                                routeFunction.bind = Function.prototype.bind;
                                return {
                                    enumerable: false,
                                    configurable: true,
                                    writable: false,
                                    value: routeFunction
                                };
                            }
                            if (typeof prop === 'string' && typeof Array.prototype[prop] === 'function') {
                                return {
                                    enumerable: false,
                                    configurable: true,
                                    writable: false,
                                    value: (() => {
                                        if (typeof target[prop] === 'function') {
                                            return target[prop].bind(target);
                                        }
                                        return Array.prototype[prop].bind(target);
                                    })()
                                };
                            }
                            return Reflect.getOwnPropertyDescriptor(target, prop);
                        },
                        // $route/toJSON must appear as own keys for Alpine and JSON.stringify
                        ownKeys(target) {
                            const keys = Reflect.ownKeys(target);
                            const result = [...keys];
                            if (!result.includes('$route')) {
                                result.push('$route');
                            }
                            if (!result.includes('toJSON')) {
                                result.push('toJSON');
                            }
                            return result;
                        }
                    });

                    if (activeProps) {
                        activeProps.delete(propKey);
                    }

                    return arrayProxy;
                }

                // Objects: wrap recursively for further nesting
                if (typeof value === 'object' && value !== null) {
                    let objectToProxy = value;

                    // Simple objects return as plain copies instead of proxies (recursion guard)
                    const handleSimpleObject = window.ManifestDataProxiesSimple?.handleSimpleObject;
                    if (handleSimpleObject && !Array.isArray(value)) {
                        const plainCopy = handleSimpleObject(value, {
                            activeProps,
                            propKey,
                            rawTarget,
                            fullPath,
                            callDepthMap
                        });
                        // null means not a simple object; fall through to proxy creation
                        if (plainCopy !== null) {
                            return plainCopy;
                        }
                    }

                    // If rawTarget is already proxied, resolve the nested raw object and reuse its cached proxy
                    if (isRawTargetProxied) {
                        const newPath = [...path, key];
                        let rawNestedObject = objectToProxy;

                        try {
                            const getRawData = window.ManifestDataStore?.getRawData;
                            if (getRawData && dataSourceName) {
                                const rawDataSource = getRawData(dataSourceName);
                                if (rawDataSource && typeof rawDataSource === 'object') {
                                    let current = rawDataSource;
                                    let pathValid = true;
                                    for (let i = 0; i < newPath.length; i++) {
                                        const pathKey = newPath[i];
                                        if (current && typeof current === 'object' && pathKey in current) {
                                            current = current[pathKey];
                                        } else {
                                            pathValid = false;
                                            break;
                                        }
                                    }
                                    if (pathValid && current) {
                                        rawNestedObject = current;
                                    }
                                }
                            }
                        } catch (e) {
                            // Silently handle errors
                        }

                        if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(rawNestedObject)) {
                            const cachedProxy = window.ManifestDataProxiesCore.nestedObjectProxyCache.get(rawNestedObject);
                            if (cachedProxy) {
                                if (activeProps) {
                                    activeProps.delete(propKey);
                                }
                                return cachedProxy;
                            }
                        }

                        objectToProxy = rawNestedObject;
                    }

                    if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(objectToProxy)) {
                        const cachedProxy = window.ManifestDataProxiesCore.nestedObjectProxyCache.get(objectToProxy);
                        if (activeProps) {
                            activeProps.delete(propKey);
                        }
                        return cachedProxy;
                    }

                    if (objectToProxy === undefined || objectToProxy === null) {
                        return undefined;
                    }

                    // Cache check before createNestedObjectProxy (avoids call overhead)
                    const newPath = [...path, key];
                    let rawNestedObject = objectToProxy;

                    const getRawData = window.ManifestDataStore?.getRawData;
                    if (getRawData && dataSourceName) {
                        const rawDataSource = getRawData(dataSourceName);
                        if (rawDataSource && typeof rawDataSource === 'object') {
                            let current = rawDataSource;
                            let pathValid = true;
                            for (let i = 0; i < newPath.length; i++) {
                                const pathKey = newPath[i];
                                if (current && typeof current === 'object' && pathKey in current) {
                                    current = current[pathKey];
                                } else {
                                    pathValid = false;
                                    break;
                                }
                            }
                            if (pathValid && current) {
                                rawNestedObject = current;
                            }
                        }
                    }

                    if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(rawNestedObject)) {
                        const cachedProxy = window.ManifestDataProxiesCore.nestedObjectProxyCache.get(rawNestedObject);
                        if (cachedProxy) {
                            if (activeProps) {
                                activeProps.delete(propKey);
                            }
                            return cachedProxy;
                        }
                    }

                    const nestedProxy = createNestedObjectProxy(objectToProxy, dataSourceName, reloadDataSource, newPath);

                    if (activeProps) {
                        activeProps.delete(propKey);
                    }

                    // Depth reset handled by the nested proxy
                    return nestedProxy;
                }

                // Undefined: loading proxy keeps the chain alive
                if (value === undefined) {
                    if (activeProps) {
                        activeProps.delete(propKey);
                    }
                    callDepthMap.delete(rawTarget);
                    return window.ManifestDataProxiesCore.createLoadingProxy(dataSourceName);
                }

                if (activeProps) {
                    activeProps.delete(propKey);
                }

                callDepthMap.delete(rawTarget);
                return value;
            } finally {
                if (typeof window !== 'undefined') window.__manifestNestedGetDepth = Math.max(0, (window.__manifestNestedGetDepth || 0) - 1);
            }
        }
    });

    // Cache keyed by raw object (see header note)
    if (window.ManifestDataProxiesCore?.nestedObjectProxyCache) {
        window.ManifestDataProxiesCore.nestedObjectProxyCache.set(rawObjectForCache, proxy);


    }
    return proxy;
}

// Export functions to window for use by other subscripts
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxies) {
        window.ManifestDataProxies = {};
    }
    window.ManifestDataProxies.createNestedObjectProxy = createNestedObjectProxy;
}
