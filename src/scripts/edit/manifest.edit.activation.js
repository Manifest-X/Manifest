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
    let estore;
    const isActive = (a) => !!a && (!a._edit.gated || (estore && estore.active));
    const anyActive = () => areas().some(isActive);
    function armAll() { areas().forEach(a => { if (isActive(a) && !a._armed) { lastSnap[key(a)] = snapshot(a, classify(a)); armArea(a); a._armed = true; } }); armThemeControls(); refresh(); }
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
