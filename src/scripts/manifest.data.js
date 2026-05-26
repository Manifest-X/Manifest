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



/* Manifest Data Sources - Store Management */

// Cache for loaded data sources (raw data, not in Alpine store to avoid double-proxying)
const dataSourceCache = new Map();
const loadingPromises = new Map();

// Store raw data separately from Alpine's reactive store
// This prevents Alpine from proxying our data, which causes recursion when we proxy it
const rawDataStore = new Map();

// Track initialization state
let isInitializing = false;
let initializationComplete = false;

// Render-ready: debounced timer used by checkAndDispatchRenderReady
let _renderReadyTimer = null;
const RENDER_READY_QUIET_MS = 150; // ms of quiet (no loading) before firing

// Deep seal an object to prevent Alpine from making it reactive
// This prevents double-proxying which causes recursion errors
function deepSeal(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    // Seal arrays and objects to prevent Alpine from proxying them
    Object.seal(obj);

    // Recursively seal nested objects and arrays
    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (item !== null && typeof item === 'object') {
                deepSeal(item);
            }
        }
    } else {
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const value = obj[key];
                if (value !== null && typeof value === 'object') {
                    deepSeal(value);
                }
            }
        }
    }

    return obj;
}

// Update store with new data
function updateStore(dataSourceName, data, options = {}) {
    if (isInitializing && !options.allowDuringInit) return;

    // Store raw data in our non-reactive Map for backup access
    rawDataStore.set(dataSourceName, data);

    // Store data in Alpine's reactive store (like backup did)
    // Alpine will handle reactivity, and our proxies will work on top
    const store = Alpine.store('data');

    // Filter out null/undefined items and items matching this data source
    const all = (store.all || []).filter(item =>
        item !== null &&
        item !== undefined &&
        item.contentType !== dataSourceName
    );

    // Only add data to 'all' array if it's not null/undefined
    if (data !== null && data !== undefined) {
        if (Array.isArray(data)) {
            all.push(...data);
        } else {
            all.push(data);
        }
    }

    // Get current state for this data source (or defaults)
    const currentState = store[`_${dataSourceName}_state`] || {
        loading: false,
        error: null,
        ready: false
    };

    // Update state based on options
    const newState = {
        loading: options.loading !== undefined ? options.loading : currentState.loading,
        error: options.error !== undefined ? options.error : currentState.error,
        ready: options.ready !== undefined ? options.ready : (data !== null && data !== undefined),
        errorTime: options.error !== undefined && options.error !== null ? Date.now() : (currentState.errorTime || null)
    };

    // Use Alpine's reactive store update to trigger reactivity
    // Create a new object reference to ensure Alpine detects the change
    // Also create new references for nested arrays (like fileIds) so Alpine can track nested property changes
    const reactiveData = Array.isArray(data)
        ? (createReactiveReferences ? createReactiveReferences(data, dataSourceName) : data)
        : data;

    // Bump version so any effect that read the store re-runs (fixes bindings stuck on loading fallback)
    const dataVersion = (store._dataVersion || 0) + 1;
    const updatedStore = {
        ...store,
        [dataSourceName]: reactiveData, // Store actual data in Alpine store (like backup)
        [`_${dataSourceName}_state`]: newState, // Store state for this data source
        all,
        _initialized: true,
        _ready: true, // Mark as ready when first data source is loaded
        _dataVersion: dataVersion
    };

    Alpine.store('data', updatedStore);

    // When a source finishes loading (success or error), check if everything is settled.
    // This is the primary trigger for manifest:render-ready.
    if (!newState.loading) {
        checkAndDispatchRenderReady();
    }

    // Attach methods to array if it's an array (for new architecture)
    // This ensures methods are available on the new array reference
    if (Array.isArray(reactiveData) && window.ManifestDataProxies?.attachArrayMethods) {
        // Get the loadDataSource function from main module
        const loadDataSource = window.ManifestDataMain?.loadDataSource;
        if (loadDataSource) {
            window.ManifestDataProxies.attachArrayMethods(reactiveData, dataSourceName, loadDataSource);
        }
    }

    // Clear proxy cache for this data source to force re-reading from store
    if (window.ManifestDataProxies?.clearAccessCache) {
        window.ManifestDataProxies.clearAccessCache(dataSourceName);
    }
    // Clear array proxy cache to ensure Alpine gets fresh proxy
    if (window.ManifestDataProxies?.clearArrayProxyCacheForDataSource) {
        window.ManifestDataProxies.clearArrayProxyCacheForDataSource(dataSourceName);
    }
    // Clear route proxy cache to ensure fresh route proxies
    if (window.ManifestDataProxies?.clearRouteProxyCacheForDataSource) {
        window.ManifestDataProxies.clearRouteProxyCacheForDataSource(dataSourceName);
    }
    // Clear nested proxy cache so next $x.dataSourceName access builds from new store data
    if (window.ManifestDataProxies?.clearNestedProxyCacheForDataSource) {
        window.ManifestDataProxies.clearNestedProxyCacheForDataSource(dataSourceName);
    }
}

// Get raw data from our non-reactive store
function getRawData(dataSourceName) {
    return rawDataStore.get(dataSourceName);
}

// Create new object/array references for Alpine reactivity
// This ensures nested arrays (like fileIds) get new references so Alpine can track changes
function createReactiveReferences(data, dataSourceName = null) {
    if (data === null || data === undefined) {
        return data;
    }

    if (Array.isArray(data)) {
        // Create new array with new references for each item
        return data.map(item => createReactiveReferences(item, dataSourceName));
    }

    if (typeof data === 'object') {
        // Create new object with new references for each property
        const newObj = {};
        for (const key in data) {
            if (data.hasOwnProperty(key)) {
                const value = data[key];
                // Recursively create new references for nested objects/arrays
                newObj[key] = createReactiveReferences(value, dataSourceName);
            }
        }

        // Detect file objects (have mimeType or sizeOriginal)
        const isFile = data.$id &&
            typeof data.$id === 'string' &&
            (data.mimeType || data.sizeOriginal !== undefined);

        // Detect database entries (have $id but no mimeType/sizeOriginal)
        const isDatabaseEntry = data.$id &&
            typeof data.$id === 'string' &&
            !data.mimeType &&
            !data.sizeOriginal;

        if (isDatabaseEntry) {
            const createComputedFilesArray = window.ManifestDataProxiesFiles?.createComputedFilesArray;
            const ensureManifest = window.ManifestDataConfig?.ensureManifest;

            if (createComputedFilesArray && ensureManifest) {
                // SINGLE SOURCE OF TRUTH: Create computed files array that filters bucket by fileIds
                // This automatically stays in sync with both bucket changes and fileIds changes
                ensureManifest().then(manifest => {
                    const tableDataSource = manifest?.data?.[dataSourceName];
                    const storageConfig = tableDataSource?.storage;
                    const bucketName = storageConfig ? Object.keys(storageConfig)[0] : null;

                    if (bucketName) {
                        // Get column name from storage config
                        const bucketConfig = storageConfig[bucketName];
                        const columnName = typeof bucketConfig === 'string'
                            ? bucketConfig
                            : (bucketConfig?.column || 'fileIds');

                        // Create computed files array - this filters bucket array by entry's fileIds
                        const computedFiles = createComputedFilesArray(
                            dataSourceName,
                            data.$id,
                            bucketName,
                            columnName
                        );

                        // Assign computed array to entry
                        newObj.$files = computedFiles;

                        // Add loading/error getters that read from computed array
                        Object.defineProperty(newObj, '$filesLoading', {
                            enumerable: false,
                            configurable: true,
                            get() {
                                return computedFiles.$loading || false;
                            }
                        });

                        Object.defineProperty(newObj, '$filesError', {
                            enumerable: false,
                            configurable: true,
                            get() {
                                return computedFiles.$error || null;
                            }
                        });
                    } else {
                        // No bucket configured - create empty array
                        newObj.$files = typeof Alpine !== 'undefined' && Alpine.reactive
                            ? Alpine.reactive([])
                            : [];
                        Object.defineProperty(newObj, '$filesLoading', {
                            enumerable: false,
                            configurable: true,
                            get() { return false; }
                        });
                        Object.defineProperty(newObj, '$filesError', {
                            enumerable: false,
                            configurable: true,
                            get() { return null; }
                        });
                    }
                }).catch(err => {
                    // On error, create empty array
                    newObj.$files = typeof Alpine !== 'undefined' && Alpine.reactive
                        ? Alpine.reactive([])
                        : [];
                    Object.defineProperty(newObj, '$filesLoading', {
                        enumerable: false,
                        configurable: true,
                        get() { return false; }
                    });
                    Object.defineProperty(newObj, '$filesError', {
                        enumerable: false,
                        configurable: true,
                        get() { return err.message || 'Failed to load manifest'; }
                    });
                });
            } else {
                // Fallback: create empty array
                newObj.$files = typeof Alpine !== 'undefined' && Alpine.reactive
                    ? Alpine.reactive([])
                    : [];
                Object.defineProperty(newObj, '$filesLoading', {
                    enumerable: false,
                    configurable: true,
                    get() { return false; }
                });
                Object.defineProperty(newObj, '$filesError', {
                    enumerable: false,
                    configurable: true,
                    get() { return null; }
                });
            }
        }

        // Add computed properties to file objects
        if (isFile && dataSourceName) {
            // Add $isImage computed property
            Object.defineProperty(newObj, '$isImage', {
                enumerable: false,
                configurable: true,
                get() {
                    return data.mimeType && typeof data.mimeType === 'string' && data.mimeType.startsWith('image/');
                }
            });

            // Add $isPdf computed property
            Object.defineProperty(newObj, '$isPdf', {
                enumerable: false,
                configurable: true,
                get() {
                    return data.mimeType === 'application/pdf';
                }
            });

            // Add $formattedSize computed property
            Object.defineProperty(newObj, '$formattedSize', {
                enumerable: false,
                configurable: true,
                get() {
                    if (!data.sizeOriginal || typeof data.sizeOriginal !== 'number') {
                        return null;
                    }
                    const bytes = data.sizeOriginal;
                    if (bytes < 1024) return bytes + ' B';
                    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
                    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
                    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
                }
            });

            // Add $formattedDate computed property
            Object.defineProperty(newObj, '$formattedDate', {
                enumerable: false,
                configurable: true,
                get() {
                    if (!data.$createdAt) return null;
                    try {
                        return new Date(data.$createdAt).toLocaleString();
                    } catch (e) {
                        return null;
                    }
                }
            });

            // Add $thumbnailUrl - lazy-loaded, reactive property
            // This will be populated when accessed if the file is an image
            // Use reactive state for Alpine reactivity
            const thumbnailState = typeof Alpine !== 'undefined' && Alpine.reactive
                ? Alpine.reactive({ url: null, loading: false, error: null })
                : { url: null, loading: false, error: null };

            Object.defineProperty(newObj, '$thumbnailUrl', {
                enumerable: false,
                configurable: true,
                get() {
                    // Only load thumbnail for images
                    if (!newObj.$isImage) {
                        return null;
                    }

                    // Return cached URL if available
                    if (thumbnailState.url) {
                        return thumbnailState.url;
                    }

                    // Lazy-load thumbnail URL if not already loading/loaded
                    if (!thumbnailState.loading && !thumbnailState.error && typeof window !== 'undefined' && window.$x && window.$x[dataSourceName]) {
                        thumbnailState.loading = true;
                        const bucketArray = window.$x[dataSourceName];
                        if (bucketArray && typeof bucketArray.$url === 'function') {
                            bucketArray.$url(data.$id)
                                .then(url => {
                                    // Append mode=admin for testing (can be made configurable later)
                                    thumbnailState.url = url + (url.includes('?') ? '&' : '?') + 'mode=admin';
                                    thumbnailState.loading = false;
                                    thumbnailState.error = null;
                                })
                                .catch(err => {
                                    thumbnailState.error = err.message || 'Failed to load thumbnail';
                                    thumbnailState.loading = false;
                                    console.error('[Manifest Data] Failed to load thumbnail URL for', data.$id, err);
                                });
                        } else {
                            thumbnailState.loading = false;
                        }
                    }

                    return thumbnailState.url; // Return null while loading, URL when loaded
                }
            });

            // Add $thumbnailError computed property
            Object.defineProperty(newObj, '$thumbnailError', {
                enumerable: false,
                configurable: true,
                get() {
                    return thumbnailState.error;
                }
            });

            // Add $thumbnailLoading computed property
            Object.defineProperty(newObj, '$thumbnailLoading', {
                enumerable: false,
                configurable: true,
                get() {
                    return thumbnailState.loading;
                }
            });
        }

        return newObj;
    }

    // Primitives can be returned as-is
    return data;
}

// Initialize store
function initializeStore() {
    const initialStore = {
        all: [], // Global content array for cross-dataSource access
        _initialized: false,
        _ready: false, // Flag to indicate when data is ready for Alpine evaluation
        _dataVersion: 0, // Bumped in updateStore so bindings re-run when data loads
        _currentUrl: window.location.pathname,
        // Operation-specific loading states (for UI reactivity)
        // Format: { dataSourceName: { entryId: true } }
        _creatingEntry: {}, // { dataSourceName: { entryId: true } }
        _updatingEntry: {}, // { dataSourceName: { entryId: true } }
        _deletingEntry: {}, // { dataSourceName: { entryId: true } }
        _uploadingFile: {}, // { dataSourceName: { entryId: { fileId: true } } }

        // Helper methods to check operation-specific loading states (accessible via $data)
        isCreatingEntry(dataSourceName, entryId) {
            return isCreatingEntry(dataSourceName, entryId);
        },
        isUpdatingEntry(dataSourceName, entryId) {
            return isUpdatingEntry(dataSourceName, entryId);
        },
        isDeletingEntry(dataSourceName, entryId) {
            return isDeletingEntry(dataSourceName, entryId);
        },
        isUploadingFile(dataSourceName, entryId, fileId = null) {
            return isUploadingFile(dataSourceName, entryId, fileId);
        }
    };
    Alpine.store('data', initialStore);
}

// Listen for team changes to reload team-scoped data sources
function setupTeamChangeListener() {
    if (typeof Alpine === 'undefined') return;

    let lastTeamId = null;
    let checking = false;

    const checkTeamChange = async () => {
        if (checking) return;
        checking = true;

        try {
            const authStore = Alpine.store('auth');
            if (!authStore) {
                checking = false;
                return;
            }

            const currentTeamId = authStore.currentTeam?.$id || null;

            if (currentTeamId !== lastTeamId) {
                lastTeamId = currentTeamId;

                // Get manifest to identify team-scoped data sources
                const manifest = await window.ManifestDataConfig.ensureManifest();
                if (!manifest?.data) {
                    checking = false;
                    return;
                }

                // Find team-scoped data sources (both "team" and "teams" scopes, including dual scope)
                const teamScopedDataSources = Object.entries(manifest.data)
                    .filter(([name, config]) => {
                        if (typeof config === 'object' && config.scope) {
                            const scope = config.scope;
                            // Check for "team", "teams", or array containing team/teams
                            if (scope === 'team' || scope === 'teams') {
                                return true;
                            }
                            if (Array.isArray(scope) && (scope.includes('team') || scope.includes('teams'))) {
                                return true;
                            }
                        }
                        return false;
                    })
                    .map(([name]) => name);

                if (teamScopedDataSources.length === 0) {
                    checking = false;
                    return;
                }

                // Clear cache for team-scoped data sources (similar to locale change)
                teamScopedDataSources.forEach(dataSourceName => {
                    // Clear all locale variants of this data source
                    const keysToDelete = [];
                    for (const key of dataSourceCache.keys()) {
                        if (key.startsWith(`${dataSourceName}:`)) {
                            keysToDelete.push(key);
                        }
                    }
                    keysToDelete.forEach(key => dataSourceCache.delete(key));

                    // Clear loading promises for this data source
                    const promisesToDelete = [];
                    for (const key of loadingPromises.keys()) {
                        if (key.startsWith(`${dataSourceName}:`)) {
                            promisesToDelete.push(key);
                        }
                    }
                    promisesToDelete.forEach(key => loadingPromises.delete(key));
                });

                // Remove team-scoped data from store
                const store = Alpine.store('data');
                if (store) {
                    const newStore = { ...store };
                    teamScopedDataSources.forEach(dataSourceName => {
                        delete newStore[dataSourceName];
                    });
                    Alpine.store('data', newStore);
                }

                // Clear proxy cache for these data sources
                teamScopedDataSources.forEach(dataSourceName => {
                    if (window.ManifestDataProxies && window.ManifestDataProxies.clearAccessCache) {
                        window.ManifestDataProxies.clearAccessCache(dataSourceName);
                    }
                });

                // Actually reload the data sources (not just clear cache)
                // This ensures data is fresh when team changes

                // Reload each data source by calling loadDataSource directly
                const loadDataSource = window.ManifestDataMain?.loadDataSource;
                if (loadDataSource) {
                    // Reload all team-scoped data sources with new team context
                    Promise.all(teamScopedDataSources.map(async (dataSourceName) => {
                        try {
                            // Reload with new team context
                            await loadDataSource(dataSourceName);
                        } catch (error) {
                            console.error('[Manifest Data] Failed to reload data source after team change:', dataSourceName, error);
                        }
                    })).then(() => {
                    });
                } else {
                    // Fallback: Delete from store to force reload on next access
                    const store = Alpine.store('data');
                    if (store) {
                        const newStore = { ...store };
                        teamScopedDataSources.forEach(dataSourceName => {
                            delete newStore[dataSourceName];
                        });
                        Alpine.store('data', newStore);
                    }
                }
            }
        } catch (error) {
            console.error('[Manifest Data] Error handling team change:', error);
        } finally {
            checking = false;
        }
    };

    // Wait for Alpine and auth store to be ready, then start polling
    let teamCheckIntervalId = null;
    const startPolling = () => {
        const authStore = Alpine.store('auth');
        if (authStore) {
            lastTeamId = authStore.currentTeam?.$id || null;
            if (!teamCheckIntervalId) {
                // Poll every 2s to limit CPU wakeups; team changes are rare
                teamCheckIntervalId = setInterval(checkTeamChange, 2000);
            }
        } else {
            setTimeout(startPolling, 100);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startPolling);
    } else {
        startPolling();
    }
}

// Dispatch manifest:render-ready when all tracked data sources have settled.
// Uses a debounce so rapid sequential source completions coalesce into one event.
// The render script listens for this event instead of polling internal store state.
function checkAndDispatchRenderReady() {
    if (_renderReadyTimer) {
        clearTimeout(_renderReadyTimer);
    }
    _renderReadyTimer = setTimeout(() => {
        _renderReadyTimer = null;
        try {
            if (typeof window === 'undefined' || typeof Alpine === 'undefined') return;
            const store = Alpine.store('data');
            if (!store) return;

            // Don't fire while a locale change is still in progress
            if (store._localeChanging) return;

            // Don't fire if any source state still shows loading
            for (const key of Object.keys(store)) {
                if (key.startsWith('_') && key.endsWith('_state')) {
                    if (store[key]?.loading) return;
                }
            }

            // Don't fire if any fetch promises are still in flight
            if (loadingPromises.size > 0) return;

            // All settled — dispatch the authoritative prerender signal
            const locale =
                (typeof document !== 'undefined' && document.documentElement.lang) ||
                Alpine.store('locale')?.current ||
                'en';
            const sources = Object.keys(store).filter(k => !k.startsWith('_') && k !== 'all');

            window.dispatchEvent(new CustomEvent('manifest:render-ready', {
                detail: { locale, sources }
            }));
        } catch {
            // Silently fail — the render script has its own timeout fallback
        }
    }, RENDER_READY_QUIET_MS);
}

// Listen for locale changes to reload data
function setupLocaleChangeListener() {
    window.addEventListener('localechange', async (event) => {
        const newLocale = event.detail.locale;

        // Set loading state to prevent flicker
        const store = Alpine.store('data');
        if (store) {
            Alpine.store('data', {
                ...store,
                _localeChanging: true
            });
        }

        try {
            // Get manifest to identify localized data sources
            const manifest = await window.ManifestDataConfig.ensureManifest();
            if (!manifest?.data) return;

            // Find localized data sources (those with locale keys or "locales" key, or CSV files with locale columns)
            const localizedDataSources = [];
            const csvChecks = []; // Track async CSV checks

            Object.entries(manifest.data).forEach(([name, config]) => {
                if (typeof config === 'object' && !config.url) {
                    // Check if it has "locales" key (single CSV with multiple locale columns)
                    if (config.locales) {
                        localizedDataSources.push(name);
                    } else {
                        // Check if it has locale keys (separate files per locale)
                        const hasLocaleKeys = Object.keys(config).some(key => {
                            // Check if key is a valid language code (not a config key)
                            const configKeys = ['url', 'headers', 'params', 'transform', 'defaultValue', 'locales'];
                            return !configKeys.includes(key) &&
                                typeof config[key] === 'string' &&
                                /^[a-zA-Z0-9_-]+$/.test(key);
                        });
                        if (hasLocaleKeys) {
                            localizedDataSources.push(name);
                        }
                    }
                } else if (typeof config === 'string' && config.endsWith('.csv')) {
                    // Simple CSV file path - check if it has locale columns
                    // We'll check by fetching the header row (async, but we'll wait for it)
                    csvChecks.push(
                        fetch(config)
                            .then(response => response.text())
                            .then(text => {
                                const lines = text.split('\n').filter(line => line.trim());
                                if (lines.length > 0) {
                                    const headers = lines[0].split(',').map(h => h.trim());
                                    // Check if this looks like a localized CSV (has 'key' column + locale columns)
                                    const firstHeader = headers[0]?.toLowerCase();
                                    if (firstHeader === 'key' && headers.length > 1) {
                                        // Check if any header after 'key' looks like a locale code
                                        const hasLocaleColumns = headers.slice(1).some(header =>
                                            /^[a-zA-Z0-9_-]+$/.test(header) && header.length >= 2
                                        );
                                        if (hasLocaleColumns) {
                                            localizedDataSources.push(name);
                                        }
                                    }
                                }
                            })
                            .catch(() => {
                                // Silently fail - assume not localized
                            })
                    );
                }
            });

            // Wait for all CSV checks to complete before proceeding
            await Promise.all(csvChecks);

            // Only clear cache for localized data sources
            localizedDataSources.forEach(dataSourceName => {
                // Clear all locale variants of this data source
                const keysToDelete = [];
                for (const key of dataSourceCache.keys()) {
                    if (key.startsWith(`${dataSourceName}:`)) {
                        keysToDelete.push(key);
                    }
                }
                keysToDelete.forEach(key => dataSourceCache.delete(key));

                // Clear loading promises for this data source
                const promisesToDelete = [];
                for (const key of loadingPromises.keys()) {
                    if (key.startsWith(`${dataSourceName}:`)) {
                        promisesToDelete.push(key);
                    }
                }
                promisesToDelete.forEach(key => loadingPromises.delete(key));

                // Clear nested proxy cache for this data source
                // This ensures fresh proxies are created with new locale data
                if (window.ManifestDataProxies?.clearNestedProxyCacheForDataSource) {
                    window.ManifestDataProxies.clearNestedProxyCacheForDataSource(dataSourceName);
                }

                // Clear raw data so $x.content (etc.) doesn't serve stale locale until reload completes
                rawDataStore.delete(dataSourceName);
            });

            // Remove localized data from store so bindings see missing data and re-run
            const store = Alpine.store('data');
            if (store && store.all) {
                const filteredAll = store.all.filter(item =>
                    !localizedDataSources.includes(item.contentType)
                );

                const newStore = { ...store, all: filteredAll };
                localizedDataSources.forEach(dataSourceName => {
                    delete newStore[dataSourceName];
                    delete newStore[`_${dataSourceName}_state`];
                });

                const dataVersion = (store._dataVersion || 0) + 1;
                Alpine.store('data', {
                    ...newStore,
                    _localeChanging: false,
                    _dataVersion: dataVersion
                });
            }

            // Proactively reload localized sources with the new locale so the UI updates.
            // (Relying only on Alpine re-evaluating $x.content after store change is unreliable.)
            const loadDataSource = window.ManifestDataMain?.loadDataSource;
            if (loadDataSource && localizedDataSources.length > 0) {
                await Promise.all(
                    localizedDataSources.map(name => loadDataSource(name, newLocale))
                );
            }

            // All localized sources have reloaded — check if everything is settled.
            // This fires manifest:render-ready after a locale change completes end-to-end.
            checkAndDispatchRenderReady();

        } catch (error) {
            console.error('[Manifest Data] Error handling locale change:', error);
            // Fallback to full reload if something goes wrong
            dataSourceCache.clear();
            loadingPromises.clear();
            Alpine.store('data', {
                all: [],
                _initialized: true,
                _localeChanging: false
            });
        }
    });
}

// Helper functions to manage operation-specific loading states
// Use objects with entry IDs as keys for Alpine reactivity
function setCreatingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store) return;

    // Ensure _creatingEntry exists
    if (!store._creatingEntry) {
        store._creatingEntry = {};
    }
    if (!store._creatingEntry[dataSourceName]) {
        store._creatingEntry[dataSourceName] = {};
    }
    // Create new object reference for reactivity
    store._creatingEntry[dataSourceName] = {
        ...store._creatingEntry[dataSourceName],
        [entryId]: true
    };

    // Update store to trigger reactivity
    Alpine.store('data', {
        ...store,
        _creatingEntry: { ...store._creatingEntry }
    });
}

function clearCreatingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._creatingEntry || !store._creatingEntry[dataSourceName]) return;

    // Create new object without this entryId
    const { [entryId]: removed, ...rest } = store._creatingEntry[dataSourceName];
    store._creatingEntry[dataSourceName] = rest;

    // Update store to trigger reactivity
    Alpine.store('data', {
        ...store,
        _creatingEntry: { ...store._creatingEntry }
    });
}

function setUpdatingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store) return;

    // Ensure _updatingEntry exists
    if (!store._updatingEntry) {
        store._updatingEntry = {};
    }
    if (!store._updatingEntry[dataSourceName]) {
        store._updatingEntry[dataSourceName] = {};
    }
    // Create new object reference for reactivity
    store._updatingEntry[dataSourceName] = {
        ...store._updatingEntry[dataSourceName],
        [entryId]: true
    };

    // Update store to trigger reactivity
    Alpine.store('data', {
        ...store,
        _updatingEntry: { ...store._updatingEntry }
    });
}

function clearUpdatingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._updatingEntry || !store._updatingEntry[dataSourceName]) return;

    // Create new object without this entryId
    const { [entryId]: removed, ...rest } = store._updatingEntry[dataSourceName];
    store._updatingEntry[dataSourceName] = rest;

    // Update store to trigger reactivity
    Alpine.store('data', {
        ...store,
        _updatingEntry: { ...store._updatingEntry }
    });
}

function setDeletingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store) return;

    // Ensure _deletingEntry exists
    if (!store._deletingEntry) {
        store._deletingEntry = {};
    }
    if (!store._deletingEntry[dataSourceName]) {
        store._deletingEntry[dataSourceName] = {};
    }
    // Create new object reference for reactivity
    store._deletingEntry[dataSourceName] = {
        ...store._deletingEntry[dataSourceName],
        [entryId]: true
    };

    // Update store to trigger reactivity
    Alpine.store('data', {
        ...store,
        _deletingEntry: { ...store._deletingEntry }
    });
}

function clearDeletingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._deletingEntry || !store._deletingEntry[dataSourceName]) return;

    // Create new object without this entryId
    const { [entryId]: removed, ...rest } = store._deletingEntry[dataSourceName];
    store._deletingEntry[dataSourceName] = rest;

    // Update store to trigger reactivity
    Alpine.store('data', {
        ...store,
        _deletingEntry: { ...store._deletingEntry }
    });
}

function setUploadingFile(dataSourceName, entryId, fileId) {
    const store = Alpine.store('data');
    if (!store) return;

    // Ensure _uploadingFile exists
    if (!store._uploadingFile) {
        store._uploadingFile = {};
    }
    if (!store._uploadingFile[dataSourceName]) {
        store._uploadingFile[dataSourceName] = {};
    }
    if (!store._uploadingFile[dataSourceName][entryId]) {
        store._uploadingFile[dataSourceName][entryId] = {};
    }
    // Create new object reference for reactivity
    store._uploadingFile[dataSourceName][entryId] = {
        ...store._uploadingFile[dataSourceName][entryId],
        [fileId]: true
    };

    // Update store to trigger reactivity
    Alpine.store('data', {
        ...store,
        _uploadingFile: { ...store._uploadingFile }
    });
}

function clearUploadingFile(dataSourceName, entryId, fileId) {
    const store = Alpine.store('data');
    if (!store || !store._uploadingFile || !store._uploadingFile[dataSourceName] || !store._uploadingFile[dataSourceName][entryId]) return;

    // Create new object without this fileId
    const { [fileId]: removed, ...rest } = store._uploadingFile[dataSourceName][entryId];
    store._uploadingFile[dataSourceName][entryId] = rest;

    // Clean up empty entry objects
    if (Object.keys(store._uploadingFile[dataSourceName][entryId]).length === 0) {
        const { [entryId]: removedEntry, ...restEntries } = store._uploadingFile[dataSourceName];
        store._uploadingFile[dataSourceName] = restEntries;
    }

    // Update store to trigger reactivity
    Alpine.store('data', {
        ...store,
        _uploadingFile: { ...store._uploadingFile }
    });
}

// Helper methods to check operation-specific loading states
function isCreatingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._creatingEntry[dataSourceName]) return false;
    return !!store._creatingEntry[dataSourceName][entryId];
}

function isUpdatingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._updatingEntry[dataSourceName]) return false;
    return !!store._updatingEntry[dataSourceName][entryId];
}

function isDeletingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._deletingEntry[dataSourceName]) return false;
    return !!store._deletingEntry[dataSourceName][entryId];
}

function isUploadingFile(dataSourceName, entryId, fileId = null) {
    const store = Alpine.store('data');
    if (!store || !store._uploadingFile[dataSourceName] || !store._uploadingFile[dataSourceName][entryId]) return false;
    if (fileId === null) {
        // Check if any file is uploading for this entry
        return Object.keys(store._uploadingFile[dataSourceName][entryId]).length > 0;
    }
    return !!store._uploadingFile[dataSourceName][entryId][fileId];
}

// Export functions to window for use by other subscripts
window.ManifestDataStore = {
    dataSourceCache,
    loadingPromises,
    rawDataStore,
    isInitializing,
    initializationComplete,
    setIsInitializing: (value) => { isInitializing = value; },
    setInitializationComplete: (value) => { initializationComplete = value; },
    updateStore,
    getRawData,
    createReactiveReferences,
    initializeStore,
    setupLocaleChangeListener,
    setupTeamChangeListener,
    checkAndDispatchRenderReady,
    // Operation-specific loading state helpers
    setCreatingEntry,
    clearCreatingEntry,
    setUpdatingEntry,
    clearUpdatingEntry,
    setDeletingEntry,
    clearDeletingEntry,
    setUploadingFile,
    clearUploadingFile,
    isCreatingEntry,
    isUpdatingEntry,
    isDeletingEntry,
    isUploadingFile
};



/* Manifest Data Sources - File Loaders */

// Key names that would walk into Object's prototype chain if used as nested-
// path segments. Rejecting them in setNestedValue and deepMergeWithFallback
// prevents a CSV row like `__proto__.polluted, true` (or a malicious JSON
// locale file containing `{"__proto__": {...}}`) from polluting
// Object.prototype and silently affecting every plain object on the page.
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Dynamic js-yaml loader
let jsyaml = null;
let yamlLoadingPromise = null;

// Dynamic PapaParse CSV loader
let papaparse = null;
let csvLoadingPromise = null;

// Collect all path-like strings from manifest.data (recursive; includes nested locale objects)
function collectDataPaths(manifest) {
    const paths = [];
    if (!manifest?.data || typeof manifest.data !== 'object') return paths;
    function visit(val) {
        if (typeof val === 'string' && (val.startsWith('/') || /\.(yaml|yml|csv|json)$/i.test(val))) {
            paths.push(val);
        } else if (Array.isArray(val)) {
            val.forEach(visit);
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            Object.values(val).forEach(visit);
        }
    }
    Object.values(manifest.data).forEach(visit);
    return paths;
}

function manifestDataPathsInclude(manifest, extensions) {
    const paths = collectDataPaths(manifest);
    return paths.some(p => extensions.some(ext => p.toLowerCase().includes(ext)));
}

async function loadYamlLibrary() {
    if (jsyaml) return jsyaml;
    if (yamlLoadingPromise) return yamlLoadingPromise;

    const manifest = await window.ManifestDataConfig?.ensureManifest?.();
    if (manifest && !manifestDataPathsInclude(manifest, ['.yaml', '.yml'])) {
        yamlLoadingPromise = Promise.reject(new Error('[Manifest Data] No YAML paths in manifest - skipping loader'));
        return yamlLoadingPromise;
    }

    yamlLoadingPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/js-yaml/dist/js-yaml.min.js';
        script.onload = () => {
            if (typeof window.jsyaml !== 'undefined') {
                jsyaml = window.jsyaml;
                resolve(jsyaml);
            } else {
                console.error('[Manifest Data] js-yaml failed to load - jsyaml is undefined');
                yamlLoadingPromise = null; // Reset so we can try again
                reject(new Error('js-yaml failed to load'));
            }
        };
        script.onerror = (error) => {
            console.error('[Manifest Data] Script failed to load:', error);
            yamlLoadingPromise = null; // Reset so we can try again
            reject(error);
        };
        document.head.appendChild(script);
    });

    return yamlLoadingPromise;
}

// Dynamic PapaParse CSV loader
async function loadCSVParser() {
    if (papaparse) return papaparse;
    if (csvLoadingPromise) return csvLoadingPromise;

    const manifest = await window.ManifestDataConfig?.ensureManifest?.();
    if (manifest && !manifestDataPathsInclude(manifest, ['.csv'])) {
        csvLoadingPromise = Promise.reject(new Error('[Manifest Data] No CSV paths in manifest - skipping loader'));
        return csvLoadingPromise;
    }

    csvLoadingPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/papaparse@latest/papaparse.min.js';
        script.onload = () => {
            if (typeof window.Papa !== 'undefined') {
                papaparse = window.Papa;
                resolve(papaparse);
            } else {
                console.error('[Manifest Data] PapaParse failed to load - Papa is undefined');
                csvLoadingPromise = null; // Reset so we can try again
                reject(new Error('PapaParse failed to load'));
            }
        };
        script.onerror = (error) => {
            console.error('[Manifest Data] CSV parser script failed to load:', error);
            csvLoadingPromise = null; // Reset so we can try again
            reject(error);
        };
        document.head.appendChild(script);
    });

    return csvLoadingPromise;
}

// Deep merge objects with current locale taking precedence
function deepMergeWithFallback(currentData, fallbackData) {
    if (fallbackData === null || fallbackData === undefined) {
        return currentData;
    }
    if (currentData === null || currentData === undefined) {
        return fallbackData;
    }

    // If both are arrays, merge array items by index
    if (Array.isArray(currentData) && Array.isArray(fallbackData)) {
        const maxLength = Math.max(currentData.length, fallbackData.length);
        const merged = [];
        for (let i = 0; i < maxLength; i++) {
            const currentItem = currentData[i];
            const fallbackItem = fallbackData[i];
            if (currentItem !== undefined && fallbackItem !== undefined) {
                // Both exist - merge recursively
                merged.push(deepMergeWithFallback(currentItem, fallbackItem));
            } else if (currentItem !== undefined) {
                // Only current exists
                merged.push(currentItem);
            } else {
                // Only fallback exists
                merged.push(fallbackItem);
            }
        }
        return merged;
    }

    // If both are objects, merge recursively
    if (typeof currentData === 'object' && typeof fallbackData === 'object' &&
        !Array.isArray(currentData) && !Array.isArray(fallbackData)) {
        const merged = { ...fallbackData };
        for (const key in currentData) {
            if (POLLUTING_KEYS.has(key)) continue;
            if (key.startsWith('_')) {
                // Preserve metadata from current locale
                merged[key] = currentData[key];
            } else {
                const currentValue = currentData[key];
                // Treat empty strings as missing values (fallback to default locale)
                if (currentValue !== undefined && currentValue !== null && currentValue !== '') {
                    // Recursively merge nested objects/arrays
                    merged[key] = deepMergeWithFallback(currentValue, fallbackData[key]);
                }
                // If current value is empty/missing, keep fallback value (already in merged)
            }
        }
        return merged;
    }

    // For primitives or mismatched types, prefer current (but treat empty strings as missing)
    if (currentData !== undefined && currentData !== null && currentData !== '') {
        return currentData;
    }
    return fallbackData;
}

