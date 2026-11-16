/**
 * @vitest-environment node
 *
 * Theme utilities that only appear in Alpine class bindings are scanned, and
 * data-/aria- variants keep their attribute condition (Tailwind v4: on the
 * element itself). Runtime discovery lives in utilities-dynamic-runtime.test.js.
 */
import { describe, it, expect } from 'vitest'
import { compileUtilities, scanClasses } from '../lib/manifest.utilities.node.mjs'

const THEME_CSS = ':root { --color-positive-content: green; --color-negative-content: red; --color-brand: blue; }'
const compile = (classes) => compileUtilities({ classes, themeCss: THEME_CSS })

describe(':class binding scan', () => {
    it('collects both branches of a ternary', () => {
        const found = scanClasses(`<p :class="ok ? 'text-positive-content' : 'text-negative-content'"></p>`)
        expect(found).toEqual(expect.arrayContaining(['text-positive-content', 'text-negative-content']))
    })

    it('splits multi-class literals and reads x-bind:class', () => {
        const found = scanClasses(`<p x-bind:class="ok && 'font-bold text-brand'"></p>`)
        expect(found).toEqual(expect.arrayContaining(['font-bold', 'text-brand']))
    })

    it('reads quoted and bare object keys', () => {
        const found = scanClasses(`<p :class="{ 'bg-brand': ok, hidden: !ok, 'md:p-4 rounded': big }"></p>`)
        expect(found).toEqual(expect.arrayContaining(['bg-brand', 'hidden', 'md:p-4', 'rounded']))
    })

    it('reads literals inside template expressions and entity-encoded quotes', () => {
        expect(scanClasses('<p :class="`p-2 ${ok ? \'text-brand\' : \'\'}`"></p>')).toEqual(expect.arrayContaining(['p-2', 'text-brand']))
        expect(scanClasses(`<p :class="ok ? &quot;text-brand&quot; : 'x'"></p>`)).toContain('text-brand')
    })

    it('keeps arbitrary values and drops expression fragments', () => {
        const found = scanClasses('<p :class="ok ? \'bg-[rgb(1,2,3)]\' : `text-${tone}`"></p>')
        expect(found).toContain('bg-[rgb(1,2,3)]')
        expect(found.some(c => c.includes('$') || c.includes('{'))).toBe(false)
    })
})

describe('attribute variants', () => {
    it('data-<name> requires the attribute on the element', async () => {
        const css = await compile(['data-good:text-positive-content'])
        expect(css).toContain('.data-good\\:text-positive-content[data-good] { color: var(--color-positive-content) }')
        expect(css).not.toMatch(/\.data-good\\:text-positive-content \{/)
    })

    it('data-[key=value] and aria-[key=value] quote the value on the element', async () => {
        const css = await compile(['data-[tone=good]:text-brand', 'aria-[sort=ascending]:text-brand'])
        expect(css).toContain('.data-\\[tone\\=good\\]\\:text-brand[data-tone="good"]')
        expect(css).toContain('.aria-\\[sort\\=ascending\\]\\:text-brand[aria-sort="ascending"]')
    })

    it('aria-<state> matches the element, named and generic', async () => {
        const css = await compile(['aria-expanded:text-brand', 'aria-collapsed:text-brand', 'aria-grabbed:text-brand'])
        expect(css).toContain('.aria-expanded\\:text-brand[aria-expanded="true"]')
        expect(css).toContain('.aria-collapsed\\:text-brand[aria-expanded="false"]')
        expect(css).toContain('.aria-grabbed\\:text-brand[aria-grabbed="true"]')
    })

    it('group- and peer- put the condition on the marker', async () => {
        const css = await compile(['group-data-[open]:text-brand', 'peer-aria-collapsed:text-brand'])
        expect(css).toContain(':where(.group[data-open]) .group-data-\\[open\\]\\:text-brand')
        expect(css).toContain(':where(.peer[aria-expanded="false"]) ~ .peer-aria-collapsed\\:text-brand')
    })

    it('an unknown variant emits no rule instead of an unconditional one', async () => {
        const css = await compile(['text-brand', 'nonsense-variant:text-positive-content'])
        expect(css).toContain('.text-brand {')
        expect(css).not.toContain('nonsense-variant')
    })
})
