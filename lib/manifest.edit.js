/* manifest.edit.js — built from scripts/edit/ */

(function () {

/* Manifest Edit */

(function () {
    const lsKey = (path) => 'mnfst-edit-log:' + (path || location.pathname);
    let lsPath = location.pathname;
    const SCHEMA = 8;
    const HISTORY_CAP = 400;
    const ALL_CAPS = ['text', 'move', 'size', 'data'];
    const DEFAULT_CAPS = ['text', 'move'];
    const LOCK_ACTIONS = ['move', 'remove', 'duplicate', 'text', 'attrs', 'size'];
    const RETIRED = { sort: '.move', authoring: 'nothing (visuals are on by default; use .bare to hide them, .persist to keep edits)', style: '$edit.classes / $edit.attr', none: '.lock' };
    const COALESCE_MS = 1000;
    let dragged = null, autoN = 0;

    let log = [], cursor = 0;
    const lastSnap = {};
    const persisted = new WeakSet();

    // Text an element holds in source: Alpine-rendered and generated content is left out.
    // Plugin-rendered hosts: their children are produced at runtime, not authored.
    const RENDERED = ['x-html', 'x-text', 'x-markdown', 'x-icon', 'x-svg', 'x-code', 'x-code-group', 'x-chart', 'x-anchors', 'x-carousel', 'x-color', 'x-colorpicker', 'x-combobox', 'x-date', 'x-defer', 'x-virtual', 'x-import', 'x-files', 'x-data-files'];
    const isRendered = (el) => [...el.attributes].some(a => { const n = a.name.toLowerCase(); return RENDERED.some(r => n === r || n.startsWith(r + '.')); });
    // Elements whose content is not markup: never text-edited.
    const RAW_EDIT = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'XMP', 'IFRAME', 'NOEMBED', 'NOFRAMES']);
    const listTpl = (area) => [...area.children].find(c => c.tagName === 'TEMPLATE' && c.hasAttribute('x-for')) || null;
    function sourceText(el) {
        if (isRendered(el)) return '';
        let t = '';
        for (const n of el.childNodes) {
            if (n.nodeType === 3) t += n.textContent;
            else if (n.nodeType === 1 && !pluginNode(n) && n.tagName !== 'TEMPLATE' && !isGenerated(n) && !n._manifestComponent) t += sourceText(n);
        }
        return t;
    }
    const staticKey = (el) => el.tagName.toUpperCase() + ':' + sourceText(el).replace(/\s+/g, ' ').trim().slice(0, 24);
    // Identity: "@region@KEY" for source elements (origin area + content key),
    // "~id~@region@KEY" for a copy of one, "!id" for content that is not in source.
    const canonKey = (region, k) => '@' + encodeURIComponent(region) + '@' + k;
    const originOf = (k) => k && k[0] === '~' ? k.slice(k.indexOf('~', 1) + 1) : k;
    let mintN = 0;
    const mint = () => Date.now().toString(36) + (++mintN).toString(36) + Math.random().toString(36).slice(2, 6);
    // Elements Alpine renders from a template (x-if / x-for clones) are not source.
    function isGenerated(el) {
        for (let t = el.previousElementSibling; t; t = t.previousElementSibling) {
            if (t.tagName !== 'TEMPLATE') continue;
            if (t._x_currentIfEl === el) return true;
            const l = t._x_lookup;
            if (l && (l instanceof Map ? [...l.values()] : Object.values(l)).includes(el)) return true;
        }
        return false;
    }
    function staticKeys(container) {
        const seen = Object.create(null);
        return sortableChildren(container).map(el => {
            const assigned = el.getAttribute('data-edit-host') || el.getAttribute('data-edit-key');
            if (assigned) return assigned;
            const base = staticKey(el);
            const n = seen[base] = (seen[base] || 0) + 1;
            return n > 1 ? base + '#' + n : base;
        });
    }
    // Surfaced conflicts ($edit.conflicts); those of .persist regions are stored with the log until cleared
    let conflicts = [];
    const keptConflicts = new WeakSet();
    const loadState = () => {
        try {
            lsPath = location.pathname;
            const s = JSON.parse(localStorage.getItem(lsKey(lsPath)));
            if (s && s.v === SCHEMA) {
                log = s.log || []; cursor = s.cursor ?? log.length; log.forEach(d => persisted.add(d));
                conflicts = Array.isArray(s.conflicts) ? s.conflicts : []; conflicts.forEach(c => keptConflicts.add(c));
                if (estore) estore.conflicts = conflicts.slice();
            }
            else if (s) localStorage.removeItem(lsKey(lsPath));
        } catch { }
    };
    // One document, one log: an SPA's routes share it, so every path this page has been at
    // holds the same state (a publish from one route leaves no published deltas under another).
    const sessionPaths = new Set([location.pathname]);
    const saveState = (path) => {
        if (log.length > HISTORY_CAP) { const n = log.length - HISTORY_CAP; log.splice(0, n); cursor = Math.max(0, cursor - n); }
        const done = log.slice(0, cursor).filter(d => persisted.has(d)), ahead = log.slice(cursor).filter(d => persisted.has(d));
        sessionPaths.add(path || location.pathname);
        const kept = conflicts.filter(c => keptConflicts.has(c));
        (path ? [path] : [...sessionPaths]).forEach(p => {
            try {
                if (!done.length && !ahead.length && !kept.length) localStorage.removeItem(lsKey(p));
                else localStorage.setItem(lsKey(p), JSON.stringify(Object.assign({ v: SCHEMA, log: [...done, ...ahead], cursor: done.length }, kept.length ? { conflicts: kept } : {})));
            } catch { }
        });
    };
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // Nearest value of a custom property, `none` included ('' when unset).
    function rawVar(el, name) {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const v = getComputedStyle(n).getPropertyValue(name).trim();
            if (v) return v;
        }
        return '';
    }
    // Inherited custom properties; `none` cancels an inherited value.
    function cssVar(el, name, fallback) {
        const v = rawVar(el, name);
        if (!v) return fallback ?? '';
        return v === 'none' && name !== '--edit-size' ? (fallback ?? '') : v;
    }
    // Inline style minus declarations the plugin applied itself.
    // Inline style minus declarations the plugins applied: Edit's position, Rich Text's --rich-text-* state.
    function stripRuntime(s, pos) {
        if (!pos && !/--rich-text-/.test(s)) return s;
        const d = document.createElement('div');
        d.setAttribute('style', s);
        if (pos) d.style.removeProperty('position');
        const names = []; for (let i = 0; i < d.style.length; i++) names.push(d.style.item(i));
        names.filter(p => p.startsWith('--rich-text-')).forEach(p => d.style.removeProperty(p));
        return d.getAttribute('style') || '';
    }
    const ownStyle = (el) => stripRuntime(el.getAttribute('style') || '', !!el._editPos);
    function writeStyle(el, v) {
        if (v == null || v === '') el.removeAttribute('style'); else if (el.getAttribute('style') !== v) el.setAttribute('style', v);
        if (el._editPos && !el.style.position) el.style.position = 'relative';
    }

    /* ---- Safety ---- */
    const nodeSig = (el) => el ? el.tagName.toLowerCase() : '';
    const SAFE_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'U', 'S', 'SMALL', 'CODE', 'MARK', 'SUB', 'SUP', 'BR', 'SPAN', 'A']);
    // x-rich-text fields keep blocks; every other text leaf is inline. Rich Text's allowlist when loaded.
    const authoredRich = (el) => !!el && el.nodeType === 1 && el.hasAttribute('data-rich-text') && !el._editRt;
    const LEAF_STYLE = true;   // inline style survives Rich Text's sanitizer, so it is plain formatting too
    const inlineClean = (html) => window.ManifestRichText.sanitize(html, false, LEAF_STYLE);
    // Leaf text: Rich Text's allowlist; no interactive element inside another (or inside an
    // interactive leaf), no empty link; a trailing <br> shows nothing, so none is kept.
    // Comments the writer keeps verbatim: nothing that could close one early or open another.
    // Comment text the HTML spec allows: written back verbatim, it parses to the same comment.
    const keptComment = (d) => !/^-?>|-->|--!>|<!-$/.test(d);
    let warnedComment = false;
    const commentsIn = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT), out = []; for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n); return out; };
    const attrKept = (n, a) => !attrRefusal(a.name, a.value, n.tagName) && !(a.name === 'style' && /expression|url\s*\(|javascript:|@import/i.test(a.value));
    // The end of the text, along the last-descendant chain: <br>s, blank text and the inline elements they leave empty go.
    // Comments are kept and passed over.
    function trimTail(root) {
        const last = (p) => { let n = p.lastChild; while (n && n.nodeType === 8) n = n.previousSibling; return n; };
        for (let guard = 0; guard < 1000; guard++) {
            let n = last(root);
            while (n && n.nodeType === 1 && n.tagName !== 'BR' && last(n)) n = last(n);
            if (!n || n === root) return;
            const gone = n.nodeType === 3 ? !n.nodeValue.trim() : n.tagName === 'BR' || (!last(n) && !/^(IMG|WBR)$/.test(n.tagName));
            if (!gone) return;
            n.remove();
        }
    }
    function leafClean(html, host) {
        const t = document.createElement('template');
        // Authored comments ride through the sanitizer as placeholders
        t.innerHTML = String(html == null ? '' : html);
        const kept = [];
        const nonce = 'mnfst' + Math.random().toString(36).slice(2) + Date.now().toString(36), mark = new RegExp('(' + nonce + '\\d+_)');
        commentsIn(t.content).forEach(c => {
            if (keptComment(c.data)) { c.replaceWith(nonce + kept.length + '_'); kept.push(c.data); return; }
            c.remove();
            if (!warnedComment) { warnedComment = true; console.warn('[edit] a comment that cannot be written back as it is was left out of edited text'); }
        });
        t.innerHTML = inlineClean(t.innerHTML);
        if (kept.length) {
            const w = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT), texts = [];
            for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes(nonce)) texts.push(n);
            texts.forEach(n => n.replaceWith(...n.nodeValue.split(mark).filter(Boolean).map(p => mark.test(p) && p.startsWith(nonce) ? document.createComment(kept[parseInt(p.slice(nonce.length), 10)]) : document.createTextNode(p))));
        }
        trimTail(t.content);
        // The source writer's attribute rules, so what is shown is what publishes
        t.content.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => { if (!attrKept(n, a)) n.removeAttribute(a.name); }));
        const sel = CONTENT_RULES.interactive.join(','), hosted = !!(host && host.closest && host.closest('a, button'));
        [...t.content.querySelectorAll(sel)].forEach(n => { if (hosted || (n.parentElement && n.parentElement.closest(sel))) n.replaceWith(...n.childNodes); });
        t.content.querySelectorAll('a').forEach(a => { if (!a.textContent.trim() && !a.querySelector('img')) a.replaceWith(...a.childNodes); });
        return t.innerHTML.trim();
    }
    // A live leaf's markup; links nested by DOM edits are unwrapped first (a parser would split them).
    function leafHTML(el) {
        const sel = CONTENT_RULES.interactive.join(','), hosted = !!el.closest('a, button');
        [...el.querySelectorAll(sel)].forEach(n => { const up = n.parentElement && n.parentElement.closest(sel); if (hosted || (up && el.contains(up))) n.replaceWith(...n.childNodes); });
        return el.innerHTML.trim();
    }
    const sanitizeFor = (el, html) => !window.ManifestRichText ? sanitizeHTML(html)
        : authoredRich(el) ? window.ManifestRichText.sanitize(html, true, true) : leafClean(html, el);
    // Text written into an element. A leaf shows exactly what is logged; a rich field owns its markup:
    // it is written only when it differs as logged, then settles (keeping its editing affordances)
    function writeText(el, html) {
        const safe = sanitizeFor(el, html);
        if (el.innerHTML === safe || (authoredRich(el) && sanitizeFor(el, el.innerHTML.trim()) === safe)) return;
        el.innerHTML = safe;
        if (el._rt && typeof el._rt.settle === 'function') el._rt.settle();
    }

    function sanitizeHTML(html) {
        const t = document.createElement('template'); t.innerHTML = String(html == null ? '' : html);
        const walk = (node) => [...node.childNodes].forEach(c => {
            if (c.nodeType === 8) return c.remove();
            if (c.nodeType !== 1) return;
            if (!SAFE_TAGS.has(c.tagName)) { c.replaceWith(document.createTextNode(c.textContent)); return; }
            [...c.attributes].forEach(a => { const n = a.name.toLowerCase(); if (!(c.tagName === 'A' && n === 'href' && !attrRefusal('href', a.value, 'A'))) c.removeAttribute(a.name); });
            walk(c);
        });
        walk(t.content);
        return t.innerHTML;
    }

    // Attribute guardrails. Returns a reason, or null when safe. A script scheme is
    // refused in any value; data: only as a raster image on img/source src/srcset.
    const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', tab: '\t', newline: '\n', colon: ':' };
    const decodeEntities = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
        if (e[0] === '#') { const c = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return c >= 0 && c < 0x110000 ? String.fromCodePoint(c) : m; }
        const v = NAMED[e.toLowerCase()]; return v === undefined ? m : v;
    });
    const LOADS = { script: ['src', 'type'], iframe: ['src', 'srcdoc'], embed: ['src', 'srcdoc'], object: ['src', 'srcdoc', 'data'], frame: ['src', 'srcdoc'], link: ['href', 'rel'], base: ['href', 'rel'], meta: ['http-equiv', 'content'] };
    const SVG_ANIM = new Set(['set', 'animate', 'animatetransform', 'animatemotion']);
    const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif)[;,]/;
    function attrRefusal(name, value, tag) {
        const n = String(name || '').trim().toLowerCase(), t = String(tag || '').toLowerCase();
        if (!n || !/^[a-z_][\w:.-]*$/i.test(n)) return /^[@:]/.test(n) ? 'Alpine directive' : 'invalid name';
        if (n === 'text') return 'reserved name';
        if (n === 'action' || n === 'formaction') return 'form target';
        if (n.startsWith('on')) return 'event handler attribute';
        if (n.startsWith('x-')) return 'Alpine directive';
        if (n.startsWith('data-edit-')) return 'plugin attribute';
        if (n === 'srcdoc') return 'inline document';
        if (SVG_ANIM.has(t) && ['attributename', 'to', 'values', 'from', 'by'].includes(n)) return 'SVG animation target';
        if (LOADS[t] && LOADS[t].includes(n)) return 'loads or runs content';
        if (value == null) return null;
        for (const raw of [String(value), decodeEntities(value)]) {
            const v = raw.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
            if (/(^|[,(;'"=])(javascript|vbscript):/.test(v)) return 'script URL';
            const datas = v.match(/(^|[,(;'"=])data:[^,)]*/g) || [];
            if (datas.length) {
                const imageOk = (t === 'img' || t === 'source') && (n === 'src' || n === 'srcset');
                if (!imageOk || !datas.every(d => DATA_IMAGE.test(d.replace(/^[,(;'"=]/, '')))) return 'data URL';
            }
        }
        return null;
    }

    /* ---- x-edit registry ---- */
    const editEls = new Set();
    const themeScopes = {};
    const warnedRetired = new Set();
    // Within an area, a rendered host's content is not editable (the leaf exclusion).
    const insideRendered = (el) => { const a = regionOf(el); for (let n = el && el.parentElement; n; n = n.parentElement) { if (isRendered(n)) return true; if (n === a) break; } return false; };
    // Hosts whose content is generated output, not authored markup: an area inside one edits
    // in the page, but its markup is in no HTML file mnfst-run can write (x-code-group,
    // x-carousel and x-defer keep their authored children, so those can be written).
    const GENERATED = RENDERED.filter(r => r !== 'x-code-group' && r !== 'x-carousel' && r !== 'x-defer');
    function generatedBy(el) {
        for (let n = el && el.parentElement; n; n = n.parentElement) {
            if (n.nodeType !== 1) continue;
            const a = [...n.attributes].map(x => x.name.toLowerCase()).find(x => GENERATED.some(r => x === r || x.startsWith(r + '.')));
            if (a) return a.split('.')[0];
        }
        return null;
    }
    function registerEdit(el, modifiers, expression) {
        if (modifiers.includes('cssvar')) return registerCssVar(el, expression, modifiers);
        modifiers.forEach(m => { if (RETIRED[m] && !warnedRetired.has(m)) { warnedRetired.add(m); console.warn(`[edit] x-edit.${m} was removed — use ${RETIRED[m]}`); } });
        if (modifiers.includes('lock')) {
            const actions = modifiers.filter(m => LOCK_ACTIONS.includes(m));
            el._editLock = new Set(actions.length ? actions : ['*']);
            return;
        }
        const caps = new Set(ALL_CAPS.filter(c => modifiers.includes(c)));
        const theme = modifiers.includes('theme');
        const k = (expression || '').trim() || `area-${++autoN}`;
        if (theme) themeScopes[k] = el;
        if (theme && !caps.size) { if (modifiers.includes('persist')) el._editPersist = true; return; }
        if (!caps.size) DEFAULT_CAPS.forEach(c => caps.add(c));
        if ((expression || '').trim() && [...editEls].some(e => e !== el && e._edit && e._edit.key === k)) console.warn('[edit] duplicate x-edit key (deltas will mis-route):', k);
        const bare = modifiers.includes('bare');
        el._edit = { key: k, caps, gated: modifiers.includes('gated'), theme, persist: modifiers.includes('persist'), bare, rendered: generatedBy(el) };
        el.setAttribute('data-edit-area', bare ? 'bare' : '');
        editEls.add(el); resetAreas();
    }
    let areasCache = null;
    // Top-level areas: no x-edit above them in the same file (component markup is another file's).
    const areas = () => areasCache || (areasCache = [...editEls].filter(el => { for (let n = el; n; n = n.parentElement) { if (n !== el && n._edit) return false; if (n._manifestComponent || (n !== el && isRendered(n))) return true; } return true; }));
    const resetAreas = () => { areasCache = null; };
    const areaByKey = (k) => areas().find(a => a._edit.key === k);
    // A key mounted more than once (a component used several times) is not editable.
    const sharedKey = (a) => areas().filter(b => b._edit.key === a._edit.key).length > 1;
    // The component file an area is authored in: its nearest component root, when the area
    // sits inside it or that file itself carries this x-edit (else it came from the placeholder).
    function sourceComponent(area) {
        if (area._editSrc !== undefined) return area._editSrc;
        let name = null;
        for (let n = area; n; n = n.parentElement) {
            if (!n._manifestComponent) continue;
            const src = n === area && window.ManifestComponentsLoader && window.ManifestComponentsLoader.cache[n._manifestComponent];
            const own = new RegExp('\\sx-edit(?:\\.[\\w-]+)*\\s*=\\s*(["\'])' + area._edit.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\1');
            if (n !== area || (src && own.test(src))) name = n._manifestComponent;
            break;
        }
        return (area._editSrc = name);
    }
    // Its project path, as the components loader resolves it.
    function componentFile(name) {
        const mf = (window.ManifestComponentsRegistry && window.ManifestComponentsRegistry.manifest) || {};
        const p = [...(mf.preloadedComponents || []), ...(mf.components || [])].find(x => String(x).split('/').pop().replace('.html', '') === name);
        return String(p || 'components/' + name + '.html').replace(/^\/+/, '');
    }
    const sourceFile = (area) => { const c = sourceComponent(area); return c ? componentFile(c) : 'index.html'; };
    const topArea = (a) => !!a && areas().includes(a);
    const regionOf = (el) => el && areas().reduce((best, a) => (a === el || a.contains(el)) && (!best || best.contains(a)) ? a : best, null);
    const key = (area) => area._edit.key;
    function editInfo(node) { for (let n = node; n; n = n.parentElement) if (n._edit) return n._edit; return null; }
    const capOf = (node, cap) => { const i = editInfo(node); return !!i && i.caps.has(cap) && !lockedFor(node, cap); };
    const ownsCap = (el, cap) => !!el._edit && el._edit.caps.has(cap) && !lockedFor(el, cap);
    const persistOf = (region) => { const a = region != null && areaByKey(region); return !!(a && a._edit.persist); };

    /* ---- Regime classification ---- */
    function classify(area) {
        if (listTpl(area)) return 'data';
        if ((area.matches('[data-component]') && !sourceComponent(area)) || cmpRoot(area)) return 'component';
        return 'static';
    }
    // An instance the area overrides by path: the one component the area wraps, with no
    // x-edit region of its own. Among other content, a component is a host piece instead.
    const cmpRoot = (area) => {
        const kids = realChildren(area).filter(k => k.tagName !== 'TEMPLATE'), r = kids[0];
        return kids.length === 1 && r.matches('[data-component]') && !r._edit && !r.querySelector('[data-edit-area]') ? r : null;
    };
    function dataSourceExpr(area) { const t = listTpl(area); const m = t && t.getAttribute('x-for').match(/\bin\s+(.+)$/); return m ? m[1].trim() : null; }
    const dataSourceName = (area) => { const e = dataSourceExpr(area); const m = e && e.match(/\$x\.(\w+)/); return m ? m[1] : (e || 'source'); };
    const pluginNode = (x) => x.hasAttribute('data-edit-handle') || x.hasAttribute('data-edit-ghost') || x.hasAttribute('data-edit-grip');
    // A component's roots past its first follow that first one (its <x-name> host) everywhere.
    const groupOf = (el) => el && el._manifestHost && el._manifestHost.roots && el._manifestHost.roots[0] === el ? el._manifestHost.roots.slice() : [el];
    const extraRoot = (x) => !!x._manifestHost && !!x._manifestHost.roots && x._manifestHost.roots[0] !== x;
    const isHostEl = (el) => !!el && el.nodeType === 1 && el.hasAttribute('data-edit-host');
    const idOf = (el) => el.getAttribute('data-edit-host') || el.getAttribute('data-edit-key');
    const realChildren = (el) => Array.from(el.children).filter(x => !pluginNode(x) && !extraRoot(x));
    const sortableChildren = (c) => realChildren(c).filter(x => x.tagName !== 'TEMPLATE');
    let _keyWarned = false;
    function itemKey(el, area) {
        const explicit = el.getAttribute('data-key');
        if (explicit != null) return explicit;
        const tpl = listTpl(area), expr = tpl && tpl._x_keyExpression;
        if (expr) { try { const v = window.Alpine.evaluate(el, expr); if (v != null) return String(v); } catch { } }
        if (!_keyWarned) { _keyWarned = true; console.warn('[edit] data area rows have no identity — add :key to the x-for or :data-key to the row, or the order cannot be stored'); }
        return null;
    }

    /* ---- Structure: text elements are pieces, never containers ---- */
    const TEXT_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SPAN', 'A', 'LABEL', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SMALL', 'CODE', 'MARK', 'SUB', 'SUP', 'Q', 'CITE', 'ABBR', 'TIME', 'DT', 'DD', 'FIGCAPTION', 'CAPTION', 'LEGEND', 'SUMMARY', 'BUTTON', 'OPTION']);
    const ATOMIC_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'svg', 'IFRAME', 'OBJECT', 'SELECT', 'TEXTAREA', 'PICTURE', 'MATH', 'math', 'TEMPLATE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE', 'XMP']);
    const ownText = (el) => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const isTextEl = (el) => TEXT_TAGS.has(el.tagName) || el.hasAttribute('data-rich-text') || ownText(el) || wholeLeaf(el);
    // One leaf: a text element whose elements inside are all plain formatting, i.e. markup
    // Rich Text's inline sanitizer keeps unchanged (Edit's own attributes aside); <br> included.
    const LEAF_TAGS = new Set([...TEXT_TAGS, 'LI', 'TD', 'TH']);
    function plainFormatted(el) {
        if (!window.ManifestRichText) return false;
        const c = el.cloneNode(true);
        c.querySelectorAll('[data-edit-handle], [data-edit-ghost], [data-edit-grip]').forEach(n => n.remove());
        commentsIn(c).forEach(n => n.remove());
        if (!c.children.length) return true;
        c.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-')) n.removeAttribute(a.name); }));
        return inlineClean(c.innerHTML) === c.innerHTML && [...c.querySelectorAll('*')].every(n => [...n.attributes].every(a => attrKept(n, a)));
    }
    // Text is required: a link around an image alone stays granular, so the image keeps its own identity.
    const wholeLeaf = (el) => LEAF_TAGS.has(el.tagName) && realChildren(el).length > 0 && !!el.textContent.trim() && plainFormatted(el);
    // The text leaf an element sits inside (not the leaf itself), attached or resting as a focused piece.
    const leafHost = (el) => { for (let n = el && el.parentElement; n && n.nodeType === 1; n = n.parentElement) { if (n._editRtFormat) return n; if (n._edit) break; } return null; };
    function isContainer(el) {
        if (!el || el.nodeType !== 1 || ATOMIC_TAGS.has(el.tagName) || pluginNode(el)) return false;
        return !isTextEl(el);
    }

    /* ---- Titling comments ----
       A comment directly above an element (whitespace between, at most one newline)
       titles it and moves with it, unless it opens its container. Mirrors the source
       writer's leadOf (packages/run/serve.mjs). */
    function leadNodes(el) {
        const out = [];
        let n = el.previousSibling;
        for (;;) {
            let ws = null;
            if (n && n.nodeType === 3) { if (!/^[ \t]*(\r?\n)?[ \t]*$/.test(n.textContent)) break; ws = n; n = n.previousSibling; }
            if (!n || n.nodeType !== 8) break;
            let p = n.previousSibling;
            while (p && p.nodeType === 3 && !p.textContent.trim()) p = p.previousSibling;
            if (!p) break;
            out.unshift(n, ...(ws ? [ws] : []));
            n = n.previousSibling;
        }
        return out;
    }
    const startOf = (el) => el ? leadNodes(el)[0] || el : null;
    function moveWith(el, place) { const lead = leadNodes(el), rest = groupOf(el).slice(1); place(el); if (lead.length) el.before(...lead); if (rest.length) el.after(...rest); }

    /* ---- HTML content model ----
       Drops the parser would re-nest, foster-parent or drop. Mirrors CONTENT_RULES in
       the source writer (packages/run/serve.mjs). */
    const CONTENT_RULES = {
        only: {
            table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'script', 'template', 'style'],
            thead: ['tr', 'script', 'template'], tbody: ['tr', 'script', 'template'], tfoot: ['tr', 'script', 'template'],
            tr: ['td', 'th', 'script', 'template'], colgroup: ['col', 'template'],
            ul: ['li', 'script', 'template'], ol: ['li', 'script', 'template'], menu: ['li', 'script', 'template'],
            dl: ['dt', 'dd', 'div', 'script', 'template'],
            select: ['option', 'optgroup', 'hr', 'script', 'template'], datalist: ['option', 'script', 'template'], optgroup: ['option', 'script', 'template']
        },
        parent: {
            tr: ['thead', 'tbody', 'tfoot'], td: ['tr'], th: ['tr'], caption: ['table'], colgroup: ['table'], col: ['colgroup'],
            thead: ['table'], tbody: ['table'], tfoot: ['table'], li: ['ul', 'ol', 'menu'], dt: ['dl', 'div'], dd: ['dl', 'div'],
            option: ['select', 'datalist', 'optgroup'], optgroup: ['select']
        },
        interactive: ['a', 'button', 'input', 'select', 'textarea', 'details', 'label', 'iframe', 'embed', 'object', 'audio', 'video', 'keygen'],
        phrasingOnly: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'],
        block: ['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul', 'li', 'dd', 'dt']
    };
    function contentRefusal(child, parent, ancestors, subtree) {
        const R = CONTENT_RULES;
        if (R.only[parent] && !R.only[parent].includes(child)) return `<${parent}> takes only ${R.only[parent].filter(t => t !== 'script' && t !== 'template' && t !== 'style').join(', ')}`;
        if (R.parent[child] && !R.parent[child].includes(parent)) return `<${child}> belongs in ${R.parent[child].join(' or ')}`;
        if ((child === 'dt' || child === 'dd') && parent === 'div' && ancestors[1] !== 'dl') return `<${child}> belongs in a dl`;
        if (subtree.has('form') && ancestors.includes('form')) return 'a form cannot contain a form';
        if ((ancestors.includes('a') || ancestors.includes('button')) && R.interactive.some(t => subtree.has(t))) return 'interactive content cannot go inside a link or button';
        if (R.phrasingOnly.includes(parent) && R.block.some(t => subtree.has(t))) return `<${parent}> takes only inline content`;
        return null;
    }
    // Whether `piece` may be placed in `container` without the parser changing it.
    function fits(piece, container) {
        if (!piece || !container) return false;
        if (piece.parentElement === container) return true;
        const anc = [];
        for (let a = container; a && a.nodeType === 1; a = a.parentElement) anc.push(a.tagName.toLowerCase());
        // Template contents count: an x-if can render them right here (the server counts them too).
        const sub = new Set();
        const add = (root) => [root, ...root.querySelectorAll('*')].forEach(n => { if (n.nodeType !== 1) return; sub.add(n.tagName.toLowerCase()); if (n.tagName === 'TEMPLATE' && n.content) [...n.content.children].forEach(add); });
        groupOf(piece).forEach(add);
        // A component never goes inside its own markup, however deep it includes it
        const around = new Set();
        for (let a = container; a; a = a.parentElement) if (a._manifestComponent) around.add(a._manifestComponent);
        if (around.size && groupOf(piece).some(r => [r, ...r.querySelectorAll('*')].some(n => n._manifestComponent && around.has(n._manifestComponent)))) return false;
        return !contentRefusal(piece.tagName.toLowerCase(), container.tagName.toLowerCase(), anc, sub);
    }

    /* ---- Units ---- */
    const unitOf = (v) => { const m = String(v || '').match(/[a-z%]+$/i); return m ? m[0] : null; };
    function toUnit(px, unit, el, basisEl, dim) {
        if (unit === 'rem') return +(px / parseFloat(getComputedStyle(document.documentElement).fontSize)).toFixed(2);
        if (unit === 'em') return +(px / parseFloat(getComputedStyle(el).fontSize)).toFixed(2);
        if (unit === '%') { const b = (basisEl || el.parentElement).getBoundingClientRect(); const d = dim === 'w' ? b.width : b.height; return d ? +(px / d * 100).toFixed(2) : 0; }
        return Math.round(px);
    }
    function toPx(str, el, dim) {
        const v = parseFloat(str); if (isNaN(v)) return null; const u = unitOf(str) || 'px';
        if (u === 'rem') return v * parseFloat(getComputedStyle(document.documentElement).fontSize);
        if (u === 'em') return v * parseFloat(getComputedStyle(el).fontSize);
        if (u === '%') { const b = (el.parentElement || el).getBoundingClientRect(); return v / 100 * (dim === 'h' ? b.height : b.width); }
        return v;
    }
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);


    /* ---- Log ---- */
    const REVERT = '∅revert';
    let ver = 0;
    const stamps = new WeakMap();

    // Append a delta at the cursor. `join` undoes it together with the delta before it.
    function pushDelta(d, persist) {
        log.splice(cursor);
        log.push(d); cursor = log.length; ver++;
        if (persist === undefined) persist = deltaPersists(d);
        if (persist) persisted.add(d);
        saveState(); refresh();
        return d;
    }
    function deltaPersists(d) {
        if (d.kind === 'data-splice' || d.kind === 'show') return false;
        if (d.kind === 'st-move') return persistOf(d.from) && persistOf(d.to);
        return d.region != null && persistOf(d.region);
    }

    function snapshot(area, kind) {
        if (kind === 'data') return { source: dataSourceName(area), order: sortableChildren(area).map(c => itemKey(c, area)) };
        return {};
    }
    async function applySnap(area, kind, snap) {
        if (!area || !snap) return;
        if (kind === 'data') applyDataOrder(area, snap.order);
        if (isActive(area)) armArea(area);
    }
    function applyDataOrder(area, order) {
        const expr = dataSourceExpr(area), tpl = listTpl(area);
        try {
            const arr = window.Alpine.evaluate(tpl, expr); if (!Array.isArray(arr)) return;
            const byKey = new Map(arr.map(it => [String(it.id), it]));
            const next = order.map(k => byKey.get(String(k))).filter(Boolean);
            arr.forEach(it => { if (!order.map(String).includes(String(it.id))) next.push(it); });
            arr.splice(0, arr.length, ...next);
        } catch { }
    }

    /* ---- Component edits: cmp-main (every instance) / cmp-inst (one region) ---- */
    function componentState() {
        const main = {}, inst = {}, reverts = {}, sigs = {};
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind === 'cmp-main' || d.kind === 'cmp-inst') if (d.sig) sigs[d.component + '|' + d.path] = d.sig;
            if (d.kind === 'cmp-main') { (main[d.component] = main[d.component] || {}); (main[d.component][d.path] = main[d.component][d.path] || {})[d.prop] = d.value; }
            else if (d.kind === 'cmp-inst') {
                const r = d.region;
                if (d.value === REVERT) {
                    reverts[r] = reverts[r] || new Set();
                    if (d.path === '*') { delete inst[r]; reverts[r] = new Set(['*']); }
                    else { if (inst[r]) delete inst[r][d.path]; reverts[r].add(d.path); }
                } else {
                    inst[r] = inst[r] || {}; (inst[r][d.path] = inst[r][d.path] || {})[d.prop] = d.value;
                    if (reverts[r]) { reverts[r].delete(d.path); reverts[r].delete('*'); }
                }
            }
        }
        return { main, inst, reverts, sigs };
    }
    const componentNodes = (root) => [root, ...root.querySelectorAll('*')].filter(el => el._editPath != null);
    function applyComponentState() {
        const { main, inst, sigs } = componentState();
        areas().forEach(area => {
            if (classify(area) !== 'component') return;
            const comp = componentName(area), region = key(area), root = cmpRoot(area); if (!root) return;
            componentNodes(root).forEach(el => {
                const p = el._editPath;
                const expect = sigs[comp + '|' + p];
                if (expect && nodeSig(el) !== expect) { console.warn('[edit] skip stale node (structure changed):', comp, p); return; }
                const iv = (inst[region] && inst[region][p]) || {}, mv = (main[comp] && main[comp][p]) || {};
                const base = area._baseText || {}, baseC = area._baseClass || {}, baseS = area._baseStyle || {};
                const pick = (prop, fallback) => iv[prop] !== undefined ? iv[prop] : (mv[prop] !== undefined ? mv[prop] : fallback);
                const text = pick('text', base[p]), cls = pick('class', baseC[p]), sty = pick('style', baseS[p]);
                if (text !== undefined) writeText(el, text);
                if (cls !== undefined) writeClass(el, cls);
                if (sty !== undefined && el.getAttribute('style') !== sty) { if (sty === '') el.removeAttribute('style'); else el.setAttribute('style', sty); }
            });
        });
    }
    function commitComponentNode(area, el, prop, value, before) {
        const path = el._editPath, scope = area._editScope || 'instance', component = componentName(area), region = key(area);
        if (path == null) return false;
        if (prop === 'text') value = sanitizeFor(el, value);
        if (before === undefined) before = prop === 'text' ? el._preEdit : prop === 'style' ? el._preStyle : el._preClass;
        if (before === value || (prop === 'text' && before != null && sanitizeFor(el, before) === value)) return false;
        const sig = nodeSig(el);
        pushDelta(scope === 'main' ? { kind: 'cmp-main', component, path, prop, value, before, sig, region } : { kind: 'cmp-inst', component, region, path, prop, value, before, sig });
        applyComponentState();
        return true;
    }
    function revertNode(area, el) { pushDelta({ kind: 'cmp-inst', component: componentName(area), region: key(area), path: el._editPath, prop: '*', value: REVERT }); applyComponentState(); }
    function revertAll(area) { pushDelta({ kind: 'cmp-inst', component: componentName(area), region: key(area), path: '*', prop: '*', value: REVERT }); applyComponentState(); }

    /* ---- Static: per-node typed deltas + per-container child orders ----
       Every key is a canonical identity (origin region + content key), so a delta
       names the same element wherever it moves. Orders are keyed region → container
       key ('' = the region root). Baselines come from the first delta that touched a
       prop or container. */
    function staticState() {
        const node = {}, order = {}, orderBase = {}, sigs = {}, base = {}, html = {};
        const setOrder = (o, region, parent, keys, first) => {
            if (!keys) return;
            const m = o[region] = o[region] || {}, p = parent || '';
            if (first && p in m) return;
            m[p] = keys.slice();
        };
        for (let i = 0; i < log.length; i++) {
            const d = log[i];
            if (d.kind === 'st-children') { if (d.html) Object.assign(html, d.html); setOrder(orderBase, d.region, d.parent, d.before, true); }
            else if (d.kind === 'st-order') setOrder(orderBase, d.region, d.parent, d.before, true);
            else if (d.kind === 'st-move') { setOrder(orderBase, d.from, d.fromParent, d.fromBefore, true); setOrder(orderBase, d.to, d.toParent, d.toBefore, true); }
            else if (d.kind === 'st-node') {
                const b = base[d.path] = base[d.path] || {};
                if (!(d.prop in b)) b[d.prop] = d.before;
                if (d.sig) sigs[d.path] = d.sig;
            }
        }
        const touched = new Set();
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind === 'st-node') (node[d.path] = node[d.path] || {})[d.prop] = d.value;
            else if (d.kind === 'st-order' || d.kind === 'st-children') {
                setOrder(order, d.region, d.parent, d.order); touched.add(d.parent || '#' + d.region);
                if (d.copies) Object.entries(d.copies).forEach(([k, ops]) => { node[k] = Object.assign({}, ops, node[k]); });
            } else if (d.kind === 'st-move') {
                setOrder(order, d.from, d.fromParent, d.fromOrder); setOrder(order, d.to, d.toParent, d.toOrder);
                touched.add(d.fromParent || '#' + d.from); touched.add(d.toParent || '#' + d.to);
            }
        }
        return { node, order, orderBase, sigs, base, html, touched };
    }

    // Data rows: adding/removing records the record itself. In-session only.
    function commitSplice(area, index, record, op) {
        pushDelta({ kind: 'data-splice', region: key(area), source: dataSourceName(area), index, op, record: JSON.parse(JSON.stringify(record)) });
        setTimeout(() => { lastSnap[key(area)] = snapshot(area, classify(area)); }, 0);
    }
    function applySplice(d, undo) {
        const area = areaByKey(d.region); if (!area) return;
        const tpl = listTpl(area), expr = dataSourceExpr(area);
        if (!tpl || !expr) return;
        let arr; try { arr = window.Alpine.evaluate(tpl, expr); } catch { return; }
        if (!Array.isArray(arr)) return;
        const inserting = undo ? d.op === 'remove' : d.op === 'insert';
        if (inserting) arr.splice(Math.min(d.index, arr.length), 0, JSON.parse(JSON.stringify(d.record)));
        else arr.splice(d.index, 1);
        setTimeout(() => { lastSnap[d.region] = snapshot(area, classify(area)); }, 0);
    }

    const parentKey = (container, area) => container === area ? '' : (container.getAttribute('data-edit-key') || '');

    // Duplicate, delete, paste: the container's resulting order plus the markup the log
    // introduced or took away. `copies` seeds a copy's edits from its original.
    function commitStructure(area, container, before, markup, copies) {
        const order = staticKeys(container);
        if (eq(before, order) && !Object.keys(markup || {}).length) return;
        const d = { kind: 'st-children', region: key(area), parent: parentKey(container, area), order, before, html: markup || {} };
        if (copies && Object.keys(copies).length) d.copies = copies;
        pushDelta(d);
    }
    const materialize = (markup, k) => {
        if (!markup) return null;
        const t = document.createElement('template');
        t.innerHTML = markup.trim();
        const el = t.content.firstElementChild;
        if (el && k) el.setAttribute(/^[^@]*@[^@]*@X-[\w-]+:/.test(originOf(k)) ? 'data-edit-host' : 'data-edit-key', k);
        return el;
    };
    const staticAreas = () => areas().filter(a => classify(a) === 'static' && !sharedKey(a));
    // Removed elements, kept so undo puts back the same element (listeners, titling comment).
    const detached = new Map();
    function keyMap(roots) {
        const m = new Map();
        roots.forEach(area => [area, ...area.querySelectorAll('[data-edit-key]')].forEach(el => {
            if (el.closest('[data-edit-ghost]')) return;
            const k = el.getAttribute('data-edit-key');
            if (k != null && !m.has(k)) m.set(k, el);
        }));
        roots.forEach(area => area.querySelectorAll('[data-edit-host]').forEach(el => { const k = el.getAttribute('data-edit-host'); if (!m.has(k)) m.set(k, el); }));
        return m;
    }

    function applyStaticProp(el, prop, v) {
        if (v === undefined) return;
        if (prop === 'text') return writeText(el, v);
        if (attrRefusal(prop, v, el.tagName)) return;
        if (prop === 'class') return writeClass(el, v);
        if (prop === 'style') return writeStyle(el, v);
        if (v === null) { el.removeAttribute(prop); return; }
        if (el.getAttribute(prop) !== v) el.setAttribute(prop, v);
    }

    // Edits whose element is gone from the source (an external change rewrote it): shown
    // nowhere and never publishable, so they are surfaced ($edit.conflicts, `edit:conflict`,
    // a warning) and dropped from the log. Checked against a freshly rendered source only.
    function surfaceConflicts(fresh) {
        // Only regions keyed on this page load: an unarmed (gated) region has no keys yet
        const live = keyMap(staticAreas()), lost = [], regions = new Set(fresh.filter(a => a._marked).map(key));
        const isStatic = (r) => regions.has(r) && !!areaByKey(r) && classify(areaByKey(r)) === 'static';
        // Structure: a container the log restructured must still hold what the log started from.
        // Children matched by position and tag whose own text changed in place are renamed to
        // their new keys, so the reorder still applies, but only if no structural edit moved,
        // added or removed them. Otherwise every structural edit of that region goes (the
        // writer would refuse them), reported with the children that changed.
        const first = new Map(), broken = new Map(), renames = new Map();
        const note = (region, parent, before) => { const k = JSON.stringify([region, parent]); if (!first.has(k) && isStatic(region)) first.set(k, [region, parent, before || []]); };
        log.forEach(d => {
            if (d.kind === 'st-order' || d.kind === 'st-children') note(d.region, d.parent, d.before);
            if (d.kind === 'st-move') { note(d.from, d.fromParent, d.fromBefore); note(d.to, d.toParent, d.toBefore); }
        });
        const tagOf = (k) => String(k).slice(String(k).indexOf('@', 1) + 1).split(':')[0];
        // Keys a structural edit moved (out of the longest kept order), added or removed in a container
        const moved = (region, parent) => {
            const out = new Set();
            const diff = (before, after) => {
                before = before || []; after = after || [];
                before.forEach(k => { if (!after.includes(k)) out.add(k); });
                after.forEach(k => { if (!before.includes(k)) out.add(k); });
                const pos = after.filter(k => before.includes(k)).map(k => before.indexOf(k));
                const tails = [], prev = new Array(pos.length).fill(-1), idx = [];
                pos.forEach((p, i) => { let lo = 0, hi = tails.length; while (lo < hi) { const m = (lo + hi) >> 1; if (pos[tails[m]] < p) lo = m + 1; else hi = m; } if (lo > 0) prev[i] = tails[lo - 1]; tails[lo] = i; });
                const keep = new Set(); for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
                after.filter(k => before.includes(k)).forEach((k, i) => { if (!keep.has(i)) out.add(k); });
            };
            log.forEach(d => {
                if ((d.kind === 'st-order' || d.kind === 'st-children') && d.region === region && (d.parent || '') === parent) diff(d.before, d.order);
                if (d.kind === 'st-move') {
                    if (d.from === region && (d.fromParent || '') === parent) { out.add(d.key); diff(d.fromBefore, d.fromOrder); }
                    if (d.to === region && (d.toParent || '') === parent) { out.add(d.key); diff(d.toBefore, d.toOrder); }
                }
            });
            return out;
        };
        first.forEach(([region, parent, before]) => {
            let c = parent === '' ? areaByKey(region) : live.get(parent), renamedParent = null;
            if (!c && parent !== '') {
                // The container's own key changed with a child's text: found again through its unchanged children
                const holders = new Set(before.map(k => live.get(k)).filter(Boolean).map(el => el.parentElement));
                if (holders.size === 1) { c = [...holders][0]; renamedParent = c.getAttribute('data-edit-key'); }
            }
            const now = c ? staticKeys(c) : [];
            if (c && now.join('\n') === before.join('\n') && !renamedParent) return;
            const changed = [];
            before.forEach((k, i) => { if (now[i] !== k) changed.push({ was: k, now: now[i] ?? null }); });
            now.slice(before.length).forEach(k => changed.push({ was: null, now: k }));
            const shift = moved(region, parent);
            const same = !!c && now.length === before.length && before.every((k, i) => tagOf(k) === tagOf(now[i]));
            // A rename is a child whose own text changed in place: its old key is gone from the whole
            // new source and its new key is new to the log (else elements were swapped or moved,
            // which position cannot tell from a rename), its opening tag unchanged where a copy
            // recorded it. Anything else is a conflict.
            const known = new Set();
            log.forEach(d => [d.before, d.order, d.fromBefore, d.toBefore, d.fromOrder, d.toOrder].forEach(a => Array.isArray(a) && a.forEach(k => known.add(k))));
            const openTag = (el) => { const c2 = el.cloneNode(false); [...c2.attributes].forEach(a => { if (/^(data-edit-|data-rich-text|contenteditable$|role$|aria-multiline$|tabindex$)/.test(a.name)) c2.removeAttribute(a.name); }); return c2.outerHTML.replace(/<\/[^>]+>$/, ''); };
            const copyTag = (k) => { for (const d of log) if (d.kind === 'st-children' && d.html) for (const [ck, h] of Object.entries(d.html)) if (ck[0] === '~' && originOf(ck) === k) { const t = document.createElement('template'); t.innerHTML = h; const e = t.content.firstElementChild; if (e) return openTag(e); } return null; };
            const renamable = (x) => !!x.was && !!x.now && x.was[0] === '@' && !live.has(x.was) && !known.has(x.now)
                && (() => { const t = copyTag(x.was), el = live.get(x.now); return !t || !el || t === openTag(el); })();
            if (same && changed.every(x => renamable(x) && !shift.has(x.was))) {
                const m = renames.get(region) || new Map();
                changed.forEach(x => m.set(x.was, x.now));
                if (renamedParent && renamedParent !== parent) m.set(parent, renamedParent);
                renames.set(region, m);
            } else broken.set(region, [...(broken.get(region) || []), { container: parent, changed: changed.map(x => ({ was: x.was && tagOf(x.was) && x.was.slice(x.was.indexOf('@', 1) + 1), now: x.now && x.now.slice(x.now.indexOf('@', 1) + 1) })) }]);
        });
        // Renamed children keep their place in every structural edit (their own text edits stay conflicts)
        renames.forEach((m, region) => {
            if (broken.has(region)) return;
            const ren = (k) => typeof k !== 'string' ? k : m.has(k) ? m.get(k) : k[0] === '~' && m.has(originOf(k)) ? k.slice(0, k.length - originOf(k).length) + m.get(originOf(k)) : k;
            const arr = (a) => Array.isArray(a) ? a.map(ren) : a;
            const enc = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;'), dec = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            const markup = (h) => typeof h === 'string' ? h.replace(/data-edit-key="([^"]*)"/g, (all, v) => `data-edit-key="${enc(ren(dec(v)))}"`) : h;
            // A copy with no text of its own follows its source, as the writer copies it: shown = published
            const typedCopy = (k) => log.some(d => d.kind === 'st-node' && d.path === k && d.prop === 'text');
            const follow = (k, v) => {
                if (k[0] !== '~' || !m.has(originOf(k)) || typedCopy(k)) return markup(v);
                const src = live.get(m.get(originOf(k))); if (!src) return markup(v);
                const t = document.createElement('template'); t.innerHTML = blockHTML(src, true);
                const prefix = k.slice(0, k.length - originOf(k).length);
                [t.content.firstElementChild, ...t.content.firstElementChild.querySelectorAll('[data-edit-key]')].forEach(n => { const nk = n.getAttribute('data-edit-key'); if (nk && nk[0] === '@') n.setAttribute('data-edit-key', prefix + nk); });
                return t.innerHTML;
            };
            const keyed = (o) => o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [ren(k), follow(k, v)])) : o;
            log.forEach(d => {
                if ((d.kind === 'st-order' || d.kind === 'st-children') && d.region === region) { d.parent = ren(d.parent); d.before = arr(d.before); d.order = arr(d.order); if (d.html) d.html = keyed(d.html); if (d.copies) d.copies = Object.fromEntries(Object.entries(d.copies).map(([k, v]) => [ren(k), v])); }
                if (d.kind === 'st-node' && d.region === region && typeof d.path === 'string' && d.path[0] === '~') d.path = ren(d.path);   // a copy is new content: its edits follow its source's new key
                if (d.kind === 'st-move' && (d.from === region || d.to === region)) { d.key = ren(d.key); d.fromParent = ren(d.fromParent); d.toParent = ren(d.toParent); d.fromBefore = arr(d.fromBefore); d.toBefore = arr(d.toBefore); d.fromOrder = arr(d.fromOrder); d.toOrder = arr(d.toOrder); }
                if (d.kind === 'lock' && d.region === region) d.key = ren(d.key);
            });
            ver++;
        });
        const structural = (d) => ((d.kind === 'st-order' || d.kind === 'st-children') && broken.has(d.region)) || (d.kind === 'st-move' && (broken.has(d.from) || broken.has(d.to)))
            || (d.kind === 'st-node' && broken.has(d.region) && typeof d.path === 'string' && d.path[0] === '~');
        const gone = (d) => (d.kind === 'st-node' && typeof d.path === 'string' && d.path[0] === '@' && isStatic(d.region) && !live.has(d.path)) || structural(d);
        log.forEach((d, i) => { if (gone(d) && i < cursor && d.kind === 'st-node' && d.path[0] === '@') lost.push(d); });
        if (!log.some(gone)) { if (renames.size) saveState(); return []; }
        const latest = new Map();
        lost.forEach(d => latest.set(d.path + '|' + d.prop, d));
        const label = (k) => typeof k === 'string' ? originOf(k).slice(originOf(k).indexOf('@', 1) + 1) : '';
        const found = [...latest.values()].map(d => ({ region: d.region, key: d.path, element: label(d.path), prop: d.prop, value: d.value, before: d.before,
            reason: `${label(d.path)} changed in the source, so the ${d.prop === 'text' ? 'text' : d.prop} edited into it was not applied` }));
        // A dropped structure carries what it held: the children that changed, the elements it moved,
        // and every copy it made, with the copy's markup and the text typed into it
        broken.forEach((containers, region) => {
            const deltas = log.filter((d, i) => i < cursor && structural(d) && (d.region === region || d.from === region || d.to === region));
            const movedKeys = new Set(), copies = [];
            deltas.forEach(d => {
                if (d.kind === 'st-move') movedKeys.add(d.key);
                if (d.kind === 'st-order' || d.kind === 'st-children') moved(region, d.parent || '').forEach(k => movedKeys.add(k));
                if (d.kind === 'st-children' && d.html) Object.entries(d.html).forEach(([k, h]) => {
                    if (k[0] !== '~') return;
                    const t = document.createElement('template'); t.innerHTML = h;
                    const typed = log.filter((x, i) => i < cursor && x.kind === 'st-node' && x.path === k && x.prop === 'text').pop();
                    copies.push({ of: label(k), html: h, text: typed ? typed.value : t.content.textContent.trim() });
                });
            });
            const changed = containers.flatMap(c => c.changed);
            const names = [...new Set(changed.map(x => x.was || x.now))];
            const moves = [...new Set([...movedKeys].filter(k => k && k[0] === '@').map(label))];
            const what = [moves.length && `moved ${moves.join(', ')}`, copies.length && `copied ${copies.map(c => `${c.of} ("${String(c.text).slice(0, 40)}")`).join(', ')}`].filter(Boolean).join('; ');
            found.push({ region, key: '', element: containers.map(c => c.container ? label(c.container) : region).join(', '), prop: 'structure',
                value: { changed, moved: moves, copies }, before: null,
                reason: `${names.join(', ')} changed in the source where the layout was edited, so the layout edits (${what || 'reordering'}) were not applied` });
        });
        found.forEach(f => { conflicts.push(f); if (persistOf(f.region)) keptConflicts.add(f); });
        let c = 0;
        log = log.filter((d, i) => { const keep = !gone(d); if (keep && i < cursor) c++; return keep; });
        cursor = c; ver++;
        saveState(); refresh();
        if (found.length) {
            if (estore) estore.conflicts = conflicts.slice();
            console.warn('[edit] edits to elements that changed in the source were dropped:\n' + found.map(f => '  ' + f.reason + (f.prop === 'structure' ? '' : `: "${String(f.value).slice(0, 80)}"`)).join('\n'));
            document.dispatchEvent(new CustomEvent('edit:conflict', { detail: { conflicts: found } }));
        }
        return found;
    }

    // One pass over every static area: orders place elements by identity (moving them
    // between areas when the log says so), then props are applied.
    function applyStaticState() {
        const { node, order, orderBase, sigs, base, html } = staticState();
        const roots = staticAreas();
        const byId = keyMap(roots);
        const entries = [];
        new Set([...Object.keys(orderBase), ...Object.keys(order)]).forEach(region => {
            const want = Object.assign({}, orderBase[region] || {}, order[region] || {});
            Object.entries(want).forEach(([parent, keys]) => entries.push([region, parent, keys]));
        });
        const claimed = new Set();
        entries.forEach(([, , keys]) => keys.forEach(k => claimed.add(k)));
        const touchedAreas = new Set();
        const get = (k) => {
            let el = byId.get(k);
            if (!el && detached.has(k)) { el = detached.get(k); detached.delete(k); byId.set(k, el); }
            if (!el && html[k]) {
                el = materialize(html[k], k);
                if (el) { byId.set(k, el); el.querySelectorAll('[data-edit-key]').forEach(n => { const nk = n.getAttribute('data-edit-key'); if (!byId.has(nk)) byId.set(nk, n); }); }
            }
            return el;
        };
        let progress = true;
        while (entries.length && progress) {
            progress = false;
            for (let i = 0; i < entries.length; i++) {
                const [region, parent, keys] = entries[i];
                const c = parent ? byId.get(parent) : areaByKey(region);
                if (!c || !c.isConnected) continue;
                entries.splice(i--, 1); progress = true;
                let kids = sortableChildren(c);
                const next = keys.map(get).filter(el => el && el !== c && !el.contains(c));
                const stay = kids.filter(el => !next.includes(el) && !claimed.has(idOf(el)) && !html[idOf(el)]);
                // A component host's other roots go with its first
                const target = [...next, ...stay].flatMap(groupOf);
                kids = kids.flatMap(groupOf);
                if (target.length === kids.length && target.every((el, j) => el === kids[j])) continue;
                const anchor = kids.length ? kids[kids.length - 1].nextSibling : Array.from(c.children).find(pluginNode) || null;
                const leads = new Map(target.map(el => [el, el.isConnected ? leadNodes(el) : el._editLead || []]));
                kids.forEach(el => { if (target.includes(el)) return; el._editLead = leadNodes(el); el._editLead.forEach(n => n.remove()); el.remove(); const k = idOf(el); if (k) detached.set(k, el); });
                target.forEach(el => { const from = regionOf(el); if (from) touchedAreas.add(from); c.insertBefore(el, anchor && anchor.parentNode === c ? anchor : null); const l = leads.get(el); if (l.length) el.before(...l); });
                const a = regionOf(c); if (a) touchedAreas.add(a);
            }
        }
        if (touchedAreas.size) resetAreas();
        const live = touchedAreas.size ? keyMap(staticAreas()) : byId;
        live.forEach((el, p) => {
            const ops = node[p], baseline = base[p];
            if (!ops && !baseline) return;
            const expect = sigs[p]; if (expect && nodeSig(el) !== expect) { console.warn('[edit] skip stale static node', p); return; }
            const props = new Set([...Object.keys(ops || {}), ...Object.keys(baseline || {})]);
            props.forEach(prop => applyStaticProp(el, prop, ops && ops[prop] !== undefined ? ops[prop] : baseline && baseline[prop]));
        });
        touchedAreas.forEach(a => { if (!a.isConnected) return; markStatic(a); if (a._armed && isActive(a)) armArea(a); });
    }

    // One delta per committed change. `opts.before` overrides the captured baseline;
    // `opts.coalesce` folds a quick follow-up change to the same prop into the last delta.
    function commitStaticNode(area, el, prop, value, opts = {}) {
        const region = key(area), path = el.getAttribute('data-edit-key');
        if (!path || path[0] === '!') return false;
        if (prop === 'text' && RAW_EDIT.has(el.tagName)) return false;
        if (prop === 'text') value = sanitizeFor(el, value);
        let before = opts.before;
        if (before === undefined) {
            const fallback = prop === 'text' ? area._baseText && area._baseText[path] : prop === 'class' ? area._baseClass && area._baseClass[path] : prop === 'style' ? area._baseStyle && area._baseStyle[path] : el.getAttribute(prop);
            const pre = prop === 'text' ? el._preEdit : prop === 'class' ? el._preClass : prop === 'style' ? el._preStyle : undefined;
            before = pre !== undefined ? pre : fallback;
        }
        if (before === value || (prop === 'text' && before != null && sanitizeFor(el, before) === value)) return false;
        // A rich field owns its markup: the logged value is never written back into it
        if (prop === 'text' && document.activeElement !== el && !authoredRich(el)) writeText(el, value);
        const last = log[cursor - 1];
        if (opts.coalesce && last && cursor === log.length && last.kind === 'st-node' && last.region === region && last.path === path && last.prop === prop && Date.now() - (stamps.get(last) || 0) < COALESCE_MS) {
            if (last.before === value) { log.pop(); cursor--; } else { last.value = value; stamps.set(last, Date.now()); }
            ver++; saveState(); refresh();
            return true;
        }
        const d = pushDelta(Object.assign({ kind: 'st-node', region, path, prop, value, before, sig: nodeSig(el) }, opts.join ? { join: true } : {}));
        if (opts.coalesce) stamps.set(d, Date.now());
        return true;
    }

    /* ---- Data values (.data): edit $x record fields ---- */
    function dataValueState() {
        const s = {};
        for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'data-val') ((s[d.source] = s[d.source] || {})[d.id] = s[d.source][d.id] || {})[d.field] = d.value; }
        return s;
    }
    // Every field the log touches: its value at the cursor, else the first delta's before (an undo back to the start).
    function applyDataValues() {
        const st = dataValueState(), first = new Map();
        log.forEach(d => { if (d.kind === 'data-val') { const k = JSON.stringify([d.source, d.id, d.field]); if (!first.has(k)) first.set(k, d); } });
        first.forEach(d => {
            const r = (st[d.source] = st[d.source] || {})[d.id] = st[d.source][d.id] || {};
            if (!(d.field in r) && d.before !== undefined) r[d.field] = d.before;
        });
        areas().forEach(area => {
            if (classify(area) !== 'data') return;
            const source = dataSourceName(area), recs = st[source]; if (!recs) return;
            const tpl = listTpl(area), expr = dataSourceExpr(area);
            try { const arr = window.Alpine.evaluate(tpl, expr); if (Array.isArray(arr)) Object.entries(recs).forEach(([id, fields]) => { const rec = arr.find(r => String(r.id) === String(id)); if (rec) Object.entries(fields).forEach(([f, v]) => { if (rec[f] !== v) rec[f] = v; }); }); } catch { }
            if (isActive(area)) setTimeout(() => armDataValues(area), 0);
        });
    }
    function commitDataValue(area, source, id, field, value, el) {
        value = String(value);
        if (el && el._editRich) value = sanitizeFor(el, value);
        const before = el ? el._preEdit : undefined;
        if (before === value || (el && el._editRich && before != null && sanitizeFor(el, before) === value)) return false;
        pushDelta({ kind: 'data-val', region: key(area), source, id, field, value, before });
        applyDataValues();
        return true;
    }

    // Size and freeform placement write inline style; plugin-applied declarations stay out.
    function commitStyle(area, el, opts) {
        const v = ownStyle(el), kind = classify(area);
        if (kind === 'component') return commitComponentNode(area, el, 'style', v);
        if (kind === 'static') return commitStaticNode(area, el, 'style', v, opts);
        return false;
    }
    function commitOrder(area, container, before) {
        const order = staticKeys(container);
        if (eq(before, order)) return false;
        pushDelta({ kind: 'st-order', region: key(area), parent: parentKey(container, area), order, before });
        return true;
    }
    // A piece that already sits in its new container. Identity never changes, so one
    // delta names both containers' orders, within an area or across areas.
    function commitMove(fromArea, toArea, item, fromContainer, fromBefore, toBefore, opts = {}) {
        const toContainer = item.parentElement;
        const d = { kind: 'st-move', from: key(fromArea), to: key(toArea), fromParent: parentKey(fromContainer, fromArea), toParent: parentKey(toContainer, toArea), key: idOf(item), fromOrder: staticKeys(fromContainer), toOrder: staticKeys(toContainer), fromBefore, toBefore };
        if (opts.join) d.join = true;
        pushDelta(d);
        resetAreas();
        markStatic(toArea);
        if (isActive(fromArea)) armArea(fromArea);
        if (toArea !== fromArea && isActive(toArea)) armArea(toArea);
        return d;
    }

    /* ---- Locks: runtime per-action locks, logged ---- */
    // Static identities are global (they survive moves between areas); others are per area.
    const lockSlot = (region, id) => /^[~@]/.test(id) ? id : region + '|' + id;
    let lockVer = -1, lockMap = new Map();
    function lockState() {
        if (lockVer === ver) return lockMap;
        lockMap = new Map();
        for (let i = 0; i < cursor; i++) {
            const d = log[i]; if (d.kind !== 'lock') continue;
            const slot = lockSlot(d.region, d.key);
            const m = lockMap.get(slot) || new Map(); lockMap.set(slot, m);
            (d.actions && d.actions.length ? d.actions : LOCK_ACTIONS).forEach(a => m.set(a, d.value));
        }
        lockVer = ver;
        return lockMap;
    }
    const lockStateNow = () => lockState();
    function identity(el, area) {
        const kind = classify(area);
        if (kind === 'static') return el.getAttribute('data-edit-key');
        if (el === area) return '';
        if (kind === 'component') return el._editPath != null ? 'path:' + el._editPath : null;
        const list = listTpl(area);
        if (list && el.parentElement === list.parentElement) { const k = itemKey(el, area); return k == null ? null : 'row:' + k; }
        return null;
    }
    const actionOf = (cap) => cap === 'data' ? 'text' : cap === 'class' ? 'attrs' : cap;
    // A component host's lock is keyed by its host key and covers its group and what is in it.
    const hostOf = (n) => isHostEl(n) ? n : extraRoot(n) ? n._manifestHost.roots[0] : null;
    function lockedFor(node, cap) {
        const action = actionOf(cap);
        const h0 = node && node.nodeType === 1 && hostOf(node);
        if (h0) node = h0;
        let region = h0 ? blockArea(h0) : regionOf(node);
        const locks = lockState();
        for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
            let v;
            const h = hostOf(n);
            if (h && locks.size) { const m = locks.get(h.getAttribute('data-edit-host')); if (m && m.has(action)) v = m.get(action); }
            if (v === undefined && region && locks.size && !(h && n === h0)) { const id = identity(n, region); const m = id != null && locks.get(lockSlot(key(region), id)); if (m && m.has(action)) v = m.get(action); }
            if (v === undefined && n._editLock) v = n._editLock.has('*') || n._editLock.has(action);
            if (v) return true;
            if (n === region) { if (h && n !== h0) { region = blockArea(n); if (region) continue; } break; }
        }
        return false;
    }
    function setLock(el, action, value) {
        if (!el || el.nodeType !== 1) return false;
        const h = hostOf(el);
        const area = h ? blockArea(h) : regionOf(el); if (!area) return false;
        if (action != null && !LOCK_ACTIONS.includes(action)) { console.warn('[edit] unknown lock action:', action); return false; }
        if (h) { pushDelta({ kind: 'lock', region: key(area), key: h.getAttribute('data-edit-host'), actions: action ? [action] : [], value: !!value }); rearm(area); if (h._edit) rearm(h); return true; }
        const id = identity(el, area);
        if (id == null) { console.warn('[edit] this element has no stable identity to lock'); return false; }
        pushDelta({ kind: 'lock', region: key(area), key: id, actions: action ? [action] : [], value: !!value });
        rearm(area);
        return true;
    }
    function rearm(area) { if (area && area._armed) { disarmArea(area); if (isActive(area)) armArea(area); } }

    /* ---- Data area snapshots ---- */
    function commit(area) {
        if (!area) return;
        const k = key(area), kind = classify(area), after = snapshot(area, kind), before = lastSnap[k];
        if (before && eq(before, after)) return;
        pushDelta({ region: k, kind, before: before ?? after, after });
        lastSnap[k] = after;
    }
    const dispatchApply = (d) => {
        if (d.kind === 'cmp-main' || d.kind === 'cmp-inst') applyComponentState();
        else if (d.kind === 'data-val') applyDataValues();
        else if (d.kind === 'theme') applyThemeState();
        else if (d.kind === 'lock') rearm(areaByKey(d.region));
        else applyStaticState();
    };
    // Returns a promise only when a data snapshot must settle, so undo stays synchronous otherwise.
    function applyShow(d, back) {
        const area = areaByKey(d.region); if (!area) return;
        const el = d.key === '' ? area : [area, ...area.querySelectorAll('[x-show]')].find(n => identity(n, area) === d.key);
        if (!el) return;
        try { setShow(el, d.expr, back ? d.before : d.value); } catch { }
    }
    function step(d, back) {
        if (d.kind === 'show') { applyShow(d, back); return null; }
        if (d.kind === 'data-splice') applySplice(d, back);
        else if (d.kind === 'data') { const snap = back ? d.before : d.after; lastSnap[d.region] = snap; return applySnap(areaByKey(d.region), d.kind, snap); }
        else dispatchApply(d);
        return null;
    }
    async function undo() {
        if (cursor === 0) return;
        let d;
        do { d = log[--cursor]; ver++; const p = step(d, true); if (p) await p; } while (d.join && cursor > 0);
        rebaseFocused(); saveState(); refresh();
    }
    async function redo() {
        if (cursor >= log.length) return;
        do { const d = log[cursor++]; ver++; const p = step(d, false); if (p) await p; } while (cursor < log.length && log[cursor].join);
        rebaseFocused(); saveState(); refresh();
    }

    /* ---- Projections ---- */
    function fold() { const s = {}; for (let i = 0; i < cursor; i++) { const d = log[i]; if (d.kind === 'data') s[d.region] = { kind: d.kind, snap: d.after }; } return s; }
    const patchFor = (r, kind, snap) => ({ region: r, kind, op: 'reorderData', source: snap.source, order: snap.order });


    /* ---- Pieces and block operations ---- */
    let clipboard = null;
    let target = null;

    const bump = () => { if (estore) estore.version = (estore.version || 0) + 1; };
    const setTarget = (el) => { target = el; bump(); };

    // The innermost structural piece holding a node: a child of a container (static),
    // a row of the list (data), or a path-addressed node (component).
    function pieceOf(node) {
        if (node && node.nodeType !== 1) node = node.parentElement;
        const area = regionOf(node);
        // A component host is one piece of the area around it, whatever inside it was hit.
        if (isHostEl(node) && blockArea(node) && classify(blockArea(node)) === 'static') return node;
        if (!area || node === area) return null;
        const kind = classify(area);
        if (kind === 'data') {
            const tpl = listTpl(area), list = tpl && tpl.parentElement;
            for (let n = node; n && n !== area; n = n.parentElement) if (n.parentElement === list) return n;
            return null;
        }
        if (kind === 'component') {
            for (let n = node; n && n !== area; n = n.parentElement) if (n._editPath != null) return n;
            return null;
        }
        let host = null;
        for (let n = node; n && n !== area; n = n.parentElement) if (isHostEl(n) || extraRoot(n)) host = isHostEl(n) ? n : n._manifestHost.roots[0];
        if (host) return host;
        for (let n = node; n && n !== area; n = n.parentElement) {
            if (pluginNode(n)) return null;
            if (isContainer(n.parentElement)) return n;
        }
        return null;
    }
    const isPiece = (el) => !!el && el.nodeType === 1 && pieceOf(el) === el;
    const asPiece = (el) => isPiece(el) ? el : pieceOf(el);
    const blockArea = (el) => el && regionOf(el.parentElement);
    const isRegionBlock = (el) => !!el && (!!el._edit || el.hasAttribute('data-edit-area'));
    // A piece can be dragged when its container moves and nothing up to the region locks it.
    const movable = (el) => !!el && !!el.parentElement && !pluginNode(el) && !insideRendered(el) && capOf(el.parentElement, 'move') && !lockedFor(el, 'move') && classify(regionOf(el.parentElement)) !== 'component';
    function accepts(c) {
        if (!c || c.nodeType !== 1) return false;
        const area = regionOf(c);
        if (!area || !isActive(area) || !isContainer(c)) return false;
        for (let n = c; n && n !== area; n = n.parentElement) if (n._manifestComponent) return false;   // a host's markup is another file's
        return capOf(c, 'move');
    }

    // Markup without plugin affordances. `keepKeys` keeps identity so undo restores it.
    function blockHTML(el, keepKeys) {
        const c = el.cloneNode(true);
        const src = [el, ...el.querySelectorAll('*')], dst = [c, ...c.querySelectorAll('*')];
        dst.forEach((n, i) => { if (addedTab.has(src[i])) n.removeAttribute('tabindex'); });
        unrich(el, c);
        c.querySelectorAll('[data-edit-handle], [data-edit-live], [data-edit-ghost], [data-edit-grip]').forEach(n => n.remove());
        [c, ...c.querySelectorAll('*')].forEach(n => {
            [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-') && !(keepKeys && a.name === 'data-edit-key')) n.removeAttribute(a.name); });
            n.removeAttribute('contenteditable');
            n.removeAttribute('draggable');
        });
        return c.outerHTML;
    }

    /* ---- Data regime: the array is the truth ---- */
    function dataOps(area) {
        const tpl = listTpl(area), expr = dataSourceExpr(area);
        if (!tpl || !expr) return null;
        try { const arr = window.Alpine.evaluate(tpl, expr); return Array.isArray(arr) ? arr : null; } catch { return null; }
    }
    const recordIndex = (area, el) => {
        const arr = dataOps(area); if (!arr) return -1;
        const k = itemKey(el, area);
        return arr.findIndex(it => String(it && it.id != null ? it.id : it) === String(k));
    };
    function freshId(arr, id) {
        const taken = new Set(arr.map(it => String(it && it.id)));
        if (!taken.has(String(id))) return String(id);
        let n = 2, next = `${id}-copy`;
        while (taken.has(next)) next = `${id}-copy-${n++}`;
        return next;
    }

    /* ---- can() ---- */
    const ACTIONS = ['move', 'remove', 'duplicate', 'text', 'attrs', 'class', 'size', 'copy', 'cut', 'paste'];
    // Static areas take only static pieces (they carry source identity); a list takes any.
    const pasteFits = (area) => !!area && !!clipboard && (classify(area) !== 'static' || clipboard.kind === 'static');
    function pasteDest(el) {
        const block = el ? asPiece(el) : null;
        if (block) return accepts(block.parentElement) ? block.parentElement : null;
        const area = areas().find(a => isActive(a) && accepts(a));
        return area || null;
    }
    function canDo(action, el) {
        if (!ACTIONS.includes(action)) return false;
        if (action === 'paste') { const d = clipboard && pasteDest(el); return !!d && pasteFits(regionOf(d)); }
        if (!el || el.nodeType !== 1 || insideRendered(el)) return false;
        // A component host moves, duplicates and goes as a piece of the area around it
        if (isHostEl(el) && (action === 'move' || action === 'duplicate' || action === 'remove')) {
            const outer = blockArea(el);
            if (!outer || !isActive(outer)) return false;
            if (action === 'move') return movable(el);
            return capOf(el.parentElement, 'move') && !lockedFor(el, action);
        }
        const area = regionOf(el);
        if (!area || !isActive(area)) return false;
        const kind = classify(area);
        if (action === 'size') return !!el._edit && el._edit.caps.has('size') && !lockedFor(el, 'size');
        // Text: an editable leaf (or a rich-editor host), never a container or a bound element.
        if (action === 'text') return capOf(el, 'text') && !el.hasAttribute('x-text') && !el.hasAttribute('x-html')
            && (el.getAttribute('contenteditable') === 'true' || !!el._pieceMode || el.hasAttribute('data-rich-text') || (el._editField != null && capOf(el, 'data')));
        // attrs: any attribute (static elements); class: the class list (static and component nodes).
        if ((action === 'attrs' || action === 'class') && kind === 'static' && el._manifestComponent) return false;
        if (action === 'attrs' || action === 'class') {
            if (kind === 'data' || lockedFor(el, 'attrs')) return false;
            const host = leafHost(el);
            if (host) return action === 'attrs' && capOf(host, 'text');   // inside text: through the leaf's text, never classes
            if (kind === 'component') return action === 'class' && el._editPath != null;
            const k = el.getAttribute('data-edit-key');
            return !!k && k[0] !== '!';
        }
        if (kind === 'component') return false;
        const block = asPiece(el);
        if (!block) return false;
        if (action === 'copy') return !isHostEl(block);
        if (action === 'cut') return canDo('copy', block) && canDo('remove', block);   // a cut is a copy and a remove
        if (action === 'move') return movable(block);
        const lockAs = action === 'duplicate' ? 'duplicate' : 'remove';
        return capOf(block.parentElement, 'move') && !lockedFor(block, lockAs);
    }

    function copyBlock(el) {
        const block = asPiece(el === undefined ? target : el); if (!block) return false;
        const area = blockArea(block); if (!area) return false;
        clipboard = { html: blockHTML(block, true), ops: subtreeOps(block), source: key(area), kind: classify(area) };
        bump();
        return true;
    }

    // The edits a subtree carries now, keyed by identity, for a copy to start from.
    function subtreeOps(el) {
        const ss = staticState(), ops = {};
        [el, ...el.querySelectorAll('[data-edit-key]')].forEach(n => { const k = n.getAttribute('data-edit-key'); if (k && ss.node[k]) ops[k] = Object.assign({}, ss.node[k]); });
        return ops;
    }
    // A copy gets fresh identities that still name the source element it copies.
    function stampCopy(made, ops) {
        const id = mint(), copies = {};
        [made, ...made.querySelectorAll('[data-edit-key]')].forEach(n => {
            const k = n.getAttribute('data-edit-key');
            if (!k || k[0] === '!') { n.setAttribute('data-edit-key', '!' + mint()); return; }
            const ck = '~' + id + '~' + originOf(k);
            n.setAttribute('data-edit-key', ck);
            if (ops && ops[k]) copies[ck] = Object.assign({}, ops[k]);
        });
        return copies;
    }
    function insertStatic(area, container, made, after, ops) {
        const before = staticKeys(container);
        const copies = stampCopy(made, ops);
        if (after) after.after(made); else container.appendChild(made);
        markStatic(area); armArea(area);
        commitStructure(area, container, before, { [made.getAttribute('data-edit-key')]: blockHTML(made, true) }, copies);
    }

    function duplicateBlock(el) {
        const block = asPiece(el === undefined ? target : el); if (!canDo('duplicate', block)) return false;
        const area = blockArea(block);
        if (classify(area) === 'data') {
            const arr = dataOps(area), i = recordIndex(area, block);
            if (!arr || i < 0) return false;
            const copy = JSON.parse(JSON.stringify(arr[i]));
            if (copy && copy.id != null) copy.id = freshId(arr, copy.id);
            arr.splice(i + 1, 0, copy);
            commitSplice(area, i + 1, copy, 'insert');
            return true;
        }
        if (isHostEl(block)) return duplicateHost(area, block);
        const made = materialize(blockHTML(block, true));
        if (!made) return false;
        insertStatic(area, block.parentElement, made, block, subtreeOps(block));
        return true;
    }
    // A new instance of the component: its host copied in the source; on the page, its roots.
    function duplicateHost(area, block) {
        const container = block.parentElement, before = staticKeys(container), roots = groupOf(block);
        const made = roots.map(r => materialize(blockHTML(r)));
        if (made.some(m => !m)) return false;
        const host = { roots: made }, k = '~' + mint() + '~' + originOf(idOf(block));
        made.forEach(m => { m._manifestComponent = block._manifestComponent; m._manifestHost = host; m.removeAttribute('data-component'); });
        made[0].setAttribute('data-edit-host', k);
        roots[roots.length - 1].after(...made);
        markStatic(area); armArea(area);
        commitStructure(area, container, before, { [k]: made[0].outerHTML });
        return true;
    }

    function removeBlock(el) {
        const block = asPiece(el === undefined ? target : el); if (!canDo('remove', block)) return false;
        const area = blockArea(block);
        if (classify(area) === 'data') {
            const arr = dataOps(area), i = recordIndex(area, block);
            if (!arr || i < 0) return false;
            const gone = arr[i];
            arr.splice(i, 1);
            commitSplice(area, i, gone, 'remove');
            if (target === block) setTarget(null);
            return true;
        }
        const container = block.parentElement, before = staticKeys(container);
        const gone = idOf(block), markup = isHostEl(block) ? block.outerHTML : blockHTML(block, true);
        block._editLead = leadNodes(block);
        block._editLead.forEach(n => n.remove());
        groupOf(block).slice(1).forEach(n => n.remove());
        block.remove();
        detached.set(gone, block);
        if (target === block || (target && block.contains(target))) setTarget(null);
        commitStructure(area, container, before, { [gone]: markup });
        return true;
    }

    const cutBlock = (el) => { const b = asPiece(el === undefined ? target : el); return canDo('remove', b) && copyBlock(b) && removeBlock(b); };

    // Programmatic move: into `dest` (container element or x-edit key) before `ref`, or at the end.
    function moveBlock(el, dest, ref) {
        const block = asPiece(el == null ? target : el);
        if (!block || !movable(block)) return false;
        const from = blockArea(block);
        const container = typeof dest === 'string' ? areaByKey(dest) : dest;
        if (!container || container.nodeType !== 1 || container === block || block.contains(container)) return false;
        const to = regionOf(container);
        if (!from || !to || !isActive(from) || !isActive(to) || !accepts(container)) return false;
        if (ref && ref.parentElement !== container) ref = null;
        const fromContainer = block.parentElement;
        if (!fits(block, container)) return false;
        if (classify(from) === 'data') {
            if (container !== fromContainer) return false;
            moveWith(block, b => container.insertBefore(b, ref ? startOf(ref) : null));
            finishReorder(from, container);
            return true;
        }
        if (classify(from) !== 'static' || classify(to) !== 'static') return false;
        if (from !== to && isRegionBlock(block) && !isHostEl(block)) return false;
        const fromBefore = staticKeys(fromContainer), toBefore = staticKeys(container);
        moveWith(block, b => container.insertBefore(b, ref ? startOf(ref) : null));
        if (container === fromContainer) return commitOrder(from, container, fromBefore);
        commitMove(from, to, block, fromContainer, fromBefore, toBefore);
        return true;
    }

    function pasteBlock(el) {
        if (!clipboard) return false;
        const container = pasteDest(el === undefined ? target : el); if (!container) return false;
        const block = asPiece(el === undefined ? target : el);
        const area = regionOf(container);
        if (!pasteFits(area)) return false;
        if (classify(area) === 'data') {
            const arr = dataOps(area); if (!arr) return false;
            const at = block ? recordIndex(area, block) + 1 : arr.length;
            const t = document.createElement('template'); t.innerHTML = clipboard.html;
            const record = { id: freshId(arr, 'pasted'), label: (t.content.textContent || '').trim() };
            arr.splice(at, 0, record);
            commitSplice(area, at, record, 'insert');
            return true;
        }
        if (classify(area) !== 'static') return false;
        const made = materialize(clipboard.html); if (!made || !fits(made, container)) return false;
        insertStatic(area, container, made, block && block.parentElement === container ? block : null, clipboard.ops);
        return true;
    }

    /* ---- Block hotkeys (outside text) ---- */
    const inText = (e) => e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    function onBlockKey(e, block) {
        if (inText(e)) return false;
        const meta = e.metaKey || e.ctrlKey, k = (e.key || '').toLowerCase();
        if (meta && k === 'c') return copyBlock(block);
        if (meta && k === 'x') return cutBlock(block);
        if (meta && k === 'v') return pasteBlock(block);
        if (meta && k === 'd') return duplicateBlock(block);
        if (!meta && (e.key === 'Delete' || e.key === 'Backspace')) return removeBlock(block);
        return false;
    }

    // Right-click records the piece under the pointer before any menu opens.
    function onContextCapture(e) {
        const area = regionOf(e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement);
        if (!area || !isActive(area)) return;
        setTarget(pieceOf(e.target));
    }
    const setBlockTarget = (el) => setTarget(el && el.nodeType === 1 ? asPiece(el) || el : null);


    /* ---- Move: one pointer engine for reorder, nest, un-nest and cross-area moves ----
       Keyboard: Alt+Up/Down steps among siblings, Alt+Right nests into the previous
       container, Alt+Left moves out one level. Space/Enter grabs, arrows move, Enter drops.
       After a drop, CSS decides: in flow the piece takes DOM order; absolutely positioned
       it lands at the drop point.
         --edit-drop-reach   48px   how far outside another area a drop still lands in it */
    const isPositioned = (el) => { const p = getComputedStyle(el).position; return p === 'absolute' || p === 'fixed'; };
    const addedTab = new WeakSet();
    let grabbed = null, liveRegion;
    function announce(msg) { if (!liveRegion || !liveRegion.isConnected) { liveRegion = document.createElement('div'); liveRegion.setAttribute('data-edit-live', ''); liveRegion.setAttribute('aria-live', 'polite'); document.body.appendChild(liveRegion); } liveRegion.textContent = msg; }

    function collectPieces(area) {
        const kind = classify(area);
        if (kind === 'component') return [];
        if (kind === 'data') { const tpl = listTpl(area); return tpl ? sortableChildren(tpl.parentElement) : []; }
        const out = [];
        const walk = (c) => sortableChildren(c).forEach(ch => { if (ch.closest('[data-edit-ghost]')) return; if (ch._manifestComponent) { if (isHostEl(ch)) out.push(ch); return; } out.push(ch); if (isContainer(ch) && !isRendered(ch)) walk(ch); });
        if (isContainer(area)) walk(area);
        return out;
    }
    function unmarkPiece(el) { el.removeAttribute('data-edit-piece'); if (addedTab.has(el)) { el.removeAttribute('tabindex'); addedTab.delete(el); } }
    function markPieces(area) {
        const want = new Set(collectPieces(area).filter(movable));
        area.querySelectorAll('[data-edit-piece]').forEach(el => { if (!want.has(el) && regionOf(el.parentElement) === area) unmarkPiece(el); });
        want.forEach(el => {
            el.setAttribute('data-edit-piece', '');
            if (!el.hasAttribute('tabindex')) { el.tabIndex = 0; addedTab.add(el); }
        });
    }

    const flowAxis = (c) => { const cs = getComputedStyle(c); return /grid/.test(cs.display) || (/flex/.test(cs.display) && !String(cs.flexDirection || '').startsWith('column')) ? 'x' : 'y'; };
    // Beside a hovered piece: before it when the pointer is in its leading half.
    function beside(el, x, y, parent) {
        const r = el.getBoundingClientRect(), horiz = flowAxis(parent) === 'x';
        const lead = horiz ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
        let ref = lead ? el : groupOf(el).pop().nextElementSibling;
        while (ref && (ref === dragged || ref.hasAttribute('data-edit-dragging'))) ref = ref.nextElementSibling;
        return { container: parent, ref };
    }
    // Middle band of a container nests; its edges insert before/after it.
    function inBand(r, horiz, x, y) {
        const lo = horiz ? r.left : r.top, size = horiz ? r.width : r.height, p = horiz ? x : y;
        if (!size) return true;
        const edge = Math.min(size * 0.25, 24);
        return p >= lo + edge && p <= lo + size - edge;
    }
    const inMiddle = (el, x, y, parent) => inBand(el.getBoundingClientRect(), flowAxis(parent) === 'x', x, y);
    const dropValid = (a) => !!a && !!a._edit && accepts(a) && classify(a) === 'static' && topArea(a);
    // Another area under the pointer, else the nearest within reach.
    function dropArea(x, y, origin) {
        const hit = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
        let hitArea = hit && regionOf(hit);
        if (hitArea && hitArea !== origin && origin.contains(hitArea)) hitArea = origin;   // a component region inside: its host is one piece here
        if (hitArea && dropValid(hitArea)) return hitArea;
        const cands = [origin, ...document.querySelectorAll('[data-edit-drop-target]')].filter((a, i, all) => dropValid(a) && all.indexOf(a) === i);
        const inside = (r, pad) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
        let best = null, bestD = Infinity;
        for (const a of cands) {
            const r = a.getBoundingClientRect();
            const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
            const reach = toPx(cssVar(a, '--edit-drop-reach', ''), a, 'w') ?? 48;
            const p = a.parentElement;
            const column = p && p !== document.body && p !== document.documentElement && !cands.some(o => o !== a && p.contains(o)) && inside(p.getBoundingClientRect(), 0);
            if ((inside(r, reach) || column) && d < bestD) { best = a; bestD = d; }
        }
        return best;
    }
    function dropTarget(x, y, s) {
        if (s.dataList) return { container: s.home, ref: afterElement(s.home, x, y) };
        // Nested: the container's bands stay where they were before the ghost went in
        // (its size and the layout around it change once it does).
        const n = s.nested;
        if (n && n.el.isConnected && s.ghost.parentElement === n.el && x >= n.rect.left && x <= n.rect.right && y >= n.rect.top && y <= n.rect.bottom && inBand(n.rect, n.horiz, x, y)) return { container: n.el, ref: afterElement(n.el, x, y) };
        s.nested = null;
        const region = s.crossOK ? dropArea(x, y, s.area) : s.area;
        if (!region) return null;
        const hit = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
        // Over the stand-in itself: it stays where it is
        if (hit && s.ghost && (hit === s.ghost || s.ghost.contains(hit))) return null;
        if (hit && hit !== region && region.contains(hit)) {
            // Inside a component host: the host is what is hit (its markup is another file's)
            let from = hit;
            for (let n = hit; n && n !== region; n = n.parentElement) if (isHostEl(n) || extraRoot(n)) from = isHostEl(n) ? n : n._manifestHost.roots[0];
            for (let el = from; el && el !== region; el = el.parentElement) {
                if (el === s.item || s.item.contains(el) || pluginNode(el)) continue;
                const parent = el.parentElement;
                if (!isContainer(parent)) continue;
                if (isHostEl(el)) { if (accepts(parent) && fits(s.item, parent) && !s.item.contains(parent)) return beside(el, x, y, parent); continue; }
                // Over the container the piece came from, or one holding the stand-in (a gap, its padding):
                // it stays in, placed by reading order; it leaves only when the pointer does
                if (s.ghost && (el === s.home || el.contains(s.ghost)) && accepts(el) && fits(s.item, el)) return { container: el, ref: afterElement(el, x, y) };
                if (isContainer(el) && accepts(el) && fits(s.item, el) && inMiddle(el, x, y, parent)) {
                    if (s.ghost && s.ghost.parentElement !== el) s.nested = { el, rect: el.getBoundingClientRect(), horiz: flowAxis(parent) === 'x' };
                    return { container: el, ref: afterElement(el, x, y) };
                }
                if (accepts(parent) && fits(s.item, parent) && !s.item.contains(parent)) return beside(el, x, y, parent);
            }
        }
        if (!s.crossOK && (!hit || !region.contains(hit))) { const c = s.ghost.parentElement; return { container: c, ref: afterElement(c, x, y) }; }
        return accepts(region) && fits(s.item, region) ? { container: region, ref: afterElement(region, x, y) } : null;
    }
    // Reading-order insertion: the first sibling past the pointer.
    function afterElement(c, x, y) {
        const column = flowAxis(c) === 'y';
        for (const el of sortableChildren(c)) {
            if (el === dragged || el.hasAttribute('data-edit-dragging') || lockedFor(el, 'move')) continue;
            const b = el.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
            // Stacked rows: past a row once the pointer is past its middle (wherever it is across)
            if (column && !/inline/.test(getComputedStyle(el).display)) { if (cy > y) return el; continue; }
            const sameRow = Math.abs(cy - y) < b.height / 2;
            if (cy - y > b.height / 2 || (sameRow && cx > x)) return el;
        }
        return null;
    }
    // Drop point in the piece's own units, relative to its offset parent.
    function placeAt(el, x, y, s) {
        const op = el.offsetParent || el.parentElement, r = op.getBoundingClientRect();
        let left = x - s.grabX - r.left - (op.clientLeft || 0) + (op.scrollLeft || 0);
        let top = y - s.grabY - r.top - (op.clientTop || 0) + (op.scrollTop || 0);
        const maxL = op.clientWidth - el.offsetWidth, maxT = op.clientHeight - el.offsetHeight;
        left = maxL > 0 ? clamp(left, 0, maxL) : Math.max(0, left);
        top = maxT > 0 ? clamp(top, 0, maxT) : Math.max(0, top);
        el.style.left = toUnit(left, s.lu, el, op, 'w') + s.lu;
        el.style.top = toUnit(top, s.tu, el, op, 'h') + s.tu;
    }
    const clearPlacement = (el) => { el.style.removeProperty('left'); el.style.removeProperty('top'); if (!el.getAttribute('style')) el.removeAttribute('style'); };
    const keysWithout = (c, item) => staticKeys(c).filter((k, i) => sortableChildren(c)[i] !== item);

    function onAreaPointerDown(e) {
        const area = this;
        if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0) || e._editDrag) return;
        const t = e.target;
        if (!t || t.nodeType !== 1 || t.isContentEditable || t.hasAttribute('data-edit-handle')) return;
        if (t._pieceMode) { exitPieceMode(t); return; }
        let item = null;
        for (let n = t; n && n !== area; n = n.parentElement) if (n.hasAttribute('data-edit-piece') && movable(n)) { item = n; break; }
        if (!item) return;
        e._editDrag = true;
        startDrag(e, item, area);
    }

    /* ---- Grip: text pieces, whose surface is for typing, drag from a handle at their inline-start edge ---- */
    let grip = null, gripFor = null, gripHovered = null, gripFocused = null, gripListening = false;
    // Text pieces, and rows that are themselves a data field (their surface is for typing too)
    const needsGrip = (p) => !!p && movable(p) && ((isTextEl(p) && capOf(p, 'text')) || p._editField != null);
    function gripPiece(node, area) {
        for (let n = node; n && n.nodeType === 1 && n !== area; n = n.parentElement) if (n.hasAttribute('data-edit-piece')) return needsGrip(n) ? n : null;
        return null;
    }
    function ensureGrip() {
        if (grip && grip.isConnected) return grip;
        grip = document.createElement('span');
        grip.setAttribute('data-edit-grip', '');
        grip.setAttribute('aria-hidden', 'true');
        grip.hidden = true;
        grip.addEventListener('pointerdown', onGripDown);
        grip.addEventListener('pointerleave', (e) => gripLeave(e.relatedTarget));
        document.body.appendChild(grip);
        if (!gripListening) {
            gripListening = true;
            window.addEventListener('scroll', placeGrip, { capture: true, passive: true });
            window.addEventListener('resize', placeGrip, { passive: true });
        }
        return grip;
    }
    function placeGrip() {
        if (!gripFor || !grip) return;
        if (!gripFor.isConnected) return hideGrip();
        const r = gripFor.getBoundingClientRect(), rtl = getComputedStyle(gripFor).direction === 'rtl';
        grip.dir = rtl ? 'rtl' : 'ltr';
        grip.style.top = r.top + 'px';
        grip.style.left = (rtl ? r.right : r.left) + 'px';
    }
    function showGrip(piece) {
        const area = regionOf(piece);
        if (dragged || !area || area._edit.bare || piece.closest('[data-edit-area="bare"]')) return hideGrip();
        const g = ensureGrip();
        // The grip lives on <body>: it takes the piece's own accent and sizes
        ['--edit-accent', '--edit-grip-size', '--edit-grip-offset'].forEach(v => { const x = rawVar(piece, v); if (x) g.style.setProperty(v, x); else g.style.removeProperty(v); });
        gripFor = piece; placeGrip(); g.hidden = false;
    }
    function hideGrip() { gripFor = null; if (grip) grip.hidden = true; }
    function gripOver(e, area) {
        if (dragged) return;
        const p = gripPiece(e.target, area);
        gripHovered = p;
        if (p) showGrip(p); else if (gripFocused) showGrip(gripFocused); else hideGrip();
    }
    function gripLeave(to) {
        if (to && grip && (to === grip || (gripFor && gripFor.contains(to)))) return;
        gripHovered = null;
        if (gripFocused && gripFocused.isConnected) showGrip(gripFocused); else hideGrip();
    }
    function gripFocus(e, area) {
        const p = gripPiece(e.target, area);
        gripFocused = p;
        if (p && !(gripHovered && gripHovered.isConnected)) showGrip(p);
    }
    function gripBlur(to) {
        if (to && gripFocused && gripFocused.contains(to)) return;
        gripFocused = null;
        if (!(gripHovered && gripHovered.isConnected)) hideGrip();
    }
    function onGripDown(e) {
        const piece = gripFor;
        if (!piece || (e.pointerType === 'mouse' && e.button !== 0)) return;
        const area = regionOf(piece);
        if (!isActive(area) || !movable(piece)) return;
        e.preventDefault(); e.stopPropagation();
        hideGrip();
        startDrag(e, piece, area);
    }

    function startDrag(e, item, area) {
        const home = item.parentElement, homeNext = groupOf(item).pop().nextElementSibling, rest = groupOf(item).slice(1);
        const dataList = classify(area) === 'data';
        const s = {
            item, area, home, dataList, ghost: null,
            crossOK: !dataList && classify(area) === 'static' && (isHostEl(item) || !isRegionBlock(item)),
            homeBefore: dataList ? null : staticKeys(home),
            lu: unitOf(item.style.left) || 'px', tu: unitOf(item.style.top) || 'px'
        };
        const start = item.getBoundingClientRect(), preStyle = item.getAttribute('style'), preOwn = ownStyle(item), lead = leadNodes(item);
        s.grabX = e.clientX - start.left; s.grabY = e.clientY - start.top;
        const sx = e.clientX, sy = e.clientY;
        let active = false, frame = 0, px = sx, py = sy, last = null;

        const lift = (ev) => {
            if (s.crossOK) areas().forEach(a => { if (a !== area && dropValid(a)) a.setAttribute('data-edit-drop-target', ''); });
            const ghost = s.ghost = item.cloneNode(true);
            unrich(item, ghost);
            ghost.setAttribute('data-edit-ghost', '');
            ghost.setAttribute('x-ignore', '');
            ghost.removeAttribute('id');
            ghost.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
            [ghost, ...ghost.querySelectorAll('*')].forEach(n => {
                [...n.attributes].forEach(a => { if (a.name.startsWith('data-edit-') && a.name !== 'data-edit-ghost') n.removeAttribute(a.name); });
                n.removeAttribute('contenteditable'); n.removeAttribute('tabindex'); n.removeAttribute('draggable');
            });
            item.before(ghost);
            Object.assign(item.style, { position: 'fixed', width: start.width + 'px', height: start.height + 'px', margin: '0', pointerEvents: 'none' });
            item.setAttribute('data-edit-dragging', '');
            dragged = ghost;
            try { item.setPointerCapture(ev.pointerId); } catch { }
        };
        const paint = () => { frame = 0; item.style.left = (px - s.grabX) + 'px'; item.style.top = (py - s.grabY) + 'px'; };
        const placeGhost = (drop) => {
            const g = s.ghost, { container, ref } = drop;
            const same = last && last.container === container && last.ref === ref;
            last = drop;
            if (!same) container.insertBefore(g, ref && ref.parentElement === container ? startOf(ref) : null);
            if (isPositioned(g)) {
                if (!same) { if (container === home && item.parentElement === home) home.insertBefore(g, item); else if (g.nextElementSibling) container.appendChild(g); }
                placeAt(g, px, py, s);
            } else if (g.style.left || g.style.top) clearPlacement(g);
        };
        const onMove = (ev) => {
            px = ev.clientX; py = ev.clientY;
            if (!active) {
                if (Math.hypot(px - sx, py - sy) < 5) return;
                active = true; hideGrip(); lift(ev); paint();
            }
            ev.preventDefault();
            const drop = dropTarget(px, py, s);
            if (drop) placeGhost(drop);
            if (!frame) frame = requestAnimationFrame(paint);
        };
        const settle = (cancelled) => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onCancel);
            document.removeEventListener('keydown', onKey, true);
            if (frame) cancelAnimationFrame(frame);
            if (!active) return;
            document.querySelectorAll('[data-edit-drop-target]').forEach(a => a.removeAttribute('data-edit-drop-target'));
            item.removeAttribute('data-edit-dragging');
            if (cancelled) s.ghost.remove(); else { s.ghost.replaceWith(item); if (lead.length) item.before(...lead); if (rest.length) item.after(...rest); }
            if (preStyle == null) item.removeAttribute('style'); else item.setAttribute('style', preStyle);
            s.ghost = null; dragged = null;
            const back = () => { if (homeNext && homeNext.parentElement === home) home.insertBefore(item, startOf(homeNext)); else home.appendChild(item); if (lead.length) item.before(...lead); if (rest.length) item.after(...rest); };
            if (cancelled) { back(); announce('Cancelled'); return; }
            const dest = item.parentElement, toArea = regionOf(dest);
            if (dest !== home && (s.dataList || !accepts(dest) || !fits(item, dest) || !toArea || (toArea !== area && !(s.crossOK && dropValid(toArea))))) { back(); announce('Cancelled'); return; }
            if (isPositioned(item)) placeAt(item, px, py, s);
            else if (item.style.left || item.style.top) clearPlacement(item);
            const styled = ownStyle(item) !== preOwn;
            if (s.dataList) { finishReorder(area, home); announce('Dropped'); return; }
            let did = false;
            if (dest === home) did = commitOrder(area, home, s.homeBefore);
            else { commitMove(area, toArea, item, home, s.homeBefore, keysWithout(dest, item)); did = true; }
            if (styled) commitStyle(regionOf(item), item, { before: preOwn, join: did });
            announce(toArea !== area ? 'Moved to ' + key(toArea) : 'Dropped');
        };
        const onUp = () => settle(false);
        const onCancel = () => settle(true);
        const onKey = (ev) => { if (ev.key !== 'Escape') return; ev.preventDefault(); ev.stopPropagation(); settle(true); };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancel);
        document.addEventListener('keydown', onKey, true);
    }

    function finishReorder(area, container) {
        if (classify(area) === 'data') { applyDataOrder(area, sortableChildren(container).map(c => itemKey(c, area))); commit(area); return true; }
        return false;
    }

    /* ---- Keyboard ---- */
    const ownControl = (e, item) => e.target !== item && !!e.target.closest && item.contains(e.target.closest('a[href], button, summary, [role="button"], [role="link"]'));
    const siblingsOf = (item) => sortableChildren(item.parentElement).filter(c => c === item || !lockedFor(c, 'move'));
    function refocus(el) { if (document.activeElement !== el) try { el.focus(); } catch { } }

    function onPieceKeydown(e, area) {
        if (e._editRow) return;
        const t = e.target;
        if (e.key === 'Enter' && t.matches && t.matches('a[href]') && islandLink(t, area)) return;
        if (t._pieceMode && e.key === 'Enter') { e._editRow = true; e.preventDefault(); exitPieceMode(t, true); return; }
        let item = null;
        for (let n = t; n && n !== area; n = n.parentElement) if (n.hasAttribute && n.hasAttribute('data-edit-piece') && movable(n)) { item = n; break; }
        if (!grabbed) { const b = asPiece(t); if (b && onBlockKey(e, b)) { e._editRow = true; e.preventDefault(); e.stopPropagation(); return; } }
        if (!item) return;
        const dir = { ArrowUp: -1, ArrowDown: 1 }[e.key], side = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
        const plainAlt = e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey;
        if (plainAlt && dir != null && !(grabbed && grabbed.item === item)) { e._editRow = true; e.preventDefault(); stepRow(item, dir); return; }
        if (plainAlt && side != null && !inText(e)) { e._editRow = true; e.preventDefault(); if (side > 0) nestInto(item); else unnest(item); return; }
        if ((e.key === ' ' || e.key === 'Enter') && !inText(e) && !ownControl(e, item) && !e.altKey && !e.metaKey && !e.ctrlKey) {
            e._editRow = true; e.preventDefault();
            if (grabbed && grabbed.item === item) { dropGrab(); refocus(item); announce('Dropped'); }
            else { if (grabbed) cancelGrab(); grabbed = { item, area: blockArea(item), container: item.parentElement, next: groupOf(item).pop().nextElementSibling, before: classify(blockArea(item)) === 'data' ? null : staticKeys(item.parentElement) }; item.setAttribute('data-edit-dragging', 'keyboard'); announce('Grabbed — arrow keys to move, Enter to drop'); }
            return;
        }
        if (grabbed && grabbed.item === item) {
            if (e.key === 'Escape') { e._editRow = true; e.preventDefault(); cancelGrab(); refocus(item); announce('Cancelled'); return; }
            const step = dir ?? side; if (step == null) return;
            e._editRow = true; e.preventDefault();
            const sibs = siblingsOf(item), i = sibs.indexOf(item), j = i + step;
            if (j < 0 || j >= sibs.length) return;
            moveWith(item, it => { if (step > 0) groupOf(sibs[j]).pop().after(it); else startOf(sibs[j]).before(it); });
            refocus(item); announce(`Position ${j + 1} of ${sibs.length}`);
            return;
        }
        if (t === item && !inText(e) && !e.altKey && !e.metaKey && !e.ctrlKey && (dir != null || side != null) && isPositioned(item)) { e._editRow = true; nudge(e, item); }
    }
    function dropGrab() {
        const g = grabbed; grabbed = null; if (!g) return;
        g.item.removeAttribute('data-edit-dragging');
        if (g.before) commitOrder(g.area, g.container, g.before); else finishReorder(g.area, g.container);
    }
    function cancelGrab() {
        const g = grabbed; grabbed = null; if (!g) return;
        g.item.removeAttribute('data-edit-dragging');
        moveWith(g.item, it => { if (g.next && g.next.parentElement === g.container) g.container.insertBefore(it, startOf(g.next)); else g.container.appendChild(it); });
    }
    // One step, committed at once. Neighbours move round the piece, so focus and caret survive.
    function stepRow(item, dir) {
        const area = blockArea(item), container = item.parentElement;
        const sibs = siblingsOf(item), i = sibs.indexOf(item), j = i + dir;
        if (i < 0 || j < 0 || j >= sibs.length) { announce(`Position ${i + 1} of ${sibs.length}`); return; }
        const before = classify(area) === 'data' ? null : staticKeys(container);
        const other = sibs[j], between = [];
        for (let n = dir > 0 ? item.nextElementSibling : item.previousElementSibling; n && n !== other; n = dir > 0 ? n.nextElementSibling : n.previousElementSibling) between.push(n);
        // Neighbours move round the piece, each with its titling comment.
        const block = (n) => [...leadNodes(n), ...groupOf(n)];
        if (dir > 0) { const at = startOf(item); [other, ...between].filter(n => !extraRoot(n)).forEach(n => at.before(...block(n))); }
        else { let after = groupOf(item).pop(); [...between.slice().reverse(), other].filter(n => !extraRoot(n)).forEach(n => { after.after(...block(n)); after = groupOf(n).pop(); }); }
        const focused = document.activeElement, sel = window.getSelection && window.getSelection();
        const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        if (before) commitOrder(area, container, before); else finishReorder(area, container);
        if (focused && focused.isConnected && document.activeElement !== focused) {
            focused.focus();
            if (range) try { sel.removeAllRanges(); sel.addRange(range); } catch { }
        }
        announce(`Moved to position ${j + 1} of ${sibs.length}`);
    }
    const describe = (el) => el === regionOf(el) ? key(el) : el.tagName.toLowerCase();
    function nestInto(item) {
        const area = blockArea(item);
        if (classify(area) !== 'static') { announce('Records stay in their list'); return false; }
        let prev = item.previousElementSibling;
        while (prev && (pluginNode(prev) || prev.tagName === 'TEMPLATE' || extraRoot(prev))) prev = prev.previousElementSibling;
        if (!prev || isHostEl(prev) || !accepts(prev) || !fits(item, prev)) { announce('Nothing to nest into'); return false; }
        const from = item.parentElement, fb = staticKeys(from), tb = staticKeys(prev);
        moveWith(item, it => prev.appendChild(it));
        commitMove(area, area, item, from, fb, tb);
        refocus(item); announce('Nested in ' + describe(prev));
        return true;
    }
    function unnest(item) {
        const area = blockArea(item), from = item.parentElement;
        if (classify(area) !== 'static') { announce('Records stay in their list'); return false; }
        const out = from && from !== area ? from.parentElement : null;
        if (!out || !(out === area || area.contains(out)) || !accepts(out)) { announce('Already at the top level'); return false; }
        if (!fits(item, out)) { announce('Cannot move out here'); return false; }
        const fb = staticKeys(from), tb = staticKeys(out);
        moveWith(item, it => groupOf(from).pop().after(it));
        commitMove(area, area, item, from, fb, tb);
        refocus(item); announce('Moved out to ' + describe(out));
        return true;
    }
    // Arrow nudge for a focused, absolutely positioned piece; a key burst commits once.
    function nudge(e, el) {
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!d) return;
        e.preventDefault();
        if (!el._moveTimer) el._preStyle = ownStyle(el);
        const step = e.shiftKey ? 16 : 4, cs = getComputedStyle(el), parent = el.offsetParent || el.parentElement;
        const lu = unitOf(el.style.left) || 'px', tu = unitOf(el.style.top) || 'px';
        const maxL = Math.max(0, parent.clientWidth - el.offsetWidth), maxT = Math.max(0, parent.clientHeight - el.offsetHeight);
        const nl = Math.max(0, (parseFloat(cs.left) || 0) + d[0] * step), nt = Math.max(0, (parseFloat(cs.top) || 0) + d[1] * step);
        if (d[0]) el.style.left = toUnit(maxL ? Math.min(maxL, nl) : nl, lu, el, parent, 'w') + lu;
        if (d[1]) el.style.top = toUnit(maxT ? Math.min(maxT, nt) : nt, tu, el, parent, 'h') + tu;
        clearTimeout(el._moveTimer); el._moveTimer = setTimeout(() => { el._moveTimer = null; commitStyle(regionOf(el), el); }, 350);
    }


    /* ---- Size: edge handles → unit-preserving width/height ----
         --edit-size                 both | x | y | none   axes (default both)
         --edit-size-edges           "right bottom-right"  handle list (logical start/end ok)
         --edit-size-handle          1rem                  handle hit area
         --edit-size-snap(-x/-y)     12rem 24rem           snap stops; unset = no snapping
         --edit-size-snap-distance(-x/-y)  1rem            magnet reach; unset = always the nearest stop
         --edit-size-close(-x/-y)    4rem                  below this, an x-show element closes
       `none` on any --edit-size-* cancels an inherited value. Min/max come from native min-/max-width/height. */
    let overlayEl;
    // edit:size fires while dragging (done:false) and once on commit (done:true).
    function sizeEvent(el, done) {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new CustomEvent('edit:size', {
            bubbles: true,
            detail: { width: r.width, height: r.height, css: { width: el.style.width, height: el.style.height }, done }
        }));
    }
    function showOverlay() { if (!overlayEl) { overlayEl = document.createElement('div'); overlayEl.setAttribute('data-edit-overlay', ''); document.body.appendChild(overlayEl); } overlayEl.style.display = 'block'; return overlayEl; }
    function hideOverlay() { if (overlayEl) overlayEl.style.display = 'none'; }

    const isRTL = (el) => getComputedStyle(el).direction === 'rtl';
    // Resolve logical start/end to physical left/right per the element's direction.
    function physical(pos, el) {
        const rtl = isRTL(el);
        return pos.replace(/start/g, rtl ? 'right' : 'left').replace(/end/g, rtl ? 'left' : 'right');
    }
    // Containing-block size for % limits (null when the height is not definite).
    function blockSize(el, dim) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed') return dim === 'w' ? document.documentElement.clientWidth : document.documentElement.clientHeight;
        const cb = pos === 'absolute' ? el.offsetParent || el.parentElement : el.parentElement;
        if (!cb) return null;
        const ps = getComputedStyle(cb), w = dim === 'w';
        const box = w ? cb.clientWidth : cb.clientHeight;
        if (pos === 'absolute') return box;
        if (!w && !definiteHeight(cb)) return null;
        return box - (parseFloat(w ? ps.paddingLeft : ps.paddingTop) || 0) - (parseFloat(w ? ps.paddingRight : ps.paddingBottom) || 0);
    }
    // Specified height via Typed OM; without it (Firefox) only an inline height counts.
    function definiteHeight(el) {
        for (let n = el, depth = 0; n && depth < 32; n = n.parentElement, depth++) {
            if (n === document.documentElement) return true;               // % on the root resolves against the viewport
            const pos = getComputedStyle(n).position;
            if (pos === 'absolute' || pos === 'fixed') return true;
            let h;
            if (n.computedStyleMap) { try { h = String(n.computedStyleMap().get('height')).trim(); } catch { } }
            if (h == null) h = (n.style && n.style.height || '').trim() || 'auto';
            if (h === 'auto' || h === '') return false;
            if (!h.endsWith('%')) return true;                           // a length (or calc) is definite
        }
        return false;
    }
    function limitPx(v, el, dim, none) {
        v = String(v || '').trim();
        if (!v || v === 'none' || v === 'auto') return none;
        if (/^-?[\d.]+%$/.test(v)) { const b = blockSize(el, dim); return b == null ? none : parseFloat(v) / 100 * b; }
        const px = toPx(v, el, dim);
        return px == null ? none : px;
    }
    function limits(el, cs) {
        const minW = limitPx(cs.minWidth, el, 'w', 0), minH = limitPx(cs.minHeight, el, 'h', 0);
        return { minW, minH, maxW: Math.max(minW, limitPx(cs.maxWidth, el, 'w', Infinity)), maxH: Math.max(minH, limitPx(cs.maxHeight, el, 'h', Infinity)) };   // min wins, as in CSS
    }
    const defaultEdges = (axes) => axes === 'x' ? ['left', 'right'] : axes === 'y' ? ['top', 'bottom'] : ['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

    function armSize(el) {
        const axes = cssVar(el, '--edit-size', 'both');
        if (axes === 'none') return;
        if (el._sizeBound) return; el._sizeBound = true;
        // Handles need a containing block; this position is the plugin's, never logged or published.
        const pos = getComputedStyle(el).position;
        if (!pos || pos === 'static') { el.style.position = 'relative'; el._editPos = true; }
        const edges = (cssVar(el, '--edit-size-edges', '') || defaultEdges(axes).join(' ')).split(/\s+/).filter(Boolean);
        edges.forEach(pos => {
            const phys = physical(pos, el);
            const h = document.createElement('span');
            h.setAttribute('data-edit-handle', pos);
            h.tabIndex = 0; h.setAttribute('role', 'slider'); h.setAttribute('aria-label', `Resize ${pos}`);
            h.addEventListener('pointerdown', (e) => startSize(e, el, phys));
            h.addEventListener('keydown', (e) => keyResize(e, el, phys));
            el.appendChild(h);
        });
    }
    // Keyboard: arrows resize (Shift = larger step); a key burst commits once per element.
    function keyResize(e, el, pos) {
        const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!map[e.key]) return;
        const area = regionOf(el); if (!isActive(area)) return;
        e.preventDefault(); e.stopPropagation();
        if (!el._keyTimer) el._preStyle = ownStyle(el);
        const [kx, ky] = map[e.key], step = e.shiftKey ? 32 : 8, cs = getComputedStyle(el);
        const right = pos.includes('right'), left = pos.includes('left'), top = pos.includes('top'), bottom = pos.includes('bottom');
        const wu = unitOf(el.style.width) || 'px', hu = unitOf(el.style.height) || 'px';
        const { minW, maxW, minH, maxH } = limits(el, cs);
        if ((right || left) && kx) { const w = clamp((parseFloat(cs.width) || 0) + kx * step * (right ? 1 : -1), minW, maxW); el.style.width = toUnit(w, wu, el, el.parentElement, 'w') + wu; }
        if ((top || bottom) && ky) { const h = clamp((parseFloat(cs.height) || 0) + ky * step * (bottom ? 1 : -1), minH, maxH); el.style.height = toUnit(h, hu, el, el.parentElement, 'h') + hu; }
        sizeEvent(el, false);
        clearTimeout(el._keyTimer); el._keyTimer = setTimeout(() => { el._keyTimer = null; commitStyle(regionOf(el), el); sizeEvent(el, true); }, 350);
    }
    // An axis value wins; an explicit axis `none` cancels the base value too.
    function axisVar(el, base, axis) {
        const a = rawVar(el, `${base}-${axis}`);
        if (a) return a === 'none' ? '' : a;
        const b = rawVar(el, base);
        return b === 'none' ? '' : b;
    }
    function snapStops(el, axis, dim) {
        return axisVar(el, '--edit-size-snap', axis).split(/\s+/).filter(Boolean).map(s => toPx(s, el, dim)).filter(v => v != null);
    }
    function snapTo(v, stops, reach) {
        if (!stops.length) return v;
        let best = v, d = Infinity;
        for (const p of stops) { const dd = Math.abs(v - p); if (dd < d) { d = dd; best = p; } }
        return reach == null || d <= reach ? best : v;
    }
    const lengthVar = (el, base, axis, dim) => { const v = axisVar(el, base, axis); return v ? toPx(v, el, dim) : null; };
    // Close rides x-show: only an identifier or member path (no calls) can be set false.
    const ASSIGNABLE = /^\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:'[^'\\]*'|"[^"\\]*"|\d+)\s*\])*\s*$/;
    const warnedShow = new WeakSet();
    function closable(el) {
        const expr = el.getAttribute('x-show');
        if (expr == null) return null;
        if (ASSIGNABLE.test(expr)) return expr;
        if (!warnedShow.has(el)) { warnedShow.add(el); console.warn('[edit] --edit-size-close needs an assignable x-show expression (e.g. x-show="open"); close is off here:', expr); }
        return null;
    }
    const showable = (v) => { try { return JSON.stringify(v) !== undefined ? JSON.parse(JSON.stringify(v)) : true; } catch { return true; } };
    function setShow(el, expr, value) { window.Alpine.evaluate(el, `${expr} = ${JSON.stringify(value)}`); }
    // Closing is logged with the size change, so one undo reopens it.
    function closeVia(area, el, expr, join) {
        let before;
        try { before = showable(window.Alpine.evaluate(el, expr)); setShow(el, expr, false); } catch (err) { console.warn('[edit] could not close via x-show:', err); return false; }
        const id = identity(el, area);
        if (id != null) pushDelta(Object.assign({ kind: 'show', region: key(area), key: id, expr, before, value: false }, join ? { join: true } : {}));
        return true;
    }
    function startSize(e, el, pos) {
        const area = regionOf(el);
        if (!isActive(area) || (e.pointerType === 'mouse' && e.button !== 0) || e.button > 0) return;
        e.preventDefault(); e.stopPropagation();
        const preStyle = el.getAttribute('style'); el._preStyle = ownStyle(el);
        const cs = getComputedStyle(el), rect = el.getBoundingClientRect();
        const wu = unitOf(el.style.width) || 'px', hu = unitOf(el.style.height) || 'px';
        const baseW = parseFloat(cs.width) || rect.width, baseH = parseFloat(cs.height) || rect.height, sx = e.clientX, sy = e.clientY;
        const { minW, maxW, minH, maxH } = limits(el, cs);
        const right = pos.includes('right'), left = pos.includes('left'), bottom = pos.includes('bottom'), top = pos.includes('top');
        const reachX = lengthVar(el, '--edit-size-snap-distance', 'x', 'w'), reachY = lengthVar(el, '--edit-size-snap-distance', 'y', 'h');
        const snapW = snapStops(el, 'x', 'w'), snapH = snapStops(el, 'y', 'h');
        const closeX = lengthVar(el, '--edit-size-close', 'x', 'w'), closeY = lengthVar(el, '--edit-size-close', 'y', 'h');
        const showExpr = closeX != null || closeY != null ? closable(el) : null;
        try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch { }
        showOverlay();
        let rawW = baseW, rawH = baseH;
        const move = (ev) => {
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (right || left) { rawW = baseW + (right ? dx : -dx); el.style.width = toUnit(snapTo(clamp(rawW, minW, maxW), snapW, reachX), wu, el, el.parentElement, 'w') + wu; }
            if (top || bottom) { rawH = baseH + (bottom ? dy : -dy); el.style.height = toUnit(snapTo(clamp(rawH, minH, maxH), snapH, reachY), hu, el, el.parentElement, 'h') + hu; }
            sizeEvent(el, false);
        };
        const end = () => {
            document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel);
            hideOverlay();
        };
        const restore = () => { if (preStyle == null) el.removeAttribute('style'); else el.setAttribute('style', preStyle); };
        const cancel = () => { end(); restore(); sizeEvent(el, true); };
        const up = () => {
            end();
            const shutX = (right || left) && closeX != null && rawW < closeX, shutY = (top || bottom) && closeY != null && rawH < closeY;
            if ((shutX || shutY) && showExpr) {
                // Closed at the minimum it can have; with none, at the size it had, so it reopens sensibly.
                const atMin = (shutX ? minW : 0) > 0 || (shutY ? minH : 0) > 0;
                restore();
                if (atMin) {
                    if (shutX && minW > 0) el.style.width = toUnit(minW, wu, el, el.parentElement, 'w') + wu;
                    if (shutY && minH > 0) el.style.height = toUnit(minH, hu, el, el.parentElement, 'h') + hu;
                }
                const sized = commitStyle(area, el); sizeEvent(el, true);
                closeVia(area, el, showExpr, sized);
                return;
            }
            if (shutX || shutY) { restore(); sizeEvent(el, true); return; }   // close configured but not possible here: leave it as it was
            commitStyle(area, el); sizeEvent(el, true);
        };
        document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel);
    }


    /* ---- Inline text editing ---- */
    // Focus selects the leaf's content; deferred a frame to win over the click's caret.
    function selectAllIn(el) {
        requestAnimationFrame(() => {
            if (dragged || grabbed) return;              // reordering, not editing
            if (document.activeElement !== el) return;
            try { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch { }
        });
    }
    // A link clicked in an active area is content: neither the router nor the browser follows it,
    // whatever the contenteditable state (a piece at rest is contenteditable=false). A
    // contenteditable=false island that is not a resting piece keeps its links. Runs on window,
    // capture, ahead of the router's document listener.
    function islandLink(link, area) {
        const off = link.closest('[contenteditable="false"]');
        return !!off && area.contains(off) && !off.hasAttribute('data-edit-piece-mode');
    }
    function onAreaLinkClick(e) {
        const link = e.target && e.target.closest && e.target.closest('a[href]');
        const area = link && regionOf(link);
        if (!area || !isActive(area) || islandLink(link, area)) return;
        e.preventDefault();
    }

    /* ---- Rich Text engine: every editable leaf is an inline Rich Text field ---- */
    const richLeaves = new Set();
    let rtMissing = false;
    function rtEngine() {
        const RT = window.ManifestRichText;
        if (RT && typeof RT.attach === 'function') return RT;
        if (!rtMissing) { rtMissing = true; console.warn('[edit] Rich Text is not loaded; text leaves fall back to plain contenteditable'); }
        return null;
    }
    // Edit's own listeners are bound before this, so they run ahead of Rich Text's.
    function editable(el, format) {
        el._editRtFormat = format;
        if (el._editRt || el._pieceMode) return;                         // a focused piece re-attaches when it leaves piece mode
        const RT = rtEngine();
        el._editRtPrior = ['role', 'aria-multiline'].map(a => [a, el.getAttribute(a)]);
        const h = RT && RT.attach(el, { mode: 'inline', breaks: true, all: false, format, onChange: () => { } });
        if (!h) { el.setAttribute('contenteditable', 'true'); return; }
        el._editRt = h;
        el.setAttribute('data-edit-text', '');
        richLeaves.add(el);
    }
    function unedit(el) {
        const h = el._editRt; if (!h) return;
        el._editRt = null; richLeaves.delete(el);
        el.removeAttribute('data-edit-text');
        h.detach();
    }
    // Leaves inside `area`, and any no longer on the page.
    const uneditIn = (area) => richLeaves.forEach(el => { if (!el.isConnected || (area && area.contains(el))) unedit(el); });
    // Rich Text's history spans one edit session: it restarts at focus and when Edit's history moves the text.
    const restartRich = (el) => { const h = el._editRt; if (h) h.value = h.value; };
    /* Undo/redo in a leaf, one session at a time. While focused, each Rich Text step
       (a typing burst, a command, a paste) undoes and redoes on its own. Past the
       session's start, Edit's history takes over; a session with steps still to redo
       first becomes one Edit step (start → furthest state), logged and undone, so Edit's
       redo brings it back whole. Ctrl+Y redoes, as in Edit. */
    function richHistoryKey(e) {
        const el = this, h = el._editRt, dir = historyDir(e);
        if (!h || !dir) return;
        if (h.can(dir)) { e.preventDefault(); e.stopImmediatePropagation(); h[dir](); return; }
        const region = regionOf(el);
        if (dir === 'undo' && region && isActive(region) && !hotkeysOff(el)) handOff(el);   // only when Edit's history will act
        onHistoryKey(e);
        if (e.defaultPrevented) e.stopImmediatePropagation();
    }
    function handOff(el) {
        const h = el._editRt;
        if (!h || !h.can('redo') || !el._commitText) return;
        const top = sessionTop(el);
        if (el._commitText(top)) undo();
    }
    // Drops follow the area's rule (none while active), ahead of Rich Text's own drop handling.
    function noDrop(el) {
        el.addEventListener('drop', (e) => { const a = regionOf(el); if (a && isActive(a)) { e.preventDefault(); e.stopImmediatePropagation(); } });
    }
    // The session's furthest state: the newest entry in the leaf's Rich Text history.
    function sessionTop(el) {
        const html = el._editRt.newest();
        if (!(el._editField && !el._editRich)) return html.trim();
        const t = document.createElement('template'); t.innerHTML = html; return t.content.textContent;
    }
    // Copies and ghosts of a leaf carry none of the engine's attributes or --rich-text-* state.
    function unrich(src, copy) {
        const s = [src, ...src.querySelectorAll('*')], c = [copy, ...copy.querySelectorAll('*')];
        c.forEach(n => { const st = n.getAttribute('style'); if (st && /--rich-text-/.test(st)) { const v = stripRuntime(st); v ? n.setAttribute('style', v) : n.removeAttribute('style'); } });
        s.forEach((n, i) => {
            if (!n._editRt || !c[i]) return;
            [...c[i].attributes].forEach(a => { if (a.name.startsWith('data-rich-text')) c[i].removeAttribute(a.name); });
            (n._editRtPrior || []).forEach(([a, v]) => v == null ? c[i].removeAttribute(a) : c[i].setAttribute(a, v));
        });
    }
    // `commit(value?)` logs the leaf's text against its session start (_preEdit).
    function bindLeaf(el, commit, input) {
        if (el._textBound) return; el._textBound = true;
        el._commitText = commit;
        el.addEventListener('focus', () => { restartRich(el); el._preEdit = leafText(el); selectAllIn(el); });
        el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.isContentEditable) { e.preventDefault(); e.stopImmediatePropagation(); leaveText(el); } });
        el.addEventListener('keydown', richHistoryKey);
        noDrop(el);
        if (input) el.addEventListener('input', input);
        el.addEventListener('blur', () => commit());
    }
    // A rich editor other than this leaf's own owns `el`.
    const richOwned = (el) => { const o = el.closest('[data-rich-text]'); return !!o && (o !== el || !el._editRt); };

    // Where x-rich-text is declared, it owns the element: this plugin neither makes
    // its leaves contenteditable nor competes for the caret. If the rich editor has
    // no expression of its own, we capture what it produces as an ordinary text
    // delta, so a rich field inside a page-editing region publishes like any other.
    function armRichText(area) {
        area.querySelectorAll('[data-rich-text]:not([data-rich-text-bound])').forEach(el => {
            if (el._editRt || !capOf(el, 'text') || !/^[@~]/.test(el.getAttribute('data-edit-key') || '')) return;
            if (el._richBound) return; el._richBound = true;
            el.addEventListener('focusin', () => { el._preEdit = leafText(el); });
            el.addEventListener('blur', () => {
                const a = regionOf(el) || area;   // the region the element sits in NOW, not where it was armed
                const commit = classify(a) === 'component' ? commitComponentNode : commitStaticNode;
                commit(a, el, 'text', el.innerHTML.trim());
            }, true);
        });
    }

    // Static: literal leaves only.
    function armText(area) {
        armRichText(area);
        // An area that is itself the text leaf.
        const nodes = [...area.querySelectorAll('*')];
        if (!realChildren(area).length || wholeLeaf(area)) nodes.unshift(area);   // size handles are children too
        nodes.forEach(el => {
            if ((realChildren(el).length && !wholeLeaf(el)) || !el.textContent.trim() || el.closest('template') || el.hasAttribute('data-edit-handle')) return;
            if (el._manifestComponent && el !== area) return;          // a component host: its markup is another file's
            if (richOwned(el)) return;                                  // the rich editor owns this subtree
            if (el.closest('[contenteditable="false"]:not([data-edit-piece-mode])')) return;   // an authored non-editable island
            if (!capOf(el, 'text') || isRendered(el) || RAW_EDIT.has(el.tagName)) return;
            if (!/^[@~]/.test(el.getAttribute('data-edit-key') || '')) return;   // only what will be logged and published
            bindLeaf(el, (v) => commitStaticNode(regionOf(el) || area, el, 'text', v ?? leafHTML(el)));   // live region: the element may have moved since arming
            editable(el, 'html');
        });
    }

    /* ---- Data values (.data): x-for fields bound to a plain `item.field` are editable ---- */
    function armDataValues(area) {
        const tpl = listTpl(area); if (!tpl) return;
        const lv = (tpl.getAttribute('x-for').match(/^\s*([\w$]+)\s+in\b/) || [])[1]; if (!lv) return;
        const source = dataSourceName(area), fieldRe = new RegExp('^\\s*' + lv + '\\.([\\w$]+)\\s*$');
        sortableChildren(area).forEach(clone => {
            // The record: :data-key names its id; otherwise the row's own x-for scope gives the record (the writer matches records by id)
            let id = clone.getAttribute('data-key');
            if (id == null) { let rec = null; try { rec = window.Alpine.$data(clone)[lv]; } catch { } if (rec && rec.id != null) id = String(rec.id); }
            if (id == null) return;
            [clone, ...clone.querySelectorAll('*')].forEach(el => {
                const rich = el.hasAttribute('x-html');
                if ((el.children.length && !(rich && plainFormatted(el))) || el.hasAttribute('data-edit-handle')) return;
                const expr = el.getAttribute('x-text') || el.getAttribute('x-html'); if (!expr) return;
                const m = expr.match(fieldRe); if (!m) return;
                const field = m[1];
                el._editField = field;
                // x-html fields hold markup; x-text fields are plain.
                el._editRich = rich;
                if (!el._dvBound) {
                    el._dvBound = true;
                    const read = () => rich ? leafHTML(el) : el.textContent;
                    el._commitText = (v) => commitDataValue(area, source, id, field, v ?? read(), el);
                    el.addEventListener('focus', () => { restartRich(el); el._preEdit = leafText(el); if (!authoredRich(el)) selectAllIn(el); });   // the rich editor owns its caret
                    el.addEventListener('focusin', () => { el._preEdit = leafText(el); });
                    el.addEventListener('keydown', richHistoryKey);
                    noDrop(el);
                    el.addEventListener('blur', () => el._commitText(), true);
                }
                if (!authoredRich(el)) editable(el, rich ? 'html' : 'plain');
            });
        });
    }

    /* ---- Components: nodes addressed by structural path; scope via $edit.scope ---- */
    const componentName = (area) => { const r = cmpRoot(area); return (r?.getAttribute('data-component') || '').replace(/-\d+$/, ''); };
    function pathOf(node, root) { const idx = []; let n = node; while (n && n !== root && n.parentElement) { idx.unshift(realChildren(n.parentElement).indexOf(n)); n = n.parentElement; } return idx.join('.'); }
    function nodeByPath(root, path) { let el = root; for (const i of path.split('.').map(Number)) { el = realChildren(el)[i]; if (!el) return null; } return el; }
    // 'main' scope: mirror live to other instances without their own override.
    function liveMainPropagate(area, sourceEl, prop, value) {
        if ((area._editScope || 'instance') !== 'main') return;
        const comp = componentName(area), path = sourceEl._editPath, { inst } = componentState();
        areas().forEach(a => {
            if (classify(a) !== 'component' || componentName(a) !== comp) return;
            const root = cmpRoot(a); if (!root) return;
            const el = path === '' ? root : nodeByPath(root, path); if (!el || el === sourceEl) return;
            const iv = (inst[key(a)] && inst[key(a)][path]) || {}; if (iv[prop] !== undefined) return;   // override wins
            if (prop === 'class') writeClass(el, value);
            else if (el.innerHTML !== value) el.innerHTML = value;
        });
    }
    function armComponent(area) {
        const root = cmpRoot(area); if (!root) return;
        if (!area._editScope) area._editScope = 'instance';
        area._baseText = area._baseText || {}; area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {};
        const markClass = (el) => { const p = pathOf(el, root); el._editPath = p; if (!(p in area._baseClass)) area._baseClass[p] = el.getAttribute('class') || ''; if (!(p in area._baseStyle)) area._baseStyle[p] = el.getAttribute('style') || ''; };
        markClass(root);
        root.querySelectorAll('*').forEach(el => { if (!el.hasAttribute('data-edit-handle')) markClass(el); });
        armRichText(area);
        componentNodes(root).forEach(el => {
            if ((el.children.length && !wholeLeaf(el)) || !el.textContent.trim() || !capOf(el, 'text')) return;
            if (richOwned(el)) return;                                  // the rich editor owns this subtree
            const p = el._editPath;
            if (!(p in area._baseText)) area._baseText[p] = el.innerHTML.trim();
            bindLeaf(el, (v) => commitComponentNode(area, el, 'text', v ?? leafHTML(el)), () => liveMainPropagate(area, el, 'text', el.innerHTML));
            editable(el, 'html');
        });
    }
    // Escape leaves text with the piece focused, so Alt+arrows move it.
    function leaveText(el) {
        el.blur();
        const piece = [el, ...ancestorsIn(el)].find(n => n.hasAttribute && n.hasAttribute('data-edit-piece'));
        if (!piece) return;
        if (piece.isContentEditable) {
            piece._pieceMode = true;
            piece.setAttribute('data-edit-piece-mode', '');
            unedit(piece);                                              // a focused piece is not a text field
            piece.setAttribute('contenteditable', 'false');
            piece.addEventListener('focusout', () => exitPieceMode(piece), { once: true });
        }
        try { piece.focus(); } catch { }
    }
    const ancestorsIn = (el) => { const out = [], area = regionOf(el); for (let n = el.parentElement; n && n !== area; n = n.parentElement) out.push(n); return out; };
    function exitPieceMode(el, edit) {
        if (!el._pieceMode) return;
        el._pieceMode = false;
        el.removeAttribute('data-edit-piece-mode');
        if (el.getAttribute('contenteditable') === 'false') { el.removeAttribute('contenteditable'); editable(el, el._editRtFormat || 'html'); }
        if (edit) { try { el.focus(); } catch { } selectAllIn(el); }
    }


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
        const kind = classify(area);
        // A component root also carries its placeholder's class and attributes
        if (kind === 'static' && el._manifestComponent) return null;
        return { el, area, kind };
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
    // A colour input takes #rrggbb only: any CSS colour (a theme's oklch(), var() resolved) is read off a canvas pixel
    let colorCanvas = null;
    function hexColor(v) {
        if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
        try {
            colorCanvas = colorCanvas || document.createElement('canvas');
            const g = colorCanvas.getContext && colorCanvas.getContext('2d', { willReadFrequently: true });
            if (!g) return null;
            const probe = document.createElement('i'); probe.style.color = v; if (!probe.style.color) return null;
            g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = v; g.fillRect(0, 0, 1, 1);
            return '#' + [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(x => x.toString(16).padStart(2, '0')).join('');
        } catch { return null; }
    }
    function syncCssVarInput(el) {
        const cv = el._cssvar; if (!cv || !('value' in el)) return;
        const cur = getComputedStyle(themeTargetEl(cv.scope)).getPropertyValue(cv.var).trim();
        if (!cur) return;
        const next = el.type === 'color' ? hexColor(cur) : el.dataset.unit ? String(parseFloat(cur)) : cur;
        if (next != null && el.value !== next) el.value = next;
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
    function rebaseTheme(keep) {
        Object.keys(themeBaseline).forEach(kk => { if (keep && keep.has('theme|' + kk)) return; const sep = kk.indexOf('|'); themeBaseline[kk] = themeTargetEl(kk.slice(0, sep) || null).style.getPropertyValue(kk.slice(sep + 1)); });
        [...themeTouched].forEach(kk => { if (!(keep && keep.has('theme|' + kk))) themeTouched.delete(kk); });
    }
    // A scoped value lives in its scope element's inline style, and is written there, never to a
    // stylesheet: with its x-edit area's tree when the element is a static piece of one ('area'),
    // else found by its own x-edit.theme name ('own'). Inside generated content it can't be (null).
    function inlineScope(scope) {
        const el = scope && themeScopes[scope]; if (!el || generatedBy(el)) return null;
        const a = regionOf(el), k = el.getAttribute('data-edit-key');
        if (a && classify(a) === 'static' && !sharedKey(a) && k && /^[@~]/.test(k)) return 'area';
        if (a && a !== el) return null;
        const named = areaByKey(scope);
        return !named || named === el ? 'own' : null;
    }
    const inlineScoped = () => new Set(Object.values(themeState()).filter(d => d.scope && inlineScope(d.scope) === 'area').map(d => themeScopes[d.scope]));
    // The component file a scope element is authored in, if any.
    const scopeComponent = (el) => { for (let n = el; n; n = n.parentElement) if (n._manifestComponent) return n._manifestComponent; return null; };
    // A custom-property value must stay inside its declaration (same tokenizer as the
    // source writer): strings and url(...) are opaque; script schemes in url() and
    // expression() are refused anywhere; data: urls only as images.
    function themeValueRefusal(v) {
        const s = String(v == null ? '' : v);
        if (!s.trim()) return 'empty';
        if (/expression\s*\(/i.test(s)) return 'expression()';
        const stack = [];
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === '"' || ch === "'") {
                let j = i + 1;
                for (; j < s.length && s[j] !== ch; j++) { if (s[j] === '\\') j++; else if (s[j] === '\n') return 'unbalanced quotes'; }
                if (j >= s.length) return 'unbalanced quotes';
                i = j; continue;
            }
            if (/^url\(/i.test(s.slice(i, i + 4)) && !/[\w-]/.test(s[i - 1] || '')) {
                let j = i + 4, q = null, body = '';
                for (; j < s.length; j++) {
                    const c = s[j];
                    if (q) { if (c === '\\') { body += s[++j] || ''; continue; } if (c === q) { q = null; continue; } body += c; continue; }
                    if (c === '"' || c === "'") { q = c; continue; }
                    if (c === ')') break;
                    body += c;
                }
                if (j >= s.length) return 'unterminated url()';
                const u = body.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
                if (/^(javascript|vbscript):/.test(u)) return 'script URL';
                if (u.startsWith('data:') && !u.startsWith('data:image/')) return 'data URL';
                i = j; continue;
            }
            if (ch === ';' || ch === '{' || ch === '}') return `contains ${ch}`;
            if (s.startsWith('/*', i) || s.startsWith('<!--', i) || s.startsWith('</', i)) return 'contains a comment or markup';
            if (ch === '(' || ch === '[') stack.push(ch);
            else if (ch === ')' || ch === ']') { if (stack.pop() !== (ch === ')' ? '(' : '[')) return 'unbalanced brackets'; }
        }
        return stack.length ? 'unbalanced brackets' : null;
    }
    function commitTheme(scope, v, value, persist) {
        if (!/^--[\w-]+$/.test(v || '')) { console.warn('[edit] x-edit.cssvar needs a custom property name (--name):', v); return; }
        const why = themeValueRefusal(value);
        if (why) { console.warn(`[edit] theme value refused (${why}):`, value); return; }
        const kk = tkey(scope, v); themeTouched.add(kk);
        themeTargetEl(scope).style.setProperty(v, value);
        const cur = themeState()[kk]; if (cur && cur.value === value) return;   // dedupe
        pushDelta({ kind: 'theme', scope: scope || null, var: v, value }, !!persist);
    }
    // Global vars → the page's theme stylesheet (the server's choice); scoped ones inline
    function themePatches() {
        const st = Object.values(themeState()), out = [];
        st.filter(d => !inlineScope(d.scope)).forEach(d => out.push({ kind: 'theme', scope: d.scope || null, var: d.var, value: d.value, file: null }));
        // A scope element of its own: its style attribute, as the page has it now
        new Set(st.filter(d => d.scope && inlineScope(d.scope) === 'own').map(d => d.scope)).forEach(scope => {
            const el = themeScopes[scope], comp = scopeComponent(el), tree = { key: '', edits: { style: ownStyle(el) || null } };
            out.push(comp ? { kind: 'static-tree', region: scope, component: comp, tree } : { kind: 'static-tree', region: scope, tree });
        });
        return out;
    }


    /* ---- Arm / disarm ---- */
    // Identity is assigned once, on the first mark, from what the source holds: the
    // origin area plus a content key (ordinal per repeat), and the element's path.
    // Later arrivals that are not copies get a non-source id and never publish.
    const originAt = new Map();
    function markStatic(area) {
        const region = key(area), first = !area._marked;
        area._marked = true;
        area._baseClass = area._baseClass || {}; area._baseStyle = area._baseStyle || {}; area._baseText = area._baseText || {};
        const seen = Object.create(null);
        const markEl = (el, path) => {
            let k = el.getAttribute('data-edit-key');
            if (!k) {
                if (first) {
                    const base = staticKey(el);
                    const n = seen[base] = (seen[base] || 0) + 1;
                    k = canonKey(region, n > 1 ? base + '#' + n : base);
                    originAt.set(k, path);
                } else k = '!' + mint();
                el.setAttribute('data-edit-key', k);
            }
            if (!(k in area._baseClass)) area._baseClass[k] = readClass(el);
            if (!(k in area._baseStyle)) area._baseStyle[k] = ownStyle(el);
            if (!(k in area._baseText) && !el.children.length) area._baseText[k] = el.innerHTML.trim();
        };
        // Inside a Rich Text leaf: counted, as the source writer counts them, never keyed.
        const count = (el) => { for (const c of el.children) { const b = staticKey(c); seen[b] = (seen[b] || 0) + 1; count(c); } };
        // The writer never descends into x-rich-text* hosts (fields, menus, controls) or rendered hosts.
        const opaque = (el) => authoredRich(el) || isRendered(el) || [...el.attributes].some(a => a.name.startsWith('x-rich-text'));
        const walk = (el, path) => {
            markEl(el, path);
            if (el !== area && opaque(el)) return;
            if (el._editRt || ((first || el._editRtFormat) && wholeLeaf(el) && capOf(el, 'text') && !isRendered(el))) { if (first) count(el); return; }
            let i = 0;
            for (const c of el.children) {
                if (pluginNode(c) || c.closest('[data-edit-ghost]') || isGenerated(c)) continue;
                const p = path === '' ? String(i) : path + '.' + i;
                // Another component's markup is one opaque element here, its <x-name> host
                // (data-edit-host; its first root stands for it, the rest follow it)
                if (c._manifestComponent) {
                    if (extraRoot(c)) continue;
                    if (!c.hasAttribute('data-edit-host')) {
                        // Marked while still a placeholder: the components plugin carried its key over
                        const carried = c.getAttribute('data-edit-key'), own = canonKey(region, 'X-' + c._manifestComponent.toUpperCase() + ':');
                        let k = carried && (carried === own || carried.startsWith(own + '#')) ? carried : '!' + mint();
                        if (first && k[0] === '!') { const b = 'X-' + c._manifestComponent.toUpperCase() + ':', n = seen[b] = (seen[b] || 0) + 1; k = canonKey(region, n > 1 ? b + '#' + n : b); originAt.set(k, p); }
                        c.setAttribute('data-edit-host', k);
                    }
                    i++; continue;
                }
                walk(c, p);
                i++;
            }
        };
        walk(area, '');
    }
    const warnedRendered = new Set(), renderedRegions = new Set(), unwritableWhy = new Map();
    // A list whose records mnfst-run can't write: inline x-data, or a source manifest.json does not declare as a file.
    function dataUnwritable(area) {
        if (classify(area) !== 'data') return null;
        const m = (dataSourceExpr(area) || '').match(/\$x\.([\w$]+)/);
        if (!m) return 'inline x-data list: mnfst-run writes data only to CSV/JSON/YAML sources declared in manifest.json';
        const mf = window.ManifestComponentsRegistry && window.ManifestComponentsRegistry.manifest;
        if (!mf) return null;
        const src = (mf.data || {})[m[1]];
        if (src == null) return `data source '${m[1]}' is not declared in manifest.json: mnfst-run writes data only to CSV/JSON/YAML files declared there`;
        return typeof src === 'string' ? null : `data source '${m[1]}' is not a file (a cloud or remote source): save it with $x.${m[1]}.$update, not mnfst-run`;
    }
    function armArea(area) {
        const dw = dataUnwritable(area);
        if (dw) { renderedRegions.add(key(area)); unwritableWhy.set(key(area), dw); if (!warnedRendered.has(key(area))) { warnedRendered.add(key(area)); console.warn(`[edit] x-edit="${key(area)}": ${dw}; its edits stay on the page (and reach onPublish)`); } }
        if (area._edit.rendered) renderedRegions.add(key(area));
        if (area._edit.rendered && !warnedRendered.has(key(area))) { warnedRendered.add(key(area)); console.warn(`[edit] x-edit="${key(area)}" is inside content ${area._edit.rendered} renders: it edits on the page (and reaches onPublish), but mnfst-run cannot write it to a source file`); }
        uneditIn(null);
        const kind = classify(area);
        if (kind === 'static') markStatic(area);
        markPieces(area);
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(c => { if (ownsCap(c, 'size')) armSize(c); });
        if (kind === 'component') armComponent(area); else if (kind === 'static') armText(area);
        if (kind === 'data' && capOf(area, 'data')) armDataValues(area);
        if (!area._editBound) {
            area._editBound = true;
            area.addEventListener('pointerdown', onAreaPointerDown);
            area.addEventListener('keydown', (e) => { if (isActive(area)) onPieceKeydown(e, area); });
            area.addEventListener('pointerover', (e) => { if (isActive(area)) gripOver(e, area); });
            area.addEventListener('pointerleave', (e) => gripLeave(e.relatedTarget));
            area.addEventListener('focusin', (e) => { if (isActive(area)) gripFocus(e, area); });
            area.addEventListener('focusout', (e) => gripBlur(e.relatedTarget));
            // Native HTML5 drag would drop selected text into neighbouring leaves.
            area.addEventListener('dragstart', (e) => { if (isActive(area)) e.preventDefault(); });
            area.addEventListener('drop', (e) => { if (isActive(area)) e.preventDefault(); });
        }
        if (!area._editObserver) {
            area._editObserver = new MutationObserver((recs) => {
                if (dragged || area._rearmQueued || recs.every(r => r.target.isContentEditable)) return;
                area._rearmQueued = true;
                queueMicrotask(() => { area._rearmQueued = false; if (area._armed && isActive(area) && !dragged) armArea(area); });
            });
            area._editObserver.observe(area, { childList: true, subtree: true });
        }
    }
    function disarmArea(area) {
        if (gripFor && area.contains(gripFor)) hideGrip();
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(e => { if (e._editPos) { e.style.removeProperty('position'); e._editPos = false; } });
        area.querySelectorAll('[data-edit-handle]').forEach(h => h.remove());
        uneditIn(area);
        [area, ...area.querySelectorAll('[contenteditable]')].forEach(e => { if (e.hasAttribute('contenteditable')) e.removeAttribute('contenteditable'); e._pieceMode = false; e.removeAttribute('data-edit-piece-mode'); });
        area.querySelectorAll('[data-edit-piece]').forEach(unmarkPiece);
        [area, ...area.querySelectorAll('[data-edit-area]')].forEach(e => { e._sizeBound = false; });
        if (grabbed && area.contains(grabbed.item)) cancelGrab();
    }

    /* ---- Activation: always-on by default; .gated waits for $edit.on() ---- */
    let estore, booted = false, armQueued = false;
    const isActive = (a) => !!a && !!a._edit && (!a._edit.gated || !!(estore && estore.active)) && !sharedKey(a);
    const warnedShared = new Set();
    function armAll() {
        const fresh = [];
        areas().forEach(a => {
            if (!sharedKey(a)) return;
            if (!warnedShared.has(key(a))) { warnedShared.add(key(a)); console.warn(`[edit] x-edit="${key(a)}" is on the page more than once (a component used several times); it is not editable here`); }
            if (a._armed) { disarmArea(a); a._armed = false; }
        });
        areas().forEach(a => { if (isActive(a) && !a._armed) { if (!a._editBound) fresh.push(a); lastSnap[key(a)] = snapshot(a, classify(a)); armArea(a); a._armed = true; } });
        // A region mounted again after boot (x-if, a deferred route) shows the edits the log still holds for it
        if (booted && fresh.length) {
            if (log.some(d => /^st-/.test(d.kind))) { surfaceConflicts(fresh); applyStaticState(); }
            if (log.some(d => d.kind === 'cmp-main' || d.kind === 'cmp-inst')) applyComponentState();
        }
        armThemeControls(); refresh(); booted = true;
    }

    // Regions rendered after boot (x-if, routes, lazy components) arm through the directive.
    function armLater() {
        if (!booted || armQueued) return;
        armQueued = true;
        queueMicrotask(() => { armQueued = false; armAll(); });
    }
    function releaseEdit(el) {
        Object.keys(themeScopes).forEach(k => { if (themeScopes[k] === el) delete themeScopes[k]; });
        cssvarControls.delete(el);
        if (!editEls.has(el)) return;
        if (el._armed) { disarmArea(el); el._armed = false; }
        if (el._editObserver) { el._editObserver.disconnect(); el._editObserver = null; }
        editEls.delete(el); delete el._edit; resetAreas();
        el.removeAttribute('data-edit-area');
        if (target && (target === el || el.contains(target))) setTarget(null);
        refresh();
    }

    /* ---- Source patches: every area ----
       A static area publishes its FINAL structure as a tree of identities. Each node
       names a source element (key, plus its origin path as a fallback), carries its
       own edits, and lists children only where structure changed beneath it; a node
       without children keeps its source markup. Copies name the element they copy.
       Removed source elements are listed so the writer can tell them from omissions. */
    const treeKids = (el) => realChildren(el).filter(c => !isGenerated(c));
    function staticTrees(ss) {
        const out = [];
        const editsFor = (id) => {
            const ops = ss.node[id]; if (!ops) return null;
            const e = {};
            Object.entries(ops).forEach(([prop, v]) => { e[prop] = (prop === 'class' || prop === 'style') && v === '' ? null : v; });
            return Object.keys(e).length ? e : null;
        };
        const nontrivial = (n) => n.edits || n.children || n.key[0] === '~';
        const live = keyMap(staticAreas()), scoped = inlineScoped();
        staticAreas().forEach(area => {
            const region = key(area), comp = sourceComponent(area);
            const ids = new Proxy({}, { get: (_, k) => { const o = originOf(String(k)), a = areaByKey(decodeURIComponent(o.slice(1, o.indexOf('@', 1)))); const m = baseIds && a && baseIds[sourceFile(a)]; return m ? m[o] : undefined; } });
            // The children a restructured container had when the page loaded (the server refuses
            // the rewrite if the source no longer has them).
            const baseOf = (parent) => {
                const list = parent === '' ? (ss.orderBase[region] || {})[''] : Object.values(ss.orderBase).map(m => m[parent]).find(Boolean);
                return list ? list.filter(k => k[0] === '@').map(k => { const b = { key: k }, at = originAt.get(k); if (at != null) b.at = at; if (ids && ids[k]) b.fp = ids[k]; return b; }) : null;
            };
            const build = (el, isRoot) => {
                const host = !isRoot && el.getAttribute('data-edit-host');
                if (host) { if (host[0] === '!') return null; const h = { key: host }, at = originAt.get(host); if (at != null) h.at = at; if (ids && ids[host]) h.fp = ids[host]; return h; }
                if (!isRoot && el._manifestComponent) return null;
                const id = el.getAttribute('data-edit-key');
                if (!id || id[0] === '!') return null;
                const n = { key: id };
                const at = originAt.get(originOf(id)); if (at != null) n.at = at;
                if (ids && ids[originOf(id)]) n.fp = ids[originOf(id)];
                const e = editsFor(id); if (e) n.edits = e;
                if (scoped.has(el)) n.edits = Object.assign({}, n.edits, { style: ownStyle(el) || null });
                if (!(e && 'text' in e) && !isRendered(el) && !el.hasAttribute('data-rich-text')) {
                    const kids = treeKids(el).map(c => build(c)).filter(Boolean);
                    const structural = ss.touched.has(isRoot ? '#' + region : id);
                    if (id[0] === '~' || structural) { n.children = kids; const b = structural && id[0] !== '~' && baseOf(isRoot ? '' : id); if (b) n.base = b; }
                    else if (kids.some(nontrivial)) { n.children = kids.filter(nontrivial); n.path = true; }   // only a path to edits: the source keeps its own order
                }
                return n;
            };
            const tree = build(area, true);
            if (!tree || !(tree.edits || tree.children)) return;
            delete tree.at; delete tree.fp;
            out.push(comp ? { kind: 'static-tree', region, component: comp, tree } : { kind: 'static-tree', region, tree });
        });
        // Removed: named by a structural delta's `before`, absent from every current order.
        const placedKeys = new Set();
        new Set([...Object.keys(ss.orderBase), ...Object.keys(ss.order)]).forEach(r => {
            Object.values(Object.assign({}, ss.orderBase[r] || {}, ss.order[r] || {})).forEach(ks => ks.forEach(k => placedKeys.add(k)));
        });
        const removed = new Set();
        for (let i = 0; i < cursor; i++) {
            const d = log[i];
            if (d.kind === 'st-children') d.before.forEach(k => { if (k && k[0] === '@' && !placedKeys.has(k) && !live.has(k)) removed.add(k); });
        }
        const regionOfKey = (k) => decodeURIComponent(k.slice(1, k.indexOf('@', 1)));
        removed.forEach(k => {
            const r = regionOfKey(k);
            let p = out.find(x => x.region === r);
            if (!p) { const a = areaByKey(r); if (!a || sharedKey(a)) return; const c = sourceComponent(a); p = c ? { kind: 'static-tree', region: r, component: c, tree: { key: '' } } : { kind: 'static-tree', region: r, tree: { key: '' } }; out.push(p); }
            (p.removed = p.removed || []).push(k);
        });
        return out;
    }
    function buildPatches() {
        const patches = Object.entries(fold()).map(([k, v]) => patchFor(k, v.kind, v.snap));
        staticTrees(staticState()).forEach(p => patches.push(p));
        const toEdits = (paths) => {
            const e = [];
            Object.entries(paths).forEach(([path, props]) => Object.entries(props).forEach(([prop, value]) => e.push({ path, key: path, prop, value })));
            return e;
        };
        const dv = dataValueState();
        const dvRegion = {}; log.slice(0, cursor).forEach(d => { if (d.kind === 'data-val') dvRegion[d.source] = d.region; });
        Object.entries(dv).forEach(([source, recs]) => Object.entries(recs).forEach(([id, fields]) => Object.entries(fields).forEach(([field, value]) => patches.push({ kind: 'data-val', region: dvRegion[source], source, id, field, value }))));
        const { main, inst, reverts } = componentState();
        Object.entries(main).forEach(([component, paths]) => { const edits = toEdits(paths); if (edits.length) patches.push({ kind: 'component', scope: 'main', component, edits }); });
        new Set([...Object.keys(inst), ...Object.keys(reverts)]).forEach(region => {
            const area = areaByKey(region); if (!area) return;
            const edits = toEdits(inst[region] || {}), rv = [...(reverts[region] || [])];
            if (edits.length || rv.length) patches.push({ kind: 'component', scope: 'instance', component: componentName(area), region, edits, reverts: rv });
        });
        themePatches().forEach(p => patches.push(p));
        return patches;
    }
    // The source now holds every published edit: history starts again from here, and
    // identities are re-derived from the page as a fresh load of that source would.
    // Deltas for areas not on the page were not published; they stay, as do those of
    // `keep` (areas a publish left out), whose identities are left as they are.
    function rebase(keep) {
        const mounted = (r) => r == null || (!!areaByKey(r) && !(keep && keep.has(r)));
        const pending = (d) => d.kind === 'theme' ? !!keep && (keep.has('theme|' + (d.scope || '') + '|' + d.var) || keep.has(d.scope)) : (d.kind === 'st-move' ? [d.from, d.to] : [d.region]).some(r => !mounted(r));
        // Runtime locks are app state, not source: carried over by element.
        const locks = [];
        const lockState = lockStateNow();
        keyMap(staticAreas().filter(a => !(keep && keep.has(key(a))))).forEach((el, k) => { const m = lockState.get(k); if (m && m.size) locks.push([el, new Map(m), k === el.getAttribute('data-edit-host')]); });
        const nonStaticLocks = log.slice(0, cursor).filter(d => d.kind === 'lock' && !/^[~@]/.test(d.key) && !pending(d));
        let c = 0;
        log = log.filter((d, i) => { const keep = pending(d); if (keep && i < cursor) c++; return keep; });
        cursor = c; ver++;
        const relock = () => {
            const add = (d) => { log.splice(cursor, 0, d); cursor++; if (persistOf(d.region)) persisted.add(d); };
            nonStaticLocks.forEach(add);
            locks.forEach(([el, m, host]) => {
                const a = host ? blockArea(el) : regionOf(el), k = el.getAttribute(host ? 'data-edit-host' : 'data-edit-key'); if (!a || !k) return;
                [true, false].forEach(v => { const acts = [...m].filter(([, x]) => x === v).map(([act]) => act); if (acts.length) add({ kind: 'lock', region: key(a), key: k, actions: acts.length === LOCK_ACTIONS.length ? [] : acts, value: v }); });
            });
            ver++;
        };
        saveState();
        const keptAt = keep ? [...originAt].filter(([k]) => keep.has(decodeURIComponent(k.slice(1, k.indexOf('@', 1))))) : [];
        originAt.clear();
        keptAt.forEach(([k, p]) => originAt.set(k, p));
        areas().forEach(a => {
            if (keep && keep.has(key(a))) return;
            const kind = classify(a);
            a._baseText = {}; a._baseClass = {}; a._baseStyle = {};
            if (kind === 'static') {
                [a, ...a.querySelectorAll('[data-edit-key]')].forEach(n => { if (regionOf(n) === a) n.removeAttribute('data-edit-key'); });
                a.querySelectorAll('[data-edit-host]').forEach(n => { if (regionOf(n.parentElement) === a) n.removeAttribute('data-edit-host'); });
                a._marked = false; markStatic(a);
            }
            if (kind === 'component' && a._armed) armComponent(a);
            lastSnap[key(a)] = snapshot(a, kind);
        });
        rebaseTheme(keep);
        relock();
        saveState(); refresh();
    }
    const published = (r) => !(r && Array.isArray(r.results) && r.results.some(x => x && x.status === 'error'));
    // Source file hashes as the page loaded them (mnfst-run --edit); a publish carries them
    // so the server can refuse when a file changed underneath this page.
    // With them, each source element's fingerprint as loaded: the server refuses an edit
    // whose element no longer matches (changed, or a twin that moved).
    let baseFiles = null, baseIds = null;
    function loadBase(filesOnly) {
        if (!/^https?:$/.test(location.protocol) || typeof fetch !== 'function') return Promise.resolve(null);
        return fetch('/__edit/base', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => {
            if (j && j.files) baseFiles = j.files;
            if (j && j.ids && !filesOnly) baseIds = j.ids;
            return baseFiles;
        }).catch(() => null);
    }
    // Stylesheets and data hot-swap: their new hash applies. HTML waits for the reload
    // (a cancelled one leaves the page on what it loaded); our own writes advance on publish.
    // HTML that changes before the base arrives makes a late base untrustworthy.
    let movedUnbased = false;
    window.addEventListener('manifest:source-change', (e) => {
        const d = e.detail || {}, html = /\.html?$/i.test(d.file || '');
        if (html && !baseIds) movedUnbased = true;
        if (baseFiles && d.file && d.hash && !html) baseFiles[d.file] = d.hash;
    });
    // A refusal for files changed since load keeps the log and reports them ($edit.stale,
    // `edit:stale`). Reload to take the new source, or publish({ rebase: true }) to write
    // the edits over it; the history is kept until a publish succeeds.
    // The live reload a successful publish of ours triggers is not taken: the page is
    // already rebased, and typing begun since would be lost. Reloads that arrive while a
    // publish is in flight wait for its answer; anything not written by it still reloads.
    // After a stale refusal or a rebase write the page shows an older source than the file,
    // so no reload is ours to skip, and with no live reload coming the page reloads itself.
    // A reload never discards edits it cannot restore: with unpersisted edits pending, the
    // page stays and says so (edit:stale), so they can be published first.
    let ownWrites = null, inFlight = 0, held = [], resync = false, heldReload = null;
    const ours = (files) => !resync && !!ownWrites && Date.now() < ownWrites.until && files.length > 0 && files.every(f => f && ownWrites.files[f.rel] && ownWrites.files[f.rel] === f.hash);
    // A reload is safe when every applied edit survives it (persisted), and no focused leaf holds
    // typing not yet logged (a persisting one is committed first). Undone steps never hold it.
    // Typing in a focused leaf, not yet logged (it is, on blur): committed now when `force` or its region persists
    function commitFocused(force) {
        const f = document.activeElement;
        if (!f || !f._commitText || f._preEdit === undefined || !f.isContentEditable || leafText(f) === f._preEdit) return true;
        const a = regionOf(f);
        if (!a || (!force && !a._edit.persist)) return false;
        f._commitText(); restartRich(f); f._preEdit = leafText(f);
        return true;
    }
    // Grows a set of held regions by the regions moves tie to them (`via`: held -> the region it is tied to).
    function tie(held) {
        const via = new Map();
        for (let grew = true; grew;) {
            grew = false;
            log.slice(0, cursor).forEach(d => {
                if (d.kind !== 'st-move' || held.has(d.from) === held.has(d.to)) return;
                const [had, add] = held.has(d.from) ? [d.from, d.to] : [d.to, d.from];
                held.add(add); via.set(add, via.get(had) || had); grew = true;
            });
        }
        held.via = via;
        return held;
    }
    // Edits mnfst-run can't write (a generated region's own, a move in or out of one, and a piece
    // moved from one) never hold a reload: it regenerates that markup (.persist keeps them).
    // A writable region a move ties to one still holds: it is published once that move is undone.
    const keyRegion = (k) => { if (typeof k !== 'string') return null; const o = originOf(k); return o[0] === '@' ? o.slice(1, o.indexOf('@', 1)) : null; };
    const unwritableEdit = (d) => renderedRegions.has(d.region) || renderedRegions.has(d.from) || renderedRegions.has(d.to) || renderedRegions.has(keyRegion(d.path)) || renderedRegions.has(keyRegion(d.key));
    const regionsOf = (ds) => [...new Set(ds.flatMap(d => [d.region, d.from, d.to]).filter(Boolean))];
    const unsaved = () => log.slice(0, cursor).filter(d => d.kind !== 'lock' && !persisted.has(d));
    function focusedRegion() { const f = document.activeElement, a = f && f._commitText && regionOf(f); return a ? key(a) : null; }
    function reloadSafe() {
        if (!commitFocused(false) && !renderedRegions.has(focusedRegion())) return false;
        // Unpersisted edits exist only for regions of this document (mounted or not): they hold it
        return unsaved().every(unwritableEdit);
    }
    function warnDiscarded() {
        const f = focusedRegion(), lost = regionsOf(unsaved().filter(unwritableEdit));
        if (f && renderedRegions.has(f) && !commitFocused(false) && !lost.includes(f)) lost.push(f);
        if (lost.length) console.warn(`[edit] the source changed: reloading discards the unpublished edits of ${lost.map(r => `x-edit="${r}"`).join(', ')} that mnfst-run can't write (generated content, or a piece moved from it); .persist keeps them`);
    }
    function reloadNow() { warnDiscarded(); location.reload(); }
    // A held reload is taken as soon as nothing it would lose remains
    function takeHeldReload() { if (heldReload && reloadSafe()) { heldReload = null; reloadNow(); } }
    function reloadIfSafe(files) {
        if (reloadSafe()) return reloadNow();
        heldReload = files;
        const changed = files.map(f => f && f.rel).filter(Boolean);
        if (estore) estore.stale = [...new Set([...(estore.stale || []), ...changed])];
        const holding = regionsOf(unsaved().filter(d => !unwritableEdit(d))).filter(r => !renderedRegions.has(r));
        const f = focusedRegion(); if (f && !renderedRegions.has(f) && !holding.includes(f) && !commitFocused(false)) holding.push(f);
        const off = tie(new Set(renderedRegions)), tied = holding.filter(r => off.has(r));
        const name = (rs) => rs.map(r => `x-edit="${r}"`).join(', ');
        console.warn(`[edit] the source changed, but a reload would lose unpublished edits${holding.length ? ' to ' + name(holding) : ''}: publish (with rebase), then reload`
            + (tied.length ? `. ${name(tied)} ${tied.length > 1 ? 'are' : 'is'} tied by a move to ${name([...new Set(tied.map(r => off.via.get(r)))])}, which mnfst-run can't write: undo that move to publish ${tied.length > 1 ? 'them' : 'it'}, or publish the rest` : ''));
        document.dispatchEvent(new CustomEvent('edit:stale', { detail: { files: changed } }));
    }
    window.addEventListener('manifest:live-reload', (e) => {
        const files = (e.detail && e.detail.files) || [];
        if (inFlight) { e.preventDefault(); held.push(files); return; }
        if (ours(files)) { e.preventDefault(); return; }
        if (!reloadSafe()) { e.preventDefault(); reloadIfSafe(files); }
        else warnDiscarded();
    });
    function settled(r, rebased) {
        inFlight = Math.max(0, inFlight - 1);
        if (r && r.base) ownWrites = { files: Object.assign({}, r.base), until: Date.now() + 3000 };
        if (r && Array.isArray(r.stale) && r.stale.length) resync = true;
        if (rebased && published(r) && r.base) { resync = true; setTimeout(() => { if (resync) reloadIfSafe(Object.keys(r.base).map(rel => ({ rel }))); }, 1500); }
        if (inFlight) return;
        const pending = held; held = [];
        if (pending.some(f => !ours(f))) reloadIfSafe(pending.flat());
    }
    // Publishes run one at a time: a second waits for the first, then builds on its result.
    let publishing = Promise.resolve();
    function publish(opts) {
        const next = publishing.then(() => publishNow(opts));
        publishing = next.catch(() => { });
        return next;
    }
    // Once a rebase writes over HTML changed elsewhere, the page shows less than the file:
    // its HTML hashes are not taken (a plain publish is stale until a reload), nor the
    // fingerprints of keys with twins there (which may not be the elements this page shows).
    let overNewer = false;
    function publishNow(opts) {
        const done = (r, keep, heldRes) => {
            if (r && r.base && baseFiles) Object.entries(r.base).forEach(([f, h]) => { if (!overNewer || !/\.html?$/i.test(f)) baseFiles[f] = h; });
            if (r && r.ids && baseIds) {
                if (!overNewer) baseIds = r.ids;
                else Object.entries(r.ids).forEach(([f, m]) => { baseIds[f] = Object.assign({}, baseIds[f]); Object.entries(m || {}).forEach(([k, fp]) => { if (!String(fp).includes('.')) baseIds[f][k] = fp; }); });
            }
            const stale = r && Array.isArray(r.stale) ? r.stale : [];
            if (estore) estore.stale = stale;
            if (stale.length) document.dispatchEvent(new CustomEvent('edit:stale', { detail: { files: stale } }));
            if (published(keep ? { results: r.results.filter(x => !(x && (keep.has(x.region) || (heldRes && heldRes.has(x))))) } : r)) rebase(keep);
            takeHeldReload();
            return r;
        };
        // An area the writer could not resolve does not hold the others back: they are sent
        // again without it (and areas a move ties to it); its edits stay, its refusal is returned.
        const leftOut = (r, patches) => {
            if (!r || !Array.isArray(r.results) || (Array.isArray(r.stale) && r.stale.length)) return null;
            const failed = new Set(r.results.filter(x => x && x.failed != null).map(x => x.failed));
            const own = new Set(patches.filter((p, i) => r.results[i] && r.results[i].status === 'error' && r.results[i].failed == null && p.kind !== 'static-tree'));
            if ((!failed.size && !own.size) || r.results.some((x, i) => x && x.status === 'error' && !failed.has(patches[i] && patches[i].region) && !own.has(patches[i]))) return null;
            tie(failed);
            const out = (p) => own.has(p) || (p.region != null && failed.has(p.region));
            if (!patches.some(p => !out(p))) return null;
            return Object.assign(failed, { own, out });
        };
        // What a held-back patch keeps in the log: its region's edits, or its theme value.
        const keepOf = (p) => p.kind === 'theme' ? 'theme|' + (p.scope || '') + '|' + p.var : p.region;
        // An area inside generated content (x-markdown output and the like) edits on the page,
        // but its markup is in no file mnfst-run can write: it is refused by name, not sent.
        const renderedBy = (region) => { const a = areaByKey(region); return a && a._edit.rendered; };
        const unwritable = (p) => p.region != null && p.kind !== 'theme' && renderedRegions.has(p.region);
        const send = () => {
            commitFocused(true);   // typing under way publishes with the rest (identities are re-derived from the page after)
            const patches = buildPatches();
            if (estore && typeof estore.onPublish === 'function') return Promise.resolve(estore.onPublish(patches, { log, cursor })).then(done);
            if (!patches.length) { takeHeldReload(); return Promise.resolve({ results: [] }); }   // nothing to send: a held reload goes now
            const post = (ps) => { inFlight++; return fetch('/__edit/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patches: ps, base: baseFiles }) }).then(r => r.json()).catch(err => { settled(null); throw err; }); };
            const off = tie(new Set(patches.filter(unwritable).map(p => p.region)));
            const offResult = (p) => ({ region: p.region, status: 'error', reason: unwritableWhy.has(p.region) && unwritable(p) ? `x-edit="${p.region}": ${unwritableWhy.get(p.region)}`
                : renderedBy(p.region) && unwritable(p) ? `x-edit="${p.region}" is inside content ${renderedBy(p.region)} renders, so mnfst-run can't write it to a source file`
                : `not published: tied by a move to x-edit="${off.via.get(p.region)}", which mnfst-run can't write` });
            const sendable = patches.filter(p => !off.has(p.region));
            // The sent part's answer, merged with what was held back, as one result per patch.
            const finish = (r, held, sent) => {
                const keep = new Set([...off, ...(held || []), ...(held ? sent.filter(held.out).map(keepOf) : [])]);
                const heldRes = new Set();
                const results = patches.map(p => { if (off.has(p.region)) { const x = offResult(p); heldRes.add(x); return x; } const x = r.results[sent.indexOf(p)]; if (held && held.out(p)) heldRes.add(x); return x; });
                const o = done(Object.assign({}, r, { results }), keep.size ? keep : undefined, heldRes); settled(r, !!(opts && opts.rebase)); return o;
            };
            if (!sendable.length) { const o = done({ results: patches.map(offResult) }, off); return Promise.resolve(o); }
            return post(sendable).then(r => {
                const out = leftOut(r, sendable);
                if (!out) return finish(r, null, sendable);
                settled(r, false);
                const rest = sendable.filter(p => !out.out(p));
                return post(rest).then(r2 => {
                    const results = sendable.map((p, i) => out.out(p)
                        ? (r.results[i] && r.results[i].status === 'error' ? r.results[i] : { region: p.region, status: 'error', reason: `not published: tied by a move to x-edit="${out.via.get(p.region) || [...out].find(x => !out.via.has(x))}", which failed` })
                        : r2.results[rest.indexOf(p)]);
                    return finish(Object.assign({}, r2, { results }), out, sendable);
                });
            });
        };
        // mnfst-run gets a publish only with the base the page loaded; a missing one is
        // fetched once more, else the publish is refused and the history kept.
        const refuse = (reason) => { const patches = buildPatches(); return patches.length ? done({ results: patches.map(p => ({ region: p.region, status: 'error', reason })) }) : { results: [] }; };
        const custom = estore && typeof estore.onPublish === 'function';
        const based = custom || (baseFiles && baseIds) ? Promise.resolve(null)
            : movedUnbased ? Promise.resolve('the source changed before this page could read its base from the dev server; reload to continue')
            : loadBase().then(() => baseFiles && baseIds ? null : 'the dev server\'s base (/__edit/base) could not be read, so nothing can be checked against the source; nothing was published');
        const rebaseSend = () => {
            const was = Object.assign({}, baseFiles);
            return loadBase(true).then(() => { if (Object.keys(baseFiles || {}).some(f => /\.html?$/i.test(f) && was[f] !== baseFiles[f])) overNewer = true; return send(); });
        };
        return based.then(why => why ? refuse(why) : opts && opts.rebase ? rebaseSend() : send());
    }
    function on() { if (estore) estore.active = true; armAll(); }
    function off() {
        if (estore) estore.active = false;
        areas().forEach(a => { if (a._edit.gated && a._armed) { disarmArea(a); a._armed = false; } });
        refresh();
    }


    function refresh() {
        if (!estore) return;
        estore.canUndo = cursor > 0;
        estore.canRedo = cursor < log.length;
        estore.version = (estore.version || 0) + 1;
        if (heldReload) setTimeout(takeHeldReload, 0);
    }

    /* ---- Undo/redo hotkeys: Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Ctrl+Y ----
       On wherever a region is active; data-edit-hotkeys="off" on a region or any
       ancestor opts it out. Text that is still being typed keeps the browser's own
       undo until it commits on blur; fields and x-rich-text keep theirs always. A leaf
       on Rich Text uses Rich Text's history while it has steps (richHistoryKey). */
    // Text as it would be logged: every baseline and comparison goes through the same sanitizer
    const leafText = (el) => el._editField && !el._editRich ? el.textContent : sanitizeFor(el, el.innerHTML.trim());
    const hotkeysOff = (el) => !!el.closest('[data-edit-hotkeys="off"]');
    // A focused leaf's baseline follows history rewrites under the caret.
    function rebaseFocused() {
        const el = document.activeElement;
        if (!el || el._preEdit === undefined || !el.isContentEditable) return;
        const sync = () => { if (document.activeElement === el) { restartRich(el); el._preEdit = leafText(el); } };
        sync(); setTimeout(sync, 0);
    }
    function historyDir(e) {
        if (e.altKey || !(e.metaKey || e.ctrlKey)) return null;
        const k = (e.key || '').toLowerCase();
        if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
        return k === 'y' && e.ctrlKey && !e.metaKey && !e.shiftKey ? 'redo' : null;
    }
    function onHistoryKey(e) {
        if (e.defaultPrevented || dragged) return;   // never mid-drag
        const dir = historyDir(e); if (!dir) return;
        const isRedo = dir === 'redo';
        const t = e.target && e.target.nodeType === 1 ? e.target : document.body;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || authoredRich(t.closest('[data-rich-text]'))) return;
        const region = t.closest('[data-edit-area]');
        if (region) {
            const top = regionOf(region);
            if (!top || !isActive(top) || hotkeysOff(region)) return;
        } else {
            if (t.isContentEditable) return;                         // someone else's editor
            if (!areas().some(a => isActive(a) && !hotkeysOff(a))) return;
        }
        if (t.isContentEditable && t._preEdit !== undefined && leafText(t) !== t._preEdit) return;   // uncommitted typing: native undo
        if (isRedo ? cursor >= log.length : cursor === 0) return;
        e.preventDefault();
        isRedo ? redo() : undo();
    }


    /* ---- Restore persisted edits + boot ---- */
    // Deltas for areas that no longer persist are dropped before replay.
    function pruneLoaded() {
        const stale = (d) => {
            const regions = d.kind === 'st-move' ? [d.from, d.to] : d.region != null ? [d.region] : [];
            return regions.some(r => { const a = areaByKey(r); return a && !a._edit.persist; });
        };
        if (!log.some(stale)) return;
        let c = 0;
        const kept = log.filter((d, i) => { const keep = !stale(d); if (keep && i < cursor) c++; return keep; });
        log = kept; cursor = c; ver++;
        saveState();
    }
    function restore() {
        if (!log.length) return;
        pruneLoaded();
        for (const [k, v] of Object.entries(fold())) { const area = areaByKey(k); if (area && v.kind === 'data') waitForData(area, () => applySnap(area, 'data', v.snap)); }
        if (log.some(d => /^st-/.test(d.kind))) { surfaceConflicts(areas()); applyStaticState(); }
        if (log.some(d => d.kind === 'cmp-main' || d.kind === 'cmp-inst')) applyComponentState();
        if (log.some(d => d.kind === 'data-val')) { const da = areas().find(a => classify(a) === 'data'); if (da) waitForData(da, applyDataValues); }
        if (log.some(d => d.kind === 'theme')) applyThemeState();
        if (log.some(d => d.kind === 'lock')) areas().forEach(rearm);
        refresh();
    }
    function waitForData(area, cb) { const expr = dataSourceExpr(area), tpl = listTpl(area); let n = 0; const t = setInterval(() => { let r = false; try { r = Array.isArray(window.Alpine.evaluate(tpl, expr)); } catch { } if (r) { clearInterval(t); cb(); } else if (++n > 100) clearInterval(t); }, 50); }
    let inited = false;
    function init() {
        if (inited || !window.Alpine || !Alpine.directive) return;
        inited = true;
        // Alpine walks only x-data trees: a page with none still gets its areas
        if (document.body && !document.body.hasAttribute('x-data')) document.body.setAttribute('x-data', '{}');
        Alpine.directive('edit', (el, { modifiers, expression }, { cleanup }) => {
            registerEdit(el, modifiers, expression);
            armLater();
            cleanup(() => releaseEdit(el));
        });
        Alpine.store('edit', {
            active: false, canUndo: false, canRedo: false, version: 0, stale: [], conflicts: [],
            onPublish: null,
            toggle() { this.active ? off() : on(); }, on() { on(); }, off() { off(); },
            undo() { return undo(); }, redo() { return redo(); },
            publish(opts) { return publish(opts); },
            patches() { return buildPatches(); },
            export() { return JSON.parse(JSON.stringify({ log, cursor })); },
            get target() { void this.version; return target; },
            set target(el) { setBlockTarget(el); },
            can(action, el) { void this.version; return canDo(action, el === undefined ? target : el); },
            lock(el, action) { return setLock(el === undefined ? target : el, action, true); },
            unlock(el, action) { return setLock(el === undefined ? target : el, action, false); },
            copy(el) { return copyBlock(el); },
            cut(el) { return cutBlock(el); },
            paste(el) { return pasteBlock(el); },
            duplicate(el) { return duplicateBlock(el); },
            remove(el) { return removeBlock(el); },
            move(el, dest, before) { return moveBlock(el, dest, before); },
            nest(el) { const p = asPiece(el === undefined ? target : el); return !!p && movable(p) && nestInto(p); },
            unnest(el) { const p = asPiece(el === undefined ? target : el); return !!p && movable(p) && unnest(p); },
            block(node) { return pieceOf(node); },
            attr(name, value, el) { return setAttr(name, value, el); },
            classes: classesApi,
            scope(value, el) { void this.version; if (value && value.nodeType === 1) return scopeOf(value); return value == null ? scopeOf(el) : setScope(value, el); },
            revert(el) { return revert(el); },
            clearConflicts() { conflicts = []; this.conflicts = []; saveState(); }
        });
        estore = Alpine.store('edit');
        const editMagic = () => Alpine.store('edit');
        Alpine.magic('edit', editMagic);
        // The loader's stand-in answered $edit until now: it hands over, and effects that read it run again
        window.__manifestEditMagic = editMagic;
        const kept = window.__manifestEditStubWrites;   // writes made on the stand-in ($edit.onPublish = …)
        if (kept) Object.keys(kept).forEach(k => { try { estore[k] = kept[k]; } catch { } delete kept[k]; });
        if (window.__manifestEditStub) setTimeout(() => { window.__manifestEditStub.v++; }, 0);
        loadState();
        if (window.__mnfstEdit) loadBase();   // only mnfst-run --edit serves the base
        setTimeout(() => { armAll(); restore(); }, 450);
        document.addEventListener('keydown', onHistoryKey);
        window.addEventListener('click', onAreaLinkClick, true);
        window.addEventListener('auxclick', onAreaLinkClick, true);
        document.addEventListener('contextmenu', onContextCapture, true);
        document.addEventListener('dropdown:context', onContextCapture, true);
        // SPA navigation: the state so far is saved under the page it was made on.
        window.addEventListener('manifest:route-change', () => { if (lsPath !== location.pathname) { lsPath = location.pathname; saveState(); } });
        adopt();
    }
    // Loaded after Alpine started: x-edit elements its walk passed get their attributes re-set
    // (Alpine runs them as new directives); those it never walked (no x-data above) are walked now.
    function adopt() {
        if (!window.__manifestAlpineStarted && ![...document.querySelectorAll('[x-data]')].some(e => e._x_marker)) return;
        const isEdit = (n) => /^x-edit(\.|$)/.test(n);
        const found = [...document.querySelectorAll('*')].filter(el => !el._edit && [...el.attributes].some(a => isEdit(a.name)));
        found.forEach(el => { if (el._x_marker) [...el.attributes].filter(a => isEdit(a.name)).forEach(a => el.setAttribute(a.name, a.value)); });
        if (found.some(el => !el._x_marker)) Alpine.initTree(document.body);
    }
    document.addEventListener('alpine:init', init);
    if (window.Alpine && Alpine.directive) setTimeout(init, 0);
})();


})();
