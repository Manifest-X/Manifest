/* Manifest Combobox */

(function () {

// Select-like field across four axes: trigger (input/textarea/button), options
// (none/datalist/menu/async), value (single/multiple), display (text/chips). Modes
// are modifiers; the value is a bare source id or a { source, max, filter, … } object.

/* ------------------------------------------------------------------ *
 * Shared localized-UI resolver (byte-identical to the datepicker /
 * colorpicker copies; first plugin to load defines it).
 * ------------------------------------------------------------------ */
if (!window.ManifestUI) {
    window.ManifestUI = {
        _loadedSourceNames() {
            try {
                const store = window.ManifestDataStore && window.ManifestDataStore.rawDataStore;
                if (store && typeof store.keys === 'function') return [...store.keys()];
            } catch (_) { }
            return [];
        },
        resolve(component, fallbacks) {
            const merged = JSON.parse(JSON.stringify(fallbacks || {}));
            try {
                if (!window.Alpine || typeof Alpine.evaluate !== 'function') return merged;
                try { Alpine.evaluate(document.body, '$locale && $locale.current'); } catch (_) { }
                for (const name of this._loadedSourceNames()) {
                    let ui;
                    try { ui = Alpine.evaluate(document.body, `$x['${name}'] && $x['${name}']._ui && $x['${name}']._ui['${component}']`); } catch (_) { ui = null; }
                    if (ui && typeof ui === 'object' && !Array.isArray(ui)) this._deepOverlay(merged, ui);
                }
            } catch (_) { }
            return merged;
        },
        _deepOverlay(target, src) {
            for (const k of Object.keys(src)) {
                if (k.startsWith('$') || k === 'contentType' || k === 'valueOf' || k === 'toString') continue;
                const v = src[k];
                if (typeof v === 'function') continue;
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    if (!target[k] || typeof target[k] !== 'object') target[k] = {};
                    this._deepOverlay(target[k], v);
                } else if (v !== undefined && v !== null && v !== '') {
                    target[k] = v;
                }
            }
        }
    };
}

// Default English UI chrome; overridable via a data source's `_ui.combobox`.
const UI_FALLBACK = {
    empty: 'No matches',
    add: 'Add “{value}”',
    loading: 'Searching…',
    prompt: 'Type to search'
};

function initializeComboboxPlugin() {

    function ensureAlpineContext() {
        if (!document.body.hasAttribute('x-data')) document.body.setAttribute('x-data', '{}');
    }

    ensureAlpineContext();

    const rand = () => Math.random().toString(36).slice(2, 9);
    const ui = () => window.ManifestUI ? window.ManifestUI.resolve('combobox', UI_FALLBACK) : UI_FALLBACK;

    // Alpine binding attributes — never carried onto combobox-owned clones
    const isBinding = (n) => n[0] === ':' || n[0] === '@' || n.indexOf('x-') === 0;

    // Rendered-snapshot clone: strip Alpine bindings (x-/:/@) from the whole subtree —
    // they reference the source's x-for scope and would throw when Alpine walks the
    // combobox-owned copy. Computed results (style, class, text) are baked in and survive.
    function stripClone(root) {
        Array.from(root.attributes).forEach(a => { if (isBinding(a.name)) root.removeAttribute(a.name); });
        root.querySelectorAll('*').forEach(n => {
            Array.from(n.attributes).forEach(a => { if (isBinding(a.name)) n.removeAttribute(a.name); });
        });
        return root;
    }

    // Read options from a source element (datalist/select → option, menu → li)
    function readOptions(src) {
        if (!src) return [];
        if (src.tagName === 'MENU') {
            return Array.from(src.querySelectorAll('li')).map(li => {
                const copy = stripClone(li.cloneNode(true));
                // A [data-chip] element inside the row is the chip's rich content: the chip
                // shows its rendered clone, and clicks are mirrored back to this live source
                // fragment so author @click handlers run in their own x-for scope.
                const chipSrc = li.querySelector('[data-chip]');
                return {
                    value: li.dataset.value != null ? li.dataset.value : li.textContent.trim(),
                    label: li.dataset.label || li.textContent.trim(),
                    pattern: li.dataset.pattern || null,
                    locked: li.hasAttribute('data-locked'),
                    html: copy.innerHTML,
                    chip: chipSrc ? (n => ({ node: n, src: chipSrc, sig: n.outerHTML }))(stripClone(chipSrc.cloneNode(true))) : null,
                    // Author-declared chip colours (on the [data-chip] fragment or the <li>)
                    // are forwarded onto the generated chip so the WHOLE chip — background,
                    // text and × — takes the colour, not just the label.
                    chipColor: (() => {
                        const rd = (v) => (chipSrc && chipSrc.style.getPropertyValue(v).trim()) || li.style.getPropertyValue(v).trim();
                        const s = rd('--combobox-chip-surface'), c = rd('--combobox-chip-content');
                        return (s || c) ? { s, c } : null;
                    })(),
                    // Carry the row's own attributes into the option, minus combobox-managed ones.
                    attrs: Array.from(li.attributes)
                        .filter(a => { const n = a.name; return n !== 'role' && n !== 'id' && n !== 'aria-selected' && !isBinding(n); })
                        .map(a => [a.name, a.value])
                };
            });
        }
        return Array.from(src.querySelectorAll('option')).map(o => ({
            value: o.value || o.textContent.trim(),
            // o.label is the native `label` IDL prop: the `label` attribute when set, else
            // the option's text — so <option value="SE" label="Sweden"> works natively.
            label: (o.label || '').trim() || o.value,
            pattern: o.getAttribute('data-pattern') || null,
            locked: o.hasAttribute('data-locked'),
            html: null
        }));
    }

    // Capture x-model's expression and strip the attribute so Alpine never binds the
    // editor (in chips mode it's a typing buffer; we own read/write ourselves).
    function captureModel(el) {
        if (el.__cbModelExpr !== undefined) return;
        let attr = null;
        for (const a of Array.from(el.attributes)) {
            if (a.name === 'x-model' || a.name.indexOf('x-model.') === 0) { attr = a.name; break; }
        }
        el.__cbModelExpr = attr ? el.getAttribute(attr) : null;
        if (attr) el.removeAttribute(attr);
    }

    // Match by attribute-name prefix, not `[x-combobox]` — modifiers make the literal
    // attribute name (x-combobox.multiple.chips) that the CSS selector won't match.
    function isComboboxEl(el) {
        if (!el.attributes) return false;
        for (const a of el.attributes) if (a.name === 'x-combobox' || a.name.indexOf('x-combobox.') === 0) return true;
        return false;
    }
    function stripModels(root) {
        if (!root || root.nodeType !== 1) return;
        if (isComboboxEl(root)) captureModel(root);
        const all = root.getElementsByTagName ? root.getElementsByTagName('*') : [];
        for (let i = 0; i < all.length; i++) if (isComboboxEl(all[i])) captureModel(all[i]);
    }

    // Strip x-model before Alpine binds it: static DOM here (pre-walk), later-mounted
    // subtrees (x-markdown, components) via the wrapped public initTree below.
    stripModels(document.body);
    if (typeof Alpine.initTree === 'function' && !Alpine.__cbInitTreeWrapped) {
        Alpine.__cbInitTreeWrapped = true;
        const origInitTree = Alpine.initTree.bind(Alpine);
        Alpine.initTree = (node, ...rest) => { stripModels(node); return origInitTree(node, ...rest); };
    }

    Alpine.directive('combobox', (el, { modifiers, expression }, { cleanup }) => {
        captureModel(el);   // fallback for any path that bypasses the above
        // Build after the current tick so sibling sources (datalist/menu) exist.
        setTimeout(() => build(el, modifiers, expression || '', cleanup), 0);
    });

    function build(el, modifiers, expression, cleanup) {
        if (el.__mnfstCombobox) return;
        el.__mnfstCombobox = true;

        // If a mount path bypassed the strip (x-if/x-for via Alpine's internal initTree)
        // and native x-model already bound the editor, neutralize both native paths here
        // (value-sync would bleed the model in; the input listener would write typing back).
        if (el._x_model) {
            el._x_forceModelUpdate = function () { };    // kill the model→editor value-sync
            // Remove Alpine's input/change listener (a closure; overriding .set isn't enough).
            try {
                const rm = el._x_removeModelListeners;
                if (rm) Object.keys(rm).forEach(k => { try { rm[k](); } catch (_) { } });
            } catch (_) { }
            el._x_model.set = function () { };            // extra safety for any path that calls it
            if (el.value) el.value = '';
        }

        // Sweep orphaned generated menus (editor gone after a re-render, or a baked
        // prerender duplicate) — no connected editor points at them.
        document.querySelectorAll('body > menu[id^="combobox-menu-"]').forEach(m => {
            if (!document.querySelector('[aria-controls="' + m.id + '"]')) m.remove();
        });

        // ----- Prerender hydration -----
        // A prerendered page bakes in our wrapper; adopt it and re-derive the selection
        // from the baked chips (nesting a second .combobox would shrink/truncate). SPA skips.
        const adopt = el.parentElement && el.parentElement.classList.contains('combobox') ? el.parentElement : null;
        let recoveredName = null, seedSelected = null;
        if (adopt) {
            seedSelected = Array.from(adopt.querySelectorAll(':scope > .combobox-chip')).map(c => ({
                value: c.dataset.value,
                label: (c.querySelector('span') || c).textContent.trim()
            }));
            const hiddens = Array.from(adopt.querySelectorAll('input[data-cb]'));
            if (hiddens.length) {
                recoveredName = hiddens[0].getAttribute('name');
                if (!seedSelected.length) seedSelected = hiddens.map(h => ({ value: h.value, label: h.value }));
            }
            adopt.querySelectorAll('.combobox-chip, input[data-cb], [role=status]').forEach(n => n.remove());
            const bakedMenuId = el.getAttribute('aria-controls');
            // Remove the baked generated menu (id combobox-menu-…); leave the source
            // element (author's own id) in place for readOptions to re-read.
            if (bakedMenuId && bakedMenuId.indexOf('combobox-menu-') === 0) {
                const m = document.getElementById(bakedMenuId);
                if (m) m.remove();
            }
            ['aria-controls', 'aria-expanded', 'aria-activedescendant', 'aria-haspopup', 'role', 'aria-autocomplete'].forEach(a => el.removeAttribute(a));
            adopt.style.removeProperty('anchor-name');
        }

        // ----- Config: bare id string, or a { } object -----
        let cfg = {};
        const expr = expression.trim();
        if (expr.startsWith('{')) {
            try { cfg = window.Alpine.evaluate(el, expr) || {}; } catch (_) { cfg = {}; }
        } else if (expr) {
            // Template-literal ids (`${uid}-options`) are evaluated, matching x-dropdown;
            // a bare id is used as-is.
            if (expr.includes('${') || expr.includes('`')) {
                try { cfg.source = window.Alpine.evaluate(el, expr); } catch (_) { cfg.source = expr; }
            } else {
                cfg.source = expr;
            }
        }

        const editorNone = el.tagName === 'BUTTON';
        const multiple   = modifiers.includes('multiple');
        const chips      = modifiers.includes('chips');
        const strict     = modifiers.includes('strict');
        const create     = modifiers.includes('create');
        const isAsync     = modifiers.includes('async');
        const max        = parseInt(cfg.max, 10) || (multiple ? Infinity : 1);
        const filterMode = cfg.filter || 'includes';
        const minChars   = parseInt(cfg.min, 10) || 0;
        const debounceMs = parseInt(cfg.debounce, 10) || 200;
        const separators = cfg.separators != null
            ? String(cfg.separators).split('').filter(c => c.trim() || c === ' ')
            : (multiple ? [','] : []);
        const name        = el.getAttribute('name') || recoveredName;
        const placeholder = el.getAttribute('placeholder') || (editorNone ? el.textContent.trim() : '');

        // ----- Source / options -----
        const sourceId = cfg.source ? String(cfg.source).replace(/^#/, '') : null;
        const src = sourceId ? document.getElementById(sourceId) : null;

        // A named source that isn't in the DOM yet (it renders after us — a later sibling,
        // an x-if branch, an async component) would otherwise leave the field menu-less and
        // unable to resolve labels forever. Nothing is mutated before this point, so wait
        // for it and cleanly re-enter build(). A MutationObserver fires the instant the
        // source mounts (immune to setTimeout throttling under page-load congestion); a
        // ~5s timeout falls back to a source-less field if it never appears.
        if (sourceId && !src && !isAsync && !el.__cbSourceGaveUp) {
            el.__mnfstCombobox = false;
            if (!el.__cbSourceObs) {
                const rebuild = (gaveUp) => {
                    if (!el.__cbSourceObs) return;
                    el.__cbSourceObs.disconnect();
                    el.__cbSourceObs = null;
                    clearTimeout(el.__cbSourceTO);
                    if (gaveUp) el.__cbSourceGaveUp = true;
                    build(el, modifiers, expression, cleanup);
                };
                el.__cbSourceObs = new MutationObserver(() => { if (document.getElementById(sourceId)) rebuild(false); });
                el.__cbSourceObs.observe(document.documentElement, { childList: true, subtree: true });
                el.__cbSourceTO = setTimeout(() => rebuild(true), 5000);
                if (cleanup) cleanup(() => { if (el.__cbSourceObs) { el.__cbSourceObs.disconnect(); el.__cbSourceObs = null; } clearTimeout(el.__cbSourceTO); });
            }
            return;
        }

        let options = readOptions(src);
        const hasMenu = !!src || isAsync;
        if (editorNone && !hasMenu) return;     // a button trigger needs a list

        // ----- Shell -----
        let wrap;
        if (adopt) {
            wrap = adopt;   // reuse the baked field (its author max-width is preserved)
        } else {
            wrap = document.createElement('div');
            wrap.className = 'combobox';
            el.parentNode.insertBefore(wrap, el);
            wrap.appendChild(el);
            // The wrapper is the field, so move the author's inline sizing onto it.
            const authorStyle = el.getAttribute('style');
            if (authorStyle) { wrap.setAttribute('style', authorStyle); el.removeAttribute('style'); }
        }
        el.setAttribute('autocomplete', 'off');
        if (!editorNone) el.removeAttribute('placeholder');
        if (name) el.removeAttribute('name');   // hidden inputs carry the value(s)

        // A wrapping <label> with no `for` targets its FIRST labelable descendant —
        // that's the first chip's remove button, not the editor. Hovering the label then
        // hover-lights that ×, and clicking the label (or a chip's text) activates it,
        // deleting chips. Bind the label to the editor explicitly; clicks on interactive
        // chip content (the ×, or any links/handlers) still land on it, not the label.
        const ownerLabel = wrap.closest('label');
        if (ownerLabel && !ownerLabel.hasAttribute('for')) {
            if (!el.id) el.id = 'combobox-editor-' + rand();
            ownerLabel.setAttribute('for', el.id);
        }

        // Live region for add/remove announcements
        const live = document.createElement('span');
        live.setAttribute('role', 'status');
        wrap.appendChild(live);
        const announce = (m) => { live.textContent = ''; live.textContent = m; };

        // ----- Selection model -----
        let selected = adopt && seedSelected ? seedSelected : [];
        const isSelected = (v) => selected.some(s => String(s.value).toLowerCase() === String(v).toLowerCase());
        const atCap = () => multiple && selected.length >= max;
        const labelFor = (v) => {
            const o = options.find(o => String(o.value).toLowerCase() === String(v).toLowerCase());
            return o ? o.label : String(v);
        };

        // ----- Locked values (non-removable chips) -----
        // From a `locked: [...]` config list (reactive below) and/or per-option
        // `data-locked`. Locked chips hide their × and refuse removal.
        const lockedFromOptions = options.filter(o => o.locked).map(o => String(o.value).toLowerCase());
        const computeLocked = (cfgObj) => {
            const set = new Set(lockedFromOptions);
            const raw = cfgObj && cfgObj.locked != null ? cfgObj.locked : cfg.locked;
            const list = Array.isArray(raw) ? raw : (raw != null ? String(raw).split(',') : []);
            list.forEach(v => set.add(String(v).trim().toLowerCase()));
            return set;
        };
        let lockedSet = computeLocked();
        const isLocked = (v) => lockedSet.has(String(v).toLowerCase());

        // ----- Reactive model (x-model), owned here -----
        // Preserve the author's shape (array or CSV; array default for .multiple). Chips
        // show labels, the model carries values. Read/effect/set wired near mount.
        const modelExpr = el.__cbModelExpr || null;
        let modelArrayShape = null;     // null until first read; true = array, false = CSV
        let modelSet = null;
        const modelToValues = (v) => {
            if (v == null || v === '') return [];
            if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object' && x.value != null) ? x.value : x).map(String);
            if (typeof v === 'string') return v.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
            return [String(v)];
        };
        const sameList = (a, b) => a.length === b.length && a.every((x, i) => String(x).toLowerCase() === String(b[i]).toLowerCase());
        function syncOut() { if (modelSet) modelSet(selected.map(s => s.value)); }

        // ----- Menu -----
        let menu = null, generatedMenu = null, optionEls = [], createEl = null, emptyEl = null, activeIndex = -1;

        function makeOption(o, i) {
            const li = document.createElement('li');
            if (o.attrs) o.attrs.forEach(([n, v]) => { try { li.setAttribute(n, v); } catch (_) { } });
            li.id = menu.id + '-opt-' + i;
            li.dataset.value = o.value;
            li.dataset.label = o.label;
            if (o.pattern) li.dataset.pattern = o.pattern;
            if (o.html) li.innerHTML = o.html; else li.textContent = o.label;
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', isSelected(o.value) ? 'true' : 'false');
            return li;
        }
        function setOptions(opts) {
            optionEls.forEach(li => li.remove());
            optionEls = opts.map((o, i) => {
                const li = makeOption(o, i);
                menu.insertBefore(li, createEl || emptyEl);
                return li;
            });
            activeIndex = -1;
        }

        if (hasMenu) {
            // Always render into a generated menu, even for an authored <menu>: the source
            // stays a data layer x-for/$x can own (reread below mirrors it), the combobox
            // owns the listbox. readOptions keeps each row's innerHTML, preserving markup.
            menu = document.createElement('menu');
            menu.setAttribute('x-ignore', '');  // plugin-owned rows — Alpine must never walk them
            // An authored <menu> source is the data layer; its presentation belongs to the
            // rendered copy. Mirror the author's class and data-*/aria-* onto it — live, so
            // bound values (:class, :aria-label="$x…") keep applying as state changes:
            // Alpine writes the computed attribute onto the source, the observer relays it.
            if (src && src.tagName === 'MENU') {
                const carries = (n) => n === 'class' || (n.indexOf('data-') === 0 && n !== 'data-kbd') || (n.indexOf('aria-') === 0 && n !== 'aria-multiselectable');
                const mirrorMenuAttrs = () => {
                    Array.from(menu.attributes).forEach(a => { if (carries(a.name) && !src.hasAttribute(a.name)) menu.removeAttribute(a.name); });
                    Array.from(src.attributes).forEach(a => { if (carries(a.name)) menu.setAttribute(a.name, a.value); });
                };
                mirrorMenuAttrs();
                const menuAttrObserver = new MutationObserver(mirrorMenuAttrs);
                menuAttrObserver.observe(src, { attributes: true });
                if (cleanup) cleanup(() => menuAttrObserver.disconnect());
            }
            // Nearest popover host, so an outer auto popover isn't light-dismissed
            // by listbox clicks; body otherwise (out of overflow contexts either way).
            (el.closest('[popover]') || document.body).appendChild(menu);
            generatedMenu = menu;               // tracked so cleanup() can remove it on re-render
            if (src) src.style.setProperty('display', 'none', 'important');
            menu.setAttribute('popover', 'manual');
            menu.id = 'combobox-menu-' + rand();
            menu.setAttribute('role', 'listbox');
            if (multiple) menu.setAttribute('aria-multiselectable', 'true');

            if (create) {
                createEl = document.createElement('li');
                createEl.className = 'combobox-create';
                createEl.setAttribute('role', 'option');
                createEl.hidden = true;
                menu.appendChild(createEl);
            }
            emptyEl = document.createElement('div');
            emptyEl.className = 'combobox-empty';
            emptyEl.hidden = true;
            menu.appendChild(emptyEl);

            setOptions(options);

            const anchorName = '--combobox-' + rand();
            wrap.style.setProperty('anchor-name', anchorName);
            menu.style.setProperty('position-anchor', anchorName);

            el.setAttribute('aria-controls', menu.id);
            el.setAttribute('aria-expanded', 'false');
            if (editorNone) {
                el.setAttribute('aria-haspopup', 'listbox');
            } else {
                el.setAttribute('role', 'combobox');
                el.setAttribute('aria-autocomplete', 'list');
            }

            menu.addEventListener('mousedown', (e) => e.preventDefault());
            menu.addEventListener('click', (e) => {
                const li = e.target.closest('li');
                if (li && !li.hidden) selectOption(li);
            });
            // Moving the mouse over the list hands the highlight back to :hover, so
            // the keyboard's active-descendant background doesn't linger on an option.
            menu.addEventListener('pointermove', () => menu.removeAttribute('data-kbd'));
        }

        function openMenu() {
            if (!menu || menu.matches(':popover-open') || atCap()) return;
            menu.style.minWidth = wrap.offsetWidth + 'px';
            menu.showPopover();
            el.setAttribute('aria-expanded', 'true');
        }
        function closeMenu() {
            if (!menu || !menu.matches(':popover-open')) return;
            menu.hidePopover();
            el.setAttribute('aria-expanded', 'false');
            setActive(-1);
        }
        function showEmpty(text) {
            if (emptyEl) { emptyEl.textContent = text; emptyEl.hidden = false; }
            setActive(-1);
        }

        function setActive(i) {
            optionEls.forEach(li => li.removeAttribute('aria-current'));
            if (createEl) createEl.removeAttribute('aria-current');
            activeIndex = i;
            const li = liAt(i);
            if (li) { li.setAttribute('aria-current', 'true'); el.setAttribute('aria-activedescendant', li.id); }
            else el.removeAttribute('aria-activedescendant');
        }
        function liAt(i) {
            if (i === -2) return createEl && !createEl.hidden ? createEl : null;
            return optionEls[i] || null;
        }
        function visibleIndexes() {
            const v = optionEls.map((li, i) => (!li.hidden ? i : -1)).filter(i => i >= 0);
            if (createEl && !createEl.hidden) v.push(-2);
            return v;
        }
        function moveActive(dir) {
            const vis = visibleIndexes();
            if (!vis.length) return;
            if (menu) menu.setAttribute('data-kbd', '');   // keyboard now drives the highlight
            let pos = vis.indexOf(activeIndex);
            pos = (pos + dir + vis.length) % vis.length;
            setActive(vis[pos]);
        }

        function testPattern(p, input) {
            try { return new RegExp(p, 'i').test(input); } catch { return false; }
        }

        function filter() {
            if (!menu) return;
            const raw = (el.value || '').trim();
            const q = raw.toLowerCase();
            let first = -1, anyVisible = false, exact = false;
            optionEls.forEach((li, i) => {
                const t = String(li.dataset.label).toLowerCase();
                let show =
                    isAsync || editorNone || !q || filterMode === 'none' ? true
                    : filterMode === 'startswith' ? t.startsWith(q)
                    : filterMode === 'pattern' ? (li.dataset.pattern ? testPattern(li.dataset.pattern, raw) : t.includes(q))
                    : t.includes(q);
                if (show && multiple && isSelected(li.dataset.value)) show = false;
                li.hidden = !show;
                if (show) { anyVisible = true; if (first < 0) first = i; }
                if (t === q) exact = true;
            });
            if (createEl) {
                const show = create && q && !exact;
                createEl.hidden = !show;
                createEl.textContent = show ? ui().add.replace('{value}', raw) : '';
                createEl.dataset.value = raw;
                if (show) anyVisible = true;
            }
            if (emptyEl) { emptyEl.textContent = ui().empty; emptyEl.hidden = anyVisible; }
            setActive(first >= 0 ? first : (createEl && !createEl.hidden ? -2 : -1));
        }

        // Show the whole list (single field re-opened on a committed value, so the
        // choice can be swapped — its current value shouldn't narrow the list to itself).
        function showAll() {
            optionEls.forEach(li => { li.hidden = false; });
            if (createEl) createEl.hidden = true;
            if (emptyEl) emptyEl.hidden = optionEls.length > 0;
            const sel = optionEls.findIndex(li => isSelected(li.dataset.value));
            setActive(sel >= 0 ? sel : (optionEls.length ? 0 : -1));
        }

        // ----- Async option fetching (Open UI's beforefilter analog) -----
        let asyncTimer, asyncSeq = 0;
        function scheduleAsync() {
            openMenu();
            clearTimeout(asyncTimer);
            setOptions([]);                 // drop stale results so nothing flashes
            showEmpty(ui().loading);
            asyncTimer = setTimeout(runAsync, debounceMs);
        }
        function runAsync() {
            const seq = ++asyncSeq;
            const value = (el.value || '').trim();
            el.dispatchEvent(new CustomEvent('combobox-filter', {
                bubbles: true,
                detail: {
                    value,
                    setOptions: (opts) => {
                        if (seq !== asyncSeq) return;       // ignore stale responses
                        options = (opts || []).map(o => typeof o === 'string' ? { value: o, label: o } : o);
                        setOptions(options);
                        filter();
                    }
                }
            }));
        }
        // Async: open and either fetch or prompt, depending on the typed length.
        function asyncRefresh() {
            openMenu();
            if ((el.value || '').trim().length >= minChars) scheduleAsync();
            else { setOptions([]); showEmpty(ui().prompt); }
        }

        function commitText(raw) {
            raw = (raw || '').trim();
            if (!raw) return false;
            if (strict) {
                const o = options.find(o => o.label.toLowerCase() === raw.toLowerCase());
                if (!o) return false;
                addValue(o.value, o.label);
            } else {
                addValue(raw, raw);
            }
            if (chips || multiple) el.value = '';
            if (menu && !isAsync) filter();
            return true;
        }

        function selectOption(li) {
            if (li === createEl) { commitText(li.dataset.value); return refocus(); }
            addValue(li.dataset.value, li.dataset.label);
            if (!editorNone && (chips || multiple)) el.value = '';
            if (!multiple) closeMenu(); else filter();
            refocus();
        }
        // refocus keeps the caret in the field after a pick. Suppress the focus
        // handler's auto-open for that one tick so a selection doesn't reopen the list.
        let suppressOpen = false;
        function refocus() { suppressOpen = true; el.focus(); setTimeout(() => { suppressOpen = false; }, 0); }

        // The model is written ONLY on explicit user selection; commits also fire a DOM
        // change event so apps can save on events instead of watching the model.
        // `dirty` = the user actually edited the text since focus — gates Enter's
        // free-text commit so a stray Enter on an untouched field can't re-commit the
        // display label (or, with the menu open, an auto-highlighted option) as a value.
        let dirty = false;
        let seeding = false;   // init-time seeding is not a user commit — no change event
        const fireChange = () => { if (!seeding) el.dispatchEvent(new Event('change', { bubbles: true })); };

        function addValue(value, label) {
            if (!multiple) {
                const same = selected[0] && String(selected[0].value) === String(value);
                selected = [{ value, label }];
                render();
                dirty = false;
                if (!same) { syncOut(); fireChange(); announce(label + ' selected'); }
                return;
            }
            if (isSelected(value)) return;
            if (selected.length >= max) { announce('Maximum of ' + max + ' reached'); return; }
            selected.push({ value, label });
            render();
            dirty = false;
            syncOut();
            fireChange();
            announce(label + ' added');
        }
        function removeValue(value) {
            if (isLocked(value)) return;     // locked chips stay put
            const i = selected.findIndex(s => String(s.value).toLowerCase() === String(value).toLowerCase());
            if (i < 0) return;
            const [g] = selected.splice(i, 1);
            render();
            syncOut();
            fireChange();
            announce(g.label + ' removed');
            if (menu && !isAsync) filter();
            refocus();
        }

        function makeChip(s) {
            const chip = document.createElement('span');
            chip.className = 'combobox-chip';
            chip.dataset.value = s.value;
            const label = document.createElement('span');
            setChipContent(label, s);
            chip.appendChild(label);
            applyLock(chip, s.value, s.label);
            applyChipColor(chip, s);
            return chip;
        }
        // Forward an option's author-declared chip colours onto the whole chip so the
        // background, text and × all take the tag colour. Set/clear so a reactive colour
        // change (via reread) tracks. Values are author-provided — never computed here.
        function applyChipColor(chip, s) {
            const o = options.find(o => String(o.value).toLowerCase() === String(s.value).toLowerCase());
            const c = o && o.chipColor;
            if (c && c.s) chip.style.setProperty('--combobox-chip-surface', c.s); else chip.style.removeProperty('--combobox-chip-surface');
            if (c && c.c) chip.style.setProperty('--combobox-chip-content', c.c); else chip.style.removeProperty('--combobox-chip-content');
        }
        // Chip content: the option's [data-chip] fragment when present (rendered clone,
        // refreshed in place on reread — updating innerHTML never re-inserts the chip
        // node, so the WebKit focused-insert collapse can't trigger), else the text
        // label. Links in the clone navigate natively (computed href carries); other
        // clicks are mirrored onto the same element in the LIVE source fragment, where
        // the author's @click runs in its own x-for scope.
        function setChipContent(span, s) {
            const o = options.find(o => String(o.value).toLowerCase() === String(s.value).toLowerCase());
            const rich = o && o.chip;
            const sig = rich ? o.chip.sig : 't:' + s.label;
            if (span.__cbSig === sig) return;
            span.__cbSig = sig;
            if (!rich) { span.textContent = s.label; span.__cbSrc = null; return; }
            span.innerHTML = '';
            span.appendChild(o.chip.node.cloneNode(true));
            span.__cbSrc = o.chip.src;
            if (span.__cbDelegated) return;
            span.__cbDelegated = true;
            span.addEventListener('click', (e) => {
                const srcRoot = span.__cbSrc;
                if (!srcRoot || !srcRoot.isConnected) return;
                if (e.target.closest && e.target.closest('a[href]')) return;   // native nav owns it
                const cloneRoot = span.firstElementChild;
                let n = e.target === span ? cloneRoot : e.target;
                const path = [];
                while (n && n !== cloneRoot) {
                    const p = n.parentElement;
                    if (!p) return;
                    path.unshift(Array.prototype.indexOf.call(p.children, n));
                    n = p;
                }
                let t = srcRoot;
                for (const i of path) { t = t.children[i]; if (!t) return; }
                t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            });
        }
        // Add/drop the × to match locked state. Re-run from render() so a reactive
        // `locked` change toggles existing chips too.
        function applyLock(chip, value, label) {
            const locked = isLocked(value);
            chip.toggleAttribute('data-locked', locked);
            const btn = chip.querySelector(':scope > button');
            if (locked) { if (btn) btn.remove(); return; }
            if (btn) return;
            const x = document.createElement('button');
            x.type = 'button';
            x.setAttribute('aria-label', 'Remove ' + (label || (chip.querySelector(':scope > span') || {}).textContent || value));
            x.textContent = '×';
            x.addEventListener('click', () => removeValue(value));
            chip.appendChild(x);
        }
        function hidden(value) {
            const h = document.createElement('input');
            h.type = 'hidden';
            h.name = name;
            h.value = value;
            h.setAttribute('data-cb', '');
            return h;
        }

        function render() {
            if (chips) {
                // Incremental: keep existing chip nodes, add/drop/refresh only. Recreating
                // all re-inserts next to the focused editor, collapsing them in WebKit.
                const norm = v => String(v).toLowerCase();
                const have = new Map();
                wrap.querySelectorAll('.combobox-chip').forEach(c => have.set(norm(c.dataset.value), c));
                const want = selected.map(s => norm(s.value));
                const wantSet = new Set(want);
                have.forEach((node, key) => { if (!wantSet.has(key)) { node.remove(); have.delete(key); } });
                selected.forEach(s => {
                    const key = norm(s.value);
                    const node = have.get(key);
                    if (!node) { const n = makeChip(s); have.set(key, n); wrap.insertBefore(n, el); }
                    else {
                        applyLock(node, s.value, s.label);
                        applyChipColor(node, s);
                        const sp = node.querySelector(':scope > span');
                        if (sp) setChipContent(sp, s);   // in-place refresh; node identity kept
                    }
                });
                // Reorder only when order differs — needless re-insertion collapses chips
                // in WebKit; the common append path (order matches) skips this.
                const cur = Array.from(wrap.querySelectorAll('.combobox-chip')).map(c => norm(c.dataset.value));
                if (!sameList(cur, want)) selected.forEach(s => wrap.insertBefore(have.get(norm(s.value)), el));
                // Hidden inputs are type=hidden (no layout), so a clean rebuild is harmless.
                wrap.querySelectorAll('input[data-cb]').forEach(n => n.remove());
                if (name) selected.forEach(s => wrap.appendChild(hidden(s.value)));
                if (!editorNone) el.placeholder = selected.length ? '' : placeholder;
            } else if (!multiple) {
                wrap.querySelectorAll('.combobox-chip, input[data-cb]').forEach(n => n.remove());
                if (editorNone) el.textContent = selected[0] ? selected[0].label : placeholder;
                else { el.value = selected[0] ? selected[0].label : ''; el.placeholder = placeholder; }
                if (name && selected[0]) wrap.appendChild(hidden(selected[0].value));
            }
            optionEls.forEach(li => li.setAttribute('aria-selected', isSelected(li.dataset.value) ? 'true' : 'false'));
            // At cap: drop the input affordance entirely; a removed chip restores it.
            el.hidden = atCap();
            if (el.hidden) closeMenu();
        }

        // Pull separator-terminated tokens out of the field into chips, leaving the
        // trailing partial. Reading the value (not keydown) dodges the insert race and covers paste.
        function extractTokens() {
            if (!separators.length) return;
            const val = el.value;
            if (!val || ![...val].some(ch => separators.includes(ch))) return;
            const parts = []; let buf = '';
            for (const ch of val) {
                if (separators.includes(ch)) { parts.push(buf); buf = ''; }
                else buf += ch;
            }
            el.value = '';
            parts.forEach(p => commitText(p));
            el.value = buf;
        }

        // Open for fresh entry. A committed single value shows the full list (swappable);
        // selectText (keyboard focus) also selects it to type over.
        function openForEntry(selectText) {
            if (menu) menu.removeAttribute('data-kbd');   // opening is mouse-mode until a key drives it
            const committed = !multiple && selected.length && el.value === selected[0].label;
            if (committed && selectText) el.select();
            if (isAsync) {
                if (committed) { openMenu(); setOptions([]); showEmpty(ui().prompt); }
                else asyncRefresh();
            } else {
                openMenu();
                if (committed) showAll(); else filter();
            }
        }

        // ----- Events -----
        if (editorNone) {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                if (menu.matches(':popover-open')) closeMenu();
                else { menu.removeAttribute('data-kbd'); openMenu(); filter(); }
            });
            el.addEventListener('keydown', (e) => {
                const open = menu.matches(':popover-open');
                if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
                    e.preventDefault(); menu.setAttribute('data-kbd', ''); openMenu(); filter(); return;
                }
                if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
                else if (e.key === 'Enter' || e.key === ' ') {
                    if (!e.repeat && menu.hasAttribute('data-kbd') && (activeIndex >= 0 || activeIndex === -2)) { e.preventDefault(); selectOption(liAt(activeIndex)); }
                }
                else if (e.key === 'Escape') { if (open) { e.preventDefault(); closeMenu(); } }
            });
        } else {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown' && menu) { e.preventDefault(); openMenu(); moveActive(1); }
                else if (e.key === 'ArrowUp' && menu) { e.preventDefault(); moveActive(-1); }
                else if (e.key === 'Enter') {
                    // Commit only on deliberate action: an option needs a keyboard-driven
                    // highlight (data-kbd — arrows or typing), free text needs an actual
                    // edit since focus (dirty). A stray Enter on an untouched field — key
                    // repeat, form submit, saving the record — must never write the model.
                    if (e.repeat) return;
                    if (menu && menu.matches(':popover-open') && menu.hasAttribute('data-kbd') && (activeIndex >= 0 || activeIndex === -2)) {
                        e.preventDefault();
                        selectOption(liAt(activeIndex));
                    } else if ((!strict || !menu) && dirty) {
                        if (commitText(el.value)) e.preventDefault();
                    }
                }
                else if (e.key === 'Escape') { if (menu && menu.matches(':popover-open')) { e.preventDefault(); closeMenu(); } }
                else if (e.key === 'Backspace' && el.value === '' && chips && selected.length) {
                    removeValue(selected[selected.length - 1].value);
                }
            });

            // Separators (and paste) commit from here, the moment one lands in the value.
            el.addEventListener('input', () => {
                dirty = true;
                if (menu) menu.setAttribute('data-kbd', '');   // typing drives the highlight onto the first match
                extractTokens();
                if (isAsync) asyncRefresh(); else { openMenu(); filter(); }
            });

            el.addEventListener('focus', () => { dirty = false; if (!suppressOpen) openForEntry(true); });
            // Reopen on click even when the field is already focused (focus won't re-fire).
            el.addEventListener('mousedown', () => { if (menu && !menu.matches(':popover-open') && !suppressOpen) openForEntry(false); });
        }

        // Close when focus leaves the field entirely (Tab away). A committed single
        // field also snaps its display back to the selection's label — abandoned typing
        // never commits, and the model is left untouched.
        el.addEventListener('blur', () => setTimeout(() => {
            if (wrap.contains(document.activeElement) || (menu && menu.contains(document.activeElement))) return;
            closeMenu();
            if (!multiple && !chips && !editorNone && selected[0] && el.value !== selected[0].label) {
                el.value = selected[0].label;
                dirty = false;
            }
        }, 0));

        // Click empty shell → focus the trigger
        wrap.addEventListener('mousedown', (e) => {
            if (e.target === wrap) { e.preventDefault(); refocus(); }
        });

        // Outside dismiss (manual popover); self-removes when the menu leaves the DOM.
        if (menu && !menu.__mnfstCbDismiss) {
            menu.__mnfstCbDismiss = true;
            const onDocPointer = (e) => {
                if (!menu.isConnected) { document.removeEventListener('pointerdown', onDocPointer); return; }
                if (menu.matches(':popover-open') && !menu.contains(e.target) && !wrap.contains(e.target)) closeMenu();
            };
            document.addEventListener('pointerdown', onDocPointer);
            if (cleanup) cleanup(() => document.removeEventListener('pointerdown', onDocPointer));
        }
        // The generated menu lives in <body>; remove it on teardown so it doesn't orphan
        // as a stale duplicate. Authored/adopted menus go with their container.
        if (cleanup && generatedMenu) cleanup(() => { if (generatedMenu.isConnected) generatedMenu.remove(); });

        // ----- Reactive model (x-model) -----
        // Render chips from the bound value on init and external change; write back on
        // add/remove. Read inside an Alpine effect so $x / nested state stay reactive.
        if (modelExpr) {
            const read = Alpine.evaluateLater(el, modelExpr);
            modelSet = (vals) => {
                const out = !multiple ? (vals.length ? vals[0] : '')
                    : (modelArrayShape === false ? vals.join(',') : vals.slice());
                try { Alpine.evaluate(el, `${modelExpr} = ${JSON.stringify(out)}`); } catch (_) { }
            };
            Alpine.effect(() => {
                read(raw => {
                    if (modelArrayShape === null && raw != null && raw !== '') modelArrayShape = Array.isArray(raw);
                    const incoming = modelToValues(raw);
                    if (sameList(incoming, selected.map(s => s.value))) return;   // unchanged / our own write-back
                    selected = incoming.map(v => ({ value: v, label: labelFor(v) }));
                    if (!multiple && selected.length > 1) selected = selected.slice(-1);
                    render();
                });
            });
        }

        // ----- Reactive locked list (config-object form, so `locked` can gate on state) -----
        if (expr.startsWith('{')) {
            Alpine.effect(() => {
                let c; try { c = Alpine.evaluate(el, expr); } catch (_) { return; }
                const next = computeLocked(c && typeof c === 'object' && !Array.isArray(c) ? c : null);
                if (next.size === lockedSet.size && [...next].every(v => lockedSet.has(v))) return;
                lockedSet = next;
                render();
            });
        }

        // ----- Dynamic options: re-read when x-for / $x fills the source after build,
        //        keeping the menu, chip labels, and data-locked flags current. -----
        if (src) {
            const reread = () => {
                options = readOptions(src);
                lockedFromOptions.length = 0;
                options.filter(o => o.locked).forEach(o => lockedFromOptions.push(String(o.value).toLowerCase()));
                lockedSet = computeLocked();
                selected = selected.map(s => ({ value: s.value, label: labelFor(s.value) }));
                setOptions(options);
                render();
                // Keep an open list (and its empty-state) correct after the source changes.
                if (menu && menu.matches(':popover-open')) filter();
            };
            const mo = new MutationObserver(reread);
            // childList/characterData: x-for row edits. attributes unfiltered: ANY bound
            // attribute inside a row (style, class, data-*) changes the rendered snapshot
            // the menu and rich chips clone, so all must re-trigger. Mutations coalesce
            // per microtask, so a state flush costs one reread.
            mo.observe(src, { childList: true, subtree: true, characterData: true, attributes: true });
            if (cleanup) cleanup(() => mo.disconnect());
        }

        // ----- Seed the initial value from the value attribute — only when there's no
        //        x-model (it wins). Chips split on separators; a SINGLE field takes the
        //        whole value and resolves it to its label (async options fill in via the
        //        reread). Seeding never writes the model or fires change. -----
        if (!modelExpr && !editorNone && el.value) {
            seeding = true;
            if (chips) {
                // Fresh only — an adopted (prerendered) wrapper already recovered its chips.
                if (!adopt) {
                    const seeds = el.value.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
                    el.value = '';
                    seeds.forEach(s => commitText(s));
                }
            } else if (!multiple) {
                // Runs fresh AND on hydration: el.value is the value attribute either way,
                // so a single field re-derives its selection even in an adopted wrapper.
                addValue(el.value.trim(), labelFor(el.value.trim()));
            }
            seeding = false;
        }
        // In chips/multiple the editor is a typing buffer. Clear value AND remove the
        // attribute: mnfst-render serializes the attribute, so leaving it bakes seed text
        // into the prerendered editor (shows as inline text on hydration in Safari).
        if ((chips || multiple) && !editorNone) { el.value = ''; el.removeAttribute('value'); }
        render();
    }
}

// ----- Boot (mirrors the dropdowns plugin lifecycle) -----
let comboboxPluginInitialized = false;
let alpineHasWalked = false;
document.addEventListener('alpine:initialized', () => { alpineHasWalked = true; });

function ensureComboboxPluginInitialized() {
    if (comboboxPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;
    comboboxPluginInitialized = true;
    initializeComboboxPlugin();
    if (alpineHasWalked && typeof window.Alpine.initTree === 'function') {
        document.querySelectorAll('[x-combobox]').forEach(el => { if (!el._x_dataStack) window.Alpine.initTree(el); });
    }
}
window.ensureComboboxPluginInitialized = ensureComboboxPluginInitialized;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureComboboxPluginInitialized);
document.addEventListener('alpine:init', ensureComboboxPluginInitialized);
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureComboboxPluginInitialized, 0);
} else {
    const t = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') { clearInterval(t); ensureComboboxPluginInitialized(); }
    }, 10);
    setTimeout(() => clearInterval(t), 5000);
}

})();
