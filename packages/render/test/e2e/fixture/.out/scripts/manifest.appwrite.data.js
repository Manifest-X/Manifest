/* Manifest Data Sources - Appwrite Integration */

// Cache for Appwrite client (initialized once)
let appwriteClientCache = null;
let appwriteClientPromise = null;

// Initialize Appwrite client (supports both auth plugin and standalone)
async function initializeAppwriteClient() {
    // Return cached client if available
    if (appwriteClientCache) {
        return appwriteClientCache;
    }

    // Return existing promise if initialization in progress
    if (appwriteClientPromise) {
        return appwriteClientPromise;
    }

    // Check if Appwrite SDK is loaded
    if (!window.Appwrite || !window.Appwrite.Client) {
        console.warn('[Manifest Data] Appwrite SDK not loaded');
        return null;
    }

    appwriteClientPromise = (async () => {
        try {
            // Try to get client from auth plugin first (if available)
            if (window.ManifestAppwriteAuthConfig) {
                try {
                    const { client } = await window.ManifestAppwriteAuthConfig.getAppwriteClient();
                    if (client) {
                        appwriteClientCache = client;
                        return client;
                    }
                } catch (e) {
                }
            }

            // Fallback: Initialize client from manifest config
            if (!window.ManifestDataConfig) {
                console.warn('[Manifest Data] ManifestDataConfig not available');
                return null;
            }

            const manifest = await window.ManifestDataConfig.ensureManifest();
            if (!manifest?.appwrite) {
                console.warn('[Manifest Data] Appwrite config not found in manifest');
                return null;
            }

            const config = manifest.appwrite;
            const projectId = window.ManifestDataConfig.interpolateEnvVars(config.projectId);
            const endpoint = window.ManifestDataConfig.interpolateEnvVars(config.endpoint);

            if (!projectId || !endpoint) {
                console.warn('[Manifest Data] Appwrite projectId or endpoint missing from manifest');
                return null;
            }

            // Initialize client with project ID and endpoint
            const client = new window.Appwrite.Client()
                .setEndpoint(endpoint)
                .setProject(projectId);

            // If devKey is provided, set it (for server-side operations)
            // Note: setKey may not be available in all Appwrite SDK versions
            if (config.devKey) {
                const devKey = window.ManifestDataConfig.interpolateEnvVars(config.devKey);
                if (devKey && typeof client.setKey === 'function') {
                    client.setKey(devKey);
                } else if (devKey) {
                    console.warn('[Manifest Data] client.setKey is not available in this Appwrite SDK version');
                }
            }

            appwriteClientCache = client;
            return client;
        } catch (error) {
            console.error('[Manifest Data] Failed to initialize Appwrite client:', error);
            appwriteClientPromise = null; // Reset on error
            return null;
        }
    })();

    return appwriteClientPromise;
}

// Get Appwrite data services (TablesDB, Storage, Realtime)
// Works with or without auth plugin
async function getAppwriteDataServices() {
    const client = await initializeAppwriteClient();
    if (!client) {
        return null;
    }

    return {
        tablesDB: window.Appwrite.TablesDB ? new window.Appwrite.TablesDB(client) : null,
        storage: window.Appwrite.Storage ? new window.Appwrite.Storage(client) : null,
        realtime: window.Appwrite.Realtime ? new window.Appwrite.Realtime(client) : null
    };
}

// Load rows from Appwrite table
async function loadTableRows(databaseId, tableId, queries = []) {
    const services = await getAppwriteDataServices();
    if (!services?.tablesDB) {
        throw new Error('[Manifest Data] Appwrite TablesDB service not available');
    }

    // Optional: Verify authentication if auth plugin is available
    // Skip if using API key or anonymous access
    if (window.ManifestAppwriteAuthConfig) {
        try {
            const { client } = await window.ManifestAppwriteAuthConfig.getAppwriteClient();
            if (client && window.Appwrite?.Account) {
                const account = new window.Appwrite.Account(client);
                try {
                    await account.get(); // This will throw if not authenticated
                } catch (authError) {
                    // Only throw if auth plugin is being used - otherwise allow anonymous/API key access
                    if (authError.code === 401) {
                        throw new Error('[Manifest Data] User not authenticated. Please sign in to Appwrite first.');
                    }
                }
            }
        } catch (authCheckError) {
            // If auth check fails, still try the request (might be anonymous access or API key)
            if (authCheckError.message?.includes('not authenticated')) {
                throw authCheckError;
            }
        }
    }

    try {
        const response = await services.tablesDB.listRows({
            databaseId,
            tableId,
            queries
        });
        return response.rows;
    } catch (error) {
        // Provide helpful error message for 401 errors
        if (error?.code === 401 || error?.message?.includes('401') || error?.message?.includes('not authorized')) {
            const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
            const isAuthenticated = authStore?.isAuthenticated;
            const errorMsg = isAuthenticated
                ? 'Table permissions issue: Your user account may not have the required permissions for this table. Check the table permissions in Appwrite console.'
                : 'Authentication required: Please sign in to Appwrite first.';
            throw new Error(errorMsg);
        }
        // Only log non-auth errors to reduce noise
        if (error?.code !== 401 && error?.message?.includes('401') === false) {
            console.error('[Manifest Data] Failed to load table rows:', error);
        }
        throw error;
    }
}

// Get a single row from Appwrite table
async function getTableRow(databaseId, tableId, rowId) {
    const services = await getAppwriteDataServices();
    if (!services?.tablesDB) {
        throw new Error('[Manifest Data] Appwrite TablesDB service not available');
    }

    try {
        const response = await services.tablesDB.getRow({
            databaseId,
            tableId,
            rowId
        });
        return response;
    } catch (error) {
        console.error('[Manifest Data] Failed to get table row:', error);
        throw error;
    }
}

