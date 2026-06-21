    /* ---- Theme regime: edit CSS custom properties (x-edit.cssvar) ----
       Not DOM-element editing. A variable set on :root is global; set on an x-edit
       theme scope's element it cascades to that subtree ONLY (sandboxed theme), so the
       same var name can live at both levels without collision. Controls are inputs that
       declare their target as "scope:--var" (area/scope key) or bare "--var" (global).
       Live = setProperty (var()-referencing utilities update for free); persisted as
       {kind:'theme', scope, var, value}. Net-new variables are a later step. */
    const cssvarControls = new Set();
    const themeBaseline = {};            // "scope|var" → original inline value ('' if none) — for revert-to-baseline
    const themeTouched = new Set();      // every scope|var ever applied
    const tkey = (scope, v) => (scope || '') + '|' + v;
    const themeTargetEl = (scope) => (scope && themeScopes[scope]) || document.documentElement;
    const cvValue = (el) => el.value + (el.dataset.unit || '');   // data-unit lets a range/number drive a unit'd var

    function registerCssVar(el, expression) {
        const spec = (expression || '').trim();
        const m = spec.match(/^([\w-]+)\s*:\s*(--[\w-]+)$/);   // "scope:--var" vs bare "--var" (global)
        el._cssvar = m ? { scope: m[1], var: m[2] } : { scope: null, var: spec };
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
        el.addEventListener('change', () => commitTheme(cv.scope, cv.var, cvValue(el)));                       // commit
    }
    function armThemeControls() { cssvarControls.forEach(armCssVar); }

    function themeState() {
        const s = {};
        for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'theme') s[tkey(d.scope, d.var)] = d; }
        return s;
    }
    // Re-derive every touched var from the log: state value if present, else the captured
    // baseline (setProperty to restore an authored inline value; removeProperty if none).
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
    function commitTheme(scope, v, value) {
        const kk = tkey(scope, v); themeTouched.add(kk);
        themeTargetEl(scope).style.setProperty(v, value);
        const cur = themeState()[kk]; if (cur && cur.value === value) return;   // dedupe
        log.splice(cursor); log.push({ kind: 'theme', scope: scope || null, var: v, value }); cursor = log.length; saveState(); refresh();
    }
    // B-side: each theme var → its scope's target CSS file (data-edit-theme-file on the
    // scope element); global vars carry no file → the server falls back to the theme file.
    function themePatches() {
        return Object.values(themeState()).map(d => {
            const el = d.scope ? themeScopes[d.scope] : null;
            return { kind: 'theme', scope: d.scope || null, var: d.var, value: d.value, file: el ? el.getAttribute('data-edit-theme-file') || null : null };
        });
    }
