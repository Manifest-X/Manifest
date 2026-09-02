/* Manifest Data Sources - Store Management */

// Raw data, kept out of Alpine's store to avoid double-proxying (recursion)
const dataSourceCache = new Map();
const loadingPromises = new Map();
const rawDataStore = new Map();

let isInitializing = false;
let initializationComplete = false;

let _renderReadyTimer = null;
const RENDER_READY_QUIET_MS = 150; // quiet time before firing render-ready

// Landing queue: network writes coalesce into one store write per frame
const pendingLandings = [];
let landingResolvers = [];
let landingFrame = null;
let landingTimer = null;
const LANDING_FALLBACK_MS = 50;

// Local writes made while a flush is pending win over it (local-last)
const pendingLocal = new Map(); // source -> Map<$id, { patch, removed }>

// Lazy cross-source `all`
let allCache = null;
let allDirty = true;

// Deep seal so Alpine won't proxy (double-proxying causes recursion)
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
        // Object.keys, not for…in + .hasOwnProperty: backend payloads may lack
        // the Object prototype or shadow hasOwnProperty with a column of that name.
        for (const key of Object.keys(obj)) {
            const value = obj[key];
            if (value !== null && typeof value === 'object') {
                deepSeal(value);
            }
        }
    }

    return obj;
}

const rawOf = (obj) => (typeof Alpine !== 'undefined' && Alpine.raw && obj ? Alpine.raw(obj) : obj);

const rowKey = (row) => (row && typeof row === 'object' && (typeof row.$id === 'string' || typeof row.$id === 'number'))
    ? row.$id
    : null;

function ensureStoreShape(store) {
    if (!store._v) store._v = {};
}

// Version bump: per-source (`$x` reads subscribe here), `all`, and the legacy
// global counter kept for external readers (status/datepicker/charts)
function touchSources(store, sources) {
    ensureStoreShape(store);
    const v = store._v;
    for (const source of sources) v[source] = (v[source] || 0) + 1;
    v.all = (v.all || 0) + 1;
    allDirty = true;
    store._dataVersion = (store._dataVersion || 0) + 1;
}

function touchSource(dataSourceName) {
    const store = typeof Alpine !== 'undefined' ? Alpine.store('data') : null;
    if (store) touchSources(store, [dataSourceName]);
}

// Post-settle hammer: re-run every `$x` reader (Alpine scheduler swallow)
function bumpAllVersions() {
    const store = typeof Alpine !== 'undefined' ? Alpine.store('data') : null;
    if (!store) return;
    ensureStoreShape(store);
    const raw = rawOf(store);
    const sources = new Set(Object.keys(raw._v || {}));
    for (const key of Object.keys(raw)) {
        if (!key.startsWith('_') && key !== 'all' && typeof raw[key] !== 'function') sources.add(key);
    }
    sources.delete('all');
    touchSources(store, sources);
}

function sameScalarOrList(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        if (x !== b[i] || (x !== null && typeof x === 'object')) return false;
    }
    return true;
}

// Merge fields onto an existing tracked row (property-grain); `$files` stays bound
function mergeRowFields(target, fields, dataSourceName) {
    if (!target || !fields || typeof fields !== 'object') return;
    const raw = rawOf(target);
    for (const key of Object.keys(fields)) {
        if (key === '$files') continue;
        const value = fields[key];
        if (sameScalarOrList(raw[key], value)) continue;
        target[key] = createReactiveReferences(value, dataSourceName);
    }
}

function attachMethods(array, dataSourceName) {
    const loadDataSource = window.ManifestDataMain?.loadDataSource;
    if (Array.isArray(array) && loadDataSource && window.ManifestDataProxies?.attachArrayMethods) {
        window.ManifestDataProxies.attachArrayMethods(array, dataSourceName, loadDataSource);
    }
}

// Reactive source array, created on demand; raw map tracks the same identity
function ensureSourceArray(dataSourceName) {
    const store = Alpine.store('data');
    if (!store) return null;
    const current = rawOf(store)[dataSourceName];
    if (Array.isArray(current)) return store[dataSourceName];
    if (current !== null && current !== undefined) return null;
    store[dataSourceName] = [];
    const created = rawOf(store)[dataSourceName];
    rawDataStore.set(dataSourceName, created);
    attachMethods(created, dataSourceName);
    return store[dataSourceName];
}

