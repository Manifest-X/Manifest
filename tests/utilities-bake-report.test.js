/**
 * @vitest-environment node
 *
 * bakeUtilities reports whether the Tailwind pass ran, with which engine version,
 * on which input and candidates; its css is compileUtilities' output.
 */
import { createRequire } from 'module'
import { describe, it, expect } from 'vitest'
import * as tailwindcss from 'tailwindcss'
import { readFileSync } from 'fs'
import { compileUtilities, bakeUtilities } from '../lib/manifest.utilities.node.mjs'
import { TAILWIND_CUSTOM_VARIANTS, TAILWIND_DARK_VARIANT } from '../src/scripts/manifest.tailwind.variants.mjs'

const require = createRequire(import.meta.url)
const VERSION = require('tailwindcss/package.json').version
const THEME_CSS = ':root { --color-brand: #f00; }'
const injected = (extra = {}) => ({
    engine: tailwindcss,
    themeCss: readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8'),
    utilitiesCss: readFileSync(require.resolve('tailwindcss/utilities.css'), 'utf8'),
    ...extra,
})

describe('bakeUtilities', () => {
    it('returns the same css as compileUtilities', async () => {
        const opts = { classes: ['p-4', 'text-brand', 'md:flex', 'w-[37px]'], themeCss: THEME_CSS, safelist: ['gap-2'] }
        const { css } = await bakeUtilities(opts)
        expect(css).toBe(await compileUtilities(opts))
        expect(css).toContain('.gap-2')
    })

    it('reports a pass that ran, its version, input and candidates', async () => {
        const { tailwind } = await bakeUtilities({ classes: ['p-4', 'flex', 'p-4'], safelist: ['gap-2'] })
        expect(tailwind.ran).toBe(true)
        expect(tailwind.emitted).toBe(true)
        expect(tailwind.reason).toBe(null)
        expect(tailwind.version).toBe(VERSION)
        expect(tailwind.candidates).toEqual(['flex', 'gap-2', 'p-4'])
        for (const v of [...TAILWIND_CUSTOM_VARIANTS, TAILWIND_DARK_VARIANT]) expect(tailwind.input).toContain(v)
        expect(tailwind.input.startsWith('@layer theme, base, components, utilities;\n')).toBe(true)
    })

    it('a pass that ran but matched nothing is still a pass', async () => {
        const { css, tailwind } = await bakeUtilities({ classes: ['row', 'not-a-utility'] })
        expect(tailwind).toMatchObject({ ran: true, emitted: false, reason: null, version: VERSION })
        expect(css).toBe(await compileUtilities({ classes: ['row', 'not-a-utility'] }))
    })

    it('no candidates: the pass is skipped', async () => {
        const { css, tailwind } = await bakeUtilities({ classes: [], themeCss: THEME_CSS })
        expect(tailwind).toMatchObject({ ran: false, emitted: false, reason: 'no-classes', candidates: [] })
        expect(css).toBe('')
    })

    it('an injected engine reports its given version', async () => {
        const { tailwind } = await bakeUtilities({ classes: ['flex'], tailwind: injected({ version: '9.9.9' }) })
        expect(tailwind).toMatchObject({ ran: true, emitted: true, version: '9.9.9' })
        const unversioned = await bakeUtilities({ classes: ['flex'], tailwind: injected() })
        expect(unversioned.tailwind).toMatchObject({ ran: true, version: null })
    })

    it('an unusable injected engine reports unavailable, with Manifest utilities still baked', async () => {
        const { css, tailwind } = await bakeUtilities({ classes: ['flex', 'text-brand'], themeCss: THEME_CSS, tailwind: { engine: {}, themeCss: '', utilitiesCss: '' } })
        expect(tailwind).toMatchObject({ ran: false, emitted: false, reason: 'unavailable', version: null })
        expect(css).toContain('.text-brand')
        expect(css).not.toContain('.flex')
    })

    it('an engine that throws reports error', async () => {
        const engine = { compile: async () => { throw new Error('boom') } }
        const { tailwind } = await bakeUtilities({ classes: ['flex'], tailwind: injected({ engine, version: '4.0.0' }) })
        expect(tailwind).toMatchObject({ ran: false, emitted: false, reason: 'error', version: '4.0.0' })
    })
})
