/**
 * @vitest-environment happy-dom
 *
 * Compound actions answer can() as their parts do (a cut is a copy and a remove), and
 * $edit.scope(el) reads an element's component scope.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'

const flush = () => new Promise(r => setTimeout(r, 0))
const store = () => Alpine.store('edit')
async function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    await flush(); await flush()
    return root
}
beforeAll(async () => {
    new Function(EDIT_SRC)()
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))
})

describe('compound actions', () => {
    it('cut needs both copy and remove: a delete-locked piece cannot be cut', async () => {
        const root = await mount(`<ul x-edit="cu"><li x-edit.lock.remove>Kept</li><li>Free</li></ul>`)
        const [kept, free] = root.querySelectorAll('li')
        expect(store().can('copy', kept)).toBe(true)
        expect(store().can('remove', kept)).toBe(false)
        expect(store().can('cut', kept)).toBe(false)
        expect(store().cut(kept)).toBe(false)
        expect(store().can('cut', free)).toBe(true)
        store().lock(free, 'remove')
        expect(store().can('cut', free)).toBe(false)
    })
})

describe('$edit.scope', () => {
    it('scope(el) reads an element\'s scope; scope(value, el) sets it', async () => {
        const root = await mount(`<div x-edit="sc"><div class="card" data-component="card-1"><p>Card</p></div></div>`)
        const p = root.querySelector('p')
        expect(store().scope(p)).toBe('instance')
        expect(store().scope('main', p)).toBe(true)
        expect(store().scope(p)).toBe('main')
        expect(store().scope(undefined, p)).toBe('main')
        expect(store().scope(root)).toBe(null)                  // not in a component area
    })
})