// Set nested value in object using dot notation path.
// Numeric path segments (e.g. cards.0.title) create real arrays so x-for="card in $x....cards" works.
function setNestedValue(obj, path, value) {
    const keys = path.split('.');
    // Drop the whole row if any segment would walk into the prototype chain.
    // `foo.constructor.prototype.polluted` is just as dangerous as `__proto__.polluted`.
    if (keys.some(k => POLLUTING_KEYS.has(k))) return;
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        const nextKey = keys[i + 1];
        const nextIsIndex = /^\d+$/.test(nextKey);

        if (!(key in current)) {
            current[key] = nextIsIndex ? [] : {};
        } else if (nextIsIndex && !Array.isArray(current[key]) && current[key] && typeof current[key] === 'object') {
            // If we later discover this container should be an array, coerce numeric-key objects.
            const existing = current[key];
            const existingKeys = Object.keys(existing);
            const numericOnly = existingKeys.every(k => /^\d+$/.test(k));
            if (numericOnly) {
                const arr = [];
                existingKeys.forEach(k => {
                    arr[parseInt(k, 10)] = existing[k];
                });
                current[key] = arr;
            }
        }

        if (Array.isArray(current) && /^\d+$/.test(key)) {
            const idx = parseInt(key, 10);
            if (current[idx] == null || typeof current[idx] !== 'object') {
                current[idx] = nextIsIndex ? [] : {};
            }
        }

        current = current[key];
    }

    current[keys[keys.length - 1]] = value;
}

// If the key-value result has only numeric top-level keys (e.g. 0.path, 1.path), convert to array
// so $route/$search/$query work and the shape matches YAML/JSON array sources.
function numericKeyObjectToArray(obj) {
    if (obj == null || Array.isArray(obj) || typeof obj !== 'object') {
        return obj;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return obj;
    const numericKeys = keys.filter(k => /^\d+$/.test(k));
    if (numericKeys.length !== keys.length) return obj;
    const sorted = numericKeys.map(k => parseInt(k, 10)).sort((a, b) => a - b);
    return sorted.map(i => obj[String(i)]);
}

// Parse CSV text to nested object structure
function parseCSVToNestedObject(csvText, options = {}) {
    const {
        currentLocale = null,
        delimiter = ','
    } = options;

    // Use PapaParse if available, otherwise fall back to simple parser
    if (papaparse) {
        const parsed = papaparse.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            delimiter: delimiter
        });

        if (parsed.errors && parsed.errors.length > 0) {
            const serious = parsed.errors.filter(e => e.code !== 'TooFewFields');
            if (serious.length > 0) {
                console.warn('[Manifest Data] CSV parsing warnings:', serious);
            }
        }

        if (!parsed.data || parsed.data.length === 0) {
            throw new Error('[Manifest Data] CSV file is empty or has no data rows');
        }

        const result = {};
        const headers = Object.keys(parsed.data[0] || {});

        if (headers.length === 0) {
            throw new Error('[Manifest Data] CSV file has no headers');
        }

        // First column is always the key
        const keyColumn = headers[0];

        // Detect if this is tabular data (array of objects) vs key-value data (nested object)
        // Tabular: first column header is "id" (case-insensitive) AND 3+ columns AND values look like IDs
        // Key-value: everything else (supports both flat keys like "home" and dot notation like "home.title")
        const keyColumnLower = keyColumn.toLowerCase();
        let isTabular = false;

        if (headers.length > 2 && keyColumnLower === 'id') {
            // Check if first column values look like IDs (numeric or short identifiers)
            const sampleRows = parsed.data.slice(0, Math.min(5, parsed.data.length));
            const idLikeRows = sampleRows.filter(row => {
                const val = row[keyColumn];
                return val && (/^\d+$/.test(val) || (val.length < 20 && !val.includes('.')));
            });
            // If most sample rows look like IDs, treat as tabular
            isTabular = idLikeRows.length >= sampleRows.length * 0.6;
        }

        if (isTabular) {
            // Return array of objects (tabular data like product inventory)
            const array = [];
            for (const row of parsed.data) {
                if (!row || Object.keys(row).length === 0) continue;
                // Create object from all columns
                const obj = {};
                for (const header of headers) {
                    obj[header] = row[header];
                }
                array.push(obj);
            }
            return array;
        } else {
            // Key-value mode: convert dot notation to nested object
            // Auto-detect value column:
            // 1. If currentLocale is provided and matches a header, use that
            // 2. Otherwise, use the second column (or first non-key column)
            let valueColumnName = null;
            let fallbackColumnName = null; // First locale column (default fallback)

            if (currentLocale && headers.includes(currentLocale)) {
                valueColumnName = currentLocale;
            } else if (headers.length > 1) {
                // Use second column (first non-key column)
                valueColumnName = headers[1];
            } else {
                throw new Error('[Manifest Data] CSV file must have at least two columns (key and value)');
            }

            // Find first locale column (first column after 'key') as fallback
            if (headers.length > 1) {
                fallbackColumnName = headers[1];
            }

            for (const row of parsed.data) {
                if (!row || Object.keys(row).length === 0) continue;

                const key = row[keyColumn];
                if (!key) continue;

                // Get value from the detected value column
                let value = row[valueColumnName];

                // If value is empty/missing and we have a fallback column, use it
                if ((value === undefined || value === null || value === '') && fallbackColumnName && fallbackColumnName !== valueColumnName) {
                    value = row[fallbackColumnName];
                }

                // Convert dot notation to nested object
                setNestedValue(result, key, value);
            }

            return numericKeyObjectToArray(result);
        }
    } else {
        // Fallback simple parser (if PapaParse not loaded)
        const lines = csvText.split('\n').filter(line => line.trim());
        if (lines.length < 2) {
            throw new Error('[Manifest Data] CSV file must have at least a header row and one data row');
        }

        // Simple CSV line parser (handles quoted values)
        function parseCSVLine(line, delim) {
            const result = [];
            let current = '';
            let inQuotes = false;

            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === delim && !inQuotes) {
                    result.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            result.push(current.trim());
            return result;
        }

        const headers = parseCSVLine(lines[0], delimiter);
        if (headers.length < 2) {
            throw new Error('[Manifest Data] CSV file must have at least two columns');
        }

        // First column is always the key
        const keyColumn = headers[0];

        // Detect if this is tabular data (array of objects) vs key-value data (nested object)
        // Tabular: first column header is "id" (case-insensitive) AND 3+ columns AND values look like IDs
        // Key-value: everything else (supports both flat keys like "home" and dot notation like "home.title")
        const keyColumnLower = keyColumn.toLowerCase();
        let isTabular = false;

        if (headers.length > 2 && keyColumnLower === 'id') {
            // Check if first column values look like IDs (numeric or short identifiers)
            let idLikeCount = 0;
            const sampleSize = Math.min(5, lines.length - 1);
            for (let i = 1; i <= sampleSize; i++) {
                const values = parseCSVLine(lines[i], delimiter);
                const val = values[0];
                if (val && (/^\d+$/.test(val) || (val.length < 20 && !val.includes('.')))) {
                    idLikeCount++;
                }
            }
            // If most sample rows look like IDs, treat as tabular
            isTabular = idLikeCount >= sampleSize * 0.6;
        }

        if (isTabular) {
            // Return array of objects (tabular data like product inventory)
            const array = [];
            for (let i = 1; i < lines.length; i++) {
                const values = parseCSVLine(lines[i], delimiter);
                if (values.length === 0) continue;

                const obj = {};
                for (let j = 0; j < headers.length; j++) {
                    obj[headers[j]] = values[j] !== undefined ? values[j] : null;
                }
                array.push(obj);
            }
            return array;
        } else {
            // Key-value mode: convert dot notation to nested object
            // Auto-detect value column: use current locale if available, otherwise second column
            let valueColumnName = null;
            let fallbackColumnName = null; // First locale column (default fallback)

            if (currentLocale && headers.includes(currentLocale)) {
                valueColumnName = currentLocale;
            } else {
                valueColumnName = headers[1];
            }

            // Find first locale column (first column after 'key') as fallback
            if (headers.length > 1) {
                fallbackColumnName = headers[1];
            }

            const keyIndex = 0;
            const valueIndex = headers.indexOf(valueColumnName);
            const fallbackIndex = fallbackColumnName ? headers.indexOf(fallbackColumnName) : -1;

            const result = {};

            for (let i = 1; i < lines.length; i++) {
                const values = parseCSVLine(lines[i], delimiter);
                const key = values[keyIndex];
                if (!key) continue;

                let value = values[valueIndex] !== undefined ? values[valueIndex] : null;

                // If value is empty/missing and we have a fallback column, use it
                if ((value === undefined || value === null || value === '') && fallbackIndex >= 0 && fallbackIndex !== valueIndex) {
                    value = values[fallbackIndex] !== undefined ? values[fallbackIndex] : null;
                }

                // Convert dot notation to nested object
                setNestedValue(result, key, value);
            }

            return numericKeyObjectToArray(result);
        }
    }
}

// Load a local file (JSON, YAML, CSV). Resolves manifest-relative paths when viewing from dist.
function resolveDataPath(filePath) {
    if (!filePath || typeof filePath !== 'string' || filePath.startsWith('http')) {
        return filePath;
    }
    const base = typeof window.getManifestBase === 'function' ? window.getManifestBase() : '';
    const pathOnly = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    return base ? base + pathOnly : filePath;
}

// Load a local file (JSON, YAML, CSV)
async function loadLocalFile(filePath, options = {}) {
    const resolved = resolveDataPath(filePath);
    const response = await fetch(resolved);

    // Check if file exists
    if (!response.ok) {
        throw new Error(`[Manifest Data] File not found: ${resolved} (${response.status})`);
    }

    const contentType = response.headers.get('content-type');

    // Handle CSV files
    if (resolved.endsWith('.csv') || contentType?.includes('text/csv')) {
        const text = await response.text();
        const csvParser = await loadCSVParser();
        // Pass currentLocale if provided in options
        return parseCSVToNestedObject(text, { currentLocale: options.currentLocale });
    }
    // Handle JSON files
    else if (contentType?.includes('application/json') || resolved.endsWith('.json')) {
        return await response.json();
    }
    // Handle YAML files
    else if (contentType?.includes('text/yaml') || resolved.endsWith('.yaml') || resolved.endsWith('.yml')) {
        const text = await response.text();
        const yamlLib = await loadYamlLibrary();
        return yamlLib.load(text);
    } else {
        // Try JSON first, then YAML, then CSV
        try {
            const text = await response.text();
            return JSON.parse(text);
        } catch (e) {
            try {
                const yamlLib = await loadYamlLibrary();
                return yamlLib.load(text);
            } catch (e2) {
                // Last resort: try CSV
                const csvParser = await loadCSVParser();
                return parseCSVToNestedObject(text, { currentLocale: options.currentLocale });
            }
        }
    }
}

// Export functions to window for use by other subscripts
window.ManifestDataLoaders = {
    loadYamlLibrary,
    loadCSVParser,
    deepMergeWithFallback,
    parseCSVToNestedObject,
    setNestedValue,
    numericKeyObjectToArray,
    resolveDataPath,
    loadLocalFile
};

/* Manifest Data Sources - Cloud API Loader */
// NOTE: This is basic read-only API support included in core for localization compatibility.
// Full CRUD operations will be available via manifest.api.data.js plugin (planned).
// When the API plugin is available, it will extend this functionality.

// Load from API endpoint (read-only)
async function loadFromAPI(dataSource) {
    try {
        const url = new URL(window.ManifestDataConfig.interpolateEnvVars(dataSource.url));

        // Add query parameters
        if (dataSource.params) {
            Object.entries(dataSource.params).forEach(([key, value]) => {
                url.searchParams.set(key, window.ManifestDataConfig.interpolateEnvVars(value));
            });
        }

        // Prepare headers
        const headers = {};
        if (dataSource.headers) {
            Object.entries(dataSource.headers).forEach(([key, value]) => {
                headers[key] = window.ManifestDataConfig.interpolateEnvVars(value);
            });
        }

        const response = await fetch(url, {
            method: dataSource.method || 'GET',
            headers: headers
        });

        if (!response.ok) {
            throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        }

        let data = await response.json();

        // Transform data if needed
        if (dataSource.transform) {
            data = window.ManifestDataConfig.getNestedValue(data, dataSource.transform);
        }

        return data;
    } catch (error) {
        console.error(`[Manifest Data] Failed to load API dataSource:`, error);
        // Return empty array/object to prevent breaking the UI
        return Array.isArray(dataSource.defaultValue) ? dataSource.defaultValue : (dataSource.defaultValue || []);
    }
}

// Export functions to window for use by other subscripts
window.ManifestDataAPI = {
    loadFromAPI
};



/* Manifest Data Sources - Error Handling & Loading States */

// Placeholder for Phase 4: Error handling and loading states
// This will be implemented in Phase 4

// Export empty object for now
window.ManifestDataErrors = {
    // Phase 4: Error handling will be added here
};



/* Manifest Data Sources - Unified Mutation System */
// Handles optimistic updates, scoped updates, rollback, and background sync

// Track pending mutations for rollback
const pendingMutations = new Map(); // Map<mutationId, { type, dataSourceName, optimisticData, originalData, rollback }>

let mutationIdCounter = 0;

// Generate unique mutation ID
function generateMutationId() {
    return `mutation_${Date.now()}_${++mutationIdCounter}`;
}

// Update a single entry in the store (scoped update)
function updateEntryInStore(dataSourceName, entryId, updates, options = {}) {
    if (typeof Alpine === 'undefined' || !Alpine.store) {
        return false;
    }

    const store = Alpine.store('data');
    if (!store || !store[dataSourceName] || !Array.isArray(store[dataSourceName])) {
        return false;
    }

    const currentArray = store[dataSourceName];
    const index = currentArray.findIndex(entry => entry.$id === entryId);

    if (index === -1) {
        return false;
    }

    // CRITICAL DEBUG: Log all updates to projects, especially fileIds changes
    if (dataSourceName === 'projects') {
        const existingEntry = currentArray[index];
        const existingFileIds = existingEntry?.fileIds || [];
        const newFileIds = updates?.fileIds || (updates === existingEntry ? existingFileIds : undefined);

        // Get stack trace to see who's calling this
        const stack = new Error().stack;
        const caller = stack?.split('\n')[2]?.trim() || 'unknown';

    }

    // Create new array with updated entry
    const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
    const newArray = currentArray.map((entry, i) => {
        if (i === index) {
            // Merge updates into entry, creating new object reference
            const updatedEntry = createReactiveReferences
                ? createReactiveReferences({ ...entry, ...updates }, dataSourceName)
                : { ...entry, ...updates };
            return updatedEntry;
        }
        return entry;
    });

    // Create reactive references for entire array
    const reactiveArray = createReactiveReferences
        ? createReactiveReferences(newArray, dataSourceName)
        : newArray;

    // Update store
    Alpine.store('data', {
        ...store,
        [dataSourceName]: reactiveArray
    });

    // Attach methods to new array reference
    if (window.ManifestDataProxies?.attachArrayMethods) {
        const loadDataSource = window.ManifestDataMain?.loadDataSource;
        if (loadDataSource) {
            window.ManifestDataProxies.attachArrayMethods(reactiveArray, dataSourceName, loadDataSource);
        }
    }

    // Clear caches
    if (window.ManifestDataProxies?.clearAccessCache) {
        window.ManifestDataProxies.clearAccessCache(dataSourceName);
    }
    if (window.ManifestDataProxies?.clearArrayProxyCacheForDataSource) {
        window.ManifestDataProxies.clearArrayProxyCacheForDataSource(dataSourceName);
    }
    if (window.ManifestDataProxies?.clearRouteProxyCacheForDataSource) {
        window.ManifestDataProxies.clearRouteProxyCacheForDataSource(dataSourceName);
    }

    // Dispatch mutation event
    window.dispatchEvent(new CustomEvent('manifest:data-mutated', {
        detail: {
            dataSourceName,
            mutationType: 'update',
            entryId,
            updates
        }
    }));

    return true;
}

// Add entry to store (optimistic)
function addEntryToStore(dataSourceName, entry, options = {}) {
    if (typeof Alpine === 'undefined' || !Alpine.store) {
        return false;
    }

    const store = Alpine.store('data');
    if (!store) {
        return false;
    }

    // Get current array or initialize
    const currentArray = store[dataSourceName] || [];
    if (!Array.isArray(currentArray)) {
        return false;
    }

    // Create reactive references for new entry
    const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
    const newEntry = createReactiveReferences
        ? createReactiveReferences(entry, dataSourceName)
        : entry;

    // Create new array with new entry
    const newArray = [...currentArray, newEntry];
    const reactiveArray = createReactiveReferences
        ? createReactiveReferences(newArray, dataSourceName)
        : newArray;

    // Update store
    Alpine.store('data', {
        ...store,
        [dataSourceName]: reactiveArray
    });

    // Attach methods to new array reference
    if (window.ManifestDataProxies?.attachArrayMethods) {
        const loadDataSource = window.ManifestDataMain?.loadDataSource;
        if (loadDataSource) {
            window.ManifestDataProxies.attachArrayMethods(reactiveArray, dataSourceName, loadDataSource);
        }
    }

    // Clear caches
    if (window.ManifestDataProxies?.clearAccessCache) {
        window.ManifestDataProxies.clearAccessCache(dataSourceName);
    }
    if (window.ManifestDataProxies?.clearArrayProxyCacheForDataSource) {
        window.ManifestDataProxies.clearArrayProxyCacheForDataSource(dataSourceName);
    }
    if (window.ManifestDataProxies?.clearRouteProxyCacheForDataSource) {
        window.ManifestDataProxies.clearRouteProxyCacheForDataSource(dataSourceName);
    }

    // Dispatch mutation event
    window.dispatchEvent(new CustomEvent('manifest:data-mutated', {
        detail: {
            dataSourceName,
            mutationType: 'create',
            entryId: entry.$id,
            entry
        }
    }));

    return true;
}

// Remove entry from store (optimistic)
function removeEntryFromStore(dataSourceName, entryId, options = {}) {
    if (typeof Alpine === 'undefined' || !Alpine.store) {
        return false;
    }

    const store = Alpine.store('data');
    if (!store || !store[dataSourceName] || !Array.isArray(store[dataSourceName])) {
        return false;
    }

    const currentArray = store[dataSourceName];
    const index = currentArray.findIndex(entry => entry.$id === entryId);

    if (index === -1) {
        return false;
    }

    // Store original entry for rollback
    const originalEntry = currentArray[index];

    // Create new array without entry
    const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
    const newArray = currentArray.filter((entry, i) => i !== index);
    const reactiveArray = createReactiveReferences
        ? createReactiveReferences(newArray, dataSourceName)
        : newArray;

    // Update store
    Alpine.store('data', {
        ...store,
        [dataSourceName]: reactiveArray
    });

    // Attach methods to new array reference
    if (window.ManifestDataProxies?.attachArrayMethods) {
        const loadDataSource = window.ManifestDataMain?.loadDataSource;
        if (loadDataSource) {
            window.ManifestDataProxies.attachArrayMethods(reactiveArray, dataSourceName, loadDataSource);
        }
    }

    // Clear caches
    if (window.ManifestDataProxies?.clearAccessCache) {
        window.ManifestDataProxies.clearAccessCache(dataSourceName);
    }
    if (window.ManifestDataProxies?.clearArrayProxyCacheForDataSource) {
        window.ManifestDataProxies.clearArrayProxyCacheForDataSource(dataSourceName);
    }

    // Dispatch mutation event
    window.dispatchEvent(new CustomEvent('manifest:data-mutated', {
        detail: {
            dataSourceName,
            mutationType: 'delete',
            entryId,
            originalEntry
        }
    }));

    return { originalEntry };
}

// Rollback a mutation
function rollbackMutation(mutationId) {
    const mutation = pendingMutations.get(mutationId);
    if (!mutation) {
        return false;
    }

    const { type, dataSourceName, originalData, rollback } = mutation;

    try {
        if (rollback && typeof rollback === 'function') {
            // Use custom rollback function
            rollback();
        } else {
            // Default rollback based on type
            if (type === 'create') {
                // Remove the entry we added
                removeEntryFromStore(dataSourceName, originalData.$id);
            } else if (type === 'update') {
                // Restore original entry
                updateEntryInStore(dataSourceName, originalData.$id, originalData);
            } else if (type === 'delete') {
                // Restore deleted entry
                addEntryToStore(dataSourceName, originalData);
            }
        }

        pendingMutations.delete(mutationId);
        return true;
    } catch (error) {
        console.error(`[Manifest Data] Failed to rollback mutation ${mutationId}:`, error);
        return false;
    }
}

