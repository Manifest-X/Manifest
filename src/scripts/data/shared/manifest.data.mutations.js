/* Manifest Data Sources - Unified Mutation System */
// Handles optimistic updates, scoped updates, rollback, and background sync

// Track pending mutations for rollback
const pendingMutations = new Map(); // Map<mutationId, { type, dataSourceName, optimisticData, originalData, rollback }>

let mutationIdCounter = 0;

// Generate unique mutation ID
function generateMutationId() {
    return `mutation_${Date.now()}_${++mutationIdCounter}`;
}

// Local writes are synchronous (read-your-writes) and identity-preserving;
// network landings go through ManifestDataStore.landRows instead.
function clearSourceCaches(dataSourceName) {
    const proxies = window.ManifestDataProxies;
    proxies?.clearAccessCache?.(dataSourceName);
    proxies?.clearArrayProxyCacheForDataSource?.(dataSourceName);
    proxies?.clearRouteProxyCacheForDataSource?.(dataSourceName);
}

function findRawIndex(dataSourceName, entryId) {
    const store = Alpine.store('data');
    const raw = window.ManifestDataStore?.rawOf?.(store) || store;
    const arr = raw?.[dataSourceName];
    if (!Array.isArray(arr)) return { store, arr: null, index: -1 };
    return { store, arr, index: arr.findIndex(entry => entry && entry.$id === entryId) };
}

// Update a single entry in the store (scoped update)
function updateEntryInStore(dataSourceName, entryId, updates, options = {}) {
    if (typeof Alpine === 'undefined' || !Alpine.store) {
        return false;
    }

    const { store, arr, index } = findRawIndex(dataSourceName, entryId);
    if (!store || !arr || index === -1) {
        return false;
    }

    // Local write: merge onto the tracked row, sync
    const ds = window.ManifestDataStore;
    ds.mergeRowFields(store[dataSourceName][index], updates, dataSourceName);
    ds.noteLocalWrite(dataSourceName, entryId, { patch: updates });
    ds.touchSource(dataSourceName);
    clearSourceCaches(dataSourceName);

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

    const ds = window.ManifestDataStore;
    const target = ds?.ensureSourceArray?.(dataSourceName);
    if (!target) {
        return false;
    }

    // Local write: push onto the tracked array, sync
    target.push(ds.createReactiveReferences(entry, dataSourceName));
    ds.noteLocalWrite(dataSourceName, entry?.$id, { patch: entry });
    ds.touchSource(dataSourceName);
    clearSourceCaches(dataSourceName);

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

    const { store, arr, index } = findRawIndex(dataSourceName, entryId);
    if (!store || !arr || index === -1) {
        return false;
    }

    // Store original entry for rollback
    const originalEntry = arr[index];

    // Local write: splice the tracked array, sync
    const ds = window.ManifestDataStore;
    store[dataSourceName].splice(index, 1);
    ds.noteLocalWrite(dataSourceName, entryId, { removed: true });
    ds.touchSource(dataSourceName);
    clearSourceCaches(dataSourceName);

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
            // Snapshot for rollback (the row itself is mutated in place)
            const store = Alpine.store('data');
            if (store && store[dataSourceName] && Array.isArray(store[dataSourceName])) {
                const found = store[dataSourceName].find(e => e.$id === entryId);
                originalData = found ? { ...found } : null;
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
            // Snapshot for rollback
            const store = Alpine.store('data');
            if (store && store[dataSourceName] && Array.isArray(store[dataSourceName])) {
                const found = store[dataSourceName].find(e => e.$id === entryId);
                originalData = found ? { ...found } : null;
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
                // Ack: swap the temp row for the server row in place (new $id → new $files binding)
                const { store, arr, index } = findRawIndex(dataSourceName, optimisticData.$id);
                if (store && arr) {
                    if (index !== -1) {
                        const ds = window.ManifestDataStore;
                        store[dataSourceName].splice(index, 1, ds.createReactiveReferences(result, dataSourceName));
                        ds.touchSource(dataSourceName);
                        clearSourceCaches(dataSourceName);
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


