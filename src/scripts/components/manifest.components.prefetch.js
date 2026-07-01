/* Manifest Components — route-level prefetch (batch on route change + on hover) */

(function () {
    'use strict';

    // <x-*> tag pattern — lowercase, hyphenated.
    const TAG_RE = /^x-[a-z][a-z0-9-]*$/;

    // Framework web components (not project components) — skip when scanning.
    const FRAMEWORK_TAGS = new Set(['code', 'code-group']);

    // Anchors already hover-prefetched. WeakSet so detached nodes GC naturally.
    const prefetchedAnchors = new WeakSet();

    function loader() { return window.ManifestComponentsLoader; }

    // Match a route pattern against a normalized pathname. Mirrors router visibility.
    function routeMatches(routeValue, pathname) {
        const pieces = String(routeValue || '').split(',').map((s) => s.trim()).filter(Boolean);
        let matched = false;
        let negated = false;
        for (const piece of pieces) {
            if (piece === '!*') continue; // catch-all only handled by visibility plugin
            if (piece.startsWith('!')) {
                if (piece.slice(1) === pathname) negated = true;
                continue;
            }
            if (piece.startsWith('=')) {
                if (piece.slice(1) === pathname) matched = true;
                continue;
            }
            if (piece.endsWith('/*')) {
                const prefix = piece.slice(0, -2);
                if (pathname === prefix || pathname.startsWith(prefix + '/')) matched = true;
                continue;
            }
            if (piece === pathname) { matched = true; continue; }
            if (pathname.startsWith(piece + '/')) matched = true;
        }
        return matched && !negated;
    }

    function findRouteSubtrees(pathname) {
        const normalized = (pathname || '/') === '/' ? '/' : pathname.replace(/^\/|\/$/g, '');
        const out = [];
        document.querySelectorAll('[x-route]').forEach((el) => {
            const value = el.getAttribute('x-route') || '';
            if (routeMatches(value, normalized)) out.push(el);
        });
        return out;
    }

    function discoverComponentNames(root) {
        const names = new Set();
        if (!root || !root.querySelectorAll) return names;
        // No CSS selector for "tag starts with x-", so scan all and filter in JS.
        root.querySelectorAll('*').forEach((el) => {
            const tag = el.tagName.toLowerCase();
            if (!tag.startsWith('x-') || !TAG_RE.test(tag)) return;
            const name = tag.slice(2);
            if (!FRAMEWORK_TAGS.has(name)) names.add(name);
        });
        return names;
    }

    function prefetchForRoute(pathname) {
        const L = loader();
        if (!L || typeof L.loadComponent !== 'function') return;
        const subtrees = findRouteSubtrees(pathname);
        if (!subtrees.length) return;
        const names = new Set();
        for (const subtree of subtrees) {
            discoverComponentNames(subtree).forEach((n) => names.add(n));
        }
        names.forEach((name) => {
            try { L.loadComponent(name); } catch { /* swallow — dedup is internal */ }
        });
    }

    function hrefToPathname(href) {
        if (!href) return null;
        if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return null;
        try {
            const url = new URL(href, window.location.href);
            if (url.origin !== window.location.origin) return null;
            return url.pathname || '/';
        } catch {
            return null;
        }
    }

    function initialize() {
        // 1) Parallel batch on route change.
        window.addEventListener('manifest:route-change', (event) => {
            const detail = (event && event.detail) || {};
            const path = detail.normalizedPath || detail.to || '/';
            const pathname = String(path).startsWith('/') ? String(path) : '/' + String(path);
            prefetchForRoute(pathname);
        });

        // 2) Hover prefetch. pointerover bubbles (pointerenter doesn't); WeakSet dedups.
        document.addEventListener('pointerover', (e) => {
            if (!e.target || !e.target.closest) return;
            const a = e.target.closest('a[href]');
            if (!a || prefetchedAnchors.has(a)) return;
            // Author opt-out: `data-no-prefetch` skips this anchor.
            if (a.hasAttribute('data-no-prefetch')) return;
            const href = a.getAttribute('href');
            const pathname = hrefToPathname(href);
            if (!pathname) return;
            prefetchedAnchors.add(a);
            prefetchForRoute(pathname);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
