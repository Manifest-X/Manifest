/**
 * @vitest-environment happy-dom
 *
 * One utilities compiler per page. A second copy of the plugin (a runtime
 * Manifest.loadPlugin() that resolved to another version) used to build a rival
 * #manifest-styles; the two order observers then re-appended their own style to
 * <head> forever and wedged the main thread.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

async function evaluateBundle() {
    // A unique nonce defeats the dynamic import cache, so this is a genuine
    // second evaluation of the plugin — what a second <script> would do.
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + `\n//boot:${Math.random()}`))
}

describe('utilities: one compiler per page', () => {
    it('a second evaluation reuses the live compiler instead of building a rival style element', async () => {
        document.head.innerHTML = '<style id="theme-vars">:root { --spacing-4: 1rem; }</style>'
        document.body.innerHTML = '<div class="p-4"></div>'
        window.tailwind = {}
        window.ManifestComponentsRegistry = { manifest: {} }

        await evaluateBundle()
        const first = window.ManifestUtilities
        expect(first).toBeTruthy()
        expect(document.querySelectorAll('style#manifest-styles').length).toBe(1)

        await evaluateBundle()

        expect(window.ManifestUtilities).toBe(first)
        expect(document.querySelectorAll('style#manifest-styles').length).toBe(1)
    })

    it('builds a fresh compiler when the previous style element is gone from the document', async () => {
        await evaluateBundle()
        const first = window.ManifestUtilities
        document.head.innerHTML = '<style id="theme-vars">:root { --spacing-4: 1rem; }</style>'

        await evaluateBundle()

        expect(window.ManifestUtilities).not.toBe(first)
        expect(document.querySelectorAll('style#manifest-styles').length).toBe(1)
    })
})
