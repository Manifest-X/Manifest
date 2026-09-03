/**
 * @vitest-environment happy-dom
 *
 * Parity check: compileUtilities (lib/manifest.utilities.node.mjs) must match
 * what a real page produces — the live browser plugin's generation logic
 * (lib/manifest.utilities.js) for theme-var/custom utilities, AND the real
 * bundled Tailwind engine (lib/manifest.tailwind.js) for plain Tailwind-style
 * utilities. Both are loaded live and driven the way a page drives them, so
 * this can't drift from a hand-written expectation.
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

function browserManifestCompile(classes, themeCss, baseCss = '') {
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

// Drives the real, bundled Tailwind engine (lib/manifest.tailwind.js) the way
// a live page does: candidates come from its own DOM scan
// (document.querySelectorAll('[class]')), not an API — so this puts the
// classes on a scratch element, loads the engine fresh (a fresh happy-dom
// realm each time so its internal "already seen" candidate set — see
// manifest.utilities.node.mjs's compileTailwindPass comment — never leaks
// across calls), waits for its async build to settle, then reads the
// `<style>` tag it appended to <head>.
async function browserTailwindCompile(classes) {
    const { Window } = await import('happy-dom')
    const win = new Window()
    const doc = win.document
    const el = doc.createElement('div')
    el.setAttribute('class', classes.join(' '))
    doc.body.appendChild(el)
    win.eval(readFileSync(join(__dirname, '../lib/manifest.tailwind.js'), 'utf8'))
    let css = ''
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 25))
        const style = Array.from(doc.head.querySelectorAll('style')).find((s) => !s.getAttribute('type'))
        if (style && style.textContent) { css = style.textContent; break }
    }
    await win.happyDOM.close()
    const theme = extractLayerBody(css, 'theme')
    const utilities = extractLayerBody(css, 'utilities')
    const parts = []
    if (theme) parts.push(`@layer theme {\n${theme}\n}`)
    if (utilities) parts.push(`@layer utilities {\n${utilities}\n}`)
    return parts.join('\n\n')
}

function extractLayerBody(css, layerName) {
    const marker = `@layer ${layerName} {`
    const start = css.indexOf(marker)
    if (start === -1) return ''
    let depth = 1
    let i = start + marker.length
    const bodyStart = i
    for (; i < css.length && depth > 0; i++) {
        if (css[i] === '{') depth++
        else if (css[i] === '}') depth--
    }
    return css.slice(bodyStart, i - 1).trim()
}

const norm = (css) => css.replace(/\s+/g, ' ').trim()

describe('compileUtilities parity with the browser Manifest plugin', () => {
    it('matches for a representative class set (variants, arbitrary value, theme-var utility)', async () => {
        // w-[37px] and md:flex here have no Manifest generator/theme-var
        // backing, so browserManifestCompile emits nothing for them — but
        // compileUtilities now also runs the Tailwind pass, so its output
        // carries those two on top. Assert the Manifest-side portion matches
        // exactly, and that the Tailwind-only tokens are covered too.
        const nodeCss = await compileUtilities({ classes: CLASSES, themeCss: THEME_CSS })
        const browserCss = browserManifestCompile(CLASSES, THEME_CSS)
        expect(nodeCss).toContain(browserCss)
        expect(nodeCss).toContain('.w-\\[37px\\]')
        expect(nodeCss).toContain('.md\\:flex')
    })

    it('matches when baseCss carries the framework\'s own semantic utilities (.row/.col variants)', async () => {
        // compile() finds manifest.css for free via discoverCssFiles() reading
        // the page's own stylesheets; a static bake has no page, so the caller
        // must pass the same CSS as baseCss (scripts/utilities-static.mjs does
        // this automatically) — parity holds once it does.
        const baseCss = ':where(.row, .col) { display: flex; }\n:where(.col) { flex-flow: column nowrap; }'
        const classes = ['row', 'md:row', 'hover:col']
        const nodeCss = await compileUtilities({ classes, baseCss })
        const browserCss = browserManifestCompile(classes, '', baseCss)
        expect(norm(nodeCss)).toBe(norm(browserCss))
    })
})

describe('compileUtilities Tailwind pass parity with the real bundled engine', () => {
    it('matches lib/manifest.tailwind.js output for plain Tailwind-style tokens', async () => {
        // No Manifest theme vars in play here — every one of these is a stock
        // Tailwind utility with no Manifest generator/custom-utility backing,
        // so compileUtilities' output is exactly the Tailwind pass.
        const classes = ['flex', 'gap-2', 'items-center', 'rounded-full', 'max-w-3xl', 'w-[37px]', 'md:flex', 'sm:hidden']
        const nodeCss = await compileUtilities({ classes })
        const browserCss = await browserTailwindCompile(classes)
        expect(norm(nodeCss)).toBe(norm(browserCss))
    }, 15000)
})
