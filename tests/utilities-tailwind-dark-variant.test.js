/**
 * @vitest-environment node
 *
 * Under data-tailwind, Tailwind's dark: follows the .dark class $color sets,
 * not prefers-color-scheme. Covers the live injected variant (real bundled
 * Tailwind engine in happy-dom) and the node bake.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import { compileUtilities } from '../lib/manifest.utilities.node.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UTILITIES = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')
const TAILWIND = readFileSync(join(__dirname, '../lib/manifest.tailwind.js'), 'utf8')
const CLASS_DARK = '&:where(.dark, .dark *)'

async function livePage(authorCss) {
    const { Window } = await import('happy-dom')
    const win = new Window()
    const doc = win.document
    win.tailwind = {}
    win.ManifestComponentsRegistry = { manifest: {} }
    if (authorCss) {
        const s = doc.createElement('style')
        s.setAttribute('type', 'text/tailwindcss')
        s.textContent = authorCss
        doc.head.appendChild(s)
    }
    const el = doc.createElement('div')
    el.setAttribute('class', 'dark:bg-black')
    doc.body.appendChild(el)
    win.eval(UTILITIES)
    const injected = doc.getElementById('manifest-tailwind-variants')?.textContent || ''
    delete win.tailwind
    win.eval(TAILWIND)
    let css = ''
    for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 25))
        const style = Array.from(doc.head.querySelectorAll('style')).find((s) => !s.getAttribute('type') && s.textContent.includes('dark\\:bg-black'))
        if (style) { css = style.textContent; break }
    }
    await win.happyDOM.close()
    return { injected, css }
}

describe('Tailwind dark: variant under data-tailwind', () => {
    it('injects a class-based dark variant the Tailwind engine uses', async () => {
        const { injected, css } = await livePage()
        expect(injected).toContain('@custom-variant dark (&:where(.dark, .dark *));')
        expect(css).toContain(CLASS_DARK)
        expect(css).not.toContain('prefers-color-scheme')
    })

    it('leaves an author-declared dark variant in charge', async () => {
        const { injected, css } = await livePage('@custom-variant dark (&:where([data-mode=dark], [data-mode=dark] *));')
        expect(injected).not.toContain('@custom-variant dark')
        expect(css).toContain('[data-mode=dark]')
        expect(css).not.toContain(CLASS_DARK)
    })

    it('bakes dark: against the .dark class', async () => {
        const css = await compileUtilities({ classes: ['dark:bg-black'] })
        expect(css).toContain(CLASS_DARK)
        expect(css).not.toContain('prefers-color-scheme')
    })
})
