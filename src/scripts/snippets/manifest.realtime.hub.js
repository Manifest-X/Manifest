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
