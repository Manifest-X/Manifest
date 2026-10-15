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
            const comp = componentName(area), region = key(area), root = cmpRoot(area); if (!root) return;
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
        roots.forEach(area => area.querySelectorAll('[data-edit-host]').forEach(el => { const k = el.getAttribute('data-edit-host'); if (!m.has(k)) m.set(k, el); }));
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

    // Edits whose element is gone from the source (an external change rewrote it): shown
    // nowhere and never publishable, so they are surfaced ($edit.conflicts, `edit:conflict`,
    // a warning) and dropped from the log. Checked against a freshly rendered source only.
    function surfaceConflicts(fresh) {
        // Only regions keyed on this page load: an unarmed (gated) region has no keys yet
        const live = keyMap(staticAreas()), lost = [], regions = new Set(fresh.filter(a => a._marked).map(key));
        const isStatic = (r) => regions.has(r) && !!areaByKey(r) && classify(areaByKey(r)) === 'static';
        // Structure: a container the log restructured must still hold what the log started from.
        // Children matched by position and tag whose own text changed in place are renamed to
        // their new keys, so the reorder still applies, but only if no structural edit moved,
        // added or removed them. Otherwise every structural edit of that region goes (the
        // writer would refuse them), reported with the children that changed.
        const first = new Map(), broken = new Map(), renames = new Map();
        const note = (region, parent, before) => { const k = JSON.stringify([region, parent]); if (!first.has(k) && isStatic(region)) first.set(k, [region, parent, before || []]); };
        log.forEach(d => {
            if (d.kind === 'st-order' || d.kind === 'st-children') note(d.region, d.parent, d.before);
            if (d.kind === 'st-move') { note(d.from, d.fromParent, d.fromBefore); note(d.to, d.toParent, d.toBefore); }
        });
        const tagOf = (k) => String(k).slice(String(k).indexOf('@', 1) + 1).split(':')[0];
        // Keys a structural edit moved (out of the longest kept order), added or removed in a container
        const moved = (region, parent) => {
            const out = new Set();
            const diff = (before, after) => {
                before = before || []; after = after || [];
                before.forEach(k => { if (!after.includes(k)) out.add(k); });
                after.forEach(k => { if (!before.includes(k)) out.add(k); });
                const pos = after.filter(k => before.includes(k)).map(k => before.indexOf(k));
                const tails = [], prev = new Array(pos.length).fill(-1), idx = [];
                pos.forEach((p, i) => { let lo = 0, hi = tails.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pos[tails[m]] < p) lo = m + 1; else hi = m; } if (lo > 0) prev[i] = tails[lo - 1]; tails[lo] = i; });
                const keep = new Set(); for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
                after.filter(k => before.includes(k)).forEach((k, i) => { if (!keep.has(i)) out.add(k); });
            };
            log.forEach(d => {
                if ((d.kind === 'st-order' || d.kind === 'st-children') && d.region === region && (d.parent || '') === parent) diff(d.before, d.order);
                if (d.kind === 'st-move') {
                    if (d.from === region && (d.fromParent || '') === parent) { out.add(d.key); diff(d.fromBefore, d.fromOrder); }
                    if (d.to === region && (d.toParent || '') === parent) { out.add(d.key); diff(d.toBefore, d.toOrder); }
                }
            });
            return out;
        };
        first.forEach(([region, parent, before]) => {
            let c = parent === '' ? areaByKey(region) : live.get(parent), renamedParent = null;
            if (!c && parent !== '') {
                // The container's own key changed with a child's text: found again through its unchanged children
                const holders = new Set(before.map(k => live.get(k)).filter(Boolean).map(el => el.parentElement));
                if (holders.size === 1) { c = [...holders][0]; renamedParent = c.getAttribute('data-edit-key'); }
            }
            const now = c ? staticKeys(c) : [];
            if (c && now.join('\n') === before.join('\n') && !renamedParent) return;
            const changed = [];
            before.forEach((k, i) => { if (now[i] !== k) changed.push({ was: k, now: now[i] ?? null }); });
            now.slice(before.length).forEach(k => changed.push({ was: null, now: k }));
            const shift = moved(region, parent);
            const same = !!c && now.length === before.length && before.every((k, i) => tagOf(k) === tagOf(now[i]));
            // A rename is a child whose own text changed in place: its old key is gone from the whole
            // new source and its new key is new to the log (else elements were swapped or moved,
            // which position cannot tell from a rename), its opening tag unchanged where a copy
            // recorded it. Anything else is a conflict.
            const known = new Set();
            log.forEach(d => [d.before, d.order, d.fromBefore, d.toBefore, d.fromOrder, d.toOrder].forEach(a => Array.isArray(a) && a.forEach(k => known.add(k))));
            const openTag = (el) => { const c2 = el.cloneNode(false); [...c2.attributes].forEach(a => { if (/^(data-edit-|data-rich-text|contenteditable$|role$|aria-multiline$|tabindex$)/.test(a.name)) c2.removeAttribute(a.name); }); return c2.outerHTML.replace(/<\/[^>]+>$/, ''); };
            const copyTag = (k) => { for (const d of log) if (d.kind === 'st-children' && d.html) for (const [ck, h] of Object.entries(d.html)) if (ck[0] === '~' && originOf(ck) === k) { const t = document.createElement('template'); t.innerHTML = h; const e = t.content.firstElementChild; if (e) return openTag(e); } return null; };
            const renamable = (x) => !!x.was && !!x.now && x.was[0] === '@' && !live.has(x.was) && !known.has(x.now)
                && (() => { const t = copyTag(x.was), el = live.get(x.now); return !t || !el || t === openTag(el); })();
            if (same && changed.every(x => renamable(x) && !shift.has(x.was))) {
                const m = renames.get(region) || new Map();
                changed.forEach(x => m.set(x.was, x.now));
                if (renamedParent && renamedParent !== parent) m.set(parent, renamedParent);
                renames.set(region, m);
            } else broken.set(region, [...(broken.get(region) || []), { container: parent, changed: changed.map(x => ({ was: x.was && tagOf(x.was) && x.was.slice(x.was.indexOf('@', 1) + 1), now: x.now && x.now.slice(x.now.indexOf('@', 1) + 1) })) }]);
        });
        // Renamed children keep their place in every structural edit (their own text edits stay conflicts)
        renames.forEach((m, region) => {
            if (broken.has(region)) return;
            const ren = (k) => typeof k !== 'string' ? k : m.has(k) ? m.get(k) : k[0] === '~' && m.has(originOf(k)) ? k.slice(0, k.length - originOf(k).length) + m.get(originOf(k)) : k;
            const arr = (a) => Array.isArray(a) ? a.map(ren) : a;
            const enc = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;'), dec = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            const markup = (h) => typeof h === 'string' ? h.replace(/data-edit-key="([^"]*)"/g, (all, v) => `data-edit-key="${enc(ren(dec(v)))}"`) : h;
            // A copy with no text of its own follows its source, as the writer copies it: shown = published
            const typedCopy = (k) => log.some(d => d.kind === 'st-node' && d.path === k && d.prop === 'text');
            const follow = (k, v) => {
                if (k[0] !== '~' || !m.has(originOf(k)) || typedCopy(k)) return markup(v);
                const src = live.get(m.get(originOf(k))); if (!src) return markup(v);
                const t = document.createElement('template'); t.innerHTML = blockHTML(src, true);
                const prefix = k.slice(0, k.length - originOf(k).length);
                [t.content.firstElementChild, ...t.content.firstElementChild.querySelectorAll('[data-edit-key]')].forEach(n => { const nk = n.getAttribute('data-edit-key'); if (nk && nk[0] === '@') n.setAttribute('data-edit-key', prefix + nk); });
                return t.innerHTML;
            };
            const keyed = (o) => o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [ren(k), follow(k, v)])) : o;
            log.forEach(d => {
                if ((d.kind === 'st-order' || d.kind === 'st-children') && d.region === region) { d.parent = ren(d.parent); d.before = arr(d.before); d.order = arr(d.order); if (d.html) d.html = keyed(d.html); if (d.copies) d.copies = Object.fromEntries(Object.entries(d.copies).map(([k, v]) => [ren(k), v])); }
                if (d.kind === 'st-node' && d.region === region && typeof d.path === 'string' && d.path[0] === '~') d.path = ren(d.path);   // a copy is new content: its edits follow its source's new key
                if (d.kind === 'st-move' && (d.from === region || d.to === region)) { d.key = ren(d.key); d.fromParent = ren(d.fromParent); d.toParent = ren(d.toParent); d.fromBefore = arr(d.fromBefore); d.toBefore = arr(d.toBefore); d.fromOrder = arr(d.fromOrder); d.toOrder = arr(d.toOrder); }
                if (d.kind === 'lock' && d.region === region) d.key = ren(d.key);
            });
            ver++;
        });
        const structural = (d) => ((d.kind === 'st-order' || d.kind === 'st-children') && broken.has(d.region)) || (d.kind === 'st-move' && (broken.has(d.from) || broken.has(d.to)))
            || (d.kind === 'st-node' && broken.has(d.region) && typeof d.path === 'string' && d.path[0] === '~');
        const gone = (d) => (d.kind === 'st-node' && typeof d.path === 'string' && d.path[0] === '@' && isStatic(d.region) && !live.has(d.path)) || structural(d);
        log.forEach((d, i) => { if (gone(d) && i < cursor && d.kind === 'st-node' && d.path[0] === '@') lost.push(d); });
        if (!log.some(gone)) { if (renames.size) saveState(); return []; }
        const latest = new Map();
        lost.forEach(d => latest.set(d.path + '|' + d.prop, d));
        const label = (k) => typeof k === 'string' ? originOf(k).slice(originOf(k).indexOf('@', 1) + 1) : '';
        const found = [...latest.values()].map(d => ({ region: d.region, key: d.path, element: label(d.path), prop: d.prop, value: d.value, before: d.before,
            reason: `${label(d.path)} changed in the source, so the ${d.prop === 'text' ? 'text' : d.prop} edited into it was not applied` }));
        // A dropped structure carries what it held: the children that changed, the elements it moved,
        // and every copy it made, with the copy's markup and the text typed into it
        broken.forEach((containers, region) => {
            const deltas = log.filter((d, i) => i < cursor && structural(d) && (d.region === region || d.from === region || d.to === region));
            const movedKeys = new Set(), copies = [];
            deltas.forEach(d => {
                if (d.kind === 'st-move') movedKeys.add(d.key);
                if (d.kind === 'st-order' || d.kind === 'st-children') moved(region, d.parent || '').forEach(k => movedKeys.add(k));
                if (d.kind === 'st-children' && d.html) Object.entries(d.html).forEach(([k, h]) => {
                    if (k[0] !== '~') return;
                    const t = document.createElement('template'); t.innerHTML = h;
                    const typed = log.filter((x, i) => i < cursor && x.kind === 'st-node' && x.path === k && x.prop === 'text').pop();
                    copies.push({ of: label(k), html: h, text: typed ? typed.value : t.content.textContent.trim() });
                });
            });
            const changed = containers.flatMap(c => c.changed);
            const moves = [...movedKeys].filter(k => k && k[0] === '@').map(label);
            const what = [moves.length && `moved ${moves.join(', ')}`, copies.length && `copied ${copies.map(c => `${c.of} ("${String(c.text).slice(0, 40)}")`).join(', ')}`].filter(Boolean).join('; ');
            found.push({ region, key: '', element: containers.map(c => c.container ? label(c.container) : region).join(', '), prop: 'structure',
                value: { changed, moved: moves, copies }, before: null,
                reason: `${changed.map(x => x.was || x.now).join(', ')} changed in the source where the layout was edited, so the layout edits (${what || 'reordering'}) were not applied` });
        });
        found.forEach(f => { conflicts.push(f); if (persistOf(f.region)) keptConflicts.add(f); });
        let c = 0;
        log = log.filter((d, i) => { const keep = !gone(d); if (keep && i < cursor) c++; return keep; });
        cursor = c; ver++;
        saveState(); refresh();
        if (found.length) {
            if (estore) estore.conflicts = conflicts.slice();
            console.warn('[edit] edits to elements that changed in the source were dropped:\n' + found.map(f => '  ' + f.reason + (f.prop === 'structure' ? '' : `: "${String(f.value).slice(0, 80)}"`)).join('\n'));
            document.dispatchEvent(new CustomEvent('edit:conflict', { detail: { conflicts: found } }));
        }
        return found;
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
                // A component host's other roots go with its first
                const group = (el) => { const g = [el]; if (el._manifestHost) for (let n = el.nextElementSibling; n && n._manifestHost === el._manifestHost; n = n.nextElementSibling) g.push(n); return g; };
                const next = keys.map(get).filter(el => el && el !== c && !el.contains(c)).flatMap(el => el.hasAttribute('data-edit-host') ? group(el) : [el]);
                const idOf = (el) => el.getAttribute('data-edit-host') || el.getAttribute('data-edit-key');
                const stay = kids.filter(el => !next.includes(el) && !claimed.has(idOf(el)) && !html[idOf(el)]);
                const target = [...next, ...stay];
                if (target.length === kids.length && target.every((el, j) => el === kids[j])) continue;
                const anchor = kids.length ? kids[kids.length - 1].nextSibling : Array.from(c.children).find(pluginNode) || null;
                const leads = new Map(target.map(el => [el, el.isConnected ? leadNodes(el) : el._editLead || []]));
                kids.forEach(el => { if (target.includes(el)) return; el._editLead = leadNodes(el); el._editLead.forEach(n => n.remove()); el.remove(); const k = idOf(el); if (k) detached.set(k, el); });
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
