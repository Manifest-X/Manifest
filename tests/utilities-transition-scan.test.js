/**
 * @vitest-environment happy-dom
 *
 * x-transition:* values are class lists: the bake and the browser's static scan both collect them.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import { compileUtilities, scanClasses } from '../lib/manifest.utilities.node.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const HTML = `<div x-data="{ open: false }">
<div x-show="open"
  x-transition:enter="transition ease-out duration-300"
  x-transition:enter-start='opacity-0 scale-90'
  x-transition:enter-end="opacity-100 scale-100"
  x-transition:leave.opacity="transition ease-in duration-150"
  x-transition:leave-start="opacity-100"
  x-transition:leave-end="opacity-0 translate-y-2"
  x-transition.duration.500ms
  class="p-4"></div></div>`
const TRANSITION_TOKENS = ['transition', 'ease-out', 'duration-300', 'opacity-0', 'scale-90', 'opacity-100', 'scale-100', 'ease-in', 'duration-150', 'translate-y-2']

describe('x-transition class scan', () => {
    it('scanClasses collects every x-transition:* value token', () => {
        expect(scanClasses(HTML)).toEqual(expect.arrayContaining(['p-4', ...TRANSITION_TOKENS]))
    })

    it('skips x- and $ tokens and empty modifier-only attributes', () => {
        const found = scanClasses('<p x-transition:enter="x-foo $bar ease-out" x-transition.scale.80></p>')
        expect(found).toEqual(['ease-out'])
    })

    it('ignores look-alike attribute names', () => {
        expect(scanClasses('<p data-x-transition:enter="ease-out" my-x-transition:enter="duration-75"></p>')).toEqual([])
    })

    it('the bake emits Tailwind rules for them', async () => {
        const css = await compileUtilities({ classes: scanClasses(HTML) })
        expect(css).toContain('.duration-300')
        expect(css).toContain('.scale-90')
        expect(css).toContain('.translate-y-2')
    })

    it('the browser static scan collects them too', async () => {
        window.tailwind = {}
        window.ManifestComponentsRegistry = { manifest: {} }
        document.body.innerHTML = HTML
        await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
            readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')
        ))
        const compiler = window.ManifestUtilities
        compiler.staticScanPromise = null
        const found = await compiler.scanStaticClasses()
        expect([...found]).toEqual(expect.arrayContaining(TRANSITION_TOKENS))
    })
})