// Execute mutation with optimistic update
async function executeMutation(mutationConfig) {
    const {
        type, // 'create', 'update', 'delete'
        dataSourceName,
        entryId, // For update/delete
        data, // Entry data for create/update
        apiCall, // Function that performs the API call
        options = {}
    } = mutationConfig;

    const mutationId = generateMutationId();
    let originalData = null;
    let optimisticData = null;
    let resolvedEntryId = entryId;

    // Get helper functions from store
    const {
        setCreatingEntry,
        clearCreatingEntry,
        setUpdatingEntry,
        clearUpdatingEntry,
        setDeletingEntry,
        clearDeletingEntry
    } = window.ManifestDataStore || {};

    try {
        // Step 1: Set operation-specific loading state and perform optimistic update
        if (type === 'create') {
            // Generate temporary ID if not provided
            const tempId = data.$id || `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            optimisticData = { ...data, $id: tempId };
            resolvedEntryId = tempId;

            // Set creating state
            if (setCreatingEntry) {
                setCreatingEntry(dataSourceName, resolvedEntryId);
            }

            addEntryToStore(dataSourceName, optimisticData, options);
            originalData = null; // Nothing to rollback for create
        } else if (type === 'update') {
            // Store original entry for rollback
            const store = Alpine.store('data');
            if (store && store[dataSourceName] && Array.isArray(store[dataSourceName])) {
                originalData = store[dataSourceName].find(e => e.$id === entryId);
            }

            // Set updating state
            if (setUpdatingEntry && entryId) {
                setUpdatingEntry(dataSourceName, entryId);
            }

            // Perform optimistic update if originalData found
            // If not found, still proceed with API call (entry might have been just created)
            if (originalData) {
                updateEntryInStore(dataSourceName, entryId, data, options);
            }
        } else if (type === 'delete') {
            // Store original entry for rollback
            const store = Alpine.store('data');
            if (store && store[dataSourceName] && Array.isArray(store[dataSourceName])) {
                originalData = store[dataSourceName].find(e => e.$id === entryId);
            }

            // Set deleting state
            if (setDeletingEntry && entryId) {
                setDeletingEntry(dataSourceName, entryId);
            }

            // Perform optimistic delete if originalData found
            // If not found, still proceed with API call (entry might have been just deleted)
            if (originalData) {
                removeEntryFromStore(dataSourceName, entryId, options);
            }
        }

        // Step 2: Perform API call
        const result = await apiCall();

        // Step 3: Clear loading states after successful API call (regardless of result format)
        if (type === 'create' && clearCreatingEntry && resolvedEntryId) {
            clearCreatingEntry(dataSourceName, resolvedEntryId);
        } else if (type === 'update' && clearUpdatingEntry && entryId) {
            clearUpdatingEntry(dataSourceName, entryId);
        } else if (type === 'delete' && clearDeletingEntry && entryId) {
            clearDeletingEntry(dataSourceName, entryId);
        }

        // Step 4: Background sync - update with server response
        if (result && result.$id) {
            if (type === 'create') {
                // Replace temporary entry with real one from server
                const store = Alpine.store('data');
                if (store && store[dataSourceName] && Array.isArray(store[dataSourceName])) {
                    const index = store[dataSourceName].findIndex(e => e.$id === optimisticData.$id);
                    if (index !== -1) {
                        // Remove temporary entry and add real one
                        const currentArray = store[dataSourceName];
                        const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                        const newArray = currentArray.map((entry, i) => {
                            if (i === index) {
                                // Replace with server response
                                return createReactiveReferences
                                    ? createReactiveReferences(result, dataSourceName)
                                    : result;
                            }
                            return entry;
                        });
                        const reactiveArray = createReactiveReferences
                            ? createReactiveReferences(newArray, dataSourceName)
                            : newArray;
                        Alpine.store('data', {
                            ...store,
                            [dataSourceName]: reactiveArray
                        });
                        // Attach methods
                        if (window.ManifestDataProxies?.attachArrayMethods) {
                            const loadDataSource = window.ManifestDataMain?.loadDataSource;
                            if (loadDataSource) {
                                window.ManifestDataProxies.attachArrayMethods(reactiveArray, dataSourceName, loadDataSource);
                            }
                        }
                        // Clear caches
                        if (window.ManifestDataProxies?.clearAccessCache) {
                            window.ManifestDataProxies.clearAccessCache(dataSourceName);
                        }
                        if (window.ManifestDataProxies?.clearArrayProxyCacheForDataSource) {
                            window.ManifestDataProxies.clearArrayProxyCacheForDataSource(dataSourceName);
                        }
                        if (window.ManifestDataProxies?.clearRouteProxyCacheForDataSource) {
                            window.ManifestDataProxies.clearRouteProxyCacheForDataSource(dataSourceName);
                        }
                    } else {
                        // Temporary entry not found, just add the real one
                        addEntryToStore(dataSourceName, result, options);
                    }
                }
            } else if (type === 'update') {
                // Update with server response (may have additional fields)
                updateEntryInStore(dataSourceName, entryId, result, options);
            }
            // For delete, entry is already removed optimistically, nothing to sync
        }

        // Step 4: Clean up pending mutation
        pendingMutations.delete(mutationId);

        // Dispatch success event
        window.dispatchEvent(new CustomEvent('manifest:data-mutation-success', {
            detail: {
                mutationId,
                type,
                dataSourceName,
                entryId: result?.$id || entryId,
                result
            }
        }));

        return result;
    } catch (error) {
        // Clear operation-specific loading state on error
        if (type === 'create' && clearCreatingEntry && resolvedEntryId) {
            clearCreatingEntry(dataSourceName, resolvedEntryId);
        } else if (type === 'update' && clearUpdatingEntry && entryId) {
            clearUpdatingEntry(dataSourceName, entryId);
        } else if (type === 'delete' && clearDeletingEntry && entryId) {
            clearDeletingEntry(dataSourceName, entryId);
        }

        // Rollback on error
        console.error(`[Manifest Data] Mutation failed, rolling back:`, error);

        const rollbackFn = () => {
            if (type === 'create' && optimisticData) {
                removeEntryFromStore(dataSourceName, optimisticData.$id);
            } else if (type === 'update' && originalData) {
                updateEntryInStore(dataSourceName, entryId, originalData);
            } else if (type === 'delete' && originalData) {
                addEntryToStore(dataSourceName, originalData);
            }
        };

        rollbackFn();
        pendingMutations.delete(mutationId);

        // Dispatch error event
        window.dispatchEvent(new CustomEvent('manifest:data-mutation-error', {
            detail: {
                mutationId,
                type,
                dataSourceName,
                entryId,
                error
            }
        }));

        throw error;
    }
}

// Sync entry from server (background reconciliation)
async function syncEntryFromServer(dataSourceName, entryId, syncFunction) {
    try {
        const serverData = await syncFunction();
        if (serverData && serverData.$id) {
            updateEntryInStore(dataSourceName, entryId, serverData);
            return serverData;
        }
    } catch (error) {
        console.warn(`[Manifest Data] Failed to sync entry ${entryId} from server:`, error);
    }
    return null;
}

// Event-driven reactivity helper
// Automatically updates components when data mutations occur
function setupEventDrivenReactivity(componentScope, dataSourceName, entryId = null) {
    if (typeof Alpine === 'undefined' || !componentScope) {
        return () => { }; // Return no-op cleanup function
    }

    const cleanupCallbacks = [];

    // Listen for mutations on this data source
    const handleMutation = (event) => {
        const { detail } = event;
        if (detail.dataSourceName !== dataSourceName) return;

        // If entryId specified, only react to mutations for that specific entry
        if (entryId && detail.entryId !== entryId) return;

        // Trigger Alpine reactivity by accessing the store
        // This ensures components re-evaluate their expressions
        const store = Alpine.store('data');
        if (store && store[dataSourceName]) {
            // Force Alpine to detect the change by accessing the array
            const _ = store[dataSourceName].length;
        }
    };

    // Listen for mutation success
    const handleMutationSuccess = (event) => {
        const { detail } = event;
        if (detail.dataSourceName !== dataSourceName) return;
        if (entryId && detail.entryId !== entryId) return;

        // Trigger reactivity
        const store = Alpine.store('data');
        if (store && store[dataSourceName]) {
            const _ = store[dataSourceName].length;
        }
    };

    // Listen for mutation errors (for potential rollback notifications)
    const handleMutationError = (event) => {
        const { detail } = event;
        if (detail.dataSourceName !== dataSourceName) return;
        if (entryId && detail.entryId !== entryId) return;

        // Component can handle error if needed
        // For now, just trigger reactivity check
        const store = Alpine.store('data');
        if (store && store[dataSourceName]) {
            const _ = store[dataSourceName].length;
        }
    };

    // Register event listeners
    window.addEventListener('manifest:data-mutated', handleMutation);
    window.addEventListener('manifest:data-mutation-success', handleMutationSuccess);
    window.addEventListener('manifest:data-mutation-error', handleMutationError);

    cleanupCallbacks.push(() => {
        window.removeEventListener('manifest:data-mutated', handleMutation);
        window.removeEventListener('manifest:data-mutation-success', handleMutationSuccess);
        window.removeEventListener('manifest:data-mutation-error', handleMutationError);
    });

    // Return cleanup function
    return () => {
        cleanupCallbacks.forEach(cb => cb());
    };
}

// Export for use in other modules
if (typeof window !== 'undefined') {
    if (!window.ManifestDataMutations) window.ManifestDataMutations = {};
    window.ManifestDataMutations = {
        executeMutation,
        updateEntryInStore,
        addEntryToStore,
        removeEntryFromStore,
        rollbackMutation,
        syncEntryFromServer,
        generateMutationId,
        setupEventDrivenReactivity
    };
}




/* Manifest Data Sources - Core Proxy Utilities */

// Track if we're in Alpine's initial evaluation phase
// During this phase, we return safe values to prevent recursion
let isInitialEvaluation = true;
setTimeout(() => {
    isInitialEvaluation = false;
}, 100); // Give Alpine time to finish initial evaluation

// Fallback for nested property access: chainable (return self for string keys so
// .another.deep.level never throws) and string-like (toString/valueOf → '', common string methods).
// Used by loading proxy and nested object proxy when a key is missing.
let cachedChainingFallback = null;
function getChainingFallback() {
    if (cachedChainingFallback) return cachedChainingFallback;
    const empty = [];
    const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
    const arrayWithMethods = attachArrayMethods ? attachArrayMethods(empty, '', null) : empty;
    const routeFn = (typeof arrayWithMethods?.$route === 'function')
        ? arrayWithMethods.$route.bind(arrayWithMethods)
        : function () { return cachedChainingFallback; };
    const searchFn = (typeof arrayWithMethods?.$search === 'function')
        ? arrayWithMethods.$search.bind(arrayWithMethods)
        : function () { return []; };
    const queryFn = (typeof arrayWithMethods?.$query === 'function')
        ? arrayWithMethods.$query.bind(arrayWithMethods)
        : function () { return []; };
    const emptyStr = function () { return ''; };
    const emptyArr = function () { return []; };
    const stringMethodStubs = {
        trim: emptyStr, toLowerCase: emptyStr, toUpperCase: emptyStr, repeat: emptyStr,
        padStart: emptyStr, padEnd: emptyStr, trimStart: emptyStr, trimEnd: emptyStr,
        replace: emptyStr, replaceAll: emptyStr, slice: emptyStr, substring: emptyStr, substr: emptyStr,
        split: emptyArr, concat: emptyStr, valueOf: emptyStr, toString: emptyStr,
        charAt: emptyStr, charCodeAt: function () { return NaN; }, codePointAt: function () { return undefined; },
        startsWith: function () { return false; }, endsWith: function () { return false; },
        includes: function () { return false; }, indexOf: function () { return -1; }, lastIndexOf: function () { return -1; },
        match: function () { return null; }, matchAll: function () { return []; }, search: function () { return -1; },
        normalize: emptyStr, toLocaleLowerCase: emptyStr, toLocaleUpperCase: emptyStr
    };
    cachedChainingFallback = new Proxy(Object.create(null), {
        get(_, key) {
            if (key === '$route') return routeFn;
            if (key === '$search') return searchFn;
            if (key === '$query') return queryFn;
            if (key === 'length') return 0;
            if (key === Symbol.toPrimitive || key === 'valueOf' || key === 'toString') {
                return emptyStr;
            }
            if (key === Symbol.iterator) {
                return function* () { };
            }
            if (typeof key === 'string' && key in stringMethodStubs) {
                return stringMethodStubs[key];
            }
            // Return self for any other string key so chaining never throws (e.g. .another.deep.level).
            // Display still works via toString/valueOf → ''.
            if (typeof key === 'string') return cachedChainingFallback;
            return undefined;
        },
        has() { return true; }
    });
    return cachedChainingFallback;
}

// Safe loading branch: returns '' for every key. Used only for prop === 'content' so
// $x.content.theme.light never returns a proxy Alpine can re-enter (avoids stack overflow).
let cachedLoadingBranchSafe = null;
function getLoadingBranchSafe() {
    if (cachedLoadingBranchSafe) return cachedLoadingBranchSafe;
    const emptyStr = function () { return ''; };
    cachedLoadingBranchSafe = new Proxy(Object.create(null), {
        get(_, key) {
            if (key === Symbol.toPrimitive || key === 'valueOf' || key === 'toString') return emptyStr;
            if (key === 'then' || key === 'catch' || key === 'finally') return undefined;
            return '';
        },
        has() { return true; }
    });
    return cachedLoadingBranchSafe;
}

// Max depth for loading placeholder chain; beyond this, string keys return '' to avoid stack overflow.
const MAX_LOADING_BRANCH_DEPTH = 10;

const loadingBranchByDepth = Object.create(null);
function getLoadingBranch(depth) {
    const d = depth == null ? 0 : Math.min(Math.max(0, depth), MAX_LOADING_BRANCH_DEPTH);
    if (loadingBranchByDepth[d]) return loadingBranchByDepth[d];
    const emptyStr = function () { return ''; };
  const emptyArray = [];
  const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
  const arrayWithMethods = attachArrayMethods ? attachArrayMethods(emptyArray, '', null) : emptyArray;
    const nextDepth = d + 1;
    const getReturnForStringKey = () =>
        nextDepth <= MAX_LOADING_BRANCH_DEPTH ? getLoadingBranch(nextDepth) : '';
    loadingBranchByDepth[d] = new Proxy(Object.create(null), {
        get(_, key) {
            if (key === Symbol.toPrimitive || key === 'valueOf' || key === 'toString') return emptyStr;
            if (key === 'then' || key === 'catch' || key === 'finally') return undefined;
            if (key === Symbol.iterator) return function* () { };
            if (key === '$route' || key === '$search' || key === '$query') {
                return function () { return getLoadingBranch(nextDepth <= MAX_LOADING_BRANCH_DEPTH ? nextDepth : MAX_LOADING_BRANCH_DEPTH); };
            }
            if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                if (key in arrayWithMethods && typeof arrayWithMethods[key] === 'function') {
                    return arrayWithMethods[key].bind(arrayWithMethods);
                }
                return Array.prototype[key].bind(arrayWithMethods);
            }
            if (key === 'length') return 0;
            if (typeof key === 'string') return getReturnForStringKey();
            if (typeof key === 'symbol') return undefined;
            return getLoadingBranch(MAX_LOADING_BRANCH_DEPTH);
        },
        has() { return true; }
    });
    return loadingBranchByDepth[d];
}

// Create a simple fallback object that returns empty strings for all properties.
// Nested data keys use getLoadingBranch() (chainable) so $route, $search, $query and deep paths
// don't throw while loading (e.g. $x.content.legal.$route('path')).
function createSimpleFallback(propForPlaceholder) {
    const fallback = Object.create(null);

    // Add primitive conversion methods directly to the object
    fallback[Symbol.toPrimitive] = function (hint) {
        return hint === 'number' ? 0 : '';
    };
    fallback.valueOf = function () { return ''; };
    fallback.toString = function () { return ''; };

    // Add $route function that returns the fallback for chaining
    fallback.$route = function (pathKey) {
        return fallback;
    };

    // For array-like properties, add length
    Object.defineProperty(fallback, 'length', {
        value: 0,
        writable: false,
        enumerable: false,
        configurable: false
    });

    // Add array methods to the fallback so expressions like ($x.example.products || []).filter() work
    // even when the data hasn't loaded yet. The loading proxy is truthy, so || [] doesn't trigger,
    // but we need array methods to be available.
    const arrayMethods = [
        'filter', 'map', 'forEach', 'find', 'findIndex', 'some', 'every', 'reduce', 'reduceRight',
        'slice', 'concat', 'includes', 'indexOf', 'lastIndexOf', 'join', 'toString', 'toLocaleString',
        'keys', 'values', 'entries', 'flat', 'flatMap', 'sort', 'reverse'
    ];

    arrayMethods.forEach(methodName => {
        if (typeof Array.prototype[methodName] === 'function') {
            Object.defineProperty(fallback, methodName, {
                value: function () {
                    // For methods that return arrays, return empty array
                    if (['filter', 'map', 'slice', 'concat', 'flat', 'flatMap', 'sort', 'reverse'].includes(methodName)) {
                        return [];
                    }
                    // For methods that return booleans, return false
                    if (['some', 'every', 'includes'].includes(methodName)) {
                        return false;
                    }
                    // For find methods, return undefined
                    if (['find', 'findIndex'].includes(methodName)) {
                        return methodName === 'find' ? undefined : -1;
                    }
                    // For reduce methods, return initial value or undefined
                    if (['reduce', 'reduceRight'].includes(methodName)) {
                        return arguments.length > 1 ? arguments[1] : undefined;
                    }
                    // For indexOf methods, return -1
                    if (['indexOf', 'lastIndexOf'].includes(methodName)) {
                        return -1;
                    }
                    // For join/toString methods, return empty string
                    if (['join', 'toString', 'toLocaleString'].includes(methodName)) {
                        return '';
                    }
                    // For forEach, return undefined (no-op)
                    if (methodName === 'forEach') {
                        return undefined;
                    }
                    // For iterator methods, return empty iterator
                    if (['keys', 'values', 'entries'].includes(methodName)) {
                        return function* () { };
                    }
                    // Default: return empty array for safety
                    return [];
                },
                writable: false,
                enumerable: false,
                configurable: true
            });
        }
    });

    // Make Symbol.toPrimitive non-enumerable and directly on the object
    Object.defineProperty(fallback, Symbol.toPrimitive, {
        value: function (hint) {
            return hint === 'number' ? 0 : '';
        },
        writable: false,
        enumerable: false,
        configurable: false
    });

    // Create an empty array with methods attached for array-like access
    // This is used when array methods are accessed on the loading proxy
    let cachedArrayWithMethods = null;
    const getArrayWithMethods = () => {
        if (!cachedArrayWithMethods) {
            const emptyArray = [];
            const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
            if (attachArrayMethods) {
                // Use a generic data source name - methods will still work
                cachedArrayWithMethods = attachArrayMethods(emptyArray, '', null);
            } else {
                cachedArrayWithMethods = emptyArray;
            }
        }
        return cachedArrayWithMethods;
    };

    // Create the proxy and store a reference to itself for recursive access
    const proxy = new Proxy(fallback, {
        get(target, key) {
            // Handle Symbol.iterator to make it iterable (for Alpine's x-for)
            if (key === Symbol.iterator) {
                return function* () {
                    // Return empty iterator - Alpine can iterate over it safely
                };
            }

            // Handle other special keys
            if (key === 'then' || key === 'catch' || key === 'finally' ||
                key === Symbol.toStringTag || key === Symbol.hasInstance) {
                return undefined;
            }

            // Handle constructor and prototype
            if (key === 'constructor' || key === '__proto__' || key === 'prototype') {
                return undefined;
            }

            // CRITICAL: If array methods ($search, $query) or common array methods are accessed,
            // return the array with methods attached (not just the method)
            // This ensures ($x.example.products || []).$search() works correctly
            // When $search/$query are called, they filter the array and return a new array with methods
            if (key === '$search' || key === '$query' || key === '$route') {
                const arrayWithMethods = getArrayWithMethods();
                // Return the method bound to the array
                if (key in arrayWithMethods && typeof arrayWithMethods[key] === 'function') {
                    return arrayWithMethods[key].bind(arrayWithMethods);
                }
            }
            // For other array methods, return them from the array with methods
            if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
                const arrayWithMethods = getArrayWithMethods();
                if (key in arrayWithMethods && typeof arrayWithMethods[key] === 'function') {
                    return arrayWithMethods[key].bind(arrayWithMethods);
                }
                // Fallback to Array.prototype method
                return Array.prototype[key].bind(arrayWithMethods);
            }

            // If the key exists on the target (like route, toString, valueOf, length, Symbol.toPrimitive), return it
            if (key in target || key === Symbol.toPrimitive) {
                const value = target[key];
                if (value !== undefined) {
                    return value;
                }
            }

            // For string keys that look like data: use chainable placeholder so nested arrays (e.g. content.legal)
            // have $route/$search/$query and expressions like $x.content.legal.$route('path') don't throw while loading.
            if (typeof key === 'string' && key.length > 0 && key.length < 64 &&
                !key.startsWith('$') && key !== 'length') {
                return getLoadingBranch();
            }

            // For any other key, return chaining fallback — never return the loading proxy itself.
            return getChainingFallback();
        },
        has(target, key) {
            // Make all string keys appear to exist to prevent Alpine from trying to access them
            if (typeof key === 'string') {
                // Also check if it's an array method - these should definitely exist
                if (typeof Array.prototype[key] === 'function') {
                    return true;
                }
                return true;
            }
            return key in target || key === Symbol.toPrimitive;
        }
    });

    return proxy;
}

// Cache loading proxy per prop so content gets safe placeholder, json/yaml get chainable.
const cachedLoadingProxyByProp = Object.create(null);

// Create a safe proxy for loading state. prop is the top-level key (e.g. 'content', 'json').
// When prop === 'content', nested placeholders are primitives-only (no stack overflow).
function createLoadingProxy(prop) {
    const key = prop == null ? '' : String(prop);
    if (!cachedLoadingProxyByProp[key]) {
        cachedLoadingProxyByProp[key] = createSimpleFallback(key || undefined);
    }
    return cachedLoadingProxyByProp[key];
}

// WeakMap cache only for arrays (to prevent recursion in $route() lookups)
const arrayProxyCache = new WeakMap();

// WeakMap cache for nested object proxies (to prevent infinite recursion)
const nestedObjectProxyCache = new WeakMap();

// WeakMap cache for main data source proxies (to prevent creating new proxies on each access)
const dataSourceProxyCache = new WeakMap();

// Create a proxy for array items
// Simplified: Just return target[key] directly (like backup) - no recursive proxying
function createArrayItemProxy(item) {
    return new Proxy(item, {
        get(target, key) {
            // Handle special keys
            if (key === Symbol.iterator || key === 'then' || key === 'catch' || key === 'finally') {
                return undefined;
            }

            // Handle toPrimitive for text content
            if (key === Symbol.toPrimitive) {
                return function () {
                    return target[key] || '';
                };
            }

            // Just return the value directly - let Alpine's store handle reactivity
            // This prevents recursion by not creating nested proxies
            return target[key];
        }
    });
}

// Export functions to window for use by other subscripts
window.ManifestDataProxiesCore = {
    isInitialEvaluation: () => isInitialEvaluation,
    getChainingFallback,
    createLoadingProxy,
    createArrayItemProxy,
    arrayProxyCache,
    nestedObjectProxyCache,
    dataSourceProxyCache
};


/* Manifest Data Sources - Access Cache Management */

// Global access cache map (dataSourceName -> cache Map)
const globalAccessCache = new Map();

// Clear access cache for a specific data source
function clearAccessCache(dataSourceName) {
    if (dataSourceName) {
        globalAccessCache.delete(dataSourceName);
    } else {
        globalAccessCache.clear();
    }
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxies) {
    window.ManifestDataProxies = {};
}
window.ManifestDataProxies.clearAccessCache = clearAccessCache;
window.ManifestDataProxies.globalAccessCache = globalAccessCache;


/* Manifest Data Sources - Circular Reference Handler */
// Handles detection and resolution of circular references in proxy property access
// This is critical for preventing infinite recursion when Alpine re-evaluates expressions

/**
 * Handles circular reference detection and resolution
 * @param {Object} params - Handler parameters
 * @param {Set} params.activeProps - Set of currently active property accesses
 * @param {string} params.propKey - The property key being accessed
 * @param {Object} params.rawTarget - Raw target object (not Alpine-wrapped)
 * @param {Array} params.path - Path array to the current object
 * @param {string} params.key - The key being accessed
 * @param {string} params.fullPath - Full path string for logging
 * @param {number} params.currentDepth - Current call depth
 * @param {string} params.triggeredBy - What triggered this access ('Alpine', 'Proxy', etc.)
 * @param {boolean} params.shouldLog - Whether to log debug information
 * @returns {*} The resolved value or undefined to break the cycle
 */
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
        return null; // Not a circular reference, continue normal flow
    }

    if (shouldLog) {
        console.warn(`[Proxy] ⚠️ CIRCULAR ${fullPath} | depth:${currentDepth} | triggered by:${triggeredBy} | This is likely Alpine re-evaluation`);
    }

    // Property is already being accessed - this is likely Alpine re-evaluating the expression
    // CRITICAL: For simple objects that are already being accessed, return the cached plain copy
    // if it exists. This prevents infinite recursion by ensuring Alpine gets the same object instance.
    try {
        // First, try to get the value from rawTarget
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

            // If it's a simple object, check if we have a cached plain copy
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
                    // Check for cached plain copy first - this is critical to prevent recursion
                    if (!window.ManifestDataProxiesCore.frozenPlainCopyCache) {
                        window.ManifestDataProxiesCore.frozenPlainCopyCache = new WeakMap();
                    }
                    const plainCopyCache = window.ManifestDataProxiesCore.frozenPlainCopyCache;
                    const cachedCopy = plainCopyCache.get(current);

                    if (cachedCopy) {
                        // Return cached copy immediately - don't create a new one
                        // DON'T remove from activeProps here - let the normal flow handle it
                        return cachedCopy;
                    }
                }
            }
        }
    } catch (e) {
        if (shouldLog) {
            console.error(`[Proxy] ${fullPath} | Error in circular check:`, e);
        }
    }

    // If we can't return a cached copy, return undefined to break the cycle
    if (shouldLog) {
        console.warn(`[Proxy] ${fullPath} | ⚠️ CIRCULAR - returning undefined to break cycle`);
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


/* Manifest Data Sources - Simple Object Handler */
// Handles detection and creation of plain copies for simple objects
// This prevents infinite recursion when Alpine wraps proxies and accesses nested properties

/**
 * Checks if an object is a "simple object" (contains only primitives, no nested objects/arrays)
 * @param {*} value - The value to check
 * @returns {boolean} True if the object is simple (only primitives)
 */
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

/**
 * Creates or retrieves a cached plain copy of a simple object
 * Plain copies are NOT frozen - Alpine needs to access properties on them
 * @param {Object} value - The simple object to copy
 * @param {Object} params - Handler parameters
 * @param {Set} params.activeProps - Set of currently active property accesses
 * @param {string} params.propKey - The property key being accessed
 * @param {Object} params.rawTarget - Raw target object
 * @param {string} params.fullPath - Full path string for logging
 * @param {Map} params.callDepthMap - Map tracking call depth
 * @param {boolean} params.shouldLog - Whether to log debug information
 * @returns {Object|null} The plain copy, or null if not a simple object or copy failed
 */
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

    // Check for cached copy first - this is critical to prevent recursion
    let cachedCopy = plainCopyCache.get(value);
    if (cachedCopy) {
        // Return cached plain copy - Alpine won't see it as "new"
        // CRITICAL: Remove from activeProps since plain copy is plain object (won't trigger proxy getters)
        if (activeProps) {
            activeProps.delete(propKey);
        }
        // Reset depth after returning plain copy
        if (callDepthMap && rawTarget) {
            callDepthMap.delete(rawTarget);
        }
        return cachedCopy;
    }

    // Create new plain copy

    const plainCopy = {};
    try {
        // CRITICAL: Copy property values directly (they're already primitives for simple objects)
        // Don't freeze nested values - just copy them as-is
        for (const prop in value) {
            plainCopy[prop] = value[prop];
        }

        // Don't freeze the object - Alpine needs to access properties on it
        // Instead, return a plain object copy which Alpine won't wrap in reactivity
        // because it's a new object instance each time (cached by WeakMap)

        // Cache the plain copy for future accesses (same instance = Alpine won't re-evaluate)
        plainCopyCache.set(value, plainCopy);

        // CRITICAL: Remove from activeProps since plain copy is plain object (won't trigger proxy getters)
        // The plain copy breaks the proxy chain, so we don't need to track it in activeProps
        // This prevents false circular reference detection when Alpine accesses properties on the plain copy
        if (activeProps) {
            activeProps.delete(propKey);
        }
        // Reset depth after returning plain copy
        if (callDepthMap && rawTarget) {
            callDepthMap.delete(rawTarget);
        }
        return plainCopy;
    } catch (e) {
        // Return null to indicate failure - caller should fall through to proxy creation
        return null;
    }
}

/**
 * Handles simple object detection and plain copy creation for a value
 * This is the main entry point for simple object handling
 * @param {*} value - The value to check
 * @param {Object} params - Handler parameters
 * @returns {Object|null} The plain copy if simple object, null otherwise
 */
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


/* Manifest Data Sources - Proxy Helper Functions */
// Utility functions for proxy creation and data manipulation

/**
 * Find an item in nested data structures by path key and segments
 * @param {*} data - The data to search (array or object)
 * @param {string} pathKey - The key that contains the path value
 * @param {Array} pathSegments - Array of path segments to match
 * @returns {*} The found item or null
 */
function findItemByPath(data, pathKey, pathSegments) {
    if (!pathSegments || pathSegments.length === 0) {
        return null;
    }

    // Handle arrays (including Alpine proxies that might not pass Array.isArray check)
    const hasLength = data && typeof data === 'object' && ('length' in data) && typeof data.length === 'number';
    const isArrayLike = hasLength && (Array.isArray(data) || (data.length >= 0 && (data.length === 0 || (typeof data[0] !== 'undefined' || typeof data['0'] !== 'undefined'))));

    if (isArrayLike) {
        // Convert to real array if needed (handles Alpine proxies)
        let arrayToSearch = data;
        if (!Array.isArray(data)) {
            try {
                // Try Array.from first (works for most iterables)
                arrayToSearch = Array.from(data);
            } catch (e) {
                // Fallback: manual conversion for non-iterable array-like objects
                arrayToSearch = [];
                for (let i = 0; i < data.length; i++) {
                    arrayToSearch[i] = data[i];
                }
            }
        }

        for (const item of arrayToSearch) {
            if (typeof item === 'object' && item !== null) {
                // Check if this item has the path key
                if (pathKey in item) {
                    const itemPath = item[pathKey];
                    // Check if any path segment matches this item's path
                    // Use String() to ensure type consistency in comparison
                    if (pathSegments.some(segment => String(segment) === String(itemPath))) {
                        return item;
                    }
                }

                // Recursively search nested objects
                const found = findItemByPath(item, pathKey, pathSegments);
                if (found) return found;
            }
        }
    } else if (typeof data === 'object' && data !== null) {
        for (const key in data) {
            const found = findItemByPath(data[key], pathKey, pathSegments);
            if (found) return found;
        }
    }

    return null;
}

/**
 * Find the group that contains a specific item
 * @param {*} data - The data to search
 * @param {*} targetItem - The item to find
 * @returns {*} The group containing the item or null
 */
function findGroupContainingItem(data, targetItem) {
    if (Array.isArray(data)) {
        for (const item of data) {
            if (typeof item === 'object' && item !== null) {
                // Check if this is a group with items
                if (item.group && Array.isArray(item.items)) {
                    // Check if the target item is in this group's items
                    if (item.items.includes(targetItem)) {
                        return item;
                    }
                }

                // Recursively search in nested objects
                const found = findGroupContainingItem(item, targetItem);
                if (found) return found;
            }
        }
    } else if (typeof data === 'object' && data !== null) {
        for (const key in data) {
            const found = findGroupContainingItem(data[key], targetItem);
            if (found) return found;
        }
    }

    return null;
}

/**
 * Convert Alpine proxy to real array
 * @param {*} proxyData - The proxy data to convert
 * @returns {Array} The converted array or original value
 */
function convertProxyToArray(proxyData) {
    if (Array.isArray(proxyData)) {
        return proxyData;
    }
    if (!proxyData || typeof proxyData !== 'object' || !('length' in proxyData)) {
        return proxyData;
    }
    try {
        return Array.from(proxyData);
    } catch (e) {
        // Fallback: manual conversion for non-iterable array-like objects
        const arr = [];
        for (let i = 0; i < proxyData.length; i++) {
            arr[i] = proxyData[i];
        }
        return arr;
    }
}

// Export to window for use by proxy creation modules
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxiesHelpers) {
        window.ManifestDataProxiesHelpers = {};
    }
    window.ManifestDataProxiesHelpers.findItemByPath = findItemByPath;
    window.ManifestDataProxiesHelpers.findGroupContainingItem = findGroupContainingItem;
    window.ManifestDataProxiesHelpers.convertProxyToArray = convertProxyToArray;
}


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
    let isAppwriteSource = false;
    if (dataSourceName) {
        try {
            const manifest = window.ManifestDataConfig?.ensureManifest?.();
            if (manifest?.data) {
                const dataSource = manifest.data[dataSourceName];
                if (dataSource && window.ManifestDataConfig?.isAppwriteCollection?.(dataSource)) {
                    isAppwriteSource = true;
                }
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
        // Check if this is an Appwrite source (reuse check from above if available)
        let isAppwriteSource = false;
        try {
            const manifest = window.ManifestDataConfig?.ensureManifest?.();
            if (manifest?.data) {
                const dataSource = manifest.data[dataSourceName];
                if (dataSource && window.ManifestDataConfig?.isAppwriteCollection?.(dataSource)) {
                    isAppwriteSource = true;
                }
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


/* Manifest Data Sources - Object Proxy Creation */
// Create proxies for nested objects that properly handles arrays and further nesting
// Simplified: Only proxy arrays, return objects directly (like backup)
function createNestedObjectProxy(objTarget, dataSourceName = null, reloadDataSource = null, path = []) {
    // path: array of keys representing the path to this object (e.g., ['specialHeader'] for $x.example.specialHeader)
    // This allows us to directly access nested values in the raw store without triggering Alpine reactivity

    // CRITICAL: Check if objTarget is already a proxy we created to prevent infinite recursion
    // Alpine may wrap our proxy, but we should never proxy a proxy we already created
    if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(objTarget)) {
        // This object is already proxied, return the cached proxy
        return window.ManifestDataProxiesCore.nestedObjectProxyCache.get(objTarget);
    }

    // Get the raw object from the store using the path to ensure we cache the correct object
    // This is critical because objTarget might be Alpine-wrapped (e.g. when raw wasn't ready at first access)
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

    // Check cache first to prevent infinite recursion and ensure same proxy instance is returned
    // This is critical for Alpine reactivity - if we create a new proxy each time,
    // Alpine sees it as a "new" object and triggers re-evaluation, causing infinite loops
    // Use the raw object from store as cache key (WeakMap requires object keys)
    if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(rawObjectForCache)) {
        const cached = window.ManifestDataProxiesCore.nestedObjectProxyCache.get(rawObjectForCache);

        return cached;
    }

    // Track active property accesses to prevent circular references
    // Use a WeakMap to track active accesses per target object (works even with Alpine proxies)
    // CRITICAL: Use rawObjectForCache as the key, not objTarget, because objTarget might be Alpine-wrapped
    if (!window.ManifestDataProxiesCore) {
        window.ManifestDataProxiesCore = {};
    }
    if (!window.ManifestDataProxiesCore.nestedProxyActiveProps) {
        window.ManifestDataProxiesCore.nestedProxyActiveProps = new WeakMap();
    }
    const activePropsMap = window.ManifestDataProxiesCore.nestedProxyActiveProps;

    // Initialize active props set for this target if not already present
    // Use rawObjectForCache as key to ensure consistency even when Alpine wraps the proxy
    if (!activePropsMap.has(rawObjectForCache)) {
        activePropsMap.set(rawObjectForCache, new Set());
    }

    // Store reference to raw target to avoid Alpine proxy wrapping issues
    // CRITICAL: Alpine may wrap our proxy in its own proxy, making 'target' in the get trap
    // actually be Alpine's wrapped version. By storing the raw object reference separately,
    // we can always access the true raw data without triggering Alpine's reactivity
    // CRITICAL: Always use rawObjectForCache for tracking, not objTarget which might be Alpine-wrapped
    const rawTarget = rawObjectForCache;

    // CRITICAL: Use rawTarget as the Proxy target, not objTarget
    // This ensures Alpine wraps a proxy around raw data, not Alpine-wrapped data
    // When Alpine wraps our proxy and accesses properties, it won't trigger reactivity loops
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

                // CRITICAL: If rawTarget is already a proxy we created, get value directly from store
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
                        // Use rawTarget (rawObjectForCache) to avoid Alpine reactivity issues
                        try {
                            const getRawData = window.ManifestDataStore?.getRawData;
                            if (getRawData && dataSourceName && path.length >= 0) {
                                const rawDataSource = getRawData(dataSourceName);
                                if (rawDataSource && typeof rawDataSource === 'object') {
                                    // Use a helper function to safely access properties without triggering proxies
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
                                    // Traverse the full path including the current key to get the final value
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

                // Check for circular reference using WeakMap
                // Use rawTarget (rawObjectForCache) instead of target to ensure we're tracking the correct object
                // This is critical because target might be Alpine's wrapped version
                const activeProps = activePropsMap.get(rawTarget);
                const propKey = String(key);

                // Use extracted circular reference handler
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
                    // If handler returned a value (including undefined), use it
                    // null means not a circular reference, continue normal flow
                    if (circularResult !== null) {
                        return circularResult;
                    }
                } else {
                    // Fallback to inline handling if handler not available (shouldn't happen in production)
                    if (activeProps && activeProps.has(propKey)) {
                        if (activeProps) {
                            activeProps.delete(propKey);
                        }
                        return undefined;
                    }
                }

                // Mark this property as being accessed (temporarily, will remove after getting value)
                // CRITICAL: Do this BEFORE any async operations or proxy creation to prevent re-entry
                if (activeProps) {
                    activeProps.add(propKey);
                }

                // CRITICAL: Always use rawTarget directly, never target
                // Even though we set proxyTarget to rawTarget, Alpine may wrap our proxy
                // and replace 'target' with an Alpine-wrapped version
                // By always using rawTarget (captured in closure), we ensure we're accessing raw data
                let value;

                try {
                    // Use a safe property accessor that bypasses proxies
                    const safeGet = (obj, prop) => {
                        if (!obj || typeof obj !== 'object') return undefined;
                        // Use Object.prototype.hasOwnProperty to check existence without triggering getters
                        if (Object.prototype.hasOwnProperty.call(obj, prop)) {
                            // Use direct property access - this bypasses proxy getters
                            return obj[prop];
                        }
                        return undefined;
                    };

                    // ALWAYS use rawTarget, never target (which might be Alpine-wrapped)
                    // For nested paths, traverse step by step using safe property access
                    // rawTarget is always the object at this path (path from root to this proxy).
                    // So we only need to read the requested key from rawTarget, never re-traverse path.
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

                // CRITICAL: Return primitives immediately to prevent Alpine wrapping issues
                // This must come BEFORE array/object checks to handle primitive values correctly
                if (value === null ||
                    typeof value === 'string' || typeof value === 'number' ||
                    typeof value === 'boolean' || typeof value === 'symbol') {
                    // Remove from activeProps before returning
                    if (activeProps) {
                        activeProps.delete(propKey);
                    }
                    // Reset depth after returning primitive
                    callDepthMap.delete(rawTarget);
                    return value;
                }

                // If the property is an array, create a proxy that handles array methods and $route at the top level
                if (Array.isArray(value)) {
                    // First attach methods directly to the array (for compatibility)
                    let arrayWithMethods = value;
                    try {
                        const attachArrayMethods = window.ManifestDataProxies?.attachArrayMethods;
                        if (attachArrayMethods) {
                            arrayWithMethods = attachArrayMethods(value, dataSourceName, reloadDataSource);
                        }
                    } catch (error) {
                        // Silently handle error attaching methods
                    }

                    // CRITICAL: Store reference to key and dataSourceName for toJSON access
                    const arrayKey = key;
                    const arrayDataSourceName = dataSourceName;

                    // CRITICAL: Define toJSON on the array before proxying
                    // JSON.stringify checks for toJSON before accessing properties
                    if (typeof arrayWithMethods.toJSON !== 'function') {
                        Object.defineProperty(arrayWithMethods, 'toJSON', {
                            enumerable: false,
                            configurable: true,
                            writable: false,
                            value: function () {
                                // Get raw array from store for serialization
                                try {
                                    const getRawData = window.ManifestDataStore?.getRawData;
                                    if (getRawData && arrayDataSourceName) {
                                        const rawDataSource = getRawData(arrayDataSourceName);
                                        if (rawDataSource && typeof rawDataSource === 'object') {
                                            const rawArray = rawDataSource[arrayKey];
                                            if (Array.isArray(rawArray)) {
                                                return rawArray; // Return raw array directly
                                            }
                                        }
                                    }
                                } catch (e) {
                                    // Fallback
                                }
                                // Fallback to arrayWithMethods (should be a plain array)
                                return Array.isArray(arrayWithMethods) ? arrayWithMethods : arrayWithMethods;
                            }
                        });
                    }

                    // Create a proxy for the array that handles methods at the top level
                    // This is similar to how Appwrite methods work - handled in proxy's get trap
                    const arrayProxy = new Proxy(arrayWithMethods, {
                        get(proxyTarget, prop) {
                            // CRITICAL: Handle toJSON for JSON.stringify compatibility
                            // JSON.stringify calls toJSON if it exists, otherwise it accesses properties
                            if (prop === 'toJSON') {
                                // Return the toJSON method directly from the target
                                return proxyTarget.toJSON;
                            }

                            // CRITICAL: Handle Symbol.toPrimitive for string conversion
                            if (prop === Symbol.toPrimitive) {
                                return function (hint) {
                                    if (hint === 'string' || hint === 'default') {
                                        // Use toJSON if available, otherwise stringify directly
                                        if (typeof proxyTarget.toJSON === 'function') {
                                            return JSON.stringify(proxyTarget.toJSON());
                                        }
                                        return JSON.stringify(proxyTarget);
                                    }
                                    return proxyTarget;
                                };
                            }

                            // Handle $search and $query at proxy level with safe fallbacks
                            if (prop === '$search' || prop === '$query') {
                                // Check if method exists on target
                                if (proxyTarget && typeof proxyTarget === 'object' && prop in proxyTarget && typeof proxyTarget[prop] === 'function') {
                                    return proxyTarget[prop].bind(proxyTarget);
                                }
                                // Fallback: return safe function that returns empty array
                                // This prevents Alpine errors when method doesn't exist yet (during loading)
                                return function () {
                                    return [];
                                };
                            }

                            // Handle $route at proxy level (like Appwrite methods)
                            if (prop === '$route') {
                                const createRouteProxy = window.ManifestDataProxies?.createRouteProxy;
                                if (!createRouteProxy) {
                                    return new Proxy({}, { get: () => undefined });
                                }
                                const routeFunction = function (pathKey) {
                                    if (proxyTarget && Array.isArray(proxyTarget)) {
                                        const getRawData = window.ManifestDataStore?.getRawData;
                                        let dataToUse = proxyTarget;
                                        // Try to get the nested array from raw data if needed
                                        if (dataSourceName && getRawData) {
                                            const rawData = getRawData(dataSourceName);
                                            if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
                                                // If raw data is an object, try to find the nested array
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
                                // Ensure function has proper prototype for Alpine's instanceof checks
                                Object.setPrototypeOf(routeFunction, Function.prototype);
                                // Mark as callable
                                routeFunction.call = Function.prototype.call;
                                routeFunction.apply = Function.prototype.apply;
                                routeFunction.bind = Function.prototype.bind;
                                return routeFunction;
                            }

                            // Handle ALL array methods at proxy level (like Appwrite methods)
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

                            // Fall through to target for other properties (including numeric indices)
                            return proxyTarget[prop];
                        },
                        // CRITICAL: Alpine uses has() to check if properties exist before accessing them
                        has(target, prop) {
                            // Always report that base plugin methods exist (we provide fallbacks)
                            if (prop === '$route' || prop === '$search' || prop === '$query') {
                                return true;
                            }
                            if (typeof prop === 'string' && typeof Array.prototype[prop] === 'function') {
                                return true;
                            }
                            return prop in target;
                        },
                        // CRITICAL: Alpine uses getOwnPropertyDescriptor to introspect properties
                        getOwnPropertyDescriptor(target, prop) {
                            if (prop === '$route') {
                                // Create the same function as in get() to ensure consistency
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
                        // CRITICAL: Include $route in ownKeys so Alpine sees it as an own property
                        ownKeys(target) {
                            const keys = Reflect.ownKeys(target);
                            const result = [...keys];
                            if (!result.includes('$route')) {
                                result.push('$route');
                            }
                            // CRITICAL: Include toJSON for JSON.stringify compatibility
                            if (!result.includes('toJSON')) {
                                result.push('toJSON');
                            }
                            return result;
                        }
                    });

                    // Remove from activeProps after creating array proxy
                    if (activeProps) {
                        activeProps.delete(propKey);
                    }

                    return arrayProxy;
                }

                // If the property is an object, wrap it recursively for further nesting
                // (activeProps is already declared above)
                // Pass along dataSourceName and reloadDataSource to maintain context
                if (typeof value === 'object' && value !== null) {
                    // NOTE: activeProps was already removed above after getting the value
                    // This prevents false circular reference detection when Alpine wraps our proxy

                    // CRITICAL: Always use the raw value we got from the store using path-based access
                    // The 'value' variable already contains the raw data from the store (via path traversal)
                    // This ensures we never use Alpine-wrapped objects
                    let objectToProxy = value;

                    // CRITICAL FIX: For simple objects accessed through nested proxies,
                    // return a plain object copy instead of creating another proxy.
                    // This prevents infinite recursion when Alpine wraps our proxy and accesses properties.
                    // Use extracted simple object handler
                    const handleSimpleObject = window.ManifestDataProxiesSimple?.handleSimpleObject;
                    if (handleSimpleObject && !Array.isArray(value)) {
                        const plainCopy = handleSimpleObject(value, {
                            activeProps,
                            propKey,
                            rawTarget,
                            fullPath,
                            callDepthMap
                        });
                        // If handler returned a plain copy, use it (null means not a simple object or failed)
                        if (plainCopy !== null) {
                            return plainCopy;
                        }
                        // Fall through to proxy creation if not a simple object or copy failed
                    }

                    // CRITICAL: If rawTarget is already proxied, check if the value itself is proxied before creating new proxy
                    // This prevents infinite recursion when Alpine wraps our proxy and accesses nested properties
                    if (isRawTargetProxied) {
                        // Get the raw nested object from store to check cache
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

                        // If the nested object is already proxied, return the cached proxy
                        if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(rawNestedObject)) {
                            const cachedProxy = window.ManifestDataProxiesCore.nestedObjectProxyCache.get(rawNestedObject);
                            if (cachedProxy) {
                                if (activeProps) {
                                    activeProps.delete(propKey);
                                }
                                return cachedProxy;
                            }
                        }

                        // If rawTarget is proxied but nested object isn't, we still need to create a proxy
                        // But use the raw nested object from store as the target
                        objectToProxy = rawNestedObject;
                    }

                    // CRITICAL: Check if this object is already a proxy we created to prevent infinite recursion
                    // This can happen when Alpine wraps our proxy and accesses properties on the wrapped proxy
                    if (window.ManifestDataProxiesCore?.nestedObjectProxyCache?.has(objectToProxy)) {
                        const cachedProxy = window.ManifestDataProxiesCore.nestedObjectProxyCache.get(objectToProxy);
                        if (activeProps) {
                            activeProps.delete(propKey);
                        }
                        return cachedProxy;
                    }

                    // Final check: if still undefined or null, return undefined
                    if (objectToProxy === undefined || objectToProxy === null) {
                        return undefined;
                    }

                    // CRITICAL FIX: Check cache BEFORE calling createNestedObjectProxy to avoid function call overhead
                    // Get the raw nested object from store to use as cache key
                    const newPath = [...path, key];
                    let rawNestedObject = objectToProxy;

                    // Try to get the raw object from store using the new path
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
                            // Remove from activeProps before returning cached proxy
                            if (activeProps) {
                                activeProps.delete(propKey);
                            }
                            return cachedProxy;
                        }
                    }

                    const nestedProxy = createNestedObjectProxy(objectToProxy, dataSourceName, reloadDataSource, newPath);

                    // Remove from activeProps after creating nested proxy
                    // This allows Alpine to access nested properties without false circular detection
                    if (activeProps) {
                        activeProps.delete(propKey);
                    }

                    // Don't reset depth here - nested proxy will handle it
                    return nestedProxy;
                }

                // If value is undefined, return a loading proxy to maintain chain and prevent errors
                if (value === undefined) {
                    // Remove from activeProps before returning
                    if (activeProps) {
                        activeProps.delete(propKey);
                    }
                    // Reset depth
                    callDepthMap.delete(rawTarget);
                    return window.ManifestDataProxiesCore.createLoadingProxy(dataSourceName);
                }

                // Remove from activeProps before returning
                if (activeProps) {
                    activeProps.delete(propKey);
                }

                // Reset depth
                callDepthMap.delete(rawTarget);
                return value;
            } finally {
                if (typeof window !== 'undefined') window.__manifestNestedGetDepth = Math.max(0, (window.__manifestNestedGetDepth || 0) - 1);
            }
        }
    });

    // Cache the proxy before returning to prevent re-proxying the same object
    // Use the raw object from store as cache key (WeakMap requires object keys)
    // Critical for Alpine reactivity - prevents infinite re-evaluation loops
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


/* Manifest Data Sources - Route Proxy Creation */
// Creates proxies for route-specific data lookups ($route() method)

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
                console.error('[Route Proxy Get] Error:', error);
                return undefined;
            }
        },
        // Add has trap to help Alpine track property existence
        has(target, prop) {
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


/* Manifest Data Sources - File Management */
// Single Source of Truth Architecture:
// - Storage bucket = source of truth for file existence
// - Database entry's fileIds = source of truth for relationships
// - Entry file lists = computed/filtered views (no separate state)

// Legacy: Keep reactiveFileManagers Map for backward compatibility during transition
// Will be removed once all code is migrated to computed approach
const reactiveFileManagers = new Map();

// Create a computed files array for an entry that filters the bucket array by fileIds
// This is the new single-source-of-truth approach
function createComputedFilesArray(tableName, entryId, bucketName, columnName = 'fileIds') {
    if (typeof Alpine === 'undefined') {
        // Return empty array proxy if Alpine not available
        return new Proxy([], {
            get(target, key) {
                if (key === '$loading') return false;
                if (key === '$error') return null;
                if (key === Symbol.iterator) return function* () { };
                if (key in target) {
                    const value = target[key];
                    return typeof value === 'function' ? value.bind(target) : value;
                }
                return undefined;
            },
            has(target, key) {
                return key in target || key === '$loading' || key === '$error';
            }
        });
    }

    // Create a reactive array that will be computed from bucket and fileIds
    const computedFiles = typeof Alpine !== 'undefined' && Alpine.reactive
        ? Alpine.reactive([])
        : [];

    // Reactive state for loading/error
    const loadingState = typeof Alpine !== 'undefined' && Alpine.reactive
        ? Alpine.reactive({ value: false })
        : { value: false };
    const errorState = typeof Alpine !== 'undefined' && Alpine.reactive
        ? Alpine.reactive({ value: null })
        : { value: null };

    // Function to recompute files array from bucket and entry's fileIds
    const recomputeFiles = () => {
        try {
            // Get bucket array from store
            const store = Alpine.store('data');
            if (!store) {
                computedFiles.length = 0;
                loadingState.value = true; // Still loading if store not ready
                return;
            }

            // Check bucket loading state first
            const bucketState = store[`_${bucketName}_state`];
            const bucketLoading = bucketState?.loading || false;
            const bucketError = bucketState?.error || null;

            // If bucket not loaded yet, show loading state
            if (!store[bucketName] || !Array.isArray(store[bucketName])) {
                computedFiles.length = 0;
                loadingState.value = bucketLoading;
                errorState.value = bucketError;
                return;
            }

            const bucketFiles = store[bucketName];

            // Get entry from store to read fileIds
            const entries = store[tableName];
            if (!Array.isArray(entries)) {
                computedFiles.length = 0;
                loadingState.value = bucketLoading;
                errorState.value = bucketError;
                return;
            }

            const entry = entries.find(e => e.$id === entryId);
            if (!entry) {
                computedFiles.length = 0;
                loadingState.value = bucketLoading;
                errorState.value = bucketError;
                return;
            }

            // Get fileIds from entry
            const fileIds = entry[columnName] || [];
            if (!Array.isArray(fileIds)) {
                computedFiles.length = 0;
                loadingState.value = bucketLoading;
                errorState.value = bucketError;
                return;
            }

            // Filter bucket files by fileIds
            const filteredFiles = bucketFiles.filter(file =>
                file && file.$id && fileIds.includes(file.$id)
            );

            // Update computed array (maintains reactivity)
            computedFiles.length = 0;
            computedFiles.push(...filteredFiles);

            // Update loading/error state from bucket state
            loadingState.value = bucketLoading;
            errorState.value = bucketError;

        } catch (err) {
            console.error('[createComputedFilesArray] Error recomputing files:', err);
            errorState.value = err.message || 'Failed to compute files';
            loadingState.value = false;
        }
    };

    // Set up Alpine effect to watch both bucket array and entry's fileIds
    if (typeof Alpine !== 'undefined' && Alpine.effect) {
        Alpine.effect(() => {
            // Access store to track changes
            const store = Alpine.store('data');
            if (!store) {
                recomputeFiles();
                return;
            }

            // Track bucket array changes - access the array itself and iterate to track all elements
            const bucketFiles = store[bucketName];
            if (bucketFiles && Array.isArray(bucketFiles)) {
                // Access length and iterate to track all file changes
                const _ = bucketFiles.length;
                // Iterate through files to track individual file changes
                bucketFiles.forEach(file => {
                    if (file && file.$id) {
                        const __ = file.$id; // Track file ID changes
                    }
                });
            }

            // Track entry's fileIds changes - access entry and fileIds array
            const entries = store[tableName];
            if (entries && Array.isArray(entries)) {
                const entry = entries.find(e => e.$id === entryId);
                if (entry) {
                    // Access fileIds array to track changes
                    const fileIds = entry[columnName] || [];
                    if (Array.isArray(fileIds)) {
                        const _ = fileIds.length;
                        // Iterate through fileIds to track individual ID changes
                        fileIds.forEach(id => {
                            const __ = id; // Track individual fileId changes
                        });
                    }
                }
            }

            // Track bucket loading state
            const bucketState = store[`_${bucketName}_state`];
            if (bucketState) {
                const _ = bucketState.loading;
                const __ = bucketState.error;
            }

            // Recompute files after tracking all dependencies
            recomputeFiles();
        });
    }

    // Initial computation
    recomputeFiles();

    // Create proxy that adds loading/error properties
    return new Proxy(computedFiles, {
        get(target, key) {
            if (key === '$loading') return loadingState.value;
            if (key === '$error') return errorState.value;
            if (key === Symbol.iterator) return target[Symbol.iterator].bind(target);
            if (key in target) {
                const value = target[key];
                return typeof value === 'function' ? value.bind(target) : value;
            }
            return undefined;
        },
        has(target, key) {
            return key in target || key === '$loading' || key === '$error';
        }
    });
}

// Create reactive file array that watches a function/expression for entryId changes
function createReactiveFileArrayFromGetter(tableName, entryIdGetter, bucketName, columnName) {
    if (typeof Alpine === 'undefined') {
        // Return empty array if Alpine not available
        return new Proxy([], {
            get(target, key) {
                if (key === '$loading') return false;
                if (key === '$error') return null;
                if (key === '$reload') return () => { };
                if (key === Symbol.iterator) return function* () { };
                if (key in target) {
                    const value = target[key];
                    return typeof value === 'function' ? value.bind(target) : value;
                }
                return undefined;
            }
        });
    }

    // Current manager reference
    let currentManager = null;
    let currentEntryId = null;
    let unwatchCallback = null;

    // Create a proxy array that delegates to the current manager
    const proxyArray = new Proxy([], {
        get(target, key) {
            // Handle special keys
            if (key === Symbol.iterator || key === 'then' || key === 'catch' || key === 'finally') {
                return undefined;
            }

            // Get current entryId from getter
            let entryId;
            try {
                entryId = typeof entryIdGetter === 'function' ? entryIdGetter() : entryIdGetter;
            } catch (e) {
                // If getter throws (e.g., property doesn't exist yet), return empty array behavior
                entryId = null;
            }

            // If entryId changed or manager doesn't exist, update manager
            if (entryId !== currentEntryId) {
                currentEntryId = entryId;

                // Cleanup old watcher
                if (unwatchCallback) {
                    unwatchCallback();
                    unwatchCallback = null;
                }

                // If no entryId, return empty array behavior
                if (!entryId) {
                    currentManager = null;
                    return key === '$loading' ? false :
                        key === '$error' ? null :
                            key === '$reload' ? () => { } :
                                key === 'length' ? 0 :
                                    key === Symbol.iterator ? function* () { } :
                                        key in target ? (typeof target[key] === 'function' ? target[key].bind(target) : target[key]) : undefined;
                }

                // Get manifest and storage config
                const manifest = window.ManifestDataConfig?.getManifest?.();
                if (!manifest?.data) {
                    currentManager = null;
                    return key === '$loading' ? true :
                        key === '$error' ? null :
                            key === '$reload' ? () => { } :
                                key === 'length' ? 0 :
                                    key === Symbol.iterator ? function* () { } :
                                        key in target ? (typeof target[key] === 'function' ? target[key].bind(target) : target[key]) : undefined;
                }

                const tableDataSource = manifest.data[tableName];
                if (!tableDataSource) {
                    currentManager = null;
                    return undefined;
                }

                // Determine bucket name
                let resolvedBucketName = bucketName;
                if (!resolvedBucketName) {
                    resolvedBucketName = getDefaultBucketForTable(tableName);
                    if (!resolvedBucketName) {
                        currentManager = null;
                        return undefined;
                    }
                }

                // Get storage config
                const storageConfig = parseStorageConfig(tableDataSource, resolvedBucketName);
                if (!storageConfig) {
                    currentManager = null;
                    return undefined;
                }

                const resolvedColumnName = columnName || storageConfig.column || 'fileIds';

                // Create or get reactive file manager
                currentManager = createReactiveFileManager(tableName, entryId, resolvedBucketName, resolvedColumnName);
            }

            // Delegate to current manager
            if (currentManager) {
                if (key === '$loading') {
                    return currentManager.loading();
                }
                if (key === '$error') {
                    return currentManager.error();
                }
                if (key === '$reload') {
                    return currentManager.reload;
                }
                // Delegate array access to manager's files array
                const files = currentManager.files;
                if (key in files) {
                    const value = files[key];
                    return typeof value === 'function' ? value.bind(files) : value;
                }
            }

            // Fallback to empty array behavior
            return key === 'length' ? 0 :
                key === Symbol.iterator ? function* () { } :
                    key in target ? (typeof target[key] === 'function' ? target[key].bind(target) : target[key]) : undefined;
        },
        has(target, key) {
            if (currentManager && key in currentManager.files) {
                return true;
            }
            return key in target || key === '$loading' || key === '$error' || key === '$reload';
        }
    });

    // Initial evaluation to set up manager
    try {
        const initialEntryId = typeof entryIdGetter === 'function' ? entryIdGetter() : entryIdGetter;
        if (initialEntryId) {
            // Trigger initial setup by accessing a property
            proxyArray.length;
        }
    } catch (e) {
        // Ignore errors during initial evaluation
    }

    return proxyArray;
}

// Parse storage config (hybrid: string reference or inline object)
function parseStorageConfig(tableDataSource, bucketName) {
    const manifest = window.ManifestDataConfig?.getManifest?.();
    if (!manifest?.data) {
        return null;
    }

    const storageConfig = tableDataSource?.storage;
    if (!storageConfig || typeof storageConfig !== 'object') {
        return null;
    }

    const bucketConfig = storageConfig[bucketName];
    if (!bucketConfig) {
        return null;
    }

    // If string, it's a column name reference to separate bucket
    if (typeof bucketConfig === 'string') {
        const bucketDataSource = manifest.data[bucketName];
        if (!bucketDataSource || !window.ManifestDataConfig.getAppwriteBucketId(bucketDataSource)) {
            return null;
        }
        return {
            bucketId: window.ManifestDataConfig.getAppwriteBucketId(bucketDataSource),
            scope: window.ManifestDataConfig.getScope(bucketDataSource),
            column: bucketConfig
        };
    }

    // If object, it's an inline bucket definition
    if (typeof bucketConfig === 'object' && bucketConfig !== null) {
        return {
            bucketId: bucketConfig.appwriteBucketId,
            scope: bucketConfig.scope,
            column: bucketConfig.column || 'fileIds'
        };
    }

    return null;
}

// Get storage config for a table (returns all configured buckets)
function getTableStorageConfig(tableName) {
    const manifest = window.ManifestDataConfig?.getManifest?.();
    if (!manifest?.data) {
        return null;
    }

    const tableDataSource = manifest.data[tableName];
    if (!tableDataSource) {
        return null;
    }

    return tableDataSource.storage || null;
}

// Get default bucket for a table (if only one configured)
function getDefaultBucketForTable(tableName) {
    const storageConfig = getTableStorageConfig(tableName);
    if (!storageConfig || typeof storageConfig !== 'object') {
        return null;
    }

    const bucketNames = Object.keys(storageConfig);
    if (bucketNames.length === 1) {
        return bucketNames[0];
    }

    return null;
}

// Create reactive file array manager for a table/entry/bucket combination
function createReactiveFileManager(tableName, entryId, bucketName, columnName) {
    const key = `${tableName}:${entryId}:${bucketName}`;

    if (reactiveFileManagers.has(key)) {
        const existing = reactiveFileManagers.get(key);
        return existing;
    }

    // CRITICAL: Make files array reactive so Alpine can track changes
    const files = typeof Alpine !== 'undefined' && Alpine.reactive
        ? Alpine.reactive([])
        : [];

    let loading = false;
    let error = null;
    let unsubscribeCallbacks = [];

    // Load files function
    const loadFiles = async () => {
        if (loading) return;

        loading = true;
        error = null;

        try {
            const manifest = await window.ManifestDataConfig.ensureManifest();
            const tableDataSource = manifest?.data?.[tableName];
            if (!tableDataSource) {
                throw new Error(`[Manifest Data] Table "${tableName}" not found`);
            }

            // CRITICAL: parseStorageConfig uses getManifest() which might return null
            // Instead, parse the storage config directly using the manifest we already have
            const storageConfigObj = tableDataSource?.storage;
            if (!storageConfigObj || typeof storageConfigObj !== 'object') {
                throw new Error(`[Manifest Data] Storage bucket "${bucketName}" not configured for table "${tableName}"`);
            }

            const bucketConfig = storageConfigObj[bucketName];
            if (!bucketConfig) {
                throw new Error(`[Manifest Data] Storage bucket "${bucketName}" not configured for table "${tableName}"`);
            }

            let storageConfig;
            // If string, it's a column name reference to separate bucket
            if (typeof bucketConfig === 'string') {
                const bucketDataSource = manifest.data[bucketName];
                if (!bucketDataSource || !window.ManifestDataConfig.getAppwriteBucketId(bucketDataSource)) {
                    throw new Error(`[Manifest Data] Storage bucket "${bucketName}" not found in manifest`);
                }
                storageConfig = {
                    bucketId: window.ManifestDataConfig.getAppwriteBucketId(bucketDataSource),
                    scope: window.ManifestDataConfig.getScope(bucketDataSource),
                    column: bucketConfig
                };
            } else if (typeof bucketConfig === 'object' && bucketConfig !== null) {
                // If object, it's an inline bucket definition
                storageConfig = {
                    bucketId: bucketConfig.appwriteBucketId,
                    scope: bucketConfig.scope,
                    column: bucketConfig.column || 'fileIds'
                };
            } else {
                throw new Error(`[Manifest Data] Invalid storage configuration for bucket "${bucketName}"`);
            }

            if (!storageConfig) {
                throw new Error(`[Manifest Data] Storage bucket "${bucketName}" not configured for table "${tableName}"`);
            }

            const loadedFiles = await getFilesForEntry(
                tableName,
                entryId,
                storageConfig.bucketId,
                columnName || storageConfig.column
            );

            // Update array in place (maintains reactivity)
            files.length = 0;
            files.push(...loadedFiles);

            // Update lastSeenFileIds to match what was actually loaded
            // This prevents false positives when the watch effect runs
            const $x = window.Alpine?.magic?.('x')?.();
            if ($x && $x[tableName] && Array.isArray($x[tableName])) {
                const entry = $x[tableName].find(item => item.$id === entryId);
                if (entry) {
                    const currentFileIds = entry[columnName || 'fileIds'] || [];
                    lastSeenFileIds = JSON.stringify(currentFileIds);
                }
            }

        } catch (err) {
            error = err.message || String(err);
        } finally {
            loading = false;
        }
    };

    // Subscribe to events
    const subscribeToEvents = () => {
        // Listen for table file updates (currently dispatched as manifest:project-files-updated)
        const handleTableFilesUpdated = (e) => {
            // Support both old format (projectId) and new format (tableName + entryIds)
            const eventEntryId = e.detail?.projectId || e.detail?.entryId;
            const eventTableName = e.detail?.tableName || 'projects'; // Default to 'projects' for backward compat

            if (eventTableName === tableName && eventEntryId === entryId) {
                // Use requestAnimationFrame for immediate execution in next frame
                // This ensures DOM updates are complete but doesn't add unnecessary delay
                requestAnimationFrame(() => {
                    loadFiles();
                });
            }
        };

        // Listen for file created events
        const handleFileCreated = (e) => {
            if (e.detail?.fileId) {
                // Use requestAnimationFrame for immediate execution
                requestAnimationFrame(() => {
                    // Check if file is linked to this entry
                    const $x = window.Alpine?.magic?.('x')?.();
                    if ($x && $x[tableName]) {
                        const entry = Array.isArray($x[tableName])
                            ? $x[tableName].find(item => item.$id === entryId)
                            : null;
                        if (entry && entry[columnName || 'fileIds']?.includes(e.detail.fileId)) {
                            loadFiles();
                        }
                    }
                });
            }
        };

        // Listen for file deleted events
        const handleFileDeleted = (e) => {
            if (e.detail?.fileId && e.detail?.tableName === tableName && e.detail?.entryIds?.includes(entryId)) {
                // Optimistically remove file immediately for instant UI feedback
                const index = files.findIndex(f => f.$id === e.detail.fileId);
                if (index !== -1) {
                    files.splice(index, 1);
                }
                // Then reload to ensure consistency
                requestAnimationFrame(() => {
                    loadFiles();
                });
            }
        };

        window.addEventListener('manifest:project-files-updated', handleTableFilesUpdated);
        window.addEventListener('manifest:file-created', handleFileCreated);
        window.addEventListener('manifest:file-deleted', handleFileDeleted);

        unsubscribeCallbacks.push(() => {
            window.removeEventListener('manifest:project-files-updated', handleTableFilesUpdated);
            window.removeEventListener('manifest:file-created', handleFileCreated);
            window.removeEventListener('manifest:file-deleted', handleFileDeleted);
        });
    };

    // Watch table data for fileIds changes
    // CRITICAL: Track last seen fileIds for THIS specific entry to prevent false positives
    let lastSeenFileIds = null;

    const watchTableData = () => {
        if (typeof Alpine === 'undefined') return;

        const unwatch = Alpine.effect(() => {
            const $x = window.Alpine?.magic?.('x')?.();
            if ($x && $x[tableName] && Array.isArray($x[tableName])) {
                const entry = $x[tableName].find(item => item.$id === entryId);
                if (entry) {
                    const currentFileIds = entry[columnName || 'fileIds'] || [];
                    const currentFileIdsStr = JSON.stringify(currentFileIds);

                    // Only reload if fileIds actually changed for THIS entry
                    // Compare with lastSeenFileIds, not with files array (which might be stale)
                    if (lastSeenFileIds !== currentFileIdsStr && !loading) {
                        // Update lastSeenFileIds BEFORE loading to prevent duplicate loads
                        lastSeenFileIds = currentFileIdsStr;

                        // Load files immediately - don't wait for next frame
                        loadFiles().then(() => {
                            // After loading, verify fileIds still match (in case they changed during load)
                            const $xAfter = window.Alpine?.magic?.('x')?.();
                            if ($xAfter && $xAfter[tableName] && Array.isArray($xAfter[tableName])) {
                                const entryAfter = $xAfter[tableName].find(item => item.$id === entryId);
                                if (entryAfter) {
                                    const fileIdsAfter = entryAfter[columnName || 'fileIds'] || [];
                                    lastSeenFileIds = JSON.stringify(fileIdsAfter);
                                }
                            }
                        }).catch(err => {
                            console.error('[ReactiveFileManager] Failed to load files after fileIds change:', err);
                        });
                    } else if (lastSeenFileIds === null) {
                        // Initialize lastSeenFileIds on first run
                        lastSeenFileIds = currentFileIdsStr;
                    }

                    // CRITICAL: Also check if files array is out of sync with fileIds
                    // This handles cases where fileIds changed but watch didn't trigger
                    // Use the already-declared currentFileIds variable
                    const filesFileIds = files.map(f => f.$id);
                    const fileIdsMatch = currentFileIds.length === filesFileIds.length &&
                        currentFileIds.every(id => filesFileIds.includes(id));

                    if (!fileIdsMatch && !loading && lastSeenFileIds !== null) {
                        lastSeenFileIds = JSON.stringify(currentFileIds);
                        loadFiles().catch(err => {
                            console.error('[ReactiveFileManager] Failed to reload files after sync check:', err);
                        });
                    }
                }
            }
        });

        unsubscribeCallbacks.push(() => {
            if (unwatch && typeof unwatch === 'function') {
                unwatch();
            }
        });
    };

    // Initialize
    subscribeToEvents();
    watchTableData();

    loadFiles();

    const manager = {
        files,
        loading: () => loading,
        error: () => error,
        reload: loadFiles,
        destroy: () => {
            unsubscribeCallbacks.forEach(cb => cb());
            reactiveFileManagers.delete(key);
        }
    };

    reactiveFileManagers.set(key, manager);

    return manager;
}

// Get files for a specific table entry (generic - works with any table)
// Supports any scope (user/team/teams) - files are filtered by permissions automatically
async function getFilesForEntry(tableName, entryId, bucketId, fileIdsColumn = 'fileIds') {
    const manifest = await window.ManifestDataConfig.ensureManifest();
    const tableDataSource = manifest?.data?.[tableName];

    if (!tableDataSource || !window.ManifestDataConfig.getAppwriteTableId(tableDataSource)) {
        throw new Error(`[Manifest Data] Table "${tableName}" not found in manifest`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(tableDataSource);
    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(tableDataSource);

    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${tableName}"`);
    }

    // Get the table entry
    let entry;
    try {
        entry = await window.ManifestDataAppwrite.getTableRow(
            appwriteConfig.databaseId,
            tableId,
            entryId
        );
    } catch (err) {
        // Handle 404 errors gracefully (entry was deleted)
        const isNotFound = err.message?.includes('not found') ||
            err.message?.includes('could not be found') ||
            err.code === 404 ||
            err.response?.code === 404;

        if (isNotFound) {
            // Entry was deleted - return empty array instead of throwing
            return [];
        }
        // Re-throw other errors
        throw err;
    }

    if (!entry) {
        return [];
    }

    // Get fileIds from the entry (using configurable column name)
    const fileIds = entry[fileIdsColumn] || [];
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
        return [];
    }

    // Get all files from the bucket by calling Appwrite storage directly
    // This bypasses any scope filtering that might be applied in loadDataSource
    // We need ALL files the user has access to, not just those matching the current scope
    const services = await window.ManifestDataAppwrite._getAppwriteDataServices?.();
    if (!services?.storage) {
        throw new Error('[Manifest Data] Appwrite Storage service not available');
    }

    // Call Appwrite storage.listFiles directly to get all files user has access to
    // This returns files based on Appwrite's permission system, not our scope filtering
    const response = await services.storage.listFiles(bucketId, []);
    const allFiles = response?.files || [];

    // Filter to only files that are in the entry's fileIds array
    let entryFiles = allFiles.filter(file => fileIds.includes(file.$id));

    // Check for missing files - these might have been uploaded with incorrect permissions
    // (e.g., before we fixed buildStoragePermissions to use project team permissions)
    const missingFileIds = fileIds.filter(id => !entryFiles.some(f => f.$id === id));

    // CRITICAL DEBUG: Log missing files to understand where stale fileIds come from
    if (missingFileIds.length > 0) {
        console.warn('[getFilesForEntry] Found missing fileIds in database entry:', {
            tableName,
            entryId,
            missingFileIds,
            validFileIds: entryFiles.map(f => f.$id),
            allFileIdsInBucket: allFiles.map(f => f.$id)
        });
    }

    // Note: missingFileIds are silently skipped - they may have been deleted
    // CRITICAL: If we have missing fileIds, we should clean them up from the database
    // instead of trying to fetch them (which causes 404s)
    const confirmedMissingFileIds = []; // Track fileIds confirmed to be deleted (404s)

    if (missingFileIds.length > 0) {
        // Log warning about stale fileIds
        console.warn('[Manifest Data] Found stale fileIds in database entry:', {
            tableName,
            entryId,
            staleFileIds: missingFileIds,
            validFileIds: entryFiles.map(f => f.$id),
            suggestion: 'These fileIds will be cleaned up automatically'
        });

        // Try to fetch missing files individually ONLY if they might exist with different permissions
        // Skip files that are clearly deleted (404s) to avoid unnecessary API calls
        for (const missingFileId of missingFileIds) {
            try {
                // Try to get file metadata directly using getFile if available
                // This is more reliable than getFileView for checking if a file exists
                let fileMetadata = null;
                let fileExists = false;

                if (services.storage.getFile) {
                    try {
                        fileMetadata = await services.storage.getFile(bucketId, missingFileId);
                        if (fileMetadata) {
                            fileExists = true;
                            entryFiles.push(fileMetadata);
                            continue; // Successfully added, move to next file
                        }
                    } catch (getFileError) {
                        // Check if it's a 404 (file not found) vs other error
                        const isNotFound = getFileError.message?.includes('not found') ||
                            getFileError.message?.includes('could not be found') ||
                            getFileError.code === 404 ||
                            getFileError.response?.code === 404;

                        if (isNotFound) {
                            // File was deleted - track it for cleanup
                            confirmedMissingFileIds.push(missingFileId);
                            continue; // Skip this missing file
                        }

                        // Other error (permission, etc.) - try getFileView as fallback
                    }
                }

                // Fallback: Try to get file metadata by attempting to get its view URL
                // If this succeeds, the file exists and user has access
                try {
                    const fileUrl = await services.storage.getFileView({
                        bucketId: bucketId,
                        fileId: missingFileId
                    });

                    // If we got a URL, the file exists and user has access
                    // Try to find it in the full list (maybe it was in a different page)
                    const foundInList = allFiles.find(f => f.$id === missingFileId);
                    if (foundInList) {
                        entryFiles.push(foundInList);
                    } else {
                        // File exists and user has access (we got the URL), but wasn't in listFiles
                        // This means the file has permission issues but is still accessible
                        // Create a minimal file object
                        const minimalFile = {
                            $id: missingFileId,
                            name: `File ${missingFileId.substring(0, 8)}... (limited access)`,
                            bucketId: bucketId,
                            // Note: This file may have permission issues, but user can access it via URL
                            $permissions: [],
                            // Mark as minimal so UI can handle it appropriately
                            _minimal: true
                        };
                        entryFiles.push(minimalFile);
                        console.warn('[Manifest Data] File accessible but not in listFiles - created minimal object:', {
                            fileId: missingFileId,
                            entryId,
                            suggestion: 'File may need to be re-uploaded with correct team permissions for full metadata'
                        });
                    }
                } catch (viewError) {
                    // getFileView also failed - check if it's a 404
                    const isNotFound = viewError.message?.includes('not found') ||
                        viewError.message?.includes('could not be found') ||
                        viewError.code === 404 ||
                        viewError.response?.code === 404;

                    if (isNotFound) {
                        // File was deleted - track it for cleanup
                        confirmedMissingFileIds.push(missingFileId);
                        continue; // Skip this missing file
                    } else {
                        // Permission error or other issue
                        console.warn('[Manifest Data] Missing file not accessible:', {
                            fileId: missingFileId,
                            entryId,
                            error: viewError.message,
                            suggestion: 'File was likely uploaded with incorrect permissions. Re-upload the file to fix permissions.'
                        });
                    }
                }
            } catch (error) {
                // Unexpected error - log and skip
                console.warn('[Manifest Data] Unexpected error checking missing file:', {
                    fileId: missingFileId,
                    entryId,
                    error: error.message
                });
            }
        }

        // Clean up confirmed-missing fileIds from the database entry
        if (confirmedMissingFileIds.length > 0) {
            try {
                const unlinkFileFromEntry = window.ManifestDataProxiesFiles?.unlinkFileFromEntry;
                if (unlinkFileFromEntry) {
                    // Remove all confirmed-missing fileIds in parallel
                    await Promise.all(
                        confirmedMissingFileIds.map(fileId =>
                            unlinkFileFromEntry(tableName, entryId, fileId, fileIdsColumn)
                                .catch(err => {
                                    console.warn('[Manifest Data] Failed to unlink stale fileId:', {
                                        fileId,
                                        entryId,
                                        error: err.message
                                    });
                                })
                        )
                    );
                }
            } catch (cleanupError) {
                console.warn('[Manifest Data] Failed to clean up stale fileIds:', {
                    tableName,
                    entryId,
                    error: cleanupError.message
                });
            }
        }
    }

    return entryFiles;
}

