/*  Manifest Appwrite Presences ($presence)
/*  By Andrew Matlock under MIT license
/*  https://github.com/andrewmatlock/Manifest
/*
/*  Reactive user status/roster over the native Appwrite Presences API
/*  Requires Alpine JS (alpinejs.dev) to operate
*/

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

(function () {
    'use strict';

    /* State */

    const ctx = {
        client: null,
        presences: null,
        sub: null,
        heartbeat: null,
        started: false,
        status: 'online',
        metadata: null,
        scope: 'auto',          // 'auto'/'team' = current team, 'global', or an explicit team id
        auto: true,             // focus/blur auto-flip
        heartbeatMs: 25000,     // TTL refresh cadence
        onFocus: null,
        onBlur: null
    };

    /* Config */

    // Resolve ${VAR} against window.env
    function resolveEnv(v) {
        if (typeof v !== 'string') return v;
        return v.replace(/\$\{([^}]+)\}/g, (m, name) => {
            if (typeof window !== 'undefined' && window.env && window.env[name] != null) return window.env[name];
            return null;
        });
    }

    // manifest.json appwrite.presences block ({ scope } today; true = defaults)
    async function getPresencesConfig() {
        try {
            const manifest = await (window.ManifestDataConfig?.ensureManifest?.() || window.ManifestAppwriteAuthConfig?.ensureManifest?.());
            const block = manifest?.appwrite?.presences ?? manifest?.appwrite?.presence;
            return (block && typeof block === 'object') ? block : {};
        } catch (e) {
            return {};
        }
    }

    function store() {
        return (typeof Alpine !== 'undefined') ? Alpine.store('presence') : null;
    }

    function authUser() {
        const s = (typeof Alpine !== 'undefined') ? Alpine.store('auth') : null;
        return s && s.user ? s.user : null;
    }

    // Active team id (read-scoping)
    function currentTeamId() {
        const s = (typeof Alpine !== 'undefined') ? Alpine.store('auth') : null;
        if (!s) return null;
        if (s.currentTeam) return typeof s.currentTeam === 'string' ? s.currentTeam : (s.currentTeam.$id || s.currentTeam.id || null);
        if (Array.isArray(s.teams) && s.teams.length) return s.teams[0].$id || s.teams[0].id || null;
        return null;
    }

    // Consistent per-user color
    function userColor(id) {
        if (!id) return '#666';
        let hash = 0;
        for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
        return `hsl(${Math.abs(hash) % 360}, 70%, 50%)`;
    }

    // Shared Appwrite client via the auth plugin (a hard dependency) + the
    // realtime hub: presences never constructs its own Client or Realtime, so
    // data + auth + presence ride one socket per tab
    async function ensureServices() {
        if (ctx.presences && ctx.client) return true;
        const A = window.Appwrite;
        if (!A || !A.Presences || !A.Realtime || !window.ManifestRealtimeHub) return false;
        const services = await window.ManifestAppwriteAuthConfig?.getAppwriteClient?.();
        if (!services?.client) return false;
        ctx.client = services.client;
        ctx.presences = new A.Presences(services.client);
        return true;
    }

    /* Scope */

    // Roster scope as a team id: explicit id > current team ('auto'/'team') > none ('global')
    function scopeTeamId() {
        const s = ctx.scope;
        if (s === 'global' || s === false || s == null) return null;
        if (typeof s === 'string' && s !== 'auto' && s !== 'team') return s;
        return currentTeamId();
    }

    // Client-side scope filter (always on, defense in depth): a team scope is
    // not expressible as a server-side realtime query — the payload has no team
    // field and $permissions is an array the server's strict equal can't match —
    // so out-of-scope records drop here, before the store. Matches the plugin's
    // own write convention: read(Role.team(teamId)).
    function inScope(raw, userId) {
        const team = scopeTeamId();
        if (!team) return true;
        const meId = authUser()?.$id;
        if (meId && userId === meId) return true;
        const perms = Array.isArray(raw?.$permissions) ? raw.$permissions : [];
        return perms.some(p => p === `read("team:${team}")` || p.startsWith(`read("team:${team}/`));
    }

    /* Records */

    function normalize(rec) {
        if (!rec) return null;
        const userId = rec.userId || rec.$userId || rec.presenceId || rec.$id;
        if (!userId) return null;
        let metadata = rec.metadata;
        if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch (e) { } }
        const updatedAt = rec.$updatedAt || rec.$createdAt || null;
        return {
            userId,
            status: rec.status || null,
            metadata: metadata || null,
            lastSeen: updatedAt ? Date.parse(updatedAt) : Date.now(),
            expiresAt: rec.expiresAt || rec.$expiresAt || null,
            color: userColor(userId)
        };
    }

    // Reactive map updates (reassign for Alpine tracking)
    function putRecord(rec) {
        const s = store(); if (!s || !rec) return;
        s.records = { ...s.records, [rec.userId]: rec };
    }
    function removeRecord(userId) {
        const s = store(); if (!s || !userId) return;
        if (!s.records[userId]) return;
        const next = { ...s.records }; delete next[userId]; s.records = next;
    }

    async function hydrate() {
        const s = store();
        try {
            const res = await ctx.presences.list();
            const rows = res?.presences || res?.rows || res?.documents || [];
            const map = {};
            rows.forEach(r => { const n = normalize(r); if (n && inScope(r, n.userId)) map[n.userId] = n; });
            if (s) s.records = map;
        } catch (e) {
            if (s) s.error = e?.message || String(e);
        }
    }

    function subscribe() {
        const A = window.Appwrite;
        const hub = window.ManifestRealtimeHub;
        const channel = (A.Channel && typeof A.Channel.presences === 'function') ? A.Channel.presences() : 'presences';
        hub.subscribe({
            name: 'presence:roster',
            channel,
            getRealtime: async () => hub.acquire(ctx.client),
            // One classified call per message (presence upserts classify as update)
            onEvent: (action, payload) => {
                const rec = normalize(payload);
                if (!rec) return;
                // Ignore echoes of our own presence (tracked locally; delayed echoes would clobber newer status)
                const meId = authUser()?.$id;
                if (meId && rec.userId === meId) return;
                if (!inScope(payload, rec.userId)) return;
                if (action === 'delete') removeRecord(rec.userId);
                else putRecord(rec);
            }
        }).catch(e => {
            const s = store(); if (s) s.error = e?.message || String(e);
        });
        ctx.sub = () => hub.unsubscribe('presence:roster');
    }

    /* Operations */

    async function set(status, metadata) {
        const A = window.Appwrite;
        const user = authUser();
        const s = store();
        if (!user) { if (s) s.error = 'sign in required'; return false; }
        if (!(await ensureServices())) { if (s) s.error = 'Appwrite Presences unavailable'; return false; }
        ctx.status = status != null ? status : ctx.status;
        ctx.metadata = metadata !== undefined ? metadata : ctx.metadata;

        // Read-scope + owner write (owner update/delete required, else updates 401).
        // Reads follow the roster scope: team role when scoped, all users when global.
        const teamId = scopeTeamId();
        const permissions = [
            teamId ? A.Permission.read(A.Role.team(teamId)) : A.Permission.read(A.Role.users()),
            A.Permission.update(A.Role.user(user.$id)),
            A.Permission.delete(A.Role.user(user.$id))
        ];

        // name/color in metadata for rosters (name null when unknown — display label is the author's)
        const meta = Object.assign(
            { name: user.name || user.email || null, color: userColor(user.$id) },
            ctx.metadata || {}
        );

        // Optimistic local update
        putRecord(normalize({ userId: user.$id, status: ctx.status, metadata: meta, $updatedAt: new Date().toISOString() }));
        if (s) s.me = ctx.status;
        try {
            await ctx.presences.upsert({ presenceId: user.$id, status: ctx.status, metadata: meta, permissions });
            if (s) s.error = null;
            return true;
        } catch (e) {
            if (s) s.error = e?.message || String(e);
            return false;
        }
    }

    async function clear() {
        const user = authUser();
        if (!user || !ctx.presences) return;
        try { await ctx.presences.delete({ presenceId: user.$id }); } catch (e) { }
        removeRecord(user.$id);
        const s = store(); if (s) s.me = null;
    }

    function of(userId) {
        const s = store();
        return (s && s.records ? s.records[userId] : null) || null;
    }

    function all() {
        const s = store();
        return s && s.records ? Object.values(s.records) : [];
    }

    async function start(options) {
        const opts = options || {};
        if (typeof opts.auto === 'boolean') ctx.auto = opts.auto;
        if (typeof opts.heartbeatMs === 'number') ctx.heartbeatMs = opts.heartbeatMs;
        if (typeof opts.status === 'string') ctx.status = opts.status;

        // Scope: start() option > manifest appwrite.presences.scope > 'auto'
        const cfg = await getPresencesConfig();
        if (cfg.scope != null) ctx.scope = resolveEnv(cfg.scope);
        if (opts.scope != null) ctx.scope = opts.scope;

        const s = store();
        if (!authUser()) { if (s) s.error = 'sign in required'; return false; }
        if (!(await ensureServices())) { if (s) s.error = 'Appwrite Presences unavailable'; return false; }
        if (ctx.started) return true;
        ctx.started = true;

        await hydrate();
        subscribe();
        await set(ctx.status, ctx.metadata);

        // Heartbeat (refresh TTL)
        ctx.heartbeat = setInterval(() => { if (authUser()) set(ctx.status, ctx.metadata); }, ctx.heartbeatMs);

        // Auto focus/blur flip
        if (ctx.auto) {
            ctx.onBlur = () => set('away');
            ctx.onFocus = () => set('online');
            window.addEventListener('blur', ctx.onBlur);
            window.addEventListener('focus', ctx.onFocus);
        }

        if (s) { s.ready = true; s.error = null; }
        return true;
    }

    function stop() {
        if (ctx.heartbeat) { clearInterval(ctx.heartbeat); ctx.heartbeat = null; }
        if (ctx.onBlur) { window.removeEventListener('blur', ctx.onBlur); ctx.onBlur = null; }
        if (ctx.onFocus) { window.removeEventListener('focus', ctx.onFocus); ctx.onFocus = null; }
        if (typeof ctx.sub === 'function') { try { ctx.sub(); } catch (e) { } }
        ctx.sub = null;
        ctx.started = false;
        const s = store(); if (s) s.ready = false;
    }

    /* Registration */

    document.addEventListener('alpine:init', () => {
        Alpine.store('presence', { records: {}, ready: false, error: null, me: null });

        // Clear on sign-out
        try {
            Alpine.effect(() => {
                if (!authUser() && ctx.started) { clear(); stop(); }
            });
        } catch (e) { }

        // Re-scope on team switch: refilter the roster, rewrite own presence perms
        let lastTeam;
        try {
            Alpine.effect(() => {
                const team = currentTeamId();
                if (team === lastTeam) return;
                lastTeam = team;
                if (!ctx.started) return;
                hydrate();
                set(ctx.status, ctx.metadata);
            });
        } catch (e) { }

        const api = {
            start, stop, set, clear, of, all,
            get records() { return store()?.records || {}; },
            get list() { return all(); },
            get ready() { return !!store()?.ready; },
            get error() { return store()?.error || null; },
            get me() { return store()?.me || null; }
        };
        Alpine.magic('presence', () => api);
    });

    // Clear on tab close
    window.addEventListener('beforeunload', () => { try { if (ctx.started) clear(); } catch (e) { } });

    // Non-Alpine handle
    window.ManifestPresence = { start, stop, set, clear, of, all };
})();
