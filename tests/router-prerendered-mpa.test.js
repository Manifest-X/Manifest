/**
 * @vitest-environment happy-dom
 *
 * Static MPA skip, against the built router bundle: every subscript shares one IIFE, so a
 * same-named helper in a later subscript shadows the earlier one (it once recursed into a
 * caught RangeError and always returned false).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

window.Alpine = Alpine
window.__manifestLoaderStarted = true

const meta = document.createElement('meta')
meta.name = 'manifest:prerendered'
meta.content = '1'

let vis
beforeAll(async () => {
    document.head.appendChild(meta)
    document.body.innerHTML = `
        <section id="home" x-route="/">
            <template data-head><meta name="route-head" content="home"></template>
            <h1>Home</h1>
        </section>`
    // Baked by the prerender alongside the section
    const baked = document.createElement('meta')
    baked.name = 'route-head'
    baked.content = 'home'
    baked.setAttribute('data-route-head', 'section-1')
    document.head.appendChild(baked)
    const src = readFileSync(path.join(__dirname, '../src/scripts/manifest.router.js'), 'utf8')
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(src))
    vis = window.ManifestRoutingVisibility
})

afterEach(() => { if (!meta.isConnected) document.head.appendChild(meta) })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const routeChange = (normalizedPath) => window.dispatchEvent(new CustomEvent('manifest:route-change', {
    detail: { from: '/', to: '/' + normalizedPath, normalizedPath }
}))

describe('router on prerendered static MPA output', () => {
    it('detects the prerender meta without recursing', () => {
        expect(vis.isPrerenderedStaticMPA()).toBe(true)
    })

    it('isRouteActive short-circuits true', () => {
        const el = document.createElement('div')
        el.setAttribute('x-route', 'elsewhere')
        expect(vis.isRouteActive(el, '/')).toBe(true)
    })

    it('leaves baked route sections and head content alone on route-change', async () => {
        routeChange('elsewhere')
        await wait(150)
        const home = document.getElementById('home')
        expect(home.hasAttribute('hidden')).toBe(false)
        expect(home.hasAttribute('x-cloak')).toBe(false)
        expect(document.head.querySelectorAll('meta[name="route-head"]').length).toBe(1)
    })

    it('without the meta, routes and head content follow the URL again', async () => {
        meta.remove()
        expect(vis.isPrerenderedStaticMPA()).toBe(false)
        const el = document.createElement('div')
        el.setAttribute('x-route', 'elsewhere')
        expect(vis.isRouteActive(el, '/')).toBe(false)
        routeChange('elsewhere')
        await wait(150)
        expect(document.getElementById('home').hasAttribute('hidden')).toBe(true)
    })
})
