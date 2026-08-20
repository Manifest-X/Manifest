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
    const materialize = (markup) => {
        if (!markup) return null;
        const t = document.createElement('template');
        t.innerHTML = markup.trim();
        return t.content.firstElementChild;
    };

    function applyStaticState() {
        const { node, order, sigs, base, html } = staticState();
        document.querySelectorAll('[data-edit-area]').forEach(area => {
            if (!area._edit || classify(area) !== 'static') return;
            const region = key(area);
            [area, ...area.querySelectorAll('[data-edit-path]')].forEach(el => {
                const p = el.getAttribute('data-edit-path'), bk = region + '|' + p;
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
                const next = want.map(kk => by[kk] || materialize(markup[kk])).filter(Boolean);
                kids.forEach(el => { if (!next.includes(el)) el.remove(); });
                next.forEach(el => area.appendChild(el));
            }
        });
    }
    function commitStaticNode(area, el, prop, value) {
        const region = key(area), path = el.getAttribute('data-edit-path');
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
        value = String(value); const before = el ? el._preEdit : undefined;
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
