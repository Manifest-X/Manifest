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
