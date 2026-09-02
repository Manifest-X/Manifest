/* Manifest Edit — SPIKE.

   Compiled from src/scripts/edit/*.js into src/scripts/manifest.edit.js by build.mjs
   (order matters). These subscripts are FRAGMENTS of a single IIFE: core.js opens it,
   main.js closes it. Everything stays in one private closure — no globals, no E.* churn.
   Each fragment is grouped by concern; references resolve at runtime once all parts load.

   x-edit marks an editable AREA (or single target). Always-on by default; .gated requires
   $edit.on(). Capabilities via modifiers: .sort .text .style .size (default sort+text+style);
   .lock opts a subtree out. Fine config (size axes/snap/collapse) reads --edit-* CSS vars.
   Three regimes: static HTML · data mutation · component override. Append-only typed-delta
   log is the spine; A overlay + B source patch are projections. */

(function () {
    const LS_KEY = 'mnfst-edit-log';
    const SCHEMA = 6;                  // overlay schema version — bump when the delta shape changes
    const HISTORY_CAP = 400;           // cap the append-only log so long sessions don't grow unbounded
    const ALL_CAPS = ['sort', 'text', 'style', 'size', 'data'];   // 'data' = edit $x field values (opt-in)
    let dragged = null, autoN = 0;

    let log = [], cursor = 0;
    const lastSnap = {}, lastOrder = {};
    // Content-derived key for a static sortable child — stable across reorder AND reload
    // (same content → same key), so reorder can be stored as a tiny key permutation.
    const staticKey = (el) => el.tagName + ':' + (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    // The SAME identity markStatic assigned, not a fresh derivation. Recomputing from
    // current content would drift the moment text is edited, and the child order
    // recorded before that edit would then fail to find the element it named.
    // Two identical siblings are told apart by the ordinal markStatic gave them.
    function staticKeys(container) {
        const seen = Object.create(null);
        return sortableChildren(container).map(el => {
            const assigned = el.getAttribute('data-edit-key');
            if (assigned) return assigned;
            const base = staticKey(el);
            const n = seen[base] = (seen[base] || 0) + 1;
            return n > 1 ? base + '#' + n : base;
        });
    }
    const loadState = () => { try { const s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && s.v === SCHEMA) { log = s.log || []; cursor = s.cursor ?? log.length; } else if (s) localStorage.removeItem(LS_KEY); } catch {} };
    // Only an .authoring area is a page being edited. Everywhere else the plugin is
    // behaviour — a sortable list, a resizable panel — and the app owns the state, so
    // those deltas neither travel to the source nor survive in the overlay. They stay
    // in the in-memory log, so undo still works for the session.
    const authoringRegion = (r) => { const a = r != null && areaByKey(r); return !!(a && a._edit.authoring); };
    const persistable = (d) => d.kind !== 'data-splice' && (d.region == null || authoringRegion(d.region));

    const saveState = () => { if (log.length > HISTORY_CAP) { const n = log.length - HISTORY_CAP; log.splice(0, n); cursor = Math.max(0, cursor - n); } const keep = log.filter(persistable); localStorage.setItem(LS_KEY, JSON.stringify({ v: SCHEMA, log: keep, cursor: Math.min(cursor, keep.length) })); };
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const cssVar = (el, name, fallback) => { const v = getComputedStyle(el).getPropertyValue(name).trim(); return v || fallback; };

    /* ---- Safety helpers ---- */
    // Structural signature for a node at a path — guards against the source structure
    // drifting under a stored delta (apply only if the node still matches).
    const nodeSig = (el) => el ? el.tagName.toLowerCase() : '';
    // Sanitize contentEditable / replayed HTML: allowlist inline tags, strip everything
    // else (attributes, scripts, comments, javascript: hrefs). Critical once overlays can
    // come from other users (cloud). Unknown tags are unwrapped to their text.
    const SAFE_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'U', 'S', 'SMALL', 'CODE', 'MARK', 'SUB', 'SUP', 'BR', 'SPAN', 'A']);
    // An element owned by the rich editor carries block markup this plugin's own
    // allowlist would flatten, so let that plugin vet its own content. Everything
    // else keeps the conservative inline-only policy.
    const sanitizeFor = (el, html) => el && el.hasAttribute && el.hasAttribute('data-text-edit') && window.ManifestTextEdit
        ? window.ManifestTextEdit.sanitize(html, true, true)
        : sanitizeHTML(html);

    function sanitizeHTML(html) {
        const t = document.createElement('template'); t.innerHTML = String(html == null ? '' : html);
        const walk = (node) => [...node.childNodes].forEach(c => {
            if (c.nodeType === 8) return c.remove();                         // comments
            if (c.nodeType !== 1) return;
            if (!SAFE_TAGS.has(c.tagName)) { c.replaceWith(document.createTextNode(c.textContent)); return; }   // unwrap unknown tag
            [...c.attributes].forEach(a => { const n = a.name.toLowerCase(); if (!(c.tagName === 'A' && n === 'href' && !/^\s*javascript:/i.test(a.value))) c.removeAttribute(a.name); });
            walk(c);
        });
        walk(t.content);
        return t.innerHTML;
    }

    /* ---- x-edit registry ---- */
    const editEls = new Set();
    const themeScopes = {};            // scope key → element (CSS-var cascade target for x-edit.cssvar)
    function registerEdit(el, modifiers, expression) {
        if (modifiers.includes('cssvar')) return registerCssVar(el, expression);   // theme control, not an area
        const caps = new Set(ALL_CAPS.filter(c => modifiers.includes(c)));
        const lock = modifiers.includes('lock') || modifiers.includes('none');
        const theme = modifiers.includes('theme');   // theme scope: vars set here cascade to this subtree only
        const k = (expression || '').trim() || `area-${++autoN}`;
        if (theme) themeScopes[k] = el;
        if (theme && !caps.size && !lock) return;   // pure theme scope — a cascade target, NOT an editable area (so it doesn't swallow nested areas)
        if (!caps.size && !lock) ['sort', 'text', 'style'].forEach(c => caps.add(c));   // size is opt-in
        if ((expression || '').trim() && [...editEls].some(e => e !== el && e._edit && e._edit.key === k)) console.warn('[edit] duplicate x-edit key (deltas will mis-route):', k);   // re-init of the same element is not a duplicate
        el._edit = { key: k, caps, lock, gated: modifiers.includes('gated'), theme, authoring: modifiers.includes('authoring') };
        el.setAttribute('data-edit-area', '');
        editEls.add(el);
    }
    const areas = () => [...editEls].filter(el => { for (let n = el.parentElement; n; n = n.parentElement) if (n._edit) return false; return true; });
    const areaByKey = (k) => areas().find(a => a._edit.key === k);
    const key = (area) => area._edit.key;
    function editInfo(node) { for (let n = node; n; n = n.parentElement) if (n._edit) return n._edit; return null; }
    const capOf = (node, cap) => { const i = editInfo(node); return !!i && !i.lock && i.caps.has(cap); };
    const locked = (node) => { const i = editInfo(node); return !!i && i.lock; };
    const ownsCap = (el, cap) => !!el._edit && !el._edit.lock && el._edit.caps.has(cap);

    /* ---- Regime classification ---- */
    function classify(area) {
        if (area.querySelector('template[x-for]')) return 'data';
        if (area.matches('[data-component]') || area.querySelector('[data-component]')) return 'component';
        return 'static';
    }
    function dataSourceExpr(area) { const t = area.querySelector('template[x-for]'); const m = t && t.getAttribute('x-for').match(/\bin\s+(.+)$/); return m ? m[1].trim() : null; }
    const dataSourceName = (area) => { const e = dataSourceExpr(area); const m = e && e.match(/\$x\.(\w+)/); return m ? m[1] : (e || 'source'); };
    const sortableChildren = (c) => Array.from(c.children).filter(x => x.tagName !== 'TEMPLATE' && !x.hasAttribute('data-edit-handle'));
    // Identity of a row in a data area. `data-key` is the explicit form; without it,
    // fall back to the x-for's own :key so a plain list needs no extra attribute.
    let _keyWarned = false;
    function itemKey(el, area) {
        const explicit = el.getAttribute('data-key');
        if (explicit != null) return explicit;
        const tpl = area.querySelector('template[x-for]'), expr = tpl && tpl._x_keyExpression;
        if (expr) { try { const v = window.Alpine.evaluate(el, expr); if (v != null) return String(v); } catch { } }
        if (!_keyWarned) { _keyWarned = true; console.warn('[edit] data area rows have no identity — add :key to the x-for or :data-key to the row, or the order cannot be stored'); }
        return null;
    }
    const STRUCT_ATTRS = new Set(['class', 'style', 'data-component', 'data-edit-area', 'data-edit-field', 'data-edit-sizable', 'data-edit-movable', 'draggable', 'contenteditable', 'x-text', 'x-html', 'id']);
    const componentParams = (area) => { const r = area.querySelector('[data-component]') || area; return [...r.attributes].filter(a => !STRUCT_ATTRS.has(a.name) && a.value.trim()); };

    /* ---- Unit helpers (shared by move + size) ---- */
    const unitOf = (v) => { const m = String(v || '').match(/[a-z%]+$/i); return m ? m[0] : null; };
    function toUnit(px, unit, el, basisEl, dim) {
        if (unit === 'rem') return +(px / parseFloat(getComputedStyle(document.documentElement).fontSize)).toFixed(2);
        if (unit === 'em') return +(px / parseFloat(getComputedStyle(el).fontSize)).toFixed(2);
        if (unit === '%') { const b = (basisEl || el.parentElement).getBoundingClientRect(); return +(px / (dim === 'w' ? b.width : b.height) * 100).toFixed(2); }
        return Math.round(px);
    }
    function toPx(str, el, dim) {
        const v = parseFloat(str); if (isNaN(v)) return null; const u = unitOf(str) || 'px';
        if (u === 'rem') return v * parseFloat(getComputedStyle(document.documentElement).fontSize);
        if (u === 'em') return v * parseFloat(getComputedStyle(el).fontSize);
        if (u === '%') { const b = (el.parentElement || el).getBoundingClientRect(); return v / 100 * (dim === 'h' ? b.height : b.width); }
        return v;
    }
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