// Link a file to a table entry by adding the file ID to the entry's fileIds array
// Generic function - works with any table and any scope
async function linkFileToEntry(tableName, entryId, fileId, fileIdsColumn = 'fileIds') {
    const manifest = await window.ManifestDataConfig.ensureManifest();
    const tableDataSource = manifest?.data?.[tableName];

    if (!tableDataSource || !window.ManifestDataConfig.getAppwriteTableId(tableDataSource)) {
        throw new Error(`[Manifest Data] Table "${tableName}" not found in manifest`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(tableDataSource);
    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(tableDataSource);

    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${tableName}"`);
    }

    // CRITICAL: Read from store FIRST to get the latest optimistic updates
    // This prevents race conditions when multiple files are uploaded concurrently
    // If store has the entry, use it; otherwise fall back to database
    let fileIds = null;
    const store = typeof Alpine !== 'undefined' && Alpine.store ? Alpine.store('data') : null;
    if (store && store[tableName] && Array.isArray(store[tableName])) {
        const storeEntry = store[tableName].find(e => e.$id === entryId);
        if (storeEntry && storeEntry[fileIdsColumn] !== undefined) {
            fileIds = storeEntry[fileIdsColumn];
        }
    }

    // If store doesn't have it, read from database
    if (fileIds === null) {
        const entry = await window.ManifestDataAppwrite.getTableRow(
            appwriteConfig.databaseId,
            tableId,
            entryId
        );

        if (!entry) {
            throw new Error(`[Manifest Data] Entry "${entryId}" not found in table "${tableName}"`);
        }

        // Get or initialize fileIds array (using configurable column name)
        // Check if the column exists (if it's undefined, the column might not exist in the table schema)
        fileIds = entry[fileIdsColumn];
        if (fileIds === undefined) {
            // Column doesn't exist - throw a helpful error
            throw new Error(`[Manifest Data] The "${fileIdsColumn}" column does not exist in the "${tableName}" table. Please add a "${fileIdsColumn}" column (type: string array) to the table in Appwrite.`);
        }

    }

    if (!Array.isArray(fileIds)) {
        fileIds = [];
    }

    // Add file ID if not already present
    if (!fileIds.includes(fileId)) {
        fileIds.push(fileId);

        try {
            // Use optimistic update via mutation system
            const executeMutation = window.ManifestDataMutations?.executeMutation;
            const updateEntryInStore = window.ManifestDataMutations?.updateEntryInStore;

            if (executeMutation && updateEntryInStore) {
                // Optimistic update: immediately update store
                updateEntryInStore(tableName, entryId, { [fileIdsColumn]: fileIds });

                // Background sync: update server
                try {
                    await window.ManifestDataAppwrite.updateRow(
                        appwriteConfig.databaseId,
                        tableId,
                        entryId,
                        { [fileIdsColumn]: fileIds }
                    );
                } catch (updateError) {
                    // Rollback on error
                    const errorMessage = updateError?.message || String(updateError);
                    if (errorMessage.includes('Unknown attribute') || errorMessage.includes(fileIdsColumn)) {
                        throw new Error(`[Manifest Data] The "${fileIdsColumn}" column does not exist in the "${tableName}" table. Please add a "${fileIdsColumn}" column (type: string array) to the table in Appwrite.`);
                    }
                    // Rollback optimistic update
                    const store = Alpine.store('data');
                    if (store && store[tableName] && Array.isArray(store[tableName])) {
                        const originalEntry = store[tableName].find(e => e.$id === entryId);
                        if (originalEntry) {
                            const originalFileIds = originalEntry[fileIdsColumn] || [];
                            const rolledBackFileIds = originalFileIds.filter(id => id !== fileId);
                            updateEntryInStore(tableName, entryId, { [fileIdsColumn]: rolledBackFileIds });
                        }
                    }
                    throw updateError;
                }
            } else {
                // Fallback to old behavior
                await window.ManifestDataAppwrite.updateRow(
                    appwriteConfig.databaseId,
                    tableId,
                    entryId,
                    { [fileIdsColumn]: fileIds }
                );
                const reloadDataSourceFunc = window.ManifestDataMain?._loadDataSource;
                if (reloadDataSourceFunc) {
                    await reloadDataSourceFunc(tableName);
                }
            }

            // Dispatch event synchronously after store update completes
            // Use requestAnimationFrame to ensure DOM is ready but execute immediately
            requestAnimationFrame(() => {
                window.dispatchEvent(new CustomEvent('manifest:project-files-updated', {
                    detail: {
                        projectId: entryId,
                        entryId: entryId,  // Support both formats
                        tableName: tableName,
                        fileIds: fileIds
                    }
                }));
            });
        } catch (updateError) {
            const errorMessage = updateError?.message || String(updateError);
            if (errorMessage.includes('Unknown attribute') || errorMessage.includes(fileIdsColumn)) {
                throw new Error(`[Manifest Data] The "${fileIdsColumn}" column does not exist in the "${tableName}" table. Please add a "${fileIdsColumn}" column (type: string array) to the table in Appwrite.`);
            }
            throw updateError;
        }

    }
}

// Unlink a file from all table entries that reference it (used when deleting files)
// This is a best-effort cleanup - uses already-loaded table data from Alpine store
// Returns array of affected entry IDs grouped by table name: { tableName: [entryId1, entryId2, ...] }
async function unlinkFileFromAllEntries(fileId) {
    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        return {};
    }

    const actualFileId = fileId?.$id || fileId;
    if (!actualFileId) {
        return {};
    }

    // Find all table data sources that might have fileIds arrays
    const tables = Object.entries(manifest.data).filter(([name, config]) =>
        config && typeof config === 'object' && window.ManifestDataConfig.getAppwriteTableId(config)
    );

    // Use already-loaded data from Alpine store instead of querying Appwrite
    // Check if Alpine is available before accessing store
    if (typeof Alpine === 'undefined' || !Alpine.store) {
        return {};
    }
    const store = Alpine.store('data');
    if (!store) {
        return {};
    }

    const affectedEntries = {}; // { tableName: [entryId1, entryId2, ...] }

    // Do all unlinks in parallel for speed
    const unlinkPromises = [];

    for (const [tableName, tableConfig] of tables) {
        try {
            const tableId = window.ManifestDataConfig.getAppwriteTableId(tableConfig);
            const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(tableConfig);

            if (!appwriteConfig) continue;

            // Get already-loaded entries from Alpine store
            const entries = store[tableName];
            if (!Array.isArray(entries) || entries.length === 0) {
                continue;
            }

            // Find entries that have this fileId in their fileIds array
            const entriesToUpdate = entries.filter(entry => {
                const fileIds = entry.fileIds || [];
                return Array.isArray(fileIds) && fileIds.includes(actualFileId);
            });

            if (entriesToUpdate.length > 0) {
                affectedEntries[tableName] = entriesToUpdate.map(e => e.$id);
            }

            // Unlink file from each entry in parallel
            for (const entry of entriesToUpdate) {
                unlinkPromises.push(
                    unlinkFileFromEntry(tableName, entry.$id, actualFileId, 'fileIds')
                        .then(() => {
                        })
                        .catch(error => {
                            console.debug('[Manifest Data] Could not unlink from', tableName, 'entry', entry.$id, ':', error.message);
                        })
                );
            }
        } catch (error) {
            // Silently continue - not all tables may have fileIds
            console.debug('[Manifest Data] Could not process', tableName, ':', error.message);
        }
    }

    // Wait for all unlinks to complete
    await Promise.all(unlinkPromises);

    return affectedEntries;
}

// Unlink a file from a table entry by removing the file ID from the entry's fileIds array
// Generic function - works with any table and any scope
async function unlinkFileFromEntry(tableName, entryId, fileId, fileIdsColumn = 'fileIds') {
    const manifest = await window.ManifestDataConfig.ensureManifest();
    const tableDataSource = manifest?.data?.[tableName];

    if (!tableDataSource || !window.ManifestDataConfig.getAppwriteTableId(tableDataSource)) {
        throw new Error(`[Manifest Data] Table "${tableName}" not found in manifest`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(tableDataSource);
    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(tableDataSource);

    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${tableName}"`);
    }

    // Get the current table entry
    const entry = await window.ManifestDataAppwrite.getTableRow(
        appwriteConfig.databaseId,
        tableId,
        entryId
    );

    if (!entry) {
        throw new Error(`[Manifest Data] Entry "${entryId}" not found in table "${tableName}"`);
    }

    // Get or initialize fileIds array (using configurable column name)
    let fileIds = entry[fileIdsColumn] || [];
    if (!Array.isArray(fileIds)) {
        fileIds = [];
    }

    // Remove file ID if present
    const index = fileIds.indexOf(fileId);
    if (index !== -1) {
        fileIds.splice(index, 1);

        // Use optimistic update via mutation system
        const updateEntryInStore = window.ManifestDataMutations?.updateEntryInStore;

        if (updateEntryInStore) {
            // Optimistic update: immediately update store
            updateEntryInStore(tableName, entryId, { [fileIdsColumn]: fileIds });

            // Background sync: update server
            try {
                await window.ManifestDataAppwrite.updateRow(
                    appwriteConfig.databaseId,
                    tableId,
                    entryId,
                    { [fileIdsColumn]: fileIds }
                );
            } catch (updateError) {
                // Rollback on error
                const store = Alpine.store('data');
                if (store && store[tableName] && Array.isArray(store[tableName])) {
                    const originalEntry = store[tableName].find(e => e.$id === entryId);
                    if (originalEntry) {
                        const originalFileIds = originalEntry[fileIdsColumn] || [];
                        // Restore original fileIds (add back the fileId we removed)
                        if (!originalFileIds.includes(fileId)) {
                            originalFileIds.push(fileId);
                        }
                        updateEntryInStore(tableName, entryId, { [fileIdsColumn]: originalFileIds });
                    }
                }
                throw updateError;
            }
        } else {
            // Fallback to old behavior
            await window.ManifestDataAppwrite.updateRow(
                appwriteConfig.databaseId,
                tableId,
                entryId,
                { [fileIdsColumn]: fileIds }
            );
            const reloadDataSourceFunc = window.ManifestDataMain?._loadDataSource;
            if (reloadDataSourceFunc) {
                await reloadDataSourceFunc(tableName);
            }
        }

        // Dispatch event synchronously after store update completes
        // Use requestAnimationFrame to ensure DOM is ready but execute immediately
        requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('manifest:project-files-updated', {
                detail: {
                    projectId: entryId,
                    entryId: entryId,  // Support both formats
                    tableName: tableName,
                    fileIds: fileIds
                }
            }));
        });
    }
}

