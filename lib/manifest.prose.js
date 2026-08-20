/* Manifest Prose — rich text editing.

   x-prose="state.field" turns an element into a formatting-aware editor and keeps
   the bound value in sync. Markdown by default (portable, and x-markdown renders it
   straight back); .html stores sanitized HTML; .plain stores text.

   Serialization is a closed round trip over exactly what the toolbar can produce —
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

    /* ---- Toolbar ---- */
    // Lucide geometry, inlined so the plugin has no icon dependency.
    const ICONS = {
        bold: '<path d="M6 12h8a4 4 0 0 0 0-8H6z"/><path d="M6 12h9a4 4 0 0 1 0 8H6z"/>',
        italic: '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
        strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>',
        code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
        h1: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>',
        h2: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>',
        quote: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
        ul: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
        ol: '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        rule: '<line x1="3" y1="12" x2="21" y2="12"/>'
    };

    const TOOLS = [
        { id: 'bold', label: 'Bold', key: 'b', block: false },
        { id: 'italic', label: 'Italic', key: 'i', block: false },
        { id: 'strike', label: 'Strikethrough', block: false },
        { id: 'code', label: 'Code', block: false },
        { id: 'h1', label: 'Heading 1', block: true },
        { id: 'h2', label: 'Heading 2', block: true },
        { id: 'quote', label: 'Quote', block: true },
        { id: 'ul', label: 'Bulleted list', block: true },
        { id: 'ol', label: 'Numbered list', block: true },
        { id: 'link', label: 'Link', key: 'k', block: false },
        { id: 'rule', label: 'Divider', block: true }
    ];

    const svg = (id) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;

    function buildToolbar(host, tools) {
        const bar = document.createElement('div');
        bar.setAttribute('data-prose-toolbar', '');
        bar.setAttribute('role', 'toolbar');
        bar.innerHTML = tools.map(t => `<button type="button" class="ghost sm" data-prose-tool="${t.id}" aria-label="${t.label}" title="${t.label}">${svg(t.id)}</button>`).join('');
        bar.addEventListener('pointerdown', e => e.preventDefault());   // keep the caret
        bar.addEventListener('click', e => {
            const b = e.target.closest('[data-prose-tool]'); if (!b) return;
            host.focus();
            run(host, b.getAttribute('data-prose-tool'));
        });
        return bar;
    }

    /* ---- Commands ---- */
    const CMD = {
        bold: () => document.execCommand('bold'),
        italic: () => document.execCommand('italic'),
        strike: () => document.execCommand('strikeThrough'),
        h1: () => toggleBlock('H1'),
        h2: () => toggleBlock('H2'),
        quote: () => toggleBlock('BLOCKQUOTE'),
        ul: () => document.execCommand('insertUnorderedList'),
        ol: () => document.execCommand('insertOrderedList'),
        rule: () => document.execCommand('insertHTML', false, '<hr><p><br></p>')
    };

    function toggleBlock(tag) {
        const cur = blockTag();
        document.execCommand('formatBlock', false, cur === tag ? 'P' : tag);
    }

    function blockTag() {
        const s = getSelection(); if (!s || !s.rangeCount) return null;
        let n = s.getRangeAt(0).startContainer;
        while (n && n.nodeType !== 1) n = n.parentNode;
        while (n && !BLOCK.includes(n.tagName)) n = n.parentElement;
        return n && n.tagName;
    }

    // <code> has no execCommand; wrap or unwrap the selection by hand.
    function toggleCode() {
        const s = getSelection(); if (!s || !s.rangeCount) return;
        const r = s.getRangeAt(0);
        let n = r.startContainer; while (n && n.nodeType !== 1) n = n.parentNode;
        const existing = n && n.closest('code');
        if (existing) { existing.replaceWith(...existing.childNodes); return; }
        if (r.collapsed) return;
        const c = document.createElement('code');
        c.textContent = r.toString();
        r.deleteContents(); r.insertNode(c);
        s.removeAllRanges(); const after = document.createRange(); after.setStartAfter(c); after.collapse(true); s.addRange(after);
    }

    function toggleLink(host) {
        const s = getSelection(); if (!s || !s.rangeCount) return;
        let n = s.getRangeAt(0).startContainer; while (n && n.nodeType !== 1) n = n.parentNode;
        const a = n && n.closest('a');
        if (a) { a.replaceWith(...a.childNodes); return; }
        if (s.getRangeAt(0).collapsed) return;
        const url = prompt('Link URL', 'https://');
        if (!url || /^\s*javascript:/i.test(url)) return;
        document.execCommand('createLink', false, url);
    }

    function run(host, id) {
        if (id === 'code') toggleCode();
        else if (id === 'link') toggleLink(host);
        else if (CMD[id]) CMD[id]();
        host.dispatchEvent(new Event('input', { bubbles: true }));
        syncActive(host);
    }

    function inTag(sel) {
        const s = getSelection(); if (!s || !s.rangeCount) return false;
        let n = s.getRangeAt(0).startContainer; while (n && n.nodeType !== 1) n = n.parentNode;
        return !!(n && n.closest(sel));
    }

    function isActive(id) {
        if (id === 'h1') return blockTag() === 'H1';
        if (id === 'h2') return blockTag() === 'H2';
        if (id === 'quote') return blockTag() === 'BLOCKQUOTE';
        if (id === 'code') return inTag('code');
        if (id === 'link') return inTag('a');
        // queryCommandState reads computed weight, so a heading reports bold. Only an
        // explicit mark counts there — otherwise the button lights up with nothing to undo.
        if (id === 'bold' && /^H[1-6]$/.test(blockTag() || '')) return inTag('strong, b');
        try {
            if (id === 'bold' || id === 'italic') return document.queryCommandState(id);
            if (id === 'strike') return document.queryCommandState('strikeThrough');
            if (id === 'ul') return document.queryCommandState('insertUnorderedList');
            if (id === 'ol') return document.queryCommandState('insertOrderedList');
        } catch { }
        return false;
    }

    function syncActive(host) {
        const bar = host._proseBar; if (!bar) return;
        bar.querySelectorAll('[data-prose-tool]').forEach(b => {
            b.toggleAttribute('data-prose-active', isActive(b.getAttribute('data-prose-tool')));
        });
    }

    /* ---- Directive ---- */
    function init() {
        if (!window.Alpine || !Alpine.directive) return;

        Alpine.directive('prose', (el, { expression, modifiers }, { effect, evaluateLater, cleanup }) => {
            const mode = modifiers.includes('html') ? 'html' : modifiers.includes('plain') ? 'plain' : 'markdown';
            const minimal = modifiers.includes('minimal');
            const bare = modifiers.includes('bare') || mode === 'plain';
            const tools = TOOLS.filter(t => !minimal || !t.block);

            const host = document.createElement('div');
            host.setAttribute('data-prose-input', '');
            host.setAttribute('contenteditable', 'true');
            host.setAttribute('role', 'textbox');
            host.setAttribute('aria-multiline', 'true');
            const ph = el.getAttribute('placeholder'); if (ph) { host.setAttribute('data-prose-placeholder', ph); el.removeAttribute('placeholder'); }
            if (el.hasAttribute('aria-label')) host.setAttribute('aria-label', el.getAttribute('aria-label'));

            el.setAttribute('data-prose', mode);
            if (modifiers.includes('sticky')) el.setAttribute('data-prose-sticky', '');
            el.replaceChildren();
            if (!bare) { const bar = buildToolbar(host, tools); host._proseBar = bar; el.appendChild(bar); }
            el.appendChild(host);

            const read = () => mode === 'plain' ? host.innerText.replace(/\n{3,}/g, '\n\n').trim()
                : mode === 'html' ? sanitize(host.innerHTML, true)
                    : toMarkdown(host);
            const write = (v) => {
                if (mode === 'plain') host.textContent = v == null ? '' : String(v);
                else host.innerHTML = mode === 'html' ? sanitize(v, true) : fromMarkdown(v);
                if (!host.childNodes.length) host.innerHTML = '<p><br></p>';
            };

            let last = null, writing = false;
            if (expression) {
                const getValue = evaluateLater(expression);
                const setValue = evaluateLater(`${expression} = __proseValue`);
                effect(() => getValue(v => {
                    const s = v == null ? '' : String(v);
                    if (s === last) return;                       // our own write coming back
                    last = s; writing = true; write(s); writing = false;
                }));
                host.addEventListener('input', () => {
                    if (writing) return;
                    last = read();
                    setValue(() => { }, { scope: { __proseValue: last } });
                });
            } else {
                write('');
            }

            host.addEventListener('keydown', (e) => {
                if (!(e.metaKey || e.ctrlKey)) return;
                const t = tools.find(x => x.key && x.key === e.key.toLowerCase());
                if (!t) return;
                e.preventDefault(); run(host, t.id);
            });

            // Paste as our own subset — never the source app's markup.
            host.addEventListener('paste', (e) => {
                e.preventDefault();
                const dt = e.clipboardData; if (!dt) return;
                const html = dt.getData('text/html');
                const frag = mode === 'plain' ? escHtml(dt.getData('text/plain'))
                    : html ? sanitize(html, !minimal)
                        : fromMarkdown(dt.getData('text/plain'));
                document.execCommand('insertHTML', false, frag);
            });

            const onSel = () => { if (host.contains(document.getSelection()?.anchorNode)) syncActive(host); };
            document.addEventListener('selectionchange', onSel);
            host.addEventListener('input', () => syncActive(host));
            cleanup(() => document.removeEventListener('selectionchange', onSel));

            el._prose = {
                get value() { return read(); },
                set value(v) { write(v); host.dispatchEvent(new Event('input', { bubbles: true })); },
                focus: () => host.focus(),
                run: (id) => { host.focus(); run(host, id); },
                active: (id) => isActive(id),
                markdown: () => toMarkdown(host),
                html: () => sanitize(host.innerHTML, true)
            };
            if (modifiers.includes('autofocus')) setTimeout(() => host.focus(), 0);
        });

        // $prose — the editor this element sits in (or the focused one), for custom toolbars.
        Alpine.magic('prose', (el) => {
            const own = el.closest('[data-prose]');
            const active = document.activeElement && document.activeElement.closest('[data-prose]');
            return (own || active)?._prose || { value: '', run() { }, active: () => false, focus() { }, markdown: () => '', html: () => '' };
        });
    }

    document.addEventListener('alpine:init', init);
    if (window.Alpine && Alpine.directive) init();

    window.ManifestProse = { toMarkdown, fromMarkdown, sanitize };
})();
