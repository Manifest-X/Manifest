/**
 * @vitest-environment happy-dom
 *
 * A <pre x-code> inside a frame within an x-code-group is not a group panel:
 * it keeps its own title bar and copy button. Direct panels defer to the group.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.code.js'), 'utf8')

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)) }

beforeEach(() => {
    window.hljs = {
        listLanguages: () => Array.from({ length: 60 }, (_, i) => `l${i}`),
        getLanguage: () => ({}),
        registerLanguage() {},
        highlight: (s) => ({ value: s }),
        highlightElement() {},
    }
    globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} }
})

describe('code group panels vs blocks nested in a frame', () => {
    it('only direct panels lose their header and copy button', async () => {
        document.body.innerHTML = `
            <div x-code-group copy>
                <aside class="frame" name="Preview">
                    Text <pre x-code="plaintext" name="x.html" copy id="nested"><code>a</code></pre>
                </aside>
                <pre x-code="plaintext" name="Code" copy id="panel"><code>b</code></pre>
            </div>`

        new Function(SRC)()
        await settle()

        const group = document.querySelector('pre[x-code-group]')
        const nested = document.getElementById('nested')
        const panel = document.getElementById('panel')

        expect(group).not.toBeNull()
        expect(nested.querySelector(':scope > header')?.textContent).toBe('x.html')
        expect(nested.querySelector(':scope > button.copy')).not.toBeNull()
        expect(panel.querySelector(':scope > header')).toBeNull()
        expect(panel.querySelector(':scope > button.copy')).toBeNull()
        expect(group.querySelectorAll(':scope > button.copy').length).toBe(1)
    })
})
