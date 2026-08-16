/* Manifest Export — x-export / $export download of pages, regions, or data (pdf/png/jpeg/webp/csv/json) */

(function () {


function initializeExportPlugin() {

    Alpine.directive('export', (el, { modifiers, expression }, { evaluate, cleanup }) => {

        const opts = resolveOptions(expression, modifiers, evaluate);
        const format = (opts.format || 'pdf').toLowerCase();
        const isAnchor = el.tagName === 'A';
        const href = isAnchor ? el.getAttribute('href') : null;

        // ----- URL-trigger destination: fire if ?export=<format> is present (once per load) -----
        if (opts.trigger === 'url') {
            if (urlTriggerFired) return;
            const paramName = opts.urlParam || 'export';
            const paramValue = new URLSearchParams(window.location.search).get(paramName);
            if (paramValue) {
                urlTriggerFired = true;
                const fmt = isKnownFormat(paramValue) ? paramValue : format;
                setTimeout(() => {
                    runExport(fmt, opts, resolveFilename(el, opts, fmt))
                        .catch((err) => emitError(fmt, err));
                }, Number(opts.delay) > 0 ? Number(opts.delay) : 0);
            }
            return;
        }

        // ----- Anchor with cross-page href: pre-arm with ?export=<format> -----
        if (isAnchor && href && !href.startsWith('#') && !href.startsWith('javascript:')
            && !/^(mailto|tel):/i.test(href)) {
            try {
                const url = new URL(href, window.location.href);
                const paramName = opts.urlParam || 'export';
                url.searchParams.set(paramName, format);
                // Preserve the original href shape: relative stays relative.
                if (url.origin === window.location.origin && !href.startsWith('http')) {
                    el.setAttribute('href', url.pathname + url.search + url.hash);
                } else {
                    el.setAttribute('href', url.toString());
                }
            } catch (err) {
                console.warn('[x-export] could not parse href for cross-page export:', err.message);
            }
            return;
        }

        // ----- Anchor with same-page fragment href: the href IS the target -----
        if (isAnchor && href && href.startsWith('#')) {
            const onClick = async (e) => {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                const filename = resolveFilename(el, opts, format);
                try {
                    await runExport(format, { ...opts, target: href }, filename);
                } catch (err) {
                    emitError(format, err);
                }
            };
            el.addEventListener('click', onClick);
            cleanup(() => el.removeEventListener('click', onClick));
            return;
        }

        // ----- Default: click anywhere else triggers export -----
        const onClick = async (e) => {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            const filename = resolveFilename(el, opts, format);
            try {
                await runExport(format, opts, filename);
            } catch (err) {
                emitError(format, err);
            }
        };
        el.addEventListener('click', onClick);
        cleanup(() => el.removeEventListener('click', onClick));
    });

    // ----- $export magic — programmatic trigger from any expression -----
    Alpine.magic('export', () => async (opts = {}) => {
        const format = String(opts.format || 'pdf').toLowerCase();
        const filename = opts.filename || defaultFilename(format);
        return runExport(format, opts, filename);
    });

    // ------- Options + format helpers -----------------------------------

    function resolveOptions(expression, modifiers, evaluate) {
        let opts = {};
        if (expression && expression.trim()) {
            try {
                const v = evaluate(expression);
                if (v && typeof v === 'object') opts = { ...v };
                else if (typeof v === 'string') opts.format = v;
            } catch (err) {
                console.warn('[x-export] could not evaluate options expression:', err.message);
            }
        }
        // Modifier shorthand for format only (.png, .jpg, …); numeric options go in the value expression.
        if (!opts.format && Array.isArray(modifiers) && modifiers.length) {
            const found = modifiers.find((m) => isKnownFormat(String(m).toLowerCase()));
            if (found) opts.format = String(found).toLowerCase();
        }
        return opts;
    }

    function isKnownFormat(f) {
        return f === 'pdf' || f === 'png' || f === 'jpeg' || f === 'jpg' || f === 'webp' || f === 'csv' || f === 'json';
    }

    function defaultFilename(format) {
        const ext = format === 'jpeg' || format === 'jpg' ? 'jpg' : format;
        const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        return `export-${ts}.${ext}`;
    }

    // Filename resolution precedence (highest first):
    //   1. opts.filename from the directive's object expression
    //   2. the standard HTML `download` attribute on an anchor host
    //   3. a `data-filename` attribute on any host element
    //   4. a timestamped default based on the format
    function resolveFilename(el, opts, format) {
        if (opts && opts.filename) return String(opts.filename);
        if (el && el.tagName === 'A') {
            const dl = el.getAttribute('download');
            if (dl) return dl;
        }
        if (el && typeof el.getAttribute === 'function') {
            const df = el.getAttribute('data-filename');
            if (df) return df;
        }
        return defaultFilename(format);
    }

    // Fallback for a failed inline image, so one CORS/404 doesn't reject the whole snapshot.
    const TRANSPARENT_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

    // Translate the library's raw image.onerror Event into a readable message.
    function describeExportError(err) {
        if (err && err.message) return err;
        if (err && typeof Event !== 'undefined' && err instanceof Event) {
            const tag = err.target && err.target.tagName ? err.target.tagName.toLowerCase() : 'image';
            return new Error(
                `failed to render ${tag} during export. ` +
                `Common causes: cross-origin images without CORS headers, ` +
                `an oversized target element, or a no-target snapshot of a complex page. ` +
                `Pass a "target" option to scope the snapshot.`
            );
        }
        return new Error(String(err));
    }

    function emitError(format, err) {
        const e = describeExportError(err);
        console.error('[x-export] export failed:', e.message);
        try {
            window.dispatchEvent(new CustomEvent('manifest:export-error', {
                detail: { format, error: e.message }
            }));
        } catch { /* ignore */ }
    }

    async function runExport(format, opts, filename) {
        switch (format) {
            case 'pdf': return exportPdf(opts, filename);
            case 'png': return exportImage(opts, filename, 'png');
            case 'jpeg':
            case 'jpg': return exportImage(opts, filename, 'jpeg');
            case 'webp': return exportImage(opts, filename, 'webp');
            case 'csv': return exportCsv(opts, filename);
            case 'json': return exportJson(opts, filename);
            default: throw new Error(`Unknown format "${format}". Supported: pdf, png, jpeg, webp, csv, json.`);
        }
    }

    // ------- Visual exports (PDF, PNG, JPEG, WebP) ----------------------

    function resolveTarget(opts) {
        if (opts.target) {
            const t = typeof opts.target === 'string'
                ? document.querySelector(opts.target)
                : opts.target;
            if (!t) throw new Error(`target "${opts.target}" matched no element`);
            return t;
        }
        return document.body;
    }

    function snapshotOptions(opts) {
        // html2canvas-pro: return true to SKIP this node (data-no-export opt-out).
        const ignoreElements = (node) => {
            return !!(node && node.nodeType === 1
                && node.hasAttribute && node.hasAttribute('data-no-export'));
        };
        // Default scale = device pixel ratio (matches on-screen); override with `resolution: N`.
        const defaultScale = (typeof window !== 'undefined' && window.devicePixelRatio > 0)
            ? window.devicePixelRatio
            : 1;
        const out = {
            scale: Number(opts.resolution) > 0 ? Number(opts.resolution) : defaultScale,
            ignoreElements,
            useCORS: true,
            allowTaint: false,
            // Per-image timeout: a failed fetch drops the image, not the whole snapshot.
            imageTimeout: 5000,
            logging: false,
            // Pin capture to (0,0) — otherwise html2canvas clips to below the current scroll.
            scrollX: 0,
            scrollY: 0,
        };
        // html2canvas-pro wants null (not 'transparent') to disable its default white fill.
        if (opts.backgroundColor === 'transparent') {
            out.backgroundColor = null;
        } else if (opts.backgroundColor) {
            out.backgroundColor = opts.backgroundColor;
        }
        if (opts.width) out.width = Number(opts.width);
        if (opts.height) out.height = Number(opts.height);
        return out;
    }

    // Await in-target <img> loads so freshly-mounted images aren't blank; timeout-bounded.
    async function waitForImages(target, timeoutMs = 5000) {
        if (!target || typeof target.querySelectorAll !== 'function') return;
        const imgs = Array.from(target.querySelectorAll('img'));
        const pending = imgs.filter((img) => !img.complete || img.naturalWidth === 0);
        if (pending.length === 0) return;
        await Promise.race([
            Promise.all(pending.map((img) => new Promise((resolve) => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
            }))),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
    }

    async function snapshotToCanvas(lib, target, so) {
        try {
            return await lib(target, so);
        } catch (err) {
            // Retry with allowTaint + lower scale to survive a cross-origin image.
            const safer = { ...so, allowTaint: true, useCORS: false, scale: Math.min(so.scale || 2, 1) };
            return await lib(target, safer);
        }
    }

    async function exportImage(opts, filename, ext) {
        const lib = await loadSnapshotLib();
        const target = resolveTarget(opts);
        const so = snapshotOptions(opts);
        // Default to the page's effective background so the snapshot looks like the page.
        if (so.backgroundColor === undefined) {
            so.backgroundColor = effectivePageBackground();
        }
        await waitForImages(target);
        const canvas = await snapshotToCanvas(lib, target, so);
        const quality = Number(opts.quality) > 0 && Number(opts.quality) <= 1
            ? Number(opts.quality)
            : 0.95;
        let dataUrl;
        if (ext === 'png') dataUrl = canvas.toDataURL('image/png');
        else if (ext === 'jpeg') dataUrl = canvas.toDataURL('image/jpeg', quality);
        else if (ext === 'webp') dataUrl = canvas.toDataURL('image/webp', quality);
        triggerDownload(dataUrl, filename);
    }

    // PDFs route through the browser's print pipeline — vector text, real layout,
    // multi-page flow, the page's own @media print CSS. A target scopes the print.
    async function exportPdf(opts, filename) {
        return printToPdf(filename, opts.target ? resolveTarget(opts) : null, opts.pageSize);
    }

    // Trigger "Save as PDF". Filename seeds via a document.title swap. A target is
    // scoped by cloning it into a body-level container and display:none-ing every
    // other body child — cloning leaves live DOM/Alpine state intact, and
    // display:none (not visibility:hidden) collapses body height so no blank tail pages.
    function printToPdf(filename, target, pageSize) {
        const original = document.title;
        const cleaned = String(filename || '').replace(/\.pdf$/i, '') || original;
        document.title = cleaned;
        // Sanitize pageSize so it can't break out of the @page rule.
        const safePageSize = (typeof pageSize === 'string' && /^[a-zA-Z0-9 ]+$/.test(pageSize))
            ? pageSize.trim()
            : 'a4';

        let printContainer = null;
        const pageRule = '@page { size: ' + safePageSize + '; margin: 1cm; }';
        const style = document.createElement('style');
        style.setAttribute('data-mnfst-print-scope', '');

        if (target && target.nodeType === 1) {
            printContainer = document.createElement('div');
            printContainer.setAttribute('data-mnfst-print-target', '');
            // Off-screen so the clone never flashes in normal rendering.
            printContainer.style.position = 'absolute';
            printContainer.style.left = '-99999px';
            printContainer.style.top = '0';
            printContainer.appendChild(target.cloneNode(true));
            document.body.appendChild(printContainer);

            style.textContent =
                pageRule +
                '@media print {' +
                  // Hide every original body child so body height collapses to the clone.
                  'body > *:not([data-mnfst-print-target]) { display: none !important; }' +
                  // Restore the clone to normal flow, full width.
                  'body > [data-mnfst-print-target] {' +
                    'display: block !important;' +
                    'position: static !important;' +
                    'left: auto !important;' +
                    'top: auto !important;' +
                    'width: 100% !important;' +
                    'max-width: none !important;' +
                    'margin: 0 !important;' +
                    'padding: 0 !important;' +
                  '}' +
                  '[data-no-export] { display: none !important; }' +
                '}';
        } else {
            // Whole-page print: honor pageSize + data-no-export; page's own print CSS does the rest.
            style.textContent =
                pageRule +
                '@media print {' +
                  '[data-no-export] { display: none !important; }' +
                '}';
        }
        document.head.appendChild(style);

        const cleanup = () => {
            document.title = original;
            style.remove();
            if (printContainer) printContainer.remove();
            window.removeEventListener('afterprint', onAfter);
        };
        const onAfter = () => cleanup();
        window.addEventListener('afterprint', onAfter);

        try { window.print(); }
        catch (err) {
            cleanup();
            throw err;
        }
        // afterprint isn't always reliable (e.g. Esc-cancel in older Safari) — fallback teardown.
        setTimeout(cleanup, 30000);
    }

    function effectivePageBackground() {
        let el = document.body;
        while (el && el !== document.documentElement.parentElement) {
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor;
            if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
            el = el.parentElement;
        }
        return '#ffffff';
    }

    function loadImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    // ------- Tabular exports (CSV, JSON) --------------------------------

    function resolveDataset(opts) {
        if (Array.isArray(opts.data)) return opts.data;
        if (opts.data && typeof opts.data === 'object') return opts.data;
        if (opts.source) {
            const x = window.$x || (window.Alpine && window.Alpine.magic && window.Alpine.magic('x'));
            if (x && x[opts.source] != null) return x[opts.source];
        }
        throw new Error('csv/json export needs `source: "<name>"` or `data: <value>`');
    }

    function exportCsv(opts, filename) {
        const data = resolveDataset(opts);
        if (!Array.isArray(data)) throw new Error('csv export expects an array data source');
        if (data.length === 0) {
            triggerDownload(blobUrl('', 'text/csv'), filename);
            return;
        }
        const headers = [];
        const seen = new Set();
        for (const row of data) {
            if (!row || typeof row !== 'object') continue;
            for (const k of Object.keys(row)) {
                if (!seen.has(k)) { seen.add(k); headers.push(k); }
            }
        }
        const lines = [headers.map(csvCell).join(',')];
        for (const row of data) {
            lines.push(headers.map((h) => csvCell(row && row[h])).join(','));
        }
        triggerDownload(blobUrl(lines.join('\n') + '\n', 'text/csv;charset=utf-8'), filename);
    }

    function exportJson(opts, filename) {
        const data = resolveDataset(opts);
        const serializable = sanitize(data);
        triggerDownload(blobUrl(JSON.stringify(serializable, null, 2), 'application/json'), filename);
    }

    function sanitize(value) {
        if (Array.isArray(value)) return value.map(sanitize);
        if (value && typeof value === 'object') {
            const out = {};
            for (const k of Object.keys(value)) {
                if (k.startsWith('$') || k === '_loading' || k === '_error') continue;
                out[k] = sanitize(value[k]);
            }
            return out;
        }
        return value;
    }

    function csvCell(v) {
        if (v == null) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    // ------- Helpers ----------------------------------------------------

    function blobUrl(content, type) {
        return URL.createObjectURL(new Blob([content], { type }));
    }

    function triggerDownload(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (url.startsWith('blob:')) setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 2000);
    }

    // Lazy library loaders — cached promises.

    // html2canvas-pro — ESM-only, loaded via dynamic import() from jsDelivr.
    let snapshotLibPromise = null;
    function loadSnapshotLib() {
        if (snapshotLibPromise) return snapshotLibPromise;
        snapshotLibPromise = import('https://cdn.jsdelivr.net/npm/html2canvas-pro@2/dist/html2canvas-pro.esm.js')
            .then((mod) => {
                const fn = mod.default || mod.html2canvas;
                if (typeof fn !== 'function') {
                    throw new Error('html2canvas-pro failed to load (missing default export)');
                }
                return fn;
            })
            .catch((err) => {
                snapshotLibPromise = null; // allow retry on next call
                throw err;
            });
        return snapshotLibPromise;
    }

    let jsPDFPromise = null;
    function loadJsPDF() {
        if (jsPDFPromise) return jsPDFPromise;
        jsPDFPromise = loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js')
            .then(() => {
                const ctor = window.jspdf && window.jspdf.jsPDF;
                if (!ctor) throw new Error('jsPDF failed to load');
                return ctor;
            });
        return jsPDFPromise;
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                if (existing._loaded) resolve();
                else {
                    existing.addEventListener('load', () => resolve());
                    existing.addEventListener('error', reject);
                }
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.addEventListener('load', () => { s._loaded = true; resolve(); });
            s.addEventListener('error', () => reject(new Error('Failed to load ' + src)));
            document.head.appendChild(s);
        });
    }
}

// URL-triggered exports fire at most once per page load.
let urlTriggerFired = false;

// Standard plugin init lifecycle.
let exportPluginInitialized = false;
function ensureExportPluginInitialized() {
    if (exportPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
    exportPluginInitialized = true;
    initializeExportPlugin();
}
window.ensureExportPluginInitialized = ensureExportPluginInitialized;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureExportPluginInitialized);
}
document.addEventListener('alpine:init', ensureExportPluginInitialized);
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureExportPluginInitialized, 0);
} else {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureExportPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}


})();
