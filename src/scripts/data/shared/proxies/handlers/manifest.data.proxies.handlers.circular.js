/* Manifest Data Sources - Circular Reference Handler */
// Breaks infinite recursion when Alpine re-evaluates an expression that
// re-reads a property still being accessed. Returns the cached plain copy if
// available, else undefined to break the cycle.
function handleCircularReference({
    activeProps,
    propKey,
    rawTarget,
    path,
    key,
    fullPath,
    currentDepth,
    triggeredBy,
    shouldLog
}) {
    if (!activeProps || !activeProps.has(propKey)) {
        return null; // Not circular, continue normal flow
    }

    if (shouldLog) {
        console.warn(`[Manifest Data] ⚠️ CIRCULAR ${fullPath} | depth:${currentDepth} | triggered by:${triggeredBy} | This is likely Alpine re-evaluation`);
    }

    // Prop already in flight (Alpine re-evaluating): hand back the cached plain
    // copy so Alpine gets the same instance and doesn't recurse.
    try {
        let current = rawTarget;
        let pathValid = true;
        const accessPath = path.length === 0 ? [key] : [...path, key];

        for (let i = 0; i < accessPath.length; i++) {
            const pathKey = accessPath[i];
            if (current && typeof current === 'object' && pathKey in current) {
                current = current[pathKey];
            } else {
                pathValid = false;
                break;
            }
        }

        if (pathValid && current !== undefined && current !== null) {
            // If it's a primitive, return it directly
            if (typeof current !== 'object' || current === null) {
                if (activeProps) {
                    activeProps.delete(propKey);
                }
                return current;
            }

            // Simple object: return its cached plain copy if present
            if (!Array.isArray(current)) {
                let isSimpleObject = true;
                try {
                    for (const prop in current) {
                        if (typeof current[prop] === 'object' && current[prop] !== null) {
                            isSimpleObject = false;
                            break;
                        }
                    }
                } catch (e) {
                    isSimpleObject = false;
                }

                if (isSimpleObject) {
                    if (!window.ManifestDataProxiesCore.frozenPlainCopyCache) {
                        window.ManifestDataProxiesCore.frozenPlainCopyCache = new WeakMap();
                    }
                    const plainCopyCache = window.ManifestDataProxiesCore.frozenPlainCopyCache;
                    const cachedCopy = plainCopyCache.get(current);

                    if (cachedCopy) {
                        // Leave propKey in activeProps — normal flow clears it
                        return cachedCopy;
                    }
                }
            }
        }
    } catch (e) {
        if (shouldLog) {
            console.error(`[Manifest Data] ${fullPath} | Error in circular check:`, e);
        }
    }

    // If we can't return a cached copy, return undefined to break the cycle
    if (shouldLog) {
        console.warn(`[Manifest Data] ${fullPath} | ⚠️ CIRCULAR - returning undefined to break cycle`);
    }
    if (activeProps) {
        activeProps.delete(propKey);
    }
    return undefined;
}

// Export to window for use by proxy creation modules
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxiesHandlers) {
        window.ManifestDataProxiesHandlers = {};
    }
    window.ManifestDataProxiesHandlers.handleCircularReference = handleCircularReference;
}
