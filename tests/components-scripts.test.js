/**
 * @vitest-environment happy-dom
 *
 * Scripts inside component files: classic inline scripts run in global scope,
 * inline modules become real module scripts (imports resolve through the
 * page's import map, once per page), and data blocks are dropped unrun.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const COMPONENTS = {
    classic: '<div class="classic">x</div><script>window.__classicRuns = (window.__classicRuns || 0) + 1</script>',
    typed: '<div class="typed">x</div><script type="text/javascript">window.__typedRuns = (window.__typedRuns || 0) + 1</script>',
    modular: '<div class="modular">x</div><script type="module">import { a } from "@app/a.js"; window.__mod = a</script>',
    external: '<div class="external">x</div><script type="module" src="/app/widget.js"></script>',
    data: '<div class="data">x</div><script type="application/json" id="cfg">{"a":1}</script>',
    leading: '<script type="application/json">{"a":1}</script><div class="lead" x-text="label"></div>',
    legacy: '<div class="legacy">x</div><script type="text/javascript1.5">window.__legacyRuns = (window.__legacyRuns || 0) + 1</script>'
}
window.Alpine = Alpine
window.ManifestComponentsRegistry = { registered: new Set(Object.keys(COMPONENTS)) }
window.ManifestComponentsLoader = { async loadComponent(name) { return COMPONENTS[name] || null } }

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/components/manifest.components.processor.js'), 'utf8')
))
const processor = window.ManifestComponentsProcessor

const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

async function mount(name) {
    const host = document.createElement('div')
    host.setAttribute('x-data', '')
    host.innerHTML = `<x-${name}></x-${name}>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    await processor.processComponent(host.querySelector(`x-${name}`))
    await settle()
    return host
}

beforeEach(() => {
    document.body.innerHTML = ''
    document.head.querySelectorAll('script').forEach((s) => s.remove())
    delete window.__classicRuns
    delete window.__typedRuns
    delete window.__legacyRuns
})

describe('component scripts', () => {
    it('runs a classic inline script', async () => {
        await mount('classic')
        expect(window.__classicRuns).toBe(1)
    })

    it('runs an explicitly typed classic inline script', async () => {
        await mount('typed')
        expect(window.__typedRuns).toBe(1)
    })

    it('injects an inline module as a module script instead of evaluating it', async () => {
        const errors = []
        const orig = console.error
        console.error = (...a) => { errors.push(a.join(' ')); }
        try { await mount('modular') } finally { console.error = orig }
        const injected = [...document.head.querySelectorAll('script[type="module"]')]
        expect(injected).toHaveLength(1)
        expect(injected[0].textContent).toContain('import { a } from "@app/a.js"')
        expect(errors.filter((e) => e.includes('Error executing script'))).toHaveLength(0)
    })

    it('keeps an external module script a module', async () => {
        await mount('external')
        const s = document.head.querySelector('script[src="/app/widget.js"]')
        expect(s).not.toBeNull()
        expect(s.type).toBe('module')
    })

    it('drops data blocks without running them', async () => {
        const errors = []
        const orig = console.error
        console.error = (...a) => { errors.push(a.join(' ')) }
        let host
        try { host = await mount('data') } finally { console.error = orig }
        expect(host.querySelector('script')).toBeNull()
        expect(host.querySelector('.data')).not.toBeNull()
        expect(errors).toHaveLength(0)
    })

    it('a leading data block never becomes the component root', async () => {
        const host = document.createElement('div')
        host.setAttribute('x-data', '')
        host.innerHTML = '<x-leading x-data="{ label: \'hi\' }" class="p-4"></x-leading>'
        document.body.appendChild(host)
        Alpine.initTree(host)
        await processor.processComponent(host.querySelector('x-leading'))
        await settle()
        const lead = host.querySelector('.lead')
        expect(lead.classList.contains('p-4')).toBe(true)
        expect(lead.textContent).toBe('hi')
    })

    it('runs legacy JavaScript MIME types as classic scripts', async () => {
        await mount('legacy')
        expect(window.__legacyRuns).toBe(1)
    })

    it('injects a given inline module once however many instances render', async () => {
        await mount('modular')
        await mount('modular')
        expect(document.head.querySelectorAll('script[data-component-module]')).toHaveLength(1)
    })
})
