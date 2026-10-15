/**
 * @vitest-environment happy-dom
 *
 * Edit loaded without Rich Text (the one test that does): one warning, and text
 * leaves fall back to plain contenteditable that still logs and sanitizes.
 */
import { describe, it, expect, vi } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_ONLY_SRC } from './helpers/edit-setup.js'

describe('Edit without Rich Text', () => {
    it('warns once and edits text as plain contenteditable', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        new Function(EDIT_ONLY_SRC)()
        window.Alpine = Alpine; globalThis.Alpine = Alpine
        Alpine.start()
        await new Promise(r => setTimeout(r, 500))
        const root = document.createElement('div')
        root.innerHTML = `<section x-edit="fb"><h1>Title</h1><p>Body</p></section><section x-edit="fb2"><p>More</p></section>`
        Alpine.mutateDom(() => document.body.appendChild(root))
        Alpine.initTree(root)
        await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0))
        const said = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('Rich Text is not loaded'))
        warn.mockRestore()
        expect(window.ManifestRichText).toBe(undefined)
        expect(said.length).toBe(1)
        const h1 = root.querySelector('h1')
        expect(h1.getAttribute('contenteditable')).toBe('true')
        expect(h1.hasAttribute('data-rich-text')).toBe(false)
        expect(h1.hasAttribute('data-edit-text')).toBe(false)
        h1.dispatchEvent(new Event('focus'))
        h1.innerHTML = 'New <b onclick="x()">title</b><script>bad()</script>'
        h1.dispatchEvent(new Event('blur'))
        const { log, cursor } = Alpine.store('edit').export()
        expect(log[cursor - 1]).toMatchObject({ kind: 'st-node', prop: 'text', value: 'New <b>title</b>bad()' })
    })
})
