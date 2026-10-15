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
        const expr = dataSourceExpr(area), tpl = area.querySelector('template[x-for]');
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
       Orders are keyed region → container key ('' = the region root). Baselines come
       from the whole log: the first delta that touched a prop or container carries it. */
    const hasRemaps = () => log.some(d => d.kind === 'st-move' && d.remap && d.remap.length);
    // Translate a key valid at log time `s` to the current cursor, through move renames.
    function renameAt(region, k, s) {
        if (s < cursor) {
            for (let j = s; j < cursor; j++) { const d = log[j]; if (d.kind !== 'st-move' || !d.remap) continue; const hit = d.remap.find(r => r[0] === region && r[1] === k); if (hit) { region = hit[2]; k = hit[3]; } }
        } else {
            for (let j = s - 1; j >= cursor; j--) { const d = log[j]; if (d.kind !== 'st-move' || !d.remap) continue; const hit = d.remap.find(r => r[2] === region && r[3] === k); if (hit) { region = hit[0]; k = hit[1]; } }
        }
        return [region, k];
    }
    function staticState() {
        const node = {}, order = {}, orderBase = {}, sigs = {}, base = {}, html = {};
        const remaps = hasRemaps();
        const at = (region, k, s) => remaps ? renameAt(region, k, s) : [region, k];
        const setOrder = (o, region, parent, keys, s, first) => {
            if (!keys) return;
            const [r, p] = parent ? at(region, parent, s) : [region, ''];
            if (r !== region) return;
            const m = o[r] = o[r] || {};
            if (first && p in m) return;
            m[p] = remaps ? keys.map(k => at(region, k, s)).filter(([rr]) => rr === region).map(([, kk]) => kk) : keys.slice();
        };
        for (let i = 0; i < log.length; i++) {
            const d = log[i];
            if (d.kind === 'st-children') { if (d.html) Object.assign(html[d.region] = html[d.region] || {}, d.html); setOrder(orderBase, d.region, d.parent, d.before, i, true); }
            else if (d.kind === 'st-order') setOrder(orderBase, d.region, d.parent, d.before, i, true);
            else if (d.kind === 'st-move') {
                if (d.html) { (html[d.from] = html[d.from] || {})[d.key] = d.html; (html[d.to] = html[d.to] || {})[d.toKey] = d.html; }
                setOrder(orderBase, d.from, d.fromParent, d.fromBefore, i, true);
                setOrder(orderBase, d.to, d.toParent, d.toBefore, i, true);
            } else if (d.kind === 'st-node') {
                const [region, path] = at(d.region, d.path, i);
                const bk = region + '|' + path;
                const b = base[bk] = base[bk] || {};
                if (!(d.prop in b)) b[d.prop] = d.before;
                if (d.sig) sigs[bk] = d.sig;
            }
        }
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind === 'st-node') { const [region, path] = at(d.region, d.path, i + 1); (node[region] = node[region] || {}); (node[region][path] = node[region][path] || {})[d.prop] = d.value; }
            else if (d.kind === 'st-order' || d.kind === 'st-children') setOrder(order, d.region, d.parent, d.order, i + 1);
            else if (d.kind === 'st-move') { setOrder(order, d.from, d.fromParent, d.fromOrder, i + 1); setOrder(order, d.to, d.toParent, d.toOrder, i + 1); }
        }
        return { node, order, orderBase, sigs, base, html };
    }

    // Data rows: adding/removing records the record itself. In-session only.
    function commitSplice(area, index, record, op) {
        pushDelta({ kind: 'data-splice', region: key(area), source: dataSourceName(area), index, op, record: JSON.parse(JSON.stringify(record)) });
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

    const parentKey = (container, area) => container === area ? '' : (container.getAttribute('data-edit-key') || '');

    // Duplicate, delete, paste: the container's resulting order plus the markup the log introduced or took away.
    function commitStructure(area, container, before, markup) {
        const order = staticKeys(container);
        if (eq(before, order) && !Object.keys(markup || {}).length) return;
        pushDelta({ kind: 'st-children', region: key(area), parent: parentKey(container, area), order, before, html: markup || {} });
    }
    const materialize = (markup, k) => {
        if (!markup) return null;
        const t = document.createElement('template');
        t.innerHTML = markup.trim();
        const el = t.content.firstElementChild;
        if (el && k) el.setAttribute('data-edit-key', k);
        return el;
    };
    function keyMap(area) {
        const m = new Map();
        [area, ...area.querySelectorAll('[data-edit-key]')].forEach(el => {
            if (el.closest('[data-edit-ghost]')) return;
            const k = el.getAttribute('data-edit-key');
            if (k != null && !m.has(k)) m.set(k, el);
        });
        return m;
    }

    function applyStaticProp(el, prop, v) {
        if (v === undefined) return;
        if (prop === 'text') { const safe = sanitizeFor(el, v); if (el.innerHTML !== safe) el.innerHTML = safe; return; }
        if (attrRefusal(prop, v)) return;
        if (prop === 'class') return writeClass(el, v);
        if (v === null || (v === '' && prop === 'style')) { el.removeAttribute(prop); return; }
        if (el.getAttribute(prop) !== v) el.setAttribute(prop, v);
    }

    function applyStaticState() {
        const { node, order, orderBase, sigs, base, html } = staticState();
        areas().forEach(area => {
            if (classify(area) !== 'static') return;
            const region = key(area);
            const byKey = keyMap(area), markup = html[region] || {};
            const want = Object.assign({}, orderBase[region] || {}, order[region] || {});
            const claimed = new Set();
            Object.values(want).forEach(ks => ks.forEach(k => claimed.add(k)));
            let rebuilt = false;
            const get = (k) => {
                let el = byKey.get(k);
                if (!el && markup[k]) {
                    el = materialize(markup[k], k);
                    if (el) { byKey.set(k, el); el.querySelectorAll('[data-edit-key]').forEach(n => { const nk = n.getAttribute('data-edit-key'); if (!byKey.has(nk)) byKey.set(nk, n); }); rebuilt = true; }
                }
                return el;
            };
            const pending = Object.entries(want);
            let progress = true;
            while (pending.length && progress) {
                progress = false;
                for (let i = 0; i < pending.length; i++) {
                    const [parent, keys] = pending[i];
                    const c = parent ? byKey.get(parent) : area;
                    if (!c) continue;
                    pending.splice(i--, 1); progress = true;
                    const kids = sortableChildren(c);
                    const next = keys.map(get).filter(el => el && el !== c && !el.contains(c));
                    const stay = kids.filter(el => !next.includes(el) && !claimed.has(el.getAttribute('data-edit-key')) && !markup[el.getAttribute('data-edit-key')]);
                    const target = [...next, ...stay];
                    if (target.length === kids.length && target.every((el, j) => el === kids[j])) continue;
                    const anchor = kids.length ? kids[kids.length - 1].nextSibling : Array.from(c.children).find(pluginNode) || null;
                    kids.forEach(el => { if (!target.includes(el)) el.remove(); });
                    target.forEach(el => c.insertBefore(el, anchor && anchor.parentNode === c ? anchor : null));
                    rebuilt = true;
                }
            }
            const live = rebuilt ? keyMap(area) : byKey;
            live.forEach((el, p) => {
                const bk = region + '|' + p;
                const ops = (node[region] || {})[p], baseline = base[bk];
                if (!ops && !baseline) return;
                const expect = sigs[bk]; if (expect && nodeSig(el) !== expect) { console.warn('[edit] skip stale static node', region, p); return; }
                const props = new Set([...Object.keys(ops || {}), ...Object.keys(baseline || {})]);
                props.forEach(prop => applyStaticProp(el, prop, ops && ops[prop] !== undefined ? ops[prop] : baseline && baseline[prop]));
            });
            if (rebuilt) { markStatic(area); if (area._armed && isActive(area)) armArea(area); }
        });
    }

    // One delta per committed change. `opts.before` overrides the captured baseline;
    // `opts.coalesce` folds a quick follow-up change to the same prop into the last delta.
    function commitStaticNode(area, el, prop, value, opts = {}) {
        const region = key(area), path = el.getAttribute('data-edit-key');
        if (!path) return false;
        if (prop === 'text') value = sanitizeFor(el, value);
        let before = opts.before;
        if (before === undefined) {
            const fallback = prop === 'text' ? area._baseText && area._baseText[path] : prop === 'class' ? area._baseClass && area._baseClass[path] : prop === 'style' ? area._baseStyle && area._baseStyle[path] : el.getAttribute(prop);
            const pre = prop === 'text' ? el._preEdit : prop === 'class' ? el._preClass : prop === 'style' ? el._preStyle : undefined;
            before = pre !== undefined ? pre : fallback;
        }
        if (before === value) return false;
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
    function applyDataValues() {
        const st = dataValueState();
        areas().forEach(area => {
            if (classify(area) !== 'data') return;
            const source = dataSourceName(area), recs = st[source]; if (!recs) return;
            const tpl = area.querySelector('template[x-for]'), expr = dataSourceExpr(area);
            try { const arr = window.Alpine.evaluate(tpl, expr); if (Array.isArray(arr)) Object.entries(recs).forEach(([id, fields]) => { const rec = arr.find(r => String(r.id) === String(id)); if (rec) Object.entries(fields).forEach(([f, v]) => { if (rec[f] !== v) rec[f] = v; }); }); } catch { }
            if (isActive(area)) setTimeout(() => armDataValues(area), 0);
        });
    }
    function commitDataValue(area, source, id, field, value, el) {
        value = String(value);
        if (el && el._editRich) value = sanitizeFor(el, value);
        const before = el ? el._preEdit : undefined;
        if (before === value) return;
        pushDelta({ kind: 'data-val', region: key(area), source, id, field, value, before });
        applyDataValues();
    }

    // Size and freeform placement write inline style.
    function commitStyle(area, el, opts) {
        const v = el.getAttribute('style') || '', kind = classify(area);
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
    // Positional re-key of a region, as a fresh session would derive it. Returns [old, new] renames.
    function rekeyRegion(area) {
        const seen = Object.create(null), changes = [];
        for (const el of [area, ...area.querySelectorAll('*')]) {
            if (el.hasAttribute('data-edit-handle') || el.hasAttribute('data-edit-ghost')) continue;
            if (el.parentElement && el.parentElement.closest('[data-text-edit]')) continue;
            const cur = el.getAttribute('data-edit-key');
            const base = cur ? ((/^([\s\S]*)#\d+$/.exec(cur) || [, cur])[1]) : staticKey(el);
            const n = seen[base] = (seen[base] || 0) + 1;
            const k = n > 1 ? base + '#' + n : base;
            if (cur !== k) { el.setAttribute('data-edit-key', k); if (cur) changes.push([cur, k]); }
        }
        return changes;
    }
    function applyMoveKeys(d, invert) {
        if (!d.remap) return;
        const jobs = [];
        for (const [r, o, r2, n] of d.remap) {
            if (r !== r2) continue;
            const a = areaByKey(r); if (!a) continue;
            const findKey = invert ? n : o, setKey = invert ? o : n;
            const el = [a, ...a.querySelectorAll('[data-edit-key]')].find(e => e.getAttribute('data-edit-key') === findKey);
            if (el) jobs.push([el, setKey]);
        }
        jobs.forEach(([el, k]) => el.setAttribute('data-edit-key', k));
    }
    // A piece that already sits in its new container. Same region: identity is kept.
    // Across regions: both regions are re-keyed positionally and the renames ride the delta.
    function commitMove(fromArea, toArea, item, fromContainer, fromBefore, toBefore, opts = {}) {
        const from = key(fromArea), to = key(toArea), toContainer = item.parentElement;
        const fromParent = parentKey(fromContainer, fromArea);
        const fromKey = item.getAttribute('data-edit-key') || staticKey(item);
        let toKey = fromKey, remap = [];
        if (from !== to) {
            const descOld = [...item.querySelectorAll('[data-edit-key]')].map(n => [n, n.getAttribute('data-edit-key')]);
            item.removeAttribute('data-edit-key');
            item.querySelectorAll('[data-edit-key]').forEach(n => n.removeAttribute('data-edit-key'));
            const fromPairs = rekeyRegion(fromArea).map(([o, n]) => [from, o, from, n]);
            const toPairs = rekeyRegion(toArea).map(([o, n]) => [to, o, to, n]);
            toKey = item.getAttribute('data-edit-key');
            remap = [[from, fromKey, to, toKey]];
            descOld.forEach(([n, o]) => { const nk = n.getAttribute('data-edit-key'); if (nk) remap.push([from, o, to, nk]); });
            remap.push(...fromPairs, ...toPairs);
        }
        const d = { kind: 'st-move', from, to, fromParent, toParent: parentKey(toContainer, toArea), key: fromKey, toKey, fromOrder: staticKeys(fromContainer), toOrder: staticKeys(toContainer), fromBefore, toBefore, html: blockHTML(item, true), remap };
        if (opts.join) d.join = true;
        pushDelta(d);
        resetAreas();
        markStatic(fromArea);
        if (toArea !== fromArea) armArea(toArea); else if (isActive(fromArea)) armArea(fromArea);
        return d;
    }

    /* ---- Locks: runtime per-action locks, logged ---- */
    let lockVer = -1, lockMap = new Map();
    function lockState() {
        if (lockVer === ver) return lockMap;
        lockMap = new Map();
        for (let i = 0; i < cursor; i++) {
            const d = log[i]; if (d.kind !== 'lock') continue;
            const r = lockMap.get(d.region) || new Map(); lockMap.set(d.region, r);
            const m = r.get(d.key) || new Map(); r.set(d.key, m);
            (d.actions && d.actions.length ? d.actions : LOCK_ACTIONS).forEach(a => m.set(a, d.value));
        }
        lockVer = ver;
        return lockMap;
    }
    function identity(el, area) {
        if (el === area) return '';
        const kind = classify(area);
        if (kind === 'static') return el.getAttribute('data-edit-key');
        if (kind === 'component') return el._editPath != null ? 'path:' + el._editPath : null;
        const list = area.querySelector('template[x-for]');
        if (list && el.parentElement === list.parentElement) { const k = itemKey(el, area); return k == null ? null : 'row:' + k; }
        return null;
    }
    const actionOf = (cap) => cap === 'data' ? 'text' : cap;
    function lockedFor(node, cap) {
        const action = actionOf(cap);
        const region = regionOf(node);
        const rl = region && lockState().get(key(region));
        for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
            let v;
            if (rl && rl.size) { const id = identity(n, region); const m = id != null && rl.get(id); if (m && m.has(action)) v = m.get(action); }
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
        const el = d.key === '' ? area : [...area.querySelectorAll('[x-show]')].find(n => identity(n, area) === d.key);
        if (!el) return;
        try { setShow(el, d.expr, back ? d.before : d.value); } catch { }
    }
    function step(d, back) {
        if (d.kind === 'show') { applyShow(d, back); return null; }
        if (d.kind === 'st-move') applyMoveKeys(d, back);
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
