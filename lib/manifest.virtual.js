/* Manifest Virtual — in-flow list/table/grid/gallery/masonry virtualization for Alpine.
 *
 * Renders only rows in the viewport (plus overscan). Line modes keep rows in NORMAL
 * FLOW between top/bottom spacers standing in for off-window rows, so the same markup
 * works virtualized or not and shared columns/sticky/flex-wrap behave normally;
 * masonry positions absolutely. Options: estimate (px or {width,height}), overscan,
 * mode ('rows'|'gallery'|'masonry'; masonry must be explicit, others auto-detect),
 * recycle (true: rows leaving the window are rebound to rows entering it, which then get
 * `manifest:virtual-recycle`; line modes only, not with x-transition in rows).
 * With several x-for templates inside, mark the virtualized one `data-virtual`.
 * `$virtual` (the list around an element, or `$virtual(id | element)`): scrollToIndex / scrollToKey.
 * Column widths must be content-independent or columns shift as the window changes.
 */


(function () {

// `item in src` or `(item, index) in src`, parentheses optional (as x-for)
const FOR_RE = /^\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)?\s+(?:in|of)\s+(.+?)\s*$/;

// Recycle: a row holding one of these open is not handed on (unbound DOM state)
const OPEN_SEL_BASIC = 'details[open],dialog[open],[aria-expanded="true"][aria-controls],[aria-expanded="true"][popovertarget]';
const OPEN_SEL = OPEN_SEL_BASIC + ',:popover-open';
const RECYCLE_EVENT = 'manifest:virtual-recycle';
const RECYCLE_HANDLER = /^(@|x-on:)manifest:virtual-recycle(\.|$)/;

// Scroll-to method names on $virtual
const SCROLL_TO = { index: 'scrollToIndex', key: 'scrollToKey' };
const ALIGNS = ['start', 'center', 'end', 'nearest'];
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown']);
const WIDGET_SEL = 'input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[role=slider],[role=spinbutton],[role=listbox],[role=menu],[role=menubar],[role=tablist],[role=tree],[role=treegrid],[role=grid],[role=radiogroup],[role=combobox],[role=scrollbar],[role=textbox],[role=searchbox]';
const FOLLOW_QUIET = 400, FOLLOW_MAX = 3000, SETTLE_MAX = 1500;   // ms after landing: keep the target in place while rows still size
const handles = new WeakMap();   // x-virtual element -> its $virtual API

// A value for a message, whatever it is
function describe(x) {
    try { return typeof x === 'string' ? `'${x}'` : typeof x === 'symbol' ? x.toString() : typeof x === 'object' && x !== null ? (x.tagName ? x.tagName.toLowerCase() : 'an object') : String(x); }
    catch { return typeof x; }
}

function holdsOpen(n) {
    try { return n.matches(OPEN_SEL) || !!n.querySelector(OPEN_SEL); }
    catch { return n.matches(OPEN_SEL_BASIC) || !!n.querySelector(OPEN_SEL_BASIC); }
}

function hasAttr(node, test) {
    for (const a of node.attributes) if (test(a.name)) return true;
    return false;
}

// Any element in a template's content, nested templates included, passing test
function templateHas(content, test) {
    for (const node of content.querySelectorAll('*')) {
        if (test(node)) return true;
        if (node.tagName === 'TEMPLATE' && templateHas(node.content, test)) return true;
    }
    return false;
}

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

// Spacers of this list (not of a list nested in it)
function ownSpacers(el) {
    const out = [];
    for (const s of el.querySelectorAll('[data-virtual-spacer]')) {
        let n = s.parentElement;
        while (n && n !== el && !hasVirtual(n)) n = n.parentElement;
        if (n === el) out.push(s);
    }
    return out;
}

// Prerendered rows have no loop scope: stamped rows, rows between line spacers, placed masonry items
function bakedRows(host, spacers) {
    const out = new Set(host.querySelectorAll(':scope > [data-virtual-row]'));
    if (spacers.length === 1) {
        for (const n of host.children) if (n.tagName !== 'TEMPLATE' && n !== spacers[0] && n.style.position === 'absolute') out.add(n);
    } else {
        const end = spacers[spacers.length - 1];
        for (let n = spacers[0].nextSibling; n && n !== end; n = n.nextSibling) if (n.tagName !== 'TEMPLATE' || !n.hasAttribute('data-virtual-for')) out.add(n);
    }
    return out;
}

// Prerendered list: drop its rows and spacers before Alpine walks them; the list renders afresh.
// A bake without the loop on its template cannot run: its rows stay as baked, inert
function adoptBaked(el, template) {
    if (live.has(el)) return;
    const spacers = ownSpacers(el);
    if (!spacers.length) return;
    const host = spacers[0].parentElement;
    if (template && template.hasAttribute('data-virtual-for')) {
        for (const n of bakedRows(host, spacers)) n.remove();
        for (const s of spacers) s.remove();
    } else {
        for (const n of bakedRows(host, spacers)) if (n.nodeType === 1 && !n._x_marker) n.setAttribute('x-ignore', '');
    }
}

const live = new WeakSet();   // x-virtual elements with a running list
const baking = () => window.__manifestRender === true;

function initializeVirtualPlugin() {

    // Alpine queues a tree's directives before running any: x-for comes off as the container is visited
    if (typeof Alpine.interceptInit === 'function') {
        Alpine.interceptInit((el) => {
            if (el.nodeType !== 1 || !hasVirtual(el) || el.hasAttribute('x-ignore')) return;
            const template = pickTemplate(el);
            if (template) stashFor(template);
            adoptBaked(el, template);
        });
    }

    // One dependency for "any index or length change" where array iteration is instrumented; else a read per index
    const cheapIterate = Alpine.reactive([]).some !== Array.prototype.some;
    const anyItem = () => true;
    const toRaw = Alpine.raw || ((x) => x);
    // Runs fn in a throwaway effect: row inits reading the item must not subscribe the source effect to it
    function untracked(fn) {
        if (typeof Alpine.effect !== 'function' || typeof Alpine.release !== 'function') return fn();
        let out, err, failed = false;
        // A throw is caught inside, so the effect always exists to release (an engine may keep a failed one live)
        Alpine.release(Alpine.effect(() => { try { out = fn(); } catch (e) { err = e; failed = true; } }));
        if (failed) throw err;
        return out;
    }
    function trackList(list) {
        if (!Array.isArray(list)) return;   // an iterator would be consumed
        void list.length;
        if (cheapIterate) { list.some(anyItem); return; }
        for (let i = 0; i < list.length; i++) void list[i];
    }

    // $virtual: the list this element is in, or $virtual(id | element)
    const warnedNoList = new Set();
    const noList = (t) => {
        const f = () => {
            const msg = `[x-virtual] no x-virtual list ${t === undefined ? 'around this element' : 'for ' + (typeof t === 'string' ? `id "${t}"` : describe(t))}`;
            if (!warnedNoList.has(msg)) { warnedNoList.add(msg); console.warn(msg); }
            return Promise.resolve(null);
        };
        return { [SCROLL_TO.index]: f, [SCROLL_TO.key]: f };
    };
    Alpine.magic('virtual', (el) => {
        let local = null;
        for (let n = el; n && !local; n = n.parentElement) local = handles.get(n) || null;
        const pick = (t) => (typeof t === 'string' ? handles.get(document.getElementById(t)) : t && typeof t === 'object' && handles.get(t)) || noList(t);
        return new Proxy(pick, {
            get(fn, p) {
                if (local && p in local) return local[p];
                if (p === SCROLL_TO.index || p === SCROLL_TO.key) return noList()[p];
                return fn[p];
            }
        });
    });

    Alpine.directive('virtual', (el, { expression }, { evaluate, evaluateLater, effect, cleanup }) => {

        if (live.has(el)) return;
        // --- Find the template (may be nested, e.g. table > tbody > template) ---
        const template = pickTemplate(el, true) || el.querySelector(':scope template');
        if (template) stashFor(template);
        adoptBaked(el, template);
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

        // The template stays as the clone source; data-virtual-for/-key stay for a prerendered page to run again
        live.add(el);

        // --- Options ---
        const options = expression ? (evaluate(expression) || {}) : {};
        const est = options.estimate;
        const estimateH = (est && typeof est === 'object') ? (Number(est.height) || 50) : (Number(est) > 0 ? Number(est) : 50);
        const estimateW = (est && typeof est === 'object') ? (Number(est.width) || 120) : 120;
        const overscan = Number.isFinite(options.overscan) && options.overscan >= 0 ? Number(options.overscan) : 3;
        let recycle = options.recycle === true && options.mode !== 'masonry';   // line modes only
        let rowTeleports = false;
        if (recycle) {
            const rows = template.content;
            if (templateHas(rows, (n) => hasAttr(n, (a) => a.startsWith('x-transition')))) {
                recycle = false;
                console.warn('[x-virtual] recycle is off for this list: its rows use x-transition, which would replay between unrelated items', el);
            } else {
                rowTeleports = templateHas(rows, (n) => n.tagName === 'TEMPLATE' && n.hasAttribute('x-teleport'));
                // The event does not bubble: only a handler on the row root counts
                const root = rows.firstElementChild;
                const onRoot = root && hasAttr(root, (a) => RECYCLE_HANDLER.test(a));
                if (!onRoot && templateHas(rows, (n) => hasAttr(n, (a) => a === 'x-init' || a.startsWith('x-init.')))) {
                    console.warn(`[x-virtual] recycle: x-init runs once per row node, not per item. Reset row state with @${RECYCLE_EVENT}`, el);
                }
            }
        }

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
        let builtAvg = 0;                      // the unmeasured-row estimate at the last full rebuild
        let builtKeys = [];                    // key at each index when the offsets were last built
        let dataVer = 0;                       // source changes seen
        let seek = null;                       // scroll-to in progress
        let seekCalls = 0;

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

        // Rows that were before the window keep their offset step by key (an unchanged prefix is copied as is);
        // only rows without one are estimated from the current average
        function rebuildSingle() {
            const n = raw.length;
            const prev = cumulative, prevKeys = builtKeys;
            const keys = new Array(n);
            const limit = Math.min(lastStart, n, prevKeys.length, prev.length - 1);
            let p = 0;
            for (; p < limit; p++) if ((keys[p] = keyFn(raw[p], p)) !== prevKeys[p]) break;
            const oldLimit = Math.min(lastStart, prevKeys.length, prev.length - 1);
            // Old rows are matched in order (a few skipped rows tolerated); many misses switch to a key map of the rest
            let j = p, misses = 0, steps = null, seen = null;
            const skipped = [];                // recently passed old rows: a row moved down a little (a swap)
            const carried = (k) => {
                if (steps) {
                    const v = steps.get(k);
                    if (!Array.isArray(v)) return v;
                    const c = (seen || (seen = new Map())).get(k) || 0;
                    seen.set(k, c + 1);
                    return v[c];
                }
                if (j >= oldLimit) return undefined;
                for (let d = 0; d < 8 && j + d < oldLimit; d++) {
                    if (prevKeys[j + d] !== k) continue;
                    for (let o = j; o < j + d; o++) { skipped.push(o); if (skipped.length > 8) skipped.shift(); }
                    j += d + 1;
                    return prev[j] - prev[j - 1];
                }
                for (let q = 0; q < skipped.length; q++) {
                    const o = skipped[q];
                    if (prevKeys[o] === k) { skipped.splice(q, 1); return prev[o + 1] - prev[o]; }
                }
                if (++misses > 16) {
                    steps = new Map();
                    for (let i = j; i < oldLimit; i++) {
                        const ok = prevKeys[i];
                        if (ok == null) continue;
                        const step = prev[i + 1] - prev[i], had = steps.get(ok);
                        if (had === undefined) steps.set(ok, step);
                        else if (typeof had === 'number') steps.set(ok, [had, step]);   // a repeated key: steps in order
                        else had.push(step);
                    }
                    return carried(k);
                }
                return undefined;
            };
            cumulative = new Float64Array(n + 1);
            if (p) cumulative.set(prev.subarray(0, p + 1));
            let y = p ? prev[p] : 0;
            for (let i = p; i < n; i++) {
                cumulative[i] = y;
                const k = i === p && keys[i] !== undefined ? keys[i] : keyFn(raw[i], i);
                keys[i] = k;
                const c = j < oldLimit || steps ? carried(k) : undefined;   // a carried step is the row's measured height if it had one
                y += c ?? heights.get(k) ?? avgH();
            }
            cumulative[n] = y;
            builtKeys = keys;
            builtAvg = avgH();
        }

        // Re-measured rendered rows: shift the offsets after each by its change, without re-reading the list.
        // A full rebuild instead when a row's index is unknown or the estimate for unmeasured rows moved by 10%
        function applyMeasured(keys) {
            const n = raw.length;
            if (isMasonry || isGallery || cumulative.length !== n + 1 || Math.abs(avgH() - builtAvg) > builtAvg * 0.1) return rebuild();
            const changes = [];
            for (const key of keys) {
                const entry = rendered.get(key);
                const i = entry ? entry.i : -1;
                if (!(i >= 0 && i < n) || keyFn(raw[i], i) !== key) return rebuild();
                const d = heights.get(key) - (cumulative[i + 1] - cumulative[i]);
                if (d) changes.push(i, d);
            }
            if (!changes.length) return;
            const order = [];
            for (let c = 0; c < changes.length; c += 2) order.push(c);
            order.sort((a, b) => changes[a] - changes[b]);
            let acc = 0, c = 0;
            for (let j = changes[order[0]] + 1; j <= n; j++) {
                while (c < order.length && changes[order[c]] < j) acc += changes[order[c++] + 1];
                cumulative[j] += acc;
            }
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
            if (seek && !seek.snap) noteClamp(seek);
            const r = renderWindow();
            if (seek && seek.parked && r !== false) { seek.parked = false; seek.wrote = scrollEl.scrollTop; seek.t1 = 0; arm(seek, true); seek.raf = requestAnimationFrame(seekFrame); }
            return r;
        }

        function renderWindow() {
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
            const free = recycle ? new Map() : null;   // leaving row node -> [old key, entry], for rows entering this pass
            const ctxHosts = free && window.__mnfstContextHosts ? window.__mnfstContextHosts() : null;   // open x-dropdown.context triggers
            for (const [key, entry] of rendered) {
                if (!visible.has(key)) {
                    if (free && reusable(entry, ctxHosts)) { free.set(entry.node, [key, entry]); rendered.delete(key); }
                    else removeRow(key, entry);
                }
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
            let placed = topSpacer;                    // recycle: the last row placed
            const recycled = free ? [] : null;         // rows rebound this pass, told once all are placed
            try {
                for (let i = 0; i < keys.length; i++) {
                    if (cursor.parentNode !== host) cursor = botSpacer;
                    let entry = rendered.get(keys[i]);
                    if (!entry && free && free.size) {
                        // A free row already between the last placed row and the cursor stays put
                        let node = null;
                        for (let n = placed.parentNode === host ? placed.nextSibling : null; n && n !== cursor; n = n.nextSibling) {
                            if (free.has(n)) { node = n; break; }
                            if (rowNodes.has(n)) break;
                        }
                        const inPlace = !!node;
                        if (!node) node = free.keys().next().value;
                        const [oldKey, e] = free.get(node);
                        entry = e;
                        reuseRow(entry, oldKey, keys[i], items[i], indices[i]);
                        recycled.push(entry, keys[i]);
                        free.delete(node);
                        rowNodes.add(node);
                        if (!inPlace) host.insertBefore(node, cursor);
                        placed = node;
                        continue;
                    }
                    if (!entry) {
                        entry = free ? untracked(() => mountRow(items[i], keys[i], cursor, indices[i])) : mountRow(items[i], keys[i], cursor, indices[i]);
                        rowNodes.add(entry.node);
                        if (entry.node.parentNode !== host) host.insertBefore(entry.node, cursor);  // root replaced itself in init
                        if (free) placed = entry.node;
                        continue;
                    }
                    if (free) rebindQuiet(entry, items[i], indices[i]);
                    else rebind(entry, items[i], indices[i]);
                    if (entry.node === cursor) cursor = nextRow(cursor.nextSibling);
                    else host.insertBefore(entry.node, cursor);
                    if (free) placed = entry.node;
                }
            } finally {
                // Leaving rows nobody took are destroyed as without recycle
                if (free) for (const [key, e] of free.values()) removeRow(key, e);
            }
            // After Alpine's flush for this pass (queued as a microtask on the first rebind), so handlers see the
            // updated row and their writes start a new flush instead of being dropped from this one
            if (recycled && recycled.length) queueMicrotask(() => { if (!destroyed) untracked(() => notifyRecycled(recycled)); });

            // Measure anything not yet measured, then reconcile offsets once.
            scheduleMeasure(keys);
        }

        // Recycle: a leaving row is handed on unless it (or content it teleported) holds focus or something open,
        // or it cannot move as one node (a <template> root renders its rows beside it)
        function reusable(entry, ctxHosts) {
            const n = entry.node;
            if (ctxHosts) for (const h of ctxHosts) if (n.contains(h)) return false;
            if (n.tagName === 'TEMPLATE' || n.parentNode !== host) return false;
            const a = document.activeElement;
            if (a && a !== document.body && n.contains(a)) return false;
            if (rowTeleports) {
                for (const t of n.querySelectorAll('template[x-teleport]')) {
                    const c = t._x_teleport;
                    if (c && (c.contains(a) || holdsOpen(c))) return false;
                    if (ctxHosts && c) for (const h of ctxHosts) if (c.contains(h)) return false;
                }
            }
            return !holdsOpen(n);
        }

        // Rows rebound this pass get `manifest:virtual-recycle` (detail: key, index), their scope already on the new item
        function notifyRecycled(list) {
            for (let j = 0; j < list.length; j += 2) {
                const entry = list[j], key = list[j + 1];
                if (rendered.get(key) !== entry) continue;
                entry.node.dispatchEvent(new CustomEvent(RECYCLE_EVENT, { detail: { key, index: entry.i } }));
            }
        }

        // Recycle: re-key a leaving row for an entering item; it is measured afresh under the new key
        function reuseRow(entry, oldKey, key, item, i) {
            if (entry.targets) {
                const kept = [];
                for (const t of entry.targets) {
                    if (entry.node.contains(t)) { targetKey.set(t, key); kept.push(t); }
                    else { rowRo.unobserve(t); targetKey.delete(t); }   // cells an x-if dropped
                }
                entry.targets = kept;
            }
            pending.delete(oldKey);
            entry.seen = false;
            rendered.set(key, entry);
            rebindQuiet(entry, item, i);
        }

        // Rebind comparing the raw scope: a read through the proxy here would make the source effect depend on it
        function rebindQuiet(entry, item, i) {
            entry.i = i;
            const s = toRaw(entry.scope);
            if (toRaw(s[itemName]) !== toRaw(item)) entry.scope[itemName] = item;
            if (indexName && s[indexName] !== i) entry.scope[indexName] = i;
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
            entry.i = i;
            if (entry.scope[itemName] !== item) entry.scope[itemName] = item;
            if (indexName && entry.scope[indexName] !== i) entry.scope[indexName] = i;
        }

        function mountRow(item, key, before = anchor, i) {
            const tpl = template.content.firstElementChild;
            const node = tpl.cloneNode(true);
            if (baking()) node.setAttribute('data-virtual-row', '');
            host.insertBefore(node, before);                     // connect before init
            const scope = Alpine.reactive(indexName ? { [itemName]: item, [indexName]: i } : { [itemName]: item });
            const removeScope = Alpine.addScopeToNode(node, scope);
            Alpine.initTree(node);
            const entry = { node, scope, removeScope, targets: null, seen: false, i };
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
        // (x-if in the row) are found by one MutationObserver watching each such row's own children
        let cellMo = null;
        function watchChildren(entry, node) {
            if (entry.watched) return;
            entry.watched = true;
            if (!cellMo) cellMo = new MutationObserver((records) => {
                for (const r of records) {
                    if (!hasElement(r.addedNodes) && !hasElement(r.removedNodes)) continue;   // text-only changes
                    const key = targetKey.get(r.target);
                    if (key !== undefined && rendered.get(key)?.node === r.target) pending.add(key);
                }
                if (pending.size) schedule();
            });
            cellMo.observe(node, { childList: true });
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
                const doRender = measurePending() || renderPending;
                renderPending = false;
                if (doRender) render();
            });
        }

        function measurePending() {
            const changed = [];
            for (const key of pending) {
                const entry = rendered.get(key);
                if (entry && measureRow(key, entry)) changed.push(key);
            }
            pending.clear();
            if (seek && !seek.snap) noteClamp(seek);
            if (!changed.length) return false;
            applyMeasured(changed);
            if (seek) seek.quiet = performance.now();
            return true;
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
            if (contents && rowRo) { watchChildren(entry, node); observeCells(entry, key, node); }
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

        // ---- Scroll to an item ----

        const warned = new Set();
        const padCache = new Map();
        function warnOnce(msg) {
            if (warned.has(msg)) return;
            if (warned.size > 50) warned.clear();
            warned.add(msg);
            console.warn(msg, el);
        }

        // Starts after the current flush, so an item added in the same tick is in the list
        function seekCall(byKey, target, opts) {
            const call = ++seekCalls;
            return new Promise((resolve) => queueMicrotask(() => {
                try {
                    if (call !== seekCalls || destroyed) return resolve(null);
                    let i = -1, key;
                    if (byKey) i = indexOfKey(key = target, -1);
                    else {
                        // A whole number, or digits as text (x-model without .number)
                        const n = typeof target === 'string' && /^\s*\d+\s*$/.test(target) ? Number(target) : target;
                        if (!Number.isInteger(n) || n < 0 || Object.is(n, -0)) {
                            warnOnce(`[x-virtual] ${SCROLL_TO.index}: index must be a whole number, got ${describe(target)}`);
                            endSeek(null);
                            return resolve(null);
                        }
                        if (n < raw.length) key = keyFn(raw[i = n], i);
                    }
                    if (i < 0) {
                        warnOnce(`[x-virtual] ${byKey ? SCROLL_TO.key : SCROLL_TO.index}: no item ${byKey ? 'with key' : 'at index'} ${describe(target)} (${raw.length} items)`);
                        endSeek(null);
                        return resolve(null);
                    }
                    const o = opts || {};
                    const align = ALIGNS.includes(o.align) ? o.align : 'start';
                    const offset = Number(o.offset) || 0;
                    const snap = snaps();   // snap lists: one instant jump, wherever the browser snaps
                    const smooth = !snap && o.behavior === 'smooth' && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
                    // The same request again joins the one in progress; one that already landed lands again if the row moved away
                    if (seek && seek.key === key && seek.align === align && seek.offset === offset && seek.smooth === smooth) {
                        if (!seek.done) return seek.waiters.push(resolve);
                        const node = targetNode();
                        if (node && Math.abs(destFor(seek) - scrollEl.scrollTop) < 1) return resolve(node);
                    }
                    endSeek(null);
                    seek = { key, i, ver: dataVer, waiters: [resolve], align, offset, smooth, snap, parked: false, armed: false, raf: 0, frames: 0, done: false, wrote: scrollEl.scrollTop, quiet: 0, until: 0, anchor: scrollEl.style.overflowAnchor };
                    scrollEl.style.overflowAnchor = 'none';   // the seek keeps the target in place itself
                    arm(seek, true);
                    seekFrame();
                } catch (e) {
                    endSeek(null);
                    resolve(null);
                    console.error(e);
                }
            }));
        }

        function settle(s, value) {
            if (s.done) return;
            s.done = true;
            for (const r of s.waiters) r(value || null);
            s.waiters = [];
        }

        function endSeek(value) {
            const s = seek;
            if (!s) return;
            seek = null;
            if (s.raf) cancelAnimationFrame(s.raf);
            scrollEl.style.overflowAnchor = s.anchor;
            arm(s, false);
            settle(s, value);
        }

        // Browser-animated scrolls (wheel, keys) can be overtaken by the next write: their intent cancels too.
        // Only while a visible list is seeking
        function arm(s, on) {
            if (s.armed === on) return;
            s.armed = on;
            const m = on ? 'addEventListener' : 'removeEventListener';
            scrollEl[m]('wheel', onUserScroll, { passive: true });
            scrollEl[m]('touchstart', onUserScroll, { passive: true });
            document[m]('keydown', onUserKey);
        }

        function onUserScroll() { endSeek(null); }

        // A key that would scroll this list: on a row or the list itself, or with nothing focused
        function onUserKey(e) {
            if (e.defaultPrevented || !SCROLL_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
            const t = e.target;
            if (t && t !== document.body && t !== document.documentElement) {
                if (!scrollEl.contains(t)) return;
                for (let n = t; n && n !== scrollEl; n = n.parentElement) {
                    if (n.matches(WIDGET_SEL)) return;
                    if (n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) return;
                }
            }
            endSeek(null);
        }

        function indexOfKey(key, hint) {
            if (hint >= 0 && hint < raw.length && keyFn(raw[hint], hint) === key) return hint;
            const e = rendered.get(key);
            if (e && e.i < raw.length && keyFn(raw[e.i], e.i) === key) return e.i;
            for (let i = 0; i < raw.length; i++) if (keyFn(raw[i], i) === key) return i;
            return -1;
        }

        // At scroll time: a position left at that moment's end is the browser clamping while rows shrink
        // (rebound rows); anything else the seek did not write is an outside move
        function seekScroll(s) {
            if (s.snap || s.parked) return;
            if (!noteClamp(s) && Math.abs(scrollEl.scrollTop - s.wrote) >= 1) endSeek(null);
        }

        // Also checked where the module flushes layout (measuring, before re-rendering), as a later frame may restore the height
        function noteClamp(s) {
            const st = scrollEl.scrollTop;
            if (Math.abs(st - s.wrote) < 1 || st < scrollEl.scrollHeight - scrollEl.clientHeight - 1) return false;
            s.wrote = st;
            return true;
        }

        // A scroll position the seek did not write: the person, the browser (keys, find, snap) or other code
        function movedOutside(s) {
            const st = scrollEl.scrollTop, max = scrollEl.scrollHeight - scrollEl.clientHeight;
            return Math.abs(st - s.wrote) >= 1 && !(s.wrote >= max - 1 && st >= max - 1);
        }

        // Lands (resolves), then follows the target while rows still size, until quiet or capped
        function seekFrame() {
            const s = seek;
            if (!s) return;
            s.raf = 0;
            try {
                if (destroyed) return endSeek(null);
                if (!ready || !scrollEl.clientHeight) { s.parked = true; s.t1 = 0; arm(s, false); return; }   // resumed by render()
                // An author :style string binding can drop the temporary overflow-anchor: put it back
                if (scrollEl.style.overflowAnchor !== 'none') { s.anchor = scrollEl.style.overflowAnchor; scrollEl.style.overflowAnchor = 'none'; }
                if (!s.snap && movedOutside(s)) return endSeek(null);
                if (s.ver !== dataVer) {
                    s.ver = dataVer;
                    if ((s.i = indexOfKey(s.key, s.i)) < 0) return endSeek(null);
                }
                if (s.snap) return snapFrame(s);
                const now = performance.now();
                // Rows resized since the last frame (rebound rows' new bindings included)
                let busy = measurePending();
                if (busy) render();
                if (!s.done) {
                    if (!(s.smooth && travel(s))) {
                        if (!s.t1) s.t1 = now;
                        if (now - s.t1 > SETTLE_MAX) return endSeek(targetNode());   // heights still changing: as close as it got
                        busy = converge(s) || busy;
                        const node = targetNode();
                        // Not in a frame that just rendered rows: recycled rows bind after this task
                        if (!busy && node && Math.abs(destFor(s) - scrollEl.scrollTop) < 1) {
                            settle(s, node);
                            s.quiet = now;
                            s.until = now + FOLLOW_MAX;
                        }
                    }
                } else {
                    if (now > s.until || now - s.quiet > FOLLOW_QUIET) return endSeek();
                    if (Math.abs(destFor(s) - scrollEl.scrollTop) >= 1) { converge(s); s.quiet = now; }
                }
                s.wrote = scrollEl.scrollTop;
                s.raf = requestAnimationFrame(seekFrame);
            } catch (e) {
                endSeek(null);
                throw e;
            }
        }

        // Snap: align with snapping off (only rendered rows are snap points), then let the browser snap; at most 4 frames
        function snapFrame(s) {
            const node = targetNode();
            const r = node && rowRect(node);
            const top = scrollEl.getBoundingClientRect().top + scrollEl.clientTop;
            const seen = r && r.bottom > top && r.top < top + scrollEl.clientHeight;
            if (seen && s.frames) return endSeek(node);
            if (++s.frames > 4) return endSeek(null);
            const type = scrollEl.style.scrollSnapType;
            scrollEl.style.scrollSnapType = 'none';
            try { converge(s); } finally { scrollEl.style.scrollSnapType = type; }
            s.raf = requestAnimationFrame(seekFrame);
        }

        function snaps() {
            return /^(y|block|both)\b/.test(getComputedStyle(scrollEl).scrollSnapType || '');   // block axis only
        }

        // Smooth: eased frames toward the estimate, re-read each frame as rows measure; never steps back
        function travel(s) {
            const now = performance.now(), cur = scrollEl.scrollTop;
            if (s.t0 === undefined) {
                s.t0 = now; s.from = cur;
                s.dur = Math.min(800, Math.max(250, Math.abs(destFor(s) - cur) / scrollEl.clientHeight * 40));
            }
            const k = Math.min(1, (now - s.t0) / s.dur);
            if (k >= 1) return false;
            const d = destFor(s);
            const y = Math.round(s.from + (d - s.from) * (k < 0.5 ? 2 * k * k : 1 - (2 - 2 * k) ** 2 / 2));
            if ((y - cur) * (d - s.from) > 0) { jump(y); render(); }
            return true;
        }

        // Instant: scroll, render and measure in this task until the target sits where asked
        function converge(s) {
            let did = false;
            for (let pass = 0; pass < 8; pass++) {
                const d = destFor(s);
                const off = Math.abs(d - scrollEl.scrollTop) >= 1;
                if (!off && targetNode()) return did;
                if (off) jump(d);
                render();
                if (measurePending()) render();
                did = true;
            }
            return did;
        }

        // Instant even under CSS scroll-behavior: smooth
        function jump(y) {
            try { scrollEl.scrollTo({ top: y, behavior: 'instant' }); } catch { scrollEl.scrollTop = y; }
            if (seek) seek.wrote = scrollEl.scrollTop;
        }

        function targetNode() {
            const e = seek && rendered.get(seek.key);
            return e && e.node.isConnected && rowRect(e.node) ? e.node : null;
        }

        function rowRect(node) {
            if (getComputedStyle(node).display === 'contents') {
                const b = { top: Infinity, bottom: -Infinity };
                unionCellRects(node, b);
                return b.bottom > b.top ? b : null;
            }
            const r = node.getBoundingClientRect();
            return r.width || r.height ? r : null;
        }

        // Target's top and height in scroll-content px: the rendered row, else the offset model
        function targetBox(s) {
            const origin = scrollEl.getBoundingClientRect().top + scrollEl.clientTop - scrollEl.scrollTop;
            const node = targetNode();
            const r = node && rowRect(node);
            if (r) return { top: r.top - origin, h: r.bottom - r.top };
            if (isMasonry) {
                const p = pos[s.i];
                return p ? { top: sizer.getBoundingClientRect().top - origin + p.y, h: p.h } : { top: 0, h: 0 };
            }
            const top = topSpacer.getBoundingClientRect().top - origin;
            if (isGallery) {
                let lo = 0, hi = lines.length - 1;
                while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (lines[mid].start <= s.i) lo = mid; else hi = mid - 1; }
                return lines.length ? { top: top + cumulative[lo], h: lines[lo].height } : { top, h: 0 };
            }
            const i = Math.min(s.i, cumulative.length - 2);
            return i >= 0 ? { top: top + cumulative[i], h: cumulative[i + 1] - cumulative[i] } : { top, h: 0 };
        }

        // scroll-padding in px or % of the viewport
        function pad(v, vh) {
            if (!v || v === 'auto') return 0;
            if (/^-?[\d.]+%$/.test(v)) return parseFloat(v) * vh / 100;
            if (!/calc|min|max|clamp/.test(v)) return parseFloat(v) || 0;
            // calc() and friends: % taken against the viewport, the rest resolved by a probe
            const k = v + '|' + vh;
            if (!padCache.has(k)) {
                const probe = document.createElement('div');
                probe.style.cssText = 'position:absolute;visibility:hidden;height:0;width:' + v.replace(/(-?[\d.]+)%/g, (_, n) => (n * vh / 100) + 'px');
                document.body.appendChild(probe);
                padCache.set(k, parseFloat(getComputedStyle(probe).width) || 0);
                probe.remove();
                if (padCache.size > 20) padCache.delete(padCache.keys().next().value);
            }
            return padCache.get(k);
        }

        // scrollTop that puts the target at its alignment, inside scroll-padding and offset
        function destFor(s) {
            const vh = scrollEl.clientHeight, st = scrollEl.scrollTop;
            const c = getComputedStyle(scrollEl);
            const a = pad(c.scrollPaddingTop, vh) + s.offset;
            const b = vh - pad(c.scrollPaddingBottom, vh) - s.offset;
            const { top, h } = targetBox(s);
            let d;
            if (s.align === 'center') d = top + h / 2 - (a + b) / 2;
            else if (s.align === 'end') d = top + h - b;
            else if (s.align === 'nearest') d = top - st >= a && top + h - st <= b ? st : (top - st < a || h > b - a ? top - a : top + h - b);
            else d = top - a;
            return Math.round(Math.max(0, Math.min(scrollEl.scrollHeight - vh, d)));
        }

        handles.set(el, {
            [SCROLL_TO.index]: (index, opts) => seekCall(false, index, opts),
            [SCROLL_TO.key]: (key, opts) => seekCall(true, key, opts),
        });

        // ---- Reactive source ----

        const getSource = evaluateLater(sourceExpr);
        effect(() => {
            getSource((value) => {
                trackList(value);
                data = Array.isArray(value) ? value : (value ? Array.from(value) : []);
                raw = Alpine.raw ? Alpine.raw(data) : data;
                dataVer++;
                if (heights.size > raw.length * 2 + 100) forgetLeft();   // amortised: only once the store outgrows the list
                rebuild();
                // render() drops rows that left the window or the list; unsized (hidden), it cannot
                if (render() === false && rendered.size) dropStaleRows();
            });
        });

        // ---- Scroll / resize ----

        const onScroll = () => { if (seek) seekScroll(seek); schedule(true); };
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
            live.delete(el);
            endSeek(null);
            handles.delete(el);
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

function hasElement(nodes) {
    for (const n of nodes) if (n.nodeType === 1) return true;
    return false;
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
