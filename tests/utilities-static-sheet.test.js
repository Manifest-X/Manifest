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
import { describe, it, expect, vi } from 'vitest'

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

    it('covers a class whose only baked rule came from the Tailwind engine pass (gap-2)', async () => {
        // gap-2 has no Manifest generator/theme-var backing at all — a static
        // sheet baked by compileUtilities() covers it purely via the Tailwind
        // pass (see manifest.utilities.node.mjs). The runtime's coverage
        // detection is generic (classNamesFromCssText reads any selector), so
        // it must recognize this as covered the same as a Manifest-authored rule.
        const headHtml = [
            '<style data-mnfst-utilities>.gap-2{gap:calc(var(--spacing) * 2)}</style>',
        ].join('')
        const bodyHtml = '<div class="gap-2 p-4"></div>'

        const compiler = await bootPluginWith({ headHtml, bodyHtml })

        expect(compiler.staticUtilitiesCoveredClasses.has('gap-2')).toBe(true)
        const generated = document.getElementById('manifest-styles').textContent
        expect(generated).not.toMatch(/\.gap-2\s*\{/)
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

describe('static utilities sheet — nested @layer/@media coverage (real Tailwind bake shape)', () => {
    // Regression: extractSelectorsFromCssText only recognized an `@` rule when
    // `i` landed exactly on '@'. After skipping a `;`-terminated statement (or
    // finishing a sibling rule), `i` sits on the whitespace/newline before the
    // next '@' — so a real bake's `@layer utilities { ... @media { ... } }`
    // was swallowed whole as one bogus selector and none of its classes (nor
    // classes nested one level deeper inside its own @media) were ever seen as
    // covered, regardless of unescaping. Every real compileUtilities() output
    // has this exact shape now that it emits the `@layer base, ...;` preamble.
    const NESTED_CSS = [
        '@layer base, components, utilities;',
        '@layer utilities {',
        '.group-hover\\:opacity-100 { &:hover { opacity: 1; } }',
        '.\\[\\&_svg\\]\\:size-4 { & svg { width: 1rem; } }',
        '@media (min-width: 768px) {',
        '.md\\:flex { display: flex; }',
        '}',
        '}',
    ].join('\n')

    it('a <style> sheet: covers classes at both the @layer and nested @media level', async () => {
        const headHtml = [
            '<style id="theme-vars">:root { --spacing-4: 1rem; }</style>',
            `<style data-mnfst-utilities>${NESTED_CSS}</style>`,
        ].join('')
        const bodyHtml = '<div class="group-hover:opacity-100 [&_svg]:size-4 md:flex p-4"></div>'

        const compiler = await bootPluginWith({ headHtml, bodyHtml })

        expect(compiler.staticUtilitiesCoveredClasses.has('group-hover:opacity-100')).toBe(true)
        expect(compiler.staticUtilitiesCoveredClasses.has('[&_svg]:size-4')).toBe(true)
        expect(compiler.staticUtilitiesCoveredClasses.has('md:flex')).toBe(true)

        // Covered classes never reach generateUtilitiesFromVars/generateCustomUtilities
        // (filterStaticallyCoveredClasses / getUsedClasses), the uncovered one still does.
        const generated = document.getElementById('manifest-styles').textContent
        expect(generated).not.toMatch(/group-hover/)
        expect(generated).not.toMatch(/svg/)
        expect(generated).not.toMatch(/md\\:flex/)
        expect(generated).toMatch(/\.p-4\s*\{/)
    })

    it('a <link> sheet (CSSOM cssRules): the same nested shape, walked recursively', async () => {
        const link = document.createElement('link')
        link.setAttribute('rel', 'stylesheet')
        link.setAttribute('data-mnfst-utilities', '')
        link.setAttribute('href', 'data:text/css,')
        document.head.innerHTML = '<style id="theme-vars">:root { --spacing-4: 1rem; }</style>'
        document.head.appendChild(link)
        document.body.innerHTML = '<div class="group-hover:opacity-100 [&_svg]:size-4 md:flex p-4"></div>'
        window.tailwind = {}
        window.ManifestComponentsRegistry = { manifest: {} }
        delete window.__manifestUtilitiesReady
        window.__manifestUtilitiesPending = 0

        // A real CSSOM read returns one top-level rule per top-level statement/block
        // (a CSSLayerStatementRule for the preamble, a CSSLayerBlockRule for the
        // layer body) — mirror that shape rather than one joined string.
        vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([{
            ownerNode: link,
            cssRules: [
                { cssText: '@layer base, components, utilities;' },
                { cssText: NESTED_CSS.slice(NESTED_CSS.indexOf('@layer utilities')) },
            ],
        }])

        const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
        const nonce = `\n//boot:${Math.random()}`
        await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
        await ready
        const compiler = window.ManifestUtilities

        expect(compiler.staticUtilitiesCoveredClasses.has('group-hover:opacity-100')).toBe(true)
        expect(compiler.staticUtilitiesCoveredClasses.has('[&_svg]:size-4')).toBe(true)
        expect(compiler.staticUtilitiesCoveredClasses.has('md:flex')).toBe(true)
        vi.restoreAllMocks()
    })

    it('a preflight-shaped rule (*, ::before, ::after, ::backdrop) contributes no bogus classes', async () => {
        const css = [
            '*, ::before, ::after, ::backdrop { box-sizing: border-box; }',
            NESTED_CSS,
        ].join('\n')
        const headHtml = `<style data-mnfst-utilities>${css}</style>`
        const compiler = await bootPluginWith({ headHtml, bodyHtml: '<div></div>' })

        expect(compiler.staticUtilitiesCoveredClasses.has('group-hover:opacity-100')).toBe(true)
        for (const bogus of ['*', '::before', '::after', '::backdrop', '']) {
            expect(compiler.staticUtilitiesCoveredClasses.has(bogus)).toBe(false)
        }
    })
})
