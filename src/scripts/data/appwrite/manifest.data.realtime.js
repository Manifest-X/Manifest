/* Manifest Data Sources - Real-time Subscriptions
   One shared Realtime client per tab; channels ref-counted across sources. */

// Map<channel, { refs, unsubscribe, handlers: Map<sourceName, handler> }>
const channels = new Map();
// Map<sourceName, { channel, token }> — token guards a stale unsubscribe closure
const sources = new Map();
// Map<sourceName, fn(eventType, row)> — pre-filters, run per event per source
const filters = new Map();
// Back-compat/debug surface: Map<sourceName, unsubscribeFunction>
const subscriptions = new Map();
// Instance the current channel subscriptions live on
let activeRealtime = null;

function classify(event) {
    if (typeof event !== 'string') return null;
    if (event.includes('create')) return 'create';
    if (event.includes('update')) return 'update';
    if (event.includes('delete')) return 'delete';
    return null;
}

// Fan one SDK message out: each registered source handler gets each event once,
// after that source's pre-filter (setFilter) — before any merge/dedup work
function dispatch(channel, response) {
    const entry = channels.get(channel);
    if (!entry || !response || !response.events) return;
    const events = Array.isArray(response.events) ? response.events : [response.events];
    let payload = response.payload;
    if (!payload || (!payload.$id && !payload.row)) payload = response;
    for (const event of events) {
        const type = classify(event);
        if (!type) continue;
        for (const [name, handler] of entry.handlers) {
            const filter = filters.get(name);
            if (filter && filter(type, payload) === false) continue;
            handler(type, payload);
        }
    }
}

function sdkSubscribe(realtime, channel) {
    return realtime.subscribe(channel, response => dispatch(channel, response));
}

// Drop a source's registration; tear the channel down when the last source leaves
function detach(name, token) {
    const cur = sources.get(name);
    if (!cur || (token && cur.token !== token)) return;
    sources.delete(name);
    const entry = channels.get(cur.channel);
    if (!entry) return;
    entry.handlers.delete(name);
    entry.refs = entry.handlers.size;
    if (entry.refs === 0) {
        channels.delete(cur.channel);
        if (typeof entry.unsubscribe === 'function') {
            try { entry.unsubscribe(); } catch (e) { /* socket already gone */ }
        }
    }
}

// Instance changed (client rebuilt on identity change): re-bind live channels
function syncInstance(realtime) {
    if (activeRealtime === realtime) return;
    activeRealtime = realtime;
    for (const [channel, entry] of channels) {
        if (typeof entry.unsubscribe === 'function') {
            try { entry.unsubscribe(); } catch (e) { /* old instance */ }
        }
        try {
            entry.unsubscribe = sdkSubscribe(realtime, channel);
        } catch (error) {
            console.error('[Manifest Data] Failed to re-subscribe channel:', channel, error);
        }
    }
}

// One SDK subscribe per distinct channel, however many sources share it.
// isCurrent: false once the requesting load is superseded (logout) — skip, never touch a newer entry
async function subscribeChannel(dataSourceName, channel, onEvent, isCurrent) {
    detach(dataSourceName);
    subscriptions.delete(dataSourceName);

    const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
    if (isCurrent && !isCurrent()) return null;
    if (!services?.realtime) {
        console.warn('[Manifest Data] Realtime service not available for', dataSourceName);
        return null;
    }
    syncInstance(services.realtime);

    let entry = channels.get(channel);
    if (!entry) {
        entry = { refs: 0, unsubscribe: null, handlers: new Map() };
        try {
            entry.unsubscribe = sdkSubscribe(services.realtime, channel);
        } catch (error) {
            console.error('[Manifest Data] Failed to subscribe:', channel, error);
            return null;
        }
        channels.set(channel, entry);
    }
    const token = Symbol(dataSourceName);
    entry.handlers.set(dataSourceName, onEvent);
    entry.refs = entry.handlers.size;
    sources.set(dataSourceName, { channel, token });

    const unsubscribe = () => detach(dataSourceName, token);
    subscriptions.set(dataSourceName, unsubscribe);
    return unsubscribe;
}

// Subscribe to storage bucket file changes
function subscribeToStorageBucket(dataSourceName, bucketId, scope, onEvent, isCurrent) {
    return subscribeChannel(dataSourceName, `buckets.${bucketId}.files`, onEvent, isCurrent);
}

// Subscribe to database table row changes
function subscribeToTable(dataSourceName, databaseId, tableId, scope, onEvent, isCurrent) {
    return subscribeChannel(dataSourceName, `databases.${databaseId}.tables.${tableId}.rows`, onEvent, isCurrent);
}

// Unsubscribe from a data source
function unsubscribeFromDataSource(dataSourceName) {
    detach(dataSourceName);
    subscriptions.delete(dataSourceName);
}

// Unsubscribe from all data sources
function unsubscribeAll() {
    for (const name of [...sources.keys()]) detach(name);
    subscriptions.clear();
}

// Programmatic pre-filter: fn(eventType, row) runs per event per source BEFORE
// any merge/dedup work; returning false drops the event. null clears it.
function setFilter(sourceName, fn) {
    if (fn == null) filters.delete(sourceName);
    else if (typeof fn === 'function') filters.set(sourceName, fn);
}

// Identity events rebuild the shared Realtime (manifest.data.appwrite.js drops
// its memo on the same events); re-bind any live channels to the new instance
if (typeof window !== 'undefined') {
    ['manifest:auth:login', 'manifest:auth:logout', 'manifest:auth:anonymous', 'manifest:auth:session-cleared', 'manifest:auth:initialized']
        .forEach(type => window.addEventListener(type, async () => {
            if (!channels.size) return;
            const services = await window.ManifestDataAppwrite?.getAppwriteDataServices?.();
            if (services?.realtime) syncInstance(services.realtime);
        }));
}

// Export functions
window.ManifestDataRealtime = {
    subscribeToStorageBucket,
    subscribeToTable,
    unsubscribeFromDataSource,
    unsubscribeAll,
    setFilter,
    subscriptions, // Expose for debugging
    _channels: channels // Expose for debugging
};
