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

    // The router's own element matcher; memo is per pass (path fixed)
    function pass(path) {
        const vis = window.ManifestRoutingVisibility;
        const memo = new Map();
        let defined;
        const definedFor = () => {
            if (defined === undefined) defined = vis.routesDefined ? !!vis.routesDefined(path) : undefined;
            return defined;
        };
        return function active(el) {
            let hit = memo.get(el);
            if (hit !== undefined) return hit;
            if (vis && vis.routeMatches) {
                const cond = el.getAttribute('x-route') || '';
                hit = vis.routeMatches(el, path, cond.includes('!*') ? definedFor() : undefined) !== false;
            } else {
                // Router predating the export: its condition matcher, comma list and ! only
                const routing = window.ManifestRouting;
                const conds = (el.getAttribute('x-route') || '').split(',').map(c => c.trim()).filter(Boolean);
                const pos = conds.filter(c => !c.startsWith('!'));
                hit = !conds.some(c => c.startsWith('!') && routing.matchesCondition(path, c.slice(1))) &&
                    (pos.length === 0 || pos.some(c => routing.matchesCondition(path, c)));
            }
            memo.set(el, hit);
            return hit;
        };
    }

    // A route string checked as if on an element (reverts know only the string)
    function matches(xRoute, path) {
        if (!xRoute || !window.ManifestRouting) return true;
        const probe = document.createElement('div');
        probe.setAttribute('x-route', xRoute);
        return pass(path)(probe);
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

    // Logical route (router base stripped), as route visibility reads it
    function currentPath() {
        const p = window.ManifestRoutingNavigation?.getCurrentRoute?.() ?? window.location.pathname;
        return p === '/' ? '/' : p.replace(/^\/+|\/+$/g, '');
    }

    // 'swap' | 'skip' | 'defer': own x-route and every x-route ancestor must be active.
    // Reuse one gate(path) across a pass so ancestors are matched once.
    function gate(path) {
        let active = null;
        return function decide(el) {
            let n = el.closest('[x-route]');
            if (!n) return 'swap';
            if (!window.ManifestRouting) {
                if (!pending()) return 'swap';
                rerunWhenSettled();
                return 'defer';
            }
            if (!active) active = pass(path ?? currentPath());
            for (; n; n = n.parentElement && n.parentElement.closest('[x-route]')) {
                if (!active(n)) return 'skip';
            }
            return 'swap';
        };
    }

    const decide = (el, path) => gate(path)(el);

    return { pending, whenSettled, matches, gate, decide, currentPath };
})();
