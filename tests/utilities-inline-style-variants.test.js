/**
 * @vitest-environment happy-dom
 *
 * Vars from an id-less inline <style> reach the full compile, so variant
 * classes (dark:, hover:, md:) get rules, not just the sync-path base classes.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

async function boot({ headHtml, bodyHtml }) {
    document.head.innerHTML = headHtml
    document.body.innerHTML = bodyHtml
    window.tailwind = {}
    window.ManifestComponentsRegistry = { manifest: {} }
    delete window.__manifestUtilitiesReady
    window.__manifestUtilitiesPending = 0
    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + `\n//boot:${Math.random()}`))
    await ready
    return window.ManifestUtilities
}

describe('inline <style> theme vars', () => {
    for (const [label, attrs] of [['without id', ''], ['with id', ' id="theme"']]) {
        it(`${label}: emits variant rules`, async () => {
            const compiler = await boot({
                headHtml: `<style${attrs}>:root{--color-brand: red}</style>`,
                bodyHtml: '<div class="dark:bg-brand hover:text-brand md:bg-brand"></div>'
            })
            expect(await compiler.fetchThemeContent()).toContain('--color-brand')
            const css = compiler.styleElement.textContent
            expect(css).toContain('dark\\:bg-brand')
            expect(css).toContain('hover\\:text-brand')
            expect(css).toContain('md\\:bg-brand')
        })
    }
})
