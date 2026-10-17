/**
 * @vitest-environment happy-dom
 *
 * Prerendered pages with components as the sole child of x-if/x-for: baked
 * output (markPrerenderedManifestComponents + clone tags) booted through the
 * real loader reconcile, Alpine and the components mutation observer, then
 * toggled/reordered. Template content must never carry data-pre-rendered, or
 * runtime clones stay unswapped placeholders.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = (f) => readFileSync(path.join(__dirname, '../src/scripts/', f), 'utf8')
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await tick() }
// render.mjs has a shebang the happy-dom transform rejects; lift the function out.
const renderSrc = src('manifest.render.mjs')
const markStart = renderSrc.indexOf('function markPrerenderedManifestComponents(')
const markPrerenderedManifestComponents = new Function(
    renderSrc.slice(markStart, renderSrc.indexOf('\n}\n', markStart) + 2) + 'return markPrerenderedManifestComponents'
)()

const COMPONENTS = {
    support: '<div class="support"><span>help</span></div>',
    pair: '<p class="first">a</p><p class="second">b</p>',
    card: '<article class="card"><h3 x-text="item.name"></h3></article><script>window.__cardScriptRuns = (window.__cardScriptRuns || 0) + 1</script>'
}

// What mnfst-render bakes for the page below: swapped components, x-if clones
// tagged via _x_currentIfEl, x-for clones via _x_lookup.
const BAKED = `<div id="root" x-data="window.__state">
<template x-if="show"><x-support></x-support></template><div class="support" data-component="support-1" data-mnfst-prerender-clone="1"><span>help</span></div>
<template x-if="show"><x-pair></x-pair></template><x-pair data-processed="" style="display: contents;" data-mnfst-prerender-clone="1"><p class="first">a</p><p class="second">b</p></x-pair>
<section><template x-for="item in items" :key="item.id"><x-card></x-card></template><article class="card" data-mnfst-prerender-clone="1"><h3>one</h3></article><article class="card" data-mnfst-prerender-clone="1"><h3>two</h3></article></section>
</div>`

async function boot(html) {
    window.__state = Alpine.reactive({ show: true, items: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] })
    document.body.innerHTML = html
    // Loader's alpine:init listener is once-only; re-run it per boot.
    new Function(src('manifest.js'))()
    document.dispatchEvent(new Event('alpine:init'))
    Alpine.initTree(document.getElementById('root'))
    document.dispatchEvent(new Event('alpine:initialized'))
    await settle()
    return document.getElementById('root')
}

beforeAll(async () => {
    window.Alpine = Alpine
    window.__manifestLoaderStarted = true
    window.__manifestReady = true
    window.ManifestComponentsRegistry = { registered: new Set(Object.keys(COMPONENTS)) }
    window.ManifestComponentsLoader = { async loadComponent(name) { return COMPONENTS[name] || null } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    for (const f of ['components/manifest.components.processor.js', 'components/manifest.components.mutation.js']) {
        await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(src(f)))
    }
    window.ManifestComponentsMutation.initialize()
})

beforeEach(() => { document.body.innerHTML = '' })

async function exercise(root) {
    const state = window.__state
    const names = () => Array.from(root.querySelectorAll('.card h3')).map((h) => h.textContent)

    // First load: baked x-if clones adopted, x-for re-rendered and swapped.
    expect(root.querySelectorAll('.support')).toHaveLength(1)
    expect(root.querySelectorAll('.first')).toHaveLength(1)
    expect(names()).toEqual(['one', 'two'])
    expect(root.querySelectorAll('[data-pre-rendered]:empty')).toHaveLength(0)

    state.show = false
    await settle()
    expect(root.querySelectorAll('.support')).toHaveLength(0)
    expect(root.querySelectorAll('.first, .second')).toHaveLength(0)

    state.show = true
    await settle()
    expect(root.querySelectorAll('.support')).toHaveLength(1)
    expect(root.querySelectorAll('.first')).toHaveLength(1)
    expect(root.querySelector('x-support, x-pair:empty, x-card')).toBeNull()

    state.items = [...state.items].reverse()
    await settle()
    expect(names()).toEqual(['two', 'one'])

    state.items = state.items.slice(1)
    await settle()
    expect(names()).toEqual(['one'])
}

describe('prerendered components under x-if/x-for', () => {
    it('render leaves x-if/x-for template content unmarked', () => {
        const out = markPrerenderedManifestComponents(BAKED)
        expect(out).toContain('<template x-if="show"><x-support></x-support></template>')
        expect(out).toContain('<template x-for="item in items" :key="item.id"><x-card></x-card></template>')
        expect(markPrerenderedManifestComponents('<x-support></x-support>')).toBe('<x-support data-pre-rendered="1"></x-support>')
    })

    it('toggles and reorders after boot (current render output)', async () => {
        const root = await boot(markPrerenderedManifestComponents(BAKED))
        await exercise(root)
    })

    it('toggles and reorders after boot (older render output marked template content)', async () => {
        const legacy = markPrerenderedManifestComponents(BAKED)
            .replace(/<x-(support|pair|card)><\/x-\1><\/template>/g, '<x-$1 data-pre-rendered="1"></x-$1></template>')
        expect(legacy).toContain('<x-card data-pre-rendered="1"></x-card></template>')
        const root = await boot(legacy)
        await exercise(root)
    })
})
