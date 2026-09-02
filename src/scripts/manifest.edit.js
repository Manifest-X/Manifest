/* manifest.edit.js — built from scripts/edit/ */

(function () {

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


    /* ---- Snapshots (static/data are area-snapshotted; component uses per-node deltas) ---- */
    const REVERT = '\u2205revert';   // sentinel; must not collide with a real class/text value
    function snapshot(area, kind) {
        if (kind === 'data') return { source: dataSourceName(area), order: sortableChildren(area).map(c => itemKey(c, area)) };
        return {};   // static & component use per-node typed deltas, not area snapshots
    }
    function cleanStaticHTML(area) {
        const c = area.cloneNode(true);
        c.querySelectorAll('[data-edit-handle], [data-edit-live]').forEach(n => n.remove());
        [c, ...c.querySelectorAll('*')].forEach(el => {
            [...el.attributes].forEach(a => { if (a.name.startsWith('data-edit-')) el.removeAttribute(a.name); });
            ['draggable', 'contenteditable', 'tabindex', 'role', 'aria-label'].forEach(a => el.removeAttribute(a));
            if (!el.getAttribute('class')) el.removeAttribute('class');
        });
        return c.innerHTML.trim().replace(/\n\s*\n/g, '\n');
    }
    async function applySnap(area, kind, snap) {
        if (!area || !snap) return;
        if (kind === 'static') { area.innerHTML = snap.html; if (snap.style != null) area.setAttribute('style', snap.style); }
        else if (kind === 'data') applyDataOrder(area, snap.order);
        if (isActive(area)) armArea(area);
    }
    function applyDataOrder(area, order) {
        const expr = dataSourceExpr(area), tpl = area.querySelector('template[x-for]');
        try {
            const arr = window.Alpine.evaluate(tpl, expr); if (!Array.isArray(arr)) return;
            const byKey = new Map(arr.map(it => [String(it.id), it]));
            const next = order.map(k => byKey.get(String(k))).filter(Boolean);
            arr.forEach(it => { if (!order.map(String).includes(String(it.id))) next.push(it); });
            arr.splice(0, arr.length, ...next);
        } catch {}
    }

    /* ---- Component edits: per-node deltas, scoped instance vs main ----
       cmp-main applies to EVERY instance of the component; cmp-inst to one region.
       prop is 'text' or 'class'; REVERT (prop '*') clears a node's instance overrides. */
    function componentState() {
        const main = {}, inst = {}, reverts = {}, sigs = {};
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind === 'cmp-main' || d.kind === 'cmp-inst') if (d.sig) sigs[d.component + '|' + d.path] = d.sig;
            if (d.kind === 'cmp-main') { (main[d.component] = main[d.component] || {}); (main[d.component][d.path] = main[d.component][d.path] || {})[d.prop] = d.value; }
            else if (d.kind === 'cmp-inst') {
                const r = d.region;
                if (d.value === REVERT) {
                    reverts[r] = reverts[r] || new Set();
                    if (d.path === '*') { delete inst[r]; reverts[r] = new Set(['*']); }
                    else { if (inst[r]) delete inst[r][d.path]; reverts[r].add(d.path); }
                } else {
                    inst[r] = inst[r] || {}; (inst[r][d.path] = inst[r][d.path] || {})[d.prop] = d.value;
                    if (reverts[r]) { reverts[r].delete(d.path); reverts[r].delete('*'); }
                }
            }
        }
        return { main, inst, reverts, sigs };
    }
    function applyComponentState() {
        const { main, inst, sigs } = componentState();
        document.querySelectorAll('[data-edit-area]').forEach(area => {
            if (!area._edit || classify(area) !== 'component') return;
            const comp = componentName(area), region = key(area), root = area.querySelector('[data-component]'); if (!root) return;
            [root, ...root.querySelectorAll('[data-edit-path]')].forEach(el => {   // include the root (path '') — edits on the parent
                const p = el.getAttribute('data-edit-path');
                const expect = sigs[comp + '|' + p];
                if (expect && nodeSig(el) !== expect) { console.warn('[edit] skip stale node (structure changed):', comp, p); return; }
                const iv = (inst[region] && inst[region][p]) || {}, mv = (main[comp] && main[comp][p]) || {};
                const base = area._baseText || {}, baseC = area._baseClass || {}, baseS = area._baseStyle || {};
                const pick = (prop, fallback) => iv[prop] !== undefined ? iv[prop] : (mv[prop] !== undefined ? mv[prop] : fallback);
                const text = pick('text', base[p]), cls = pick('class', baseC[p]), sty = pick('style', baseS[p]);
                if (text !== undefined) { const safe = sanitizeFor(el, text); if (el.innerHTML !== safe) el.innerHTML = safe; }   // sanitize on apply (cloud overlays)
                if (cls !== undefined && el.getAttribute('class') !== cls) el.setAttribute('class', cls);
                if (sty !== undefined && el.getAttribute('style') !== sty) { if (sty === '') el.removeAttribute('style'); else el.setAttribute('style', sty); }
            });
        });
    }
    function commitComponentNode(area, el, prop, value) {
        const path = el.getAttribute('data-edit-path'), scope = area._editScope || 'instance', component = componentName(area), region = key(area);
        if (prop === 'text') value = sanitizeFor(el, value);   // sanitize contentEditable on capture
        const before = prop === 'text' ? el._preEdit : prop === 'style' ? el._preStyle : el._preClass;
        if (before === value) return;
        log.splice(cursor);
        const sig = nodeSig(el);
        log.push(scope === 'main' ? { kind: 'cmp-main', component, path, prop, value, before, sig } : { kind: 'cmp-inst', component, region, path, prop, value, before, sig });
        cursor = log.length; saveState(); applyComponentState(); refresh();
    }
    function revertNode(area, el) { log.splice(cursor); log.push({ kind: 'cmp-inst', component: componentName(area), region: key(area), path: el.getAttribute('data-edit-path'), prop: '*', value: REVERT }); cursor = log.length; saveState(); applyComponentState(); refresh(); }
    function revertAll(area) { log.splice(cursor); log.push({ kind: 'cmp-inst', component: componentName(area), region: key(area), path: '*', prop: '*', value: REVERT }); cursor = log.length; saveState(); applyComponentState(); refresh(); }

    /* ---- Static editing: per-node typed deltas (text/class/style) + reorder permutation.
       No whole-HTML snapshots — storage is O(edits), addresses not trees. ---- */
    // Ops fold up to the cursor; baselines come from the WHOLE log — the `before`
    // on the first delta that touched a prop is its authored value. That pairing is
    // what makes undo total: a prop with no surviving op is restored to baseline
    // instead of being left holding the edit. (applyThemeState works the same way.)
    function staticState() {
        const node = {}, order = {}, sigs = {}, base = {}, html = {};
        for (const d of log) {
            if (d.kind === 'st-children' && d.html) Object.assign(html[d.region] = html[d.region] || {}, d.html);
            if (d.kind !== 'st-node') continue;
            const bk = d.region + '|' + d.path;
            const b = base[bk] = base[bk] || {};
            if (!(d.prop in b)) b[d.prop] = d.before;
            if (d.sig) sigs[bk] = d.sig;
        }
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind === 'st-node') { (node[d.region] = node[d.region] || {}); (node[d.region][d.path] = node[d.region][d.path] || {})[d.prop] = d.value; }
            else if (d.kind === 'st-order' || d.kind === 'st-children') order[d.region] = d.order;
        }
        // The markup for anything added or removed comes from the WHOLE log, the same
        // way baselines do — undoing a delete has to be able to rebuild the element,
        // and the delta that knows its markup is no longer applied.
        return { node, order, sigs, base, html };
    }

    // A data area's own deltas carry only the id order, which can restore a sequence
    // but cannot resurrect a record — so adding and removing rows record the record
    // itself. In-session history only: what the array should hold is the app's to
    // persist, so these never travel to the source.
    function commitSplice(area, index, record, op) {
        log.splice(cursor);
        log.push({ kind: 'data-splice', region: key(area), source: dataSourceName(area), index, op, record: JSON.parse(JSON.stringify(record)) });
        cursor = log.length; saveState(); refresh();
        setTimeout(() => { lastSnap[key(area)] = snapshot(area, classify(area)); }, 0);
    }

    function applySplice(d, undo) {
        const area = areaByKey(d.region); if (!area) return;
        const tpl = area.querySelector('template[x-for]'), expr = dataSourceExpr(area);
        if (!tpl || !expr) return;
        let arr; try { arr = window.Alpine.evaluate(tpl, expr); } catch { return; }
        if (!Array.isArray(arr)) return;
        const inserting = undo ? d.op === 'remove' : d.op === 'insert';
        if (inserting) arr.splice(Math.min(d.index, arr.length), 0, JSON.parse(JSON.stringify(d.record)));
        else arr.splice(d.index, 1);
        setTimeout(() => { lastSnap[d.region] = snapshot(area, classify(area)); }, 0);
    }

    // Structural change to a container's children: duplicate, delete, paste. Stored
    // as the resulting key order plus the markup of whatever the log introduced or
    // took away, so it stays proportional to the edit rather than snapshotting.
    function commitStructure(area, markup) {
        const region = key(area), order = staticKeys(area), before = lastOrder[region] || area._baseOrder || order;
        if (eq(before, order) && !Object.keys(markup || {}).length) return;
        log.splice(cursor);
        log.push({ kind: 'st-children', region, order, before, html: markup || {} });
        cursor = log.length; lastOrder[region] = order; saveState(); refresh();
    }
    // Rebuilt markup carries no identity — blockHTML strips it so a duplicate cannot
    // inherit its original's. Stamp the key we are rebuilding it for, or the element
    // comes back nameless and the next fold drops it again.
    const materialize = (markup, k) => {
        if (!markup) return null;
        const t = document.createElement('template');
        t.innerHTML = markup.trim();
        const el = t.content.firstElementChild;
        if (el && k) el.setAttribute('data-edit-key', k);
        return el;
    };

    function applyStaticState() {
        const { node, order, sigs, base, html } = staticState();
        document.querySelectorAll('[data-edit-area]').forEach(area => {
            if (!area._edit || classify(area) !== 'static') return;
            const region = key(area);
            [area, ...area.querySelectorAll('[data-edit-key]')].forEach(el => {
                const p = el.getAttribute('data-edit-key'), bk = region + '|' + p;
                const ops = (node[region] || {})[p], baseline = base[bk];
                if (!ops && !baseline) return;
                const expect = sigs[bk]; if (expect && nodeSig(el) !== expect) { console.warn('[edit] skip stale static node', region, p); return; }
                const eff = (prop) => ops && ops[prop] !== undefined ? ops[prop] : baseline && baseline[prop];
                const setAttr = (name, v) => { if (v === undefined) return; if (v === '') el.removeAttribute(name); else if (el.getAttribute(name) !== v) el.setAttribute(name, v); };
                const text = eff('text'); if (text !== undefined) { const safe = sanitizeFor(el, text); if (el.innerHTML !== safe) el.innerHTML = safe; }
                setAttr('class', eff('class'));
                setAttr('style', eff('style'));
            });
            const want = order[region] || area._baseOrder;
            if (want) {
                const by = {}, kids = sortableChildren(area), keys = staticKeys(area);
                kids.forEach((el, i) => { by[keys[i]] = el; });
                const markup = html[region] || {};
                const next = want.map(kk => by[kk] || materialize(markup[kk], kk)).filter(Boolean);
                kids.forEach(el => { if (!next.includes(el)) el.remove(); });
                next.forEach(el => area.appendChild(el));
            }
        });
    }
    function commitStaticNode(area, el, prop, value) {
        const region = key(area), path = el.getAttribute('data-edit-key');
        if (!path) return;                          // not an addressable node
        if (prop === 'text') value = sanitizeFor(el, value);
        const before = prop === 'text' ? el._preEdit : prop === 'class' ? el._preClass : el._preStyle;
        if (before === value) return;
        log.splice(cursor); log.push({ kind: 'st-node', region, path, prop, value, before, sig: nodeSig(el) }); cursor = log.length; saveState(); refresh();
    }
    /* ---- Data VALUE editing (opt-in .values): edit $x record fields. Not an HTML edit —
       it mutates the data source. A-side: mutate the in-memory $x array (reactive).
       B-side: local file cell write (dev server); cloud → $x.<source>.$update(id,{field}). ---- */
    function dataValueState() {
        const s = {};
        for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'data-val') ((s[d.source] = s[d.source] || {})[d.id] = s[d.source][d.id] || {})[d.field] = d.value; }
        return s;
    }
    function applyDataValues() {
        const st = dataValueState();
        areas().forEach(area => {
            if (classify(area) !== 'data') return;
            const source = dataSourceName(area), recs = st[source]; if (!recs) return;
            const tpl = area.querySelector('template[x-for]'), expr = dataSourceExpr(area);
            try { const arr = window.Alpine.evaluate(tpl, expr); if (Array.isArray(arr)) Object.entries(recs).forEach(([id, fields]) => { const rec = arr.find(r => String(r.id) === String(id)); if (rec) Object.entries(fields).forEach(([f, v]) => { if (rec[f] !== v) rec[f] = v; }); }); } catch {}
            if (isActive(area)) setTimeout(() => armDataValues(area), 0);   // re-arm clones Alpine re-rendered
        });
    }
    function commitDataValue(area, source, id, field, value, el) {
        value = String(value);
        if (el && el.hasAttribute('data-edit-rich')) value = sanitizeFor(el, value);
        const before = el ? el._preEdit : undefined;
        if (before === value) return;
        log.splice(cursor); log.push({ kind: 'data-val', source, id, field, value, before }); cursor = log.length; saveState();
        applyDataValues(); refresh();
    }

    // size/move write an element's inline style → static: per-node style op; data: n/a.
    // Size/move land here. The data regime has nowhere to put per-row geometry —
    // the data source holds values, not layout — so it stays transient there.
    function commitStyle(area, el) {
        const v = el.getAttribute('style') || '', kind = classify(area);
        if (kind === 'component') commitComponentNode(area, el, 'style', v);
        else if (kind === 'static') commitStaticNode(area, el, 'style', v);
    }
    function commitStaticOrder(area) {
        const region = key(area), order = staticKeys(area), before = lastOrder[region] || order;
        if (eq(before, order)) return;
        log.splice(cursor); log.push({ kind: 'st-order', region, order, before }); cursor = log.length; lastOrder[region] = order; saveState(); refresh();
    }

    /* ---- Commit / undo / redo (data area snapshots) ---- */
    function commit(area) {
        if (!area) return;
        const k = key(area), kind = classify(area), after = snapshot(area, kind), before = lastSnap[k];
        if (before && eq(before, after)) return;
        log.splice(cursor); log.push({ region: k, kind, before: before ?? after, after });
        cursor = log.length; lastSnap[k] = after; saveState(); refresh();
    }
    const dispatchApply = (d) => { if (d.kind === 'cmp-main' || d.kind === 'cmp-inst') applyComponentState(); else if (d.kind === 'data-val') applyDataValues(); else if (d.kind === 'theme') applyThemeState(); else applyStaticState(); };
    async function undo() {
        if (cursor === 0) return; const d = log[--cursor];
        if (d.kind === 'data-splice') applySplice(d, true);
        else if (d.kind === 'data') { await applySnap(areaByKey(d.region), d.kind, d.before); lastSnap[d.region] = d.before; }
        else dispatchApply(d);
        saveState(); refresh();
    }
    async function redo() {
        if (cursor >= log.length) return; const d = log[cursor++];
        if (d.kind === 'data-splice') applySplice(d, false);
        else if (d.kind === 'data') { await applySnap(areaByKey(d.region), d.kind, d.after); lastSnap[d.region] = d.after; }
        else dispatchApply(d);
        saveState(); refresh();
    }

    /* ---- Projections (static/data); component projections come from componentState() ---- */
    function fold() { const s = {}; for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'static' || d.kind === 'data') s[d.region] = { kind: d.kind, snap: d.after }; } return s; }
    function patchFor(r, kind, snap) {
        if (kind === 'static') return { region: r, kind, op: 'writeHTML', target: `[x-edit="${r}"]`, html: snap.html, style: snap.style, note: 'static/style/size/move fold into the source HTML.' };
        return { region: r, kind, op: 'reorderData', source: snap.source, order: snap.order, note: `data mutation: $x.${snap.source}.$update(id,{order}).` };
    }


    /* ---- Block operations: copy, cut, paste, duplicate, delete ----
       Structural edits on a sortable child. The plugin performs them and logs them;
       it renders no menu, because what a context menu looks like belongs to the
       project. What it offers instead is enough to build one: an `edit:context`
       event carrying the block and where the pointer was, $edit.target for the block
       in play, and $edit.can(op) so a menu can disable what would not apply. */
    let clipboard = null;                       // { html, source } — the plugin's own, not the OS clipboard
    let target = null;                          // the block a menu is acting on

    // A menu binds :disabled to can(), so what can() depends on has to be trackable.
    // The target and the clipboard are plain values, so changes to them are announced
    // through a counter on the store, which is reactive.
    const bump = () => { if (estore) estore.targetVersion = (estore.targetVersion || 0) + 1; };
    const setTarget = (el) => { target = el; bump(); };

    // The addressable block for a node: the sortable child that contains it, or —
    // where the region is not sortable at all — the outermost element inside the area
    // that contains it. Deleting a heading should not require the region to have been
    // declared reorderable.
    function blockOf(node) {
        const area = node && node.closest && node.closest('[data-edit-area]');
        if (!area) return null;
        const sortable = node.closest('[data-edit-sortable]');
        if (sortable && sortable.closest('[data-edit-area]') === area) return sortable;
        let el = node;
        while (el && el.parentElement && el.parentElement !== area) el = el.parentElement;
        return el && el.parentElement === area ? el : null;
    }

    const blockArea = (el) => el && el.closest('[data-edit-area]');

    // Markup without the plugin's own affordances, so a duplicate re-arms cleanly
    // rather than inheriting half-initialised state from its original.
    function blockHTML(el) {
        const c = el.cloneNode(true);
        c.querySelectorAll('[data-edit-handle], [data-edit-live], [data-edit-ghost]').forEach(n => n.remove());
        [c, ...c.querySelectorAll('*')].forEach(n => {
            [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-')) n.removeAttribute(a.name); });
            ['contenteditable', 'draggable', 'tabindex', 'role', 'aria-label'].forEach(a => n.removeAttribute(a));
        });
        return c.outerHTML;
    }

    /* ---- Data regime: the array is the truth, so operate on it ---- */
    function dataOps(area) {
        const tpl = area.querySelector('template[x-for]'), expr = dataSourceExpr(area);
        if (!tpl || !expr) return null;
        try {
            const arr = window.Alpine.evaluate(tpl, expr);
            return Array.isArray(arr) ? arr : null;
        } catch { return null; }
    }

    const recordIndex = (area, el) => {
        const arr = dataOps(area); if (!arr) return -1;
        const k = itemKey(el, area);
        return arr.findIndex(it => String(it && it.id != null ? it.id : it) === String(k));
    };

    // A copy needs its own identity or the list has two rows claiming one key.
    function freshId(arr, id) {
        const taken = new Set(arr.map(it => String(it && it.id)));
        if (!taken.has(String(id))) return String(id);
        let n = 2, next = `${id}-copy`;
        while (taken.has(next)) next = `${id}-copy-${n++}`;
        return next;
    }

    /* ---- Operations ---- */
    function canDo(op, el) {
        const block = el || target;
        if (op === 'paste') return !!clipboard && !!(block ? blockArea(block) : areas().find(isActive));
        if (!block || locked(block)) return false;
        const area = blockArea(block);
        if (!area || !isActive(area)) return false;
        if (classify(area) === 'component') return false;          // instances are overridden, not restructured
        return true;
    }

    function copyBlock(el) {
        const block = el || target; if (!block) return false;
        clipboard = { html: blockHTML(block), source: key(blockArea(block)) };
        bump();
        return true;
    }

    function duplicateBlock(el) {
        const block = el || target; if (!canDo('duplicate', block)) return false;
        const area = blockArea(block);
        if (classify(area) === 'data') {
            const arr = dataOps(area), i = recordIndex(area, block);
            if (!arr || i < 0) return false;
            const copy = JSON.parse(JSON.stringify(arr[i]));
            if (copy && copy.id != null) copy.id = freshId(arr, copy.id);
            arr.splice(i + 1, 0, copy);
            commitSplice(area, i + 1, copy, 'insert');
            return true;
        }
        const made = materialize(blockHTML(block));
        if (!made) return false;
        block.after(made);
        armArea(area);                                             // the copy needs its own affordances
        commitStructure(area, { [staticKeys(area)[sortableChildren(area).indexOf(made)]]: blockHTML(made) });
        return true;
    }

    function removeBlock(el) {
        const block = el || target; if (!canDo('remove', block)) return false;
        const area = blockArea(block);
        if (classify(area) === 'data') {
            const arr = dataOps(area), i = recordIndex(area, block);
            if (!arr || i < 0) return false;
            const gone = arr[i];
            arr.splice(i, 1);
            commitSplice(area, i, gone, 'remove');
            return true;
        }
        const keys = staticKeys(area), gone = keys[sortableChildren(area).indexOf(block)];
        const markup = blockHTML(block);
        block.remove();
        if (target === block) setTarget(null);
        commitStructure(area, { [gone]: markup });                 // keep the markup so undo can rebuild it
        return true;
    }

    const cutBlock = (el) => copyBlock(el) && removeBlock(el);

    function pasteBlock(el) {
        if (!clipboard) return false;
        const block = el || target;
        const area = blockArea(block) || areas().find(isActive);
        if (!area || !isActive(area)) return false;
        if (classify(area) === 'data') {
            const arr = dataOps(area); if (!arr) return false;
            const at = block ? recordIndex(area, block) + 1 : arr.length;
            const t = document.createElement('template'); t.innerHTML = clipboard.html;
            const record = { id: freshId(arr, 'pasted'), label: (t.content.textContent || '').trim() };
            arr.splice(at, 0, record);
            commitSplice(area, at, record, 'insert');
            return true;
        }
        const made = materialize(clipboard.html); if (!made) return false;
        if (block) block.after(made); else area.appendChild(made);
        armArea(area);
        commitStructure(area, { [staticKeys(area)[sortableChildren(area).indexOf(made)]]: blockHTML(made) });
        return true;
    }

    /* ---- Wiring ----
       Hotkeys ride the focused block, which reorder already gives a tabindex. They
       stay out of the way of text: nothing fires while a caret is in a field, so
       Cmd+C inside a paragraph still copies the words. */
    const inText = (e) => e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

    function onBlockKey(e) {
        if (inText(e)) return;
        const block = blockOf(e.target); if (!block) return;
        const area = blockArea(block); if (!isActive(area)) return;
        const meta = e.metaKey || e.ctrlKey;
        let done = false;
        if (meta && e.key.toLowerCase() === 'c') done = copyBlock(block);
        else if (meta && e.key.toLowerCase() === 'x') done = cutBlock(block);
        else if (meta && e.key.toLowerCase() === 'v') done = pasteBlock(block);
        else if (meta && e.key.toLowerCase() === 'd') done = duplicateBlock(block);
        else if (!meta && (e.key === 'Delete' || e.key === 'Backspace')) done = removeBlock(block);
        if (done) { e.preventDefault(); e.stopPropagation(); }
    }

    /* ---- Right-click ----
       The event waits for the pointer to come up. A popover opened while the button
       is still down is closed again by the release that follows it — the browser's
       light dismiss decides on pointerup, and by then the menu was not yet open when
       the press was recorded. Firing after the release is the only way a menu opened
       in the handler survives. The context-menu key sends no release, so a short
       timer covers it. */
    let pendingContext = null;

    function onBlockContext(e, builtIn) {
        const area = blockArea(e.target);
        if (!area || !isActive(area)) return false;
        const block = blockOf(e.target);
        if (!block) return false;                                  // off-block: leave the native menu alone
        setTarget(block);
        e.preventDefault();

        const fire = () => {
            clearTimeout(pendingContext); pendingContext = null;
            document.removeEventListener('pointerup', fire, true);
            const detail = { target: block, area, x: e.clientX, y: e.clientY, can: (op) => canDo(op, block) };
            const ev = new CustomEvent('edit:context', { bubbles: true, cancelable: true, detail });
            if (area.dispatchEvent(ev) && builtIn) builtIn();       // nobody took it
        };
        document.addEventListener('pointerup', fire, true);
        pendingContext = setTimeout(fire, 300);
        return true;
    }

    const blockTarget = () => target;
    const setBlockTarget = (el) => setTarget(el && el.nodeType === 1 ? blockOf(el) || el : null);


    /* ---- Drag: reorder (in-flow, pointer+keyboard) OR move (positioned) ----
       Pointer-based so it works with mouse, touch, and pen (HTML5 DnD was mouse-only).
       Keyboard: focus an item, Space/Enter to grab, arrows to move, Enter/Esc to drop/cancel. */
    const isPositioned = (el) => { const p = getComputedStyle(el).position; return p === 'absolute' || p === 'fixed'; };
    let grabbed = null, liveRegion;
    function announce(msg) { if (!liveRegion) { liveRegion = document.createElement('div'); liveRegion.setAttribute('data-edit-live', ''); liveRegion.setAttribute('aria-live', 'polite'); document.body.appendChild(liveRegion); } liveRegion.textContent = msg; }

    function makeSortable(container) {
        sortableChildren(container).forEach(child => {
            if (locked(child)) return;
            if (isPositioned(child)) { if (!child._dragBound) { child._dragBound = true; makeMovable(child); } return; }
            child.setAttribute('data-edit-sortable', ''); child.tabIndex = 0; child.setAttribute('role', 'listitem');
            if (child._dragBound) return; child._dragBound = true;
            child.addEventListener('pointerdown', onPointerDown);
            child.addEventListener('keydown', onItemKeydown);
            child.addEventListener('keydown', onBlockKey);
        });
        container.setAttribute('role', 'list');
        // x-for rows and any other late arrivals are not sortable unless we notice
        // them — arming only ever ran once, so a list that grows loses its handles.
        if (!container._sortObserver) {
            container._sortObserver = new MutationObserver(() => {
                if (dragged) return;                        // never re-arm mid-drag
                if (isActive(container.closest('[data-edit-area]'))) makeSortable(container);
            });
            container._sortObserver.observe(container, { childList: true });
        }
    }
    function onPointerDown(e) {
        const item = this, area = item.closest('[data-edit-area]');
        if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0)) return;
        if (e.target.isContentEditable || e.target.hasAttribute('data-edit-handle')) return;   // text/size win
        const container = item.parentElement;
        const homeNext = item.nextElementSibling;          // where to put it back if cancelled
        const start = item.getBoundingClientRect();
        const preStyle = item.getAttribute('style');
        const grabX = e.clientX - start.left, grabY = e.clientY - start.top;
        const sx = e.clientX, sy = e.clientY;
        let active = false, frame = 0, px = sx, py = sy, ghost = null;

        // The item leaves the flow and a stand-in takes its slot, so the gap that
        // opens is a real element the author can style — by default a translucent
        // copy of what is being dragged, showing exactly where it would land.
        const lift = (ev) => {
            ghost = item.cloneNode(true);
            ghost.setAttribute('data-edit-ghost', '');
            ghost.setAttribute('x-ignore', '');            // a clone must not re-bind
            ghost.removeAttribute('id');
            ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
            [ghost, ...ghost.querySelectorAll('*')].forEach(n => {
                [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-') && a.name !== 'data-edit-ghost') n.removeAttribute(a.name); });
                n.removeAttribute('contenteditable'); n.removeAttribute('tabindex'); n.removeAttribute('draggable');
            });
            item.before(ghost);
            item.style.position = 'fixed';
            item.style.width = start.width + 'px';
            item.style.height = start.height + 'px';
            item.style.margin = '0';
            item.style.pointerEvents = 'none';
            item.setAttribute('data-edit-dragging', '');
            area.setAttribute('data-edit-dragging-in', '');
            dragged = ghost;
            try { item.setPointerCapture(ev.pointerId); } catch { }
        };

        const paint = () => {
            frame = 0;
            item.style.left = (px - grabX) + 'px';
            item.style.top = (py - grabY) + 'px';
        };

        const onMove = (ev) => {
            px = ev.clientX; py = ev.clientY;
            if (!active) {
                if (Math.hypot(px - sx, py - sy) < 5) return;   // threshold so taps/clicks still work
                active = true; lift(ev); paint();
            }
            ev.preventDefault();
            reorderOver(container, px, py);
            if (!frame) frame = requestAnimationFrame(paint);
        };

        const settle = (cancelled) => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('keydown', onKey, true);
            if (frame) cancelAnimationFrame(frame);
            if (!active) return;
            if (cancelled) {
                ghost.remove();
                if (homeNext) container.insertBefore(item, homeNext); else container.appendChild(item);
            } else ghost.replaceWith(item);
            if (preStyle == null) item.removeAttribute('style'); else item.setAttribute('style', preStyle);
            item.removeAttribute('data-edit-dragging');
            area.removeAttribute('data-edit-dragging-in');
            ghost = null; dragged = null;
            if (cancelled) announce('Cancelled'); else finishReorder(area);
        };
        const onUp = () => settle(false);
        // Escape puts it back, the way every drag is expected to be escapable.
        const onKey = (ev) => { if (ev.key !== 'Escape') return; ev.preventDefault(); ev.stopPropagation(); settle(true); };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('keydown', onKey, true);
    }
    function reorderOver(container, x, y) {
        if (!dragged || dragged.parentElement !== container) return;
        const ref = afterElement(container, x, y);
        if (ref === dragged || ref === dragged.nextElementSibling) return;
        if (ref == null) container.appendChild(dragged); else container.insertBefore(dragged, ref);
    }
    function finishReorder(area) { if (classify(area) === 'data') { applyDataOrder(area, sortableChildren(area).map(c => itemKey(c, area))); commit(area); } else commitStaticOrder(area); }
    // Reading-order insertion: block, inline, flex row/col/wrap, grid auto-flow.
    // The FIRST sibling past the pointer, not the nearest — nearest can pick an
    // element further down the list and makes the drop point jump around. Taking the
    // first is also self-stabilising: once the item lands, that sibling's midpoint is
    // behind the pointer, so it does not immediately swap back.
    function afterElement(c, x, y) {
        for (const el of sortableChildren(c)) {
            if (el === dragged || locked(el) || el.hasAttribute('data-edit-dragging')) continue;
            const b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
            const sameRow = Math.abs(cy - y) <= b.height / 2;
            if (cy - y > b.height / 2 || (sameRow && cx > x)) return el;
        }
        return null;
    }
    // Keyboard reorder: grab → arrows move among siblings → drop.
    function onItemKeydown(e) {
        const item = this, area = item.closest('[data-edit-area]'); if (!isActive(area)) return;
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (grabbed === item) { grabbed = null; item.removeAttribute('data-edit-grabbed'); finishReorder(area); item.focus(); announce('Dropped'); }
            else { if (grabbed) grabbed.removeAttribute('data-edit-grabbed'); grabbed = item; item.setAttribute('data-edit-grabbed', ''); announce('Grabbed — arrow keys to move, Enter to drop'); }
            return;
        }
        if (grabbed !== item) return;
        if (e.key === 'Escape') { e.preventDefault(); grabbed = null; item.removeAttribute('data-edit-grabbed'); item.focus(); announce('Cancelled'); return; }
        const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
        if (dir == null) return;
        e.preventDefault();
        const sibs = sortableChildren(item.parentElement).filter(c => !locked(c)), i = sibs.indexOf(item), j = i + dir;
        if (j < 0 || j >= sibs.length) return;
        if (dir > 0) sibs[j].after(item); else sibs[j].before(item);
        item.focus(); announce(`Position ${j + 1} of ${sibs.length}`);
    }
    // Move mode: positioned elements → pointer-drag left/top (touch-capable) + keyboard nudge, unit-preserving.
    function makeMovable(el) {
        el.setAttribute('data-edit-movable', ''); el.tabIndex = 0; el.setAttribute('role', 'application'); el.setAttribute('aria-label', 'Draggable; arrow keys to move');
        el.addEventListener('pointerdown', (e) => {
            const area = el.closest('[data-edit-area]');
            if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0) || e.target.isContentEditable || e.target.hasAttribute('data-edit-handle')) return;
            e.preventDefault(); el._preStyle = el.getAttribute('style') || '';
            const cs = getComputedStyle(el), parent = el.offsetParent || el.parentElement;
            const lu = unitOf(el.style.left) || 'px', tu = unitOf(el.style.top) || 'px';
            const baseL = parseFloat(cs.left) || 0, baseT = parseFloat(cs.top) || 0, sx = e.clientX, sy = e.clientY;
            const ov = showOverlay();
            const move = (ev) => { ev.preventDefault(); el.style.left = toUnit(baseL + (ev.clientX - sx), lu, el, parent, 'w') + lu; el.style.top = toUnit(baseT + (ev.clientY - sy), tu, el, parent, 'h') + tu; };
            const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); hideOverlay(ov); commitStyle(area, el); };
            document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
        });
        el.addEventListener('keydown', (e) => {
            const area = el.closest('[data-edit-area]'); if (!isActive(area)) return;
            const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!d) return;
            e.preventDefault();
            if (!el._moveTimer) el._preStyle = el.getAttribute('style') || '';   // baseline at start of a key burst
            const step = e.shiftKey ? 16 : 4, cs = getComputedStyle(el), parent = el.offsetParent || el.parentElement;
            const lu = unitOf(el.style.left) || 'px', tu = unitOf(el.style.top) || 'px';
            if (d[0]) el.style.left = toUnit((parseFloat(cs.left) || 0) + d[0] * step, lu, el, parent, 'w') + lu;
            if (d[1]) el.style.top = toUnit((parseFloat(cs.top) || 0) + d[1] * step, tu, el, parent, 'h') + tu;
            clearTimeout(el._moveTimer); el._moveTimer = setTimeout(() => { el._moveTimer = null; commitStyle(area, el); }, 350);
        });
    }


    /* ---- Size: drag handles → unit-preserving width/height (folded-in resize) ----
       CSS-var config (cascades by selector, keeps the directive tight):
         --edit-size              both | x | y | none           which axes (default both)
         --edit-size-edges        e.g. "right bottom-right"      explicit handle list (logical start/end ok)
         --edit-size-handle       1rem                           handle hit area
         --edit-size-snap         12rem 24rem                    snap stops (both axes)
         --edit-size-snap-x/-y    per-axis stop overrides
         --edit-size-snap-distance  1rem                         magnet tolerance (NOT a grid step)
         --edit-size-snap-distance-x/-y  per-axis tolerance
         --edit-size-collapse-x/-y  120px                        collapse below this → [data-edit-collapsed] + 'edit:collapse' event
       (min/max come from the element's native min-/max-width/height.) */
    let overlayEl;
    // Fires while dragging (done:false) and once on commit (done:true), so consumers
    // that must re-measure — charts, virtual lists — can track the drag and settle.
    function sizeEvent(el, done) {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new CustomEvent('edit:size', {
            bubbles: true,
            detail: { width: r.width, height: r.height, css: { width: el.style.width, height: el.style.height }, collapsed: el.hasAttribute('data-edit-collapsed'), done }
        }));
    }
    function showOverlay() { if (!overlayEl) { overlayEl = document.createElement('div'); overlayEl.setAttribute('data-edit-overlay', ''); document.body.appendChild(overlayEl); } overlayEl.style.display = 'block'; return overlayEl; }
    function hideOverlay() { if (overlayEl) overlayEl.style.display = 'none'; }

    const isRTL = (el) => getComputedStyle(el).direction === 'rtl';
    // Resolve logical start/end to physical left/right per the element's direction.
    function physical(pos, el) {
        const rtl = isRTL(el);
        return pos.replace(/start/g, rtl ? 'right' : 'left').replace(/end/g, rtl ? 'left' : 'right');
    }
    const defaultEdges = (axes) => axes === 'x' ? ['left', 'right'] : axes === 'y' ? ['top', 'bottom'] : ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

    function armSize(el) {
        const axes = cssVar(el, '--edit-size', 'both');
        if (axes === 'none') return;
        if (el._sizeBound) return; el._sizeBound = true;
        el.setAttribute('data-edit-sizable', '');
        // Anchor guard: handles are positioned against this element, so it must establish a
        // containing block. The CSS sets position:relative via :where() (overridable); if an
        // author's CSS won and left it static, set it here so handles never detach.
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        const edges = (cssVar(el, '--edit-size-edges', '').trim() || defaultEdges(axes).join(' ')).split(/\s+/).filter(Boolean);
        edges.forEach(pos => {
            const phys = physical(pos, el);                  // keep logical class for CSS; resolve to physical for behavior
            const h = document.createElement('span');
            h.setAttribute('data-edit-handle', pos);      // logical value drives the CSS; `phys` drives behaviour
            h.tabIndex = 0; h.setAttribute('role', 'slider'); h.setAttribute('aria-label', `Resize ${pos}`);
            h.addEventListener('pointerdown', (e) => startSize(e, el, phys));
            h.addEventListener('keydown', (e) => keyResize(e, el, phys));
            el.appendChild(h);
        });
    }
    // Keyboard a11y: focus a handle, arrow keys resize (Shift = larger step), debounced commit.
    let _keyTimer;
    function keyResize(e, el, pos) {
        const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!map[e.key]) return;
        const area = el.closest('[data-edit-area]'); if (!isActive(area)) return;
        e.preventDefault();
        if (!_keyTimer) el._preStyle = el.getAttribute('style') || '';   // baseline at start of a key burst
        const [kx, ky] = map[e.key], step = e.shiftKey ? 32 : 8, cs = getComputedStyle(el);
        const right = pos.includes('right'), left = pos.includes('left'), top = pos.includes('top'), bottom = pos.includes('bottom');
        const wu = unitOf(el.style.width) || 'px', hu = unitOf(el.style.height) || 'px';
        const minW = parseFloat(cs.minWidth) || 0, maxW = parseFloat(cs.maxWidth) || Infinity, minH = parseFloat(cs.minHeight) || 0, maxH = parseFloat(cs.maxHeight) || Infinity;
        if ((right || left) && kx) { const w = clamp((parseFloat(cs.width) || 0) + kx * step * (right ? 1 : -1), minW, maxW); el.style.width = toUnit(w, wu, el, el.parentElement, 'w') + wu; }
        if ((top || bottom) && ky) { const h = clamp((parseFloat(cs.height) || 0) + ky * step * (bottom ? 1 : -1), minH, maxH); el.style.height = toUnit(h, hu, el, el.parentElement, 'h') + hu; }
        sizeEvent(el, false);
        clearTimeout(_keyTimer); _keyTimer = setTimeout(() => { _keyTimer = null; commitStyle(area, el); sizeEvent(el, true); }, 350);   // coalesce key bursts into one delta
    }
    function snapStops(el, axisVar, dim) {
        const list = cssVar(el, axisVar, '') || cssVar(el, '--edit-size-snap', '');
        return list.split(/\s+/).filter(Boolean).map(s => toPx(s, el, dim)).filter(v => v != null);
    }
    function startSize(e, el, pos) {
        const area = el.closest('[data-edit-area]');
        if (!isActive(area) || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); el._preStyle = el.getAttribute('style') || '';
        const cs = getComputedStyle(el), rect = el.getBoundingClientRect();
        const wu = unitOf(el.style.width) || 'px', hu = unitOf(el.style.height) || 'px';
        const baseW = parseFloat(cs.width) || rect.width, baseH = parseFloat(cs.height) || rect.height, sx = e.clientX, sy = e.clientY;
        const minW = parseFloat(cs.minWidth) || 0, maxW = parseFloat(cs.maxWidth) || Infinity;
        const minH = parseFloat(cs.minHeight) || 0, maxH = parseFloat(cs.maxHeight) || Infinity;
        const right = pos.includes('right'), left = pos.includes('left'), bottom = pos.includes('bottom'), top = pos.includes('top');
        const tolX = toPx(cssVar(el, '--edit-size-snap-distance-x', '') || cssVar(el, '--edit-size-snap-distance', '0'), el, 'w') || 0;
        const tolY = toPx(cssVar(el, '--edit-size-snap-distance-y', '') || cssVar(el, '--edit-size-snap-distance', '0'), el, 'h') || 0;
        const snapW = snapStops(el, '--edit-size-snap-x', 'w'), snapH = snapStops(el, '--edit-size-snap-y', 'h');
        const collapseX = toPx(cssVar(el, '--edit-size-collapse-x', ''), el, 'w');
        const collapseY = toPx(cssVar(el, '--edit-size-collapse-y', ''), el, 'h');
        const snap = (v, pts, tol) => { if (!tol) return v; for (const p of pts) if (Math.abs(v - p) <= tol) return p; return v; };
        const ov = showOverlay();
        let lastW = baseW, lastH = baseH;
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (right || left) { lastW = snap(clamp(baseW + (right ? dx : -dx), minW, maxW), snapW, tolX); el.style.width = toUnit(lastW, wu, el, el.parentElement, 'w') + wu; }
            if (top || bottom) { lastH = snap(clamp(baseH + (bottom ? dy : -dy), minH, maxH), snapH, tolY); el.style.height = toUnit(lastH, hu, el, el.parentElement, 'h') + hu; }
            const collapsed = (collapseX != null && lastW < collapseX) || (collapseY != null && lastH < collapseY);
            el.toggleAttribute('data-edit-collapsed', collapsed);
            sizeEvent(el, false);
        };
        const up = () => {
            document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); hideOverlay(ov);
            if (el.hasAttribute('data-edit-collapsed')) el.dispatchEvent(new CustomEvent('edit:collapse', { bubbles: true }));
            commitStyle(area, el); sizeEvent(el, true);
        };
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    }


    /* ---- Inline text editing ---- */
    // Where x-text-edit is declared, it owns the element: this plugin neither makes
    // its leaves contenteditable nor competes for the caret. If the rich editor has
    // no expression of its own, we capture what it produces as an ordinary text
    // delta, so a rich field inside a page-editing region publishes like any other.
    function armRichText(area) {
        area.querySelectorAll('[data-text-edit]:not([data-text-edit-bound])').forEach(el => {
            if (!capOf(el, 'text') || locked(el)) return;
            if (el._richBound) return; el._richBound = true;
            el.addEventListener('focusin', () => { el._preEdit = el.innerHTML.trim(); });
            el.addEventListener('blur', () => {
                const commit = classify(area) === 'component' ? commitComponentNode : commitStaticNode;
                commit(area, el, 'text', el.innerHTML.trim());
            }, true);
        });
    }

    // STATIC: literal leaves only (skip bound nodes; those belong to data/component).
    function armText(area) {
        armRichText(area);
        area.querySelectorAll('*').forEach(el => {
            if (el.children.length || !el.textContent.trim() || el.closest('template') || el.hasAttribute('data-edit-handle')) return;
            if (el.closest('[data-text-edit]')) return;                 // the rich editor owns this subtree
            if (!capOf(el, 'text') || el.hasAttribute('x-text') || el.hasAttribute('x-html')) return;
            el.setAttribute('contenteditable', 'true');
            if (el._textBound) return; el._textBound = true;
            el.addEventListener('focus', () => { el._preEdit = el.innerHTML.trim(); const d = el.closest('[draggable="true"]'); if (d) d.setAttribute('draggable', 'false'); });
            el.addEventListener('blur', () => { const d = el.closest('[data-edit-area] [draggable="false"]'); if (d) d.setAttribute('draggable', 'true'); commitStaticNode(area, el, 'text', el.innerHTML.trim()); });
        });
    }

    /* ---- DATA value editing (opt-in .data): make $x-bound leaves in an x-for list editable,
       but ONLY when the binding is a SIMPLE field ref of the loop var (p.name) — computed
       expressions (e.g. '$' + p.price) stay read-only. Edit → data mutation, not HTML.
       (Scope today: x-for list item fields. Direct $x.a.b bindings outside a list are a
       natural extension — different addressing {source,path} + key-value write-back.) ---- */
    function armDataValues(area) {
        const tpl = area.querySelector('template[x-for]'); if (!tpl) return;
        const lv = (tpl.getAttribute('x-for').match(/^\s*([\w$]+)\s+in\b/) || [])[1]; if (!lv) return;
        const source = dataSourceName(area), fieldRe = new RegExp('^\\s*' + lv + '\\.([\\w$]+)\\s*$');
        sortableChildren(area).forEach(clone => {
            const id = clone.getAttribute('data-key'); if (id == null) return;
            clone.querySelectorAll('*').forEach(el => {
                if (el.children.length || el.hasAttribute('data-edit-handle')) return;
                const rich = el.hasAttribute('x-html');
                const expr = el.getAttribute('x-text') || el.getAttribute('x-html'); if (!expr) return;
                const m = expr.match(fieldRe); if (!m) return;
                const field = m[1];
                el.setAttribute('data-edit-field', field);
                // A field bound with x-html can hold markup, so it is styleable like
                // any other text — the value simply carries the tags. Bound with
                // x-text it cannot, and offering the controls there would write
                // markup the binding renders as literal characters. The author's
                // choice of binding is the whole distinction.
                el.toggleAttribute('data-edit-rich', rich);
                // The rich editor owns the caret where it is present.
                if (!el.hasAttribute('data-text-edit')) el.setAttribute('contenteditable', 'true');
                if (el._dvBound) return; el._dvBound = true;
                const read = () => rich ? el.innerHTML.trim() : el.textContent;
                el.addEventListener('focus', () => { el._preEdit = read(); });
                el.addEventListener('focusin', () => { el._preEdit = read(); });
                el.addEventListener('blur', () => commitDataValue(area, source, id, field, read(), el), true);
            });
        });
    }

    /* ---- COMPONENT editing: text leaves addressed by structural path. Right-click an
       instance for the scope (this instance vs all) + per-element classes + revert. ---- */
    const componentName = (area) => { const r = area.querySelector('[data-component]'); return (r?.getAttribute('data-component') || '').replace(/-\d+$/, ''); };
    function pathOf(node, root) { const idx = []; let n = node; while (n && n !== root && n.parentElement) { idx.unshift(Array.from(n.parentElement.children).indexOf(n)); n = n.parentElement; } return idx.join('.'); }
    function nodeByPath(root, path) { let el = root; for (const i of path.split('.').map(Number)) { el = el.children[i]; if (!el) return null; } return el; }
    // While editing in 'All' scope, mirror the edit to every OTHER instance live — but
    // skip the source element (don't fight the caret) and skip any instance that has its
    // OWN committed override for this node/prop (instance overrides always win).
    function liveMainPropagate(area, sourceEl, prop, value) {
        if ((area._editScope || 'instance') !== 'main') return;
        const comp = componentName(area), path = sourceEl.getAttribute('data-edit-path'), { inst } = componentState();
        document.querySelectorAll('[data-edit-area]').forEach(a => {
            if (!a._edit || classify(a) !== 'component' || componentName(a) !== comp) return;
            const root = a.querySelector('[data-component]'); if (!root) return;
            const el = path === '' ? root : nodeByPath(root, path); if (!el || el === sourceEl) return;
            const iv = (inst[key(a)] && inst[key(a)][path]) || {}; if (iv[prop] !== undefined) return;   // override wins
            if (prop === 'class') { if (el.getAttribute('class') !== value) el.setAttribute('class', value); }
            else if (el.innerHTML !== value) el.innerHTML = value;
        });
    }
    function armComponent(area) {
        const root = area.querySelector('[data-component]'); if (!root) return;
        if (!area._editScope) { area._editScope = 'instance'; area.setAttribute('data-edit-scope', 'instance'); }
        area._baseText = area._baseText || {}; area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {};
        // Mark the root AND every element with a path → all are class-editable (incl. the parent).
        const markClass = (el) => { const p = pathOf(el, root); el.setAttribute('data-edit-path', p); if (!(p in area._baseClass)) area._baseClass[p] = el.getAttribute('class') || ''; if (!(p in area._baseStyle)) area._baseStyle[p] = el.getAttribute('style') || ''; };
        markClass(root);
        root.querySelectorAll('*').forEach(el => { if (!el.hasAttribute('data-edit-handle')) markClass(el); });
        // Text leaves also become contenteditable. Capture innerHTML (not textContent) so
        // nested inline elements like <i>/<br> the user adds are preserved.
        armRichText(area);
        root.querySelectorAll('[data-edit-path]').forEach(el => {
            if (el.children.length || !el.textContent.trim() || !capOf(el, 'text')) return;
            if (el.closest('[data-text-edit]')) return;                 // the rich editor owns this subtree
            const p = el.getAttribute('data-edit-path');
            if (!(p in area._baseText)) area._baseText[p] = el.innerHTML.trim();
            el.setAttribute('contenteditable', 'true');
            if (el._textBound) return; el._textBound = true;
            el.addEventListener('focus', () => { el._preEdit = el.innerHTML.trim(); });
            el.addEventListener('input', () => liveMainPropagate(area, el, 'text', el.innerHTML));
            el.addEventListener('blur', () => commitComponentNode(area, el, 'text', el.innerHTML.trim()));
        });
    }
    let cmpMenu;
    function openComponentMenu(e, area) {
        if (!isActive(area)) return; e.preventDefault(); e.stopPropagation();
        const target = e.target.closest('[data-edit-path]');
        if (!cmpMenu) {
            cmpMenu = document.createElement('div'); cmpMenu.setAttribute('data-edit-menu', ''); cmpMenu.setAttribute('popover', 'manual');
            cmpMenu.addEventListener('pointerdown', ev => ev.stopPropagation());
            document.body.appendChild(cmpMenu);
            document.addEventListener('pointerdown', () => { if (cmpMenu && cmpMenu.matches(':popover-open')) cmpMenu.hidePopover(); });
        }
        if (target) target._preClass = target.getAttribute('class') || '';
        const cur = area._editScope || 'instance';
        cmpMenu.innerHTML =
            `<small>Scope · ${componentName(area)}</small>`
            + `<div class="row"><button class="ghost sm" data-s="instance">${cur === 'instance' ? '✓ ' : ''}This instance</button><button class="ghost sm" data-s="main">${cur === 'main' ? '✓ ' : ''}All</button></div>`
            + (target ? `<small>Classes · ${target.tagName.toLowerCase()} · live</small><input type="text" spellcheck="false" data-cls>` : '')
            + `<div class="row">${target ? '<button class="ghost sm" data-a="revert">Revert element</button>' : ''}<button class="ghost sm" data-a="revertall">Revert all</button></div>`;
        cmpMenu.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { area._editScope = b.getAttribute('data-s'); area.setAttribute('data-edit-scope', area._editScope); area.setAttribute('data-edit-label', `${key(area)} · component · ${area._editScope}`); openComponentMenu(e, area); });
        const cls = cmpMenu.querySelector('[data-cls]');
        if (cls && target) {
            cls.value = target.getAttribute('class') || '';
            cls.addEventListener('input', () => { target.setAttribute('class', cls.value); liveMainPropagate(area, target, 'class', cls.value); });
            cls.addEventListener('change', () => commitComponentNode(area, target, 'class', cls.value));
            cls.addEventListener('keydown', ev => { if (ev.key === 'Enter') cls.blur(); });
        }
        const hide = () => { if (cmpMenu.matches(':popover-open')) cmpMenu.hidePopover(); };
        const rv = cmpMenu.querySelector('[data-a="revert"]'); if (rv) rv.onclick = () => { revertNode(area, target); hide(); };
        cmpMenu.querySelector('[data-a="revertall"]').onclick = () => { revertAll(area); hide(); };
        cmpMenu.style.left = Math.min(e.clientX, innerWidth - 240) + 'px'; cmpMenu.style.top = Math.min(e.clientY, innerHeight - 180) + 'px';
        if (!cmpMenu.matches(':popover-open')) { try { cmpMenu.showPopover(); } catch { } }
        if (cls) setTimeout(() => cls.focus(), 0);
    }


    /* ---- Style: right-click → live utility-class input (no Apply; commit on close) ---- */
    let menu;
    function closeMenu() {
        if (!menu || !menu.matches(':popover-open')) return;
        if (menu._dirty && menu._target) { commitStaticNode(menu._target.closest('[data-edit-area]'), menu._target, 'class', menu._target.getAttribute('class') || ''); menu._dirty = false; }
        try { menu.hidePopover(); } catch { } menu._target = null;
    }
    function ensureMenu() {
        if (menu) return menu;
        // A real popover: the top layer is above every stacking context, so the menu
        // cannot be painted over by a resize handle or anything else with a z-index.
        menu = document.createElement('div'); menu.setAttribute('data-edit-menu', ''); menu.setAttribute('popover', 'manual');
        menu.innerHTML = '<small>Classes <span data-tag></span> · live</small><input type="text" spellcheck="false"><div class="row"><button class="ghost sm" data-a="close">Done</button></div>';
        menu.addEventListener('pointerdown', e => e.stopPropagation());
        const input = menu.querySelector('input');
        input.addEventListener('input', () => { if (menu._target) { menu._target.setAttribute('class', input.value); menu._dirty = true; } });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') closeMenu(); });
        menu.querySelector('[data-a="close"]').addEventListener('click', closeMenu);
        document.body.appendChild(menu);
        document.addEventListener('pointerdown', closeMenu);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
        return menu;
    }
    function openMenu(el, x, y) {
        const m = ensureMenu(); m._target = el; m._dirty = false; el._preClass = el.getAttribute('class') || '';
        m.querySelector('[data-tag]').textContent = '· ' + el.tagName.toLowerCase();
        const input = m.querySelector('input'); input.value = el.getAttribute('class') || '';
        m.style.left = Math.min(x, innerWidth - 280) + 'px'; m.style.top = Math.min(y, innerHeight - 130) + 'px';
        if (!m.matches(':popover-open')) { try { m.showPopover(); } catch { } }
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }
    // The class menu is authoring chrome, so it only opens where chrome was asked for.
    function openClassMenu(area, e) {
        if (!area._edit.authoring) return;
        let t = e.target;
        while (t && t !== area.parentElement && !(capOf(t, 'style') && !locked(t) && !t.hasAttribute('data-edit-handle'))) t = t.parentElement;
        if (!t || !capOf(t, 'style') || locked(t)) return;
        openMenu(t, e.clientX, e.clientY);
    }


    /* ---- Theme regime: edit CSS custom properties (x-edit.cssvar) ----
       Not DOM-element editing. A variable set on :root is global; set on an x-edit
       theme scope's element it cascades to that subtree ONLY (sandboxed theme), so the
       same var name can live at both levels without collision. Controls are inputs that
       declare their target as "scope:--var" (area/scope key) or bare "--var" (global).
       Live = setProperty (var()-referencing utilities update for free); persisted as
       {kind:'theme', scope, var, value}. Net-new variables are a later step. */
    const cssvarControls = new Set();
    const themeBaseline = {};            // "scope|var" → original inline value ('' if none) — for revert-to-baseline
    const themeTouched = new Set();      // every scope|var ever applied
    const tkey = (scope, v) => (scope || '') + '|' + v;
    const themeTargetEl = (scope) => (scope && themeScopes[scope]) || document.documentElement;
    const cvValue = (el) => el.value + (el.dataset.unit || '');   // data-unit lets a range/number drive a unit'd var

    function registerCssVar(el, expression) {
        const spec = (expression || '').trim();
        const m = spec.match(/^([\w-]+)\s*:\s*(--[\w-]+)$/);   // "scope:--var" vs bare "--var" (global)
        el._cssvar = m ? { scope: m[1], var: m[2] } : { scope: null, var: spec };
        cssvarControls.add(el);
    }
    function syncCssVarInput(el) {
        const cv = el._cssvar; if (!cv || !('value' in el)) return;
        const cur = getComputedStyle(themeTargetEl(cv.scope)).getPropertyValue(cv.var).trim();
        if (!cur) return;
        const next = el.dataset.unit ? String(parseFloat(cur)) : cur;
        if (el.value !== next) el.value = next;
    }
    function armCssVar(el) {
        const cv = el._cssvar; if (!cv || !cv.var) return;
        const kk = tkey(cv.scope, cv.var);
        if (!(kk in themeBaseline)) themeBaseline[kk] = themeTargetEl(cv.scope).style.getPropertyValue(cv.var);
        syncCssVarInput(el);
        if (el._cvBound) return; el._cvBound = true;
        el.addEventListener('input', () => themeTargetEl(cv.scope).style.setProperty(cv.var, cvValue(el)));   // live, no log
        el.addEventListener('change', () => commitTheme(cv.scope, cv.var, cvValue(el)));                       // commit
    }
    function armThemeControls() { cssvarControls.forEach(armCssVar); }

    function themeState() {
        const s = {};
        for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'theme') s[tkey(d.scope, d.var)] = d; }
        return s;
    }
    // Re-derive every touched var from the log: state value if present, else the captured
    // baseline (setProperty to restore an authored inline value; removeProperty if none).
    function applyThemeState() {
        const st = themeState();
        new Set([...themeTouched, ...Object.keys(st)]).forEach(kk => {
            themeTouched.add(kk);
            const sep = kk.indexOf('|'), scope = kk.slice(0, sep) || null, v = kk.slice(sep + 1);
            const el = themeTargetEl(scope), eff = st[kk] ? st[kk].value : themeBaseline[kk];
            if (eff) el.style.setProperty(v, eff); else el.style.removeProperty(v);
        });
        cssvarControls.forEach(syncCssVarInput);
    }
    function commitTheme(scope, v, value) {
        const kk = tkey(scope, v); themeTouched.add(kk);
        themeTargetEl(scope).style.setProperty(v, value);
        const cur = themeState()[kk]; if (cur && cur.value === value) return;   // dedupe
        log.splice(cursor); log.push({ kind: 'theme', scope: scope || null, var: v, value }); cursor = log.length; saveState(); refresh();
    }
    // B-side: each theme var → its scope's target CSS file (data-edit-theme-file on the
    // scope element); global vars carry no file → the server falls back to the theme file.
    function themePatches() {
        return Object.values(themeState()).map(d => {
            const el = d.scope ? themeScopes[d.scope] : null;
            return { kind: 'theme', scope: d.scope || null, var: d.var, value: d.value, file: el ? el.getAttribute('data-edit-theme-file') || null : null };
        });
    }


    /* ---- Arm / disarm an area for its regime + caps ---- */
    // Static nodes are addressed by a content-derived key, not by their position
    // among siblings. Position was stable while the tree was, but adding, removing or
    // duplicating a block shifts every address after it — so an edit recorded before
    // a structural change replayed onto the wrong element afterwards.
    //
    // The key is derived once, from what the element held when the area was first
    // armed, and never recomputed for an element that already has one. That is what
    // makes it survive both kinds of change: a later text edit does not move the
    // address, and a reload derives the same key again because the source it loads is
    // the same source the key was first taken from.
    function markStatic(area) {
        area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {}; area._baseText = area._baseText || {};
        const seen = Object.create(null);
        const markEl = (el) => {
            let k = el.getAttribute('data-edit-key');
            if (k) {
                // Keep the tally in step so a new element never claims an ordinal
                // an existing one already holds.
                const [base, n] = k.split('#');
                seen[base] = Math.max(seen[base] || 0, n ? +n : 1);
            } else {
                const base = el.tagName + ':' + (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24);
                const n = seen[base] = (seen[base] || 0) + 1;
                k = n > 1 ? base + '#' + n : base;
                el.setAttribute('data-edit-key', k);
            }
            el.setAttribute('data-edit-path', pathOf(el, area));   // still what the source writer navigates by
            if (!(k in area._baseClass)) area._baseClass[k] = el.getAttribute('class') || '';
            if (!(k in area._baseStyle)) area._baseStyle[k] = el.getAttribute('style') || '';
        };
        markEl(area);
        // Stop at a rich editor: its internals are its own, and marking them would
        // both litter its content and let applyStaticState fight it for the same nodes.
        area.querySelectorAll('*').forEach(el => {
            if (el.hasAttribute('data-edit-handle')) return;
            if (el.parentElement && el.parentElement.closest('[data-text-edit]')) return;
            markEl(el);
        });
        if (!area._baseOrder) area._baseOrder = staticKeys(area);
        if (!(key(area) in lastOrder)) lastOrder[key(area)] = area._baseOrder;
    }
    function armArea(area) {
        const kind = classify(area);
        area.setAttribute('data-edit-armed', '');
        // Chrome is opt-in: a sortable list should look like a list, not like a page
        // being edited. The attributes are all CSS asks for — what is shown, and
        // whether it is shown at all, is decided in the stylesheet.
        area.toggleAttribute('data-edit-authoring', !!area._edit.authoring);
        area.setAttribute('data-edit-label', kind === 'component' ? `${key(area)} · component · ${area._editScope || 'instance'}` : `${key(area)} · ${kind}`);
        if (kind === 'static') markStatic(area);
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(c => { if (capOf(c, 'sort') && !locked(c)) makeSortable(c); });
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(c => { if (ownsCap(c, 'size')) armSize(c); });
        if (kind === 'component') armComponent(area); else armText(area);
        if (!area._ctxBound) {
            area._ctxBound = true;
            // One binding for the whole area: report the block, and fall back to the
            // built-in authoring menu only if the project did not take the event.
            area.addEventListener('contextmenu', (e) => {
                if (!isActive(area)) return;
                const builtIn = () => classify(area) === 'component' ? openComponentMenu(e, area) : openClassMenu(area, e);
                if (onBlockContext(e, builtIn)) return;
                if (!area._edit.authoring) return;
                e.preventDefault();
                builtIn();
            });
        }
        if (kind === 'data' && capOf(area, 'data')) armDataValues(area);
    }
    function disarmArea(area) {
        area.querySelectorAll('[data-edit-handle]').forEach(h => h.remove());
        area.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
        area.querySelectorAll('[data-edit-sortable]').forEach(e => { ['data-edit-sortable', 'data-edit-grabbed', 'data-edit-dragging', 'tabindex', 'role', 'draggable'].forEach(a => e.removeAttribute(a)); e._dragBound = false; });
        [area, ...area.querySelectorAll('[data-edit-sizable],[data-edit-movable]')].forEach(e => { e.removeAttribute('data-edit-sizable'); e.removeAttribute('data-edit-movable'); e._sizeBound = false; });
        area.removeAttribute('data-edit-armed'); area.removeAttribute('data-edit-label');
    }

    /* ---- Activation: per-area, always-on by default (.gated needs $edit.on()) ---- */
    let estore, booted = false, armQueued = false;
    const isActive = (a) => !!a && (!a._edit.gated || (estore && estore.active));
    const anyActive = () => areas().some(isActive);
    function armAll() { areas().forEach(a => { if (isActive(a) && !a._armed) { lastSnap[key(a)] = snapshot(a, classify(a)); armArea(a); a._armed = true; } }); armThemeControls(); refresh(); booted = true; }

    /* ---- Late regions: arm when Alpine initialises them, release when it destroys them ---- */
    // Arming ran once at boot, so anything rendered later — x-if, a route change, a lazy
    // component, x-markdown output — stayed inert. Every one of those paths goes through
    // Alpine.initTree, so the x-edit directive itself is the hook; no observer needed.
    // Deferred one microtask so the tree Alpine is walking is complete before baselines
    // are captured, and batched so a burst of regions costs one pass.
    function armLater() {
        if (!booted || armQueued) return;   // the boot pass still owns start-up ordering
        armQueued = true;
        queueMicrotask(() => { armQueued = false; armAll(); });
    }
    // Runs from Alpine's directive cleanup (x-if/x-for teardown, or its own mutation
    // observer), so a removed region drops its observers and its registry slot.
    function releaseEdit(el) {
        Object.keys(themeScopes).forEach(k => { if (themeScopes[k] === el) delete themeScopes[k]; });
        cssvarControls.delete(el);
        if (!editEls.has(el)) return;
        if (el._armed) { disarmArea(el); el._armed = false; }
        [el, ...el.querySelectorAll('*')].forEach(n => { if (n._sortObserver) { n._sortObserver.disconnect(); n._sortObserver = null; } });
        editEls.delete(el); delete el._edit;
        el.removeAttribute('data-edit-area');
        refresh();
    }
    // Build B-side source patches from the edit set (storage-agnostic; overlay
    // already auto-persists to localStorage on commit).
    function buildPatches() {
        const patches = Object.entries(fold()).filter(([k]) => authoringRegion(k)).map(([k, v]) => patchFor(k, v.kind, v.snap));   // data
        const toEdits = (paths, area) => {
            const e = [];
            Object.entries(paths).forEach(([k, props]) => {
                // Keys address across a session; the source writer navigates by
                // position, so resolve to where the element actually sits now. An
                // element that has since been deleted has nothing to write.
                const el = area && (area.getAttribute('data-edit-key') === k ? area : area.querySelector(`[data-edit-key="${CSS.escape(k)}"]`));
                const path = el ? el.getAttribute('data-edit-path') : k;
                if (area && !el) return;
                Object.entries(props).forEach(([prop, value]) => e.push({ path, key: k, prop, value }));
            });
            return e;
        };
        const ss = staticState();   // static: per-node ops + reorder permutation (no whole HTML)
        new Set([...Object.keys(ss.node), ...Object.keys(ss.order)]).forEach(region => {
            if (!authoringRegion(region)) return;
            const edits = toEdits(ss.node[region] || {}, areaByKey(region));
            if (edits.length || ss.order[region]) patches.push({ kind: 'static', region, edits, order: ss.order[region] || null });
        });
        const dv = dataValueState();   // data-value edits → field writes (local file / cloud $update)
        Object.entries(dv).forEach(([source, recs]) => Object.entries(recs).forEach(([id, fields]) => Object.entries(fields).forEach(([field, value]) => patches.push({ kind: 'data-val', source, id, field, value }))));
        const { main, inst, reverts } = componentState();
        Object.entries(main).forEach(([component, paths]) => { const edits = toEdits(paths); if (edits.length) patches.push({ kind: 'component', scope: 'main', component, edits }); });
        new Set([...Object.keys(inst), ...Object.keys(reverts)]).forEach(region => {
            const area = areaByKey(region); if (!area) return;
            const edits = toEdits(inst[region] || {}), rv = [...(reverts[region] || [])];
            if (edits.length || rv.length) patches.push({ kind: 'component', scope: 'instance', component: componentName(area), region, edits, reverts: rv });
        });
        themePatches().forEach(p => patches.push(p));   // theme: CSS-var value writes (scoped → its file; global → theme file)
        return patches;
    }
    function publish() {
        const patches = buildPatches();
        if (estore && typeof estore.onPublish === 'function') return Promise.resolve(estore.onPublish(patches, { log, cursor }));
        if (!patches.length) return Promise.resolve({ results: [] });
        return fetch('/__edit/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patches) }).then(r => r.json());   // default: local dev-server source writer (authoring)
    }
    function on() { if (estore) estore.active = true; armAll(); }
    function off() { if (estore) estore.active = false; areas().forEach(a => { if (a._edit.gated && a._armed) { disarmArea(a); a._armed = false; } }); closeMenu(); refresh(); }
    // Runtime lock — meta, not content: applied immediately, not logged. Locks
    // the target and its subtree (descendants without their own x-edit inherit).
    function setLock(el, val) {
        if (!el) return;
        if (!el._edit) { el._edit = { key: `lock-${++autoN}`, caps: new Set(), lock: val, gated: false }; el.setAttribute('data-edit-area', ''); editEls.add(el); }
        else { el._edit.lock = val; if (val) el._edit.caps = new Set(); }
        if (val) { el.querySelectorAll('[data-edit-handle]').forEach(h => h.remove()); el.removeAttribute('draggable'); el.removeAttribute('contenteditable'); el.removeAttribute('data-edit-sizable'); el._sizeBound = false; el.querySelectorAll('[draggable],[contenteditable]').forEach(n => { n.removeAttribute('draggable'); n.removeAttribute('contenteditable'); }); }
        const area = areas().find(a => a === el || a.contains(el));
        if (area && isActive(area)) armArea(area);
    }


    /* ---- Authoring chrome: floating toolbar (undo/redo/publish/reset). A convenience
       over the $edit magic — built on first use and shown only where there is
       something to edit, so it never sits on a route with no editable area. ---- */
    let bar;
    function buildUI() {
        if (bar) return bar;
        bar = document.createElement('div'); bar.setAttribute('data-edit-toolbar', '');
        bar.innerHTML = '<button class="ghost" data-a="undo">↶ Undo</button><button class="ghost" data-a="redo">↷ Redo</button><button class="brand" data-a="publish">Publish</button><button class="ghost" data-a="reset">Reset</button>';
        bar.addEventListener('click', e => {
            const btn = e.target.closest('button'); if (!btn) return; const a = btn.getAttribute('data-a');
            if (a === 'undo') undo(); if (a === 'redo') redo(); if (a === 'reset') { localStorage.removeItem(LS_KEY); location.reload(); }
            if (a === 'publish') {
                const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Publishing…';
                publish().then(r => { const rs = r.results || []; const w = rs.filter(x => x.status === 'written').length, sk = rs.filter(x => x.status === 'skipped').length; btn.textContent = `Wrote ${w}${sk ? ` · ${sk} skipped` : ''}`; })
                    .catch(() => btn.textContent = 'Failed').finally(() => { btn.disabled = false; setTimeout(() => btn.textContent = orig, 2800); });
            }
        });
        document.body.appendChild(bar);
        return bar;
    }
    // An area hidden by the router is still in the DOM, so ask the layout, not the tree.
    const onScreen = (el) => el.checkVisibility ? el.checkVisibility() : !!el.offsetParent;
    function refresh() {
        if (estore) { estore.canUndo = cursor > 0; estore.canRedo = cursor < log.length; }
        // Script decides presence — it is the only thing that knows which route is on
        // screen. The stylesheet decides whether it is seen.
        const authoring = areas().some(a => a._edit.authoring && isActive(a) && onScreen(a));
        document.documentElement.toggleAttribute('data-edit-active', authoring);
        if (!authoring) return;
        buildUI();
        bar.querySelector('[data-a="undo"]').disabled = cursor === 0;
        bar.querySelector('[data-a="redo"]').disabled = cursor >= log.length;
    }


    /* ---- Restore persisted edits + boot (registers x-edit directive + $edit magic) ---- */
    function restore() {
        if (!log.length) return;
        for (const [k, v] of Object.entries(fold())) { const area = areaByKey(k); if (area && v.kind === 'data') waitForData(area, () => applySnap(area, 'data', v.snap)); }
        if (log.some(d => d.kind === 'st-node' || d.kind === 'st-order')) applyStaticState();
        if (log.some(d => d.kind === 'cmp-main' || d.kind === 'cmp-inst')) applyComponentState();
        if (log.some(d => d.kind === 'data-val')) { const da = areas().find(a => classify(a) === 'data'); if (da) waitForData(da, applyDataValues); }
        if (log.some(d => d.kind === 'theme')) applyThemeState();
    }
    function waitForData(area, cb) { const expr = dataSourceExpr(area), tpl = area.querySelector('template[x-for]'); let n = 0; const t = setInterval(() => { let r = false; try { r = Array.isArray(window.Alpine.evaluate(tpl, expr)); } catch {} if (r) { clearInterval(t); cb(); } else if (++n > 100) clearInterval(t); }, 50); }
    function init() {
        if (!window.Alpine || !Alpine.directive) return;
        Alpine.directive('edit', (el, { modifiers, expression }, { cleanup }) => {
            registerEdit(el, modifiers, expression);
            armLater();                        // a region rendered after boot arms itself
            cleanup(() => releaseEdit(el));    // ...and lets go when Alpine tears it down
        });
        Alpine.store('edit', {
            active: false, canUndo: false, canRedo: false,
            onPublish: null,                                 // author sets a fn(patches, {log,cursor}) → route to cloud/custom
            toggle() { this.active ? off() : on(); }, on() { on(); }, off() { off(); },
            undo() { undo(); }, redo() { redo(); }, lock(el) { setLock(el, true); }, unlock(el) { setLock(el, false); },
            publish() { return publish(); },
            // Block operations. Called with no element they act on the block the last
            // right-click reported, which is what a context menu wants.
            targetVersion: 0,                                // trackable: see blocks.js
            get target() { void this.targetVersion; return blockTarget(); },
            set target(el) { setBlockTarget(el); },
            can(op, el) { void this.targetVersion; return canDo(op, el); },
            copy(el) { return copyBlock(el); },
            cut(el) { return cutBlock(el); },
            paste(el) { return pasteBlock(el); },
            duplicate(el) { return duplicateBlock(el); },
            remove(el) { return removeBlock(el); },
            block(node) { return blockOf(node); },
            patches() { return buildPatches(); },            // resolved B-side source patches
            export() { return JSON.parse(JSON.stringify({ log, cursor })); }   // A-side overlay (e.g. push to Appwrite)
        });
        estore = Alpine.store('edit');
        Alpine.magic('edit', () => Alpine.store('edit'));
        loadState();
        setTimeout(() => { armAll(); restore(); }, 450);   // arm (captures baselines) THEN re-apply persisted edits
        window.addEventListener('manifest:route-change', () => setTimeout(refresh, 0));   // chrome follows the route
    }
    document.addEventListener('alpine:init', init);
    if (window.Alpine && Alpine.directive) setTimeout(init, 0);
})();


})();
