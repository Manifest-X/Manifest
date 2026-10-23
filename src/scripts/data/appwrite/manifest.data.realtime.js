/* Manifest Data Sources - Real-time Subscriptions
   One shared Realtime client per tab; subscriptions ref-counted by
   (channel + canonical server-filter set) across sources.

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
     update that makes a held row STOP matching is not delivered; the client
     matcher stays on in both modes and the row corrects on the next load.
     realtime: { serverFilter: false } restores full channel delivery. */

// Map<subKey, { channel, queries, refs, unsubscribe, handlers: Map<sourceName, handler> }>
const entries = new Map();
// Map<sourceName, { subKey, channel, token, handler, getFilters }> — token guards a stale unsubscribe closure
const sources = new Map();
// Map<sourceName, fn(eventType, row)> — pre-filters, run per event per source
const filters = new Map();
// Back-compat/debug surface: Map<sourceName, unsubscribeFunction>
const subscriptions = new Map();
// Instance the current subscriptions live on
let activeRealtime = null;

function classify(event) {
    if (typeof event !== 'string') return null;
    if (event.includes('create')) return 'create';
    if (event.includes('update')) return 'update';
    if (event.includes('delete')) return 'delete';
    return null;
}

// Query-capable Realtime service (see header): detect per instance, never assume
function supportsQueries(realtime) {
    return !!(realtime && (realtime.pendingSubscribes || realtime.slotToSubscriptionId));
}

// (channel, resolved filter set) → stable subscription key; resolved.key is
// already canonical (sorted) so equivalent filter sets share one subscription
function subKeyFor(channel, resolved) {
    if (!resolved || !resolved.key) return channel;
    return `${channel}\u001f${resolved.key}`;
}

// Fan one SDK message out: each registered source handler gets each event once,
// after that source's pre-filter (setFilter) — before any merge/dedup work
function dispatch(subKey, response) {
    const entry = entries.get(subKey);
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

// subscribe() returns an unsubscribe function (legacy client) or a
// Promise<RealtimeSubscription> (Realtime service): normalize teardown
function dropSub(sub) {
    if (typeof sub === 'function') sub();
    else if (sub && typeof sub.close === 'function') sub.close(); // unsubscribe + drop the socket when last
    else if (sub && typeof sub.unsubscribe === 'function') sub.unsubscribe();
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

// Get or create the shared entry for (channel, filters); registered in the map
// before the SDK call so an event arriving mid-subscribe already dispatches
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

// Drop a source's registration; tear the subscription down when the last source leaves
function detach(name, token) {
    const cur = sources.get(name);
    if (!cur || (token && cur.token !== token)) return;
    sources.delete(name);
    removeFromEntry(name, cur.subKey);
}

// Instance changed (client rebuilt on identity change): re-resolve each source's
// filters ($auth. values are stale) and regroup subscriptions on the new instance.
// Chained so overlapping rebuilds run in order; a superseded rebuild stops.
let syncChain = Promise.resolve();
function syncInstance(realtime) {
    if (activeRealtime === realtime) return syncChain;
    activeRealtime = realtime;
    syncChain = syncChain
        .then(() => rebindAll(realtime))
        .catch(error => console.error('[Manifest Data] Realtime rebind failed:', error));
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
            console.error('[Manifest Data] Failed to re-subscribe channel:', src.channel, error);
        }
    }
}

// One SDK subscribe per distinct (channel, filter set); sources sharing both share it.
// isCurrent: false once the requesting load is superseded (logout) — skip, never touch a newer entry.
// getFilters: async () => ({ queries, key }) | null, re-run per (re)subscribe so
// $auth. values resolve at subscribe time; null → channel-only (0.5.248 path).
// A replaced registration detaches only after the new subscription is live (no
// event gap); overlap double-delivery is absorbed by the per-source event dedupe.
async function subscribeChannel(dataSourceName, channel, onEvent, isCurrent, getFilters) {
    const services = await window.ManifestDataAppwrite.getAppwriteDataServices();
    if (isCurrent && !isCurrent()) return null;
    if (!services?.realtime) {
        console.warn('[Manifest Data] Realtime service not available for', dataSourceName);
        detach(dataSourceName);
        subscriptions.delete(dataSourceName);
        return null;
    }
    await syncInstance(services.realtime);
    if (isCurrent && !isCurrent()) return null;

    const resolved = (supportsQueries(services.realtime) && getFilters) ? await getFilters() : null;
    if (isCurrent && !isCurrent()) return null;
    const subKey = subKeyFor(channel, resolved);

    const prev = sources.get(dataSourceName);
    let entry;
    try {
        entry = ensureEntry(services.realtime, subKey, channel, resolved?.queries);
    } catch (error) {
        console.error('[Manifest Data] Failed to subscribe:', channel, error);
        detach(dataSourceName);
        subscriptions.delete(dataSourceName);
        return null;
    }
    const token = Symbol(dataSourceName);
    entry.handlers.set(dataSourceName, onEvent);
    entry.refs = entry.handlers.size;
    sources.set(dataSourceName, { subKey, channel, token, handler: onEvent, getFilters });
    if (prev && prev.subKey !== subKey) removeFromEntry(dataSourceName, prev.subKey);

    const unsubscribe = () => detach(dataSourceName, token);
    subscriptions.set(dataSourceName, unsubscribe);
    return unsubscribe;
}

// Resolver re-runs per (re)subscribe so $auth. values are current at that moment
function filterResolver(filterSpec) {
    if (!filterSpec) return null;
    const build = window.ManifestDataQueries?.buildRealtimeQueries;
    if (typeof build !== 'function') return null;
    return () => build(filterSpec.queriesConfig, filterSpec.scope, filterSpec.scopeColumns);
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
// its memo on the same events); re-bind live subscriptions to the new instance
if (typeof window !== 'undefined') {
    ['manifest:auth:login', 'manifest:auth:logout', 'manifest:auth:anonymous', 'manifest:auth:session-cleared', 'manifest:auth:initialized']
        .forEach(type => window.addEventListener(type, async () => {
            if (!sources.size) return;
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
    _channels: entries // Expose for debugging (keyed by channel + filter set)
};
