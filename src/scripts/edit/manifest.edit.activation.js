    /* ---- Arm / disarm ---- */
    // Identity is assigned once, on the first mark, from what the source holds: the
    // origin area plus a content key (ordinal per repeat), and the element's path.
    // Later arrivals that are not copies get a non-source id and never publish.
    const originAt = new Map();
    function markStatic(area) {
        const region = key(area), first = !area._marked;
        area._marked = true;
        area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {}; area._baseText = area._baseText || {};
        const seen = Object.create(null);
        const markEl = (el, path) => {
            let k = el.getAttribute('data-edit-key');
            if (!k) {
                if (first) {
                    const base = staticKey(el);
                    const n = seen[base] = (seen[base] || 0) + 1;
                    k = canonKey(region, n > 1 ? base + '#' + n : base);
                    originAt.set(k, path);
                } else k = '!' + mint();
                el.setAttribute('data-edit-key', k);
            }
            if (!(k in area._baseClass)) area._baseClass[k] = readClass(el);
            if (!(k in area._baseStyle)) area._baseStyle[k] = ownStyle(el);
            if (!(k in area._baseText) && !el.children.length) area._baseText[k] = el.innerHTML.trim();
        };
        // Inside a Rich Text leaf: counted, as the source writer counts them, never keyed.
        const count = (el) => { for (const c of el.children) { const b = staticKey(c); seen[b] = (seen[b] || 0) + 1; count(c); } };
        // The writer never descends into x-rich-text* hosts (fields, menus, controls) or rendered hosts.
        const opaque = (el) => authoredRich(el) || isRendered(el) || [...el.attributes].some(a => a.name.startsWith('x-rich-text'));
        const walk = (el, path) => {
            markEl(el, path);
            if (el !== area && opaque(el)) return;
            if (el._editRt || ((first || el._editRtFormat) && wholeLeaf(el) && capOf(el, 'text') && !isRendered(el))) { if (first) count(el); return; }
            let i = 0;
            for (const c of el.children) {
                if (pluginNode(c) || c.closest('[data-edit-ghost]') || isGenerated(c)) continue;
                walk(c, path === '' ? String(i) : path + '.' + i);
                i++;
            }
        };
        walk(area, '');
    }
    function armArea(area) {
        uneditIn(null);
        const kind = classify(area);
        if (kind === 'static') markStatic(area);
        markPieces(area);
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(c => { if (ownsCap(c, 'size')) armSize(c); });
        if (kind === 'component') armComponent(area); else if (kind === 'static') armText(area);
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
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(e => { if (e._editPos) { e.style.removeProperty('position'); e._editPos = false; } });
        area.querySelectorAll('[data-edit-handle]').forEach(h => h.remove());
        uneditIn(area);
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

    /* ---- Source patches: every area ----
       A static area publishes its FINAL structure as a tree of identities. Each node
       names a source element (key, plus its origin path as a fallback), carries its
       own edits, and lists children only where structure changed beneath it; a node
       without children keeps its source markup. Copies name the element they copy.
       Removed source elements are listed so the writer can tell them from omissions. */
    const treeKids = (el) => realChildren(el).filter(c => !isGenerated(c));
    function staticTrees(ss) {
        const out = [];
        const editsFor = (id) => {
            const ops = ss.node[id]; if (!ops) return null;
            const e = {};
            Object.entries(ops).forEach(([prop, v]) => { e[prop] = (prop === 'class' || prop === 'style') && v === '' ? null : v; });
            return Object.keys(e).length ? e : null;
        };
        const nontrivial = (n) => n.edits || n.children || n.key[0] === '~';
        const live = keyMap(staticAreas());
        staticAreas().forEach(area => {
            const region = key(area);
            const build = (el, isRoot) => {
                const id = el.getAttribute('data-edit-key');
                if (!id || id[0] === '!') return null;
                const n = { key: id };
                const at = originAt.get(originOf(id)); if (at != null) n.at = at;
                const e = editsFor(id); if (e) n.edits = e;
                if (!(e && 'text' in e) && !isRendered(el) && !el.hasAttribute('data-rich-text')) {
                    const kids = treeKids(el).map(c => build(c)).filter(Boolean);
                    if (id[0] === '~' || ss.touched.has(isRoot ? '#' + region : id) || kids.some(nontrivial)) n.children = kids;
                }
                return n;
            };
            const tree = build(area, true);
            if (!tree || !(tree.edits || tree.children)) return;
            delete tree.at;
            out.push({ kind: 'static-tree', region, tree });
        });
        // Removed: named by a structural delta's `before`, absent from every current order.
        const placedKeys = new Set();
        new Set([...Object.keys(ss.orderBase), ...Object.keys(ss.order)]).forEach(r => {
            Object.values(Object.assign({}, ss.orderBase[r] || {}, ss.order[r] || {})).forEach(ks => ks.forEach(k => placedKeys.add(k)));
        });
        const removed = new Set();
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind === 'st-children') d.before.forEach(k => { if (k && k[0] === '@' && !placedKeys.has(k) && !live.has(k)) removed.add(k); });
        }
        const regionOfKey = (k) => decodeURIComponent(k.slice(1, k.indexOf('@', 1)));
        removed.forEach(k => {
            const r = regionOfKey(k);
            let p = out.find(x => x.region === r);
            if (!p) { if (!areaByKey(r)) return; p = { kind: 'static-tree', region: r, tree: { key: '' } }; out.push(p); }
            (p.removed = p.removed || []).push(k);
        });
        return out;
    }
    function buildPatches() {
        const patches = Object.entries(fold()).map(([k, v]) => patchFor(k, v.kind, v.snap));
        staticTrees(staticState()).forEach(p => patches.push(p));
        const toEdits = (paths) => {
            const e = [];
            Object.entries(paths).forEach(([path, props]) => Object.entries(props).forEach(([prop, value]) => e.push({ path, key: path, prop, value })));
            return e;
        };
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
    // The source now holds every published edit: history starts again from here, and
    // identities are re-derived from the page as a fresh load of that source would.
    // Deltas for areas not on the page were not published; they stay.
    function rebase() {
        const mounted = (r) => r == null || !!areaByKey(r);
        const pending = (d) => (d.kind === 'st-move' ? [d.from, d.to] : [d.region]).some(r => !mounted(r));
        // Runtime locks are app state, not source: carried over by element.
        const locks = [];
        const lockState = lockStateNow();
        keyMap(staticAreas()).forEach((el, k) => { const m = lockState.get(k); if (m && m.size) locks.push([el, new Map(m)]); });
        const nonStaticLocks = log.slice(0, cursor).filter(d => d.kind === 'lock' && !/^[~@]/.test(d.key) && !pending(d));
        let c = 0;
        log = log.filter((d, i) => { const keep = pending(d); if (keep && i < cursor) c++; return keep; });
        cursor = c; ver++;
        const relock = () => {
            const add = (d) => { log.splice(cursor, 0, d); cursor++; if (persistOf(d.region)) persisted.add(d); };
            nonStaticLocks.forEach(add);
            locks.forEach(([el, m]) => {
                const a = regionOf(el), k = el.getAttribute('data-edit-key'); if (!a || !k) return;
                [true, false].forEach(v => { const acts = [...m].filter(([, x]) => x === v).map(([act]) => act); if (acts.length) add({ kind: 'lock', region: key(a), key: k, actions: acts.length === LOCK_ACTIONS.length ? [] : acts, value: v }); });
            });
            ver++;
        };
        saveState();
        originAt.clear();
        areas().forEach(a => {
            const kind = classify(a);
            a._baseText = {}; a._baseClass = {}; a._baseStyle = {};
            if (kind === 'static') { [a, ...a.querySelectorAll('[data-edit-key]')].forEach(n => n.removeAttribute('data-edit-key')); a._marked = false; markStatic(a); }
            if (kind === 'component' && a._armed) armComponent(a);
            lastSnap[key(a)] = snapshot(a, kind);
        });
        rebaseTheme();
        relock();
        saveState(); refresh();
    }
    const published = (r) => !(r && Array.isArray(r.results) && r.results.some(x => x && x.status === 'error'));
    // Source file hashes as the page loaded them (mnfst-run --edit); a publish carries them
    // so the server can refuse when a file changed underneath this page.
    let baseFiles = null;
    function loadBase() {
        if (!/^https?:$/.test(location.protocol) || typeof fetch !== 'function') return Promise.resolve(null);
        return fetch('/__edit/base', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => { if (j && j.files) baseFiles = j.files; return baseFiles; }).catch(() => null);
    }
    // Stylesheets and data hot-swap without a reload: the dev server sends their new hash.
    window.addEventListener('manifest:source-change', (e) => { const d = e.detail || {}; if (baseFiles && d.file && d.hash) baseFiles[d.file] = d.hash; });
    // A refusal for files changed since load keeps the log and reports them ($edit.stale,
    // `edit:stale`). Reload to take the new source, or publish({ rebase: true }) to write
    // the edits over it; the history is kept until a publish succeeds.
    function publish(opts) {
        const done = (r) => {
            if (r && r.base && baseFiles) Object.assign(baseFiles, r.base);
            const stale = r && Array.isArray(r.stale) ? r.stale : [];
            if (estore) estore.stale = stale;
            if (stale.length) document.dispatchEvent(new CustomEvent('edit:stale', { detail: { files: stale } }));
            if (published(r)) rebase();
            return r;
        };
        const send = () => {
            const patches = buildPatches();
            if (estore && typeof estore.onPublish === 'function') return Promise.resolve(estore.onPublish(patches, { log, cursor })).then(done);
            if (!patches.length) return Promise.resolve({ results: [] });
            const body = baseFiles ? { patches, base: baseFiles } : patches;
            return fetch('/__edit/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).then(done);
        };
        return opts && opts.rebase ? loadBase().then(send) : send();
    }
    function on() { if (estore) estore.active = true; armAll(); }
    function off() {
        if (estore) estore.active = false;
        areas().forEach(a => { if (a._edit.gated && a._armed) { disarmArea(a); a._armed = false; } });
        refresh();
    }