// Build storage permissions based on scope
// Returns array of permission strings for Appwrite Storage
// Supports:
// - scope: "user" | "team" | "teams" | ["user", "team"]
// - dataSource.belongsTo: Reference to a table entry (e.g., { table: "projects", id: "$projectId" })
async function buildStoragePermissions(scope, dataSource = {}) {
    const permissions = [];

    // Get auth store
    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
    if (!authStore) {
        // No auth store, return empty array (bucket-level permissions will apply)
        return [];
    }

    // Wait for auth store initialization
    if (!authStore._initialized || authStore.isAuthenticated === undefined) {
        let attempts = 0;
        const maxAttempts = 10;
        while (attempts < maxAttempts && (!authStore._initialized || authStore.isAuthenticated === undefined)) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
    }

    const isAuthenticated = authStore.isAuthenticated === true;
    if (!isAuthenticated) {
        // Not authenticated, return empty array
        return [];
    }

    // Get Appwrite Permission and Role helpers
    const Permission = window.Appwrite?.Permission;
    const Role = window.Appwrite?.Role;

    if (!Permission || !Role) {
        console.warn('[Manifest Data] Appwrite Permission/Role not available, cannot set scope-based permissions');
        return [];
    }

    // Check if file belongs to a database entry (e.g., a project)
    // This allows files to inherit permissions from a table entry
    if (dataSource.belongsTo) {
        const { table, id } = dataSource.belongsTo;
        if (table && id) {
            // Get the table entry to determine ownership
            try {
                const manifest = await window.ManifestDataConfig.ensureManifest();
                const tableDataSource = manifest?.data?.[table];
                if (tableDataSource && window.ManifestDataConfig.getAppwriteTableId(tableDataSource)) {
                    // Load the table entry to get userId/teamId
                    const tableId = window.ManifestDataConfig.getAppwriteTableId(tableDataSource);
                    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(tableDataSource);
                    if (appwriteConfig) {
                        const entry = await window.ManifestDataAppwrite.getTableRow(
                            appwriteConfig.databaseId,
                            tableId,
                            id
                        );

                        // Use the entry's userId/teamId for permissions
                        if (entry) {
                            if (entry.userId) {
                                permissions.push(Permission.read(Role.user(entry.userId)));
                                permissions.push(Permission.write(Role.user(entry.userId)));
                                permissions.push(Permission.delete(Role.user(entry.userId)));
                            }
                            if (entry.teamId) {
                                permissions.push(Permission.read(Role.team(entry.teamId)));
                                permissions.push(Permission.write(Role.team(entry.teamId)));
                                permissions.push(Permission.delete(Role.team(entry.teamId)));
                            }
                            return permissions;
                        }
                    }
                }
            } catch (error) {
                console.warn('[Manifest Data] Failed to load table entry for file permissions:', error);
                // Fall through to scope-based permissions
            }
        }
    }

    const scopeArray = Array.isArray(scope) ? scope : [scope];
    const hasUserScope = scopeArray.includes('user');
    const hasTeamScope = scopeArray.includes('team');
    const hasTeamsScope = scopeArray.includes('teams');

    // Handle user scope
    if (hasUserScope) {
        const user = authStore.user;
        const userId = user?.$id || user?.id;
        if (userId) {
            // Grant read and write permissions to the user
            const userRead = Permission.read(Role.user(userId));
            const userWrite = Permission.write(Role.user(userId));
            const userDelete = Permission.delete(Role.user(userId));
            permissions.push(userRead);
            permissions.push(userWrite);
            permissions.push(userDelete);
        }
    }

    // Handle team scope (single team)
    if (hasTeamScope) {
        const currentTeam = authStore.currentTeam;
        const teamId = currentTeam?.$id || currentTeam?.id;
        if (teamId) {
            // Grant read and write permissions to the team
            const teamRead = Permission.read(Role.team(teamId));
            const teamWrite = Permission.write(Role.team(teamId));
            const teamDelete = Permission.delete(Role.team(teamId));
            permissions.push(teamRead);
            permissions.push(teamWrite);
            permissions.push(teamDelete);
        } else {
            console.warn('[Manifest Data] Team scope specified but no currentTeam found in auth store');
        }
    }

    // Handle teams scope (all teams user belongs to)
    if (hasTeamsScope) {
        const teams = authStore.teams || [];
        teams.forEach(team => {
            const teamId = team.$id || team.id;
            if (teamId) {
                const teamRead = Permission.read(Role.team(teamId));
                const teamWrite = Permission.write(Role.team(teamId));
                const teamDelete = Permission.delete(Role.team(teamId));
                permissions.push(teamRead);
                permissions.push(teamWrite);
                permissions.push(teamDelete);
            }
        });
    }

    return permissions;
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesFiles) {
    window.ManifestDataProxiesFiles = {};
}
window.ManifestDataProxiesFiles.createReactiveFileArrayFromGetter = createReactiveFileArrayFromGetter;
window.ManifestDataProxiesFiles.createReactiveFileManager = createReactiveFileManager; // Legacy - will be removed
window.ManifestDataProxiesFiles.createComputedFilesArray = createComputedFilesArray; // New single-source-of-truth approach
window.ManifestDataProxiesFiles.parseStorageConfig = parseStorageConfig;
window.ManifestDataProxiesFiles.getTableStorageConfig = getTableStorageConfig;
window.ManifestDataProxiesFiles.getDefaultBucketForTable = getDefaultBucketForTable;
window.ManifestDataProxiesFiles.getFilesForEntry = getFilesForEntry;
window.ManifestDataProxiesFiles.linkFileToEntry = linkFileToEntry;
window.ManifestDataProxiesFiles.unlinkFileFromEntry = unlinkFileFromEntry;
window.ManifestDataProxiesFiles.unlinkFileFromAllEntries = unlinkFileFromAllEntries;
window.ManifestDataProxiesFiles.buildStoragePermissions = buildStoragePermissions;
window.ManifestDataProxiesFiles.reactiveFileManagers = reactiveFileManagers; // Legacy - will be removed

/* Manifest Data Sources - Route & Proxy Coordinator */
// This file coordinates the proxy creation modules and re-exports their functions
// The actual implementations are in:
// - proxies/creation/manifest.data.proxies.helpers.js (helper functions)
// - proxies/creation/manifest.data.proxies.array.js (array proxy creation)
// - proxies/creation/manifest.data.proxies.object.js (object proxy creation)
// - proxies/creation/manifest.data.proxies.route.js (route proxy creation)

// Re-export functions from proxy creation modules for backward compatibility
// These modules export to window.ManifestDataProxies, so we just ensure the namespace exists
if (typeof window !== 'undefined') {
    if (!window.ManifestDataProxies) {
        window.ManifestDataProxies = {};
    }
    
    // Functions are already exported by the individual modules:
    // - createArrayProxyWithRoute (from array.js)
    // - createRouteProxy (from route.js)
    // - createNestedObjectProxy (from object.js)
    // - clearRouteProxyCacheForDataSource (from route.js)
    // - clearArrayProxyCacheForDataSource (from array.js)
    // - attachArrayMethods (from array.js)
    
    // This file serves as a coordinator and ensures all modules are loaded
    // The build system includes these files in the correct order before this file
}


/* Manifest Data Sources - Appwrite Methods Handler */
// Create Appwrite methods handler for tables and buckets
function createAppwriteMethodsHandler(dataSourceName, reloadDataSource) {
    // Helper to set error state automatically
    const setErrorState = (error) => {
        const store = Alpine.store('data');
        if (store) {
            const stateKey = `_${dataSourceName}_state`;
            const currentState = store[stateKey] || { loading: false, error: null, ready: false };
            const updatedStore = {
                ...store,
                [stateKey]: {
                    ...currentState,
                    error: error?.message || error || 'Operation failed',
                    errorTime: Date.now()
                }
            };
            Alpine.store('data', updatedStore);
        }
        // For test purposes, also log to console
        console.error(`[Manifest Data] ${dataSourceName} operation failed:`, error);
    };

    // Helper to clear error state
    const clearErrorState = () => {
        const store = Alpine.store('data');
        if (store) {
            const stateKey = `_${dataSourceName}_state`;
            const currentState = store[stateKey];
            if (currentState?.error) {
                const updatedStore = {
                    ...store,
                    [stateKey]: {
                        ...currentState,
                        error: null,
                        errorTime: null
                    }
                };
                Alpine.store('data', updatedStore);
            }
        }
    };

    // Core method handler logic (extracted for recursive calls)
    const handleMethod = async function (method, ...args) {
        // Clear error state before operation
        clearErrorState();

        try {
            // Get manifest to check if this is an Appwrite data source
            const manifest = await window.ManifestDataConfig?.ensureManifest?.();
            if (!manifest?.data) {
                throw new Error('[Manifest Data] Manifest not available');
            }

            const dataSource = manifest.data[dataSourceName];
            if (!dataSource || !window.ManifestDataConfig?.isAppwriteCollection?.(dataSource)) {
                throw new Error(`[Manifest Data] "${dataSourceName}" is not an Appwrite data source`);
            }

            const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
            if (!appwriteConfig) {
                throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
            }

            const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
            const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);
            const scope = window.ManifestDataConfig.getScope(dataSource);

            // Handle table operations (TablesDB)
            if (tableId) {
                if (method === '$create') {
                    const [data, rowId] = args;

                    // Auto-inject userId and/or teamId based on scope and config
                    const autoInject = window.ManifestDataConfig.getAutoInjectConfig(dataSource);
                    let enrichedData = { ...data };
                    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;

                    // Determine which scopes are active (support array for dual scope)
                    const scopeArray = Array.isArray(scope) ? scope : [scope];
                    const hasUserScope = scopeArray.includes('user');
                    const hasTeamScope = scopeArray.includes('team') || scopeArray.includes('teams');

                    // Inject userId if user scope is active and enabled
                    if (autoInject.userId && hasUserScope && authStore?.isAuthenticated && authStore?.user) {
                        const userId = authStore?.user?.$id || authStore?.user?.id || authStore?.userId;
                        if (userId && !enrichedData.userId) {
                            enrichedData.userId = userId;
                        }
                    }

                    // Inject teamId if team scope is active and enabled
                    if (autoInject.teamId && hasTeamScope) {
                        const teamId = authStore?.currentTeam?.$id || authStore?.currentTeam?.id;
                        if (teamId && !enrichedData.teamId) {
                            enrichedData.teamId = teamId;
                        }
                    }

                    // Use unified mutation system with optimistic updates
                    const executeMutation = window.ManifestDataMutations?.executeMutation;
                    if (executeMutation) {
                        return await executeMutation({
                            type: 'create',
                            dataSourceName,
                            data: enrichedData,
                            apiCall: async () => {
                                return await window.ManifestDataAppwrite.createRow(
                                    appwriteConfig.databaseId,
                                    tableId,
                                    enrichedData,
                                    rowId
                                );
                            },
                            options: {
                                scope,
                                tableId,
                                appwriteConfig
                            }
                        });
                    } else {
                        // Fallback to old behavior if mutation system not available
                        const result = await window.ManifestDataAppwrite.createRow(
                            appwriteConfig.databaseId,
                            tableId,
                            enrichedData,
                            rowId
                        );
                        // Reload data source
                        await reloadDataSource(dataSourceName);
                        return result;
                    }
                } else if (method === '$update') {
                    const [idOrArray, data] = args;
                    const executeMutation = window.ManifestDataMutations?.executeMutation;

                    // Support batch updates
                    if (Array.isArray(idOrArray)) {
                        const updates = idOrArray;
                        if (executeMutation) {
                            // Use optimistic updates for batch
                            const results = await Promise.all(
                                updates.map(update => {
                                    const entryId = update.id || update.$id || update.rowId;
                                    const updateData = update.data || update;
                                    return executeMutation({
                                        type: 'update',
                                        dataSourceName,
                                        entryId,
                                        data: updateData,
                                        apiCall: async () => {
                                            return await window.ManifestDataAppwrite.updateRow(
                                                appwriteConfig.databaseId,
                                                tableId,
                                                entryId,
                                                updateData
                                            );
                                        },
                                        options: {
                                            scope,
                                            tableId,
                                            appwriteConfig
                                        }
                                    });
                                })
                            );
                            return results;
                        } else {
                            // Fallback to old behavior
                            const results = await Promise.all(
                                updates.map(update =>
                                    window.ManifestDataAppwrite.updateRow(
                                        appwriteConfig.databaseId,
                                        tableId,
                                        update.id || update.$id || update.rowId,
                                        update.data || update
                                    )
                                )
                            );
                            await reloadDataSource(dataSourceName);
                            return results;
                        }
                    } else {
                        const rowId = idOrArray.$id || idOrArray.id || idOrArray.rowId || idOrArray;
                        if (executeMutation) {
                            return await executeMutation({
                                type: 'update',
                                dataSourceName,
                                entryId: rowId,
                                data,
                                apiCall: async () => {
                                    return await window.ManifestDataAppwrite.updateRow(
                                        appwriteConfig.databaseId,
                                        tableId,
                                        rowId,
                                        data
                                    );
                                },
                                options: {
                                    scope,
                                    tableId,
                                    appwriteConfig
                                }
                            });
                        } else {
                            // Fallback to old behavior
                            const result = await window.ManifestDataAppwrite.updateRow(
                                appwriteConfig.databaseId,
                                tableId,
                                rowId,
                                data
                            );
                            await reloadDataSource(dataSourceName);
                            return result;
                        }
                    }
                } else if (method === '$delete') {
                    const idOrArray = args[0];
                    const executeMutation = window.ManifestDataMutations?.executeMutation;

                    if (Array.isArray(idOrArray)) {
                        if (executeMutation) {
                            // Use optimistic updates for batch delete
                            const results = await Promise.all(
                                idOrArray.map(id => {
                                    const entryId = id.$id || id;
                                    return executeMutation({
                                        type: 'delete',
                                        dataSourceName,
                                        entryId,
                                        apiCall: async () => {
                                            return await window.ManifestDataAppwrite.deleteRow(
                                                appwriteConfig.databaseId,
                                                tableId,
                                                entryId
                                            );
                                        },
                                        options: {
                                            scope,
                                            tableId,
                                            appwriteConfig
                                        }
                                    });
                                })
                            );
                            return results;
                        } else {
                            // Fallback to old behavior
                            const results = await Promise.all(
                                idOrArray.map(id =>
                                    window.ManifestDataAppwrite.deleteRow(
                                        appwriteConfig.databaseId,
                                        tableId,
                                        id.$id || id
                                    )
                                )
                            );
                            await reloadDataSource(dataSourceName);
                            return results;
                        }
                    } else {
                        const rowId = idOrArray.$id || idOrArray.id || idOrArray.rowId || idOrArray;
                        if (executeMutation) {
                            return await executeMutation({
                                type: 'delete',
                                dataSourceName,
                                entryId: rowId,
                                apiCall: async () => {
                                    return await window.ManifestDataAppwrite.deleteRow(
                                        appwriteConfig.databaseId,
                                        tableId,
                                        rowId
                                    );
                                },
                                options: {
                                    scope,
                                    tableId,
                                    appwriteConfig
                                }
                            });
                        } else {
                            // Fallback to old behavior
                            const result = await window.ManifestDataAppwrite.deleteRow(
                                appwriteConfig.databaseId,
                                tableId,
                                rowId
                            );
                            await reloadDataSource(dataSourceName);
                            return result;
                        }
                    }
                } else if (method === '$duplicate') {
                    const [entryId, options = {}] = args;
                    const { files = 'same', newRowId, ...overrides } = options;

                    // Get the original entry
                    const originalEntry = await window.ManifestDataAppwrite.getTableRow(
                        appwriteConfig.databaseId,
                        tableId,
                        entryId
                    );

                    if (!originalEntry) {
                        throw new Error(`[Manifest Data] Entry "${entryId}" not found`);
                    }

                    // Prepare duplicate data - exclude Appwrite system fields
                    const duplicateData = { ...originalEntry };
                    delete duplicateData.$id;
                    delete duplicateData.$createdAt;
                    delete duplicateData.$updatedAt;

                    // Apply overrides
                    Object.assign(duplicateData, overrides);

                    // Handle file references based on files option
                    const storageConfig = dataSource.storage;
                    if (storageConfig) {
                        // Get fileIds column name from storage config
                        const getFileIdsColumn = (storageConfig) => {
                            if (typeof storageConfig === 'string') {
                                return storageConfig; // Column name directly
                            } else if (typeof storageConfig === 'object') {
                                // Object with bucket names as keys
                                const bucketNames = Object.keys(storageConfig);
                                if (bucketNames.length > 0) {
                                    const firstBucket = storageConfig[bucketNames[0]];
                                    return typeof firstBucket === 'string' ? firstBucket : (firstBucket.column || 'fileIds');
                                }
                            }
                            return 'fileIds'; // Default
                        };

                        const fileIdsColumn = getFileIdsColumn(storageConfig);
                        const originalFileIds = duplicateData[fileIdsColumn] || [];

                        if (files === 'duplicate') {
                            // Duplicate files and get new file IDs
                            const getFilesForEntry = window.ManifestDataProxiesFiles?.getFilesForEntry;
                            const linkFileToEntry = window.ManifestDataProxiesFiles?.linkFileToEntry;

                            if (getFilesForEntry && linkFileToEntry && originalFileIds.length > 0) {
                                // Get bucket ID from storage config
                                const getBucketId = (storageConfig) => {
                                    if (typeof storageConfig === 'object') {
                                        const bucketNames = Object.keys(storageConfig);
                                        if (bucketNames.length > 0) {
                                            const bucketName = bucketNames[0];
                                            const bucketDataSource = manifest.data[bucketName];
                                            return window.ManifestDataConfig.getAppwriteBucketId(bucketDataSource);
                                        }
                                    }
                                    return null;
                                };

                                const bucketId = getBucketId(storageConfig);
                                if (bucketId) {
                                    // Get original files
                                    const originalFiles = await getFilesForEntry(dataSourceName, entryId, bucketId, fileIdsColumn);

                                    // Duplicate each file
                                    const newFileIds = [];
                                    for (const file of originalFiles) {
                                        try {
                                            // Download file content
                                            const fileBlob = await window.ManifestDataAppwrite.getFileContentAsBlob(bucketId, file.$id);

                                            // Create new file with same name (or add "copy" suffix)
                                            const newFileName = file.name ? `${file.name.replace(/\.[^/.]+$/, '')} copy${file.name.match(/\.[^/.]+$/)?.[0] || ''}` : `copy_${file.$id}`;

                                            // Duplicate file
                                            const duplicatedFile = await window.ManifestDataAppwrite.createFile(
                                                bucketId,
                                                null, // Auto-generate fileId
                                                fileBlob,
                                                null, // Use bucket permissions
                                                null  // No progress callback
                                            );

                                            newFileIds.push(duplicatedFile.$id);
                                        } catch (error) {
                                            console.warn(`[Manifest Data] Failed to duplicate file "${file.$id}":`, error);
                                            // Continue with other files
                                        }
                                    }

                                    duplicateData[fileIdsColumn] = newFileIds;
                                }
                            } else {
                                // No file helpers available, remove fileIds
                                duplicateData[fileIdsColumn] = [];
                            }
                        } else if (files === 'same') {
                            // Keep same file references
                            duplicateData[fileIdsColumn] = [...originalFileIds];
                        } else if (files === 'none') {
                            // Remove file references
                            duplicateData[fileIdsColumn] = [];
                        }
                    }

                    // Create the duplicate entry using existing $create logic
                    return await handleMethod('$create', duplicateData, newRowId);
                } else if (method === '$query') {
                    const [queries] = args;
                    const appwriteQueries = await window.ManifestDataQueries.buildAppwriteQueries(
                        queries || [],
                        scope
                    );
                    const result = await window.ManifestDataAppwrite.loadTableRows(
                        appwriteConfig.databaseId,
                        tableId,
                        appwriteQueries
                    );
                    // Update store with query results
                    const store = Alpine.store('data');
                    if (store) {
                        // Create a new array reference to ensure Alpine detects the change
                        const newArray = Array.isArray(result) ? [...result] : result;

                        // Use Alpine.store() to replace the entire store, which triggers reactivity
                        const currentStore = Alpine.store('data');
                        const updatedStore = {
                            ...currentStore,
                            [dataSourceName]: newArray
                        };
                        Alpine.store('data', updatedStore);

                        // Attach methods to the new array reference
                        if (Array.isArray(newArray) && window.ManifestDataProxies?.attachArrayMethods) {
                            window.ManifestDataProxies.attachArrayMethods(newArray, dataSourceName, reloadDataSource);
                        }

                        // Clear proxy cache to force fresh read
                        if (window.ManifestDataProxies?.clearAccessCache) {
                            window.ManifestDataProxies.clearAccessCache(dataSourceName);
                        }
                    }
                    return result;
                }
            }

            // Handle storage operations
            if (bucketId) {
                if (method === '$create') {
                    let [fileId, file, permissions, onProgress] = args;

                    // Appwrite requires fileId to be provided - it doesn't auto-generate
                    // If fileId is not provided or is a File object (first arg is file), generate one
                    if (!fileId || fileId instanceof File || fileId instanceof Blob) {
                        // First arg is the file, second might be fileId
                        if (fileId instanceof File || fileId instanceof Blob) {
                            file = fileId;
                            fileId = args[1]; // Check if second arg is fileId
                        }
                        // Generate unique ID if still not provided or invalid
                        // fileId must be <= 36 chars, alphanumeric + period/hyphen/underscore, can't start with special char
                        if (!fileId || typeof fileId !== 'string' || fileId.length > 36 || !/^[a-zA-Z0-9]/.test(fileId)) {
                            // Use Appwrite.ID.unique() to generate a valid fileId
                            if (window.Appwrite && window.Appwrite.ID) {
                                fileId = window.Appwrite.ID.unique();
                            } else {
                                // Fallback: generate simple ID if Appwrite SDK not loaded
                                const fileName = file?.name || 'file';
                                fileId = fileName
                                    .replace(/[^a-zA-Z0-9._-]/g, '_')
                                    .substring(0, 36)
                                    .replace(/^[^a-zA-Z0-9]/, 'a'); // Ensure doesn't start with special char
                                if (fileId.length === 0) fileId = 'file_' + Date.now().toString().slice(-10);
                            }
                        }
                    }

                    // Auto-inject permissions based on scope (if not explicitly provided)
                    let finalPermissions = permissions;
                    if (permissions === undefined || permissions === null) {
                        // Get scope from manifest
                        const manifest = await window.ManifestDataConfig.ensureManifest();
                        const dataSource = manifest?.data?.[dataSourceName];
                        const scope = window.ManifestDataConfig.getScope(dataSource);

                        // Check if entryId is provided - if so, use the entry's team for permissions
                        let entryId = null;
                        let tableName = null;

                        // Check for options object (4th argument)
                        if (args.length > 3 && typeof args[3] === 'object' && args[3] !== null && !(args[3] instanceof File) && !Array.isArray(args[3])) {
                            entryId = args[3].entryId || args[3].projectId;
                            tableName = args[3].table || args[3].projectTable || 'projects';
                        } else if (args.length > 4 && typeof args[4] === 'string') {
                            // Legacy: 5th argument as entryId
                            entryId = args[4];
                            tableName = 'projects';
                        }

                        // Also check manifest for belongsTo configuration
                        if (!entryId && dataSource?.belongsTo) {
                            tableName = dataSource.belongsTo.table;
                            const belongsToId = dataSource.belongsTo.id;
                            if (belongsToId && belongsToId.startsWith('$')) {
                                // Interpolate variable from auth store if possible
                                const authStore = Alpine.store('auth');
                                if (authStore) {
                                    const variablePath = belongsToId.substring(1);
                                    entryId = window.ManifestDataQueries.getAuthValue(variablePath);
                                }
                            } else {
                                entryId = belongsToId;
                            }
                        }

                        // If entryId is provided, build permissions based on the entry's team
                        if (entryId && tableName) {
                            try {
                                // Get the entry to determine its team
                                const tableDataSource = manifest?.data?.[tableName];
                                if (tableDataSource && window.ManifestDataConfig.getAppwriteTableId(tableDataSource)) {
                                    const tableId = window.ManifestDataConfig.getAppwriteTableId(tableDataSource);
                                    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(tableDataSource);

                                    if (appwriteConfig) {
                                        const entry = await window.ManifestDataAppwrite.getTableRow(
                                            appwriteConfig.databaseId,
                                            tableId,
                                            entryId
                                        );

                                        if (entry && entry.teamId) {
                                            // Use the entry's team for permissions instead of current team
                                            const Permission = window.Appwrite?.Permission;
                                            const Role = window.Appwrite?.Role;

                                            if (Permission && Role) {
                                                finalPermissions = [
                                                    Permission.read(Role.team(entry.teamId)),
                                                    Permission.write(Role.team(entry.teamId)),
                                                    Permission.delete(Role.team(entry.teamId))
                                                ];
                                            }
                                        }
                                    }
                                }
                            } catch (error) {
                                console.warn('[Manifest Data] Failed to get entry for file permissions, falling back to scope:', error);
                            }
                        }

                        // If we still don't have permissions, use scope-based permissions or grant creator access
                        if (!finalPermissions || finalPermissions.length === 0) {
                            if (scope) {
                                // Build permissions based on scope
                                const buildStoragePermissions = window.ManifestDataProxiesFiles?.buildStoragePermissions;
                                if (buildStoragePermissions) {
                                    try {
                                        finalPermissions = await buildStoragePermissions(scope, dataSource);
                                        if (finalPermissions.length === 0) {
                                            console.warn('[Manifest Data] buildStoragePermissions returned empty array for scope:', scope);
                                        }
                                    } catch (error) {
                                        console.warn('[Manifest Data] Failed to build storage permissions from scope, falling back to user permissions:', error);
                                        finalPermissions = [];
                                    }
                                } else {
                                    console.warn('[Manifest Data] buildStoragePermissions not available, using empty permissions');
                                    finalPermissions = [];
                                }
                            } else {
                                // No scope defined - ensure creator can access their own file
                                // Even with bucket-level permissions, we should grant explicit user permissions
                                const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
                                if (authStore?.isAuthenticated && authStore?.user) {
                                    const userId = authStore.user.$id || authStore.user.id;
                                    const Permission = window.Appwrite?.Permission;
                                    const Role = window.Appwrite?.Role;

                                    if (userId && Permission && Role) {
                                        // Grant creator read/write/delete permissions on their own file
                                        const readPerm = Permission.read(Role.user(userId));
                                        const writePerm = Permission.write(Role.user(userId));
                                        const deletePerm = Permission.delete(Role.user(userId));
                                        finalPermissions = [readPerm, writePerm, deletePerm];
                                    } else {
                                        // Fallback: use empty array (bucket-level permissions apply)
                                        finalPermissions = [];
                                    }
                                } else {
                                    // Not authenticated, use empty array (bucket-level permissions apply)
                                    console.warn('[Manifest Data] User not authenticated, using bucket-level permissions');
                                    finalPermissions = [];
                                }
                            }
                        }
                    } else {
                        // Permissions explicitly provided, use as-is
                        finalPermissions = Array.isArray(permissions) ? permissions : [permissions];
                    }

                    // Ensure onProgress is undefined (not null) if not provided, as it's a callback
                    const validOnProgress = (onProgress === undefined || onProgress === null) ? undefined : onProgress;

                    // Use optimistic update via mutation system
                    const addEntryToStore = window.ManifestDataMutations?.addEntryToStore;
                    const removeEntryFromStore = window.ManifestDataMutations?.removeEntryFromStore;
                    const manifest = await window.ManifestDataConfig.ensureManifest();
                    const dataSource = manifest?.data?.[dataSourceName];
                    const scope = window.ManifestDataConfig.getScope(dataSource);

                    // Get entryId from options for uploading state tracking
                    let entryIdForUpload = null;
                    if (args.length > 3 && typeof args[3] === 'object' && args[3] !== null && !(args[3] instanceof File) && !Array.isArray(args[3])) {
                        entryIdForUpload = args[3].entryId || args[3].projectId;
                    } else if (args.length > 4 && typeof args[4] === 'string') {
                        entryIdForUpload = args[4];
                    }

                    // Also check manifest for belongsTo configuration
                    if (!entryIdForUpload && dataSource?.belongsTo) {
                        const belongsToId = dataSource.belongsTo.id;
                        if (belongsToId && belongsToId.startsWith('$')) {
                            const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
                            if (authStore) {
                                const variablePath = belongsToId.substring(1);
                                entryIdForUpload = window.ManifestDataQueries?.getAuthValue(variablePath);
                            }
                        } else {
                            entryIdForUpload = belongsToId;
                        }
                    }

                    // Get helper functions for uploading state
                    const { setUploadingFile, clearUploadingFile } = window.ManifestDataStore || {};

                    // Set uploading state if entryId is available
                    if (setUploadingFile && entryIdForUpload) {
                        setUploadingFile(dataSourceName, entryIdForUpload, fileId);
                    }

                    // Create optimistic file object (before API call)
                    let optimisticFile = null;
                    if (addEntryToStore) {
                        optimisticFile = {
                            $id: fileId,
                            name: file?.name || 'Uploading...',
                            sizeOriginal: file?.size || 0,
                            mimeType: file?.type || 'application/octet-stream',
                            $createdAt: new Date().toISOString(),
                            $updatedAt: new Date().toISOString(),
                            _optimistic: true // Mark as optimistic
                        };
                        // Optimistic update: immediately add file to store
                        addEntryToStore(dataSourceName, optimisticFile);
                    }

                    let result;
                    try {
                        result = await window.ManifestDataAppwrite.createFile(
                            bucketId,
                            fileId,
                            file,
                            finalPermissions,
                            validOnProgress
                        );

                        // Clear uploading state on success
                        if (clearUploadingFile && entryIdForUpload) {
                            clearUploadingFile(dataSourceName, entryIdForUpload, fileId);
                        }
                    } catch (error) {
                        // Clear uploading state on error
                        if (clearUploadingFile && entryIdForUpload) {
                            clearUploadingFile(dataSourceName, entryIdForUpload, fileId);
                        }
                        // Rollback optimistic update on error
                        if (optimisticFile && removeEntryFromStore) {
                            removeEntryFromStore(dataSourceName, optimisticFile.$id);
                        }
                        throw error;
                    }

                    // Replace optimistic file with real one from server
                    if (optimisticFile && addEntryToStore && removeEntryFromStore) {
                        // Remove optimistic entry
                        removeEntryFromStore(dataSourceName, optimisticFile.$id);
                        // Add real entry
                        addEntryToStore(dataSourceName, result);
                    } else if (addEntryToStore) {
                        // If no optimistic update was done, add now
                        addEntryToStore(dataSourceName, result);
                    }

                    // If entryId is provided, link the file to a table entry
                    // Supports multiple API styles for flexibility:
                    // 1. $x.assets.$create(file, null, null, { entryId: '...', table: 'projects' })
                    // 2. $x.assets.$create(file, null, null, { entryId: '...', table: 'projects', fileIdsColumn: 'attachments' })
                    // 3. $x.assets.$create(file, null, null, null, 'entryId') // Legacy: 4th arg as entryId
                    let entryId = null;
                    let tableName = null;
                    let fileIdsColumn = 'fileIds'; // Default column name

                    // Check for options object (4th argument)
                    if (args.length > 3 && typeof args[3] === 'object' && args[3] !== null && !(args[3] instanceof File) && !Array.isArray(args[3])) {
                        entryId = args[3].entryId || args[3].projectId; // Support both for backward compatibility
                        tableName = args[3].table || args[3].projectTable || 'projects'; // Support both
                        fileIdsColumn = args[3].fileIdsColumn || 'fileIds'; // Default to 'fileIds' if not specified
                    } else if (args.length > 4 && typeof args[4] === 'string') {
                        // Legacy: 5th argument as entryId (backward compatibility)
                        entryId = args[4];
                        tableName = 'projects'; // Default table name
                    }

                    // Also check manifest for belongsTo configuration
                    if (!entryId && dataSource?.belongsTo) {
                        tableName = dataSource.belongsTo.table;
                        fileIdsColumn = dataSource.belongsTo.fileIdsColumn || 'fileIds';
                        // Interpolate entryId from belongsTo.id (might be a variable like $entryId)
                        const belongsToId = dataSource.belongsTo.id;
                        if (belongsToId && belongsToId.startsWith('$')) {
                            // Try to get from context (would need to be passed, but for now we'll skip)
                            // This would require a context system - deferring for now
                        } else {
                            entryId = belongsToId;
                        }
                    }

                    // Link file to entry if entryId is provided
                    if (entryId && tableName) {
                        try {
                            const linkFileToEntry = window.ManifestDataProxiesFiles?.linkFileToEntry;
                            if (linkFileToEntry) {
                                await linkFileToEntry(tableName, entryId, result.$id, fileIdsColumn);
                            }
                        } catch (linkError) {
                            // Check if error is about missing column
                            const errorMessage = linkError?.message || String(linkError);
                            if (errorMessage.includes('Unknown attribute') || errorMessage.includes('fileIds')) {
                                console.error(`[Manifest Data] Failed to link file: The "${fileIdsColumn}" column does not exist in the "${tableName}" table.`, {
                                    error: errorMessage
                                });
                            } else {
                                console.warn('[Manifest Data] Failed to link file to entry:', linkError);
                            }
                            // Don't fail the upload if linking fails
                        }
                    }

                    // For storage buckets, we already have the real file from API response
                    // No need for background reload - the optimistic update was already replaced with real file
                    // Background reload would only be needed if we need to apply scope filtering,
                    // but since we have the real file object, we can trust it's correct
                    // If scope filtering is needed, it will be handled by realtime events
                    if (!addEntryToStore) {
                        // Fallback to old behavior
                        if (window.ManifestDataStore?.dataSourceCache) {
                            const cacheKey = `${dataSourceName}:en`;
                            window.ManifestDataStore.dataSourceCache.delete(cacheKey);
                        }
                        clearAccessCache(dataSourceName);
                        const reloadedData = await reloadDataSource(dataSourceName);
                        if (reloadedData && Array.isArray(reloadedData) && typeof Alpine !== 'undefined' && Alpine.store) {
                            const store = Alpine.store('data');
                            const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                            const newArray = createReactiveReferences
                                ? createReactiveReferences(reloadedData, dataSourceName)
                                : reloadedData.map(entry => ({ ...entry }));
                            Alpine.store('data', {
                                ...store,
                                [dataSourceName]: newArray
                            });
                            if (window.ManifestDataProxies?.attachArrayMethods) {
                                window.ManifestDataProxies.attachArrayMethods(newArray, dataSourceName, reloadDataSource);
                            }
                            if (window.ManifestDataProxies?.clearAccessCache) {
                                window.ManifestDataProxies.clearAccessCache(dataSourceName);
                            }
                            if (window.ManifestDataProxies?.clearArrayProxyCacheForDataSource) {
                                window.ManifestDataProxies.clearArrayProxyCacheForDataSource(dataSourceName);
                            }
                        }
                    }

                    return result;
                } else if (method === '$delete') {
                    const fileId = args[0];
                    const actualFileId = fileId?.$id || fileId;

                    // Before deleting, unlink file from any table entries that reference it
                    // This prevents orphaned references (best-effort cleanup)
                    try {
                        const unlinkFileFromAllEntries = window.ManifestDataProxiesFiles?.unlinkFileFromAllEntries;
                        if (unlinkFileFromAllEntries) {
                            await unlinkFileFromAllEntries(actualFileId);
                        }
                    } catch (unlinkError) {
                        console.warn('[Manifest Data] Failed to unlink file from entries before delete:', unlinkError);
                        // Continue with delete even if unlink fails
                    }

                    const executeMutation = window.ManifestDataMutations?.executeMutation;
                    const removeEntryFromStore = window.ManifestDataMutations?.removeEntryFromStore;

                    if (Array.isArray(fileId)) {
                        if (executeMutation) {
                            // Use optimistic updates for batch delete
                            const results = await Promise.all(
                                fileId.map(id => {
                                    const entryId = id.$id || id;
                                    return executeMutation({
                                        type: 'delete',
                                        dataSourceName,
                                        entryId,
                                        apiCall: async () => {
                                            return await window.ManifestDataAppwrite.deleteFile(bucketId, entryId);
                                        },
                                        options: {
                                            scope,
                                            bucketId,
                                            appwriteConfig
                                        }
                                    });
                                })
                            );

                            // SINGLE SOURCE OF TRUTH: No reload needed - optimistic delete provides immediate feedback
                            // and realtime events will sync everything automatically. Reloading causes race conditions
                            // where stale data overwrites optimistic deletes, causing files to reappear.
                            return results;
                        } else {
                            // Fallback to old behavior
                            const results = await Promise.all(
                                fileId.map(id =>
                                    window.ManifestDataAppwrite.deleteFile(bucketId, id.$id || id)
                                )
                            );
                            // Note: No reload - rely on realtime events for sync
                            return results;
                        }
                    } else {
                        if (executeMutation) {
                            const result = await executeMutation({
                                type: 'delete',
                                dataSourceName,
                                entryId: actualFileId,
                                apiCall: async () => {
                                    return await window.ManifestDataAppwrite.deleteFile(bucketId, actualFileId);
                                },
                                options: {
                                    scope,
                                    bucketId,
                                    appwriteConfig
                                }
                            });

                            // SINGLE SOURCE OF TRUTH: No reload needed - optimistic delete provides immediate feedback
                            // and realtime events will sync everything automatically. Reloading causes race conditions
                            // where stale data overwrites optimistic deletes, causing files to reappear.
                            return result;
                        } else {
                            // Fallback to old behavior
                            const result = await window.ManifestDataAppwrite.deleteFile(bucketId, actualFileId);
                            // Note: No reload - rely on realtime events for sync
                            return result;
                        }
                    }
                } else if (method === '$duplicate') {
                    const [fileId, options = {}] = args;
                    const { newFileId, newName, ...overrides } = options;
                    const actualFileId = fileId?.$id || fileId;

                    if (!actualFileId) {
                        throw new Error('[Manifest Data] File ID is required for $duplicate');
                    }

                    // Get the original file metadata using getFile (more reliable than listFiles)
                    // This verifies the file exists and we have access to it
                    const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
                    if (!services?.storage) {
                        throw new Error('[Manifest Data] Appwrite Storage service not available');
                    }

                    let originalFile;
                    try {
                        originalFile = await services.storage.getFile({
                            bucketId: bucketId,
                            fileId: actualFileId
                        });
                    } catch (error) {
                        throw new Error(`[Manifest Data] File "${actualFileId}" not found or not accessible: ${error.message}`);
                    }

                    // Get view URL using Appwrite SDK (returns authenticated URL)
                    // Using 'view' instead of 'download' since we're re-uploading, not downloading to device
                    let viewUrl = await window.ManifestDataAppwrite.getFileURL(bucketId, actualFileId);

                    // Temporarily append ?mode=admin for localhost testing (cross-domain issues)
                    // Remove this in production - it should work without it
                    const urlObj = new URL(viewUrl);
                    urlObj.searchParams.set('mode', 'admin');
                    viewUrl = urlObj.toString();

                    // Fetch file content using the view URL with credentials
                    // The URL from getFileURL is already authenticated, just need to include cookies
                    const response = await fetch(viewUrl, {
                        method: 'GET',
                        credentials: 'include' // Include cookies for authentication
                    });

                    if (!response.ok) {
                        throw new Error(`Failed to fetch file content: ${response.status} ${response.statusText}`);
                    }

                    const fileBlob = await response.blob();

                    // Determine new file name
                    let finalFileName = newName;
                    if (!finalFileName) {
                        const originalName = originalFile.name || '';
                        if (originalName) {
                            const ext = originalName.match(/\.[^/.]+$/)?.[0] || '';
                            const baseName = originalName.replace(/\.[^/.]+$/, '');
                            finalFileName = `${baseName} copy${ext}`;
                        } else {
                            finalFileName = `copy_${actualFileId}`;
                        }
                    }

                    // Create File object from Blob with name
                    const fileObj = new File([fileBlob], finalFileName, {
                        type: fileBlob.type || originalFile.mimeType || 'application/octet-stream'
                    });

                    // Create duplicate file using existing $create logic
                    // $create signature: (fileId, file, permissions, onProgress) where fileId can be null
                    // We need to pass fileId as first arg (or null to auto-generate), file as second
                    return await handleMethod('$create', newFileId || null, fileObj);
                } else if (method === '$url') {
                    const [fileId, token] = args;
                    // Extract file ID - handle both object with $id property and string ID
                    const extractedFileId = (fileId && typeof fileId === 'object' && fileId.$id)
                        ? fileId.$id
                        : (typeof fileId === 'string' ? fileId : String(fileId));
                    if (!extractedFileId) {
                        throw new Error('[Manifest Data] File ID is required for $url');
                    }
                    if (!bucketId) {
                        throw new Error(`[Manifest Data] Bucket ID not found for data source "${dataSourceName}"`);
                    }
                    const url = await window.ManifestDataAppwrite.getFileURL(
                        bucketId,
                        extractedFileId,
                        token
                    );
                    return url;
                } else if (method === '$download') {
                    const [fileId, token] = args;
                    // Extract file ID - handle both object with $id property and string ID
                    const extractedFileId = (fileId && typeof fileId === 'object' && fileId.$id)
                        ? fileId.$id
                        : (typeof fileId === 'string' ? fileId : String(fileId));
                    if (!extractedFileId) {
                        throw new Error('[Manifest Data] File ID is required for $download');
                    }
                    if (!bucketId) {
                        throw new Error(`[Manifest Data] Bucket ID not found for data source "${dataSourceName}"`);
                    }
                    const url = await window.ManifestDataAppwrite.getFileDownload(
                        bucketId,
                        extractedFileId,
                        token
                    );
                    return url;
                } else if (method === '$filesFor') {
                    // Get files for a specific table entry (generic - works with any table)
                    // Usage: $x.assets.$filesFor('projects', projectId)
                    // Usage: $x.assets.$filesFor('projects', projectId, 'attachments') // Custom column name
                    const [tableName, entryId, fileIdsColumn] = args;
                    if (!tableName || !entryId) {
                        throw new Error('[Manifest Data] $filesFor requires table name and entry ID');
                    }
                    const getFilesForEntry = window.ManifestDataProxiesFiles?.getFilesForEntry;
                    if (!getFilesForEntry) {
                        throw new Error('[Manifest Data] File management functions not available');
                    }
                    return await getFilesForEntry(tableName, entryId, bucketId, fileIdsColumn || 'fileIds');
                } else if (method === '$preview') {
                    const [fileId, widthOrOptions, height] = args;
                    // Extract file ID - handle both object with $id property and string ID
                    const extractedFileId = (fileId && typeof fileId === 'object' && fileId.$id)
                        ? fileId.$id
                        : (typeof fileId === 'string' ? fileId : String(fileId));
                    if (!extractedFileId) {
                        throw new Error('[Manifest Data] File ID is required for $preview');
                    }
                    if (!bucketId) {
                        throw new Error(`[Manifest Data] Bucket ID not found for data source "${dataSourceName}"`);
                    }
                    // Follow Appwrite API docs exactly - pass options as documented
                    const url = await window.ManifestDataAppwrite.getFilePreview(
                        bucketId,
                        extractedFileId,
                        widthOrOptions,
                        height
                    );
                    return url;
                } else if (method === '$openUrl') {
                    // Convenience method: Get URL from SDK and open directly
                    // Uses SDK's authenticated URL - browser sends cookies automatically (like <img> tags)
                    const [fileId, token] = args;
                    try {
                        // Get URL from SDK (same method that works for thumbnails)
                        let url = await handleMethod('$url', fileId, token);
                        if (!url) {
                            throw new Error('[Manifest Data] No URL returned from $url');
                        }
                        // Append mode=admin for testing (bypasses permission checks)
                        url = url + (url.includes('?') ? '&' : '?') + 'mode=admin';
                        // Open URL directly - browser sends cookies automatically (like <img> tags)
                        window.open(url, '_blank', 'noopener,noreferrer');
                        return url;
                    } catch (error) {
                        console.error('[Manifest Data] $openUrl failed:', {
                            fileId,
                            token,
                            error: error?.message || error,
                            code: error?.code,
                            type: error?.type
                        });
                        throw error;
                    }
                } else if (method === '$openPreview') {
                    // Convenience method: Get preview URL from SDK and open directly
                    // Uses SDK's authenticated URL - browser sends cookies automatically (like <img> tags)
                    const [fileId, widthOrOptions, height] = args;
                    try {
                        const options = typeof widthOrOptions === 'object' ? widthOrOptions : { width: widthOrOptions || 800, height: height || 800 };
                        // Get preview URL from SDK (same method that works for thumbnails)
                        let url = await handleMethod('$preview', fileId, options);
                        if (!url) {
                            throw new Error('[Manifest Data] No URL returned from $preview');
                        }
                        // Append mode=admin for testing (bypasses permission checks)
                        url = url + (url.includes('?') ? '&' : '?') + 'mode=admin';
                        // Open URL directly - browser sends cookies automatically (like <img> tags)
                        window.open(url, '_blank', 'noopener,noreferrer');
                        return url;
                    } catch (error) {
                        console.error('[Manifest Data] $openPreview failed:', {
                            fileId,
                            widthOrOptions,
                            height,
                            error: error?.message || error,
                            code: error?.code,
                            type: error?.type
                        });
                        throw error;
                    }
                } else if (method === '$openDownload') {
                    // Convenience method: Get download URL from SDK and trigger download
                    // Uses SDK's authenticated URL - browser sends cookies automatically (like <img> tags)
                    const [fileId, fileName, token] = args;
                    try {
                        // Get download URL from SDK (same method that works for thumbnails)
                        let url = await handleMethod('$download', fileId, token);
                        if (!url) {
                            throw new Error('[Manifest Data] No URL returned from $download');
                        }
                        // Append mode=admin for testing (bypasses permission checks)
                        url = url + (url.includes('?') ? '&' : '?') + 'mode=admin';
                        // Create link element pointing to SDK URL - browser sends cookies automatically
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = fileName || 'download';
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        document.body.appendChild(link);
                        link.click();
                        // Remove link after a short delay
                        setTimeout(() => document.body.removeChild(link), 100);
                        return url;
                    } catch (error) {
                        console.error('[Manifest Data] $openDownload failed:', {
                            fileId,
                            fileName,
                            token,
                            error: error?.message || error,
                            code: error?.code,
                            type: error?.type
                        });
                        throw error;
                    }
                } else if (method === '$unlinkFrom') {
                    const [tableName, entryId, fileId, fileIdsColumn] = args;
                    if (!tableName || !entryId || !fileId) {
                        throw new Error('[Manifest Data] $unlinkFrom requires table name, entry ID, and file ID');
                    }
                    const unlinkFileFromEntry = window.ManifestDataProxiesFiles?.unlinkFileFromEntry;
                    if (!unlinkFileFromEntry) {
                        throw new Error('[Manifest Data] File management functions not available');
                    }
                    return await unlinkFileFromEntry(tableName, entryId, fileId.$id || fileId, fileIdsColumn || 'fileIds');
                } else if (method === '$removeFrom') {
                    // Convenience method: unlink file from entry with automatic refresh
                    // Usage: $x.assets.$removeFrom('projects', projectId, fileId)
                    // Automatically refreshes and returns the files list for that table/entry
                    const [tableName, entryId, fileId, fileIdsColumn] = args;
                    if (!tableName || !entryId || !fileId) {
                        throw new Error('[Manifest Data] $removeFrom requires table name, entry ID, and file ID');
                    }

                    const unlinkFileFromEntry = window.ManifestDataProxiesFiles?.unlinkFileFromEntry;
                    if (unlinkFileFromEntry) {
                        await unlinkFileFromEntry(tableName, entryId, fileId.$id || fileId, fileIdsColumn || 'fileIds');
                    }

                    // Auto-refresh: automatically refresh and return files list for this table/entry
                    // This matches the pattern of $x.projects.$delete() which auto-reloads
                    const getFilesForEntry = window.ManifestDataProxiesFiles?.getFilesForEntry;
                    if (getFilesForEntry) {
                        return await getFilesForEntry(tableName, entryId, bucketId, fileIdsColumn || 'fileIds');
                    }
                    return null;
                } else if (method === '$remove') {
                    // Convenience method: delete file with automatic bucket reload and entry unlinking
                    // Usage: $x.assets.$remove(fileId)
                    // Automatically reloads the entire assets bucket and unlinks from table entries
                    // This is an alias for $delete with the same auto-reload functionality
                    const fileId = args[0];
                    if (!fileId) {
                        throw new Error('[Manifest Data] $remove requires file ID');
                    }

                    const actualFileId = fileId.$id || fileId;

                    // Before deleting, unlink file from any table entries that reference it
                    // This prevents orphaned references and ensures UI updates correctly
                    let affectedEntries = {};
                    try {
                        affectedEntries = await unlinkFileFromAllEntries(actualFileId) || {};
                    } catch (unlinkError) {
                        console.warn('[Manifest Data] Failed to unlink file from entries before delete:', unlinkError);
                        // Continue with delete even if unlink fails
                    }

                    // Delete file(s) and reload in parallel for speed
                    const deletePromise = Array.isArray(fileId)
                        ? Promise.all(fileId.map(id => window.ManifestDataAppwrite.deleteFile(bucketId, id.$id || id)))
                        : window.ManifestDataAppwrite.deleteFile(bucketId, actualFileId);

                    const reloadPromise = window.ManifestDataAppwrite.listBucketFiles(bucketId, []);

                    // Do delete and reload in parallel
                    const [result, reloadedData] = await Promise.all([deletePromise, reloadPromise]);

                    // Update store
                    const store = Alpine.store('data');
                    if (store && reloadedData) {
                        const newArray = Array.isArray(reloadedData) ? [...reloadedData] : reloadedData;
                        const currentStore = Alpine.store('data');
                        const updatedStore = {
                            ...currentStore,
                            [dataSourceName]: newArray
                        };
                        Alpine.store('data', updatedStore);
                        // Attach methods to the new array reference
                        if (Array.isArray(newArray) && window.ManifestDataProxies?.attachArrayMethods) {
                            window.ManifestDataProxies.attachArrayMethods(newArray, dataSourceName, reloadDataSource);
                        }
                        if (window.ManifestDataProxies?.clearAccessCache) {
                            window.ManifestDataProxies.clearAccessCache(dataSourceName);
                        }
                        if (window.ManifestDataProxies?.clearArrayProxyCacheForDataSource) {
                            window.ManifestDataProxies.clearArrayProxyCacheForDataSource(dataSourceName);
                        }
                    }

                    // Reload affected table data sources to ensure Alpine reactivity
                    // This ensures project fileIds arrays and counters update in the UI
                    const reloadDataSourceFunc = window.ManifestDataMain?._loadDataSource;
                    if (reloadDataSourceFunc && Object.keys(affectedEntries).length > 0) {
                        const reloadPromises = [];
                        for (const tableName of Object.keys(affectedEntries)) {
                            reloadPromises.push(
                                reloadDataSourceFunc(tableName).then(reloadedData => {
                                    // Ensure we create new object references so Alpine detects nested property changes
                                    if (reloadedData && Array.isArray(reloadedData) && typeof Alpine !== 'undefined' && Alpine.store) {
                                        const store = Alpine.store('data');
                                        const newArray = reloadedData.map(entry => ({ ...entry }));
                                        Alpine.store('data', {
                                            ...store,
                                            [tableName]: newArray
                                        });
                                        // Clear cache for reactivity
                                        if (window.ManifestDataProxies?.clearAccessCache) {
                                            window.ManifestDataProxies.clearAccessCache(tableName);
                                        }
                                        if (window.ManifestDataProxies?.clearArrayProxyCacheForDataSource) {
                                            window.ManifestDataProxies.clearArrayProxyCacheForDataSource(tableName);
                                        }
                                    }
                                }).catch(err => {
                                    console.warn(`[Manifest Data] Failed to reload ${tableName} after file delete:`, err);
                                })
                            );
                        }
                        // Don't await - let it happen in background
                        Promise.all(reloadPromises).catch(() => { });
                    }

                    // Emit event for affected projects to auto-refresh
                    // Always emit the event so UI can handle it optimistically, even if we couldn't find affected entries
                    if (Object.keys(affectedEntries).length > 0) {
                        for (const [tableName, entryIds] of Object.entries(affectedEntries)) {
                            if (Array.isArray(entryIds) && entryIds.length > 0) {
                                window.dispatchEvent(new CustomEvent('manifest:file-deleted', {
                                    detail: {
                                        fileId: actualFileId,
                                        tableName,
                                        entryIds
                                    }
                                }));
                            }
                        }
                    } else {
                        // If we couldn't find affected entries, still emit event with empty entryIds
                        // This allows UI to handle it optimistically by checking if the file is in their local list
                        window.dispatchEvent(new CustomEvent('manifest:file-deleted', {
                            detail: {
                                fileId: actualFileId,
                                tableName: null,
                                entryIds: []
                            }
                        }));
                    }

                    // Also dispatch event for storage bucket reactivity (so $x.assets updates)
                    // The realtime handler will also update, but this ensures immediate UI update
                    window.dispatchEvent(new CustomEvent('manifest:file-deleted', {
                        detail: {
                            fileId: actualFileId,
                            tableName: null,
                            entryIds: [],
                            bucketId: bucketId  // Include bucketId so storage can filter if needed
                        }
                    }));

                    return result;
                }
            }

            throw new Error(`[Manifest Data] Method "${method}" not supported for this data source`);
        } catch (error) {
            // Automatically set error state - no need for inline .catch() in HTML
            setErrorState(error);
            // Re-throw so promise chain still works if caller wants to handle it
            throw error;
        }
    };

    // Return the handler function
    return handleMethod;
}

