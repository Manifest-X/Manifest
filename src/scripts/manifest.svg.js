/* Manifest SVG */

(function () {

// mnfst:vendor:start — synced by the build from scripts/snippets/manifest.vendor.js; edit there
// Pinned third-party files (npm paths in src/scripts/vendor.lock.json), loaded with their hash.
// Through the loader when present: CDN fallback, and its integrity map when checks are on.
if (!window.ManifestVendor) {
    const CDN = 'https://cdn.jsdelivr.net/npm/';
    window.ManifestVendor = {
        get checked() { return !!(window.Manifest && window.Manifest.integrity); },
        script(path, hash) {
            const M = window.Manifest;
            if (M && M.loadVendor) return M.loadVendor(path, hash);
            return new Promise((resolve, reject) => {
                const src = CDN + path;
                const found = document.querySelector(`script[src="${src}"]`);
                if (found && found.dataset.vendorLoaded) return resolve();
                const s = found || document.createElement('script');
                s.addEventListener('load', () => { s.dataset.vendorLoaded = '1'; resolve(); });
                s.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
                if (found) return;
                if (hash) { s.integrity = hash; s.crossOrigin = 'anonymous'; }
                s.src = src;
                document.head.appendChild(s);
            });
        },
        fetch(path, hash) {
            const M = window.Manifest;
            if (M && M.fetchVendor) return M.fetchVendor(path, hash);
            return fetch(CDN + path, hash ? { integrity: hash, mode: 'cors', credentials: 'omit' } : undefined)
                .then(r => { if (!r.ok) throw new Error(`Failed to load ${CDN + path}`); return r; });
        }
    };
}
// mnfst:vendor:end

const svgCache = new Map();

// Shared DOMPurify loader for the .safe modifier (user-supplied SVG can carry
// <script>, on* handlers, javascript: URLs, foreignObject HTML). On window so
// manifest.markdown.js shares one loader/promise — separate top-level `let`
// declarations would collide in the global lexical env and throw at parse time.
if (!window.ManifestDOMPurify) {
    window.ManifestDOMPurify = {
        _promise: null,
        load() {
            if (typeof window.DOMPurify !== 'undefined') return Promise.resolve(window.DOMPurify);
            if (this._promise) return this._promise;
            this._promise = window.ManifestVendor.script('dompurify@3.4.10/dist/purify.min.js', 'sha384-eguRoJERj8ghOpzO//Rl7+ScQsQIR1cH+ajll7+fG+IpbNPlkZsQn9h8ccr+wPXx')
                .then(() => {
                    if (typeof window.DOMPurify === 'undefined') throw new Error('DOMPurify failed to load');
                    return window.DOMPurify;
                })
                .catch((err) => { this._promise = null; throw err; });
            return this._promise;
        }
    };
}

// Sanitize with DOMPurify's SVG profile when .safe is on; pass through otherwise.
async function maybeSanitizeSvg(svgText, safe) {
    if (!safe) return svgText;
    try {
        const DOMPurify = await window.ManifestDOMPurify.load();
        return DOMPurify.sanitize(svgText, {
            USE_PROFILES: { svg: true, svgFilters: true }
        });
    } catch {
        console.warn('[Manifest SVG] x-svg.safe: DOMPurify unavailable — skipping injection.');
        return '';
    }
}

function resolveFetchPath(pathOrContent) {
    let resolved = pathOrContent;
    if (!pathOrContent.startsWith('/')) {
        const base = (typeof window.getManifestBase === 'function' ? window.getManifestBase() : '') || '';
        const basePath = base.replace(/\/$/, '') || '';
        resolved = (basePath ? basePath + '/' : '/') + pathOrContent;
    }
    return resolved;
}

function looksLikeInlineSvgMarkup(str) {
    if (typeof str !== 'string') return false;
    const t = str.trim();
    return t.length > 0 && t.startsWith('<') && /<svg[\s>]/i.test(t);
}

function isLikelySvgFilePath(str) {
    if (typeof str !== 'string') return false;
    const t = str.trim();
    if (!t || looksLikeInlineSvgMarkup(t)) return false;
    return (
        t.includes('.svg') ||
        t.startsWith('/') ||
        (t.includes('/') && !t.includes('<'))
    );
}

function parseSvgRoot(svgText) {
    const trimmed = svgText.trim();
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err) {
        return null;
    }
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg') {
        return null;
    }
    return root;
}

async function resolveSvgString(pathOrContent) {
    if (pathOrContent === undefined || pathOrContent === null) {
        return { ok: false, error: 'empty', text: '' };
    }
    const str = typeof pathOrContent === 'string' ? pathOrContent : String(pathOrContent);
    if (!str.trim()) {
        return { ok: false, error: 'empty', text: '' };
    }

    if (looksLikeInlineSvgMarkup(str)) {
        return { ok: true, text: str };
    }

    if (!isLikelySvgFilePath(str)) {
        if (parseSvgRoot(str)) {
            return { ok: true, text: str };
        }
        return { ok: false, error: 'not-path', text: str };
    }

    let resolvedPath;
    try {
        resolvedPath = resolveFetchPath(str);

        if (svgCache.has(resolvedPath)) {
            return { ok: true, text: svgCache.get(resolvedPath) };
        }

        const response = await fetch(resolvedPath);
        if (!response.ok) {
            console.warn(`[Manifest SVG] Failed to fetch: ${resolvedPath}`);
            const errText = `<!-- SVG load error: ${resolvedPath} -->`;
            svgCache.set(resolvedPath, errText);
            return { ok: false, error: 'fetch', text: errText };
        }

        const text = await response.text();
        svgCache.set(resolvedPath, text);
        return { ok: true, text };
    } catch (error) {
        console.error(`[Manifest SVG] Error fetching: ${str}`, error);
        const errText = `<!-- SVG fetch error: ${error.message} -->`;
        if (resolvedPath) {
            svgCache.set(resolvedPath, errText);
        }
        return { ok: false, error: 'fetch', text: errText };
    }
}

