    /* ---- Theme: CSS custom properties (x-edit.cssvar="--var" or "scope:--var") ----
       Global on :root, or sandboxed to an x-edit.theme scope's subtree. */
    const cssvarControls = new Set();
    const themeBaseline = {};            // "scope|var" → original inline value ('' if none) — for revert-to-baseline
    const themeTouched = new Set();      // every scope|var ever applied
    const tkey = (scope, v) => (scope || '') + '|' + v;
    const themeTargetEl = (scope) => (scope && themeScopes[scope]) || document.documentElement;
    const cvValue = (el) => el.value + (el.dataset.unit || '');   // data-unit lets a range/number drive a unit'd var

    function registerCssVar(el, expression, modifiers) {
        const spec = (expression || '').trim();
        const m = spec.match(/^([\w-]+)\s*:\s*(--[\w-]+)$/);
        el._cssvar = m ? { scope: m[1], var: m[2] } : { scope: null, var: spec };
        el._cssvar.persist = !!(modifiers && modifiers.includes('persist'));
        cssvarControls.add(el);
    }
    function syncCssVarInput(el) {
        const cv = el._cssvar; if (!cv || !('value' in el)) return;
        const cur = getComputedStyle(themeTargetEl(cv.scope)).getPropertyValue(cv.var).trim();
        if (!cur) return;
        const next = el.dataset.unit ? String(parseFloat(cur)) : cur;
        if (el.value !== next) el.value = next;
    }
    function armCssVar(el) {
        const cv = el._cssvar; if (!cv || !cv.var) return;
        const kk = tkey(cv.scope, cv.var);
        if (!(kk in themeBaseline)) themeBaseline[kk] = themeTargetEl(cv.scope).style.getPropertyValue(cv.var);
        syncCssVarInput(el);
        if (el._cvBound) return; el._cvBound = true;
        el.addEventListener('input', () => themeTargetEl(cv.scope).style.setProperty(cv.var, cvValue(el)));   // live, no log
        el.addEventListener('change', () => commitTheme(cv.scope, cv.var, cvValue(el), cv.persist || (s => !!s && !!(s._editPersist || (s._edit && s._edit.persist)))(cv.scope && themeScopes[cv.scope])));
    }
    function armThemeControls() { cssvarControls.forEach(armCssVar); }

    function themeState() {
        const s = {};
        for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'theme') s[tkey(d.scope, d.var)] = d; }
        return s;
    }
    // Re-derive every touched var from the log, else its captured baseline.
    function applyThemeState() {
        const st = themeState();
        new Set([...themeTouched, ...Object.keys(st)]).forEach(kk => {
            themeTouched.add(kk);
            const sep = kk.indexOf('|'), scope = kk.slice(0, sep) || null, v = kk.slice(sep + 1);
            const el = themeTargetEl(scope), eff = st[kk] ? st[kk].value : themeBaseline[kk];
            if (eff) el.style.setProperty(v, eff); else el.style.removeProperty(v);
        });
        cssvarControls.forEach(syncCssVarInput);
    }
    function rebaseTheme() {
        Object.keys(themeBaseline).forEach(kk => { const sep = kk.indexOf('|'); themeBaseline[kk] = themeTargetEl(kk.slice(0, sep) || null).style.getPropertyValue(kk.slice(sep + 1)); });
        themeTouched.clear();
    }
    function commitTheme(scope, v, value, persist) {
        if (!/^--[\w-]+$/.test(v || '')) { console.warn('[edit] x-edit.cssvar needs a custom property name (--name):', v); return; }
        const kk = tkey(scope, v); themeTouched.add(kk);
        themeTargetEl(scope).style.setProperty(v, value);
        const cur = themeState()[kk]; if (cur && cur.value === value) return;   // dedupe
        pushDelta({ kind: 'theme', scope: scope || null, var: v, value }, !!persist);
    }
    // Each var → its scope's data-edit-theme-file, else the server's theme file.
    function themePatches() {
        return Object.values(themeState()).map(d => {
            const el = d.scope ? themeScopes[d.scope] : null;
            return { kind: 'theme', scope: d.scope || null, var: d.var, value: d.value, file: el ? el.getAttribute('data-edit-theme-file') || null : null };
        });
    }
