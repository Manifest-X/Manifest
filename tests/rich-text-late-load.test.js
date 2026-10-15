/**
 * @vitest-environment happy-dom
 *
 * Rich Text loaded after Alpine has started (usage found in a component, x-html
 * or markdown): elements Alpine already walked are adopted, exactly once.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.rich.text.js'), 'utf8')
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

let root
beforeAll(async () => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    document.body.innerHTML = `<div x-data="{ doc: 'Hello **there**' }" id="root">
        <div x-rich-text="doc" id="a"></div>
        <button x-rich-text.strong id="b">B</button>
        <div x-rich-text-menu id="m"><button x-rich-text.em>I</button></div>
    </div>`
    Alpine.start()
    root = document.getElementById('root')
    expect(root.querySelector('#a').hasAttribute('data-rich-text')).toBe(false)   // inert before the plugin
    new Function(SRC)()
    await tick(); await tick()
})

describe('late plugin load', () => {
    it('initialises an area Alpine already walked, bound to its value', () => {
        const a = root.querySelector('#a')
        expect(a.getAttribute('data-rich-text')).toBe('markdown')
        expect(a.getAttribute('contenteditable')).toBe('true')
        expect(a.innerHTML).toBe('<p>Hello <strong>there</strong></p>')
    })

    it('initialises controls and the selection menu', () => {
        expect(root.querySelector('#b').getAttribute('data-rich-text-control')).toBe('strong')
        expect(root.querySelector('#m').hasAttribute('data-rich-text-menu')).toBe(true)
    })

    it('initialises each element once (one Enter, one paragraph)', () => {
        const a = root.querySelector('#a')
        const s = window.getSelection(), r = document.createRange()
        r.setStart(a.querySelector('p').firstChild, 5); r.collapse(true)
        s.removeAllRanges(); s.addRange(r)
        a.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
        document.dispatchEvent(new window.Event('selectionchange'))
        a.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        expect(a.querySelectorAll('p').length).toBe(2)
    })
})
