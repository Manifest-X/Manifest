/**
 * @vitest-environment happy-dom
 *
 * Runtime discovery: classes only in an inserted element's :class binding are
 * compiled, and a class that arrives while a full compile is awaiting the theme
 * is not marked applied without a rule.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let compiler
const css = () => compiler.styleElement.textContent + '\n' + (compiler._applied ? compiler._applied.entries.map(e => e.rule).join('\n') : '')

beforeAll(async () => {
    document.head.innerHTML = '<style id="theme-vars">:root { --color-brand: #f00; --color-accent: #0f0; --color-positive-content: green; --color-negative-content: red; --color-warn: orange; }</style>'
    document.body.innerHTML = '<div class="text-brand"></div>'
    window.tailwind = {}
    window.ManifestComponentsRegistry = { manifest: {} }
    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc))
    await ready
    compiler = window.ManifestUtilities
    await wait(300)
})

describe('utilities runtime discovery', () => {
    it('compiles both branches of an inserted :class binding before either is applied', async () => {
        const el = document.createElement('p')
        el.setAttribute(':class', "ok ? 'text-positive-content' : 'text-negative-content'")
        document.body.appendChild(el)
        await wait(400)
        expect(css()).toMatch(/\.text-positive-content \{/)
        expect(css()).toMatch(/\.text-negative-content \{/)
    })

    it('a class seen mid-compile still gets its rule', async () => {
        const orig = compiler.fetchThemeContent
        compiler.fetchThemeContent = async function () { await wait(300); return orig.call(this) }
        compiler._applied = null // full-compile path
        try {
            const first = document.createElement('p')
            first.className = 'bg-accent'
            document.body.appendChild(first)
            await wait(150)
            const late = document.createElement('p')
            late.className = 'text-warn'
            document.body.appendChild(late)
            await wait(1800)
            expect(css()).toMatch(/\.bg-accent \{/)
            expect(css()).toMatch(/\.text-warn \{/)
        } finally {
            compiler.fetchThemeContent = orig
        }
    })
})