// Export to window for use by routes proxy
if (!window.ManifestDataProxiesAppwrite) {
    window.ManifestDataProxiesAppwrite = {};
}
window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler = createAppwriteMethodsHandler;



/* Manifest Data Sources - Magic Method State Properties */
// Handles $loading, $error, $ready state properties

/**
 * Get state property value for a data source
 * @param {string} prop - Property name ($loading, $error, $ready)
 * @param {string} dataSourceName - Name of the data source
 * @returns {boolean|string|null} State value
 */
function getStateProperty(prop, dataSourceName) {
    if (typeof Alpine === 'undefined' || !Alpine.store) {
        return prop === '$loading' ? false : (prop === '$error' ? null : false);
    }

    const store = Alpine.store('data');
    if (!store) {
        return prop === '$loading' ? false : (prop === '$error' ? null : false);
    }

    const stateKey = `_${dataSourceName}_state`;
    const state = store[stateKey] || { loading: false, error: null, ready: false };

    if (prop === '$loading') {
        return state.loading !== false; // Default to true if loading
    } else if (prop === '$error') {
        return state.error || null;
    } else if (prop === '$ready') {
        return state.ready || false;
    }

    return undefined;
}

/**
 * Create a state property handler for loading proxies
 * Returns a function that can be used in proxy get handlers
 */
function createStatePropertyHandler(dataSourceName) {
    return function (key) {
        if (key === '$loading' || key === '$error' || key === '$ready') {
            return getStateProperty(key, dataSourceName);
        }
        return undefined;
    };
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesMagic) {
    window.ManifestDataProxiesMagic = {};
}
window.ManifestDataProxiesMagic.getStateProperty = getStateProperty;
window.ManifestDataProxiesMagic.createStatePropertyHandler = createStatePropertyHandler;



/* Manifest Data Sources - Magic Method $files Handler */
// Handles $files method for reactive file arrays

/**
 * Create $files method for a data source
 * @param {string} dataSourceName - Name of the data source (table)
 * @returns {Function} $files method function
 */
function createFilesMethod(dataSourceName) {
    return function (entryIdOrGetter, bucketName, columnName) {
        // Check if first argument is a function (reactive getter)
        if (typeof entryIdOrGetter === 'function') {
            const createReactiveFileArrayFromGetter = window.ManifestDataProxiesFiles?.createReactiveFileArrayFromGetter;
            return createReactiveFileArrayFromGetter
                ? createReactiveFileArrayFromGetter(dataSourceName, entryIdOrGetter, bucketName, columnName)
                : [];
        }

        // Direct value (backward compatible)
        const entryId = entryIdOrGetter;
        const manifest = window.ManifestDataConfig?.getManifest?.();

        if (!manifest?.data) {
            // Return empty array proxy if manifest not ready
            return new Proxy([], {
                get(target, key) {
                    if (key === '$loading') return true;
                    if (key === '$error') return null;
                    if (key === '$reload') return () => { };
                    if (key === Symbol.iterator) return function* () { };
                    if (key in target) {
                        const value = target[key];
                        return typeof value === 'function' ? value.bind(target) : value;
                    }
                    return undefined;
                }
            });
        }

        const tableDataSource = manifest.data[dataSourceName];
        if (!tableDataSource || !window.ManifestDataConfig.getAppwriteTableId(tableDataSource)) {
            throw new Error(`[Manifest Data] "${dataSourceName}" is not an Appwrite table`);
        }

        if (!entryId) {
            // Return empty array proxy if entryId not provided yet
            return new Proxy([], {
                get(target, key) {
                    if (key === '$loading') return false;
                    if (key === '$error') return null;
                    if (key === '$reload') return () => { };
                    if (key === Symbol.iterator) return function* () { };
                    if (key in target) {
                        const value = target[key];
                        return typeof value === 'function' ? value.bind(target) : value;
                    }
                    return undefined;
                }
            });
        }

        // Determine bucket name
        let resolvedBucketName = bucketName;
        if (!resolvedBucketName) {
            const getDefaultBucketForTable = window.ManifestDataProxiesFiles?.getDefaultBucketForTable;
            if (getDefaultBucketForTable) {
                resolvedBucketName = getDefaultBucketForTable(dataSourceName);
            }
            if (!resolvedBucketName) {
                throw new Error(`[Manifest Data] Multiple storage buckets configured for "${dataSourceName}". Please specify bucket name: $x.${dataSourceName}.$files(entryId, 'bucketName')`);
            }
        }

        // Get column name from config or use default
        const parseStorageConfig = window.ManifestDataProxiesFiles?.parseStorageConfig;
        if (!parseStorageConfig) {
            throw new Error('[Manifest Data] File management functions not available');
        }
        const storageConfig = parseStorageConfig(tableDataSource, resolvedBucketName);
        if (!storageConfig) {
            throw new Error(`[Manifest Data] Storage bucket "${resolvedBucketName}" not configured for table "${dataSourceName}"`);
        }

        const resolvedColumnName = columnName || storageConfig.column || 'fileIds';

        // SINGLE SOURCE OF TRUTH: Create computed files array that filters bucket by fileIds
        const createComputedFilesArray = window.ManifestDataProxiesFiles?.createComputedFilesArray;
        if (!createComputedFilesArray) {
            throw new Error('[Manifest Data] File management functions not available');
        }
        const computedFiles = createComputedFilesArray(dataSourceName, entryId, resolvedBucketName, resolvedColumnName);

        // Return computed array (already has $loading and $error properties via proxy)
        return computedFiles;
    };
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesMagic) {
    window.ManifestDataProxiesMagic = {};
}
window.ManifestDataProxiesMagic.createFilesMethod = createFilesMethod;



/* Manifest Data Sources - Magic Method $upload Handler */
// Handles $upload method for uploading files and linking to table entries

/**
 * Create $upload method for a data source
 * @param {string} dataSourceName - Name of the data source (table)
 * @param {Function} reloadDataSource - Function to reload data source
 * @returns {Function} $upload method function
 */
