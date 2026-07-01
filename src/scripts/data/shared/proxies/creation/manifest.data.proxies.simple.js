/* Manifest Data Sources - Simple Object Handler */
// Plain copies of primitive-only objects break the proxy chain so Alpine
// wrapping + nested access can't recurse infinitely.

// True if value is an object of only primitives (no nested objects/arrays)
function isSimpleObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value === null) {
        return false;
    }

    try {
        for (const prop in value) {
            if (typeof value[prop] === 'object' && value[prop] !== null) {
                return false;
            }
        }
        return true;
    } catch (e) {
        return false;
    }
}

// Get/create a cached plain copy of a simple object. Not frozen — Alpine
// reads properties off it. Returns null if not simple or copy failed.
function createOrGetPlainCopy(value, {
    activeProps,
    propKey,
    rawTarget,
    fullPath,
    callDepthMap,
    shouldLog
}) {
    if (!isSimpleObject(value)) {
        return null;
    }

    // Initialize cache if needed
    if (!window.ManifestDataProxiesCore.frozenPlainCopyCache) {
        window.ManifestDataProxiesCore.frozenPlainCopyCache = new WeakMap();
    }
    const plainCopyCache = window.ManifestDataProxiesCore.frozenPlainCopyCache;

    // Cached copy = same instance, so Alpine won't re-evaluate (prevents recursion)
    let cachedCopy = plainCopyCache.get(value);
    if (cachedCopy) {
        if (activeProps) {
            activeProps.delete(propKey);
        }
        if (callDepthMap && rawTarget) {
            callDepthMap.delete(rawTarget);
        }
        return cachedCopy;
    }

    const plainCopy = {};
    try {
        for (const prop in value) {
            plainCopy[prop] = value[prop];
        }

        plainCopyCache.set(value, plainCopy);

        // Plain copy breaks the proxy chain, so drop it from activeProps to
        // avoid false circular-reference detection on Alpine's follow-up reads.
        if (activeProps) {
            activeProps.delete(propKey);
        }
        if (callDepthMap && rawTarget) {
            callDepthMap.delete(rawTarget);
        }
        return plainCopy;
    } catch (e) {
        return null;
    }
}

// Entry point: plain copy if value is a simple object, else null
function handleSimpleObject(value, params) {
    if (Array.isArray(value)) {
        return null; // Arrays are not simple objects
    }

    if (!isSimpleObject(value)) {
        return null;
    }

    return createOrGetPlainCopy(value, params);
}

// Export to window for use by proxy creation modules
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxiesSimple) {
        window.ManifestDataProxiesSimple = {};
    }
    window.ManifestDataProxiesSimple.isSimpleObject = isSimpleObject;
    window.ManifestDataProxiesSimple.createOrGetPlainCopy = createOrGetPlainCopy;
    window.ManifestDataProxiesSimple.handleSimpleObject = handleSimpleObject;
}
