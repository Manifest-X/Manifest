/*  Manifest Status — config
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
*/

(function () {
    'use strict';

    // Infer provider type from which field is present.
    function normalizeSignal(sig) {
        if (typeof sig === 'string') return { type: 'probe', url: sig, label: sig };
        if (!sig || typeof sig !== 'object') return { type: 'unknown', label: 'unknown' };

        if (sig.static) return { type: 'static', state: sig.static, label: sig.label || 'static' };
        if (sig.feed) return { type: 'feed', url: sig.feed, path: sig.path, label: sig.label || sig.feed };
        if (sig.mirror) return { type: 'mirror', mirror: sig.mirror, label: sig.label || sig.mirror };
        if (sig.appwriteService || sig.appwriteTableId)
            return { type: 'appwrite', service: sig.appwriteService || 'health', label: sig.label || 'appwrite' };
        if (sig.mcp) return { type: 'mcp', mcp: sig.mcp, label: sig.label || 'mcp' };
        if (sig.heartbeat)
            return { type: 'heartbeat', heartbeat: sig.heartbeat, expectEvery: sig.expectEvery || 60000, label: sig.label || sig.heartbeat };
        if (sig.url)
            return {
                type: 'probe', url: sig.url, label: sig.label || sig.url,
                expect: sig.expect, degradedAbove: sig.degradedAbove,
                method: sig.method || 'GET', headers: sig.headers, timeout: sig.timeout
            };
        return { type: 'unknown', label: sig.label || 'unknown' };
    }

    // Normalize a manifest.status entry (string | array | object) into a record.
    function normalizeEntry(name, def) {
        const opts = { rollup: 'worst', refresh: 30000, confirmations: 1, staleAfter: null, history: 90 };
        let signals = [];

        if (typeof def === 'string') {
            signals = [normalizeSignal(def)];
        } else if (Array.isArray(def)) {
            signals = def.map(normalizeSignal);
        } else if (def && typeof def === 'object') {
            if (Array.isArray(def.signals)) {
                signals = def.signals.map(normalizeSignal);
                if (def.rollup) opts.rollup = def.rollup;
                if (def.refresh) opts.refresh = def.refresh;
                if (def.confirmations) opts.confirmations = def.confirmations;
                if (def.staleAfter) opts.staleAfter = def.staleAfter;
            } else {
                // Single-signal object.
                signals = [normalizeSignal(def)];
                if (def.refresh) opts.refresh = def.refresh;
            }
        }

        if (def && typeof def === 'object' && !Array.isArray(def) && def.history) opts.history = def.history;
        if (opts.staleAfter == null) opts.staleAfter = opts.refresh * 3;
        return { name, signals, ...opts };
    }

    // Reuse a cached manifest only if it carries the `status` block; some plugins
    // cache a normalized copy that omits keys they don't consume.
    async function ensureStatusManifest() {
        const cached = window.ManifestComponentsRegistry?.manifest || window.__manifestLoaded;
        if (cached && cached.status) return cached;
        try {
            const url = document.querySelector('link[rel="manifest"]')?.getAttribute('href') || '/manifest.json';
            const res = await fetch(url);
            return await res.json();
        } catch (_) {
            return cached || null;
        }
    }

    async function getStatusConfig() {
        const manifest = await ensureStatusManifest();
        if (!manifest?.status || typeof manifest.status !== 'object') return null;
        const entries = {};
        for (const [name, def] of Object.entries(manifest.status)) {
            entries[name] = normalizeEntry(name, def);
        }
        return { entries, appwriteEndpoint: manifest.appwrite?.endpoint || null };
    }

    window.ManifestStatusConfig = { getStatusConfig, normalizeEntry, normalizeSignal, ensureStatusManifest };
})();


/*  Manifest Status — store
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
*/

(function () {
    'use strict';

    // Ordered severity; maintenance sits between operational and degraded.
    const LEVELS = {
        operational: 0,
        maintenance: 0.5,
        degraded: 1,
        partial_outage: 2,
        major_outage: 3,
        unknown: -1
    };

    function level(state) {
        return Object.prototype.hasOwnProperty.call(LEVELS, state) ? LEVELS[state] : -1;
    }

    // Placeholder health for an unknown/not-yet-resolved entry.
    function emptyHealth(name) {
        return { name, state: 'unknown', level: -1, up: false, latencyMs: null, message: null, uptime: null, history: [], incidents: [], updatedAt: null, stale: false, signals: [] };
    }

    function initializeStore() {
        if (!window.Alpine) return;
        if (window.Alpine.store('status')) return;
        window.Alpine.store('status', { _version: 0, _ready: false, entries: {}, incidents: [] });
    }

    window.ManifestStatusStore = { LEVELS, level, emptyHealth, initializeStore };
})();


