/**
 * @vitest-environment happy-dom
 *
 * `data-defer-routes` on the loader script turns route deferral on without any config object.
 * Load-time switch, so it gets its own module instance.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

window.__manifestLoaderStarted = true
window.Alpine = Alpine
window.counts = {}

const loader = document.createElement('script')
loader.setAttribute('data-defer-routes', '')
document.head.appendChild(loader)

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.defer.js'), 'utf8')
))

beforeAll(() => { Alpine.start() })

describe('data-defer-routes', () => {
    it('defers a hidden route without a router present and renders it when hidden is removed', async () => {
        const host = document.createElement('div')
        host.innerHTML = `<div x-data><div x-route="/away" hidden id="r"><p x-init="counts.r = 1"></p></div><div x-route="/here" id="h"><p x-init="counts.h = 1"></p></div></div>`
        document.body.appendChild(host)
        Alpine.initTree(host)
        expect(window.ManifestDefer.stats().routes.enabled).toBe(true)
        const r = host.querySelector('#r')
        expect(r.__mnfstDefer.rule).toBe('route')
        expect(window.counts.r).toBeUndefined()
        expect(host.querySelector('#h').__mnfstDefer).toBeFalsy() // no router to consult: only hidden panes are closed
        expect(window.counts.h).toBe(1)
        r.removeAttribute('hidden')
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(window.counts.r).toBe(1)
    })
})
