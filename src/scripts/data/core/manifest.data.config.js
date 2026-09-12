/* Manifest Data Sources - Configuration */

// Load manifest if not already loaded (loader may set __manifestLoaded / registry.manifest).
// Only trust a cached global if it looks like a real Manifest config — another plugin
// doing `window.__manifestLoaded.foo = …` before the loader populates it (or in a
// no-loader setup) can leave a stub without `data`/`components`, which would otherwise
// mask every data source. Fall through to fetching the real manifest in that case.
async function ensureManifest() {
    const looksComplete = (m) => m && typeof m === 'object' &&
        (m.data || m.components || m.preloadedComponents || m.appwrite || m.render);
    if (looksComplete(window.ManifestComponentsRegistry?.manifest)) {
        return window.ManifestComponentsRegistry.manifest;
    }
    if (looksComplete(window.__manifestLoaded)) {
        return window.__manifestLoaded;
    }

    // One request per boot, shared with the loader and the other plugins (window.__manifestPromise)
    if (window.__manifestPromise) {
        const shared = await window.__manifestPromise.catch(() => null);
        if (looksComplete(shared)) return shared;
    }
    try {
        const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
        window.__manifestPromise = fetch(manifestUrl).then(r => r.json()).then(m => { interpolateManifest(m); return m; });
        return await window.__manifestPromise;
    } catch (error) {
        console.error('[Manifest Data] Failed to load manifest:', error);
        return null;
    }
}

// Interpolate ${VAR} placeholders in a string against window.env. Only
// PUBLIC_-prefixed vars reach window.env (the mnfst-run dev server filters
// .env by that prefix to keep server-side secrets like MANIFEST_API_KEY out
// of the browser). Misses warn once per name so a missing var doesn't fail
// silently downstream as an empty URL / endpoint.
const _warnedMissingEnv = new Set();
function interpolateEnvVars(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/\$\{([^}]+)\}/g, (match, varName) => {
        if (typeof process !== 'undefined' && process.env && process.env[varName]) {
            return process.env[varName];
        }
        if (typeof window !== 'undefined' && window.env && window.env[varName]) {
            return window.env[varName];
        }
        if (!_warnedMissingEnv.has(varName)) {
            _warnedMissingEnv.add(varName);
            if (!varName.startsWith('PUBLIC_')) {
                console.warn(
                    `[Manifest Data] data source references \${${varName}}, but only ` +
                    `PUBLIC_-prefixed env vars are injected into window.env by mnfst-run. ` +
                    `Rename to PUBLIC_${varName}, hardcode the value, or supply it via ` +
                    `<script>window.env = {…}</script>. Leaving placeholder literal.`
                );
            } else {
                console.warn(
                    `[Manifest Data] data source references \${${varName}}, but it is not ` +
                    `present in window.env. Add ${varName}=… to .env (read by mnfst-run) ` +
                    `or set it via <script>window.env = {…}</script>. Leaving placeholder literal.`
                );
            }
        }
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

// Get scope column names for a data source (for query building + write-side auto-inject).
// dataSource.scopeColumn can be a string (applies to both team/user) or
// { team: "workspaceId", user: "ownerId" } to name them independently.
// Defaults to teamId/userId when unset.
function getScopeColumns(dataSource) {
    const raw = dataSource?.scopeColumn;
    if (raw && typeof raw === 'object') {
        return {
            team: raw.team || 'teamId',
            user: raw.user || 'userId'
        };
    }
    if (typeof raw === 'string' && raw) {
        return { team: raw, user: raw };
    }
    return { team: 'teamId', user: 'userId' };
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
    getScopeColumns,
    getQueries,
    getAutoInjectConfig
};

