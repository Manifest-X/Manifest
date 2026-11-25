/**
 * @vitest-environment happy-dom
 *
 * An on-use module not registered when Alpine walks an element that uses it: the element and
 * its subtree are held uninitialised (Alpine.deferInit) and started once, after the directive
 * registers. Nothing already initialised is destroyed or re-run; siblings start at once; a
 * failed load starts held elements anyway. Magics answer through a forwarding stand-in: a call
 * to a function-valued magic waits for the module and runs once; captured references forward.
 * Module scripts don't execute in happy-dom: a test registers the directive or magic itself,
 * as the module would on arrival.
 * LOADER_SRC=<file> runs the suite against another loader (e.g. the old one).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(process.env.LOADER_SRC || path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.217'

const warnings = []
const count = (k) => { window.__c[k] = (window.__c[k] || 0) + 1 }
beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    vi.spyOn(console, 'warn').mockImplementation((...a) => warnings.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a) => warnings.push(a.join(' ')))
    window.__c = {}
    window.count = count
    window.happyDOM.setURL('https://site.example/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = `<div id="app" x-data="{ n: 1 }"><main id="host"></main><div id="late"></div></div>`
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.js`)
    s.setAttribute('data-version', V)
    document.head.appendChild(s)
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true })
    new Function(CODE)()
    Object.defineProperty(document, 'currentScript', { value: null, configurable: true })
    await settle()
    window.Alpine = Alpine
    document.addEventListener('alpine:init', () => {
        Alpine.data('cap', () => ({ init() { window.__captured = this.$export } }))
        Alpine.magic('chart', () => 'app-owned')
    })
    Alpine.start()
    await settle()
    // Magics only after boot: a boot read would load (here: never run) the module first
    document.getElementById('late').innerHTML = `<p id="date" x-text="'v:' + String($date)"></p><button id="exp" @click="window.__ret = $export({ format: 'csv' })">e</button>`
    await settle()
})

describe('late on-use modules', () => {
    it('magics read before their module arrives answer empty, without errors', () => {
        expect(document.getElementById('date').textContent).toBe('v:')
        expect(warnings.filter(w => /Expression Error|not defined/.test(w))).toEqual([])
    })

    it('an element using an unregistered directive is held; siblings start at once', async () => {
        document.getElementById('host').innerHTML = `
            <section id="held" x-data="{ v: 'live' }" x-init="count('held')" x-chart="{}"><span id="kid" x-init="count('kid')" x-text="v"></span></section>
            <div id="sib" x-data x-init="count('sib')"></div>`
        await settle()
        expect(window.__c.sib).toBe(1)
        expect(window.__c.held).toBeUndefined()
        expect(window.__c.kid).toBeUndefined()
        expect(document.getElementById('kid').textContent).toBe('')
        // Prerender waits while anything is held
        expect(window.ManifestPending.labels()).toContain('held')
    })

    it('once the directive registers, the held element starts exactly once', async () => {
        const ran = []
        Alpine.directive('chart', (el) => { ran.push(el.id) })
        await settle()
        expect(ran).toEqual(['held'])
        expect(window.__c.held).toBe(1)
        expect(window.__c.kid).toBe(1)
        expect(document.getElementById('kid').textContent).toBe('live')
        expect(window.ManifestPending.labels()).not.toContain('held')
        // Inserted after registration: Alpine's own walk, once
        document.getElementById('host').insertAdjacentHTML('beforeend', '<div id="later" x-chart></div>')
        await settle()
        expect(ran).toEqual(['held', 'later'])
        expect(window.__c.held).toBe(1)
    })

    it('a scope-providing directive reaches its children with no expression errors', async () => {
        document.getElementById('host').insertAdjacentHTML('beforeend', `<div id="car" x-carousel><span id="slides" x-text="total"></span></div>`)
        await settle()
        Alpine.directive('carousel', (el) => { Alpine.bind(el, { 'x-data'() { return { total: 3 } } }) })
        await settle()
        expect(document.getElementById('slides').textContent).toBe('3')
        expect(warnings.filter(w => /Expression Error|not defined/.test(w))).toEqual([])
    })

    it('an attribute added to a live element runs just that directive once it registers', async () => {
        const el = document.getElementById('sib')
        el.setAttribute('x-date', '')
        await settle()
        const ran = []
        Alpine.directive('date', (e) => ran.push(e.id))
        await settle()
        expect(ran).toEqual(['sib'])
        expect(window.__c.sib).toBe(1)
    })

    it('a call to a function-valued magic waits for the module and runs once', async () => {
        document.getElementById('exp').click()
        const ret = window.__ret
        expect(typeof ret.then).toBe('function')
        let calls = 0
        Alpine.magic('export', () => async (opts) => { calls++; return 'done:' + opts.format })
        expect(await ret).toBe('done:csv')
        expect(calls).toBe(1)
    })

    it('a reference captured before the module arrived forwards to the real magic', async () => {
        document.getElementById('host').insertAdjacentHTML('beforeend', '<div x-data="cap"></div>')
        await settle()
        expect(await window.__captured({ format: 'json' })).toBe('done:json')
    })

    it('readers re-run against the real magic once it registers', async () => {
        Alpine.magic('date', () => 'real-date')
        await settle()
        expect(document.getElementById('date').textContent).toBe('v:real-date')
    })

    it('an app\'s own magic of the same name is kept', async () => {
        document.getElementById('host').insertAdjacentHTML('beforeend', '<p id="own" x-text="$chart"></p>')
        await settle()
        expect(document.getElementById('own').textContent).toBe('app-owned')
    })

    it('a failed load starts held elements anyway and warns once', async () => {
        window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = false
        const append = document.head.appendChild.bind(document.head)
        const spy = vi.spyOn(document.head, 'appendChild').mockImplementation((n) => {
            if (n.tagName === 'SCRIPT' && /manifest\.svg/.test(n.src)) { setTimeout(() => n.onerror && n.onerror(new Event('error')), 0); return n }
            return append(n)
        })
        document.getElementById('host').insertAdjacentHTML('beforeend', '<div id="sv" x-data x-init="count(\'svg\')" x-svg="s"></div><div id="sv2" x-data x-init="count(\'svg\')" x-svg="t"></div>')
        await settle(40)
        expect(window.__c.svg).toBe(2)
        expect(warnings.filter(w => w.includes('svg failed to load')).length).toBe(1)
        spy.mockRestore()
    })

    it('a module that loads but never registers: held elements start once after 10 s', async () => {
        window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
        vi.useFakeTimers({ toFake: ['setTimeout'] })
        try {
            document.getElementById('host').insertAdjacentHTML('beforeend', '<div id="g1" x-data x-init="count(\'g1\')" x-combobox="o"><i x-init="count(\'g1kid\')"></i></div>')
            await vi.advanceTimersByTimeAsync(9000)
            expect(window.__c.g1).toBeUndefined()
            expect(window.ManifestPending.labels()).toContain('held')
            await vi.advanceTimersByTimeAsync(1500)
            expect(window.__c.g1).toBe(1)
            expect(window.__c.g1kid).toBe(1)
            expect(window.ManifestPending.labels()).not.toContain('held')
            // Not held again
            await vi.advanceTimersByTimeAsync(20000)
            expect(window.__c.g1).toBe(1)
            expect(warnings.filter(w => w.includes('combobox has not started 10 s after loading')).length).toBe(1)
        } finally { vi.useRealTimers() }
    })

    it('if it registers after the give-up, its directive applies once', async () => {
        const ran = []
        Alpine.directive('combobox', (el) => ran.push(el.id))
        await settle()
        expect(ran).toEqual(['g1'])
        expect(window.__c.g1).toBe(1)
    })

    it('a ref inside a held element resolves during the hold and after it', async () => {
        document.getElementById('host').insertAdjacentHTML('beforeend', '<div id="rr" x-data="{ seen: \'\' }" x-init="seen = $refs.r ? \'has\' : \'no\'"><div x-ref="r" x-colorpicker></div><span id="rs" x-text="seen"></span></div>')
        await settle()
        expect(document.getElementById('rs').textContent).toBe('has')
    })

    it('state typed while held is put back once it starts; nothing can leave the page held', async () => {
        document.getElementById('host').insertAdjacentHTML('beforeend', `<div id="fw" x-data="{ t: 'init', lazy: 'l0', many: [], root: 'r0' }">
            <section x-virtual><input id="ht" x-model="t"><input id="hl" x-model.lazy="lazy"><select id="hm" multiple x-model="many"><option>a</option><option>b</option><option>c</option></select><input id="hf" type="file"><input id="hx"></section>
            <input id="hr" x-code-group x-model="root">
            <div id="gone" x-ref="gone" x-code-group></div>
        </div>`)
        await settle()
        expect(window.ManifestPending.labels()).toContain('held')
        document.getElementById('ht').value = 'typed'
        document.getElementById('hl').value = 'lazy typed'
        const opts = document.getElementById('hm').options
        opts[0].selected = true; opts[2].selected = true
        document.getElementById('hr').value = 'root typed'
        // A control whose restore throws
        Object.defineProperty(document.getElementById('hx'), 'value', { get: () => 'x', set: () => { throw new Error('boom') }, configurable: true })
        document.getElementById('gone').remove()
        Alpine.directive('virtual', () => { })
        Alpine.directive('code-group', () => { })
        Alpine.directive('colorpicker', () => { })
        await settle()
        const d = Alpine.$data(document.getElementById('fw'))
        expect([d.t, d.lazy, Alpine.raw(d.many), d.root]).toEqual(['typed', 'lazy typed', ['a', 'c'], 'root typed'])
        expect(window.ManifestPending.labels()).not.toContain('held')
        expect(Alpine.evaluate(document.getElementById('fw'), '$refs.gone')).toBeUndefined()
    })

    it('a restore that throws still releases the hold', async () => {
        document.getElementById('host').insertAdjacentHTML('beforeend', '<div id="tw" x-data><section x-markdown="m"><input id="tx"></section></div>')
        await settle()
        expect(window.ManifestPending.labels()).toContain('held')
        Object.defineProperty(document.getElementById('tx'), 'value', { get: () => 'x', set: () => { throw new Error('boom') }, configurable: true })
        Alpine.directive('markdown', () => { })
        await settle()
        expect(window.ManifestPending.labels()).not.toContain('held')
    })
})
