// $secure — Keychain/Keystore-backed key/value storage (native) with a
// namespaced localStorage fallback on the web. Intended for session tokens etc.
// Native: install a Capacitor secure-storage plugin registered as
// window.Capacitor.Plugins.SecureStorage; if its method shape differs from the
// adapters below, override with $secure.use(adapter). Verify on device.
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

// Adapts the two common Capacitor secure-storage plugin shapes: localStorage-like
// (getItem/setItem/removeItem) or object-arg (get/set/remove with {key,value}).
function manifestSecureNativeBackend(plugin) {
    const itemApi = typeof plugin.getItem === 'function';
    return {
        async get(key) {
            try {
                if (itemApi) { const v = await plugin.getItem(key); return v == null ? null : v; }
                const r = await plugin.get({ key }); return r && typeof r.value !== 'undefined' ? r.value : (r == null ? null : r);
            } catch (e) { return null; }
        },
        async set(key, value) {
            try { if (itemApi) await plugin.setItem(key, String(value)); else await plugin.set({ key, value: String(value) }); } catch (e) {}
        },
        async remove(key) {
            try { if (typeof plugin.removeItem === 'function') await plugin.removeItem(key); else await plugin.remove({ key }); } catch (e) {}
        },
        async keys() { try { const r = await plugin.keys(); return Array.isArray(r) ? r : (r && r.value) || []; } catch (e) { return []; } },
        async clear() { try { await plugin.clear(); } catch (e) {} }
    };
}

let _manifestSecureBackend = null;
function manifestSecureBackend() {
    if (_manifestSecureBackend) return _manifestSecureBackend;
    const plugin = manifestNativePlugin('SecureStorage');
    _manifestSecureBackend = plugin ? manifestSecureNativeBackend(plugin) : manifestSecureWebBackend();
    return _manifestSecureBackend;
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
