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
            else if (n.nodeType === 1 && !pluginNode(n) && n.tagName !== 'TEMPLATE' && !isGenerated(n)) t += sourceText(n);
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
            const assigned = el.getAttribute('data-edit-key');
            if (assigned) return assigned;
            const base = staticKey(el);
            const n = seen[base] = (seen[base] || 0) + 1;
            return n > 1 ? base + '#' + n : base;
        });
    }
    const loadState = () => {
        try {
            lsPath = location.pathname;
            const s = JSON.parse(localStorage.getItem(lsKey(lsPath)));
            if (s && s.v === SCHEMA) { log = s.log || []; cursor = s.cursor ?? log.length; log.forEach(d => persisted.add(d)); }
            else if (s) localStorage.removeItem(lsKey(lsPath));
        } catch { }
    };
    const saveState = (path = location.pathname) => {
        if (log.length > HISTORY_CAP) { const n = log.length - HISTORY_CAP; log.splice(0, n); cursor = Math.max(0, cursor - n); }
        const done = log.slice(0, cursor).filter(d => persisted.has(d)), ahead = log.slice(cursor).filter(d => persisted.has(d));
        try {
            if (!done.length && !ahead.length) localStorage.removeItem(lsKey(path));
            else localStorage.setItem(lsKey(path), JSON.stringify({ v: SCHEMA, log: [...done, ...ahead], cursor: done.length }));
        } catch { }
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
    const keptComment = (d) => !/^-?>|--|<!-|-$/.test(d);
    const commentsIn = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT), out = []; for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n); return out; };
    // A leaf's text delta keeps its comments, unless one cannot be kept: then it stays granular.
    const commentsKept = (el) => commentsIn(el).every(c => keptComment(c.data));
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
        commentsIn(t.content).forEach(c => { if (keptComment(c.data)) { c.replaceWith('\uE000' + kept.length + '\uE001'); kept.push(c.data); } else c.remove(); });
        t.innerHTML = inlineClean(t.innerHTML);
        if (kept.length) {
            const w = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT), texts = [];
            for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes('\uE000')) texts.push(n);
            texts.forEach(n => n.replaceWith(...n.nodeValue.split(/(\uE000\d+\uE001)/).filter(Boolean).map(p => /^\uE000\d+\uE001$/.test(p) ? document.createComment(kept[+p.slice(1, -1)]) : document.createTextNode(p))));
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
        el._edit = { key: k, caps, gated: modifiers.includes('gated'), theme, persist: modifiers.includes('persist'), bare };
        el.setAttribute('data-edit-area', bare ? 'bare' : '');
        editEls.add(el); resetAreas();
    }
    let areasCache = null;
    const areas = () => areasCache || (areasCache = [...editEls].filter(el => { for (let n = el.parentElement; n; n = n.parentElement) if (n._edit) return false; return true; }));
    const resetAreas = () => { areasCache = null; };
    const areaByKey = (k) => areas().find(a => a._edit.key === k);
    const topArea = (a) => !!a && areas().includes(a);
    const regionOf = (el) => el && areas().find(a => a === el || a.contains(el));
    const key = (area) => area._edit.key;
    function editInfo(node) { for (let n = node; n; n = n.parentElement) if (n._edit) return n._edit; return null; }
    const capOf = (node, cap) => { const i = editInfo(node); return !!i && i.caps.has(cap) && !lockedFor(node, cap); };
    const ownsCap = (el, cap) => !!el._edit && el._edit.caps.has(cap) && !lockedFor(el, cap);
    const persistOf = (region) => { const a = region != null && areaByKey(region); return !!(a && a._edit.persist); };

    /* ---- Regime classification ---- */
    function classify(area) {
        if (listTpl(area)) return 'data';
        if (area.matches('[data-component]') || area.querySelector('[data-component]')) return 'component';
        return 'static';
    }
    function dataSourceExpr(area) { const t = listTpl(area); const m = t && t.getAttribute('x-for').match(/\bin\s+(.+)$/); return m ? m[1].trim() : null; }
    const dataSourceName = (area) => { const e = dataSourceExpr(area); const m = e && e.match(/\$x\.(\w+)/); return m ? m[1] : (e || 'source'); };
    const pluginNode = (x) => x.hasAttribute('data-edit-handle') || x.hasAttribute('data-edit-ghost') || x.hasAttribute('data-edit-grip');
    const realChildren = (el) => Array.from(el.children).filter(x => !pluginNode(x));
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
        if (!window.ManifestRichText || !commentsKept(el)) return false;
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
    function moveWith(el, place) { const lead = leadNodes(el); place(el); if (lead.length) el.before(...lead); }

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
        add(piece);
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
