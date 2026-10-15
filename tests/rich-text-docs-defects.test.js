/**
 * @vitest-environment happy-dom
 *
 * Defects found exercising the docs demos: history that sticks after a settle,
 * controls that lose their selection or re-evaluate their argument, typed marks,
 * pending marks, markdown paste, lists and quotes, empty values.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import Alpine from 'alpinejs'
import { RICH_SRC } from './helpers/edit-setup.js'

beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    new Function(RICH_SRC)()
    Alpine.start()
})

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))
function mount(html, data = '{}') {
    const root = document.createElement('div')
    root.setAttribute('x-data', data)
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    return root
}
const focusin = (el) => el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
function select(node, start, end) {
    const s = window.getSelection(), r = document.createRange()
    r.setStart(node, start); r.setEnd(node, end === undefined ? start : end)
    s.removeAllRanges(); s.addRange(r)
    document.dispatchEvent(new Event('selectionchange'))
}
const key = (el, init) => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e }
const api = (el) => el._rt.api

beforeEach(() => { document.body.replaceChildren(); window.getSelection().removeAllRanges(); document.execCommand = vi.fn(() => true) })
afterEach(() => { vi.restoreAllMocks() })

describe('history never sticks on a settle', () => {
    it('a command that leaves a block last undoes all the way back', () => {
        const root = mount(`<div x-rich-text.html id="a"><p>Hello</p><p>Text</p></div>`)
        const el = root.querySelector('#a'), start = el.innerHTML
        focusin(el); select(el.lastElementChild.firstChild, 0, 4)
        api(el).blockquote()
        expect(el.querySelector('blockquote')).toBeTruthy()
        expect(el.lastElementChild.tagName).toBe('P')                     // the trailing block is part of the step
        for (let i = 0; i < 3; i++) key(el, { key: 'z', metaKey: true })
        expect(el.innerHTML).toBe(start)
        key(el, { key: 'z', metaKey: true, shiftKey: true })
        expect(el.querySelector('blockquote')).toBeTruthy()
    })
})

describe('controls judge and act on the field they serve', () => {
    const away = (el) => { el.focus(); const s = window.getSelection(); s.removeAllRanges(); const r = document.createRange(); r.setStart(document.body, 0); s.addRange(r); document.dispatchEvent(new Event('selectionchange')) }

    it('<input x-rich-text.a> is usable while it has focus and applies the link to the saved selection', async () => {
        const root = mount(`<input id="link" type="url" x-rich-text.a><div x-rich-text.html id="f"><p>Hello world here</p></div>`)
        const el = root.querySelector('#f'), input = root.querySelector('#link')
        focusin(el); select(el.querySelector('p').firstChild, 6, 11)
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); away(input)
        await tick()
        expect(input.getAttribute('aria-disabled')).toBe('false')
        input.value = 'https://x.com'
        input.dispatchEvent(new Event('change'))
        expect(el.innerHTML).toBe('<p>Hello <a href="https://x.com">world</a> here</p>')
    })

    it('a control\'s expression is evaluated only when it runs', async () => {
        window.__evals = 0
        const root = mount(`<button id="p" x-rich-text.a="(window.__evals++, 'https://p.example')">P</button><div x-rich-text.html id="f"><p>Hello world</p></div>`)
        const el = root.querySelector('#f'), b = root.querySelector('#p')
        focusin(el)
        for (let i = 0; i < 4; i++) { select(el.querySelector('p').firstChild, i, i + 3); await tick() }
        expect(window.__evals).toBe(0)
        select(el.querySelector('p').firstChild, 6, 11)
        b.click()
        expect(window.__evals).toBe(1)
        expect(el.querySelector('a').getAttribute('href')).toBe('https://p.example')
    })

    it('after a blur, a control acts on the saved selection, not on the caret focus puts back', () => {
        const root = mount(`<button id="b" x-rich-text.strong>B</button><div x-rich-text.html id="f"><p>Hello world</p></div>`)
        const el = root.querySelector('#f'), b = root.querySelector('#b'), t = el.querySelector('p').firstChild
        focusin(el); select(t, 0, 5)
        window.getSelection().removeAllRanges(); document.dispatchEvent(new Event('selectionchange'))
        // focusing the field places a caret at its start, as browsers do
        el.addEventListener('focus', () => { const s = window.getSelection(), r = document.createRange(); r.setStart(t, 0); s.removeAllRanges(); s.addRange(r); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
        b.click()
        expect(el.innerHTML).toBe('<p><strong>Hello</strong> world</p>')
    })

    it('undo and redo controls are disabled while focus is in another input', async () => {
        const root = mount(`<input id="o" type="text"><button id="u" x-rich-text.undo>U</button><div x-rich-text.html id="f"><p>One</p></div>`)
        const el = root.querySelector('#f'), u = root.querySelector('#u'), p = el.querySelector('p')
        focusin(el); p.firstChild.nodeValue = 'Onex'; window.getSelection().collapse(p.firstChild, 4)
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }))
        await tick(450)
        expect(u.getAttribute('aria-disabled')).toBe('false')
        root.querySelector('#o').focus()
        document.dispatchEvent(new Event('selectionchange'))
        await tick()
        expect(u.getAttribute('aria-disabled')).toBe('true')
    })
})

describe('typed and pending marks', () => {
    const typeAtCaret = (el, ch, data) => {
        const r = window.getSelection().getRangeAt(0), t = r.startContainer
        t.insertData(r.startOffset, ch)
        window.getSelection().collapse(t, r.startOffset + ch.length)
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: data ?? ch }))
    }
    it('a space typed after a converted mark lands outside it, stored as U+00A0 or not', () => {
        const root = mount(`<div x-rich-text id="m"></div>`)
        const el = root.querySelector('#m')
        focusin(el)
        el.firstElementChild.textContent = 'A **bold*'
        window.getSelection().collapse(el.firstElementChild.firstChild, 9)
        typeAtCaret(el, '*')
        expect(el.innerHTML).toBe('<p>A <strong>bold</strong></p>')
        window.getSelection().collapse(el.querySelector('strong').firstChild, 4)   // where Chrome keeps the caret
        typeAtCaret(el, '\u00a0', ' ')
        expect(el.innerHTML).toBe('<p>A <strong>bold</strong>&nbsp;</p>')
        typeAtCaret(el, 'then')
        expect(el._rt.api.value.replace(/\u00a0/g, ' ')).toBe('A **bold** then')
    })

    it('a space typed after a converted code mark lands outside it too', () => {
        const root = mount(`<div x-rich-text id="m"></div>`)
        const el = root.querySelector('#m')
        focusin(el)
        el.firstElementChild.textContent = 'Use `code'
        window.getSelection().collapse(el.firstElementChild.firstChild, 9)
        typeAtCaret(el, '`')
        expect(el.innerHTML).toBe('<p>Use <code>code</code></p>')
        window.getSelection().collapse(el.querySelector('code').firstChild, 4)
        typeAtCaret(el, '\u00a0', ' ')
        typeAtCaret(el, 'then more')
        expect(el.innerHTML).toBe('<p>Use <code>code</code>&nbsp;then more</p>')
        expect(el._rt.api.value.replace(/\u00a0/g, ' ')).toBe('Use `code` then more')
    })

    // Chrome's sequence: beforeinput insertText; if not prevented, a typed U+0020 at a mark's edge
    // goes into the mark's text, and a lone plain space after an inline collapses on the next key,
    // the character landing in the mark
    const chromeType = (el, ch) => {
        const bi = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch })
        el.dispatchEvent(bi)
        if (bi.defaultPrevented) return
        const r = window.getSelection().getRangeAt(0)
        let t = r.startContainer, o = r.startOffset
        const lastText = (n) => { let l = null; const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); for (let x = w.nextNode(); x; x = w.nextNode()) l = x; return l }
        const before = t.nodeType === 3 ? (o === 0 ? t.previousSibling : null) : t.childNodes[o - 1]
        if (before && before.nodeType === 1 && lastText(before)) { if (t.nodeType === 3 && !t.length) t.remove(); t = lastText(before); o = t.length }
        else if (t.nodeType === 3 && t.nodeValue === ' ' && o === 1 && t.previousSibling && t.previousSibling.nodeType === 1 && ch !== ' ') { const m = lastText(t.previousSibling); t.remove(); t = m; o = m.length }
        t.insertData(o, ch)
        window.getSelection().collapse(t, o + ch.length)
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }))
    }
    it('typing a space and text after any converted mark, as Chrome sends the keys, lands outside the mark', () => {
        const cases = [['Use `code', '`', 'code'], ['A **bold*', '*', 'strong'], ['An *em', '*', 'em'], ['A ~~del~', '~', 'del'], ['See [l](https://x.dev', ')', 'a']]
        for (const [typed, closer, tag] of cases) {
            document.body.innerHTML = ''
            const root = mount(`<div x-rich-text id="m"></div>`)
            const el = root.querySelector('#m')
            focusin(el)
            el.firstElementChild.textContent = typed
            window.getSelection().collapse(el.firstElementChild.firstChild, typed.length)
            chromeType(el, closer)
            const mark = el.querySelector(tag)
            expect(mark, typed).toBeTruthy()
            for (const ch of ' then more') chromeType(el, ch)
            expect(mark.textContent, typed).toBe({ code: 'code', strong: 'bold', em: 'em', del: 'del', a: 'l' }[tag])
            expect(el.querySelector('p').lastChild.nodeValue, typed).toBe('\u00a0then more')
            expect(el._rt.api.value.replace(/\u00a0/g, ' '), typed).toBe(typed + closer + ' then more')
        }
    })

    it('an armed mark wraps what is typed, a leading space included', () => {
        const root = mount(`<div x-rich-text.html id="h"><p>Hello world</p></div>`)
        const el = root.querySelector('#h'), t = el.querySelector('p').firstChild
        focusin(el); select(t, 11)
        key(el, { key: 'b', metaKey: true })
        typeAtCaret(el, '\u00a0', ' ')
        expect(el.innerHTML).toBe('<p>Hello world<strong>&nbsp;</strong></p>')
        typeAtCaret(el, 'big')
        expect(el.innerHTML).toBe('<p>Hello world<strong>&nbsp;big</strong></p>')
    })

    it('arming bold inside bold ends it: the text goes after, other formatting carries on', () => {
        const root = mount(`<div x-rich-text.html id="b"><p>Hi <strong>bo<em>ld</em></strong></p></div>`)
        const el = root.querySelector('#b'), t = el.querySelector('em').firstChild
        focusin(el); select(t, 2)
        key(el, { key: 'b', metaKey: true })
        typeAtCaret(el, 'x')
        expect(el.innerHTML).toBe('<p>Hi <strong>bo<em>ld</em></strong><em>x</em></p>')
    })
})

describe('markdown paste', () => {
    it('keeps only what markdown can store: html-only marks are unwrapped', () => {
        let inserted = []
        document.execCommand = vi.fn((cmd, _ui, v) => { if (cmd === 'insertHTML') inserted.push(v); return true })
        const root = mount(`<div x-rich-text id="m"><p>One</p></div><div x-rich-text.inline id="i">x</div>`)
        const el = root.querySelector('#m'), il = root.querySelector('#i')
        const paste = (target, html) => { const ev = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'clipboardData', { value: { getData: (t) => t === 'text/html' ? html : 'x' } }); target.dispatchEvent(ev) }
        focusin(el); select(el.querySelector('p').firstChild, 3)
        paste(el, '<p><u>under</u> <mark>hi</mark> H<sub>2</sub>O <strong>bold</strong> <a href="/x">l</a></p>')
        expect(el.innerHTML).toBe('<p>Oneunder hi H2O <strong>bold</strong> <a href="/x">l</a></p>')
        paste(el, '<h2>Head</h2><p><u>u</u></p>')
        expect(inserted.at(-1)).toBe('<h2>Head</h2><p>u</p>')
        focusin(il); select(il.firstChild, 1)
        paste(il, '<u>u</u><em>e</em><span style="color:red">s</span>')
        expect(il.innerHTML).toBe('xu<em>e</em>s')
    })
})

describe('small things', () => {
    it('a page with no x-data still gets its fields (body gains an empty scope)', () => {
        expect(document.body.getAttribute('x-data')).toBe('{}')
    })

    it('Tab then Shift+Tab: the caret stays in the item, so they chain', () => {
        const root = mount(`<div x-rich-text.html id="l"><ul><li>One</li><li>Two</li></ul></div>`)
        const el = root.querySelector('#l'), two = el.querySelectorAll('li')[1]
        focusin(el); select(two.firstChild, 2)
        key(el, { key: 'Tab' })
        expect(el.querySelector('li li')).toBe(two)
        const r = window.getSelection().getRangeAt(0)
        expect(two.contains(r.startContainer)).toBe(true)
        key(el, { key: 'Tab', shiftKey: true })
        expect(el.querySelector('li li')).toBe(null)
        expect(el.querySelectorAll('ul > li').length).toBe(2)
    })

    it('Enter on an empty last paragraph of a quote leaves it', () => {
        const root = mount(`<div x-rich-text id="q"></div>`, '{}')
        const el = root.querySelector('#q')
        el._rt.api.value = '> quoted'
        expect(el.querySelector('blockquote > p')).toBeTruthy()
        focusin(el); const p = el.querySelector('blockquote p'); select(p.firstChild, 6)
        key(el, { key: 'Enter' })
        expect(el.querySelectorAll('blockquote p').length).toBe(2)
        key(el, { key: 'Enter' })
        expect(el.querySelectorAll('blockquote p').length).toBe(1)
        expect(el.querySelector('blockquote').nextElementSibling.tagName).toBe('P')
        expect(el._rt.api.value).toBe('> quoted')
    })

    it('an empty font (or colour, size) removes it instead of wrapping a bare span', () => {
        const root = mount(`<div x-rich-text.html id="f"><p><span style="font-family: serif">Hello</span> world</p></div>`)
        const el = root.querySelector('#f')
        focusin(el); select(el.querySelector('span').firstChild, 0, 5)
        el._rt.api.font('')
        expect(el.innerHTML).toBe('<p>Hello world</p>')
        select(el.querySelector('p').firstChild, 0, 5)
        el._rt.api.color('')
        expect(el.querySelector('span')).toBe(null)
    })
})

describe('paste into a block', () => {
    const paste = (target, html, text = '') => { const ev = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'clipboardData', { value: { getData: (t) => t === 'text/html' ? html : text } }); target.dispatchEvent(ev) }
    it('inline content lands inside the caret\'s paragraph, in a quote too, leading space and formatting kept', () => {
        const root = mount(`<div x-rich-text id="md"><blockquote><p>Quote line</p></blockquote><p>After</p></div>`)
        const el = root.querySelector('#md'), q = el.querySelector('blockquote p')
        focusin(el); select(q.firstChild, 10)
        const clip = ' <u>under</u> <mark>mk</mark> <sub>s</sub> <strong>st</strong> <span style="color:red">sp</span>'
        paste(el, clip)
        expect(el.querySelector('blockquote').innerHTML).toBe('<p>Quote line under mk s <strong>st</strong> sp</p>')
        const after = el.querySelectorAll(':scope > p')[0]
        select(after.firstChild, 5)
        paste(el, clip)
        expect(after.innerHTML).toBe('After under mk s <strong>st</strong> sp')
        expect(el._rt.api.value).toBe('> Quote line under mk s **st** sp\n\nAfter under mk s **st** sp')
    })

    it('loose inline runs inside a quote serialise as one paragraph, formatting kept', () => {
        const d = document.createElement('div')
        d.innerHTML = '<blockquote><p>Quote line</p> under mk s <strong>st</strong> sp</blockquote>'
        expect(window.ManifestRichText.toMarkdown(d)).toBe('> Quote line\n>\n> under mk s **st** sp')
    })
})

describe('paste over a selection across blocks', () => {
    const paste = (target, html) => { const ev = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'clipboardData', { value: { getData: (t) => t === 'text/html' ? html : '' } }); target.dispatchEvent(ev) }
    const doc = '<h2>Heading</h2><p>First para here</p><p>Second para here</p><ul><li>Item one</li><li>Item two</li></ul><table><tbody><tr><td>Cell A</td><td>Cell B</td></tr></tbody></table><p>Last</p>'
    const field = () => { const root = mount(`<div x-rich-text.html id="h">${doc}</div>`); const el = root.querySelector('#h'); focusin(el); return el }
    const span = (sc, so, ec, eo) => { const r = document.createRange(); r.setStart(sc, so); r.setEnd(ec, eo); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')) }
    const NEW = '<strong>NEW</strong> text'

    it('a triple-clicked paragraph (ending at the next one\'s start) is replaced in place', () => {
        const el = field(), [p1, p2] = el.querySelectorAll('p')
        span(p1.firstChild, 0, p2, 0)
        paste(el, NEW)
        expect(el.innerHTML).toBe(doc.replace('<p>First para here</p>', '<p><strong>NEW</strong> text</p>'))
    })

    it('everything selected leaves one paragraph of the paste', () => {
        const el = field()
        span(el, 0, el, el.childNodes.length)
        paste(el, NEW)
        expect(el.innerHTML).toBe('<p><strong>NEW</strong> text</p>')
    })

    it('from the middle of one paragraph into the next: they merge around the paste', () => {
        const el = field(), [p1, p2] = el.querySelectorAll('p')
        span(p1.firstChild, 6, p2.firstChild, 7)
        paste(el, NEW)
        expect(el.querySelectorAll('p')[0].outerHTML).toBe('<p>First <strong>NEW</strong> textpara here</p>')
        expect(el.innerHTML).not.toContain('Second')
    })

    it('from a list item into a table cell: the cell stays, the paste goes in the item', () => {
        const el = field(), li = el.querySelectorAll('li')[1], td = el.querySelector('td')
        span(li.firstChild, 2, td.firstChild, 3)
        paste(el, NEW)
        expect(li.innerHTML).toBe('It<strong>NEW</strong> text')
        expect(td.innerHTML).toBe('l A')
        expect([...el.children].map(c => c.tagName)).toEqual(['H2', 'P', 'P', 'UL', 'TABLE', 'P'])
    })

    it('the caret ends inside the last pasted text, and an empty field loses its placeholder and leading space', () => {
        const root = mount(`<div x-rich-text.html id="e"></div>`)
        const el = root.querySelector('#e')
        expect(el.innerHTML).toBe('<p><br></p>')
        focusin(el); select(el.querySelector('p'), 0)
        paste(el, ' <u>u</u> <em>em</em>')
        expect(el.innerHTML).toBe('<p><u>u</u> <em>em</em></p>')
        const r = window.getSelection().getRangeAt(0)
        expect(r.startContainer.nodeType).toBe(3)
        expect(r.startContainer.nodeValue).toBe('em')
        expect(r.startOffset).toBe(2)
    })

    it('loose inline content at a block field\'s root is wrapped in a paragraph on settle', () => {
        const root = mount(`<div x-rich-text.html id="l"><p>One</p></div>`)
        const el = root.querySelector('#l')
        el.append(' loose ', Object.assign(document.createElement('strong'), { textContent: 'bold' }))
        el.dispatchEvent(new InputEvent('input', { bubbles: true }))
        expect(el.innerHTML).toBe('<p>One</p><p> loose <strong>bold</strong></p>')
    })
})

describe('authored empty blocks', () => {
    it('spacers and an empty figure survive load and unrelated edits, bound or not', async () => {
        const root = mount(`<div x-rich-text.html id="a"><p>One</p><p></p><p>Two</p><figure></figure><p>Three</p></div><div x-rich-text.html="doc" id="d"></div>`, `{ doc: '<p>A</p><p></p><p>B</p>' }`)
        await tick()
        const a = root.querySelector('#a'), d = root.querySelector('#d')
        expect(a.innerHTML).toBe('<p>One</p><p></p><p>Two</p><figure></figure><p>Three</p>')
        expect(d.innerHTML).toBe('<p>A</p><p></p><p>B</p>')
        focusin(d); const t = d.querySelector('p').firstChild; t.nodeValue = 'Ax'; select(t, 2)
        d.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }))
        await tick()
        expect(d.innerHTML).toBe('<p>Ax</p><p></p><p>B</p>')
        expect(Alpine.$data(root).doc).toBe('<p>Ax</p><p></p><p>B</p>')
        focusin(a); const u = a.querySelector('p').firstChild; u.nodeValue = 'One!'; select(u, 4)
        a.dispatchEvent(new InputEvent('input', { bubbles: true, data: '!' }))
        expect(a.innerHTML).toBe('<p>One!</p><p></p><p>Two</p><figure></figure><p>Three</p>')
    })
})
