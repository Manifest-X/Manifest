    /* ---- Restore persisted edits + boot (registers x-edit directive + $edit magic) ---- */
    function restore() {
        if (!log.length) return;
        for (const [k, v] of Object.entries(fold())) { const area = areaByKey(k); if (area && v.kind === 'data') waitForData(area, () => applySnap(area, 'data', v.snap)); }
        if (log.some(d => d.kind === 'st-node' || d.kind === 'st-order')) applyStaticState();
        if (log.some(d => d.kind === 'cmp-main' || d.kind === 'cmp-inst')) applyComponentState();
        if (log.some(d => d.kind === 'data-val')) { const da = areas().find(a => classify(a) === 'data'); if (da) waitForData(da, applyDataValues); }
        if (log.some(d => d.kind === 'theme')) applyThemeState();
    }
    function waitForData(area, cb) { const expr = dataSourceExpr(area), tpl = area.querySelector('template[x-for]'); let n = 0; const t = setInterval(() => { let r = false; try { r = Array.isArray(window.Alpine.evaluate(tpl, expr)); } catch {} if (r) { clearInterval(t); cb(); } else if (++n > 100) clearInterval(t); }, 50); }
    function init() {
        if (!window.Alpine || !Alpine.directive) return;
        Alpine.directive('edit', (el, { modifiers, expression }) => registerEdit(el, modifiers, expression));
        Alpine.store('edit', {
            active: false, canUndo: false, canRedo: false,
            onPublish: null,                                 // author sets a fn(patches, {log,cursor}) → route to cloud/custom
            toggle() { this.active ? off() : on(); }, on() { on(); }, off() { off(); },
            undo() { undo(); }, redo() { redo(); }, lock(el) { setLock(el, true); }, unlock(el) { setLock(el, false); },
            publish() { return publish(); },
            // Block operations. Called with no element they act on the block the last
            // right-click reported, which is what a context menu wants.
            targetVersion: 0,                                // trackable: see blocks.js
            get target() { void this.targetVersion; return blockTarget(); },
            set target(el) { setBlockTarget(el); },
            can(op, el) { void this.targetVersion; return canDo(op, el); },
            copy(el) { return copyBlock(el); },
            cut(el) { return cutBlock(el); },
            paste(el) { return pasteBlock(el); },
            duplicate(el) { return duplicateBlock(el); },
            remove(el) { return removeBlock(el); },
            block(node) { return blockOf(node); },
            patches() { return buildPatches(); },            // resolved B-side source patches
            export() { return JSON.parse(JSON.stringify({ log, cursor })); }   // A-side overlay (e.g. push to Appwrite)
        });
        estore = Alpine.store('edit');
        Alpine.magic('edit', () => Alpine.store('edit'));
        loadState();
        setTimeout(() => { armAll(); restore(); }, 450);   // arm (captures baselines) THEN re-apply persisted edits
        window.addEventListener('manifest:route-change', () => setTimeout(refresh, 0));   // chrome follows the route
    }
    document.addEventListener('alpine:init', init);
    if (window.Alpine && Alpine.directive) setTimeout(init, 0);
})();
