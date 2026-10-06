/* Manifest Data Sources - Real-time Subscriptions */

// Track active subscriptions
const subscriptions = new Map(); // Map<dataSourceName, unsubscribeFunction>

// Subscribe to storage bucket file changes
// isCurrent: false once the requesting load is superseded (logout) — skip, never touch a newer entry
async function subscribeToStorageBucket(dataSourceName, bucketId, scope, onEvent, isCurrent) {
    // Unsubscribe from existing subscription if any
    if (subscriptions.has(dataSourceName)) {
        const unsubscribe = subscriptions.get(dataSourceName);
        if (unsubscribe && typeof unsubscribe === 'function') {
            unsubscribe();
        }
        subscriptions.delete(dataSourceName);
    }

    const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
    if (isCurrent && !isCurrent()) return null;
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
async function subscribeToTable(dataSourceName, databaseId, tableId, scope, onEvent, isCurrent) {
    // Unsubscribe from existing subscription if any
    if (subscriptions.has(dataSourceName)) {
        const unsubscribe = subscriptions.get(dataSourceName);
        if (unsubscribe && typeof unsubscribe === 'function') {
            unsubscribe();
        }
        subscriptions.delete(dataSourceName);
    }

    const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
    if (isCurrent && !isCurrent()) return null;
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
