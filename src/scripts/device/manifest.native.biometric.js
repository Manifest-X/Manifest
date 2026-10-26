// $biometric — Face ID / Touch ID. Native: @aparajita/capacitor-biometric-auth
// (BiometricAuthNative) or @capgo/capacitor-native-biometric (NativeBiometric).
// No web equivalent: available() is false and verify() reports unsupported.

const MANIFEST_BIOMETRIC_PLUGINS = ['BiometricAuthNative', 'BiometricAuth', 'NativeBiometric'];

// Native only: bundled web builds expose plugin web stubs that always "verify".
function manifestBiometricPlugin() {
    if (!manifestNativeIsNative()) return null;
    // Prefer one in the native header list; without a list, first registered
    const headers = window.Capacitor && window.Capacitor.PluginHeaders;
    if (Array.isArray(headers)) {
        for (const name of MANIFEST_BIOMETRIC_PLUGINS) {
            const plugin = manifestNativePlugin(name);
            if (plugin && headers.some(h => h && h.name === name)) return { name, plugin };
        }
        return null;
    }
    for (const name of MANIFEST_BIOMETRIC_PLUGINS) {
        const plugin = manifestNativePlugin(name);
        if (plugin) return { name, plugin };
    }
    return null;
}

function manifestBiometricWarn(msg, e) {
    try { console.warn('[Manifest] $biometric: ' + msg, e || ''); } catch (_) {}
}

async function manifestBiometricAvailable() {
    const found = manifestBiometricPlugin();
    if (!found) return false;
    const { name, plugin: B } = found;
    try {
        if (manifestNativeHas(name, B, 'checkBiometry')) { const r = await B.checkBiometry(); return !!(r && r.isAvailable); }
        if (manifestNativeHas(name, B, 'isAvailable')) { const r = await B.isAvailable(); return !!(r && r.isAvailable !== false); }
    } catch (e) { manifestBiometricWarn('availability check failed', e); return false; }
    manifestBiometricWarn(name + ' has no checkBiometry() or isAvailable()');
    return false;
}

async function manifestBiometricVerify(opts) {
    const o = opts || {};
    const found = manifestBiometricPlugin();
    if (!found) return { verified: false, error: 'unsupported' };
    const { name, plugin: B } = found;
    try {
        // aparajita: native method + its own option names
        if (manifestNativeHas(name, B, 'internalAuthenticate') || manifestNativeHas(name, B, 'authenticate')) {
            const args = { reason: o.reason, cancelTitle: o.cancelTitle, iosFallbackTitle: o.fallbackTitle, androidTitle: o.title, androidSubtitle: o.subtitle, allowDeviceCredential: o.allowDeviceCredential };
            if (manifestNativeHas(name, B, 'internalAuthenticate')) await B.internalAuthenticate(args);
            else await B.authenticate(args);
            return { verified: true };
        }
        if (manifestNativeHas(name, B, 'verifyIdentity')) {
            await B.verifyIdentity({ reason: o.reason, description: o.reason, title: o.title, subtitle: o.subtitle, negativeButtonText: o.cancelTitle, useFallback: !!o.allowDeviceCredential, fallbackTitle: o.fallbackTitle });
            return { verified: true };
        }
    } catch (e) { return { verified: false, error: (e && (e.message || e.code)) || 'failed', code: (e && e.code) || undefined }; }
    manifestBiometricWarn(name + ' has no supported verify method');
    return { verified: false, error: 'unsupported' };
}

function initManifestBiometric() {
    window.Alpine.magic('biometric', () => ({
        available: () => manifestBiometricAvailable(),
        verify: (opts) => manifestBiometricVerify(opts)
    }));
}
