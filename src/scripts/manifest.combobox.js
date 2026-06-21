/* Manifest Combobox */

(function () {

// A select-like field with four orthogonal axes:
//   editor:  input (default) | textarea | none (button trigger)
//   options: none (free entry) | datalist/select (generated menu) | menu (authored)
//   value:   single (default) | multiple (+ data-max cap)
//   display: text (default) | chips
//
// The dropdown reuses Manifest's menu[popover] styles + anchor positioning.
// Tokenization, filtering and form participation live here.

function initializeComboboxPlugin() {

    function ensureAlpineContext() {
        if (!document.body.hasAttribute('x-data')) document.body.setAttribute('x-data', '{}');
    }

    ensureAlpineContext();

    const rand = () => Math.random().toString(36).slice(2, 9);

    // Read options from a source element (datalist/select → option, menu → li)
    function readOptions(src) {
        if (!src) return [];
        if (src.tagName === 'MENU') {
            return Array.from(src.querySelectorAll('li')).map(li => ({
                value: li.dataset.value != null ? li.dataset.value : li.textContent.trim(),
                label: (li.dataset.label || li.textContent.trim()),
                html: li.innerHTML
            }));
        }
        return Array.from(src.querySelectorAll('option')).map(o => ({
            value: o.value || o.textContent.trim(),
            label: o.textContent.trim() || o.value,
            html: null
        }));
    }

    Alpine.directive('combobox', (el, { modifiers, expression }) => {
        // Build after the current tick so sibling sources (datalist/menu) exist.
        setTimeout(() => build(el, modifiers, (expression || '').trim()), 0);
    });

    function build(el, modifiers, sourceSel) {
        if (el.__mnfstCombobox) return;
        el.__mnfstCombobox = true;

        // ----- Config -----
        const multiple   = modifiers.includes('multiple');
        const chips      = modifiers.includes('chips');
        const strict     = modifiers.includes('strict');
        const create     = modifiers.includes('create');
        const max        = parseInt(el.getAttribute('data-max'), 10) || (multiple ? Infinity : 1);
        const filterMode = el.getAttribute('data-filter') || 'includes';
        const minChars   = parseInt(el.getAttribute('data-min'), 10) || 0;
        const sepAttr    = el.getAttribute('data-separators');
        const separators = sepAttr != null
            ? sepAttr.split('').filter(c => c.trim() || c === ' ')
            : (multiple ? [','] : []);
        const name        = el.getAttribute('name');
        const placeholder = el.getAttribute('placeholder') || '';

        // ----- Source / options -----
        if (sourceSel && !/^[.#\[]/.test(sourceSel)) sourceSel = '#' + sourceSel;
        const src = sourceSel ? document.querySelector(sourceSel) : null;
        const options = readOptions(src);
        const hasMenu = !!src;

        // ----- Shell -----
        const wrap = document.createElement('div');
        wrap.className = 'combobox';
        el.parentNode.insertBefore(wrap, el);
        wrap.appendChild(el);
        el.classList.add('combobox-editor');
        el.setAttribute('autocomplete', 'off');
        el.removeAttribute('placeholder');

        // The editor never submits; hidden inputs carry the real value(s).
        if (name) el.removeAttribute('name');

        // Live region for add/remove announcements
        const live = document.createElement('span');
        live.className = 'combobox-live';
        live.setAttribute('aria-live', 'polite');
        wrap.appendChild(live);
        const announce = (m) => { live.textContent = ''; live.textContent = m; };

        // ----- Menu -----
        let menu = null, optionEls = [], createEl = null, emptyEl = null, activeIndex = -1;

        if (hasMenu) {
            if (src.tagName === 'MENU') {
                menu = src;                       // authored menu (rich rows)
            } else {
                menu = document.createElement('menu');  // generated from datalist/select
                document.body.appendChild(menu);
                src.style.setProperty('display', 'none', 'important'); // keep inert source out of layout
            }
            menu.classList.add('dropdown-menu', 'combobox-menu');
            menu.setAttribute('popover', 'manual');
            if (!menu.id) menu.id = 'combobox-menu-' + rand();
            menu.setAttribute('role', 'listbox');
            if (multiple) menu.setAttribute('aria-multiselectable', 'true');

            // (Re)build option <li>s when generated; tag authored ones.
            const lis = src.tagName === 'MENU'
                ? Array.from(menu.querySelectorAll('li'))
                : options.map(o => {
                    const li = document.createElement('li');
                    li.textContent = o.label;
                    menu.appendChild(li);
                    return li;
                });
            lis.forEach((li, i) => {
                const o = options[i] || { value: li.dataset.value || li.textContent.trim(), label: li.textContent.trim() };
                li.id = menu.id + '-opt-' + i;
                li.dataset.value = o.value;
                li.dataset.label = o.label;
                li.setAttribute('role', 'option');
                li.setAttribute('aria-selected', 'false');
                optionEls.push(li);
            });

            // "Add …" row
            if (create) {
                createEl = document.createElement('li');
                createEl.className = 'combobox-create';
                createEl.setAttribute('role', 'option');
                createEl.hidden = true;
                menu.appendChild(createEl);
            }

            // Empty state
            emptyEl = document.createElement('div');
            emptyEl.className = 'combobox-empty';
            emptyEl.textContent = 'No matches';
            emptyEl.hidden = true;
            menu.appendChild(emptyEl);

            // Anchor positioning (same mechanism as x-dropdown)
            const anchorName = '--combobox-' + rand();
            wrap.style.setProperty('anchor-name', anchorName);
            menu.style.setProperty('position-anchor', anchorName);

            // ARIA combobox wiring on the editor
            el.setAttribute('role', 'combobox');
            el.setAttribute('aria-autocomplete', 'list');
            el.setAttribute('aria-expanded', 'false');
            el.setAttribute('aria-controls', menu.id);

            // Keep editor focus when clicking an option
            menu.addEventListener('mousedown', (e) => e.preventDefault());
            menu.addEventListener('click', (e) => {
                const li = e.target.closest('li');
                if (li && !li.hidden) selectOption(li);
            });
        }

        // ----- Selection model -----
        let selected = [];
        const isSelected = (v) => selected.some(s => String(s.value).toLowerCase() === String(v).toLowerCase());

        function openMenu() {
            if (!menu || menu.matches(':popover-open')) return;
            if (el.value.length < minChars) return;
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

        function setActive(i) {
            optionEls.forEach(li => li.classList.remove('is-active'));
            if (createEl) createEl.classList.remove('is-active');
            activeIndex = i;
            const li = liAt(i);
            if (li) { li.classList.add('is-active'); el.setAttribute('aria-activedescendant', li.id); }
            else el.removeAttribute('aria-activedescendant');
        }
        // Active index addresses visible options first, then the create row (-2).
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
            let pos = vis.indexOf(activeIndex);
            pos = (pos + dir + vis.length) % vis.length;
            setActive(vis[pos]);
        }

        function filter() {
            if (!menu) return;
            const q = el.value.trim().toLowerCase();
            let first = -1, anyVisible = false, exact = false;
            optionEls.forEach((li, i) => {
                const t = String(li.dataset.label).toLowerCase();
                let show = !q || filterMode === 'none' ? true
                    : filterMode === 'startswith' ? t.startsWith(q)
                    : t.includes(q);
                if (show && multiple && isSelected(li.dataset.value)) show = false; // hide chosen
                li.hidden = !show;
                if (show) { anyVisible = true; if (first < 0) first = i; }
                if (t === q) exact = true;
            });
            if (createEl) {
                const show = create && q && !exact;
                createEl.hidden = !show;
                createEl.textContent = show ? `Add “${el.value.trim()}”` : '';
                createEl.dataset.value = el.value.trim();
                if (show) anyVisible = true;
            }
            if (emptyEl) emptyEl.hidden = anyVisible;
            setActive(first >= 0 ? first : (createEl && !createEl.hidden ? -2 : -1));
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
            if (chips || multiple) el.value = '';   // single-text keeps the label render() set
            if (menu) filter();
            return true;
        }

        function selectOption(li) {
            if (li === createEl) { commitText(li.dataset.value); return refocus(); }
            addValue(li.dataset.value, li.dataset.label);
            if (chips || multiple) el.value = '';   // single-text keeps the label render() set
            if (!multiple) closeMenu(); else filter();
            refocus();
        }
        function refocus() { if (el.tagName !== 'BUTTON') el.focus(); }

        function addValue(value, label) {
            if (!multiple) { selected = [{ value, label }]; render(); announce(label + ' selected'); return; }
            if (isSelected(value)) return;
            if (selected.length >= max) { announce('Maximum of ' + max + ' reached'); return; }
            selected.push({ value, label });
            render();
            announce(label + ' added');
        }
        function removeValue(value) {
            const i = selected.findIndex(s => String(s.value).toLowerCase() === String(value).toLowerCase());
            if (i < 0) return;
            const [g] = selected.splice(i, 1);
            render();
            announce(g.label + ' removed');
            if (menu) filter();
            refocus();
        }

        function makeChip(s) {
            const chip = document.createElement('span');
            chip.className = 'combobox-chip';
            chip.dataset.value = s.value;
            const label = document.createElement('span');
            label.className = 'combobox-chip-label';
            label.textContent = s.label;
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'combobox-chip-remove';
            x.setAttribute('aria-label', 'Remove ' + s.label);
            x.textContent = '×';
            x.addEventListener('click', () => removeValue(s.value));
            chip.append(label, x);
            return chip;
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
            wrap.querySelectorAll('.combobox-chip, input[data-cb]').forEach(n => n.remove());
            if (chips) {
                selected.forEach(s => {
                    wrap.insertBefore(makeChip(s), el);
                    if (name) wrap.appendChild(hidden(s.value));
                });
                el.placeholder = selected.length ? '' : placeholder;
            } else if (!multiple) {
                el.value = selected[0] ? selected[0].label : '';
                el.placeholder = placeholder;
                if (name && selected[0]) wrap.appendChild(hidden(selected[0].value));
            }
            // Sync aria-selected on options
            optionEls.forEach(li => li.setAttribute('aria-selected', isSelected(li.dataset.value) ? 'true' : 'false'));
            // Cap: stop typing when full (multiple)
            const full = multiple && selected.length >= max;
            el.disabled = full;
            wrap.classList.toggle('is-disabled', false);
        }

        if (!chips && !multiple) el.placeholder = placeholder;

        // ----- Events -----
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
            else if (separators.includes(e.key)) { if (commitText(el.value)) e.preventDefault(); }
        });

        el.addEventListener('input', () => { openMenu(); filter(); });
        el.addEventListener('focus', () => { openMenu(); filter(); });

        el.addEventListener('paste', (e) => {
            if (!separators.length && !multiple) return;
            const text = (e.clipboardData || window.clipboardData).getData('text');
            if (text && /[,\n;]/.test(text)) {
                e.preventDefault();
                text.split(/[,\n;]+/).forEach(t => commitText(t));
            }
        });

        // Click empty shell → focus editor
        wrap.addEventListener('mousedown', (e) => {
            if (e.target === wrap) { e.preventDefault(); refocus(); }
        });

        // Outside dismiss (manual popover)
        if (menu && !menu.__mnfstCbDismiss) {
            menu.__mnfstCbDismiss = true;
            document.addEventListener('pointerdown', (e) => {
                if (menu.matches(':popover-open') && !menu.contains(e.target) && !wrap.contains(e.target)) closeMenu();
            });
        }

        // ----- Seed initial chips from value="a, b" -----
        if (chips && el.value) {
            const seeds = el.value.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
            el.value = '';
            seeds.forEach(s => commitText(s));
        }
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
        document.querySelectorAll('[x-combobox]').forEach(el => { if (!el.__x) window.Alpine.initTree(el); });
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
