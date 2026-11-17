/**
 * @vitest-environment happy-dom
 *
 * Components route gate covers ancestors: a placeholder hydrates only when its
 * own x-route and every x-route ancestor (wrappers, unhydrated placeholders, a
 * swapped-in component's own sections) are active. Real components source in a
 * vm context per test; the router's real matcher (tests/helpers/real-router.js).
 */
import vm from 'vm'
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import { realRouter } from './helpers/real-router.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.resolve(__dirname, '../src/scripts/components/', f), 'utf8')
const SOURCES = ['processor', 'routing', 'swapping', 'mutation'].map((n) => read(`manifest.components.${n}.js`))

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(2) }

class Events {
    constructor() { this.l = {} }
    addEventListener(t, f) { (this.l[t] ||= new Set()).add(f) }
    removeEventListener(t, f) { this.l[t]?.delete(f) }
    dispatchEvent(e) { for (const f of [...(this.l[e.type] || [])]) f(e); return true }
}
class Evt { constructor(type, o) { this.type = type; this.detail = o?.detail } }

const observers = []
class TrackedObserver extends window.MutationObserver {
    constructor(cb) { super(cb); observers.push(this) }
}

const TEMPLATES = {
    // A component with its own routed section holding another component
    shell: '<div class="r-shell"><div x-route="/b"><x-inner></x-inner></div></div>'
}

function makeEnv({ path: p = '/a', router = true, mutation = true } = {}) {
    const loads = []
    const win = new Events()
    win.location = { pathname: p }
    win.ManifestComponentsRegistry = { registered: new Set(['w', 'v', 'e', 'nf', 'inner', 'a', 'shell', 'own']) }
    win.ManifestComponentsLoader = {
        async loadComponent(name) {
            loads.push(name)
            await tick(1)
            return TEMPLATES[name] || `<div class="r-${name}"></div>`
        }
    }
    if (router) Object.assign(win, realRouter(document))
    const ctx = { window: win, document, console: { ...console, debug() {} }, setTimeout, Promise, Set, Map, Array, WeakSet, CustomEvent: Evt, MutationObserver: TrackedObserver }
    vm.createContext(ctx)
    for (const s of SOURCES) vm.runInContext(s, ctx)
    win.ManifestComponentsSwapping.initialize()
    if (mutation) win.ManifestComponentsMutation.initialize()
    const go = async (to) => {
        win.location.pathname = to
        win.dispatchEvent(new Evt('manifest:route-change', { detail: { normalizedPath: to === '/' ? '/' : to.replace(/^\/|\/$/g, '') } }))
        await settle()
    }
    const routerArrives = () => {
        Object.assign(win, realRouter(document))
        document.querySelector('script[src*="manifest.router"]')?.dispatchEvent(new window.Event('load'))
    }
    const rendered = () => [...document.querySelectorAll('[class^="r-"]')].map((e) => e.className.slice(2)).sort()
    return { win, loads, go, routerArrives, rendered }
}

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

describe('ancestor route gate', () => {
    it('a wrapper with x-route gates its placeholder', async () => {
        document.body.innerHTML = '<div x-route="/b"><x-w></x-w></div><div x-route="/a"><x-v></x-v></div>'
        const { rendered, loads } = makeEnv({ path: '/a' })
        await settle()
        expect(rendered()).toEqual(['v'])
        expect(loads).not.toContain('w')
    })

    it('a placeholder nested in an unhydrated gated placeholder stays put', async () => {
        document.body.innerHTML = '<x-a x-route="/a"><x-inner></x-inner></x-a>'
        const { loads } = makeEnv({ path: '/b' })
        await settle()
        expect(loads).toEqual([])
    })

    it('navigating into a section hydrates its placeholders', async () => {
        document.body.innerHTML = '<div x-route="/b"><x-w></x-w></div>'
        const { rendered, go } = makeEnv({ path: '/a' })
        await settle()
        expect(rendered()).toEqual([])
        await go('/b')
        expect(rendered()).toEqual(['w'])
    })

    it('deep nesting: every routed ancestor must be active', async () => {
        document.body.innerHTML = '<div x-route="/s"><section><div x-route="/s/t"><div><x-w></x-w></div></div></section></div>' +
            '<div x-route="/a"><div x-route="/b"><x-v></x-v></div></div>'
        const { rendered, go } = makeEnv({ path: '/s' })
        await settle()
        expect(rendered()).toEqual([])
        await go('/s/t')
        expect(rendered()).toEqual(['w'])
        await go('/a')
        await go('/b')
        expect(rendered()).not.toContain('v')
    })

    it('comma, negation, =exact and !* on an ancestor follow the router', async () => {
        document.body.innerHTML = '<div x-route="/a,/c"><x-w></x-w></div><div x-route="!/a"><x-v></x-v></div>' +
            '<div x-route="=s"><x-e></x-e></div><div x-route="!*"><x-nf></x-nf></div><div x-route="s/*"></div>'
        const env = makeEnv({ path: '/a' })
        await settle()
        expect(env.rendered()).toEqual(['w'])
        await env.go('/c')
        expect(env.rendered()).toEqual(['v', 'w'])
        await env.go('/s/t')
        expect(env.rendered()).not.toContain('e')
        expect(env.rendered()).not.toContain('nf')
        await env.go('/zzz')
        expect(env.rendered()).toContain('nf')
    })

    it('late router: ancestor-gated placeholders defer, then follow the gate', async () => {
        document.head.innerHTML = '<script type="text/x-inert" src="/fw/manifest.router.js"></script>'
        document.body.innerHTML = '<div x-route="/b"><x-w></x-w></div><div x-route="/a"><x-v></x-v></div><x-e></x-e>'
        const { rendered, loads, routerArrives } = makeEnv({ path: '/a', router: false })
        await settle()
        expect(rendered()).toEqual(['e'])
        routerArrives()
        await settle()
        expect(rendered()).toEqual(['e', 'v'])
        expect(loads).not.toContain('w')
    })

    it('mutation path: placeholders added inside a routed wrapper wait for its route', async () => {
        document.body.innerHTML = '<div id="pane" x-route="/b"></div>'
        const { rendered, loads, go } = makeEnv({ path: '/a' })
        await settle()
        document.getElementById('pane').innerHTML = '<div><x-w></x-w></div>'
        await settle()
        expect(loads).not.toContain('w')
        await go('/b')
        expect(rendered()).toEqual(['w'])
    })

    it("a swapped-in component's own routed section gates its nested placeholder", async () => {
        document.body.innerHTML = '<x-shell></x-shell>'
        const { rendered, loads, go } = makeEnv({ path: '/a' })
        await settle()
        expect(rendered()).toEqual(['shell'])
        expect(loads).not.toContain('inner')
        await go('/b')
        expect(rendered()).toEqual(['inner', 'shell'])
    })

    it('revert semantics: an ancestor going inactive keeps the component; its own x-route still reverts', async () => {
        document.body.innerHTML = '<div x-route="/a"><x-w></x-w><x-own x-route="/a"></x-own></div>'
        const { rendered, go } = makeEnv({ path: '/a' })
        await settle()
        expect(rendered()).toEqual(['own', 'w'])
        await go('/b')
        expect(rendered()).toEqual(['w'])
    })

    it('no router: wrappers gate nothing', async () => {
        document.body.innerHTML = '<div x-route="/b"><x-w></x-w></div><x-a x-route="/b"><x-inner></x-inner></x-a>'
        const { rendered } = makeEnv({ path: '/a', router: false })
        await settle()
        expect(rendered()).toEqual(['a', 'w'])
    })
})
