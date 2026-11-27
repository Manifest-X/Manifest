/**
 * @vitest-environment happy-dom
 *
 * Component markup is parsed once per source and cloned per instance, and the
 * boot pass swaps each placeholder once (no second walk racing it). Props,
 * class merges, scripts and nested components stay per instance.
 * Real processor/routing/swapping/mutation source in a vm context (as components-router-race.test.js).
 */
import vm from 'vm'
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.resolve(__dirname, '../src/scripts/', f), 'utf8')
const sources = ['processor', 'routing', 'swapping', 'mutation'].map((n) => read(`components/manifest.components.${n}.js`))

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

// Counts innerHTML writes of each component's markup (one per parse)
let parses = {}
let restoreInnerHTML = null
function spyParses(components) {
    let proto = document.createElement('div')
    while (proto && !Object.getOwnPropertyDescriptor(proto, 'innerHTML')) proto = Object.getPrototypeOf(proto)
    const desc = Object.getOwnPropertyDescriptor(proto, 'innerHTML')
    const byMarkup = new Map(Object.entries(components).map(([k, v]) => [v.trim(), k]))
    Object.defineProperty(proto, 'innerHTML', {
        ...desc,
        set(v) { const k = byMarkup.get(String(v).trim()); if (k) parses[k] = (parses[k] || 0) + 1; desc.set.call(this, v) }
    })
    restoreInnerHTML = () => Object.defineProperty(proto, 'innerHTML', desc)
}

function makeEnv(components) {
    parses = {}
    spyParses(components)
    const win = new Events()
    win.location = { pathname: '/' }
    win.ManifestComponentsRegistry = { registered: new Set(Object.keys(components)) }
    win.ManifestComponentsLoader = { async loadComponent(name) { await tick(1); return components[name] ?? null } }
    const ctx = { window: win, document, console: { ...console, debug() {} }, setTimeout, Promise, Set, Map, Array, WeakSet, CustomEvent: Evt, MutationObserver: TrackedObserver }
    vm.createContext(ctx)
    for (const s of sources) vm.runInContext(s, ctx)
    const calls = []
    const processor = win.ManifestComponentsProcessor
    const original = processor.processComponent.bind(processor)
    processor.processComponent = (el, id) => { calls.push(el); return original(el, id) }
    // Boot order of manifest.components.main.js
    const boot = () => { win.ManifestComponentsSwapping.initialize(); win.ManifestComponentsMutation.initialize() }
    return { win, calls, boot }
}

beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => { observers.splice(0).forEach((o) => o.disconnect()); restoreInnerHTML?.(); restoreInnerHTML = null })

describe('boot pass', () => {
    it('hands each placeholder to the processor once', async () => {
        const env = makeEnv({ card: '<article class="card">c</article>', other: '<aside class="other">o</aside>' })
        document.body.innerHTML = '<x-card></x-card><x-card></x-card><x-other></x-other>'
        const placeholders = [...document.body.children]
        env.boot()
        await settle()
        expect(document.querySelectorAll('.card')).toHaveLength(2)
        expect(document.querySelectorAll('.other')).toHaveLength(1)
        expect(placeholders.map((p) => env.calls.filter((c) => c === p).length)).toEqual([1, 1, 1])
        expect([...document.querySelectorAll('[data-component]')].map((e) => e.getAttribute('data-component'))).toEqual(['card-1', 'card-2', 'other-1'])
    })

    it('still swaps nested components inside swapped markup', async () => {
        const env = makeEnv({ shell: '<section class="shell"><x-inner></x-inner></section>', inner: '<b class="inner">i</b>' })
        document.body.innerHTML = '<x-shell></x-shell><x-shell></x-shell>'
        env.boot()
        await settle(12)
        expect(document.querySelectorAll('.shell .inner')).toHaveLength(2)
        expect(document.querySelector('x-inner')).toBeNull()
    })

    it('still swaps placeholders added after boot', async () => {
        const env = makeEnv({ card: '<article class="card">c</article>' })
        env.boot()
        await settle()
        const added = document.createElement('div')
        added.innerHTML = '<x-card></x-card>'
        document.body.appendChild(added)
        await settle()
        expect(document.querySelectorAll('.card')).toHaveLength(1)
    })
})

describe('parse once per source', () => {
    const CARD = `
        <article class="card" x-data="{ n: 1 }" :title="$modify('label')">
            <h3 x-text="$modify('label')"></h3>
            <template x-if="true"><i class="t">t</i></template>
        </article>
        <script>window.__runs = (window.__runs || 0) + 1</script>`

    it('parses the markup once for many instances', async () => {
        const env = makeEnv({ card: CARD })
        document.body.innerHTML = '<x-card label="a"></x-card><x-card label="b"></x-card><x-card label="c"></x-card><x-card label="d"></x-card>'
        env.boot()
        await settle()
        expect(document.querySelectorAll('.card')).toHaveLength(4)
        expect(parses.card).toBe(1)
    })

    it('keeps props, classes and scripts per instance', async () => {
        const env = makeEnv({ card: CARD })
        document.body.innerHTML = '<x-card label="one" class="extra"></x-card><x-card label="it\'s"></x-card><x-card></x-card>'
        env.boot()
        await settle()
        const cards = [...document.querySelectorAll('.card')]
        expect(cards.map((c) => c.querySelector('h3').getAttribute('x-text'))).toEqual(["'one'", "'it\\'s'", null])
        expect(cards.map((c) => c.getAttribute(':title'))).toEqual(["'one'", "'it\\'s'", null])
        expect(cards.map((c) => c.className)).toEqual(['card extra', 'card', 'card'])
        expect(cards.every((c) => c.querySelector('template')?.content.querySelector('.t'))).toBe(true)
        expect(document.querySelectorAll('script')).toHaveLength(0)
        expect(env.win.__runs).toBe(3)
    })

    it('reparses when the source changes', async () => {
        const components = { card: '<p class="v1">1</p>' }
        const env = makeEnv(components)
        document.body.innerHTML = '<x-card></x-card>'
        env.boot()
        await settle()
        components.card = '<p class="v2">2</p>'
        const added = document.createElement('div')
        added.innerHTML = '<x-card></x-card>'
        document.body.appendChild(added)
        await settle()
        expect([...document.querySelectorAll('p')].map((p) => p.className)).toEqual(['v1', 'v2'])
    })
})
