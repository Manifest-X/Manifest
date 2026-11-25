/* Manifest Virtual — in-flow list/table/grid/gallery/masonry virtualization for Alpine.
 *
 * Renders only rows in the viewport (plus overscan). Line modes keep rows in NORMAL
 * FLOW between top/bottom spacers standing in for off-window rows, so the same markup
 * works virtualized or not and shared columns/sticky/flex-wrap behave normally;
 * masonry positions absolutely. Options: estimate (px or {width,height}), overscan,
 * mode ('rows'|'gallery'|'masonry'; masonry must be explicit, others auto-detect).
 * With several x-for templates inside, mark the virtualized one `data-virtual`.
 * Column widths must be content-independent or columns shift as the window changes.
 */


(function () {

// `item in src` or `(item, index) in src`, parentheses optional (as x-for)
const FOR_RE = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)?\s+(?:in|of)\s+(.+?)\s*$/;

function hasVirtual(el) {
    if (el.hasAttribute('x-virtual')) return true;
    for (const attr of el.attributes) if (attr.name.startsWith('x-virtual.')) return true;
    return false;
}

// The virtualized template: one marked data-virtual, else the first outside <thead>/<tfoot>, else the first
function pickTemplate(el, warn) {
    const all = el.querySelectorAll('template[x-for], template[data-virtual-for]');
    if (all.length < 2) return all[0] || null;
    for (const t of all) if (t.hasAttribute('data-virtual')) return t;
    const body = [...all].filter((t) => !inTableHead(t, el));
    // Only document order decided: say how to make it explicit
    if (warn && body.length !== 1) console.warn('[x-virtual] several x-for templates inside and none marked: virtualizing the first. Mark the rows template with data-virtual', el);
    return body[0] || all[0];
}
function inTableHead(t, el) {
    for (let n = t.parentElement; n && n !== el; n = n.parentElement) if (n.tagName === 'THEAD' || n.tagName === 'TFOOT') return true;
    return false;
}

// x-for and :key move to data attributes Alpine ignores. Only a form x-virtual can run:
// any other stays on the template for Alpine's own x-for
function stashFor(template) {
    const forExpr = template.getAttribute('x-for');
    if (forExpr === null || !FOR_RE.test(forExpr)) return;
    template.setAttribute('data-virtual-for', forExpr);
    const key = template.getAttribute(':key') ?? template.getAttribute('x-bind:key');
    if (key !== null) template.setAttribute('data-virtual-key', key);
    template.removeAttribute('x-for');
    template.removeAttribute(':key');
    template.removeAttribute('x-bind:key');
}

function initializeVirtualPlugin() {

    // Alpine queues a tree's directives before running any: x-for comes off as the container is visited
    if (typeof Alpine.interceptInit === 'function') {
        Alpine.interceptInit((el) => {
            if (el.nodeType !== 1 || !hasVirtual(el) || el.hasAttribute('x-ignore')) return;
            const template = pickTemplate(el);
            if (template) stashFor(template);
        });
    }

    // One dependency for "any index or length change" where array iteration is instrumented; else a read per index
    const cheapIterate = Alpine.reactive([]).some !== Array.prototype.some;
    const anyItem = () => true;
    function trackList(list) {
        if (!Array.isArray(list)) return;   // an iterator would be consumed
        void list.length;
        if (cheapIterate) { list.some(anyItem); return; }
        for (let i = 0; i < list.length; i++) void list[i];
    }

    Alpine.directive('virtual', (el, { expression }, { evaluate, evaluateLater, effect, cleanup }) => {

        // --- Find the template (may be nested, e.g. table > tbody > template) ---
        const template = pickTemplate(el, true) || el.querySelector(':scope template');
        if (template) stashFor(template);
        const forExpr = template && (template.getAttribute('data-virtual-for') ?? template.getAttribute('x-for'));
        if (!forExpr) {
            // Quiet on re-init of an already-virtualized container
            if (!el.querySelector('[data-virtual-spacer]')) {
                console.warn('[x-virtual] expects a descendant <template> with x-for, e.g. <template x-for="row in $x.items" :key="row.id">…');
            }
            return;
        }
        const m = FOR_RE.exec(forExpr);
        if (!m) {
            // x-for is still on the template: Alpine renders the list unvirtualized
            console.warn('[x-virtual] could not parse x-for expression: ' + forExpr);
            return;
        }
        const itemName = m[1];
        const indexName = m[2] || null;
        const sourceExpr = m[3].trim();
        const keyExpr = template.getAttribute('data-virtual-key') || `${itemName}.id`;

        // The template stays as the clone source, with nothing left for Alpine to render
        template.removeAttribute('data-virtual-for');
        template.removeAttribute('data-virtual-key');

        // --- Options ---
        const options = expression ? (evaluate(expression) || {}) : {};
        const est = options.estimate;
        const estimateH = (est && typeof est === 'object') ? (Number(est.height) || 50) : (Number(est) > 0 ? Number(est) : 50);
        const estimateW = (est && typeof est === 'object') ? (Number(est.width) || 120) : 120;
        const overscan = Number.isFinite(options.overscan) && options.overscan >= 0 ? Number(options.overscan) : 3;

        // --- Elements & mode ---
        const scrollEl = el;                          // the bounded scroll viewport
        const host = template.parentElement;          // where spacers + rows live
        const cs = getComputedStyle(scrollEl);
        if (cs.overflow === 'visible' && cs.overflowY === 'visible') scrollEl.style.overflow = 'auto';

        const isMasonry = options.mode === 'masonry';
        let kind = detectKind(host);                  // table | grid | flex | block; null while hidden
        let isGallery = false;

        // Masonry: fixed `columns` or target `columnWidth`; optional per-item `span`/
        // `height` fns from data for ~zero settling; `gap` px (falls back to CSS gap).
        const colsOpt = Number(options.columns) > 0 ? Math.floor(options.columns) : 0;
        const colWidthOpt = Number(options.columnWidth) > 0 ? Number(options.columnWidth) : 0;
        const spanFn = typeof options.span === 'function' ? options.span : null;
        const heightFn = typeof options.height === 'function' ? options.height : null;
        const masonryGap = Number.isFinite(options.gap) ? Number(options.gap) : (parseFloat(cs.gap) || 0);
        if (isMasonry && cs.position === 'static') scrollEl.style.position = 'relative';

        // Column count for table spacer colspan (so it doesn't disturb columns).
        const colCount = template.content.firstElementChild
            ? template.content.firstElementChild.children.length : 1;

        // --- Spacers (line modes) / sizer (masonry) ---
        let topSpacer, botSpacer, sizer;
        if (isMasonry) {
            sizer = document.createElement('div');
            sizer.dataset.virtualSpacer = '';
            sizer.setAttribute('aria-hidden', 'true');
            sizer.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:0;pointer-events:none';
            host.appendChild(sizer);
        } else {
            topSpacer = makeSpacer(kind, colCount);
            botSpacer = makeSpacer(kind, colCount);
            host.insertBefore(topSpacer, template);
            host.insertBefore(botSpacer, template);
            if (kind) applyKind();
        }

        // A display:none host can't be classified; resolve once it has a box.
        function applyKind() {
            styleSpacer(topSpacer, kind);
            styleSpacer(botSpacer, kind);
            isGallery = (options.mode || detectMode(kind, host)) === 'gallery';
        }
        function resolveKind() {
            if (kind || isMasonry) return true;
            if (!(kind = detectKind(host))) return false;
            if (ro && host !== scrollEl) ro.unobserve(host);
            applyKind();
            rebuild();
            return true;
        }
        const anchor = isMasonry ? sizer : botSpacer;   // rows insert before this

        // --- State ---
        const heights = new Map();   // key -> measured line/row height
        const widths = new Map();    // key -> measured item width (gallery only)
        let measuredSum = 0, measuredCount = 0;
        const rendered = new Map();  // key -> { node, scope, removeScope }
        let data = [];
        let raw = [];                          // the same list unwrapped: full scans read this, rows get data[i]
        let cumulative = new Float64Array(1);  // line-top offsets; last = total
        let endNotifiedAt = -1;                // data length `virtual-end` last fired for
        let endHead;                           // first item's key then: a replaced list fires again
        let lines = [];                        // gallery: [{ start, end, height }]
        let pos = [];                          // masonry: per-index { x, y, w, h }
        let sortedTop = [];                    // masonry: indices sorted by y
        let totalHeight = 0;                   // masonry: packed content height
        let maxItemH = 0;                      // masonry: back-scan bound
        let ready = false;                     // becomes true once container is sized
        let ro = null;
        let destroyed = false;
        let lastStart = 0;                     // last render's first unit
        let aboveAvg = null;                   // estimate for unmeasured rows before the window, held until the source changes

        const keyFn = buildKeyFn(itemName, indexName, keyExpr);
        const avgH = () => (measuredCount > 0 ? measuredSum / measuredCount : estimateH);
        const heightFor = (k) => heights.get(k) ?? avgH();
        const widthFor = (k) => widths.get(k) ?? estimateW;
        const heightForItem = (item, i) => heightFn ? (Number(heightFn(item)) || estimateH) : heightFor(keyFn(item, i));

        // ---- Cumulative offset model ----

        function rebuild() {
            if (isMasonry) rebuildMasonry();
            else if (isGallery) rebuildGallery();
            else rebuildSingle();
        }

        // Skyline packer: place each item in the `span`-wide column band with the lowest
        // top. Positions depend only on order, so the whole layout is computed in JS.
        function rebuildMasonry() {
            const cw = contentWidth();
            const g = masonryGap;
            let cols = colsOpt || (colWidthOpt ? Math.max(1, Math.floor((cw + g) / (colWidthOpt + g))) : 3);
            const colW = (cw - (cols - 1) * g) / cols;
            const bottom = new Float64Array(cols);
            const n = data.length;
            pos = new Array(n);
            maxItemH = 0;
            const authored = !!(spanFn || heightFn);   // author functions read live items: a changed field repacks
            for (let i = 0; i < n; i++) {
                const item = authored ? data[i] : raw[i];
                let span = spanFn ? (spanFn(item) | 0) : 1;
                if (span < 1) span = 1; else if (span > cols) span = cols;
                const h = heightForItem(item, i);
                let bestC = 0, bestY = Infinity;
                for (let c = 0; c + span <= cols; c++) {
                    let y = 0;
                    for (let d = 0; d < span; d++) if (bottom[c + d] > y) y = bottom[c + d];
                    if (y < bestY) { bestY = y; bestC = c; }
                }
                const w = span * colW + (span - 1) * g;
                pos[i] = { x: bestC * (colW + g), y: bestY, w, h };
                const nb = bestY + h + g;
                for (let d = 0; d < span; d++) bottom[bestC + d] = nb;
                if (h > maxItemH) maxItemH = h;
            }
            let t = 0;
            for (let c = 0; c < cols; c++) if (bottom[c] > t) t = bottom[c];
            totalHeight = t > 0 ? t - g : 0;
            sortedTop = Array.from({ length: n }, (_, i) => i).sort((a, b) => pos[a].y - pos[b].y);
        }

        function rebuildSingle() {
            const n = data.length;
            cumulative = new Float64Array(n + 1);
            let y = 0;
            // Rows before the window keep their estimate: a new measurement moves nothing above the view
            const held = aboveAvg === null ? 0 : Math.min(lastStart, n);
            for (let i = 0; i < n; i++) {
                cumulative[i] = y;
                const k = keyFn(raw[i], i);
                y += i < held ? (heights.get(k) ?? aboveAvg) : heightFor(k);
            }
            cumulative[n] = y;
        }

        function rebuildGallery() {
            const cw = contentWidth();
            const gx = gapX(), gy = gapY();
            lines = [];
            let i = 0;
            const n = data.length;
            while (i < n) {
                const start = i;
                let lineW = 0, h = 0;
                while (i < n) {
                    const k = keyFn(raw[i], i);
                    const w = widthFor(k);
                    const add = lineW === 0 ? w : gx + w;
                    if (lineW > 0 && lineW + add > cw) break;   // wrap
                    lineW += add;
                    h = Math.max(h, heightFor(k));
                    i++;
                }
                if (i === start) i++;                            // item wider than row
                lines.push({ start, end: i, height: h });
            }
            cumulative = new Float64Array(lines.length + 1);
            let y = 0;
            for (let l = 0; l < lines.length; l++) {
                cumulative[l] = y;
                y += lines[l].height + gy;
            }
            cumulative[lines.length] = lines.length ? y - gy : 0;
        }

        // Binary search: first line/row whose END offset exceeds `pos`.
        function findStart(pos, count) {
            let lo = 0, hi = count;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (cumulative[mid + 1] <= pos) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }

        // ---- Render ----

        // The last item is rendered: `virtual-end` fires once per data length (load the next page here)
        function notifyEnd(reached) {
            const head = data.length ? keyFn(data[0], 0) : undefined;
            if (data.length < endNotifiedAt || head !== endHead) endNotifiedAt = -1;
            endHead = head;
            if (!reached || !data.length || endNotifiedAt === data.length) return;
            endNotifiedAt = data.length;
            el.dispatchEvent(new CustomEvent('virtual-end', { bubbles: true, detail: { length: data.length } }));
        }

        function render() {
            if (isMasonry) return renderMasonry();
            if (!data.length) { clearRows(); setHeight(topSpacer, 0); setHeight(botSpacer, 0); return; }
            const vh = scrollEl.clientHeight;
            if (!vh || !resolveKind()) return false;             // defer until sized
            ready = true;
            const total = isGallery ? lines.length : data.length;   // after resolveKind (may enable gallery)

            const eff = Math.max(0, scrollEl.scrollTop - regionTop());
            let startUnit = findStart(eff, total) - overscan;
            if (startUnit < 0) startUnit = 0;
            let endUnit = findStart(eff + vh, total) + 1 + overscan;
            if (endUnit > total) endUnit = total;

            lastStart = startUnit;
            if (aboveAvg === null || startUnit === 0) aboveAvg = avgH();
            setHeight(topSpacer, cumulative[startUnit]);
            setHeight(botSpacer, cumulative[total] - cumulative[endUnit]);

            // Resolve the item range for these units.
            const startItem = isGallery ? lines[startUnit].start : startUnit;
            const endItem = isGallery ? lines[endUnit - 1].end : endUnit;
            notifyEnd(endItem >= data.length);

            const visible = new Set();
            const keys = [];
            const items = [];
            const indices = [];
            for (let i = startItem; i < endItem; i++) {
                const item = data[i];
                if (item == null) continue;
                const key = keyFn(item, i);
                if (key == null) continue;
                visible.add(key);
                keys.push(key);
                items.push(item);
                indices.push(i);
            }
            for (const [key, entry] of rendered) {
                if (!visible.has(key)) removeRow(key, entry);
            }

            // Keep DOM order = data order, moving only rows out of place
            const rowNodes = new Set();
            for (const entry of rendered.values()) rowNodes.add(entry.node);
            // Next row in the host; skips what a row root rendered (x-if clones), survives a row's init detaching it
            const nextRow = (n) => {
                while (n && n !== botSpacer && n.parentNode === host && !rowNodes.has(n)) n = n.nextSibling;
                return n && n.parentNode === host ? n : botSpacer;
            };
            let cursor = nextRow(topSpacer.nextSibling);
            for (let i = 0; i < keys.length; i++) {
                if (cursor.parentNode !== host) cursor = botSpacer;
                let entry = rendered.get(keys[i]);
                if (!entry) {
                    entry = mountRow(items[i], keys[i], cursor, indices[i]);
                    rowNodes.add(entry.node);
                    if (entry.node.parentNode !== host) host.insertBefore(entry.node, cursor);  // root replaced itself in init
                    continue;
                }
                rebind(entry, items[i], indices[i]);
                if (entry.node === cursor) cursor = nextRow(cursor.nextSibling);
                else host.insertBefore(entry.node, cursor);
            }

            // Measure anything not yet measured, then reconcile offsets once.
            scheduleMeasure(keys);
        }

        // Masonry: render items whose packed box intersects the viewport, positioned
        // absolutely at their computed (x, y, w).
        function renderMasonry() {
            if (!data.length) { clearRows(); sizer.style.height = '0px'; return; }
            const vh = scrollEl.clientHeight;
            if (!vh) return false;                               // defer until sized
            ready = true;
            sizer.style.height = totalHeight + 'px';

            const opx = overscan * avgH();
            const winTop = scrollEl.scrollTop - opx;
            const winBot = scrollEl.scrollTop + vh + opx;
            // First candidate whose top could reach the window (bounded by tallest item).
            let lo = 0, hi = sortedTop.length;
            const target = winTop - maxItemH;
            while (lo < hi) { const mid = (lo + hi) >>> 1; if (pos[sortedTop[mid]].y < target) lo = mid + 1; else hi = mid; }

            const visible = new Set();
            const keys = [];
            for (let k = lo; k < sortedTop.length; k++) {
                const i = sortedTop[k];
                const p = pos[i];
                if (p.y > winBot) break;
                if (p.y + p.h < winTop) continue;
                const item = data[i];
                if (item == null) continue;
                const key = keyFn(item, i);
                if (key == null) continue;
                visible.add(key);
                keys.push(key);
                let entry = rendered.get(key);
                if (!entry) entry = mountRow(item, key, anchor, i);
                else rebind(entry, item, i);
                const s = entry.node.style;
                s.position = 'absolute';
                s.left = p.x + 'px';
                s.top = p.y + 'px';
                s.width = p.w + 'px';
            }
            for (const [key, entry] of rendered) {
                if (!visible.has(key)) removeRow(key, entry);
            }
            notifyEnd(visible.has(keyFn(data[data.length - 1], data.length - 1)));
            scheduleMeasure(keys);
        }

        // Rebind by key: same row, possibly a new item object or position
        function rebind(entry, item, i) {
            if (entry.scope[itemName] !== item) entry.scope[itemName] = item;
            if (indexName && entry.scope[indexName] !== i) entry.scope[indexName] = i;
        }

        function mountRow(item, key, before = anchor, i) {
            const tpl = template.content.firstElementChild;
            const node = tpl.cloneNode(true);
            host.insertBefore(node, before);                     // connect before init
            const scope = Alpine.reactive(indexName ? { [itemName]: item, [indexName]: i } : { [itemName]: item });
            const removeScope = Alpine.addScopeToNode(node, scope);
            Alpine.initTree(node);
            const entry = { node, scope, removeScope, targets: null, seen: false };
            rendered.set(key, entry);
            observe(entry, key, node);
            return entry;
        }

        function removeRow(key, entry) {
            if (entry.targets) for (const t of entry.targets) rowRo.unobserve(t);
            entry.removeScope && entry.removeScope();
            Alpine.destroyTree && Alpine.destroyTree(entry.node);
            entry.node.remove();
            rendered.delete(key);
        }

        // Rows whose item left the list (only needed while render() is deferred)
        function dropStaleRows() {
            const valid = new Set();
            for (let i = 0; i < raw.length; i++) if (raw[i] != null) valid.add(keyFn(raw[i], i));
            for (const [key, entry] of rendered) if (!valid.has(key)) removeRow(key, entry);
        }

        function clearRows() {
            for (const [key, entry] of rendered) removeRow(key, entry);
        }

        // ---- Measurement ----

        // Rendered rows report size changes; one observer, reconciled in the next frame
        const rowRo = (isMasonry && heightFn) ? null : new ResizeObserver((entries) => {
            for (const e of entries) {
                const key = targetKey.get(e.target);
                if (key !== undefined && rendered.has(key)) pending.add(key);
            }
            if (pending.size) schedule();
        });
        const targetKey = new WeakMap();   // observed node -> row key
        function observe(entry, key, node) {
            if (!rowRo) return;
            (entry.targets || (entry.targets = [])).push(node);
            targetKey.set(node, key);
            rowRo.observe(node);
        }
        // display:contents rows have no box: their cells are observed instead, and cells added later
        // (x-if in the row) are found by one subtree observer on the host, created with the first such row
        let cellMo = null;
        function watchCells() {
            if (cellMo) return;
            cellMo = new MutationObserver((records) => {
                for (const r of records) {
                    let n = r.target;
                    if (n === host) continue;
                    while (n && n.parentNode !== host) n = n.parentNode;
                    const key = n && targetKey.get(n);
                    if (key !== undefined && rendered.get(key)?.node === n) pending.add(key);
                }
                if (pending.size) schedule();
            });
            cellMo.observe(host, { childList: true, subtree: true });
        }
        function observeCells(entry, key, node) {
            for (const c of node.children) {
                if (c.tagName === 'TEMPLATE') continue;
                const d = getComputedStyle(c).display;
                if (d === 'contents') observeCells(entry, key, c);
                else if (d !== 'none' && !targetKey.has(c)) observe(entry, key, c);
            }
        }

        // One frame callback: measure pending rows first (before render can remove them), then render
        const pending = new Set();
        let frameScheduled = false, renderPending = false;
        function schedule(withRender) {
            if (withRender) renderPending = true;
            if (frameScheduled) return;
            frameScheduled = true;
            requestAnimationFrame(() => {
                frameScheduled = false;
                if (destroyed) return;
                let changed = false;
                for (const key of pending) {
                    const entry = rendered.get(key);
                    if (entry && measureRow(key, entry)) changed = true;
                }
                pending.clear();
                const doRender = changed || renderPending;
                renderPending = false;
                if (changed) rebuild();
                if (doRender) render();
            });
        }

        function scheduleMeasure(keys) {
            if (isMasonry && heightFn) return;                   // heights known from data
            // Rows mounted since the last measure; later changes arrive through the row observer
            for (const key of keys) {
                const entry = rendered.get(key);
                if (entry && (!entry.seen || !heights.has(key) || (isGallery && !widths.has(key)))) pending.add(key);
            }
            if (pending.size) schedule();
        }

        function measureRow(key, entry) {
            const node = entry.node;
            if (!node.isConnected) return false;
            const contents = getComputedStyle(node).display === 'contents';
            if (contents && rowRo) { watchCells(); observeCells(entry, key, node); }
            entry.seen = true;
            const h = contents ? unionHeight(node) : node.offsetHeight;
            if (!h) return false;
            let changed = false;
            const prev = heights.get(key);
            if (prev !== h) {
                if (prev !== undefined) measuredSum -= prev;
                else measuredCount++;
                measuredSum += h;
                heights.set(key, h);
                changed = true;
            }
            if (isGallery) {
                const w = node.offsetWidth;
                if (w && widths.get(key) !== w) { widths.set(key, w); changed = true; }
            }
            return changed;
        }

        // display:contents rows (grid-table) have no box — measure the union of
        // their cells. Vertically sticky (top) cells report their stuck rect and
        // aren't supported; horizontal sticky is fine.
        function unionHeight(node) {
            const b = { top: Infinity, bottom: -Infinity };
            unionCellRects(node, b);
            return b.bottom > b.top ? b.bottom - b.top : 0;
        }

        // Keys that left the source: their sizes go, and stop counting toward the estimate
        function forgetLeft() {
            const live = new Set();
            for (let i = 0; i < raw.length; i++) if (raw[i] != null) live.add(keyFn(raw[i], i));
            for (const [key, h] of heights) {
                if (live.has(key)) continue;
                heights.delete(key);
                measuredSum -= h;
                measuredCount--;
            }
            for (const key of widths.keys()) if (!live.has(key)) widths.delete(key);
        }

        // ---- Geometry helpers ----

        // Scroll-content position where the virtualized region begins (accounts
        // for a static/sticky header above the rows).
        function regionTop() {
            const s = scrollEl.getBoundingClientRect();
            const t = topSpacer.getBoundingClientRect();
            return t.top - s.top + scrollEl.scrollTop;
        }
        function contentWidth() {
            const c = getComputedStyle(scrollEl);
            return scrollEl.clientWidth - parseFloat(c.paddingLeft || 0) - parseFloat(c.paddingRight || 0);
        }
        function gapX() {
            const g = getComputedStyle(scrollEl);
            return parseFloat(g.columnGap || g.gap || 0) || 0;
        }
        function gapY() {
            const g = getComputedStyle(scrollEl);
            return parseFloat(g.rowGap || g.gap || 0) || 0;
        }

        // ---- Reactive source ----

        const getSource = evaluateLater(sourceExpr);
        effect(() => {
            getSource((value) => {
                trackList(value);
                data = Array.isArray(value) ? value : (value ? Array.from(value) : []);
                raw = Alpine.raw ? Alpine.raw(data) : data;
                aboveAvg = null;
                if (heights.size > raw.length * 2 + 100) forgetLeft();   // amortised: only once the store outgrows the list
                rebuild();
                // render() drops rows that left the window or the list; unsized (hidden), it cannot
                if (render() === false && rendered.size) dropStaleRows();
            });
        });

        // ---- Scroll / resize ----

        const onScroll = () => schedule(true);
        scrollEl.addEventListener('scroll', onScroll, { passive: true });

        let resizeTimer = null;
        ro = new ResizeObserver(() => {
            if (!ready) { requestAnimationFrame(() => { rebuild(); render(); }); return; } // first paint once sized, off the observer tick
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { rebuild(); render(); }, 100);  // debounced re-pack
        });
        ro.observe(scrollEl);
        if (!kind && !isMasonry && host !== scrollEl) ro.observe(host);   // only until a hidden host is classified

        cleanup(() => {
            destroyed = true;
            scrollEl.removeEventListener('scroll', onScroll);
            ro.disconnect();
            rowRo && rowRo.disconnect();
            cellMo && cellMo.disconnect();
            clearTimeout(resizeTimer);
            clearRows();
            if (isMasonry) sizer.remove();
            else { topSpacer.remove(); botSpacer.remove(); }
        });
    });

}

