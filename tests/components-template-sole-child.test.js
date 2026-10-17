/**
 * @vitest-environment happy-dom
 *
 * A component as the sole child of <template x-if>/<template x-for>: the swap
 * replaces the clone Alpine tracks, so Alpine must be repointed at the swapped
 * node or toggles/list changes leave stale DOM behind.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const COMPONENTS = {
    support: '<div class="support"><span>help</span></div>',
    card: '<article class="card"><h3 x-text="item.name"></h3></article>',
    pair: '<p class="first">a</p><p class="second" x-text="typeof item === \'undefined\' ? \'b\' : item.name"></p>'
}
window.Alpine = Alpine
window.ManifestComponentsRegistry = { registered: new Set(Object.keys(COMPONENTS)) }
window.ManifestComponentsLoader = { async loadComponent(name) { return COMPONENTS[name] || null } }

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/components/manifest.components.processor.js'), 'utf8')
))
const processor = window.ManifestComponentsProcessor

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }

// Stands in for the mutation observer: swap every placeholder in the tree.
async function swapAll(root) {
    const pending = Array.from(root.querySelectorAll('*')).filter((el) =>
        el.tagName.toLowerCase().startsWith('x-') && !el.hasAttribute('data-processed'))
    for (const el of pending) await processor.processComponent(el)
}

async function mount(html, data) {
    window.__state = Alpine.reactive(data)
    const host = document.createElement('div')
    host.setAttribute('x-data', 'window.__state')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    await settle()
    await swapAll(host)
    await settle()
    return host
}

const state = () => window.__state

beforeEach(() => { document.body.innerHTML = '' })

describe('component as sole child of x-if', () => {
    it('removes and re-renders on toggle', async () => {
        const host = await mount('<template x-if="show"><x-support></x-support></template>', { show: true })
        expect(host.querySelectorAll('.support')).toHaveLength(1)

        state().show = false
        await settle()
        expect(host.querySelectorAll('.support')).toHaveLength(0)

        state().show = true
        await settle()
        await swapAll(host)
        await settle()
        expect(host.querySelectorAll('.support')).toHaveLength(1)
        expect(host.querySelector('x-support')).toBeNull()

        state().show = false
        await settle()
        expect(host.querySelectorAll('.support')).toHaveLength(0)
    })

    it('points the template at the swapped node (prerender tags _x_currentIfEl)', async () => {
        const host = await mount('<template x-if="show"><x-support></x-support></template>', { show: true })
        const tpl = host.querySelector('template')
        expect(tpl._x_currentIfEl).toBe(host.querySelector('.support'))
        expect(tpl._x_currentIfEl.previousElementSibling).toBe(tpl)
    })

    it('removes every root of a multi-root component', async () => {
        const host = await mount('<template x-if="show"><x-pair></x-pair></template>', { show: true })
        expect(host.querySelectorAll('.first, .second')).toHaveLength(2)
        state().show = false
        await settle()
        expect(host.querySelectorAll('.first, .second')).toHaveLength(0)
    })
})

describe('component as sole child of x-for', () => {
    it('keeps loop scope and follows list changes', async () => {
        const host = await mount(
            '<template x-for="item in items" :key="item.id"><x-card></x-card></template>',
            { items: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }, { id: 3, name: 'three' }] }
        )
        const names = () => Array.from(host.querySelectorAll('.card h3')).map((h) => h.textContent)
        expect(names()).toEqual(['one', 'two', 'three'])

        state().items = state().items.filter((i) => i.id !== 2)
        await settle()
        expect(names()).toEqual(['one', 'three'])

        state().items = [...state().items].reverse()
        await settle()
        expect(names()).toEqual(['three', 'one'])

        state().items[0].name = 'THREE'
        await settle()
        expect(names()).toEqual(['THREE', 'one'])

        state().items = []
        await settle()
        expect(host.querySelectorAll('.card')).toHaveLength(0)
    })

    it('moves and removes multi-root components as a unit', async () => {
        const host = await mount(
            '<template x-for="item in items" :key="item.id"><x-pair></x-pair></template>',
            { items: [{ id: 1, name: 'one' }, { id: 2, name: 'two' }] }
        )
        const seconds = () => Array.from(host.querySelectorAll('.second')).map((p) => p.textContent)
        expect(seconds()).toEqual(['one', 'two'])

        state().items = [...state().items].reverse()
        await settle()
        expect(seconds()).toEqual(['two', 'one'])

        state().items = state().items.slice(1)
        await settle()
        expect(seconds()).toEqual(['one'])
        expect(host.querySelectorAll('.first')).toHaveLength(1)

        state().items = []
        await settle()
        expect(host.querySelectorAll('.first, .second')).toHaveLength(0)
    })
})

describe('wrapped components are unchanged', () => {
    it('component inside a wrapper under x-if', async () => {
        const host = await mount('<template x-if="show"><div class="wrap"><x-support></x-support></div></template>', { show: true })
        expect(host.querySelector('.wrap > .support')).toBeTruthy()
        state().show = false
        await settle()
        expect(host.querySelector('.support')).toBeNull()
    })
})
