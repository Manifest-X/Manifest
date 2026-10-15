    /* ---- Move: one pointer engine for reorder, nest, un-nest and cross-area moves ----
       Keyboard: Alt+Up/Down steps among siblings, Alt+Right nests into the previous
       container, Alt+Left moves out one level. Space/Enter grabs, arrows move, Enter drops.
       After a drop, CSS decides: in flow the piece takes DOM order; absolutely positioned
       it lands at the drop point.
         --edit-drop-reach   48px   how far outside another area a drop still lands in it */
    const isPositioned = (el) => { const p = getComputedStyle(el).position; return p === 'absolute' || p === 'fixed'; };
    const addedTab = new WeakSet();
    let grabbed = null, liveRegion;
    function announce(msg) { if (!liveRegion || !liveRegion.isConnected) { liveRegion = document.createElement('div'); liveRegion.setAttribute('data-edit-live', ''); liveRegion.setAttribute('aria-live', 'polite'); document.body.appendChild(liveRegion); } liveRegion.textContent = msg; }

    function collectPieces(area) {
        const kind = classify(area);
        if (kind === 'component') return [];
        if (kind === 'data') { const tpl = listTpl(area); return tpl ? sortableChildren(tpl.parentElement) : []; }
        const out = [];
        const walk = (c) => sortableChildren(c).forEach(ch => { if (ch.closest('[data-edit-ghost]')) return; out.push(ch); if (isContainer(ch)) walk(ch); });
        if (isContainer(area)) walk(area);
        return out;
    }
    function unmarkPiece(el) { el.removeAttribute('data-edit-piece'); if (addedTab.has(el)) { el.removeAttribute('tabindex'); addedTab.delete(el); } }
    function markPieces(area) {
        const want = new Set(collectPieces(area).filter(movable));
        area.querySelectorAll('[data-edit-piece]').forEach(el => { if (!want.has(el)) unmarkPiece(el); });
        want.forEach(el => {
            el.setAttribute('data-edit-piece', '');
            if (!el.hasAttribute('tabindex')) { el.tabIndex = 0; addedTab.add(el); }
        });
    }

    const flowAxis = (c) => { const cs = getComputedStyle(c); return /grid/.test(cs.display) || (/flex/.test(cs.display) && !String(cs.flexDirection || '').startsWith('column')) ? 'x' : 'y'; };
    // Beside a hovered piece: before it when the pointer is in its leading half.
    function beside(el, x, y, parent) {
        const r = el.getBoundingClientRect(), horiz = flowAxis(parent) === 'x';
        const lead = horiz ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
        let ref = lead ? el : el.nextElementSibling;
        while (ref && (ref === dragged || ref.hasAttribute('data-edit-dragging'))) ref = ref.nextElementSibling;
        return { container: parent, ref };
    }
    // Middle band of a container nests; its edges insert before/after it.
    function inMiddle(el, x, y, parent) {
        const r = el.getBoundingClientRect(), horiz = flowAxis(parent) === 'x';
        const lo = horiz ? r.left : r.top, size = horiz ? r.width : r.height, p = horiz ? x : y;
        if (!size) return true;
        const edge = Math.min(size * 0.25, 24);
        return p >= lo + edge && p <= lo + size - edge;
    }
    const dropValid = (a) => !!a && !!a._edit && accepts(a) && classify(a) === 'static' && topArea(a);
    // Another area under the pointer, else the nearest within reach.
    function dropArea(x, y, origin) {
        const hit = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
        const hitArea = hit && regionOf(hit);
        if (hitArea && dropValid(hitArea)) return hitArea;
        const cands = [origin, ...document.querySelectorAll('[data-edit-drop-target]')].filter((a, i, all) => dropValid(a) && all.indexOf(a) === i);
        const inside = (r, pad) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
        let best = null, bestD = Infinity;
        for (const a of cands) {
            const r = a.getBoundingClientRect();
            const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
            const reach = toPx(cssVar(a, '--edit-drop-reach', ''), a, 'w') ?? 48;
            const p = a.parentElement;
            const column = p && p !== document.body && p !== document.documentElement && !cands.some(o => o !== a && p.contains(o)) && inside(p.getBoundingClientRect(), 0);
            if ((inside(r, reach) || column) && d < bestD) { best = a; bestD = d; }
        }
        return best;
    }
    function dropTarget(x, y, s) {
        if (s.dataList) return { container: s.home, ref: afterElement(s.home, x, y) };
        const region = s.crossOK ? dropArea(x, y, s.area) : s.area;
        if (!region) return null;
        const hit = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
        if (hit && hit !== region && region.contains(hit)) {
            for (let el = hit; el && el !== region; el = el.parentElement) {
                if (el === s.item || s.item.contains(el) || pluginNode(el)) continue;
                const parent = el.parentElement;
                if (!isContainer(parent)) continue;
                if (isContainer(el) && accepts(el) && inMiddle(el, x, y, parent)) return { container: el, ref: afterElement(el, x, y) };
                if (accepts(parent) && !s.item.contains(parent)) return beside(el, x, y, parent);
            }
        }
        if (!s.crossOK && (!hit || !region.contains(hit))) { const c = s.ghost.parentElement; return { container: c, ref: afterElement(c, x, y) }; }
        return accepts(region) ? { container: region, ref: afterElement(region, x, y) } : null;
    }
    // Reading-order insertion: the first sibling past the pointer.
    function afterElement(c, x, y) {
        for (const el of sortableChildren(c)) {
            if (el === dragged || el.hasAttribute('data-edit-dragging') || lockedFor(el, 'move')) continue;
            const b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
            const sameRow = Math.abs(cy - y) <= b.height / 2;
            if (cy - y > b.height / 2 || (sameRow && cx > x)) return el;
        }
        return null;
    }
    // Drop point in the piece's own units, relative to its offset parent.
    function placeAt(el, x, y, s) {
        const op = el.offsetParent || el.parentElement, r = op.getBoundingClientRect();
        let left = x - s.grabX - r.left - (op.clientLeft || 0) + (op.scrollLeft || 0);
        let top = y - s.grabY - r.top - (op.clientTop || 0) + (op.scrollTop || 0);
        const maxL = op.clientWidth - el.offsetWidth, maxT = op.clientHeight - el.offsetHeight;
        left = maxL > 0 ? clamp(left, 0, maxL) : Math.max(0, left);
        top = maxT > 0 ? clamp(top, 0, maxT) : Math.max(0, top);
        el.style.left = toUnit(left, s.lu, el, op, 'w') + s.lu;
        el.style.top = toUnit(top, s.tu, el, op, 'h') + s.tu;
    }
    const clearPlacement = (el) => { el.style.removeProperty('left'); el.style.removeProperty('top'); if (!el.getAttribute('style')) el.removeAttribute('style'); };
    const keysWithout = (c, item) => staticKeys(c).filter((k, i) => sortableChildren(c)[i] !== item);

    function onAreaPointerDown(e) {
        const area = this;
        if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0) || e._editDrag) return;
        const t = e.target;
        if (!t || t.nodeType !== 1 || t.isContentEditable || t.hasAttribute('data-edit-handle')) return;
        if (t._pieceMode) { exitPieceMode(t); return; }
        let item = null;
        for (let n = t; n && n !== area; n = n.parentElement) if (n.hasAttribute('data-edit-piece') && movable(n)) { item = n; break; }
        if (!item) return;
        e._editDrag = true;
        startDrag(e, item, area);
    }

    /* ---- Grip: text pieces, whose surface is for typing, drag from a handle at their inline-start edge ---- */
    let grip = null, gripFor = null, gripHovered = null, gripFocused = null, gripListening = false;
    const needsGrip = (p) => !!p && movable(p) && isTextEl(p) && capOf(p, 'text');
    function gripPiece(node, area) {
        for (let n = node; n && n.nodeType === 1 && n !== area; n = n.parentElement) if (n.hasAttribute('data-edit-piece')) return needsGrip(n) ? n : null;
        return null;
    }
    function ensureGrip() {
        if (grip && grip.isConnected) return grip;
        grip = document.createElement('span');
        grip.setAttribute('data-edit-grip', '');
        grip.setAttribute('aria-hidden', 'true');
        grip.hidden = true;
        grip.addEventListener('pointerdown', onGripDown);
        grip.addEventListener('pointerleave', (e) => gripLeave(e.relatedTarget));
        document.body.appendChild(grip);
        if (!gripListening) {
            gripListening = true;
            window.addEventListener('scroll', placeGrip, { capture: true, passive: true });
            window.addEventListener('resize', placeGrip, { passive: true });
        }
        return grip;
    }
    function placeGrip() {
        if (!gripFor || !grip) return;
        if (!gripFor.isConnected) return hideGrip();
        const r = gripFor.getBoundingClientRect(), rtl = getComputedStyle(gripFor).direction === 'rtl';
        grip.dir = rtl ? 'rtl' : 'ltr';
        grip.style.top = r.top + 'px';
        grip.style.left = (rtl ? r.right : r.left) + 'px';
    }
    function showGrip(piece) {
        const area = regionOf(piece);
        if (dragged || !area || area._edit.bare || piece.closest('[data-edit-area="bare"]')) return hideGrip();
        const g = ensureGrip();
        gripFor = piece; placeGrip(); g.hidden = false;
    }
    function hideGrip() { gripFor = null; if (grip) grip.hidden = true; }
    function gripOver(e, area) {
        if (dragged) return;
        const p = gripPiece(e.target, area);
        gripHovered = p;
        if (p) showGrip(p); else if (gripFocused) showGrip(gripFocused); else hideGrip();
    }
    function gripLeave(to) {
        if (to && grip && (to === grip || (gripFor && gripFor.contains(to)))) return;
        gripHovered = null;
        if (gripFocused && gripFocused.isConnected) showGrip(gripFocused); else hideGrip();
    }
    function gripFocus(e, area) {
        const p = gripPiece(e.target, area);
        gripFocused = p;
        if (p && !(gripHovered && gripHovered.isConnected)) showGrip(p);
    }
    function gripBlur(to) {
        if (to && gripFocused && gripFocused.contains(to)) return;
        gripFocused = null;
        if (!(gripHovered && gripHovered.isConnected)) hideGrip();
    }
    function onGripDown(e) {
        const piece = gripFor;
        if (!piece || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const area = regionOf(piece);
        if (!isActive(area) || !movable(piece)) return;
        e.preventDefault(); e.stopPropagation();
        hideGrip();
        startDrag(e, piece, area);
    }

    function startDrag(e, item, area) {
        const home = item.parentElement, homeNext = item.nextElementSibling;
        const dataList = classify(area) === 'data';
        const s = {
            item, area, home, dataList, ghost: null,
            crossOK: !dataList && classify(area) === 'static' && !isRegionBlock(item),
            homeBefore: dataList ? null : staticKeys(home),
            lu: unitOf(item.style.left) || 'px', tu: unitOf(item.style.top) || 'px'
        };
        const start = item.getBoundingClientRect(), preStyle = item.getAttribute('style'), preOwn = ownStyle(item);
        s.grabX = e.clientX - start.left; s.grabY = e.clientY - start.top;
        const sx = e.clientX, sy = e.clientY;
        let active = false, frame = 0, px = sx, py = sy, last = null;

        const lift = (ev) => {
            if (s.crossOK) areas().forEach(a => { if (a !== area && dropValid(a)) a.setAttribute('data-edit-drop-target', ''); });
            const ghost = s.ghost = item.cloneNode(true);
            unrich(item, ghost);
            ghost.setAttribute('data-edit-ghost', '');
            ghost.setAttribute('x-ignore', '');
            ghost.removeAttribute('id');
            ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
            [ghost, ...ghost.querySelectorAll('*')].forEach(n => {
                [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-') && a.name !== 'data-edit-ghost') n.removeAttribute(a.name); });
                n.removeAttribute('contenteditable'); n.removeAttribute('tabindex'); n.removeAttribute('draggable');
            });
            item.before(ghost);
            Object.assign(item.style, { position: 'fixed', width: start.width + 'px', height: start.height + 'px', margin: '0', pointerEvents: 'none' });
            item.setAttribute('data-edit-dragging', '');
            dragged = ghost;
            try { item.setPointerCapture(ev.pointerId); } catch { }
        };
        const paint = () => { frame = 0; item.style.left = (px - s.grabX) + 'px'; item.style.top = (py - s.grabY) + 'px'; };
        const placeGhost = (drop) => {
            const g = s.ghost, { container, ref } = drop;
            const same = last && last.container === container && last.ref === ref;
            last = drop;
            if (!same) container.insertBefore(g, ref && ref.parentElement === container ? ref : null);
            if (isPositioned(g)) {
                if (!same) { if (container === home && item.parentElement === home) home.insertBefore(g, item); else if (g.nextElementSibling) container.appendChild(g); }
                placeAt(g, px, py, s);
            } else if (g.style.left || g.style.top) clearPlacement(g);
        };
        const onMove = (ev) => {
            px = ev.clientX; py = ev.clientY;
            if (!active) {
                if (Math.hypot(px - sx, py - sy) < 5) return;
                active = true; hideGrip(); lift(ev); paint();
            }
            ev.preventDefault();
            const drop = dropTarget(px, py, s);
            if (drop) placeGhost(drop);
            if (!frame) frame = requestAnimationFrame(paint);
        };
        const settle = (cancelled) => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onCancel);
            document.removeEventListener('keydown', onKey, true);
            if (frame) cancelAnimationFrame(frame);
            if (!active) return;
            document.querySelectorAll('[data-edit-drop-target]').forEach(a => a.removeAttribute('data-edit-drop-target'));
            item.removeAttribute('data-edit-dragging');
            if (cancelled) s.ghost.remove(); else s.ghost.replaceWith(item);
            if (preStyle == null) item.removeAttribute('style'); else item.setAttribute('style', preStyle);
            s.ghost = null; dragged = null;
            const back = () => { if (homeNext && homeNext.parentElement === home) home.insertBefore(item, homeNext); else home.appendChild(item); };
            if (cancelled) { back(); announce('Cancelled'); return; }
            const dest = item.parentElement, toArea = regionOf(dest);
            if (dest !== home && (s.dataList || !accepts(dest) || !toArea || (toArea !== area && !(s.crossOK && dropValid(toArea))))) { back(); announce('Cancelled'); return; }
            if (isPositioned(item)) placeAt(item, px, py, s);
            else if (item.style.left || item.style.top) clearPlacement(item);
            const styled = ownStyle(item) !== preOwn;
            if (s.dataList) { finishReorder(area, home); announce('Dropped'); return; }
            let did = false;
            if (dest === home) did = commitOrder(area, home, s.homeBefore);
            else { commitMove(area, toArea, item, home, s.homeBefore, keysWithout(dest, item)); did = true; }
            if (styled) commitStyle(regionOf(item), item, { before: preOwn, join: did });
            announce(toArea !== area ? 'Moved to ' + key(toArea) : 'Dropped');
        };
        const onUp = () => settle(false);
        const onCancel = () => settle(true);
        const onKey = (ev) => { if (ev.key !== 'Escape') return; ev.preventDefault(); ev.stopPropagation(); settle(true); };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancel);
        document.addEventListener('keydown', onKey, true);
    }

    function finishReorder(area, container) {
        if (classify(area) === 'data') { applyDataOrder(area, sortableChildren(container).map(c => itemKey(c, area))); commit(area); return true; }
        return false;
    }

    /* ---- Keyboard ---- */
    const ownControl = (e, item) => e.target !== item && !!e.target.closest && item.contains(e.target.closest('a[href], button, summary, [role="button"], [role="link"]'));
    const siblingsOf = (item) => sortableChildren(item.parentElement).filter(c => c === item || !lockedFor(c, 'move'));
    function refocus(el) { if (document.activeElement !== el) try { el.focus(); } catch { } }

    function onPieceKeydown(e, area) {
        if (e._editRow) return;
        const t = e.target;
        if (t._pieceMode && e.key === 'Enter') { e._editRow = true; e.preventDefault(); exitPieceMode(t, true); return; }
        let item = null;
        for (let n = t; n && n !== area; n = n.parentElement) if (n.hasAttribute && n.hasAttribute('data-edit-piece') && movable(n)) { item = n; break; }
        if (!grabbed) { const b = asPiece(t); if (b && onBlockKey(e, b)) { e._editRow = true; e.preventDefault(); e.stopPropagation(); return; } }
        if (!item) return;
        const dir = { ArrowUp: -1, ArrowDown: 1 }[e.key], side = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
        const plainAlt = e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey;
        if (plainAlt && dir != null && !(grabbed && grabbed.item === item)) { e._editRow = true; e.preventDefault(); stepRow(item, dir); return; }
        if (plainAlt && side != null && !inText(e)) { e._editRow = true; e.preventDefault(); if (side > 0) nestInto(item); else unnest(item); return; }
        if ((e.key === ' ' || e.key === 'Enter') && !inText(e) && !ownControl(e, item) && !e.altKey && !e.metaKey && !e.ctrlKey) {
            e._editRow = true; e.preventDefault();
            if (grabbed && grabbed.item === item) { dropGrab(); refocus(item); announce('Dropped'); }
            else { if (grabbed) cancelGrab(); grabbed = { item, area: regionOf(item), container: item.parentElement, next: item.nextElementSibling, before: classify(regionOf(item)) === 'data' ? null : staticKeys(item.parentElement) }; item.setAttribute('data-edit-dragging', 'keyboard'); announce('Grabbed — arrow keys to move, Enter to drop'); }
            return;
        }
        if (grabbed && grabbed.item === item) {
            if (e.key === 'Escape') { e._editRow = true; e.preventDefault(); cancelGrab(); refocus(item); announce('Cancelled'); return; }
            const step = dir ?? side; if (step == null) return;
            e._editRow = true; e.preventDefault();
            const sibs = siblingsOf(item), i = sibs.indexOf(item), j = i + step;
            if (j < 0 || j >= sibs.length) return;
            if (step > 0) sibs[j].after(item); else sibs[j].before(item);
            refocus(item); announce(`Position ${j + 1} of ${sibs.length}`);
            return;
        }
        if (t === item && !inText(e) && !e.altKey && !e.metaKey && !e.ctrlKey && (dir != null || side != null) && isPositioned(item)) { e._editRow = true; nudge(e, item); }
    }
    function dropGrab() {
        const g = grabbed; grabbed = null; if (!g) return;
        g.item.removeAttribute('data-edit-dragging');
        if (g.before) commitOrder(g.area, g.container, g.before); else finishReorder(g.area, g.container);
    }
    function cancelGrab() {
        const g = grabbed; grabbed = null; if (!g) return;
        g.item.removeAttribute('data-edit-dragging');
        if (g.next && g.next.parentElement === g.container) g.container.insertBefore(g.item, g.next); else g.container.appendChild(g.item);
    }
    // One step, committed at once. Neighbours move round the piece, so focus and caret survive.
    function stepRow(item, dir) {
        const area = regionOf(item), container = item.parentElement;
        const sibs = siblingsOf(item), i = sibs.indexOf(item), j = i + dir;
        if (i < 0 || j < 0 || j >= sibs.length) { announce(`Position ${i + 1} of ${sibs.length}`); return; }
        const before = classify(area) === 'data' ? null : staticKeys(container);
        const other = sibs[j], between = [];
        for (let n = dir > 0 ? item.nextElementSibling : item.previousElementSibling; n && n !== other; n = dir > 0 ? n.nextElementSibling : n.previousElementSibling) between.push(n);
        if (dir > 0) { item.before(other); between.forEach(n => item.before(n)); }
        else { item.after(other); between.forEach(n => item.after(n)); }
        const focused = document.activeElement, sel = window.getSelection && window.getSelection();
        const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        if (before) commitOrder(area, container, before); else finishReorder(area, container);
        if (focused && focused.isConnected && document.activeElement !== focused) {
            focused.focus();
            if (range) try { sel.removeAllRanges(); sel.addRange(range); } catch { }
        }
        announce(`Moved to position ${j + 1} of ${sibs.length}`);
    }
    const describe = (el) => el === regionOf(el) ? key(el) : el.tagName.toLowerCase();
    function nestInto(item) {
        const area = regionOf(item);
        if (classify(area) !== 'static') { announce('Records stay in their list'); return false; }
        let prev = item.previousElementSibling;
        while (prev && (pluginNode(prev) || prev.tagName === 'TEMPLATE')) prev = prev.previousElementSibling;
        if (!prev || !accepts(prev)) { announce('Nothing to nest into'); return false; }
        const from = item.parentElement, fb = staticKeys(from), tb = staticKeys(prev);
        prev.appendChild(item);
        commitMove(area, area, item, from, fb, tb);
        refocus(item); announce('Nested in ' + describe(prev));
        return true;
    }
    function unnest(item) {
        const area = regionOf(item), from = item.parentElement;
        if (classify(area) !== 'static') { announce('Records stay in their list'); return false; }
        const out = from && from !== area ? from.parentElement : null;
        if (!out || !(out === area || area.contains(out)) || !accepts(out)) { announce('Already at the top level'); return false; }
        const fb = staticKeys(from), tb = staticKeys(out);
        from.after(item);
        commitMove(area, area, item, from, fb, tb);
        refocus(item); announce('Moved out to ' + describe(out));
        return true;
    }
    // Arrow nudge for a focused, absolutely positioned piece; a key burst commits once.
    function nudge(e, el) {
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!d) return;
        e.preventDefault();
        if (!el._moveTimer) el._preStyle = ownStyle(el);
        const step = e.shiftKey ? 16 : 4, cs = getComputedStyle(el), parent = el.offsetParent || el.parentElement;
        const lu = unitOf(el.style.left) || 'px', tu = unitOf(el.style.top) || 'px';
        const maxL = Math.max(0, parent.clientWidth - el.offsetWidth), maxT = Math.max(0, parent.clientHeight - el.offsetHeight);
        const nl = Math.max(0, (parseFloat(cs.left) || 0) + d[0] * step), nt = Math.max(0, (parseFloat(cs.top) || 0) + d[1] * step);
        if (d[0]) el.style.left = toUnit(maxL ? Math.min(maxL, nl) : nl, lu, el, parent, 'w') + lu;
        if (d[1]) el.style.top = toUnit(maxT ? Math.min(maxT, nt) : nt, tu, el, parent, 'h') + tu;
        clearTimeout(el._moveTimer); el._moveTimer = setTimeout(() => { el._moveTimer = null; commitStyle(regionOf(el), el); }, 350);
    }
