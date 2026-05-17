// Components — route-level prefetch.
//
// Two enhancements that run on top of the existing on-encounter loader:
//
//   1. Parallel batch on route change. When manifest:route-change fires,
//      scan the [x-route] subtrees that match the new route and call
//      loadComponent() on every <x-*> tag inside them. The loader
//      deduplicates fetches, so calling it for components that the
//      regular swapping logic is already mounting is harmless — but
//      pre-issuing in parallel saves 50–200 ms vs. one-by-one fetches.
//
//   2. Prefetch on hover. When the pointer enters an internal <a href>,
//      derive the target pathname, find the [x-route] subtree(s) that
//      would match it, and prefetch their components. By the time the
//      user clicks the link, the components are warm in the loader's
//      cache and navigation feels instant.
//
// Both phases require zero author configuration. Manifest auto-discovers
// what to prefetch from the existing [x-route] DOM structure.

(function () {
    'use strict';

    // <x-*> tag pattern — lowercase, hyphenated.
    const TAG_RE = /^x-[a-z][a-z0-9-]*$/;

    // Framework-provided web components (registered by Manifest plugins
    // themselves, not as project components in manifest.json). Skip these
    // when scanning for project components to prefetch.
    const FRAMEWORK_TAGS = new Set(['code', 'code-group']);

    // Anchors we've already issued a hover-prefetch for. WeakSet so DOM
    // garbage-collects naturally as elements leave the tree.
    const prefetchedAnchors = new WeakSet();

    function loader() { return window.ManifestComponentsLoader; }

    // Match a single route pattern against a normalized pathname (no
    // leading/trailing slashes, '/' represented as '/'). Mirrors the
    // router visibility logic so prefetch targets the same subtrees.
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
        // querySelectorAll('*') is the fastest path for "every descendant".
        // We filter by tag name in JS — there's no CSS selector for "tag
        // name starts with x-". A page typically has a few thousand nodes,
        // which scans in well under a millisecond.
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

        // 2) Hover prefetch. Use pointerover (bubbles) and check the closest
        // anchor on each event so we get a single trigger per anchor entry
        // without needing pointerenter (which doesn't bubble). Dedup via
        // a WeakSet so repeat moves within the anchor don't re-scan.
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
