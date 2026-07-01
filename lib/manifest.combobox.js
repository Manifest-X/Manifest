/* Manifest Combobox */

(function () {

// A select-like field with four orthogonal axes:
//   trigger: input (default) | textarea | button (editor:none, click only)
//   options: none (free entry) | datalist/select (generated menu) | menu (authored) | async
//   value:   single (default) | multiple (+ max cap)
//   display: text (default) | chips
//
// Config is the directive value: a bare id string (the options source, like
// x-dropdown) or a { source, max, filter, separators, min, debounce } object.
// Modes are modifiers. The dropdown reuses Manifest's menu[popover] styles.

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

    // Read options from a source element (datalist/select → option, menu → li)
    function readOptions(src) {
        if (!src) return [];
        if (src.tagName === 'MENU') {
            return Array.from(src.querySelectorAll('li')).map(li => ({
                value: li.dataset.value != null ? li.dataset.value : li.textContent.trim(),
                label: li.dataset.label || li.textContent.trim(),
                pattern: li.dataset.pattern || null,
                locked: li.hasAttribute('data-locked'),
                html: li.innerHTML,
                // Carry the authored row's own attributes (class, style, title, data-*) into
                // the rendered option, minus the ones the combobox manages and Alpine's
                // bindings (x-/:/@ — those reference the source's x-for scope, not the clone).
                attrs: Array.from(li.attributes)
                    .filter(a => { const n = a.name; return n !== 'role' && n !== 'id' && n !== 'aria-selected' && n[0] !== ':' && n[0] !== '@' && n.indexOf('x-') !== 0; })
                    .map(a => [a.name, a.value])
            }));
        }
        return Array.from(src.querySelectorAll('option')).map(o => ({
            value: o.value || o.textContent.trim(),
            label: o.textContent.trim() || o.value,
            pattern: o.getAttribute('data-pattern') || null,
            locked: o.hasAttribute('data-locked'),
            html: null
        }));
    }

    // Take ownership of x-model: capture the expression and strip the attribute so
    // Alpine's own model directive never binds the editor. In chips mode the editor is
    // a transient typing buffer — Alpine's x-model would dump the bound array into it
    // and write partial typing back to the model. We read/write the model ourselves.
    function captureModel(el) {
        if (el.__cbModelExpr !== undefined) return;
        let attr = null;
        for (const a of Array.from(el.attributes)) {
            if (a.name === 'x-model' || a.name.indexOf('x-model.') === 0) { attr = a.name; break; }
        }
        el.__cbModelExpr = attr ? el.getAttribute(attr) : null;
        if (attr) el.removeAttribute(attr);
    }

    // NB: match by attribute-name prefix, not the `[x-combobox]` CSS selector — the
    // directive is almost always written with modifiers (x-combobox.multiple.chips),
    // a literal attribute name that `[x-combobox]` does NOT match.
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

    // Strip x-model before Alpine ever binds it. The initial static DOM is handled here
    // (this runs on alpine:init, before the walk); subtrees mounted later — x-markdown,
    // components — are handled by wrapping the public initTree they call to mount, so the
    // attribute is gone before Alpine's model directive looks for it.
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

        // If a mount path bypassed the pre-emptive strip (x-if / x-for mount via Alpine's
        // INTERNAL initTree, which our public-initTree wrapper can't see) and Alpine's
        // native x-model already bound the editor, neutralize it here. Otherwise its
        // value-sync would bleed the raw model into the editor ("a,b") and its input
        // listener would write partial typing back to the model. We own read/write below,
        // so make both native paths no-ops. captureModel still recovered the expression.
        if (el._x_model) {
            el._x_forceModelUpdate = function () { };    // kill the model→editor value-sync (no bleed)
            // Remove Alpine's input/change listener that writes the editor back to the model
            // (a local closure — overriding _x_model.set isn't enough). _x_removeModelListeners
            // is Alpine's own removal hook for exactly this.
            try {
                const rm = el._x_removeModelListeners;
                if (rm) Object.keys(rm).forEach(k => { try { rm[k](); } catch (_) { } });
            } catch (_) { }
            el._x_model.set = function () { };            // extra safety for any path that calls it
            if (el.value) el.value = '';
        }

        // Sweep generated menus left orphaned by a prior render — their controlling
        // editor is gone (a SPA x-markdown re-render) or never hydrated (duplicates
        // an old prerender baked into <body>). Either way, no connected editor points
        // at them, so they can only sit as stale, sometimes-open duplicates.
        document.querySelectorAll('body > menu[id^="combobox-menu-"]').forEach(m => {
            if (!document.querySelector('[aria-controls="' + m.id + '"]')) m.remove();
        });

        // ----- Prerender hydration -----
        // A prerendered page bakes in the wrapper this plugin generated. On load we
        // adopt that wrapper and re-derive the selection from the baked chips, rather
        // than nesting a second .combobox inside it (which shrinks the field and
        // truncates the chips). A fresh SPA run has no such wrapper and skips this.
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
            // Remove the baked generated menu (its id is always combobox-menu-…); the
            // source element (datalist or authored <menu>, carrying the author's own id)
            // is the data layer and is left in place for readOptions to re-read.
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
            cfg.source = expr;
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
            // The wrapper IS the field, so move the author's sizing (inline style) onto
            // it. Otherwise the editor/button is constrained inside a full-width field.
            const authorStyle = el.getAttribute('style');
            if (authorStyle) { wrap.setAttribute('style', authorStyle); el.removeAttribute('style'); }
        }
        el.setAttribute('autocomplete', 'off');
        if (!editorNone) el.removeAttribute('placeholder');
        if (name) el.removeAttribute('name');   // hidden inputs carry the value(s)

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
        // From a `locked: [...]` config list (re-evaluated reactively below) and/or a
        // `data-locked` flag on individual options. Locked chips keep their × hidden and
        // refuse removal while staying selected.
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

        // ----- Reactive model (x-model) — captured + stripped pre-walk, owned here -----
        // The bound value may be a token array or a CSV string; we preserve whichever the
        // author used (default array for .multiple). Chips render labels; the model carries
        // values/tokens. Read/effect/set are wired near mount, once render() exists.
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
            // Always render into a generated menu — even when the source is an authored
            // <menu>. The source stays a pure data layer so x-for / $x can own its <li>
            // freely (the reread below mirrors changes into the generated list), while the
            // combobox owns the listbox it shows and the option lifecycle. readOptions
            // captures each row's innerHTML, so authored rich markup is preserved.
            menu = document.createElement('menu');
            document.body.appendChild(menu);   // anchor positioning needs it out of overflow contexts
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

        function addValue(value, label) {
            if (!multiple) { selected = [{ value, label }]; render(); syncOut(); announce(label + ' selected'); return; }
            if (isSelected(value)) return;
            if (selected.length >= max) { announce('Maximum of ' + max + ' reached'); return; }
            selected.push({ value, label });
            render();
            syncOut();
            announce(label + ' added');
        }
        function removeValue(value) {
            if (isLocked(value)) return;     // locked chips stay put
            const i = selected.findIndex(s => String(s.value).toLowerCase() === String(value).toLowerCase());
            if (i < 0) return;
            const [g] = selected.splice(i, 1);
            render();
            syncOut();
            announce(g.label + ' removed');
            if (menu && !isAsync) filter();
            refocus();
        }

        function makeChip(s) {
            const chip = document.createElement('span');
            chip.className = 'combobox-chip';
            chip.dataset.value = s.value;
            const label = document.createElement('span');
            label.textContent = s.label;
            chip.appendChild(label);
            applyLock(chip, s.value, s.label);
            return chip;
        }
        // Add or drop the × to match the value's locked state. Re-run from render() so a
        // reactive `locked` change toggles the affordance on existing chips too.
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
                // Incremental: keep existing chip nodes, only add new / drop removed /
                // refresh locked state. Recreating every chip re-inserts them next to the
                // focused editor, which collapses them to an ellipsis in WebKit; untouched
                // nodes keep their width.
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
                    else applyLock(node, s.value, s.label);
                });
                // Reorder to match selection only when it actually differs — needless
                // re-insertion collapses chips in WebKit while the editor is focused, so the
                // common append path (order already matches) skips this.
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

        // Pull complete tokens (those ended by a separator) out of the field into
        // chips, leaving any trailing partial. Reading the value here rather than on
        // keydown avoids the keydown/character-insert race, and covers paste too.
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

        // Open for fresh entry. A committed single value is shown alongside the full
        // list so it can be swapped; selectText (keyboard focus) also selects it to type over.
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
                    if (activeIndex >= 0 || activeIndex === -2) { e.preventDefault(); selectOption(liAt(activeIndex)); }
                }
                else if (e.key === 'Escape') { if (open) { e.preventDefault(); closeMenu(); } }
            });
        } else {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown' && menu) { e.preventDefault(); openMenu(); moveActive(1); }
                else if (e.key === 'ArrowUp' && menu) { e.preventDefault(); moveActive(-1); }
                else if (e.key === 'Enter') {
                    if (menu && menu.matches(':popover-open') && (activeIndex >= 0 || activeIndex === -2)) {
                        e.preventDefault();
                        selectOption(liAt(activeIndex));
                    } else if (!strict || !menu) {
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
                if (menu) menu.setAttribute('data-kbd', '');   // typing drives the highlight onto the first match
                extractTokens();
                if (isAsync) asyncRefresh(); else { openMenu(); filter(); }
            });

            el.addEventListener('focus', () => { if (!suppressOpen) openForEntry(true); });
            // Reopen on click even when the field is already focused (focus won't re-fire).
            el.addEventListener('mousedown', () => { if (menu && !menu.matches(':popover-open') && !suppressOpen) openForEntry(false); });
        }

        // Close when focus leaves the field entirely (Tab away).
        el.addEventListener('blur', () => setTimeout(() => {
            if (menu && !wrap.contains(document.activeElement) && !menu.contains(document.activeElement)) closeMenu();
        }, 0));

        // Click empty shell → focus the trigger
        wrap.addEventListener('mousedown', (e) => {
            if (e.target === wrap) { e.preventDefault(); refocus(); }
        });

        // Outside dismiss (manual popover). Self-removes once the menu leaves the DOM
        // so repeated re-renders don't leak document listeners.
        if (menu && !menu.__mnfstCbDismiss) {
            menu.__mnfstCbDismiss = true;
            const onDocPointer = (e) => {
                if (!menu.isConnected) { document.removeEventListener('pointerdown', onDocPointer); return; }
                if (menu.matches(':popover-open') && !menu.contains(e.target) && !wrap.contains(e.target)) closeMenu();
            };
            document.addEventListener('pointerdown', onDocPointer);
            if (cleanup) cleanup(() => document.removeEventListener('pointerdown', onDocPointer));
        }
        // A generated (datalist/select) menu lives in <body>; remove it when the field
        // is torn down (e.g. an x-markdown re-render in a SPA) so it doesn't orphan as
        // a stale, sometimes-open duplicate. Authored/adopted menus go with their container.
        if (cleanup && generatedMenu) cleanup(() => { if (generatedMenu.isConnected) generatedMenu.remove(); });

        // ----- Reactive model (x-model) -----
        // Renders chips from the bound value on init and whenever it changes externally
        // (e.g. switching which record is being edited); writes back on add/remove. The
        // read runs inside an Alpine effect so $x / nested state stay reactive.
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

        // ----- Reactive locked list (config-object form re-evaluates, so authors can
        //        gate it on state, e.g. last-owner: locked: owners.length <= 1 ? ['owner'] : []) -----
        if (expr.startsWith('{')) {
            Alpine.effect(() => {
                let c; try { c = Alpine.evaluate(el, expr); } catch (_) { return; }
                const next = computeLocked(c && typeof c === 'object' && !Array.isArray(c) ? c : null);
                if (next.size === lockedSet.size && [...next].every(v => lockedSet.has(v))) return;
                lockedSet = next;
                render();
            });
        }

        // ----- Dynamic options: re-read when x-for / $x fills the source list after
        //        build, so the menu, chip labels, and data-locked flags stay current. -----
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
            // childList/characterData: x-for adds/removes/edits rows. attributes: a bound
            // data-locked / data-value / data-label toggles, so locking is reactive.
            mo.observe(src, {
                childList: true, subtree: true, characterData: true,
                attributes: true, attributeFilter: ['data-value', 'data-label', 'data-locked', 'data-pattern']
            });
            if (cleanup) cleanup(() => mo.disconnect());
        }

        // ----- Seed initial chips from value="a, b" — only when there's no x-model
        //        (x-model wins) and no adopted wrapper (which already seeded). -----
        if (!modelExpr && !adopt && !editorNone && chips && el.value) {
            const seeds = el.value.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
            el.value = '';
            seeds.forEach(s => commitText(s));
        }
        // In chips/multiple mode the editor is a typing buffer, never a value holder. Clear
        // the value PROPERTY and remove the value ATTRIBUTE: the attribute (not the property)
        // is what mnfst-render serializes into the prerendered HTML, so leaving it would bake
        // the raw seed text into the editor and show it as inline text on hydration (Safari).
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