// Create row in Appwrite table
async function createRow(databaseId, tableId, data, rowId = null) {
    const services = await getAppwriteDataServices();
    if (!services?.tablesDB) {
        throw new Error('[Manifest Data] Appwrite TablesDB service not available');
    }

    try {
        // If rowId is provided, use it; otherwise Appwrite will auto-generate
        const params = {
            databaseId,
            tableId,
            data
        };

        if (rowId) {
            params.rowId = rowId;
        } else if (window.Appwrite?.ID?.unique) {
            // Use Appwrite's ID.unique() helper if available
            params.rowId = window.Appwrite.ID.unique();
        }

        return await services.tablesDB.createRow(params);
    } catch (error) {
        console.error('[Manifest Data] Failed to create row:', error);
        throw error;
    }
}

// Update row in Appwrite table
async function updateRow(databaseId, tableId, rowId, data) {
    const services = await getAppwriteDataServices();
    if (!services?.tablesDB) {
        throw new Error('[Manifest Data] Appwrite TablesDB service not available');
    }

    try {
        return await services.tablesDB.updateRow({
            databaseId,
            tableId,
            rowId,
            data
        });
    } catch (error) {
        console.error('[Manifest Data] Failed to update row:', error);
        throw error;
    }
}

// Delete row from Appwrite table
async function deleteRow(databaseId, tableId, rowId) {
    const services = await getAppwriteDataServices();
    if (!services?.tablesDB) {
        throw new Error('[Manifest Data] Appwrite TablesDB service not available');
    }

    try {
        await services.tablesDB.deleteRow({
            databaseId,
            tableId,
            rowId
        });
        return true;
    } catch (error) {
        console.error('[Manifest Data] Failed to delete row:', error);
        throw error;
    }
}

// List files from Appwrite storage bucket
async function listBucketFiles(bucketId, queries = []) {
    const services = await getAppwriteDataServices();
    if (!services?.storage) {
        console.error('[Manifest Data] Appwrite Storage service not available');
        throw new Error('[Manifest Data] Appwrite Storage service not available');
    }

    try {
        const response = await services.storage.listFiles(
            bucketId,
            queries
        );


        // Appwrite returns { files: [...], total: number }
        // Handle both response.files and direct array response (for compatibility)
        let files;
        if (response && typeof response === 'object') {
            if (Array.isArray(response.files)) {
                files = response.files;
            } else if (Array.isArray(response)) {
                // Response is directly an array (unlikely but handle it)
                files = response;
            } else {
                console.warn('[Manifest Data] Unexpected listFiles response structure:', response);
                files = [];
            }
        } else {
            files = [];
        }

        if (!Array.isArray(files)) {
            console.error('[Manifest Data] listBucketFiles returned non-array:', { response, files, type: typeof files });
            return [];
        }

        return files;
    } catch (error) {
        console.error('[Manifest Data] Failed to list bucket files:', error);
        throw error;
    }
}

// Upload file to Appwrite storage bucket
async function createFile(bucketId, fileId, file, permissions = null, onProgress = null) {
    const services = await getAppwriteDataServices();
    if (!services?.storage) {
        throw new Error('[Manifest Data] Appwrite Storage service not available');
    }

    try {
        // Appwrite SDK: permissions must be an array of strings or null/undefined
        // Empty array [] means "no file-level permissions" which Appwrite rejects
        // Pass null/undefined to use bucket-level permissions, or pass array of permission strings
        let validPermissions = null;
        if (permissions !== undefined && permissions !== null) {
            // If permissions is provided, ensure it's an array
            if (Array.isArray(permissions)) {
                // Filter out any null/undefined values and ensure all are strings
                validPermissions = permissions.filter(p => p != null).map(p => String(p));
                // If array becomes empty after filtering, use null instead
                if (validPermissions.length === 0) {
                    validPermissions = null;
                }
            } else {
                // Single permission value
                validPermissions = [String(permissions)];
            }
        }
        // onProgress can be undefined (optional callback)
        const validOnProgress = (onProgress === undefined || onProgress === null) ? undefined : onProgress;

        // Wrap file in InputFile if needed (Appwrite SDK requirement)
        let inputFile = file;
        if (window.Appwrite?.InputFile && !(file instanceof window.Appwrite.InputFile)) {
            // Check if file is a File or Blob object
            if (file instanceof File || file instanceof Blob) {
                try {
                    inputFile = window.Appwrite.InputFile.fromFile(file);
                } catch (e) {
                    // If InputFile.fromFile fails, use file as-is
                    console.warn('[Manifest Data] Could not wrap file in InputFile, using raw file:', e);
                }
            }
        }

        // Appwrite SDK: pass null/undefined to use bucket-level permissions
        // Pass array of permission strings for file-level permissions
        const finalPermissions = validPermissions;

        // Appwrite SDK createFile signature: createFile(bucketId, fileId, file, permissions, onProgress)
        // Note: Bucket must have write permissions for the user/role, file-level permissions are for after creation
        const result = await services.storage.createFile(
            bucketId,
            fileId,
            inputFile,
            finalPermissions, // Array of permission strings or null/undefined
            validOnProgress
        );

        return result;
    } catch (error) {
        console.error('[Manifest Data] Failed to upload file:', error);
        throw error;
    }
}

// Delete file from Appwrite storage bucket
async function deleteFile(bucketId, fileId) {
    const services = await getAppwriteDataServices();
    if (!services?.storage) {
        throw new Error('[Manifest Data] Appwrite Storage service not available');
    }

    try {
        await services.storage.deleteFile(bucketId, fileId);
        return true;
    } catch (error) {
        console.error('[Manifest Data] Failed to delete file:', error);
        throw error;
    }
}

