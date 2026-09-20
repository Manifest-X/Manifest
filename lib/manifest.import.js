/* Manifest Import — x-import / $import pick a local file and parse it into data (json/csv) */

(function () {


function initializeImportPlugin() {

    Alpine.directive('import', (el, { modifiers, expression }, { evaluate, cleanup }) => {

        const onClick = async (e) => {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            const opts = resolveOptions(expression, modifiers, evaluate);
            try {
                await runImport(el, opts);
            } catch (err) {
                if (!err || !err._mnfstReported) emitError(el, opts.format, err);
            }
        };
        el.addEventListener('click', onClick);
        cleanup(() => el.removeEventListener('click', onClick));
    });

    // ----- $import magic — programmatic file pick, resolves parsed data -----
    Alpine.magic('import', (el) => async (opts = {}) => {
        return runImport(el || null, { ...opts });
    });

    // ------- Options + format helpers -----------------------------------

    function resolveOptions(expression, modifiers, evaluate) {
        let opts = {};
        if (expression && expression.trim()) {
            try {
                const v = evaluate(expression);
                if (v && typeof v === 'object') opts = { ...v };
                else if (typeof v === 'string') opts = isKnownFormat(v.toLowerCase()) ? { format: v.toLowerCase() } : { source: v };
            } catch (err) {
                console.warn('[x-import] could not evaluate options expression:', err.message);
            }
        }
        // Modifier shorthand for format only (.json, .csv).
        if (!opts.format && Array.isArray(modifiers) && modifiers.length) {
            const found = modifiers.find((m) => isKnownFormat(String(m).toLowerCase()));
            if (found) opts.format = String(found).toLowerCase();
        }
        return opts;
    }

    function isKnownFormat(f) {
        return f === 'json' || f === 'csv';
    }

    function acceptFor(format) {
        if (format === 'json') return '.json,application/json';
        if (format === 'csv') return '.csv,text/csv,.tsv';
        return '.json,application/json,.csv,text/csv,.tsv';
    }

    function formatOf(file, declared) {
        if (declared && isKnownFormat(declared)) return declared;
        const name = (file && file.name || '').toLowerCase();
        if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv';
        return 'json';
    }

    // ------- File picking ------------------------------------------------

    // Hidden input per pick; resolves the chosen File, or null when the dialog
    // is dismissed (the input 'cancel' event, where supported).
    function pickFile(accept) {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            if (accept) input.accept = accept;
            input.style.display = 'none';
            const done = (file) => { input.remove(); resolve(file); };
            input.addEventListener('change', () => done(input.files && input.files[0] || null), { once: true });
            input.addEventListener('cancel', () => done(null), { once: true });
            document.body.appendChild(input);
            input.click();
        });
    }

    function readAsText(file) {
        if (typeof file.text === 'function') return file.text();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('could not read file'));
            reader.readAsText(file);
        });
    }

    // ------- Parsing -------------------------------------------------------

    function parseContent(text, format) {
        if (format === 'json') {
            return JSON.parse(text);
        }
        return parseCsv(text);
    }

    // RFC 4180-style CSV: quoted fields, embedded commas/newlines/quotes.
    // Header row → array of objects. Delimiter sniffed from the header line.
    function parseCsv(text) {
        const src = String(text).replace(/^﻿/, '');
        if (!src.trim()) return [];
        const delimiter = sniffDelimiter(src);
        const rows = [];
        let row = [];
        let cell = '';
        let inQuotes = false;
        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (src[i + 1] === '"') { cell += '"'; i++; }
                    else inQuotes = false;
                } else cell += ch;
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === delimiter) {
                row.push(cell); cell = '';
            } else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && src[i + 1] === '\n') i++;
                row.push(cell); cell = '';
                rows.push(row); row = [];
            } else {
                cell += ch;
            }
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
        if (!rows.length) return [];
        const headers = rows[0].map((h) => String(h).trim());
        return rows.slice(1).map((cells) => {
            const out = {};
            headers.forEach((h, i) => { if (h) out[h] = coerceCell(cells[i]); });
            return out;
        });
    }

    function sniffDelimiter(src) {
        const header = src.slice(0, src.indexOf('\n') < 0 ? src.length : src.indexOf('\n'));
        let best = ',', bestCount = 0;
        for (const d of [',', ';', '\t']) {
            const count = header.split(d).length - 1;
            if (count > bestCount) { best = d; bestCount = count; }
        }
        return best;
    }

    // Undo x-export's CSV serialization: JSON-looking cells parse back to
    // objects/arrays; numbers, booleans and null coerce; everything else stays a string.
    function coerceCell(v) {
        if (v == null) return '';
        const s = String(v);
        const t = s.trim();
        if (t === '') return '';
        if (t === 'true') return true;
        if (t === 'false') return false;
        if (t === 'null') return null;
        if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) {
            const n = Number(t);
            if (Number.isFinite(n)) return n;
        }
        if (t[0] === '{' || t[0] === '[') {
            try { return JSON.parse(t); } catch { /* keep string */ }
        }
        return s;
    }

    // ------- Delivery ------------------------------------------------------

    function applyToSource(source, data) {
        const store = window.ManifestDataStore;
        if (!store || typeof store.updateStore !== 'function') {
            throw new Error(`cannot write to source "${source}" — the data plugin is not loaded`);
        }
        store.updateStore(source, data, { loading: false, error: null, ready: true, fresh: true, allowDuringInit: true });
    }

    async function runImport(el, opts) {
        const accept = opts.accept || acceptFor(opts.format);
        const file = await pickFile(accept);
        if (!file) return null;
        const format = formatOf(file, opts.format);
        let data;
        try {
            data = parseContent(await readAsText(file), format);
        } catch (err) {
            const e = new Error(`could not parse ${file.name} as ${format}: ${err.message}`);
            emitError(el, format, e);
            e._mnfstReported = true;
            throw e;
        }
        if (opts.source) applyToSource(String(opts.source), data);
        emit(el, 'manifest:import', {
            data,
            format,
            source: opts.source || null,
            file: { name: file.name, size: file.size, type: file.type }
        });
        return data;
    }

    function emit(el, name, detail) {
        try {
            const event = new CustomEvent(name, { detail, bubbles: true, composed: true });
            (el && el.dispatchEvent ? el : window).dispatchEvent(event);
        } catch { /* ignore */ }
    }

    function emitError(el, format, err) {
        console.error('[x-import] import failed:', err && err.message || err);
        emit(el, 'manifest:import-error', { format: format || null, error: err && err.message || String(err) });
    }
}

// Standard plugin init lifecycle.
let importPluginInitialized = false;
function ensureImportPluginInitialized() {
    if (importPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
    importPluginInitialized = true;
    initializeImportPlugin();
}
window.ensureImportPluginInitialized = ensureImportPluginInitialized;
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureImportPluginInitialized);
}
document.addEventListener('alpine:init', ensureImportPluginInitialized);
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureImportPluginInitialized, 0);
} else {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureImportPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}


})();
