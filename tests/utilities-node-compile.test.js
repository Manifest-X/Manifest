/**
 * @vitest-environment node
 *
 * DOM-free utilities compiler (src/scripts/utilities/manifest.utilities.node.mjs,
 * built to lib/manifest.utilities.node.mjs). Runs under the plain node
 * environment (no jsdom/happy-dom) so a stray `document`/`window` read in the
 * generation path fails loudly instead of being masked by a DOM polyfill.
 * Browser-vs-node parity lives in utilities-node-compile.browser.test.js,
 * which needs happy-dom to load the live browser bundle.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { describe, it, expect } from 'vitest'
import { compileUtilities, scanClasses } from '../lib/manifest.utilities.node.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const THEME_CSS = ':root { --color-brand: #ff0000; --spacing-4: 1rem; --spacing-8: 2rem; }'
const CLASSES = ['text-brand', 'hover:bg-brand', 'p-4', 'md:flex', 'w-[37px]']

describe('compileUtilities', () => {
    it('includes theme-variable utilities and their variants', async () => {
        const css = await compileUtilities({ classes: CLASSES, themeCss: THEME_CSS })
        expect(css).toContain('.text-brand { color: var(--color-brand) }')
        expect(css).toContain('.hover\\:bg-brand:hover { background-color: var(--color-brand) }')
        expect(css).toContain('.p-4 { padding: var(--spacing-4) }')
    })

    it('also bakes plain Tailwind tokens (arbitrary value, variant) via the real Tailwind engine', async () => {
        const css = await compileUtilities({ classes: CLASSES, themeCss: THEME_CSS })
        expect(css).toContain('.w-\\[37px\\]')
        expect(css).toContain('.md\\:flex')
    })

    it('bakes every class in a representative Tailwind + theme-var set (RFC §15 example)', async () => {
        const classes = ['gap-2', 'rounded-full', 'items-center', 'max-w-3xl', 'w-[37px]', 'md:flex', 'hover:bg-brand', 'p-4']
        const css = await compileUtilities({ classes, themeCss: ':root{--spacing-4:1rem;--color-brand:#f00;}' })
        const escaped = classes.map(c => '.' + c.replace(/[.:\/\[\]]/g, m => '\\' + m))
        for (const sel of escaped) expect(css).toContain(sel)
    })

    it('is deterministic for the same inputs', async () => {
        const a = await compileUtilities({ classes: CLASSES, themeCss: THEME_CSS })
        const b = await compileUtilities({ classes: [...CLASSES].reverse(), themeCss: THEME_CSS })
        // Same set, different input order — output is derived from the shared
        // generation methods scanning theme vars, not class-array order.
        expect(a).toBe(b)
    })

    it('returns empty string for no classes at all', async () => {
        expect(await compileUtilities({})).toBe('')
        expect(await compileUtilities({ classes: [] })).toBe('')
    })

    it('bakes flex/block via the Tailwind pass even with no Manifest theme vars', async () => {
        // flex/block aren't theme-variable-driven (no generator emits a bare
        // `display` utility from a var) — Manifest ships its own static
        // .row/.col equivalents instead — but they're real Tailwind
        // utilities, so the Tailwind engine pass covers them regardless.
        const css = await compileUtilities({ classes: ['flex', 'block'], themeCss: THEME_CSS })
        expect(css).toContain('.flex')
        expect(css).toContain('.block')
    })

    it('pulls in custom utilities from baseCss', async () => {
        const baseCss = ':where(.row, .col) { display: flex; }'
        const css = await compileUtilities({ classes: ['hover:row'], baseCss })
        expect(css).toContain('row')
    })

    it('generates a theme-var utility even when the last declaration has no trailing semicolon', async () => {
        // Regression: extractThemeVariables used to require a `;` terminator,
        // so the last declaration in a block (valid CSS without one) was
        // silently dropped — e.g. `:root{--spacing-4:1rem}` produced nothing.
        const css = await compileUtilities({ classes: ['p-4'], themeCss: ':root{--spacing-4:1rem}' })
        expect(css).toContain('.p-4 { padding: var(--spacing-4) }')
    })
})

describe('scanClasses', () => {
    it('finds tokens in class attributes and skips x-/$ tokens', () => {
        const html = '<div class="p-4 text-brand x-data $magic"></div>'
        expect(scanClasses(html)).toEqual(['p-4', 'text-brand'])
    })

    it('dedupes and sorts', () => {
        const html = '<div class="b-token a-token"></div><span class="a-token c-token"></span>'
        expect(scanClasses(html)).toEqual(['a-token', 'b-token', 'c-token'])
    })

    it('picks up class:token bindings', () => {
        const html = '<div class:is-open="expanded"></div>'
        expect(scanClasses(html)).toContain('is-open')
    })

    it('picks up static tokens inside a :class object literal', () => {
        const html = `<div :class="{ 'foo-class': active, 'other-class': !active }"></div>`
        expect(scanClasses(html)).toEqual(expect.arrayContaining(['foo-class', 'other-class']))
    })
})

describe('scripts/utilities-static.mjs CLI', () => {
    it('writes a deterministic static sheet for a directory of HTML files', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mnfst-utilities-static-'))
        try {
            writeFileSync(join(dir, 'index.html'), '<div class="p-4 text-brand hover:bg-brand"></div>')
            writeFileSync(join(dir, 'theme.css'), THEME_CSS)
            const cliPath = join(__dirname, '../scripts/utilities-static.mjs')
            const outPath = join(dir, 'out.css')

            execFileSync(process.execPath, [cliPath, dir, '--theme', join(dir, 'theme.css'), '--out', outPath])
            const first = readFileSync(outPath, 'utf8')

            const outPath2 = join(dir, 'out2.css')
            execFileSync(process.execPath, [cliPath, dir, '--theme', join(dir, 'theme.css'), '--out', outPath2])
            const second = readFileSync(outPath2, 'utf8')

            expect(first).toBe(second)
            expect(first).toContain('.text-brand')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('bakes variants of the framework\'s own semantic utilities (.row/.col) without a --base flag', () => {
        // Regression: the CLI used to call compileUtilities() with no baseCss,
        // so md:row/hover:col-wrap-style usage of Manifest's own .row/.col
        // utilities was silently skipped at bake time (the browser JIT finds
        // manifest.css for free via discoverCssFiles(); a static bake has no
        // page, so this script must load it itself — see utilities-static.mjs).
        const dir = mkdtempSync(join(tmpdir(), 'mnfst-utilities-static-'))
        try {
            writeFileSync(join(dir, 'index.html'), '<div class="row md:row hover:row-wrap"></div>')
            const cliPath = join(__dirname, '../scripts/utilities-static.mjs')
            const outPath = join(dir, 'out.css')

            execFileSync(process.execPath, [cliPath, dir, '--out', outPath])
            const css = readFileSync(outPath, 'utf8')

            expect(css).toContain('md\\:row')
            expect(css).toContain('hover\\:row-wrap')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
