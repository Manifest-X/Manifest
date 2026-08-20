    /* ---- Block operations: copy, cut, paste, duplicate, delete ----
       Structural edits on a sortable child. The plugin performs them and logs them;
       it renders no menu, because what a context menu looks like belongs to the
       project. What it offers instead is enough to build one: an `edit:context`
       event carrying the block and where the pointer was, $edit.target for the block
       in play, and $edit.can(op) so a menu can disable what would not apply. */
    let clipboard = null;                       // { html, source } — the plugin's own, not the OS clipboard
    let target = null;                          // the block a menu is acting on

    // A menu binds :disabled to can(), so what can() depends on has to be trackable.
    // The target and the clipboard are plain values, so changes to them are announced
    // through a counter on the store, which is reactive.
    const bump = () => { if (estore) estore.targetVersion = (estore.targetVersion || 0) + 1; };
    const setTarget = (el) => { target = el; bump(); };

    // The addressable block for a node: the sortable child that contains it, or —
    // where the region is not sortable at all — the outermost element inside the area
    // that contains it. Deleting a heading should not require the region to have been
    // declared reorderable.
    function blockOf(node) {
        const area = node && node.closest && node.closest('[data-edit-area]');
        if (!area) return null;
        const sortable = node.closest('[data-edit-sortable]');
        if (sortable && sortable.closest('[data-edit-area]') === area) return sortable;
        let el = node;
        while (el && el.parentElement && el.parentElement !== area) el = el.parentElement;
        return el && el.parentElement === area ? el : null;
    }

    const blockArea = (el) => el && el.closest('[data-edit-area]');

    // Markup without the plugin's own affordances, so a duplicate re-arms cleanly
    // rather than inheriting half-initialised state from its original.
    function blockHTML(el) {
        const c = el.cloneNode(true);
        c.querySelectorAll('[data-edit-handle], [data-edit-live], [data-edit-ghost]').forEach(n => n.remove());
        [c, ...c.querySelectorAll('*')].forEach(n => {
            [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-')) n.removeAttribute(a.name); });
            ['contenteditable', 'draggable', 'tabindex', 'role', 'aria-label'].forEach(a => n.removeAttribute(a));
        });
        return c.outerHTML;
    }

    /* ---- Data regime: the array is the truth, so operate on it ---- */
    function dataOps(area) {
        const tpl = area.querySelector('template[x-for]'), expr = dataSourceExpr(area);
        if (!tpl || !expr) return null;
        try {
            const arr = window.Alpine.evaluate(tpl, expr);
            return Array.isArray(arr) ? arr : null;
        } catch { return null; }
    }

    const recordIndex = (area, el) => {
        const arr = dataOps(area); if (!arr) return -1;
        const k = itemKey(el, area);
        return arr.findIndex(it => String(it && it.id != null ? it.id : it) === String(k));
    };

    // A copy needs its own identity or the list has two rows claiming one key.
    function freshId(arr, id) {
        const taken = new Set(arr.map(it => String(it && it.id)));
        if (!taken.has(String(id))) return String(id);
        let n = 2, next = `${id}-copy`;
        while (taken.has(next)) next = `${id}-copy-${n++}`;
        return next;
    }

    /* ---- Operations ---- */
    function canDo(op, el) {
        const block = el || target;
        if (op === 'paste') return !!clipboard && !!(block ? blockArea(block) : areas().find(isActive));
        if (!block || locked(block)) return false;
        const area = blockArea(block);
        if (!area || !isActive(area)) return false;
        if (classify(area) === 'component') return false;          // instances are overridden, not restructured
        return true;
    }

    function copyBlock(el) {
        const block = el || target; if (!block) return false;
        clipboard = { html: blockHTML(block), source: key(blockArea(block)) };
        bump();
        return true;
    }

    function duplicateBlock(el) {
        const block = el || target; if (!canDo('duplicate', block)) return false;
        const area = blockArea(block);
        if (classify(area) === 'data') {
            const arr = dataOps(area), i = recordIndex(area, block);
            if (!arr || i < 0) return false;
            const copy = JSON.parse(JSON.stringify(arr[i]));
            if (copy && copy.id != null) copy.id = freshId(arr, copy.id);
            arr.splice(i + 1, 0, copy);
            commitSplice(area, i + 1, copy, 'insert');
            return true;
        }
        const made = materialize(blockHTML(block));
        if (!made) return false;
        block.after(made);
        armArea(area);                                             // the copy needs its own affordances
        commitStructure(area, { [staticKeys(area)[sortableChildren(area).indexOf(made)]]: blockHTML(made) });
        return true;
    }

    function removeBlock(el) {
        const block = el || target; if (!canDo('remove', block)) return false;
        const area = blockArea(block);
        if (classify(area) === 'data') {
            const arr = dataOps(area), i = recordIndex(area, block);
            if (!arr || i < 0) return false;
            const gone = arr[i];
            arr.splice(i, 1);
            commitSplice(area, i, gone, 'remove');
            return true;
        }
        const keys = staticKeys(area), gone = keys[sortableChildren(area).indexOf(block)];
        const markup = blockHTML(block);
        block.remove();
        if (target === block) setTarget(null);
        commitStructure(area, { [gone]: markup });                 // keep the markup so undo can rebuild it
        return true;
    }

    const cutBlock = (el) => copyBlock(el) && removeBlock(el);

    function pasteBlock(el) {
        if (!clipboard) return false;
        const block = el || target;
        const area = blockArea(block) || areas().find(isActive);
        if (!area || !isActive(area)) return false;
        if (classify(area) === 'data') {
            const arr = dataOps(area); if (!arr) return false;
            const at = block ? recordIndex(area, block) + 1 : arr.length;
            const t = document.createElement('template'); t.innerHTML = clipboard.html;
            const record = { id: freshId(arr, 'pasted'), label: (t.content.textContent || '').trim() };
            arr.splice(at, 0, record);
            commitSplice(area, at, record, 'insert');
            return true;
        }
        const made = materialize(clipboard.html); if (!made) return false;
        if (block) block.after(made); else area.appendChild(made);
        armArea(area);
        commitStructure(area, { [staticKeys(area)[sortableChildren(area).indexOf(made)]]: blockHTML(made) });
        return true;
    }

    /* ---- Wiring ----
       Hotkeys ride the focused block, which reorder already gives a tabindex. They
       stay out of the way of text: nothing fires while a caret is in a field, so
       Cmd+C inside a paragraph still copies the words. */
    const inText = (e) => e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

    function onBlockKey(e) {
        if (inText(e)) return;
        const block = blockOf(e.target); if (!block) return;
        const area = blockArea(block); if (!isActive(area)) return;
        const meta = e.metaKey || e.ctrlKey;
        let done = false;
        if (meta && e.key.toLowerCase() === 'c') done = copyBlock(block);
        else if (meta && e.key.toLowerCase() === 'x') done = cutBlock(block);
        else if (meta && e.key.toLowerCase() === 'v') done = pasteBlock(block);
        else if (meta && e.key.toLowerCase() === 'd') done = duplicateBlock(block);
        else if (!meta && (e.key === 'Delete' || e.key === 'Backspace')) done = removeBlock(block);
        if (done) { e.preventDefault(); e.stopPropagation(); }
    }

    /* ---- Right-click ----
       The event waits for the pointer to come up. A popover opened while the button
       is still down is closed again by the release that follows it — the browser's
       light dismiss decides on pointerup, and by then the menu was not yet open when
       the press was recorded. Firing after the release is the only way a menu opened
       in the handler survives. The context-menu key sends no release, so a short
       timer covers it. */
    let pendingContext = null;

    function onBlockContext(e, builtIn) {
        const area = blockArea(e.target);
        if (!area || !isActive(area)) return false;
        const block = blockOf(e.target);
        if (!block) return false;                                  // off-block: leave the native menu alone
        setTarget(block);
        e.preventDefault();

        const fire = () => {
            clearTimeout(pendingContext); pendingContext = null;
            document.removeEventListener('pointerup', fire, true);
            const detail = { target: block, area, x: e.clientX, y: e.clientY, can: (op) => canDo(op, block) };
            const ev = new CustomEvent('edit:context', { bubbles: true, cancelable: true, detail });
            if (area.dispatchEvent(ev) && builtIn) builtIn();       // nobody took it
        };
        document.addEventListener('pointerup', fire, true);
        pendingContext = setTimeout(fire, 300);
        return true;
    }

    const blockTarget = () => target;
    const setBlockTarget = (el) => setTarget(el && el.nodeType === 1 ? blockOf(el) || el : null);
