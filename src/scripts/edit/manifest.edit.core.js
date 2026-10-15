/* Manifest Edit */

(function () {
    const LS_KEY = 'mnfst-edit-log';
    const SCHEMA = 8;
    const HISTORY_CAP = 400;
    const ALL_CAPS = ['text', 'move', 'size', 'data'];
    const DEFAULT_CAPS = ['text', 'move'];
    const LOCK_ACTIONS = ['move', 'remove', 'duplicate', 'text', 'attrs', 'size'];
    const RETIRED = { sort: '.move', authoring: 'nothing (visuals are on by default; use .bare to hide them, .persist to keep edits)', style: '$edit.classes / $edit.attr', none: '.lock' };
    const COALESCE_MS = 1000;
    let dragged = null, autoN = 0;

    let log = [], cursor = 0;
    const lastSnap = {};
    const persisted = new WeakSet();

    const staticKey = (el) => el.tagName + ':' + (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
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
    const loadState = () => {
        try {
            const s = JSON.parse(localStorage.getItem(LS_KEY));
            if (s && s.v === SCHEMA) { log = s.log || []; cursor = s.cursor ?? log.length; log.forEach(d => persisted.add(d)); }
            else if (s) localStorage.removeItem(LS_KEY);
        } catch { }
    };
    const saveState = () => {
        if (log.length > HISTORY_CAP) { const n = log.length - HISTORY_CAP; log.splice(0, n); cursor = Math.max(0, cursor - n); }
        const done = log.slice(0, cursor).filter(d => persisted.has(d)), ahead = log.slice(cursor).filter(d => persisted.has(d));
        try {
            if (!done.length && !ahead.length) localStorage.removeItem(LS_KEY);
            else localStorage.setItem(LS_KEY, JSON.stringify({ v: SCHEMA, log: [...done, ...ahead], cursor: done.length }));
        } catch { }
    };
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // Inherited custom properties, read through the cascade; `none` cancels an inherited value.
    function cssVar(el, name, fallback) {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const v = getComputedStyle(n).getPropertyValue(name).trim();
            if (v) return v === 'none' && name !== '--edit-size' ? (fallback ?? '') : v;
        }
        return fallback ?? '';
    }

    /* ---- Safety ---- */
    const nodeSig = (el) => el ? el.tagName.toLowerCase() : '';
    const SAFE_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'U', 'S', 'SMALL', 'CODE', 'MARK', 'SUB', 'SUP', 'BR', 'SPAN', 'A']);
    const sanitizeFor = (el, html) => el && el.hasAttribute && el.hasAttribute('data-text-edit') && window.ManifestTextEdit
        ? window.ManifestTextEdit.sanitize(html, true, true)
        : sanitizeHTML(html);

    function sanitizeHTML(html) {
        const t = document.createElement('template'); t.innerHTML = String(html == null ? '' : html);
        const walk = (node) => [...node.childNodes].forEach(c => {
            if (c.nodeType === 8) return c.remove();
            if (c.nodeType !== 1) return;
            if (!SAFE_TAGS.has(c.tagName)) { c.replaceWith(document.createTextNode(c.textContent)); return; }
            [...c.attributes].forEach(a => { const n = a.name.toLowerCase(); if (!(c.tagName === 'A' && n === 'href' && !/^\s*javascript:/i.test(a.value))) c.removeAttribute(a.name); });
            walk(c);
        });
        walk(t.content);
        return t.innerHTML;
    }

    // Attribute guardrails: refused names and URL schemes. Returns a reason, or null when safe.
    const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
    function attrRefusal(name, value) {
        const n = String(name || '').trim().toLowerCase();
        if (!n || !/^[a-z_:][\w:.-]*$/i.test(n) && !/^[@:]/.test(n)) return 'invalid name';
        if (n === 'text') return 'reserved name';
        if (n.startsWith('on')) return 'event handler attribute';
        if (n.startsWith('x-') || n.startsWith('@') || n.startsWith(':')) return 'Alpine directive';
        if (n.startsWith('data-edit-')) return 'plugin attribute';
        if (n === 'srcdoc') return 'inline document';
        if (value != null && URL_ATTRS.has(n)) {
            const v = String(value).replace(/[\u0000- ]/g, '').toLowerCase();
            if (/^(javascript|vbscript):/.test(v)) return 'script URL';
            if (v.startsWith('data:') && !(n === 'src' && v.startsWith('data:image/'))) return 'data URL';
        }
        return null;
    }

    /* ---- x-edit registry ---- */
    const editEls = new Set();
    const themeScopes = {};
    const warnedRetired = new Set();
    function registerEdit(el, modifiers, expression) {
        if (modifiers.includes('cssvar')) return registerCssVar(el, expression, modifiers);
        modifiers.forEach(m => { if (RETIRED[m] && !warnedRetired.has(m)) { warnedRetired.add(m); console.warn(`[edit] x-edit.${m} was removed — use ${RETIRED[m]}`); } });
        if (modifiers.includes('lock')) {
            const actions = modifiers.filter(m => LOCK_ACTIONS.includes(m));
            el._editLock = new Set(actions.length ? actions : ['*']);
            return;
        }
        const caps = new Set(ALL_CAPS.filter(c => modifiers.includes(c)));
        const theme = modifiers.includes('theme');
        const k = (expression || '').trim() || `area-${++autoN}`;
        if (theme) themeScopes[k] = el;
        if (theme && !caps.size) { if (modifiers.includes('persist')) el._editPersist = true; return; }
        if (!caps.size) DEFAULT_CAPS.forEach(c => caps.add(c));
        if ((expression || '').trim() && [...editEls].some(e => e !== el && e._edit && e._edit.key === k)) console.warn('[edit] duplicate x-edit key (deltas will mis-route):', k);
        const bare = modifiers.includes('bare');
        el._edit = { key: k, caps, gated: modifiers.includes('gated'), theme, persist: modifiers.includes('persist'), bare };
        el.setAttribute('data-edit-area', bare ? 'bare' : '');
        editEls.add(el); resetAreas();
    }
    let areasCache = null;
    const areas = () => areasCache || (areasCache = [...editEls].filter(el => { for (let n = el.parentElement; n; n = n.parentElement) if (n._edit) return false; return true; }));
    const resetAreas = () => { areasCache = null; };
    const areaByKey = (k) => areas().find(a => a._edit.key === k);
    const topArea = (a) => !!a && areas().includes(a);
    const regionOf = (el) => el && areas().find(a => a === el || a.contains(el));
    const key = (area) => area._edit.key;
    function editInfo(node) { for (let n = node; n; n = n.parentElement) if (n._edit) return n._edit; return null; }
    const capOf = (node, cap) => { const i = editInfo(node); return !!i && i.caps.has(cap) && !lockedFor(node, cap); };
    const ownsCap = (el, cap) => !!el._edit && el._edit.caps.has(cap) && !lockedFor(el, cap);
    const persistOf = (region) => { const a = region != null && areaByKey(region); return !!(a && a._edit.persist); };

    /* ---- Regime classification ---- */
    function classify(area) {
        if (area.querySelector('template[x-for]')) return 'data';
        if (area.matches('[data-component]') || area.querySelector('[data-component]')) return 'component';
        return 'static';
    }
    function dataSourceExpr(area) { const t = area.querySelector('template[x-for]'); const m = t && t.getAttribute('x-for').match(/\bin\s+(.+)$/); return m ? m[1].trim() : null; }
    const dataSourceName = (area) => { const e = dataSourceExpr(area); const m = e && e.match(/\$x\.(\w+)/); return m ? m[1] : (e || 'source'); };
    const pluginNode = (x) => x.hasAttribute('data-edit-handle') || x.hasAttribute('data-edit-ghost');
    const realChildren = (el) => Array.from(el.children).filter(x => !pluginNode(x));
    const sortableChildren = (c) => realChildren(c).filter(x => x.tagName !== 'TEMPLATE');
    let _keyWarned = false;
    function itemKey(el, area) {
        const explicit = el.getAttribute('data-key');
        if (explicit != null) return explicit;
        const tpl = area.querySelector('template[x-for]'), expr = tpl && tpl._x_keyExpression;
        if (expr) { try { const v = window.Alpine.evaluate(el, expr); if (v != null) return String(v); } catch { } }
        if (!_keyWarned) { _keyWarned = true; console.warn('[edit] data area rows have no identity — add :key to the x-for or :data-key to the row, or the order cannot be stored'); }
        return null;
    }

    /* ---- Structure: text elements are pieces, never containers ---- */
    const TEXT_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SPAN', 'A', 'LABEL', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SMALL', 'CODE', 'MARK', 'SUB', 'SUP', 'Q', 'CITE', 'ABBR', 'TIME', 'DT', 'DD', 'FIGCAPTION', 'CAPTION', 'LEGEND', 'SUMMARY', 'BUTTON', 'OPTION']);
    const ATOMIC_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'svg', 'IFRAME', 'OBJECT', 'SELECT', 'TEXTAREA', 'PICTURE', 'MATH', 'math', 'TEMPLATE', 'SCRIPT', 'STYLE']);
    const ownText = (el) => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const isTextEl = (el) => TEXT_TAGS.has(el.tagName) || el.hasAttribute('data-text-edit') || ownText(el);
    function isContainer(el) {
        if (!el || el.nodeType !== 1 || ATOMIC_TAGS.has(el.tagName) || pluginNode(el)) return false;
        return !isTextEl(el);
    }

    /* ---- Units ---- */
    const unitOf = (v) => { const m = String(v || '').match(/[a-z%]+$/i); return m ? m[0] : null; };
    function toUnit(px, unit, el, basisEl, dim) {
        if (unit === 'rem') return +(px / parseFloat(getComputedStyle(document.documentElement).fontSize)).toFixed(2);
        if (unit === 'em') return +(px / parseFloat(getComputedStyle(el).fontSize)).toFixed(2);
        if (unit === '%') { const b = (basisEl || el.parentElement).getBoundingClientRect(); const d = dim === 'w' ? b.width : b.height; return d ? +(px / d * 100).toFixed(2) : 0; }
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
