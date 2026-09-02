/**
 * @vitest-environment happy-dom
 *
 * `data-defer="off"` on the loader script disables deferral globally, and the render
 * pass (`window.__manifestRender`) keeps closed containers eager so snapshots carry
 * their markup. Each is a load-time switch, so they get their own module instance.
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
loader.setAttribute('data-defer', 'off')
document.head.appendChild(loader)

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.defer.js'), 'utf8')
))

beforeAll(() => { Alpine.start() })

describe('global kill switch', () => {
    it('leaves closed containers eager and makes the cooperative call a no-op', () => {
        const host = document.createElement('div')
        host.innerHTML = `<div x-data><menu popover id="m"><li x-init="counts.m = 1"></li></menu><div hidden id="h"><p x-init="counts.h = 1"></p></div></div>`
        document.body.appendChild(host)
        Alpine.initTree(host)
        expect(window.ManifestDefer.enabled).toBe(false)
        expect(host.querySelector('#m').__mnfstDefer).toBeFalsy()
        expect(window.counts).toEqual({ m: 1, h: 1 })
        const menu = document.createElement('menu')
        menu.setAttribute('popover', '')
        menu.innerHTML = '<li></li>'
        expect(window.ManifestDefer.defer(menu)).toBeNull()
    })

    it('also disables route deferral when its flag is on', () => {
        window.ManifestDeferConfig = { routes: true }
        const host = document.createElement('div')
        host.innerHTML = `<div x-data><div x-route="/away" hidden id="r"><p x-init="counts.r = 1"></p></div></div>`
        document.body.appendChild(host)
        Alpine.initTree(host)
        expect(host.querySelector('#r').__mnfstDefer).toBeFalsy()
        expect(window.counts.r).toBe(1)
    })
})
