/**
 * @vitest-environment happy-dom
 *
 * Arming used to run once at boot, so an x-edit region rendered later — x-if, a route
 * change, a lazy component, x-markdown output — stayed inert and the page had to call
 * $edit.on() again by hand. The directive now arms its own region and releases it when
 * Alpine destroys the tree.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.edit.js'), 'utf8')

const flush = () => new Promise(r => setTimeout(r, 0))

beforeAll(async () => {
    new Function(SRC)()          // registers on alpine:init; window.Alpine is set after, so init runs once
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))   // let the 450ms boot pass run
})

const store = () => Alpine.store('edit')

function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    return root
}

// A gated region behind an x-if, so it renders strictly after the boot pass.
function gated(key) {
    const root = mount(`<div x-data="{ show: false }"><template x-if="show"><section x-edit.gated="${key}"><p>One</p><p>Two</p></section></template></div>`)
    const host = root.firstElementChild
    return {
        root,
        data: Alpine.$data(host),
        async render(on) { Alpine.$data(host).show = on; await Alpine.nextTick(); await flush() },
        get region() { return root.querySelector('section') }
    }
}

afterEach(() => {
    store().off()
    document.body.innerHTML = ''
})

describe('x-edit late regions', () => {
    it('arms a region rendered after editing is switched on', async () => {
        const f = gated('late-if')
        store().on()
        await f.render(true)

        expect(f.region).toBeTruthy()
        expect(f.region.hasAttribute('data-edit-armed')).toBe(true)
        expect(f.region.querySelector('p').getAttribute('contenteditable')).toBe('true')
    })

    it('arms a region rendered while editing is off on the next on()', async () => {
        const f = gated('late-off')
        await f.render(true)
        expect(f.region.hasAttribute('data-edit-armed')).toBe(false)

        store().on()
        await flush()
        expect(f.region.hasAttribute('data-edit-armed')).toBe(true)
    })

    it('releases a removed region: observers, registry slot and markup', async () => {
        const f = gated('late-gone')
        store().on()
        await f.render(true)
        const region = f.region
        expect(region._sortObserver).toBeTruthy()   // arming watches the list for late rows

        await f.render(false)
        expect(region._sortObserver).toBe(null)
        expect(region._edit).toBeUndefined()
        expect(region._armed).toBe(false)
        expect(region.hasAttribute('data-edit-area')).toBe(false)
        expect(region.hasAttribute('data-edit-armed')).toBe(false)
    })

    it('does not treat a re-rendered region as a duplicate key', async () => {
        const f = gated('late-again')
        store().on()
        await f.render(true)
        await f.render(false)

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        await f.render(true)
        expect(warn.mock.calls.filter(c => String(c[0]).includes('duplicate x-edit key'))).toEqual([])
        warn.mockRestore()
        expect(f.region.hasAttribute('data-edit-armed')).toBe(true)
    })
})
