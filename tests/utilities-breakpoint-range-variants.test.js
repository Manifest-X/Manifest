/**
 * @vitest-environment node
 *
 * Tailwind v4 breakpoint ranges: max-*, min-*, min-/max-[size], and stacked
 * at-rule variants (md:max-lg:) nest instead of the last one winning.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { compileUtilities } from '../lib/manifest.utilities.node.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const THEME_CSS = ':root { --color-brand: blue; }'

async function compile(classes, opts = {}) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
    const css = await compileUtilities({ classes, themeCss: THEME_CSS, ...opts })
    const warnings = warn.mock.calls.map(c => c.join(' '))
    return { css, warnings }
}

afterEach(() => vi.restoreAllMocks())

describe('breakpoint range variants', () => {
    it('max-<bp> is width below the breakpoint, for every named breakpoint', async () => {
        const bps = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 }
        const { css, warnings } = await compile(Object.keys(bps).map(bp => `max-${bp}:text-brand`))
        for (const [bp, px] of Object.entries(bps)) {
            expect(css).toContain(`@media (width < ${px}px) { .max-${bp}\\:text-brand { color: var(--color-brand) } }`)
        }
        expect(warnings.filter(w => w.includes('Unknown variant'))).toEqual([])
    })

    it('min-<bp> matches the bare breakpoint', async () => {
        const { css, warnings } = await compile(['min-lg:text-brand'])
        expect(css).toContain('@media (width >= 1024px) { .min-lg\\:text-brand { color: var(--color-brand) } }')
        expect(warnings).toEqual([])
    })

    it('arbitrary min-[size] and max-[size]', async () => {
        const { css, warnings } = await compile(['max-[600px]:text-brand', 'min-[30rem]:text-brand'])
        expect(css).toContain('@media (width < 600px) { .max-\\[600px\\]\\:text-brand')
        expect(css).toContain('@media (width >= 30rem) { .min-\\[30rem\\]\\:text-brand')
        expect(warnings).toEqual([])
    })

    it('stacked md:max-lg: nests both conditions', async () => {
        const { css } = await compile(['md:max-lg:text-brand'])
        expect(css).toContain('@media (min-width: 768px) { @media (width < 1024px) { .md\\:max-lg\\:text-brand { color: var(--color-brand) } } }')
    })

    it('a range variant composes with a state variant', async () => {
        const { css } = await compile(['max-md:hover:text-brand'])
        expect(css).toContain('@media (width < 768px) { .max-md\\:hover\\:text-brand:hover { color: var(--color-brand) } }')
    })

    it('max-<bp> on built-in display classes joins the ordered responsive block', async () => {
        const baseCss = fs.readFileSync(path.join(ROOT, 'lib', 'manifest.css'), 'utf8')
        const { css } = await compile(['max-lg:row', 'max-sm:row', 'lg:row'], { baseCss })
        const a = css.indexOf('.max-lg\\:row.max-lg\\:row { display: flex }')
        const b = css.indexOf('.max-sm\\:row.max-sm\\:row { display: flex }')
        const c = css.indexOf('.lg\\:row.lg\\:row { display: flex }')
        expect(a).toBeGreaterThan(-1)
        expect(b).toBeGreaterThan(a)
        expect(c).toBeGreaterThan(b)
        expect(css).toContain('@media (width < 1024px) { .max-lg\\:row.max-lg\\:row')
    })

    it('min-<bp> on display classes ranks like the bare breakpoint (md:row min-lg:hidden)', async () => {
        const baseCss = fs.readFileSync(path.join(ROOT, 'lib', 'manifest.css'), 'utf8')
        const { css } = await compile(['md:row', 'min-lg:hidden', 'min-sm:col'], { baseCss })
        const sm = css.indexOf('.min-sm\\:col.min-sm\\:col { display: flex }')
        const md = css.indexOf('.md\\:row.md\\:row { display: flex }')
        const lg = css.indexOf('.min-lg\\:hidden.min-lg\\:hidden { display: none }')
        expect(sm).toBeGreaterThan(-1)
        expect(md).toBeGreaterThan(sm)
        expect(lg).toBeGreaterThan(md)
        expect(css).toContain('@media (min-width: 1024px) { .min-lg\\:hidden.min-lg\\:hidden')
    })

    it('rejects arbitrary range values that could break out of the rule', async () => {
        const { css, warnings } = await compile(['max-[1px){}body{color:red}]:text-brand', 'min-[1px;x]:text-brand'])
        expect(css).not.toContain('color:red')
        expect(css).not.toMatch(/@media \(width [<>]=? 1px/)
        expect(warnings.filter(w => w.includes('Unknown variant')).length).toBe(2)
    })

    it('still warns for a genuinely unknown variant and emits no rule', async () => {
        const { css, warnings } = await compile(['max-huge:text-brand'])
        expect(css).not.toContain('max-huge')
        expect(warnings.some(w => w.includes('Unknown variant: max-huge'))).toBe(true)
    })
})
