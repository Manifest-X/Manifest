    function refresh() {
        if (!estore) return;
        estore.canUndo = cursor > 0;
        estore.canRedo = cursor < log.length;
        estore.version = (estore.version || 0) + 1;
    }

    /* ---- Undo/redo hotkeys: Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y ----
       On wherever a region is active; data-edit-hotkeys="off" on a region or any
       ancestor opts it out. Text that is still being typed keeps the browser's own
       undo until it commits on blur; fields and x-text-edit keep theirs always. */
    const leafText = (el) => el._editField && !el._editRich ? el.textContent : el.innerHTML.trim();
    const hotkeysOff = (el) => !!el.closest('[data-edit-hotkeys="off"]');
    // A focused leaf's baseline follows history rewrites under the caret.
    function rebaseFocused() {
        const el = document.activeElement;
        if (!el || el._preEdit === undefined || !el.isContentEditable) return;
        const sync = () => { if (document.activeElement === el) el._preEdit = leafText(el); };
        sync(); setTimeout(sync, 0);
    }
    function onHistoryKey(e) {
        if (e.defaultPrevented || e.altKey || !(e.metaKey || e.ctrlKey) || dragged) return;   // never mid-drag
        const k = (e.key || '').toLowerCase();
        const isRedo = (k === 'z' && e.shiftKey) || (k === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey);
        if (!isRedo && !(k === 'z' && !e.shiftKey)) return;
        const t = e.target && e.target.nodeType === 1 ? e.target : document.body;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[data-text-edit]')) return;
        const region = t.closest('[data-edit-area]');
        if (region) {
            const top = regionOf(region);
            if (!top || !isActive(top) || hotkeysOff(region)) return;
        } else {
            if (t.isContentEditable) return;                         // someone else's editor
            if (!areas().some(a => isActive(a) && !hotkeysOff(a))) return;
        }
        if (t.isContentEditable && t._preEdit !== undefined && leafText(t) !== t._preEdit) return;   // uncommitted typing: native undo
        if (isRedo ? cursor >= log.length : cursor === 0) return;
        e.preventDefault();
        isRedo ? redo() : undo();
    }
