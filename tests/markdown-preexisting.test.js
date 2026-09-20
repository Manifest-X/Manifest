/**
 * @vitest-environment happy-dom
 *
 * x-markdown elements already in the DOM when the plugin registers go through
 * a second updateContent closure (pre-registration path) that once referenced
 * `safe` from the directive closure it isn't inside of — ReferenceError, and
 * the element rendered nothing.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.markdown.js'), 'utf8')

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)) }

describe('x-markdown pre-registration path', () => {
    it('renders a pre-existing element without throwing', async () => {
        globalThis.marked = {
            use() {},
            setOptions() {},
            parse: (md) => `<p>${md}</p>`,
        }
        window.Alpine = {
            directive() {},
            $data: () => ({}),
            initTree() {},
            nextTick: (fn) => fn(),
            magic: () => () => {},
        }

        const el = document.createElement('div')
        el.setAttribute('x-markdown', "'# Hello'")
        document.body.appendChild(el)

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
        new Function(SRC)()
        await settle()

        const failed = errors.mock.calls.filter(args => String(args[0]).includes('Failed to process element'))
        errors.mockRestore()
        expect(failed).toEqual([])
        expect(el.innerHTML).toContain('# Hello')
    })
})
