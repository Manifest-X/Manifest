    /* ---- Authoring chrome: floating toolbar (undo/redo/publish/reset). A convenience
       over the $edit magic — built on first use and shown only where there is
       something to edit, so it never sits on a route with no editable area. ---- */
    let bar;
    function buildUI() {
        if (bar) return bar;
        bar = document.createElement('div'); bar.setAttribute('data-edit-toolbar', '');
        bar.innerHTML = '<button class="ghost" data-a="undo">↶ Undo</button><button class="ghost" data-a="redo">↷ Redo</button><button class="brand" data-a="publish">Publish</button><button class="ghost" data-a="reset">Reset</button>';
        bar.addEventListener('click', e => {
            const btn = e.target.closest('button'); if (!btn) return; const a = btn.getAttribute('data-a');
            if (a === 'undo') undo(); if (a === 'redo') redo(); if (a === 'reset') { localStorage.removeItem(LS_KEY); location.reload(); }
            if (a === 'publish') {
                const orig = btn.textContent; btn.disabled = true; btn.textContent = 'Publishing…';
                publish().then(r => { const rs = r.results || []; const w = rs.filter(x => x.status === 'written').length, sk = rs.filter(x => x.status === 'skipped').length; btn.textContent = `Wrote ${w}${sk ? ` · ${sk} skipped` : ''}`; })
                    .catch(() => btn.textContent = 'Failed').finally(() => { btn.disabled = false; setTimeout(() => btn.textContent = orig, 2800); });
            }
        });
        document.body.appendChild(bar);
        return bar;
    }
    // An area hidden by the router is still in the DOM, so ask the layout, not the tree.
    const onScreen = (el) => el.checkVisibility ? el.checkVisibility() : !!el.offsetParent;
    function refresh() {
        if (estore) { estore.canUndo = cursor > 0; estore.canRedo = cursor < log.length; }
        // Script decides presence — it is the only thing that knows which route is on
        // screen. The stylesheet decides whether it is seen.
        const authoring = areas().some(a => a._edit.authoring && isActive(a) && onScreen(a));
        document.documentElement.toggleAttribute('data-edit-active', authoring);
        if (!authoring) return;
        buildUI();
        bar.querySelector('[data-a="undo"]').disabled = cursor === 0;
        bar.querySelector('[data-a="redo"]').disabled = cursor >= log.length;
    }

    /* ---- Undo/redo hotkeys: Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y ----
       On wherever a region is active; data-edit-hotkeys="off" on a region or any
       ancestor opts it out. Text that is still being typed keeps the browser's own
       undo until it commits on blur; fields and x-rich-text keep theirs always. */
    const leafText = (el) => el.hasAttribute('data-edit-field') && !el.hasAttribute('data-edit-rich') ? el.textContent : el.innerHTML.trim();
    const hotkeysOff = (el) => !!el.closest('[data-edit-hotkeys="off"]');
    // A leaf the user was typing in commits on blur against its focus-time value;
    // after history rewrites it under the caret, that value must follow (again
    // once Alpine has re-rendered a data field).
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
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[data-rich-text]')) return;
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
