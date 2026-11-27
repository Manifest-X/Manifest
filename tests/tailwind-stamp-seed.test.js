/**
 * @vitest-environment node
 *
 * Engine-skip seed and stamp: one seed function feeds the node bake's report, the stamp the
 * backend writes and the constant the built loader compares against.
 * STAMP_LIB=<dir> runs it against another lib/ build.
 */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { describe, it, expect } from 'vitest'
import * as tailwindcss from 'tailwindcss'
import { tailwindSeed, TAILWIND_ENGINE_INPUT, TAILWIND_CUSTOM_VARIANTS, TAILWIND_DARK_VARIANT } from '../src/scripts/manifest.tailwind.variants.mjs'
import { inlineSubscript } from '../src/scripts/build.subscript.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = process.env.STAMP_LIB || join(repo, 'lib')
const require = createRequire(import.meta.url)
const node = await import(pathToFileURL(join(LIB, 'manifest.utilities.node.mjs')).href)
const ENGINE = readFileSync(join(repo, 'src/scripts/build.mjs'), 'utf8').match(/TAILWIND_V4_FILE: 'tailwind\.v(\d+\.\d+\.\d+)\.js'/)[1]
const injected = (version) => ({
    engine: tailwindcss,
    themeCss: readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8'),
    utilitiesCss: readFileSync(require.resolve('tailwindcss/utilities.css'), 'utf8'),
    version,
})

describe('tailwindSeed', () => {
    it('is "<version>:<hash of the input>" and deterministic', () => {
        expect(tailwindSeed('4.3.1')).toMatch(/^4\.3\.1:[0-9a-z]+$/)
        expect(tailwindSeed('4.3.1')).toBe(tailwindSeed('4.3.1', TAILWIND_ENGINE_INPUT))
        expect(tailwindSeed('4.3.3')).not.toBe(tailwindSeed('4.3.1'))
        expect(tailwindSeed('4.3.1', TAILWIND_ENGINE_INPUT + ' ')).not.toBe(tailwindSeed('4.3.1'))
        expect(tailwindSeed('')).toBe(null)
        expect(tailwindSeed(null)).toBe(null)
    })

    it('the input carries every Manifest variant', () => {
        for (const v of [...TAILWIND_CUSTOM_VARIANTS, TAILWIND_DARK_VARIANT]) expect(TAILWIND_ENGINE_INPUT).toContain(v)
    })

    it('the built loader and its min build accept exactly the bundled engine\'s seed', () => {
        const seed = tailwindSeed(ENGINE)
        for (const f of ['manifest.js', 'manifest.min.js']) expect(readFileSync(join(LIB, f), 'utf8'), f).toMatch(new RegExp(`['"]${seed.replace(/\./g, '\\.')}['"]`))
        expect(readFileSync(join(LIB, 'manifest.js'), 'utf8')).toContain(`const TAILWIND_SEED = '${seed}';`)
        expect(readFileSync(join(repo, 'src/scripts/manifest.js'), 'utf8')).toContain("const TAILWIND_SEED = '';")
    })
})

describe('bakeUtilities report seed', () => {
    it('is the seed of the version and input that ran', async () => {
        const { tailwind } = await node.bakeUtilities({ classes: ['p-4'], tailwind: injected('4.3.1') })
        expect(tailwind.seed).toBe(tailwindSeed('4.3.1', tailwind.input))
        expect(tailwind.input).toBe(TAILWIND_ENGINE_INPUT)
    })

    it('is null when the pass did not run or the version is unknown', async () => {
        expect((await node.bakeUtilities({ classes: [] })).tailwind.seed).toBe(null)
        expect((await node.bakeUtilities({ classes: ['p-4'], tailwind: injected(undefined) })).tailwind.seed).toBe(null)
        expect((await node.bakeUtilities({ classes: ['p-4'], tailwind: { engine: {} } })).tailwind.seed).toBe(null)
    })
})