// Identity-preserving upsert by $id: existing rows are merged in place, new
// rows created; append keeps the array, replace swaps it only when membership
// or order changed
function upsertRows(store, dataSourceName, rows, mode) {
    const raw = rawOf(store);
    const curRaw = Array.isArray(raw[dataSourceName]) ? raw[dataSourceName] : null;
    if (!curRaw) {
        store[dataSourceName] = rows.map(row => createReactiveReferences(row, dataSourceName));
        return;
    }
    const cur = store[dataSourceName];
    const index = new Map();
    curRaw.forEach((row, i) => { const id = rowKey(row); if (id !== null) index.set(id, i); });
    const fresh = new Map();
    const next = [];
    const appended = [];
    for (const row of rows) {
        const id = rowKey(row);
        const i = id !== null ? index.get(id) : undefined;
        if (i !== undefined) {
            mergeRowFields(cur[i], row, dataSourceName);
            if (mode === 'replace') next.push(curRaw[i]);
            continue;
        }
        if (id !== null && fresh.has(id)) {
            mergeRowFields(fresh.get(id), row, dataSourceName);
            continue;
        }
        const created = createReactiveReferences(row, dataSourceName);
        if (id !== null) fresh.set(id, created);
        (mode === 'replace' ? next : appended).push(created);
    }
    if (mode === 'replace') {
        if (next.length !== curRaw.length || next.some((row, i) => row !== curRaw[i])) store[dataSourceName] = next;
    } else if (appended.length) {
        cur.push(...appended);
    }
}

function removeRows(store, dataSourceName, ids) {
    const curRaw = rawOf(store)[dataSourceName];
    if (!Array.isArray(curRaw) || !ids?.length) return false;
    const set = new Set(ids);
    const cur = store[dataSourceName];
    let removed = false;
    for (let i = curRaw.length - 1; i >= 0; i--) {
        const id = rowKey(curRaw[i]);
        if (id !== null && set.has(id)) { cur.splice(i, 1); removed = true; }
    }
    return removed;
}

// Synchronous write of data + state for one source (no version bump); returns the new state
function writeSource(dataSourceName, data, options = {}) {
    const store = Alpine.store('data');
    if (!store) return null;
    ensureStoreShape(store);
    const mode = options.mode === 'append' ? 'append' : 'replace';

    if (data === null || data === undefined) {
        if (mode === 'replace') {
            store[dataSourceName] = data;
            rawDataStore.set(dataSourceName, data);
        }
    } else if (Array.isArray(data)) {
        upsertRows(store, dataSourceName, data, mode);
        const arr = rawOf(store)[dataSourceName];
        rawDataStore.set(dataSourceName, arr);
        attachMethods(arr, dataSourceName);
    } else {
        store[dataSourceName] = data;
        rawDataStore.set(dataSourceName, data);
    }

    const currentState = store[`_${dataSourceName}_state`] || { loading: false, error: null, ready: false };
    const newState = {
        loading: options.loading !== undefined ? options.loading : currentState.loading,
        error: options.error !== undefined ? options.error : currentState.error,
        ready: options.ready !== undefined ? options.ready : (data !== null && data !== undefined),
        errorTime: options.error !== undefined && options.error !== null ? Date.now() : (currentState.errorTime || null)
    };
    store[`_${dataSourceName}_state`] = newState;
    store._initialized = true;
    store._ready = true;

    const proxies = window.ManifestDataProxies;
    proxies?.clearAccessCache?.(dataSourceName);
    proxies?.clearArrayProxyCacheForDataSource?.(dataSourceName);
    proxies?.clearRouteProxyCacheForDataSource?.(dataSourceName);
    proxies?.clearNestedProxyCacheForDataSource?.(dataSourceName);
    return newState;
}

// Synchronous replace: local writes ($register, init preload, state-only updates)
function updateStore(dataSourceName, data, options = {}) {
    if (isInitializing && !options.allowDuringInit) return;
    const state = writeSource(dataSourceName, data, { ...options, mode: 'replace' });
    if (!state) return;
    touchSource(dataSourceName);
    if (!state.loading) checkAndDispatchRenderReady();
}

// Network landing (page load, paged append, realtime batch): buffered, applied
// with every other landing of the same frame in ONE flush. Resolves once visible.
function landRows(dataSourceName, rows, options = {}) {
    return queueLanding({ source: dataSourceName, rows, options: { mode: 'replace', ...options } });
}

