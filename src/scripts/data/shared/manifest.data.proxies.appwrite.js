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

                    // Get view URL using Appwrite SDK (a URL STRING, not the
                    // file content). Using 'view' rather than 'download' since
                    // we're re-uploading rather than saving to disk.
                    const viewUrl = await window.ManifestDataAppwrite.getFileURL(bucketId, actualFileId);

                    // Authenticate the fetch for permissioned buckets.
                    //
                    // Storage's /view, /download and /preview endpoints check
                    // the USER SESSION — not API/dev keys (those work only on
                    // JSON endpoints like /storage/buckets/.../files/.../).
                    // In localhost dev the browser blocks the cross-domain
                    // session cookie (SameSite=Lax on plain HTTP), so the
                    // request lands at Appwrite as anonymous and a permissioned
                    // file returns 404 storage_file_not_found.
                    //
                    // The Appwrite Web SDK works around this by writing the
                    // session token to localStorage under `cookieFallback`
                    // and replaying it as the `X-Fallback-Cookies` header on
                    // every SDK request. That's why SDK calls (getFile metadata
                    // above, listRows, $create, etc.) succeed cross-domain
                    // while raw fetch() doesn't — raw fetch doesn't know to
                    // read that localStorage key.
                    //
                    // We do exactly what the SDK does: read cookieFallback
                    // and attach it as X-Fallback-Cookies. This is more
                    // reliable than JWT:
                    //   - no createJWT round-trip (and dev-key-configured
                    //     clients 501 on createJWT)
                    //   - no 15-min expiry or rate limit (10/hour/account)
                    //   - matches whatever auth the SDK is already using
                    //
                    // Falls through to credentials-only when the user isn't
                    // signed in (no cookieFallback in storage) — that path
                    // still works in production with a SameSite=None cookie.
                    const fetchHeaders = {};
                    if (appwriteConfig.projectId) {
                        fetchHeaders['X-Appwrite-Project'] = appwriteConfig.projectId;
                    }
                    try {
                        const cookieFallback = typeof localStorage !== 'undefined'
                            ? localStorage.getItem('cookieFallback')
                            : null;
                        if (cookieFallback) {
                            fetchHeaders['X-Fallback-Cookies'] = cookieFallback;
                        }
                    } catch { /* localStorage access denied — fall through */ }

                    const response = await fetch(viewUrl, {
                        method: 'GET',
                        credentials: 'include', // Carry session cookie when available
                        headers: fetchHeaders
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

