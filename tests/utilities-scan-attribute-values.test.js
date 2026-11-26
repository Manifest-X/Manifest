/**
 * @vitest-environment node
 *
 * The class scan reads attribute values as the DOM does: entities decoded, unquoted values read.
 */
import { describe, it, expect } from 'vitest'
import { scanClasses } from '../lib/manifest.utilities.node.mjs'

describe('class attribute values', () => {
    it('decodes character references', () => {
        expect(scanClasses('<div class="[&amp;>*]:p-2 [&amp;_a]:w-full"></div>')).toEqual(['[&>*]:p-2', '[&_a]:w-full'])
        expect(scanClasses('<div class="content-[&#39;x&#39;] content-[&quot;y&quot;] after:content-[&#x2192;]"></div>'))
            .toEqual(['after:content-[→]', 'content-["y"]', "content-['x']"])
        expect(scanClasses('<div class="[&lt;x&gt;] &unknown;"></div>')).toEqual(['&unknown;', '[<x>]'])
    })

    it('reads unquoted values', () => {
        expect(scanClasses('<div class=flex id=a></div><p class=p-4>t</p>')).toEqual(['flex', 'p-4'])
        expect(scanClasses('<div x-transition:enter=ease-out></div>')).toEqual(['ease-out'])
    })

    it('leaves bindings and look-alikes alone', () => {
        expect(scanClasses('<div :class=open x-bind:class=open></div>')).toEqual([])
    })

    it('decodes x-transition values too', () => {
        expect(scanClasses('<div x-transition:enter="[&amp;_*]:opacity-0"></div>')).toEqual(['[&_*]:opacity-0'])
    })
})
