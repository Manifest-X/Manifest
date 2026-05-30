// Router navigation

// Current route state (logical path, e.g. /gadget; not full pathname when app is in a subpath)
let currentRoute = '/';
let isInternalNavigation = false;

function isPrerenderedStaticBuild() {
    // When prerendered HTML is served as static pages, prefer normal browser navigation (MPA)
    // so each URL loads its own prerendered HTML rather than SPA toggling.
    const prerendered = document.querySelector('meta[name="manifest:prerendered"]');
    const val = (prerendered?.getAttribute('content') || '').trim().toLowerCase();
    if (prerendered && val !== '0' && val !== 'false') return true;
    // Backstop: prerender writes this per-page depth marker.
    return !!document.querySelector('meta[name="manifest:router-base-depth"]');
}

function getBasePath() {
    return (typeof window.getManifestBasePath === 'function' ? window.getManifestBasePath() : '') || '';
}

// Locale codes from manifest data (same idea as ManifestRouting.matchesCondition).
function getLocalizationCodesFromManifest() {
    const localizationCodes = [];
    try {
        const manifest = window.ManifestComponentsRegistry?.manifest || window.manifest;
        if (manifest?.data && typeof manifest.data === 'object') {
            Object.values(manifest.data).forEach((dataSource) => {
                if (typeof dataSource === 'object' && dataSource !== null) {
                    Object.keys(dataSource).forEach((key) => {
                        if (key.match(/^[a-z]{2}(-[A-Z]{2})?$/)) {
                            localizationCodes.push(key);
                        }
                    });
                }
            });
        }
    } catch {
        /* ignore */
    }
    return [...new Set(localizationCodes)];
}

function logicalSegmentsFromPathname(pathname) {
    const logical = pathnameToLogical(pathname);
    const s = logical.replace(/^\/+|\/+$/g, '');
    return s ? s.split('/') : [];
}

const STICKY_LOCALE_SKIP_FIRST_SEGMENTS = new Set([
    'api',
    'assets',
    'static',
    'public',
    'dist',
    'icons',
    'fonts',
    'media',
    '.well-known',
]);

const STICKY_LOCALE_STATIC_FILE_EXT = new Set([
    'js', 'mjs', 'cjs', 'css', 'map', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico',
    'woff', 'woff2', 'ttf', 'eot', 'json', 'xml', 'txt', 'pdf', 'zip', 'wasm', 'avif',
    'mp4', 'webm', 'mp3',
]);

function shouldSkipStickyLocaleForLogicalSegments(segments) {
    if (!segments.length) return false;
    if (STICKY_LOCALE_SKIP_FIRST_SEGMENTS.has(segments[0])) return true;
    const last = segments[segments.length - 1];
    if (!last || !last.includes('.')) return false;
    const ext = last.slice(last.lastIndexOf('.') + 1).toLowerCase();
    return STICKY_LOCALE_STATIC_FILE_EXT.has(ext);
}

// manifest.render.localeRouteExclude → JSON array in meta; logical path prefixes (after locale).
function parseLocaleRouteExcludePatterns() {
    const meta = document.querySelector('meta[name="manifest:locale-route-exclude"]');
    const raw = meta?.getAttribute('content') || '';
    if (raw.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(raw.replace(/&quot;/g, '"'));
            if (Array.isArray(parsed)) {
                return parsed.map((s) => String(s).trim()).filter(Boolean);
            }
        } catch {
            /* fall through */
        }
    }
    const legacy = document.querySelector('meta[name="manifest:locale-sticky-exclude"]');
    const legacyRaw = legacy?.getAttribute('content') || '';
    if (!legacyRaw.trim()) return [];
    return legacyRaw.split(',').map((s) => s.trim().replace(/^\/+/, '').split('/')[0]).filter(Boolean);
}

