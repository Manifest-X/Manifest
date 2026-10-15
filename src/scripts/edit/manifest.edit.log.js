    /* ---- Log ---- */
    const REVERT = '∅revert';
    let ver = 0;
    const stamps = new WeakMap();

    // Append a delta at the cursor. `join` undoes it together with the delta before it.
    function pushDelta(d, persist) {
        log.splice(cursor);
        log.push(d); cursor = log.length; ver++;
        if (persist === undefined) persist = deltaPersists(d);
        if (persist) persisted.add(d);
        saveState(); refresh();
        return d;
    }
    function deltaPersists(d) {
        if (d.kind === 'data-splice' || d.kind === 'show') return false;
        if (d.kind === 'st-move') return persistOf(d.from) && persistOf(d.to);
        return d.region != null && persistOf(d.region);
    }

    function snapshot(area, kind) {
        if (kind === 'data') return { source: dataSourceName(area), order: sortableChildren(area).map(c => itemKey(c, area)) };
        return {};
    }
    async function applySnap(area, kind, snap) {
        if (!area || !snap) return;
        if (kind === 'data') applyDataOrder(area, snap.order);
        if (isActive(area)) armArea(area);
    }
    function applyDataOrder(area, order) {
        const expr = dataSourceExpr(area), tpl = listTpl(area);
        try {
            const arr = window.Alpine.evaluate(tpl, expr); if (!Array.isArray(arr)) return;
            const byKey = new Map(arr.map(it => [String(it.id), it]));
            const next = order.map(k => byKey.get(String(k))).filter(Boolean);
            arr.forEach(it => { if (!order.map(String).includes(String(it.id))) next.push(it); });
            arr.splice(0, arr.length, ...next);
        } catch { }
    }

    /* ---- Component edits: cmp-main (every instance) / cmp-inst (one region) ---- */
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
    const componentNodes = (root) => [root, ...root.querySelectorAll('*')].filter(el => el._editPath != null);
    function applyComponentState() {
        const { main, inst, sigs } = componentState();
        areas().forEach(area => {
            if (classify(area) !== 'component') return;
            const comp = componentName(area), region = key(area), root = area.querySelector('[data-component]'); if (!root) return;
            componentNodes(root).forEach(el => {
                const p = el._editPath;
                const expect = sigs[comp + '|' + p];
                if (expect && nodeSig(el) !== expect) { console.warn('[edit] skip stale node (structure changed):', comp, p); return; }
                const iv = (inst[region] && inst[region][p]) || {}, mv = (main[comp] && main[comp][p]) || {};
                const base = area._baseText || {}, baseC = area._baseClass || {}, baseS = area._baseStyle || {};
                const pick = (prop, fallback) => iv[prop] !== undefined ? iv[prop] : (mv[prop] !== undefined ? mv[prop] : fallback);
                const text = pick('text', base[p]), cls = pick('class', baseC[p]), sty = pick('style', baseS[p]);
                if (text !== undefined) { const safe = sanitizeFor(el, text); if (el.innerHTML !== safe) el.innerHTML = safe; }
                if (cls !== undefined) writeClass(el, cls);
                if (sty !== undefined && el.getAttribute('style') !== sty) { if (sty === '') el.removeAttribute('style'); else el.setAttribute('style', sty); }
            });
        });
    }
    function commitComponentNode(area, el, prop, value, before) {
        const path = el._editPath, scope = area._editScope || 'instance', component = componentName(area), region = key(area);
        if (path == null) return false;
        if (prop === 'text') value = sanitizeFor(el, value);
        if (before === undefined) before = prop === 'text' ? el._preEdit : prop === 'style' ? el._preStyle : el._preClass;
        if (before === value) return false;
        const sig = nodeSig(el);
        pushDelta(scope === 'main' ? { kind: 'cmp-main', component, path, prop, value, before, sig, region } : { kind: 'cmp-inst', component, region, path, prop, value, before, sig });
        applyComponentState();
        return true;
    }
    function revertNode(area, el) { pushDelta({ kind: 'cmp-inst', component: componentName(area), region: key(area), path: el._editPath, prop: '*', value: REVERT }); applyComponentState(); }
    function revertAll(area) { pushDelta({ kind: 'cmp-inst', component: componentName(area), region: key(area), path: '*', prop: '*', value: REVERT }); applyComponentState(); }

    /* ---- Static: per-node typed deltas + per-container child orders ----
       Every key is a canonical identity (origin region + content key), so a delta
       names the same element wherever it moves. Orders are keyed region → container
       key ('' = the region root). Baselines come from the first delta that touched a
       prop or container. */
    function staticState() {
        const node = {}, order = {}, orderBase = {}, sigs = {}, base = {}, html = {};
        const setOrder = (o, region, parent, keys, first) => {
            if (!keys) return;
            const m = o[region] = o[region] || {}, p = parent || '';
            if (first && p in m) return;
            m[p] = keys.slice();
        };
        for (let i = 0; i < log.length; i++) {
            const d = log[i];
            if (d.kind === 'st-children') { if (d.html) Object.assign(html, d.html); setOrder(orderBase, d.region, d.parent, d.before, true); }
            else if (d.kind === 'st-order') setOrder(orderBase, d.region, d.parent, d.before, true);
            else if (d.kind === 'st-move') { setOrder(orderBase, d.from, d.fromParent, d.fromBefore, true); setOrder(orderBase, d.to, d.toParent, d.toBefore, true); }
            else if (d.kind === 'st-node') {
                const b = base[d.path] = base[d.path] || {};
                if (!(d.prop in b)) b[d.prop] = d.before;
                if (d.sig) sigs[d.path] = d.sig;
            }
        }
        const touched = new Set();
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind === 'st-node') (node[d.path] = node[d.path] || {})[d.prop] = d.value;
            else if (d.kind === 'st-order' || d.kind === 'st-children') {
                setOrder(order, d.region, d.parent, d.order); touched.add(d.parent || '#' + d.region);
                if (d.copies) Object.entries(d.copies).forEach(([k, ops]) => { node[k] = Object.assign({}, ops, node[k]); });
            } else if (d.kind === 'st-move') {
                setOrder(order, d.from, d.fromParent, d.fromOrder); setOrder(order, d.to, d.toParent, d.toOrder);
                touched.add(d.fromParent || '#' + d.from); touched.add(d.toParent || '#' + d.to);
            }
        }
        return { node, order, orderBase, sigs, base, html, touched };
    }

    // Data rows: adding/removing records the record itself. In-session only.
    function commitSplice(area, index, record, op) {
        pushDelta({ kind: 'data-splice', region: key(area), source: dataSourceName(area), index, op, record: JSON.parse(JSON.stringify(record)) });
        setTimeout(() => { lastSnap[key(area)] = snapshot(area, classify(area)); }, 0);
    }
    function applySplice(d, undo) {
        const area = areaByKey(d.region); if (!area) return;
        const tpl = listTpl(area), expr = dataSourceExpr(area);
        if (!tpl || !expr) return;
        let arr; try { arr = window.Alpine.evaluate(tpl, expr); } catch { return; }
        if (!Array.isArray(arr)) return;
        const inserting = undo ? d.op === 'remove' : d.op === 'insert';
        if (inserting) arr.splice(Math.min(d.index, arr.length), 0, JSON.parse(JSON.stringify(d.record)));
        else arr.splice(d.index, 1);
        setTimeout(() => { lastSnap[d.region] = snapshot(area, classify(area)); }, 0);
    }

    const parentKey = (container, area) => container === area ? '' : (container.getAttribute('data-edit-key') || '');

    // Duplicate, delete, paste: the container's resulting order plus the markup the log
    // introduced or took away. `copies` seeds a copy's edits from its original.
    function commitStructure(area, container, before, markup, copies) {
        const order = staticKeys(container);
        if (eq(before, order) && !Object.keys(markup || {}).length) return;
        const d = { kind: 'st-children', region: key(area), parent: parentKey(container, area), order, before, html: markup || {} };
        if (copies && Object.keys(copies).length) d.copies = copies;
        pushDelta(d);
    }
    const materialize = (markup, k) => {
        if (!markup) return null;
        const t = document.createElement('template');
        t.innerHTML = markup.trim();
        const el = t.content.firstElementChild;
        if (el && k) el.setAttribute('data-edit-key', k);
        return el;
    };
    const staticAreas = () => areas().filter(a => classify(a) === 'static' && !sharedKey(a));
    // Removed elements, kept so undo puts back the same element (listeners, titling comment).
    const detached = new Map();
    function keyMap(roots) {
        const m = new Map();
        roots.forEach(area => [area, ...area.querySelectorAll('[data-edit-key]')].forEach(el => {
            if (el.closest('[data-edit-ghost]')) return;
            const k = el.getAttribute('data-edit-key');
            if (k != null && !m.has(k)) m.set(k, el);
        }));
        return m;
    }

    function applyStaticProp(el, prop, v) {
        if (v === undefined) return;
        if (prop === 'text') { const safe = sanitizeFor(el, v); if (el.innerHTML !== safe) el.innerHTML = safe; return; }
        if (attrRefusal(prop, v, el.tagName)) return;
        if (prop === 'class') return writeClass(el, v);
        if (prop === 'style') return writeStyle(el, v);
        if (v === null) { el.removeAttribute(prop); return; }
        if (el.getAttribute(prop) !== v) el.setAttribute(prop, v);
    }

    // One pass over every static area: orders place elements by identity (moving them
    // between areas when the log says so), then props are applied.
    function applyStaticState() {
        const { node, order, orderBase, sigs, base, html } = staticState();
        const roots = staticAreas();
        const byId = keyMap(roots);
        const entries = [];
        new Set([...Object.keys(orderBase), ...Object.keys(order)]).forEach(region => {
            const want = Object.assign({}, orderBase[region] || {}, order[region] || {});
            Object.entries(want).forEach(([parent, keys]) => entries.push([region, parent, keys]));
        });
        const claimed = new Set();
        entries.forEach(([, , keys]) => keys.forEach(k => claimed.add(k)));
        const touchedAreas = new Set();
        const get = (k) => {
            let el = byId.get(k);
            if (!el && detached.has(k)) { el = detached.get(k); detached.delete(k); byId.set(k, el); }
            if (!el && html[k]) {
                el = materialize(html[k], k);
                if (el) { byId.set(k, el); el.querySelectorAll('[data-edit-key]').forEach(n => { const nk = n.getAttribute('data-edit-key'); if (!byId.has(nk)) byId.set(nk, n); }); }
            }
            return el;
        };
        let progress = true;
        while (entries.length && progress) {
            progress = false;
            for (let i = 0; i < entries.length; i++) {
                const [region, parent, keys] = entries[i];
                const c = parent ? byId.get(parent) : areaByKey(region);
                if (!c || !c.isConnected) continue;
                entries.splice(i--, 1); progress = true;
                const kids = sortableChildren(c);
                const next = keys.map(get).filter(el => el && el !== c && !el.contains(c));
                const stay = kids.filter(el => !next.includes(el) && !claimed.has(el.getAttribute('data-edit-key')) && !html[el.getAttribute('data-edit-key')]);
                const target = [...next, ...stay];
                if (target.length === kids.length && target.every((el, j) => el === kids[j])) continue;
                const anchor = kids.length ? kids[kids.length - 1].nextSibling : Array.from(c.children).find(pluginNode) || null;
                const leads = new Map(target.map(el => [el, el.isConnected ? leadNodes(el) : el._editLead || []]));
                kids.forEach(el => { if (target.includes(el)) return; el._editLead = leadNodes(el); el._editLead.forEach(n => n.remove()); el.remove(); const k = el.getAttribute('data-edit-key'); if (k) detached.set(k, el); });
                target.forEach(el => { const from = regionOf(el); if (from) touchedAreas.add(from); c.insertBefore(el, anchor && anchor.parentNode === c ? anchor : null); const l = leads.get(el); if (l.length) el.before(...l); });
                const a = regionOf(c); if (a) touchedAreas.add(a);
            }
        }
        if (touchedAreas.size) resetAreas();
        const live = touchedAreas.size ? keyMap(staticAreas()) : byId;
        live.forEach((el, p) => {
            const ops = node[p], baseline = base[p];
            if (!ops && !baseline) return;
            const expect = sigs[p]; if (expect && nodeSig(el) !== expect) { console.warn('[edit] skip stale static node', p); return; }
            const props = new Set([...Object.keys(ops || {}), ...Object.keys(baseline || {})]);
            props.forEach(prop => applyStaticProp(el, prop, ops && ops[prop] !== undefined ? ops[prop] : baseline && baseline[prop]));
        });
        touchedAreas.forEach(a => { if (!a.isConnected) return; markStatic(a); if (a._armed && isActive(a)) armArea(a); });
    }

    // One delta per committed change. `opts.before` overrides the captured baseline;
    // `opts.coalesce` folds a quick follow-up change to the same prop into the last delta.
    function commitStaticNode(area, el, prop, value, opts = {}) {
        const region = key(area), path = el.getAttribute('data-edit-key');
        if (!path || path[0] === '!') return false;
        if (prop === 'text' && RAW_EDIT.has(el.tagName)) return false;
        if (prop === 'text') value = sanitizeFor(el, value);
        let before = opts.before;
        if (before === undefined) {
            const fallback = prop === 'text' ? area._baseText && area._baseText[path] : prop === 'class' ? area._baseClass && area._baseClass[path] : prop === 'style' ? area._baseStyle && area._baseStyle[path] : el.getAttribute(prop);
            const pre = prop === 'text' ? el._preEdit : prop === 'class' ? el._preClass : prop === 'style' ? el._preStyle : undefined;
            before = pre !== undefined ? pre : fallback;
        }
        if (before === value) return false;
        if (prop === 'text' && document.activeElement !== el && el.innerHTML.trim() !== value) el.innerHTML = value;
        const last = log[cursor - 1];
        if (opts.coalesce && last && cursor === log.length && last.kind === 'st-node' && last.region === region && last.path === path && last.prop === prop && Date.now() - (stamps.get(last) || 0) < COALESCE_MS) {
            if (last.before === value) { log.pop(); cursor--; } else { last.value = value; stamps.set(last, Date.now()); }
            ver++; saveState(); refresh();
            return true;
        }
        const d = pushDelta(Object.assign({ kind: 'st-node', region, path, prop, value, before, sig: nodeSig(el) }, opts.join ? { join: true } : {}));
        if (opts.coalesce) stamps.set(d, Date.now());
        return true;
    }

    /* ---- Data values (.data): edit $x record fields ---- */
    function dataValueState() {
        const s = {};
        for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'data-val') ((s[d.source] = s[d.source] || {})[d.id] = s[d.source][d.id] || {})[d.field] = d.value; }
        return s;
    }
    // Every field the log touches: its value at the cursor, else the first delta's before (an undo back to the start).
    function applyDataValues() {
        const st = dataValueState(), first = new Map();
        log.forEach(d => { if (d.kind === 'data-val') { const k = JSON.stringify([d.source, d.id, d.field]); if (!first.has(k)) first.set(k, d); } });
        first.forEach(d => {
            const r = (st[d.source] = st[d.source] || {})[d.id] = st[d.source][d.id] || {};
            if (!(d.field in r) && d.before !== undefined) r[d.field] = d.before;
        });
        areas().forEach(area => {
            if (classify(area) !== 'data') return;
            const source = dataSourceName(area), recs = st[source]; if (!recs) return;
            const tpl = listTpl(area), expr = dataSourceExpr(area);
            try { const arr = window.Alpine.evaluate(tpl, expr); if (Array.isArray(arr)) Object.entries(recs).forEach(([id, fields]) => { const rec = arr.find(r => String(r.id) === String(id)); if (rec) Object.entries(fields).forEach(([f, v]) => { if (rec[f] !== v) rec[f] = v; }); }); } catch { }
            if (isActive(area)) setTimeout(() => armDataValues(area), 0);
        });
    }
    function commitDataValue(area, source, id, field, value, el) {
        value = String(value);
        if (el && el._editRich) value = sanitizeFor(el, value);
        const before = el ? el._preEdit : undefined;
        if (before === value) return false;
        pushDelta({ kind: 'data-val', region: key(area), source, id, field, value, before });
        applyDataValues();
        return true;
    }

    // Size and freeform placement write inline style; plugin-applied declarations stay out.
    function commitStyle(area, el, opts) {
        const v = ownStyle(el), kind = classify(area);
        if (kind === 'component') return commitComponentNode(area, el, 'style', v);
        if (kind === 'static') return commitStaticNode(area, el, 'style', v, opts);
        return false;
    }
    function commitOrder(area, container, before) {
        const order = staticKeys(container);
        if (eq(before, order)) return false;
        pushDelta({ kind: 'st-order', region: key(area), parent: parentKey(container, area), order, before });
        return true;
    }
    // A piece that already sits in its new container. Identity never changes, so one
    // delta names both containers' orders, within an area or across areas.
    function commitMove(fromArea, toArea, item, fromContainer, fromBefore, toBefore, opts = {}) {
        const toContainer = item.parentElement;
        const d = { kind: 'st-move', from: key(fromArea), to: key(toArea), fromParent: parentKey(fromContainer, fromArea), toParent: parentKey(toContainer, toArea), key: item.getAttribute('data-edit-key'), fromOrder: staticKeys(fromContainer), toOrder: staticKeys(toContainer), fromBefore, toBefore };
        if (opts.join) d.join = true;
        pushDelta(d);
        resetAreas();
        markStatic(toArea);
        if (isActive(fromArea)) armArea(fromArea);
        if (toArea !== fromArea && isActive(toArea)) armArea(toArea);
        return d;
    }

    /* ---- Locks: runtime per-action locks, logged ---- */
    // Static identities are global (they survive moves between areas); others are per area.
    const lockSlot = (region, id) => /^[~@]/.test(id) ? id : region + '|' + id;
    let lockVer = -1, lockMap = new Map();
    function lockState() {
        if (lockVer === ver) return lockMap;
        lockMap = new Map();
        for (let i = 0; i < cursor; i++) {
            const d = log[i]; if (d.kind !== 'lock') continue;
            const slot = lockSlot(d.region, d.key);
            const m = lockMap.get(slot) || new Map(); lockMap.set(slot, m);
            (d.actions && d.actions.length ? d.actions : LOCK_ACTIONS).forEach(a => m.set(a, d.value));
        }
        lockVer = ver;
        return lockMap;
    }
    const lockStateNow = () => lockState();
    function identity(el, area) {
        const kind = classify(area);
        if (kind === 'static') return el.getAttribute('data-edit-key');
        if (el === area) return '';
        if (kind === 'component') return el._editPath != null ? 'path:' + el._editPath : null;
        const list = listTpl(area);
        if (list && el.parentElement === list.parentElement) { const k = itemKey(el, area); return k == null ? null : 'row:' + k; }
        return null;
    }
    const actionOf = (cap) => cap === 'data' ? 'text' : cap === 'class' ? 'attrs' : cap;
    function lockedFor(node, cap) {
        const action = actionOf(cap);
        const region = regionOf(node);
        const locks = lockState();
        for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
            let v;
            if (region && locks.size) { const id = identity(n, region); const m = id != null && locks.get(lockSlot(key(region), id)); if (m && m.has(action)) v = m.get(action); }
            if (v === undefined && n._editLock) v = n._editLock.has('*') || n._editLock.has(action);
            if (v) return true;
            if (n === region) break;
        }
        return false;
    }
    function setLock(el, action, value) {
        if (!el || el.nodeType !== 1) return false;
        const area = regionOf(el); if (!area) return false;
        if (action != null && !LOCK_ACTIONS.includes(action)) { console.warn('[edit] unknown lock action:', action); return false; }
        const id = identity(el, area);
        if (id == null) { console.warn('[edit] this element has no stable identity to lock'); return false; }
        pushDelta({ kind: 'lock', region: key(area), key: id, actions: action ? [action] : [], value: !!value });
        rearm(area);
        return true;
    }
    function rearm(area) { if (area && area._armed) { disarmArea(area); if (isActive(area)) armArea(area); } }

    /* ---- Data area snapshots ---- */
    function commit(area) {
        if (!area) return;
        const k = key(area), kind = classify(area), after = snapshot(area, kind), before = lastSnap[k];
        if (before && eq(before, after)) return;
        pushDelta({ region: k, kind, before: before ?? after, after });
        lastSnap[k] = after;
    }
    const dispatchApply = (d) => {
        if (d.kind === 'cmp-main' || d.kind === 'cmp-inst') applyComponentState();
        else if (d.kind === 'data-val') applyDataValues();
        else if (d.kind === 'theme') applyThemeState();
        else if (d.kind === 'lock') rearm(areaByKey(d.region));
        else applyStaticState();
    };
    // Returns a promise only when a data snapshot must settle, so undo stays synchronous otherwise.
    function applyShow(d, back) {
        const area = areaByKey(d.region); if (!area) return;
        const el = d.key === '' ? area : [area, ...area.querySelectorAll('[x-show]')].find(n => identity(n, area) === d.key);
        if (!el) return;
        try { setShow(el, d.expr, back ? d.before : d.value); } catch { }
    }
    function step(d, back) {
        if (d.kind === 'show') { applyShow(d, back); return null; }
        if (d.kind === 'data-splice') applySplice(d, back);
        else if (d.kind === 'data') { const snap = back ? d.before : d.after; lastSnap[d.region] = snap; return applySnap(areaByKey(d.region), d.kind, snap); }
        else dispatchApply(d);
        return null;
    }
    async function undo() {
        if (cursor === 0) return;
        let d;
        do { d = log[--cursor]; ver++; const p = step(d, true); if (p) await p; } while (d.join && cursor > 0);
        rebaseFocused(); saveState(); refresh();
    }
    async function redo() {
        if (cursor >= log.length) return;
        do { const d = log[cursor++]; ver++; const p = step(d, false); if (p) await p; } while (cursor < log.length && log[cursor].join);
        rebaseFocused(); saveState(); refresh();
    }

    /* ---- Projections ---- */
    function fold() { const s = {}; for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'data') s[d.region] = { kind: d.kind, snap: d.after }; } return s; }
    const patchFor = (r, kind, snap) => ({ region: r, kind, op: 'reorderData', source: snap.source, order: snap.order });
