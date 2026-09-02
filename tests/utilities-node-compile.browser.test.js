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

async function browserCompile(classes, themeCss) {
    const discovered = liveCompiler.extractCustomUtilities(themeCss)
    for (const [name, value] of discovered) liveCompiler.customUtilities.set(name, value)
    const usedData = { classes: Array.from(new Set(classes)), variableSuffixes: [] }
    const varUtilities = liveCompiler.generateUtilitiesFromVars(themeCss, usedData)
    const customUtilities = liveCompiler.generateCustomUtilities(usedData)
    let all = [varUtilities, customUtilities].filter(Boolean).join('\n\n')
    all = liveCompiler.sortUtilities(all)
    return all ? `@layer utilities {\n${all}\n}` : ''
}

describe('compileUtilities parity with the browser plugin', () => {
    it('matches for a representative class set (variants, arbitrary value, theme-var utility)', async () => {
        const nodeCss = await compileUtilities({ classes: CLASSES, themeCss: THEME_CSS })
        const browserCss = await browserCompile(CLASSES, THEME_CSS)
        expect(nodeCss).toBe(browserCss)
    })
})
