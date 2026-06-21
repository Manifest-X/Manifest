/* Manifest Virtual — variable-height list virtualization for Alpine.
 *
 * Renders only the rows visible in the scroll viewport (plus an overscan
 * buffer), so a list of tens of thousands of rows can scroll smoothly with
 * a low DOM count. Row heights are measured on render and the spacer
 * recalculates, so authors aren't bound to a fixed row height.
 *
 * Usage — wrap an x-for template with x-virtual on the scrolling container:
 *
 *   <div x-virtual style="height: 600px; overflow: auto">
 *     <template x-for="row in $x.customers" :key="row.id">
 *       <div class="row">
 *         <span x-text="row.name"></span>
 *       </div>
 *     </template>
 *   </div>
 *
 * Options (object expression on the directive):
 *
 *   <div x-virtual="{ estimate: 48, overscan: 5 }" style="height: 600px">
 *
 *     estimate   Initial per-row height in px (default 50). Used for rows
 *                that haven't been measured yet. Closer estimates mean
 *                less scroll-position drift on first render.
 *     overscan   Rows to render above/below the visible window (default 3).
 *                Higher = smoother scroll, more DOM.
 *
 * Notes:
 *
 *   - Only one template child is supported. It must have x-for and :key.
 *   - The container element must have a bounded height (CSS height /
 *     max-height) and scroll. The plugin sets overflow: auto + position:
 *     relative if not already set.
 *   - Heights are remeasured automatically if a row's content changes.
 */

