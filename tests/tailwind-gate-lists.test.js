/**
 * @vitest-environment node
 *
 * The engine-skip gate's build-stamped lists, checked against the engine itself (tailwindcss pinned to the
 * bundled engine's version, with Manifest's variants): every bare utility it lists emits a rule, no bare
 * name it leaves out emits one, and no framework class it excuses emits one.
 */
import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import { TAILWIND_ENGINE_INPUT } from '../src/scripts/manifest.tailwind.variants.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = process.env.STAMP_LIB || join(repo, 'lib')
const require = createRequire(import.meta.url)
const tw = require('tailwindcss')
const bundle = readFileSync(join(LIB, 'manifest.utilities.js'), 'utf8')
const list = (name) => JSON.parse(bundle.match(new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\);`))[1])
const ds = await tw.__unstable__loadDesignSystem(TAILWIND_ENGINE_INPUT, {
    base: '/',
    loadStylesheet: async (id) => ({ base: '/', content: readFileSync(require.resolve(id === 'tailwindcss/theme' ? 'tailwindcss/theme.css' : 'tailwindcss/utilities.css'), 'utf8') })
})
const emits = (tokens) => ds.candidatesToCss(tokens).map(Boolean)

describe('engine-skip gate lists', () => {
    const bare = list('TAILWIND_BARE_UTILITIES')
    const framework = list('FRAMEWORK_CLASSES')

    it('are stamped', () => {
        expect(bare.length).toBeGreaterThan(30)
        expect(framework.length).toBeGreaterThan(50)
        for (const t of ['flex', 'hidden', 'block', 'grid', 'container', 'truncate', 'shadow', 'rounded', 'grow']) expect(bare).toContain(t)
        for (const t of ['tabs-wrapper', 'color-icon-solid', 'toast-entry']) expect(framework).toContain(t)
    })

    it('every listed bare utility emits a rule', () => {
        const hits = emits(bare)
        expect(bare.filter((t, i) => !hits[i])).toEqual([])
    })

    it('no bare name outside the list emits a rule (every root the engine knows)', () => {
        const roots = new Set()
        for (const [c] of ds.getClassList()) for (const r of [c, c.replace(/^-/, '').split('-')[0]]) if (r && !/[-:[\/!.]/.test(r)) roots.add(r)
        const extra = [...roots].filter(r => !bare.includes(r))
        const hits = emits(extra)
        expect(extra.filter((t, i) => hits[i])).toEqual([])
        const words = ['iconify', 'prompt', 'card', 'row', 'col', 'toast', 'dark', 'group', 'peer', 'false']
        const wordHits = emits(words)
        expect(words.filter((t, i) => wordHits[i])).toEqual([])
    })

    it('no excused framework class emits a rule', () => {
        const hits = emits(framework)
        expect(framework.filter((t, i) => hits[i])).toEqual([])
    })

    it('framework classes holding a Tailwind name are not excused', () => {
        for (const t of ['hidden', 'flex', 'truncate', 'sr-only']) expect(framework).not.toContain(t)
    })
})
