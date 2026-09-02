/**
 * @vitest-environment happy-dom
 *
 * Prerender contract: during the mnfst-render pass (`window.__manifestRender`) closed
 * containers stay eager so the snapshot serializes their real markup; on hydration the
 * interceptor stashes that markup before any child directive runs (covered in
 * defer.test.js — the snapshot is plain authored HTML).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

window.__manifestLoaderStarted = true
window.__manifestRender = true
window.Alpine = Alpine
window.counts = {}

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.defer.js'), 'utf8')
))

beforeAll(() => { Alpine.start() })

describe('render pass', () => {
    it('serializes closed containers with their subtree intact', () => {
        const host = document.createElement('div')
        host.innerHTML = `<div x-data><menu popover id="m"><li x-init="counts.m = 1" x-text="'row'"></li></menu></div>`
        document.body.appendChild(host)
        Alpine.initTree(host)
        const menu = host.querySelector('#m')
        expect(menu.__mnfstDefer).toBeFalsy()
        expect(window.counts.m).toBe(1)
        expect(menu.outerHTML).not.toContain('<template')
        expect(menu.querySelector('li').textContent).toBe('row')
    })
})