function createUploadMethod(dataSourceName, reloadDataSource) {
    return async function (entryId, fileOrEvent, bucketName) {
        const manifest = await window.ManifestDataConfig.ensureManifest();
        if (!manifest?.data) {
            throw new Error('[Manifest Data] Manifest not available');
        }

        const tableDataSource = manifest.data[dataSourceName];
        if (!tableDataSource || !window.ManifestDataConfig.getAppwriteTableId(tableDataSource)) {
            throw new Error(`[Manifest Data] "${dataSourceName}" is not an Appwrite table`);
        }

        if (!entryId) {
            throw new Error(`[Manifest Data] Entry ID is required for $upload()`);
        }

        // Extract file(s) from event or use file object directly
        let files = [];
        if (fileOrEvent?.target?.files) {
            // Event object - extract files
            files = Array.from(fileOrEvent.target.files);
            // Clear input value after extraction
            if (fileOrEvent.target) {
                fileOrEvent.target.value = '';
            }
        } else if (fileOrEvent instanceof File || fileOrEvent instanceof Blob) {
            // Direct file object
            files = [fileOrEvent];
        } else if (Array.isArray(fileOrEvent)) {
            // Array of files
            files = fileOrEvent.filter(f => f instanceof File || f instanceof Blob);
        } else {
            throw new Error(`[Manifest Data] Invalid file or event object. Expected File, Blob, Event, or array of files.`);
        }

        if (files.length === 0) {
            throw new Error(`[Manifest Data] No files provided for upload`);
        }

        // Determine bucket name
        let resolvedBucketName = bucketName;
        if (!resolvedBucketName) {
            const getDefaultBucketForTable = window.ManifestDataProxiesFiles?.getDefaultBucketForTable;
            if (getDefaultBucketForTable) {
                resolvedBucketName = getDefaultBucketForTable(dataSourceName);
            }
            if (!resolvedBucketName) {
                throw new Error(`[Manifest Data] Multiple storage buckets configured for "${dataSourceName}". Please specify bucket name: $x.${dataSourceName}.$upload(entryId, fileOrEvent, 'bucketName')`);
            }
        }

        // Get storage config
        const storageConfig = window.ManifestDataProxiesFiles?.parseStorageConfig(tableDataSource, resolvedBucketName);
        if (!storageConfig) {
            throw new Error(`[Manifest Data] Storage bucket "${resolvedBucketName}" not configured for table "${dataSourceName}"`);
        }

        const resolvedColumnName = storageConfig.column || 'fileIds';

        // Get bucket data source to access $create method
        const bucketDataSource = manifest.data[resolvedBucketName];
        if (!bucketDataSource || !window.ManifestDataConfig.getAppwriteBucketId(bucketDataSource)) {
            throw new Error(`[Manifest Data] Storage bucket "${resolvedBucketName}" not found in manifest`);
        }

        // Get $x to access bucket methods
        const $x = window.Alpine?.magic?.('x')?.();
        if (!$x || !$x[resolvedBucketName] || typeof $x[resolvedBucketName].$create !== 'function') {
            throw new Error(`[Manifest Data] Bucket "${resolvedBucketName}" is not available`);
        }

        // Get helper functions for uploading state
        const { setUploadingFile, clearUploadingFile } = window.ManifestDataStore || {};

        // Generate temporary file IDs for tracking upload state
        const fileIds = files.map(file => {
            if (window.Appwrite && window.Appwrite.ID) {
                return window.Appwrite.ID.unique();
            }
            return `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        });

        // Set uploading state for all files
        if (setUploadingFile) {
            fileIds.forEach(fileId => {
                setUploadingFile(dataSourceName, entryId, fileId);
            });
        }

        try {
            // Upload files (single or multiple)
            const uploadPromises = files.map((file, index) => {
                const tempFileId = fileIds[index];
                return $x[resolvedBucketName].$create(file, tempFileId, null, {
                    entryId: entryId,
                    table: dataSourceName,
                    fileIdsColumn: resolvedColumnName
                }).then(result => {
                    // Clear uploading state for this file
                    if (clearUploadingFile) {
                        clearUploadingFile(dataSourceName, entryId, tempFileId);
                    }
                    return result;
                }).catch(error => {
                    // Clear uploading state on error
                    if (clearUploadingFile) {
                        clearUploadingFile(dataSourceName, entryId, tempFileId);
                    }
                    throw error;
                });
            });

            const results = await Promise.all(uploadPromises);

            // NOTE: No need to manually update file managers - computed files arrays
            // automatically update when bucket array changes (single source of truth)

            // Return single file or array of files
            return files.length === 1 ? results[0] : results;
        } catch (error) {
            // Clear all uploading states on error
            if (clearUploadingFile) {
                fileIds.forEach(fileId => {
                    clearUploadingFile(dataSourceName, entryId, fileId);
                });
            }
            throw error;
        }
    };
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesMagic) {
    window.ManifestDataProxiesMagic = {};
}
window.ManifestDataProxiesMagic.createUploadMethod = createUploadMethod;



/* Manifest Data Sources - Magic Method Pagination Handlers */
// Handles pagination methods ($first, $next, $prev, $page)

/**
 * Create pagination method handler
 * @param {string} methodName - Method name ($first, $next, $prev, $page)
 * @param {string} dataSourceName - Name of the data source
 * @returns {Function} Pagination method function
 */
function createPaginationMethod(methodName, dataSourceName) {
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
}

// Export functions to window for use by other subscripts
if (!window.ManifestDataProxiesMagic) {
    window.ManifestDataProxiesMagic = {};
}
window.ManifestDataProxiesMagic.createPaginationMethod = createPaginationMethod;



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

/* Manifest Data Sources - Directives */
// Register x-files directive for automatic file management (files linked to table entries)
function registerFilesDirective() {
    if (typeof Alpine === 'undefined') {
        // Wait for Alpine to be available
        const checkAlpine = setInterval(() => {
            if (typeof Alpine !== 'undefined') {
                clearInterval(checkAlpine);
                registerFilesDirective();
            }
        }, 10);
        setTimeout(() => clearInterval(checkAlpine), 5000);
        return;
    }

    // Helper to walk up DOM tree to find parent x-for template
    function findParentXFor(el) {
        let current = el;
        // Walk up the tree, checking each element
        while (current) {
            // Check if current element is a template with x-for
            if (current.tagName === 'TEMPLATE' && current.hasAttribute('x-for')) {
                return current;
            }
            // Also check parent element
            current = current.parentElement;
            if (current && current.tagName === 'TEMPLATE' && current.hasAttribute('x-for')) {
                return current;
            }
        }
        return null;
    }

    // Helper to extract loop item variable name from x-for expression
    function extractLoopItemName(xForExpression) {
        // x-for="item in $x.source" -> "item"
        const match = xForExpression.match(/^(\w+)\s+in\s+/);
        return match ? match[1] : null;
    }

    Alpine.directive('files', (el, { expression, modifiers }, { effect, evaluateLater, cleanup }) => {

        // For string literals (data source names), we need to handle them specially
        // If expression is a plain identifier (no quotes, no dots, no special chars), treat as string
        const isPlainIdentifier = expression && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(expression.trim());

        const evaluate = isPlainIdentifier
            ? (callback) => {
                const value = expression.trim();
                callback(value);
            }
            : evaluateLater(expression); // Evaluate as normal expression

        const evaluateField = el.hasAttribute('x-files-field')
            ? evaluateLater(el.getAttribute('x-files-field'))
            : null;

        let tableName = null;
        let entryId = null;
        let entry = null;
        let fileField = 'fileIds'; // Default field name
        let files = [];
        let loadingFiles = false;
        let filesError = null;
        let lastFileIds = null;
        let unwatch = null;
        let handleFileDeleted = null;
        let isProcessing = false; // Guard to prevent infinite loops
        let waitingForDataSource = null; // Track which data source we're waiting for

        // Initialize reactive state in Alpine scope IMMEDIATELY (before Alpine evaluates expressions)
        // This must happen synchronously, not in an effect, so Alpine can find the variables
        let scope;
        try {
            scope = Alpine.$data(el);
        } catch (e) {
            // Scope might not be ready yet, will initialize in effect
            scope = null;
        }

        if (scope) {
            // Always initialize - don't check for undefined, just set them
            // This ensures they exist when Alpine first evaluates expressions
            if (!('files' in scope)) {
                scope.files = [];
            }
            if (!('loadingFiles' in scope)) {
                scope.loadingFiles = false;
            }
            if (!('filesError' in scope)) {
                scope.filesError = null;
            }
            // Sync local variables with scope
            files = scope.files;
            loadingFiles = scope.loadingFiles;
            filesError = scope.filesError;
        } else {
            // If scope not ready, initialize in effect
            // But we still need to set them on the element's data context
            // Use Alpine's reactive system
            setTimeout(() => {
                try {
                    const delayedScope = Alpine.$data(el);
                    if (delayedScope) {
                        if (!('files' in delayedScope)) {
                            delayedScope.files = [];
                        }
                        if (!('loadingFiles' in delayedScope)) {
                            delayedScope.loadingFiles = false;
                        }
                        if (!('filesError' in delayedScope)) {
                            delayedScope.filesError = null;
                        }
                    }
                } catch (e) {
                    // Ignore
                }
            }, 0);
        }

        // Get $x from Alpine magic methods
        const getX = () => {
            try {
                return Alpine.$data(el).$x;
            } catch {
                return null;
            }
        };

        // Resolve entry from expression value
        const resolveEntry = async (value) => {

            // Pattern 1: Explicit tuple (tableName, entryId)
            if (Array.isArray(value) && value.length === 2) {
                return {
                    tableName: value[0],
                    entryId: value[1]?.$id || value[1],
                    entry: null
                };
            }

            // Pattern 2: Entry object with $id
            if (value && typeof value === 'object' && value.$id) {
                // Try to detect table name from $x data sources
                const $x = getX();
                if ($x) {
                    // Filter out internal Vue/React properties
                    const internalProps = ['__v_isRef', '__v_isReadonly', '__v_isShallow', '__v_raw', '__v_isReactive'];
                    for (const [dsName, dsData] of Object.entries($x)) {
                        // Skip internal properties
                        if (internalProps.includes(dsName) || dsName.startsWith('__')) {
                            continue;
                        }
                        if (Array.isArray(dsData) && dsData.some(item => item.$id === value.$id)) {
                            return {
                                tableName: dsName,
                                entryId: value.$id,
                                entry: value
                            };
                        }
                    }
                }
                // Fallback: assume entry object but need table name
                return {
                    tableName: null,
                    entryId: value.$id,
                    entry: value
                };
            }

            // Pattern 3: Data source name (string) - walk up DOM for loop context
            if (typeof value === 'string') {
                // Filter out internal properties
                const internalProps = ['__v_isRef', '__v_isReadonly', '__v_isShallow', '__v_raw', '__v_isReactive'];
                if (internalProps.includes(value) || value.startsWith('__')) {
                    return null; // Don't treat internal properties as data sources
                }

                const $x = getX();
                const $xKeys = $x ? Object.keys($x).filter(k => !k.startsWith('__')) : [];
                if (!$x || !$x[value]) {
                    // Data source not loaded yet - return null to retry later
                    // The effect will re-run when $x[value] becomes available
                    return null; // Data source doesn't exist yet
                }

                // Try to find parent x-for template
                const parentTemplate = findParentXFor(el);
                if (parentTemplate) {
                    const xForExpr = parentTemplate.getAttribute('x-for');
                    const loopItemName = extractLoopItemName(xForExpr);

                    if (loopItemName) {
                        // Get loop item from current scope (Alpine sets it in the scope of elements inside x-for)
                        const currentScope = Alpine.$data(el);
                        const scopeKeys = currentScope ? Object.keys(currentScope).filter(k => !k.startsWith('__')) : [];
                        if (currentScope && currentScope[loopItemName]) {
                            const loopItem = currentScope[loopItemName];
                            return {
                                tableName: value,
                                entryId: loopItem.$id,
                                entry: loopItem
                            };
                        } else {
                        }
                    }
                }

                // If no loop context found, return null (can't determine entry)
                return null;
            }

            return null;
        };

        const loadFiles = async () => {
            if (!tableName || !entryId) {
                return;
            }

            const $x = getX();
            if (!$x?.assets || typeof $x.assets.$filesFor !== 'function') {
                setTimeout(loadFiles, 100);
                return;
            }

            loadingFiles = true;
            if (scope) scope.loadingFiles = true;

            try {
                const loadedFiles = await $x.assets.$filesFor(tableName, entryId);
                files = loadedFiles;
                if (scope) {
                    scope.files = files;
                    scope.loadingFiles = false;
                    scope.filesError = null;
                }
                loadingFiles = false;
                filesError = null;
            } catch (err) {
                console.error('[x-files] loadFiles: Error loading files:', err);
                filesError = err.message || 'Failed to load files';
                if (scope) {
                    scope.filesError = filesError;
                    scope.loadingFiles = false;
                }
                loadingFiles = false;
            }
        };

        effect(() => {
            // Ensure scope variables are initialized in effect (runs immediately)
            const currentScope = Alpine.$data(el);
            if (currentScope) {
                if (!('files' in currentScope)) {
                    currentScope.files = [];
                }
                if (!('loadingFiles' in currentScope)) {
                    currentScope.loadingFiles = false;
                }
                if (!('filesError' in currentScope)) {
                    currentScope.filesError = null;
                }
                // Update local refs
                files = currentScope.files;
                loadingFiles = currentScope.loadingFiles;
                filesError = currentScope.filesError;
            }

            // Evaluate file field name if specified
            let currentFileField = 'fileIds';
            if (evaluateField) {
                evaluateField(fieldValue => {
                    if (fieldValue && typeof fieldValue === 'string') {
                        currentFileField = fieldValue;
                        fileField = currentFileField;
                    }
                });
            }

            // First, evaluate the expression to get the value
            evaluate((value) => {
                // Guard against infinite loops
                if (isProcessing) {
                    return;
                }


                // For string values (data source names), access $x[value] in effect to make Alpine track it
                if (typeof value === 'string') {
                    const $x = getX();
                    // Access $x[value] here so Alpine tracks it and re-runs effect when it changes
                    // This must be done synchronously in the effect, not in a promise
                    const dataSource = $x?.[value];
                    // Check if it's an array or array-like (proxy might wrap an array)
                    const isArrayLike = dataSource && (
                        Array.isArray(dataSource) ||
                        (typeof dataSource.length === 'number' && dataSource.length >= 0)
                    );
                    const hasData = isArrayLike && dataSource.length > 0;

                    if (!$x || !dataSource || !isArrayLike || !hasData) {
                        // If we're already waiting for this data source, don't log again (prevents spam)
                        if (waitingForDataSource !== value) {
                            waitingForDataSource = value;

                            // Set up a watch that will trigger when data becomes available
                            const scope = Alpine.$data(el);
                            if (scope && $x) {
                                // Watch the length property - when it changes from 0 to > 0, we'll process
                                let unwatchLengthFn = null;
                                try {
                                    unwatchLengthFn = scope.$watch(`$x.${value}.length`, (newLength) => {
                                        if (newLength > 0 && waitingForDataSource === value) {
                                            waitingForDataSource = null;
                                            if (unwatchLengthFn && typeof unwatchLengthFn === 'function') {
                                                unwatchLengthFn();
                                                unwatchLengthFn = null;
                                            }
                                            // The effect will re-run now that we've cleared the flag
                                        }
                                    });
                                } catch (e) {
                                    // $watch might not be available or might fail
                                    console.warn('[x-files] Failed to set up watch:', e);
                                }

                                // Clean up watch on cleanup
                                if (unwatchLengthFn) {
                                    cleanup(() => {
                                        if (unwatchLengthFn && typeof unwatchLengthFn === 'function') {
                                            try {
                                                unwatchLengthFn();
                                            } catch (e) {
                                                // Ignore cleanup errors
                                            }
                                        }
                                    });
                                }
                            }
                        }
                        return; // Wait for data source to load - effect will re-run when $x[value] changes
                    }

                    // Data source is ready - clear waiting flag
                    if (waitingForDataSource === value) {
                        waitingForDataSource = null;
                    }
                }

                // Mark as processing to prevent re-entry
                isProcessing = true;

                // Now resolve the entry (async)
                resolveEntry(value).then((resolved) => {

                    if (!resolved) {
                        // Couldn't resolve entry - might be waiting for data
                        return;
                    }

                    const newTableName = resolved.tableName;
                    const newEntryId = resolved.entryId;
                    const newEntry = resolved.entry;

                    // Check if anything changed
                    if (newTableName === tableName && newEntryId === entryId && currentFileField === fileField) {
                        return; // No change
                    }

                    // Cleanup previous watchers/listeners
                    if (unwatch && typeof unwatch === 'function') {
                        unwatch();
                    }
                    if (handleFileDeleted) {
                        window.removeEventListener('manifest:file-deleted', handleFileDeleted);
                    }

                    tableName = newTableName;
                    entryId = newEntryId;
                    entry = newEntry;
                    fileField = currentFileField;


                    if (!tableName || !entryId) {
                        return;
                    }

                    // Initial load
                    loadFiles();

                    // Get current fileIds from entry or table
                    const $x = getX();
                    if (entry && entry[fileField]) {
                        lastFileIds = JSON.stringify(entry[fileField] || []);
                    } else if ($x && $x[tableName]) {
                        const tableData = $x[tableName];
                        if (Array.isArray(tableData)) {
                            const currentEntry = tableData.find(item => item.$id === entryId);
                            if (currentEntry && currentEntry[fileField]) {
                                lastFileIds = JSON.stringify(currentEntry[fileField] || []);
                            }
                        }
                    }

                    // Watch the table array for fileIds changes
                    const scope = Alpine.$data(el);
                    if (scope) {
                        unwatch = scope.$watch(`$x.${tableName}`, (tableData) => {
                            if (!tableData || !Array.isArray(tableData)) return;

                            const currentEntry = tableData.find(item => item.$id === entryId);
                            if (!currentEntry) return;

                            const currentFileIds = JSON.stringify(currentEntry[fileField] || []);

                            // Refresh if fileIds actually changed and not already loading
                            if (currentFileIds !== lastFileIds && !loadingFiles) {
                                const $x = getX();
                                if ($x?.assets && typeof $x.assets.$filesFor === 'function') {
                                    lastFileIds = currentFileIds;
                                    loadFiles();
                                }
                            }
                        });
                    }

                    // Listen for file deletion events for instant UI updates
                    handleFileDeleted = (e) => {
                        const fileId = e.detail?.fileId;
                        if (!fileId) return;

                        // Check if this file is in our file list
                        const fileInList = files.some(f => f.$id === fileId);

                        // If event specifies this table/entry, or if file is in our list (optimistic update)
                        const isForThisEntry = e.detail?.tableName === tableName &&
                            e.detail?.entryIds &&
                            e.detail.entryIds.includes(entryId);

                        if (isForThisEntry || fileInList) {
                            // Optimistic update: remove file immediately for instant feedback
                            files = files.filter(f => f.$id !== fileId);
                            const scope = Alpine.$data(el);
                            if (scope) scope.files = files;

                            // Then refresh to ensure sync (but don't wait - optimistic update already happened)
                            if (!loadingFiles) {
                                const $x = getX();
                                if ($x?.assets && typeof $x.assets.$filesFor === 'function') {
                                    // Use a small delay to let the server sync, then refresh
                                    setTimeout(() => {
                                        if (!loadingFiles) {
                                            loadFiles();
                                        }
                                    }, 200);
                                }
                            }
                        }
                    };

                    window.addEventListener('manifest:file-deleted', handleFileDeleted);

                    // Reset processing guard after successful setup
                    isProcessing = false;
                }).catch((err) => {
                    console.error('[x-files] Error resolving entry:', err);
                    isProcessing = false; // Reset guard on error
                });
            });
        });

        cleanup(() => {
            if (unwatch && typeof unwatch === 'function') {
                unwatch();
            }
            if (handleFileDeleted) {
                window.removeEventListener('manifest:file-deleted', handleFileDeleted);
            }
        });
    });

    // Register x-project-files directive - simplified, turnkey solution for project files
    // Usage: <div x-project-files="project"> - automatically provides files, loadingFiles, filesError
    // Register x-entry-files directive - generic directive for displaying files linked to any table entry
    // Usage: <div x-entry-files="entry"> - automatically provides files, loadingFiles, filesError
    // Renamed from x-project-files to be more generic (works with any table entry, not just projects)
    // WeakMap to store namespace per element - ensures complete isolation
    const dataFilesNamespaces = new WeakMap();

    Alpine.directive('data-files', (el, { expression }, { effect, evaluateLater, cleanup }) => {
        const evaluateEntry = evaluateLater(expression);

        let entry = null;
        let entryId = null; // Track entry ID separately to avoid stale references
        let tableName = 'projects'; // Default, will be detected from entry
        let project = null; // Keep for backward compatibility during transition
        let projectId = null; // Keep for backward compatibility during transition
        let files = [];
        let loadingFiles = false;
        let filesError = null;
        let loadTimeout = null;
        let cleanupCallbacks = [];
        let watchCreated = false; // Track if watch has been created to prevent duplicates

        // CRITICAL: Always create a NEW isolated x-data scope for this directive element
        // This ensures complete isolation - each directive instance has its own scope
        // We MUST do this even if a parent scope exists, to prevent property conflicts
        const directiveInstanceId = `directive-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create a unique x-data object for this directive instance
        // This ensures Alpine creates a completely new scope for this element
        const isolatedData = Alpine.reactive({
            files: [],
            loadingFiles: false,
            filesError: null
        });

        // Set x-data attribute with a unique object reference
        // Alpine will create a new scope from this, completely isolated from parent scopes
        el.setAttribute('x-data', `{}`);

        // Get the scope AFTER setting x-data (Alpine creates it when x-data is set)
        let scope;
        try {
            scope = Alpine.$data(el);
        } catch (e) {
            // If Alpine hasn't initialized yet, create scope manually
            scope = {};
            Alpine.initTree(el);
            scope = Alpine.$data(el);
        }

        // CRITICAL: Directly assign properties to the scope object
        // Since this is a NEW isolated scope, we can safely assign directly without conflicts
        scope.files = isolatedData.files;
        scope.loadingFiles = isolatedData.loadingFiles;
        scope.filesError = isolatedData.filesError;

        // Store reference in WeakMap for access in closures
        dataFilesNamespaces.set(el, isolatedData);

        // DIAGNOSTIC: Log scope identity and element info
        const scopeId = `scope-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        scope._debugScopeId = scopeId;
        scope._debugDirectiveId = directiveInstanceId;
        scope._debugElement = el;

        // Initialize local references
        files = isolatedData.files;
        loadingFiles = isolatedData.loadingFiles;
        filesError = isolatedData.filesError;

        // Helper to get namespace (for consistency)
        const getNamespace = () => dataFilesNamespaces.get(el) || isolatedData;

        // Debounced load function
        const loadProjectFiles = async () => {
            // Use projectId variable instead of project.$id to avoid stale references
            const currentProjectId = projectId;

            if (!currentProjectId) {
                if (scope) {
                    scope.loadingFiles = false;
                    scope.files = [];
                }
                return;
            }

            // Always get the latest project reference from the store by ID
            const store = Alpine.store('data');
            const projects = store?.projects;
            if (!Array.isArray(projects)) {
                return;
            }

            const currentProject = projects.find(p => p.$id === currentProjectId);
            if (!currentProject) {
                // Project was deleted - clear files and don't try to load
                files = [];
                if (scope) {
                    scope.files = [];
                    scope.loadingFiles = false;
                    scope.filesError = null;
                }
                filesError = null;
                loadingFiles = false;
                project = null;
                projectId = null;
                return;
            }

            // Update project reference to latest from store
            project = currentProject;

            // Clear existing timeout
            if (loadTimeout) {
                clearTimeout(loadTimeout);
            }

            // Set new timeout for debouncing
            loadTimeout = setTimeout(async () => {
                // Double-check project still exists before making API call using projectId
                const store = Alpine.store('data');
                const projects = store?.projects;
                if (!Array.isArray(projects)) {
                    loadTimeout = null;
                    return;
                }

                const currentProject = projects.find(p => p.$id === currentProjectId);
                if (!currentProject) {
                    // Project was deleted while waiting - clear and exit
                    files = [];
                    if (scope) {
                        scope.files = [];
                        scope.loadingFiles = false;
                        scope.filesError = null;
                    }
                    filesError = null;
                    loadingFiles = false;
                    loadTimeout = null;
                    project = null;
                    projectId = null;
                    return;
                }

                // Update project reference to latest from store
                project = currentProject;

                // Set loading state - update both the namespace and scope directly
                loadingFiles = true;
                const ns = getNamespace();
                if (ns) {
                    ns.loadingFiles = true;
                    if (scope) scope.loadingFiles = true;
                }
                filesError = null;
                if (ns) {
                    ns.filesError = null;
                    if (scope) scope.filesError = null;
                }

                try {
                    // Use getFilesForEntry directly - more reliable than waiting for $filesFor
                    const getFilesForEntry = window.ManifestDataProxiesFiles?.getFilesForEntry;
                    if (!getFilesForEntry) {
                        throw new Error('getFilesForEntry is not available');
                    }

                    // Get bucket ID for assets from manifest
                    const manifest = await window.ManifestDataConfig?.ensureManifest?.();
                    if (!manifest?.data?.assets) {
                        throw new Error('Assets data source not found in manifest');
                    }

                    const assetsConfig = manifest.data.assets;
                    const bucketId = window.ManifestDataConfig?.getAppwriteBucketId?.(assetsConfig);
                    if (!bucketId) {
                        throw new Error('Assets bucket ID not found');
                    }

                    // Use currentProjectId to ensure we're loading files for the correct project
                    // Double-check we're using the correct project ID
                    if (!currentProjectId) {
                        return;
                    }

                    // Verify projectId matches before calling
                    if (currentProjectId !== projectId) {
                        return;
                    }

                    // Get the database entry's fileIds BEFORE calling getFilesForEntry
                    // This lets us check if the database has stale data
                    let databaseFileIds = null;
                    try {
                        const manifest = await window.ManifestDataConfig?.ensureManifest?.();
                        const tableDataSource = manifest?.data?.projects;
                        if (tableDataSource && window.ManifestDataConfig?.getAppwriteTableId) {
                            const tableId = window.ManifestDataConfig.getAppwriteTableId(tableDataSource);
                            const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(tableDataSource);
                            if (appwriteConfig && window.ManifestDataAppwrite?.getTableRow) {
                                const dbEntry = await window.ManifestDataAppwrite.getTableRow(
                                    appwriteConfig.databaseId,
                                    tableId,
                                    currentProjectId
                                );
                                databaseFileIds = dbEntry?.fileIds || [];
                            }
                        }
                    } catch (err) {
                        // Ignore errors - we'll just update store if needed
                    }

                    // CRITICAL DEBUG: Verify we're using the correct projectId before calling getFilesForEntry
                    const loadedFiles = await getFilesForEntry('projects', currentProjectId, bucketId, 'fileIds') || [];

                    // CRITICAL: Always create a NEW array for scope.files to avoid sharing between directive instances
                    // Don't mutate the existing array - create a completely new one
                    const newFilesArray = [...loadedFiles];

                    // Update local reference
                    files = newFilesArray;

                    // Update both namespace and scope directly (they reference the same arrays/values)
                    const ns = getNamespace();
                    if (ns) {
                        // DIAGNOSTIC: Mark each file with the project ID for tracking
                        const markedFiles = newFilesArray.map(file => ({
                            ...file,
                            _debugProjectId: currentProjectId,
                            _debugDirectiveId: directiveInstanceId,
                            _debugLoadedAt: Date.now()
                        }));

                        // Update namespace (reactive object)
                        ns.files = markedFiles;
                        ns.loadingFiles = false;
                        ns.filesError = null;

                        // Update scope directly (since it's isolated, no conflicts)
                        if (scope) {
                            scope.files = markedFiles;
                            scope.loadingFiles = false;
                            scope.filesError = null;
                        }

                        // Update local references
                        files = markedFiles;
                        loadingFiles = false;
                        filesError = null;

                    }


                    // Update lastFileIds to match what we actually loaded (from Appwrite)
                    // This is more reliable than reading from the store, which might be stale
                    const loadedFileIdsArray = loadedFiles.map(f => f.$id) || [];
                    lastFileIds = JSON.stringify(loadedFileIdsArray);

                    // CRITICAL: Sync store AND Appwrite database's fileIds with what actually exists
                    // If the store/database has stale fileIds (file IDs that don't exist), clean them up
                    const store = Alpine.store('data');
                    const projects = store?.projects;
                    if (Array.isArray(projects)) {
                        const currentProject = projects.find(p => p.$id === currentProjectId);
                        if (currentProject) {
                            const storeFileIds = currentProject.fileIds || [];
                            const storeFileIdsArray = Array.isArray(storeFileIds) ? storeFileIds : [];
                            const storeFileIdsJson = JSON.stringify(storeFileIdsArray);

                            // Check if store is stale (different from what we loaded)
                            const storeIsStale = storeFileIdsJson !== lastFileIds;

                            // Check if database is stale (different from what we loaded)
                            const databaseFileIdsArray = Array.isArray(databaseFileIds) ? databaseFileIds : [];
                            const databaseFileIdsJson = JSON.stringify(databaseFileIdsArray);
                            const databaseIsStale = databaseFileIds && databaseFileIdsJson !== lastFileIds;

                            if (storeIsStale || databaseIsStale) {
                                console.warn('[UPLOAD DEBUG] Store/Database fileIds is STALE - cleaning up:', {
                                    directiveInstanceId,
                                    projectId: currentProjectId,
                                    storeFileIds: storeFileIdsJson,
                                    databaseFileIds: databaseFileIdsJson,
                                    loadedFileIds: lastFileIds,
                                    storeIsStale,
                                    databaseIsStale,
                                    willSyncStore: storeIsStale,
                                    willSyncDatabase: databaseIsStale
                                });

                                // Update store if it's stale
                                if (storeIsStale) {
                                    const updateEntryInStore = window.ManifestDataMutations?.updateEntryInStore;
                                    if (updateEntryInStore) {
                                        updateEntryInStore('projects', currentProjectId, { fileIds: loadedFileIdsArray });
                                    }
                                }

                                // CRITICAL: Only update Appwrite database if it's actually stale
                                // This prevents unnecessary realtime events that might overwrite our store update
                                if (databaseIsStale) {
                                    try {
                                        const manifest = await window.ManifestDataConfig?.ensureManifest?.();
                                        const tableDataSource = manifest?.data?.projects;
                                        if (tableDataSource && window.ManifestDataConfig?.getAppwriteTableId) {
                                            const tableId = window.ManifestDataConfig.getAppwriteTableId(tableDataSource);
                                            const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(tableDataSource);

                                            if (appwriteConfig && window.ManifestDataAppwrite?.updateRow) {
                                                await window.ManifestDataAppwrite.updateRow(
                                                    appwriteConfig.databaseId,
                                                    tableId,
                                                    currentProjectId,
                                                    { fileIds: loadedFileIdsArray }
                                                );
                                            }
                                        }
                                    } catch (dbUpdateError) {
                                        console.error('[UPLOAD DEBUG] Failed to update Appwrite database:', dbUpdateError);
                                        // Don't throw - store is already updated, database will sync via realtime eventually
                                    }
                                }
                            }
                        }
                    }
                } catch (err) {
                    // Check if error is a 404 (project not found) - handle gracefully
                    const isNotFound = err.message?.includes('not found') ||
                        err.message?.includes('could not be found') ||
                        err.code === 404 ||
                        err.response?.code === 404;

                    if (isNotFound) {
                        // Project was deleted - silently clear files (don't show error)
                        files = [];
                        filesError = null;
                        if (scope) {
                            scope.files = [];
                            scope.loadingFiles = false;
                            scope.filesError = null;
                        }
                    } else {
                        // Other error - show it
                        console.error('[x-project-files] Error loading files:', err);
                        filesError = err.message || 'Failed to load files';
                        files = [];
                        if (scope) {
                            scope.filesError = filesError;
                            scope.files = files;
                            scope.loadingFiles = false;
                        }
                    }
                } finally {
                    // Ensure loadingFiles is cleared
                    loadingFiles = false;
                    const ns = getNamespace();
                    if (ns) {
                        ns.loadingFiles = false;
                        if (scope) scope.loadingFiles = false;
                    }
                    loadTimeout = null;
                }
            }, 100);
        };

        let lastFileIds = null;
        let fileIdsWatchUnwatch = null;

        effect(() => {
            // Evaluate project expression - this will re-run when project changes
            evaluateEntry((value) => {
                // Always get the latest project reference from the store by ID
                // This prevents using stale references when the projects array updates
                const currentProjectId = value?.$id;

                if (!currentProjectId) {
                    // Clear files if no project
                    files = [];
                    if (scope) {
                        scope.files = [];
                        scope.loadingFiles = false;
                    }
                    project = null;
                    projectId = null;
                    return;
                }

                // Get the latest project reference from the store to avoid stale references
                const store = Alpine.store('data');
                const projects = store?.projects;
                let latestProject = value; // Default to evaluated value

                if (Array.isArray(projects)) {
                    const storeProject = projects.find(p => p.$id === currentProjectId);
                    if (storeProject) {
                        latestProject = storeProject; // Use latest from store
                    } else {
                    }
                }

                const previousProjectId = projectId;
                const previousEntryId = entryId; // Sync with entryId
                project = latestProject; // Always use latest reference
                projectId = currentProjectId; // Update tracked project ID
                entry = latestProject; // Sync entry
                entryId = currentProjectId; // Sync entryId

                // Clean up existing fileIds watch when project ID changes
                if (previousProjectId !== currentProjectId) {
                    if (fileIdsWatchUnwatch && typeof fileIdsWatchUnwatch === 'function') {
                        fileIdsWatchUnwatch();
                        fileIdsWatchUnwatch = null;
                    }
                    lastFileIds = null;
                    watchCreated = false; // Reset watch creation flag when project ID changes
                }

                // Only reload if project ID changed or if we didn't have a project before
                if (currentProjectId && (previousProjectId !== currentProjectId || !previousProjectId)) {
                    loadProjectFiles();
                }

                // Watch for fileIds changes by watching the store directly
                // This ensures we always get the latest project reference from the store
                // Only create watch if we don't already have one for this project ID AND haven't created one yet
                if (currentProjectId && scope && typeof scope.$watch === 'function' && !fileIdsWatchUnwatch && !watchCreated) {
                    watchCreated = true; // Mark watch as created to prevent duplicates
                    const projectId = currentProjectId; // Capture project ID for closure
                    let isProcessing = false; // Guard against multiple simultaneous updates
                    let isInitializing = true; // Skip first evaluation (initialization)

                    // Initialize lastFileIds with current value from the store to prevent false positives
                    const store = Alpine.store('data');
                    const projects = store?.projects;
                    if (Array.isArray(projects)) {
                        const currentProject = projects.find(p => p.$id === projectId);
                        if (currentProject) {
                            lastFileIds = JSON.stringify(currentProject.fileIds || []);
                        }
                    }

                    // Use function-based watch that accesses the store - Alpine will track this
                    // This is more reliable than string expressions for nested store access
                    // IMPORTANT: Only access the specific project's fileIds to minimize reactivity
                    fileIdsWatchUnwatch = scope.$watch(
                        () => {
                            // Access the store - Alpine tracks this
                            const store = Alpine.store('data');
                            const projects = store?.projects;
                            if (!Array.isArray(projects)) return null;

                            // Find the current project by ID - always gets latest reference
                            const currentProject = projects.find(p => p.$id === projectId);
                            if (!currentProject) return null;

                            // Return the fileIds array as JSON string for comparison
                            // Accessing fileIds here makes Alpine track changes to this property
                            // This should only trigger when THIS project's fileIds changes
                            return JSON.stringify(currentProject.fileIds || []);
                        },
                        (currentFileIdsJson) => {
                            // Skip first evaluation (initialization) - we already loaded files above
                            if (isInitializing) {
                                isInitializing = false;
                                return;
                            }

                            // Guard against processing multiple updates simultaneously
                            if (isProcessing) {
                                return;
                            }

                            // This callback runs whenever fileIds changes
                            if (currentFileIdsJson === null) {
                                // Project not found in store
                                if (scope) {
                                    scope.files = [];
                                    scope.loadingFiles = false;
                                }
                                return;
                            }

                            // Compare with last known fileIds - only reload if actually changed
                            // Use the outer lastFileIds variable (not a local one)
                            if (currentFileIdsJson !== lastFileIds) {
                                isProcessing = true;
                                // Update the outer lastFileIds variable
                                lastFileIds = currentFileIdsJson;
                                // Debounce the reload to avoid multiple rapid updates
                                loadProjectFiles().finally(() => {
                                    isProcessing = false;
                                    // NOTE: lastFileIds is already updated in loadProjectFiles from loaded files (source of truth)
                                    // Don't overwrite it with store data here, as the store might be stale
                                });
                            } else {
                            }
                        }
                    );

                    // Mark this watch for cleanup
                    if (fileIdsWatchUnwatch) {
                        fileIdsWatchUnwatch._isFileIdsWatch = true;
                        cleanupCallbacks.push(() => {
                            if (fileIdsWatchUnwatch && typeof fileIdsWatchUnwatch === 'function') {
                                fileIdsWatchUnwatch();
                            }
                        });
                    }
                }
            });
        });

        // Set up event listeners
        let eventProcessing = false; // Guard against event-triggered reloads

        const handleProjectFilesUpdated = (e) => {
            const eventProjectId = e.detail?.projectId || e.detail?.entryId;
            const matches = eventProjectId === projectId;

            // Use projectId variable instead of project?.$id to avoid stale references
            if (matches && !eventProcessing) {
                eventProcessing = true;
                // Force reload when event fires - this is a backup to the watch
                loadProjectFiles().finally(() => {
                    eventProcessing = false;
                });
            }
        };

        const handleFileCreated = (e) => {
            // Check if the file is linked to this project
            const fileId = e.detail?.fileId;
            const entryId = e.detail?.entryId;
            const tableName = e.detail?.tableName;

            // CRITICAL: Use entryId from event to identify target project
            // This is more reliable than checking the store, which might be stale
            const matchesProject = entryId === projectId && tableName === 'projects';

            // Use entryId from event instead of checking store (which is stale)
            if (fileId && matchesProject && !eventProcessing) {
                eventProcessing = true;
                // Reload files for this project - getFilesForEntry will get the latest from Appwrite
                loadProjectFiles().finally(() => {
                    eventProcessing = false;
                });
            }
        };

        const handleFileDeleted = (e) => {
            // Use projectId variable instead of project?.$id to avoid stale references
            if (e.detail?.tableName === 'projects' && e.detail?.entryIds?.includes(projectId) && !eventProcessing) {
                const fileId = e.detail?.fileId;
                eventProcessing = true;
                if (fileId) {
                    // Optimistically remove from UI
                    files = files.filter(f => f.$id !== fileId);
                    if (scope) scope.files = files;
                }
                // Reload to ensure consistency
                loadProjectFiles().finally(() => {
                    eventProcessing = false;
                });
            }
        };

        window.addEventListener('manifest:project-files-updated', handleProjectFilesUpdated);
        window.addEventListener('manifest:file-created', handleFileCreated);
        window.addEventListener('manifest:file-deleted', handleFileDeleted);

        cleanupCallbacks.push(() => {
            window.removeEventListener('manifest:project-files-updated', handleProjectFilesUpdated);
            window.removeEventListener('manifest:file-created', handleFileCreated);
            window.removeEventListener('manifest:file-deleted', handleFileDeleted);
            if (loadTimeout) {
                clearTimeout(loadTimeout);
            }
            // Clean up watch when directive is destroyed
            if (fileIdsWatchUnwatch && typeof fileIdsWatchUnwatch === 'function') {
                fileIdsWatchUnwatch();
                fileIdsWatchUnwatch = null;
            }
            watchCreated = false; // Reset flag on cleanup
        });

        cleanup(() => {
            cleanupCallbacks.forEach(cb => cb());
        });
    });
}

// Directive removed - using project.$files property instead
// Auto-register directive when Alpine is ready
// if (typeof document !== 'undefined') {
//     if (typeof Alpine !== 'undefined') {
//         registerFilesDirective();
//     } else {
//         document.addEventListener('alpine:init', () => {
//             registerFilesDirective();
//         });
//     }
// }

/* Manifest Data Sources - Main Initialization */

// Filter storage files by scope (client-side filtering)
// Appwrite returns all files user has access to, but we need to filter by current team
// to match database team scope behavior
async function filterFilesByScope(files, scope) {
    if (!files || !Array.isArray(files) || files.length === 0) {
        return files;
    }

    // Get auth store
    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
    if (!authStore) {
        return files;
    }

    // Wait for auth store initialization
    if (!authStore._initialized || authStore.isAuthenticated === undefined) {
        let attempts = 0;
        const maxAttempts = 10;
        while (attempts < maxAttempts && (!authStore._initialized || authStore.isAuthenticated === undefined)) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
    }

    const isAuthenticated = authStore.isAuthenticated === true;
    if (!isAuthenticated) {
        return [];
    }

    const scopeArray = Array.isArray(scope) ? scope : [scope];
    const hasUserScope = scopeArray.includes('user');
    const hasTeamScope = scopeArray.includes('team');
    const hasTeamsScope = scopeArray.includes('teams');

    // Get Permission and Role helpers
    const Permission = window.Appwrite?.Permission;
    const Role = window.Appwrite?.Role;

    if (!Permission || !Role) {
        console.warn('[Manifest Data] Appwrite Permission/Role not available, cannot filter files by scope');
        return files;
    }

    // Build expected permission strings based on scope
    const expectedPermissions = [];

    if (hasUserScope) {
        const user = authStore.user;
        const userId = user?.$id || user?.id;
        if (userId) {
            expectedPermissions.push(Permission.read(Role.user(userId)));
        }
    }

    if (hasTeamScope) {
        const currentTeam = authStore.currentTeam;
        const teamId = currentTeam?.$id || currentTeam?.id;
        if (teamId) {
            expectedPermissions.push(Permission.read(Role.team(teamId)));
        } else {
            // No current team - return empty array (matches database behavior)
            return [];
        }
    }

    if (hasTeamsScope) {
        const teams = authStore.teams || [];
        teams.forEach(team => {
            const teamId = team.$id || team.id;
            if (teamId) {
                expectedPermissions.push(Permission.read(Role.team(teamId)));
            }
        });
    }

    if (expectedPermissions.length === 0) {
        // No scope permissions to filter by, return all files
        return files;
    }

    // Filter files: include file if its permissions match any of the expected permissions
    const filteredFiles = files.filter(file => {
        const filePermissions = file.$permissions || [];

        // Check if file has any of the expected permissions
        return expectedPermissions.some(expectedPerm => {
            // Permission strings are in format like "read(\"team:teamId\")"
            // We need to check if the file's permissions include this
            const expectedPermString = typeof expectedPerm === 'string' ? expectedPerm : String(expectedPerm);
            return filePermissions.some(filePerm => {
                const filePermString = typeof filePerm === 'string' ? filePerm : String(filePerm);
                // Check if permissions match (they should be identical strings)
                return filePermString === expectedPermString;
            });
        });
    });

    return filteredFiles;
}

// Handle real-time storage events
async function handleStorageRealtimeEvent(dataSourceName, bucketId, scope, eventType, payload) {

    // Deduplicate events
    const eventKey = getEventKey(eventType, payload);
    if (isEventProcessed(eventKey)) {
        return;
    }
    markEventProcessed(eventKey);

    const store = Alpine.store('data');
    if (!store) {
        return;
    }

    const currentFiles = store[dataSourceName];
    if (!Array.isArray(currentFiles)) {
        return;
    }

    // Use scoped updates via mutation system
    const addEntryToStore = window.ManifestDataMutations?.addEntryToStore;
    const updateEntryInStore = window.ManifestDataMutations?.updateEntryInStore;
    const removeEntryFromStore = window.ManifestDataMutations?.removeEntryFromStore;

    if (eventType === 'create') {
        // New file created - check if it matches scope before adding
        const file = payload?.$id ? payload : (payload?.file || payload);
        if (file && file.$id) {
            // Check if file matches current scope
            const fileMatchesScope = await checkFileMatchesScope(file, scope);
            if (fileMatchesScope) {
                // Check if already exists
                const exists = currentFiles.some(f => f.$id === file.$id);
                if (!exists && addEntryToStore) {
                    // Use scoped update: add only this file
                    addEntryToStore(dataSourceName, file);
                } else if (!exists) {
                    // Fallback: update entire array
                    const updatedFiles = [...currentFiles, file];
                    const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                    const reactiveFiles = createReactiveReferences
                        ? createReactiveReferences(updatedFiles, dataSourceName)
                        : updatedFiles;
                    Alpine.store('data', { ...store, [dataSourceName]: reactiveFiles });
                    if (window.ManifestDataProxies?.attachArrayMethods) {
                        const loadDataSource = window.ManifestDataMain?._loadDataSource;
                        if (loadDataSource) {
                            window.ManifestDataProxies.attachArrayMethods(reactiveFiles, dataSourceName, loadDataSource);
                        }
                    }
                }

                // Emit custom event for new file creation so UI can refresh project files
                window.dispatchEvent(new CustomEvent('manifest:file-created', {
                    detail: { fileId: file.$id, file: file }
                }));
            }
        } else {
            console.warn('[Manifest Data] Invalid file payload in create event:', payload);
        }
    } else if (eventType === 'update') {
        // File updated - update in array if it exists
        const file = payload?.$id ? payload : (payload?.file || payload);
        if (file && file.$id) {
            const existingFile = currentFiles.find(f => f.$id === file.$id);
            if (existingFile) {
                // Check if file still matches scope after update
                const fileMatchesScope = await checkFileMatchesScope(file, scope);
                if (fileMatchesScope) {
                    // Use scoped update: update only this file
                    if (updateEntryInStore) {
                        updateEntryInStore(dataSourceName, file.$id, file);
                    } else {
                        // Fallback: update entire array
                        const updatedFiles = currentFiles.map(f => f.$id === file.$id ? file : f);
                        const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                        const reactiveFiles = createReactiveReferences
                            ? createReactiveReferences(updatedFiles)
                            : updatedFiles;
                        Alpine.store('data', { ...store, [dataSourceName]: reactiveFiles });
                        if (window.ManifestDataProxies?.attachArrayMethods) {
                            const loadDataSource = window.ManifestDataMain?._loadDataSource;
                            if (loadDataSource) {
                                window.ManifestDataProxies.attachArrayMethods(reactiveFiles, dataSourceName, loadDataSource);
                            }
                        }
                    }
                } else {
                    // File no longer matches scope, remove it
                    if (removeEntryFromStore) {
                        removeEntryFromStore(dataSourceName, file.$id);
                    } else {
                        // Fallback: update entire array
                        const updatedFiles = currentFiles.filter(f => f.$id !== file.$id);
                        const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                        const reactiveFiles = createReactiveReferences
                            ? createReactiveReferences(updatedFiles)
                            : updatedFiles;
                        Alpine.store('data', { ...store, [dataSourceName]: reactiveFiles });
                        if (window.ManifestDataProxies?.attachArrayMethods) {
                            const loadDataSource = window.ManifestDataMain?._loadDataSource;
                            if (loadDataSource) {
                                window.ManifestDataProxies.attachArrayMethods(reactiveFiles, dataSourceName, loadDataSource);
                            }
                        }
                    }
                }
            } else {
                // File not in list, but might match scope now - add it
                const fileMatchesScope = await checkFileMatchesScope(file, scope);
                if (fileMatchesScope && addEntryToStore) {
                    addEntryToStore(dataSourceName, file);
                } else if (fileMatchesScope) {
                    // Fallback: update entire array
                    const updatedFiles = [...currentFiles, file];
                    const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                    const reactiveFiles = createReactiveReferences
                        ? createReactiveReferences(updatedFiles, dataSourceName)
                        : updatedFiles;
                    Alpine.store('data', { ...store, [dataSourceName]: reactiveFiles });
                    if (window.ManifestDataProxies?.attachArrayMethods) {
                        const loadDataSource = window.ManifestDataMain?._loadDataSource;
                        if (loadDataSource) {
                            window.ManifestDataProxies.attachArrayMethods(reactiveFiles, dataSourceName, loadDataSource);
                        }
                    }
                }
            }
        }
    } else if (eventType === 'delete') {
        // File deleted - remove from array
        const fileId = payload?.$id || payload?.file?.$id || payload?.fileId || payload;
        if (fileId) {
            const actualFileId = fileId.$id || fileId;
            if (removeEntryFromStore) {
                // Use scoped update: remove only this file
                removeEntryFromStore(dataSourceName, actualFileId);
            } else {
                // Fallback: update entire array
                const updatedFiles = currentFiles.filter(f => f.$id !== actualFileId);
                const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                const reactiveFiles = createReactiveReferences
                    ? createReactiveReferences(updatedFiles)
                    : updatedFiles;
                Alpine.store('data', { ...store, [dataSourceName]: reactiveFiles });
                if (window.ManifestDataProxies?.attachArrayMethods) {
                    const loadDataSource = window.ManifestDataMain?._loadDataSource;
                    if (loadDataSource) {
                        window.ManifestDataProxies.attachArrayMethods(reactiveFiles, dataSourceName, loadDataSource);
                    }
                }
            }
        }
    }
}

// Track recently processed events to prevent duplicate processing
// Use a combination of event type, ID, and timestamp to create a unique key per client
const processedEvents = new Map(); // Map<eventKey, timestamp>
const EVENT_DEDUP_WINDOW = 2000; // 2 seconds (reduced from 5 to catch rapid duplicates but allow legitimate updates)

// Generate a unique key for an event
// For updates, we need to be more careful - use timestamp to allow same sequence from different sources
function getEventKey(eventType, payload) {
    const id = payload?.$id || payload?.row?.$id || payload?.rowId || payload?.id || payload;
    const sequence = payload?.$sequence || payload?.sequence;
    const timestamp = payload?.$updatedAt || payload?.$createdAt || payload?.timestamp;

    // For updates, include timestamp to allow processing updates with same sequence but different times
    // This handles the case where multiple clients receive the same sequence number
    if (eventType === 'update' && timestamp) {
        // Use a combination that allows same sequence from different times
        return `${eventType}:${id}:${sequence}:${timestamp}`;
    }

    // For create/delete, sequence is usually unique enough
    return `${eventType}:${id}:${sequence || Date.now()}`;
}

// Check if an event was recently processed
function isEventProcessed(eventKey) {
    const timestamp = processedEvents.get(eventKey);
    if (!timestamp) {
        return false;
    }
    // Remove old entries
    if (Date.now() - timestamp > EVENT_DEDUP_WINDOW) {
        processedEvents.delete(eventKey);
        return false;
    }
    return true;
}

// Mark an event as processed
function markEventProcessed(eventKey) {
    processedEvents.set(eventKey, Date.now());
    // Clean up old entries periodically
    if (processedEvents.size > 1000) {
        const now = Date.now();
        for (const [key, timestamp] of processedEvents.entries()) {
            if (now - timestamp > EVENT_DEDUP_WINDOW) {
                processedEvents.delete(key);
            }
        }
    }
}

// Handle real-time events for database tables
async function handleTableRealtimeEvent(dataSourceName, databaseId, tableId, scope, eventType, payload) {

    // Deduplicate events
    const eventKey = getEventKey(eventType, payload);
    if (isEventProcessed(eventKey)) {
        return;
    }
    markEventProcessed(eventKey);

    const store = Alpine.store('data');
    if (!store) {
        return;
    }

    const currentRows = store[dataSourceName];

    // Handle realtime events
    if (!Array.isArray(currentRows)) {
        return;
    }

    let updatedRows = [...currentRows];

    // Use scoped updates via mutation system
    const addEntryToStore = window.ManifestDataMutations?.addEntryToStore;
    const updateEntryInStore = window.ManifestDataMutations?.updateEntryInStore;
    const removeEntryFromStore = window.ManifestDataMutations?.removeEntryFromStore;

    if (eventType === 'create') {
        // New row created - check if it matches scope before adding
        const row = payload?.$id ? payload : (payload?.row || payload);
        if (row && row.$id) {
            // Check if row matches current scope
            const rowMatchesScope = await checkRowMatchesScope(row, scope);
            if (rowMatchesScope) {
                // Check if already exists
                const exists = currentRows.some(r => r.$id === row.$id);
                if (!exists && addEntryToStore) {
                    // Use scoped update: add only this entry
                    addEntryToStore(dataSourceName, row);
                } else if (!exists) {
                    // Fallback: update entire array
                    const updatedRows = [...currentRows, row];
                    const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                    const reactiveRows = createReactiveReferences
                        ? createReactiveReferences(updatedRows, dataSourceName)
                        : updatedRows;
                    Alpine.store('data', { ...store, [dataSourceName]: reactiveRows });
                    if (window.ManifestDataProxies?.attachArrayMethods) {
                        const loadDataSource = window.ManifestDataMain?._loadDataSource;
                        if (loadDataSource) {
                            window.ManifestDataProxies.attachArrayMethods(reactiveRows, dataSourceName, loadDataSource);
                        }
                    }
                }
            }
        } else {
            console.warn('[Manifest Data] Invalid row payload in create event:', payload);
        }
    } else if (eventType === 'update') {
        // Row updated - update in array if it exists
        const row = payload?.$id ? payload : (payload?.row || payload);
        if (row && row.$id) {
            const existingRow = currentRows.find(r => r.$id === row.$id);
            if (existingRow) {
                // Check if row still matches scope after update
                const rowMatchesScope = await checkRowMatchesScope(row, scope);
                if (rowMatchesScope) {
                    // For most data sources (roles, etc.), always update on realtime events
                    // Special handling only for projects with fileIds to protect optimistic updates
                    const existingFileIds = existingRow?.fileIds || [];
                    const incomingFileIds = row?.fileIds || [];
                    const hasFileIds = existingFileIds.length > 0 || incomingFileIds.length > 0;
                    const isProjectWithFiles = hasFileIds && dataSourceName === 'projects';

                    let shouldUpdate = true;

                    // Special handling only for projects with fileIds
                    if (isProjectWithFiles) {
                        const existingUpdatedAt = existingRow?.$updatedAt || existingRow?.$sequence;
                        const newUpdatedAt = row?.$updatedAt || row?.$sequence;
                        const shouldUpdateByTimestamp = !newUpdatedAt || !existingUpdatedAt || newUpdatedAt !== existingUpdatedAt;

                        if (!shouldUpdateByTimestamp) {
                            // Timestamps match and both exist - skip update
                            shouldUpdate = false;
                        } else {
                            const existingFileIdsSet = new Set(existingFileIds);
                            const incomingFileIdsSet = new Set(incomingFileIds);

                            // Check if incoming is a superset (has all existing files + more)
                            const isSuperset = incomingFileIds.every(id => existingFileIdsSet.has(id)) &&
                                incomingFileIds.length > existingFileIds.length;

                            // Check if incoming is missing files that exist in current (stale data)
                            const isMissingFiles = existingFileIds.some(id => !incomingFileIdsSet.has(id));

                            // Only update if:
                            // 1. Incoming is a superset (has all existing + more), OR
                            // 2. Incoming is equal (same files), OR
                            // 3. Timestamp comparison suggests it's definitely newer (more than 1 second difference)
                            const timestampDiff = newUpdatedAt > existingUpdatedAt ?
                                (new Date(newUpdatedAt) - new Date(existingUpdatedAt)) :
                                (new Date(existingUpdatedAt) - new Date(newUpdatedAt));
                            const isDefinitelyNewer = timestampDiff > 1000; // More than 1 second difference

                            // CRITICAL: If existing has more fileIds than incoming, and timestamps are close,
                            // this is likely a stale realtime event overwriting an optimistic update
                            // Protect optimistic updates by requiring incoming to be a superset or definitely newer
                            if (isMissingFiles && !isDefinitelyNewer) {
                                // Incoming data is missing files and timestamp isn't definitely newer - likely stale
                                // This protects optimistic updates from being overwritten by stale realtime events
                                console.warn('[Realtime] Ignoring stale realtime update (protecting optimistic update):', {
                                    projectId: row.$id,
                                    existingFileIds: existingFileIds,
                                    incomingFileIds: incomingFileIds,
                                    existingFileIdsCount: existingFileIds.length,
                                    incomingFileIdsCount: incomingFileIds.length,
                                    existingUpdatedAt,
                                    newUpdatedAt,
                                    timestampDiff,
                                    isMissingFiles,
                                    isDefinitelyNewer,
                                    reason: 'Incoming data missing files that exist in store - likely stale realtime event'
                                });
                                shouldUpdate = false;
                            }
                        }
                    }

                    // Apply the update if shouldUpdate is true
                    if (shouldUpdate) {
                        // Check if fileIds changed (for projects with linked files)
                        const fileIdsChanged = isProjectWithFiles &&
                            JSON.stringify(existingFileIds) !== JSON.stringify(incomingFileIds);

                        // Use scoped update: update only this entry
                        if (updateEntryInStore) {
                            updateEntryInStore(dataSourceName, row.$id, row);
                        } else {
                            // Fallback: update entire array
                            const updatedRows = currentRows.map(r => r.$id === row.$id ? row : r);
                            const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                            const reactiveRows = createReactiveReferences
                                ? createReactiveReferences(updatedRows, dataSourceName)
                                : updatedRows;
                            Alpine.store('data', { ...store, [dataSourceName]: reactiveRows });
                            if (window.ManifestDataProxies?.attachArrayMethods) {
                                const loadDataSource = window.ManifestDataMain?._loadDataSource;
                                if (loadDataSource) {
                                    window.ManifestDataProxies.attachArrayMethods(reactiveRows, dataSourceName, loadDataSource);
                                }
                            }
                        }

                        // Emit custom event for project file updates so UI can refresh
                        if (fileIdsChanged && dataSourceName === 'projects') {
                            window.dispatchEvent(new CustomEvent('manifest:project-files-updated', {
                                detail: { projectId: row.$id, fileIds: row.fileIds }
                            }));
                        }
                    }
                } else {
                    // Row no longer matches scope, remove it
                    if (removeEntryFromStore) {
                        removeEntryFromStore(dataSourceName, row.$id);
                    } else {
                        // Fallback: update entire array
                        const updatedRows = currentRows.filter(r => r.$id !== row.$id);
                        const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                        const reactiveRows = createReactiveReferences
                            ? createReactiveReferences(updatedRows, dataSourceName)
                            : updatedRows;
                        Alpine.store('data', { ...store, [dataSourceName]: reactiveRows });
                        if (window.ManifestDataProxies?.attachArrayMethods) {
                            const loadDataSource = window.ManifestDataMain?._loadDataSource;
                            if (loadDataSource) {
                                window.ManifestDataProxies.attachArrayMethods(reactiveRows, dataSourceName, loadDataSource);
                            }
                        }
                    }
                }
            } else {
                // Row not in list, but might match scope now - add it
                const rowMatchesScope = await checkRowMatchesScope(row, scope);
                if (rowMatchesScope && addEntryToStore) {
                    addEntryToStore(dataSourceName, row);
                } else if (rowMatchesScope) {
                    // Fallback: update entire array
                    const updatedRows = [...currentRows, row];
                    const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                    const reactiveRows = createReactiveReferences
                        ? createReactiveReferences(updatedRows, dataSourceName)
                        : updatedRows;
                    Alpine.store('data', { ...store, [dataSourceName]: reactiveRows });
                    if (window.ManifestDataProxies?.attachArrayMethods) {
                        const loadDataSource = window.ManifestDataMain?._loadDataSource;
                        if (loadDataSource) {
                            window.ManifestDataProxies.attachArrayMethods(reactiveRows, dataSourceName, loadDataSource);
                        }
                    }
                }
            }
        }
    } else if (eventType === 'delete') {
        // Row deleted - remove from array
        const rowId = payload?.$id || payload?.row?.$id || payload?.rowId || payload;
        if (rowId) {
            const actualRowId = rowId.$id || rowId;
            if (removeEntryFromStore) {
                // Use scoped update: remove only this entry
                removeEntryFromStore(dataSourceName, actualRowId);
            } else {
                // Fallback: update entire array
                const updatedRows = currentRows.filter(r => r.$id !== actualRowId);
                const createReactiveReferences = window.ManifestDataStore?.createReactiveReferences;
                const reactiveRows = createReactiveReferences
                    ? createReactiveReferences(updatedRows, dataSourceName)
                    : updatedRows;
                Alpine.store('data', { ...store, [dataSourceName]: reactiveRows });
                if (window.ManifestDataProxies?.attachArrayMethods) {
                    const loadDataSource = window.ManifestDataMain?._loadDataSource;
                    if (loadDataSource) {
                        window.ManifestDataProxies.attachArrayMethods(reactiveRows, dataSourceName, loadDataSource);
                    }
                }
            }
        }
    }

}

// Check if a database row matches the current scope
async function checkRowMatchesScope(row, scope) {
    if (!scope || !row) {
        return true; // No scope, allow it
    }

    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
    if (!authStore) {
        return true;
    }

    const scopeArray = Array.isArray(scope) ? scope : [scope];
    const hasUserScope = scopeArray.includes('user');
    const hasTeamScope = scopeArray.includes('team');
    const hasTeamsScope = scopeArray.includes('teams');

    // Check user scope
    if (hasUserScope) {
        const user = authStore.user;
        const userId = user?.$id || user?.id;
        if (userId && row.userId === userId) {
            return true; // Matches user scope
        }
    }

    // Check team scope (singular - currentTeam)
    if (hasTeamScope) {
        const currentTeamId = authStore.currentTeam?.$id || authStore.currentTeam?.id;
        if (currentTeamId && row.teamId === currentTeamId) {
            return true; // Matches current team scope
        }
    }

    // Check teams scope (plural - all teams)
    if (hasTeamsScope) {
        const teams = authStore.teams || [];
        const teamIds = teams.map(t => t.$id || t.id).filter(id => id);
        if (teamIds.includes(row.teamId)) {
            return true; // Matches one of user's teams
        }
    }

    // For dual scopes like ["user", "team"], if either matches, return true
    // This matches the OR query logic
    if (hasUserScope && (hasTeamScope || hasTeamsScope)) {
        // Already checked above, if we get here, it doesn't match
        return false;
    }

    // If scope is defined but doesn't match, return false
    // If no scope restrictions, return true
    return !hasUserScope && !hasTeamScope && !hasTeamsScope;
}

// Check if a file matches the current scope (for real-time events)
async function checkFileMatchesScope(file, scope) {
    if (!scope || !file || !file.$permissions) {
        return true; // No scope or no permissions, allow it
    }

    // Use the same scope filtering logic as filterFilesByScope
    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
    if (!authStore) {
        return true;
    }

    const scopeArray = Array.isArray(scope) ? scope : [scope];
    const hasUserScope = scopeArray.includes('user');
    const hasTeamScope = scopeArray.includes('team');
    const hasTeamsScope = scopeArray.includes('teams');

    const Permission = window.Appwrite?.Permission;
    const Role = window.Appwrite?.Role;

    if (!Permission || !Role) {
        return true;
    }

    const expectedPermissions = [];

    if (hasUserScope) {
        const user = authStore.user;
        const userId = user?.$id || user?.id;
        if (userId) {
            expectedPermissions.push(Permission.read(Role.user(userId)));
        }
    }

    if (hasTeamScope) {
        const currentTeam = authStore.currentTeam;
        const teamId = currentTeam?.$id || currentTeam?.id;
        if (teamId) {
            expectedPermissions.push(Permission.read(Role.team(teamId)));
        } else {
            return false; // No current team, file doesn't match
        }
    }

    if (hasTeamsScope) {
        const teams = authStore.teams || [];
        teams.forEach(team => {
            const teamId = team.$id || team.id;
            if (teamId) {
                expectedPermissions.push(Permission.read(Role.team(teamId)));
            }
        });
    }

    if (expectedPermissions.length === 0) {
        return true; // No scope restrictions
    }

    // Check if file has any of the expected permissions
    const filePermissions = file.$permissions || [];
    return expectedPermissions.some(expectedPerm => {
        const expectedPermString = typeof expectedPerm === 'string' ? expectedPerm : String(expectedPerm);
        return filePermissions.some(filePerm => {
            const filePermString = typeof filePerm === 'string' ? filePerm : String(filePerm);
            return filePermString === expectedPermString;
        });
    });
}

// Load dataSource data
async function loadDataSource(dataSourceName, locale = 'en') {
    const cacheKey = `${dataSourceName}:${locale}`;
    const { dataSourceCache, loadingPromises, isInitializing, updateStore } = window.ManifestDataStore;

    // Check memory cache first
    if (dataSourceCache.has(cacheKey)) {
        const cachedData = dataSourceCache.get(cacheKey);
        if (!isInitializing) {
            updateStore(dataSourceName, cachedData, { loading: false, error: null, ready: true });
        }
        return cachedData;
    }

    // If already loading, return existing promise
    if (loadingPromises.has(cacheKey)) {
        return loadingPromises.get(cacheKey);
    }

    // Set loading state
    if (!isInitializing) {
        updateStore(dataSourceName, null, { loading: true, error: null, ready: false });
    }

    const loadPromise = (async () => {
        try {
            const manifest = await window.ManifestDataConfig.ensureManifest();
            if (!manifest) {
                return null;
            }

            // Check both manifest.data and manifest.appwrite for data sources
            let dataSource = null;

            if (manifest.data?.[dataSourceName]) {
                dataSource = manifest.data[dataSourceName];
            } else if (manifest.appwrite?.[dataSourceName]) {
                dataSource = manifest.appwrite[dataSourceName];
            }

            if (!dataSource) {
                // Only return null for dataSources that are actually being accessed
                // This prevents warnings for test references that might exist in HTML
                return null;
            }

            // Get bucketId early to check if this is a bucket (needed for data enhancement)
            const bucketId = window.ManifestDataConfig.getAppwriteBucketId?.(dataSource) || null;

            let data;

            // Helper to get current locale
            function getCurrentLocale() {
                return document.documentElement.lang ||
                    (window.Alpine && Alpine.store('locale')?.current) ||
                    locale ||
                    'en';
            }

            // Auto-detect dataSource type based on structure
            if (typeof dataSource === 'string') {
                // Local file - load from filesystem (auto-detect format)
                // For CSV files, pass currentLocale so parser can use locale column if available
                const options = dataSource.endsWith('.csv') ? { currentLocale: getCurrentLocale() } : {};
                try {
                    data = await window.ManifestDataLoaders.loadLocalFile(dataSource, options);
                } catch (error) {
                    console.error(`[Manifest Data] Failed to load local file "${dataSourceName}":`, error);
                    throw error;
                }
            } else if (dataSource.locales) {
                // Single CSV file with multiple locale columns (all locales in one file)
                const options = { currentLocale: getCurrentLocale() };
                data = await window.ManifestDataLoaders.loadLocalFile(dataSource.locales, options);
            } else if (dataSource.url) {
                // Cloud API - load from HTTP endpoint (read-only)
                // NOTE: Basic API support is in core for localization compatibility.
                // Full CRUD operations will be available via manifest.api.data.js plugin (planned).
                data = await window.ManifestDataAPI.loadFromAPI(dataSource);
            } else if (window.ManifestDataConfig.isAppwriteCollection(dataSource)) {
                // Appwrite collection or bucket
                const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
                if (!appwriteConfig) {
                    console.warn(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
                    return null;
                }

                const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
                // bucketId already defined above
                const scope = window.ManifestDataConfig.getScope(dataSource);
                const queriesConfig = window.ManifestDataConfig.getQueries(dataSource);

                if (tableId) {
                    // Load from Appwrite table (TablesDB)
                    const queries = queriesConfig
                        ? await window.ManifestDataQueries.buildAppwriteQueries(queriesConfig.default || queriesConfig, scope)
                        : await window.ManifestDataQueries.buildAppwriteQueries([], scope);

                    // Log auth state for debugging
                    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
                    const teamIds = authStore?.teams?.map(t => t.$id || t.id) || [];

                    data = await window.ManifestDataAppwrite.loadTableRows(
                        appwriteConfig.databaseId,
                        tableId,
                        queries
                    );

                    // Subscribe to real-time updates for this table
                    if (window.ManifestDataRealtime && window.ManifestDataRealtime.subscribeToTable) {
                        await window.ManifestDataRealtime.subscribeToTable(
                            dataSourceName,
                            appwriteConfig.databaseId,
                            tableId,
                            scope,
                            async (eventType, payload) => {
                                // Handle real-time events
                                await handleTableRealtimeEvent(dataSourceName, appwriteConfig.databaseId, tableId, scope, eventType, payload);
                            }
                        );
                    }
                } else if (bucketId) {
                    // Load from Appwrite storage bucket
                    // Note: Storage buckets don't support query-based scope filtering (no userId/teamId columns)
                    // Appwrite automatically filters by permissions, but returns ALL files user has access to
                    // We need to filter client-side based on scope (current team) to match database behavior
                    const queries = queriesConfig
                        ? await window.ManifestDataQueries.buildAppwriteQueries(queriesConfig.default || queriesConfig, null)
                        : await window.ManifestDataQueries.buildAppwriteQueries([], null);

                    let files = await window.ManifestDataAppwrite.listBucketFiles(bucketId, queries);

                    // Ensure files is always an array
                    if (!Array.isArray(files)) {
                        console.warn(`[Manifest Data] listBucketFiles returned non-array for "${dataSourceName}":`, files);
                        files = [];
                    }

                    // Filter files by scope if scope is defined (client-side filtering)
                    // This matches the database team scope behavior
                    if (scope && files && Array.isArray(files) && files.length > 0) {
                        const originalCount = files.length;
                        files = await filterFilesByScope(files, scope);
                    }

                    data = files;

                    // Subscribe to real-time updates for this bucket
                    if (window.ManifestDataRealtime && window.ManifestDataRealtime.subscribeToStorageBucket) {
                        await window.ManifestDataRealtime.subscribeToStorageBucket(
                            dataSourceName,
                            bucketId,
                            scope,
                            async (eventType, payload) => {
                                // Handle real-time events
                                await handleStorageRealtimeEvent(dataSourceName, bucketId, scope, eventType, payload);
                            }
                        );
                    }
                } else {
                    console.warn(`[Manifest Data] Appwrite data source "${dataSourceName}" missing tableId or bucketId`);
                    return null;
                }
            } else if (dataSource[locale]) {
                // Localized dataSource - load current locale
                const localizedDataSource = dataSource[locale];
                let currentLocaleData = null;

                try {
                    if (typeof localizedDataSource === 'string') {
                        // Localized local file (separate file per locale)
                        // For CSV in localized structure, don't pass locale - each file is already locale-specific
                        currentLocaleData = await window.ManifestDataLoaders.loadLocalFile(localizedDataSource);
                    } else if (localizedDataSource.url) {
                        // Localized cloud API
                        currentLocaleData = await window.ManifestDataAPI.loadFromAPI(localizedDataSource);
                    } else {
                        console.warn(`[Manifest Data] No valid source found for dataSource "${dataSourceName}" in locale "${locale}"`);
                        return null;
                    }
                } catch (error) {
                    // Current locale file is missing or failed to load
                    console.warn(`[Manifest Data] Failed to load locale "${locale}" for "${dataSourceName}":`, error.message);
                    currentLocaleData = null; // Will fallback to default
                }

                // Load default locale for fallback (if different from current locale, or if current failed)
                const defaultLocale = window.ManifestDataConfig.getDefaultLocale(dataSource);
                if (defaultLocale && (defaultLocale !== locale || !currentLocaleData)) {
                    const defaultLocaleDataSource = dataSource[defaultLocale];
                    let fallbackData = null;

                    try {
                        if (typeof defaultLocaleDataSource === 'string') {
                            // For CSV in localized structure, don't pass locale - each file is already locale-specific
                            fallbackData = await window.ManifestDataLoaders.loadLocalFile(defaultLocaleDataSource);
                        } else if (defaultLocaleDataSource?.url) {
                            fallbackData = await window.ManifestDataAPI.loadFromAPI(defaultLocaleDataSource);
                        }

                        // Merge fallback data with current locale data (current takes precedence if it exists)
                        if (fallbackData) {
                            if (currentLocaleData) {
                                data = window.ManifestDataLoaders.deepMergeWithFallback(currentLocaleData, fallbackData);
                            } else {
                                // Current locale file is missing, use fallback as primary
                                data = fallbackData;
                            }
                        } else {
                            data = currentLocaleData;
                        }
                    } catch (error) {
                        // If fallback also fails, use current locale data (or null if that also failed)
                        console.warn(`[Manifest Data] Failed to load fallback locale "${defaultLocale}" for "${dataSourceName}":`, error.message);
                        data = currentLocaleData;
                    }
                } else {
                    // No default locale or same as current, just use current (or null if it failed)
                    data = currentLocaleData;
                }
            } else {
                console.warn(`[Manifest Data] No valid source found for dataSource "${dataSourceName}"`);
                return null;
            }

            // Enhance data with metadata
            let enhancedData;
            const sourceType = typeof dataSource === 'string' ? 'local' :
                (dataSource.url ? 'api' : 'local');
            const sourcePath = typeof dataSource === 'string' ? dataSource :
                (dataSource.url || '');

            // For buckets, ensure data is always an array
            if (bucketId && !Array.isArray(data)) {
                console.warn(`[Manifest Data] Bucket "${dataSourceName}" returned non-array data:`, data);
                data = [];
            }

            if (Array.isArray(data)) {
                // Only enhance objects in arrays, not primitives
                enhancedData = data.map(item => {
                    if (item !== null && typeof item === 'object') {
                        return {
                            ...item,
                            contentType: dataSourceName,
                            _loadedFrom: sourcePath,
                            _sourceType: sourceType,
                            _locale: locale
                        };
                    } else {
                        // For primitives, return as-is (no enhancement)
                        return item;
                    }
                });
            } else if (data !== null && data !== undefined && typeof data === 'object') {
                enhancedData = {
                    ...data,
                    contentType: dataSourceName,
                    _loadedFrom: sourcePath,
                    _sourceType: sourceType,
                    _locale: locale
                };
            } else {
                // For null, undefined, or primitives, use data as-is
                enhancedData = data;
            }

            // Ensure enhancedData is an array for bucket data sources
            if (bucketId && !Array.isArray(enhancedData)) {
                console.warn(`[Manifest Data] Bucket "${dataSourceName}" enhancedData is not an array:`, enhancedData);
                enhancedData = [];
            }

            // Update cache (store unsealed version for our use)
            dataSourceCache.set(cacheKey, enhancedData);

            // Update store only if not initializing
            // Note: updateStore will seal the data to prevent Alpine from proxying it
            if (!isInitializing) {
                updateStore(dataSourceName, enhancedData, { loading: false, error: null, ready: true });
            }

            // Return unsealed version for our proxy system
            return enhancedData;
        } catch (error) {
            // Set error state with timestamp to prevent rapid retries
            if (!isInitializing) {
                const errorMessage = error?.message || error?.toString() || `Failed to load dataSource "${dataSourceName}"`;
                updateStore(dataSourceName, null, {
                    loading: false,
                    error: errorMessage,
                    ready: false,
                    errorTime: Date.now() // Track when error occurred
                });
            }

            // Only log non-auth errors to reduce noise (401 is expected until user authenticates)
            const isAuthError = error?.code === 401 || error?.message?.includes('401') || error?.message?.includes('not authorized');
            if (!isAuthError) {
                console.error(`[Manifest Data] Failed to load dataSource "${dataSourceName}":`, error);
                // Log the full error details for debugging
                if (error?.stack) {
                    console.error(`[Manifest Data] Error stack for "${dataSourceName}":`, error.stack);
                }
            }
            return null;
        } finally {
            loadingPromises.delete(cacheKey);
        }
    })();

    loadingPromises.set(cacheKey, loadPromise);
    return loadPromise;
}

// Listen for URL changes to trigger reactivity
function setupUrlChangeListeners() {
    let currentUrl = window.location.pathname;

    // Create a reactive object for route tracking that Alpine can track
    // This is separate from the store to ensure Alpine tracks it properly
    const routeTracker = Alpine.reactive ? Alpine.reactive({
        currentUrl: window.location.pathname
    }) : { currentUrl: window.location.pathname };

    // Expose routeTracker globally so createRouteProxy can access it
    if (!window.ManifestDataRouteTracker) {
        window.ManifestDataRouteTracker = routeTracker;
    }

    // Update store with current URL
    function updateCurrentUrl(newUrl) {
        if (newUrl !== currentUrl) {
            currentUrl = newUrl;
            const store = Alpine.store('data');
            if (store && store._initialized) {
                // Update the store property - Alpine stores are reactive by default
                // CRITICAL: Use Object.assign or spread to ensure Alpine tracks the change
                // Direct property assignment might not trigger reactivity in all cases
                Object.assign(store, { _currentUrl: newUrl });

                // CRITICAL: Also update the reactive route tracker
                // This ensures Alpine tracks the change even if store access isn't tracked in Proxy get traps
                if (routeTracker) {
                    routeTracker.currentUrl = newUrl;
                }

                // Force Alpine to recognize the change by accessing the property
                // This ensures Alpine's reactivity system tracks the update
                const _ = store._currentUrl;
                // Dispatch a custom event to ensure any components listening for URL changes can react
                // This helps with reactivity in cases where Alpine's automatic tracking might miss the update
                try {
                    window.dispatchEvent(new CustomEvent('manifest:data-url-change', {
                        detail: { url: newUrl }
                    }));
                } catch (e) {
                    console.warn('[Manifest Data] Failed to dispatch event:', e);
                }
            } else {
                console.warn('[Manifest Data] Store not initialized, cannot update _currentUrl:', {
                    storeExists: !!store,
                    initialized: store?._initialized
                });
            }
        }
    }

    // Listen to router's route change event (primary integration point)
    window.addEventListener('manifest:route-change', (event) => {
        const newUrl = event.detail?.to ?? window.ManifestRoutingNavigation?.getCurrentRoute?.() ?? window.location.pathname;
        updateCurrentUrl(newUrl);
        // Flush route proxies after other listeners have queued their updates, so $x.*.$route('path') content updates without refresh
        setTimeout(() => {
            if (window.ManifestDataRouteProxyUpdateQueue?.flushSync) {
                window.ManifestDataRouteProxyUpdateQueue.flushSync();
            }
        }, 0);
    });

    // Also listen for popstate (browser back/forward)
    window.addEventListener('popstate', () => {
        updateCurrentUrl(window.location.pathname);
    });

    // Also listen for pushstate/replacestate (for SPA navigation)
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
        originalPushState.apply(history, args);
        updateCurrentUrl(window.location.pathname);
    };

    history.replaceState = function (...args) {
        originalReplaceState.apply(history, args);
        updateCurrentUrl(window.location.pathname);
    };

    // Initialize with current URL
    updateCurrentUrl(window.location.pathname);
}

// Initialize plugin when either DOM is ready or Alpine is ready
async function initializeDataSourcesPlugin() {

    const { initializeStore, setupLocaleChangeListener, setupTeamChangeListener, setIsInitializing, setInitializationComplete, updateStore } = window.ManifestDataStore;

    // Initialize empty data sources store
    initializeStore();

    // Setup locale change listener
    setupLocaleChangeListener();

    // Setup team change listener
    setupTeamChangeListener();

    // Setup URL change listeners
    setupUrlChangeListeners();

    // Register $x magic method (only if Alpine is available)

    if (typeof Alpine !== 'undefined' && window.ManifestDataProxies) {
        window.ManifestDataProxies.registerXMagicMethod(loadDataSource);
    } else {
        // Wait for Alpine to load
        const checkAlpine = setInterval(() => {
            if (typeof Alpine !== 'undefined' && window.ManifestDataProxies) {
                window.ManifestDataProxies.registerXMagicMethod(loadDataSource);
                clearInterval(checkAlpine);
            }
        }, 10);
        // Timeout after 5 seconds
        setTimeout(() => {
            clearInterval(checkAlpine);
            if (typeof Alpine === 'undefined') {
                console.error('[Manifest Data] Alpine.js failed to load - $x magic method not registered');
            }
        }, 5000);
    }

    // Export loadDataSource for use by team change listener
    window.ManifestDataMain = {
        loadDataSource,
        _loadDataSource: loadDataSource, // Export for internal use
        filterFilesByScope // Export for use by getFilesForEntry
    };

    // Listen for manifest:dev-reload (fired by mnfst-run when a data file changes).
    // Re-fetches all local data sources and updates the Alpine store reactively.
    window.addEventListener('manifest:dev-reload', async () => {
        const manifest = await window.ManifestDataConfig.ensureManifest();
        if (!manifest?.data) return;

        const locale = document.documentElement.lang ||
            (typeof Alpine !== 'undefined' && Alpine.store('locale')?.current) || 'en';

        const { dataSourceCache, loadingPromises } = window.ManifestDataStore;
        const isAppwriteCollection = window.ManifestDataConfig.isAppwriteCollection;

        for (const [name, source] of Object.entries(manifest.data)) {
            if (isAppwriteCollection(source)) continue;
            if (source && typeof source === 'object' && source.url) continue;

            const cacheKey = `${name}:${locale}`;
            dataSourceCache.delete(cacheKey);
            loadingPromises.delete(cacheKey);

            try { await loadDataSource(name, locale); } catch { /* skip failed sources */ }
        }
    });

    // Initialize dataSources after magic method is registered
    if (window.ManifestDataStore.isInitializing || window.ManifestDataStore.initializationComplete) return;
    setIsInitializing(true);

    try {
        // Initialize store - preserve existing store properties like _currentUrl
        const existingStore = Alpine.store('data') || {};
        Alpine.store('data', {
            ...existingStore,
            all: [],
            _initialized: true,
            _ready: false,
            // Ensure _currentUrl is preserved or initialized
            _currentUrl: existingStore._currentUrl || window.location.pathname
        });

        // Pre-load all local file-backed data sources so $x.* accessors see
        // real data on the very first render pass.
        //
        // Each source is at most ONE fetch regardless of type:
        //   - Simple string paths (e.g. "/data/clients.yaml") → one file.
        //   - Localized objects (e.g. { "en": "...", "fr": "..." }) → only the
        //     current locale file is fetched (+ default locale for fallback
        //     merging if different), NOT all 35 variants.
        //   - Single CSV with embedded locales → one file.
        //
        // Skipped (remain on-demand):
        //   - Appwrite collections / buckets — require auth/session context.
        //   - API-URL sources — may have side-effects or auth requirements.
        //   - The special "manifest" key — handled separately below.
        //
        // Without pre-loading, sources like $x.clients load asynchronously on
        // first access, causing a visible flash in the SPA and missing data in
        // prerender snapshots.
        try {
            const manifest = await window.ManifestDataConfig.ensureManifest();
            const locale = (typeof document !== 'undefined' && document.documentElement?.lang) || (typeof Alpine !== 'undefined' && Alpine.store('locale')?.current) || 'en';
            const isAppwriteCollection = window.ManifestDataConfig.isAppwriteCollection;

            if (manifest?.data) {
                const preloadNames = [];
                for (const [name, source] of Object.entries(manifest.data)) {
                    if (name === 'manifest') continue; // handled separately below
                    if (isAppwriteCollection(source)) continue;
                    if (source && typeof source === 'object' && source.url) continue;
                    preloadNames.push(name);
                }

                if (preloadNames.length > 0) {
                    await Promise.all(
                        preloadNames.map(async (name) => {
                            try {
                                const data = await loadDataSource(name, locale);
                                if (data != null && window.ManifestDataStore?.updateStore) {
                                    window.ManifestDataStore.updateStore(name, data, { loading: false, error: null, ready: true, allowDuringInit: true });
                                }
                            } catch (err) {
                                console.warn(`[Manifest Data] Failed to pre-load ${name}:`, err);
                            }
                        })
                    );
                }
            }

            if (manifest && manifest.data && manifest.data.manifest) {
                // The manifest data source points to itself - use the manifest object directly
                const manifestData = manifest;
                // Remove internal properties that shouldn't be exposed
                const { data, appwrite, components, preloadedComponents, ...publicManifest } = manifestData;
                // allowDuringInit: setIsInitializing(true) is active, so without this
                // flag updateStore short-circuits and $x.manifest stays unpopulated.
                window.ManifestDataStore.dataSourceCache.set(`manifest:${locale}`, publicManifest);
                updateStore('manifest', publicManifest, { loading: false, error: null, ready: true, allowDuringInit: true });

                const store = Alpine.store('data');
                Alpine.store('data', {
                    ...store,
                    _ready: true
                });
            } else {
                // No manifest data source, mark as ready anyway
                const store = Alpine.store('data');
                Alpine.store('data', {
                    ...store,
                    _ready: true
                });
            }
        } catch (error) {
            // If manifest pre-load fails, mark as ready anyway - it will load on-demand
            console.warn('[Manifest Data] Failed to pre-load manifest:', error);
            const store = Alpine.store('data');
            Alpine.store('data', {
                ...store,
                _ready: true
            });
        }

        // Force Alpine to re-run effects that read $x.content (they may have run before pre-load and got loading proxy)
        const flushThenDispatch = () => {
            if (typeof Alpine !== 'undefined') {
                const s = Alpine.store('data');
                Alpine.store('data', { ...s, _dataVersion: (s._dataVersion || 0) + 1 });
            }
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('manifest:data-ready'));
            }
            // Check if all sources are settled and dispatch manifest:render-ready if so.
            // Covers the initial-load path (no data sources, or only content pre-loaded).
            window.ManifestDataStore?.checkAndDispatchRenderReady?.();
        };
        if (typeof Alpine !== 'undefined' && Alpine.nextTick) {
            Alpine.nextTick(flushThenDispatch);
        } else {
            setTimeout(flushThenDispatch, 0);
        }

        // Other data sources remain on-demand when accessed via $x
    } finally {
        setIsInitializing(false);
        setInitializationComplete(true);
    }
}

// Handle both DOMContentLoaded and alpine:init
// Track if we've already initialized to prevent duplicate initialization
let dataSourcesInitialized = false;

function tryInitialize() {
    if (dataSourcesInitialized) {
        return;
    }
    if (typeof Alpine === 'undefined') {
        return;
    }
    dataSourcesInitialized = true;
    initializeDataSourcesPlugin();
}

// Try immediately if Alpine is available
if (typeof Alpine !== 'undefined') {
    tryInitialize();
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryInitialize);
}

// Also listen for alpine:init (in case Alpine loads after DOMContentLoaded)
document.addEventListener('alpine:init', tryInitialize);