function landRemove(dataSourceName, ids, options = {}) {
    return queueLanding({ source: dataSourceName, remove: Array.isArray(ids) ? ids : [ids], options });
}

function queueLanding(op) {
    return new Promise(resolve => {
        pendingLandings.push(op);
        landingResolvers.push(resolve);
        scheduleLandingFlush();
    });
}

function scheduleLandingFlush() {
    if (landingFrame !== null || landingTimer !== null) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (!hidden && typeof requestAnimationFrame === 'function') {
        landingFrame = requestAnimationFrame(flushLandings);
        landingTimer = setTimeout(flushLandings, LANDING_FALLBACK_MS);
    } else {
        landingTimer = setTimeout(flushLandings, 0);
    }
}

// Local write while a flush is pending: replayed on top of that flush
function noteLocalWrite(dataSourceName, id, note) {
    if (!pendingLandings.length || id === null || id === undefined) return;
    let byId = pendingLocal.get(dataSourceName);
    if (!byId) pendingLocal.set(dataSourceName, byId = new Map());
    if (note.removed) { byId.set(id, { removed: true }); return; }
    const prev = byId.get(id);
    const base = prev && !prev.removed ? prev.patch : {};
    byId.set(id, { removed: false, patch: { ...base, ...note.patch } });
}

function flushLandings() {
    if (landingFrame !== null) { cancelAnimationFrame(landingFrame); landingFrame = null; }
    if (landingTimer !== null) { clearTimeout(landingTimer); landingTimer = null; }
    const ops = pendingLandings.splice(0);
    const resolvers = landingResolvers.splice(0);
    const local = new Map(pendingLocal);
    pendingLocal.clear();
    if (!ops.length) return;

    const store = typeof Alpine !== 'undefined' ? Alpine.store('data') : null;
    const touched = new Set();
    let settled = false;
    if (store) {
        for (const op of ops) {
            try {
                if (op.remove) {
                    if (removeRows(store, op.source, op.remove)) touched.add(op.source);
                    continue;
                }
                const state = writeSource(op.source, op.rows, op.options);
                if (!state) continue;
                touched.add(op.source);
                // Only load completions (explicit loading state) feed render-ready; realtime upserts never do
                if (op.options.loading !== undefined && !state.loading) settled = true;
            } catch (error) {
                console.error(`[Manifest Data] Landing failed for "${op.source}":`, error);
            }
        }
        for (const [source, byId] of local) {
            for (const [id, note] of byId) {
                if (note.removed) {
                    if (removeRows(store, source, [id])) touched.add(source);
                    continue;
                }
                const curRaw = rawOf(store)[source];
                const i = Array.isArray(curRaw) ? curRaw.findIndex(row => rowKey(row) === id) : -1;
                if (i !== -1) { mergeRowFields(store[source][i], note.patch, source); touched.add(source); }
            }
        }
        if (touched.size) touchSources(store, touched);
    }
    resolvers.forEach(resolve => resolve());
    if (settled) checkAndDispatchRenderReady();
}

// Cross-source `all`: built on first read after a change, versioned by _v.all
function getAll() {
    const store = typeof Alpine !== 'undefined' ? Alpine.store('data') : null;
    if (!store) return [];
    ensureStoreShape(store);
    void store._v.all;
    if (allDirty || !allCache) {
        const raw = rawOf(store);
        const wrap = Alpine.reactive ? (item => Alpine.reactive(item)) : (item => item);
        const out = [];
        for (const key of Object.keys(raw)) {
            if (key.startsWith('_') || key === 'all') continue;
            const value = raw[key];
            if (Array.isArray(value)) {
                for (const item of value) {
                    if (item !== null && item !== undefined) out.push(typeof item === 'object' ? wrap(item) : item);
                }
            } else if (value && typeof value === 'object') {
                out.push(wrap(value));
            }
        }
        allCache = out;
        allDirty = false;
        attachMethods(out, 'all');
    }
    return allCache;
}

// Get raw data from our non-reactive store
function getRawData(dataSourceName) {
    return rawDataStore.get(dataSourceName);
}

