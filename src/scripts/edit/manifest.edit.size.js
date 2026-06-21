    /* ---- Size: drag handles → unit-preserving width/height (folded-in resize) ----
       CSS-var config (cascades by selector, keeps the directive tight):
         --edit-size              both | x | y | none           which axes (default both)
         --edit-size-edges        e.g. "right bottom-right"      explicit handle list (logical start/end ok)
         --edit-size-handle       1rem                           handle hit area
         --edit-size-snap         12rem 24rem                    snap stops (both axes)
         --edit-size-snap-x/-y    per-axis stop overrides
         --edit-size-snap-distance  1rem                         magnet tolerance (NOT a grid step)
         --edit-size-snap-distance-x/-y  per-axis tolerance
         --edit-size-collapse-x/-y  120px                        collapse below this → [data-edit-collapsed] + 'edit:collapse' event
       (min/max come from the element's native min-/max-width/height.) */
    let overlayEl;
    function showOverlay() { if (!overlayEl) { overlayEl = document.createElement('div'); overlayEl.className = 'edit-overlay'; document.body.appendChild(overlayEl); } overlayEl.style.display = 'block'; return overlayEl; }
    function hideOverlay() { if (overlayEl) overlayEl.style.display = 'none'; }

    const isRTL = (el) => getComputedStyle(el).direction === 'rtl';
    // Resolve logical start/end to physical left/right per the element's direction.
    function physical(pos, el) {
        const rtl = isRTL(el);
        return pos.replace(/start/g, rtl ? 'right' : 'left').replace(/end/g, rtl ? 'left' : 'right');
    }
    const defaultEdges = (axes) => axes === 'x' ? ['left', 'right'] : axes === 'y' ? ['top', 'bottom'] : ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

    function armSize(el) {
        const axes = cssVar(el, '--edit-size', 'both');
        if (axes === 'none') return;
        if (el._sizeBound) return; el._sizeBound = true;
        el.setAttribute('data-edit-sizable', '');
        // Anchor guard: handles are positioned against this element, so it must establish a
        // containing block. The CSS sets position:relative via :where() (overridable); if an
        // author's CSS won and left it static, set it here so handles never detach.
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        const edges = (cssVar(el, '--edit-size-edges', '').trim() || defaultEdges(axes).join(' ')).split(/\s+/).filter(Boolean);
        edges.forEach(pos => {
            const phys = physical(pos, el);                  // keep logical class for CSS; resolve to physical for behavior
            const h = document.createElement('span');
            h.className = `edit-handle edit-handle-${pos}`;
            h.tabIndex = 0; h.setAttribute('role', 'slider'); h.setAttribute('aria-label', `Resize ${pos}`);
            h.addEventListener('pointerdown', (e) => startSize(e, el, phys));
            h.addEventListener('keydown', (e) => keyResize(e, el, phys));
            el.appendChild(h);
        });
    }
    // Keyboard a11y: focus a handle, arrow keys resize (Shift = larger step), debounced commit.
    let _keyTimer;
    function keyResize(e, el, pos) {
        const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!map[e.key]) return;
        const area = el.closest('[data-edit-area]'); if (!isActive(area)) return;
        e.preventDefault();
        if (!_keyTimer) el._preStyle = el.getAttribute('style') || '';   // baseline at start of a key burst
        const [kx, ky] = map[e.key], step = e.shiftKey ? 32 : 8, cs = getComputedStyle(el);
        const right = pos.includes('right'), left = pos.includes('left'), top = pos.includes('top'), bottom = pos.includes('bottom');
        const wu = unitOf(el.style.width) || 'px', hu = unitOf(el.style.height) || 'px';
        const minW = parseFloat(cs.minWidth) || 0, maxW = parseFloat(cs.maxWidth) || Infinity, minH = parseFloat(cs.minHeight) || 0, maxH = parseFloat(cs.maxHeight) || Infinity;
        if ((right || left) && kx) { const w = clamp((parseFloat(cs.width) || 0) + kx * step * (right ? 1 : -1), minW, maxW); el.style.width = toUnit(w, wu, el, el.parentElement, 'w') + wu; }
        if ((top || bottom) && ky) { const h = clamp((parseFloat(cs.height) || 0) + ky * step * (bottom ? 1 : -1), minH, maxH); el.style.height = toUnit(h, hu, el, el.parentElement, 'h') + hu; }
        clearTimeout(_keyTimer); _keyTimer = setTimeout(() => { _keyTimer = null; commitStyle(area, el); }, 350);   // coalesce key bursts into one delta
    }
    function snapStops(el, axisVar, dim) {
        const list = cssVar(el, axisVar, '') || cssVar(el, '--edit-size-snap', '');
        return list.split(/\s+/).filter(Boolean).map(s => toPx(s, el, dim)).filter(v => v != null);
    }
    function startSize(e, el, pos) {
        const area = el.closest('[data-edit-area]');
        if (!isActive(area) || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); el._preStyle = el.getAttribute('style') || '';
        const cs = getComputedStyle(el), rect = el.getBoundingClientRect();
        const wu = unitOf(el.style.width) || 'px', hu = unitOf(el.style.height) || 'px';
        const baseW = parseFloat(cs.width) || rect.width, baseH = parseFloat(cs.height) || rect.height, sx = e.clientX, sy = e.clientY;
        const minW = parseFloat(cs.minWidth) || 0, maxW = parseFloat(cs.maxWidth) || Infinity;
        const minH = parseFloat(cs.minHeight) || 0, maxH = parseFloat(cs.maxHeight) || Infinity;
        const right = pos.includes('right'), left = pos.includes('left'), bottom = pos.includes('bottom'), top = pos.includes('top');
        const tolX = toPx(cssVar(el, '--edit-size-snap-distance-x', '') || cssVar(el, '--edit-size-snap-distance', '0'), el, 'w') || 0;
        const tolY = toPx(cssVar(el, '--edit-size-snap-distance-y', '') || cssVar(el, '--edit-size-snap-distance', '0'), el, 'h') || 0;
        const snapW = snapStops(el, '--edit-size-snap-x', 'w'), snapH = snapStops(el, '--edit-size-snap-y', 'h');
        const collapseX = toPx(cssVar(el, '--edit-size-collapse-x', ''), el, 'w');
        const collapseY = toPx(cssVar(el, '--edit-size-collapse-y', ''), el, 'h');
        const snap = (v, pts, tol) => { if (!tol) return v; for (const p of pts) if (Math.abs(v - p) <= tol) return p; return v; };
        const ov = showOverlay();
        let lastW = baseW, lastH = baseH;
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (right || left) { lastW = snap(clamp(baseW + (right ? dx : -dx), minW, maxW), snapW, tolX); el.style.width = toUnit(lastW, wu, el, el.parentElement, 'w') + wu; }
            if (top || bottom) { lastH = snap(clamp(baseH + (bottom ? dy : -dy), minH, maxH), snapH, tolY); el.style.height = toUnit(lastH, hu, el, el.parentElement, 'h') + hu; }
            const collapsed = (collapseX != null && lastW < collapseX) || (collapseY != null && lastH < collapseY);
            el.toggleAttribute('data-edit-collapsed', collapsed);
        };
        const up = () => {
            document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); hideOverlay(ov);
            if (el.hasAttribute('data-edit-collapsed')) el.dispatchEvent(new CustomEvent('edit:collapse', { bubbles: true }));
            commitStyle(area, el);
        };
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    }
