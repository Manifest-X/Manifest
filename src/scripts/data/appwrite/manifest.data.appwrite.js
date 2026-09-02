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

// Auth pre-flight: one shared account.get() in flight; a pass is cached until auth state changes
let authCheck = null;
let authVerified = false;
['manifest:auth:login', 'manifest:auth:logout', 'manifest:auth:anonymous', 'manifest:auth:session-cleared', 'manifest:auth:initialized']
    .forEach(type => window.addEventListener(type, () => { authCheck = null; authVerified = false; }));

async function verifyAuthenticated() {
    if (!window.ManifestAppwriteAuthConfig || authVerified) return;
    if (!authCheck) {
        authCheck = (async () => {
            const { client } = await window.ManifestAppwriteAuthConfig.getAppwriteClient();
            if (!client || !window.Appwrite?.Account) return true;
            try {
                await new window.Appwrite.Account(client).get();
            } catch (error) {
                if (error?.code === 401) return false;
            }
            authVerified = true; // Anonymous / API-key access proceeds too
            return true;
        })().catch(() => true).finally(() => { authCheck = null; });
    }
    if (!(await authCheck)) {
        throw new Error('[Manifest Data] User not authenticated. Please sign in to Appwrite first.');
    }
}

// Load rows from Appwrite table
async function loadTableRows(databaseId, tableId, queries = []) {
    const services = await getAppwriteDataServices();
    if (!services?.tablesDB) {
        throw new Error('[Manifest Data] Appwrite TablesDB service not available');
    }

    await verifyAuthenticated();

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