// New object/array references (incl. nested arrays like fileIds) so Alpine tracks changes
function createReactiveReferences(data, dataSourceName = null) {
    if (data === null || data === undefined) {
        return data;
    }

    if (Array.isArray(data)) {
        // Create new array with new references for each item
        return data.map(item => createReactiveReferences(item, dataSourceName));
    }

    if (typeof data === 'object') {
        // Object.keys, not for…in + .hasOwnProperty (see deepSeal). Hot path for
        // every Appwrite mutation result and realtime event.
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
        _initialized: false,
        _ready: false, // Flag to indicate when data is ready for Alpine evaluation
        _v: {}, // Per-source versions: `$x.<source>` reads subscribe to _v[source]; _v.all for `$x.all`
        _dataVersion: 0, // Legacy global counter, bumped once per flush for external readers
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
    // Lazy cross-source array (non-enumerable so store spreads/key scans skip it)
    Object.defineProperty(initialStore, 'all', { enumerable: false, configurable: true, get: getAll });
    allCache = null;
    allDirty = true;
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
                    teamScopedDataSources.forEach(dataSourceName => {
                        delete store[dataSourceName];
                    });
                    touchSources(store, teamScopedDataSources);
                }

                // Clear proxy cache for these data sources
                teamScopedDataSources.forEach(dataSourceName => {
                    if (window.ManifestDataProxies && window.ManifestDataProxies.clearAccessCache) {
                        window.ManifestDataProxies.clearAccessCache(dataSourceName);
                    }
                });

                // Reload (not just cache-clear) so data is fresh for the new team
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

// Dispatch manifest:render-ready once all sources settle (debounced to coalesce).
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

            window.__manifestRenderReady = true;
            window.dispatchEvent(new CustomEvent('manifest:render-ready', {
                detail: { locale, sources }
            }));
            // Alpine 3.x can strand effects re-queued mid-flush (scheduler
            // swallow) — an x-if that read this store before data arrived may
            // never re-run. One post-settle bump on a fresh task re-runs
            // anything dropped.
            setTimeout(() => {
                try { bumpAllVersions(); } catch (_) { /* no-op */ }
            }, 50);
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
        if (store) store._localeChanging = true;

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

                // Clear nested proxy cache so fresh proxies use the new locale data
                if (window.ManifestDataProxies?.clearNestedProxyCacheForDataSource) {
                    window.ManifestDataProxies.clearNestedProxyCacheForDataSource(dataSourceName);
                }

                // Clear raw data so $x.content (etc.) doesn't serve stale locale until reload completes
                rawDataStore.delete(dataSourceName);
            });

            // Remove localized data from store so bindings see missing data and re-run
            const store = Alpine.store('data');
            if (store) {
                localizedDataSources.forEach(dataSourceName => {
                    delete store[dataSourceName];
                    delete store[`_${dataSourceName}_state`];
                });
                store._localeChanging = false;
                touchSources(store, localizedDataSources);
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
            rawDataStore.clear();
            const store = Alpine.store('data');
            if (store) {
                const raw = rawOf(store);
                for (const key of Object.keys(raw)) {
                    if (!key.startsWith('_') && typeof raw[key] !== 'function') delete store[key];
                }
                store._initialized = true;
                store._localeChanging = false;
                bumpAllVersions();
            }
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
}

function clearCreatingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._creatingEntry || !store._creatingEntry[dataSourceName]) return;

    // Create new object without this entryId
    const { [entryId]: removed, ...rest } = store._creatingEntry[dataSourceName];
    store._creatingEntry[dataSourceName] = rest;
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
}

function clearUpdatingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._updatingEntry || !store._updatingEntry[dataSourceName]) return;

    // Create new object without this entryId
    const { [entryId]: removed, ...rest } = store._updatingEntry[dataSourceName];
    store._updatingEntry[dataSourceName] = rest;
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
}

function clearDeletingEntry(dataSourceName, entryId) {
    const store = Alpine.store('data');
    if (!store || !store._deletingEntry || !store._deletingEntry[dataSourceName]) return;

    // Create new object without this entryId
    const { [entryId]: removed, ...rest } = store._deletingEntry[dataSourceName];
    store._deletingEntry[dataSourceName] = rest;
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
    // Landing model (PERF-PRIMITIVES-DESIGN.md §5)
    landRows,
    landRemove,
    flushLandings,
    noteLocalWrite,
    touchSource,
    bumpAllVersions,
    mergeRowFields,
    ensureSourceArray,
    rawOf,
    getAll,
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

