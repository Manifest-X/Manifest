    /* ---- Drag: reorder (in-flow, pointer+keyboard) OR move (positioned) ----
       Pointer-based so it works with mouse, touch, and pen (HTML5 DnD was mouse-only).
       Keyboard: focus an item, Space/Enter to grab, arrows to move, Enter/Esc to drop/cancel. */
    const isPositioned = (el) => { const p = getComputedStyle(el).position; return p === 'absolute' || p === 'fixed'; };
    let grabbed = null, liveRegion;
    function announce(msg) { if (!liveRegion) { liveRegion = document.createElement('div'); liveRegion.setAttribute('data-edit-live', ''); liveRegion.setAttribute('aria-live', 'polite'); document.body.appendChild(liveRegion); } liveRegion.textContent = msg; }

    function makeSortable(container) {
        sortableChildren(container).forEach(child => {
            if (locked(child)) return;
            if (isPositioned(child)) { if (!child._dragBound) { child._dragBound = true; makeMovable(child); } return; }
            child.setAttribute('data-edit-sortable', ''); child.tabIndex = 0; child.setAttribute('role', 'listitem');
            if (child._dragBound) return; child._dragBound = true;
            child.addEventListener('pointerdown', onPointerDown);
            child.addEventListener('keydown', onItemKeydown);
            child.addEventListener('keydown', onBlockKey);
        });
        container.setAttribute('role', 'list');
        // x-for rows and any other late arrivals are not sortable unless we notice
        // them — arming only ever ran once, so a list that grows loses its handles.
        if (!container._sortObserver) {
            container._sortObserver = new MutationObserver(() => {
                if (dragged) return;                        // never re-arm mid-drag
                if (isActive(container.closest('[data-edit-area]'))) makeSortable(container);
            });
            container._sortObserver.observe(container, { childList: true });
        }
    }
    function onPointerDown(e) {
        const item = this, area = item.closest('[data-edit-area]');
        if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0)) return;
        if (e.target.isContentEditable || e.target.hasAttribute('data-edit-handle')) return;   // text/size win
        const container = item.parentElement;
        const homeNext = item.nextElementSibling;          // where to put it back if cancelled
        const start = item.getBoundingClientRect();
        const preStyle = item.getAttribute('style');
        const grabX = e.clientX - start.left, grabY = e.clientY - start.top;
        const sx = e.clientX, sy = e.clientY;
        let active = false, frame = 0, px = sx, py = sy, ghost = null;

        // The item leaves the flow and a stand-in takes its slot, so the gap that
        // opens is a real element the author can style — by default a translucent
        // copy of what is being dragged, showing exactly where it would land.
        const lift = (ev) => {
            ghost = item.cloneNode(true);
            ghost.setAttribute('data-edit-ghost', '');
            ghost.setAttribute('x-ignore', '');            // a clone must not re-bind
            ghost.removeAttribute('id');
            ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
            [ghost, ...ghost.querySelectorAll('*')].forEach(n => {
                [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-') && a.name !== 'data-edit-ghost') n.removeAttribute(a.name); });
                n.removeAttribute('contenteditable'); n.removeAttribute('tabindex'); n.removeAttribute('draggable');
            });
            item.before(ghost);
            item.style.position = 'fixed';
            item.style.width = start.width + 'px';
            item.style.height = start.height + 'px';
            item.style.margin = '0';
            item.style.pointerEvents = 'none';
            item.setAttribute('data-edit-dragging', '');
            area.setAttribute('data-edit-dragging-in', '');
            dragged = ghost;
            try { item.setPointerCapture(ev.pointerId); } catch { }
        };

        const paint = () => {
            frame = 0;
            item.style.left = (px - grabX) + 'px';
            item.style.top = (py - grabY) + 'px';
        };

        const onMove = (ev) => {
            px = ev.clientX; py = ev.clientY;
            if (!active) {
                if (Math.hypot(px - sx, py - sy) < 5) return;   // threshold so taps/clicks still work
                active = true; lift(ev); paint();
            }
            ev.preventDefault();
            reorderOver(container, px, py);
            if (!frame) frame = requestAnimationFrame(paint);
        };

        const settle = (cancelled) => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('keydown', onKey, true);
            if (frame) cancelAnimationFrame(frame);
            if (!active) return;
            if (cancelled) {
                ghost.remove();
                if (homeNext) container.insertBefore(item, homeNext); else container.appendChild(item);
            } else ghost.replaceWith(item);
            if (preStyle == null) item.removeAttribute('style'); else item.setAttribute('style', preStyle);
            item.removeAttribute('data-edit-dragging');
            area.removeAttribute('data-edit-dragging-in');
            ghost = null; dragged = null;
            if (cancelled) announce('Cancelled'); else finishReorder(area);
        };
        const onUp = () => settle(false);
        // Escape puts it back, the way every drag is expected to be escapable.
        const onKey = (ev) => { if (ev.key !== 'Escape') return; ev.preventDefault(); ev.stopPropagation(); settle(true); };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('keydown', onKey, true);
    }
    function reorderOver(container, x, y) {
        if (!dragged || dragged.parentElement !== container) return;
        const ref = afterElement(container, x, y);
        if (ref === dragged || ref === dragged.nextElementSibling) return;
        if (ref == null) container.appendChild(dragged); else container.insertBefore(dragged, ref);
    }
    function finishReorder(area) { if (classify(area) === 'data') { applyDataOrder(area, sortableChildren(area).map(c => itemKey(c, area))); commit(area); } else commitStaticOrder(area); }
    // Reading-order insertion: block, inline, flex row/col/wrap, grid auto-flow.
    // The FIRST sibling past the pointer, not the nearest — nearest can pick an
    // element further down the list and makes the drop point jump around. Taking the
    // first is also self-stabilising: once the item lands, that sibling's midpoint is
    // behind the pointer, so it does not immediately swap back.
    function afterElement(c, x, y) {
        for (const el of sortableChildren(c)) {
            if (el === dragged || locked(el) || el.hasAttribute('data-edit-dragging')) continue;
            const b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
            const sameRow = Math.abs(cy - y) <= b.height / 2;
            if (cy - y > b.height / 2 || (sameRow && cx > x)) return el;
        }
        return null;
    }
    // Keyboard reorder: grab → arrows move among siblings → drop.
    function onItemKeydown(e) {
        const item = this, area = item.closest('[data-edit-area]'); if (!isActive(area)) return;
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (grabbed === item) { grabbed = null; item.removeAttribute('data-edit-grabbed'); finishReorder(area); item.focus(); announce('Dropped'); }
            else { if (grabbed) grabbed.removeAttribute('data-edit-grabbed'); grabbed = item; item.setAttribute('data-edit-grabbed', ''); announce('Grabbed — arrow keys to move, Enter to drop'); }
            return;
        }
        if (grabbed !== item) return;
        if (e.key === 'Escape') { e.preventDefault(); grabbed = null; item.removeAttribute('data-edit-grabbed'); item.focus(); announce('Cancelled'); return; }
        const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
        if (dir == null) return;
        e.preventDefault();
        const sibs = sortableChildren(item.parentElement).filter(c => !locked(c)), i = sibs.indexOf(item), j = i + dir;
        if (j < 0 || j >= sibs.length) return;
        if (dir > 0) sibs[j].after(item); else sibs[j].before(item);
        item.focus(); announce(`Position ${j + 1} of ${sibs.length}`);
    }
    // Move mode: positioned elements → pointer-drag left/top (touch-capable) + keyboard nudge, unit-preserving.
    function makeMovable(el) {
        el.setAttribute('data-edit-movable', ''); el.tabIndex = 0; el.setAttribute('role', 'application'); el.setAttribute('aria-label', 'Draggable; arrow keys to move');
        el.addEventListener('pointerdown', (e) => {
            const area = el.closest('[data-edit-area]');
            if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0) || e.target.isContentEditable || e.target.hasAttribute('data-edit-handle')) return;
            e.preventDefault(); el._preStyle = el.getAttribute('style') || '';
            const cs = getComputedStyle(el), parent = el.offsetParent || el.parentElement;
            const lu = unitOf(el.style.left) || 'px', tu = unitOf(el.style.top) || 'px';
            const baseL = parseFloat(cs.left) || 0, baseT = parseFloat(cs.top) || 0, sx = e.clientX, sy = e.clientY;
            const ov = showOverlay();
            const move = (ev) => { ev.preventDefault(); el.style.left = toUnit(baseL + (ev.clientX - sx), lu, el, parent, 'w') + lu; el.style.top = toUnit(baseT + (ev.clientY - sy), tu, el, parent, 'h') + tu; };
            const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); hideOverlay(ov); commitStyle(area, el); };
            document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
        });
        el.addEventListener('keydown', (e) => {
            const area = el.closest('[data-edit-area]'); if (!isActive(area)) return;
            const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!d) return;
            e.preventDefault();
            if (!el._moveTimer) el._preStyle = el.getAttribute('style') || '';   // baseline at start of a key burst
            const step = e.shiftKey ? 16 : 4, cs = getComputedStyle(el), parent = el.offsetParent || el.parentElement;
            const lu = unitOf(el.style.left) || 'px', tu = unitOf(el.style.top) || 'px';
            if (d[0]) el.style.left = toUnit((parseFloat(cs.left) || 0) + d[0] * step, lu, el, parent, 'w') + lu;
            if (d[1]) el.style.top = toUnit((parseFloat(cs.top) || 0) + d[1] * step, tu, el, parent, 'h') + tu;
            clearTimeout(el._moveTimer); el._moveTimer = setTimeout(() => { el._moveTimer = null; commitStyle(area, el); }, 350);
        });
    }