// Get file content as blob using authenticated fetch
// This works around cross-domain cookie issues by using the Appwrite client's authenticated HTTP
async function getFileContentAsBlob(bucketId, fileId, path = 'view', token = null, previewOptions = null) {
    const client = await initializeAppwriteClient();
    if (!client) {
        throw new Error('[Manifest Data] Appwrite client not available');
    }

    if (!bucketId || !fileId) {
        throw new Error('[Manifest Data] Bucket ID and File ID are required');
    }

    // Get endpoint and project ID from config
    let endpoint = null;
    let projectId = null;

    // Try to get from auth plugin config first
    if (window.ManifestAppwriteAuthConfig) {
        try {
            const config = await window.ManifestAppwriteAuthConfig.getAppwriteConfig();
            if (config) {
                endpoint = config.endpoint;
                projectId = config.projectId;
            }
        } catch (e) {
            // Fallback to manifest
        }
    }

    // Fallback to manifest config
    if (!endpoint || !projectId) {
        if (window.ManifestDataConfig) {
            try {
                const manifest = await window.ManifestDataConfig.ensureManifest();
                if (manifest?.appwrite) {
                    endpoint = window.ManifestDataConfig.interpolateEnvVars(manifest.appwrite.endpoint);
                    projectId = window.ManifestDataConfig.interpolateEnvVars(manifest.appwrite.projectId);
                }
            } catch (e) {
                // Error getting config
            }
        }
    }

    if (!endpoint || !projectId) {
        throw new Error('[Manifest Data] Could not determine Appwrite endpoint or project ID');
    }

    // Build the URL with query parameters
    let url = `${endpoint}/storage/buckets/${bucketId}/files/${fileId}/${path}?project=${projectId}`;

    // Add preview options if provided
    if (previewOptions && typeof previewOptions === 'object') {
        Object.keys(previewOptions).forEach(key => {
            if (previewOptions[key] !== null && previewOptions[key] !== undefined) {
                url += `&${key}=${encodeURIComponent(previewOptions[key])}`;
            }
        });
    }

    // Add token if provided
    if (token) {
        url += `&token=${encodeURIComponent(token)}`;
    }

    // Get authentication headers from the client
    // The Appwrite client stores headers that include authentication
    const headers = {
        ...(client.headers || {})
    };

    // Ensure project header is set
    headers['X-Appwrite-Project'] = projectId;

    // Use XMLHttpRequest instead of fetch() - it handles cookies more reliably in cross-domain scenarios
    // This is what the Appwrite SDK uses internally
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.withCredentials = true; // Include cookies
        xhr.responseType = 'blob';

        // Set headers
        Object.keys(headers).forEach(key => {
            xhr.setRequestHeader(key, headers[key]);
        });

        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response);
            } else {
                let errorText = '';
                try {
                    // Try to read error as text if not blob
                    if (xhr.response instanceof Blob) {
                        // Can't easily read blob error messages, but we have status
                        errorText = `HTTP ${xhr.status}`;
                    } else {
                        errorText = xhr.responseText || `HTTP ${xhr.status}`;
                    }
                } catch (e) {
                    errorText = `HTTP ${xhr.status}`;
                }
                console.error('[Manifest Data] File fetch failed:', {
                    status: xhr.status,
                    statusText: xhr.statusText,
                    url,
                    errorText
                });
                reject(new Error(`Failed to fetch file: ${xhr.status} ${xhr.statusText}`));
            }
        };

        xhr.onerror = function () {
            console.error('[Manifest Data] File fetch network error:', { url });
            reject(new Error('Network error while fetching file'));
        };

        xhr.ontimeout = function () {
            console.error('[Manifest Data] File fetch timeout:', { url });
            reject(new Error('Timeout while fetching file'));
        };

        xhr.timeout = 30000; // 30 second timeout
        xhr.send();
    });
}

// Get file URL from Appwrite storage bucket
// Follows Appwrite API documentation exactly: https://appwrite.io/docs/references/cloud/client-web/storage#get-file-for-view
// Optional token parameter for file token-based access (created server-side)
async function getFileURL(bucketId, fileId, token = null) {
    const services = await getAppwriteDataServices();
    if (!services?.storage) {
        throw new Error('[Manifest Data] Appwrite Storage service not available');
    }

    if (!bucketId) {
        throw new Error('[Manifest Data] Bucket ID is required for getFileURL');
    }
    if (!fileId) {
        throw new Error('[Manifest Data] File ID is required for getFileURL');
    }

    try {
        // Follow Appwrite API docs exactly
        const options = {
            bucketId: String(bucketId),
            fileId: String(fileId)
        };
        if (token) {
            options.token = String(token);
        }

        // Appwrite SDK's getFileView returns a URL string
        // Authentication is handled automatically by the SDK via session cookies
        // Note: Third-party cookie issues may occur when app and Appwrite are on different domains
        // See Manifest documentation for storage setup and custom domain configuration
        const url = await services.storage.getFileView(options);
        return url;
    } catch (error) {
        console.error('[Manifest Data] Failed to get file URL:', {
            bucketId,
            fileId,
            error: error?.message || error,
            code: error?.code,
            type: error?.type
        });
        throw error;
    }
}

