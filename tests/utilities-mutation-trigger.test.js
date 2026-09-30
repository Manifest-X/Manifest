/**
 * @vitest-environment happy-dom
 *
 * Utilities JIT on a busy page: DOM additions only recompile when they bring a
 * class the compiler has not seen. Re-mounting an x-data subtree with known
 * classes (a detail pane re-rendering per row click) costs no compile, no
 * document scan and no per-node querySelector.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const counts = { qs: 0, compile: 0, scan: 0 }
const wrap = (proto, name) => { const orig = proto[name]; proto[name] = function () { counts.qs++; return orig.apply(this, arguments) } }
wrap(Element.prototype, 'querySelector')

let compiler
beforeAll(async () => {
    document.head.innerHTML = '<style id="theme-vars">:root { --color-brand: #ff0000; --color-accent: #00ff00; --spacing-4: 1rem; }</style>'
    document.body.innerHTML = '<div class="p-4 text-brand"></div>'
    window.tailwind = {}
    window.ManifestComponentsRegistry = { manifest: {} }
    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc))
    await ready
    compiler = window.ManifestUtilities
    const compile = compiler.compile.bind(compiler)
    compiler.compile = function () { counts.compile++; return compile() }
    const scan = compiler.getUsedClasses.bind(compiler)
    compiler.getUsedClasses = function () { counts.scan++; return scan() }
    await wait(300)
})
beforeEach(() => { counts.qs = 0; counts.compile = 0; counts.scan = 0 })

const detail = (cls) => `<div x-data class="col">${Array.from({ length: 40 }, (_, i) =>
    `<div x-data class="row ${cls}"><span class="p-4">field ${i}</span></div>`).join('')}</div>`

describe('utilities recompile trigger', () => {
    it('re-mounting x-data subtrees with known classes does not compile', async () => {
        const host = document.createElement('section')
        document.body.appendChild(host)
        host.innerHTML = detail('text-brand')
        await wait(300)
        counts.compile = 0; counts.scan = 0; counts.qs = 0
        for (let k = 0; k < 5; k++) {
            host.innerHTML = detail('text-brand')
            await wait(20)
        }
        await wait(300)
        expect(counts.compile).toBe(0)
        expect(counts.scan).toBe(0)
        expect(counts.qs).toBe(0)
    })

    it('a subtree bringing a new class compiles once and emits its rule', async () => {
        const host = document.createElement('section')
        document.body.appendChild(host)
        host.innerHTML = detail('hover:bg-accent')
        await wait(400)
        expect(counts.compile).toBeGreaterThanOrEqual(1)
        expect(counts.compile).toBeLessThanOrEqual(2)
        expect(document.getElementById('manifest-styles').textContent).toMatch(/hover\\:bg-accent:hover/)
    })

    it('a class attribute change to a new class compiles', async () => {
        const el = document.body.querySelector('.p-4')
        el.className = 'p-4 text-accent'
        await wait(400)
        expect(counts.compile).toBeGreaterThanOrEqual(1)
        expect(document.getElementById('manifest-styles').textContent).toMatch(/\.text-accent\s*\{/)
    })
})
