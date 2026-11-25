/**
 * @vitest-environment happy-dom
 *
 * Framework web component tags (x-code, x-code-group) live in one list, the loader's
 * frameworkTags; the processor and the route prefetch both read it.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUB = (f) => readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'components', f), 'utf8')

let fetched
globalThis.fetch = async (url) => {
    const pathname = String(url).split('?')[0]
    fetched.push(pathname)
    return { ok: true, status: 200, text: async () => `<div>${pathname}</div>` }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms))

beforeAll(() => {
    window.__manifestLoaded = { components: [] }
    for (const f of ['registry', 'loader', 'processor', 'prefetch']) new Function(SUB(`manifest.components.${f}.js`))()
})

beforeEach(async () => {
    fetched = []
    document.body.innerHTML = ''
    const loader = window.ManifestComponentsLoader
    loader.cache = {}; loader._loading = {}; loader._raw = {}; loader._missing = new Set()
    loader.frameworkTags = new Set(['code', 'code-group'])
    await window.ManifestComponentsRegistry.initialize()
})

async function process(tag) {
    const el = document.createElement(tag)
    document.body.appendChild(el)
    await window.ManifestComponentsProcessor.processComponent(el)
}

describe('framework component tags', () => {
    it('the processor never fetches x-code or x-code-group', async () => {
        await process('x-code')
        await process('x-code-group')
        expect(fetched).toEqual([])
    })

    it('the processor reads the loader list', async () => {
        window.ManifestComponentsLoader.frameworkTags.add('widget')
        await process('x-widget')
        expect(fetched).toEqual([])
        await process('x-card')
        expect(fetched).toEqual(['/components/card.html'])
    })

    it('the route prefetch reads the loader list', async () => {
        window.ManifestComponentsLoader.frameworkTags.add('widget')
        document.body.innerHTML = '<div x-route="docs"><x-widget></x-widget><x-code></x-code><x-panel></x-panel></div>'
        window.dispatchEvent(new CustomEvent('manifest:route-change', { detail: { normalizedPath: '/docs' } }))
        await wait(10)
        expect(fetched).toEqual(['/components/panel.html'])
    })
})
