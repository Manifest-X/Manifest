// $haptics — tactile feedback. Native: Capacitor Haptics. Web fallback:
// navigator.vibrate (limited; iOS Safari ignores it — fine, it's an enhancement).
// No-ops silently when unsupported.

function manifestVibrate(pattern) {
    try { if (navigator.vibrate) return navigator.vibrate(pattern); } catch (e) {}
    return false;
}

function initManifestHaptics() {
    window.Alpine.magic('haptics', () => ({
        impact(style) {
            const H = manifestNativePlugin('Haptics');
            if (H) { try { return H.impact({ style: style || 'MEDIUM' }); } catch (e) {} }
            manifestVibrate(10); return Promise.resolve();
        },
        notification(type) {
            const H = manifestNativePlugin('Haptics');
            if (H) { try { return H.notification({ type: type || 'SUCCESS' }); } catch (e) {} }
            manifestVibrate([10, 40, 10]); return Promise.resolve();
        },
        selection() {
            const H = manifestNativePlugin('Haptics');
            if (H) { try { return H.selectionChanged(); } catch (e) {} }
            manifestVibrate(5); return Promise.resolve();
        },
        vibrate(ms) {
            const H = manifestNativePlugin('Haptics');
            if (H) { try { return H.vibrate({ duration: ms || 300 }); } catch (e) {} }
            manifestVibrate(ms || 300); return Promise.resolve();
        }
    }));
}
