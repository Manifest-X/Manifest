    /* ---- Inline text editing ---- */
    // Focus selects the leaf's content; deferred a frame to win over the click's caret.
    function selectAllIn(el) {
        requestAnimationFrame(() => {
            if (dragged || grabbed) return;              // reordering, not editing
            if (document.activeElement !== el) return;
            try { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch { }
        });
    }
    // A link clicked in an active area is content: neither the router nor the browser follows it,
    // whatever the contenteditable state (a piece at rest is contenteditable=false). A
    // contenteditable=false island that is not a resting piece keeps its links. Runs on window,
    // capture, ahead of the router's document listener.
    function islandLink(link, area) {
        const off = link.closest('[contenteditable="false"]');
        return !!off && area.contains(off) && !off.hasAttribute('data-edit-piece-mode');
    }
    function onAreaLinkClick(e) {
        const link = e.target && e.target.closest && e.target.closest('a[href]');
        const area = link && regionOf(link);
        if (!area || !isActive(area) || islandLink(link, area)) return;
        e.preventDefault();
    }

    /* ---- Rich Text engine: every editable leaf is an inline Rich Text field ---- */
    const richLeaves = new Set();
    let rtMissing = false;
    function rtEngine() {
        const RT = window.ManifestRichText;
        if (RT && typeof RT.attach === 'function') return RT;
        if (!rtMissing) { rtMissing = true; console.warn('[edit] Rich Text is not loaded; text leaves fall back to plain contenteditable'); }
        return null;
    }
    // Edit's own listeners are bound before this, so they run ahead of Rich Text's.
    function editable(el, format) {
        el._editRtFormat = format;
        if (el._editRt || el._pieceMode) return;                         // a focused piece re-attaches when it leaves piece mode
        const RT = rtEngine();
        el._editRtPrior = ['role', 'aria-multiline'].map(a => [a, el.getAttribute(a)]);
        const h = RT && RT.attach(el, { mode: 'inline', breaks: true, all: false, format, onChange: () => { } });
        if (!h) { el.setAttribute('contenteditable', 'true'); return; }
        el._editRt = h;
        el.setAttribute('data-edit-text', '');
        richLeaves.add(el);
    }
    function unedit(el) {
        const h = el._editRt; if (!h) return;
        el._editRt = null; richLeaves.delete(el);
        el.removeAttribute('data-edit-text');
        h.detach();
    }
    // Leaves inside `area`, and any no longer on the page.
    const uneditIn = (area) => richLeaves.forEach(el => { if (!el.isConnected || (area && area.contains(el))) unedit(el); });
    // Rich Text's history spans one edit session: it restarts at focus and when Edit's history moves the text.
    const restartRich = (el) => { const h = el._editRt; if (h) h.value = h.value; };
    /* Undo/redo in a leaf, one session at a time. While focused, each Rich Text step
       (a typing burst, a command, a paste) undoes and redoes on its own. Past the
       session's start, Edit's history takes over; a session with steps still to redo
       first becomes one Edit step (start → furthest state), logged and undone, so Edit's
       redo brings it back whole. Ctrl+Y redoes, as in Edit. */
    function richHistoryKey(e) {
        const el = this, h = el._editRt, dir = historyDir(e);
        if (!h || !dir) return;
        if (h.can(dir)) { e.preventDefault(); e.stopImmediatePropagation(); h[dir](); return; }
        const region = regionOf(el);
        if (dir === 'undo' && region && isActive(region) && !hotkeysOff(el)) handOff(el);   // only when Edit's history will act
        onHistoryKey(e);
        if (e.defaultPrevented) e.stopImmediatePropagation();
    }
    function handOff(el) {
        const h = el._editRt;
        if (!h || !h.can('redo') || !el._commitText) return;
        const top = sessionTop(el);
        if (el._commitText(top)) undo();
    }
    // Drops follow the area's rule (none while active), ahead of Rich Text's own drop handling.
    function noDrop(el) {
        el.addEventListener('drop', (e) => { const a = regionOf(el); if (a && isActive(a)) { e.preventDefault(); e.stopImmediatePropagation(); } });
    }
    // The session's furthest state: the newest entry in the leaf's Rich Text history.
    function sessionTop(el) {
        const html = el._editRt.newest();
        if (!(el._editField && !el._editRich)) return html.trim();
        const t = document.createElement('template'); t.innerHTML = html; return t.content.textContent;
    }
    // Copies and ghosts of a leaf carry none of the engine's attributes or --rich-text-* state.
    function unrich(src, copy) {
        const s = [src, ...src.querySelectorAll('*')], c = [copy, ...copy.querySelectorAll('*')];
        c.forEach(n => { const st = n.getAttribute('style'); if (st && /--rich-text-/.test(st)) { const v = stripRuntime(st); v ? n.setAttribute('style', v) : n.removeAttribute('style'); } });
        s.forEach((n, i) => {
            if (!n._editRt || !c[i]) return;
            [...c[i].attributes].forEach(a => { if (a.name.startsWith('data-rich-text')) c[i].removeAttribute(a.name); });
            (n._editRtPrior || []).forEach(([a, v]) => v == null ? c[i].removeAttribute(a) : c[i].setAttribute(a, v));
        });
    }
    // `commit(value?)` logs the leaf's text against its session start (_preEdit).
    function bindLeaf(el, commit, input) {
        if (el._textBound) return; el._textBound = true;
        el._commitText = commit;
        el.addEventListener('focus', () => { restartRich(el); el._preEdit = leafText(el); selectAllIn(el); });
        el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.isContentEditable) { e.preventDefault(); e.stopImmediatePropagation(); leaveText(el); } });
        el.addEventListener('keydown', richHistoryKey);
        noDrop(el);
        if (input) el.addEventListener('input', input);
        el.addEventListener('blur', () => commit());
    }
    // A rich editor other than this leaf's own owns `el`.
    const richOwned = (el) => { const o = el.closest('[data-rich-text]'); return !!o && (o !== el || !el._editRt); };

    // Where x-rich-text is declared, it owns the element: this plugin neither makes
    // its leaves contenteditable nor competes for the caret. If the rich editor has
    // no expression of its own, we capture what it produces as an ordinary text
    // delta, so a rich field inside a page-editing region publishes like any other.
    function armRichText(area) {
        area.querySelectorAll('[data-rich-text]:not([data-rich-text-bound])').forEach(el => {
            if (el._editRt || !capOf(el, 'text') || !/^[@~]/.test(el.getAttribute('data-edit-key') || '')) return;
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
        if (!realChildren(area).length || wholeLeaf(area)) nodes.unshift(area);   // size handles are children too
        nodes.forEach(el => {
            if ((realChildren(el).length && !wholeLeaf(el)) || !el.textContent.trim() || el.closest('template') || el.hasAttribute('data-edit-handle')) return;
            if (el._manifestComponent && el !== area) return;          // a component host: its markup is another file's
            if (richOwned(el)) return;                                  // the rich editor owns this subtree
            if (el.closest('[contenteditable="false"]:not([data-edit-piece-mode])')) return;   // an authored non-editable island
            if (!capOf(el, 'text') || isRendered(el) || RAW_EDIT.has(el.tagName)) return;
            if (!/^[@~]/.test(el.getAttribute('data-edit-key') || '')) return;   // only what will be logged and published
            bindLeaf(el, (v) => commitStaticNode(regionOf(el) || area, el, 'text', v ?? leafHTML(el)));   // live region: the element may have moved since arming
            editable(el, 'html');
        });
    }

    /* ---- Data values (.data): x-for fields bound to a plain `item.field` are editable ---- */
    function armDataValues(area) {
        const tpl = listTpl(area); if (!tpl) return;
        const lv = (tpl.getAttribute('x-for').match(/^\s*([\w$]+)\s+in\b/) || [])[1]; if (!lv) return;
        const source = dataSourceName(area), fieldRe = new RegExp('^\\s*' + lv + '\\.([\\w$]+)\\s*$');
        sortableChildren(area).forEach(clone => {
            // The record: :data-key names its id; otherwise the row's own x-for scope gives the record (the writer matches records by id)
            let id = clone.getAttribute('data-key');
            if (id == null) { let rec = null; try { rec = window.Alpine.$data(clone)[lv]; } catch { } if (rec && rec.id != null) id = String(rec.id); }
            if (id == null) return;
            [clone, ...clone.querySelectorAll('*')].forEach(el => {
                const rich = el.hasAttribute('x-html');
                if ((el.children.length && !(rich && plainFormatted(el))) || el.hasAttribute('data-edit-handle')) return;
                const expr = el.getAttribute('x-text') || el.getAttribute('x-html'); if (!expr) return;
                const m = expr.match(fieldRe); if (!m) return;
                const field = m[1];
                el._editField = field;
                // x-html fields hold markup; x-text fields are plain.
                el._editRich = rich;
                if (!el._dvBound) {
                    el._dvBound = true;
                    const read = () => rich ? leafHTML(el) : el.textContent;
                    el._commitText = (v) => commitDataValue(area, source, id, field, v ?? read(), el);
                    el.addEventListener('focus', () => { restartRich(el); el._preEdit = leafText(el); if (!authoredRich(el)) selectAllIn(el); });   // the rich editor owns its caret
                    el.addEventListener('focusin', () => { el._preEdit = leafText(el); });
                    el.addEventListener('keydown', richHistoryKey);
                    noDrop(el);
                    el.addEventListener('blur', () => el._commitText(), true);
                }
                if (!authoredRich(el)) editable(el, rich ? 'html' : 'plain');
            });
        });
    }

    /* ---- Components: nodes addressed by structural path; scope via $edit.scope ---- */
    const componentName = (area) => { const r = cmpRoot(area); return (r?.getAttribute('data-component') || '').replace(/-\d+$/, ''); };
    function pathOf(node, root) { const idx = []; let n = node; while (n && n !== root && n.parentElement) { idx.unshift(realChildren(n.parentElement).indexOf(n)); n = n.parentElement; } return idx.join('.'); }
    function nodeByPath(root, path) { let el = root; for (const i of path.split('.').map(Number)) { el = realChildren(el)[i]; if (!el) return null; } return el; }
    // 'main' scope: mirror live to other instances without their own override.
    function liveMainPropagate(area, sourceEl, prop, value) {
        if ((area._editScope || 'instance') !== 'main') return;
        const comp = componentName(area), path = sourceEl._editPath, { inst } = componentState();
        areas().forEach(a => {
            if (classify(a) !== 'component' || componentName(a) !== comp) return;
            const root = cmpRoot(a); if (!root) return;
            const el = path === '' ? root : nodeByPath(root, path); if (!el || el === sourceEl) return;
            const iv = (inst[key(a)] && inst[key(a)][path]) || {}; if (iv[prop] !== undefined) return;   // override wins
            if (prop === 'class') writeClass(el, value);
            else if (el.innerHTML !== value) el.innerHTML = value;
        });
    }
    function armComponent(area) {
        const root = cmpRoot(area); if (!root) return;
        if (!area._editScope) area._editScope = 'instance';
        area._baseText = area._baseText || {}; area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {};
        const markClass = (el) => { const p = pathOf(el, root); el._editPath = p; if (!(p in area._baseClass)) area._baseClass[p] = el.getAttribute('class') || ''; if (!(p in area._baseStyle)) area._baseStyle[p] = el.getAttribute('style') || ''; };
        markClass(root);
        root.querySelectorAll('*').forEach(el => { if (!el.hasAttribute('data-edit-handle')) markClass(el); });
        armRichText(area);
        componentNodes(root).forEach(el => {
            if ((el.children.length && !wholeLeaf(el)) || !el.textContent.trim() || !capOf(el, 'text')) return;
            if (richOwned(el)) return;                                  // the rich editor owns this subtree
            const p = el._editPath;
            if (!(p in area._baseText)) area._baseText[p] = el.innerHTML.trim();
            bindLeaf(el, (v) => commitComponentNode(area, el, 'text', v ?? leafHTML(el)), () => liveMainPropagate(area, el, 'text', el.innerHTML));
            editable(el, 'html');
        });
    }
    // Escape leaves text with the piece focused, so Alt+arrows move it.
    function leaveText(el) {
        el.blur();
        const piece = [el, ...ancestorsIn(el)].find(n => n.hasAttribute && n.hasAttribute('data-edit-piece'));
        if (!piece) return;
        if (piece.isContentEditable) {
            piece._pieceMode = true;
            piece.setAttribute('data-edit-piece-mode', '');
            unedit(piece);                                              // a focused piece is not a text field
            piece.setAttribute('contenteditable', 'false');
            piece.addEventListener('focusout', () => exitPieceMode(piece), { once: true });
        }
        try { piece.focus(); } catch { }
    }
    const ancestorsIn = (el) => { const out = [], area = regionOf(el); for (let n = el.parentElement; n && n !== area; n = n.parentElement) out.push(n); return out; };
    function exitPieceMode(el, edit) {
        if (!el._pieceMode) return;
        el._pieceMode = false;
        el.removeAttribute('data-edit-piece-mode');
        if (el.getAttribute('contenteditable') === 'false') { el.removeAttribute('contenteditable'); editable(el, el._editRtFormat || 'html'); }
        if (edit) { try { el.focus(); } catch { } selectAllIn(el); }
    }
