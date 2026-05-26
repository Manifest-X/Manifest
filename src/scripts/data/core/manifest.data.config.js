/* Manifest Data Sources - Configuration */

// Load manifest if not already loaded (loader may set __manifestLoaded / registry.manifest)
async function ensureManifest() {
    if (window.ManifestComponentsRegistry?.manifest) {
        return window.ManifestComponentsRegistry.manifest;
    }
    if (window.__manifestLoaded) {
        return window.__manifestLoaded;
    }

    try {
        const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
        const response = await fetch(manifestUrl);
        const manifest = await response.json();
        interpolateManifest(manifest);
        return manifest;
    } catch (error) {
        console.error('[Manifest Data] Failed to load manifest:', error);
        return null;
    }
}

// Helper to interpolate environment variables
function interpolateEnvVars(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        // Check for environment variables (in browser, these would be set by build process)
        if (typeof process !== 'undefined' && process.env && process.env[varName]) {
            return process.env[varName];
        }
        // Check for window.env (common pattern for client-side env vars)
        if (typeof window !== 'undefined' && window.env && window.env[varName]) {
            return window.env[varName];
        }
        // Return original if not found
        return match;
    });
}

// Recursively walk a manifest object and interpolate every string value in
// place. Object keys are left untouched. Called once at manifest-load time so
// downstream consumers (auth, data, appwrite) read already-resolved values.
function interpolateManifest(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            const v = obj[i];
            if (typeof v === 'string') {
                obj[i] = interpolateEnvVars(v);
            } else if (v !== null && typeof v === 'object') {
                interpolateManifest(v);
            }
        }
        return obj;
    }
    for (const key of Object.keys(obj)) {
        const v = obj[key];
        if (typeof v === 'string') {
            obj[key] = interpolateEnvVars(v);
        } else if (v !== null && typeof v === 'object') {
            interpolateManifest(v);
        }
    }
    return obj;
}

// Helper to get nested value from object
function getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => {
        return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
}

// Get default locale (first locale key) from a localized data source
function getDefaultLocale(dataSource) {
    if (typeof dataSource !== 'object' || dataSource === null) {
        return null;
    }

    // If using "locales" key (single CSV with multiple locale columns), return null
    // The CSV parser will handle locale selection internally
    if (dataSource.locales) {
        return null;
    }

    // Find first locale key (valid language code that's not a config key)
    const configKeys = ['url', 'headers', 'params', 'transform', 'defaultValue', 'locales'];
    for (const key of Object.keys(dataSource)) {
        if (!configKeys.includes(key) &&
            typeof dataSource[key] === 'string' &&
            /^[a-zA-Z0-9_-]+$/.test(key)) {
            return key;
        }
    }
    return null;
}

// Parse content path with array support (currently unused but kept for future)
function parseContentPath(path) {
    const parts = [];
    let currentPart = '';
    let inBrackets = false;

    for (let i = 0; i < path.length; i++) {
        const char = path[i];
        if (char === '[') {
            if (currentPart) {
                parts.push(currentPart);
                currentPart = '';
            }
            inBrackets = true;
        } else if (char === ']') {
            if (currentPart) {
                parts.push(parseInt(currentPart));
                currentPart = '';
            }
            inBrackets = false;
        } else if (char === '.' && !inBrackets) {
            if (currentPart) {
                parts.push(currentPart);
                currentPart = '';
            }
        } else {
            currentPart += char;
        }
    }

    if (currentPart) {
        parts.push(currentPart);
    }

    return parts;
}

// Check if a data source is an Appwrite table or bucket
function isAppwriteCollection(dataSource) {
    return dataSource && typeof dataSource === 'object' &&
        (dataSource.appwriteTableId || dataSource.appwriteBucketId);
}

// Get Appwrite configuration for a data source
// If dataSource is not provided, returns global config only
async function getAppwriteConfig(dataSource = null) {
    const manifest = await ensureManifest();
    if (!manifest) return null;

    // Get global Appwrite config
    const globalConfig = manifest.appwrite || {};

    // If no dataSource provided, return global config only
    if (!dataSource || typeof dataSource !== 'object') {
        return {
            projectId: globalConfig.projectId,
            endpoint: globalConfig.endpoint,
            databaseId: globalConfig.databaseId || 'main',
            devKey: globalConfig.devKey
        };
    }

    // Per-source config can override global
    const sourceConfig = {
        projectId: dataSource.appwriteProjectId || globalConfig.projectId,
        endpoint: dataSource.appwriteEndpoint || globalConfig.endpoint,
        databaseId: dataSource.appwriteDatabaseId || globalConfig.databaseId || 'main',
        devKey: dataSource.appwriteDevKey || globalConfig.devKey
    };

    // Validate required fields
    if (!sourceConfig.projectId || !sourceConfig.endpoint) {
        return null;
    }

    return sourceConfig;
}

// Get Appwrite table ID from data source
function getAppwriteTableId(dataSource) {
    return dataSource?.appwriteTableId || null;
}

// Get Appwrite bucket ID from data source
function getAppwriteBucketId(dataSource) {
    return dataSource?.appwriteBucketId || null;
}

// Get scope from data source (for query building)
// Scope must be "user" (uses userId column) or "team" (uses teamId column)
function getScope(dataSource) {
    return dataSource?.scope || null;
}

// Get auto-injection config from data source
// Controls whether userId/teamId are automatically injected on create
function getAutoInjectConfig(dataSource) {
    return {
        userId: dataSource?.autoInjectUserId !== false, // Default: true (inject userId)
        teamId: dataSource?.autoInjectTeamId !== false  // Default: true (inject teamId for team scopes)
    };
}

// Get queries configuration from data source
function getQueries(dataSource) {
    return dataSource?.queries || null;
}

// Export functions to window for use by other subscripts
window.ManifestDataConfig = {
    ensureManifest,
    interpolateEnvVars,
    interpolateManifest,
    getNestedValue,
    getDefaultLocale,
    parseContentPath,
    isAppwriteCollection,
    getAppwriteConfig,
    getAppwriteTableId,
    getAppwriteBucketId,
    getScope,
    getQueries,
    getAutoInjectConfig
};

