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
                const p = path === '' ? String(i) : path + '.' + i;
                // Another component's markup is one opaque element here, its <x-name> host
                // (data-edit-host; its first root stands for it, the rest follow it)
                if (c._manifestComponent) {
                    if (extraRoot(c)) continue;
                    if (!c.hasAttribute('data-edit-host')) {
                        // Marked while still a placeholder: the components plugin carried its key over
                        const carried = c.getAttribute('data-edit-key'), own = canonKey(region, 'X-' + c._manifestComponent.toUpperCase() + ':');
                        let k = carried && (carried === own || carried.startsWith(own + '#')) ? carried : '!' + mint();
                        if (first && k[0] === '!') { const b = 'X-' + c._manifestComponent.toUpperCase() + ':', n = seen[b] = (seen[b] || 0) + 1; k = canonKey(region, n > 1 ? b + '#' + n : b); originAt.set(k, p); }
                        c.setAttribute('data-edit-host', k);
                    }
                    i++; continue;
                }
                walk(c, p);
                i++;
            }
        };
        walk(area, '');
    }
    const warnedRendered = new Set(), renderedRegions = new Set();
    function armArea(area) {
        if (area._edit.rendered) renderedRegions.add(key(area));
        if (area._edit.rendered && !warnedRendered.has(key(area))) { warnedRendered.add(key(area)); console.warn(`[edit] x-edit="${key(area)}" is inside content ${area._edit.rendered} renders: it edits on the page (and reaches onPublish), but mnfst-run cannot write it to a source file`); }
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
        [area, ...area.querySelectorAll('[contenteditable]')].forEach(e => { if (e.hasAttribute('contenteditable')) e.removeAttribute('contenteditable'); e._pieceMode = false; e.removeAttribute('data-edit-piece-mode'); });
        area.querySelectorAll('[data-edit-piece]').forEach(unmarkPiece);
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(e => { e._sizeBound = false; });
        if (grabbed && area.contains(grabbed.item)) cancelGrab();
    }

    /* ---- Activation: always-on by default; .gated waits for $edit.on() ---- */
    let estore, booted = false, armQueued = false;
    const isActive = (a) => !!a && !!a._edit && (!a._edit.gated || !!(estore && estore.active)) && !sharedKey(a);
    const warnedShared = new Set();
    function armAll() {
        const fresh = [];
        areas().forEach(a => {
            if (!sharedKey(a)) return;
            if (!warnedShared.has(key(a))) { warnedShared.add(key(a)); console.warn(`[edit] x-edit="${key(a)}" is on the page more than once (a component used several times); it is not editable here`); }
            if (a._armed) { disarmArea(a); a._armed = false; }
        });
        areas().forEach(a => { if (isActive(a) && !a._armed) { if (!a._editBound) fresh.push(a); lastSnap[key(a)] = snapshot(a, classify(a)); armArea(a); a._armed = true; } });
        // A region mounted again after boot (x-if, a deferred route) shows the edits the log still holds for it
        if (booted && fresh.length) {
            if (log.some(d => /^st-/.test(d.kind))) { surfaceConflicts(fresh); applyStaticState(); }
            if (log.some(d => d.kind === 'cmp-main' || d.kind === 'cmp-inst')) applyComponentState();
        }
        armThemeControls(); refresh(); booted = true;
    }

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
            const region = key(area), comp = sourceComponent(area);
            const ids = new Proxy({}, { get: (_, k) => { const o = originOf(String(k)), a = areaByKey(decodeURIComponent(o.slice(1, o.indexOf('@', 1)))); const m = baseIds && a && baseIds[sourceFile(a)]; return m ? m[o] : undefined; } });
            // The children a restructured container had when the page loaded (the server refuses
            // the rewrite if the source no longer has them).
            const baseOf = (parent) => {
                const list = parent === '' ? (ss.orderBase[region] || {})[''] : Object.values(ss.orderBase).map(m => m[parent]).find(Boolean);
                return list ? list.filter(k => k[0] === '@').map(k => { const b = { key: k }, at = originAt.get(k); if (at != null) b.at = at; if (ids && ids[k]) b.fp = ids[k]; return b; }) : null;
            };
            const build = (el, isRoot) => {
                const host = !isRoot && el.getAttribute('data-edit-host');
                if (host) { if (host[0] === '!') return null; const h = { key: host }, at = originAt.get(host); if (at != null) h.at = at; if (ids && ids[host]) h.fp = ids[host]; return h; }
                if (!isRoot && el._manifestComponent) return null;
                const id = el.getAttribute('data-edit-key');
                if (!id || id[0] === '!') return null;
                const n = { key: id };
                const at = originAt.get(originOf(id)); if (at != null) n.at = at;
                if (ids && ids[originOf(id)]) n.fp = ids[originOf(id)];
                const e = editsFor(id); if (e) n.edits = e;
                if (!(e && 'text' in e) && !isRendered(el) && !el.hasAttribute('data-rich-text')) {
                    const kids = treeKids(el).map(c => build(c)).filter(Boolean);
                    const structural = ss.touched.has(isRoot ? '#' + region : id);
                    if (id[0] === '~' || structural) { n.children = kids; const b = structural && id[0] !== '~' && baseOf(isRoot ? '' : id); if (b) n.base = b; }
                    else if (kids.some(nontrivial)) { n.children = kids.filter(nontrivial); n.path = true; }   // only a path to edits: the source keeps its own order
                }
                return n;
            };
            const tree = build(area, true);
            if (!tree || !(tree.edits || tree.children)) return;
            delete tree.at; delete tree.fp;
            out.push(comp ? { kind: 'static-tree', region, component: comp, tree } : { kind: 'static-tree', region, tree });
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
            if (!p) { const a = areaByKey(r); if (!a || sharedKey(a)) return; const c = sourceComponent(a); p = c ? { kind: 'static-tree', region: r, component: c, tree: { key: '' } } : { kind: 'static-tree', region: r, tree: { key: '' } }; out.push(p); }
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
    // Deltas for areas not on the page were not published; they stay, as do those of
    // `keep` (areas a publish left out), whose identities are left as they are.
    function rebase(keep) {
        const mounted = (r) => r == null || (!!areaByKey(r) && !(keep && keep.has(r)));
        const pending = (d) => (d.kind === 'st-move' ? [d.from, d.to] : [d.region]).some(r => !mounted(r));
        // Runtime locks are app state, not source: carried over by element.
        const locks = [];
        const lockState = lockStateNow();
        keyMap(staticAreas().filter(a => !(keep && keep.has(key(a))))).forEach((el, k) => { const m = lockState.get(k); if (m && m.size) locks.push([el, new Map(m), k === el.getAttribute('data-edit-host')]); });
        const nonStaticLocks = log.slice(0, cursor).filter(d => d.kind === 'lock' && !/^[~@]/.test(d.key) && !pending(d));
        let c = 0;
        log = log.filter((d, i) => { const keep = pending(d); if (keep && i < cursor) c++; return keep; });
        cursor = c; ver++;
        const relock = () => {
            const add = (d) => { log.splice(cursor, 0, d); cursor++; if (persistOf(d.region)) persisted.add(d); };
            nonStaticLocks.forEach(add);
            locks.forEach(([el, m, host]) => {
                const a = host ? blockArea(el) : regionOf(el), k = el.getAttribute(host ? 'data-edit-host' : 'data-edit-key'); if (!a || !k) return;
                [true, false].forEach(v => { const acts = [...m].filter(([, x]) => x === v).map(([act]) => act); if (acts.length) add({ kind: 'lock', region: key(a), key: k, actions: acts.length === LOCK_ACTIONS.length ? [] : acts, value: v }); });
            });
            ver++;
        };
        saveState();
        const keptAt = keep ? [...originAt].filter(([k]) => keep.has(decodeURIComponent(k.slice(1, k.indexOf('@', 1))))) : [];
        originAt.clear();
        keptAt.forEach(([k, p]) => originAt.set(k, p));
        areas().forEach(a => {
            if (keep && keep.has(key(a))) return;
            const kind = classify(a);
            a._baseText = {}; a._baseClass = {}; a._baseStyle = {};
            if (kind === 'static') {
                [a, ...a.querySelectorAll('[data-edit-key]')].forEach(n => { if (regionOf(n) === a) n.removeAttribute('data-edit-key'); });
                a.querySelectorAll('[data-edit-host]').forEach(n => { if (regionOf(n.parentElement) === a) n.removeAttribute('data-edit-host'); });
                a._marked = false; markStatic(a);
            }
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
    // With them, each source element's fingerprint as loaded: the server refuses an edit
    // whose element no longer matches (changed, or a twin that moved).
    let baseFiles = null, baseIds = null;
    function loadBase(filesOnly) {
        if (!/^https?:$/.test(location.protocol) || typeof fetch !== 'function') return Promise.resolve(null);
        return fetch('/__edit/base', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => {
            if (j && j.files) baseFiles = j.files;
            if (j && j.ids && !filesOnly) baseIds = j.ids;
            return baseFiles;
        }).catch(() => null);
    }
    // Stylesheets and data hot-swap: their new hash applies. HTML waits for the reload
    // (a cancelled one leaves the page on what it loaded); our own writes advance on publish.
    // HTML that changes before the base arrives makes a late base untrustworthy.
    let movedUnbased = false;
    window.addEventListener('manifest:source-change', (e) => {
        const d = e.detail || {}, html = /\.html?$/i.test(d.file || '');
        if (html && !baseIds) movedUnbased = true;
        if (baseFiles && d.file && d.hash && !html) baseFiles[d.file] = d.hash;
    });
    // A refusal for files changed since load keeps the log and reports them ($edit.stale,
    // `edit:stale`). Reload to take the new source, or publish({ rebase: true }) to write
    // the edits over it; the history is kept until a publish succeeds.
    // The live reload a successful publish of ours triggers is not taken: the page is
    // already rebased, and typing begun since would be lost. Reloads that arrive while a
    // publish is in flight wait for its answer; anything not written by it still reloads.
    // After a stale refusal or a rebase write the page shows an older source than the file,
    // so no reload is ours to skip, and with no live reload coming the page reloads itself.
    // A reload never discards edits it cannot restore: with unpersisted edits pending, the
    // page stays and says so (edit:stale), so they can be published first.
    let ownWrites = null, inFlight = 0, held = [], resync = false, heldReload = null;
    const ours = (files) => !resync && !!ownWrites && Date.now() < ownWrites.until && files.length > 0 && files.every(f => f && ownWrites.files[f.rel] && ownWrites.files[f.rel] === f.hash);
    // A reload is safe when every applied edit survives it (persisted), and no focused leaf holds
    // typing not yet logged (a persisting one is committed first). Undone steps never hold it.
    // Typing in a focused leaf, not yet logged (it is, on blur): committed now when `force` or its region persists
    function commitFocused(force) {
        const f = document.activeElement;
        if (!f || !f._commitText || f._preEdit === undefined || !f.isContentEditable || leafText(f) === f._preEdit) return true;
        const a = regionOf(f);
        if (!a || (!force && !a._edit.persist)) return false;
        f._commitText(); restartRich(f); f._preEdit = leafText(f);
        return true;
    }
    // Grows a set of held regions by the regions moves tie to them (`via`: held -> the region it is tied to).
    function tie(held) {
        const via = new Map();
        for (let grew = true; grew;) {
            grew = false;
            log.slice(0, cursor).forEach(d => {
                if (d.kind !== 'st-move' || held.has(d.from) === held.has(d.to)) return;
                const [had, add] = held.has(d.from) ? [d.from, d.to] : [d.to, d.from];
                held.add(add); via.set(add, via.get(had) || had); grew = true;
            });
        }
        held.via = via;
        return held;
    }
    // Edits mnfst-run can't write (a generated region's own, a move in or out of one, and a piece
    // moved from one) never hold a reload: it regenerates that markup (.persist keeps them).
    // A writable region a move ties to one still holds: it is published once that move is undone.
    const keyRegion = (k) => { if (typeof k !== 'string') return null; const o = originOf(k); return o[0] === '@' ? o.slice(1, o.indexOf('@', 1)) : null; };
    const unwritableEdit = (d) => renderedRegions.has(d.region) || renderedRegions.has(d.from) || renderedRegions.has(d.to) || renderedRegions.has(keyRegion(d.path)) || renderedRegions.has(keyRegion(d.key));
    const regionsOf = (ds) => [...new Set(ds.flatMap(d => [d.region, d.from, d.to]).filter(Boolean))];
    const unsaved = () => log.slice(0, cursor).filter(d => d.kind !== 'lock' && !persisted.has(d));
    function focusedRegion() { const f = document.activeElement, a = f && f._commitText && regionOf(f); return a ? key(a) : null; }
    function reloadSafe() {
        if (!commitFocused(false) && !renderedRegions.has(focusedRegion())) return false;
        // Unpersisted edits exist only for regions of this document (mounted or not): they hold it
        return unsaved().every(unwritableEdit);
    }
    function warnDiscarded() {
        const f = focusedRegion(), lost = regionsOf(unsaved().filter(unwritableEdit));
        if (f && renderedRegions.has(f) && !commitFocused(false) && !lost.includes(f)) lost.push(f);
        if (lost.length) console.warn(`[edit] the source changed: reloading discards the unpublished edits of ${lost.map(r => `x-edit="${r}"`).join(', ')} that mnfst-run can't write (generated content, or a piece moved from it); .persist keeps them`);
    }
    function reloadNow() { warnDiscarded(); location.reload(); }
    // A held reload is taken as soon as nothing it would lose remains
    function takeHeldReload() { if (heldReload && reloadSafe()) { heldReload = null; reloadNow(); } }
    function reloadIfSafe(files) {
        if (reloadSafe()) return reloadNow();
        heldReload = files;
        const changed = files.map(f => f && f.rel).filter(Boolean);
        if (estore) estore.stale = [...new Set([...(estore.stale || []), ...changed])];
        const holding = regionsOf(unsaved().filter(d => !unwritableEdit(d))).filter(r => !renderedRegions.has(r));
        const f = focusedRegion(); if (f && !renderedRegions.has(f) && !holding.includes(f) && !commitFocused(false)) holding.push(f);
        const off = tie(new Set(renderedRegions)), tied = holding.filter(r => off.has(r));
        const name = (rs) => rs.map(r => `x-edit="${r}"`).join(', ');
        console.warn(`[edit] the source changed, but a reload would lose unpublished edits${holding.length ? ' to ' + name(holding) : ''}: publish (with rebase), then reload`
            + (tied.length ? `. ${name(tied)} ${tied.length > 1 ? 'are' : 'is'} tied by a move to ${name([...new Set(tied.map(r => off.via.get(r)))])}, which mnfst-run can't write: undo that move to publish ${tied.length > 1 ? 'them' : 'it'}, or publish the rest` : ''));
        document.dispatchEvent(new CustomEvent('edit:stale', { detail: { files: changed } }));
    }
    window.addEventListener('manifest:live-reload', (e) => {
        const files = (e.detail && e.detail.files) || [];
        if (inFlight) { e.preventDefault(); held.push(files); return; }
        if (ours(files)) { e.preventDefault(); return; }
        if (!reloadSafe()) { e.preventDefault(); reloadIfSafe(files); }
        else warnDiscarded();
    });
    function settled(r, rebased) {
        inFlight = Math.max(0, inFlight - 1);
        if (r && r.base) ownWrites = { files: Object.assign({}, r.base), until: Date.now() + 3000 };
        if (r && Array.isArray(r.stale) && r.stale.length) resync = true;
        if (rebased && published(r) && r.base) { resync = true; setTimeout(() => { if (resync) reloadIfSafe(Object.keys(r.base).map(rel => ({ rel }))); }, 1500); }
        if (inFlight) return;
        const pending = held; held = [];
        if (pending.some(f => !ours(f))) reloadIfSafe(pending.flat());
    }
    // Publishes run one at a time: a second waits for the first, then builds on its result.
    let publishing = Promise.resolve();
    function publish(opts) {
        const next = publishing.then(() => publishNow(opts));
        publishing = next.catch(() => { });
        return next;
    }
    // Once a rebase writes over HTML changed elsewhere, the page shows less than the file:
    // its HTML hashes are not taken (a plain publish is stale until a reload), nor the
    // fingerprints of keys with twins there (which may not be the elements this page shows).
    let overNewer = false;
    function publishNow(opts) {
        const done = (r, keep) => {
            if (r && r.base && baseFiles) Object.entries(r.base).forEach(([f, h]) => { if (!overNewer || !/\.html?$/i.test(f)) baseFiles[f] = h; });
            if (r && r.ids && baseIds) {
                if (!overNewer) baseIds = r.ids;
                else Object.entries(r.ids).forEach(([f, m]) => { baseIds[f] = Object.assign({}, baseIds[f]); Object.entries(m || {}).forEach(([k, fp]) => { if (!String(fp).includes('.')) baseIds[f][k] = fp; }); });
            }
            const stale = r && Array.isArray(r.stale) ? r.stale : [];
            if (estore) estore.stale = stale;
            if (stale.length) document.dispatchEvent(new CustomEvent('edit:stale', { detail: { files: stale } }));
            if (published(keep ? { results: r.results.filter(x => !(x && keep.has(x.region))) } : r)) rebase(keep);
            takeHeldReload();
            return r;
        };
        // An area the writer could not resolve does not hold the others back: they are sent
        // again without it (and areas a move ties to it); its edits stay, its refusal is returned.
        const leftOut = (r, patches) => {
            if (!r || !Array.isArray(r.results) || (Array.isArray(r.stale) && r.stale.length)) return null;
            const failed = new Set(r.results.filter(x => x && x.failed != null).map(x => x.failed));
            if (!failed.size || r.results.some((x, i) => x && x.status === 'error' && !failed.has(patches[i] && patches[i].region))) return null;
            tie(failed);
            return patches.some(p => !failed.has(p.region)) ? failed : null;
        };
        // An area inside generated content (x-markdown output and the like) edits on the page,
        // but its markup is in no file mnfst-run can write: it is refused by name, not sent.
        const renderedBy = (region) => { const a = areaByKey(region); return a && a._edit.rendered; };
        const unwritable = (p) => (p.kind === 'static-tree' || (p.kind === 'component' && p.scope === 'instance')) && !!renderedBy(p.region);
        const send = () => {
            commitFocused(true);   // typing under way publishes with the rest (identities are re-derived from the page after)
            const patches = buildPatches();
            if (estore && typeof estore.onPublish === 'function') return Promise.resolve(estore.onPublish(patches, { log, cursor })).then(done);
            if (!patches.length) { takeHeldReload(); return Promise.resolve({ results: [] }); }   // nothing to send: a held reload goes now
            const post = (ps) => { inFlight++; return fetch('/__edit/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patches: ps, base: baseFiles }) }).then(r => r.json()).catch(err => { settled(null); throw err; }); };
            const off = tie(new Set(patches.filter(unwritable).map(p => p.region)));
            const offResult = (p) => ({ region: p.region, status: 'error', reason: renderedBy(p.region) && unwritable(p)
                ? `x-edit="${p.region}" is inside content ${renderedBy(p.region)} renders, so mnfst-run can't write it to a source file`
                : `not published: tied by a move to x-edit="${off.via.get(p.region)}", which mnfst-run can't write` });
            const sendable = patches.filter(p => !off.has(p.region));
            // The sent part's answer, merged with what was held back, as one result per patch.
            const finish = (r, held, sent) => {
                const keep = new Set([...off, ...(held || [])]);
                const results = patches.map(p => off.has(p.region) ? offResult(p) : r.results[sent.indexOf(p)]);
                const o = done(Object.assign({}, r, { results }), keep.size ? keep : undefined); settled(r, !!(opts && opts.rebase)); return o;
            };
            if (!sendable.length) { const o = done({ results: patches.map(offResult) }, off); return Promise.resolve(o); }
            return post(sendable).then(r => {
                const out = leftOut(r, sendable);
                if (!out) return finish(r, null, sendable);
                settled(r, false);
                const rest = sendable.filter(p => !out.has(p.region));
                return post(rest).then(r2 => {
                    const results = sendable.map((p, i) => out.has(p.region)
                        ? (r.results[i] && r.results[i].status === 'error' ? r.results[i] : { region: p.region, status: 'error', reason: `not published: tied by a move to x-edit="${out.via.get(p.region) || [...out].find(x => !out.via.has(x))}", which failed` })
                        : r2.results[rest.indexOf(p)]);
                    return finish(Object.assign({}, r2, { results }), out, sendable);
                });
            });
        };
        // mnfst-run gets a publish only with the base the page loaded; a missing one is
        // fetched once more, else the publish is refused and the history kept.
        const refuse = (reason) => { const patches = buildPatches(); return patches.length ? done({ results: patches.map(p => ({ region: p.region, status: 'error', reason })) }) : { results: [] }; };
        const custom = estore && typeof estore.onPublish === 'function';
        const based = custom || (baseFiles && baseIds) ? Promise.resolve(null)
            : movedUnbased ? Promise.resolve('the source changed before this page could read its base from the dev server; reload to continue')
            : loadBase().then(() => baseFiles && baseIds ? null : 'the dev server\'s base (/__edit/base) could not be read, so nothing can be checked against the source; nothing was published');
        const rebaseSend = () => {
            const was = Object.assign({}, baseFiles);
            return loadBase(true).then(() => { if (Object.keys(baseFiles || {}).some(f => /\.html?$/i.test(f) && was[f] !== baseFiles[f])) overNewer = true; return send(); });
        };
        return based.then(why => why ? refuse(why) : opts && opts.rebase ? rebaseSend() : send());
    }
    function on() { if (estore) estore.active = true; armAll(); }
    function off() {
        if (estore) estore.active = false;
        areas().forEach(a => { if (a._edit.gated && a._armed) { disarmArea(a); a._armed = false; } });
        refresh();
    }
