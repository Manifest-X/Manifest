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

    /* ---- Tag tables ----
       Commands are named for the tag they produce, so there is no Manifest
       vocabulary to map onto HTML: .blockquote makes a <blockquote>. `md` marks the
       tags markdown can carry; the rest are available in .html mode only, where they
       survive, rather than being written and silently dropped on the next save. */
    const INLINE_TAGS = {
        strong: { md: 1 }, b: { md: 1 }, em: { md: 1 }, i: { md: 1 }, s: { md: 1 }, del: { md: 1 }, code: { md: 1 },
        u: {}, mark: {}, small: {}, sub: {}, sup: {}, kbd: {}, samp: {}, var: {}, abbr: {}, cite: {}, q: {}, ins: {}, dfn: {}, time: {}, span: {}
    };
    const BLOCK_TAGS = {
        p: { md: 1 }, h1: { md: 1 }, h2: { md: 1 }, h3: { md: 1 }, h4: { md: 1 }, h5: { md: 1 }, h6: { md: 1 },
        blockquote: { md: 1 }, pre: { md: 1 },
        address: {}, figure: {}, figcaption: {}, dl: {}, dt: {}, dd: {}
    };
    const BLOCK = [...Object.keys(BLOCK_TAGS), 'ul', 'ol', 'li', 'hr', 'table', 'td', 'th'].map(t => t.toUpperCase());
    const MARKS = { STRONG: '**', B: '**', EM: '*', I: '*', S: '~~', DEL: '~~', CODE: '`' };
    const INLINE_OK = new Set([...Object.keys(INLINE_TAGS).map(t => t.toUpperCase()), 'BR', 'A', 'IMG']);

    /* ---- HTML → Markdown ---- */
    const esc = (t) => t.replace(/([\\`*_[\]])/g, '\\$1');

    function inline(node) {
        let out = '';
        node.childNodes.forEach(n => {
            if (n.nodeType === 3) { out += esc(n.textContent); return; }
            if (n.nodeType !== 1) return;
            const tag = n.tagName;
            if (tag === 'BR') { out += '  \n'; return; }
            if (tag === 'IMG') { const src = n.getAttribute('src') || ''; out += src ? `![${n.getAttribute('alt') || ''}](${src})` : ''; return; }
            if (tag === 'A') { const h = n.getAttribute('href') || ''; out += h ? `[${inline(n)}](${h})` : inline(n); return; }
            const m = MARKS[tag];
            if (!m) { out += inline(n); return; }
            const body = tag === 'CODE' ? n.textContent : inline(n);
            out += body.trim() ? m + body + m : body;
        });
        return out;
    }

    // <br> inside a <pre> is a line break; textContent alone would run the lines together.
    const preText = (n) => [...n.childNodes].map(c =>
        c.nodeName === 'BR' ? '\n' : c.nodeType === 3 ? c.nodeValue : preText(c)).join('');

    function block(node, depth) {
        if (node.nodeType === 3) { const t = node.textContent.trim(); return t ? esc(t) : ''; }
        if (node.nodeType !== 1) return '';
        const tag = node.tagName;
        if (tag === 'HR') return '---';
        if (tag === 'PRE') return '```\n' + preText(node).replace(/\n+$/, '') + '\n```';
        if (/^H[1-6]$/.test(tag)) return '#'.repeat(+tag[1]) + ' ' + inline(node).trim();
        if (tag === 'BLOCKQUOTE') return blocks(node, depth).split('\n').map(l => ('> ' + l).trimEnd()).join('\n');
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
            .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => /^\s*javascript:/i.test(src) ? '' : `<img src="${src}" alt="${alt}">`)
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

    function sanitize(html, allowBlocks, keepStyle) {
        const t = document.createElement('template');
        t.innerHTML = String(html == null ? '' : html);
        const ok = new Set(allowBlocks ? [...INLINE_OK, ...BLOCK, 'INPUT', 'TR', 'TBODY', 'THEAD', 'CAPTION', 'DT', 'DD'] : INLINE_OK);
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
                if (c.tagName === 'IMG' && (n === 'src' || n === 'alt') && !/^\s*javascript:/i.test(a.value)) return;
                if (c.tagName === 'INPUT' && (n === 'type' || n === 'checked')) return;
                // Without these a merged cell comes apart on the next save
                if (/^(TD|TH)$/.test(c.tagName) && (n === 'colspan' || n === 'rowspan') && /^[1-9]\d{0,2}$/.test(a.value)) return;
                if (n === 'style' && keepStyle && !/expression|url\s*\(|javascript:/i.test(a.value)) return;   // our own colour, font and alignment
                c.removeAttribute(a.name);
            });
        });
        walk(t.content);
        return t.innerHTML;
    }

    /* ---- Selection primitives ---- */
    const sel = () => window.getSelection();
    const range = () => { const s = sel(); return s && s.rangeCount ? s.getRangeAt(0) : null; };

    function elementAt(node) { while (node && node.nodeType !== 1) node = node.parentNode; return node; }

    function ancestor(match) {
        const r = range(); if (!r) return null;
        const el = elementAt(r.startContainer);
        return el ? el.closest(match) : null;
    }

    // Stops at the editable area. Without that boundary a caret sitting between blocks
    // resolves to the area itself, and a block command replaces the whole editor.
    function blockEl() {
        let n = elementAt(range() && range().startContainer);
        while (n && !areas.has(n)) {
            if (BLOCK.includes(n.tagName)) return n;
            n = n.parentElement;
        }
        return null;
    }

    // deleteContents can take the whole paragraph with it, leaving the caret loose in
    // the area. Put it back in a block before any command reads it.
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

    // Character offset of the caret within a root, and the inverse. Swapping a block
    // element or restoring a history snapshot both rebuild nodes, so the caret has to
    // be addressed by position in the text rather than by node identity.
    function offsetIn(root) {
        const r = range(); if (!r || !root.contains(r.startContainer)) return null;
        const pre = document.createRange();
        pre.selectNodeContents(root);
        pre.setEnd(r.startContainer, r.startOffset);
        return pre.toString().length;
    }

    function caretIn(root, offset) {
        const s = sel(), r = document.createRange();
        if (offset == null) offset = 0;
        // An empty block accepts a caret only when a <br> holds the line open and the
        // range is anchored on the element. Anchored on an empty text node instead,
        // the browser normalizes the caret outward and the next keystroke lands as a
        // sibling of the block rather than inside it. Verified in Chrome; the <br> is
        // the same placeholder contenteditable inserts itself, and the serializer
        // drops a block that holds only one.
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

    // Split the boundary text nodes so every node returned lies wholly inside the
    // selection — wrapping node by node never crosses an element boundary, which is
    // what keeps <code> from swallowing half a paragraph.
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

    /* ---- Inline tags ----
       One generic wrap/unwrap for every inline tag, rather than execCommand's fixed
       handful — that is what lets the command set be the tag set. */
    function wrapInline(tag, style) {
        const nodes = selectedTextNodes(); if (!nodes.length) return [];
        const made = [];
        nodes.forEach(n => {
            if (!n.nodeValue.length) return;
            const el = document.createElement(tag);
            if (style) Object.assign(el.style, style);
            n.parentNode.insertBefore(el, n);
            el.appendChild(n);
            made.push(el);
            el.querySelectorAll(tag).forEach(dupe => dupe.replaceWith(...dupe.childNodes));   // no nesting the same tag
        });
        if (!made.length) return made;
        // Land the boundaries INSIDE the new elements, not around them: everything
        // downstream — active state, setting an href — asks what the caret is in.
        const s = sel(), r = document.createRange(), last = made[made.length - 1];
        r.setStart(made[0], 0); r.setEnd(last, last.childNodes.length);
        s.removeAllRanges(); s.addRange(r);
        return made;
    }

    function unwrapInline(tag) {
        const nodes = selectedTextNodes();
        const targets = new Set();
        nodes.forEach(n => { const el = elementAt(n) && elementAt(n).closest(tag); if (el) targets.add(el); });
        const host = ancestor(tag); if (host) targets.add(host);
        targets.forEach(el => el.replaceWith(...el.childNodes));
    }

    const toggleInline = (tag, style) => ancestor(tag) ? unwrapInline(tag) : wrapInline(tag, style);

    /* ---- Block tags ----
       Swapping the element outright covers every block tag, where formatBlock only
       accepts a short list and disagrees between engines. */
    function setBlock(tag) {
        const b = blockEl(); if (!b) return;
        const want = (b.tagName === tag.toUpperCase() ? 'p' : tag).toLowerCase();
        if (b.tagName === want.toUpperCase()) return;
        const n = document.createElement(want);
        n.setAttribute('style', b.getAttribute('style') || '');
        if (!n.getAttribute('style')) n.removeAttribute('style');
        const off = offsetIn(b);
        while (b.firstChild) n.appendChild(b.firstChild);
        b.replaceWith(n);
        caretIn(n, off);
    }

    const styleBlock = (prop, value) => { const b = blockEl(); if (b) b.style[prop] = value; };
    const readBlockStyle = (prop) => { const b = blockEl(); return b ? getComputedStyle(b)[prop] : ''; };

    /* ---- Lists, tables, indent ---- */
    const inList = () => !!ancestor('li');
    const inTable = () => !!ancestor('td, th');

    /* ---- Tables ----
       A table is a small spreadsheet inside a document, and it needs the operations
       one has: rows and columns added and removed where the caret is, cells merged
       and split, and arrows that move the way the grid looks rather than the way the
       markup is ordered. */
    const cellAt = () => ancestor('td, th');
    const tableAt = () => { const c = cellAt(); return c && c.closest('table'); };
    const rowsOf = (table) => [...table.rows];
    const emptyCell = () => { const td = document.createElement('td'); td.appendChild(document.createElement('br')); return td; };

    // Column index accounting for colspan, so a merged cell does not throw the count.
    function gridPosition(cell) {
        const row = cell.parentElement;
        let col = 0;
        for (const c of row.children) { if (c === cell) break; col += c.colSpan || 1; }
        return { row: [...cell.closest('table').rows].indexOf(row), col };
    }

    // The cell covering a column in a row, following spans.
    function cellCovering(row, col) {
        let at = 0;
        for (const c of row.children) {
            const span = c.colSpan || 1;
            if (col < at + span) return c;
            at += span;
        }
        return row.lastElementChild;
    }

    const columnCount = (table) => Math.max(...rowsOf(table).map(r => [...r.children].reduce((n, c) => n + (c.colSpan || 1), 0)), 0);

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
        const table = cell.closest('table'), { col } = gridPosition(cell);
        rowsOf(table).forEach(row => {
            const at = cellCovering(row, col);
            const fresh = document.createElement(at && at.tagName === 'TH' ? 'th' : 'td');
            fresh.appendChild(document.createElement('br'));
            if (where < 0) at.before(fresh); else at.after(fresh);
        });
        const now = cellCovering(rowsOf(table)[gridPosition(cell).row], where < 0 ? col : col + 1);
        caretIn(now, 0);
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
        const table = cell.closest('table'), { col } = gridPosition(cell);
        if (columnCount(table) <= 1) return removeTable();
        rowsOf(table).forEach(row => { const at = cellCovering(row, col); if (at) at.remove(); });
        const row = rowsOf(table)[0];
        caretIn(cellCovering(row, Math.max(0, col - 1)), 0);
    }

    function removeTable() {
        const table = tableAt(); if (!table) return;
        const p = document.createElement('p');
        table.replaceWith(p);
        caretIn(p, 0);
    }

    // Merge takes the cells the selection touches; with a collapsed caret it takes
    // the one to the right, which is what a single "merge" press usually means.
    function mergeCells() {
        const cell = cellAt(); if (!cell) return;
        const picked = selectedCells();
        const cells = picked.length > 1 ? picked : [cell, cell.nextElementSibling].filter(Boolean);
        if (cells.length < 2) return;
        const first = cells[0];
        const sameRow = cells.every(c => c.parentElement === first.parentElement);
        if (!sameRow) return mergeDown(cells);
        first.colSpan = cells.reduce((n, c) => n + (c.colSpan || 1), 0);
        cells.slice(1).forEach(c => {
            if (c.textContent.trim()) first.append(' ', ...c.childNodes);
            c.remove();
        });
        caretIn(first, first.textContent.length);
    }

    function mergeDown(cells) {
        const first = cells[0];
        first.rowSpan = cells.reduce((n, c) => n + (c.rowSpan || 1), 0);
        cells.slice(1).forEach(c => {
            if (c.textContent.trim()) first.append(' ', ...c.childNodes);
            c.remove();
        });
        caretIn(first, first.textContent.length);
    }

    function splitCell() {
        const cell = cellAt(); if (!cell) return;
        const cols = cell.colSpan || 1, rows = cell.rowSpan || 1;
        if (cols < 2 && rows < 2) return;
        cell.colSpan = 1; cell.rowSpan = 1;
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
        caretIn(cell, 0);
    }

    function selectedCells() {
        const r = range(); if (!r || r.collapsed) return [];
        const table = tableAt(); if (!table) return [];
        return [...table.querySelectorAll('td, th')].filter(c => r.intersectsNode(c));
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
        // A <thead> is a child of the table, never of the tbody. Inserted before the
        // row it would land inside tbody, which is invalid — and table.rows then
        // reports one row, so the next toggle rewrites the wrong one.
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
        // Re-parenting the row detaches the caret, and without it the command reads
        // as unavailable the next time — the header could be turned on but not off.
        caretIn(table.rows[0].firstElementChild, 0);
    }

    // Tab walks the grid and grows it at the end, the way every editor's tables do.
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

    // Vertical arrows move between rows, not along the markup. Horizontal arrows only
    // leave a cell once the caret has run out of text in that direction, so typing
    // and navigating feel like one thing.
    function arrowInTable(e) {
        const cell = cellAt(); if (!cell) return false;
        const r = range(); if (!r || !r.collapsed) return false;
        const table = cell.closest('table'), { row, col } = gridPosition(cell);
        const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp';
        if (!vertical) {
            const at = offsetIn(cell);
            const len = cell.textContent.length;
            if (e.key === 'ArrowRight' && at < len) return false;   // still text to cross
            if (e.key === 'ArrowLeft' && at > 0) return false;
            return moveCell(e.key === 'ArrowRight' ? 1 : -1);
        }
        // Down or up only leaves the cell from its last or first visual line.
        if (!atCellEdge(cell, e.key === 'ArrowDown')) return false;
        const target = rowsOf(table)[row + (e.key === 'ArrowDown' ? 1 : -1)];
        if (!target) return escapeTable(table, e.key === 'ArrowDown');
        const next = cellCovering(target, col);
        if (!next) return false;
        caretIn(next, e.key === 'ArrowDown' ? 0 : next.textContent.length);
        return true;
    }

    // Whether the caret sits on the cell's first or last rendered line. Compared
    // against where a caret at the very start or end of the cell would sit, not
    // against the cell's box — padding and line leading put those several pixels
    // apart, which no fixed tolerance gets right.
    function atCellEdge(cell, down) {
        const r = range(); if (!r) return true;
        const here = r.getBoundingClientRect();
        if (!here.height) return true;
        const probe = document.createRange();
        probe.selectNodeContents(cell);
        probe.collapse(!down);
        const edge = probe.getBoundingClientRect();
        if (!edge.height) return true;
        return down ? here.bottom >= edge.bottom - 2 : here.top <= edge.top + 2;
    }

    // A table at the very end of a document has nothing after it to click into.
    function escapeTable(table, down) {
        const sibling = down ? table.nextElementSibling : table.previousElementSibling;
        if (sibling) { caretIn(sibling, down ? 0 : sibling.textContent.length); return true; }
        if (!down) return false;
        const p = document.createElement('p');
        table.after(p);
        caretIn(p, 0);
        return true;
    }

    // Built by hand for the same reason as indent: execCommand('insertUnorderedList')
    // puts the <ul> *inside* the paragraph rather than replacing it, which is invalid
    // and silently loses the list on the next serialize.
    function retagList(list, tag) {
        const n = document.createElement(tag);
        while (list.firstChild) n.appendChild(list.firstChild);
        list.replaceWith(n);
        return n;
    }

    function unwrapItem(li) {
        const list = li.closest('ul, ol'), off = offsetIn(li);
        const p = document.createElement('p');
        [...li.childNodes].forEach(n => { if (n.tagName !== 'INPUT') p.appendChild(n); });
        const after = [...list.children].slice([...list.children].indexOf(li) + 1);
        list.parentNode.insertBefore(p, list.nextSibling);
        if (after.length) {                                   // items below carry on in their own list
            const tail = document.createElement(list.tagName.toLowerCase());
            if (list.hasAttribute('data-checklist')) tail.setAttribute('data-checklist', '');
            after.forEach(n => tail.appendChild(n));
            p.parentNode.insertBefore(tail, p.nextSibling);
        }
        li.remove();
        if (!list.children.length) list.remove();
        caretIn(p, off);
    }

    function toggleList(tag) {
        const li = ancestor('li');
        if (li) {
            const list = li.closest('ul, ol');
            if (list.tagName.toLowerCase() === tag) return unwrapItem(li);
            const next = retagList(list, tag);
            next.removeAttribute('data-checklist');
            next.querySelectorAll('input[type=checkbox]').forEach(b => b.remove());
            caretIn(next.querySelector('li') || next, 0);
            return;
        }
        const b = blockEl(); if (!b) return;
        const off = offsetIn(b);
        const list = document.createElement(tag), item = document.createElement('li');
        while (b.firstChild) item.appendChild(b.firstChild);
        list.appendChild(item);
        b.replaceWith(list);
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
        // Offset 0 of the item is *before* the checkbox, so typing would land there.
        const box = item.querySelector(':scope > input[type=checkbox]');
        if (!box) return caretIn(item, 0);
        if (!item.textContent.length && !item.querySelector('br')) item.appendChild(document.createElement('br'));
        const sl = sel(), r = document.createRange();
        r.setStartAfter(box); r.collapse(true);
        sl.removeAllRanges(); sl.addRange(r);
    }

    // execCommand('indent') nests by making a list a direct child of a list, which is
    // invalid — the sublist belongs inside the preceding item. Left alone it costs the
    // whole nested branch on the next serialize. Cheap enough to run after any command.
    function normalizeLists(root) {
        root.querySelectorAll(':is(ul, ol) > :is(ul, ol)').forEach(nested => {
            const prev = nested.previousElementSibling;
            if (prev && prev.tagName === 'LI') return prev.appendChild(nested);
            const li = document.createElement('li');
            nested.parentNode.insertBefore(li, nested);
            li.appendChild(nested);
        });
        // Enter inside a task item clones the row's contents in whatever order the
        // engine feels like, so the box can land after the text or twice over.
        root.querySelectorAll('[data-checklist] > li').forEach(li => {
            const boxes = [...li.querySelectorAll(':scope > input[type=checkbox]')];
            boxes.slice(1).forEach(b => b.remove());
            const box = boxes[0] || Object.assign(document.createElement('input'), { type: 'checkbox' });
            if (li.firstChild !== box) li.insertBefore(box, li.firstChild);
            if (li.textContent.length) li.querySelectorAll(':scope > br').forEach(b => b.remove());
        });
    }

    // Moving the item ourselves rather than calling execCommand('indent'): the browser
    // builds an empty parent item on the second level and sprinkles colour spans on
    // outdent. This also caps nesting at one level deeper than the item above, which
    // is what every list editor does.
    function moveItem(by) {
        const li = ancestor('li'); if (!li) return;
        const list = li.parentElement;
        if (by > 0) {
            const prev = li.previousElementSibling;
            if (!prev || prev.tagName !== 'LI') return;           // nothing to nest under
            let sub = prev.querySelector(':scope > ul, :scope > ol');
            if (!sub) { sub = document.createElement(list.tagName.toLowerCase()); prev.appendChild(sub); }
            sub.appendChild(li);
        } else {
            const parentItem = list.parentElement;
            if (!parentItem || parentItem.tagName !== 'LI') return;   // already top level
            parentItem.parentElement.insertBefore(li, parentItem.nextSibling);
            if (!list.children.length) list.remove();
        }
    }

    // Enabled only where the command would actually move something — a control that
    // is lit but inert is the same bug as one that is missing.
    function canIndent(area) {
        const li = ancestor('li');
        if (li) return !!li.previousElementSibling;             // nothing to nest under otherwise
        return area._te.mode === 'html';
    }

    function canOutdent(area) {
        const li = ancestor('li');
        if (li) return li.closest('ul, ol').parentElement.tagName === 'LI';
        const b = blockEl();
        return area._te.mode === 'html' && !!b && parseFloat(b.style.marginInlineStart) > 0;
    }

    const STEP = 2;   // rem per indent level
    // Nesting a list item is markdown; indenting a paragraph is a CSS margin, which
    // markdown cannot carry — so the second half only runs where it would survive.
    function indent(by, area) {
        if (inList()) return moveItem(by);
        if (area && area._te.mode !== 'html') return;
        const b = blockEl(); if (!b) return;
        const now = parseFloat(b.style.marginInlineStart) || 0;
        const next = Math.max(0, now + by * STEP);
        if (next) b.style.marginInlineStart = next + 'rem'; else b.style.removeProperty('margin-inline-start');
    }

    /* ---- Links ----
       An <input x-text-edit.a> is the whole define / edit / clear surface: it shows
       the current href, sets it on change, and clears the link when emptied. */
    function setLink(href) {
        const existing = ancestor('a');
        const url = href == null ? '' : String(href).trim();
        if (!url) { if (existing) existing.replaceWith(...existing.childNodes); return; }
        if (/^\s*javascript:/i.test(url)) return;
        if (existing) { existing.setAttribute('href', url); return; }
        const made = wrapInline('a');
        if (made.length) made.forEach(a => a.setAttribute('href', url));
        else insertHTML(`<a href="${url}">${url}</a>`);   // nothing selected — drop the URL in as its own link
    }
    const linkHref = () => { const a = ancestor('a'); return a ? a.getAttribute('href') || '' : ''; };

    /* ---- Insertions ---- */
    function insertHTML(html) { document.execCommand('insertHTML', false, html); }
    const insertImage = (src, alt) => { if (src && !/^\s*javascript:/i.test(src)) insertHTML(`<img src="${src}" alt="${alt || ''}">`); };

    function insertTable(spec) {
        const [rows, cols] = String(spec || '3x3').split(/[x×,]/).map(n => Math.max(1, Math.min(20, parseInt(n, 10) || 3)));
        const row = `<tr>${'<td><br></td>'.repeat(cols)}</tr>`;
        insertHTML(`<table><tbody>${row.repeat(rows)}</tbody></table><p><br></p>`);
    }

    // A table, image or rule sitting last leaves nowhere to put the caret after it —
    // there is no line to click on, and no key that reaches past the block.
    function ensureTrailingBlock(area) {
        const last = area.lastElementChild;
        if (!last || !/^(TABLE|HR|FIGURE|PRE|UL|OL|BLOCKQUOTE|DL)$/.test(last.tagName)) return false;
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        area.appendChild(p);
        return true;
    }

    function clearFormatting() {
        selectedTextNodes().forEach(n => {
            let el = elementAt(n);
            while (el && !BLOCK.includes(el.tagName) && el.getAttribute && el.hasAttribute('contenteditable') === false) el = el.parentElement;
        });
        Object.keys(INLINE_TAGS).forEach(unwrapInline);
        unwrapInline('a');
    }

    /* ---- Command table ----
       Every inline and block tag is a command named for itself; the rest are the
       operations that have no tag of their own. `md` means markdown can carry it. */
    /* ---- Page-level styling ----
       Document-wide font, size, colour and so on are presentation, not content — the
       stored value is the area's markup, and burying a wrapper in it to carry a font
       would be a lie about what the document says. They are written as custom
       properties on the area instead, which the stylesheet consumes and $text.page
       hands back as a plain object for the author to persist beside the document. */
    const PAGE_VARS = {
        font: '--text-edit-font', size: '--text-edit-size', leading: '--text-edit-leading',
        align: '--text-edit-align', color: '--text-edit-color', background: '--text-edit-background'
    };
    const pageStyle = (area) => Object.fromEntries(Object.entries(PAGE_VARS)
        .map(([k, v]) => [k, area.style.getPropertyValue(v).trim()]).filter(([, v]) => v));
    const setPageStyle = (area, values) => Object.entries(PAGE_VARS).forEach(([k, v]) => {
        const next = values && values[k];
        if (next) area.style.setProperty(v, next); else area.style.removeProperty(v);
    });

    const COMMANDS = {};
    Object.entries(INLINE_TAGS).forEach(([tag, meta]) => {
        COMMANDS[tag] = {
            md: meta.md,
            run: (v, area) => hasSelection() ? toggleInline(tag) : armPending(area, tag),
            active: (v, area) => !!ancestor(tag) || pendingHas(area, tag)
        };
    });
    Object.entries(BLOCK_TAGS).forEach(([tag, meta]) => {
        COMMANDS[tag] = { md: meta.md, block: 1, run: () => setBlock(tag), active: () => blockTag() === tag.toUpperCase() };
    });

    // A <figure> is a block WITH a caption — retagging a paragraph to one looks like
    // nothing happened, which is exactly what it did before.
    COMMANDS.figure = {
        block: 1,
        active: () => !!ancestor('figure'),
        run: () => {
            const existing = ancestor('figure');
            if (existing) {                                   // unwrap, dropping the caption
                const caption = existing.querySelector('figcaption');
                if (caption) caption.remove();
                existing.replaceWith(...existing.childNodes);
                return;
            }
            const b = blockEl(); if (!b) return;
            const fig = document.createElement('figure');
            b.replaceWith(fig);
            fig.appendChild(b);
            const caption = document.createElement('figcaption');
            caption.appendChild(document.createElement('br'));
            fig.appendChild(caption);
            caretIn(caption, 0);
        }
    };
    Object.assign(COMMANDS, {
        a: { md: 1, run: setLink, active: () => !!ancestor('a'), reflect: linkHref, enabled: () => !!ancestor('a') || hasSelection() },
        ul: { md: 1, block: 1, run: () => toggleList('ul'), active: () => !!ancestor('ul') && !ancestor('ul').hasAttribute('data-checklist') },
        ol: { md: 1, block: 1, run: () => toggleList('ol'), active: () => !!ancestor('ol') },
        checklist: { md: 1, block: 1, run: toggleChecklist, active: () => !!ancestor('ul[data-checklist]') },
        hr: { md: 1, block: 1, run: () => insertHTML('<hr><p><br></p>'), active: () => false },
        img: { md: 1, run: (v) => insertImage(v), active: () => false },
        br: { md: 1, run: () => insertHTML('<br>'), active: () => false },

        table: { block: 1, run: (v) => insertTable(v), active: () => false },
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
        align: { block: 1, page: 1, run: (v) => styleBlock('textAlign', v || 'start'), active: () => false, reflect: () => readBlockStyle('textAlign') },
        color: { page: 1, needsSelection: 1, run: (v) => wrapInline('span', { color: v }), active: () => false, reflect: () => rgbToHex(readInlineStyle('color')) },
        background: { page: 1, needsSelection: 1, run: (v) => wrapInline('span', { backgroundColor: v }), active: () => false, reflect: () => rgbToHex(readInlineStyle('backgroundColor')) },
        font: { page: 1, needsSelection: 1, run: (v) => wrapInline('span', { fontFamily: v }), active: () => false, reflect: () => readInlineStyle('fontFamily').split(',')[0].replace(/['"]/g, '') },
        size: { page: 1, needsSelection: 1, run: (v) => wrapInline('span', { fontSize: px(v) }), active: () => false, reflect: () => readInlineStyle('fontSize') },
        leading: { page: 1, block: 1, run: (v) => styleBlock('lineHeight', v), active: () => false, reflect: () => readBlockStyle('lineHeight') },

        clear: { md: 1, run: clearFormatting, active: () => false },
        undo: { md: 1, history: 1, run: (v, area) => step(area, -1), active: () => false, enabled: (a) => a._history.at > 0 },
        redo: { md: 1, history: 1, run: (v, area) => step(area, 1), active: () => false, enabled: (a) => a._history.at < a._history.stack.length - 1 },
        block: { md: 1, block: 1, run: (v) => setBlock(String(v || 'p').toLowerCase()), active: () => false, reflect: () => (blockTag() || 'P').toLowerCase() }
    });

    const px = (v) => /^\d+(\.\d+)?$/.test(String(v)) ? v + 'px' : v;
    const hasSelection = () => { const r = range(); return !!r && !r.collapsed; };

    /* ---- Pending marks ----
       Bold with nothing selected arms the tag for what you type next, the way a word
       processor does. It cannot be done by wrapping an empty element and putting the
       caret inside — the browser normalizes the caret straight back out — so the mark
       is remembered and applied to the first characters that arrive. The anchor is
       checked on the way in: move the caret elsewhere and the arming lapses rather
       than firing somewhere unexpected. */
    function armPending(area, tag) {
        const r = range(); if (!r || !r.collapsed) return;
        const at = area._pending;
        const tags = at && at.node === r.startContainer && at.offset === r.startOffset ? at.tags : new Set();
        tags.has(tag) ? tags.delete(tag) : tags.add(tag);
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
        span.deleteContents();
        let outer = null, inner = null;
        at.tags.forEach(tag => {
            const el = document.createElement(tag);
            if (inner) inner.appendChild(el); else outer = el;
            inner = el;
        });
        inner.textContent = typed;
        span.insertNode(outer);
        area._pending = null;                       // the caret is inside the tags now
        caretIn(inner, typed.length);
        return true;
    }

    function readInlineStyle(prop) {
        const el = elementAt(range() && range().startContainer);
        return el ? getComputedStyle(el)[prop] : '';
    }
    // <input type=color> only speaks hex, but themes are authored in oklch and modern
    // engines return that verbatim — assigning it to fillStyle does not normalize it
    // either. Painting one pixel and reading it back converts anything paintable.
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

    const MODES = new Set(['html', 'plain', 'minimal', 'literal', 'autofocus']);

    /* ---- Autoformat ----
       A line converts when it is finished, not while it is being typed: press Enter
       and the line you are leaving becomes what its markdown described. Converting
       mid-keystroke fought the writer — a "*" was reinterpreted the moment a second
       one appeared — and made literal markdown impossible to type. Deferring it also
       means what you see and what is stored only ever disagree within one line.

       Without conversion the two genuinely drift: "## Title" left in a paragraph is
       stored as a heading and comes back as one, having looked like body text the
       whole time it was being written. */
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
    const unsafe = (url) => /^\s*javascript:/i.test(url || '');

    function retagBlock(b, tag) {
        const n = document.createElement(tag);
        while (b.firstChild) n.appendChild(b.firstChild);
        b.replaceWith(n);
        return n;
    }

    // Consecutive lines join the list above rather than each starting their own.
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

    // Strip the marker text the rule matched, without disturbing the rest of the line.
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
            if (unsafe(m[rule.src])) return null;
            el.setAttribute('src', m[rule.src]); el.setAttribute('alt', m[rule.alt] || '');
            return el;
        }
        el.textContent = m[rule.content || 1];
        if (rule.href) { if (unsafe(m[rule.href])) return null; el.setAttribute('href', m[rule.href]); }
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

    // Returns the element now holding the line's content — an <li> for a list, so the
    // caller knows to continue the list rather than start a paragraph.
    function convertLine(b) {
        if (!b || b.closest('pre')) return b;
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

    /* ---- Enter ----
       Owned outright rather than post-processed: the split has to know what the line
       became, headings and quotes must not continue themselves, and lists and code
       blocks need a way out that is not the mouse. */
    const CONTINUES = new Set(['LI', 'PRE']);

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

    function exitList(li, area) {
        const list = li.closest('ul, ol');
        const p = document.createElement('p');
        const after = [...list.children].slice([...list.children].indexOf(li) + 1);
        list.after(p);
        if (after.length) {
            const tail = document.createElement(list.tagName.toLowerCase());
            if (list.hasAttribute('data-checklist')) tail.setAttribute('data-checklist', '');
            after.forEach(n => tail.appendChild(n));
            p.after(tail);
        }
        li.remove();
        if (!list.children.length) list.remove();
        caretIn(p, 0);
        void area;
    }

    // Enter is only taken over where the wanted behaviour differs from the browser's.
    // Inside a code block, and for Shift+Enter, the native handling is already right —
    // and doing it by hand goes wrong, because a caret placed by script next to a <br>
    // or a bare newline gets normalized back over it before the next character lands.
    // Chrome writes <br> inside a <pre> rather than a newline, so an empty last line
    // is a pair of trailing breaks — not a trailing "\n" as the markup suggests.
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
       Left to the browser, Backspace at the start of a heading merges it into the
       paragraph above and inlines the heading's computed styles as a <span> to keep
       the look — so the document quietly fills with font-size and font-weight spans.
       Deleting the last character of a table's only cell takes the whole table with
       it. Both are surprising enough to be worth owning. */
    const atBlockStart = () => { const b = ancestor('li') || blockEl(); return !!b && offsetIn(b) === 0; };

    function cellCoversAll() {
        const cell = ancestor('td, th'); if (!cell) return null;
        const r = range(); if (!r) return null;
        const all = document.createRange(); all.selectNodeContents(cell);
        const covers = r.collapsed
            ? cell.textContent.length <= 1
            : r.toString().length >= cell.textContent.length;
        return covers ? cell : null;
    }

    function backspaceAtStart(area) {
        const li = ancestor('li');
        if (li) {
            if (li.previousElementSibling) {                      // merge into the item above
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
        const b = blockEl(); if (!b) return;
        const prev = b.previousElementSibling;
        if (!prev) { if (b.tagName !== 'P') retagBlock(b, 'p').focus?.(); caretIn(blockEl() || b, 0); return; }
        if (prev.tagName === 'HR') { prev.remove(); caretIn(b, 0); return; }
        if (/^(UL|OL)$/.test(prev.tagName)) {                     // join onto the last item
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

        const pre = holder.closest('pre');
        if (pre) {
            // An empty last line leaves the code block — the one case the browser
            // cannot do, and without it the block has no keyboard exit.
            while (pre.lastChild && (pre.lastChild.nodeName === 'BR' || !pre.lastChild.textContent.trim())) pre.lastChild.remove();
            if (/\n[^\S\n]*$/.test(pre.textContent)) pre.textContent = pre.textContent.replace(/\n[^\S\n]*$/, '');
            const p = document.createElement('p');
            pre.after(p);
            if (!pre.textContent.length) pre.remove();
            caretIn(p, 0);
            return;
        }

        if (holder.tagName === 'LI' && !holder.textContent.length) return exitList(holder, area);

        // Split BEFORE converting. Conversion strips the marker text, which would
        // leave the caret offset pointing past the end of its own text node.
        const next = splitInto(holder, holder.tagName === 'LI' ? 'li' : 'p');
        if (autoformat) holder = convertLine(holder) || holder;

        if (holder.tagName === 'HR') { caretIn(next, 0); return; }

        // A finished ``` line opens the code block rather than starting a line after it.
        if (holder.tagName === 'PRE') { next.remove(); caretIn(holder, 0); return; }

        // The line became a list item, so the new line continues the list.
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

        // Everything else starts a plain paragraph. A heading or a quote does not
        // continue itself — the next line is body text, which is what a writer means.
        caretIn(next, 0);
    }

    /* ---- History ----
       Wrapping tags and moving list items are plain DOM edits, which never enter the
       browser's own undo stack and can leave it inconsistent. The editor keeps its
       own: an HTML snapshot plus the caret's character offset, coalesced while
       typing so a burst of keystrokes undoes as one step. */
    const HISTORY_CAP = 200;
    const IDLE = 400;

    function record(area) {
        const h = area._history; if (!h || h.restoring) return;
        clearTimeout(h.timer); h.timer = null;
        const html = area.innerHTML;
        if (h.stack[h.at] && h.stack[h.at].html === html) return;
        h.stack.length = h.at + 1;
        h.stack.push({ html, caret: offsetIn(area) });
        if (h.stack.length > HISTORY_CAP) h.stack.shift();
        h.at = h.stack.length - 1;
    }

    const recordSoon = (area) => {
        const h = area._history; if (!h || h.restoring) return;
        clearTimeout(h.timer);
        h.timer = setTimeout(() => record(area), IDLE);
    };

    function step(area, by) {
        const h = area._history; if (!h) return;
        record(area);                                   // land any pending burst first
        const next = h.at + by;
        if (next < 0 || next >= h.stack.length) return;
        h.at = next; h.restoring = true;
        area.innerHTML = h.stack[next].html;
        area.focus();
        caretIn(area, h.stack[next].caret);
        h.restoring = false;
        area.dispatchEvent(new Event('input', { bubbles: true }));
    }

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
       command runs — a <select>, a colour input or a URL field steals focus by
       design. Each area keeps its own last range so any control can put it back. */
    function saveRange(area) {
        const r = range();
        if (r && area.contains(r.startContainer)) area._range = r.cloneRange();
    }

    function restoreRange(area) {
        const r = range();
        if (r && area.contains(r.startContainer)) return;
        area.focus();
        if (!area._range) return;
        const s = sel(); s.removeAllRanges(); s.addRange(area._range);
    }

    // markdown can only carry the tags it has syntax for. Rather than let a command
    // write something the next save would drop, it reports itself unavailable.
    function allows(area, id, ctrl) {
        const spec = COMMANDS[id], cfg = area && area._te;
        if (!spec || !cfg || cfg.mode === 'plain') return false;
        const page = !!(ctrl && ctrl.page && spec.page);
        if (cfg.minimal && spec.block && !page) return false;
        if (cfg.mode !== 'html' && !spec.md && !page) return false;
        if (page) return true;                       // writes to the area, needs no caret
        // A wrap has nothing to wrap without a selection, and a control that is lit
        // but does nothing reads as broken — so say so rather than no-op.
        if (spec.needsSelection && !hasSelection()) return false;
        return !spec.enabled || spec.enabled(area);
    }

    function run(area, id, arg, ctrl) {
        const spec = COMMANDS[id]; if (!spec) return;
        const page = !!(ctrl && ctrl.page && spec.page);
        if (!page) restoreRange(area);          // availability can depend on the caret
        if (!allows(area, id, ctrl)) return;
        if (page) {
            area.style.setProperty(PAGE_VARS[id], id === 'size' ? px(arg) : arg);
            if (!arg) area.style.removeProperty(PAGE_VARS[id]);
            area.dispatchEvent(new CustomEvent('text-edit:page', { bubbles: true, detail: pageStyle(area) }));
            sync();
            return;
        }
        const arming = spec.md !== undefined && INLINE_TAGS[id] && !hasSelection();
        if (arming) { spec.run(arg, area); sync(); return; }   // nothing changed yet
        if (!spec.history) record(area);        // undo/redo drive the stack themselves
        spec.run(arg, area);
        normalizeLists(area);
        if (!spec.history) record(area);
        saveRange(area);
        area.dispatchEvent(new Event('input', { bubbles: true }));
        sync();
    }

    // Reflect caret state onto every control pointing at the area that owns it.
    function sync() {
        controls.forEach(c => {
            const cfg = c._te, area = resolve(c);
            const usable = !!area && allows(area, cfg.id, cfg);
            const spec = COMMANDS[cfg.id];
            const page = !!(cfg.page && spec.page);
            c.toggleAttribute('data-text-edit-active', usable && !page && !!spec.active(cfg.arg(), area));
            c.setAttribute('aria-disabled', String(!usable));
            if (usable && (page || spec.reflect) && 'value' in c && c !== document.activeElement) {
                const v = page ? area.style.getPropertyValue(PAGE_VARS[cfg.id]).trim() : spec.reflect();
                // Never blank a <select> by assigning a value the author didn't offer —
                // computed styles report plenty that no option list would carry.
                const offered = c.tagName !== 'SELECT' || [...c.options].some(o => o.value === v);
                if (v != null && offered && c.value !== v) c.value = v;
            }
            if (c.tagName === 'BUTTON') c.setAttribute('aria-pressed', String(c.hasAttribute('data-text-edit-active')));
        });
    }

    /* ---- Directive ---- */
    function init() {
        if (!window.Alpine || !Alpine.directive) return;
        // Keep the browser from inlining computed styles, and make Enter produce <p>
        // rather than Chrome's default <div> so blocks are addressable by tag.
        try { document.execCommand('styleWithCSS', false, false); } catch { }
        try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { }

        Alpine.directive('text-edit', (el, { expression, modifiers }, { effect, evaluateLater, evaluate, cleanup }) => {
            const id = modifiers.find(m => COMMANDS[m]);
            return id ? control(el, id, modifiers, expression, evaluate, cleanup)
                : area(el, modifiers, expression, { effect, evaluateLater, cleanup });
        });

        // $text — the area this element sits in, or the last focused one.
        Alpine.magic('text', (el) => {
            const own = el.closest('[data-text-edit]');
            const a = own && areas.has(own) ? own : preferred([...areas]);
            return a ? a._te.api : {
                value: '', link: '', selection: null, page: {}, run() { }, active: () => false,
                can: () => false, focus() { }, selectAll() { }, markdown: () => '', html: () => ''
            };
        });

        document.addEventListener('selectionchange', () => {
            const r = range(); if (!r) return;
            const a = [...areas].find(x => x.contains(r.startContainer));
            if (a) { saveRange(a); lastFocused = a; report(a); }
            sync();
        });
    }

    /* ---- Selection reporting ----
       Everything a selection-anchored menu needs, in both the forms an author might
       reach for: an event carrying the geometry, and the same geometry as custom
       properties on the area, so a popover can be placed without any script at all.
       The plugin renders no menu of its own — where and what that is belongs to the
       project, not to us. */
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

    function report(area) {
        const sel = selectionOf(area);
        area._selection = sel;
        const px = (n) => Math.round(n) + 'px';
        if (sel && !sel.collapsed) {
            area.style.setProperty('--text-edit-selection-x', px(sel.x));
            area.style.setProperty('--text-edit-selection-y', px(sel.y));
            area.style.setProperty('--text-edit-selection-width', px(sel.width));
            area.style.setProperty('--text-edit-selection-height', px(sel.height));
            area.style.setProperty('--text-edit-selection-center', px(sel.x + sel.width / 2));
        }
        area.toggleAttribute('data-text-edit-selected', !!sel && !sel.collapsed);
        area.dispatchEvent(new CustomEvent('text-edit:selection', { bubbles: true, detail: sel }));
    }

    function control(el, id, modifiers, expression, evaluate, cleanup) {
        // `.h2` and `.align.center` carry a static argument as the next modifier; an
        // expression is the dynamic form (`x-text-edit.a="url"`).
        const page = modifiers.includes('page');
        const next = modifiers[modifiers.indexOf(id) + 1];
        const literal = next === 'page' ? undefined : next;
        const arg = () => literal !== undefined ? literal : (expression ? evaluate(expression) : undefined);
        el._te = { id, arg, page };
        if (page) el.setAttribute('data-text-edit-page', '');
        el.setAttribute('data-text-edit-control', id);
        if (el.tagName === 'BUTTON' && !el.hasAttribute('type')) el.type = 'button';
        controls.add(el);

        const valued = 'value' in el && el.tagName !== 'BUTTON';
        if (valued) {
            const fire = () => { const a = resolve(el); if (a) run(a, id, el.value, el._te); };
            el.addEventListener('change', fire);
            el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fire(); } });
        } else {
            el.addEventListener('pointerdown', e => e.preventDefault());   // never take the caret
            el.addEventListener('click', e => { e.preventDefault(); const a = resolve(el); if (a) run(a, id, arg(), el._te); });
        }
        setTimeout(sync, 0);
        cleanup(() => { controls.delete(el); });
    }

    function area(el, modifiers, expression, { effect, evaluateLater, cleanup }) {
        const mode = modifiers.includes('html') ? 'html' : modifiers.includes('plain') ? 'plain' : 'markdown';
        const minimal = modifiers.includes('minimal');
        modifiers.filter(m => !MODES.has(m)).forEach(m => console.warn(`[Manifest Text Edit] unknown modifier: .${m}`));

        el.setAttribute('data-text-edit', mode);
        // Tells anything composing with this plugin — x-edit, chiefly — whether the
        // value already has an owner, or whether the surrounding editor should
        // capture the content itself.
        el.toggleAttribute('data-text-edit-bound', !!expression);
        el.setAttribute('contenteditable', 'true');
        el.setAttribute('role', 'textbox');
        el.setAttribute('aria-multiline', 'true');
        if (minimal) el.setAttribute('data-text-edit-minimal', '');

        const read = () => mode === 'plain' ? el.innerText.replace(/\n{3,}/g, '\n\n').trim()
            : mode === 'html' ? sanitize(el.innerHTML, true, true)
                : toMarkdown(el);
        const write = (v) => {
            if (mode === 'plain') el.textContent = v == null ? '' : String(v);
            else el.innerHTML = mode === 'html' ? sanitize(v, true, true) : fromMarkdown(v);
            if (!el.childNodes.length) el.innerHTML = '<p><br></p>';
            normalizeLists(el);
            ensureTrailingBlock(el);
        };

        let last = null, writing = false, commitValue = () => { };
        if (expression) {
            const getValue = evaluateLater(expression);
            const setValue = evaluateLater(`${expression} = __textEditValue`);
            effect(() => getValue(v => {
                const s = v == null ? '' : String(v);
                if (s === last) return;                       // our own write coming back
                last = s; writing = true; write(s); writing = false;
                // The document was replaced from outside — a new page, or a different
                // one loaded. Undo must not reach back into the document before it.
                if (el._history) { el._history.stack = [{ html: el.innerHTML, caret: 0 }]; el._history.at = 0; }
                settle();
            }));
            commitValue = () => { last = read(); setValue(() => { }, { scope: { __textEditValue: last } }); };
            el.addEventListener('input', () => { if (!writing) commitValue(); });
        } else {
            // Uncontrolled: the markup already there IS the initial content. Writing
            // an empty value over it would silently delete what the author wrote.
            // Loose inline content still needs a block to hold the caret.
            if (mode !== 'plain' && el.firstChild && ![...el.children].some(c => BLOCK.includes(c.tagName))) el.innerHTML = `<p>${el.innerHTML}</p>`;
            if (!el.firstChild) el.innerHTML = '<p><br></p>';
        }

        el._history = { stack: [{ html: el.innerHTML, caret: 0 }], at: 0, timer: null, restoring: false };

        // Wiping the document leaves whatever the first block was, so a page that
        // opened with a heading keeps making headings. Reset to a paragraph, and flag
        // emptiness for the placeholder — :empty never matches the <br> a
        // contenteditable keeps, and the tag it sits in is not predictable.
        function settle() {
            if (ensureTrailingBlock(el)) { /* somewhere to land after a trailing block */ }
            if (!el.textContent.trim() && !el.querySelector('img, table, hr')) {
                if (el.children.length !== 1 || el.firstElementChild.tagName !== 'P') el.replaceChildren();
                if (!el.firstChild) { el.innerHTML = '<p><br></p>'; if (document.activeElement === el) caretIn(el.firstElementChild, 0); }
                el.toggleAttribute('data-text-edit-empty', true);
            } else el.toggleAttribute('data-text-edit-empty', false);
        }

        el.addEventListener('focusin', () => { lastFocused = el; sync(); });
        el.addEventListener('input', (e) => {
            if (!writing && e.data && applyPending(el, e.data)) { commitValue(); }
            settle(); sync();
        });
        el.addEventListener('change', e => {
            if (e.target.type !== 'checkbox') return;
            // Clicking sets the property; only the attribute survives serialization.
            e.target.toggleAttribute('checked', e.target.checked);
            record(el);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });

        // A finished line resolves to what its markdown described, unless .literal.
        const autoformat = mode !== 'plain' && !modifiers.includes('literal');
        el.addEventListener('input', () => {
            if (writing) return;
            recordSoon(el);
            if (ancestor('li')) normalizeLists(el);        // Backspace reshapes lists too
        });

        el.addEventListener('keydown', (e) => {
            // Tab indents rather than leaving the field, the way every editor behaves.
            // Escape is the way out, so keyboard users are never trapped.
            if (e.key === 'Enter' && mode !== 'plain') {
                if (!ownsEnter(e)) return;              // let the browser do the ones it does well
                e.preventDefault();
                record(el);
                onEnter(el, autoformat);
                normalizeLists(el);
                record(el);
                commitValue();
                sync();
                return;
            }
            if (e.key === 'Backspace' && mode !== 'plain') {
                const cell = cellCoversAll();
                if (cell) {                                   // clear the cell, keep the table
                    e.preventDefault(); record(el);
                    cell.replaceChildren(document.createElement('br'));
                    caretIn(cell, 0);
                    record(el); commitValue(); sync();
                    return;
                }
                const r = range();
                if (r && r.collapsed && atBlockStart()) {
                    e.preventDefault(); record(el);
                    backspaceAtStart(el);
                    normalizeLists(el);
                    record(el); commitValue(); sync();
                    return;
                }
            }
            if (/^Arrow(Up|Down|Left|Right)$/.test(e.key) && !e.shiftKey && !e.metaKey && !e.ctrlKey && inTable()) {
                if (arrowInTable(e)) { e.preventDefault(); sync(); return; }
                return;
            }
            if (e.key === 'Tab') {
                if (mode === 'plain') return;
                e.preventDefault();
                if (moveCell(e.shiftKey ? -1 : 1)) return;      // tables walk cell to cell
                run(el, e.shiftKey ? 'outdent' : 'indent');
                return;
            }
            // Tab indents, so Escape is the way out. Stop it here so the first press
            // leaves the editor and only a second one closes an enclosing dialog.
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.blur(); return; }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault(); run(el, e.shiftKey ? 'redo' : 'undo'); return;
            }
            if (!(e.metaKey || e.ctrlKey)) return;
            const id = { b: 'strong', i: 'em', u: 'u', k: 'a' }[e.key.toLowerCase()];
            if (!id || !allows(el, id)) return;
            e.preventDefault();
            run(el, id, id === 'a' ? undefined : undefined);
        });

        // Paste as our own subset — never the source app's markup.
        el.addEventListener('paste', (e) => {
            e.preventDefault();
            const dt = e.clipboardData; if (!dt) return;
            const html = dt.getData('text/html');
            // No keepStyle: a paste brings the text and its marks, never the source
            // application's fonts and colours.
            insertHTML(mode === 'plain' ? escHtml(dt.getData('text/plain'))
                : html ? sanitize(html, !minimal)
                    : fromMarkdown(dt.getData('text/plain').replace(/([^\n])\n(?!\n)/g, '$1  \n')));
        });

        const api = {
            get value() { return read(); },
            set value(v) {
                write(v);
                el._history.stack = [{ html: el.innerHTML, caret: 0 }]; el._history.at = 0;
                settle();
                el.dispatchEvent(new Event('input', { bubbles: true }));
            },
            get page() { return pageStyle(el); },
            set page(v) { setPageStyle(el, v); sync(); },
            get selection() { return el._selection || null; },
            get link() { return linkHref(); },
            set link(v) { run(el, 'a', v); },
            focus: () => el.focus(),
            run: (id, arg) => run(el, id, arg),
            active: (id) => allows(el, id) && COMMANDS[id].active(undefined, el),
            can: (id) => allows(el, id),
            selectAll: () => { el.focus(); selectNode(el); sync(); },
            markdown: () => toMarkdown(el),
            html: () => sanitize(el.innerHTML, true, true)
        };
        el._te = { mode, minimal, api };
        areas.add(el);
        settle();

        if (modifiers.includes('autofocus')) setTimeout(() => el.focus(), 0);
        setTimeout(sync, 0);

        cleanup(() => { areas.delete(el); if (lastFocused === el) lastFocused = null; });
    }

    document.addEventListener('alpine:init', init);
    if (window.Alpine && Alpine.directive) init();

    window.ManifestTextEdit = { toMarkdown, fromMarkdown, sanitize, commands: () => Object.keys(COMMANDS) };
})();
