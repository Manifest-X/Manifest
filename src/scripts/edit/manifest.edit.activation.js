    /* ---- Arm / disarm an area for its regime + caps ---- */
    // Static: address each element by structural path, capture per-node baselines
    // and child order so edits store as typed ops/permutations.
    function markStatic(area) {
        area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {}; area._baseText = area._baseText || {};
        const markEl = (el) => { const p = pathOf(el, area); el.setAttribute('data-edit-path', p); if (!(p in area._baseClass)) area._baseClass[p] = el.getAttribute('class') || ''; if (!(p in area._baseStyle)) area._baseStyle[p] = el.getAttribute('style') || ''; };
        markEl(area);
        area.querySelectorAll('*').forEach(el => { if (!el.classList.contains('edit-handle')) markEl(el); });
        if (!area._baseOrder) area._baseOrder = sortableChildren(area).map(staticKey);
        if (!(key(area) in lastOrder)) lastOrder[key(area)] = area._baseOrder;
    }
    function armArea(area) {
        const kind = classify(area);
        area.setAttribute('data-edit-armed', '');
        area.setAttribute('data-edit-label', kind === 'component' ? `${key(area)} · component · ${area._editScope || 'instance'}` : `${key(area)} · ${kind}`);
        if (kind === 'static') markStatic(area);
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(c => { if (capOf(c, 'sort') && !locked(c)) makeSortable(c); });
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(c => { if (ownsCap(c, 'size')) armSize(c); });
        if (kind === 'component') armComponent(area); else armText(area);
        if (kind === 'static') armStyle(area);
        if (kind === 'data' && capOf(area, 'data')) armDataValues(area);
    }
    function disarmArea(area) {
        area.querySelectorAll('.edit-handle').forEach(h => h.remove());
        area.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
        area.querySelectorAll('[data-edit-sortable]').forEach(e => { ['data-edit-sortable', 'data-edit-grabbed', 'data-edit-dragging', 'tabindex', 'role', 'draggable'].forEach(a => e.removeAttribute(a)); e._dragBound = false; });
        [area, ...area.querySelectorAll('[data-edit-sizable],[data-edit-movable]')].forEach(e => { e.removeAttribute('data-edit-sizable'); e.removeAttribute('data-edit-movable'); e._sizeBound = false; });
        area.removeAttribute('data-edit-armed'); area.removeAttribute('data-edit-label');
    }

    /* ---- Activation: per-area, always-on by default (.gated needs $edit.on()) ---- */
    let estore;
    const isActive = (a) => !!a && (!a._edit.gated || (estore && estore.active));
    const anyActive = () => areas().some(isActive);
    function armAll() { areas().forEach(a => { if (isActive(a) && !a._armed) { lastSnap[key(a)] = snapshot(a, classify(a)); armArea(a); a._armed = true; } }); armThemeControls(); refresh(); }
    // Build B-side source patches from the edit set (storage-agnostic; overlay
    // already auto-persists to localStorage on commit).
    function buildPatches() {
        const patches = Object.entries(fold()).map(([k, v]) => patchFor(k, v.kind, v.snap));   // data
        const toEdits = (paths) => { const e = []; Object.entries(paths).forEach(([p, props]) => Object.entries(props).forEach(([prop, value]) => e.push({ path: p, prop, value }))); return e; };
        const ss = staticState();   // static: per-node ops + reorder permutation (no whole HTML)
        new Set([...Object.keys(ss.node), ...Object.keys(ss.order)]).forEach(region => {
            const edits = toEdits(ss.node[region] || {});
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
        if (val) { el.querySelectorAll('.edit-handle').forEach(h => h.remove()); el.removeAttribute('draggable'); el.removeAttribute('contenteditable'); el.removeAttribute('data-edit-sizable'); el._sizeBound = false; el.querySelectorAll('[draggable],[contenteditable]').forEach(n => { n.removeAttribute('draggable'); n.removeAttribute('contenteditable'); }); }
        const area = areas().find(a => a === el || a.contains(el));
        if (area && isActive(area)) armArea(area);
    }
