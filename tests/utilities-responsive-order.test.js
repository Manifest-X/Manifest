/**
 * @vitest-environment happy-dom
 *
 * @media utilities follow Tailwind v4 order, not theme-variable or class order:
 * early media (motion-*, contrast-*), then max-* widest first, then min-width
 * ascending, then other media. The order key drives full compile, incremental
 * placement and the node bake alike.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Variables declared in reverse of breakpoint order, so var order alone would emit lg before md
const THEME = ':root { --color-a: red; --color-b: blue; --color-c: green; --color-d: gold; }'
const CUSTOM = '.lead-a { line-height: 10px } .lead-b { line-height: 20px }'

let compiler, compileUtilities

beforeAll(async () => {
    document.head.innerHTML = `<style>${THEME}</style>`
    window.tailwind = {}
    window.ManifestComponentsRegistry = { manifest: {} }
    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc))
    await ready
    compiler = window.ManifestUtilities
    await wait(200)
    for (const [k, v] of compiler.extractCustomUtilities(CUSTOM)) compiler.customUtilities.set(k, v)
    ;({ compileUtilities } = await import('../lib/manifest.utilities.node.mjs'))
})

afterEach(() => vi.restoreAllMocks())

const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0 }
const order = (css, needles) => needles.map(n => { const i = css.indexOf(n); expect(i, n).toBeGreaterThan(-1); return i })
const ascending = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x)

describe('responsive @media order', () => {
    it('md:text-b lg:text-a emits md before lg whatever the variable order', async () => {
        const css = await compileUtilities({ classes: ['md:text-b', 'lg:text-a'], themeCss: THEME })
        expect(ascending(order(css, ['.md\\:text-b', '.lg\\:text-a']))).toBe(true)
    })

    it('Tailwind order: early media, max-* widest first, min-width ascending (arbitrary sizes by value), other media last', async () => {
        const classes = ['print:text-a', 'xl:text-a', 'lg:text-a', 'min-[900px]:text-b', 'md:text-b', 'max-md:text-b',
            'max-[50rem]:text-a', 'max-lg:text-a', 'motion-reduce:text-b', 'sm:text-c', 'min-xl:text-d']
        const css = await compileUtilities({ classes, themeCss: THEME })
        expect(ascending(order(css, ['.motion-reduce\\:text-b', '.max-lg\\:text-a', '.max-\\[50rem\\]\\:text-a', '.max-md\\:text-b',
            '.sm\\:text-c', '.md\\:text-b', '.min-\\[900px\\]\\:text-b', '.lg\\:text-a', '.xl\\:text-a', '.print\\:text-a']))).toBe(true)
        expect(css.indexOf('.min-xl\\:text-d')).toBeGreaterThan(css.indexOf('.lg\\:text-a'))
    })

    it('stacked md:max-lg: sits after md: and before lg:', async () => {
        const css = await compileUtilities({ classes: ['lg:text-a', 'md:max-lg:text-b', 'md:text-c'], themeCss: THEME })
        expect(ascending(order(css, ['.md\\:text-c', '.md\\:max-lg\\:text-b', '.lg\\:text-a']))).toBe(true)
    })

    it('an extra lower-order media variant sorts after the bare breakpoint (motion-safe:md: after md:)', async () => {
        const css = await compileUtilities({ classes: ['motion-safe:md:text-a', 'md:text-b', 'lg:text-c'], themeCss: THEME })
        expect(ascending(order(css, ['.md\\:text-b', '.motion-safe\\:md\\:text-a', '.lg\\:text-c']))).toBe(true)
    })

    it('a range plus a later media variant sorts with that media (print:md: after lg:)', async () => {
        const css = await compileUtilities({ classes: ['print:md:text-b', 'lg:text-a'], themeCss: THEME })
        expect(ascending(order(css, ['.lg\\:text-a', '.print\\:md\\:text-b']))).toBe(true)
    })

    it('theme and custom utilities interleave by breakpoint', async () => {
        const css = await compileUtilities({ classes: ['lg:text-a', 'md:lead-b', 'xl:lead-a', 'sm:text-d'], themeCss: THEME + '\n' + CUSTOM })
        expect(ascending(order(css, ['.sm\\:text-d', '.md\\:lead-b', '.lg\\:text-a', '.xl\\:lead-a']))).toBe(true)
    })

    it('other at-rules follow Tailwind: breakpoints, container sizes, portrait, starting, print, forced-colors', async () => {
        const classes = ['forced-colors:text-a', 'print:text-b', 'starting:text-c', 'portrait:text-d', '@md:text-a', '@max-md:text-b', '@sm:text-c', 'lg:text-d', 'md:text-a']
        const css = await compileUtilities({ classes, themeCss: THEME })
        expect(ascending(order(css, ['.md\\:text-a', '.lg\\:text-d', '.\\@max-md\\:text-b', '.\\@sm\\:text-c', '.\\@md\\:text-a',
            '.portrait\\:text-d', '.starting\\:text-c', '.print\\:text-b', '.forced-colors\\:text-a']))).toBe(true)
    })

    it('Manifest media aliases sort with their Tailwind equivalents (touch = pointer-coarse after print)', async () => {
        const css = await compileUtilities({ classes: ['touch:text-a', 'print:text-b', 'prefers-reduced-motion:text-c', 'md:text-d'], themeCss: THEME })
        expect(ascending(order(css, ['.prefers-reduced-motion\\:text-c', '.md\\:text-d', '.print\\:text-b', '.touch\\:text-a']))).toBe(true)
    })

    it('bare supports: emits no condition-less @supports rule (browsers drop it, which disabled delta apply)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        const css = await compileUtilities({ classes: ['supports:text-a', 'md:text-b'], themeCss: THEME })
        expect(css).not.toContain('@supports')
        expect(css).toContain('.md\\:text-b')
        expect(warn.mock.calls.some(c => c.join(' ').includes('supports'))).toBe(true)
    })

    it('base rules stay before every @media rule', async () => {
        const css = await compileUtilities({ classes: ['md:text-a', 'text-d', 'hover:text-b', 'lead-a'], themeCss: THEME + '\n' + CUSTOM })
        const lastBase = Math.max(css.indexOf('.text-d {'), css.indexOf('.hover\\:text-b:hover'))
        expect(lastBase).toBeLessThan(css.indexOf('@media'))
    })
})

describe('order keys', () => {
    const ALL = ['xl:text-a', 'lg:text-b', 'md:text-c', 'sm:text-d', 'max-lg:text-a', 'max-sm:text-b', 'md:max-lg:text-d',
        'min-[900px]:text-a', 'text-a', 'hover:text-b', 'md:lead-a', 'lg:lead-b', 'print:text-c', 'motion-safe:text-d',
        '@md:text-a', '@sm:text-b', 'portrait:text-c', 'starting:text-d', 'forced-colors:text-a', 'print:md:text-b']

    it('the live compiler and the node bake write the same order', async () => {
        const live = compiler.orderedUtilitiesCss(compiler.generateOrderedUtilities(THEME, { classes: ALL, variableSuffixes: [] }))
        const baked = await compileUtilities({ classes: ALL, themeCss: THEME + '\n' + CUSTOM })
        const sel = (css) => (css.match(/\.[a-z0-9\\[\]:-]+(?= \{|:hover)/g) || [])
        expect(sel(baked)).toEqual(sel(live))
    })

    it('keys are uniform, sorted, and carry each at-rule variant\'s order', () => {
        const entries = compiler.generateKeyedUtilities(THEME, ALL)
        expect(new Set(entries.map(e => e.key.length))).toEqual(new Set([9]))
        expect(entries.every((e, i) => i === 0 || cmp(entries[i - 1].key, e.key) <= 0)).toBe(true)
        const key = (needle) => entries.find(e => e.rule.includes(needle)).key
        const BP = 10e7, NO = -1e9
        expect(key('.md\\:text-c').slice(0, 4)).toEqual([1, BP + 768, NO, NO])
        expect(key('.max-sm\\:text-b').slice(0, 2)).toEqual([1, BP - 640])
        expect(key('.md\\:max-lg\\:text-d').slice(0, 3)).toEqual([1, BP + 768, BP - 1024])
        expect(key('.min-\\[900px\\]\\:text-a')[1]).toBe(BP + 900)
        expect(key('.motion-safe\\:text-d')[1]).toBe(1e7)
        expect(key('.\\@sm\\:text-b')[1]).toBe(20e7 + 384)
        expect(key('.print\\:md\\:text-b').slice(0, 3)).toEqual([1, 25e7, BP + 768])
        expect(key('.text-a {').slice(0, 4)).toEqual([0, 0, 0, 0])
    })

    it('placing a later class set by key reproduces the full regen (the order compileDelta inserts by)', () => {
        const full = compiler.generateKeyedUtilities(THEME, ALL).map(e => e.rule)
        // Discovery order the reverse of breakpoint order, one class at a time
        const live = []
        for (const cls of ALL.slice().reverse()) {
            for (const e of compiler.generateKeyedUtilities(THEME, [cls])) {
                if (live.some(x => x.rule === e.rule)) continue
                let at = live.length
                while (at > 0 && cmp(live[at - 1].key, e.key) > 0) at--
                live.splice(at, 0, e)
            }
        }
        expect(live.map(e => e.rule)).toEqual(full)
    })
})

describe('utilities cache', () => {
    it('a sheet cached under the pre-order key is dropped, not replayed', () => {
        localStorage.setItem('tailwind-cache', JSON.stringify({ 'x-y': { css: '@layer utilities {\n.stale { color: red }\n}', timestamp: Date.now() } }))
        compiler.cache = new Map()
        compiler.loadPersistentCache()
        expect(localStorage.getItem('tailwind-cache')).toBeNull()
        expect([...compiler.cache.values()].some(v => v.css.includes('.stale'))).toBe(false)
    })
})
