/*  Manifest Appwrite Presences ($presence)
/*  By Andrew Matlock under MIT license
/*  https://github.com/andrewmatlock/Manifest
/*
/*  Reactive user status/roster over the native Appwrite Presences API
/*  Requires Alpine JS (alpinejs.dev) to operate
*/

(function () {
    'use strict';

    /* State */

    const ctx = {
        client: null,
        presences: null,
        realtime: null,
        sub: null,
        heartbeat: null,
        started: false,
        status: 'online',
        metadata: null,
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

    async function getConfig() {
        try {
            const manifest = await window.ManifestDataConfig?.ensureManifest?.();
            const aw = manifest?.appwrite;
            if (!aw) return null;
            const endpoint = resolveEnv(aw.endpoint);
            const projectId = resolveEnv(aw.projectId);
            if (!endpoint || !projectId) return null;
            let devKey = aw.devKey ? resolveEnv(aw.devKey) : null;
            if (devKey && /\$\{/.test(devKey)) devKey = null;
            return { endpoint, projectId, devKey };
        } catch (e) {
            return null;
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

    // Appwrite client + services — authed via the session cookie, not the dev key (which is the guests principal for user ops)
    async function ensureServices() {
        if (ctx.presences && ctx.realtime) return true;
        const A = window.Appwrite;
        if (!A || !A.Presences || !A.Realtime) return false;
        const cfg = await getConfig();
        if (!cfg) return false;
        const client = new A.Client().setEndpoint(cfg.endpoint).setProject(cfg.projectId);
        ctx.client = client;
        ctx.presences = new A.Presences(client);
        ctx.realtime = new A.Realtime(client);
        return true;
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
            rows.forEach(r => { const n = normalize(r); if (n) map[n.userId] = n; });
            if (s) s.records = map;
        } catch (e) {
            if (s) s.error = e?.message || String(e);
        }
    }

    function subscribe() {
        const A = window.Appwrite;
        try {
            const handle = ctx.realtime.subscribe(A.Channel.presences(), (response) => {
                if (!response) return;
                const events = Array.isArray(response.events) ? response.events : (response.events ? [response.events] : []);
                const rec = normalize(response.payload || response);
                if (!rec) return;
                // Ignore echoes of our own presence (tracked locally; delayed echoes would clobber newer status)
                const meId = authUser()?.$id;
                if (meId && rec.userId === meId) return;
                if (events.some(e => typeof e === 'string' && e.includes('delete'))) removeRecord(rec.userId);
                else putRecord(rec);
            });
            // Normalise the unsubscribe handle
            if (handle && typeof handle.then === 'function') {
                handle.then(r => { ctx.sub = typeof r === 'function' ? r : (r && r.close ? () => r.close() : null); });
                ctx.sub = () => { handle.then(r => { if (typeof r === 'function') r(); else if (r && r.close) r.close(); }); };
            } else if (typeof handle === 'function') {
                ctx.sub = handle;
            } else if (handle && typeof handle.close === 'function') {
                ctx.sub = () => handle.close();
            }
        } catch (e) {
            const s = store(); if (s) s.error = e?.message || String(e);
        }
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

        // Read-scope + owner write (owner update/delete required, else updates 401)
        const teamId = currentTeamId();
        const permissions = [
            teamId ? A.Permission.read(A.Role.team(teamId)) : A.Permission.read(A.Role.users()),
            A.Permission.update(A.Role.user(user.$id)),
            A.Permission.delete(A.Role.user(user.$id))
        ];

        // name/color in metadata for rosters
        const meta = Object.assign(
            { name: user.name || user.email || 'Anonymous', color: userColor(user.$id) },
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
