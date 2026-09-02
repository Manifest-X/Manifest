/**
 * @vitest-environment happy-dom
 *
 * Custody of the selection: who owns it, when it is handed back, and the one
 * shortcut that both makes and unmakes a link.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.text.edit.js'), 'utf8')

beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    new Function(SRC)()
    Alpine.start()
})

function mount(html) {
    const root = document.createElement('div')
    root.setAttribute('x-data', '{}')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    return root
}

// happy-dom raises none of these itself, so each gesture is spelled out.
const focusin = (el) => el.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
const focusout = (el, relatedTarget = null) =>
    el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget }))
const pointerdown = (el) => el.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))

function select(node, start, end) {
    const s = window.getSelection(), r = document.createRange()
    r.setStart(node, start); r.setEnd(node, end === undefined ? start : end)
    s.removeAllRanges(); s.addRange(r)
    document.dispatchEvent(new window.Event('selectionchange'))
}

// Every selection event an area emits, newest last.
function watch(el) {
    const seen = []
    el.addEventListener('text-edit:selection', (e) => seen.push(e.detail))
    return seen
}

const text = (area) => area.querySelector('p').firstChild

beforeEach(() => {
    document.body.replaceChildren()
    document.documentElement.removeAttribute('data-text-edit-selected')
    window.getSelection().removeAllRanges()
})

describe('x-text-edit selection release', () => {
    it('releases when focus leaves for plain page text', () => {
        const root = mount('<div x-text-edit id="a"><p>hello world</p></div><span id="plain">elsewhere</span>')
        const area = root.querySelector('#a')
        focusin(area)
        select(text(area), 0, 5)
        expect(area.hasAttribute('data-text-edit-selected')).toBe(true)
        expect(document.documentElement.hasAttribute('data-text-edit-selected')).toBe(true)

        const seen = watch(area)
        pointerdown(root.querySelector('#plain'))   // plain text takes no focus
        focusout(area, null)

        expect(seen).toEqual([null])
        expect(area.hasAttribute('data-text-edit-selected')).toBe(false)
        expect(document.documentElement.hasAttribute('data-text-edit-selected')).toBe(false)
    })

    it('keeps the selection when a bound control is clicked', () => {
        const root = mount('<div x-text-edit id="a"><p>hello world</p></div><button x-text-edit.strong id="b">B</button>')
        const area = root.querySelector('#a')
        focusin(area)
        select(text(area), 0, 5)

        const seen = watch(area)
        pointerdown(root.querySelector('#b'))
        focusout(area, null)                        // a button never reports itself as relatedTarget
        expect(seen).toEqual([])
        expect(area.hasAttribute('data-text-edit-selected')).toBe(true)

        focusout(area, root.querySelector('#b'))    // nor when it does
        expect(seen).toEqual([])
        expect(area.hasAttribute('data-text-edit-selected')).toBe(true)
    })

    it('releases the area being left for another area', () => {
        const root = mount('<div x-text-edit id="a"><p>hello world</p></div><div x-text-edit id="b"><p>second area</p></div>')
        const [a, b] = [root.querySelector('#a'), root.querySelector('#b')]
        focusin(a)
        select(text(a), 0, 5)

        const seen = watch(a)
        pointerdown(b)
        focusout(a, b)
        focusin(b)
        select(text(b), 0, 6)

        expect(seen).toEqual([null])
        expect(a.hasAttribute('data-text-edit-selected')).toBe(false)
        expect(b.hasAttribute('data-text-edit-selected')).toBe(true)
        expect(document.documentElement.hasAttribute('data-text-edit-selected')).toBe(true)
    })

    it('releases on a selection that moves to another area without a focus change', () => {
        const root = mount('<div x-text-edit id="a"><p>hello world</p></div><div x-text-edit id="b"><p>second area</p></div>')
        const [a, b] = [root.querySelector('#a'), root.querySelector('#b')]
        focusin(a)
        select(text(a), 0, 5)

        const seen = watch(a)
        select(text(b), 0, 6)
        expect(seen).toEqual([null])
        expect(a.hasAttribute('data-text-edit-selected')).toBe(false)
        expect(b.hasAttribute('data-text-edit-selected')).toBe(true)
    })
})

describe('x-text-edit Cmd+K', () => {
    const cmdK = (el) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }))

    it('removes the link at the caret', () => {
        const root = mount('<div x-text-edit id="a"><p>see <a href="https://example.com">site</a> now</p></div>')
        const area = root.querySelector('#a')
        focusin(area)
        const link = area.querySelector('a')
        select(link.firstChild, 2)                  // caret inside the link

        cmdK(area)
        expect(area.querySelector('a')).toBe(null)
        expect(area.textContent).toBe('see site now')
    })

    it('links a selection through the area url control', () => {
        const root = mount('<div x-text-edit id="a"><p>hello world</p></div><input type="url" x-text-edit.a id="u">')
        const area = root.querySelector('#a'), field = root.querySelector('#u')
        focusin(area)
        select(text(area), 0, 5)

        cmdK(area)
        expect(document.activeElement).toBe(field)  // the keyboard lands where the toolbar does

        field.value = 'https://example.com'
        field.dispatchEvent(new window.Event('change'))
        const link = area.querySelector('a')
        expect(link.getAttribute('href')).toBe('https://example.com')
        expect(link.textContent).toBe('hello')
    })

    it('falls back to a prompt when the area has no url control', () => {
        const root = mount('<div x-text-edit id="a"><p>hello world</p></div>')
        const area = root.querySelector('#a')
        const asked = []
        window.prompt = (message) => { asked.push(message); return 'https://example.com' }
        focusin(area)
        select(text(area), 0, 5)

        cmdK(area)
        expect(asked.length).toBe(1)
        expect(area.querySelector('a').getAttribute('href')).toBe('https://example.com')
        delete window.prompt
    })

    it('does nothing with a bare caret and no link', () => {
        const root = mount('<div x-text-edit id="a"><p>hello world</p></div>')
        const area = root.querySelector('#a')
        let asked = 0
        window.prompt = () => { asked++; return 'https://example.com' }
        focusin(area)
        select(text(area), 3)

        cmdK(area)
        expect(asked).toBe(0)
        expect(area.querySelector('a')).toBe(null)
        delete window.prompt
    })
})
