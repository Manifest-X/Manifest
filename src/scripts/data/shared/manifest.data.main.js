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