describe('bake without the engine at runtime', () => {
    it('ships the @property initial values utilities compose with, and the fallback below utilities', async () => {
        const { css } = await node.bakeUtilities({ classes: ['shadow-md', 'skew-x-12', 'ring-2'], tailwind: injected('4.3.1') })
        for (const p of ['--tw-shadow', '--tw-inset-shadow', '--tw-ring-offset-shadow', '--tw-skew-x']) expect(css).toMatch(new RegExp(`@property ${p} \\{`))
        expect(css).toContain('initial-value: 0 0 #0000;')
        expect(css).not.toContain('@layer properties')
        expect(css).toMatch(/@layer base \{\s*@supports[\s\S]*--tw-shadow: 0 0 #0000;/)
    })

    it('adds nothing for classes that need no properties', async () => {
        const { css } = await node.bakeUtilities({ classes: ['flex'], tailwind: injected('4.3.1') })
        expect(css).not.toContain('@property')
        expect(css).not.toContain('@supports')
    })
})

describe('utilitiesStamp', () => {
    const bake = (classes = ['flex', 'p-4', 'card'], version = '4.3.1') => node.bakeUtilities({ classes, tailwind: injected(version) })

    it('gives the link attributes and the tokens element', async () => {
        const result = await bake()
        const stamp = node.utilitiesStamp(result)
        expect(stamp.seed).toBe(tailwindSeed('4.3.1'))
        expect(stamp.mode).toBe('shadow')
        expect(stamp.tokens).toEqual(['card', 'flex', 'p-4'])
        expect(stamp.attributes).toEqual({ 'data-tailwind-stamp': stamp.seed, 'data-tailwind-mode': 'shadow' })
        expect(stamp.linkAttributes).toBe(`data-tailwind-stamp="${stamp.seed}" data-tailwind-mode="shadow"`)
        expect(stamp.tokensHtml).toBe(`<script type="application/json" data-tailwind-tokens>${JSON.stringify({ seed: stamp.seed, tokens: stamp.tokens })}</script>`)
        expect(node.utilitiesStamp(result, { mode: 'skip' }).linkAttributes).toContain('data-tailwind-mode="skip"')
    })

    it('includes safelisted tokens (everything Tailwind was shown)', async () => {
        const result = await node.bakeUtilities({ classes: ['p-4'], safelist: ['gap-2'], tailwind: injected('4.3.1') })
        expect(node.utilitiesStamp(result).tokens).toEqual(['gap-2', 'p-4'])
    })

    it('escapes "<" so a token cannot close the script element', async () => {
        const stamp = node.utilitiesStamp(await bake(['[&>p]:mt-2', 'content-["</script>"]']))
        const json = stamp.tokensHtml.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')
        expect(json).not.toContain('<')
        expect(JSON.parse(json).tokens).toEqual(['[&>p]:mt-2', 'content-["</script>"]'].sort())
    })

    it('is null for a pass that did not run, an unknown version or an author text/tailwindcss block', async () => {
        expect(node.utilitiesStamp(await node.bakeUtilities({ classes: [] }))).toBe(null)
        expect(node.utilitiesStamp(await bake(["p-4"], null))).toBe(null)
        expect(node.utilitiesStamp(null)).toBe(null)
        const result = await bake()
        expect(node.utilitiesStamp(result, { sources: ['<div class="p-4"></div>', '<style type="text/tailwindcss">@theme { --color-x: red; }</style>'] })).toBe(null)
        expect(node.utilitiesStamp(result, { sources: ["<style type='text/tailwindcss'></style>"] })).toBe(null)
        expect(node.utilitiesStamp(result, { sources: ['<style>.a{}</style>'] })).not.toBe(null)
    })

    it('refuses an altered report and an unknown mode', async () => {
        const result = await bake()
        expect(node.utilitiesStamp({ ...result, tailwind: { ...result.tailwind, input: result.tailwind.input + 'x' } })).toBe(null)
        expect(() => node.utilitiesStamp(result, { mode: 'on' })).toThrow(TypeError)
    })

    it('a 4.3.3 bake does not carry the loader\'s seed', async () => {
        expect(node.utilitiesStamp(await bake(undefined, '4.3.3')).seed).not.toBe(tailwindSeed(ENGINE))
    })
})

describe('inlining shared modules into bundles', () => {
    it('strips every export declaration form', () => {
        const src = 'export const A = 1;\nexport let b = 2;\nexport var c = 3;\nexport function d() {}\nexport async function e() {}\nexport function* f() {}\nexport class G {}\n'
        expect(inlineSubscript('x.mjs', src)).toBe('const A = 1;\nlet b = 2;\nvar c = 3;\nfunction d() {}\nasync function e() {}\nfunction* f() {}\nclass G {}\n')
    })

    it('refuses forms it cannot inline instead of shipping them', () => {
        expect(() => inlineSubscript('x.mjs', 'const a = 1;\nexport { a };\n')).toThrow(/cannot inline/)
        expect(() => inlineSubscript('x.mjs', 'export default 1;\n')).toThrow(/cannot inline/)
        expect(() => inlineSubscript('x.mjs', "export * from './y.mjs';\n")).toThrow(/cannot inline/)
    })

    it('leaves .js subscripts alone', () => {
        expect(inlineSubscript('x.js', 'export const a = 1;')).toBe('export const a = 1;')
    })

    it('the browser bundles carry the seed function bare', () => {
        for (const f of ['manifest.utilities.js']) {
            const text = readFileSync(join(LIB, f), 'utf8')
            expect(text).toContain('function tailwindSeed(')
            expect(text).not.toMatch(/^export\b/m)
        }
    })
})
