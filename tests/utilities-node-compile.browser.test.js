/**
 * @vitest-environment happy-dom
 *
 * Parity check: compileUtilities (lib/manifest.utilities.node.mjs) must be
 * the exact browser plugin's generation logic with no document — loads the
 * real, live compiler instance from the built browser bundle
 * (lib/manifest.utilities.js) and compares output for the same inputs.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import { compileUtilities } from '../lib/manifest.utilities.node.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const THEME_CSS = ':root { --color-brand: #ff0000; --spacing-4: 1rem; --spacing-8: 2rem; }'
const CLASSES = ['text-brand', 'hover:bg-brand', 'p-4', 'md:flex', 'w-[37px]']

// window.tailwind short-circuits isTailwindAvailable() so waitForTailwind()
// resolves immediately instead of polling for 5s.
window.tailwind = {}
window.ManifestComponentsRegistry = { manifest: {} }
await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')
))
// The real, live compiler instance the browser bundle constructs on load —
// generateUtilitiesFromVars/generateCustomUtilities/sortUtilities/parseClassName
// are the exact production methods, called the same way compileUtilities() does.
const liveCompiler = window.ManifestUtilities

async function browserCompile(classes, themeCss, baseCss = '') {
    const cssText = [baseCss, themeCss].filter(Boolean).join('\n')
    const discovered = liveCompiler.extractCustomUtilities(cssText)
    for (const [name, value] of discovered) liveCompiler.customUtilities.set(name, value)
    const usedData = { classes: Array.from(new Set(classes)), variableSuffixes: [] }
    const varUtilities = liveCompiler.generateUtilitiesFromVars(cssText, usedData)
    const customUtilities = liveCompiler.generateCustomUtilities(usedData)
    let all = [varUtilities, customUtilities].filter(Boolean).join('\n\n')
    all = liveCompiler.sortUtilities(all)
    return all ? `@layer utilities {\n${all}\n}` : ''
}

const norm = (css) => css.replace(/\s+/g, ' ').trim()

describe('compileUtilities parity with the browser plugin', () => {
    it('matches for a representative class set (variants, arbitrary value, theme-var utility)', async () => {
        const nodeCss = await compileUtilities({ classes: CLASSES, themeCss: THEME_CSS })
        const browserCss = await browserCompile(CLASSES, THEME_CSS)
        expect(nodeCss).toBe(browserCss)
    })

    it('matches for standard Tailwind-shaped tokens plus theme/custom utilities (no fork of compile()\'s generators)', async () => {
        // Includes tokens with no generator/theme-var backing at all (flex,
        // items-center, rounded-full, max-w-3xl, w-[37px]) — compile() emits
        // nothing for these too (they're the framework's bundled Tailwind
        // engine's job, not manifest.utilities'), so parity means both sides
        // agree on what to skip, not just what to generate.
        const theme = ':root{--spacing-4:1rem;--color-brand:#f00;--color-surface:#111;}'
        const classes = ['flex', 'gap-2', 'items-center', 'rounded-full', 'max-w-3xl', 'p-4', 'md:flex', 'hover:bg-brand', 'w-[37px]', 'text-brand', 'sm:hidden', 'dark:bg-surface']
        const nodeCss = await compileUtilities({ classes, themeCss: theme })
        const browserCss = await browserCompile(classes, theme)
        expect(norm(nodeCss)).toBe(norm(browserCss))
    })

    it('matches when baseCss carries the framework\'s own semantic utilities (.row/.col variants)', async () => {
        // compile() finds manifest.css for free via discoverCssFiles() reading
        // the page's own stylesheets; a static bake has no page, so the caller
        // must pass the same CSS as baseCss (scripts/utilities-static.mjs does
        // this automatically) — parity holds once it does.
        const baseCss = ':where(.row, .col) { display: flex; }\n:where(.col) { flex-flow: column nowrap; }'
        const classes = ['row', 'md:row', 'hover:col']
        const nodeCss = await compileUtilities({ classes, baseCss })
        const browserCss = await browserCompile(classes, '', baseCss)
        expect(norm(nodeCss)).toBe(norm(browserCss))
    })
})
