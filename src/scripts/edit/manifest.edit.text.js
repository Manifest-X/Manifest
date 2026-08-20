    /* ---- Inline text editing ---- */
    // Where x-text-edit is declared, it owns the element: this plugin neither makes
    // its leaves contenteditable nor competes for the caret. If the rich editor has
    // no expression of its own, we capture what it produces as an ordinary text
    // delta, so a rich field inside a page-editing region publishes like any other.
    function armRichText(area) {
        area.querySelectorAll('[data-text-edit]:not([data-text-edit-bound])').forEach(el => {
            if (!capOf(el, 'text') || locked(el)) return;
            if (el._richBound) return; el._richBound = true;
            el.addEventListener('focusin', () => { el._preEdit = el.innerHTML.trim(); });
            el.addEventListener('blur', () => {
                const commit = classify(area) === 'component' ? commitComponentNode : commitStaticNode;
                commit(area, el, 'text', el.innerHTML.trim());
            }, true);
        });
    }

    // STATIC: literal leaves only (skip bound nodes; those belong to data/component).
    function armText(area) {
        armRichText(area);
        area.querySelectorAll('*').forEach(el => {
            if (el.children.length || !el.textContent.trim() || el.closest('template') || el.hasAttribute('data-edit-handle')) return;
            if (el.closest('[data-text-edit]')) return;                 // the rich editor owns this subtree
            if (!capOf(el, 'text') || el.hasAttribute('x-text') || el.hasAttribute('x-html')) return;
            el.setAttribute('contenteditable', 'true');
            if (el._textBound) return; el._textBound = true;
            el.addEventListener('focus', () => { el._preEdit = el.innerHTML.trim(); const d = el.closest('[draggable="true"]'); if (d) d.setAttribute('draggable', 'false'); });
            el.addEventListener('blur', () => { const d = el.closest('[data-edit-area] [draggable="false"]'); if (d) d.setAttribute('draggable', 'true'); commitStaticNode(area, el, 'text', el.innerHTML.trim()); });
        });
    }

    /* ---- DATA value editing (opt-in .data): make $x-bound leaves in an x-for list editable,
       but ONLY when the binding is a SIMPLE field ref of the loop var (p.name) — computed
       expressions (e.g. '$' + p.price) stay read-only. Edit → data mutation, not HTML.
       (Scope today: x-for list item fields. Direct $x.a.b bindings outside a list are a
       natural extension — different addressing {source,path} + key-value write-back.) ---- */
    function armDataValues(area) {
        const tpl = area.querySelector('template[x-for]'); if (!tpl) return;
        const lv = (tpl.getAttribute('x-for').match(/^\s*([\w$]+)\s+in\b/) || [])[1]; if (!lv) return;
        const source = dataSourceName(area), fieldRe = new RegExp('^\\s*' + lv + '\\.([\\w$]+)\\s*$');
        sortableChildren(area).forEach(clone => {
            const id = clone.getAttribute('data-key'); if (id == null) return;
            clone.querySelectorAll('*').forEach(el => {
                if (el.children.length || el.hasAttribute('data-edit-handle')) return;
                const expr = el.getAttribute('x-text') || el.getAttribute('x-html'); if (!expr) return;
                const m = expr.match(fieldRe); if (!m) return;
                const field = m[1];
                el.setAttribute('contenteditable', 'true'); el.setAttribute('data-edit-field', field);
                if (el._dvBound) return; el._dvBound = true;
                el.addEventListener('focus', () => { el._preEdit = el.textContent; });
                el.addEventListener('blur', () => commitDataValue(area, source, id, field, el.textContent, el));
            });
        });
    }

    /* ---- COMPONENT editing: text leaves addressed by structural path. Right-click an
       instance for the scope (this instance vs all) + per-element classes + revert. ---- */
    const componentName = (area) => { const r = area.querySelector('[data-component]'); return (r?.getAttribute('data-component') || '').replace(/-\d+$/, ''); };
    function pathOf(node, root) { const idx = []; let n = node; while (n && n !== root && n.parentElement) { idx.unshift(Array.from(n.parentElement.children).indexOf(n)); n = n.parentElement; } return idx.join('.'); }
    function nodeByPath(root, path) { let el = root; for (const i of path.split('.').map(Number)) { el = el.children[i]; if (!el) return null; } return el; }
    // While editing in 'All' scope, mirror the edit to every OTHER instance live — but
    // skip the source element (don't fight the caret) and skip any instance that has its
    // OWN committed override for this node/prop (instance overrides always win).
    function liveMainPropagate(area, sourceEl, prop, value) {
        if ((area._editScope || 'instance') !== 'main') return;
        const comp = componentName(area), path = sourceEl.getAttribute('data-edit-path'), { inst } = componentState();
        document.querySelectorAll('[data-edit-area]').forEach(a => {
            if (!a._edit || classify(a) !== 'component' || componentName(a) !== comp) return;
            const root = a.querySelector('[data-component]'); if (!root) return;
            const el = path === '' ? root : nodeByPath(root, path); if (!el || el === sourceEl) return;
            const iv = (inst[key(a)] && inst[key(a)][path]) || {}; if (iv[prop] !== undefined) return;   // override wins
            if (prop === 'class') { if (el.getAttribute('class') !== value) el.setAttribute('class', value); }
            else if (el.innerHTML !== value) el.innerHTML = value;
        });
    }
    function armComponent(area) {
        const root = area.querySelector('[data-component]'); if (!root) return;
        if (!area._editScope) { area._editScope = 'instance'; area.setAttribute('data-edit-scope', 'instance'); }
        area._baseText = area._baseText || {}; area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {};
        // Mark the root AND every element with a path → all are class-editable (incl. the parent).
        const markClass = (el) => { const p = pathOf(el, root); el.setAttribute('data-edit-path', p); if (!(p in area._baseClass)) area._baseClass[p] = el.getAttribute('class') || ''; if (!(p in area._baseStyle)) area._baseStyle[p] = el.getAttribute('style') || ''; };
        markClass(root);
        root.querySelectorAll('*').forEach(el => { if (!el.hasAttribute('data-edit-handle')) markClass(el); });
        // Text leaves also become contenteditable. Capture innerHTML (not textContent) so
        // nested inline elements like <i>/<br> the user adds are preserved.
        armRichText(area);
        root.querySelectorAll('[data-edit-path]').forEach(el => {
            if (el.children.length || !el.textContent.trim() || !capOf(el, 'text')) return;
            if (el.closest('[data-text-edit]')) return;                 // the rich editor owns this subtree
            const p = el.getAttribute('data-edit-path');
            if (!(p in area._baseText)) area._baseText[p] = el.innerHTML.trim();
            el.setAttribute('contenteditable', 'true');
            if (el._textBound) return; el._textBound = true;
            el.addEventListener('focus', () => { el._preEdit = el.innerHTML.trim(); });
            el.addEventListener('input', () => liveMainPropagate(area, el, 'text', el.innerHTML));
            el.addEventListener('blur', () => commitComponentNode(area, el, 'text', el.innerHTML.trim()));
        });
        if (area._cmpMenuBound) return; area._cmpMenuBound = true;
        area.addEventListener('contextmenu', e => {
            if (onBlockContext(e)) return;                      // a project menu took it
            if (area._edit.authoring) openComponentMenu(e, area);
        });
    }
    let cmpMenu;
    function openComponentMenu(e, area) {
        if (!isActive(area)) return; e.preventDefault(); e.stopPropagation();
        const target = e.target.closest('[data-edit-path]');
        if (!cmpMenu) {
            cmpMenu = document.createElement('div'); cmpMenu.setAttribute('data-edit-menu', ''); cmpMenu.hidden = true;
            cmpMenu.addEventListener('pointerdown', ev => ev.stopPropagation());
            document.body.appendChild(cmpMenu);
            document.addEventListener('pointerdown', () => { if (cmpMenu) cmpMenu.hidden = true; });
        }
        if (target) target._preClass = target.getAttribute('class') || '';
        const cur = area._editScope || 'instance';
        cmpMenu.innerHTML =
            `<small>Scope · ${componentName(area)}</small>`
            + `<div class="row"><button class="ghost sm" data-s="instance">${cur === 'instance' ? '✓ ' : ''}This instance</button><button class="ghost sm" data-s="main">${cur === 'main' ? '✓ ' : ''}All</button></div>`
            + (target ? `<small>Classes · ${target.tagName.toLowerCase()} · live</small><input type="text" spellcheck="false" data-cls>` : '')
            + `<div class="row">${target ? '<button class="ghost sm" data-a="revert">Revert element</button>' : ''}<button class="ghost sm" data-a="revertall">Revert all</button></div>`;
        cmpMenu.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { area._editScope = b.getAttribute('data-s'); area.setAttribute('data-edit-scope', area._editScope); area.setAttribute('data-edit-label', `${key(area)} · component · ${area._editScope}`); openComponentMenu(e, area); });
        const cls = cmpMenu.querySelector('[data-cls]');
        if (cls && target) {
            cls.value = target.getAttribute('class') || '';
            cls.addEventListener('input', () => { target.setAttribute('class', cls.value); liveMainPropagate(area, target, 'class', cls.value); });
            cls.addEventListener('change', () => commitComponentNode(area, target, 'class', cls.value));
            cls.addEventListener('keydown', ev => { if (ev.key === 'Enter') cls.blur(); });
        }
        const rv = cmpMenu.querySelector('[data-a="revert"]'); if (rv) rv.onclick = () => { revertNode(area, target); cmpMenu.hidden = true; };
        cmpMenu.querySelector('[data-a="revertall"]').onclick = () => { revertAll(area); cmpMenu.hidden = true; };
        cmpMenu.style.left = Math.min(e.clientX, innerWidth - 240) + 'px'; cmpMenu.style.top = Math.min(e.clientY, innerHeight - 180) + 'px'; cmpMenu.hidden = false;
        if (cls) setTimeout(() => cls.focus(), 0);
    }
