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

    it('skips Tailwind runtime output and the baked utilities sheet as theme sources', async () => {
        const compiler = await boot({
            headHtml: [
                '<style data-mnfst-utilities>.baked-card{border:1px solid red}</style>',
                '<style>/*! tailwindcss v4.1.0 | MIT License */ .tw-card{color:red}</style>',
                '<style>:root{--color-brand: red}</style>'
            ].join(''),
            bodyHtml: '<div class="md:bg-brand md:baked-card md:tw-card"></div>'
        })
        const theme = await compiler.fetchThemeContent()
        expect(theme).toContain('--color-brand')
        expect(theme).not.toContain('baked-card')
        expect(theme).not.toContain('tailwindcss')
        expect(compiler.customUtilities.has('baked-card')).toBe(false)
        expect(compiler.customUtilities.has('tw-card')).toBe(false)
        const css = compiler.styleElement.textContent
        expect(css).toContain('md\\:bg-brand')
        expect(css).not.toContain('md\\:baked-card')
        expect(css).not.toContain('md\\:tw-card')
    })
})
