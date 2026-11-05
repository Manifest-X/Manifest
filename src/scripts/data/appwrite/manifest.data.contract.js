/* Manifest Data Sources - Contract checks */

// Rows of Appwrite sources whose table the contract declares throw on reads of
// columns that are neither declared nor present. Dev hosts by default.
(function () {
    const proxies = new WeakMap();
    const targets = new WeakMap();
    const warned = new Set();
    // Read by the framework on every row; storage columns are added per source
    const ALLOWED = new Set(['then', 'catch', 'finally', 'toJSON', 'length', 'contentType', 'fileIds']);
    let enabled;
    let tables = null;
    const tableBySource = new Map();

    function devHost(h) {
        return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === '0.0.0.0' ||
            h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.test');
    }

    function hostMatches(pattern, host) {
        const re = new RegExp('^' + String(pattern).toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*') + '$');
        return re.test(host);
    }

    function config(manifest) {
        const c = manifest && manifest.contract;
        if (typeof c === 'string') return { module: c, checks: 'dev' };
        if (c && typeof c === 'object' && typeof c.module === 'string') return { module: c.module, checks: c.checks === undefined ? 'dev' : c.checks };
        return null;
    }

    function decide(manifest) {
        const cfg = config(manifest);
        if (!cfg || cfg.checks === false) return false;
        const host = String(location.hostname || '').toLowerCase();
        if (cfg.checks === true) return cfg;
        if (devHost(host)) return cfg;
        return Array.isArray(cfg.checks) && cfg.checks.some(p => hostMatches(p, host)) ? cfg : false;
    }

    function load(manifest, cfg) {
        import(new URL(cfg.module, location.href).href).then(mod => {
            tables = mod && mod.tables && typeof mod.tables === 'object' ? mod.tables : {};
            const defaultDb = manifest.appwrite && (manifest.appwrite.databaseId || manifest.appwrite.database);
            for (const [source, src] of Object.entries(manifest.data || {})) {
                if (!src || typeof src.appwriteTableId !== 'string') continue;
                const db = src.appwriteDatabaseId || defaultDb;
                const hit = Object.entries(tables).find(([key, t]) => t && (t.id || key) === src.appwriteTableId && (!t.database || !db || t.database === db));
                if (!hit || !Array.isArray(hit[1].columns)) continue;
                const columns = new Set(hit[1].columns);
                for (const c of Object.values(src.storage || {})) columns.add(typeof c === 'string' ? c : (c && c.column) || 'fileIds');
                tableBySource.set(source, { key: hit[0], columns });
            }
        }).catch(e => {
            console.warn(`[Manifest] contract ${cfg.module} failed to load; column checks are off`, e);
            tables = {};
        });
    }

    function isEnabled() {
        if (enabled !== undefined) return enabled;
        const manifest = window.__manifestLoaded;
        if (!manifest) return false;
        const cfg = decide(manifest);
        enabled = !!cfg;
        if (cfg) load(manifest, cfg);
        return enabled;
    }

    const known = (key, table) => key[0] === '$' || key[0] === '_' || ALLOWED.has(key) || table.columns.has(key);

    function drift(source, table, row) {
        for (const key of Object.keys(row)) {
            if (known(key, table) || warned.has(source + '\0' + key)) continue;
            warned.add(source + '\0' + key);
            console.warn(`[Manifest] data source "${source}" has column "${key}", which the contract does not declare for "${table.key}"`);
        }
    }

    function guard(source, row) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !isEnabled()) return row;
        const existing = proxies.get(row);
        if (existing) return existing;
        let checked = false;
        const proxy = new Proxy(row, {
            get(target, key, receiver) {
                if (typeof key === 'string' && tables) {
                    const table = tableBySource.get(source);
                    if (table) {
                        if (!checked) { checked = true; drift(source, table, target); }
                        if (!known(key, table) && !(key in target)) {
                            throw new Error(`[Manifest] "${key}" is not a column of "${table.key}" in the contract (data source "${source}")`);
                        }
                    }
                }
                return Reflect.get(target, key, receiver);
            }
        });
        proxies.set(row, proxy);
        proxies.set(proxy, proxy);
        targets.set(proxy, row);
        return proxy;
    }

    // Framework reads go through the unchecked row
    const raw = (obj) => (obj && targets.get(obj)) || obj;

    window.ManifestDataContract = { guard, raw };
})();
