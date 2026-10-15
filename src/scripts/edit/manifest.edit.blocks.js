    /* ---- Pieces and block operations ---- */
    let clipboard = null;
    let target = null;

    const bump = () => { if (estore) estore.version = (estore.version || 0) + 1; };
    const setTarget = (el) => { target = el; bump(); };

    // The innermost structural piece holding a node: a child of a container (static),
    // a row of the list (data), or a path-addressed node (component).
    function pieceOf(node) {
        if (node && node.nodeType !== 1) node = node.parentElement;
        const area = regionOf(node);
        if (!area || node === area) return null;
        const kind = classify(area);
        if (kind === 'data') {
            const tpl = area.querySelector('template[x-for]'), list = tpl && tpl.parentElement;
            for (let n = node; n && n !== area; n = n.parentElement) if (n.parentElement === list) return n;
            return null;
        }
        if (kind === 'component') {
            for (let n = node; n && n !== area; n = n.parentElement) if (n._editPath != null) return n;
            return null;
        }
        for (let n = node; n && n !== area; n = n.parentElement) {
            if (pluginNode(n)) return null;
            if (isContainer(n.parentElement)) return n;
        }
        return null;
    }
    const isPiece = (el) => !!el && el.nodeType === 1 && pieceOf(el) === el;
    const asPiece = (el) => isPiece(el) ? el : pieceOf(el);
    const blockArea = (el) => el && regionOf(el.parentElement);
    const isRegionBlock = (el) => !!el && (!!el._edit || el.hasAttribute('data-edit-area'));
    // A piece can be dragged when its container moves and nothing up to the region locks it.
    const movable = (el) => !!el && !!el.parentElement && !pluginNode(el) && capOf(el.parentElement, 'move') && !lockedFor(el, 'move') && classify(regionOf(el)) !== 'component';
    function accepts(c) {
        if (!c || c.nodeType !== 1) return false;
        const area = regionOf(c);
        if (!area || !isActive(area) || !isContainer(c)) return false;
        return capOf(c, 'move');
    }

    // Markup without plugin affordances. `keepKeys` keeps identity so undo restores it.
    function blockHTML(el, keepKeys) {
        const c = el.cloneNode(true);
        const src = [el, ...el.querySelectorAll('*')], dst = [c, ...c.querySelectorAll('*')];
        dst.forEach((n, i) => { if (addedTab.has(src[i])) n.removeAttribute('tabindex'); });
        c.querySelectorAll('[data-edit-handle], [data-edit-live], [data-edit-ghost]').forEach(n => n.remove());
        [c, ...c.querySelectorAll('*')].forEach(n => {
            [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-') && !(keepKeys && a.name === 'data-edit-key')) n.removeAttribute(a.name); });
            n.removeAttribute('contenteditable');
            n.removeAttribute('draggable');
        });
        return c.outerHTML;
    }

    /* ---- Data regime: the array is the truth ---- */
    function dataOps(area) {
        const tpl = area.querySelector('template[x-for]'), expr = dataSourceExpr(area);
        if (!tpl || !expr) return null;
        try { const arr = window.Alpine.evaluate(tpl, expr); return Array.isArray(arr) ? arr : null; } catch { return null; }
    }
    const recordIndex = (area, el) => {
        const arr = dataOps(area); if (!arr) return -1;
        const k = itemKey(el, area);
        return arr.findIndex(it => String(it && it.id != null ? it.id : it) === String(k));
    };
    function freshId(arr, id) {
        const taken = new Set(arr.map(it => String(it && it.id)));
        if (!taken.has(String(id))) return String(id);
        let n = 2, next = `${id}-copy`;
        while (taken.has(next)) next = `${id}-copy-${n++}`;
        return next;
    }

    /* ---- can() ---- */
    const ACTIONS = ['move', 'remove', 'duplicate', 'text', 'attrs', 'size', 'copy', 'cut', 'paste'];
    function pasteDest(el) {
        const block = el ? asPiece(el) : null;
        if (block) return accepts(block.parentElement) ? block.parentElement : null;
        const area = areas().find(a => isActive(a) && accepts(a));
        return area || null;
    }
    function canDo(action, el) {
        if (!ACTIONS.includes(action)) return false;
        if (action === 'paste') return !!clipboard && !!pasteDest(el);
        if (!el || el.nodeType !== 1) return false;
        const area = regionOf(el);
        if (!area || !isActive(area)) return false;
        const kind = classify(area);
        if (action === 'size') return !!el._edit && el._edit.caps.has('size') && !lockedFor(el, 'size');
        if (action === 'text') return capOf(el, 'text') && (kind !== 'data' || capOf(el, 'data'));
        if (action === 'attrs') {
            if (kind === 'data' || lockedFor(el, 'attrs')) return false;
            return kind === 'component' ? el._editPath != null : el.hasAttribute('data-edit-key');
        }
        if (kind === 'component') return false;
        const block = asPiece(el);
        if (!block) return false;
        if (action === 'copy') return true;
        if (action === 'move') return movable(block);
        const lockAs = action === 'duplicate' ? 'duplicate' : 'remove';
        return capOf(block.parentElement, 'move') && !lockedFor(block, lockAs);
    }

    function copyBlock(el) {
        const block = asPiece(el === undefined ? target : el); if (!block) return false;
        const area = blockArea(block); if (!area) return false;
        clipboard = { html: blockHTML(block), source: key(area) };
        bump();
        return true;
    }

    function insertStatic(area, container, made, after) {
        const before = staticKeys(container);
        if (after) after.after(made); else container.appendChild(made);
        markStatic(area); armArea(area);
        commitStructure(area, container, before, { [made.getAttribute('data-edit-key')]: blockHTML(made) });
    }

    function duplicateBlock(el) {
        const block = asPiece(el === undefined ? target : el); if (!canDo('duplicate', block)) return false;
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
        insertStatic(area, block.parentElement, made, block);
        return true;
    }

    function removeBlock(el) {
        const block = asPiece(el === undefined ? target : el); if (!canDo('remove', block)) return false;
        const area = blockArea(block);
        if (classify(area) === 'data') {
            const arr = dataOps(area), i = recordIndex(area, block);
            if (!arr || i < 0) return false;
            const gone = arr[i];
            arr.splice(i, 1);
            commitSplice(area, i, gone, 'remove');
            if (target === block) setTarget(null);
            return true;
        }
        const container = block.parentElement, before = staticKeys(container);
        const gone = block.getAttribute('data-edit-key'), markup = blockHTML(block, true);
        block.remove();
        if (target === block || (target && block.contains(target))) setTarget(null);
        commitStructure(area, container, before, { [gone]: markup });
        return true;
    }

    const cutBlock = (el) => { const b = asPiece(el === undefined ? target : el); return canDo('remove', b) && copyBlock(b) && removeBlock(b); };

    // Programmatic move: into `dest` (container element or x-edit key) before `ref`, or at the end.
    function moveBlock(el, dest, ref) {
        const block = asPiece(el == null ? target : el);
        if (!block || !movable(block)) return false;
        const from = regionOf(block);
        const container = typeof dest === 'string' ? areaByKey(dest) : dest;
        if (!container || container.nodeType !== 1 || container === block || block.contains(container)) return false;
        const to = regionOf(container);
        if (!from || !to || !isActive(from) || !isActive(to) || !accepts(container)) return false;
        if (ref && ref.parentElement !== container) ref = null;
        const fromContainer = block.parentElement;
        if (classify(from) === 'data') {
            if (container !== fromContainer) return false;
            container.insertBefore(block, ref);
            finishReorder(from, container);
            return true;
        }
        if (classify(from) !== 'static' || classify(to) !== 'static') return false;
        if (from !== to && isRegionBlock(block)) return false;
        const fromBefore = staticKeys(fromContainer), toBefore = staticKeys(container);
        container.insertBefore(block, ref);
        if (container === fromContainer) return commitOrder(from, container, fromBefore);
        commitMove(from, to, block, fromContainer, fromBefore, toBefore);
        return true;
    }

    function pasteBlock(el) {
        if (!clipboard) return false;
        const container = pasteDest(el === undefined ? target : el); if (!container) return false;
        const block = asPiece(el === undefined ? target : el);
        const area = regionOf(container);
        if (classify(area) === 'data') {
            const arr = dataOps(area); if (!arr) return false;
            const at = block ? recordIndex(area, block) + 1 : arr.length;
            const t = document.createElement('template'); t.innerHTML = clipboard.html;
            const record = { id: freshId(arr, 'pasted'), label: (t.content.textContent || '').trim() };
            arr.splice(at, 0, record);
            commitSplice(area, at, record, 'insert');
            return true;
        }
        if (classify(area) !== 'static') return false;
        const made = materialize(clipboard.html); if (!made) return false;
        insertStatic(area, container, made, block && block.parentElement === container ? block : null);
        return true;
    }

    /* ---- Block hotkeys (outside text) ---- */
    const inText = (e) => e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    function onBlockKey(e, block) {
        if (inText(e)) return false;
        const meta = e.metaKey || e.ctrlKey, k = (e.key || '').toLowerCase();
        if (meta && k === 'c') return copyBlock(block);
        if (meta && k === 'x') return cutBlock(block);
        if (meta && k === 'v') return pasteBlock(block);
        if (meta && k === 'd') return duplicateBlock(block);
        if (!meta && (e.key === 'Delete' || e.key === 'Backspace')) return removeBlock(block);
        return false;
    }

    // Right-click records the piece under the pointer before any menu opens.
    function onContextCapture(e) {
        const area = regionOf(e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement);
        if (!area || !isActive(area)) return;
        setTarget(pieceOf(e.target));
    }
    const setBlockTarget = (el) => setTarget(el && el.nodeType === 1 ? asPiece(el) || el : null);
