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
        expect(inserted.at(-1)).toBe('<p>under hi H2O <strong>bold</strong> <a href="/x">l</a></p>')
        focusin(il); select(il.firstChild, 1)
        paste(il, '<u>u</u><em>e</em><span style="color:red">s</span>')
        expect(il.innerHTML).toBe('xu<em>e</em>s')
    })
})