function logicalPathMatchesLocaleRouteExclude(segments, patterns) {
    if (!patterns.length || !segments.length) return false;
    const lower = segments.map((s) => s.toLowerCase());
    for (const pattern of patterns) {
        const p = String(pattern)
            .trim()
            .replace(/^\/+/, '')
            .split('/')
            .filter(Boolean)
            .map((x) => x.toLowerCase());
        if (p.length === 0) continue;
        if (lower.length < p.length) continue;
        let match = true;
        for (let i = 0; i < p.length; i++) {
            if (lower[i] !== p[i]) {
                match = false;
                break;
            }
        }
        if (match) return true;
    }
    return false;
}

// /fr/legal/terms → /legal/terms when patterns include "legal" or "legal/terms" (prefix match).
function normalizeRedundantLocalePrefixInUrl() {
    if (!isPrerenderedStaticBuild()) return false;
    const codes = getLocalizationCodesFromManifest();
    const patterns = parseLocaleRouteExcludePatterns();
    if (!codes.length || !patterns.length) return false;

    const segs = logicalSegmentsFromPathname(window.location.pathname);
    if (segs.length < 2) return false;
    if (!codes.includes(segs[0])) return false;
    const rest = segs.slice(1);
    if (!logicalPathMatchesLocaleRouteExclude(rest, patterns)) return false;

    const newLogical = '/' + rest.join('/');
    const base = getBasePath();
    let newPathname = base ? base.replace(/\/+$/, '') + newLogical : newLogical;
    newPathname = newPathname.replace(/\/{2,}/g, '/');
    if (!newPathname.startsWith('/')) newPathname = '/' + newPathname;
    if (newPathname === window.location.pathname) return false;

    const prevLogical = pathnameToLogical(window.location.pathname);
    const u = new URL(window.location.href);
    u.pathname = newPathname;
    history.replaceState(null, '', u.toString());
    currentRoute = pathnameToLogical(newPathname);
    const np = currentRoute === '/' ? '/' : String(currentRoute).replace(/^\/|\/$/g, '');
    window.dispatchEvent(new CustomEvent('manifest:route-change', {
        detail: { from: prevLogical, to: currentRoute, normalizedPath: np }
    }));
    return true;
}

// When the URL already has a locale prefix (e.g. /zh/pricing), keep it for same-origin links
// that omit the prefix (/articles → /zh/articles). No-op on default-locale URLs (/pricing).
function applyStickyLocaleToPathname(absolutePathname) {
    const codes = getLocalizationCodesFromManifest();
    if (!codes.length) return absolutePathname;

    const currentSegs = logicalSegmentsFromPathname(window.location.pathname);
    const sticky = currentSegs.length && codes.includes(currentSegs[0]) ? currentSegs[0] : null;
    if (!sticky) return absolutePathname;

    const targetSegs = logicalSegmentsFromPathname(absolutePathname);
    if (targetSegs.length && codes.includes(targetSegs[0])) {
        return absolutePathname;
    }

    const routeEx = parseLocaleRouteExcludePatterns();
    if (routeEx.length && logicalPathMatchesLocaleRouteExclude(targetSegs, routeEx)) {
        return absolutePathname;
    }

    if (shouldSkipStickyLocaleForLogicalSegments(targetSegs)) {
        return absolutePathname;
    }

    const base = getBasePath();
    const newLogical = targetSegs.length ? `/${sticky}/${targetSegs.join('/')}` : `/${sticky}`;
    const normalizedLogical = newLogical.replace(/\/{2,}/g, '/') || '/';
    if (!base) return normalizedLogical;
    const combined = `${base}${normalizedLogical}`.replace(/([^:])\/{2,}/g, '$1/');
    return combined.startsWith('/') ? combined : `/${combined}`;
}

function pathnameToLogical(pathname) {
    const base = getBasePath();
    if (!base) {
        const p = (pathname || '/').replace(/\/$/, '') || '/';
        if (p === '/' || p === '/index.html' || p === '/index') return '/';
        return p.startsWith('/') ? p : '/' + p;
    }
    if (pathname === base || pathname === base + '/') return '/';
    if (pathname.startsWith(base + '/')) {
        let logical = pathname.slice(base.length) || '/';
        if (logical === '/index.html' || logical === '/index') logical = '/';
        return logical;
    }
    if (pathname === base + '/index.html' || pathname === base + '/index') return '/';
    return pathname;
}

