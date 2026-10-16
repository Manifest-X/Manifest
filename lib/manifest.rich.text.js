/* Manifest Rich Text */

(function () {

    /* ---- Tag tables ----
       Commands are tag names; `md` marks tags markdown can carry (others are .html only). */
    const INLINE_TAGS = {
        strong: { md: 1 }, b: { md: 1 }, em: { md: 1 }, i: { md: 1 }, s: { md: 1 }, del: { md: 1 }, code: { md: 1 },
        abbr: { attr: 'title' }, bdi: {}, bdo: { attr: 'dir', def: 'rtl' }, cite: {}, data: { attr: 'value' },
        dfn: { attr: 'title' }, ins: {}, kbd: {}, mark: {}, q: {}, samp: {}, small: {}, span: {}, sub: {}, sup: {},
        time: { attr: 'datetime' }, u: {}, var: {}
    };
    const BLOCK_TAGS = {
        p: { md: 1 }, h1: { md: 1 }, h2: { md: 1 }, h3: { md: 1 }, h4: { md: 1 }, h5: { md: 1 }, h6: { md: 1 },
        blockquote: { md: 1 }, pre: { md: 1 }, address: {}
    };
    const BLOCK = [...Object.keys(BLOCK_TAGS), 'figure', 'figcaption', 'dl', 'dt', 'dd', 'ul', 'ol', 'li', 'hr', 'table', 'td', 'th'].map(t => t.toUpperCase());
    const BLOCK_SEL = BLOCK.join(',');
    const MARKS = { STRONG: '**', B: '**', EM: '*', I: '*', S: '~~', DEL: '~~', CODE: '`' };
    const INLINE_OK = new Set([...Object.keys(INLINE_TAGS).map(t => t.toUpperCase()), 'BR', 'WBR', 'A', 'IMG']);

    /* ---- Adjacent marks ----
       Neighbouring inline elements alike (same tag and attributes; for markdown, the same
       delimiter) are one: merged, children first, the selection kept on the nodes it was in. */
    const sameInline = (a, b) => !!b && b.nodeType === 1 && a.tagName === b.tagName
        && a.attributes.length === b.attributes.length && [...a.attributes].every(x => b.getAttribute(x.name) === x.value);
    const sameDelimiter = (a, b) => !!b && b.nodeType === 1 && (a.tagName === 'A' ? sameInline(a, b) : !!MARKS[a.tagName] && MARKS[a.tagName] === MARKS[b.tagName]);
    function mergeAdjacent(root, same = sameInline) {
        const r = root.ownerDocument === document && root.isConnected ? range() : null;
        const keep = r && root.contains(r.startContainer) ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : null;
        let any = false;
        const walk = (p) => {
            let merged = false;
            [...p.children].forEach(walk);
            for (let c = p.firstChild; c; c = c.nextSibling) {
                while (c.nodeType === 1 && INLINE_OK.has(c.tagName) && !/^(BR|WBR|IMG)$/.test(c.tagName)) {
                    const gaps = [];
                    let n = c.nextSibling;
                    while (n && n.nodeType === 3 && !n.length) { gaps.push(n); n = n.nextSibling; }   // empty text between them is nothing
                    if (!same(c, n)) break;
                    const base = c.childNodes.length;
                    if (keep) for (const i of [0, 2]) { if (gaps.includes(keep[i])) { keep[i] = c; keep[i + 1] = base; } else if (keep[i] === n) { keep[i] = c; keep[i + 1] += base; } }
                    gaps.forEach(g => g.remove()); c.append(...n.childNodes); n.remove(); merged = any = true;
                }
            }
            if (merged) walk(p);
        };
        walk(root);
        if (any && keep && keep[0].isConnected && keep[2].isConnected) try { const nr = document.createRange(); nr.setStart(keep[0], keep[1]); nr.setEnd(keep[2], keep[3]); const s = sel(); s.removeAllRanges(); s.addRange(nr); } catch { }
        return any;
    }

    /* ---- URL policy ---- */
    // No script schemes; data: only as an image.
    function unsafeUrl(url, image) {
        const u = String(url == null ? '' : url).replace(/[\x00-\x20\x7f]/g, '');
        const scheme = (u.match(/^([a-z][a-z0-9+.-]*):/i) || [])[1];
        if (!scheme) return false;
        const s = scheme.toLowerCase();
        if (s === 'javascript' || s === 'vbscript') return true;
        return s === 'data' && !(image && /^data:image\/(png|jpeg|gif|webp|avif)[;,]/i.test(u));   // raster only: an SVG can carry script
    }

    /* ---- HTML → Markdown ---- */
    const ENTITY = /&(?=#?[a-z0-9]+;)/gi;
    const esc = (t) => t.replace(/([\\`*_~[\]<>])/g, '\\$1').replace(ENTITY, '\\&');
    // Line starts that would parse as a heading, list or rule
    const escLead = (text) => text.split('\n').map(l => l
        .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
        .replace(/^(\s*)([-+])(?=\s)/, '$1\\$2')
        .replace(/^(\s*)-(?=-{2,}\s*$)/, '$1\\-')
        .replace(/^(\s*)(\d+)\.(?=\s)/, '$1$2\\.')).join('\n');
    const mdUrl = (u) => u.replace(/[\s()<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).replace(ENTITY, '\\&');

    function inline(node) {
        let out = '';
        node.childNodes.forEach(n => {
            if (n.nodeType === 3) { out += esc(n.textContent); return; }
            if (n.nodeType !== 1) return;
            const tag = n.tagName;
            if (tag === 'BR') { out += '  \n'; return; }
            if (tag === 'IMG') { const src = n.getAttribute('src') || ''; out += src && !unsafeUrl(src, true) ? `![${esc(n.getAttribute('alt') || '')}](${mdUrl(src)})` : ''; return; }
            if (tag === 'A') { const h = n.getAttribute('href') || ''; out += h && !unsafeUrl(h) ? `[${inline(n)}](${mdUrl(h)})` : inline(n); return; }
            let m = MARKS[tag];
            if (!m) { out += inline(n); return; }
            const body = tag === 'CODE' ? n.textContent : inline(n);
            if (!body.trim()) { out += body; return; }
            // Delimiters hug the text (spaces go outside), and never run into a neighbour's
            const [, lead, core, trail] = tag === 'CODE' ? ['', '', body, ''] : body.match(/^(\s*)([\s\S]*?)(\s*)$/);
            if (m[0] === '*' && !lead && out.endsWith('*')) m = m.replace(/\*/g, '_');
            out += lead + m + core + m + trail;
        });
        return out;
    }

    const preText = (n) => [...n.childNodes].map(c =>
        c.nodeName === 'BR' ? '\n' : c.nodeType === 3 ? c.nodeValue : preText(c)).join('');

    function block(node, depth) {
        if (node.nodeType === 3) { const t = node.textContent.trim(); return t ? escLead(esc(t)) : ''; }
        if (node.nodeType !== 1) return '';
        const tag = node.tagName;
        if (tag === 'HR') return '---';
        if (tag === 'PRE') return '```\n' + preText(node).replace(/\n+$/, '') + '\n```';
        if (/^H[1-6]$/.test(tag)) return '#'.repeat(+tag[1]) + ' ' + inline(node).trim();
        if (tag === 'BLOCKQUOTE') return blocks(node, depth).split('\n').map(l => ('> ' + l).trimEnd()).join('\n');
        if (tag === 'TABLE') return tableLines(node).map(cells => escLead(cells.map(cellMarkdown).join(CELL_SEP))).join('\n\n');
        if (tag === 'UL' || tag === 'OL') {
            const pad = '    '.repeat(depth);
            return [...node.children].filter(li => li.tagName === 'LI').map((li, i) => {
                const box = li.querySelector(':scope > input[type=checkbox]');
                const bullet = tag === 'OL' ? `${i + 1}. ` : box ? (box.checked ? '- [x] ' : '- [ ] ') : '- ';
                const nested = [...li.children].filter(c => c.tagName === 'UL' || c.tagName === 'OL');
                const own = inline(nestedStripped(li, nested)).trim();
                const sub = nested.map(n => block(n, depth + 1)).join('\n');
                return pad + bullet + own + (sub ? '\n' + sub : '');
            }).join('\n');
        }
        // A container of blocks (dl, figure, a cell's paragraphs) keeps them apart
        if ([...node.children].some(c => BLOCK.includes(c.tagName))) return blocks(node, depth);
        return escLead(inline(node).trim());
    }

    function nestedStripped(li, nested) {
        if (!nested.length) return li;
        const c = li.cloneNode(true);
        [...c.children].forEach(ch => { if (ch.tagName === 'UL' || ch.tagName === 'OL') ch.remove(); });
        return c;
    }

    // Consecutive inline nodes (loose text, marks) are one paragraph, formatting kept
    function blocks(root, depth) {
        const parts = [];
        let run = null;
        const flush = () => { if (run) { const t = escLead(inline(run).trim()); if (t) parts.push(t); run = null; } };
        root.childNodes.forEach(n => {
            if (n.nodeType === 1 && (BLOCK.includes(n.tagName) || [...n.children].some(c => BLOCK.includes(c.tagName)))) {
                flush();
                const b = block(n, depth || 0); if (b) parts.push(b);
                return;
            }
            if (n.nodeType === 1 || n.nodeType === 3) (run = run || document.createElement('div')).appendChild(n.cloneNode(true));
        });
        flush();
        return parts.join('\n\n');
    }

    const mdCopy = (root) => { const c = root.cloneNode(true); mergeAdjacent(c, sameDelimiter); return c; };
    const toMarkdown = (root) => blocks(mdCopy(root), 0).replace(/\n{3,}/g, '\n\n').trim();
    // Single-line values never parse block syntax, so line starts need no escape
    const inlineMarkdown = (root) => {
        const flat = document.createElement('div');
        flat.innerHTML = flattenLines(root.innerHTML, true);
        mergeAdjacent(flat, sameDelimiter);
        return inline(flat).trim();
    };

    // A cell's blocks joined with a space
    const cellMarkdown = (cell) => {
        if (![...cell.children].some(c => BLOCK.includes(c.tagName))) return inline(cell).trim();
        const c = cell.cloneNode(true);
        [...c.children].forEach(b => { if (BLOCK.includes(b.tagName)) { b.before(' '); b.after(' '); } });
        return inline(c).replace(/\s+/g, ' ').trim();
    };

    /* ---- Tables in markdown ---- */
    // One line per row, cells joined by " · ".
    const CELL_SEP = ' · ';
    const tableLines = (table) => [...table.rows].map(r => [...r.cells])
        .filter(cells => cells.some(c => c.textContent.trim() || c.querySelector('img')));

    function flattenTables(html, blocks) {
        const t = document.createElement('template');
        t.innerHTML = String(html == null ? '' : html);
        [...t.content.querySelectorAll('table')].reverse().forEach(table => {
            const frag = document.createDocumentFragment();
            tableLines(table).forEach((cells, i) => {
                const line = blocks ? document.createElement('p') : frag;
                if (!blocks && i) frag.appendChild(document.createElement('br'));
                cells.forEach((cell, j) => {
                    cell.querySelectorAll(BLOCK_SEL).forEach(b => b.replaceWith(...b.childNodes, ' '));
                    cell.normalize();
                    const a = cell.firstChild, z = cell.lastChild;
                    if (a && a.nodeType === 3) a.nodeValue = a.nodeValue.replace(/^\s+/, '');
                    if (z && z.nodeType === 3) z.nodeValue = z.nodeValue.replace(/\s+$/, '');
                    if (j) line.appendChild(document.createTextNode(CELL_SEP));
                    while (cell.firstChild) line.appendChild(cell.firstChild);
                });
                if (blocks) frag.appendChild(line);
            });
            table.replaceWith(frag);
        });
        return t.innerHTML;
    }

    // Html-only blocks become paragraphs for a markdown document
    // Markdown keeps only its own marks: other inline tags (u, mark, sub, span...) are unwrapped
    function markdownMarks(html) {
        const t = document.createElement('template');
        t.innerHTML = html;
        [...t.content.querySelectorAll('*')].reverse().forEach(el => {
            if (INLINE_OK.has(el.tagName) && !MARKS[el.tagName] && !/^(A|IMG|BR)$/.test(el.tagName)) el.replaceWith(...el.childNodes);
        });
        return t.innerHTML;
    }

    function markdownBlocks(html) {
        const t = document.createElement('template');
        t.innerHTML = html;
        [...t.content.querySelectorAll('dt, dd, figcaption, address')].reverse().forEach(b => {
            if ([...b.children].some(c => BLOCK.includes(c.tagName))) b.replaceWith(...b.childNodes);
            else retagBlock(b, 'p');
        });
        [...t.content.querySelectorAll('dl, figure')].reverse().forEach(b => b.replaceWith(...b.childNodes));
        return t.innerHTML;
    }

    /* ---- Markdown → HTML ---- */
    const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Escapes and code spans (verbatim) are held out of the mark passes, left to right, and restored last
    const HOLD = '';
    function inlineHtml(s) {
        const held = [];
        return escHtml(s)
            .replace(/\\(&lt;|&gt;|&amp;|[\\`*_~[\]#+.-])|`([^`]+)`/g, (_, c, code) => HOLD + (held.push(code != null ? `<code>${code}</code>` : c) - 1) + HOLD)
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^\w_])__([^_]+)__(?![\w_])/g, '$1<strong>$2</strong>')
            .replace(/~~([^~]+)~~/g, '<s>$1</s>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>')
            .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => unsafeUrl(src, true) ? '' : `<img src="${src}" alt="${alt}">`)
            .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, t, h) => unsafeUrl(h) ? t : `<a href="${h}">${t}</a>`)
            .replace(/ {2}\n/g, '<br>')
            .replace(new RegExp(HOLD + '(\\d+)' + HOLD, 'g'), (_, i) => held[+i]);
    }

    // Four spaces per nesting level.
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
            const task = items[i].text.match(/^\[([ xX])\]\s+(.*)$/);
            html += task
                ? `<li><input type="checkbox"${/[xX]/.test(task[1]) ? ' checked' : ''}>${inlineHtml(task[2])}</li>`
                : `<li>${inlineHtml(items[i].text)}</li>`;
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
            const line = raw.replace(/[^\S\n]+$/, m => m.length >= 2 ? '  ' : '');
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

    /* ---- Sanitize ---- */
    // Payload elements are dropped; anything else outside the allowlist is unwrapped.
    const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'MATH']);

    function sanitize(html, allowBlocks, keepStyle) {
        const t = document.createElement('template');
        t.innerHTML = String(html == null ? '' : html);
        const ok = new Set(allowBlocks ? [...INLINE_OK, ...BLOCK, 'INPUT', 'TR', 'TBODY', 'THEAD', 'CAPTION', 'COLGROUP', 'COL'] : INLINE_OK);
        // Depth-first, so nothing hoisted out of an unwrapped parent escapes the walk
        const walk = (node) => [...node.childNodes].forEach(c => {
            if (c.nodeType === 8) return c.remove();
            if (c.nodeType !== 1) return;
            if (DROP.has(c.tagName)) return c.remove();
            walk(c);
            if (!ok.has(c.tagName)) return c.replaceWith(...c.childNodes);
            const meta = INLINE_TAGS[c.tagName.toLowerCase()];
            [...c.attributes].forEach(a => {
                const n = a.name.toLowerCase();
                if (c.tagName === 'A' && n === 'href' && !unsafeUrl(a.value)) return;
                if (c.tagName === 'IMG' && (n === 'alt' || (n === 'src' && !unsafeUrl(a.value, true)))) return;
                if (c.tagName === 'INPUT' && (n === 'type' || n === 'checked')) return;
                if (/^(TD|TH)$/.test(c.tagName) && (n === 'colspan' || n === 'rowspan') && /^[1-9]\d{0,2}$/.test(a.value)) return;
                if (meta && meta.attr === n && (n !== 'dir' || /^(ltr|rtl|auto)$/i.test(a.value))) return;
                if (n === 'style' && keepStyle && !/expression|url\s*\(|javascript:|@import/i.test(a.value)) return;
                c.removeAttribute(a.name);
            });
        });
        walk(t.content);
        mergeAdjacent(t.content);
        return t.innerHTML;
    }

    const markdownHtml = (md) => sanitize(fromMarkdown(md), true);

    // Pasted spans left bare once their styles are stripped carry nothing
    function unwrapBareSpans(html) {
        const t = document.createElement('template');
        t.innerHTML = html;
        [...t.content.querySelectorAll('span')].reverse().forEach(s => { if (!s.attributes.length) s.replaceWith(...s.childNodes); });
        return t.innerHTML;
    }

    /* ---- Single-line content ---- */
    const flatText = (s) => String(s == null ? '' : s).replace(/\s*\n\s*/g, ' ');

    // Blocks and breaks become spaces, then inline-only and whitespace-collapsed.
    function flattenLines(html, keepStyle) {
        const t = document.createElement('template');
        t.innerHTML = String(html == null ? '' : html);
        t.content.querySelectorAll('br').forEach(b => b.replaceWith(' '));
        t.content.querySelectorAll('*').forEach(el => { if (!INLINE_OK.has(el.tagName)) { el.before(' '); el.after(' '); } });
        t.innerHTML = sanitize(t.innerHTML, false, keepStyle);
        // One space per boundary, across element edges too
        // Images and other replaced elements are content: the space after one stays
        const walker = document.createTreeWalker(t.content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let spaced = true, last = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.nodeType === 1) { if (/^(IMG|WBR)$/.test(n.tagName)) { spaced = false; last = n; } continue; }
            let v = n.nodeValue.replace(/[ \t\n\r\f]+/g, ' ');
            if (spaced) v = v.replace(/^ /, '');
            if (v) { spaced = v.endsWith(' '); last = n; }
            n.nodeValue = v;
        }
        if (last && last.nodeType === 3) last.nodeValue = last.nodeValue.replace(/ $/, '');
        return t.innerHTML;
    }

    // One line per block or <br> (.inline with breaks): boundaries become single <br>s, none at the ends.
    const LINE = '\u2028', PARA = '\u2029';
    function breakLines(html, keepStyle) {
        const t = document.createElement('template');
        t.innerHTML = String(html == null ? '' : html);
        t.content.querySelectorAll('br').forEach(b => b.replaceWith(LINE));
        t.content.querySelectorAll(BLOCK_SEL).forEach(b => { b.before(PARA); b.after(PARA); });
        return flattenLines(t.innerHTML, keepStyle)
            .replace(/ *([\u2028\u2029]) */g, '$1')
            .replace(/\u2029+/g, PARA).replace(/\u2028\u2029|\u2029\u2028/g, LINE)
            .replace(/^[\u2028\u2029]+|[\u2028\u2029]+$/g, '')
            .replace(/[\u2028\u2029]/g, '<br>');
    }
    const textLines = (text) => String(text == null ? '' : text).split(/\r\n?|\n/).map(l => l.trim()).filter(Boolean)
        .map(l => sanitize(inlineHtml(l), false)).join('<br>');

    /* ---- Selection primitives ---- */
    const sel = () => window.getSelection();
    // `probe` stands in for the live range while a control is judged against an area's saved one
    let probe = null;
    const liveRange = () => { const s = sel(); return s && s.rangeCount ? s.getRangeAt(0) : null; };
    const range = () => probe || liveRange();

    function elementAt(node) { while (node && node.nodeType !== 1) node = node.parentNode; return node; }

    // Bounded by the area: an area that is itself <strong> never reports as formatting
    function ancestor(match) {
        const r = range(); if (!r) return null;
        const el = elementAt(r.startContainer); if (!el) return null;
        const found = el.closest(match); if (!found) return null;
        const area = el.closest('[data-rich-text]');
        if (area && (found === area || !area.contains(found))) return null;
        return found;
    }

    const withinArea = (node, found) => {
        if (!found) return false;
        const el = elementAt(node), area = el && el.closest('[data-rich-text]');
        return !area || (found !== area && area.contains(found));
    };

    // Bounded by the area, so a block command never replaces the editor
    function blockEl() {
        let n = elementAt(range() && range().startContainer);
        while (n && !areas.has(n)) {
            if (BLOCK.includes(n.tagName)) return n;
            n = n.parentElement;
        }
        return null;
    }

    function ensureBlock(area) {
        let b = blockEl();
        if (b) return b;
        b = document.createElement('p');
        const r = range();
        if (r && area.contains(r.startContainer)) r.insertNode(b); else area.appendChild(b);
        caretIn(b, 0);
        return b;
    }
    const blockTag = () => { const b = blockEl(); return b && b.tagName; };

    function selectNode(node) {
        const s = sel(), r = document.createRange();
        r.selectNodeContents(node); s.removeAllRanges(); s.addRange(r);
    }

    // Caret as a character offset, so it survives rebuilt nodes
    function offsetIn(root) {
        const r = range(); if (!r || !root.contains(r.startContainer)) return null;
        const pre = document.createRange();
        pre.selectNodeContents(root);
        pre.setEnd(r.startContainer, r.startOffset);
        return pre.toString().length;
    }

    // The selection as text offsets in root, and back
    function textSpan(root) {
        const r = range(); if (!r || !root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
        const at = (node, off) => { const pre = document.createRange(); pre.selectNodeContents(root); pre.setEnd(node, off); return pre.toString().length; };
        return [at(r.startContainer, r.startOffset), at(r.endContainer, r.endOffset)];
    }
    function selectSpan(root, [from, to]) {
        const point = (offset, end) => {
            const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let seen = 0, last = null;
            for (let n = w.nextNode(); n; n = w.nextNode()) {
                last = n;
                if (end ? seen + n.length >= offset : seen + n.length > offset) return [n, offset - seen];
                seen += n.length;
            }
            return last ? [last, last.length] : [root, 0];
        };
        const r = document.createRange(), a = point(from, false), b = point(to, true);
        r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
        const s = sel(); s.removeAllRanges(); s.addRange(r);
    }

    function caretIn(root, offset) {
        const s = sel(), r = document.createRange();
        if (offset == null) offset = 0;
        // An empty block holds a caret only with a <br> and an element anchor
        if (!root.textContent.length) {
            [...root.childNodes].forEach(n => { if (n.nodeType === 3) n.remove(); });
            if (!root.querySelector('br')) root.appendChild(document.createElement('br'));
            r.setStart(root, 0); r.collapse(true);
            s.removeAllRanges(); s.addRange(r);
            return;
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let seen = 0;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.length) continue;
            if (seen + n.length >= offset) {
                r.setStart(n, Math.max(0, offset - seen)); r.collapse(true);
                s.removeAllRanges(); s.addRange(r);
                return;
            }
            seen += n.length;
        }
        r.setStart(root, root.childNodes.length); r.collapse(true);
        s.removeAllRanges(); s.addRange(r);
    }

    // Boundary text nodes are split so every node returned lies wholly inside the selection
    function selectedTextNodes() {
        const r = range(); if (!r || r.collapsed) return [];
        if (r.endContainer.nodeType === 3 && r.endOffset < r.endContainer.length) {
            const end = r.endContainer, at = r.endOffset;
            end.splitText(at); r.setEnd(end, end.length);
        }
        if (r.startContainer.nodeType === 3 && r.startOffset > 0) {
            const start = r.startContainer, at = r.startOffset, same = r.endContainer === start, endAt = r.endOffset;
            const tail = start.splitText(at);
            r.setStart(tail, 0);
            if (same) r.setEnd(tail, endAt - at);
        }
        const root = r.commonAncestorContainer;
        const walker = document.createTreeWalker(root.nodeType === 1 ? root : root.parentNode, NodeFilter.SHOW_TEXT);
        const out = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (r.intersectsNode(n) && n.nodeValue && r.comparePoint(n, 0) >= 0 && r.comparePoint(n, n.length) <= 0) out.push(n);
        }
        return out.length ? out : (r.startContainer.nodeType === 3 ? [r.startContainer] : []);
    }

    /* ---- Inline tags ---- */
    function wrapInline(tag, style, attrs) {
        const nodes = selectedTextNodes(); if (!nodes.length) return [];
        const made = [];
        nodes.forEach(n => {
            if (!n.nodeValue.length) return;
            const el = document.createElement(tag);
            if (style) Object.assign(el.style, style);
            if (attrs) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
            n.parentNode.insertBefore(el, n);
            el.appendChild(n);
            made.push(el);
            el.querySelectorAll(tag).forEach(dupe => dupe.replaceWith(...dupe.childNodes));
        });
        if (!made.length) return made;
        // Boundaries land inside the new elements
        const s = sel(), r = document.createRange(), last = made[made.length - 1];
        r.setStart(made[0], 0); r.setEnd(last, last.childNodes.length);
        s.removeAllRanges(); s.addRange(r);
        return made;
    }

    function unwrapInline(tag) {
        const nodes = selectedTextNodes();
        const targets = new Set();
        nodes.forEach(n => { const el = elementAt(n) && elementAt(n).closest(tag); if (withinArea(n, el)) targets.add(el); });
        const host = ancestor(tag); if (host) targets.add(host);
        targets.forEach(el => el.replaceWith(...el.childNodes));
        // Reselect the same text
        const live = nodes.filter(n => n.isConnected && n.length);
        if (!live.length) return;
        const r = document.createRange();
        r.setStart(live[0], 0);
        r.setEnd(live[live.length - 1], live[live.length - 1].length);
        const s = sel(); s.removeAllRanges(); s.addRange(r);
    }

    // Every selected text node carries the tag
    function selectionMarked(tag) {
        const r = range(); if (!r) return false;
        if (r.collapsed) return !!ancestor(tag);
        const root = r.commonAncestorContainer;
        const walker = document.createTreeWalker(root.nodeType === 1 ? root : root.parentNode, NodeFilter.SHOW_TEXT);
        let any = false;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!r.intersectsNode(n) || !n.nodeValue.trim()) continue;
            any = true;
            if (!n.parentElement) return false;
            if (!withinArea(n, n.parentElement.closest(tag))) return false;
        }
        return any;
    }

    const toggleInline = (tag, style, attrs) => selectionMarked(tag) ? unwrapInline(tag) : wrapInline(tag, style, attrs);

    const attrsFor = (tag, v) => {
        const m = INLINE_TAGS[tag], val = v != null && v !== '' ? String(v) : m.def;
        return m.attr && val ? { [m.attr]: val } : null;
    };

    function insertVoid(tag) {
        const r = range(); if (!r) return;
        r.deleteContents();
        const n = document.createElement(tag);
        r.insertNode(n);
        const s = sel(), nr = document.createRange();
        nr.setStartAfter(n); nr.collapse(true);
        s.removeAllRanges(); s.addRange(nr);
    }

    /* ---- Block tags ---- */
    // A cell's loose content into a <p> inside it, so block commands nest rather than replace the cell
    function innerBlock(cell) {
        const off = offsetIn(cell), p = document.createElement('p');
        while (cell.firstChild) p.appendChild(cell.firstChild);
        cell.appendChild(p);
        caretIn(p, off);
        return p;
    }

    // The block a command may replace: never a cell, list item, term or container
    function freeBlock() {
        const b = blockEl(); if (!b) return null;
        if (/^(UL|OL|DL|FIGURE|TABLE)$/.test(b.tagName)) return null;
        if (/^(TD|TH)$/.test(b.tagName)) return innerBlock(b);
        if (/^(LI|DT|DD)$/.test(b.tagName)) return liftItem(b);
        return b;
    }

    function setBlock(tag) {
        let b = blockEl(); if (!b) return;
        if (/^(UL|OL|DL|FIGURE|TABLE)$/.test(b.tagName)) return;
        if (/^(TD|TH)$/.test(b.tagName)) b = innerBlock(b);
        const want = (b.tagName === tag.toUpperCase() ? 'p' : tag).toLowerCase();
        if (b.tagName === want.toUpperCase()) return;
        // Out of the list first (outdenting nested items to the top), then retag
        if (b.tagName === 'LI' && want !== 'li') {
            const area = b.closest('[data-rich-text]');
            for (let guard = 0; guard < 8; guard++) {
                const list = b && b.tagName === 'LI' && b.closest('ul, ol');
                if (!list || !list.parentElement || !list.parentElement.closest('li')) break;
                indent(-1, area);
                b = blockEl(); if (!b) return;
            }
            if (b.tagName === 'LI') { liftItem(b); b = blockEl(); if (!b) return; }
            if (b.tagName === want.toUpperCase()) return;
        }
        if (/^(DT|DD)$/.test(b.tagName)) { b = liftItem(b); if (want === 'p') return; }
        const n = document.createElement(want);
        n.setAttribute('style', b.getAttribute('style') || '');
        if (!n.getAttribute('style')) n.removeAttribute('style');
        const off = offsetIn(b);
        while (b.firstChild) n.appendChild(b.firstChild);
        b.replaceWith(n);
        // A sublist that rode along steps out after the new block
        [...n.querySelectorAll(':scope > ul, :scope > ol')].reverse().forEach(l => n.after(l));
        caretIn(n, off);
    }

    const styleBlock = (prop, value) => { const b = blockEl(); if (b) b.style[prop] = value; };
    const readBlockStyle = (prop) => { const b = blockEl(); return b ? getComputedStyle(b)[prop] : ''; };

    function retagKeep(b, tag) { const off = offsetIn(b); caretIn(retagBlock(b, tag), off); }

    /* ---- Figures and description lists ---- */
    function toggleFigure() {
        const existing = ancestor('figure');
        if (existing) {
            const caption = existing.querySelector(':scope > figcaption');
            if (caption) caption.remove();
            existing.replaceWith(...existing.childNodes);
            return;
        }
        const b = freeBlock(); if (!b) return;
        const fig = document.createElement('figure');
        b.replaceWith(fig);
        fig.appendChild(b);
        const caption = document.createElement('figcaption');
        caption.appendChild(document.createElement('br'));
        fig.appendChild(caption);
        caretIn(caption, 0);
    }

    // One caption per figure: an existing one takes the caret instead
    function setCaption() {
        const fig = ancestor('figure'), b = blockEl(); if (!fig || !b) return;
        const caption = fig.querySelector(':scope > figcaption');
        if (caption && caption !== b && !caption.contains(b)) return caretIn(caption, caption.textContent.length);
        if (b.parentElement === fig) setBlock('figcaption');
    }

    function toggleDl() {
        const dl = ancestor('dl');
        if (dl) {
            const term = ancestor('dt, dd'), off = term ? offsetIn(term) : 0;
            let land = null;
            [...dl.children].forEach(c => {
                if ([...c.children].some(x => BLOCK.includes(x.tagName))) { if (c === term) land = c.firstElementChild; c.replaceWith(...c.childNodes); }
                else { const p = retagBlock(c, 'p'); if (c === term) land = p; }
            });
            dl.replaceWith(...dl.childNodes);
            if (land) caretIn(land, off);
            return;
        }
        const b = freeBlock(); if (!b) return;
        const list = document.createElement('dl'), dt = document.createElement('dt'), dd = document.createElement('dd');
        while (b.firstChild) dt.appendChild(b.firstChild);
        dd.appendChild(document.createElement('br'));
        list.append(dt, dd);
        b.replaceWith(list);
        caretIn(dd, 0);
    }

    // Retags the term itself, never a block nested in one
    const setTerm = (tag) => () => {
        const term = ancestor('dt, dd');
        if (!term || term.tagName === tag.toUpperCase()) return;
        retagKeep(term, tag);
    };
    const termIs = (tag) => { const t = ancestor('dt, dd'); return !!t && t.tagName === tag; };

    /* ---- Lists, tables, indent ---- */
    const inList = () => !!ancestor('li');
    const inTable = () => !!cellAt();

    /* ---- Tables ---- */
    let cellDrag = null;                       // pointer-picked block of cells
    const cellAt = () => ancestor('td, th') || (cellDrag && cellDrag.anchor.isConnected ? cellDrag.anchor : null);
    const tableAt = () => { const c = cellAt(); return c && c.closest('table'); };
    const rowsOf = (table) => [...table.rows];
    const emptyCell = () => { const td = document.createElement('td'); td.appendChild(document.createElement('br')); return td; };

    // Occupancy grid: every slot maps to the cell covering it, spans included
    function tableGrid(table) {
        const grid = [];
        rowsOf(table).forEach((row, r) => {
            grid[r] = grid[r] || [];
            let c = 0;
            for (const cell of row.cells) {
                while (grid[r][c]) c++;
                for (let dr = 0; dr < (cell.rowSpan || 1); dr++) {
                    grid[r + dr] = grid[r + dr] || [];
                    for (let dc = 0; dc < (cell.colSpan || 1); dc++) grid[r + dr][c + dc] = cell;
                }
                c += cell.colSpan || 1;
            }
        });
        return grid;
    }

    function gridPosition(cell) {
        const table = cell.closest('table'), grid = tableGrid(table);
        for (let r = 0; r < grid.length; r++) {
            for (let c = 0; c < (grid[r] || []).length; c++) if (grid[r][c] === cell) return { row: r, col: c, grid };
        }
        return { row: 0, col: 0, grid };
    }

    const cellCovering = (row, col) => {
        const table = row.closest('table'), grid = tableGrid(table);
        const r = rowsOf(table).indexOf(row);
        return (grid[r] || [])[col] || row.lastElementChild;
    };

    const columnCount = (table) => Math.max(0, ...tableGrid(table).map(r => r.length));

    // Short rows are padded back out
    function normalizeTables(root) {
        root.querySelectorAll('table').forEach(table => {
            const rows = rowsOf(table); if (!rows.length) return;
            const grid = tableGrid(table);
            const width = Math.max(0, ...grid.map(r => r.length));
            rows.forEach((row, r) => {
                const have = (grid[r] || []).filter(Boolean).length;
                for (let i = have; i < width; i++) row.appendChild(emptyCell());
            });
            if (!table.querySelector('tbody, thead')) {
                const body = document.createElement('tbody');
                while (table.firstChild) body.appendChild(table.firstChild);
                table.appendChild(body);
            }
        });
    }

    function addRow(where) {
        const cell = cellAt(); if (!cell) return;
        const row = cell.parentElement, table = row.closest('table');
        const fresh = document.createElement('tr');
        for (let i = 0; i < columnCount(table); i++) fresh.appendChild(emptyCell());
        if (where < 0) row.before(fresh); else row.after(fresh);
        caretIn(fresh.firstElementChild, 0);
    }

    function addColumn(where) {
        const cell = cellAt(); if (!cell) return;
        const table = cell.closest('table'), { col, grid } = gridPosition(cell);
        const seen = new Set();
        rowsOf(table).forEach((row, r) => {
            const at = (grid[r] || [])[col];
            if (!at || seen.has(at)) return;
            seen.add(at);
            const fresh = document.createElement(at.tagName === 'TH' ? 'th' : 'td');
            fresh.appendChild(document.createElement('br'));
            if (where < 0) at.before(fresh); else at.after(fresh);
        });
        normalizeTables(table.parentElement || table);
        caretIn(cellCovering(rowsOf(table)[gridPosition(cell).row], where < 0 ? col : col + 1), 0);
    }

    function removeRow() {
        const cell = cellAt(); if (!cell) return;
        const row = cell.parentElement, table = row.closest('table');
        if (rowsOf(table).length <= 1) return removeTable();
        const next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        caretIn(next.firstElementChild, 0);
    }

    function removeColumn() {
        const cell = cellAt(); if (!cell) return;
        const table = cell.closest('table'), { col, grid } = gridPosition(cell);
        if (columnCount(table) <= 1) return removeTable();
        const seen = new Set();
        grid.forEach(row => { const at = row[col]; if (!at || seen.has(at)) return; seen.add(at); at.remove(); });
        normalizeTables(table.parentElement || table);
        caretIn(cellCovering(rowsOf(table)[0], Math.max(0, col - 1)), 0);
    }

    function removeTable() {
        const table = tableAt(); if (!table) return;
        const p = document.createElement('p');
        table.replaceWith(p);
        caretIn(p, 0);
    }

    // Selected cells merge as a rectangle; a lone caret merges with the cell to its right
    function mergeCells() {
        const cell = cellAt(); if (!cell) return;
        const picked = selectedCells();
        const cells = picked.length > 1 ? picked : [cell, nextCell(cell)].filter(Boolean);
        if (cells.length < 2) return;

        const at = cells.map(gridPosition);
        const r0 = Math.min(...at.map(p => p.row));
        const r1 = Math.max(...at.map((p, i) => p.row + (cells[i].rowSpan || 1) - 1));
        const c0 = Math.min(...at.map(p => p.col));
        const c1 = Math.max(...at.map((p, i) => p.col + (cells[i].colSpan || 1) - 1));

        const grid = at[0].grid;
        const first = (grid[r0] || [])[c0] || cells[0];
        const cols = c1 - c0 + 1, rows = r1 - r0 + 1;
        if (cols > 1) first.colSpan = cols; else first.removeAttribute('colspan');
        if (rows > 1) first.rowSpan = rows; else first.removeAttribute('rowspan');

        cells.forEach(c => {
            if (c === first) return;
            if (c.textContent.trim()) first.append(' ', ...c.childNodes);
            c.remove();
        });
        tidyCell(first);
        const table = first.closest('table');
        normalizeTables(table.parentElement || table);
        cellDrag = null;
        paintCells(first.closest('[data-rich-text]') || table);
        caretIn(first, first.textContent.length);
    }

    const nextCell = (cell) => {
        const { row, col, grid } = gridPosition(cell);
        const span = cell.colSpan || 1;
        return (grid[row] || [])[col + span] || null;
    };

    const tidyCell = (cell) => {
        if (!cell.textContent.trim()) { cell.replaceChildren(document.createElement('br')); return; }
        cell.querySelectorAll(':scope > br').forEach(br => br.remove());
    };

    function splitCell() {
        const cell = cellAt(); if (!cell) return;
        const cols = cell.colSpan || 1, rows = cell.rowSpan || 1;
        if (cols < 2 && rows < 2) return;
        cell.removeAttribute('colspan'); cell.removeAttribute('rowspan');
        for (let i = 1; i < cols; i++) cell.after(emptyCell());
        if (rows > 1) {
            const table = cell.closest('table'), { row, col } = gridPosition(cell);
            for (let r = 1; r < rows; r++) {
                const target = rowsOf(table)[row + r]; if (!target) break;
                const at = cellCovering(target, col);
                const fresh = emptyCell();
                if (at) at.before(fresh); else target.appendChild(fresh);
            }
        }
        normalizeTables(cell.closest('table').parentElement || cell.closest('table'));
        caretIn(cell, 0);
    }

    // Empty cells hold no text, so cell selection follows the pointer
    const cellUnder = (x, y) => {
        const el = document.elementFromPoint(x, y);
        const cell = el && el.closest && el.closest('td, th');
        return cell && cell.closest('[data-rich-text]') ? cell : null;
    };

    function rectBetween(a, b) {
        if (!a || !b) return [];
        const pa = gridPosition(a), pb = gridPosition(b), grid = pa.grid;
        const r0 = Math.min(pa.row, pb.row), r1 = Math.max(pa.row, pb.row);
        const c0 = Math.min(pa.col, pb.col), c1 = Math.max(pa.col, pb.col);
        const out = [];
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
            const cell = (grid[r] || [])[c];
            if (cell && !out.includes(cell)) out.push(cell);
        }
        return out;
    }

    function selectedCells() {
        if (cellDrag && cellDrag.anchor !== cellDrag.focus && cellDrag.anchor.isConnected && cellDrag.focus.isConnected) {
            return rectBetween(cellDrag.anchor, cellDrag.focus);
        }
        const table = tableAt(); if (!table) return [];
        const s = sel(); if (!s || !s.anchorNode || !s.focusNode) return [];
        const from = elementAt(s.anchorNode), to = elementAt(s.focusNode);
        const a = from && from.closest('td, th'), b = to && to.closest('td, th');
        if (!a || !b || a === b) return [];
        return rectBetween(a, b);
    }

    function toggleHeaderRow() {
        const table = tableAt(); if (!table) return;
        const first = rowsOf(table)[0]; if (!first) return;
        const isHeader = first.firstElementChild && first.firstElementChild.tagName === 'TH';
        [...first.children].forEach(c => {
            const next = document.createElement(isHeader ? 'td' : 'th');
            while (c.firstChild) next.appendChild(c.firstChild);
            if (c.colSpan > 1) next.colSpan = c.colSpan;
            if (c.rowSpan > 1) next.rowSpan = c.rowSpan;
            c.replaceWith(next);
        });
        // <thead> is a child of the table, never of the tbody
        const head = table.querySelector('thead');
        if (!isHeader && !head) {
            const t = document.createElement('thead');
            table.prepend(t);
            t.appendChild(first);
        }
        if (isHeader && head) {
            let body = table.querySelector('tbody');
            if (!body) { body = document.createElement('tbody'); table.appendChild(body); }
            body.prepend(first);
            head.remove();
        }
        caretIn(table.rows[0].firstElementChild, 0);
    }

    /* ---- Column and row sizing ----
       Widths on a <colgroup>, heights on the row. */
    const EDGE = 5;

    function ensureCols(table) {
        let group = table.querySelector(':scope > colgroup');
        if (!group) { group = document.createElement('colgroup'); table.prepend(group); }
        const want = columnCount(table);
        while (group.children.length < want) group.appendChild(document.createElement('col'));
        while (group.children.length > want) group.lastElementChild.remove();
        // Freeze current widths so one drag doesn't reflow the rest
        [...group.children].forEach((col, i) => {
            if (col.style.width) return;
            const at = (tableGrid(table)[0] || [])[i];
            if (at) col.style.width = Math.round(at.getBoundingClientRect().width / (at.colSpan || 1)) + 'px';
        });
        return group;
    }

    function borderAt(x, y) {
        const el = document.elementFromPoint(x, y);
        let cell = el && el.closest && el.closest('td, th');
        if (!cell) {
            // Outer edge: on the table, or just past it
            const scope = el && el.closest && (el.closest('table') || el.closest('[data-rich-text]'));
            if (!scope) return null;
            const tables = scope.tagName === 'TABLE' ? [scope] : [...scope.querySelectorAll('table')];
            for (const table of tables) {
                const box = table.getBoundingClientRect();
                const row = [...table.rows].find(rw => { const b = rw.getBoundingClientRect(); return y >= b.top - EDGE && y <= b.bottom + EDGE; });
                if (!row || !row.cells.length) continue;
                if (Math.abs(x - box.right) <= EDGE) return { axis: 'x', cell: row.cells[row.cells.length - 1] };
                if (Math.abs(y - box.bottom) <= EDGE && x >= box.left && x <= box.right) return { axis: 'y', cell: row.cells[0] };
            }
            return null;
        }
        if (!cell.closest('[data-rich-text]')) return null;
        const b = cell.getBoundingClientRect();
        if (Math.abs(x - b.right) <= EDGE) return { axis: 'x', cell };
        if (Math.abs(x - b.left) <= EDGE) { const prev = previousCell(cell); return prev ? { axis: 'x', cell: prev } : null; }
        if (Math.abs(y - b.bottom) <= EDGE) return { axis: 'y', cell };
        if (Math.abs(y - b.top) <= EDGE) { const row = cell.parentElement.previousElementSibling; return row ? { axis: 'y', cell: row.cells[0] } : null; }
        return null;
    }

    function startResize(e, hit) {
        const cell = hit.cell, table = cell.closest('table');
        const area = cell.closest('[data-rich-text]');
        e.preventDefault();
        area.setAttribute('data-rich-text-resizing', hit.axis);

        let apply;
        if (hit.axis === 'x') {
            const group = ensureCols(table);
            const { col } = gridPosition(cell);
            const index = Math.min(col + (cell.colSpan || 1) - 1, group.children.length - 1);
            const target = group.children[index];
            const start = parseFloat(target.style.width) || cell.getBoundingClientRect().width;
            const from = e.clientX;
            // The outer border sizes the table too
            const outer = index === group.children.length - 1;
            const tableStart = table.getBoundingClientRect().width;
            if (outer) table.style.width = Math.round(tableStart) + 'px';
            apply = (ev) => {
                const delta = ev.clientX - from;
                target.style.width = Math.max(28, Math.round(start + delta)) + 'px';
                if (outer) table.style.width = Math.max(60, Math.round(tableStart + delta)) + 'px';
            };
        } else {
            const row = cell.parentElement;
            const start = row.getBoundingClientRect().height, from = e.clientY;
            apply = (ev) => { row.style.height = Math.max(20, Math.round(start + ev.clientY - from)) + 'px'; };
        }

        const move = (ev) => { ev.preventDefault(); apply(ev); };
        const up = () => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            area.removeAttribute('data-rich-text-resizing');
            area.dispatchEvent(new Event('input', { bubbles: true }));
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
    }

    // Tab walks the grid and grows it at the end
    function moveCell(dir) {
        const cell = cellAt(); if (!cell) return false;
        const cells = [...cell.closest('table').querySelectorAll('td, th')];
        let next = cells[cells.indexOf(cell) + dir];
        if (!next && dir > 0) {
            const row = cell.closest('tr'), fresh = row.cloneNode(true);
            [...fresh.children].forEach(c => { c.innerHTML = '<br>'; c.removeAttribute('colspan'); c.removeAttribute('rowspan'); });
            row.parentNode.appendChild(fresh);
            next = fresh.children[0];
        }
        if (!next) return false;
        caretIn(next, 0);
        return true;
    }

    function caretAtPoint(x, y) {
        if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
        }
        if (document.caretRangeFromPoint) {
            const r = document.caretRangeFromPoint(x, y);
            return r ? { node: r.startContainer, offset: r.startOffset } : null;
        }
        return null;
    }

    function placeAtPoint(x, y) {
        const hit = caretAtPoint(x, y); if (!hit) return null;
        const r = document.createRange();
        try { r.setStart(hit.node, hit.offset); } catch { return null; }
        r.collapse(true);
        const s = sel(); s.removeAllRanges(); s.addRange(r);
        return hit;
    }

    const cellOf = (node) => { const el = elementAt(node); return el && el.closest('td, th'); };

    // Arrows move by line within a cell, then cell to cell, keeping the column
    function arrowInTable(e) {
        const cell = cellAt(); if (!cell) return false;
        const r = range(); if (!r || !r.collapsed) return false;
        const here = r.getBoundingClientRect();

        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const at = offsetIn(cell), len = cell.textContent.length;
            if (e.key === 'ArrowRight' && at < len) return false;
            if (e.key === 'ArrowLeft' && at > 0) return false;
            const next = e.key === 'ArrowRight' ? nextCell(cell) : previousCell(cell);
            if (!next) return e.key === 'ArrowRight' ? moveCell(1) : moveCell(-1);
            caretIn(next, e.key === 'ArrowRight' ? 0 : next.textContent.length);
            return true;
        }

        const down = e.key === 'ArrowDown';
        const line = here.height || parseFloat(getComputedStyle(cell).lineHeight) || 16;
        const x = here.left;
        const probeY = down ? here.bottom + line * 0.5 : here.top - line * 0.5;

        // Another line in this cell means the native move is right
        const ahead = caretAtPoint(x, probeY);
        if (ahead && cellOf(ahead.node) === cell) {
            const probe = document.createRange();
            let onAnotherLine = false;
            try {
                probe.setStart(ahead.node, ahead.offset); probe.collapse(true);
                const box = probe.getBoundingClientRect();
                onAnotherLine = !!box.height && Math.abs(box.top - here.top) > 2;
            } catch { }
            if (onAnotherLine) return false;
        }

        const table = cell.closest('table'), { row, col, grid } = gridPosition(cell);
        const targetRow = row + (down ? (cell.rowSpan || 1) : -1);
        const next = (grid[targetRow] || [])[col];
        if (!next) return escapeTable(table, down);

        const box = next.getBoundingClientRect();
        const aimY = down ? box.top + line * 0.5 : box.bottom - line * 0.5;
        if (placeAtPoint(Math.min(Math.max(x, box.left + 2), box.right - 2), aimY)) return true;
        caretIn(next, down ? 0 : next.textContent.length);
        return true;
    }

    const previousCell = (cell) => {
        const { row, col, grid } = gridPosition(cell);
        for (let c = col - 1; c >= 0; c--) if ((grid[row] || [])[c] && grid[row][c] !== cell) return grid[row][c];
        return null;
    };

    function escapeTable(table, down) {
        const sibling = down ? table.nextElementSibling : table.previousElementSibling;
        if (sibling) { caretIn(sibling, down ? 0 : sibling.textContent.length); return true; }
        if (!down) return false;
        const p = document.createElement('p');
        table.after(p);
        caretIn(p, 0);
        return true;
    }

    /* ---- Lists ---- */
    function retagList(list, tag) {
        const n = document.createElement(tag);
        while (list.firstChild) n.appendChild(list.firstChild);
        list.replaceWith(n);
        return n;
    }

    // An item (li, dt, dd) out of its list into a <p>; following items keep their own list
    function liftItem(item) {
        const list = item.parentElement, off = offsetIn(item);
        const p = document.createElement('p');
        [...item.childNodes].forEach(n => { if (n.tagName !== 'INPUT') p.appendChild(n); });
        const after = [...list.children].slice([...list.children].indexOf(item) + 1);
        list.after(p);
        if (after.length) {
            const tail = document.createElement(list.tagName.toLowerCase());
            if (list.hasAttribute('data-checklist')) tail.setAttribute('data-checklist', '');
            after.forEach(n => tail.appendChild(n));
            p.after(tail);
        }
        item.remove();
        if (!list.children.length) list.remove();
        caretIn(p, off);
        return p;
    }

    function toggleList(tag) {
        const li = ancestor('li');
        if (li) {
            const list = li.closest('ul, ol');
            if (list.tagName.toLowerCase() === tag) return liftItem(li);
            const next = retagList(list, tag);
            next.removeAttribute('data-checklist');
            next.querySelectorAll('input[type=checkbox]').forEach(b => b.remove());
            caretIn(next.querySelector('li') || next, 0);
            return;
        }
        const b = freeBlock(); if (!b) return;
        const off = offsetIn(b);
        const list = document.createElement(tag), item = document.createElement('li');
        while (b.firstChild) item.appendChild(b.firstChild);
        list.appendChild(item);
        b.replaceWith(list);
        caretIn(item, off);
    }

    // .li: into the list above when there is one, else a new bulleted list
    function toggleItem() {
        const li = ancestor('li');
        if (li) return liftItem(li);
        const b = freeBlock(); if (!b) return;
        const prev = b.previousElementSibling;
        if (!prev || !/^(UL|OL)$/.test(prev.tagName)) return toggleList('ul');
        const off = offsetIn(b), item = document.createElement('li');
        if (prev.hasAttribute('data-checklist')) item.appendChild(Object.assign(document.createElement('input'), { type: 'checkbox' }));
        while (b.firstChild) item.appendChild(b.firstChild);
        prev.appendChild(item);
        b.remove();
        caretIn(item, off);
    }

    function toggleChecklist() {
        if (!ancestor('li')) toggleList('ul');
        const item = ancestor('li'); if (!item) return;
        const list = item.closest('ul, ol'); if (!list) return;
        const on = !list.hasAttribute('data-checklist');
        list.toggleAttribute('data-checklist', on);
        [...list.children].forEach(row => {
            const box = row.querySelector(':scope > input[type=checkbox]');
            if (on && !box) { const b = document.createElement('input'); b.type = 'checkbox'; row.insertBefore(b, row.firstChild); }
            if (!on && box) box.remove();
        });
        // Caret after the checkbox, not before it
        const box = item.querySelector(':scope > input[type=checkbox]');
        if (!box) return caretIn(item, 0);
        if (!item.textContent.length && !item.querySelector('br')) item.appendChild(document.createElement('br'));
        const sl = sel(), r = document.createRange();
        r.setStartAfter(box); r.collapse(true);
        sl.removeAllRanges(); sl.addRange(r);
    }

    // Sublists belong inside the preceding item; task items keep one leading box
    function normalizeLists(root) {
        root.querySelectorAll(':is(ul, ol) > :is(ul, ol)').forEach(nested => {
            const prev = nested.previousElementSibling;
            if (prev && prev.tagName === 'LI') return prev.appendChild(nested);
            const li = document.createElement('li');
            nested.parentNode.insertBefore(li, nested);
            li.appendChild(nested);
        });
        root.querySelectorAll('[data-checklist] > li').forEach(li => {
            const boxes = [...li.querySelectorAll(':scope > input[type=checkbox]')];
            boxes.slice(1).forEach(b => b.remove());
            const box = boxes[0] || Object.assign(document.createElement('input'), { type: 'checkbox' });
            if (li.firstChild !== box) li.insertBefore(box, li.firstChild);
            if (li.textContent.length) li.querySelectorAll(':scope > br').forEach(b => b.remove());
        });
    }

    // Nest at most one level below the item above
    function moveItem(by) {
        const li = ancestor('li'); if (!li) return;
        const list = li.parentElement, off = offsetIn(li);
        if (by > 0) {
            const prev = li.previousElementSibling;
            if (!prev || prev.tagName !== 'LI') return;
            let sub = prev.querySelector(':scope > ul, :scope > ol');
            if (!sub) { sub = document.createElement(list.tagName.toLowerCase()); prev.appendChild(sub); }
            sub.appendChild(li);
        } else {
            const parentItem = list.parentElement;
            if (!parentItem || parentItem.tagName !== 'LI') return;
            parentItem.parentElement.insertBefore(li, parentItem.nextSibling);
            if (!list.children.length) list.remove();
        }
        if (off != null) caretIn(li, off);   // the caret stays in the item's text, so Tab and Shift+Tab chain
    }

    function canIndent(area) {
        const li = ancestor('li');
        if (li) return !!li.previousElementSibling;
        return area._rt.format === 'html';
    }

    function canOutdent(area) {
        const li = ancestor('li');
        if (li) return li.closest('ul, ol').parentElement.tagName === 'LI';
        const b = blockEl();
        return area._rt.format === 'html' && !!b && parseFloat(b.style.marginInlineStart) > 0;
    }

    const STEP = 2;   // rem per indent level
    // List items nest; other blocks indent by margin (.html only)
    function indent(by, area) {
        if (inList()) return moveItem(by);
        if (area && area._rt.format !== 'html') return;
        const b = blockEl(); if (!b) return;
        const now = parseFloat(b.style.marginInlineStart) || 0;
        const next = Math.max(0, now + by * STEP);
        if (next) b.style.marginInlineStart = next + 'rem'; else b.style.removeProperty('margin-inline-start');
    }

    /* ---- Links ---- */
    // Scheme, relative path, anchor, or bare domain (gets https://); anything else is refused
    function normalizeUrl(url) {
        if (/\s/.test(url) || unsafeUrl(url)) return null;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(mailto|tel|sms):/i.test(url) || /^[/#?.]/.test(url)) return url;
        if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?|#)/.test(url)) return 'https://' + url;
        return null;
    }
    // An area that is, or sits in, a link takes no links: they cannot nest
    // Links cannot go inside a link or a button
    const linkHost = (area) => !!(area && area.closest('a, button'));
    const unwrapEl = (el) => el.replaceWith(...el.childNodes);
    const textIn = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), out = []; for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n); return out; };
    const sameEl = (a, b) => !!a && !!b && a.nodeType === 1 && b.nodeType === 1 && a.tagName === b.tagName
        && a.attributes.length === b.attributes.length && [...a.attributes].every(x => b.getAttribute(x.name) === x.value);
    // Links go outermost: a link inside formatting swaps with it (<b><a>x</a></b> → <a><b>x</b></a>);
    // then identical neighbours merge and links left without content go. The selection is kept.
    function tidyLinks(area) {
        const r = range(), keep = r && area.contains(r.startContainer) ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : null;
        for (let guard = 0, moved = true; moved && guard < 50; guard++) {
            moved = false;
            [...area.querySelectorAll('a')].forEach(a => {
                const w = a.parentElement;
                if (!a.isConnected || !w || w === area || !area.contains(w) || w.closest('a') || !INLINE_OK.has(w.tagName)) return;
                w.replaceWith(...[...w.childNodes].map(n => {
                    const wc = w.cloneNode(false);
                    if (n.nodeType === 1 && n.tagName === 'A') { wc.append(...n.childNodes); n.appendChild(wc); return n; }
                    wc.appendChild(n); return wc;
                }));
                moved = true;
            });
        }
        const merge = (p) => { [...p.children].forEach(merge); for (let c = p.firstChild; c; c = c.nextSibling) while (c.nodeType === 1 && !/^(BR|WBR|IMG)$/.test(c.tagName) && sameEl(c, c.nextSibling)) { const n = c.nextSibling; c.append(...n.childNodes); n.remove(); } };
        for (let i = 0; i < 3; i++) merge(area);
        area.querySelectorAll('a').forEach(a => { if (!a.textContent.trim() && !a.querySelector('img')) unwrapEl(a); });
        if (keep && keep[0].isConnected && keep[2].isConnected) try { const nr = document.createRange(); nr.setStart(keep[0], keep[1]); nr.setEnd(keep[2], keep[3]); const s = sel(); s.removeAllRanges(); s.addRange(nr); } catch { }
    }
    function setLink(href, area) {
        if (linkHost(area)) return;
        const existing = ancestor('a'), r = range();
        const raw = href == null ? '' : String(href).trim();
        const url = raw ? normalizeUrl(raw) : '';
        if (raw && !url) return;
        // A caret in a link retargets or unlinks all of it
        if (r && r.collapsed) {
            if (existing) { if (url) existing.setAttribute('href', url); else unwrapEl(existing); return; }
            if (url) insertHTML(`<a href="${escHtml(url)}">${escHtml(url)}</a>`);
            return;
        }
        if (!r) return;
        // A selection: each link it touches keeps its unselected text; the selection loses its link, or gets the new one
        const nodes = selectedTextNodes(); if (!nodes.length) return;
        const touched = [...new Set(nodes.map(n => elementAt(n) && elementAt(n).closest('a')).filter(a => a && withinArea(a, a)))];
        touched.forEach(a => {
            const old = a.getAttribute('href'), keep = textIn(a).filter(t => !nodes.includes(t) && t.nodeValue.length);
            unwrapEl(a);
            keep.forEach(t => { const x = document.createElement('a'); if (old != null) x.setAttribute('href', old); t.before(x); x.appendChild(t); });
        });
        const s = sel(), nr = document.createRange(), last = nodes[nodes.length - 1];
        nr.setStart(nodes[0], 0); nr.setEnd(last, last.length);
        s.removeAllRanges(); s.addRange(nr);
        if (url) wrapInline('a').forEach(a => a.setAttribute('href', url));
        const root = area || elementAt(nodes[0]).closest('[data-rich-text]');
        if (root) tidyLinks(root);
    }
    const linkHref = () => { const a = ancestor('a'); return a ? a.getAttribute('href') || '' : ''; };

    /* ---- Insertions ---- */
    function insertHTML(html) { document.execCommand('insertHTML', false, html); }

    const PLAINTEXT_ONLY = (() => {
        try { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only'; } catch { return false; }
    })();

    // Lines as <br>, inserted by hand
    function insertPlain(area, text) {
        const frag = document.createDocumentFragment();
        String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
            if (i) frag.appendChild(document.createElement('br'));
            if (line) frag.appendChild(document.createTextNode(line));
        });
        insertNodes(area, frag);
    }

    // Inserted by hand, so the browser adds no style wrappers of its own
    function insertNodes(area, frag) {
        const r = range(); if (!r || !area.contains(r.startContainer)) return;
        // Pasted or dropped links never land inside a link
        const at = elementAt(r.startContainer);
        if (at && at.closest('a')) [...frag.querySelectorAll('a')].forEach(unwrapEl);
        if (!frag.lastChild) return;
        record(area);
        r.deleteContents();
        // An empty block's placeholder <br> goes; at a block's start, so does the content's leading space
        const holder = blockEl() || area;
        if (!holder.textContent.length && !holder.querySelector('img')) holder.querySelectorAll('br').forEach(b => b.remove());
        if (offsetIn(holder) === 0) {
            const w = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT), first = w.nextNode();
            if (first) first.nodeValue = first.nodeValue.replace(/^\s+/, '');
        }
        let end = frag.lastChild;
        if (!end) return;
        const cr = range(); if (cr && area.contains(cr.startContainer)) cr.insertNode(frag); else area.appendChild(frag);
        // The caret ends inside the last text, never at an element boundary (an IME composition there is left behind)
        const s = sel(), nr = document.createRange();
        if (end.nodeType === 1) { const w = document.createTreeWalker(end, NodeFilter.SHOW_TEXT); let t = null; for (let n = w.nextNode(); n; n = w.nextNode()) t = n; if (t) end = t; }
        if (end.nodeType === 3) nr.setStart(end, end.length); else nr.setStartAfter(end);
        nr.collapse(true);
        s.removeAllRanges(); s.addRange(nr);
        record(area);
        area.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // A selection across blocks is deleted as the browser would: the partly selected end
    // block merges into the start block (never across a table cell), emptied wrappers go.
    // A selection of everything leaves one empty paragraph.
    function clearSpan(area) {
        const r = range(); if (!r || r.collapsed || !area.contains(r.startContainer)) return;
        const texts = textIn(area).filter(t => r.intersectsNode(t) && t.nodeValue.length);
        const whole = document.createRange(); whole.selectNodeContents(area);
        const all = (r.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 && r.compareBoundaryPoints(Range.END_TO_END, whole) >= 0)
            || (texts.length && r.toString() === area.textContent && !area.querySelector('img, hr, table'));
        if (all) {
            area.innerHTML = '<p></p>'; caretIn(area.firstElementChild, 0); return;
        }
        const blockOf = (n) => { for (let e = elementAt(n); e && e !== area; e = e.parentElement) if (BLOCK.includes(e.tagName)) return e; return null; };
        // Boundaries on elements move into text, so the blocks they name are the ones holding text
        if (texts.length) {
            if (r.startContainer.nodeType !== 3) r.setStart(texts[0], 0);
            if (r.endContainer.nodeType !== 3) { const l = texts[texts.length - 1]; r.setEnd(l, l.length); }
        }
        const a = blockOf(r.startContainer), b = blockOf(r.endContainer), at = [r.startContainer, r.startOffset];
        r.deleteContents();
        if (a && b && a !== b && b.isConnected && !/^(TD|TH)$/.test(a.tagName) && !/^(TD|TH)$/.test(b.tagName) && !b.contains(a) && !a.contains(b)) {
            a.append(...b.childNodes);
            let gone = b;
            while (gone.parentElement && gone.parentElement !== area && !gone.parentElement.contains(a) && gone.parentElement.children.length === 1) gone = gone.parentElement;
            gone.remove();
        }
        // The caret stays where the selection started, inside its block (deleteContents leaves it between blocks)
        const c = document.createRange();
        if (at[0].isConnected && area.contains(at[0])) c.setStart(at[0], Math.min(at[1], at[0].nodeType === 3 ? at[0].length : at[0].childNodes.length));
        else if (a && a.isConnected) c.selectNodeContents(a);
        else c.setStart(area, 0);
        c.collapse(c.startContainer === a ? false : true);
        const s = sel(); s.removeAllRanges(); s.addRange(c);
    }
    // A <br> at the caret; with nothing after it, a second one so the new line shows
    function insertBreak(area) {
        const r = range(); if (!r || !area.contains(r.startContainer)) return;
        r.deleteContents();
        const br = document.createElement('br');
        r.insertNode(br);
        const tail = document.createRange();
        tail.setStartAfter(br); tail.setEnd(area, area.childNodes.length);
        if (!tail.toString() && !tail.cloneContents().querySelector('br, img')) br.after(document.createElement('br'));
        const nr = document.createRange(); nr.setStartAfter(br); nr.collapse(true);
        const s = sel(); s.removeAllRanges(); s.addRange(nr);
    }
    const insertImage = (src, alt) => { if (src && !unsafeUrl(src, true)) insertHTML(`<img src="${escHtml(src)}" alt="${escHtml(alt || '')}">`); };

    // Columns × rows: [3, 2], '3x2' or 3
    function insertTable(spec) {
        // Never nest: land after the outermost table
        let host = ancestor('table');
        while (host && host.parentElement && withinArea(host, host.parentElement.closest('table'))) host = host.parentElement.closest('table');
        if (host) { const p = document.createElement('p'); p.appendChild(document.createElement('br')); host.after(p); caretIn(p, 0); }
        if (Array.isArray(spec) && spec.length === 1) spec = spec[0];        // table('3x2'), table([3, 2])
        const parts = Array.isArray(spec) ? spec : String(spec == null ? '' : spec).split(/[x×,\s]+/);
        const n = (v) => Math.max(1, Math.min(20, parseInt(v, 10) || 3));
        const cols = n(parts[0]), rows = n(parts[1]);
        const row = `<tr>${'<td><br></td>'.repeat(cols)}</tr>`;
        insertHTML(`<table><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`);
    }

    // A trailing table, rule or similar block gets a line after it to land on
    // Text and inline marks sitting directly in a block field are wrapped into one <p> per run, caret
    // kept. Authored empty blocks (spacers, an empty figure) are left alone.
    function looseInline(area) {
        const loose = [...area.childNodes].some(n => (n.nodeType === 3 && n.nodeValue.trim()) || (n.nodeType === 1 && INLINE_OK.has(n.tagName) && n.tagName !== 'BR'));
        if (!loose) return;
        const off = offsetIn(area);
        let run = null;
        [...area.childNodes].forEach(n => {
            const inl = n.nodeType === 3 || (n.nodeType === 1 && INLINE_OK.has(n.tagName));
            if (!inl) { run = null; return; }
            if (!run) { if (n.nodeType === 3 && !n.nodeValue.trim()) return; run = document.createElement('p'); n.before(run); }
            run.appendChild(n);
        });
        if (off != null && document.activeElement === area) caretIn(area, off);
    }

    function ensureTrailingBlock(area) {
        const last = area.lastElementChild;
        if (!last || !/^(TABLE|HR|FIGURE|PRE|UL|OL|BLOCKQUOTE|DL)$/.test(last.tagName)) return false;
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        area.appendChild(p);
        return true;
    }

    // A value styles the selection; an empty one removes that style from it (spans left bare go)
    function styleSpan(prop, v) {
        if (v != null && v !== '') return wrapInline('span', { [prop]: v });
        const nodes = selectedTextNodes(), spans = new Set();
        nodes.forEach(n => { for (let el = elementAt(n); el && el.closest && !el.hasAttribute('data-rich-text'); el = el.parentElement) if (el.tagName === 'SPAN' && el.style[prop]) spans.add(el); });
        spans.forEach(s => { s.style[prop] = ''; if (!s.getAttribute('style')) s.removeAttribute('style'); if (!s.attributes.length) unwrapEl(s); });
        return [];
    }

    function clearFormatting() {
        Object.keys(INLINE_TAGS).forEach(t => unwrapInline(t));
        unwrapInline('a');
    }

    /* ---- Document-wide styles (.all) ----
       Custom properties on the area, read back by $rich.all; never in the stored markup. */
    const ALL_VARS = {
        font: '--rich-text-font', size: '--rich-text-size', leading: '--rich-text-leading',
        align: '--rich-text-align', color: '--rich-text-color', background: '--rich-text-background'
    };
    const allStyle = (area) => Object.fromEntries(Object.entries(ALL_VARS)
        .map(([k, v]) => [k, area.style.getPropertyValue(v).trim()]).filter(([, v]) => v));
    const setAllStyle = (area, values) => Object.entries(ALL_VARS).forEach(([k, v]) => {
        const next = values && values[k];
        if (next) area.style.setProperty(v, next); else area.style.removeProperty(v);
    });

    /* ---- Command table ---- */
    const COMMANDS = Object.create(null);
    Object.entries(INLINE_TAGS).forEach(([tag, meta]) => {
        COMMANDS[tag] = {
            md: meta.md,
            run: (v, area) => hasSelection() ? toggleInline(tag, null, attrsFor(tag, v)) : armPending(area, tag, attrsFor(tag, v)),
            active: (v, area) => selectionMarked(tag) !== pendingHas(area, tag)   // pending inside the tag ends it
        };
    });
    Object.entries(BLOCK_TAGS).forEach(([tag, meta]) => {
        COMMANDS[tag] = { md: meta.md, block: 1, run: () => setBlock(tag), active: () => blockTag() === tag.toUpperCase() };
    });
    Object.assign(COMMANDS, {
        a: { md: 1, run: setLink, active: () => !!ancestor('a'), reflect: linkHref, enabled: (area) => !linkHost(area) && (!!ancestor('a') || hasSelection()) },
        unlink: { md: 1, run: (v, area) => setLink('', area), active: () => false, enabled: (area) => !linkHost(area) && (!!ancestor('a') || (hasSelection() && [...area.querySelectorAll('a')].some(a => range().intersectsNode(a)))) },
        br: { md: 1, run: (v, area) => area && area._rt && area._rt.breaks ? insertBreak(area) : insertHTML('<br>'), active: () => false },
        wbr: { run: () => insertVoid('wbr'), active: () => false },
        img: { md: 1, args: 2, run: (v) => Array.isArray(v) ? insertImage(v[0], v[1]) : insertImage(v), active: () => false },

        ul: { md: 1, block: 1, run: () => toggleList('ul'), active: () => !!ancestor('ul') && !ancestor('ul').hasAttribute('data-checklist') },
        ol: { md: 1, block: 1, run: () => toggleList('ol'), active: () => !!ancestor('ol') },
        li: { md: 1, block: 1, run: toggleItem, active: () => !!ancestor('li') },
        checklist: { md: 1, block: 1, run: toggleChecklist, active: () => !!ancestor('ul[data-checklist]') },
        hr: { md: 1, block: 1, run: () => insertHTML('<hr><p><br></p>'), active: () => false },
        figure: { block: 1, run: toggleFigure, active: () => !!ancestor('figure') },
        figcaption: { block: 1, run: setCaption, active: () => !!ancestor('figcaption'), enabled: () => !!ancestor('figure') },
        dl: { block: 1, run: toggleDl, active: () => !!ancestor('dl') },
        dt: { block: 1, run: setTerm('dt'), active: () => termIs('DT'), enabled: () => !!ancestor('dt, dd') },
        dd: { block: 1, run: setTerm('dd'), active: () => termIs('DD'), enabled: () => !!ancestor('dt, dd') },

        table: { block: 1, args: 2, run: (v) => insertTable(v), active: () => false },
        'row-before': { block: 1, run: () => addRow(-1), active: () => false, enabled: () => inTable() },
        'row-after': { block: 1, run: () => addRow(1), active: () => false, enabled: () => inTable() },
        'row-remove': { block: 1, run: removeRow, active: () => false, enabled: () => inTable() },
        'column-before': { block: 1, run: () => addColumn(-1), active: () => false, enabled: () => inTable() },
        'column-after': { block: 1, run: () => addColumn(1), active: () => false, enabled: () => inTable() },
        'column-remove': { block: 1, run: removeColumn, active: () => false, enabled: () => inTable() },
        'table-remove': { block: 1, run: removeTable, active: () => false, enabled: () => inTable() },
        'table-header': { block: 1, run: toggleHeaderRow, active: () => !!(tableAt() && tableAt().querySelector('th')), enabled: () => inTable() },
        merge: { block: 1, run: mergeCells, active: () => false, enabled: () => inTable() },
        split: { block: 1, run: splitCell, active: () => false, enabled: () => { const c = cellAt(); return !!c && ((c.colSpan || 1) > 1 || (c.rowSpan || 1) > 1); } },
        indent: { md: 1, block: 1, run: (v, area) => indent(1, area), active: () => false, enabled: (a) => canIndent(a) },
        outdent: { md: 1, block: 1, run: (v, area) => indent(-1, area), active: () => false, enabled: (a) => canOutdent(a) },
        align: { block: 1, all: 1, run: (v) => styleBlock('textAlign', v || 'start'), active: () => false, reflect: () => readBlockStyle('textAlign') },
        color: { all: 1, needsSelection: 1, run: (v) => styleSpan('color', v), active: () => false, reflect: () => rgbToHex(readInlineStyle('color')) },
        background: { all: 1, needsSelection: 1, run: (v) => styleSpan('backgroundColor', v), active: () => false, reflect: () => rgbToHex(readInlineStyle('backgroundColor')) },
        font: { all: 1, needsSelection: 1, run: (v) => styleSpan('fontFamily', v), active: () => false, reflect: () => readInlineStyle('fontFamily').split(',')[0].replace(/['"]/g, '') },
        size: { all: 1, needsSelection: 1, run: (v) => styleSpan('fontSize', v ? px(v) : ''), active: () => false, reflect: () => readInlineStyle('fontSize') },
        leading: { all: 1, block: 1, run: (v) => styleBlock('lineHeight', v), active: () => false, reflect: () => readBlockStyle('lineHeight') },

        clear: { md: 1, run: clearFormatting, active: () => false },
        // A burst still waiting to be recorded is undoable, and leaves nothing to redo
        undo: { md: 1, history: 1, run: (v, area) => step(area, -1), active: () => false, enabled: (a) => a._history.at > 0 || !!a._history.timer },
        redo: { md: 1, history: 1, run: (v, area) => step(area, 1), active: () => false, enabled: (a) => !a._history.timer && a._history.at < a._history.stack.length - 1 },
        block: { md: 1, block: 1, run: (v, area) => runBlock(area, v), active: () => false, reflect: () => (blockTag() || 'P').toLowerCase() }
    });

    // .block="h2": any block tag command, under that command's own availability
    const BLOCK_CHOICES = new Set([...Object.keys(BLOCK_TAGS), 'ul', 'ol', 'li', 'figure', 'figcaption', 'dl', 'dt', 'dd']);
    function runBlock(area, v) {
        const tag = String(v || 'p').toLowerCase(), spec = COMMANDS[tag];
        if (!BLOCK_CHOICES.has(tag)) return;
        if (area._rt.format !== 'html' && !spec.md) return;
        if (spec.enabled && !spec.enabled(area)) return;
        spec.run(undefined, area);
    }

    const px = (v) => /^\d+(\.\d+)?$/.test(String(v)) ? v + 'px' : v;
    const hasSelection = () => { const r = range(); return !!r && !r.collapsed; };

    /* ---- Pending marks ----
       An inline command at a collapsed caret arms the tag for the next typed text. */
    function armPending(area, tag, attrs) {
        const r = range(); if (!r || !r.collapsed) return;
        const at = area._pending;
        const tags = at && at.node === r.startContainer && at.offset === r.startOffset ? at.tags : new Map();
        tags.has(tag) ? tags.delete(tag) : tags.set(tag, attrs || null);
        area._pending = tags.size ? { tags, node: r.startContainer, offset: r.startOffset } : null;
    }

    const pendingHas = (area, tag) => !!(area && area._pending && area._pending.tags.has(tag));

    function applyPending(area, typed) {
        const at = area._pending; if (!at) return false;
        const r = range();
        if (!r || !r.collapsed || r.startContainer !== at.node || r.startOffset !== at.offset + typed.length) {
            area._pending = null;
            return false;
        }
        const node = r.startContainer, start = at.offset;
        const span = document.createRange();
        span.setStart(node, start); span.setEnd(node, r.startOffset);
        const text = span.toString();                 // as the browser stored it (a trailing space may be U+00A0)
        span.deleteContents();
        // A pending tag already around the caret ends there: the text goes after it, keeping other formatting inside it
        const off = [], on = [];
        at.tags.forEach((attrs, tag) => { const h = elementAt(node).closest(tag); (h && withinArea(node, h) ? off : on).push([tag, attrs]); });
        const offTags = new Set(off.map(([t]) => t.toUpperCase()));
        let pos = { node, offset: start }, keep = [];
        off.forEach(([tag]) => {
            const host = elementAt(pos.node).closest(tag); if (!host) return;
            for (let n = elementAt(pos.node); n && n !== host; n = n.parentElement) if (!offTags.has(n.tagName)) keep.unshift(n.cloneNode(false));
            const rest = document.createRange(); rest.setStart(pos.node, pos.offset); rest.setEnd(host, host.childNodes.length);
            const tail = host.cloneNode(false); tail.appendChild(rest.extractContents());
            host.after(tail);
            if (!tail.textContent) tail.remove();
            pos = { node: host.parentNode, offset: [...host.parentNode.childNodes].indexOf(host) + 1 };
            if (!host.textContent) { pos.offset--; host.remove(); }
        });
        let outer = null, inner = null;
        const wrap = (el) => { if (inner) inner.appendChild(el); else outer = el; inner = el; };
        keep.forEach(wrap);
        on.forEach(([tag, attrs]) => {
            const el = document.createElement(tag);
            if (attrs) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
            wrap(el);
        });
        const t = document.createTextNode(text);
        if (inner) inner.appendChild(t); else outer = t;
        const ins = document.createRange(); ins.setStart(pos.node, pos.offset); ins.collapse(true);
        ins.insertNode(outer);
        area._pending = null;
        const s = sel(), nr = document.createRange(); nr.setStart(t, text.length); nr.collapse(true);
        s.removeAllRanges(); s.addRange(nr);
        return true;
    }

    function readInlineStyle(prop) {
        const el = elementAt(range() && range().startContainer);
        return el ? getComputedStyle(el)[prop] : '';
    }
    // <input type=color> only speaks hex; painting a pixel converts any colour
    let _hexCtx;
    function rgbToHex(v) {
        if (!v) return '#000000';
        try {
            _hexCtx = _hexCtx || document.createElement('canvas').getContext('2d', { willReadFrequently: true });
            _hexCtx.clearRect(0, 0, 1, 1);
            _hexCtx.fillStyle = v;
            _hexCtx.fillRect(0, 0, 1, 1);
            const [r, g, b] = _hexCtx.getImageData(0, 0, 1, 1).data;
            return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
        } catch { return '#000000'; }
    }

    const MODES = new Set(['html', 'plain', 'inline', 'literal', 'autofocus']);

    // Nearest command for an unknown modifier (console warning only)
    const HINTS = {
        bold: 'strong', italic: 'em', underline: 'u', strike: 's', strikethrough: 's', link: 'a', quote: 'blockquote',
        codeblock: 'pre', bullet: 'ul', bullets: 'ul', numbered: 'ol', heading: 'h2', paragraph: 'p', image: 'img',
        rule: 'hr', highlight: 'mark', task: 'checklist', tasks: 'checklist', subscript: 'sub', superscript: 'sup',
        minimal: 'inline'
    };
    function suggest(m) {
        if (!m) return ' — name a command, e.g. .strong';
        const dist = (a, b) => {
            const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
            for (let j = 1; j <= b.length; j++) d[0][j] = j;
            for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            return d[a.length][b.length];
        };
        let hit = HINTS[m.toLowerCase()];
        if (!hit) {
            const [best] = Object.keys(COMMANDS).map(c => [c, dist(m.toLowerCase(), c)]).sort((x, y) => x[1] - y[1]);
            if (best && best[1] <= Math.min(2, m.length - 1)) hit = best[0];
        }
        return hit ? ` — did you mean .${hit}?` : '';
    }

    /* ---- Autoformat ----
       Block markdown converts on Enter; inline marks convert as their closing marker is typed. */
    const LINE_RULES = [
        { re: /^(#{1,6})\s+/, make: (b, m) => retagBlock(b, 'h' + m[1].length) },
        { re: /^[-*+]\s+/, make: (b) => listify(b, 'ul') },
        { re: /^\d+\.\s+/, make: (b) => listify(b, 'ol') },
        { re: /^\[([ xX])\]\s+/, make: (b, m) => listify(b, 'ul', /[xX]/.test(m[1])) },
        { re: /^>\s+/, make: (b) => retagBlock(b, 'blockquote') },
        { re: /^```\s*$/, make: (b) => retagBlock(b, 'pre') },
        { re: /^(-{3,}|\*{3,}|_{3,})\s*$/, make: (b) => { const hr = document.createElement('hr'); b.replaceWith(hr); return hr; } }
    ];

    const INLINE_RULES = [
        { re: /\*\*([^*]+)\*\*/, tag: 'strong' },
        { re: /__([^_]+)__/, tag: 'strong' },
        { re: /(^|[^*])\*([^*\s][^*]*)\*/, tag: 'em', pre: 1, content: 2 },
        { re: /~~([^~]+)~~/, tag: 'del' },
        { re: /`([^`]+)`/, tag: 'code' },
        { re: /!\[([^\]]*)\]\(([^)\s]+)\)/, tag: 'img', alt: 1, src: 2 },
        { re: /\[([^\]]+)\]\(([^)\s]+)\)/, tag: 'a', href: 2 }
    ];

    function retagBlock(b, tag) {
        const n = document.createElement(tag);
        while (b.firstChild) n.appendChild(b.firstChild);
        b.replaceWith(n);
        return n;
    }

    // Consecutive lines join the list above
    function listify(b, tag, checked) {
        const item = document.createElement('li');
        while (b.firstChild) item.appendChild(b.firstChild);
        const prev = b.previousElementSibling;
        const list = prev && prev.tagName === tag.toUpperCase() ? prev : document.createElement(tag);
        if (checked != null) {
            list.setAttribute('data-checklist', '');
            const box = document.createElement('input');
            box.type = 'checkbox'; box.checked = checked;
            item.insertBefore(box, item.firstChild);
        }
        list.appendChild(item);
        if (list !== prev) b.replaceWith(list); else b.remove();
        return item;
    }

    function stripLead(el, count) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let left = count;
        for (let n = walker.nextNode(); n && left > 0; n = walker.nextNode()) {
            const take = Math.min(left, n.length);
            n.deleteData(0, take);
            left -= take;
        }
    }

    function inlineEl(rule, m) {
        const el = document.createElement(rule.tag);
        if (rule.tag === 'img') {
            if (unsafeUrl(m[rule.src], true)) return null;
            el.setAttribute('src', m[rule.src]); el.setAttribute('alt', m[rule.alt] || '');
            return el;
        }
        el.textContent = m[rule.content || 1];
        if (rule.href) { if (unsafeUrl(m[rule.href])) return null; el.setAttribute('href', m[rule.href]); }
        return el;
    }

    function firstInline(text) {
        let best = null;
        for (const rule of INLINE_RULES) {
            const m = text.match(rule.re); if (!m) continue;
            const skip = rule.pre ? m[rule.pre].length : 0;
            const start = m.index + skip;
            if (!best || start < best.start) best = { rule, m, start, len: m[0].length - skip };
        }
        return best;
    }

    // Only a pattern ending exactly at the caret; earliest start wins (image over link)
    function endInline(text) {
        let best = null;
        for (const rule of INLINE_RULES) {
            const re = new RegExp(rule.re.source, 'g');
            let m;
            while ((m = re.exec(text))) {
                if (m.index + m[0].length !== text.length) continue;
                const skip = rule.pre ? m[rule.pre].length : 0;
                const start = m.index + skip;
                if (!best || start < best.start) best = { rule, m, start, len: m[0].length - skip };
                break;
            }
        }
        return best;
    }

    function convertInlineAtCaret(area) {
        const r = range(); if (!r || !r.collapsed) return false;
        const node = r.startContainer;
        if (!node || node.nodeType !== 3 || !node.parentElement) return false;
        const host = node.parentElement.closest('code, pre, a');
        if (host && area.contains(host)) return false;
        const hit = endInline(node.nodeValue.slice(0, r.startOffset));
        if (!hit) return false;
        const el = inlineEl(hit.rule, hit.m); if (!el) return false;
        record(area);
        const tail = node.splitText(hit.start);
        tail.deleteData(0, hit.len);
        tail.parentNode.insertBefore(el, tail);
        const s = sel(), nr = document.createRange();
        nr.setStart(tail, 0); nr.collapse(true);
        s.removeAllRanges(); s.addRange(nr);
        area._exit = el.tagName === 'IMG' ? null : el;
        record(area);
        return true;
    }

    const lastTextIn = (el) => { let last = null; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); for (let t = w.nextNode(); t; t = w.nextNode()) last = t; return last; };
    // A collapsed caret at a mark's end edge: after it in its parent, at the start of the text after it, or at the end of its text
    function atMarkEnd(el, r) {
        if (!el || !el.isConnected || !r || !r.collapsed) return false;
        const n = r.startContainer, o = r.startOffset, last = lastTextIn(el);
        return (n === el.parentNode && n.childNodes[o - 1] === el) || (n === el && o === el.childNodes.length)
            || (n.nodeType === 3 && n === el.nextSibling && o === 0) || (n.nodeType === 3 && n === last && o === n.length);
    }
    const tailOf = (el) => { let t = el.nextSibling; if (!t || t.nodeType !== 3) { t = document.createTextNode(''); el.after(t); } return t; };
    const caretAt = (node, offset) => { const s = sel(), nr = document.createRange(); nr.setStart(node, offset); nr.collapse(true); s.removeAllRanges(); s.addRange(nr); };
    const isWs = (c) => !c || /\s/.test(c);

    // Text typed right after a conversion goes into a text node after the mark, never into it.
    // A space that would collapse is stored as U+00A0 until text follows it.
    function typeAfterMark(area, e) {
        const el = area._exit;
        if (e.inputType !== 'insertText' || !e.cancelable || !e.data || /[\r\n]/.test(e.data) || !atMarkEnd(el, range())) return false;
        e.preventDefault();
        area._exit = null; area._after = el;
        const last = lastTextIn(el), tail = tailOf(el);
        const next = tail.nodeValue[0] || '', prev = (last && last.nodeValue.slice(-1)) || '';
        const chars = [...e.data];
        const text = chars.map((c, i) => c === ' ' && (isWs(i ? chars[i - 1] : prev) || isWs(i < chars.length - 1 ? chars[i + 1] : next)) ? '\u00a0' : c).join('');
        tail.insertData(0, text);
        const nbs = []; [...text].forEach((c, i) => { if (c === '\u00a0') nbs.push(i); });
        area._nb = nbs.length ? { node: tail, at: nbs } : null;
        caretAt(tail, text.length);
        area.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: e.data }));
        return true;
    }

    // A U+00A0 placed after a mark, or just before typed text, becomes a plain space once text is on both sides of it
    function relaxSpaces(area, typed) {
        const r0 = range();
        if (typed && r0 && r0.collapsed && r0.startContainer.nodeType === 3) {
            const at = r0.startOffset - typed.length - 1;
            if (at >= 0 && r0.startContainer.nodeValue[at] === '\u00a0') area._nb = area._nb && area._nb.node === r0.startContainer ? { node: area._nb.node, at: [...new Set([...area._nb.at, at])] } : { node: r0.startContainer, at: [at] };
        }
        const rec = area._nb; if (!rec) return;
        const node = rec.node;
        if (!node.isConnected) { area._nb = null; return; }
        const r = range(), keep = r && r.startContainer === node ? r.startOffset : null;
        rec.at = rec.at.filter(i => {
            const v = node.nodeValue;
            if (v[i] !== '\u00a0') return false;
            const p = node.previousSibling, x = node.nextSibling;
            const prev = i ? v[i - 1] : (p ? p.textContent.slice(-1) : ''), next = i < v.length - 1 ? v[i + 1] : (x ? x.textContent[0] : '');
            if (isWs(prev) || isWs(next)) return true;
            node.replaceData(i, 1, ' ');
            return false;
        });
        if (keep != null) caretAt(node, keep);
        if (!rec.at.length) area._nb = null;
    }

    // IME text composed right after a conversion is moved out of the mark, the caret with it
    function leaveMark(area, typed) {
        const el = area._exit; area._exit = null;
        const r = range();
        if (!el || !el.isConnected || !r || !r.collapsed) return false;
        const node = r.startContainer;
        // Chrome stores a typed trailing space as U+00A0
        const nb = (s) => s.replace(/\u00a0/g, ' ');
        if (node.nodeType !== 3 || !el.contains(node) || r.startOffset !== node.length || !nb(node.nodeValue).endsWith(nb(typed))) return false;
        if (lastTextIn(el) !== node || node.length === typed.length) return false;
        const moved = node.nodeValue.slice(node.length - typed.length);
        node.deleteData(node.length - typed.length, typed.length);
        const tail = tailOf(el);
        tail.insertData(0, moved);
        caretAt(tail, typed.length);
        area._after = el;
        return true;
    }

    function convertInline(root) {
        const nodes = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
        nodes.forEach(node => {
            if (!node.parentElement || node.parentElement.closest('code, pre, a')) return;
            let cur = node;
            for (let guard = 0; guard < 50; guard++) {
                const hit = firstInline(cur.nodeValue); if (!hit) return;
                const el = inlineEl(hit.rule, hit.m); if (!el) return;
                const tail = cur.splitText(hit.start);
                tail.deleteData(0, hit.len);
                tail.parentNode.insertBefore(el, tail);
                cur = tail;
            }
        });
    }

    // Returns the element now holding the line (an <li> continues the list)
    function convertLine(b) {
        if (!b) return b;
        // Only a <pre> inside the editor is a code block
        const area = b.closest('[data-rich-text]');
        const pre = b.closest('pre');
        if (pre && (!area || area.contains(pre))) return b;
        const text = b.textContent;
        for (const rule of LINE_RULES) {
            const m = text.match(rule.re); if (!m) continue;
            stripLead(b, m[0].length);
            const made = rule.make(b, m);
            if (made.tagName !== 'HR') convertInline(made);
            return made;
        }
        convertInline(b);
        return b;
    }

    /* ---- Enter ---- */
    function splitInto(b, tag) {
        const n = document.createElement(tag);
        const r = range();
        if (b.lastChild && r && b.contains(r.startContainer)) {
            const tail = document.createRange();
            tail.setStart(r.startContainer, r.startOffset);
            tail.setEndAfter(b.lastChild);
            n.appendChild(tail.extractContents());
        }
        b.after(n);
        if (!b.textContent.length && !b.querySelector('br, img')) b.appendChild(document.createElement('br'));
        return n;
    }

    // Native Enter inside code and for Shift+Enter; Chrome writes <br> pairs in a <pre>
    const codeEndsBlank = (pre) => {
        const last = pre.lastChild;
        if (last && last.nodeName === 'BR' && last.previousSibling && last.previousSibling.nodeName === 'BR') return true;
        return /\n[^\S\n]*$/.test(pre.textContent);
    };
    const leavingCode = () => {
        const pre = ancestor('pre'); if (!pre) return false;
        const r = range();
        return !!r && r.collapsed && codeEndsBlank(pre);
    };
    const ownsEnter = (e) => !e.shiftKey && (!ancestor('pre') || leavingCode());

    /* ---- Backspace ----
       Owned at a block start (no style spans from merged headings) and in a table's last cell. */
    const atBlockStart = () => { const b = ancestor('li') || blockEl(); return !!b && offsetIn(b) === 0; };

    function cellCoversAll() {
        const cell = ancestor('td, th'); if (!cell) return null;
        const r = range(); if (!r) return null;
        const covers = r.collapsed
            ? cell.textContent.length <= 1
            : r.toString().length >= cell.textContent.length;
        return covers ? cell : null;
    }

    function backspaceAtStart() {
        const li = ancestor('li');
        if (li) {
            if (li.previousElementSibling) {
                const prev = li.previousElementSibling, at = prev.textContent.length;
                while (li.firstChild) { const n = li.firstChild; if (n.nodeName === 'INPUT') n.remove(); else prev.appendChild(n); }
                li.remove();
                caretIn(prev, at);
                return;
            }
            const list = li.closest('ul, ol'), p = document.createElement('p');
            [...li.childNodes].forEach(n => { if (n.nodeName !== 'INPUT') p.appendChild(n); });
            list.before(p);
            li.remove();
            if (!list.children.length) list.remove();
            caretIn(p, 0);
            return;
        }
        const b = blockEl(); if (!b || /^(TD|TH)$/.test(b.tagName)) return;
        const prev = b.previousElementSibling;
        if (!prev && /^(DT|DD)$/.test(b.tagName)) { liftItem(b); return; }
        if (!prev) { if (b.tagName !== 'P') retagBlock(b, 'p'); caretIn(blockEl() || b, 0); return; }
        if (prev.tagName === 'HR') { prev.remove(); caretIn(b, 0); return; }
        if (/^(UL|OL)$/.test(prev.tagName)) {
            const last = prev.lastElementChild; if (!last) return;
            const at = last.textContent.length;
            while (b.firstChild) last.appendChild(b.firstChild);
            b.remove();
            caretIn(last, at);
            return;
        }
        const at = prev.textContent.length;
        prev.querySelectorAll(':scope > br:last-child').forEach(br => br.remove());
        while (b.firstChild) prev.appendChild(b.firstChild);
        b.remove();
        caretIn(prev, at);
    }

    function onEnter(area, autoformat) {
        let holder = ancestor('li') || blockEl() || ensureBlock(area);
        // Paragraphs inside a cell, never siblings of it
        if (/^(TD|TH)$/.test(holder.tagName)) holder = innerBlock(holder);

        // An empty last line leaves the code block (bounded to the area)
        const pre = holder.closest('pre');
        if (pre && pre !== area && area.contains(pre)) {
            while (pre.lastChild && (pre.lastChild.nodeName === 'BR' || !pre.lastChild.textContent.trim())) pre.lastChild.remove();
            if (/\n[^\S\n]*$/.test(pre.textContent)) pre.textContent = pre.textContent.replace(/\n[^\S\n]*$/, '');
            const p = document.createElement('p');
            pre.after(p);
            if (!pre.textContent.length) pre.remove();
            caretIn(p, 0);
            return;
        }

        if (holder.tagName === 'LI' && !holder.textContent.length) return liftItem(holder);

        // An empty last paragraph leaves its quote (a quote from markdown holds paragraphs)
        const quote = holder.parentElement;
        if (holder.tagName === 'P' && quote && quote.tagName === 'BLOCKQUOTE' && quote !== area && area.contains(quote) && holder === quote.lastElementChild && !holder.textContent.trim()) {
            quote.after(holder);
            if (!quote.textContent.trim() && !quote.querySelector('img')) quote.remove();
            caretIn(holder, 0);
            return;
        }

        // Terms alternate dt → dd → dt; an empty one leaves the list
        if (/^(DT|DD)$/.test(holder.tagName)) {
            if (!holder.textContent.length) return liftItem(holder);
            caretIn(splitInto(holder, holder.tagName === 'DT' ? 'dd' : 'dt'), 0);
            return;
        }

        // A caption continues after its figure
        if (holder.tagName === 'FIGCAPTION') {
            const next = splitInto(holder, 'p');
            holder.closest('figure').after(next);
            caretIn(next, 0);
            return;
        }

        // Split before converting: conversion strips marker text under the caret
        const next = splitInto(holder, holder.tagName === 'LI' ? 'li' : 'p');
        if (autoformat) holder = convertLine(holder) || holder;

        if (holder.tagName === 'HR') { caretIn(next, 0); return; }

        // A finished ``` line opens the code block
        if (holder.tagName === 'PRE') { next.remove(); caretIn(holder, 0); return; }

        if (holder.tagName === 'LI') {
            const item = next.tagName === 'LI' ? next : retagBlock(next, 'li');
            holder.after(item);
            const box = holder.querySelector(':scope > input[type=checkbox]');
            if (box && !item.querySelector(':scope > input[type=checkbox]')) {
                const fresh = document.createElement('input');
                fresh.type = 'checkbox';
                item.insertBefore(fresh, item.firstChild);
            }
            caretIn(item, 0);
            return;
        }

        // Headings and quotes don't continue themselves
        caretIn(next, 0);
    }

    const MAC = /Mac|iPhone|iPad|iPod/.test((typeof navigator !== 'undefined' && (navigator.userAgentData && navigator.userAgentData.platform || navigator.platform)) || '');

    /* ---- History ----
       HTML snapshots plus caret offset; typing bursts coalesce into one step. */
    const HISTORY_CAP = 200;
    const IDLE = 400;

    // Every entry is a settled state (trailing block, tables), so settling never makes the field differ from its history
    function record(area) {
        const h = area._history; if (!h || h.restoring) return;
        clearTimeout(h.timer); h.timer = null;
        if (area._rt && area._rt.settle) area._rt.settle();
        const html = area.innerHTML;
        // Unchanged: the entry learns where the next edit starts (`before`, for undo);
        // `caret` stays where the edit that produced it ended (for redo)
        if (h.stack[h.at] && h.stack[h.at].html === html) {
            const caret = offsetIn(area);
            if (caret != null) h.stack[h.at].before = caret;
            return;
        }
        h.stack.length = h.at + 1;
        h.stack.push({ html, caret: offsetIn(area) });
        if (h.stack.length > HISTORY_CAP) h.stack.shift();
        h.at = h.stack.length - 1;
    }

    // A burst about to start: the entry it will undo to remembers where it starts (never adds a step)
    function markCaret(area) {
        const h = area._history; if (!h || h.timer || h.restoring) return;
        const top = h.stack[h.at], caret = offsetIn(area);
        if (top && caret != null && top.html === area.innerHTML) top.before = caret;
    }

    // Re-sync once the burst lands, so Undo lights up
    const recordSoon = (area) => {
        const h = area._history; if (!h || h.restoring) return;
        clearTimeout(h.timer);
        h.timer = setTimeout(() => { record(area); sync(); }, IDLE);
    };

    function step(area, by) {
        const h = area._history; if (!h) return;
        // Land a pending burst; walking history alone leaves each entry's carets as recorded
        if (h.timer || !h.stack[h.at] || h.stack[h.at].html !== area.innerHTML) record(area);
        const next = h.at + by;
        if (next < 0 || next >= h.stack.length) return;
        h.at = next; h.restoring = true;
        const entry = h.stack[next];
        area.innerHTML = entry.html;
        if (area._rt && area._rt.settle) { area._rt.settle(); entry.html = area.innerHTML; }
        area.focus();
        caretIn(area, by < 0 && entry.before != null ? entry.before : entry.caret);
        saveRange(area);
        area.dispatchEvent(new Event('input', { bubbles: true }));
        h.restoring = false;
    }

    /* ---- Registry + resolution ----
       Controls resolve by containment (nearest ancestor holding exactly one area), then
       by focus; x-rich-text-for pins either. */
    const areas = new Set();
    const controls = new Set();
    let lastFocused = null;

    const onScreen = (el) => el.checkVisibility ? el.checkVisibility() : !!el.offsetParent;
    const inside = (root) => [...areas].filter(a => root.contains(a) && a !== root);
    const preferred = (list) => list.find(a => a === lastFocused && onScreen(a)) || list.find(onScreen) || list[0] || null;

    function resolve(control) {
        const pin = control.closest('[x-rich-text-for]');
        if (pin) {
            const target = document.querySelector(pin.getAttribute('x-rich-text-for'));
            if (target) return areas.has(target) ? target : preferred(inside(target));
        }
        for (let n = control.parentElement; n; n = n.parentElement) {
            const found = inside(n);
            if (found.length === 1) return found[0];
            if (found.length > 1) return unambiguous(found);
        }
        return unambiguous([...areas]);
    }

    // Releasing the target is announced with a null selection
    function release(area) {
        const was = area || lastFocused;
        if (!area || area === lastFocused) lastFocused = null;
        if (!was) return;
        was.removeAttribute('data-rich-text-focused');
        was._selection = null;
        was.removeAttribute('data-rich-text-selected');
        document.documentElement.removeAttribute('data-rich-text-selected');
        was.dispatchEvent(new CustomEvent('rich-text:selection', { bubbles: true, detail: null }));
    }

    // Stands in for relatedTarget during the blur a pointer caused
    let pointerTarget = null;

    function keeps(area, node) {
        const el = elementAt(node);
        if (!el) return false;
        if (area.contains(el)) return true;
        const control = el.closest('[data-rich-text-control]');
        return !!control && resolve(control) === area;
    }

    const TEXTLESS = /^(checkbox|radio|button|submit|reset|range|color|file|image|hidden)$/i;
    const editableElsewhere = (node) => {
        const el = elementAt(node);
        return !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !TEXTLESS.test(el.type)));
    };

    // Several areas in scope and none focused: no target
    function unambiguous(found) {
        if (lastFocused && found.includes(lastFocused) && lastFocused.isConnected && onScreen(lastFocused)) return lastFocused;
        const visible = found.filter(onScreen);
        return visible.length === 1 ? visible[0] : null;
    }

    /* ---- Caret custody ----
       Each area keeps its last range, so a focus-taking control can put it back. */
    function saveRange(area) {
        const r = range();
        if (r && area.contains(r.startContainer)) area._range = r.cloneRange();
    }

    const forget = (keep) => areas.forEach(a => { if (!keep || !a.contains(keep)) a._range = null; });

    function restoreRange(area) {
        const r = liveRange();
        if (r && area.contains(r.startContainer)) return;
        const saved = area._range;
        if (!saved || !area.contains(saved.startContainer)) return;
        area.focus();                                   // its focusin saves the caret focus placed: put ours back
        area._range = saved;
        const s = sel(); s.removeAllRanges(); s.addRange(saved);
    }

    // With focus in a control (an <input> for a link, a <select>), commands read the area's saved range
    function judged(area, fn) {
        const live = liveRange();
        if ((live && area.contains(live.startContainer)) || !area._range || !area.contains(area._range.startContainer)) return fn();
        const was = probe; probe = area._range;
        try { return fn(); } finally { probe = was; }
    }
    // Focus or caret in another editable element (not this area, not one of the controls): stay quiet
    function busyElsewhere(area) {
        const a = document.activeElement;
        if (a && a !== document.body && a.closest && !area.contains(a)) {
            if (a.closest('[data-rich-text-control]')) return false;
            if (editableElsewhere(a)) return true;
        }
        const live = liveRange();
        return !!live && !area.contains(live.startContainer) && editableElsewhere(live.startContainer);
    }

    function allows(area, id, ctrl) {
        const spec = COMMANDS[id], cfg = area && area._rt;
        if (!spec || !cfg) return false;
        const all = !!(ctrl && ctrl.all && spec.all);
        if (all && cfg.noAll) return false;
        if (!all && busyElsewhere(area)) return false;
        if (spec.history) return spec.enabled(area);
        if (cfg.format === 'plain') return false;
        if (cfg.inline && !all && (spec.block || (id === 'br' && !cfg.breaks))) return false;
        if (cfg.format !== 'html' && !spec.md && !all) return false;
        if (all) return true;
        if (!area._range || !area.contains(area._range.startContainer)) return false;
        return judged(area, () => !(spec.needsSelection && !hasSelection()) && (!spec.enabled || spec.enabled(area)));
    }

    function run(area, id, arg, ctrl) {
        const spec = COMMANDS[id]; if (!spec) return;
        const all = !!(ctrl && ctrl.all && spec.all);
        if (!all) {
            // Judged before restoring, so a refused (or keyboard-activated) control never takes focus back
            if (!allows(area, id, ctrl)) return;
            restoreRange(area);
            const r = range();
            if (!r || !area.contains(r.startContainer)) return;
        }
        if (!allows(area, id, ctrl)) return;
        if (all) {
            area.style.setProperty(ALL_VARS[id], id === 'size' ? px(arg) : arg);
            if (!arg) area.style.removeProperty(ALL_VARS[id]);
            area.dispatchEvent(new CustomEvent('rich-text:all', { bubbles: true, detail: allStyle(area) }));
            sync();
            return;
        }
        const arming = INLINE_TAGS[id] && !hasSelection();
        if (arming) { spec.run(arg, area); sync(); return; }
        if (!spec.history) record(area);
        const before = textSpan(area);
        spec.run(arg, area);
        // A command that rebuilt the blocks under the selection (a block style) leaves it where it was
        const after = range();
        if (before && before[1] > before[0] && (!after || !area.contains(after.startContainer) || after.collapsed)) selectSpan(area, before);
        mergeAdjacent(area);
        normalizeLists(area);
        if (!spec.history) record(area);
        saveRange(area);
        if (!spec.history) area.dispatchEvent(new Event('input', { bubbles: true }));
        sync();
    }

    // Reflect caret state onto every control
    function sync() {
        controls.forEach(c => {
            const cfg = c._rt, area = resolve(c);
            const usable = !!area && allows(area, cfg.id, cfg);
            if (!area) { c.removeAttribute('data-rich-text-active'); c.setAttribute('aria-disabled', 'true'); if (c.tagName === 'BUTTON') c.setAttribute('aria-pressed', 'false'); return; }
            const spec = COMMANDS[cfg.id];
            const all = !!(cfg.all && spec.all);
            c.toggleAttribute('data-rich-text-active', usable && !all && !!judged(area, () => spec.active(cfg.literal, area)));
            c.setAttribute('aria-disabled', String(!usable));
            if (usable && (all || spec.reflect) && 'value' in c && c !== document.activeElement) {
                const v = all ? area.style.getPropertyValue(ALL_VARS[cfg.id]).trim() : judged(area, () => spec.reflect());
                // Never blank a <select> with a value it doesn't offer
                const offered = c.tagName !== 'SELECT' || [...c.options].some(o => o.value === v);
                if (v != null && offered && c.value !== v) c.value = v;
            }
            if (c.tagName === 'BUTTON') c.setAttribute('aria-pressed', String(c.hasAttribute('data-rich-text-active')));
        });
    }

    /* ---- Document listeners ---- */
    let listening = false;
    function listen() {
        if (listening) return;
        listening = true;
        // A link clicked in a field is content: neither the router nor the browser follows it.
        // A contenteditable=false island inside the field keeps its links. Window capture runs first.
        const blockLink = (e) => {
            const link = e.target && e.target.closest && e.target.closest('a[href]');
            const field = link && link.closest('[data-rich-text]');
            if (!field || !areas.has(field)) return;
            const off = link.closest('[contenteditable="false"]');
            if (off && field.contains(off)) return;
            e.preventDefault();
        };
        window.addEventListener('click', blockLink, true);
        window.addEventListener('auxclick', blockLink, true);
        // No inline computed styles; Enter makes <p>, not <div>
        try { document.execCommand('styleWithCSS', false, false); } catch { }
        try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { }

        document.addEventListener('pointerdown', (e) => {
            pointerTarget = e.target;
            setTimeout(() => { pointerTarget = null; }, 0);
        }, true);

        document.addEventListener('selectionchange', () => {
            const r = range(); if (!r) return;
            const a = [...areas].find(x => x.contains(r.startContainer));
            if (a) {
                if (lastFocused && lastFocused !== a) release(lastFocused);
                saveRange(a); lastFocused = a; report(a);
            }
            else if (editableElsewhere(r.startContainer)) { forget(); if (lastFocused) release(); }
            sync();
        });

        // Caret moved into something else editable: controls lose their target
        document.addEventListener('focusin', (e) => {
            const t = e.target;
            if (!t || !t.closest) return;
            if (t.closest('[data-rich-text-control]')) return;
            const elsewhere = editableElsewhere(t);
            if (elsewhere) forget(t);
            if (t.closest('[data-rich-text]')) return;
            if (!lastFocused && !elsewhere) return;
            if (lastFocused) release();
            sync();
        }, true);
    }

    /* ---- Directive ---- */
    function init() {
        if (!window.Alpine || !Alpine.directive) return;
        // Alpine walks only x-data trees: a page with none still gets its fields
        if (document.body && !document.body.hasAttribute('x-data')) document.body.setAttribute('x-data', '{}');
        listen();

        Alpine.directive('rich-text', (el, { expression, modifiers }, { effect, evaluateLater, evaluate, cleanup }) => {
            const id = modifiers.find(m => COMMANDS[m]);
            if (id) return control(el, id, modifiers, expression, evaluate, cleanup);
            if (/^(BUTTON|SELECT|INPUT|TEXTAREA|A)$/.test(el.tagName)) {
                const m = modifiers.find(x => !MODES.has(x) && x !== 'all');
                console.warn(`[Manifest Rich Text] unknown command${m ? ` .${m}` : ''} on <${el.tagName.toLowerCase()}>${suggest(m)}`);
                return;
            }
            return areaDirective(el, modifiers, expression, { effect, evaluateLater, cleanup });
        });

        // x-rich-text-menu: a popover shown over its area's selection
        Alpine.directive('rich-text-menu', (el, _, { cleanup }) => { if (!el._rtMenu) selectionMenu(el, cleanup); });

        // $rich: the area this element sits in, else the one controls would resolve to
        const richMagic = (el) => {
            const own = el.closest('[data-rich-text]');
            const a = own && areas.has(own) ? own : resolve(el);
            return a ? a._rt.api : idleApi();
        };
        Alpine.magic('rich', richMagic);
        // The loader's stand-in answered $rich until now: it hands over, and effects that read it
        // run again once adopted areas exist
        window.__manifestRichMagic = richMagic;
        if (window.__manifestRichStub) setTimeout(() => { window.__manifestRichStub.v++; }, 0);

        adopt();
    }

    // Loaded after Alpine started: elements it already walked get their x-rich-text*
    // attributes re-set, which Alpine handles as newly added directives
    function adopt() {
        document.querySelectorAll('*').forEach(el => {
            if (!el._x_marker || el._rt || el._rtMenu || controls.has(el)) return;
            [...el.attributes].forEach(a => {
                if (a.name.startsWith('x-rich-text') && !a.name.startsWith('x-rich-text-for')) el.setAttribute(a.name, a.value);
            });
        });
    }

    function idleApi() {
        const api = {
            value: '', link: '', selection: null, all: {}, run() { }, active: () => false,
            can: () => false, focus() { }, selectAll() { }, markdown: () => '', html: () => ''
        };
        Object.keys(COMMANDS).forEach(id => { api[id] = () => { }; });
        return api;
    }

    /* ---- Selection reporting ----
       Geometry as a rich-text:selection event and as --rich-text-selection-* properties. */
    const SELECTION_VARS = ['x', 'y', 'width', 'height', 'center'].map(k => '--rich-text-selection-' + k);

    function selectionOf(area) {
        const r = range();
        if (!r || !area.contains(r.startContainer)) return null;
        const box = r.getBoundingClientRect();
        return {
            collapsed: r.collapsed,
            text: r.toString(),
            x: box.left, y: box.top, width: box.width, height: box.height,
            top: box.top, bottom: box.bottom, left: box.left, right: box.right
        };
    }

    function paintCells(area) {
        area.querySelectorAll('[data-rich-text-cell]').forEach(c => c.removeAttribute('data-rich-text-cell'));
        selectedCells().forEach(c => c.setAttribute('data-rich-text-cell', ''));
    }

    // On the root only, where a top-layer menu reads them: never in the content's own style
    function place(area, shape) {
        if (!shape || shape.collapsed) return;
        const px = (n) => Math.round(n) + 'px', t = document.documentElement;
        t.style.setProperty('--rich-text-selection-x', px(shape.x));
        t.style.setProperty('--rich-text-selection-y', px(shape.y));
        t.style.setProperty('--rich-text-selection-width', px(shape.width));
        t.style.setProperty('--rich-text-selection-height', px(shape.height));
        t.style.setProperty('--rich-text-selection-center', px(shape.x + shape.width / 2));
    }

    function report(area) {
        const live = sel();
        if (cellDrag && live && live.isCollapsed) { const c = cellOf(live.anchorNode); if (c) cellDrag = null; }
        if (area.querySelector('table')) paintCells(area);
        const shape = selectionOf(area);
        area._selection = shape;
        place(area, shape);
        area.toggleAttribute('data-rich-text-selected', !!shape && !shape.collapsed);
        document.documentElement.toggleAttribute('data-rich-text-selected', !!shape && !shape.collapsed);
        area.dispatchEvent(new CustomEvent('rich-text:selection', { bubbles: true, detail: shape }));
    }

    // popover="manual": an auto popover closes on the click that makes the selection
    function selectionMenu(el, cleanup) {
        el._rtMenu = true;
        if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
        el.setAttribute('data-rich-text-menu', '');
        let shown = null, frame = 0;
        const follow = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => { frame = 0; if (shown && shown.isConnected) place(shown, selectionOf(shown)); });
        };
        const track = (area) => {
            if (!shown) {
                window.addEventListener('scroll', follow, { capture: true, passive: true });
                window.addEventListener('resize', follow, { passive: true });
            }
            shown = area;
        };
        const untrack = () => {
            if (!shown) return;
            shown = null;
            window.removeEventListener('scroll', follow, { capture: true });
            window.removeEventListener('resize', follow);
        };
        const onSel = (e) => {
            const area = elementAt(e.target) && elementAt(e.target).closest('[data-rich-text]');
            if (!area || resolve(el) !== area) return;
            const want = !!e.detail && !e.detail.collapsed;
            if (want) track(area); else untrack();
            try {
                if (want && !el.matches(':popover-open')) el.showPopover();
                if (!want && el.matches(':popover-open')) el.hidePopover();
            } catch { }
        };
        document.addEventListener('rich-text:selection', onSel);
        cleanup(() => {
            document.removeEventListener('rich-text:selection', onSel);
            untrack(); if (frame) cancelAnimationFrame(frame);
            try { el.hidePopover(); } catch { }
        });
    }

    function control(el, id, modifiers, expression, evaluate, cleanup) {
        if (controls.has(el)) return;
        // `.align.center`, `.align.all.center`: the first other modifier after the command is its argument
        const all = modifiers.includes('all');
        const literal = modifiers.slice(modifiers.indexOf(id) + 1).find(m => m !== 'all');
        const arg = () => literal !== undefined ? literal : (expression ? evaluate(expression) : undefined);
        el._rt = { id, arg, all, literal };   // the expression is evaluated only when the control runs
        if (all) el.setAttribute('data-rich-text-all', '');
        el.setAttribute('data-rich-text-control', id);
        if (el.tagName === 'BUTTON' && !el.hasAttribute('type')) el.type = 'button';
        controls.add(el);

        const valued = 'value' in el && el.tagName !== 'BUTTON';
        // Never take the caret
        const disabled = () => el.getAttribute('aria-disabled') === 'true';
        el.addEventListener('mousedown', e => { if (!valued || disabled()) e.preventDefault(); });
        if (valued) el.addEventListener('click', e => { if (disabled()) e.preventDefault(); });
        if (valued) {
            const fire = () => { const a = resolve(el); if (a) run(a, id, el.value, el._rt); };
            if (el.type === 'color') {
                // Live preview: the first tick wraps (one undo step), later ticks restyle the same spans
                const prop = id === 'background' ? 'backgroundColor' : 'color';
                let live = null;
                const dropLive = () => {
                    if (!live) return;
                    const r = range();
                    if (!r || !live.some(sp => sp.isConnected && sp.contains(r.startContainer))) live = null;
                };
                document.addEventListener('rich-text:selection', dropLive);
                cleanup(() => document.removeEventListener('rich-text:selection', dropLive));
                el.addEventListener('input', () => {
                    const a = resolve(el); if (!a) return;
                    if (el._rt.all) { run(a, id, el.value, el._rt); return; }
                    if (live && live.length && live.every(s => s.isConnected)) {
                        live.forEach(s => { s.style[prop] = el.value; });
                        a.dispatchEvent(new Event('input', { bubbles: true }));
                        return;
                    }
                    if (!allows(a, id, el._rt)) return;
                    restoreRange(a);
                    const r = range(); if (!r || !a.contains(r.startContainer)) return;
                    record(a);
                    live = wrapInline('span', { [prop]: el.value });
                    saveRange(a);
                    a.dispatchEvent(new Event('input', { bubbles: true }));
                });
                el.addEventListener('change', () => {
                    if (live) { const a = resolve(el); live = null; if (a) { record(a); sync(); } return; }
                    fire();
                });
            } else {
                el.addEventListener('change', fire);
            }
            el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fire(); } });
        } else {
            el.addEventListener('pointerdown', e => e.preventDefault());
            el.addEventListener('click', e => { e.preventDefault(); const a = resolve(el); if (a) run(a, id, arg(), el._rt); });
        }
        setTimeout(sync, 0);
        cleanup(() => { controls.delete(el); });
    }

    function areaDirective(el, modifiers, expression, { effect, evaluateLater, cleanup }) {
        if (el._rt) return;
        const format = modifiers.includes('html') ? 'html' : modifiers.includes('plain') ? 'plain' : 'markdown';
        modifiers.filter(m => !MODES.has(m)).forEach(m => console.warn(`[Manifest Rich Text] unknown modifier: .${m}${suggest(m)}`));

        let last = null, setValue = null;
        const core = setup(el, {
            format, inline: modifiers.includes('inline'), literal: modifiers.includes('literal'),
            bound: !!expression, controlled: !!expression,
            onChange: expression ? (v) => { last = v; setValue(() => { }, { scope: { __richTextValue: v } }); } : null
        });
        if (expression) {
            const getValue = evaluateLater(expression);
            setValue = evaluateLater(`${expression} = __richTextValue`);
            effect(() => getValue(v => {
                const s = v == null ? '' : String(v);
                if (s === last) return;                       // our own write coming back
                last = s;
                core.load(s);
            }));
        }
        if (modifiers.includes('autofocus')) setTimeout(() => el.focus(), 0);
        cleanup(core.destroy);
    }

    /* ---- Area engine ----
       Shared by the directive and ManifestRichText.attach(). */
    function setup(el, { format = 'markdown', inline: single = false, breaks = false, all: allStyles = true, literal = false, bound = false, controlled = false, onChange = null } = {}) {
        // .inline html with breaks: one block of lines; <br> kept, Shift+Enter makes one
        const lines = single && breaks && format === 'html';
        const flat = (html) => lines ? breakLines(html, true) : flattenLines(html, true);
        const ac = new AbortController();
        const on = (type, fn) => el.addEventListener(type, fn, { signal: ac.signal });
        const prior = ['contenteditable', 'role', 'aria-multiline'].map(n => [n, el.getAttribute(n)]);
        const priorAll = Object.values(ALL_VARS).map(v => [v, el.style.getPropertyValue(v)]);

        el.setAttribute('data-rich-text', format);
        // Tells x-edit whether the value already has an owner
        el.toggleAttribute('data-rich-text-bound', bound);
        el.toggleAttribute('data-rich-text-inline', single);
        el.setAttribute('contenteditable', format === 'plain' && PLAINTEXT_ONLY ? 'plaintext-only' : 'true');
        el.setAttribute('role', 'textbox');
        el.setAttribute('aria-multiline', String(!single || lines));

        const read = () => {
            if (format === 'plain') return single ? el.innerText.replace(/\s*\n\s*/g, ' ').trim() : el.innerText.replace(/\n{3,}/g, '\n\n').trim();
            if (single) return format === 'html' ? flat(el.innerHTML) : inlineMarkdown(el);
            return format === 'html' ? sanitize(el.innerHTML, true, true) : toMarkdown(el);
        };
        const write = (v) => {
            if (format === 'plain') { el.textContent = single ? flatText(v).trim() : v == null ? '' : String(v); return; }
            if (single) { el.innerHTML = format === 'html' ? flat(v) : sanitize(inlineHtml(flatText(v).trim()), false); return; }
            el.innerHTML = format === 'html' ? sanitize(v, true, true) : markdownHtml(v);
            if (!el.childNodes.length) el.innerHTML = '<p><br></p>';
            normalizeLists(el);
            if (el.querySelector('table')) normalizeTables(el);
            ensureTrailingBlock(el);
        };

        // Single-line insertion: clipboard or drop data flattened, at a range when given
        const htmlText = (html) => { const t = document.createElement('template'); t.innerHTML = html || ''; return t.content.textContent; };
        const mdOnly = (html) => format === 'markdown' ? markdownMarks(html) : html;
        const flatClip = (html, text) => html ? mdOnly(unwrapBareSpans(lines ? breakLines(flattenTables(html, false)) : flattenLines(flattenTables(html, false))))
            : lines ? textLines(text) : sanitize(inlineHtml(flatText(text).trim()), false);
        const multiline = (html, text) => {
            if (!html) return /[\r\n]/.test(text || '');
            const t = document.createElement('template'); t.innerHTML = html;
            return !!t.content.querySelector(BLOCK_SEL + ',br,div');
        };
        const insertFlat = (html, at, text) => {
            if (at) { const s = sel(); s.removeAllRanges(); s.addRange(at); }
            if (format === 'plain') return insertPlain(el, flatText(text != null ? text : htmlText(html)).trim());
            const t = document.createElement('template');
            t.innerHTML = html;
            insertNodes(el, t.content);
        };

        let writing = false;
        const commit =() => { if (onChange) onChange(read()); };
        on('input', () => { if (!writing) commit(); });

        // Uncontrolled: the markup already there is the initial content
        if (!controlled && format !== 'plain') {
            if (single) { if (el.querySelector(BLOCK_SEL)) el.innerHTML = flat(el.innerHTML); }
            else {
                if (el.firstChild && ![...el.children].some(c => BLOCK.includes(c.tagName))) el.innerHTML = `<p>${el.innerHTML}</p>`;
                if (!el.firstChild) el.innerHTML = '<p><br></p>';
            }
        }

        el._history = { stack: [{ html: el.innerHTML, caret: 0 }], at: 0, timer: null, restoring: false };
        const resetHistory = () => { clearTimeout(el._history.timer); el._history.timer = null; el._history.stack = [{ html: el.innerHTML, caret: 0 }]; el._history.at = 0; };

        // Empty flag for the placeholder; a wiped document restarts as a paragraph
        function settle() {
            if (single) {
                // Backstop: whatever got a block or break in is flattened, caret kept
                if (el.querySelector(lines ? BLOCK_SEL : BLOCK_SEL + ',br')) {
                    const off = offsetIn(el), html = flat(el.innerHTML);
                    if (format === 'plain') { const t = document.createElement('template'); t.innerHTML = html; el.textContent = t.content.textContent; }
                    else el.innerHTML = html;
                    if (off != null && el.textContent.length) caretIn(el, off);
                }
                const empty = !el.textContent.trim() && !el.querySelector('img');
                if (empty && el.firstChild && !el.textContent.length) el.replaceChildren();
                el.toggleAttribute('data-rich-text-empty', empty);
                return;
            }
            if (el.querySelector('table')) normalizeTables(el);
            if (format !== 'plain') looseInline(el);
            ensureTrailingBlock(el);
            // A code block just opened (``` + Enter) holds the caret: it stays
            const r = range(), first = el.firstElementChild, opened = !!first && first.tagName === 'PRE' && !!r && first.contains(r.startContainer);
            if (!opened && !el.textContent.trim() && !el.querySelector('img, table, hr')) {
                if (el.children.length !== 1 || el.firstElementChild.tagName !== 'P') el.replaceChildren();
                if (!el.firstChild) { el.innerHTML = '<p><br></p>'; if (document.activeElement === el) caretIn(el.firstElementChild, 0); }
                el.toggleAttribute('data-rich-text-empty', true);
            } else el.toggleAttribute('data-rich-text-empty', false);
        }

        const load = (v) => {
            writing = true; write(v); writing = false;
            resetHistory();
            settle();
        };

        const lineBreak = () => { record(el); insertBreak(el); record(el); el.dispatchEvent(new Event('input', { bubbles: true })); };
        const enter = (shiftKey) => el.dispatchEvent(new CustomEvent('rich-text:enter', { bubbles: true, detail: { value: read(), shiftKey: !!shiftKey } }));

        // Table borders resize; drags pick cells
        on('pointermove', (ev) => {
            if (ev.buttons || !el.querySelector('table')) return;
            const hit = borderAt(ev.clientX, ev.clientY);
            el.setAttribute('data-rich-text-border', hit ? hit.axis : '');
            if (!hit) el.removeAttribute('data-rich-text-border');
        });
        on('pointerdown', (ev) => {
            el._exit = null; el._after = null;
            if (ev.button !== 0) return;
            if (el.querySelector('table')) {
                const hit = borderAt(ev.clientX, ev.clientY);
                if (hit) return startResize(ev, hit);
                const from = cellUnder(ev.clientX, ev.clientY);
                if (from) cellDrag = { anchor: from, focus: from };
            }
        });
        on('pointermove', (ev) => {
            if (!cellDrag || !ev.buttons) return;
            const over = cellUnder(ev.clientX, ev.clientY);
            if (!over || over === cellDrag.focus) return;
            cellDrag.focus = over;
            paintCells(el);
        });
        on('pointerup', () => {
            if (cellDrag && cellDrag.anchor === cellDrag.focus) cellDrag = null;
            paintCells(el);
            sync();
        });

        // Links are content here, not navigation
        on('click', (e) => {
            const a = e.target && e.target.closest && e.target.closest('a');
            const island = a && a.closest('[contenteditable="false"]');
            if (a && el.contains(a) && !(island && el.contains(island))) e.preventDefault();
        });

        on('focusin', () => { if (lastFocused && lastFocused !== el) release(lastFocused); lastFocused = el; el.setAttribute('data-rich-text-focused', ''); saveRange(el); sync(); });
        on('focusout', (e) => {
            if (keeps(el, e.relatedTarget || pointerTarget)) return;
            release(el);
            sync();
        });

        const autoformat = format !== 'plain' && !literal;
        on('input', (e) => {
            // Mid-composition the IME owns the text
            if (!writing && e.data && !e.isComposing) {
                if (applyPending(el, e.data)) { mergeAdjacent(el); commit(); }
                if (leaveMark(el, e.data)) commit();
                if (autoformat && convertInlineAtCaret(el)) commit();
            }
            // A deletion of text typed after a mark, back to its edge, is right after the mark again
            if (el._delOut && /^delete/.test(e.inputType || '') && atMarkEnd(el._after, range())) el._exit = el._after;
            el._delOut = false;
            if (!writing && !e.isComposing) relaxSpaces(el, e.inputType === 'insertText' ? e.data : null);
            if (!writing) recordSoon(el);
            settle(); sync();
        });
        on('compositionend', (e) => {
            if (!writing && e.data && applyPending(el, e.data)) { commit(); sync(); }
            else if (!writing && e.data && el._exit && leaveMark(el, e.data)) { commit(); sync(); }
            if (!writing) relaxSpaces(el);
        });
        on('change', e => {
            if (e.target.type !== 'checkbox') return;
            // Only the attribute survives serialization
            e.target.toggleAttribute('checked', e.target.checked);
            record(el);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        on('input', (e) => {
            if (writing || e.isComposing) return;
            if (ancestor('li')) normalizeLists(el);
        });

        // Native undo would desync the plugin's stack
        on('beforeinput', (e) => {
            if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
                e.preventDefault();
                run(el, e.inputType === 'historyUndo' ? 'undo' : 'redo');
                return;
            }
            markCaret(el);
            if (typeAfterMark(el, e)) return;
            if (/^delete/.test(e.inputType || '')) { const m = el._after, r = range(); el._delOut = !!(m && m.isConnected && r && !m.contains(r.startContainer) && !atMarkEnd(m, r)); }
            if (lines && e.inputType === 'insertLineBreak') { e.preventDefault(); lineBreak(); return; }
            if (single && /^insert(Paragraph|LineBreak)$/.test(e.inputType || '')) { e.preventDefault(); enter(false); return; }
            // Text carrying line breaks (autocorrect, IME, replacement) lands as one line
            if (single && e.cancelable && /^insert(Text|ReplacementText|CompositionText)$/.test(e.inputType || '')) {
                const d = e.data != null ? e.data : (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
                if (/[\r\n]/.test(d)) {
                    e.preventDefault();
                    const tr = e.getTargetRanges ? e.getTargetRanges()[0] : null;
                    let at = null;
                    if (tr) { at = document.createRange(); at.setStart(tr.startContainer, tr.startOffset); at.setEnd(tr.endContainer, tr.endOffset); }
                    insertFlat(lines ? textLines(d) : escHtml(flatText(d).trim()), at, d);
                    return;
                }
            }
            if (format === 'plain' && /^format/.test(e.inputType || '')) e.preventDefault();
        });

        // A multi-line drop is flattened at the drop point
        on('drop', (e) => {
            const dt = e.dataTransfer; if (!single || !dt) return;
            const html = dt.getData('text/html'), text = dt.getData('text/plain');
            if (!multiline(html, text)) return;
            e.preventDefault();
            const hit = caretAtPoint(e.clientX, e.clientY);
            let at = null;
            if (hit && el.contains(hit.node)) { at = document.createRange(); at.setStart(hit.node, hit.offset); at.collapse(true); }
            el.focus();
            insertFlat(flatClip(html, text), at, text || htmlText(html));
        });

        on('keydown', (e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && e.target !== el && e.target.matches && e.target.matches('a[href]') && e.target.closest('[contenteditable="false"]') && el.contains(e.target.closest('[contenteditable="false"]'))) return;
            if ((e.key || '').length > 1 && !/^(Shift|Alt|Control|Meta|CapsLock)$/.test(e.key)) { el._exit = null; if (!/^(Backspace|Delete)$/.test(e.key)) el._after = null; }
            if (e.key === 'Enter' && single) { e.preventDefault(); if (lines && e.shiftKey) lineBreak(); else enter(e.shiftKey); return; }
            if (e.key === 'Enter' && format !== 'plain') {
                if (!ownsEnter(e)) return;
                e.preventDefault();
                record(el);
                onEnter(el, autoformat);
                normalizeLists(el);
                record(el);
                commit();
                sync();
                return;
            }
            if (e.key === 'Backspace' && format !== 'plain' && !single) {
                const cell = cellCoversAll();
                if (cell) {                                   // clear the cell, keep the table
                    e.preventDefault(); record(el);
                    cell.replaceChildren(document.createElement('br'));
                    caretIn(cell, 0);
                    record(el); commit(); sync();
                    return;
                }
                const r = range();
                if (r && r.collapsed && atBlockStart()) {
                    e.preventDefault(); record(el);
                    backspaceAtStart();
                    normalizeLists(el);
                    record(el); commit(); sync();
                    return;
                }
            }
            if (/^Arrow(Up|Down|Left|Right)$/.test(e.key) && !e.shiftKey && !e.metaKey && !e.ctrlKey && inTable()) {
                if (arrowInTable(e)) { e.preventDefault(); sync(); return; }
                return;
            }
            // Tab indents (single-line fields keep native focus order); Escape is the way out
            if (e.key === 'Tab') {
                if (format === 'plain' || single) return;
                e.preventDefault();
                if (moveCell(e.shiftKey ? -1 : 1)) return;
                run(el, e.shiftKey ? 'outdent' : 'indent');
                return;
            }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.blur(); return; }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault(); run(el, e.shiftKey ? 'redo' : 'undo'); return;
            }
            // Ctrl+Y redoes off the Mac (where it is yank)
            if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'y' && !MAC) {
                e.preventDefault(); run(el, 'redo'); return;
            }
            // No Cmd/Ctrl+K: that chord belongs to site search
            if (!(e.metaKey || e.ctrlKey)) return;
            const id = { b: 'strong', i: 'em', u: 'u' }[e.key.toLowerCase()];
            if (!id) return;
            // Never the browser's own formatting
            e.preventDefault();
            if (allows(el, id)) run(el, id);
        });

        // Paste as our own subset, never the source app's markup or styles
        on('paste', (e) => {
            e.preventDefault();
            const dt = e.clipboardData; if (!dt) return;
            const text = dt.getData('text/plain');
            if (format === 'plain') return insertPlain(el, single ? flatText(text).trim() : text);
            const html = dt.getData('text/html');
            if (single) return insertFlat(flatClip(html, text), null, text);
            const clip = html ? unwrapBareSpans(format === 'markdown' ? markdownMarks(markdownBlocks(sanitize(flattenTables(html, true), true))) : sanitize(html, true))
                : markdownHtml(text.replace(/([^\n])\n(?!\n)/g, '$1  \n'));
            // Inline content (or a single paragraph of it) goes in at the caret, inside the caret's block,
            // leading space and formatting kept; the browser's insertHTML would place it beside the block
            const t = document.createElement('template'); t.innerHTML = clip;
            const only = t.content.children.length === 1 && t.content.firstElementChild.tagName === 'P' && !t.content.textContent.replace(t.content.firstElementChild.textContent, '').trim() ? t.content.firstElementChild : null;
            if (only) t.innerHTML = only.innerHTML;
            if (!t.content.querySelector(BLOCK_SEL)) { clearSpan(el); return insertNodes(el, t.content); }
            // Its own undo step: a pending burst lands first, the paste records after
            record(el);
            insertHTML(clip);
            record(el);
        });

        const api = {
            get value() { return read(); },
            // The value it already holds keeps the markup and caret; history restarts either way
            set value(v) {
                if (v !== read()) write(v);
                resetHistory();
                settle();
                el._history.restoring = true;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el._history.restoring = false;
            },
            get all() { return allStyle(el); },
            set all(v) { if (!allStyles) return; setAllStyle(el, v); sync(); },
            get selection() { return el._selection || null; },
            get link() { return linkHref(); },
            set link(v) { run(el, 'a', v); },
            focus: () => el.focus(),
            run: (id, arg) => run(el, id, arg),
            active: (id) => allows(el, id) && COMMANDS[id].active(undefined, el),
            can: (id) => allows(el, id),
            selectAll: () => { el.focus(); selectNode(el); saveRange(el); sync(); },
            // The newest step in this field's history (a pending typing burst lands first)
            newest: () => { const h = el._history; if (h.timer || h.stack[h.at].html !== el.innerHTML) record(el); return h.stack[h.stack.length - 1].html; },
            markdown: () => single ? inlineMarkdown(el) : toMarkdown(el),
            html: () => sanitize(el.innerHTML, !single, true)
        };
        // $rich.strong(), $rich.table(3, 2)
        Object.keys(COMMANDS).forEach(id => { api[id] = (...args) => run(el, id, COMMANDS[id].args > 1 ? args : args[0]); });

        el._rt = { format, inline: single, breaks: lines, noAll: !allStyles, api, settle };
        areas.add(el);
        settle();
        el._history.stack[0].html = el.innerHTML;
        setTimeout(sync, 0);

        const destroy = () => {
            if (!areas.has(el)) return;
            ac.abort();
            clearTimeout(el._history && el._history.timer);
            if (lastFocused === el) release(el);
            areas.delete(el);
            prior.forEach(([n, v]) => v == null ? el.removeAttribute(n) : el.setAttribute(n, v));
            [...el.attributes].forEach(a => { if (a.name.startsWith('data-rich-text')) el.removeAttribute(a.name); });
            el.querySelectorAll('[data-rich-text-cell]').forEach(c => c.removeAttribute('data-rich-text-cell'));
            SELECTION_VARS.forEach(v => el.style.removeProperty(v));
            priorAll.forEach(([v, was]) => { if (was) el.style.setProperty(v, was); else el.style.removeProperty(v); });
            if (!areas.size) {
                SELECTION_VARS.forEach(v => document.documentElement.style.removeProperty(v));
                document.documentElement.removeAttribute('data-rich-text-selected');
                if (document.documentElement.getAttribute('style') === '') document.documentElement.removeAttribute('style');
            }
            if (el.getAttribute('style') === '') el.removeAttribute('style');
            ['_rt', '_history', '_range', '_pending', '_exit', '_after', '_nb', '_delOut', '_selection'].forEach(k => { delete el[k]; });
            sync();
        };

        return { api, load, destroy };
    }

    /* ---- Engine API ---- */
    const FORMATS = new Set(['markdown', 'html', 'plain']);
    function attach(el, opts = {}) {
        if (!el || el.nodeType !== 1) return null;
        if (el._rt) return el._rt.handle || null;
        listen();
        const controlled = opts.value !== undefined;
        const core = setup(el, {
            format: FORMATS.has(opts.format) ? opts.format : 'markdown',
            inline: opts.mode === 'inline', breaks: !!opts.breaks, all: opts.all !== false, literal: !!opts.literal,
            bound: typeof opts.onChange === 'function', controlled,
            onChange: typeof opts.onChange === 'function' ? opts.onChange : null
        });
        if (controlled) core.load(opts.value);
        const handle = Object.create(core.api);
        handle.el = el;
        handle.detach = core.destroy;
        el._rt.handle = handle;
        return handle;
    }

    document.addEventListener('alpine:init', init);
    if (window.Alpine && Alpine.directive) init();

    window.ManifestRichText = { toMarkdown, fromMarkdown: markdownHtml, sanitize, commands: () => Object.keys(COMMANDS), attach };
})();
