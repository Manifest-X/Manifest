    /* ---- Drag: reorder (in-flow, pointer+keyboard) OR move (positioned) ----
       Pointer-based so it works with mouse, touch, and pen (HTML5 DnD was mouse-only).
       Keyboard: focus an item, Space/Enter to grab, arrows to move, Enter/Esc to drop/cancel. */
    const isPositioned = (el) => { const p = getComputedStyle(el).position; return p === 'absolute' || p === 'fixed'; };
    let lastMoveX = 0, lastMoveY = 0, grabbed = null, liveRegion;
    function announce(msg) { if (!liveRegion) { liveRegion = document.createElement('div'); liveRegion.className = 'edit-sr'; liveRegion.setAttribute('aria-live', 'polite'); document.body.appendChild(liveRegion); } liveRegion.textContent = msg; }

    function makeSortable(container) {
        sortableChildren(container).forEach(child => {
            if (locked(child)) return;
            if (isPositioned(child)) { if (!child._dragBound) { child._dragBound = true; makeMovable(child); } return; }
            child.setAttribute('data-edit-sortable', ''); child.tabIndex = 0; child.setAttribute('role', 'listitem');
            if (child._dragBound) return; child._dragBound = true;
            child.addEventListener('pointerdown', onPointerDown);
            child.addEventListener('keydown', onItemKeydown);
        });
        container.setAttribute('role', 'list');
    }
    function onPointerDown(e) {
        const item = this, area = item.closest('[data-edit-area]');
        if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0)) return;
        if (e.target.isContentEditable || e.target.classList.contains('edit-handle')) return;   // text/size win
        const container = item.parentElement, sx = e.clientX, sy = e.clientY; let active = false;
        const onMove = (ev) => {
            if (!active) {
                if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;   // threshold so taps/clicks still work
                active = true; dragged = item; item.setAttribute('data-edit-dragging', ''); lastMoveX = ev.clientX; lastMoveY = ev.clientY;
            }
            ev.preventDefault();
            reorderOver(container, ev.clientX, ev.clientY);
        };
        const onUp = () => {
            document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp);
            if (active) { item.removeAttribute('data-edit-dragging'); dragged = null; finishReorder(area); }
        };
        document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp);
    }
    function reorderOver(container, x, y) {   // hysteresis dead-zone kills the reflow swap-back oscillation
        if (!dragged || dragged.parentElement !== container) return;
        if (Math.hypot(x - lastMoveX, y - lastMoveY) < 6) return;
        lastMoveX = x; lastMoveY = y;
        const ref = afterElement(container, x, y);
        if (ref === dragged || ref === dragged.nextElementSibling) return;
        if (ref == null) container.appendChild(dragged); else container.insertBefore(dragged, ref);
    }
    function finishReorder(area) { if (classify(area) === 'data') { applyDataOrder(area, sortableChildren(area).map(c => c.getAttribute('data-key'))); commit(area); } else commitStaticOrder(area); }
    function afterElement(c, x, y) {   // reading-order insertion: block, inline, flex row/col/wrap, grid auto-flow
        let best = null, bestDist = Infinity;
        for (const el of sortableChildren(c)) {
            if (el === dragged || locked(el)) continue;
            const b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
            const sameRow = Math.abs(cy - y) <= b.height / 2;
            if (!((cy - y > b.height / 2) || (sameRow && cx > x))) continue;
            const d = (cx - x) ** 2 + (cy - y) ** 2;
            if (d < bestDist) { bestDist = d; best = el; }
        }
        return best;
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
            if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0) || e.target.isContentEditable || e.target.classList.contains('edit-handle')) return;
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
