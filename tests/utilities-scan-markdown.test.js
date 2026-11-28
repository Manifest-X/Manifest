/**
 * @vitest-environment node
 *
 * The bake's scan reads markdown container classes (`::: frame col gap-4`), which the markdown module
 * writes on an <aside>; without them every article using a frame needed the engine at runtime.
 */
import { describe, it, expect } from 'vitest'
import { scanClasses } from '../lib/manifest.utilities.node.mjs'

describe('scanClasses: markdown containers', () => {
    it('reads the classes on a container line', () => {
        expect(scanClasses('# T\n\n::: frame col gap-4 p-10 font-sans\n<div>x</div>\n:::\n')).toEqual(['col', 'font-sans', 'frame', 'gap-4', 'p-10'])
    })

    it('keeps important, arbitrary and variant tokens', () => {
        expect(scanClasses('::: frame !gap-6 [&_a]:underline md:h-112\nx\n:::')).toEqual(['!gap-6', '[&_a]:underline', 'frame', 'md:h-112'])
    })

    it("drops the icon, the quoted name and a frame's demo flag, as the renderer does", () => {
        expect(scanClasses('::: frame demo "header.html" icon="lucide:info" p-2\nx\n:::')).toEqual(['frame', 'p-2'])
        expect(scanClasses('::: note demo\nx\n:::')).toEqual(['demo', 'note'])
    })

    it('ignores closing lines and ::: inside a line', () => {
        expect(scanClasses('text ::: not-a-container\n:::\n')).toEqual([])
    })
})
