/**
 * @vitest-environment happy-dom
 *
 * Standing proof of Tailwind variant coverage — Andrew's requirement: "the
 * plugin is only as good as its comprehensive coverage of Tailwind classes
 * and all their variants." Table-driven so adding a class is one line.
 *
 * For every corpus member, asserts the full loop that has broken twice
 * before (see git log: nested @layer/@media, whitespace-before-@-rule):
 *   (a) scanClasses on markup containing it returns the exact token
 *   (b) compileUtilities emits a rule whose selector maps back to it
 *   (c) the runtime's classNamesFromCssText, fed that same baked output,
 *       reports it covered — i.e. bake and skip agree.
 *
 * (b) and (c) are deliberately two different parsers/checks: (b) is a plain
 * string/escape check against compileUtilities' own output; (c) round-trips
 * that same output through the browser runtime's independent CSS parser.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll } from 'vitest'
import { compileUtilities, scanClasses } from '../lib/manifest.utilities.node.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

// [family, class token] — at least one family member per required family,
// several members in the larger ones. Add a class by adding one line here.
const CORPUS = [
    // Responsive
    ['responsive', 'sm:flex'],
    ['responsive', 'md:grid'],
    ['responsive', 'lg:hidden'],
    ['responsive', 'xl:block'],
    ['responsive', '2xl:inline-flex'],
    // State
    ['state', 'hover:bg-blue-500'],
    ['state', 'focus:ring-2'],
    ['state', 'active:scale-95'],
    ['state', 'disabled:opacity-50'],
    ['state', 'focus-visible:outline-2'],
    ['state', 'focus-within:border-blue-500'],
    // Group/peer, including named
    ['group-peer', 'group-hover:opacity-100'],
    ['group-peer', 'group-hover/avatar:opacity-100'],
    ['group-peer', 'peer-checked:bg-blue-500'],
    ['group-peer', 'group-focus-within:ring-2'],
    // Dark mode
    ['dark', 'dark:bg-gray-900'],
    ['dark', 'dark:text-white'],
    // Motion
    ['motion', 'motion-safe:transition'],
    ['motion', 'motion-reduce:transition-none'],
    // Structural pseudo-classes
    ['structural', 'first:mt-0'],
    ['structural', 'last:mb-0'],
    ['structural', 'odd:bg-gray-50'],
    ['structural', 'even:bg-white'],
    ['structural', 'only:mx-auto'],
    // Pseudo-elements
    ['pseudo-element', "before:content-['*']"],
    ['pseudo-element', "after:content-['']"],
    ['pseudo-element', 'placeholder:text-gray-400'],
    ['pseudo-element', 'selection:bg-yellow-200'],
    ['pseudo-element', 'marker:text-red-500'],
    ['pseudo-element', 'file:mr-4'],
    // aria-*/data-* variants
    ['aria-data', 'aria-checked:bg-blue-500'],
    ['aria-data', 'aria-[sort=ascending]:bg-blue-500'],
    ['aria-data', 'data-[state=open]:bg-green-500'],
    ['aria-data', 'data-[disabled]:opacity-50'],
    // Arbitrary values
    ['arbitrary-value', 'w-[37px]'],
    ['arbitrary-value', 'bg-[#123456]'],
    ['arbitrary-value', 'grid-cols-[1fr_auto]'],
    // Arbitrary variants
    ['arbitrary-variant', '[&_svg]:size-4'],
    ['arbitrary-variant', '[&>*]:min-h-0'],
    ['arbitrary-variant', '[&_p:last-child]:mb-0'],
    // Stacked variants
    ['stacked', "dark:hover:[&_.pill]:shadow-[inset_0_0_0_2rem_rgb(0_0_0/0.10)]"],
    // Important
    ['important', '!text-xs'],
    ['important', 'dark:!bg-pink-900'],
    // Negatives
    ['negative', '-space-x-2'],
    ['negative', '-mt-1'],
    // Fractions/slashes
    ['fraction-slash', 'w-1/2'],
    ['fraction-slash', 'bg-black/50'],
    // size-*
    ['size', 'size-4'],
    ['size', 'size-1/2'],
]

// CSS.escape-style selector escaping (mirrors utilities-node-compile.test.js's
// helper), extended for a leading digit: an identifier can't start with a bare
// digit, so CSS.escape (and the real Tailwind engine) hex-escape it instead —
// `2xl:inline-flex` bakes as `.\32 xl\:inline-flex`, not `.2xl\:inline-flex`.
const escapeSelector = (cls) => {
    let out = '.'
    for (let i = 0; i < cls.length; i++) {
        const ch = cls[i]
        if (i === 0 && /[0-9]/.test(ch)) out += '\\' + ch.codePointAt(0).toString(16) + ' '
        else if (/[!"#$%&'()*+,./:;<=>?@[\]^`{|}~]/.test(ch)) out += '\\' + ch
        else out += ch
    }
    return out
}

describe(`Tailwind variant corpus (${CORPUS.length} classes across ${new Set(CORPUS.map(c => c[0])).size} families)`, () => {
    let bakedCss
    let compiler

    beforeAll(async () => {
        const classes = CORPUS.map(([, cls]) => cls)
        bakedCss = await compileUtilities({ classes })
        expect(bakedCss).not.toBe('') // sanity: the corpus actually baked to something

        document.head.innerHTML = ''
        document.body.innerHTML = '<div></div>'
        window.tailwind = {} // isTailwindAvailable() true immediately — skip the 5s poll
        window.ManifestComponentsRegistry = { manifest: {} } // skip the 2s registry wait
        delete window.__manifestUtilitiesReady
        window.__manifestUtilitiesPending = 0
        const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
        const nonce = `\n//boot:${Math.random()}`
        await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
        await ready
        compiler = window.ManifestUtilities
    })

    it.each(CORPUS)('%s: %s — scanClasses finds the exact token', (family, cls) => {
        const html = `<div class="${cls}"></div>`
        expect(scanClasses(html)).toContain(cls)
    })

    it.each(CORPUS)('%s: %s — compileUtilities emits a rule whose selector maps back to it', (family, cls) => {
        expect(bakedCss).toContain(escapeSelector(cls))
    })

    it.each(CORPUS)('%s: %s — the runtime parser reports it covered (bake and skip agree)', (family, cls) => {
        const covered = compiler.classNamesFromCssText(bakedCss)
        expect(covered.has(cls)).toBe(true)
    })
})
