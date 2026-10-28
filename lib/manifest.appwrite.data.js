/* manifest.appwrite.data.js — built from scripts/data/ */

(function () {

const MANIFEST_BUILD_VERSION = '0.5.217';

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

// Shared Realtime: ONE instance (one socket) per tab, via the cross-plugin
// hub (defined in manifest.data.realtime.js and the auth/presences carriers).
// Auth identity events drop the hub's memo so the next use rebuilds against
// the current session; the hub re-binds live channels.
function getSharedRealtime(client) {
    return window.ManifestRealtimeHub ? window.ManifestRealtimeHub.acquire(client) : null;
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
        realtime: getSharedRealtime(client)
    };
}

// Auth pre-flight: one shared account.get() in flight; a pass is cached until auth state changes
let authCheck = null;
let authVerified = false;
['manifest:auth:login', 'manifest:auth:logout', 'manifest:auth:anonymous', 'manifest:auth:session-cleared', 'manifest:auth:initialized']
    .forEach(type => window.addEventListener(type, () => {
        authCheck = null; authVerified = false; // the hub drops its own Realtime memo on these events
    }));

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

// Load rows from Appwrite table (requireAuth false: no pre-flight, Appwrite permissions decide)
async function loadTableRows(databaseId, tableId, queries = [], { requireAuth = true } = {}) {
    const services = await getAppwriteDataServices();
    if (!services?.tablesDB) {
        throw new Error('[Manifest Data] Appwrite TablesDB service not available');
    }

    if (requireAuth) await verifyAuthenticated();

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


/* Manifest Data Sources - Real-time Subscriptions
   One shared Realtime client per tab — via window.ManifestRealtimeHub, shared
   with the auth and presences plugins so N data sources + auth entities +
   presence ride ONE socket. Subscriptions ref-counted by (channel + canonical
   server-filter set) across sources.

   Appwrite Realtime queries (server-side event filtering), verified against
   the Web SDK and server source 2026-10:
   - Realtime#subscribe(channels, callback, queries?) — queries are per
     subscription (Query strings, ANDed; OR across subscriptions), supported
     ops: equal/notEqual/lessThan(Equal)/greaterThan(Equal)/isNull/isNotNull/
     and/or. SDK >=25.0.0 sends {type:'subscribe', data:[{subscriptionId,
     channels, queries}]} socket messages and dispatches by the matched
     subscription ids the server echoes; 22.4-24 carried per-slot queries in
     the socket URL. subscribe() resolves to {unsubscribe, update, close}.
   - Feature detection: a query-capable instance has pendingSubscribes (>=25)
     or slotToSubscriptionId (22.4-24). Without either marker: channel-only
     subscribe, exactly the 0.5.248 path.
   - The server evaluates queries against the event payload only, so an
     update that makes a held row STOP matching is not delivered. Therefore
     serverFilter defaults to 'scope': only scope-column filters (permission-
     mirrored, effectively immutable) ride the subscription; user queries stay
     client-side so stop-matching rows still drop live. 'all' pushes every
     expressible filter server-side (such rows then correct on the next load);
     false sends none. The client matcher stays on in every mode. */

// mnfst:realtime.hub:start
/* Shared Appwrite Realtime hub — ONE Realtime instance (one socket) per tab
   across the data, auth and presences plugins. The first carrier to load
   defines it; the build syncs this block byte-identical into each carrier
   from scripts/snippets/manifest.realtime.hub.js.

   Subscriptions are keyed by a caller-chosen name and ref-counted by
   (channel + canonical server-filter key); server-side realtime queries ride
   per subscription where the instance supports them (verified SDK/server
   contract: see the manifest.data.realtime.js header). Messages are
   classified ONCE — Appwrite sends ~20 event-name variants per change —
   so each handler gets one (action, payload, response) call per message. */
if (!window.ManifestRealtimeHub) {
    window.ManifestRealtimeHub = (function () {
        // Identity events drop the instance memo (the socket re-authenticates
        // as the new session) and re-bind live subscriptions
        const AUTH_EVENTS = ['manifest:auth:login', 'manifest:auth:logout', 'manifest:auth:anonymous', 'manifest:auth:session-cleared', 'manifest:auth:initialized'];

        // One Realtime (one socket) per tab, keyed to the client it wraps
        let realtimeCache = null;
        let realtimeClient = null;
        function acquire(client) {
            if (!client || !window.Appwrite?.Realtime) return null;
            if (!realtimeCache || realtimeClient !== client) {
                realtimeCache = new window.Appwrite.Realtime(client);
                realtimeClient = client;
            }
            return realtimeCache;
        }

        // Map<subKey, { channel, queries, refs, unsubscribe, handlers: Map<name, handler> }>
        const entries = new Map();
        // Map<name, { subKey, channel, token, handler, getFilters, getRealtime }>
        const sources = new Map();
        // Map<name, fn(action, payload, response)> — pre-filters, run once per message per name
        const filters = new Map();
        // Map<name, n> — explicit teardowns; aborts a subscribe in flight
        const tombstones = new Map();
        // Instance the current subscriptions live on
        let activeRealtime = null;

        // Reduce a message's event-name variants to the single most specific
        // action: delete > update (upsert counts: presences) > create
        function classify(events) {
            const list = Array.isArray(events) ? events : (events ? [events] : []);
            let action = null;
            for (const event of list) {
                if (typeof event !== 'string') continue;
                if (event.includes('delete')) return 'delete';
                if (event.includes('update') || event.includes('upsert')) action = 'update';
                else if (!action && event.includes('create')) action = 'create';
            }
            return action;
        }

        // Query-capable Realtime service: detect per instance, never assume
        function supportsQueries(realtime) {
            return !!(realtime && (realtime.pendingSubscribes || realtime.slotToSubscriptionId));
        }

        // (channel, resolved filter set) → stable subscription key; resolved.key
        // is already canonical so equivalent filter sets share one subscription
        function subKeyFor(channel, resolved) {
            if (!resolved || !resolved.key) return channel;
            return `${channel}\u001f${resolved.key}`;
        }

        // Fan one SDK message out, classified once: each registered handler gets
        // ONE (action, payload, response) call per message, after that name's
        // pre-filter (setFilter) — before any merge/dedup work
        function dispatch(subKey, response) {
            const entry = entries.get(subKey);
            if (!entry || !response || !response.events) return;
            const action = classify(response.events);
            if (!action) return;
            let payload = response.payload;
            if (!payload || (!payload.$id && !payload.row)) payload = response;
            for (const [name, handler] of entry.handlers) {
                const filter = filters.get(name);
                if (filter && filter(action, payload, response) === false) continue;
                handler(action, payload, response);
            }
        }

        // subscribe() returns an unsubscribe function (legacy client) or a
        // Promise<RealtimeSubscription> (Realtime service): normalize teardown
        function dropSub(sub) {
            if (typeof sub === 'function') sub();
            else if (sub && typeof sub.unsubscribe === 'function') sub.unsubscribe(); // per-subscription; never risks the shared socket
            else if (sub && typeof sub.close === 'function') sub.close();
        }

        function makeUnsubscriber(result) {
            if (!result || typeof result.then !== 'function') {
                return () => { try { dropSub(result); } catch (e) { /* socket already gone */ } };
            }
            const settled = result.catch(() => null);
            return () => { settled.then(dropSub).catch(() => { /* socket already gone */ }); };
        }

        function sdkSubscribe(realtime, subKey, channel, queries) {
            const cb = response => dispatch(subKey, response);
            const result = (queries && queries.length)
                ? realtime.subscribe(channel, cb, queries)
                : realtime.subscribe(channel, cb);
            return makeUnsubscriber(result);
        }

        // Get or create the shared entry for (channel, filters); registered in the
        // map before the SDK call so an event arriving mid-subscribe already dispatches
        function ensureEntry(realtime, subKey, channel, queries) {
            let entry = entries.get(subKey);
            if (entry) return entry;
            entry = { channel, queries: queries || [], refs: 0, unsubscribe: null, handlers: new Map() };
            entries.set(subKey, entry);
            try {
                entry.unsubscribe = sdkSubscribe(realtime, subKey, channel, queries);
            } catch (error) {
                entries.delete(subKey);
                throw error;
            }
            return entry;
        }

        function removeFromEntry(name, subKey) {
            const entry = entries.get(subKey);
            if (!entry) return;
            entry.handlers.delete(name);
            entry.refs = entry.handlers.size;
            if (entry.refs === 0) {
                entries.delete(subKey);
                if (typeof entry.unsubscribe === 'function') {
                    try { entry.unsubscribe(); } catch (e) { /* socket already gone */ }
                }
            }
        }

        // Drop a name's registration; tear the subscription down when the last one leaves
        function detach(name, token) {
            const cur = sources.get(name);
            if (!cur || (token && cur.token !== token)) return;
            sources.delete(name);
            removeFromEntry(name, cur.subKey);
        }

        // Instance changed (rebuilt on identity change): re-resolve each name's
        // filters ($auth. values are stale) and regroup subscriptions on the new
        // instance. Chained so overlapping rebuilds run in order; superseded stops.
        let syncChain = Promise.resolve();
        function syncInstance(realtime) {
            if (activeRealtime === realtime) return syncChain;
            activeRealtime = realtime;
            syncChain = syncChain
                .then(() => rebindAll(realtime))
                .catch(error => console.error('[Manifest Realtime] Rebind failed:', error));
            return syncChain;
        }

        async function rebindAll(realtime) {
            for (const [, entry] of entries) {
                if (typeof entry.unsubscribe === 'function') {
                    try { entry.unsubscribe(); } catch (e) { /* old instance */ }
                }
            }
            entries.clear();
            const canQuery = supportsQueries(realtime);
            for (const [name, src] of sources) {
                if (activeRealtime !== realtime) return; // superseded by a newer instance
                const resolved = (canQuery && src.getFilters) ? await src.getFilters() : null;
                const subKey = subKeyFor(src.channel, resolved);
                try {
                    const entry = ensureEntry(realtime, subKey, src.channel, resolved?.queries);
                    entry.handlers.set(name, src.handler);
                    entry.refs = entry.handlers.size;
                    src.subKey = subKey;
                } catch (error) {
                    console.error('[Manifest Realtime] Failed to re-subscribe channel:', src.channel, error);
                }
            }
        }

        // One SDK subscribe per distinct (channel, filter set); names sharing both
        // share it. getRealtime: async () => instance (re-run on identity rebuilds).
        // isCurrent: false once the requesting load is superseded — skip, never
        // touch a newer entry. getFilters: async () => ({ queries, key }) | null,
        // re-run per (re)subscribe; null → channel-only subscribe. A replaced
        // registration detaches only after the new subscription is live (no event
        // gap); overlap double-delivery is the consumer's dedupe to absorb.
        async function subscribe({ name, channel, onEvent, isCurrent, getFilters, getRealtime }) {
            const epoch = tombstones.get(name) || 0;
            const realtime = getRealtime ? await getRealtime() : null;
            if (isCurrent && !isCurrent()) return null;
            if (!realtime) {
                detach(name);
                return null;
            }
            await syncInstance(realtime);
            if (isCurrent && !isCurrent()) return null;

            const resolved = (supportsQueries(realtime) && getFilters) ? await getFilters() : null;
            if (isCurrent && !isCurrent()) return null;
            // Torn down while resolving: land nothing
            if ((tombstones.get(name) || 0) !== epoch) return null;
            // Instance replaced while resolving (identity rebuild): re-run against the live one
            if (activeRealtime !== realtime) return subscribe({ name, channel, onEvent, isCurrent, getFilters, getRealtime });
            const subKey = subKeyFor(channel, resolved);

            const prev = sources.get(name);
            let entry;
            try {
                entry = ensureEntry(realtime, subKey, channel, resolved?.queries);
            } catch (error) {
                console.error('[Manifest Realtime] Failed to subscribe:', channel, error);
                detach(name);
                return null;
            }
            const token = Symbol(name);
            entry.handlers.set(name, onEvent);
            entry.refs = entry.handlers.size;
            sources.set(name, { subKey, channel, token, handler: onEvent, getFilters, getRealtime });
            if (prev && prev.subKey !== subKey) removeFromEntry(name, prev.subKey);

            return () => detach(name, token);
        }

        // Explicit teardown by name; also aborts a subscribe in flight
        function unsubscribe(name) {
            tombstones.set(name, (tombstones.get(name) || 0) + 1);
            detach(name);
        }

        // Programmatic pre-filter: fn(action, payload, response) runs once per
        // message per name BEFORE the handler; false drops it. null clears.
        function setFilter(name, fn) {
            if (fn == null) filters.delete(name);
            else if (typeof fn === 'function') filters.set(name, fn);
        }

        // Identity events: drop the memo, then re-bind live subscriptions on a
        // fresh instance from any registered source's getter
        if (typeof window !== 'undefined') {
            AUTH_EVENTS.forEach(type => window.addEventListener(type, async () => {
                realtimeCache = null;
                realtimeClient = null;
                if (!sources.size) return;
                const src = [...sources.values()].find(s => s.getRealtime);
                const realtime = src ? await src.getRealtime() : null;
                if (realtime) syncInstance(realtime);
            }));
        }

        return {
            AUTH_EVENTS,
            acquire,
            subscribe,
            unsubscribe,
            setFilter,
            classify,
            supportsQueries,
            _entries: entries, // Expose for debugging (keyed by channel + filter set)
            _sources: sources
        };
    })();
}
// mnfst:realtime.hub:end

// Back-compat/debug surface: Map<sourceName, unsubscribeFunction>
const subscriptions = new Map();

// One SDK subscribe per distinct (channel, filter set), delegated to the hub;
// names are the data-source names. getFilters re-runs per (re)subscribe so
// $auth. values resolve at subscribe time; null → channel-only (0.5.248 path).
async function subscribeChannel(dataSourceName, channel, onEvent, isCurrent, getFilters) {
    const getRealtime = async () => {
        const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
        if (!services?.realtime) {
            console.warn('[Manifest Data] Realtime service not available for', dataSourceName);
            return null;
        }
        return services.realtime;
    };
    const unsubscribe = await window.ManifestRealtimeHub.subscribe({
        name: dataSourceName,
        channel,
        onEvent,
        isCurrent,
        getFilters,
        getRealtime
    });
    if (!unsubscribe) {
        subscriptions.delete(dataSourceName);
        return null;
    }
    subscriptions.set(dataSourceName, unsubscribe);
    return unsubscribe;
}

// Resolver re-runs per (re)subscribe so $auth. values are current at that moment
function filterResolver(filterSpec) {
    if (!filterSpec) return null;
    const build = window.ManifestDataQueries?.buildRealtimeQueries;
    if (typeof build !== 'function') return null;
    return () => build(filterSpec.queriesConfig, filterSpec.scope, filterSpec.scopeColumns, filterSpec.mode);
}

// Subscribe to storage bucket file changes
function subscribeToStorageBucket(dataSourceName, bucketId, scope, onEvent, isCurrent, filterSpec) {
    return subscribeChannel(dataSourceName, `buckets.${bucketId}.files`, onEvent, isCurrent, filterResolver(filterSpec));
}

// Subscribe to database table row changes
function subscribeToTable(dataSourceName, databaseId, tableId, scope, onEvent, isCurrent, filterSpec) {
    return subscribeChannel(dataSourceName, `databases.${databaseId}.tables.${tableId}.rows`, onEvent, isCurrent, filterResolver(filterSpec));
}

// Unsubscribe from a data source
function unsubscribeFromDataSource(dataSourceName) {
    window.ManifestRealtimeHub.unsubscribe(dataSourceName);
    subscriptions.delete(dataSourceName);
}

// Unsubscribe from all data sources (never touches auth/presence registrations)
function unsubscribeAll() {
    for (const name of [...subscriptions.keys()]) {
        window.ManifestRealtimeHub.unsubscribe(name);
    }
    subscriptions.clear();
}

// Programmatic pre-filter: fn(action, row) runs once per message per source
// BEFORE any merge/dedup work; returning false drops the event. null clears it.
function setFilter(sourceName, fn) {
    window.ManifestRealtimeHub.setFilter(sourceName, fn);
}

// Export functions
window.ManifestDataRealtime = {
    subscribeToStorageBucket,
    subscribeToTable,
    unsubscribeFromDataSource,
    unsubscribeAll,
    setFilter,
    subscriptions, // Expose for debugging
    _channels: window.ManifestRealtimeHub._entries // Expose for debugging (keyed by channel + filter set)
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
// Path is relative to the auth store itself (e.g. "currentTeam.$id", not "auth.currentTeam.$id").
// Supports optional-chaining syntax ("currentTeam?.$id") by normalizing "?." to "." — a
// missing intermediate value already returns null via the loop below.
function getAuthValue(path) {
    try {
        const store = Alpine.store('auth');
        if (!store) return null;

        const parts = path.replace(/\?\./g, '.').split('.');
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
        console.error('[Manifest Data] Error inspecting auth store:', error);
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
        // Strip the '$auth.' prefix (not just '$') — Alpine.store('auth') IS the auth
        // object, so a path starting with another 'auth' segment would never resolve.
        const path = value.substring('$auth.'.length);
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

// Thrown by interpolateQuery/interpolateObject when a whitelisted $auth.
// variable hasn't resolved yet (auth store not settled) — buildQueries
// catches this and returns NOT_READY rather than sending a query with a
// null/undefined arg (Appwrite 400s on that) to the network.
const NOT_READY = Symbol('manifest-data-not-ready');

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
                const value = interpolateVariable(arg);
                if (value === null || value === undefined) throw NOT_READY;
                return value;
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
                const resolved = interpolateVariable(value);
                if (resolved === null || resolved === undefined) throw NOT_READY;
                result[key] = resolved;
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

// Default scope column names, overridable per data source via `scopeColumn`
const DEFAULT_SCOPE_COLUMNS = { team: 'teamId', user: 'userId' };

// Event-driven wait for the auth store's initial hydration — resolves immediately
// once already settled, otherwise waits for manifest:auth:initialized (capped so a
// misconfigured/absent auth plugin can't hang a read forever).
const AUTH_INIT_WAIT_MS = 3000;
function waitForAuthInit(authStore) {
    if (!authStore || (authStore._initialized && authStore.isAuthenticated !== undefined)) {
        return Promise.resolve();
    }
    if (typeof window === 'undefined') return Promise.resolve();
    return new Promise(resolve => {
        let done = false;
        const timer = setTimeout(finish, AUTH_INIT_WAIT_MS);
        function finish() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            window.removeEventListener('manifest:auth:initialized', finish);
            resolve();
        }
        window.addEventListener('manifest:auth:initialized', finish);
    });
}

// Build queries with scope injection. Returns null ("not ready") instead of a
// query array when a $auth. arg or a required scope value hasn't resolved yet
// — callers must skip the read (never send a null/undefined/empty-equal arg to
// Appwrite) and retry once auth settles (manifest:auth:initialized/teams-loaded/login).
// SECURITY: Scope queries are ALWAYS prepended to user queries to prevent bypass
// scopeColumns: { team, user } column names to filter/write on (default teamId/userId)
async function buildQueries(queriesConfig, scope, scopeColumns) {
    const cols = { ...DEFAULT_SCOPE_COLUMNS, ...(scopeColumns || {}) };
    if (!queriesConfig || !Array.isArray(queriesConfig)) {
        return [];
    }

    // Wait for auth to settle before interpolating — a $auth. reference in a raw
    // user query (queries.default) needs this regardless of whether `scope` is set.
    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
    await waitForAuthInit(authStore);

    // Interpolate user-provided queries
    let userQueries;
    try {
        userQueries = queriesConfig.map(query => interpolateQuery(query));
    } catch (e) {
        if (e === NOT_READY) return null;
        throw e;
    }

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
                orQueries.push(['equal', cols.user, userId]);
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
            orQueries.push(['equal', cols.team, teamId]);
        });

        if (orQueries.length > 0) {
            if (orQueries.length === 1) {
                scopeQueries.push(orQueries[0]);
            } else {
                scopeQueries.push(['or', orQueries]);
            }
        } else {
            // No user or teams resolved — not ready (or genuinely unauthenticated):
            // skip the read rather than send an empty-equal; caller retries on an auth event.
            return null;
        }
    } else {
        // Handle user scope (when not combined with teams)
        if (hasUserScope) {
            const isAuthenticated = authStore?.isAuthenticated === true;
            const user = authStore?.user;

            if (!isAuthenticated || !user) {
                // Not (yet) authenticated — skip the read; caller retries on manifest:auth:login
                return null;
            }

            // Get user ID value
            const userId = getAuthValue('userId') || getAuthValue('user.$id') || getAuthValue('user.id') || user.$id || user.id;
            if (userId) {
                scopeQueries.push(['equal', cols.user, userId]);
            } else {
                // Authenticated but userId not found — not ready
                if (!window.__manifestDataDebugLogged) {
                    window.__manifestDataDebugLogged = true;
                    debugAuthStore();
                }
                return null;
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
                scopeQueries.push(['equal', cols.team, teamId]);
            } else {
                // No current team (yet) — skip the read; caller retries on manifest:auth:teams-loaded
                return null;
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
                    scopeQueries.push(['equal', cols.team, teamIds[0]]);
                } else {
                    // Multiple teams - use Query.or() with multiple Query.equal() calls
                    // Build: Query.or([Query.equal('teamId', id1), Query.equal('teamId', id2), ...])
                    const equalQueries = teamIds.map(id => ['equal', cols.team, id]);
                    scopeQueries.push(['or', equalQueries]);
                }
            } else {
                // No teams (yet) — skip the read; caller retries on manifest:auth:teams-loaded
                return null;
            }
        }
    }

    // SECURITY: Prepend scope queries to user queries
    // This ensures scope restrictions are ALWAYS applied and cannot be bypassed
    // User queries that conflict with scope will be ANDed together (both must match)
    return [...scopeQueries, ...userQueries];
}

