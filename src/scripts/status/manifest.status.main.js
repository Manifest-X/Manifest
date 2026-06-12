/*  Manifest Status — main
/*  By Andrew Matlock under MIT license
/*  https://manifestx.dev
/*
/*  Wires the store, polls each entry's signals, and registers the $status
/*  magic. $status.<name> → rolled-up health object; $status.overall → worst
/*  across all entries. The plugin renders nothing: the author drives their own
/*  UI from these reactive values (:class, x-show, x-text, etc.).
*/

(function () {
    'use strict';

    /* Shared global: ManifestUI — universal `_ui` text resolver. Defined once
       and shared across plugins (datepicker/colorpicker/charts/status); the
       `if (!window.ManifestUI)` guard means whichever loads first wins. Lets
       baked-in labels be localized/overridden via any loaded data source's
       `_ui` key, locale-reactive. Kept behaviourally identical across copies. */
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

    // Debounce state changes: a new state must be observed `confirmations`
    // times in a row before it replaces the committed state. confirmations:1
    // (default) commits immediately.
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

        // Manual override wins and bypasses hysteresis; otherwise debounce the
        // observed state through applyHysteresis.
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
            // Pre-fill with `unknown` so the bar is always full width and fills
            // from the right as checks accrue (StatusPage-style no-data segments).
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

    // Default English labels per state; overridable per-locale via any loaded
    // data source's `_ui.status.label` (same mechanism as datepicker/colorpicker).
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

    // Resolve `$x`/`$locale`/`${…}` reference strings in `_ui` values (same
    // treatment as the colorpicker's _resolveRefString — kept semantically
    // identical). Reading inside the caller's effect registers the deps.
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

    // Human label for a state string, localized through `_ui` when available.
    // Falls back to the English default, then a generic title-case for any
    // custom/unrecognized state.
    function formatStateLabel(state) {
        // Dep on the data store version so labels re-resolve when a `_ui`
        // source loads late or reloads on locale switch (same fix as the
        // datepicker's ui effect).
        try { void (window.Alpine && Alpine.store('data')?._dataVersion); } catch (_) { }
        const ui = window.ManifestUI ? window.ManifestUI.resolve('status', UI_FALLBACK) : UI_FALLBACK;
        const labels = (ui && ui.label) || UI_FALLBACK.label;
        if (labels[state]) return _resolveRefString(labels[state]);
        return String(state == null ? '' : state).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    // Reserved accessor names — never treated as entry names or enumerated, so
    // `x-for="(service, name) in $status"` iterates only real services.
    const RESERVED = new Set(['overall', 'all', 'ready', 'incidents', 'label', 'set', 'clear', 'refresh', 'beat']);

    function setOverride(name, state, message) {
        overrides[name] = { state, message: message || null };
        committed[name] = state;
        delete pending[name];
        // An operator update is an incident: open/append, or resolve when set back to operational.
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
