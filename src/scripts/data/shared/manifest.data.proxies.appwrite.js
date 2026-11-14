/* Manifest Data Sources - Appwrite Methods Handler */
// CRUD/storage methods handler for Appwrite tables and buckets
function createAppwriteMethodsHandler(dataSourceName, reloadDataSource) {
    const setErrorState = (error) => {
        const store = Alpine.store('data');
        if (store) {
            const stateKey = `_${dataSourceName}_state`;
            const currentState = store[stateKey] || { loading: false, error: null, ready: false };
            // State-only write, in place (never replace the store object)
            store[stateKey] = {
                ...currentState,
                error: error?.message || error || 'Operation failed',
                errorTime: Date.now()
            };
        }
        console.error(`[Manifest Data] ${dataSourceName} operation failed:`, error);
    };

    const clearErrorState = () => {
        const store = Alpine.store('data');
        if (store) {
            const stateKey = `_${dataSourceName}_state`;
            const currentState = store[stateKey];
            if (currentState?.error) {
                store[stateKey] = { ...currentState, error: null, errorTime: null };
            }
        }
    };

    // Core handler (named so $duplicate etc. can recurse)
    const handleMethod = async function (method, ...args) {
        const sourceUnloaded = args[3]?.sourceUnloaded === true;
        if (!sourceUnloaded) clearErrorState();
        // Reads are ordered by call, not by network start: the last-issued one lands
        let readToken = method === '$query' ? window.ManifestDataStore?.beginRead?.(dataSourceName) : undefined;
        // Recorded at call time: a lazy first load started after this defers to it
        const queryIntentRef = method === '$query' ? { queries: args[0] ?? [] } : null;
        if (queryIntentRef) window.ManifestDataMain?.noteQueryIntent?.(dataSourceName, queryIntentRef);

        try {
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
            const scopeColumns = window.ManifestDataConfig.getScopeColumns(dataSource);

            // Handle table operations (TablesDB)
            if (tableId) {
                if (method === '$create') {
                    const [data, rowId] = args;

                    // Auto-inject userId and/or teamId (or their configured scopeColumn) based on scope and config
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
                        if (userId && !enrichedData[scopeColumns.user]) {
                            enrichedData[scopeColumns.user] = userId;
                        }
                    }

                    // Inject teamId if team scope is active and enabled
                    if (autoInject.teamId && hasTeamScope) {
                        const teamId = authStore?.currentTeam?.$id || authStore?.currentTeam?.id;
                        if (teamId && !enrichedData[scopeColumns.team]) {
                            enrichedData[scopeColumns.team] = teamId;
                        }
                    }

                    // Optimistic mutation path
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
                        // Batch: ids (or rows) sharing `data`, or [{ id, data }] entries
                        const updates = idOrArray.map(update => (update !== null && typeof update === 'object')
                            ? { id: update.$id || update.id || update.rowId, data: update.data || data || update }
                            : { id: update, data });
                        if (updates.some(u => u.id === undefined || u.id === null || u.id === '' || u.data === undefined)) {
                            throw new Error(`[Manifest Data] "${dataSourceName}" $update: batch entries need an id and data`);
                        }
                        if (executeMutation) {
                            // Use optimistic updates for batch
                            const results = await Promise.all(
                                updates.map(update => {
                                    const entryId = update.id;
                                    const updateData = update.data;
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
                                        update.id,
                                        update.data
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
                    let [queries] = args;
                    if (typeof queries === 'string') {
                        const named = dataSource.queries && !Array.isArray(dataSource.queries) ? dataSource.queries[queries] : undefined;
                        if (!Array.isArray(named)) {
                            throw new Error(`[Manifest Data] "${dataSourceName}" has no query named "${queries}"`);
                        }
                        queries = named;
                    }
                    window.ManifestDataStore?.setSourceState?.(dataSourceName, { loading: true });
                    // A $auth. value or scope not resolved yet: wait for auth once, then run
                    const build = () => window.ManifestDataQueries.buildAppwriteQueries(queries || [], scope, scopeColumns);
                    let appwriteQueries = await build();
                    if (appwriteQueries === null) {
                        const waiting = window.ManifestDataMain?.awaitingQueries;
                        waiting?.add(dataSourceName);
                        try {
                            await window.ManifestDataMain?.waitForAuthChange?.();
                            // Let any reload of this source already running finish, then run as the newest read
                            window.ManifestDataStore?.endRead?.(dataSourceName, readToken);
                            await window.ManifestDataMain?.settledReads?.(dataSourceName);
                        } finally {
                            waiting?.delete(dataSourceName);
                        }
                        readToken = window.ManifestDataStore?.beginRead?.(dataSourceName);
                        window.ManifestDataStore?.setSourceState?.(dataSourceName, { loading: true });
                        appwriteQueries = await build();
                    }
                    if (appwriteQueries === null) {
                        throw new Error(`[Manifest Data] "${dataSourceName}" $query: auth not ready — sign in, or check the $auth. values in its queries`);
                    }
                    // Dedupe key: source + serialized queries (never across different queries)
                    const key = `${dataSourceName}:$query:${JSON.stringify(appwriteQueries.map(q => String(q)))}`;
                    const { runDeduped, landRows, sourceGeneration, isLatestRead } = window.ManifestDataStore || {};
                    const generation = sourceGeneration?.(dataSourceName);
                    const requireAuth = window.ManifestDataMain?.requiresIdentity?.({ ...dataSource, queries: [dataSource.queries, queries] }) ?? true;
                    // Paged sources: the new filter set starts again at its first window (or walks all)
                    const main = window.ManifestDataMain;
                    const spec = main?.pagingSpec?.(dataSource);
                    const want = spec ? main.pagedWant(dataSourceName, spec) : 0;
                    let paged = null;
                    const run = spec
                        ? async () => {
                            const fetchPaged = () => main.fetchPagedRows(dataSourceName, queries || [], {
                                want,
                                isCurrent: () => !isLatestRead || isLatestRead(dataSourceName, readToken)
                            });
                            paged = await fetchPaged();
                            if (paged === null) { await main.waitForAuthChange(); paged = await fetchPaged(); }
                            if (paged === null) throw new Error(`[Manifest Data] "${dataSourceName}" $query: auth not ready yet — retry after auth settles`);
                            return paged.rows;
                        }
                        : () => (main?.withRetry || ((_, fn) => fn()))(dataSource, () => window.ManifestDataAppwrite.loadTableRows(
                            appwriteConfig.databaseId,
                            tableId,
                            appwriteQueries,
                            { requireAuth }
                        ), () => sourceGeneration?.(dataSourceName) === generation); // shared by identical calls: stop only on a reset
                    const result = (runDeduped && !spec) ? await runDeduped(key, run) : await run();
                    // Network landing: query result replaces the source (coalesced, identity-preserving);
                    // only the last-issued read of this source lands
                    const latest = !isLatestRead || isLatestRead(dataSourceName, readToken);
                    if (result !== undefined && landRows && latest && sourceGeneration?.(dataSourceName) === generation) {
                        window.ManifestDataMain?.setActiveQuery?.(dataSourceName, queries || [], Array.isArray(result) ? result.length : 0);
                        if (paged) main.setPagingState(dataSourceName, { ...paged, spec }, { filters: queries || [] });
                        await landRows(dataSourceName, result, { mode: 'replace', fresh: true, generation, readToken });
                    }
                    return result;
                }
            }

            // Handle storage operations
            if (bucketId) {
                // $delete / $remove: delete each file, land successes locally, then unlink them
                const deleteBucketFiles = async (fileId) => {
                    const ids = (Array.isArray(fileId) ? fileId : [fileId]).map(id => id?.$id || id);
                    if (Array.isArray(fileId) && !ids.length) return [];
                    if (ids.some(id => !id)) {
                        throw new Error(`[Manifest Data] ${method} requires file ID`);
                    }
                    const ds = window.ManifestDataStore;
                    const generation = ds?.sourceGeneration?.(dataSourceName);
                    const executeMutation = window.ManifestDataMutations?.executeMutation;
                    const deleteOne = id => executeMutation
                        ? executeMutation({
                            type: 'delete',
                            dataSourceName,
                            entryId: id,
                            apiCall: () => window.ManifestDataAppwrite.deleteFile(bucketId, id),
                            options: { scope, bucketId, appwriteConfig }
                        })
                        : window.ManifestDataAppwrite.deleteFile(bucketId, id);

                    const settled = await Promise.allSettled(ids.map(deleteOne));
                    const deleted = ids.filter((id, i) => settled[i].status === 'fulfilled');

                    // Never a relist: an unfiltered listing would bypass the source's queries and scope
                    if (deleted.length && ds?.landRemove) {
                        await ds.landRemove(dataSourceName, deleted, { generation });
                    }

                    // Unlink only what the server deleted
                    const unlink = window.ManifestDataProxiesFiles?.unlinkFileFromAllEntries;
                    const affected = await Promise.all(deleted.map(async id => {
                        try {
                            return unlink ? await unlink(id, { bucketId }) || {} : {};
                        } catch (unlinkError) {
                            console.warn('[Manifest Data] Failed to unlink deleted file from entries:', unlinkError);
                            return {};
                        }
                    }));

                    const tables = new Set(affected.flatMap(entries => Object.keys(entries)));
                    const reloadDataSourceFunc = window.ManifestDataMain?._loadDataSource;
                    if (reloadDataSourceFunc) {
                        for (const tableName of tables) {
                            reloadDataSourceFunc(tableName).catch(err => {
                                console.warn(`[Manifest Data] Failed to reload ${tableName} after file delete:`, err);
                            });
                        }
                    }

                    deleted.forEach((id, i) => {
                        const linked = Object.entries(affected[i]).filter(([, entryIds]) => Array.isArray(entryIds) && entryIds.length);
                        for (const [tableName, entryIds] of linked.length ? linked : [[null, []]]) {
                            window.dispatchEvent(new CustomEvent('manifest:file-deleted', { detail: { fileId: id, tableName, entryIds } }));
                        }
                        window.dispatchEvent(new CustomEvent('manifest:file-deleted', { detail: { fileId: id, tableName: null, entryIds: [], bucketId } }));
                    });

                    const failed = settled.find(r => r.status === 'rejected');
                    if (failed) throw failed.reason;
                    const results = settled.map(r => r.value);
                    return Array.isArray(fileId) ? results : results[0];
                };

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

                    // The 4th arg may be $upload's options object, not a callback
                    const validOnProgress = typeof onProgress === 'function' ? onProgress : undefined;

                    // Use optimistic update via mutation system
                    const addEntryToStore = sourceUnloaded ? null : window.ManifestDataMutations?.addEntryToStore;
                    const removeEntryFromStore = sourceUnloaded ? null : window.ManifestDataMutations?.removeEntryFromStore;
                    const writeOptions = { generation: window.ManifestDataStore?.sourceGeneration?.(dataSourceName) };
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
                        addEntryToStore(dataSourceName, optimisticFile, writeOptions);
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
                            removeEntryFromStore(dataSourceName, optimisticFile.$id, writeOptions);
                        }
                        throw error;
                    }

                    // Replace optimistic file with real one from server
                    if (optimisticFile && addEntryToStore && removeEntryFromStore) {
                        // Remove optimistic entry
                        removeEntryFromStore(dataSourceName, optimisticFile.$id, writeOptions);
                        // Add real entry
                        addEntryToStore(dataSourceName, result, writeOptions);
                    } else if (addEntryToStore) {
                        // If no optimistic update was done, add now
                        addEntryToStore(dataSourceName, result, writeOptions);
                    }

                    // Link the uploaded file to a table entry, resolved from the
                    // options object (4th arg), the legacy 5th-arg id, or belongsTo.
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

                    // The source may have landed during the upload, from a list without this file
                    if (sourceUnloaded && window.ManifestDataStore?.getRawData?.(dataSourceName) != null) {
                        const landed = window.ManifestDataStore.getRawData(dataSourceName);
                        if (!Array.isArray(landed) || !landed.some(row => row.$id === result.$id)) {
                            window.ManifestDataMutations?.addEntryToStore?.(dataSourceName, result, writeOptions);
                        }
                    }

                    // We already have the real file from the API response, so no
                    // background reload; scope filtering (if any) is handled by realtime.
                    if (!addEntryToStore && !sourceUnloaded) {
                        // Fallback: reload lands through loadDataSource (coalesced landing)
                        if (window.ManifestDataStore?.dataSourceCache) {
                            const cacheKey = `${dataSourceName}:en`;
                            window.ManifestDataStore.dataSourceCache.delete(cacheKey);
                        }
                        clearAccessCache(dataSourceName);
                        await reloadDataSource(dataSourceName);
                    }

                    return result;
                } else if (method === '$delete') {
                    return await deleteBucketFiles(args[0]);
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

                    // 'view' URL (a string, not the bytes) since we re-upload rather than save to disk
                    const viewUrl = await window.ManifestDataAppwrite.getFileURL(bucketId, actualFileId);

                    // Storage /view checks the user SESSION, not API/dev keys. In
                    // localhost dev the cross-domain session cookie is blocked
                    // (SameSite=Lax on HTTP) so a raw fetch lands anonymous → 404.
                    // Replicate the SDK's workaround: replay the `cookieFallback`
                    // localStorage token as X-Fallback-Cookies. Falls through to
                    // credentials-only when signed out (works in prod via SameSite=None).
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
                        const url = await handleMethod('$url', fileId, token);
                        if (!url) {
                            throw new Error('[Manifest Data] No URL returned from $url');
                        }
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
                        const url = await handleMethod('$preview', fileId, options);
                        if (!url) {
                            throw new Error('[Manifest Data] No URL returned from $preview');
                        }
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
                        const url = await handleMethod('$download', fileId, token);
                        if (!url) {
                            throw new Error('[Manifest Data] No URL returned from $download');
                        }
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
                    return await deleteBucketFiles(args[0]);
                }
            }

            throw new Error(`[Manifest Data] Method "${method}" not supported for this data source`);
        } catch (error) {
            // Automatically set error state - no need for inline .catch() in HTML
            setErrorState(error);
            // Re-throw so promise chain still works if caller wants to handle it
            throw error;
        } finally {
            // In flight no longer: landed, it shows as the active query; failed, it never shows
            if (queryIntentRef) window.ManifestDataMain?.dropQueryIntent?.(dataSourceName, queryIntentRef);
            if (readToken !== undefined) {
                const ds = window.ManifestDataStore;
                ds?.endRead?.(dataSourceName, readToken);
                if (!ds?.readsInFlight?.(dataSourceName)) ds?.setSourceState?.(dataSourceName, { loading: false });
            }
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

