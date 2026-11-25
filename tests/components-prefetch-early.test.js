/**
 * @vitest-environment happy-dom
 *
 * Component HTML is fetched in one parallel round (and nested components as
 * soon as their parent's markup arrives), not one request per swap. Route-gated
 * placeholders wait for a router; framework tags are never fetched.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUB = (f) => readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'components', f), 'utf8')

const served = {
    '/components/header.html': '<header><x-logo></x-logo><x-admin x-route="admin"></x-admin><x-unlisted></x-unlisted></header>',
    '/components/logo.html': '<span class="logo">logo</span>',
    '/components/hero.html': '<section>hero</section>',
    '/components/footer.html': '<footer>footer</footer>',
    '/components/admin.html': '<div>admin</div>',
    '/components/layout.html': '<div x-route="admin"><section><x-admin></x-admin></section></div><!-- <x-footer></x-footer> --><template x-if="open"><x-hero></x-hero></template><p :class="a > b" title="x">t</p><x-logo></x-logo>',
}
let started, inFlight, maxInFlight
globalThis.fetch = async (url) => {
    const pathname = String(url).split('?')[0]
    started.push(pathname)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(r => setTimeout(r, 20))
    inFlight--
    const body = served[pathname]
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, text: async () => body ?? '' }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const count = (name) => started.filter(p => p === `/components/${name}.html`).length

beforeAll(() => {
    window.__manifestLoaded = { components: Object.keys(served).map(p => p.slice(1)) }
    new Function(SUB('manifest.components.registry.js'))()
    new Function(SUB('manifest.components.loader.js'))()
})

beforeEach(async () => {
    started = []; inFlight = 0; maxInFlight = 0
    delete window.ManifestRouting
    const loader = window.ManifestComponentsLoader
    loader.cache = {}; loader._loading = {}; loader._raw = {}; loader._missing = new Set()
    await window.ManifestComponentsRegistry.initialize()
})

const placeholders = (html) => {
    document.body.innerHTML = html
    return [...document.body.querySelectorAll('*')].filter(el => el.localName.startsWith('x-'))
}

describe('component prefetch', () => {
    it('fetches every placeholder in one parallel round', async () => {
        const loader = window.ManifestComponentsLoader
        loader.prefetchPlaceholders(placeholders('<x-hero></x-hero><x-footer></x-footer><x-hero></x-hero>'))
        await wait(5)
        expect(maxInFlight).toBe(2)
        await wait(60)
        expect(count('hero')).toBe(1)
        expect(count('footer')).toBe(1)
        expect(loader.cache.hero).toContain('hero')
    })

    it('fetches registered nested components when the parent markup arrives, skipping routed and unlisted tags', async () => {
        const loader = window.ManifestComponentsLoader
        await loader.loadComponent('header')
        expect(started).toEqual(['/components/header.html', '/components/logo.html'])
        await wait(40)
        expect(loader.cache.logo).toContain('logo')
        expect(count('admin')).toBe(0)
        expect(count('unlisted')).toBe(0)
    })

    it('nested prefetch skips components under a route-gated ancestor, in comments and in templates', async () => {
        const loader = window.ManifestComponentsLoader
        await loader.loadComponent('layout')
        await wait(40)
        expect(started).toEqual(['/components/layout.html', '/components/logo.html'])
    })

    it('exposes the markup as soon as it is fetched, before on-use modules finish loading', async () => {
        const loader = window.ManifestComponentsLoader
        let release
        window.Manifest = { loadUsed: () => new Promise(r => { release = r }) }
        try {
            const loading = loader.loadComponent('hero')
            const raw = await loader._raw.hero
            expect(raw).toContain('hero')
            expect(loader.cache.hero).toBeUndefined()
            release()
            expect(await loading).toContain('hero')
        } finally { delete window.Manifest }
        loader.loadComponent('missing-one')
        expect(await loader._raw['missing-one']).toBe(null)
    })

    it('leaves route-gated placeholders until a router can decide', async () => {
        const loader = window.ManifestComponentsLoader
        const els = placeholders('<x-hero></x-hero><div x-route="admin"><x-admin></x-admin></div><x-footer x-route="home"></x-footer>')
        loader.prefetchPlaceholders(els, () => 'swap')
        await wait(40)
        expect(count('hero')).toBe(1)
        expect(count('admin')).toBe(0)
        expect(count('footer')).toBe(0)

        window.ManifestRouting = {}
        loader.prefetchPlaceholders(els, (el) => (el.localName === 'x-admin' ? 'skip' : 'swap'))
        await wait(40)
        expect(count('footer')).toBe(1)
        expect(count('admin')).toBe(0)
    })

    it('never fetches framework tags', async () => {
        window.ManifestComponentsLoader.prefetchPlaceholders(placeholders('<x-code>a</x-code><x-code-group></x-code-group>'))
        await wait(40)
        expect(started).toEqual([])
    })

    it('initialize keeps what was fetched before it', async () => {
        const loader = window.ManifestComponentsLoader
        await loader.loadComponent('hero')
        loader.initialize()
        await loader.loadComponent('hero')
        expect(count('hero')).toBe(1)
    })

    it('concurrent registry initializes share one run', async () => {
        const registry = window.ManifestComponentsRegistry
        const a = registry.initialize(), b = registry.initialize()
        expect(a).toBe(b)
        await a
        expect(registry.registered.has('hero')).toBe(true)
    })
})
