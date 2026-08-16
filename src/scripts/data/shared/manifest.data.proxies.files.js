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
            console.error('[Manifest Data] Error recomputing files:', err);
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
                            console.error('[Manifest Data] Failed to load files after fileIds change:', err);
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
                            console.error('[Manifest Data] Failed to reload files after sync check:', err);
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
        console.warn('[Manifest Data] Found missing fileIds in database entry:', {
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
                            console.warn('[Manifest Data] Could not unlink from', tableName, 'entry', entry.$id, ':', error.message);
                        })
                );
            }
        } catch (error) {
            // Silently continue - not all tables may have fileIds
            console.warn('[Manifest Data] Could not process', tableName, ':', error.message);
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