/* Manifest Text Edit — rich text editing.

   One directive, two roles. Without a command modifier it marks the editable area
   and binds its value: x-text-edit="post". With one, it turns any element into a
   control for that area: <button x-text-edit.bold>. Controls need no wrapper and
   no shared parent — they resolve to an area by containment, then by focus, so a
   toolbar can sit anywhere and two dialogs in one DOM never cross wires.

   Markdown by default (portable, and x-markdown renders it straight back);
   .html stores sanitized HTML; .plain stores text.

   Serialization is a closed round trip over exactly what the commands can produce —
   headings, bold, italic, strike, code, links, lists, quote, rule. Markdown the
   editor can't author (tables, footnotes) is not a silent lossy convert: use .html. */

(function () {

    const BLOCK = 'H1 H2 H3 H4 H5 H6 P BLOCKQUOTE PRE UL OL LI HR DIV'.split(' ');
    const MARKS = { STRONG: '**', B: '**', EM: '*', I: '*', S: '~~', DEL: '~~', CODE: '`' };
    const INLINE_OK = new Set(['B', 'I', 'EM', 'STRONG', 'U', 'S', 'DEL', 'CODE', 'BR', 'A', 'SPAN']);

    /* ---- HTML → Markdown ---- */
    const esc = (t) => t.replace(/([\\`*_[\]])/g, '\\$1');

    function inline(node) {
        let out = '';
        node.childNodes.forEach(n => {
            if (n.nodeType === 3) { out += esc(n.textContent); return; }
            if (n.nodeType !== 1) return;
            const tag = n.tagName;
            if (tag === 'BR') { out += '  \n'; return; }
            if (tag === 'A') { const h = n.getAttribute('href') || ''; out += h ? `[${inline(n)}](${h})` : inline(n); return; }
            const m = MARKS[tag];
            if (!m) { out += inline(n); return; }
            const body = tag === 'CODE' ? n.textContent : inline(n);
            out += body.trim() ? m + body + m : body;
        });
        return out;
    }

    function block(node, depth) {
        if (node.nodeType === 3) { const t = node.textContent.trim(); return t ? esc(t) : ''; }
        if (node.nodeType !== 1) return '';
        const tag = node.tagName;
        if (tag === 'HR') return '---';
        if (tag === 'PRE') return '```\n' + node.textContent.replace(/\n$/, '') + '\n```';
        if (/^H[1-6]$/.test(tag)) return '#'.repeat(+tag[1]) + ' ' + inline(node).trim();
        if (tag === 'BLOCKQUOTE') return blocks(node, depth).split('\n').map(l => ('> ' + l).trimEnd()).join('\n');
        if (tag === 'UL' || tag === 'OL') {
            const pad = '    '.repeat(depth);
            return [...node.children].filter(li => li.tagName === 'LI').map((li, i) => {
                const bullet = tag === 'OL' ? `${i + 1}. ` : '- ';
                const nested = [...li.children].filter(c => c.tagName === 'UL' || c.tagName === 'OL');
                const own = inline(nestedStripped(li, nested)).trim();
                const sub = nested.map(n => block(n, depth + 1)).join('\n');
                return pad + bullet + own + (sub ? '\n' + sub : '');
            }).join('\n');
        }
        return inline(node).trim();
    }

    // A list item's own text is everything except its nested lists.
    function nestedStripped(li, nested) {
        if (!nested.length) return li;
        const c = li.cloneNode(true);
        [...c.children].forEach(ch => { if (ch.tagName === 'UL' || ch.tagName === 'OL') ch.remove(); });
        return c;
    }

    function blocks(root, depth) {
        const parts = [];
        root.childNodes.forEach(n => { const b = block(n, depth || 0); if (b) parts.push(b); });
        return parts.join('\n\n');
    }

    const toMarkdown = (root) => blocks(root, 0).replace(/\n{3,}/g, '\n\n').trim();

    /* ---- Markdown → HTML ---- */
    const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Escapes are masked out before the mark passes and restored last, so a literal
    // \* never gets read as emphasis and never comes back double-escaped.
    const HOLD = '\uE000';
    function inlineHtml(s) {
        const held = [];
        return escHtml(s)
            .replace(/\\([\\`*_~[\]])/g, (_, c) => HOLD + (held.push(c) - 1) + HOLD)
            .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/~~([^~]+)~~/g, '<s>$1</s>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, t, h) => /^\s*javascript:/i.test(h) ? t : `<a href="${h}">${t}</a>`)
            .replace(/ {2}\n/g, '<br>')
            .replace(new RegExp(HOLD + '(\\d+)' + HOLD, 'g'), (_, i) => held[+i]);
    }

    // Indented items nest. Depth is one level per four spaces — what the serializer emits.
    function renderList(items, i, depth) {
        const tag = items[i].tag;
        let html = `<${tag}>`;
        while (i < items.length && items[i].depth >= depth) {
            if (items[i].depth > depth) {
                const [sub, next] = renderList(items, i, items[i].depth);
                html = html.endsWith(`<${tag}>`) ? html + `<li>${sub}</li>` : html.replace(/<\/li>$/, sub + '</li>');
                i = next;
                continue;
            }
            if (items[i].tag !== tag) break;
            html += `<li>${inlineHtml(items[i].text)}</li>`;
            i++;
        }
        return [html + `</${tag}>`, i];
    }

    function fromMarkdown(md) {
        const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
        const out = [];
        let para = [], list = null, quote = null, fence = null;
        const flushPara = () => { if (para.length) { out.push(`<p>${inlineHtml(para.join('\n'))}</p>`); para = []; } };
        const flushList = () => { if (!list) return; for (let i = 0; i < list.length;) { const [html, next] = renderList(list, i, list[i].depth); out.push(html); i = next > i ? next : i + 1; } list = null; };
        const flushQuote = () => { if (quote) { out.push(`<blockquote>${fromMarkdown(quote.join('\n'))}</blockquote>`); quote = null; } };
        const flushAll = () => { flushPara(); flushList(); flushQuote(); };

        for (const raw of lines) {
            const line = raw.replace(/[^\S\n]+$/, m => m.length >= 2 ? '  ' : '');   // keep a hard break, drop stray trailing space
            if (fence !== null) { if (/^```/.test(line)) { out.push(`<pre><code>${escHtml(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(raw); continue; }
            if (/^```/.test(line)) { flushAll(); fence = []; continue; }
            if (!line.trim()) { flushAll(); continue; }
            const h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) { flushAll(); out.push(`<h${h[1].length}>${inlineHtml(h[2])}</h${h[1].length}>`); continue; }
            if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue; }
            const q = line.match(/^>\s?(.*)$/);
            if (q) { flushPara(); flushList(); (quote = quote || []).push(q[1]); continue; }
            const li = line.match(/^([ \t]*)([-*+]|\d+\.)\s+(.*)$/);
            if (li) {
                flushPara(); flushQuote();
                (list = list || []).push({ depth: Math.floor(li[1].replace(/\t/g, '    ').length / 4), tag: /\d/.test(li[2]) ? 'ol' : 'ul', text: li[3] });
                continue;
            }
            flushList(); flushQuote();
            para.push(line);
        }
        if (fence) out.push(`<pre><code>${escHtml(fence.join('\n'))}</code></pre>`);
        flushAll();
        return out.join('');
    }

    /* ---- Sanitize (paste, and .html round trips) ---- */
    // Elements whose content IS the payload — removed outright. Everything else
    // outside the allowlist is unwrapped, which keeps a pasted document's text and
    // marks while dropping its markup.
    const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH']);

    function sanitize(html, allowBlocks) {
        const t = document.createElement('template');
        t.innerHTML = String(html == null ? '' : html);
        const ok = new Set(allowBlocks ? [...INLINE_OK, ...BLOCK] : INLINE_OK);
        // Depth-first: children are cleaned before their parent unwraps, so nothing
        // hoisted out of a stripped wrapper escapes the walk.
        const walk = (node) => [...node.childNodes].forEach(c => {
            if (c.nodeType === 8) return c.remove();
            if (c.nodeType !== 1) return;
            if (DROP.has(c.tagName)) return c.remove();
            walk(c);
            if (!ok.has(c.tagName)) return c.replaceWith(...c.childNodes);
            [...c.attributes].forEach(a => {
                const n = a.name.toLowerCase();
                if (c.tagName === 'A' && n === 'href' && !/^\s*javascript:/i.test(a.value)) return;
                c.removeAttribute(a.name);
            });
        });
        walk(t.content);
        return t.innerHTML;
    }

    /* ---- Selection helpers ---- */
    function blockTag() {
        const s = getSelection(); if (!s || !s.rangeCount) return null;
        let n = s.getRangeAt(0).startContainer;
        while (n && n.nodeType !== 1) n = n.parentNode;
        while (n && !BLOCK.includes(n.tagName)) n = n.parentElement;
        return n && n.tagName;
    }

    function inTag(sel) {
        const s = getSelection(); if (!s || !s.rangeCount) return false;
        let n = s.getRangeAt(0).startContainer; while (n && n.nodeType !== 1) n = n.parentNode;
        return !!(n && n.closest(sel));
    }

    const state = (cmd) => { try { return document.queryCommandState(cmd); } catch { return false; } };
    // queryCommandState reads computed weight, so a heading reports bold. Inside one,
    // only an explicit mark counts — otherwise the control lights up with nothing to undo.
    const markActive = (cmd, sel) => /^H[1-6]$/.test(blockTag() || '') ? inTag(sel) : state(cmd);

    const setBlock = (tag) => document.execCommand('formatBlock', false, tag);
    const toggleBlockTag = (tag) => setBlock(blockTag() === tag ? 'P' : tag);

    // <code> has no execCommand; wrap or unwrap the selection by hand.
    function toggleCode() {
        const s = getSelection(); if (!s || !s.rangeCount) return;
        const r = s.getRangeAt(0);
        let n = r.startContainer; while (n && n.nodeType !== 1) n = n.parentNode;
        const existing = n && n.closest('code');
        if (existing) return existing.replaceWith(...existing.childNodes);
        if (r.collapsed) return;
        const c = document.createElement('code');
        c.textContent = r.toString();
        r.deleteContents(); r.insertNode(c);
        s.removeAllRanges(); const after = document.createRange(); after.setStartAfter(c); after.collapse(true); s.addRange(after);
    }

    function unlink() {
        const s = getSelection(); if (!s || !s.rangeCount) return;
        let n = s.getRangeAt(0).startContainer; while (n && n.nodeType !== 1) n = n.parentNode;
        const a = n && n.closest('a');
        if (a) a.replaceWith(...a.childNodes); else document.execCommand('unlink');
    }

    function setLink(url) {
        if (inTag('a') && !url) return unlink();          // bare .link on an existing link toggles it off
        const href = url != null && String(url).trim() ? String(url).trim() : prompt('Link URL', 'https://');
        if (!href || /^\s*javascript:/i.test(href)) return;
        document.execCommand('createLink', false, href);
    }

    /* ---- Commands ----
       Each entry is one control's behaviour. `block` is the odd one out: it reads
       from a <select> the author populated, rather than toggling. */
    const BLOCK_VALUES = { p: 'P', paragraph: 'P', h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', h5: 'H5', h6: 'H6', quote: 'BLOCKQUOTE', blockquote: 'BLOCKQUOTE', pre: 'PRE', code: 'PRE' };
    const BLOCK_NAMES = { P: 'p', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6', BLOCKQUOTE: 'quote', PRE: 'pre' };

    const COMMANDS = {
        bold: { run: () => document.execCommand('bold'), active: () => markActive('bold', 'strong, b') },
        italic: { run: () => document.execCommand('italic'), active: () => markActive('italic', 'em, i') },
        strike: { run: () => document.execCommand('strikeThrough'), active: () => state('strikeThrough') },
        code: { run: toggleCode, active: () => inTag('code') },
        heading: { run: (a) => toggleBlockTag('H' + (a || 2)), active: (a) => blockTag() === 'H' + (a || 2), block: true },
        paragraph: { run: () => setBlock('P'), active: () => blockTag() === 'P', block: true },
        quote: { run: () => toggleBlockTag('BLOCKQUOTE'), active: () => blockTag() === 'BLOCKQUOTE', block: true },
        bullets: { run: () => document.execCommand('insertUnorderedList'), active: () => state('insertUnorderedList'), block: true },
        numbers: { run: () => document.execCommand('insertOrderedList'), active: () => state('insertOrderedList'), block: true },
        divider: { run: () => document.execCommand('insertHTML', false, '<hr><p><br></p>'), active: () => false, block: true },
        link: { run: (a) => setLink(a), active: () => inTag('a') },
        unlink: { run: unlink, active: () => false },
        clear: { run: () => { document.execCommand('removeFormat'); unlink(); }, active: () => false },
        undo: { run: () => document.execCommand('undo'), active: () => false },
        redo: { run: () => document.execCommand('redo'), active: () => false },
        block: { run: (a) => setBlock(BLOCK_VALUES[String(a).toLowerCase()] || 'P'), active: () => false, block: true, reflect: () => BLOCK_NAMES[blockTag()] || 'p' }
    };
    const MODES = new Set(['html', 'plain', 'minimal', 'sticky', 'autofocus', 'toolbar']);

    /* ---- Registry + resolution ----
       Controls find their area by containment first, focus second. The nearest
       ancestor holding exactly one area wins, which is what keeps two dialogs
       sharing a DOM from driving each other; a toolbar with no such ancestor falls
       through to whichever area was last focused. x-text-edit-for pins either. */
    const areas = new Set();
    const controls = new Set();
    let lastFocused = null;

    const onScreen = (el) => el.checkVisibility ? el.checkVisibility() : !!el.offsetParent;
    const inside = (root) => [...areas].filter(a => root.contains(a) && a !== root);
    const preferred = (list) => list.find(a => a === lastFocused && onScreen(a)) || list.find(onScreen) || list[0] || null;

    function resolve(control) {
        const pin = control.closest('[x-text-edit-for]');
        if (pin) {
            const target = document.querySelector(pin.getAttribute('x-text-edit-for'));
            if (target) return areas.has(target) ? target : preferred(inside(target));
        }
        for (let n = control.parentElement; n; n = n.parentElement) {
            const found = inside(n);
            if (found.length === 1) return found[0];
            if (found.length > 1) return preferred(found);
        }
        return preferred([...areas]);
    }

    /* ---- Caret custody ----
       A control anywhere in the document means the area is often not focused when a
       command runs — a <select> or a URL field steals focus by design. Each area
       keeps its own last range so any control can put the caret back. */
    function saveRange(area) {
        const s = getSelection();
        if (s && s.rangeCount && area.contains(s.anchorNode)) area._range = s.getRangeAt(0).cloneRange();
    }

    function restoreRange(area) {
        const s = getSelection();
        if (s && s.rangeCount && area.contains(s.anchorNode)) return;
        area.focus();
        if (!area._range) return;
        s.removeAllRanges(); s.addRange(area._range);
    }

    const allows = (area, id) => {
        const spec = COMMANDS[id], cfg = area && area._te;
        if (!spec || !cfg || cfg.mode === 'plain') return false;
        return !(cfg.minimal && spec.block);
    };

    function run(area, id, arg) {
        if (!allows(area, id)) return;
        restoreRange(area);
        COMMANDS[id].run(arg);
        saveRange(area);
        area.dispatchEvent(new Event('input', { bubbles: true }));
        sync();
    }

    // Reflect caret state onto every control pointing at the area that owns it.
    function sync() {
        controls.forEach(c => {
            const cfg = c._te, area = resolve(c);
            const usable = !!area && allows(area, cfg.id);
            c.toggleAttribute('data-text-edit-active', usable && !!COMMANDS[cfg.id].active(cfg.arg()));
            c.setAttribute('aria-disabled', String(!usable));
            if (usable && COMMANDS[cfg.id].reflect && 'value' in c) {
                const v = COMMANDS[cfg.id].reflect();
                if (c.value !== v) c.value = v;
            } else if (c.tagName === 'BUTTON') {
                c.setAttribute('aria-pressed', String(c.hasAttribute('data-text-edit-active')));
            }
        });
    }

    /* ---- Default toolbar (.toolbar) ----
       Written with the same public directive as any hand-rolled toolbar, so there is
       no privileged path — the built-in set is just markup you didn't have to type. */
    const ICONS = {
        bold: '<path d="M6 12h8a4 4 0 0 0 0-8H6z"/><path d="M6 12h9a4 4 0 0 1 0 8H6z"/>',
        italic: '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
        strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>',
        code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
        heading: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>',
        quote: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
        bullets: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
        numbers: '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        divider: '<line x1="3" y1="12" x2="21" y2="12"/>'
    };
    const DEFAULT_TOOLS = [
        ['bold', 'Bold'], ['italic', 'Italic'], ['strike', 'Strikethrough'], ['code', 'Code'],
        ['heading.2', 'Heading', 'heading'], ['quote', 'Quote'],
        ['bullets', 'Bulleted list'], ['numbers', 'Numbered list'],
        ['link', 'Link'], ['divider', 'Divider']
    ];

    // Wraps rather than inserting a sibling: the area is often a flex or grid child,
    // and a bare sibling would land beside it instead of above. The wrapper is the
    // one bit of DOM this plugin adds, and only when .toolbar asked for it.
    function defaultToolbar(area) {
        const field = document.createElement('div');
        field.setAttribute('data-text-edit-field', '');
        area.parentNode.insertBefore(field, area);
        field.appendChild(area);

        const bar = document.createElement('div');
        bar.setAttribute('data-text-edit-toolbar', '');
        bar.setAttribute('role', 'toolbar');
        bar.innerHTML = DEFAULT_TOOLS.map(([mod, label, icon]) =>
            `<button type="button" class="ghost sm" x-text-edit.${mod} aria-label="${label}" title="${label}">` +
            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon || mod]}</svg></button>`
        ).join('');
        field.insertBefore(bar, area);
        window.Alpine.initTree(bar);   // the buttons are ordinary x-text-edit controls
        return field;
    }

    /* ---- Directive ---- */
    function init() {
        if (!window.Alpine || !Alpine.directive) return;

        Alpine.directive('text-edit', (el, { expression, modifiers }, { effect, evaluateLater, evaluate, cleanup }) => {
            const id = modifiers.find(m => COMMANDS[m]);
            return id ? control(el, id, modifiers, expression, evaluate, cleanup)
                : area(el, modifiers, expression, { effect, evaluateLater, cleanup });
        });

        // $text — the area this element sits in, or the last focused one.
        Alpine.magic('text', (el) => {
            const own = el.closest('[data-text-edit]');
            const a = own && areas.has(own) ? own : preferred([...areas]);
            return a ? a._te.api : { value: '', run() { }, active: () => false, can: () => false, focus() { }, markdown: () => '', html: () => '' };
        });

        document.addEventListener('selectionchange', () => {
            const s = getSelection(); if (!s || !s.anchorNode) return;
            const a = [...areas].find(x => x.contains(s.anchorNode));
            if (a) { saveRange(a); lastFocused = a; }
            sync();
        });
    }

    function control(el, id, modifiers, expression, evaluate, cleanup) {
        // `.heading.2` carries its argument as the next modifier; an expression is
        // the dynamic form (`x-text-edit.link="url"`).
        const literal = modifiers[modifiers.indexOf(id) + 1];
        const arg = () => literal !== undefined ? literal : (expression ? evaluate(expression) : undefined);
        el._te = { id, arg };
        el.setAttribute('data-text-edit-control', id);
        if (el.tagName === 'BUTTON' && !el.hasAttribute('type')) el.type = 'button';
        controls.add(el);

        const fire = () => { const a = resolve(el); if (a) run(a, id, arg()); };
        if ('value' in el && el.tagName !== 'BUTTON') {
            el.addEventListener('change', () => { const a = resolve(el); if (a) run(a, id, el.value); });
        } else {
            el.addEventListener('pointerdown', e => e.preventDefault());   // never take the caret
            el.addEventListener('click', e => { e.preventDefault(); fire(); });
        }
        setTimeout(sync, 0);
        cleanup(() => { controls.delete(el); });
    }

    function area(el, modifiers, expression, { effect, evaluateLater, cleanup }) {
        const mode = modifiers.includes('html') ? 'html' : modifiers.includes('plain') ? 'plain' : 'markdown';
        const minimal = modifiers.includes('minimal');
        modifiers.filter(m => !MODES.has(m)).forEach(m => console.warn(`[Manifest Text Edit] unknown modifier: .${m}`));

        el.setAttribute('data-text-edit', mode);
        el.setAttribute('contenteditable', 'true');
        el.setAttribute('role', 'textbox');
        el.setAttribute('aria-multiline', 'true');
        if (minimal) el.setAttribute('data-text-edit-minimal', '');
        if (modifiers.includes('sticky')) el.setAttribute('data-text-edit-sticky', '');

        const read = () => mode === 'plain' ? el.innerText.replace(/\n{3,}/g, '\n\n').trim()
            : mode === 'html' ? sanitize(el.innerHTML, true)
                : toMarkdown(el);
        const write = (v) => {
            if (mode === 'plain') el.textContent = v == null ? '' : String(v);
            else el.innerHTML = mode === 'html' ? sanitize(v, true) : fromMarkdown(v);
            if (!el.childNodes.length) el.innerHTML = '<p><br></p>';
        };

        let last = null, writing = false;
        if (expression) {
            const getValue = evaluateLater(expression);
            const setValue = evaluateLater(`${expression} = __textEditValue`);
            effect(() => getValue(v => {
                const s = v == null ? '' : String(v);
                if (s === last) return;                       // our own write coming back
                last = s; writing = true; write(s); writing = false;
            }));
            el.addEventListener('input', () => {
                if (writing) return;
                last = read();
                setValue(() => { }, { scope: { __textEditValue: last } });
            });
        } else {
            write('');
        }

        el.addEventListener('focusin', () => { lastFocused = el; sync(); });
        el.addEventListener('input', sync);

        el.addEventListener('keydown', (e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            const id = { b: 'bold', i: 'italic', k: 'link' }[e.key.toLowerCase()];
            if (!id || !allows(el, id)) return;
            e.preventDefault(); run(el, id);
        });

        // Paste as our own subset — never the source app's markup.
        el.addEventListener('paste', (e) => {
            e.preventDefault();
            const dt = e.clipboardData; if (!dt) return;
            const html = dt.getData('text/html');
            document.execCommand('insertHTML', false,
                mode === 'plain' ? escHtml(dt.getData('text/plain'))
                    : html ? sanitize(html, !minimal)
                        : fromMarkdown(dt.getData('text/plain')));
        });

        const api = {
            get value() { return read(); },
            set value(v) { write(v); el.dispatchEvent(new Event('input', { bubbles: true })); },
            focus: () => el.focus(),
            run: (id, arg) => run(el, id, arg),
            active: (id) => allows(el, id) && COMMANDS[id].active(),
            can: (id) => allows(el, id),
            markdown: () => toMarkdown(el),
            html: () => sanitize(el.innerHTML, true)
        };
        el._te = { mode, minimal, api };
        areas.add(el);

        let field = null;
        if (modifiers.includes('toolbar')) field = defaultToolbar(el);
        if (modifiers.includes('autofocus')) setTimeout(() => el.focus(), 0);
        setTimeout(sync, 0);

        cleanup(() => {
            areas.delete(el); if (lastFocused === el) lastFocused = null;
            if (field) { field.parentNode.insertBefore(el, field); field.remove(); }   // hand the element back unwrapped
        });
    }

    document.addEventListener('alpine:init', init);
    if (window.Alpine && Alpine.directive) init();

    window.ManifestTextEdit = { toMarkdown, fromMarkdown, sanitize };
})();