function injectSvgChildren(hostEl, svgText) {
    const root = parseSvgRoot(svgText);
    if (!root) {
        console.warn('[Manifest SVG] Invalid SVG markup');
        hostEl.replaceChildren();
        return;
    }
    const clone = document.importNode(root, true);
    hostEl.replaceChildren(clone);

    if (window.Alpine && typeof window.Alpine.initTree === 'function') {
        if (window.Alpine.nextTick) {
            window.Alpine.nextTick(() => {
                window.Alpine.initTree(hostEl);
            });
        } else {
            setTimeout(() => {
                window.Alpine.initTree(hostEl);
            }, 0);
        }
    }
}

async function initializeSvgPlugin() {
    try {
        const isPrerenderedPage = !!(
            document.querySelector('meta[name="manifest:prerendered"]') &&
            document.querySelector('meta[name="manifest:prerendered"]').getAttribute('content') !== '0'
        );

        Alpine.directive('svg', (el, { expression, modifiers }, { effect, evaluateLater }) => {
            if (!expression) {
                return;
            }

            // .safe opts into sanitization; default keeps full SVG fidelity (filters,
            // animation scripts). Use it when the source is untrusted.
            const safe = Array.isArray(modifiers) && modifiers.includes('safe');

            const hasBakedContent =
                isPrerenderedPage &&
                el.querySelector('svg') &&
                el.querySelector('svg').parentElement === el;

            if (hasBakedContent) {
                return;
            }

            // Only wrap bare tokens that look like file paths — not Alpine identifiers (e.g. `star`
            // from x-data). Same intent as x-markdown path literals vs expressions.
            let processedExpression = expression;
            const looksLikeUnquotedPath =
                !expression.includes('+') &&
                !expression.includes('`') &&
                !expression.includes('${') &&
                !expression.startsWith('$') &&
                !expression.startsWith("'") &&
                !expression.startsWith('"') &&
                (expression.includes('/') || expression.includes('.svg'));
            if (looksLikeUnquotedPath) {
                processedExpression = `'${expression.replace(/'/g, "\\'")}'`;
            }

            const getSvgSource = evaluateLater(processedExpression);
            let lastText = null;

            effect(() => {
                getSvgSource(async (pathOrContent) => {
                    if (pathOrContent === undefined || pathOrContent === '' || pathOrContent === null) {
                        el.replaceChildren();
                        return;
                    }

                    const resolved = await resolveSvgString(
                        pathOrContent === undefined ? expression : pathOrContent
                    );

                    if (!resolved.ok && resolved.error === 'not-path') {
                        console.warn('[Manifest SVG] Expected a file path or SVG markup');
                        el.replaceChildren();
                        return;
                    }

                    const rawText = resolved.text || '';
                    if (rawText === lastText) {
                        return;
                    }
                    lastText = rawText;

                    if (!rawText.trim()) {
                        el.replaceChildren();
                        return;
                    }

                    const text = await maybeSanitizeSvg(rawText, safe);
                    if (!text || !text.trim()) {
                        el.replaceChildren();
                        return;
                    }

                    injectSvgChildren(el, text);
                });
            });
        });
    } catch (error) {
        console.error('[Manifest] Failed to initialize SVG plugin:', error);
    }
}

let svgPluginInitialized = false;

// True once Alpine finished its initial walk. Bound at load so we never miss it.
let svgAlpineHasWalked = false;
document.addEventListener('alpine:initialized', () => { svgAlpineHasWalked = true; });

async function ensureSvgPluginInitialized() {
    if (svgPluginInitialized) {
        return;
    }
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') {
        return;
    }

    svgPluginInitialized = true;
    await initializeSvgPlugin();

    // Walk existing [x-svg] subtrees only if Alpine already finished its boot walk
    // (late load). During boot, let Alpine's own walk handle them with all sibling
    // directives registered — walking here would drop nested plugin content.
    if (svgAlpineHasWalked && typeof window.Alpine.initTree === 'function') {
        const existing = document.querySelectorAll('[x-svg]');
        existing.forEach((el) => {
            if (!el.__x) {
                window.Alpine.initTree(el);
            }
        });
    }
}

window.ensureSvgPluginInitialized = ensureSvgPluginInitialized;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureSvgPluginInitialized);
}

document.addEventListener('alpine:init', ensureSvgPluginInitialized);

if (window.Alpine && typeof window.Alpine.directive === 'function') {
    ensureSvgPluginInitialized();
}


})();
