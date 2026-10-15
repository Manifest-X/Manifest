    /* ---- Attributes and classes (API only; any area) ----
       Each change is one logged delta. With a :class binding, only the static
       class attribute is edited; the binding keeps merging its own classes. */
    const bindingOf = (el, name) => el.getAttribute(':' + name) ?? el.getAttribute('x-bind:' + name);
    function boundClasses(el) {
        const expr = bindingOf(el, 'class'); if (expr == null) return [];
        let v; try { v = window.Alpine.evaluate(el, expr); } catch { return []; }
        const out = [];
        const add = (x) => String(x).split(/\s+/).filter(Boolean).forEach(c => out.push(c));
        if (typeof v === 'string') add(v);
        else if (Array.isArray(v)) v.flat(Infinity).filter(Boolean).forEach(add);
        else if (v && typeof v === 'object') Object.entries(v).forEach(([k, on]) => { if (on) add(k); });
        return out;
    }
    const splitClasses = (s) => String(s || '').split(/\s+/).filter(Boolean);
    function readClass(el) {
        const bound = new Set(boundClasses(el));
        return splitClasses(el.getAttribute('class')).filter(c => !bound.has(c)).join(' ');
    }
    function writeClass(el, value) {
        const bound = boundClasses(el);
        const next = [...new Set([...splitClasses(value), ...bound])].join(' ');
        if (!next) { if (el.hasAttribute('class')) el.removeAttribute('class'); return; }
        if (el.getAttribute('class') !== next) el.setAttribute('class', next);
    }

    function attrTarget(el) {
        if (el == null) el = target;
        if (!el || el.nodeType !== 1) return null;
        const area = regionOf(el);
        if (!area || !isActive(area)) return null;
        return { el, area, kind: classify(area) };
    }
    function setAttr(name, value, el) {
        const t = attrTarget(el); if (!t) return false;
        name = String(name || '').trim().toLowerCase();
        const v = value === true ? '' : (value === false || value == null) ? null : String(value);
        const refused = attrRefusal(name, v, t.el.tagName);
        if (refused) { console.warn(`[edit] attribute refused (${refused}):`, name); return false; }
        if (lockedFor(t.el, 'attrs')) return false;
        const host = t.kind !== 'data' && leafHost(t.el);
        if (host) return setInLeaf(t, host, name, v);
        if (name === 'class') return setClass(t, v || '');
        if (t.kind === 'data') { console.warn('[edit] list rows are rendered from data; attributes on them are not editable'); return false; }
        if (t.kind === 'component') { console.warn('[edit] component nodes take class changes only'); return false; }
        if (!/^[@~]/.test(t.el.getAttribute('data-edit-key') || '')) return false;
        if (bindingOf(t.el, name) != null) console.warn(`[edit] ${name} is bound on this element; the binding will override the edited value`);
        const before = t.el.getAttribute(name);
        if (before === v) return false;
        if (v === null) t.el.removeAttribute(name); else t.el.setAttribute(name, v);
        return commitStaticNode(t.area, t.el, name, v, { before, coalesce: true });
    }
    // Inside a Rich Text leaf an attribute is part of the leaf's text: one text delta, kept only if the sanitizer keeps it.
    function setInLeaf(t, host, name, v) {
        if (lockedFor(host, 'text') || t.el.getAttribute(name) === v) return false;
        const focused = document.activeElement === host;
        const before = focused && host._preEdit !== undefined ? host._preEdit : leafText(host), was = t.el.getAttribute(name), cur = leafText(host);
        const put = (x) => x === null ? t.el.removeAttribute(name) : t.el.setAttribute(name, x);
        put(v);
        if (leafText(host) === cur) { put(was); console.warn(`[edit] ${name} is not kept inside text`); return false; }
        const value = leafHTML(host);
        const done = t.kind === 'component' ? commitComponentNode(t.area, host, 'text', value, before) : commitStaticNode(regionOf(host), host, 'text', value, { before });
        if (focused) { restartRich(host); host._preEdit = leafText(host); }
        return done;
    }
    function setClass(t, value) {
        if (t.kind === 'data') { console.warn('[edit] list rows are rendered from data; attributes on them are not editable'); return false; }
        if (leafHost(t.el)) { console.warn('[edit] class is not kept inside text'); return false; }
        const before = readClass(t.el);
        value = splitClasses(value).join(' ');
        if (before === value) return false;
        writeClass(t.el, value);
        if (t.kind === 'component') {
            if (t.el._editPath == null) return false;
            liveMainPropagate(t.area, t.el, 'class', t.el.getAttribute('class') || '');
            return commitComponentNode(t.area, t.el, 'class', value, before);
        }
        if (!/^[@~]/.test(t.el.getAttribute('data-edit-key') || '')) return false;
        return commitStaticNode(t.area, t.el, 'class', value, { before, coalesce: true });
    }
    function editClasses(el, fn) {
        const t = attrTarget(el); if (!t) return false;
        if (lockedFor(t.el, 'attrs')) return false;
        const list = splitClasses(readClass(t.el));
        const next = fn(list);
        return next ? setClass(t, next.join(' ')) : false;
    }
    const classesApi = {
        add(cls, el) { const add = splitClasses(cls); return editClasses(el, l => [...l, ...add.filter(c => !l.includes(c))]); },
        remove(cls, el) { const rm = new Set(splitClasses(cls)); return editClasses(el, l => l.filter(c => !rm.has(c))); },
        toggle(cls, el, force) {
            const t = attrTarget(el); if (!t) return false;
            const names = splitClasses(cls), on = force ?? !names.every(c => t.el.classList.contains(c));
            return on ? classesApi.add(cls, t.el) : classesApi.remove(cls, t.el);
        },
        set(value, el) { const t = attrTarget(el); return !!t && !lockedFor(t.el, 'attrs') && setClass(t, value || ''); },
        has(cls, el) { void (estore && estore.version); const t = el == null ? target : el; return !!t && t.nodeType === 1 && splitClasses(cls).every(c => t.classList.contains(c)); },
        list(el) { void (estore && estore.version); const t = el == null ? target : el; return t && t.nodeType === 1 ? splitClasses(readClass(t)) : []; }
    };

    /* ---- Component scope and revert ---- */
    const componentAreaOf = (el) => { const a = el && regionOf(el); return a && classify(a) === 'component' ? a : null; };
    function scopeOf(el) { const a = componentAreaOf(el == null ? target : el); return a ? a._editScope || 'instance' : null; }
    function setScope(value, el) {
        const a = componentAreaOf(el == null ? target : el);
        if (!a || (value !== 'instance' && value !== 'main')) return false;
        a._editScope = value; bump();
        return true;
    }
    function revert(el) {
        if (el == null) el = target;
        const a = componentAreaOf(el); if (!a) return false;
        if (el === a) revertAll(a);
        else if (el._editPath != null) revertNode(a, el);
        else return false;
        return true;
    }