/*  Manifest Status — signal resolvers + rollup
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
*/

(function () {
    'use strict';

    // Map an arbitrary upstream state string onto the Manifest vocabulary.
    function normalizeFeedState(raw) {
        if (!raw) return 'unknown';
        const s = String(raw).toLowerCase();
        if (['operational', 'up', 'pass', 'ok', 'none', 'healthy', 'available'].includes(s)) return 'operational';
        if (['degraded', 'minor', 'slow', 'degraded_performance'].includes(s)) return 'degraded';
        if (['partial', 'partial_outage'].includes(s)) return 'partial_outage';
        if (['major', 'major_outage', 'down', 'critical', 'fail', 'outage', 'unavailable'].includes(s)) return 'major_outage';
        if (['maintenance', 'maintenance_in_progress', 'under_maintenance'].includes(s)) return 'maintenance';
        return 'unknown';
    }

    function dig(obj, path) {
        if (!path) return obj;
        return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    }

    async function probe(sig) {
        const timeout = sig.timeout || 8000;
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeout);
        const start = (window.performance && performance.now) ? performance.now() : Date.now();
        try {
            const res = await fetch(sig.url, {
                method: sig.method || 'GET',
                headers: sig.headers || undefined,
                signal: controller.signal,
                cache: 'no-store'
            });
            clearTimeout(t);
            const latencyMs = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - start);
            const ok = sig.expect ? res.status === sig.expect : res.ok;
            let state;
            if (ok) state = (sig.degradedAbove && latencyMs > sig.degradedAbove) ? 'degraded' : 'operational';
            else if (res.status >= 500) state = 'major_outage';
            else state = 'partial_outage';
            return { state, latencyMs };
        } catch (err) {
            clearTimeout(t);
            // Can't distinguish down from CORS-blocked, so report unknown not outage.
            return { state: 'unknown', latencyMs: null, error: err && err.name ? err.name : 'fetch failed' };
        }
    }

    async function feed(sig) {
        try {
            const res = await fetch(sig.url, { cache: 'no-store' });
            if (!res.ok) return { state: 'unknown', latencyMs: null, error: 'feed ' + res.status };
            const json = await res.json();
            // Feed node may be a bare state string or an object with state + message.
            const node = sig.path ? dig(json, sig.path) : json;
            const obj = (node && typeof node === 'object') ? node : null;
            const raw = obj ? (obj.state != null ? obj.state : obj.status) : node;
            const message = (obj && obj.message) ? obj.message : (json.message || null);
            const history = Array.isArray(obj && obj.history) ? obj.history : (Array.isArray(json.history) ? json.history : undefined);
            const uptime = (obj && typeof obj.uptime === 'number') ? obj.uptime : (typeof json.uptime === 'number' ? json.uptime : undefined);
            const incidents = Array.isArray(obj && obj.incidents) ? obj.incidents : (Array.isArray(json.incidents) ? json.incidents : undefined);
            return { state: normalizeFeedState(raw), latencyMs: null, message, history, uptime, incidents };
        } catch (_) {
            return { state: 'unknown', latencyMs: null, error: 'feed failed' };
        }
    }

    // Atlassian Statuspage v2 indicator → Manifest vocabulary. Most hosted
    // status pages (and their /api/v2/status.json) follow this shape and serve
    // permissive CORS, so they resolve client-side.
    function mapStatuspageIndicator(ind) {
        switch (String(ind || '').toLowerCase()) {
            case 'none': return 'operational';
            case 'minor': return 'degraded';
            case 'major': return 'partial_outage';
            case 'critical': return 'major_outage';
            case 'maintenance': return 'maintenance';
            default: return 'unknown';
        }
    }

    async function fetchStatuspage(base) {
        const res = await fetch(base.replace(/\/$/, '') + '/api/v2/status.json', { cache: 'no-store' });
        if (!res.ok) return { state: 'unknown', latencyMs: null, error: 'mirror ' + res.status };
        const json = await res.json();
        return { state: mapStatuspageIndicator(json && json.status && json.status.indicator), latencyMs: null };
    }

    // Known upstream status feeds. Extend this registry, or pass a Statuspage
    // base URL directly as the mirror value.
    const MIRRORS = {
        appwrite: { url: 'https://cloud.appwrite.io/v1/health', path: 'status', map: v => (v === 'pass' ? 'operational' : 'degraded') },
        github: { statuspage: 'https://www.githubstatus.com' },
        cloudflare: { statuspage: 'https://www.cloudflarestatus.com' },
        stripe: { statuspage: 'https://status.stripe.com' },
        openai: { statuspage: 'https://status.openai.com' },
        anthropic: { statuspage: 'https://status.anthropic.com' },
        discord: { statuspage: 'https://discordstatus.com' },
        npm: { statuspage: 'https://status.npmjs.org' },
        vercel: { statuspage: 'https://www.vercel-status.com' },
        netlify: { statuspage: 'https://www.netlifystatus.com' }
    };

    async function mirror(sig) {
        // A bare URL is treated as a Statuspage base, so any provider works
        // without a registry entry.
        if (/^https?:\/\//.test(sig.mirror)) {
            try { return await fetchStatuspage(sig.mirror); }
            catch (_) { return { state: 'unknown', latencyMs: null, error: 'mirror failed' }; }
        }
        const m = MIRRORS[sig.mirror];
        if (!m) return { state: 'unknown', latencyMs: null, error: 'unknown mirror: ' + sig.mirror };
        try {
            if (m.statuspage) return await fetchStatuspage(m.statuspage);
            const res = await fetch(m.url, { cache: 'no-store' });
            if (!res.ok) return { state: 'unknown', latencyMs: null, error: 'mirror ' + res.status };
            const json = await res.json();
            const raw = m.path ? dig(json, m.path) : json;
            return { state: m.map ? m.map(raw) : normalizeFeedState(raw), latencyMs: null };
        } catch (_) {
            return { state: 'unknown', latencyMs: null, error: 'mirror failed' };
        }
    }

    // Heartbeats: external systems call $status.beat(key); absence past the
    // window reads as a major outage (dead-man's switch).
    const heartbeats = {};
    function recordHeartbeat(key) { heartbeats[key] = Date.now(); }
    function resolveHeartbeat(sig) {
        const last = heartbeats[sig.heartbeat];
        if (!last) return { state: 'unknown', latencyMs: null, error: 'no heartbeat yet' };
        const overdue = (Date.now() - last) > (sig.expectEvery || 60000);
        return { state: overdue ? 'major_outage' : 'operational', latencyMs: null };
    }

    async function resolveSignal(sig, ctx) {
        switch (sig.type) {
            case 'static': return { state: sig.state || 'unknown', latencyMs: null };
            case 'probe': return await probe(sig);
            case 'feed': return await feed(sig);
            case 'mirror': return await mirror(sig);
            case 'heartbeat': return resolveHeartbeat(sig);
            case 'appwrite': {
                const base = ctx && ctx.appwriteEndpoint;
                if (!base) return { state: 'unknown', latencyMs: null, error: 'no appwrite endpoint' };
                return await probe({ ...sig, url: base.replace(/\/$/, '') + '/health' });
            }
            case 'mcp':
                if (typeof sig.mcp === 'string' && /^https?:\/\//.test(sig.mcp)) return await feed({ ...sig, url: sig.mcp });
                return { state: 'unknown', latencyMs: null, error: 'mcp provider not configured' };
            default:
                return { state: 'unknown', latencyMs: null };
        }
    }

    // Fold resolved child signals into one entry health.
    function rollup(entry, resolved) {
        const level = window.ManifestStatusStore.level;
        const known = resolved.filter(r => r.state && r.state !== 'unknown');

        let winner = null;
        if (known.length) {
            winner = entry.rollup === 'best'
                ? known.reduce((a, b) => (level(b.state) < level(a.state) ? b : a))
                : known.reduce((a, b) => (level(b.state) > level(a.state) ? b : a));
        }
        const state = winner ? winner.state : 'unknown';
        const message = winner ? (winner.message || null) : null;

        const latencies = resolved.map(r => r.latencyMs).filter(n => typeof n === 'number');
        const latencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
        return { state, level: level(state), up: state === 'operational', latencyMs, message, history: winner ? winner.history : undefined, uptime: winner ? winner.uptime : undefined };
    }

    window.ManifestStatusSignals = { resolveSignal, rollup, recordHeartbeat, normalizeFeedState, MIRRORS };
})();