function initializeVirtualPlugin() {

    Alpine.directive('virtual', (el, { expression }, { effect, evaluate, evaluateLater, cleanup }) => {

        // --- Find and parse the template ---
        const template = el.querySelector(':scope > template');
        if (!template) {
            console.warn('[x-virtual] expects a child <template> with x-for, e.g. <template x-for="row in $x.items" :key="row.id">…');
            return;
        }
        const forExpr = template.getAttribute('x-for');
        if (!forExpr) {
            console.warn('[x-virtual] child <template> must have x-for');
            return;
        }
        const m = /^\s*(\S+|\(\s*\S+\s*,\s*\S+\s*\))\s+(?:in|of)\s+(.+?)\s*$/.exec(forExpr);
        if (!m) {
            console.warn('[x-virtual] could not parse x-for expression: ' + forExpr);
            return;
        }
        const itemName = m[1].trim();
        const sourceExpr = m[2].trim();
        const keyExpr =
            template.getAttribute(':key') ||
            template.getAttribute('x-bind:key') ||
            `${itemName}.id`;

        // Remove x-for/:key so Alpine doesn't try to render the full list, but
        // KEEP the template in the DOM as our render source. We'll clone its
        // contents per visible row.
        template.removeAttribute('x-for');
        template.removeAttribute(':key');
        template.removeAttribute('x-bind:key');

        // --- Options ---
        const options = expression ? evaluate(expression) || {} : {};
        const initialEstimate = Number(options.estimate) > 0 ? Number(options.estimate) : 50;
        const overscan = Number.isFinite(options.overscan) && options.overscan >= 0 ? Number(options.overscan) : 3;

        // --- Container setup ---
        const cs = getComputedStyle(el);
        if (cs.overflow === 'visible' && cs.overflowY === 'visible') el.style.overflow = 'auto';
        if (cs.position === 'static') el.style.position = 'relative';

        // The spacer holds the rendered (absolutely positioned) rows and sizes
        // itself to the total virtual height so the scrollbar is correct.
        const spacer = document.createElement('div');
        spacer.dataset.virtualSpacer = '';
        spacer.style.position = 'relative';
        spacer.style.width = '100%';
        spacer.style.height = '0px';
        el.appendChild(spacer);

        // --- State ---
        // heights: key -> measured pixel height (only for rows that have been
        // mounted at least once and measured).
        const heights = new Map();
        let measuredSum = 0;
        let measuredCount = 0;
        // rendered: key -> wrapper element currently in the DOM
        const rendered = new Map();
        // data: latest snapshot of the source array
        let data = [];
        // Cached cumulative offsets — index i holds the sum of heights of rows
        // 0..(i-1). Length is data.length + 1; final entry is total height.
        let cumulative = new Float64Array(1);

        const getAvg = () => (measuredCount > 0 ? measuredSum / measuredCount : initialEstimate);
        const rowHeightFor = (key) => heights.get(key) ?? getAvg();

        // Evaluate the key expression against an item without going through
        // Alpine — `new Function` is fast and isolates from the surrounding
        // scope. Expression usually looks like `row.id` or `row.$id`.
        const keyFn = buildKeyFn(itemName, keyExpr);

        function rebuildCumulative() {
            const n = data.length;
            cumulative = new Float64Array(n + 1);
            let y = 0;
            for (let i = 0; i < n; i++) {
                cumulative[i] = y;
                const k = keyFn(data[i]);
                y += rowHeightFor(k);
            }
            cumulative[n] = y;
            spacer.style.height = y + 'px';
        }

        // Find the first index whose offset is >= scrollTop. Cumulative is
        // monotonic so binary search works.
        function findStartIndex(scrollTop) {
            let lo = 0, hi = data.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (cumulative[mid + 1] <= scrollTop) lo = mid + 1;
                else hi = mid;
            }
            return Math.max(0, lo - overscan);
        }

        function findEndIndex(scrollBottom, startHint) {
            let i = startHint;
            const n = data.length;
            while (i < n && cumulative[i] < scrollBottom) i++;
            return Math.min(n, i + overscan);
        }

        function renderVisible() {
            if (!data.length) {
                for (const [, node] of rendered) node.remove();
                rendered.clear();
                return;
            }
            const scrollTop = el.scrollTop;
            const viewportHeight = el.clientHeight;
            const start = findStartIndex(scrollTop);
            const end = findEndIndex(scrollTop + viewportHeight, start);

            // Track which keys remain visible
            const stillVisible = new Set();
            for (let i = start; i < end; i++) {
                const item = data[i];
                if (item == null) continue;
                const key = keyFn(item);
                if (key == null) continue; // skip un-keyable rows
                stillVisible.add(key);

                let node = rendered.get(key);
                if (!node) {
                    node = mountRow(i);
                    if (!node) continue;
                    rendered.set(key, node);
                    spacer.appendChild(node);
                    // x-data on the row needs the parent scope (where the
                    // source array lives) to resolve, so we MUST init after
                    // append, not before.
                    Alpine.initTree(node);
                    // Measure on next frame so Alpine has bound everything.
                    requestAnimationFrame(() => measureRow(key, node));
                }
                node.style.top = cumulative[i] + 'px';
                node.dataset.virtualIndex = i;
            }

            // Remove rows no longer in the window
            for (const [key, node] of rendered) {
                if (!stillVisible.has(key)) {
                    node.remove();
                    rendered.delete(key);
                }
            }
        }

        function mountRow(index) {
            const tplChild = template.content.firstElementChild;
            if (!tplChild) return null;
            const node = tplChild.cloneNode(true);
            node.style.position = 'absolute';
            node.style.left = '0';
            node.style.right = '0';
            // Inject a per-row Alpine scope. Because we reference the source
            // expression with the index baked in via a getter, Alpine tracks
            // the dependency and re-renders this row when its data updates.
            const scopeExpr = `{ get ${itemName}() { return (${sourceExpr})[${index}]; } }`;
            // Merge with any existing x-data on the cloned root.
            const existing = node.getAttribute('x-data');
            node.setAttribute('x-data', existing ? `Object.assign({}, ${scopeExpr}, ${existing})` : scopeExpr);
            // Note: caller must Alpine.initTree(node) AFTER appending to the
            // DOM, otherwise the scope can't resolve identifiers (e.g. the
            // source array) from outer x-data contexts.
            return node;
        }

        function measureRow(key, node) {
            if (!node.isConnected) return;
            const h = node.offsetHeight;
            if (!h) return;
            const prev = heights.get(key);
            if (prev === h) return;
            if (prev !== undefined) measuredSum -= prev;
            else measuredCount++;
            measuredSum += h;
            heights.set(key, h);
            // Recompute cumulative offsets and re-render so positions reflect
            // the new heights AND any rows now in/out of the visible window.
            rebuildCumulative();
            renderVisible();
        }

        // --- Reactive data source subscription ---
        const sourceGetter = evaluateLater(sourceExpr);
        effect(() => {
            sourceGetter((value) => {
                data = Array.isArray(value) ? value : (value ? Array.from(value) : []);
                // When the data identity or length changes, drop any rendered
                // rows whose keys no longer exist in the new data.
                const validKeys = new Set();
                for (const item of data) {
                    if (item != null) validKeys.add(keyFn(item));
                }
                for (const [key, node] of rendered) {
                    if (!validKeys.has(key)) {
                        node.remove();
                        rendered.delete(key);
                    }
                }
                rebuildCumulative();
                renderVisible();
            });
        });

        // --- Scroll + resize handlers ---
        let scrollScheduled = false;
        const onScroll = () => {
            if (scrollScheduled) return;
            scrollScheduled = true;
            requestAnimationFrame(() => {
                scrollScheduled = false;
                renderVisible();
            });
        };
        el.addEventListener('scroll', onScroll, { passive: true });

        const ro = new ResizeObserver(() => renderVisible());
        ro.observe(el);

        cleanup(() => {
            el.removeEventListener('scroll', onScroll);
            ro.disconnect();
            for (const [, node] of rendered) node.remove();
            rendered.clear();
            spacer.remove();
        });
    });

}

// Build a key-evaluator function for a given itemName + keyExpr.
// `keyFn(item)` returns the row's key. Falls back to identity if it fails.
function buildKeyFn(itemName, keyExpr) {
    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(itemName, `return (${keyExpr});`);
        return (item) => {
            try { return fn(item); } catch { return item; }
        };
    } catch {
        return (item) => item;
    }
}

// Track initialization to prevent duplicates
let virtualPluginInitialized = false;

function ensureVirtualPluginInitialized() {
    if (virtualPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
    virtualPluginInitialized = true;
    initializeVirtualPlugin();
}

// Expose on window for loader to call if needed
window.ensureVirtualPluginInitialized = ensureVirtualPluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureVirtualPluginInitialized);
}

document.addEventListener('alpine:init', ensureVirtualPluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately
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
