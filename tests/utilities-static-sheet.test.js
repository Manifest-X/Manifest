/**
 * @vitest-environment happy-dom
 *
 * Runtime detection: a page with `<style data-mnfst-utilities>` should tell
 * the browser JIT (manifest.utilities.js) which classes are already covered,
 * so compile() only patches what's left — the fix for the 85-stylesheet-write
 * problem (PERF-PRIMITIVES-DESIGN.md §15).
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

async function bootPluginWith({ headHtml, bodyHtml }) {
    document.head.innerHTML = headHtml
    document.body.innerHTML = bodyHtml
    window.tailwind = {} // isTailwindAvailable() true immediately — skip the 5s poll
    window.ManifestComponentsRegistry = { manifest: {} } // skip the 2s registry wait
    // happy-dom keeps one `window` per test file — reset the ready/pending
    // latches compile() guards with, or the 2nd+ boot's "ready" event never fires.
    delete window.__manifestUtilitiesReady
    window.__manifestUtilitiesPending = 0

    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    // Each boot needs a fresh module evaluation (fresh `new TailwindCompiler()`,
    // fresh listeners) — a byte-identical data: URL would hit the dynamic
    // import cache and silently reuse the previous test's instance, so append
    // a unique nonce to force re-evaluation every call.
    const nonce = `\n//boot:${Math.random()}`
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
    await ready
    return window.ManifestUtilities
}

describe('static utilities sheet — runtime skip', () => {
    it('does not regenerate a class the static sheet already covers, and does generate a new one', async () => {
        const headHtml = [
            '<style id="theme-vars">:root { --spacing-4: 1rem; --spacing-8: 2rem; }</style>',
            '<style data-mnfst-utilities>.p-4{padding:1rem}</style>',
        ].join('')
        const bodyHtml = '<div class="p-4 p-8"></div>'

        const compiler = await bootPluginWith({ headHtml, bodyHtml })

        expect(compiler.staticUtilitiesCoveredClasses).toBeInstanceOf(Set)
        expect(compiler.staticUtilitiesCoveredClasses.has('p-4')).toBe(true)

        const generated = document.getElementById('manifest-styles').textContent
        expect(generated).not.toMatch(/\.p-4\s*\{/)
        expect(generated).toMatch(/\.p-8\s*\{/)
    })

    it('unescapes variant selectors from the static sheet (hover:bg-brand)', async () => {
        const headHtml = [
            '<style id="theme-vars">:root { --color-brand: #ff0000; }</style>',
            '<style data-mnfst-utilities>.hover\\:bg-brand:hover{background-color:red}</style>',
        ].join('')
        const bodyHtml = '<div class="hover:bg-brand text-brand"></div>'

        const compiler = await bootPluginWith({ headHtml, bodyHtml })

        expect(compiler.staticUtilitiesCoveredClasses.has('hover:bg-brand')).toBe(true)
        const generated = document.getElementById('manifest-styles').textContent
        expect(generated).not.toMatch(/hover\\:bg-brand/)
        expect(generated).toMatch(/\.text-brand\s*\{/)
    })

    it('stripCoveredRulesFromCss drops a replayed cache rule the static sheet already covers', async () => {
        // manifest.utilities.cache.js replays a stylesheet cached before the
        // static sheet existed (or from a visitor without one) verbatim via
        // loadAndApplyCache() — a separate path from compile()'s live
        // generation, so it needed its own fix to never re-emit covered rules.
        const headHtml = [
            '<style id="theme-vars">:root { --spacing-4: 1rem; --spacing-8: 2rem; }</style>',
            '<style data-mnfst-utilities>.p-4{padding:1rem}</style>',
        ].join('')
        const compiler = await bootPluginWith({ headHtml, bodyHtml: '<div></div>' })

        const cached = '@layer utilities {\n.p-4 { padding: 1rem }\n\n.p-8 { padding: 2rem }\n}'
        const stripped = compiler.stripCoveredRulesFromCss(cached)
        expect(stripped).not.toMatch(/\.p-4\s*\{/)
        expect(stripped).toMatch(/\.p-8\s*\{/)
    })

    it('behaves like a cold visitor when there is no static sheet', async () => {
        const headHtml = '<style id="theme-vars">:root { --spacing-4: 1rem; }</style>'
        const bodyHtml = '<div class="p-4"></div>'

        const compiler = await bootPluginWith({ headHtml, bodyHtml })

        expect(compiler.staticUtilitiesCoveredClasses).toBeNull()
        const generated = document.getElementById('manifest-styles').textContent
        expect(generated).toMatch(/\.p-4\s*\{/)
    })
})
