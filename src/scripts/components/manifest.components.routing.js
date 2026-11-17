// Components routing gate
// The router may load before or after this plugin; never capture it once.
window.ManifestComponentsRouting = (function () {
    const ROUTER_SRC = /(^|\/)manifest\.router(\.min)?\.js(\?|#|$)/;
    const LATE_MS = 10000;
    let givenUp = false;
    let settled = null;
    let rerunQueued = false;

    function routerScripts() {
        return Array.from(document.querySelectorAll('script[src]')).filter(s => ROUTER_SRC.test(s.getAttribute('src') || ''));
    }

    // No router yet, but a router script is still to run
    function pending() {
        if (window.ManifestRouting || givenUp) return false;
        return routerScripts().some(s => !s.hasAttribute('data-mnfst-loaded'));
    }

    // Resolves once the router has arrived or is known not to be coming
    function whenSettled() {
        if (!pending()) return Promise.resolve();
        if (settled) return settled;
        settled = new Promise(resolve => {
            const watched = new WeakSet();
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                window.removeEventListener('manifest:routing-ready', check);
                window.removeEventListener('load', onLoad);
                settled = null;
                resolve();
            };
            const watch = () => routerScripts().forEach(s => {
                if (watched.has(s)) return;
                watched.add(s);
                s.addEventListener('load', check);
                s.addEventListener('error', check);
            });
            // A failed CDN tag is swapped for the next one: re-scan a tick later
            function check() { setTimeout(() => { if (pending()) watch(); else finish(); }, 0); }
            // Window load waits for in-flight scripts: a router not here by then isn't coming
            function onLoad() { setTimeout(() => { if (done) return; if (pending()) givenUp = true; finish(); }, 0); }
            watch();
            window.addEventListener('manifest:routing-ready', check);
            // Inserted after load (Manifest.loadPlugin): its own load/error decides, bounded
            if (document.readyState === 'complete') setTimeout(onLoad, LATE_MS);
            else window.addEventListener('load', onLoad);
        });
        return settled;
    }

    // Same condition grammar as route visibility: comma list, ! negates
    function matches(xRoute, path) {
        const routing = window.ManifestRouting;
        if (!xRoute || !routing) return true;
        const conditions = xRoute.split(',').map(c => c.trim()).filter(Boolean);
        const positive = conditions.filter(c => !c.startsWith('!'));
        const negative = conditions.filter(c => c.startsWith('!')).map(c => c.slice(1));
        if (negative.some(c => routing.matchesCondition(path, c))) return false;
        return positive.length === 0 || positive.some(c => routing.matchesCondition(path, c));
    }

    // One swapping pass once the router settles, for every placeholder deferred meanwhile
    function rerunWhenSettled() {
        if (rerunQueued) return;
        rerunQueued = true;
        whenSettled().then(() => {
            rerunQueued = false;
            const swapping = window.ManifestComponentsSwapping;
            return swapping && swapping.processAll().then(() => {
                window.dispatchEvent(new CustomEvent('manifest:components-processed'));
            });
        });
    }

    function currentPath() {
        const p = window.location.pathname;
        return p === '/' ? '/' : p.replace(/^\/+|\/+$/g, '');
    }

    // 'swap' | 'skip' | 'defer' for a placeholder at a path
    function decide(el, path) {
        const xRoute = el.getAttribute('x-route');
        if (!xRoute) return 'swap';
        if (window.ManifestRouting) return matches(xRoute, path ?? currentPath()) ? 'swap' : 'skip';
        if (!pending()) return 'swap';
        rerunWhenSettled();
        return 'defer';
    }

    return { pending, whenSettled, matches, decide };
})();