// Query methods buildAppwriteQueries serializes (anything else is dropped at
// load and must therefore never drop rows in the realtime matcher below)
const QUERY_MAP = {
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

// Client-side row matcher for realtime events: evaluates a source's configured
// filter queries against one row. Only operators the load actually serializes
// (QUERY_MAP) are evaluable. Liveness over precision: anything unevaluable —
// search, an operator the load drops, or a $auth. arg that can't resolve
// synchronously — counts as a MATCH so live events are never silently dropped.
const NON_FILTER_METHODS = new Set(['limit', 'offset', 'orderAsc', 'orderDesc', 'select', 'cursorAfter', 'cursorBefore']);

function rowMatchesQueries(row, queriesConfig) {
    if (!row || !Array.isArray(queriesConfig) || queriesConfig.length === 0) return true;
    return queriesConfig.every(query => matchQuery(row, query));
}

function matchQuery(row, query) {
    if (!Array.isArray(query) || query.length === 0) return true;
    let interpolated;
    try {
        interpolated = interpolateQuery(query);
    } catch (e) {
        if (e === NOT_READY) return true; // unresolved $auth. arg
        throw e;
    }
    const [method, ...args] = interpolated;
    if (NON_FILTER_METHODS.has(method)) return true;
    if (!(method in QUERY_MAP)) return true; // load drops it: unevaluable
    if (method === 'and') return Array.isArray(args[0]) ? args[0].every(sub => matchQuery(row, sub)) : true;
    if (method === 'or') return Array.isArray(args[0]) ? args[0].some(sub => matchQuery(row, sub)) : true;

    const attr = args[0];
    const val = row ? row[attr] : undefined;
    const values = Array.isArray(args[1]) ? args[1] : [args[1]];
    // Strings compare case-insensitively (Appwrite's ci collation); other types strictly
    const eq = (a, b) => (typeof a === 'string' && typeof b === 'string')
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    const anyEqual = () => Array.isArray(val)
        ? values.some(v => val.some(el => eq(el, v)))
        : values.some(v => eq(val, v));
    const cmp = (bound, op) => val !== null && val !== undefined && bound !== null && bound !== undefined && op(val, bound);
    const lower = s => String(s).toLowerCase();

    switch (method) {
        case 'equal': return anyEqual();
        case 'notEqual': return !anyEqual();
        case 'lessThan': return cmp(args[1], (a, b) => a < b);
        case 'lessThanEqual': return cmp(args[1], (a, b) => a <= b);
        case 'greaterThan': return cmp(args[1], (a, b) => a > b);
        case 'greaterThanEqual': return cmp(args[1], (a, b) => a >= b);
        case 'between': return cmp(args[1], (a, b) => a >= b) && cmp(args[2], (a, b) => a <= b);
        case 'isNull': return val === null || val === undefined;
        case 'isNotNull': return val !== null && val !== undefined;
        case 'startsWith': return typeof val === 'string' && values.some(v => lower(val).startsWith(lower(v)));
        case 'endsWith': return typeof val === 'string' && values.some(v => lower(val).endsWith(lower(v)));
        case 'contains':
            if (Array.isArray(val)) return values.some(v => val.some(el => eq(el, v)));
            if (typeof val === 'string') return values.some(v => lower(val).includes(lower(v)));
            return false;
        default: return true; // search: unevaluable
    }
}

// Convert query array to Appwrite Query object
function toAppwriteQuery(queryArray) {
    if (!Array.isArray(queryArray) || queryArray.length === 0) {
        return null;
    }

    const [method, ...args] = queryArray;

    // Map common query methods to Appwrite Query methods (QUERY_MAP above —
    // also the realtime matcher's evaluable set)
    const queryMap = QUERY_MAP;

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

// Realtime-expressible operators: the intersection of what the load serializes
// (QUERY_MAP), what the matcher evaluates, and what Appwrite realtime filters
// server-side. isNull/isNotNull are realtime-supported but the load drops them,
// so filtering on them server-side would drop events the matcher keeps — excluded.
const REALTIME_FILTER_OPS = new Set(['equal', 'notEqual', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual']);

function isRealtimeExpressible(query) {
    if (!Array.isArray(query) || query.length === 0) return false;
    const [method, ...args] = query;
    if (method === 'or') return Array.isArray(args[0]) && args[0].length > 0 && args[0].every(isRealtimeExpressible);
    return REALTIME_FILTER_OPS.has(method);
}

// Server-side realtime filter set, reduced to the expressible subset. Omitting
// a query only WIDENS delivery — the client matcher still filters — so
// unexpressible queries are dropped whole, never approximated.
// mode 'scope' (default): only scope-column queries ride the subscription —
// permission-mirrored, so a row leaving the filter still delivers its last
// event and drops live. 'all': user queries too (a held row that stops
// matching then corrects on the next load, not instantly).
// Returns { queries, key } (key = canonical sorted serialization, for
// subscription sharing) or null (not ready / nothing expressible → channel-only
// subscribe, the 0.5.248 path).
async function buildRealtimeQueries(queriesConfig, scope, scopeColumns, mode = 'scope') {
    const userConfig = (mode === 'all' && Array.isArray(queriesConfig)) ? queriesConfig : [];
    const resolved = await buildQueries(userConfig, scope, scopeColumns);
    if (resolved === null) return null;
    const queries = resolved
        .filter(isRealtimeExpressible)
        .map(query => toAppwriteQuery(query))
        .filter(query => query !== null);
    if (queries.length === 0) return null;
    const key = queries.map(q => typeof q === 'string' ? q : JSON.stringify(q)).sort().join('\u001e');
    return { queries, key };
}

// Build Appwrite queries from configuration
// scopeColumns: { team, user } column names (default teamId/userId) — see manifest.data.config.js getScopeColumns
// Returns null ("not ready") straight through — see buildQueries.
async function buildAppwriteQueries(queriesConfig, scope, scopeColumns) {
    const queries = await buildQueries(queriesConfig, scope, scopeColumns);
    if (queries === null) return null;
    return queries
        .map(query => toAppwriteQuery(query))
        .filter(query => query !== null);
}

// Export functions to window for use by other subscripts
window.ManifestDataQueries = {
    interpolateVariable,
    interpolateQuery,
    interpolateObject,
    getAuthValue,
    buildQueries,
    buildAppwriteQueries,
    buildRealtimeQueries,
    rowMatchesQueries,
    toAppwriteQuery,
    ALLOWED_VARIABLES,
    DEFAULT_SCOPE_COLUMNS
};


/* Manifest Data Sources - Pagination (Appwrite) */

// First page, cursor-based
// Returns { items, cursor, total, hasMore }
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

// Next page from cursor
// Returns { items, cursor, total, hasMore }
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

// Previous page from cursor
// Returns { items, cursor, total, hasMore }
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

// Specific page (1-based), offset-based
// Returns { items, page, total, totalPages, hasMore }
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


})();
