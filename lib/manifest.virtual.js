/* Manifest Virtual — in-flow list/table/grid/gallery/masonry virtualization for Alpine.
 *
 * Renders only rows in the viewport (plus overscan). Line modes keep rows in NORMAL
 * FLOW between top/bottom spacers standing in for off-window rows, so the same markup
 * works virtualized or not and shared columns/sticky/flex-wrap behave normally;
 * masonry positions absolutely. Options: estimate (px or {width,height}), overscan,
 * mode ('rows'|'gallery'|'masonry'; masonry must be explicit, others auto-detect).
 * Column widths must be content-independent or columns shift as the window changes.
 */


(function () {

function initializeVirtualPlugin() {

    Alpine.directive('virtual', (el, { expression }, { evaluate, evaluateLater, effect, cleanup }) => {

        // --- Find the template (may be nested, e.g. table > tbody > template) ---
        const template = el.querySelector('template[x-for]') || el.querySelector(':scope template');
        if (!template || !template.getAttribute('x-for')) {
            // Quiet on re-init of an already-virtualized container (x-for stripped first pass).
            if (!el.querySelector('[data-virtual-spacer]')) {
                console.warn('[x-virtual] expects a descendant <template> with x-for, e.g. <template x-for="row in $x.items" :key="row.id">…');
            }
            return;
        }
        const forExpr = template.getAttribute('x-for');
        const m = /^\s*(\S+|\(\s*\S+\s*,\s*\S+\s*\))\s+(?:in|of)\s+(.+?)\s*$/.exec(forExpr);
        if (!m) {
            console.warn('[x-virtual] could not parse x-for expression: ' + forExpr);
            return;
        }
        const itemName = m[1].trim();
        const sourceExpr = m[2].trim();
        const keyExpr = template.getAttribute(':key') || template.getAttribute('x-bind:key') || `${itemName}.id`;

        // Strip x-for/:key so Alpine won't render the full list; keep the template as clone source.
        template.removeAttribute('x-for');
        template.removeAttribute(':key');
        template.removeAttribute('x-bind:key');

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

        const kind = detectKind(host);                        // spacer/geometry: table | grid | flex | block
        const mode = options.mode || detectMode(kind, host);  // windowing: rows | gallery | masonry
        const isGallery = mode === 'gallery';
        const isMasonry = mode === 'masonry';

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
        }
        const anchor = isMasonry ? sizer : botSpacer;   // rows insert before this

        // --- State ---
        const heights = new Map();   // key -> measured line/row height
        const widths = new Map();    // key -> measured item width (gallery only)
        let measuredSum = 0, measuredCount = 0;
        const rendered = new Map();  // key -> { node, scope, removeScope }
        let data = [];
        let cumulative = new Float64Array(1);  // line-top offsets; last = total
        let lines = [];                        // gallery: [{ start, end, height }]
        let pos = [];                          // masonry: per-index { x, y, w, h }
        let sortedTop = [];                    // masonry: indices sorted by y
        let totalHeight = 0;                   // masonry: packed content height
        let maxItemH = 0;                      // masonry: back-scan bound
        let ready = false;                     // becomes true once container is sized

        const keyFn = buildKeyFn(itemName, keyExpr);
        const avgH = () => (measuredCount > 0 ? measuredSum / measuredCount : estimateH);
        const heightFor = (k) => heights.get(k) ?? avgH();
        const widthFor = (k) => widths.get(k) ?? estimateW;
        const heightForItem = (item) => heightFn ? (Number(heightFn(item)) || estimateH) : heightFor(keyFn(item));

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
            for (let i = 0; i < n; i++) {
                const item = data[i];
                let span = spanFn ? (spanFn(item) | 0) : 1;
                if (span < 1) span = 1; else if (span > cols) span = cols;
                const h = heightForItem(item);
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
            for (let i = 0; i < n; i++) {
                cumulative[i] = y;
                y += heightFor(keyFn(data[i]));
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
                    const k = keyFn(data[i]);
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

        function render() {
            if (isMasonry) return renderMasonry();
            const total = isGallery ? lines.length : data.length;
            if (!total) { clearRows(); setHeight(topSpacer, 0); setHeight(botSpacer, 0); return; }
            const vh = scrollEl.clientHeight;
            if (!vh) return;                                     // defer until sized
            ready = true;

            const eff = Math.max(0, scrollEl.scrollTop - regionTop());
            let startUnit = findStart(eff, total) - overscan;
            if (startUnit < 0) startUnit = 0;
            let endUnit = findStart(eff + vh, total) + 1 + overscan;
            if (endUnit > total) endUnit = total;

            setHeight(topSpacer, cumulative[startUnit]);
            setHeight(botSpacer, cumulative[total] - cumulative[endUnit]);

            // Resolve the item range for these units.
            const startItem = isGallery ? lines[startUnit].start : startUnit;
            const endItem = isGallery ? lines[endUnit - 1].end : endUnit;

            const visible = new Set();
            const keys = [];
            for (let i = startItem; i < endItem; i++) {
                const item = data[i];
                if (item == null) continue;
                const key = keyFn(item);
                if (key == null) continue;
                visible.add(key);
                keys.push(key);
                let entry = rendered.get(key);
                if (!entry) entry = mountRow(item, key);
                else if (entry.scope[itemName] !== item) entry.scope[itemName] = item;  // rebind by key
                host.insertBefore(entry.node, botSpacer);        // keep DOM order = data order
            }
            for (const [key, entry] of rendered) {
                if (!visible.has(key)) removeRow(key, entry);
            }

            // Measure anything not yet measured, then reconcile offsets once.
            scheduleMeasure(keys);
        }

        // Masonry: render items whose packed box intersects the viewport, positioned
        // absolutely at their computed (x, y, w).
        function renderMasonry() {
            if (!data.length) { clearRows(); sizer.style.height = '0px'; return; }
            const vh = scrollEl.clientHeight;
            if (!vh) return;                                     // defer until sized
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
                const key = keyFn(item);
                if (key == null) continue;
                visible.add(key);
                keys.push(key);
                let entry = rendered.get(key);
                if (!entry) entry = mountRow(item, key);
                else if (entry.scope[itemName] !== item) entry.scope[itemName] = item;
                const s = entry.node.style;
                s.position = 'absolute';
                s.left = p.x + 'px';
                s.top = p.y + 'px';
                s.width = p.w + 'px';
            }
            for (const [key, entry] of rendered) {
                if (!visible.has(key)) removeRow(key, entry);
            }
            scheduleMeasure(keys);
        }

        function mountRow(item, key) {
            const tpl = template.content.firstElementChild;
            const node = tpl.cloneNode(true);
            host.insertBefore(node, anchor);                     // connect before init
            const scope = Alpine.reactive({ [itemName]: item });
            const removeScope = Alpine.addScopeToNode(node, scope);
            Alpine.initTree(node);
            const entry = { node, scope, removeScope };
            rendered.set(key, entry);
            return entry;
        }

        function removeRow(key, entry) {
            entry.removeScope && entry.removeScope();
            Alpine.destroyTree && Alpine.destroyTree(entry.node);
            entry.node.remove();
            rendered.delete(key);
        }

        function clearRows() {
            for (const [key, entry] of rendered) removeRow(key, entry);
        }

        // ---- Measurement ----

        let measureScheduled = false;
        function scheduleMeasure(keys) {
            if (isMasonry && heightFn) return;                   // heights known from data
            // Only measure rows we haven't sized yet.
            const pending = [];
            for (const key of keys) {
                const need = isGallery ? (!heights.has(key) || !widths.has(key)) : !heights.has(key);
                if (need && rendered.has(key)) pending.push(key);
            }
            if (!pending.length || measureScheduled) return;
            measureScheduled = true;
            requestAnimationFrame(() => {
                measureScheduled = false;
                let changed = false;
                for (const key of pending) {
                    const entry = rendered.get(key);
                    if (entry && measureRow(key, entry.node)) changed = true;
                }
                if (changed) { rebuild(); render(); }
            });
        }

        function measureRow(key, node) {
            if (!node.isConnected) return false;
            const h = measureHeight(node);
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
        // their cells. Everything else uses offsetHeight.
        function measureHeight(node) {
            if (getComputedStyle(node).display === 'contents') {
                let top = Infinity, bottom = -Infinity;
                for (const c of node.children) {
                    const r = c.getBoundingClientRect();
                    if (r.top < top) top = r.top;
                    if (r.bottom > bottom) bottom = r.bottom;
                }
                return bottom > top ? bottom - top : 0;
            }
            return node.offsetHeight;
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
                data = Array.isArray(value) ? value : (value ? Array.from(value) : []);
                // Drop rendered rows whose key no longer exists.
                const valid = new Set();
                for (const item of data) if (item != null) valid.add(keyFn(item));
                for (const [key, entry] of rendered) if (!valid.has(key)) removeRow(key, entry);
                rebuild();
                render();
            });
        });

        // ---- Scroll / resize ----

        let scrollScheduled = false;
        const onScroll = () => {
            if (scrollScheduled) return;
            scrollScheduled = true;
            requestAnimationFrame(() => { scrollScheduled = false; render(); });
        };
        scrollEl.addEventListener('scroll', onScroll, { passive: true });

        let resizeTimer = null;
        const ro = new ResizeObserver(() => {
            if (!ready) { render(); return; }                    // first paint once sized
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { rebuild(); render(); }, 100);  // debounced re-pack
        });
        ro.observe(scrollEl);

        cleanup(() => {
            scrollEl.removeEventListener('scroll', onScroll);
            ro.disconnect();
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
        if (kind === 'grid') s.style.gridColumn = '1 / -1';
        else if (kind === 'flex') s.style.flex = '0 0 100%';
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

function setHeight(spacer, px) {
    const h = Math.max(0, px) + 'px';
    spacer.style.height = h;
    if (spacer.firstElementChild && spacer.tagName === 'TR') spacer.firstElementChild.style.height = h;
}

// keyFn(item) returns the row's key. Falls back to identity on failure.
function buildKeyFn(itemName, keyExpr) {
    try {
        const fn = new Function(itemName, `return (${keyExpr});`);
        return (item) => { try { return fn(item); } catch { return item; } };
    } catch {
        return (item) => item;
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