// ---- Module helpers ----

// Container kind — which spacer element + geometry the container needs.
function detectKind(host) {
    const tag = host.tagName;
    if (tag === 'TBODY' || tag === 'THEAD' || tag === 'TFOOT' || tag === 'TABLE') return 'table';
    const disp = getComputedStyle(host).display;
    if (disp === 'none') return null;
    if (disp.includes('grid')) return 'grid';
    if (disp.includes('flex')) return 'flex';
    return 'block';
}

// Windowing mode — how items fill lines. Masonry is never auto-detected.
function detectMode(kind, host) {
    if (kind === 'flex' && (getComputedStyle(host).flexWrap || '').startsWith('wrap')) return 'gallery';
    return 'rows';
}

function makeSpacer(kind, colCount) {
    let s;
    if (kind === 'table') {
        s = document.createElement('tr');
        const td = document.createElement('td');
        if (colCount > 1) td.colSpan = colCount;
        td.style.cssText = 'padding:0;border:0;height:0';
        s.appendChild(td);
    } else {
        s = document.createElement('div');
        s.style.width = '100%';
    }
    s.dataset.virtualSpacer = '';
    s.setAttribute('aria-hidden', 'true');
    s.style.height = '0px';
    s.style.padding = '0';
    s.style.margin = '0';
    s.style.border = '0';
    s.style.background = 'none';
    s.style.pointerEvents = 'none';
    return s;
}