/*  Manifest Status — main
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
*/

(function () {
    'use strict';

    /* Shared `_ui` text resolver — defined once across plugins, first load wins.
       Localizes baked-in labels via any data source's `_ui` key. Kept identical
       across copies. */
    if (!window.ManifestUI) {
        window.ManifestUI = {
            _loadedSourceNames() {
                try {
                    const store = window.ManifestDataStore && window.ManifestDataStore.rawDataStore;
                    if (store && typeof store.keys === 'function') return [...store.keys()];
                } catch (_) { }
                return [];
            },
            resolve(component, fallbacks) {
                const merged = JSON.parse(JSON.stringify(fallbacks || {}));
                try {
                    if (!window.Alpine || typeof Alpine.evaluate !== 'function') return merged;
                    try { Alpine.evaluate(document.body, '$locale && $locale.current'); } catch (_) { } // dep → re-resolve on locale switch
                    for (const name of this._loadedSourceNames()) {
                        let ui;
                        try { ui = Alpine.evaluate(document.body, `$x['${name}'] && $x['${name}']._ui && $x['${name}']._ui['${component}']`); } catch (_) { ui = null; }
                        if (ui && typeof ui === 'object' && !Array.isArray(ui)) this._deepOverlay(merged, ui);
                    }
                } catch (_) { }
                return merged;
            },
            _deepOverlay(target, src) {
                for (const k of Object.keys(src)) {
                    if (k.startsWith('$') || k === 'contentType' || k === 'valueOf' || k === 'toString') continue;
                    const v = src[k];
                    if (typeof v === 'function') continue;
                    if (v && typeof v === 'object' && !Array.isArray(v)) {
                        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
                        this._deepOverlay(target[k], v);
                    } else if (v !== undefined && v !== null && v !== '') {
                        target[k] = v;
                    }
                }
            }
        };
    }

    let config = null;
    const timers = {};
    const overrides = {};      // name -> forced state (manual override wins)
    const lastKnown = {};      // name -> ts of last non-unknown rollup
    const committed = {};      // name -> currently displayed state (post-hysteresis)
    const pending = {};        // name -> { state, count } candidate awaiting confirmations
    const histories = {};      // name -> ring buffer of observed states
    let incidentSeq = 0;

    function store() { return window.Alpine && window.Alpine.store('status'); }

    // Debounce: a new state must be observed `confirmations` times in a row
    // before it replaces the committed one (default 1 = commit immediately).
    function applyHysteresis(entry, observed) {
        const need = entry.confirmations || 1;
        const prev = committed[entry.name];
        if (prev === undefined) { committed[entry.name] = observed; return observed; }
        if (observed === prev) { delete pending[entry.name]; return prev; }
        const p = pending[entry.name];
        if (p && p.state === observed) p.count++;
        else pending[entry.name] = { state: observed, count: 1 };
        if (pending[entry.name].count >= need) {
            committed[entry.name] = observed;
            delete pending[entry.name];
            return observed;
        }
        return prev;
    }

    function commit(name, health) {
        const s = store();
        if (!s) return;
        s.entries[name] = health;
        s._version++;
    }

    // --- Incident log (shared on the store, surfaced as $status.incidents) ---
    function logIncident(name, state, message) {
        const s = store(); if (!s) return;
        const open = s.incidents.find(i => i.name === name && !i.resolved);
        const now = Date.now();
        if (open) { open.state = state; if (message) open.message = message; open.updatedAt = now; }
        else { s.incidents.unshift({ id: 'inc_' + (++incidentSeq), name, state, message: message || null, at: now, updatedAt: now, resolved: false, resolvedAt: null }); }
        s._version++;
    }
    function resolveIncident(name) {
        const s = store(); if (!s) return;
        const open = s.incidents.find(i => i.name === name && !i.resolved);
        if (open) { open.resolved = true; open.resolvedAt = Date.now(); s._version++; }
    }
    function mergeIncidents(list) {
        const s = store(); if (!s) return;
        let changed = false;
        for (const inc of list) {
            if (!inc || !inc.id) continue;
            if (!s.incidents.some(x => x.id === inc.id)) { s.incidents.unshift(inc); changed = true; }
        }
        if (changed) s._version++;
    }

    async function refreshEntry(entry) {
        const ctx = { appwriteEndpoint: config && config.appwriteEndpoint };
        const Signals = window.ManifestStatusSignals;
        const level = window.ManifestStatusStore.level;

        const resolved = await Promise.all(entry.signals.map(async (sig) => {
            const r = await Signals.resolveSignal(sig, ctx);
            return { type: sig.type, label: sig.label, state: r.state, level: level(r.state), up: r.state === 'operational', latencyMs: r.latencyMs, message: r.message || null, history: r.history, uptime: r.uptime, incidents: r.incidents, error: r.error || null };
        }));

        const rolled = Signals.rollup(entry, resolved);

        // Manual override wins and bypasses hysteresis.
        let state, message = null;
        if (overrides[entry.name]) {
            state = overrides[entry.name].state;
            message = overrides[entry.name].message || null;
            committed[entry.name] = state;
            delete pending[entry.name];
        } else {
            state = applyHysteresis(entry, rolled.state);
            // Only carry the rolled message if the committed state matches it.
            message = (state === rolled.state) ? (rolled.message || null) : null;
        }

        const now = Date.now();
        if (state !== 'unknown') lastKnown[entry.name] = now;
        const stale = lastKnown[entry.name] ? (now - lastKnown[entry.name]) > entry.staleAfter : true;

        // History + uptime: use feed-provided values when present, else accumulate live.
        let hist;
        if (Array.isArray(rolled.history)) {
            hist = rolled.history.slice(-entry.history);
            while (hist.length < entry.history) hist.unshift('unknown');
        } else {
            // Pre-fill with `unknown` so the bar is full-width and fills from the right.
            hist = histories[entry.name] ? histories[entry.name].slice() : new Array(entry.history).fill('unknown');
            hist.push(state);
            if (hist.length > entry.history) hist = hist.slice(hist.length - entry.history);
        }
        histories[entry.name] = hist;
        const seen = hist.filter(x => x && x !== 'unknown');
        const uptime = (typeof rolled.uptime === 'number') ? rolled.uptime
            : (seen.length ? Math.round((seen.filter(x => x === 'operational').length / seen.length) * 1000) / 10 : null);

        // Merge any feed-sourced incidents into the shared log.
        const feedIncidents = resolved.flatMap(r => Array.isArray(r.incidents) ? r.incidents : []);
        if (feedIncidents.length) mergeIncidents(feedIncidents);

        const s = store();
        commit(entry.name, {
            name: entry.name,
            state,
            level: level(state),
            up: state === 'operational',
            latencyMs: rolled.latencyMs,
            message,
            uptime,
            history: hist,
            incidents: s ? s.incidents.filter(i => i.name === entry.name) : [],
            updatedAt: now,
            stale,
            signals: resolved
        });
    }

    function refreshAll() {
        if (!config) return;
        for (const entry of Object.values(config.entries)) refreshEntry(entry);
    }

    function startPolling() {
        if (!config) return;
        for (const entry of Object.values(config.entries)) {
            refreshEntry(entry);
            if (entry.refresh && entry.refresh > 0) {
                timers[entry.name] = setInterval(() => refreshEntry(entry), entry.refresh);
            }
        }
        const s = store();
        if (s) { s._ready = true; s._version++; }
    }

    function overall() {
        const s = store();
        const level = window.ManifestStatusStore.level;
        if (!s) return 'unknown';
        const known = Object.values(s.entries).filter(v => v.state && v.state !== 'unknown');
        if (!known.length) return 'unknown';
        return known.reduce((a, b) => (level(b.state) > level(a.state) ? b : a)).state;
    }

    // Default English labels; overridable per-locale via a data source's `_ui.status.label`.
    const UI_FALLBACK = {
        label: {
            operational: 'Operational',
            degraded: 'Degraded',
            partial_outage: 'Partial Outage',
            major_outage: 'Major Outage',
            maintenance: 'Maintenance',
            unknown: 'Unknown'
        }
    };

    // Resolve `$x`/`$locale`/`${…}` reference strings in `_ui` values.
    function _resolveRefString(val) {
        if (typeof val !== 'string' || val.length === 0) return val;
        const trimmed = val.trim();
        const isBareRef = trimmed.startsWith('$x.') || trimmed.startsWith('$locale')
            || trimmed.startsWith('$x[') || trimmed.startsWith('$locale[');
        const hasInterp = /\$\{[^}]+\}/.test(trimmed);
        if (!isBareRef && !hasInterp) return val;
        try {
            if (window.Alpine?.evaluate) {
                const expr = isBareRef && !hasInterp ? trimmed : '`' + trimmed + '`';
                const out = Alpine.evaluate(document.body, expr);
                if (out == null) return val;
                return typeof out === 'string' ? out : String(out);
            }
        } catch { }
        return val;
    }

    // Human label for a state, localized through `_ui`, else title-cased.
    function formatStateLabel(state) {
        // Dep on the data store version so labels re-resolve when a `_ui` source loads late.
        try { void (window.Alpine && Alpine.store('data')?._dataVersion); } catch (_) { }
        const ui = window.ManifestUI ? window.ManifestUI.resolve('status', UI_FALLBACK) : UI_FALLBACK;
        const labels = (ui && ui.label) || UI_FALLBACK.label;
        if (labels[state]) return _resolveRefString(labels[state]);
        return String(state == null ? '' : state).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    // Reserved accessor names — never treated as entries or enumerated.
    const RESERVED = new Set(['overall', 'all', 'ready', 'incidents', 'label', 'set', 'clear', 'refresh', 'beat']);

    function setOverride(name, state, message) {
        overrides[name] = { state, message: message || null };
        committed[name] = state;
        delete pending[name];
        // An operator update is an incident: open/append, or resolve when back to operational.
        if (state === 'operational') { if (message) logIncident(name, state, message); resolveIncident(name); }
        else { logIncident(name, state, message); }
        const e = config && config.entries[name];
        if (e) refreshEntry(e);
    }

    function clearOverride(name) {
        delete overrides[name];
        delete committed[name];   // re-seed from next observation
        delete pending[name];
        resolveIncident(name);
        const e = config && config.entries[name];
        if (e) refreshEntry(e);
    }

    function registerMagic() {
        if (!window.Alpine) return;
        window.Alpine.magic('status', () => {
            const s = store();
            const entries = () => (s ? s.entries : {});
            return new Proxy({}, {
                get(_, prop) {
                    if (prop === Symbol.toPrimitive) return () => overall();
                    if (prop === Symbol.iterator) { void (s && s._version); return Object.values(entries())[Symbol.iterator].bind(Object.values(entries())); }
                    if (typeof prop === 'symbol') return undefined;

                    // Touch the version counter so every read is a reactive dep.
                    void (s && s._version);

                    if (prop === 'overall') return overall();
                    if (prop === 'all') return entries();
                    if (prop === 'incidents') return s ? s.incidents : [];
                    if (prop === 'label') return formatStateLabel;
                    if (prop === 'ready') return !!(s && s._ready);
                    if (prop === 'set') return setOverride;
                    if (prop === 'clear') return clearOverride;
                    if (prop === 'refresh') return (name) => { if (name) { const e = config && config.entries[name]; if (e) refreshEntry(e); } else refreshAll(); };
                    if (prop === 'beat') return (key) => window.ManifestStatusSignals.recordHeartbeat(key);

                    return entries()[prop] || window.ManifestStatusStore.emptyHealth(String(prop));
                },
                // Enumerate only real entries so x-for over $status yields services.
                ownKeys() { void (s && s._version); return Object.keys(entries()); },
                getOwnPropertyDescriptor(_, prop) {
                    if (typeof prop === 'string' && !RESERVED.has(prop) && Object.prototype.hasOwnProperty.call(entries(), prop)) {
                        return { enumerable: true, configurable: true, value: entries()[prop] };
                    }
                    return undefined;
                },
                has(_, prop) { return Object.prototype.hasOwnProperty.call(entries(), prop); }
            });
        });
    }

    async function init() {
        window.ManifestStatusStore.initializeStore();
        registerMagic();
        config = await window.ManifestStatusConfig.getStatusConfig();
        if (!config) return;   // no status block → plugin stays inert
        startPolling();
    }

    let initialized = false;
    function ensureInitialized() {
        if (initialized) return;
        if (!window.Alpine || typeof window.Alpine.magic !== 'function') return;
        initialized = true;
        init();
    }

    window.ensureManifestStatusInitialized = ensureInitialized;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureInitialized);
    }
    document.addEventListener('alpine:init', ensureInitialized);

    if (window.Alpine && typeof window.Alpine.magic === 'function') {
        setTimeout(ensureInitialized, 0);
    } else {
        const checkAlpine = setInterval(() => {
            if (window.Alpine && typeof window.Alpine.magic === 'function') {
                clearInterval(checkAlpine);
                ensureInitialized();
            }
        }, 10);
        setTimeout(() => clearInterval(checkAlpine), 5000);
    }
})();
