    /* ---- Restore persisted edits + boot ---- */
    // Deltas for areas that no longer persist are dropped before replay.
    function pruneLoaded() {
        const stale = (d) => {
            const regions = d.kind === 'st-move' ? [d.from, d.to] : d.region != null ? [d.region] : [];
            return regions.some(r => { const a = areaByKey(r); return a && !a._edit.persist; });
        };
        if (!log.some(stale)) return;
        let c = 0;
        const kept = log.filter((d, i) => { const keep = !stale(d); if (keep && i < cursor) c++; return keep; });
        log = kept; cursor = c; ver++;
        saveState();
    }
    function restore() {
        if (!log.length) return;
        pruneLoaded();
        for (const [k, v] of Object.entries(fold())) { const area = areaByKey(k); if (area && v.kind === 'data') waitForData(area, () => applySnap(area, 'data', v.snap)); }
        if (log.some(d => /^st-/.test(d.kind))) { surfaceConflicts(areas()); applyStaticState(); }
        if (log.some(d => d.kind === 'cmp-main' || d.kind === 'cmp-inst')) applyComponentState();
        if (log.some(d => d.kind === 'data-val')) { const da = areas().find(a => classify(a) === 'data'); if (da) waitForData(da, applyDataValues); }
        if (log.some(d => d.kind === 'theme')) applyThemeState();
        if (log.some(d => d.kind === 'lock')) areas().forEach(rearm);
        refresh();
    }
    function waitForData(area, cb) { const expr = dataSourceExpr(area), tpl = listTpl(area); let n = 0; const t = setInterval(() => { let r = false; try { r = Array.isArray(window.Alpine.evaluate(tpl, expr)); } catch { } if (r) { clearInterval(t); cb(); } else if (++n > 100) clearInterval(t); }, 50); }
    let inited = false;
    function init() {
        if (inited || !window.Alpine || !Alpine.directive) return;
        inited = true;
        // Alpine walks only x-data trees: a page with none still gets its areas
        if (document.body && !document.body.hasAttribute('x-data')) document.body.setAttribute('x-data', '{}');
        Alpine.directive('edit', (el, { modifiers, expression }, { cleanup }) => {
            registerEdit(el, modifiers, expression);
            armLater();
            cleanup(() => releaseEdit(el));
        });
        Alpine.store('edit', {
            active: false, canUndo: false, canRedo: false, version: 0, stale: [], conflicts: [],
            onPublish: null,
            toggle() { this.active ? off() : on(); }, on() { on(); }, off() { off(); },
            undo() { return undo(); }, redo() { return redo(); },
            publish(opts) { return publish(opts); },
            patches() { return buildPatches(); },
            export() { return JSON.parse(JSON.stringify({ log, cursor })); },
            get target() { void this.version; return target; },
            set target(el) { setBlockTarget(el); },
            can(action, el) { void this.version; return canDo(action, el === undefined ? target : el); },
            lock(el, action) { return setLock(el === undefined ? target : el, action, true); },
            unlock(el, action) { return setLock(el === undefined ? target : el, action, false); },
            copy(el) { return copyBlock(el); },
            cut(el) { return cutBlock(el); },
            paste(el) { return pasteBlock(el); },
            duplicate(el) { return duplicateBlock(el); },
            remove(el) { return removeBlock(el); },
            move(el, dest, before) { return moveBlock(el, dest, before); },
            nest(el) { const p = asPiece(el === undefined ? target : el); return !!p && movable(p) && nestInto(p); },
            unnest(el) { const p = asPiece(el === undefined ? target : el); return !!p && movable(p) && unnest(p); },
            block(node) { return pieceOf(node); },
            attr(name, value, el) { return setAttr(name, value, el); },
            classes: classesApi,
            scope(value, el) { void this.version; return value === undefined ? scopeOf(el) : setScope(value, el); },
            revert(el) { return revert(el); },
            clearConflicts() { conflicts = []; this.conflicts = []; saveState(); }
        });
        estore = Alpine.store('edit');
        const editMagic = () => Alpine.store('edit');
        Alpine.magic('edit', editMagic);
        // The loader's stand-in answered $edit until now: it hands over, and effects that read it run again
        window.__manifestEditMagic = editMagic;
        if (window.__manifestEditStub) setTimeout(() => { window.__manifestEditStub.v++; }, 0);
        loadState();
        if (window.__mnfstEdit) loadBase();   // only mnfst-run --edit serves the base
        setTimeout(() => { armAll(); restore(); }, 450);
        document.addEventListener('keydown', onHistoryKey);
        window.addEventListener('click', onAreaLinkClick, true);
        window.addEventListener('auxclick', onAreaLinkClick, true);
        document.addEventListener('contextmenu', onContextCapture, true);
        document.addEventListener('dropdown:context', onContextCapture, true);
        // SPA navigation: the state so far is saved under the page it was made on.
        window.addEventListener('manifest:route-change', () => { if (lsPath !== location.pathname) { lsPath = location.pathname; saveState(); } });
        adopt();
    }
    // Loaded after Alpine started: x-edit elements its walk passed get their attributes re-set
    // (Alpine runs them as new directives); those it never walked (no x-data above) are walked now.
    function adopt() {
        if (!window.__manifestAlpineStarted && ![...document.querySelectorAll('[x-data]')].some(e => e._x_marker)) return;
        const isEdit = (n) => /^x-edit(\.|$)/.test(n);
        const found = [...document.querySelectorAll('*')].filter(el => !el._edit && [...el.attributes].some(a => isEdit(a.name)));
        found.forEach(el => { if (el._x_marker) [...el.attributes].filter(a => isEdit(a.name)).forEach(a => el.setAttribute(a.name, a.value)); });
        if (found.some(el => !el._x_marker)) Alpine.initTree(document.body);
    }
    document.addEventListener('alpine:init', init);
    if (window.Alpine && Alpine.directive) setTimeout(init, 0);
})();
