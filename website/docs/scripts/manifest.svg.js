/* Manifest SVG — inline SVG from local paths or raw markup (nested, like x-markdown) */

const svgCache = new Map();

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

        Alpine.directive('svg', (el, { expression }, { effect, evaluateLater }) => {
            if (!expression) {
                return;
            }

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

                    const text = resolved.text || '';
                    if (text === lastText) {
                        return;
                    }
                    lastText = text;

                    if (!text.trim()) {
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

async function ensureSvgPluginInitialized() {
    if (svgPluginInitialized) {
        return;
    }
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') {
        return;
    }

    svgPluginInitialized = true;
    await initializeSvgPlugin();

    if (window.Alpine && typeof window.Alpine.initTree === 'function') {
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
