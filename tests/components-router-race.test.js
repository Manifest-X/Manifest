/**
 * @vitest-environment happy-dom
 *
 * Components vs router load order: route-gated <x-*> placeholders never
 * hydrate off-route, whether the router script runs before or after the
 * components plugin. Real processor/routing/swapping/mutation source in a vm
 * context per test (as components-swap-reentrancy.test.js); the router's real
 * matcher (tests/helpers/real-router.js).
 */
import vm from 'vm'
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import { realRouter } from './helpers/real-router.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.resolve(__dirname, '../src/scripts/', f), 'utf8')
const processorSrc = read('components/manifest.components.processor.js')
const routingSrc = read('components/manifest.components.routing.js')
const swappingSrc = read('components/manifest.components.swapping.js')
const mutationSrc = read('components/manifest.components.mutation.js')

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick(2) }

const realRouting = () => realRouter(document)

class Events {
    constructor() { this.l = {} }
    addEventListener(t, f) { (this.l[t] ||= new Set()).add(f) }
    removeEventListener(t, f) { this.l[t]?.delete(f) }
    dispatchEvent(e) { for (const f of [...(this.l[e.type] || [])]) f(e); return true }
}
class Evt { constructor(type, o) { this.type = type; this.detail = o?.detail } }

// Observers outlive a test's vm context; disconnect them between tests
const observers = []
class TrackedObserver extends window.MutationObserver {
    constructor(cb) { super(cb); observers.push(this) }
}

function makeEnv({ path: currentPath = '/a', routing = null, mutation = false } = {}) {
    const loads = []
    const win = new Events()
    win.location = { pathname: currentPath }
    win.ManifestComponentsRegistry = { registered: new Set(['a', 'b', 'c', 'd', 'free']) }
    win.ManifestComponentsLoader = {
        async loadComponent(name) {
            loads.push(name)
            await tick(1)
            return `<div class="r-${name}"></div>`
        }
    }
    if (routing) Object.assign(win, routing)
    const ctx = { window: win, document, console: { ...console, debug() {} }, setTimeout, Promise, Set, Map, Array, WeakSet, CustomEvent: Evt, MutationObserver: TrackedObserver }
    vm.createContext(ctx)
    for (const s of [processorSrc, routingSrc, swappingSrc, mutationSrc]) vm.runInContext(s, ctx)
    win.ManifestComponentsSwapping.initialize()
    if (mutation) win.ManifestComponentsMutation.initialize()
    const routerArrives = () => {
        Object.assign(win, realRouting())
        document.querySelector('script[src*="manifest.router"]')?.dispatchEvent(new window.Event('load'))
    }
    const rendered = () => [...document.querySelectorAll('[class^="r-"]')].map((e) => e.className.slice(2)).sort()
    return { win, loads, routerArrives, rendered }
}

const PAGE = `<x-free></x-free><x-a x-route="/a"></x-a><x-b x-route="/b"></x-b>`
// Inert type: happy-dom would try to fetch a real one
const routerTag = () => { document.head.innerHTML = '<script type="text/x-inert" src="/fw/manifest.router.js"></script>' }

let readyDesc
beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    readyDesc = Object.getOwnPropertyDescriptor(document, 'readyState')
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'interactive' })
})
afterEach(() => {
    observers.splice(0).forEach((o) => o.disconnect())
    if (readyDesc) Object.defineProperty(document, 'readyState', readyDesc)
    else delete document.readyState
})

describe('components x router load order', () => {
    it('router loads late: off-route gated placeholders never hydrate; on-route ones do once it arrives', async () => {
        routerTag()
        document.body.innerHTML = PAGE
        const { routerArrives, rendered, loads } = makeEnv()
        await settle()
        expect(rendered()).toEqual(['free'])
        expect(document.querySelector('x-a')).toBeTruthy()
        routerArrives()
        await settle()
        expect(rendered()).toEqual(['a', 'free'])
        expect(loads).not.toContain('b')
    })

    it('router loads early: only matching gated placeholders hydrate', async () => {
        document.body.innerHTML = PAGE
        const { rendered, loads } = makeEnv({ routing: realRouting() })
        await settle()
        expect(rendered()).toEqual(['a', 'free'])
        expect(loads).not.toContain('b')
    })

    it('no router at all: everything swaps in, without waiting', async () => {
        document.body.innerHTML = PAGE
        const { rendered } = makeEnv()
        await settle()
        expect(rendered()).toEqual(['a', 'b', 'free'])
    })

    it('ungated components are not delayed while the router is pending', async () => {
        routerTag()
        document.body.innerHTML = PAGE
        const { win, rendered } = makeEnv()
        await settle()
        expect(win.ManifestRouting).toBeUndefined()
        expect(win.ManifestComponentsRouting.pending()).toBe(true)
        expect(rendered()).toEqual(['free'])
    })

    it('route change after a late router: listener is live, swaps in and reverts', async () => {
        routerTag()
        document.body.innerHTML = PAGE
        const { win, routerArrives, rendered } = makeEnv()
        await settle()
        routerArrives()
        await settle()
        win.location.pathname = '/b'
        win.dispatchEvent(new Evt('manifest:route-change', { detail: { normalizedPath: 'b' } }))
        await settle()
        expect(rendered()).toEqual(['b', 'free'])
        expect(document.querySelector('x-a[x-route="/a"]')).toBeTruthy()
    })

    it('mutation path: placeholders added inside a hidden route after boot stay unhydrated', async () => {
        routerTag()
        document.body.innerHTML = '<div id="host"></div>'
        const { routerArrives, rendered, loads } = makeEnv({ mutation: true })
        await settle()
        document.getElementById('host').innerHTML = '<div x-route="/b"><x-c x-route="/b"></x-c></div><x-d x-route="/a,!/b"></x-d><x-free></x-free>'
        await settle()
        expect(loads).not.toContain('c')
        expect(loads).not.toContain('d')
        expect(rendered()).toEqual(['free'])
        routerArrives()
        await settle()
        expect(rendered()).toEqual(['d', 'free'])
        expect(loads).not.toContain('c')
    })

    it('mutation path with the router present: comma lists and negation follow route visibility', async () => {
        document.body.innerHTML = '<div id="host"></div>'
        const { rendered } = makeEnv({ routing: realRouting(), mutation: true })
        await settle()
        document.getElementById('host').innerHTML = '<x-c x-route="/b,/c"></x-c><x-d x-route="/b,/a"></x-d><x-free x-route="!/a"></x-free>'
        await settle()
        expect(rendered()).toEqual(['d'])
    })

    it('router script never runs: gated placeholders swap in after window load', async () => {
        routerTag()
        document.body.innerHTML = PAGE
        const { win, rendered } = makeEnv()
        await settle()
        expect(rendered()).toEqual(['free'])
        win.dispatchEvent(new Evt('load'))
        await settle()
        expect(rendered()).toEqual(['a', 'b', 'free'])
    })

    it('a loader tag already marked loaded without a router is not waited on', async () => {
        document.head.innerHTML = '<script type="text/x-inert" src="/fw/manifest.router.js" data-mnfst-loaded></script>'
        document.body.innerHTML = PAGE
        const { rendered } = makeEnv()
        await settle()
        expect(rendered()).toEqual(['a', 'b', 'free'])
    })
})
