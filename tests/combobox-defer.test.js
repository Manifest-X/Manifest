/**
 * @vitest-environment happy-dom
 *
 * x-combobox reads its options from a source menu's rendered <li> rows. When that
 * source sits under x-defer (auto-stashed: popover menus defer by default), the rows
 * don't exist yet — x-for hasn't run — so a naive read falls back to the raw id.
 * These tests reproduce the stash the way manifest.defer.js builds it (via real Alpine
 * init over a popover <menu>, same as defer.test.js) and confirm the combobox hydrates
 * the source before reading it.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

window.requestIdleCallback = (fn) => setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 0 }), 1000)
window.cancelIdleCallback = (id) => clearTimeout(id)
window.__manifestLoaderStarted = true
window.Alpine = Alpine

const load = (file) => import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/' + file), 'utf8')
))
await load('manifest.defer.js')
await load('manifest.combobox.js')
window.ensureComboboxPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }

function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

const items = (id) => `
    <template x-for="item in items" :key="item.id">
        <li :data-value="item.id" :data-label="item.name" x-text="item.name"></li>
    </template>`

beforeAll(() => { Alpine.start() })

describe('combobox reads a deferred source', () => {
    it('resolves chip labels (not raw ids) at init through x-model', async () => {
        const host = mount(`
            <div x-data="{
                items: [ { id: 'p1', name: 'Foundry' }, { id: 'p2', name: 'Playcom' }, { id: 'p3', name: 'Acme' } ],
                tags: ['p2', 'p3']
            }">
                <menu popover id="src-a">${items()}</menu>
                <input x-combobox.multiple.chips="src-a" x-model="tags">
            </div>`)
        // Source starts stashed: x-for never ran, no <li> rows yet.
        expect(host.querySelector('#src-a > template[data-mnfst-defer]')).toBeTruthy()

        await settle()

        const labels = Array.from(host.querySelectorAll('.combobox-chip span')).map(s => s.textContent)
        expect(labels).toEqual(['Playcom', 'Acme'])
        // Source is hydrated as a side effect of the read.
        expect(host.querySelector('#src-a > template[data-mnfst-defer]')).toBeFalsy()
    })

    it('resolves all chips across several fields (6 chips / 3 fields)', async () => {
        const field = (n, a, b) => `
            <div x-data="{
                items: [ { id: '${n}1', name: '${n}-One' }, { id: '${n}2', name: '${n}-Two' }, { id: '${n}3', name: '${n}-Three' } ],
                tags: ['${n}${a}', '${n}${b}']
            }">
                <menu popover id="src-${n}">${items()}</menu>
                <input x-combobox.multiple.chips="src-${n}" x-model="tags">
            </div>`
        const host = mount(field('x', 1, 2) + field('y', 2, 3) + field('z', 1, 3))
        await settle()

        const labels = Array.from(host.querySelectorAll('.combobox-chip span')).map(s => s.textContent)
        expect(labels).toHaveLength(6)
        expect(labels).toEqual(['x-One', 'x-Two', 'y-Two', 'y-Three', 'z-One', 'z-Three'])
    })

    it('lists real options instead of an empty "No matches" menu', async () => {
        const host = mount(`
            <div x-data="{ items: [ { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' } ] }">
                <menu popover id="src-b">${items()}</menu>
                <input x-combobox="src-b">
            </div>`)
        await settle()

        const input = host.querySelector('input')
        const genMenu = document.getElementById(input.getAttribute('aria-controls'))
        const optLabels = Array.from(genMenu.querySelectorAll('li[role=option]')).map(li => li.dataset.label)
        expect(optLabels).toEqual(['Alpha', 'Beta'])
    })
})

describe('combobox regressions', () => {
    it('still resolves labels when the source was never deferred', async () => {
        const host = mount(`
            <div x-data="{ items: [ { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' } ] }">
                <menu id="src-c">${items()}</menu>
                <input x-combobox="src-c" value="b">
            </div>`)
        await settle()
        expect(host.querySelector('input').value).toBe('Beta')
    })

    it('does not throw when ManifestDefer is absent', async () => {
        const saved = window.ManifestDefer
        delete window.ManifestDefer
        try {
            const host = mount(`
                <div x-data="{ items: [ { id: 'a', name: 'Alpha' } ] }">
                    <menu popover id="src-d">${items()}</menu>
                    <input x-combobox="src-d" value="a">
                </div>`)
            await expect(settle()).resolves.not.toThrow()
            // Still functions without the defer API — falls back to today's (possibly
            // stale) read rather than crashing.
            expect(host.querySelector('input')).toBeTruthy()
        } finally {
            window.ManifestDefer = saved
        }
    })
})
