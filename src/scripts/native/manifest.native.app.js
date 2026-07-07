// $app — app lifecycle. Native: Capacitor App appStateChange (foreground/background).
// Web fallback: document visibilitychange + pageshow/pagehide. $app.active is
// reactive; onChange hooks fire on transition. Push delivers tapped-notification
// routing around resume, so this pairs with $push + $links.

let _manifestAppChangeHandlers = [];

function manifestAppSetActive(active) {
    try { const s = window.Alpine && window.Alpine.store('app'); if (s) s.active = !!active; } catch (e) {}
    _manifestAppChangeHandlers.forEach(fn => { try { fn(!!active); } catch (e) {} });
}

function initManifestApp() {
    const visible = (typeof document !== 'undefined') ? document.visibilityState !== 'hidden' : true;
    window.Alpine.store('app', { active: visible });

    const App = manifestNativePlugin('App');
    if (App) {
        try { App.addListener('appStateChange', s => manifestAppSetActive(s && s.isActive)); } catch (e) {}
    } else if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => manifestAppSetActive(document.visibilityState !== 'hidden'));
        window.addEventListener('pageshow', () => manifestAppSetActive(true));
        window.addEventListener('pagehide', () => manifestAppSetActive(false));
    }

    window.Alpine.magic('app', () => ({
        get active() { const s = window.Alpine.store('app'); return s ? s.active : true; },
        onChange(fn) { if (typeof fn === 'function') _manifestAppChangeHandlers.push(fn); }
    }));
}
