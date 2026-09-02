/* Manifest Data Sources - Persistence (IndexedDB) */
// Per-source snapshots hydrated before the network with fresh:false, keyed by
// `${scope}|${source}` (PERF-PRIMITIVES-DESIGN.md §12.2). Off unless a source
// opts in via manifest.json `persist`.

(function () {
    const STORE_NAME = 'sources';
    const DB_VERSION = 1;
    const WRITE_DEBOUNCE_MS = 500;
    const BOOT_HYDRATE_MAX_WAIT_MS = 100;
    const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const DEFAULT_MAX_ROWS = 1000;
    const SECRET_PATTERNS = ['*secret*', '*token*', '*password*', 'credentials*'];
    const NEVER_PERSIST_KEYS = new Set(['$files', '$filesLoading', '$filesError']);
    const AUTH_EVENTS = ['manifest:auth:login', 'manifest:auth:logout', 'manifest:auth:anonymous',
        'manifest:auth:session-cleared', 'manifest:auth:initialized', 'manifest:auth:teams-loaded'];
    const WIPE_EVENTS = new Set(['manifest:auth:logout', 'manifest:auth:session-cleared']);

    const state = {
        configured: false,
        enabled: false,        // at least one source opted in and IndexedDB exists
        disabled: false,       // runtime failure → off for the rest of the session
        disabledReason: null,
        dbName: null,
        dbPromise: null,
        sources: new Map(),    // source -> config (+ rows/savedAt bookkeeping)
        filters: new Map(),    // source -> row filter
        scopeExpr: null,
        scopeFn: null,
        scope: '',
        generation: 0,
        pending: new Map(),    // source -> time its debounced write is due
        writeTimer: null,
        hydrated: new Set(),   // sources hydrated (or attempted) this generation
        fetchKicked: new Set(),
        watching: false,
        deployment: null,
        frameworkVersion: null,
        warned: new Set()
    };

    const dataStore = () => window.ManifestDataStore;
    const alpineData = () => (typeof Alpine !== 'undefined' && Alpine.store ? Alpine.store('data') : null);
    const keyOf = (scope, source) => `${scope}|${source}`;
    const liveLocale = () => (typeof document !== 'undefined' && document.documentElement?.lang)
        || (typeof Alpine !== 'undefined' && Alpine.store?.('locale')?.current) || 'en';

    function warnOnce(key, message, error) {
        if (state.warned.has(key)) return;
        state.warned.add(key);
        console.warn(`[Manifest Data] ${message}`, error || '');
    }

    function disable(error) {
        if (state.disabled) return;
        state.disabled = true;
        state.disabledReason = error?.name || error?.message || String(error);
        cancelWrites();
        warnOnce('disabled', `persistence disabled for this session (${state.disabledReason})`);
    }

    // ---- config ----

    function parseTtl(value) {
        if (typeof value === 'number') return value > 0 ? value : DEFAULT_TTL_MS;
        if (typeof value !== 'string') return DEFAULT_TTL_MS;
        const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i);
        if (!m) return DEFAULT_TTL_MS;
        const unit = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[(m[2] || 'ms').toLowerCase()];
        const ms = parseFloat(m[1]) * unit;
        return ms > 0 ? ms : DEFAULT_TTL_MS;
    }

    function globToRegExp(pattern) {
        const escaped = String(pattern).split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        return new RegExp(`^${escaped}$`, 'i');
    }

    function normalizeConfig(raw) {
        if (raw !== true && (!raw || typeof raw !== 'object')) return null;
        const opts = raw === true ? {} : raw;
        const strip = Array.isArray(opts.strip) ? opts.strip : (typeof opts.strip === 'string' ? [opts.strip] : []);
        const maxRows = Number.isFinite(opts.maxRows) && opts.maxRows > 0 ? Math.floor(opts.maxRows) : DEFAULT_MAX_ROWS;
        return {
            tier: opts.tier === 'lazy' ? 'lazy' : 'boot',
            maxRows,
            recent: typeof opts.recent === 'string' && opts.recent ? opts.recent : null,
            ttl: parseTtl(opts.ttl),
            stripPatterns: [...SECRET_PATTERNS, ...strip].map(globToRegExp),
            rows: null,
            savedAt: null
        };
    }

    function frameworkVersion() {
        if (typeof MANIFEST_BUILD_VERSION === 'string') return MANIFEST_BUILD_VERSION;
        const src = typeof document !== 'undefined' ? document.currentScript?.src : null;
        const m = src && src.match(/mnfst@(\d+\.\d+\.\d+[^/]*)/);
        return m ? m[1] : '0.0.0';
    }
    const buildVersion = frameworkVersion();

    function majorMinor(version) {
        const m = String(version || '').match(/^(\d+)\.(\d+)/);
        return m ? `${m[1]}.${m[2]}` : null;
    }

    // Reads `persist` per source and top-level `persistence`; true when anything opted in
    function configure(manifest) {
        state.configured = true;
        state.sources.clear();
        for (const [name, source] of Object.entries(manifest?.data || {})) {
            if (!source || typeof source !== 'object') continue;
            const cfg = normalizeConfig(source.persist);
            if (cfg) state.sources.set(name, cfg);
        }
        state.scopeExpr = typeof manifest?.persistence?.scope === 'string' && manifest.persistence.scope.trim()
            ? manifest.persistence.scope.trim() : null;
        state.scopeFn = null;
        state.deployment = manifest?.deployment || null;
        state.frameworkVersion = buildVersion;
        const projectId = manifest?.projectId || manifest?.project?.id || null;
        const origin = (typeof location !== 'undefined' && location.origin) || 'null';
        state.dbName = `manifest:${origin}${projectId ? `:${projectId}` : ''}`;
        state.enabled = state.sources.size > 0 && typeof indexedDB !== 'undefined' && !!indexedDB;
        if (!state.enabled) return false;
        state.scope = evaluateScope();
        watchScope();
        return true;
    }

    // Late enable (runtime registration, other primitives on the same store)
    function ensureEnabled() {
        if (state.enabled || state.disabled) return state.enabled;
        if (typeof indexedDB === 'undefined' || !indexedDB) return false;
        state.enabled = true;
        if (!state.dbName) state.dbName = `manifest:${(typeof location !== 'undefined' && location.origin) || 'null'}`;
        if (!state.frameworkVersion) state.frameworkVersion = buildVersion;
        state.scope = evaluateScope();
        watchScope();
        return true;
    }

    // Runtime registration (harness/tests): same shape as manifest.json
    function register(source, config) {
        const cfg = normalizeConfig(config === undefined ? true : config);
        if (!cfg) { state.sources.delete(source); return false; }
        state.sources.set(source, cfg);
        state.hydrated.delete(source);
        state.fetchKicked.delete(source);
        ensureEnabled();
        return true;
    }

    function setScope(expression) {
        state.scopeExpr = typeof expression === 'string' && expression.trim() ? expression.trim() : null;
        state.scopeFn = null;
        watchScope();
        refreshScope();
    }

    // ---- scope ----

    // Expression scope: `$name` → Alpine.store(name) (so `$auth` tracks reactively),
    // else window[$name] (`$x`); bare names → globals
    function magicScope() {
        return new Proxy(Object.create(null), {
            has: () => true,
            get(_, name) {
                if (typeof name !== 'string') return undefined;
                if (name[0] === '$') {
                    if (name === '$store') return (n) => (typeof Alpine !== 'undefined' ? Alpine.store(n) : undefined);
                    if (typeof Alpine !== 'undefined' && Alpine.store) {
                        const s = Alpine.store(name.slice(1));
                        if (s !== undefined) return s;
                    }
                    return typeof window !== 'undefined' ? window[name] : undefined;
                }
                return globalThis[name];
            }
        });
    }

    function evaluateScope() {
        if (!state.scopeExpr) return '';
        try {
            if (!state.scopeFn) state.scopeFn = new Function('__scope', `with (__scope) { return (${state.scopeExpr}); }`);
            const value = state.scopeFn(magicScope());
            return value === null || value === undefined || value === false ? '' : String(value);
        } catch (error) {
            warnOnce('scope', `persistence scope "${state.scopeExpr}" failed to evaluate; using ""`, error);
            return '';
        }
    }

    function refreshScope() {
        if (!state.enabled) return;
        const next = evaluateScope();
        if (next !== state.scope) changeScope(next);
    }

    function watchScope() {
        if (state.watching || typeof window === 'undefined') return;
        state.watching = true;
        for (const type of AUTH_EVENTS) {
            window.addEventListener(type, () => {
                if (!state.enabled) return;
                if (WIPE_EVENTS.has(type)) deleteScope(state.scope);
                refreshScope();
            });
        }
        // Reactive re-evaluation (team switches that fire no event); the switch itself runs outside the effect
        if (typeof Alpine !== 'undefined' && Alpine.effect) {
            Alpine.effect(() => {
                if (!state.scopeExpr) return;
                const next = evaluateScope();
                if (next !== state.scope) queueMicrotask(refreshScope);
            });
        }
    }

    // Scope switch: previous entries wiped, memory rows of persisted sources
    // cleared (older loads discarded), new scope hydrates
    function changeScope(next) {
        const prev = state.scope;
        state.scope = next;
        state.generation++;
        cancelWrites();
        state.hydrated.clear();
        state.fetchKicked.clear();
        const ds = dataStore();
        for (const [source, cfg] of state.sources) {
            cfg.rows = null;
            cfg.savedAt = null;
            ds?.resetSource?.(source);
        }
        if (prev !== next) deleteScope(prev);
        hydrateBoot();
        if (typeof window !== 'undefined') {
            try { window.dispatchEvent(new CustomEvent('manifest:persist:scope', { detail: { scope: next, previous: prev } })); } catch { /* no-op */ }
        }
    }

    // ---- IndexedDB ----

    function openDb() {
        if (state.dbPromise) return state.dbPromise;
        state.dbPromise = new Promise((resolve, reject) => {
            let request;
            try { request = indexedDB.open(state.dbName, DB_VERSION); } catch (error) { reject(error); return; }
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { try { db.close(); } catch { /* no-op */ } state.dbPromise = null; };
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
            request.onblocked = () => reject(new Error('IndexedDB open blocked'));
        }).catch(error => { disable(error); return null; });
        return state.dbPromise;
    }

    const promisify = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });

    // One transaction per call; any failure (quota included) disables persistence silently
    async function withStore(mode, fn) {
        if (!state.enabled || state.disabled) return undefined;
        const db = await openDb();
        if (!db || state.disabled) return undefined;
        try {
            const tx = db.transaction(STORE_NAME, mode);
            const done = new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
                tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
            });
            const result = await fn(tx.objectStore(STORE_NAME), tx);
            await done;
            return result;
        } catch (error) {
            disable(error);
            return undefined;
        }
    }

    function readRecords(keys) {
        return withStore('readonly', (store) => Promise.all(keys.map(key => promisify(store.get(key)))));
    }

    function putRecord(record) {
        return withStore('readwrite', (store) => { store.put(record); });
    }

    function deleteKeys(keys) {
        if (!keys.length) return Promise.resolve();
        return withStore('readwrite', (store) => { for (const key of keys) store.delete(key); });
    }

    async function deleteScope(scope) {
        const prefix = `${scope}|`;
        cancelWrites();
        return withStore('readwrite', async (store) => {
            const keys = await promisify(store.getAllKeys());
            for (const key of keys) if (typeof key === 'string' && key.startsWith(prefix)) store.delete(key);
        });
    }

    // ---- snapshot (write path) ----

    function stripRow(row, patterns) {
        const out = {};
        for (const key of Object.keys(row)) {
            if (NEVER_PERSIST_KEYS.has(key)) continue;
            const value = row[key];
            if (typeof value === 'function') continue;
            if (patterns.some(re => re.test(key))) continue;
            out[key] = value;
        }
        return out;
    }

    function compareRecent(a, b) {
        if (a === b) return 0;
        if (a === undefined || a === null) return -1;
        if (b === undefined || b === null) return 1;
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        const sa = String(a), sb = String(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
    }

    // Keep the `maxRows` most recent by `recent` (or `$updatedAt`), in their original order;
    // no recency field → the last N inserted
    function capRows(rows, cfg) {
        if (rows.length <= cfg.maxRows) return rows;
        const field = cfg.recent || (rows.some(r => r && r.$updatedAt !== undefined) ? '$updatedAt' : null);
        if (!field) return rows.slice(rows.length - cfg.maxRows);
        const order = rows.map((row, i) => i).sort((i, j) => compareRecent(rows[j]?.[field], rows[i]?.[field]) || i - j);
        const keep = new Set(order.slice(0, cfg.maxRows));
        return rows.filter((_, i) => keep.has(i));
    }

    function snapshotOf(source, raw, cfg) {
        const filter = state.filters.get(source);
        if (Array.isArray(raw)) {
            let rows = raw;
            if (filter) {
                rows = [];
                for (const row of raw) {
                    if (row === null || typeof row !== 'object') { rows.push(row); continue; }
                    const kept = filter(row);
                    if (kept === null || kept === undefined) continue;
                    rows.push(typeof kept === 'object' ? kept : row);
                }
            }
            rows = capRows(rows, cfg);
            return rows.map(row => (row && typeof row === 'object') ? stripRow(row, cfg.stripPatterns) : row);
        }
        if (raw && typeof raw === 'object') {
            const kept = filter ? filter(raw) : raw;
            if (kept === null || kept === undefined) return null;
            return stripRow(typeof kept === 'object' ? kept : raw, cfg.stripPatterns);
        }
        return null;
    }

    function snapshotRecord(source) {
        const cfg = state.sources.get(source);
        const ds = dataStore();
        if (!cfg || !ds) return null;
        const raw = ds.getRawData(source);
        if (raw === null || raw === undefined) return null;
        try {
            const snapshot = snapshotOf(source, raw, cfg);
            if (snapshot === null) return null;
            return {
                key: keyOf(state.scope, source),
                scope: state.scope,
                source,
                rows: JSON.parse(JSON.stringify(snapshot)),
                savedAt: Date.now(),
                frameworkVersion: state.frameworkVersion,
                deployment: state.deployment,
                locale: liveLocale()
            };
        } catch (error) {
            warnOnce(`snapshot:${source}`, `persistence skipped "${source}" (rows are not serialisable)`, error);
            return null;
        }
    }

    // Every source whose debounce has elapsed is written in ONE transaction
    function flush(sources) {
        for (const source of sources) state.pending.delete(source);
        if (!state.enabled || state.disabled) return Promise.resolve();
        const records = sources.map(snapshotRecord).filter(Boolean);
        if (!records.length) return Promise.resolve();
        const generation = state.generation;
        return withStore('readwrite', (store) => { for (const record of records) store.put(record); }).then(() => {
            if (generation !== state.generation || state.disabled) return;
            for (const record of records) {
                const cfg = state.sources.get(record.source);
                if (!cfg) continue;
                cfg.rows = Array.isArray(record.rows) ? record.rows.length : 1;
                cfg.savedAt = record.savedAt;
            }
        });
    }

    function flushDue() {
        state.writeTimer = null;
        const now = Date.now();
        const due = [];
        for (const [source, at] of state.pending) if (at - now <= 5) due.push(source);
        const run = due.length ? flush(due) : Promise.resolve();
        scheduleWrites();
        return run.catch(() => { /* disabled */ });
    }

    function scheduleWrites() {
        if (state.writeTimer !== null || !state.pending.size) return;
        let next = Infinity;
        for (const at of state.pending.values()) if (at < next) next = at;
        state.writeTimer = setTimeout(flushDue, Math.max(0, next - Date.now()));
    }

    function cancelWrites(source) {
        if (source !== undefined) { state.pending.delete(source); return; }
        state.pending.clear();
        if (state.writeTimer !== null) { clearTimeout(state.writeTimer); state.writeTimer = null; }
    }

    // Landing hook (store flush): each landing restarts that source's 500ms debounce
    function onLanded(sources) {
        if (!state.enabled || state.disabled) return;
        const at = Date.now() + WRITE_DEBOUNCE_MS;
        for (const source of sources) if (state.sources.has(source)) state.pending.set(source, at);
        if (state.writeTimer !== null) { clearTimeout(state.writeTimer); state.writeTimer = null; }
        scheduleWrites();
    }

    // ---- hydration (read path) ----

    function validRecord(record, cfg) {
        if (!record || typeof record !== 'object' || record.scope !== state.scope) return { ok: false };
        if (record.rows === null || record.rows === undefined) return { ok: false, drop: true };
        if (typeof record.savedAt !== 'number' || Date.now() - record.savedAt > cfg.ttl) return { ok: false, drop: true };
        if (majorMinor(record.frameworkVersion) !== majorMinor(state.frameworkVersion)) return { ok: false, drop: true };
        if (record.locale && record.locale !== liveLocale()) return { ok: false };
        return { ok: true };
    }

    // One transaction for every requested key; a hydration arriving after the
    // fresh landing (or after a scope change) is discarded
    async function hydrate(sources) {
        const ds = dataStore();
        const pending = sources.filter(source => state.sources.has(source) && !state.hydrated.has(source));
        if (!ds || !pending.length || !state.enabled || state.disabled) return;
        for (const source of pending) state.hydrated.add(source);
        const generation = state.generation;
        const scope = state.scope;
        const records = await readRecords(pending.map(source => keyOf(scope, source)));
        if (!records || generation !== state.generation) return;
        const drop = [];
        const landings = [];
        pending.forEach((source, i) => {
            const cfg = state.sources.get(source);
            const record = records[i];
            if (!cfg || !record) return;
            const check = validRecord(record, cfg);
            if (!check.ok) { if (check.drop) drop.push(record.key); return; }
            if (ds.sourceFreshness(source).done) return; // fresh landing already applied
            cfg.rows = Array.isArray(record.rows) ? record.rows.length : 1;
            cfg.savedAt = record.savedAt;
            landings.push(ds.landRows(source, record.rows, { mode: 'replace', ready: true, fresh: false, persistHydration: true, allowDuringInit: true }));
        });
        if (drop.length) deleteKeys(drop).catch(() => { /* disabled */ });
        await Promise.all(landings);
    }

    function bootSources() {
        const out = [];
        for (const [source, cfg] of state.sources) if (cfg.tier === 'boot') out.push(source);
        return out;
    }

    // Boot tier: all keys in one read; the caller caps the wait (cold boot never blocks)
    function hydrateBoot(options = {}) {
        if (!state.enabled || state.disabled) return Promise.resolve();
        const run = hydrate(bootSources()).catch(() => { /* disabled */ });
        const maxWaitMs = options.maxWaitMs;
        if (!Number.isFinite(maxWaitMs)) return run;
        return Promise.race([run, new Promise(resolve => setTimeout(resolve, maxWaitMs))]);
    }

    // First `$x.<source>` read without rows → lazy-tier hydration
    function onRead(source) {
        if (!state.enabled || state.disabled) return;
        const cfg = state.sources.get(source);
        if (!cfg || state.hydrated.has(source)) return;
        hydrate([source]).catch(() => { /* disabled */ });
    }

    // Hydrated (stale) rows still need this page-load's network landing: once per source per scope
    function needsFetch(source) {
        if (!state.enabled || state.disabled) return false;
        const cfg = state.sources.get(source);
        if (!cfg || state.fetchKicked.has(source)) return false;
        const ds = dataStore();
        if (!ds || ds.sourceFreshness(source).done) return false;
        const st = ds.rawOf(alpineData() || {})[`_${source}_state`];
        if (st && (st.loading || st.error)) return false;
        const prefix = `${source}:`;
        for (const key of ds.loadingPromises.keys()) if (key.startsWith(prefix)) return false;
        state.fetchKicked.add(source);
        return true;
    }

    // A kicked load that could not land (init window) may be re-kicked by the next read
    function onFetchSettled(source, result) {
        if (result === null || result === undefined) return;
        const ds = dataStore();
        if (ds && !ds.sourceFreshness(source).done) state.fetchKicked.delete(source);
    }

    // ---- public surface ----

    // $x.$wipe(): current scope; $wipe(source); $wipe({ all: true }): every scope
    async function wipe(arg) {
        if (!state.enabled || state.disabled) return false;
        if (arg && typeof arg === 'object' && arg.all) {
            cancelWrites();
            for (const cfg of state.sources.values()) { cfg.rows = null; cfg.savedAt = null; }
            await withStore('readwrite', (store) => { store.clear(); });
            return !state.disabled;
        }
        if (typeof arg === 'string' && arg) {
            cancelWrites(arg);
            const cfg = state.sources.get(arg);
            if (cfg) { cfg.rows = null; cfg.savedAt = null; }
            await deleteKeys([keyOf(state.scope, arg)]);
            return !state.disabled;
        }
        for (const cfg of state.sources.values()) { cfg.rows = null; cfg.savedAt = null; }
        await deleteScope(state.scope);
        return !state.disabled;
    }

    function persistFilter(source, fn) {
        if (typeof fn === 'function') state.filters.set(source, fn);
        else state.filters.delete(source);
    }

    function persistence() {
        const getState = window.ManifestDataProxiesMagic?.getStateProperty;
        const sources = [];
        for (const [source, cfg] of state.sources) {
            sources.push({
                source,
                tier: cfg.tier,
                rows: cfg.rows,
                savedAt: cfg.savedAt,
                stale: getState ? getState('$stale', source) !== false : true
            });
        }
        const out = { enabled: state.enabled && !state.disabled, scope: state.scope, sources };
        if (state.disabled) out.disabledReason = state.disabledReason;
        return out;
    }

    // Tests/harness: write everything pending now
    async function flushPending() {
        const sources = [...state.pending.keys()];
        if (state.writeTimer !== null) { clearTimeout(state.writeTimer); state.writeTimer = null; }
        if (sources.length) await flush(sources).catch(() => { /* disabled */ });
    }

    // Shared record store for other primitives (chat windows, §12.2 "primitive 3"):
    // same database/object store, scope prefix, stamping and validity rules.
    // Keys are `${scope}|…`, so scope wipes and logout cover these records too.
    function stampRecord(record) {
        return {
            scope: state.scope, savedAt: Date.now(), frameworkVersion: state.frameworkVersion,
            deployment: state.deployment, locale: liveLocale(), ...record
        };
    }
    const records = {
        enable: ensureEnabled,
        enabled: () => state.enabled && !state.disabled,
        scope: () => state.scope,
        key: (...parts) => [state.scope, ...parts].join('|'),
        get: (keys) => readRecords(keys), // one transaction; array aligned with keys (undefined = miss)
        put: (list) => withStore('readwrite', (store) => { for (const record of list) store.put(stampRecord(record)); }),
        delete: (keys) => deleteKeys(keys),
        keys: (prefix) => withStore('readonly', async (store) =>
            (await promisify(store.getAllKeys())).filter(key => typeof key === 'string' && key.startsWith(prefix))),
        clear: () => withStore('readwrite', (store) => { store.clear(); }),
        valid: (record, ttlMs) => validRecord(record, { ttl: Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TTL_MS }).ok,
        stamp: stampRecord,
        ttl: parseTtl
    };

    window.ManifestDataPersist = {
        BOOT_HYDRATE_MAX_WAIT_MS,
        WRITE_DEBOUNCE_MS,
        configure,
        register,
        setScope,
        refreshScope,
        hydrateBoot,
        hydrate,
        onRead,
        needsFetch,
        onFetchSettled,
        onLanded,
        flushPending,
        wipe,
        persistFilter,
        persistence,
        records,
        state
    };

    window.ManifestData = window.ManifestData || {};
    window.ManifestData.persistFilter = persistFilter;
    window.ManifestData.persistence = persistence;
})();
