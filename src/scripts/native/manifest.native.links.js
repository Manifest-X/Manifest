// $links — deep / universal links. Native: Capacitor App fires appUrlOpen (and a
// cold-start launch URL); Manifest extracts the path and hands off to the router.
// $links.on(fn) lets the author take over routing (e.g. load data for /order/123).
// On the web there's no bridge, but $links.open(url) still works for programmatic
// deep-linking and testing. Couples with lifecycle + push (tap → route).

function manifestLinkPath(url) {
    const s = String(url);
    const scheme = (s.match(/^([a-z][a-z0-9+.-]*):/i) || [])[1];
    if (scheme && scheme.toLowerCase() !== 'http' && scheme.toLowerCase() !== 'https') {
        // Custom scheme (myapp://order/123): treat host + path as the route.
        const rest = s.slice(scheme.length + 1).replace(/^\/\//, '');
        const cut = rest.search(/[?#]/);
        const pathPart = (cut === -1 ? rest : rest.slice(0, cut)).replace(/^\/+/, '');
        const tail = cut === -1 ? '' : rest.slice(cut);
        return '/' + pathPart + tail;
    }
    try { const u = new URL(url, window.location.origin); return u.pathname + u.search + u.hash; }
    catch (e) { return '/'; }
}

// Faithful SPA navigation: route through the router's own click interceptor.
function manifestNavigateTo(path) {
    const nav = window.ManifestRoutingNavigation;
    if (nav) {
        const a = document.createElement('a');
        a.setAttribute('href', path);
        document.body.appendChild(a);
        a.click();
        a.remove();
    } else {
        window.location.assign(path);
    }
}

let _manifestLinkHandler = null;
function manifestHandleUrl(url) {
    const path = manifestLinkPath(url);
    try { const s = window.Alpine && window.Alpine.store('links'); if (s) s.last = url; } catch (e) {}
    if (typeof _manifestLinkHandler === 'function') { try { _manifestLinkHandler({ url, path }); } catch (e) {} return; }
    manifestNavigateTo(path);
}

function initManifestLinks() {
    if (!window.Alpine.store('links')) window.Alpine.store('links', { last: null });
    window.Alpine.magic('links', () => ({
        on: (fn) => { _manifestLinkHandler = typeof fn === 'function' ? fn : null; },
        open: (url) => manifestHandleUrl(url),
        get last() { const s = window.Alpine.store('links'); return s ? s.last : null; }
    }));

    const App = manifestNativePlugin('App');
    if (App) {
        try { App.addListener('appUrlOpen', (data) => { if (data && data.url) manifestHandleUrl(data.url); }); } catch (e) {}
        try { App.getLaunchUrl().then(r => { if (r && r.url) manifestHandleUrl(r.url); }).catch(() => {}); } catch (e) {}
    }
}