// Get file download URL from Appwrite storage bucket
// Follows Appwrite API documentation exactly: https://appwrite.io/docs/references/cloud/client-web/storage#get-file-for-download
// Optional token parameter for file token-based access (created server-side)
async function getFileDownload(bucketId, fileId, token = null) {
    const services = await getAppwriteDataServices();
    if (!services?.storage) {
        throw new Error('[Manifest Data] Appwrite Storage service not available');
    }

    if (!bucketId) {
        throw new Error('[Manifest Data] Bucket ID is required for getFileDownload');
    }
    if (!fileId) {
        throw new Error('[Manifest Data] File ID is required for getFileDownload');
    }

    try {
        // Follow Appwrite API docs exactly
        const options = {
            bucketId: String(bucketId),
            fileId: String(fileId)
        };
        if (token) {
            options.token = String(token);
        }

        // Appwrite SDK's getFileDownload returns a URL string
        // Authentication is handled automatically by the SDK via session cookies
        // Note: Third-party cookie issues may occur when app and Appwrite are on different domains
        // See Manifest documentation for storage setup and custom domain configuration
        const url = await services.storage.getFileDownload(options);
        return url;
    } catch (error) {
        console.error('[Manifest Data] Failed to get file download URL:', {
            bucketId,
            fileId,
            error: error?.message || error,
            code: error?.code,
            type: error?.type
        });
        throw error;
    }
}

// Get file preview URL from Appwrite storage bucket
// Options can be:
// - Simple: width, height (numbers) - for backward compatibility
// - Advanced: options object with all Appwrite preview parameters (including token)
// Optional token parameter for file token-based access (created server-side)
async function getFilePreview(bucketId, fileId, widthOrOptions = null, height = null) {
    const services = await getAppwriteDataServices();
    if (!services?.storage) {
        throw new Error('[Manifest Data] Appwrite Storage service not available');
    }

    try {
        // Follow Appwrite API docs exactly
        const options = {
            bucketId: String(bucketId),
            fileId: String(fileId)
        };

        // Handle preview options - support both object and separate width/height params
        if (typeof widthOrOptions === 'object' && widthOrOptions !== null) {
            // Options object - copy all properties as-is (Appwrite SDK will validate)
            Object.assign(options, widthOrOptions);
        } else if (typeof widthOrOptions === 'number') {
            options.width = widthOrOptions;
        }
        if (typeof height === 'number') {
            options.height = height;
        }

        // Appwrite SDK's getFilePreview returns a URL string
        // Authentication is handled automatically by the SDK via session cookies
        // Note: Third-party cookie issues may occur when app and Appwrite are on different domains
        // See Manifest documentation for storage setup and custom domain configuration
        const url = await services.storage.getFilePreview(options);
        return url;
    } catch (error) {
        console.error('[Manifest Data] Failed to get file preview:', {
            bucketId,
            fileId,
            widthOrOptions,
            height,
            error: error?.message || error,
            code: error?.code,
            type: error?.type,
            response: error?.response,
            stack: error?.stack
        });
        throw error;
    }
}

// Export functions to window for use by other subscripts
window.ManifestDataAppwrite = {
    getAppwriteDataServices,
    loadTableRows,
    getTableRow,
    createRow,
    updateRow,
    deleteRow,
    listBucketFiles,
    createFile,
    deleteFile,
    getFileURL,
    getFileDownload,
    getFilePreview,
    getFileContentAsBlob,
    _getAppwriteDataServices: getAppwriteDataServices
};


/* Manifest Data Sources - Real-time Subscriptions */

// Track active subscriptions
const subscriptions = new Map(); // Map<dataSourceName, unsubscribeFunction>

// Subscribe to storage bucket file changes
async function subscribeToStorageBucket(dataSourceName, bucketId, scope, onEvent) {
    // Unsubscribe from existing subscription if any
    if (subscriptions.has(dataSourceName)) {
        const unsubscribe = subscriptions.get(dataSourceName);
        if (unsubscribe && typeof unsubscribe === 'function') {
            unsubscribe();
        }
        subscriptions.delete(dataSourceName);
    }

    const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
    if (!services?.realtime) {
        console.warn('[Manifest Data] Realtime service not available for', dataSourceName);
        return null;
    }

    // Channel format: buckets.[BUCKET_ID].files
    const channel = `buckets.${bucketId}.files`;


    try {
        const unsubscribe = services.realtime.subscribe(channel, (response) => {
            if (!response || !response.events) {
                return;
            }

            // Handle both array and single event formats
            const events = Array.isArray(response.events) ? response.events : [response.events];

            events.forEach(event => {
                if (typeof event !== 'string') return;

                // Payload might be in response.payload or response directly
                const payload = response.payload || response;

                // Handle different event types
                if (event.includes('create') || event.includes('storage.files.create')) {
                    // New file created
                    onEvent('create', payload);
                } else if (event.includes('update') || event.includes('storage.files.update')) {
                    // File updated
                    onEvent('update', payload);
                } else if (event.includes('delete') || event.includes('storage.files.delete')) {
                    // File deleted
                    onEvent('delete', payload);
                }
            });
        });

        subscriptions.set(dataSourceName, unsubscribe);

        return unsubscribe;
    } catch (error) {
        console.error('[Manifest Data] Failed to subscribe to storage bucket:', error);
        return null;
    }
}

// Unsubscribe from a data source
function unsubscribeFromDataSource(dataSourceName) {
    if (subscriptions.has(dataSourceName)) {
        const unsubscribe = subscriptions.get(dataSourceName);
        if (unsubscribe && typeof unsubscribe === 'function') {
            unsubscribe();
        }
        subscriptions.delete(dataSourceName);
    }
}

// Unsubscribe from all data sources
function unsubscribeAll() {
    subscriptions.forEach((unsubscribe, dataSourceName) => {
        if (unsubscribe && typeof unsubscribe === 'function') {
            unsubscribe();
        }
    });
    subscriptions.clear();
}