// Handle route changes
async function handleRouteChange() {
    const pathname = window.location.pathname;
    const newRoute = pathnameToLogical(pathname);
    if (newRoute === currentRoute) return;

    const prevRoute = currentRoute;
    currentRoute = newRoute;

    // Handle scrolling based on whether this is an anchor link or route change
    if (!window.location.hash) {
        // This is a route change - scroll to top
        // Use a small delay to ensure content has loaded
        setTimeout(() => {
            // Scroll main page to top
            window.scrollTo({ top: 0, behavior: 'smooth' });

            // Find and scroll scrollable containers to top
            // Use a generic approach that works with any CSS framework
            // Only check elements that are likely to be scrollable containers
            const potentialContainers = document.querySelectorAll('div, main, section, article, aside, nav, header, footer, .prose');
            potentialContainers.forEach(element => {
                const computedStyle = window.getComputedStyle(element);
                const isScrollable = (
                    computedStyle.overflowY === 'auto' ||
                    computedStyle.overflowY === 'scroll' ||
                    computedStyle.overflow === 'auto' ||
                    computedStyle.overflow === 'scroll'
                ) && element.scrollHeight > element.clientHeight;

                if (isScrollable) {
                    element.scrollTop = 0;
                }
            });
        }, 50);
    } else {
        // This is an anchor link - let the browser handle the scroll naturally
        // Use a small delay to ensure content has loaded, then let browser scroll to anchor
        setTimeout(() => {
            // The browser will automatically scroll to the anchor
            // We just need to ensure the content is loaded first
        }, 50);
    }

    // Build the route-change event once so dispatch + transition wrapper share it.
    const event = new CustomEvent('manifest:route-change', {
        detail: {
            from: prevRoute,
            to: newRoute,
            normalizedPath: newRoute === '/' ? '/' : newRoute.replace(/^\/|\/$/g, '')
        }
    });

    // SPA route changes use the View Transitions API when available so the
    // visibility-toggle that listeners perform inside this dispatch is
    // animated. Cross-document MPA navigations are already handled by
    // `@view-transition { navigation: auto }` in the framework's reset CSS;
    // the same `::view-transition-group(*)` rule (driven by
    // `--view-transition-duration` / `--view-transition-easing`) covers both.
    //
    // The callback is synchronous: visibility/head/anchor listeners mutate
    // the DOM inside `dispatchEvent` and return. Returning anything async
    // here would freeze the rendered frame until the promise resolves,
    // adding the entirety of Alpine's pending-update queue to the perceived
    // navigation time (1–2s on busy pages).
    if (shouldUseViewTransition()) {
        document.startViewTransition(() => {
            window.dispatchEvent(event);
        });
    } else {
        window.dispatchEvent(event);
    }
}

// Decide whether SPA route changes should run inside a View Transition.
// Three modes, in priority order:
//
//   1. `<html data-no-view-transitions>`  → force OFF
//   2. `<html data-view-transitions>`     → force ON
//   3. (neither)                          → auto: ON when the current page is
//                                            under VT_AUTO_THRESHOLD elements,
//                                            OFF otherwise
//
// The auto threshold exists because the View Transitions API rasterizes the
// full viewport for the "before" and "after" snapshots; cost scales linearly
// with DOM size and gets noticeable above a few thousand elements (a 10k-
// element page measured ~500ms per snapshot in dev). Light pages keep the
// crossfade; heavy pages stay fast.
//
// Cross-document (MPA) navigations are unaffected — those use the browser's
// native cross-document path (`@view-transition { navigation: auto }`),
// which rasterizes in parallel with page load and doesn't expose the cost.
//
// Per-element opt-out (`data-no-view-transition`, singular) on individual
// elements is handled by the existing reset CSS rule that sets
// `view-transition-name: none` on them. `prefers-reduced-motion` is
// respected automatically — the browser falls back to a snap with no
// animation when the user has it set.
const VT_AUTO_THRESHOLD = 3000;

