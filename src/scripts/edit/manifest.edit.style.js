    /* ---- Style: right-click → live utility-class input (no Apply; commit on close) ---- */
    let menu;
    function closeMenu() {
        if (!menu || !menu.matches(':popover-open')) return;
        if (menu._dirty && menu._target) { commitStaticNode(menu._target.closest('[data-edit-area]'), menu._target, 'class', menu._target.getAttribute('class') || ''); menu._dirty = false; }
        try { menu.hidePopover(); } catch { } menu._target = null;
    }
    function ensureMenu() {
        if (menu) return menu;
        // A real popover: the top layer is above every stacking context, so the menu
        // cannot be painted over by a resize handle or anything else with a z-index.
        menu = document.createElement('div'); menu.setAttribute('data-edit-menu', ''); menu.setAttribute('popover', 'manual');
        menu.innerHTML = '<small>Classes <span data-tag></span> · live</small><input type="text" spellcheck="false"><div class="row"><button class="ghost sm" data-a="close">Done</button></div>';
        menu.addEventListener('pointerdown', e => e.stopPropagation());
        const input = menu.querySelector('input');
        input.addEventListener('input', () => { if (menu._target) { menu._target.setAttribute('class', input.value); menu._dirty = true; } });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') closeMenu(); });
        menu.querySelector('[data-a="close"]').addEventListener('click', closeMenu);
        document.body.appendChild(menu);
        document.addEventListener('pointerdown', closeMenu);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
        return menu;
    }
    function openMenu(el, x, y) {
        const m = ensureMenu(); m._target = el; m._dirty = false; el._preClass = el.getAttribute('class') || '';
        m.querySelector('[data-tag]').textContent = '· ' + el.tagName.toLowerCase();
        const input = m.querySelector('input'); input.value = el.getAttribute('class') || '';
        m.style.left = Math.min(x, innerWidth - 280) + 'px'; m.style.top = Math.min(y, innerHeight - 130) + 'px';
        if (!m.matches(':popover-open')) { try { m.showPopover(); } catch { } }
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }
    // The class menu is authoring chrome, so it only opens where chrome was asked for.
    function openClassMenu(area, e) {
        if (!area._edit.authoring) return;
        let t = e.target;
        while (t && t !== area.parentElement && !(capOf(t, 'style') && !locked(t) && !t.hasAttribute('data-edit-handle'))) t = t.parentElement;
        if (!t || !capOf(t, 'style') || locked(t)) return;
        openMenu(t, e.clientX, e.clientY);
    }
