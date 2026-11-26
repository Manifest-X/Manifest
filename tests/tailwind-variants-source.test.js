/**
 * @vitest-environment node
 *
 * One definition of Manifest's Tailwind @custom-variant list feeds the browser engine,
 * the node bake and mnfst-render's CLI input.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(repo, p), 'utf8')
const SOURCE = 'src/scripts/manifest.tailwind.variants.mjs'

const EXPECTED = [
    '@custom-variant touch (@media (pointer: coarse));',
    '@custom-variant cursor (@media (pointer: fine) and (hover: hover));',
    '@custom-variant pointer (@media (any-pointer: fine));',
    '@custom-variant mac (&:where([data-os="macos"] *));',
    '@custom-variant windows (&:where([data-os="windows"] *));',
    '@custom-variant linux (&:where([data-os="linux"] *));',
    '@custom-variant ios (&:where([data-os="ios"] *));',
    '@custom-variant android (&:where([data-os="android"] *));',
    '@custom-variant apple (&:where([data-os="macos"] *, [data-os="ios"] *));',
    '@custom-variant online (&:where([data-online="true"] *));',
    '@custom-variant offline (&:where([data-online="false"] *));',
    '@custom-variant standalone (&:where([data-standalone] *));',
    '@custom-variant native (&:where([data-native] *));',
    '@custom-variant web (&:where(html:not([data-native]) *));',
]
const DARK = '@custom-variant dark (&:where(.dark, .dark *));'
const count = (text, s) => text.split(s).length - 1

describe('Tailwind custom variants: one source', () => {
    it('the shared module holds the list unchanged', async () => {
        const v = await import('../' + SOURCE)
        expect(v.TAILWIND_CUSTOM_VARIANTS).toEqual(EXPECTED)
        expect(v.TAILWIND_DARK_VARIANT).toBe(DARK)
        expect(v.AUTHOR_DARK_RE.test('@custom-variant dark (&:where(.x *));')).toBe(true)
        expect(v.AUTHOR_DARK_RE.test('@custom-variant darker (&:where(.x *));')).toBe(false)
    })

    it('render re-exports the shared values', async () => {
        const v = await import('../' + SOURCE)
        const render = await import('../src/scripts/manifest.render.mjs')
        expect(render.TAILWIND_CUSTOM_VARIANTS).toBe(v.TAILWIND_CUSTOM_VARIANTS)
        expect(render.TAILWIND_DARK_VARIANT).toBe(v.TAILWIND_DARK_VARIANT)
    })

    it('no source file keeps its own copy', () => {
        for (const p of ['src/scripts/utilities/manifest.utilities.init.js', 'src/scripts/utilities/manifest.utilities.node.mjs', 'src/scripts/manifest.render.mjs']) {
            expect(count(read(p), '@custom-variant touch'), p).toBe(0)
        }
    })

    it('each built carrier holds exactly one copy', () => {
        for (const p of ['lib/manifest.utilities.js', 'lib/manifest.utilities.node.mjs', 'src/scripts/manifest.utilities.js', 'src/scripts/manifest.utilities.node.mjs']) {
            const text = read(p)
            for (const line of [...EXPECTED, DARK]) expect(count(text, `'${line}'`), `${p}: ${line}`).toBe(1)
            expect(text, p).not.toMatch(/^export const TAILWIND_/m)
        }
    })

    it('mnfst-render ships the shared module', () => {
        expect(read('packages/render/manifest.tailwind.variants.mjs')).toBe(read(SOURCE))
        expect(JSON.parse(read('packages/render/package.json')).files).toContain('manifest.tailwind.variants.mjs')
    })
})