// Subscribe to database table row changes
async function subscribeToTable(dataSourceName, databaseId, tableId, scope, onEvent) {
    // Unsubscribe from existing subscription if any
    if (subscriptions.has(dataSourceName)) {
        const unsubscribe = subscriptions.get(dataSourceName);
        if (unsubscribe && typeof unsubscribe === 'function') {
            unsubscribe();
        }
        subscriptions.delete(dataSourceName);
    }

    const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
    if (!services?.realtime) {
        console.warn('[Manifest Data] Realtime service not available for', dataSourceName);
        return null;
    }

    // Channel format: databases.[DATABASE_ID].tables.[TABLE_ID].rows
    const channel = `databases.${databaseId}.tables.${tableId}.rows`;

    try {
        const unsubscribe = services.realtime.subscribe(channel, (response) => {
            if (!response || !response.events) {
                return;
            }

            // Handle both array and single event formats
            const events = Array.isArray(response.events) ? response.events : [response.events];

            events.forEach(event => {
                if (typeof event !== 'string') {
                    return;
                }

                // Payload might be in response.payload or response directly
                // Appwrite realtime structure: { events: [...], payload: {...} }
                let payload = response.payload;

                // If payload doesn't have $id, try response directly
                if (!payload || (!payload.$id && !payload.row)) {
                    payload = response;
                }

                // Handle different event types
                if (event.includes('create') || event.includes('rows.create') || event.includes('documents.create')) {
                    // New row created
                    onEvent('create', payload);
                } else if (event.includes('update') || event.includes('rows.update') || event.includes('documents.update')) {
                    // Row updated
                    onEvent('update', payload);
                } else if (event.includes('delete') || event.includes('rows.delete') || event.includes('documents.delete')) {
                    // Row deleted
                    onEvent('delete', payload);
                } else {
                }
            });
        });

        subscriptions.set(dataSourceName, unsubscribe);

        return unsubscribe;
    } catch (error) {
        console.error('[Manifest Data] Failed to subscribe to table:', error);
        return null;
    }
}

// Export functions
window.ManifestDataRealtime = {
    subscribeToStorageBucket,
    subscribeToTable,
    unsubscribeFromDataSource,
    unsubscribeAll,
    subscriptions // Expose for debugging
};


/* Manifest Data Sources - Query Building */

// Whitelist of allowed variables for interpolation
const ALLOWED_VARIABLES = [
    '$auth.userId',
    '$auth.user.$id',
    '$auth.currentTeam.$id',
    '$auth.currentTeam.id',
    '$auth.session.$id',
    '$auth.session.id',
    '$locale.current'
];

// Get auth store value safely
function getAuthValue(path) {
    try {
        const store = Alpine.store('auth');
        if (!store) return null;

        const parts = path.split('.');
        let value = store;

        for (const part of parts) {
            if (value && typeof value === 'object') {
                value = value[part];
            } else {
                return null;
            }
        }

        return value;
    } catch (error) {
        return null;
    }
}

// Debug helper to inspect auth store
function debugAuthStore() {
    try {
        const store = Alpine.store('auth');
        if (!store) {
            return;
        }
        if (store.user) {
        }
    } catch (error) {
        console.error('[Manifest Data Debug] Error inspecting auth store:', error);
    }
}

// Get locale value safely
function getLocaleValue() {
    try {
        const store = Alpine.store('locale');
        return store?.current || null;
    } catch (error) {
        return null;
    }
}

// Interpolate variables in a value
function interpolateVariable(value) {
    if (typeof value !== 'string') return value;

    // Check if it's a variable reference
    if (value.startsWith('$auth.')) {
        const path = value.substring(1); // Remove leading $
        return getAuthValue(path);
    } else if (value === '$locale.current') {
        return getLocaleValue();
    }

    return value;
}

// Check if a string is a variable that needs interpolation
// Variables follow patterns like $auth.xxx, $locale.xxx
// Appwrite system fields like $id, $createdAt, $updatedAt are NOT variables
function isVariable(str) {
    if (typeof str !== 'string' || !str.startsWith('$')) {
        return false;
    }
    // Variables have a namespace prefix (e.g., $auth, $locale)
    // Appwrite system fields are just $fieldName (no dot)
    return str.includes('.') || ALLOWED_VARIABLES.includes(str);
}

// Interpolate variables in query array
function interpolateQuery(query) {
    if (!Array.isArray(query) || query.length === 0) {
        return query;
    }

    const [method, ...args] = query;
    const interpolatedArgs = args.map(arg => {
        if (typeof arg === 'string' && isVariable(arg)) {
            // Check if it's in the whitelist
            if (ALLOWED_VARIABLES.includes(arg)) {
                return interpolateVariable(arg);
            } else {
                console.warn(`[Manifest Data] Variable "${arg}" is not in whitelist. Allowed:`, ALLOWED_VARIABLES);
                // SECURITY: Return empty string for non-whitelisted variables to prevent injection
                // Empty string will cause query to return no results (safe default)
                return '';
            }
        } else if (typeof arg === 'object' && arg !== null) {
            // Recursively interpolate objects
            return interpolateObject(arg);
        }
        return arg;
    });

    return [method, ...interpolatedArgs];
}

// Interpolate variables in an object
function interpolateObject(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return obj;
    }

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && isVariable(value)) {
            if (ALLOWED_VARIABLES.includes(value)) {
                result[key] = interpolateVariable(value);
            } else {
                console.warn(`[Manifest Data] Variable "${value}" is not in whitelist`);
                // SECURITY: Return empty string for non-whitelisted variables to prevent injection
                // Empty string will cause query to return no results (safe default)
                result[key] = '';
            }
        } else if (typeof value === 'object' && value !== null) {
            result[key] = interpolateObject(value);
        } else {
            result[key] = value;
        }
    }

    return result;
}