// Box-less children (template, display:none) report a 0,0 rect that would drag
// the union to the viewport top; skip them, descend into nested display:contents.
function unionCellRects(node, b) {
    for (const c of node.children) {
        if (c.tagName === 'TEMPLATE') continue;
        const r = c.getBoundingClientRect();
        if (!r.width && !r.height) {
            if (getComputedStyle(c).display === 'contents') unionCellRects(c, b);
            continue;
        }
        if (r.top < b.top) b.top = r.top;
        if (r.bottom > b.bottom) b.bottom = r.bottom;
    }
}

function styleSpacer(s, kind) {
    s.style.gridColumn = kind === 'grid' ? '1 / -1' : '';
    s.style.flex = kind === 'flex' ? '0 0 100%' : '';
}

function setHeight(spacer, px) {
    const h = Math.max(0, px) + 'px';
    spacer.style.height = h;
    if (spacer.firstElementChild && spacer.tagName === 'TR') spacer.firstElementChild.style.height = h;
}

// keyFn(item, index) returns the row's key. Falls back to identity on failure.
function buildKeyFn(itemName, indexName, keyExpr) {
    // Keys read the unwrapped item (a derived list holds proxies), and an item used as its own key is one key either way
    const plain = (key) => (key && typeof key === 'object' && window.Alpine && Alpine.raw ? Alpine.raw(key) : key);
    try {
        const fn = indexName ? new Function(itemName, indexName, `return (${keyExpr});`) : new Function(itemName, `return (${keyExpr});`);
        return (item, i) => { try { return plain(fn(plain(item), i)); } catch { return plain(item); } };
    } catch {
        return (item) => plain(item);
    }
}

let virtualPluginInitialized = false;

function ensureVirtualPluginInitialized() {
    if (virtualPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
    virtualPluginInitialized = true;
    initializeVirtualPlugin();
}

window.ensureVirtualPluginInitialized = ensureVirtualPluginInitialized;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureVirtualPluginInitialized);
}

document.addEventListener('alpine:init', ensureVirtualPluginInitialized);

if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureVirtualPluginInitialized, 0);
} else {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureVirtualPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}


})();
