/**
 * @vitest-environment happy-dom
 *
 * $rich read before Rich Text has loaded (it loads on use; SPA routes and component
 * HTML can need it after boot): the loader's stand-in keeps expressions from
 * throwing, and effects that read $rich run again once the plugin arrives.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { RICH_SRC } from './helpers/edit-setup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOADER = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

describe('$rich before Rich Text loads', () => {
    it('never throws, and effects that read it apply once the plugin arrives', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
        if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
        const errors = []
        window.addEventListener('error', (e) => errors.push(e.message))
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        new Function(LOADER)()
        window.Alpine = Alpine; globalThis.Alpine = Alpine
        document.body.innerHTML = `<div x-data="{ look: { align: 'center' } }"><div id="f" x-rich-text.html><p>Text</p></div><span id="v" x-text="$rich.can('strong') ? 'yes' : 'no'"></span><i x-effect="$rich.all = look"></i></div>`
        Alpine.start()
        await tick()
        const said = warn.mock.calls.map(c => String(c[0])).join('\n')
        warn.mockRestore()
        expect(errors).toEqual([])
        expect(said).not.toMatch(/rich is not defined/)
        expect(document.querySelector('#v').textContent).toBe('no')
        expect(!!window.__manifestRichStub).toBe(true)
        new Function(RICH_SRC)()
        await tick(); await tick()
        expect(document.querySelector('#f').getAttribute('data-rich-text')).toBe('html')
        expect(window.__manifestRichStub.v).toBe(1)
        expect(document.querySelector('#f').getAttribute('style')).toContain('--rich-text-align: center')
    })
})
