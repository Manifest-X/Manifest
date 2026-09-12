/**
 * @vitest-environment happy-dom
 *
 * Regression fixtures from two real, production-baked utilities sheets
 * (fetched from live staging deployments, not hand-written) — the last two
 * classNamesFromCssText bugs (see git log: nested @layer/@media, whitespace
 * before an @-rule) both slipped past hand-written fixtures and were only
 * caught reading an actual bake. Checked-in bytes so the parser can never
 * regress on a real production shape again without a test noticing.
 *
 * playcom-staging.utilities.css opens with a doubled
 * `@layer base, components, utilities;` preamble (a real artifact of that
 * deployment) — the parser must tolerate it, not just the single-preamble
 * shape compileUtilities emits.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')
const FIXTURES = {
    playcom: { file: 'fixtures/playcom-staging.utilities.css', expectedCount: 538 },
    website: { file: 'fixtures/manifest-website-staging.utilities.css', expectedCount: 478 },
}

async function bootCompiler() {
    document.head.innerHTML = ''
    document.body.innerHTML = '<div></div>'
    window.tailwind = {} // isTailwindAvailable() true immediately — skip the 5s poll
    window.ManifestComponentsRegistry = { manifest: {} } // skip the 2s registry wait
    delete window.__manifestUtilitiesReady
    window.__manifestUtilitiesPending = 0

    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    const nonce = `\n//boot:${Math.random()}`
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
    await ready
    return window.ManifestUtilities
}

describe('real utilities sheet fixtures — classNamesFromCssText', () => {
    it('playcom-staging.manifestx.ai: reports the full covered-class count despite the doubled @layer preamble', async () => {
        const compiler = await bootCompiler()
        const css = readFileSync(join(__dirname, FIXTURES.playcom.file), 'utf8')
        expect(css.match(/^@layer base, components, utilities;/gm).length).toBeGreaterThanOrEqual(2)
        const names = compiler.classNamesFromCssText(css)
        expect(names.size).toBe(FIXTURES.playcom.expectedCount)
    })

    it('manifest-website-staging.manifestx.ai: reports the full covered-class count', async () => {
        const compiler = await bootCompiler()
        const css = readFileSync(join(__dirname, FIXTURES.website.file), 'utf8')
        const names = compiler.classNamesFromCssText(css)
        expect(names.size).toBe(FIXTURES.website.expectedCount)
    })

    it('both fixtures are treated as fully covered end-to-end when served as the static sheet', async () => {
        for (const { file, expectedCount } of Object.values(FIXTURES)) {
            document.head.innerHTML = `<style data-mnfst-utilities data-mnfst-utilities-complete>${readFileSync(join(__dirname, file), 'utf8')}</style>`
            document.body.innerHTML = '<div></div>'
            window.tailwind = {}
            window.ManifestComponentsRegistry = { manifest: {} }
            delete window.__manifestUtilitiesReady
            window.__manifestUtilitiesPending = 0

            const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
            const nonce = `\n//boot:${Math.random()}`
            await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
            await ready
            const compiler = window.ManifestUtilities

            expect(compiler.staticUtilitiesCoveredClasses).toBeInstanceOf(Set)
            expect(compiler.staticUtilitiesCoveredClasses.size).toBe(expectedCount)
        }
    })
})
