/**
 * @vitest-environment happy-dom
 *
 * x-markdown's file-fetch path and the pre-registration path injected rendered
 * HTML without telling the code plugin to rescan. Fenced blocks survived
 * (x-code is an Alpine directive that initTree picks up), but copy-only inline
 * codespans (`text`{copy}) have no directive — they were never wired, so docs
 * prompt chips didn't copy. The pre-registration path also skipped `{copy}`
 * attribute promotion entirely.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.markdown.js'), 'utf8')

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }

// marked stub: passes inline codespans through the way marked does.
const markedStub = {
    use() {},
    setOptions() {},
    parse: (md) => `<p>${md.replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`,
}

beforeEach(() => {
    document.body.innerHTML = ''
    globalThis.marked = markedStub
    window.ManifestCode = { observeAll: vi.fn() }
})

describe('x-markdown notifies the code plugin after injecting content', () => {
    it('pre-registration path: promotes {copy} and calls observeAll', async () => {
        window.Alpine = {
            directive() {},
            $data: () => ({}),
            initTree() {},
            nextTick: (fn) => fn(),
            magic: () => () => {},
        }
        const converted = vi.fn()
        document.addEventListener('manifest:code-blocks-converted', converted)

        const el = document.createElement('div')
        el.setAttribute('x-markdown', "'Ask `Put my site online`{copy}'")
        document.body.appendChild(el)

        new Function(SRC)()
        await settle()

        expect(el.innerHTML).toContain('Put my site online')
        expect(el.querySelector('code[copy]')).not.toBeNull()
        expect(window.ManifestCode.observeAll).toHaveBeenCalledWith(el)
        expect(converted).toHaveBeenCalled()

        document.removeEventListener('manifest:code-blocks-converted', converted)
    })

    it('directive file-fetch path: fetches, promotes {copy}, and calls observeAll', async () => {
        let handler = null
        window.Alpine = {
            directive: (name, fn) => { if (name === 'markdown') handler = fn },
            $data: () => ({}),
            initTree() {},
            nextTick: (fn) => fn(),
            magic: () => () => {},
        }
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            text: async () => 'Ask `Put my site online`{copy}',
        }))
        const converted = vi.fn()
        document.addEventListener('manifest:code-blocks-converted', converted)

        new Function(SRC)()
        await settle()
        expect(handler).toBeTypeOf('function')

        const el = document.createElement('div')
        document.body.appendChild(el)
        handler(
            el,
            { expression: "'/articles/test.md'", modifiers: [] },
            {
                effect: (fn) => fn(),
                evaluateLater: () => (cb) => cb('/articles/test.md'),
                cleanup: () => {},
            }
        )
        await settle()

        expect(globalThis.fetch).toHaveBeenCalled()
        expect(el.innerHTML).toContain('Put my site online')
        expect(el.querySelector('code[copy]')).not.toBeNull()
        expect(window.ManifestCode.observeAll).toHaveBeenCalledWith(el)
        expect(converted).toHaveBeenCalled()

        document.removeEventListener('manifest:code-blocks-converted', converted)
    })
})
