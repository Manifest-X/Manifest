// $biometric — Face ID / Touch ID. Native: a Capacitor biometric plugin
// (BiometricAuth or NativeBiometric; method shapes differ, adapted below). The web
// has no equivalent one-shot verify (WebAuthn is a separate server ceremony), so
// available() is false and verify() reports unsupported — a genuine native win.

function manifestBiometricPlugin() {
    return manifestNativePlugin('BiometricAuth') || manifestNativePlugin('NativeBiometric') || null;
}

async function manifestBiometricAvailable() {
    const B = manifestBiometricPlugin();
    if (!B) return false;
    try {
        if (typeof B.checkBiometry === 'function') { const r = await B.checkBiometry(); return !!(r && r.isAvailable); }
        if (typeof B.isAvailable === 'function') { const r = await B.isAvailable(); return !!(r && r.isAvailable !== false); }
    } catch (e) {}
    return false;
}

async function manifestBiometricVerify(opts) {
    const o = opts || {};
    const B = manifestBiometricPlugin();
    if (!B) return { verified: false, error: 'unsupported' };
    try {
        if (typeof B.authenticate === 'function') { await B.authenticate({ reason: o.reason, ...o }); return { verified: true }; }
        if (typeof B.verifyIdentity === 'function') { await B.verifyIdentity({ reason: o.reason, title: o.title, subtitle: o.subtitle }); return { verified: true }; }
    } catch (e) { return { verified: false, error: (e && (e.message || e.code)) || 'failed' }; }
    return { verified: false, error: 'unsupported' };
}

function initManifestBiometric() {
    window.Alpine.magic('biometric', () => ({
        available: () => manifestBiometricAvailable(),
        verify: (opts) => manifestBiometricVerify(opts)
    }));
}
