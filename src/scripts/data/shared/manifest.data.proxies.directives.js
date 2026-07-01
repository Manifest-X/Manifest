/* Manifest Data Sources - Directives */
// x-files / x-data-files: reactive file arrays for a table entry
function registerFilesDirective() {
    if (typeof Alpine === 'undefined') {
        const checkAlpine = setInterval(() => {
            if (typeof Alpine !== 'undefined') {
                clearInterval(checkAlpine);
                registerFilesDirective();
            }
        }, 10);
        setTimeout(() => clearInterval(checkAlpine), 5000);
        return;
    }

    // Walk up to the nearest parent x-for template
    function findParentXFor(el) {
        let current = el;
        while (current) {
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

    // "item in $x.source" -> "item"
    function extractLoopItemName(xForExpression) {
        const match = xForExpression.match(/^(\w+)\s+in\s+/);
        return match ? match[1] : null;
    }

    Alpine.directive('files', (el, { expression, modifiers }, { effect, evaluateLater, cleanup }) => {

        // A bare identifier is a data-source name (string literal), not an expression
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

        // Seed scope state synchronously (before Alpine evaluates expressions),
        // not in an effect, so the variables exist on first evaluation.
        let scope;
        try {
            scope = Alpine.$data(el);
        } catch (e) {
            scope = null; // not ready — seed in the effect instead
        }

        if (scope) {
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

    // x-data-files="entry": provides files/loadingFiles/filesError for a table entry.
    // Per-element namespace via WeakMap for full isolation.
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

        const directiveInstanceId = `directive-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Isolated reactive scope layer for this instance. Editing x-data won't
        // work (Alpine never re-reads it on initialized nodes) and would pollute
        // the ancestor scope — addScopeToNode attaches a fresh layer instead.
        const isolatedData = Alpine.reactive({
            files: [],
            loadingFiles: false,
            filesError: null
        });
        const removeIsolatedScope = Alpine.addScopeToNode(el, isolatedData);
        cleanupCallbacks.push(removeIsolatedScope);

        // Merged view: files/* writes hit isolatedData (top of stack); $watch etc. resolve from ancestors
        const scope = Alpine.$data(el);

        // Store reference in WeakMap for access in closures
        dataFilesNamespaces.set(el, isolatedData);

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

                    // Fresh array so instances don't share references
                    const newFilesArray = [...loadedFiles];

                    files = newFilesArray;

                    const ns = getNamespace();
                    if (ns) {
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


                    // Track what we actually loaded (Appwrite is truth, store may be stale)
                    const loadedFileIdsArray = loadedFiles.map(f => f.$id) || [];
                    lastFileIds = JSON.stringify(loadedFileIdsArray);

                    // Reconcile stale fileIds in both the store and the Appwrite row
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

                                // Only write the DB if actually stale — avoids a
                                // realtime event that could overwrite our store update
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
            evaluateEntry((value) => {
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

                // Watch this project's fileIds via the store (one watch per project id)
                if (currentProjectId && scope && typeof scope.$watch === 'function' && !fileIdsWatchUnwatch && !watchCreated) {
                    watchCreated = true;
                    const projectId = currentProjectId; // capture for closure
                    let isProcessing = false;

                    // Initialize lastFileIds with current value from the store to prevent false positives
                    const store = Alpine.store('data');
                    const projects = store?.projects;
                    if (Array.isArray(projects)) {
                        const currentProject = projects.find(p => p.$id === projectId);
                        if (currentProject) {
                            lastFileIds = JSON.stringify(currentProject.fileIds || []);
                        }
                    }

                    // Function watch (more reliable than a string expr for nested store access);
                    // reads only this project's fileIds to keep reactivity narrow.
                    fileIdsWatchUnwatch = scope.$watch(
                        () => {
                            const store = Alpine.store('data');
                            const projects = store?.projects;
                            if (!Array.isArray(projects)) return null;

                            const currentProject = projects.find(p => p.$id === projectId);
                            if (!currentProject) return null;

                            return JSON.stringify(currentProject.fileIds || []);
                        },
                        (currentFileIdsJson) => {
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
            const fileId = e.detail?.fileId;
            const entryId = e.detail?.entryId;
            const tableName = e.detail?.tableName;

            // Match on the event's entryId (store may be stale)
            const matchesProject = entryId === projectId && tableName === 'projects';

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

// Auto-registration handled elsewhere; kept for reference.
// if (typeof document !== 'undefined') {
//     if (typeof Alpine !== 'undefined') {
//         registerFilesDirective();
//     } else {
//         document.addEventListener('alpine:init', () => {
//             registerFilesDirective();
//         });
//     }
// }