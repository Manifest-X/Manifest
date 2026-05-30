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
        // Iterate own enumerable keys via Object.keys instead of for…in +
        // .hasOwnProperty(). The latter throws "hasOwnProperty is not a
        // function" on any object that either lacks the Object prototype
        // (e.g. Object.create(null)) or has a column literally named
        // `hasOwnProperty` shadowing the prototype method — both of which
        // can happen with payloads from Appwrite / arbitrary backends.
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            if (value !== null && typeof value === 'object') {
                deepSeal(value);
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
        // Create new object with new references for each property.
        // Iterate via Object.keys() (own enumerable, no prototype walk)
        // rather than for…in + .hasOwnProperty(). The latter pattern
        // throws "hasOwnProperty is not a function" on any payload that
        // either has a column literally named `hasOwnProperty` shadowing
        // the prototype, or lacks the Object prototype entirely
        // (Object.create(null), some SDK response shapes). This is the
        // hot path for every Appwrite mutation result and realtime event,
        // so it must be defensive about arbitrary backend payloads.
        const newObj = {};
        for (const key of Object.keys(data)) {
            const value = data[key];
            // Recursively create new references for nested objects/arrays
            newObj[key] = createReactiveReferences(value, dataSourceName);
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