function shouldUseViewTransition() {
    if (typeof document === 'undefined') return false;
    if (typeof document.startViewTransition !== 'function') return false;
    const html = document.documentElement;
    if (!html) return false;
    if (html.hasAttribute('data-no-view-transitions')) return false;
    if (html.hasAttribute('data-view-transitions')) return true;
    try {
        return document.querySelectorAll('*').length < VT_AUTO_THRESHOLD;
    } catch {
        return false;
    }
}

// Headless automation (Puppeteer / Playwright / Selenium / WebDriver-driven
// Chromium) frequently captures screenshots mid-transition, producing blank
// frames. Real browsers report `navigator.webdriver === false` — including
// when DevTools is open, when launched via `open <url>`, or on mobile — so
// this check exclusively affects automation tooling and leaves end-user
// behavior identical. Authors who want transitions in their automation tests
// can force them on with `<html data-view-transitions>`, which takes priority
// over this attribute via `shouldUseViewTransition()` above.
if (typeof navigator !== 'undefined' && navigator.webdriver === true) {
    const html = document.documentElement;
    if (html && !html.hasAttribute('data-view-transitions')) {
        html.setAttribute('data-no-view-transitions', '');
    }
}

// Resolve internal link to absolute pathname for pushState. Relative hrefs (e.g. "gadget") are resolved against the app base, not the current URL, so we never get additive paths like /src/dist/widget/gadget/widget/...
function resolveHref(href) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return href;
    try {
        const base = getBasePath();
        const baseUrl = base ? (window.location.origin + base + '/') : (window.location.origin + '/');
        const url = new URL(href, baseUrl);
        if (url.origin !== window.location.origin) return href;
        let path = url.pathname.replace(/\/$/, '') || '/';
        let resolved;
        if (!base) {
            resolved = path.startsWith('/') ? path : '/' + path;
        } else if (path === base || path.startsWith(base + '/')) {
            resolved = path;
        } else if (path.startsWith('/')) {
            const pathSegs = path.split('/').filter(Boolean);
            const baseSegs = base.split('/').filter(Boolean);
            let i = 0;
            while (i < baseSegs.length && i < pathSegs.length && baseSegs[i] === pathSegs[i]) i++;
            const routeSegs = pathSegs.slice(i);
            if (routeSegs.length) {
                resolved = base + '/' + routeSegs.join('/');
            } else {
                const out = base + (path.startsWith('/') ? path : '/' + path);
                resolved = out.startsWith('/') ? out : '/' + out;
            }
        } else {
            const out = base + (path.startsWith('/') ? path : '/' + path);
            resolved = out.startsWith('/') ? out : '/' + out;
        }
        return applyStickyLocaleToPathname(resolved);
    } catch {
        const base = getBasePath();
        const safe = (href || '').trim();
        if (!safe) return applyStickyLocaleToPathname(base || '/');
        const raw = base ? (base + (safe.startsWith('/') ? safe : '/' + safe)) : (safe.startsWith('/') ? safe : '/' + safe);
        return applyStickyLocaleToPathname(raw);
    }
}

