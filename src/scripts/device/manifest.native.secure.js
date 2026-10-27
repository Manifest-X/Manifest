// $secure — Keychain/Keystore-backed key/value storage (native) with a
// namespaced localStorage fallback on the web. Intended for session tokens etc.
// Native: a plugin registered as SecureStorage (@aparajita/capacitor-secure-storage,
// or any getItem/setItem or get/set shape); $secure.use(adapter) overrides.
// Native without a plugin rejects; never localStorage.
// The web fallback is NOT encrypted — it degrades honestly, not securely.

const MANIFEST_SECURE_NS = 'mnfst:';

function manifestSecureWebBackend() {
    const ls = () => window.localStorage;
    return {
        async get(key) { try { return ls().getItem(MANIFEST_SECURE_NS + key); } catch (e) { return null; } },
        async set(key, value) { try { ls().setItem(MANIFEST_SECURE_NS + key, String(value)); } catch (e) {} },
        async remove(key) { try { ls().removeItem(MANIFEST_SECURE_NS + key); } catch (e) {} },
        async keys() {
            try { return Object.keys(ls()).filter(k => k.indexOf(MANIFEST_SECURE_NS) === 0).map(k => k.slice(MANIFEST_SECURE_NS.length)); }
            catch (e) { return []; }
        },
        async clear() { try { const ks = await this.keys(); ks.forEach(k => ls().removeItem(MANIFEST_SECURE_NS + k)); } catch (e) {} }
    };
}

// aparajita's default prefix, so keys interop with its own getItem/setItem
const MANIFEST_SECURE_NATIVE_PREFIX = 'capacitor-storage_';

function manifestSecureFail(op, e) {
    try { console.error('[Manifest] $secure.' + op + ' failed', e); } catch (_) {}
    throw e instanceof Error ? e : new Error('$secure.' + op + ' failed: ' + ((e && (e.message || e.code)) || e));
}

// Adapts three native shapes: aparajita (internalGetItem…), localStorage-like
// (getItem/setItem/removeItem) and object-arg (get/set/remove with {key,value}).
function manifestSecureNativeBackend(plugin, name) {
    const n = name || 'SecureStorage';
    const has = (m) => manifestNativeHas(n, plugin, m);
    const P = MANIFEST_SECURE_NATIVE_PREFIX;
    const shape = has('internalGetItem') ? 'internal' : has('getItem') ? 'item' : has('get') ? 'object' : null;
    const call = async (op, fn) => {
        if (!shape) manifestSecureFail(op, new Error(n + ' plugin has no supported API; use $secure.use(adapter)'));
        try { return await fn(); } catch (e) { manifestSecureFail(op, e); }
    };
    return {
        get: (key) => call('get', async () => {
            if (key == null || key === '') return null;
            if (shape === 'internal') { const r = await plugin.internalGetItem({ prefixedKey: P + key }); return r && r.data != null ? r.data : null; }
            if (shape === 'item') { const v = await plugin.getItem(key); return v == null ? null : v; }
            const r = await plugin.get({ key }); return r && typeof r.value !== 'undefined' ? r.value : (r == null ? null : r);
        }),
        set: (key, value) => call('set', async () => {
            if (key == null || key === '') throw new Error('No key provided');
            if (shape === 'internal') await plugin.internalSetItem({ prefixedKey: P + key, data: String(value) });
            else if (shape === 'item') await plugin.setItem(key, String(value));
            else await plugin.set({ key, value: String(value) });
        }),
        remove: (key) => call('remove', async () => {
            if (key == null || key === '') return;
            if (shape === 'internal') await plugin.internalRemoveItem({ prefixedKey: P + key });
            else if (shape === 'item') {
                if (!has('removeItem')) throw new Error(n + ' plugin has no removeItem(); use $secure.use(adapter)');
                await plugin.removeItem(key);
            }
            else await plugin.remove({ key });
        }),
        keys: () => call('keys', async () => {
            if (shape === 'internal') { const r = await plugin.internalGetPrefixedKeys({ prefix: P }); return ((r && r.keys) || []).map(k => k.slice(P.length)); }
            const r = await plugin.keys(); return Array.isArray(r) ? r : (r && (r.keys || r.value)) || [];
        }),
        clear: () => call('clear', async () => {
            if (shape === 'internal') await plugin.internalClearItemsWithPrefix({ prefix: P });
            else await plugin.clear();
        })
    };
}

const MANIFEST_SECURE_NONE = 'No secure-storage plugin is installed; install @aparajita/capacitor-secure-storage and run npx cap sync, or provide one with $secure.use(adapter)';
const MANIFEST_SECURE_UNSYNCED = 'SecureStorage plugin is not installed natively; run npx cap sync';

// Rejects every call, logs once; never falls back to unencrypted web storage
let _manifestSecureMissingLogged = false;
function manifestSecureMissingBackend(msg) {
    const fail = (op) => async () => {
        const e = new Error(msg);
        if (!_manifestSecureMissingLogged) {
            _manifestSecureMissingLogged = true;
            try { console.error('[Manifest] $secure.' + op + ' failed', e); } catch (_) {}
        }
        throw e;
    };
    return { get: fail('get'), set: fail('set'), remove: fail('remove'), keys: fail('keys'), clear: fail('clear') };
}

// Missing backends aren't cached, so a later-registered plugin is picked up
let _manifestSecureBackend = null;
function manifestSecureBackend() {
    if (_manifestSecureBackend) return _manifestSecureBackend;
    if (!manifestNativeIsNative()) return (_manifestSecureBackend = manifestSecureWebBackend());
    const plugin = manifestNativePlugin('SecureStorage');
    if (!plugin) return manifestSecureMissingBackend(MANIFEST_SECURE_NONE);
    if (!manifestNativeInstalled('SecureStorage')) return manifestSecureMissingBackend(MANIFEST_SECURE_UNSYNCED);
    return (_manifestSecureBackend = manifestSecureNativeBackend(plugin, 'SecureStorage'));
}

function initManifestSecure() {
    window.Alpine.magic('secure', () => ({
        get: (k) => manifestSecureBackend().get(k),
        set: (k, v) => manifestSecureBackend().set(k, v),
        remove: (k) => manifestSecureBackend().remove(k),
        keys: () => manifestSecureBackend().keys(),
        clear: () => manifestSecureBackend().clear(),
        use: (adapter) => { _manifestSecureBackend = adapter; }
    }));
}
