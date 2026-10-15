    /* ---- Size: edge handles → unit-preserving width/height ----
         --edit-size                 both | x | y | none   axes (default both)
         --edit-size-edges           "right bottom-right"  handle list (logical start/end ok)
         --edit-size-handle          1rem                  handle hit area
         --edit-size-snap(-x/-y)     12rem 24rem           snap stops; unset = no snapping
         --edit-size-snap-distance(-x/-y)  1rem            magnet reach; unset = always the nearest stop
         --edit-size-close(-x/-y)    4rem                  below this, an x-show element closes
       `none` on any --edit-size-* cancels an inherited value. Min/max come from native min-/max-width/height. */
    let overlayEl;
    // edit:size fires while dragging (done:false) and once on commit (done:true).
    function sizeEvent(el, done) {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new CustomEvent('edit:size', {
            bubbles: true,
            detail: { width: r.width, height: r.height, css: { width: el.style.width, height: el.style.height }, done }
        }));
    }
    function showOverlay() { if (!overlayEl) { overlayEl = document.createElement('div'); overlayEl.setAttribute('data-edit-overlay', ''); document.body.appendChild(overlayEl); } overlayEl.style.display = 'block'; return overlayEl; }
    function hideOverlay() { if (overlayEl) overlayEl.style.display = 'none'; }

    const isRTL = (el) => getComputedStyle(el).direction === 'rtl';
    // Resolve logical start/end to physical left/right per the element's direction.
    function physical(pos, el) {
        const rtl = isRTL(el);
        return pos.replace(/start/g, rtl ? 'right' : 'left').replace(/end/g, rtl ? 'left' : 'right');
    }
    // Containing-block size for % limits (null when the height is not definite).
    function blockSize(el, dim) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed') return dim === 'w' ? document.documentElement.clientWidth : document.documentElement.clientHeight;
        const cb = pos === 'absolute' ? el.offsetParent || el.parentElement : el.parentElement;
        if (!cb) return null;
        const ps = getComputedStyle(cb), w = dim === 'w';
        const box = w ? cb.clientWidth : cb.clientHeight;
        if (pos === 'absolute') return box;
        if (!w && !definiteHeight(cb)) return null;
        return box - (parseFloat(w ? ps.paddingLeft : ps.paddingTop) || 0) - (parseFloat(w ? ps.paddingRight : ps.paddingBottom) || 0);
    }
    // Specified height via Typed OM; without it (Firefox) only an inline height counts.
    function definiteHeight(el) {
        for (let n = el, depth = 0; n && depth < 32; n = n.parentElement, depth++) {
            if (n === document.documentElement) return true;               // % on the root resolves against the viewport
            const pos = getComputedStyle(n).position;
            if (pos === 'absolute' || pos === 'fixed') return true;
            let h;
            if (n.computedStyleMap) { try { h = String(n.computedStyleMap().get('height')).trim(); } catch { } }
            if (h == null) h = (n.style && n.style.height || '').trim() || 'auto';
            if (h === 'auto' || h === '') return false;
            if (!h.endsWith('%')) return true;                           // a length (or calc) is definite
        }
        return false;
    }
    function limitPx(v, el, dim, none) {
        v = String(v || '').trim();
        if (!v || v === 'none' || v === 'auto') return none;
        if (/^-?[\d.]+%$/.test(v)) { const b = blockSize(el, dim); return b == null ? none : parseFloat(v) / 100 * b; }
        const px = toPx(v, el, dim);
        return px == null ? none : px;
    }
    function limits(el, cs) {
        const minW = limitPx(cs.minWidth, el, 'w', 0), minH = limitPx(cs.minHeight, el, 'h', 0);
        return { minW, minH, maxW: Math.max(minW, limitPx(cs.maxWidth, el, 'w', Infinity)), maxH: Math.max(minH, limitPx(cs.maxHeight, el, 'h', Infinity)) };   // min wins, as in CSS
    }
    const defaultEdges = (axes) => axes === 'x' ? ['left', 'right'] : axes === 'y' ? ['top', 'bottom'] : ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

    function armSize(el) {
        const axes = cssVar(el, '--edit-size', 'both');
        if (axes === 'none') return;
        if (el._sizeBound) return; el._sizeBound = true;
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        const edges = (cssVar(el, '--edit-size-edges', '') || defaultEdges(axes).join(' ')).split(/\s+/).filter(Boolean);
        edges.forEach(pos => {
            const phys = physical(pos, el);
            const h = document.createElement('span');
            h.setAttribute('data-edit-handle', pos);
            h.tabIndex = 0; h.setAttribute('role', 'slider'); h.setAttribute('aria-label', `Resize ${pos}`);
            h.addEventListener('pointerdown', (e) => startSize(e, el, phys));
            h.addEventListener('keydown', (e) => keyResize(e, el, phys));
            el.appendChild(h);
        });
    }
    // Keyboard: arrows resize (Shift = larger step); a key burst commits once.
    let _keyTimer;
    function keyResize(e, el, pos) {
        const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!map[e.key]) return;
        const area = regionOf(el); if (!isActive(area)) return;
        e.preventDefault(); e.stopPropagation();
        if (!_keyTimer) el._preStyle = el.getAttribute('style') || '';
        const [kx, ky] = map[e.key], step = e.shiftKey ? 32 : 8, cs = getComputedStyle(el);
        const right = pos.includes('right'), left = pos.includes('left'), top = pos.includes('top'), bottom = pos.includes('bottom');
        const wu = unitOf(el.style.width) || 'px', hu = unitOf(el.style.height) || 'px';
        const { minW, maxW, minH, maxH } = limits(el, cs);
        if ((right || left) && kx) { const w = clamp((parseFloat(cs.width) || 0) + kx * step * (right ? 1 : -1), minW, maxW); el.style.width = toUnit(w, wu, el, el.parentElement, 'w') + wu; }
        if ((top || bottom) && ky) { const h = clamp((parseFloat(cs.height) || 0) + ky * step * (bottom ? 1 : -1), minH, maxH); el.style.height = toUnit(h, hu, el, el.parentElement, 'h') + hu; }
        sizeEvent(el, false);
        clearTimeout(_keyTimer); _keyTimer = setTimeout(() => { _keyTimer = null; commitStyle(regionOf(el), el); sizeEvent(el, true); }, 350);
    }
    const axisVar = (el, base, axis) => cssVar(el, `${base}-${axis}`, '') || cssVar(el, base, '');
    function snapStops(el, axis, dim) {
        return axisVar(el, '--edit-size-snap', axis).split(/\s+/).filter(Boolean).map(s => toPx(s, el, dim)).filter(v => v != null);
    }
    function snapTo(v, stops, reach) {
        if (!stops.length) return v;
        let best = v, d = Infinity;
        for (const p of stops) { const dd = Math.abs(v - p); if (dd < d) { d = dd; best = p; } }
        return reach == null || d <= reach ? best : v;
    }
    const lengthVar = (el, base, axis, dim) => { const v = axisVar(el, base, axis); return v ? toPx(v, el, dim) : null; };
    // Close rides x-show: only an assignable expression can be set false.
    const ASSIGNABLE = /^\s*[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]]+\])*\s*$/;
    function closeVia(el) {
        const expr = el.getAttribute('x-show');
        if (expr == null) return false;
        if (!ASSIGNABLE.test(expr)) { console.warn('[edit] --edit-size-close needs an assignable x-show expression (e.g. x-show="open"):', expr); return false; }
        try { window.Alpine.evaluate(el, `${expr} = false`); return true; } catch (err) { console.warn('[edit] could not close via x-show:', err); return false; }
    }
    function startSize(e, el, pos) {
        const area = regionOf(el);
        if (!isActive(area) || e.button !== 0) return;
        e.preventDefault(); e.stopPropagation(); el._preStyle = el.getAttribute('style') || '';
        const cs = getComputedStyle(el), rect = el.getBoundingClientRect();
        const wu = unitOf(el.style.width) || 'px', hu = unitOf(el.style.height) || 'px';
        const baseW = parseFloat(cs.width) || rect.width, baseH = parseFloat(cs.height) || rect.height, sx = e.clientX, sy = e.clientY;
        const { minW, maxW, minH, maxH } = limits(el, cs);
        const right = pos.includes('right'), left = pos.includes('left'), bottom = pos.includes('bottom'), top = pos.includes('top');
        const reachX = lengthVar(el, '--edit-size-snap-distance', 'x', 'w'), reachY = lengthVar(el, '--edit-size-snap-distance', 'y', 'h');
        const snapW = snapStops(el, 'x', 'w'), snapH = snapStops(el, 'y', 'h');
        const closeX = lengthVar(el, '--edit-size-close', 'x', 'w'), closeY = lengthVar(el, '--edit-size-close', 'y', 'h');
        showOverlay();
        let lastW = baseW, lastH = baseH, rawW = baseW, rawH = baseH;
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (right || left) { rawW = baseW + (right ? dx : -dx); lastW = snapTo(clamp(rawW, minW, maxW), snapW, reachX); el.style.width = toUnit(lastW, wu, el, el.parentElement, 'w') + wu; }
            if (top || bottom) { rawH = baseH + (bottom ? dy : -dy); lastH = snapTo(clamp(rawH, minH, maxH), snapH, reachY); el.style.height = toUnit(lastH, hu, el, el.parentElement, 'h') + hu; }
            sizeEvent(el, false);
        };
        const up = () => {
            document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); hideOverlay();
            const shutX = (right || left) && closeX != null && rawW < closeX, shutY = (top || bottom) && closeY != null && rawH < closeY;
            if ((shutX || shutY) && el.hasAttribute('x-show')) {
                if (shutX) el.style.width = toUnit(minW, wu, el, el.parentElement, 'w') + wu;
                if (shutY) el.style.height = toUnit(minH, hu, el, el.parentElement, 'h') + hu;
                commitStyle(area, el); sizeEvent(el, true);
                closeVia(el);
                return;
            }
            commitStyle(area, el); sizeEvent(el, true);
        };
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    }