// Build queries with scope injection
// SECURITY: Scope queries are ALWAYS prepended to user queries to prevent bypass
async function buildQueries(queriesConfig, scope) {
    if (!queriesConfig || !Array.isArray(queriesConfig)) {
        return [];
    }

    // Interpolate user-provided queries
    const userQueries = queriesConfig.map(query => interpolateQuery(query));

    // SECURITY: Build scope queries FIRST (they will be prepended)
    // This ensures scope restrictions cannot be bypassed by user queries
    const scopeQueries = [];

    // Inject scope-based queries if scope is provided
    // Scope can be:
    // - "user" (uses userId column) - single user
    // - "team" (uses teamId column) - single team (currentTeam)
    // - "teams" (uses teamId column) - all teams user belongs to
    // - ["user", "team"] or ["team", "user"] - dual scope (both userId AND teamId)
    // - ["user", "teams"] - user AND all teams
    if (!scope) {
        return userQueries;
    }

    const scopeArray = Array.isArray(scope) ? scope : [scope];
    const hasUserScope = scopeArray.includes('user');
    const hasTeamScope = scopeArray.includes('team');
    const hasTeamsScope = scopeArray.includes('teams');

    // Wait for auth store to be initialized (shared for all scopes)
    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
    if (authStore && (!authStore._initialized || authStore.isAuthenticated === undefined)) {
        let attempts = 0;
        const maxAttempts = 10; // Wait up to 500ms (10 * 50ms)
        while (attempts < maxAttempts && (!authStore._initialized || authStore.isAuthenticated === undefined)) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
    }

    // Special case: ["user", "team"] or ["user", "teams"] or ["teams", "user"] or ["team", "user"] - use OR logic
    // Show projects that belong to user OR current team OR any of their teams
    // Note: "team" (singular) means currentTeam, "teams" (plural) means all teams in user's teams array
    if (hasUserScope && (hasTeamScope || hasTeamsScope)) {
        const isAuthenticated = authStore?.isAuthenticated === true;
        const user = authStore?.user;
        const teams = authStore?.teams || [];

        const orQueries = [];

        // Add user query
        if (isAuthenticated && user) {
            const userId = getAuthValue('userId') || getAuthValue('user.$id') || getAuthValue('user.id') || user.$id || user.id;
            if (userId) {
                orQueries.push(['equal', 'userId', userId]);
            } else {
            }
        } else {
        }

        // Add team queries
        // If hasTeamScope (singular), use currentTeam only
        // If hasTeamsScope (plural), use all teams in user's teams array
        let teamIds = [];
        if (hasTeamScope) {
            // Single team scope - use currentTeam
            const currentTeamId = authStore?.currentTeam?.$id || authStore?.currentTeam?.id;
            if (currentTeamId) {
                teamIds.push(currentTeamId);
            }
        }
        if (hasTeamsScope) {
            // Multi-team scope - use all teams in user's teams array
            const allTeamIds = teams
                .map(team => team.$id || team.id)
                .filter(id => id);
            teamIds.push(...allTeamIds);
        }

        // Remove duplicates
        teamIds = [...new Set(teamIds)];

        teamIds.forEach(teamId => {
            orQueries.push(['equal', 'teamId', teamId]);
        });

        if (orQueries.length > 0) {
            if (orQueries.length === 1) {
                scopeQueries.push(orQueries[0]);
            } else {
                scopeQueries.push(['or', orQueries]);
            }
        } else {
            // No user or teams - return no results
            scopeQueries.push(['equal', 'userId', '']);
        }
    } else {
        // Handle user scope (when not combined with teams)
        if (hasUserScope) {
            const isAuthenticated = authStore?.isAuthenticated === true;
            const user = authStore?.user;

            if (!isAuthenticated || !user) {
                // User is not authenticated - return no results
                scopeQueries.push(['equal', 'userId', '']);
                // SECURITY: Return early with scope query to prevent any data access
                return scopeQueries;
            }

            // Get user ID value
            const userId = getAuthValue('userId') || getAuthValue('user.$id') || getAuthValue('user.id') || user.$id || user.id;
            if (userId) {
                scopeQueries.push(['equal', 'userId', userId]);
            } else {
                // User is authenticated but userId not found - return no results
                scopeQueries.push(['equal', 'userId', '']);
                if (!window.__manifestDataDebugLogged) {
                    window.__manifestDataDebugLogged = true;
                    debugAuthStore();
                }
            }
        }

        // Handle team scope (single team - takes precedence over teams)
        if (hasTeamScope) {
            // Try multiple paths to get team ID
            const teamId = getAuthValue('currentTeam.$id') ||
                getAuthValue('currentTeam.id') ||
                authStore?.currentTeam?.$id ||
                authStore?.currentTeam?.id;

            if (teamId) {
                scopeQueries.push(['equal', 'teamId', teamId]);
            } else {
                // No team ID found - return no results
                scopeQueries.push(['equal', 'teamId', '']);
            }
        } else if (hasTeamsScope) {
            // Multi-team scope - use all teams user belongs to
            // Get all team IDs from user's teams
            const teams = authStore?.teams || [];
            const teamIds = teams
                .map(team => team.$id || team.id)
                .filter(id => id); // Remove any undefined/null values

            if (teamIds.length > 0) {
                if (teamIds.length === 1) {
                    // Single team - use equal for efficiency
                    scopeQueries.push(['equal', 'teamId', teamIds[0]]);
                } else {
                    // Multiple teams - use Query.or() with multiple Query.equal() calls
                    // Build: Query.or([Query.equal('teamId', id1), Query.equal('teamId', id2), ...])
                    const equalQueries = teamIds.map(id => ['equal', 'teamId', id]);
                    scopeQueries.push(['or', equalQueries]);
                }
            } else {
                // No teams found - return no results
                scopeQueries.push(['equal', 'teamId', '']);
            }
        }
    }

    // SECURITY: Prepend scope queries to user queries
    // This ensures scope restrictions are ALWAYS applied and cannot be bypassed
    // User queries that conflict with scope will be ANDed together (both must match)
    return [...scopeQueries, ...userQueries];
}

