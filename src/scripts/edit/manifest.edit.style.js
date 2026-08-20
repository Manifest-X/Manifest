    /* ---- Style: right-click → live utility-class input (no Apply; commit on close) ---- */
    let menu;
    function closeMenu() {
        if (!menu || menu.hidden) return;
        if (menu._dirty && menu._target) { commitStaticNode(menu._target.closest('[data-edit-area]'), menu._target, 'class', menu._target.getAttribute('class') || ''); menu._dirty = false; }
        menu.hidden = true; menu._target = null;
    }
    function ensureMenu() {
        if (menu) return menu;
        menu = document.createElement('div'); menu.setAttribute('data-edit-menu', ''); menu.hidden = true;
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
        m.style.left = Math.min(x, innerWidth - 280) + 'px'; m.style.top = Math.min(y, innerHeight - 130) + 'px'; m.hidden = false;
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }
    function armStyle(area) {
        if (area._styleBound) return; area._styleBound = true;
        area.addEventListener('contextmenu', (e) => {
            if (!isActive(area)) return;
            let t = e.target;
            while (t && t !== area.parentElement && !(capOf(t, 'style') && !locked(t) && !t.hasAttribute('data-edit-handle'))) t = t.parentElement;
            if (!t || !capOf(t, 'style') || locked(t)) return;
            e.preventDefault(); e.stopPropagation();
            openMenu(t, e.clientX, e.clientY);
        });
    }