// Prerendered MPA: same-origin navigations use full page loads; rewrite targets so locale prefix sticks.
function installMpaStickyLocaleLinks() {
    document.addEventListener('click', (event) => {
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const link = event.target.closest('a');
        if (!link || link.closest('[data-manifest-skip-locale-sticky]')) return;
        if (link.hasAttribute('download')) return;

        const hrefAttr = link.getAttribute('href');
        if (!hrefAttr || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:') || hrefAttr.startsWith('javascript:')) return;
        if (hrefAttr.startsWith('#')) return;

        let url;
        try {
            url = new URL(hrefAttr, window.location.href);
        } catch {
            return;
        }
        if (url.origin !== window.location.origin) return;

        const path = url.pathname.replace(/\/$/, '') || '/';
        const adjusted = applyStickyLocaleToPathname(path);
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        // For prerendered MPA builds, directory paths must have a trailing slash so that the
        // static file host (e.g. Appwrite) resolves them to the correct index.html rather than
        // falling back to the root index.html.
        const hasFileExt = /\.[a-zA-Z0-9]+$/.test(adjusted);
        url.pathname = (adjusted !== '/' && !hasFileExt && !adjusted.endsWith('/'))
            ? adjusted + '/'
            : adjusted;

        const dest = url.toString();
        if (link.target === '_blank') {
            const features = link.relList?.contains('noopener') || link.relList?.contains('noreferrer')
                ? 'noopener,noreferrer'
                : undefined;
            window.open(dest, '_blank', features);
        } else {
            window.location.assign(dest);
        }
    }, true);
}

// Intercept link clicks to prevent page reloads
function interceptLinkClicks() {
    // Use capture phase to intercept before other handlers
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a');
        if (!link) return;

        const href = link.getAttribute('href');
        if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return;

        // Handle pure anchor links normally - don't intercept them
        if (href.startsWith('#')) return;

        // Don't intercept blob: or data: URLs. The export plugin creates a
        // throwaway <a href="blob:…" download="…"> and programmatically
        // clicks it to trigger a file save; if the router treats it as a
        // SPA link, `new URL("blob:http://localhost/UUID", origin).pathname`
        // resolves to "http://localhost/UUID" which then pushState pushes
        // as a same-origin path, producing /http://localhost/UUID and
        // landing the user on a 404 instead of downloading.
        if (href.startsWith('blob:') || href.startsWith('data:')) return;

        // Honor `download` — the link is opting out of SPA navigation in
        // favor of letting the browser save its target. Same intent as
        // blob:/data:, just expressed via the standard HTML attribute.
        if (link.hasAttribute('download')) return;

        // Check if it's an external link FIRST (before any other processing)
        let isExternalLink = false;
        try {
            const url = new URL(href, window.location.origin);
            if (url.origin !== window.location.origin) {
                isExternalLink = true; // External link
            }
        } catch (e) {
            // Invalid URL, treat as relative
        }

        // If it's an external link, don't intercept it
        if (isExternalLink) {
            return;
        }

        // Handle links with both route and anchor (e.g., /page#section)
        if (href.includes('#')) {
            const [path, hash] = href.split('#');
            const fullHref = resolveHref(path) + (hash ? '#' + hash : '');

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();

            // Set flag to prevent recursive calls
            isInternalNavigation = true;

            // Update URL without page reload (use base path when app is in a subpath)
            history.pushState(null, '', fullHref);

            // Handle route change (but don't scroll to top since there's an anchor)
            handleRouteChange();

            // Reset flag
            isInternalNavigation = false;

            // After route change, scroll to the anchor
            setTimeout(() => {
                const targetElement = document.getElementById(hash);
                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth' });
                }
            }, 100);

            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        // Set flag to prevent recursive calls
        isInternalNavigation = true;

        // Update URL without page reload (use base path when app is in a subpath, e.g. /src/dist/gadget)
        const fullHref = resolveHref(href);
        history.pushState(null, '', fullHref);

        // Handle route change
        handleRouteChange();

        // Reset flag
        isInternalNavigation = false;

    }, true); // Use capture phase
}

// Initialize navigation
function initializeNavigation() {
    currentRoute = pathnameToLogical(window.location.pathname);
    normalizeRedundantLocalePrefixInUrl();

    // In prerendered/static output, use default browser navigation (no SPA interception)
    if (!isPrerenderedStaticBuild()) {
        interceptLinkClicks();

        window.addEventListener('popstate', () => {
            if (!isInternalNavigation) {
                handleRouteChange();
            }
        });
    } else {
        installMpaStickyLocaleLinks();
    }

    // Handle initial route
    handleRouteChange();
}

// Match the browser URL as soon as this module loads. Later chunks in the same bundle (e.g. router magic)
// may initialize before DOMContentLoaded; getCurrentRoute() must not stay at '/' or $route breaks article pages.
currentRoute = pathnameToLogical(window.location.pathname);

// Run immediately if DOM is ready, otherwise wait
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeNavigation);
} else {
    initializeNavigation();
}

// Export navigation interface
window.ManifestRoutingNavigation = {
    initialize: initializeNavigation,
    getCurrentRoute: () => currentRoute,
    getBasePath,
    resolveHref,
    pathnameToLogical
}; 