// Convert query array to Appwrite Query object
function toAppwriteQuery(queryArray) {
    if (!Array.isArray(queryArray) || queryArray.length === 0) {
        return null;
    }

    const [method, ...args] = queryArray;

    // Map common query methods to Appwrite Query methods
    const queryMap = {
        'equal': 'equal',
        'notEqual': 'notEqual',
        'lessThan': 'lessThan',
        'lessThanEqual': 'lessThanEqual',
        'greaterThan': 'greaterThan',
        'greaterThanEqual': 'greaterThanEqual',
        'contains': 'contains',
        'search': 'search',
        'or': 'or', // Support for multi-team queries (Query.or([Query.equal(...), ...]))
        'orderAsc': 'orderAsc',
        'orderDesc': 'orderDesc',
        'limit': 'limit',
        'offset': 'offset',
        'cursorAfter': 'cursorAfter',
        'cursorBefore': 'cursorBefore'
    };

    if (!window.Appwrite || !window.Appwrite.Query) {
        console.error('[Manifest Data] Appwrite Query not available');
        return null;
    }

    const queryMethod = queryMap[method];
    if (!queryMethod) {
        console.warn(`[Manifest Data] Unknown query method: ${method}`);
        return null;
    }

    try {
        // Special handling for 'or' queries - args[0] should be an array of query arrays
        if (method === 'or' && Array.isArray(args[0])) {
            // Build Query.or([Query.equal(...), Query.equal(...), ...])
            const orQueries = args[0]
                .map(queryArray => toAppwriteQuery(queryArray))
                .filter(query => query !== null);

            if (orQueries.length === 0) {
                return null;
            }

            if (orQueries.length === 1) {
                // Single query - return it directly (no need for or)
                return orQueries[0];
            }

            // Multiple queries - use Query.or()
            return window.Appwrite.Query.or(orQueries);
        }

        return window.Appwrite.Query[queryMethod](...args);
    } catch (error) {
        console.error(`[Manifest Data] Error building query ${method}:`, error);
        return null;
    }
}

// Build Appwrite queries from configuration
async function buildAppwriteQueries(queriesConfig, scope) {
    const queries = await buildQueries(queriesConfig, scope);
    return queries
        .map(query => toAppwriteQuery(query))
        .filter(query => query !== null);
}

// Export functions to window for use by other subscripts
window.ManifestDataQueries = {
    interpolateVariable,
    interpolateQuery,
    interpolateObject,
    buildQueries,
    buildAppwriteQueries,
    toAppwriteQuery,
    ALLOWED_VARIABLES
};


/* Manifest Data Sources - Pagination */

// Pagination helper functions for Appwrite data sources

/**
 * Get first page of results (cursor-based)
 * @param {string} dataSourceName - Name of the data source
 * @param {number} limit - Number of items per page
 * @param {Array} baseQueries - Base queries to apply (from manifest or scope)
 * @returns {Promise<{items: Array, cursor: string|null, total: number, hasMore: boolean}>}
 */
async function getFirstPage(dataSourceName, limit, baseQueries = []) {
    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }

    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }

    // Check if this is an Appwrite data source
    const isAppwriteTable = window.ManifestDataConfig.isAppwriteCollection(dataSource);
    if (!isAppwriteTable) {
        throw new Error(`[Manifest Data] Pagination is only supported for Appwrite data sources`);
    }

    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);

    // Build queries with limit
    const queries = [
        ...baseQueries,
        window.Appwrite.Query.limit(limit)
    ];

    let response;
    if (tableId) {
        // Table pagination - need to call Appwrite directly to get full response with total
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.tablesDB) {
            throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        }

        const appwriteResponse = await services.tablesDB.listRows({
            databaseId: appwriteConfig.databaseId,
            tableId: tableId,
            queries: queries
        });

        const items = appwriteResponse.rows || [];
        const total = appwriteResponse.total || 0;
        const cursor = items.length > 0 ? items[items.length - 1].$id : null;
        const hasMore = items.length === limit && total > limit;

        return {
            items,
            cursor,
            total,
            hasMore
        };
    } else if (bucketId) {
        // Storage pagination
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.storage) {
            throw new Error('[Manifest Data] Appwrite Storage service not available');
        }

        const storageResponse = await services.storage.listFiles(bucketId, queries);
        const items = storageResponse.files || [];
        const total = storageResponse.total || 0;
        const cursor = items.length > 0 ? items[items.length - 1].$id : null;
        const hasMore = items.length === limit && total > limit;

        return {
            items,
            cursor,
            total,
            hasMore
        };
    } else {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
}

/**
 * Get next page of results (cursor-based)
 * @param {string} dataSourceName - Name of the data source
 * @param {string} cursor - Cursor from previous page
 * @param {number} limit - Number of items per page
 * @param {Array} baseQueries - Base queries to apply
 * @returns {Promise<{items: Array, cursor: string|null, total: number, hasMore: boolean}>}
 */
