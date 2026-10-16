/**
 * @vitest-environment happy-dom
 *
 * Edit loaded on demand (Manifest.loadPlugin('edit') after the page is up): $edit is an
 * idle stand-in until then, the regions Alpine's first walk passed are adopted, and the
 * dev server's base is only read when the page says it is served by mnfst-run --edit.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOADER = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

describe('Edit loaded after Alpine started', () => {
    it('adopts existing regions; $edit is idle until then and its bindings follow the real store after', async () => {
        const fetch = vi.fn(async () => new Response('', { status: 404 }))
        vi.stubGlobal('fetch', fetch)
        if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
        const errors = []
        window.addEventListener('error', (e) => errors.push(e.message))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        new Function(LOADER)()
        window.Alpine = Alpine; globalThis.Alpine = Alpine
        document.body.innerHTML = `<div x-data x-init="$edit.onPublish = (patches = []) => ({ results: [], early: patches.length })"><p id="s" x-text="'active=' + $edit.active + ' can=' + $edit.can('text')"></p><section x-edit="inside"><h2>In</h2></section></div>
            <section x-edit="open"><h2>Always</h2></section><section x-edit.gated="adopt"><h2>Gated</h2></section>`
        Alpine.start()
        await tick()
        expect(document.querySelector('#s').textContent).toBe('active=false can=false')
        expect(!!window.__manifestEditStub).toBe(true)
        new Function(EDIT_SRC)()
        await tick(600)
        const said = warn.mock.calls.map(c => String(c[0])).join('\n')
        warn.mockRestore()
        expect(errors).toEqual([])
        expect(said).not.toMatch(/edit is not defined/)
        expect([...document.querySelectorAll('section')].map(s => s.hasAttribute('data-edit-area'))).toEqual([true, true, true])
        expect([...document.querySelectorAll('h2')].map(h => h.getAttribute('contenteditable'))).toEqual(['true', 'true', null])
        expect(typeof Alpine.store('edit').onPublish).toBe('function')                 // written on the stand-in, kept
        expect(await Alpine.store('edit').publish()).toMatchObject({ early: 0 })
        Alpine.store('edit').on()
        await tick(50)
        expect(document.querySelector('[x-edit\\.gated] h2').getAttribute('contenteditable')).toBe('true')
        expect(document.querySelector('#s').textContent).toMatch(/^active=true/)
        expect(fetch.mock.calls.filter(c => String(c[0]).includes('/__edit/base'))).toEqual([])   // not served by mnfst-run --edit
        vi.unstubAllGlobals()
    })
})
