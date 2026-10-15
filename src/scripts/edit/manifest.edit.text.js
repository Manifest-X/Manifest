    /* ---- Inline text editing ---- */
    // Focus selects the leaf's content; deferred a frame to win over the click's caret.
    function selectAllIn(el) {
        requestAnimationFrame(() => {
            if (dragged || grabbed) return;              // reordering, not editing
            if (document.activeElement !== el) return;
            try { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch { }
        });
    }
    // Where x-text-edit is declared, it owns the element: this plugin neither makes
    // its leaves contenteditable nor competes for the caret. If the rich editor has
    // no expression of its own, we capture what it produces as an ordinary text
    // delta, so a rich field inside a page-editing region publishes like any other.
    function armRichText(area) {
        area.querySelectorAll('[data-text-edit]:not([data-text-edit-bound])').forEach(el => {
            if (!capOf(el, 'text') || !/^[@~]/.test(el.getAttribute('data-edit-key') || '')) return;
            if (el._richBound) return; el._richBound = true;
            el.addEventListener('focusin', () => { el._preEdit = el.innerHTML.trim(); });
            el.addEventListener('blur', () => {
                const a = regionOf(el) || area;   // the region the element sits in NOW, not where it was armed
                const commit = classify(a) === 'component' ? commitComponentNode : commitStaticNode;
                commit(a, el, 'text', el.innerHTML.trim());
            }, true);
        });
    }

    // Static: literal leaves only.
    function armText(area) {
        armRichText(area);
        // An area that is itself the text leaf.
        const nodes = [...area.querySelectorAll('*')];
        if (!realChildren(area).length) nodes.unshift(area);   // size handles are children too
        nodes.forEach(el => {
            if (realChildren(el).length || !el.textContent.trim() || el.closest('template') || el.hasAttribute('data-edit-handle')) return;
            if (el.closest('[data-text-edit]')) return;                 // the rich editor owns this subtree
            if (!capOf(el, 'text') || isRendered(el) || RAW_EDIT.has(el.tagName)) return;
            if (!/^[@~]/.test(el.getAttribute('data-edit-key') || '')) return;   // only what will be logged and published
            el.setAttribute('contenteditable', 'true');
            if (el._textBound) return; el._textBound = true;
            el.addEventListener('focus', () => { el._preEdit = el.innerHTML.trim(); selectAllIn(el); });
            el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.isContentEditable) { e.preventDefault(); e.stopPropagation(); leaveText(el); } });
            el.addEventListener('blur', () => commitStaticNode(regionOf(el) || area, el, 'text', el.innerHTML.trim()));   // live region: the element may have moved since arming
        });
    }

    /* ---- Data values (.data): x-for fields bound to a plain `item.field` are editable ---- */
    function armDataValues(area) {
        const tpl = listTpl(area); if (!tpl) return;
        const lv = (tpl.getAttribute('x-for').match(/^\s*([\w$]+)\s+in\b/) || [])[1]; if (!lv) return;
        const source = dataSourceName(area), fieldRe = new RegExp('^\\s*' + lv + '\\.([\\w$]+)\\s*$');
        sortableChildren(area).forEach(clone => {
            const id = clone.getAttribute('data-key'); if (id == null) return;
            clone.querySelectorAll('*').forEach(el => {
                if (el.children.length || el.hasAttribute('data-edit-handle')) return;
                const rich = el.hasAttribute('x-html');
                const expr = el.getAttribute('x-text') || el.getAttribute('x-html'); if (!expr) return;
                const m = expr.match(fieldRe); if (!m) return;
                const field = m[1];
                el._editField = field;
                // x-html fields hold markup; x-text fields are plain.
                el._editRich = rich;
                if (!el.hasAttribute('data-text-edit')) el.setAttribute('contenteditable', 'true');
                if (el._dvBound) return; el._dvBound = true;
                const read = () => rich ? el.innerHTML.trim() : el.textContent;
                el.addEventListener('focus', () => { el._preEdit = read(); if (!el.hasAttribute('data-text-edit')) selectAllIn(el); });   // the rich editor owns its caret
                el.addEventListener('focusin', () => { el._preEdit = read(); });
                el.addEventListener('blur', () => commitDataValue(area, source, id, field, read(), el), true);
            });
        });
    }

    /* ---- Components: nodes addressed by structural path; scope via $edit.scope ---- */
    const componentName = (area) => { const r = area.querySelector('[data-component]'); return (r?.getAttribute('data-component') || '').replace(/-\d+$/, ''); };
    function pathOf(node, root) { const idx = []; let n = node; while (n && n !== root && n.parentElement) { idx.unshift(realChildren(n.parentElement).indexOf(n)); n = n.parentElement; } return idx.join('.'); }
    function nodeByPath(root, path) { let el = root; for (const i of path.split('.').map(Number)) { el = realChildren(el)[i]; if (!el) return null; } return el; }
    // 'main' scope: mirror live to other instances without their own override.
    function liveMainPropagate(area, sourceEl, prop, value) {
        if ((area._editScope || 'instance') !== 'main') return;
        const comp = componentName(area), path = sourceEl._editPath, { inst } = componentState();
        areas().forEach(a => {
            if (classify(a) !== 'component' || componentName(a) !== comp) return;
            const root = a.querySelector('[data-component]'); if (!root) return;
            const el = path === '' ? root : nodeByPath(root, path); if (!el || el === sourceEl) return;
            const iv = (inst[key(a)] && inst[key(a)][path]) || {}; if (iv[prop] !== undefined) return;   // override wins
            if (prop === 'class') writeClass(el, value);
            else if (el.innerHTML !== value) el.innerHTML = value;
        });
    }
    function armComponent(area) {
        const root = area.querySelector('[data-component]'); if (!root) return;
        if (!area._editScope) area._editScope = 'instance';
        area._baseText = area._baseText || {}; area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {};
        const markClass = (el) => { const p = pathOf(el, root); el._editPath = p; if (!(p in area._baseClass)) area._baseClass[p] = el.getAttribute('class') || ''; if (!(p in area._baseStyle)) area._baseStyle[p] = el.getAttribute('style') || ''; };
        markClass(root);
        root.querySelectorAll('*').forEach(el => { if (!el.hasAttribute('data-edit-handle')) markClass(el); });
        armRichText(area);
        componentNodes(root).forEach(el => {
            if (el.children.length || !el.textContent.trim() || !capOf(el, 'text')) return;
            if (el.closest('[data-text-edit]')) return;                 // the rich editor owns this subtree
            const p = el._editPath;
            if (!(p in area._baseText)) area._baseText[p] = el.innerHTML.trim();
            el.setAttribute('contenteditable', 'true');
            if (el._textBound) return; el._textBound = true;
            el.addEventListener('focus', () => { el._preEdit = el.innerHTML.trim(); selectAllIn(el); });
            el.addEventListener('input', () => liveMainPropagate(area, el, 'text', el.innerHTML));
            el.addEventListener('blur', () => commitComponentNode(area, el, 'text', el.innerHTML.trim()));
        });
    }
    // Escape leaves text with the piece focused, so Alt+arrows move it.
    function leaveText(el) {
        el.blur();
        const piece = [el, ...ancestorsIn(el)].find(n => n.hasAttribute && n.hasAttribute('data-edit-piece'));
        if (!piece) return;
        if (piece.isContentEditable) {
            piece._pieceMode = true;
            piece.setAttribute('contenteditable', 'false');
            piece.addEventListener('focusout', () => exitPieceMode(piece), { once: true });
        }
        try { piece.focus(); } catch { }
    }
    const ancestorsIn = (el) => { const out = [], area = regionOf(el); for (let n = el.parentElement; n && n !== area; n = n.parentElement) out.push(n); return out; };
    function exitPieceMode(el, edit) {
        if (!el._pieceMode) return;
        el._pieceMode = false;
        if (el.getAttribute('contenteditable') === 'false') el.setAttribute('contenteditable', 'true');
        if (edit) { try { el.focus(); } catch { } selectAllIn(el); }
    }
