// $push — push notifications (Capacitor PushNotifications → APNs/FCM), designed as
// three author-controlled contracts, not display-only:
//   1. permission timing — $push.request() (never auto-prompts on load)
//   2. device token      — $push.onToken(fn): token -> your backend
//   3. tap -> route       — tapped payload's url/route hands off to the router
//                           ($push.onTap(fn) to override; reuses $links + $app)
// Web fallback: permission maps to the Notification API; full web push (service
// worker + VAPID) is out of scope, so register() is a no-op on the web.

let _manifestPushTokenHandlers = [];
let _manifestPushReceiveHandlers = [];
let _manifestPushTapHandler = null;

function manifestPushMapPermission(p) {
    if (p === 'granted' || p === 'denied' || p === 'prompt') return p;
    if (p === 'default') return 'prompt';
    return p || 'prompt';
}

function manifestPushRoutePayload(notification) {
    const data = (notification && (notification.data || notification)) || {};
    return data.url || data.route || data.path || null;
}

function manifestPushHandleTap(notification) {
    if (typeof _manifestPushTapHandler === 'function') { try { _manifestPushTapHandler(notification); } catch (e) {} return; }
    const target = manifestPushRoutePayload(notification);
    if (target && typeof manifestHandleUrl === 'function') manifestHandleUrl(target);
}

function initManifestPush() {
    const store = { permission: 'prompt', token: null };
    try { store.permission = (typeof Notification !== 'undefined') ? manifestPushMapPermission(Notification.permission) : 'unsupported'; }
    catch (e) { store.permission = 'unsupported'; }
    window.Alpine.store('push', store);

    const Push = manifestNativePlugin('PushNotifications');
    if (Push) {
        try { Push.addListener('registration', t => { store.token = t && t.value; _manifestPushTokenHandlers.forEach(fn => { try { fn(store.token); } catch (e) {} }); }); } catch (e) {}
        try { Push.addListener('pushNotificationReceived', n => { _manifestPushReceiveHandlers.forEach(fn => { try { fn(n); } catch (e) {} }); }); } catch (e) {}
        try { Push.addListener('pushNotificationActionPerformed', a => manifestPushHandleTap(a && a.notification)); } catch (e) {}
    }

    window.Alpine.magic('push', () => ({
        async request() {
            const P = manifestNativePlugin('PushNotifications');
            if (P) { try { const r = await P.requestPermissions(); const p = manifestPushMapPermission(r && r.receive); window.Alpine.store('push').permission = p; return p; } catch (e) { return 'denied'; } }
            if (typeof Notification !== 'undefined' && Notification.requestPermission) { try { const p = manifestPushMapPermission(await Notification.requestPermission()); window.Alpine.store('push').permission = p; return p; } catch (e) { return 'denied'; } }
            return 'unsupported';
        },
        async register() {
            const P = manifestNativePlugin('PushNotifications');
            if (P) { try { await P.register(); } catch (e) {} }
        },
        onToken(fn) { if (typeof fn === 'function') _manifestPushTokenHandlers.push(fn); },
        onReceive(fn) { if (typeof fn === 'function') _manifestPushReceiveHandlers.push(fn); },
        onTap(fn) { _manifestPushTapHandler = typeof fn === 'function' ? fn : null; },
        get permission() { const s = window.Alpine.store('push'); return s ? s.permission : 'prompt'; },
        get token() { const s = window.Alpine.store('push'); return s ? s.token : null; }
    }));
}