async function getNextPage(dataSourceName, cursor, limit, baseQueries = []) {
    if (!cursor) {
        throw new Error('[Manifest Data] Cursor is required for next page');
    }

    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }

    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }

    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);

    // Build queries with cursorAfter and limit
    const queries = [
        ...baseQueries,
        window.Appwrite.Query.cursorAfter(cursor),
        window.Appwrite.Query.limit(limit)
    ];

    let response;
    if (tableId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.tablesDB) {
            throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        }

        const appwriteResponse = await services.tablesDB.listRows({
            databaseId: appwriteConfig.databaseId,
            tableId: tableId,
            queries: queries
        });

        const items = appwriteResponse.rows || [];
        const total = appwriteResponse.total || 0;
        const newCursor = items.length > 0 ? items[items.length - 1].$id : null;
        const hasMore = items.length === limit && total > limit;

        return {
            items,
            cursor: newCursor,
            total,
            hasMore
        };
    } else if (bucketId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.storage) {
            throw new Error('[Manifest Data] Appwrite Storage service not available');
        }

        const storageResponse = await services.storage.listFiles(bucketId, queries);
        const items = storageResponse.files || [];
        const total = storageResponse.total || 0;
        const newCursor = items.length > 0 ? items[items.length - 1].$id : null;
        const hasMore = items.length === limit && total > (limit * 2); // Rough estimate

        return {
            items,
            cursor: newCursor,
            total,
            hasMore
        };
    } else {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
}

/**
 * Get previous page of results (cursor-based)
 * @param {string} dataSourceName - Name of the data source
 * @param {string} cursor - Cursor from current page
 * @param {number} limit - Number of items per page
 * @param {Array} baseQueries - Base queries to apply
 * @returns {Promise<{items: Array, cursor: string|null, total: number, hasMore: boolean}>}
 */
async function getPrevPage(dataSourceName, cursor, limit, baseQueries = []) {
    if (!cursor) {
        throw new Error('[Manifest Data] Cursor is required for previous page');
    }

    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }

    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }

    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);

    // Build queries with cursorBefore and limit
    const queries = [
        ...baseQueries,
        window.Appwrite.Query.cursorBefore(cursor),
        window.Appwrite.Query.limit(limit)
    ];

    let response;
    if (tableId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.tablesDB) {
            throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        }

        const appwriteResponse = await services.tablesDB.listRows({
            databaseId: appwriteConfig.databaseId,
            tableId: tableId,
            queries: queries
        });

        const items = appwriteResponse.rows || [];
        const total = appwriteResponse.total || 0;
        const newCursor = items.length > 0 ? items[0].$id : null; // First item's ID for going back further
        const hasMore = true; // Can't easily determine if there's a previous page

        return {
            items,
            cursor: newCursor,
            total,
            hasMore
        };
    } else if (bucketId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.storage) {
            throw new Error('[Manifest Data] Appwrite Storage service not available');
        }

        const storageResponse = await services.storage.listFiles(bucketId, queries);
        const items = storageResponse.files || [];
        const total = storageResponse.total || 0;
        const newCursor = items.length > 0 ? items[0].$id : null;
        const hasMore = true;

        return {
            items,
            cursor: newCursor,
            total,
            hasMore
        };
    } else {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
}

/**
 * Get specific page (offset-based)
 * @param {string} dataSourceName - Name of the data source
 * @param {number} pageNumber - Page number (1-based)
 * @param {number} limit - Number of items per page
 * @param {Array} baseQueries - Base queries to apply
 * @returns {Promise<{items: Array, page: number, total: number, totalPages: number, hasMore: boolean}>}
 */
async function getPage(dataSourceName, pageNumber, limit, baseQueries = []) {
    if (pageNumber < 1) {
        throw new Error('[Manifest Data] Page number must be >= 1');
    }

    const manifest = await window.ManifestDataConfig.ensureManifest();
    if (!manifest?.data) {
        throw new Error('[Manifest Data] Manifest not available');
    }

    const dataSource = manifest.data[dataSourceName];
    if (!dataSource) {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" not found`);
    }

    const appwriteConfig = await window.ManifestDataConfig.getAppwriteConfig(dataSource);
    if (!appwriteConfig) {
        throw new Error(`[Manifest Data] Invalid Appwrite configuration for "${dataSourceName}"`);
    }

    const tableId = window.ManifestDataConfig.getAppwriteTableId(dataSource);
    const bucketId = window.ManifestDataConfig.getAppwriteBucketId(dataSource);

    const offset = (pageNumber - 1) * limit;

    // Build queries with offset and limit
    const queries = [
        ...baseQueries,
        window.Appwrite.Query.offset(offset),
        window.Appwrite.Query.limit(limit)
    ];

    let response;
    let total;
    if (tableId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.tablesDB) {
            throw new Error('[Manifest Data] Appwrite TablesDB service not available');
        }

        const appwriteResponse = await services.tablesDB.listRows({
            databaseId: appwriteConfig.databaseId,
            tableId: tableId,
            queries: queries
        });

        const items = appwriteResponse.rows || [];
        total = appwriteResponse.total || 0;
        const totalPages = Math.ceil(total / limit);
        const hasMore = pageNumber < totalPages;

        return {
            items,
            page: pageNumber,
            total,
            totalPages,
            hasMore
        };
    } else if (bucketId) {
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices();
        if (!services?.storage) {
            throw new Error('[Manifest Data] Appwrite Storage service not available');
        }

        const storageResponse = await services.storage.listFiles(bucketId, queries);
        const items = storageResponse.files || [];
        total = storageResponse.total || 0;
        const totalPages = Math.ceil(total / limit);
        const hasMore = pageNumber < totalPages;

        return {
            items,
            page: pageNumber,
            total,
            totalPages,
            hasMore
        };
    } else {
        throw new Error(`[Manifest Data] Data source "${dataSourceName}" is not a table or bucket`);
    }
}

// Export functions
window.ManifestDataPagination = {
    getFirstPage,
    getNextPage,
    getPrevPage,
    getPage
};
