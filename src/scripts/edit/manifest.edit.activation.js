    /* ---- Arm / disarm ---- */
    // Content-derived keys, assigned once per element and never recomputed, so a text
    // edit keeps the address and a reload of the same source derives the same keys.
    function markStatic(area) {
        area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {}; area._baseText = area._baseText || {};
        const seen = Object.create(null);
        const markEl = (el) => {
            let k = el.getAttribute('data-edit-key');
            if (k) {
                const m = /^([\s\S]*)#(\d+)$/.exec(k);
                const base = m ? m[1] : k, n = m ? m[2] : undefined;
                seen[base] = Math.max(seen[base] || 0, n ? +n : 1);
            } else {
                const base = staticKey(el);
                const n = seen[base] = (seen[base] || 0) + 1;
                k = n > 1 ? base + '#' + n : base;
                el.setAttribute('data-edit-key', k);
            }
            if (!(k in area._baseClass)) area._baseClass[k] = readClass(el);
            if (!(k in area._baseStyle)) area._baseStyle[k] = el.getAttribute('style') || '';
            if (!(k in area._baseText) && !el.children.length) area._baseText[k] = el.innerHTML.trim();
        };
        markEl(area);
        area.querySelectorAll('*').forEach(el => {
            if (pluginNode(el) || el.closest('[data-edit-ghost]')) return;
            if (el.parentElement && el.parentElement.closest('[data-text-edit]')) return;
            markEl(el);
        });
        if (!area._baseOrder) area._baseOrder = staticKeys(area);
    }
    function armArea(area) {
        const kind = classify(area);
        if (kind === 'static') markStatic(area);
        markPieces(area);
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(c => { if (ownsCap(c, 'size')) armSize(c); });
        if (kind === 'component') armComponent(area); else armText(area);
        if (kind === 'data' && capOf(area, 'data')) armDataValues(area);
        if (!area._editBound) {
            area._editBound = true;
            area.addEventListener('pointerdown', onAreaPointerDown);
            area.addEventListener('keydown', (e) => { if (isActive(area)) onPieceKeydown(e, area); });
            area.addEventListener('pointerover', (e) => { if (isActive(area)) gripOver(e, area); });
            area.addEventListener('pointerleave', (e) => gripLeave(e.relatedTarget));
            area.addEventListener('focusin', (e) => { if (isActive(area)) gripFocus(e, area); });
            area.addEventListener('focusout', (e) => gripBlur(e.relatedTarget));
            // Native HTML5 drag would drop selected text into neighbouring leaves.
            area.addEventListener('dragstart', (e) => { if (isActive(area)) e.preventDefault(); });
            area.addEventListener('drop', (e) => { if (isActive(area)) e.preventDefault(); });
        }
        if (!area._editObserver) {
            area._editObserver = new MutationObserver((recs) => {
                if (dragged || area._rearmQueued || recs.every(r => r.target.isContentEditable)) return;
                area._rearmQueued = true;
                queueMicrotask(() => { area._rearmQueued = false; if (area._armed && isActive(area) && !dragged) armArea(area); });
            });
            area._editObserver.observe(area, { childList: true, subtree: true });
        }
    }
    function disarmArea(area) {
        if (gripFor && area.contains(gripFor)) hideGrip();
        area.querySelectorAll('[data-edit-handle]').forEach(h => h.remove());
        [area, ...area.querySelectorAll('[contenteditable]')].forEach(e => { if (e.hasAttribute('contenteditable')) e.removeAttribute('contenteditable'); e._pieceMode = false; });
        area.querySelectorAll('[data-edit-piece]').forEach(unmarkPiece);
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(e => { e._sizeBound = false; });
        if (grabbed && area.contains(grabbed.item)) cancelGrab();
    }

    /* ---- Activation: always-on by default; .gated waits for $edit.on() ---- */
    let estore, booted = false, armQueued = false;
    const isActive = (a) => !!a && !!a._edit && (!a._edit.gated || !!(estore && estore.active));
    function armAll() { areas().forEach(a => { if (isActive(a) && !a._armed) { lastSnap[key(a)] = snapshot(a, classify(a)); armArea(a); a._armed = true; } }); armThemeControls(); refresh(); booted = true; }

    // Regions rendered after boot (x-if, routes, lazy components) arm through the directive.
    function armLater() {
        if (!booted || armQueued) return;
        armQueued = true;
        queueMicrotask(() => { armQueued = false; armAll(); });
    }
    function releaseEdit(el) {
        Object.keys(themeScopes).forEach(k => { if (themeScopes[k] === el) delete themeScopes[k]; });
        cssvarControls.delete(el);
        if (!editEls.has(el)) return;
        if (el._armed) { disarmArea(el); el._armed = false; }
        if (el._editObserver) { el._editObserver.disconnect(); el._editObserver = null; }
        editEls.delete(el); delete el._edit; resetAreas();
        el.removeAttribute('data-edit-area');
        if (target && (target === el || el.contains(target))) setTarget(null);
        refresh();
    }

    /* ---- Source patches: every area ---- */
    function buildPatches() {
        const patches = Object.entries(fold()).map(([k, v]) => patchFor(k, v.kind, v.snap));
        const toEdits = (paths, area, fileOrder) => {
            const e = [];
            Object.entries(paths).forEach(([k, props]) => {
                const el = area && (area.getAttribute('data-edit-key') === k ? area : area.querySelector(`[data-edit-key="${CSS.escape(k)}"]`));
                let path = el ? pathOf(el, area) : k;
                if (area && !el) return;
                // A pending structural change can't reach the file: address the unmodified file order.
                if (el && el !== area && fileOrder) {
                    let block = el; while (block.parentElement && block.parentElement !== area) block = block.parentElement;
                    const fi = fileOrder.indexOf(block.getAttribute('data-edit-key'));
                    if (fi < 0) return;
                    const segs = path.split('.'); segs[0] = String(fi); path = segs.join('.');
                }
                Object.entries(props).forEach(([prop, value]) => e.push({ path, key: k, prop, value }));
            });
            return e;
        };
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind !== 'st-move') continue;
            const p = { kind: 'static-move', from: d.from, to: d.to, key: d.key, toKey: d.toKey, toOrder: d.toOrder };
            if (d.fromParent) p.fromParent = d.fromParent;
            if (d.toParent) p.toParent = d.toParent;
            patches.push(p);
        }
        const ss = staticState();
        new Set([...Object.keys(ss.node), ...Object.keys(ss.order)]).forEach(region => {
            const area = areaByKey(region);
            const structural = log.slice(0, cursor).some(d => d.kind === 'st-children' && d.region === region && !d.parent);
            const edits = toEdits(ss.node[region] || {}, area, structural ? (area && area._baseOrder) || [] : null);
            const orders = ss.order[region] || {};
            const order = orders[''] || null;
            const nested = Object.fromEntries(Object.entries(orders).filter(([p]) => p));
            const patch = { kind: 'static', region, edits, order };
            if (Object.keys(nested).length) patch.orders = nested;
            if (edits.length || order || patch.orders) patches.push(patch);
        });
        const dv = dataValueState();
        Object.entries(dv).forEach(([source, recs]) => Object.entries(recs).forEach(([id, fields]) => Object.entries(fields).forEach(([field, value]) => patches.push({ kind: 'data-val', source, id, field, value }))));
        const { main, inst, reverts } = componentState();
        Object.entries(main).forEach(([component, paths]) => { const edits = toEdits(paths); if (edits.length) patches.push({ kind: 'component', scope: 'main', component, edits }); });
        new Set([...Object.keys(inst), ...Object.keys(reverts)]).forEach(region => {
            const area = areaByKey(region); if (!area) return;
            const edits = toEdits(inst[region] || {}), rv = [...(reverts[region] || [])];
            if (edits.length || rv.length) patches.push({ kind: 'component', scope: 'instance', component: componentName(area), region, edits, reverts: rv });
        });
        themePatches().forEach(p => patches.push(p));
        return patches;
    }
    function publish() {
        const patches = buildPatches();
        if (estore && typeof estore.onPublish === 'function') return Promise.resolve(estore.onPublish(patches, { log, cursor }));
        if (!patches.length) return Promise.resolve({ results: [] });
        return fetch('/__edit/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patches) }).then(r => r.json());
    }
    function on() { if (estore) estore.active = true; armAll(); }
    function off() {
        if (estore) estore.active = false;
        areas().forEach(a => { if (a._edit.gated && a._armed) { disarmArea(a); a._armed = false; } });
        refresh();
    }
