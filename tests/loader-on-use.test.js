/**
 * @vitest-environment happy-dom
 *
 * Directive modules most pages never use (markdown, code, svg, combobox, slides,
 * colorpicker, datepicker, charts, virtual, export) are out of the default bundle and load
 * on use: a directive attribute (x-name, x-name.mod, x-name:arg), a magic in any attribute
 * value or inline script, or Code's plain-HTML triggers, found in the document, in
 * <template> content, in markup passed to Manifest.loadUsed, or in nodes inserted later.
 * LOADER_SRC=<file> runs the suite against another loader (e.g. the old one).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(process.env.LOADER_SRC || path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.217'
const MOVED = ['markdown', 'svg', 'code', 'combobox', 'slides', 'colorpicker', 'datepicker', 'charts', 'virtual', 'export']
const injected = () => [...document.querySelectorAll('script[src*="/lib/manifest."]')].map(s => s.getAttribute('src').replace(/.*\/lib\/manifest\.(.*)\.min\.js/, '$1'))
const moved = () => injected().filter(p => MOVED.includes(p))
const hints = () => [...document.querySelectorAll('link[data-mnfst-hint][rel=preload]')].map(l => l.getAttribute('href'))

// Each boot runs a fresh loader; an earlier one's usage watcher must not see this test's DOM
const NativeMO = window.MutationObserver
let observers = []
window.MutationObserver = class extends NativeMO { constructor(cb) { super(cb); observers.push(this) } }

beforeEach(() => {
    observers.forEach(o => o.disconnect())
    observers = []
    for (const k of ['__manifestLoaded', '__manifestPromise', '__manifestLoaderStarted', '__manifestReady', '__manifestSwArmed', '__manifestReadyCoordinator', 'Manifest', 'Capacitor', 'Alpine']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

function boot(attrs = {}, bodyHtml = '') {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = bodyHtml
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.js`)
    s.setAttribute('data-version', V)
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    document.head.appendChild(s)
    new Function(CODE)()
}

// [module, markup that uses it]
const DIRECTIVES = [
    ['charts', '<div x-chart="cfg"></div>'], ['charts', '<div x-chart.line="cfg"></div>'], ['charts', '<div x-chart:sales="cfg"></div>'],
    ['colorpicker', '<div x-colorpicker></div>'], ['colorpicker', '<button x-colorpicker.swatch></button>'],
    ['datepicker', '<input x-date>'], ['datepicker', '<div x-date.range="r"></div>'],
    ['combobox', '<input x-combobox="opts">'], ['combobox', '<input x-combobox.multiple.chips="opts">'],
    ['code', '<pre x-code="js"><code>a</code></pre>'], ['code', '<div x-code-group><pre name="a"></pre></div>'],
    ['code', '<pre><code class="hljs language-js">a</code></pre>'], ['code', '<p><code copy>npm i</code></p>'],
    ['markdown', '<div x-markdown="body"></div>'], ['markdown', '<div x-markdown.safe="body"></div>'],
    ['export', '<button x-export></button>'], ['export', '<button x-export.csv="opts"></button>'], ['export', '<button x-import.json></button>'],
    ['virtual', '<div x-virtual><template x-for="r in rows"><p></p></template></div>'], ['virtual', '<div x-virtual.rows></div>'],
    ['slides', '<div x-carousel></div>'], ['slides', '<div x-carousel.autoplay.loop></div>'],
    ['svg', '<span x-svg="src"></span>'], ['svg', '<span x-svg.safe="src"></span>'],
]
const MAGICS = [
    ['charts', '$chart', '<button @click="$chart(\'sales\').refresh()">r</button>'],
    ['colorpicker', '$colorpicker', '<span x-text="$colorpicker.hex"></span>'],
    ['datepicker', '$date', '<span :title="$date(\'due\').value"></span>'],
    ['export', '$export', '<button @click="$export({ format: \'csv\' })">e</button>'],
    ['export', '$import', '<button x-on:click="rows = await $import()">i</button>'],
]
const NEGATIVE = [
    '<div x-chartreuse></div>', '<div data-x-chart="1"></div>', '<div x-dates></div>', '<div x-date-format="y"></div>',
    '<div x-codex></div>', '<div x-svgs></div>', '<div x-markdownish></div>', '<div x-carousels></div>',
    '<span x-text="$charts"></span>', '<span x-text="$dateRange"></span>', '<span x-text="$exporter()"></span>',
    '<p>Use $chart and x-markdown here.</p>', '<p><code class="language-js">inline</code></p>', '<div class="language-js"></div>',
    '<pre><code>plain</code></pre>',
]
const name = (m) => m.replace(/\.min\.js$/, '')

describe('on-use directive modules: default bundle', () => {
    it('a page using none of them loads none of them, and the core still loads', async () => {
        boot({}, '<p x-text="title">Plain</p><button x-tooltip="\'t\'">b</button>'); await settle()
        expect(moved()).toEqual([])
        expect(injected()).toEqual(expect.arrayContaining(['router', 'utilities', 'icons', 'tooltips', 'dropdowns', 'tabs', 'toasts']))
    })

    it('none of them is hinted unconditionally while manifest.json is in flight', async () => {
        boot({}, '<p>x</p>')
        const h = hints()
        expect(h.some(u => /manifest\.tabs/.test(u))).toBe(true)
        for (const m of MOVED) expect(h.some(u => u.includes(`manifest.${m}.`)), m).toBe(false)
        await settle()
    })

    it('the ones the parsed page uses are hinted while manifest.json is in flight', async () => {
        boot({}, '<div x-chart="c"></div><template><pre x-code="js"></pre></template>')
        const h = hints()
        expect(h.some(u => u.includes('manifest.charts.')) && h.some(u => u.includes('manifest.code.'))).toBe(true)
        expect(h.some(u => u.includes('manifest.markdown.'))).toBe(false)
        await settle()
        expect(moved().sort()).toEqual(['charts', 'code'])
    })

    it('no on-use hint with an explicit module list', async () => {
        boot({ 'data-modules': 'tabs' }, '<div x-chart="c"></div>')
        expect(hints().some(u => u.includes('manifest.charts.'))).toBe(false)
        await settle()
    })

    it('Manifest.loadPlugin still knows every one of them', async () => {
        boot({ 'data-modules': 'tabs' }); await settle()
        for (const m of [...MOVED, 'import']) await window.Manifest.loadPlugin(m, V)
        expect(moved().sort()).toEqual([...MOVED].sort())
    })
})

describe('on-use directive modules: detection at boot', () => {
    for (const [mod, html] of DIRECTIVES) {
        it(`${html} loads ${mod}`, async () => {
            boot({}, html); await settle()
            expect(moved()).toEqual([mod])
        })
    }
    for (const [mod, magic, html] of MAGICS) {
        it(`${magic} in an attribute loads ${mod}`, async () => {
            boot({}, html); await settle()
            expect(moved()).toEqual([mod])
        })
        it(`${magic} in an inline script loads ${mod}`, async () => {
            boot({}, `<script>document.addEventListener('alpine:init', () => Alpine.data('x', () => ({ go() { return this.${magic} } })))</script>`); await settle()
            expect(moved()).toEqual([mod])
        })
    }
    it('directives and magics inside <template> content load (nested too)', async () => {
        boot({}, `<template x-if="a"><div x-chart="c"></div><template x-for="r in rows"><template x-if="r.open"><span x-text="$date.value"></span><div x-markdown="r.body"></div></template></template></template>`); await settle()
        expect(moved().sort()).toEqual(['charts', 'datepicker', 'markdown'])
    })
    it('content added between the parse and manifest.json arriving is still sniffed at boot', async () => {
        let release
        const gate = new Promise(r => { release = r })
        fetch.mockImplementation(async (url) => {
            if (String(url).includes('manifest.json')) { await gate; return new Response('{"name":"x"}', { status: 200, headers: { 'content-type': 'application/json' } }) }
            return new Response('', { status: 404 })
        })
        boot({}, '<main id="m"></main>')
        await settle(3)
        document.getElementById('m').innerHTML = '<div x-carousel></div>'
        await settle(3)
        expect(moved()).toEqual([])
        release()
        await settle()
        expect(moved()).toEqual(['slides'])
    })
    it('a <template> carrying the directive itself loads it', async () => {
        boot({}, '<template x-colorpicker><div>default picker</div></template>'); await settle()
        expect(moved()).toEqual(['colorpicker'])
    })
    for (const html of NEGATIVE) {
        it(`${html} loads nothing`, async () => {
            boot({}, html); await settle()
            expect(moved()).toEqual([])
        })
    }
    it('each module loads once however many elements use it', async () => {
        boot({}, '<div x-chart="a"></div><div x-chart.line="b"></div><span x-text="$chart.ready"></span><template><div x-chart></div></template>'); await settle()
        expect(injected().filter(p => p === 'charts').length).toBe(1)
    })
})

describe('on-use directive modules: later content', () => {
    for (const [mod, html] of [...DIRECTIVES, ...MAGICS.map(([m, , h]) => [m, h])]) {
        it(`Manifest.loadUsed('${html}') loads ${mod} and resolves after it`, async () => {
            boot({}, '<p>x</p>'); await settle()
            expect(moved()).toEqual([])
            const out = await window.Manifest.loadUsed(html)
            expect(out).toContain(mod)
            expect(moved()).toEqual([mod])
        })
        it(`${html} inserted after boot loads ${mod}`, async () => {
            boot({}, '<main id="m"></main>'); await settle()
            document.getElementById('m').innerHTML = html
            await settle()
            expect(moved()).toEqual([mod])
        })
    }
    it('an on-use attribute added to a live element loads its module', async () => {
        boot({}, '<main id="m"><div id="t"></div></main>'); await settle()
        document.getElementById('t').setAttribute('x-chartreuse', '')
        document.getElementById('t').setAttribute('class', 'x-chart')
        await settle()
        expect(moved()).toEqual([])
        document.getElementById('t').setAttribute('x-chart', '')
        await settle()
        expect(moved()).toEqual(['charts'])
    })
    it('Manifest.loadUsed(element) reads template content too', async () => {
        boot({}, '<p>x</p>'); await settle()
        const t = document.createElement('template')
        t.innerHTML = '<section><div x-svg="s"></div></section>'
        await window.Manifest.loadUsed(t)
        expect(moved()).toEqual(['svg'])
    })
    it('a second caller waits for a load still in flight', async () => {
        boot({}, '<p>x</p>'); await settle()
        const a = window.Manifest.loadUsed('<div x-chart></div>')
        const b = window.Manifest.loadUsed('<div x-chart.bar></div>')
        expect(await b).toEqual(['charts'])
        await a
        expect(injected().filter(p => p === 'charts').length).toBe(1)
    })
    for (const html of NEGATIVE) {
        it(`${html} inserted after boot loads nothing`, async () => {
            boot({}, '<main id="m"></main>'); await settle()
            document.getElementById('m').innerHTML = html
            await settle()
            expect(moved()).toEqual([])
        })
    }
})

describe('on-use directive modules: explicit configuration', () => {
    it('data-modules="a,b" loads exactly those, with no sniffing', async () => {
        boot({ 'data-modules': 'tabs,charts' }, '<div x-markdown="b"></div><div x-chart></div>'); await settle()
        expect(moved()).toEqual(['charts'])
        document.body.insertAdjacentHTML('beforeend', '<div x-svg="s"></div>')
        await settle()
        expect(moved()).toEqual(['charts'])
    })
    it('data-modules="+name" always loads it, with nothing on the page', async () => {
        boot({ 'data-modules': '+markdown' }, '<p>x</p>'); await settle()
        expect(moved()).toEqual(['markdown'])
        expect(injected()).toContain('tabs')
    })
    it('data-modules="+import" loads export', async () => {
        boot({ 'data-modules': '+import' }, '<p>x</p>'); await settle()
        expect(moved()).toEqual(['export'])
    })
    it('data-omit wins over usage and says so once', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        boot({ 'data-omit': 'charts' }, '<div x-chart="c"></div><div x-code="js"></div>'); await settle()
        expect(moved()).toEqual(['code'])
        const said = warn.mock.calls.map(a => a.join(' ')).filter(s => s.includes('data-omit lists charts'))
        expect(said.length).toBe(1)
        document.body.insertAdjacentHTML('beforeend', '<div x-chart.line></div>')
        await settle()
        expect(moved()).toEqual(['code'])
        warn.mockRestore()
    })
    it('data-module-base serves on-use modules from that base', async () => {
        boot({ 'data-module-base': '/scripts' }, '<div x-svg="s"></div>'); await settle()
        expect([...document.querySelectorAll('script[src="/scripts/manifest.svg.js"]')].length).toBe(1)
    })
    it('a failed on-use load warns once and is not retried', async () => {
        boot({}, '<main id="m"></main>'); await settle()
        window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = false
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        const append = document.head.appendChild.bind(document.head)
        let attempts = 0
        vi.spyOn(document.head, 'appendChild').mockImplementation((n) => {
            if (n.tagName === 'SCRIPT' && /manifest\.svg/.test(n.src)) { attempts++; setTimeout(() => n.onerror && n.onerror(new Event('error')), 0); return n }
            return append(n)
        })
        document.getElementById('m').innerHTML = '<span x-svg="a"></span>'
        await settle()
        document.getElementById('m').innerHTML = '<span x-svg="b"></span>'
        await settle()
        const failedOnce = warn.mock.calls.map(a => a.join(' ')).filter(s => s.includes('Failed to load plugin svg'))
        expect(failedOnce.length).toBe(1)
        expect(attempts).toBe(3) // one per CDN host, once
        document.head.appendChild.mockRestore()
        warn.mockRestore()
    })
})

describe('on-use directive modules: content fetched before the boot sniff', () => {
    const holdManifest = () => {
        let release
        const gate = new Promise(r => { release = r })
        fetch.mockImplementation(async (url) => {
            if (String(url).includes('manifest.json')) { await gate; return new Response('{"name":"x"}', { status: 200, headers: { 'content-type': 'application/json' } }) }
            return new Response('', { status: 404 })
        })
        return release
    }
    // DOMContentLoaded still to come (a slow deferred script)
    const parsing = () => {
        Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'interactive' })
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ domContentLoadedEventEnd: 0 }])
        return () => { delete document.readyState; performance.getEntriesByType.mockRestore(); document.dispatchEvent(new Event('DOMContentLoaded')) }
    }
    const now = async (p) => { let v = 'pending'; p.then(x => { v = x }); for (let i = 0; i < 3; i++) await Promise.resolve(); return v }

    it('a call before manifest.json arrives waits, then loads the module and resolves after it', async () => {
        const release = holdManifest()
        boot({}, '<p>x</p>')
        const out = window.Manifest.loadUsed('<div x-chart="c"></div>')
        await settle(3)
        expect(moved()).toEqual([])
        release()
        expect(await out).toEqual(['charts'])
        expect(moved()).toEqual(['charts'])
    })
    it('a call before DOMContentLoaded loads at once', async () => {
        const done = parsing()
        boot({}, '<p>x</p>')
        await settle()
        expect(injected()).toContain('tabs')
        const out = window.Manifest.loadUsed('<section><div x-chart="c"></div></section>')
        expect(moved()).toEqual(['charts'])
        done()
        expect(await out).toEqual(['charts'])
        await settle()
        expect(moved()).toEqual(['charts'])
    })
    it('a module the boot sniff also finds loads once', async () => {
        const done = parsing()
        boot({}, '<div x-chart="a"></div>')
        await settle()
        const out = window.Manifest.loadUsed('<div x-chart="b"></div><div x-date></div>')
        done()
        await out
        await settle()
        expect(injected().filter(p => p === 'charts').length).toBe(1)
        expect(moved().sort()).toEqual(['charts', 'datepicker'])
    })
    it('data-omit is respected', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        const release = holdManifest()
        boot({ 'data-omit': 'charts' }, '<p>x</p>')
        const out = window.Manifest.loadUsed('<div x-chart="c"></div><div x-svg="s"></div>')
        release()
        expect(await out).toEqual(['svg'])
        await settle()
        expect(moved()).toEqual(['svg'])
        warn.mockRestore()
    })
    it('with an explicit module list it returns nothing at once, never waiting', async () => {
        const release = holdManifest()
        boot({ 'data-modules': 'tabs' }, '<p>x</p>')
        expect(await now(window.Manifest.loadUsed('<div x-chart="c"></div>'))).toEqual([])
        release()
        await settle()
        expect(await now(window.Manifest.loadUsed('<div x-chart="c"></div>'))).toEqual([])
        expect(moved()).toEqual([])
    })
})

describe('on-use directive modules: execution order', () => {
    const asyncOf = (m) => [...document.querySelectorAll(`script[src*="/lib/manifest.${m}."]`)].map(s => s.async)
    it('a module requested through Manifest.loadUsed runs as it arrives; the boot sniff keeps order', async () => {
        boot({}, '<div x-date></div>'); await settle()
        await window.Manifest.loadUsed('<div x-chart></div>')
        expect(asyncOf('charts')).toEqual([true])
        expect(asyncOf('datepicker')).toEqual([false])
        expect(asyncOf('tabs')).toEqual([false])
    })
    it('a module already requested early is not hinted again at DOMContentLoaded', async () => {
        Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'interactive' })
        vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ domContentLoadedEventEnd: 0 }])
        boot({}, '<div x-chart="a"></div>')
        await settle()
        window.Manifest.loadUsed('<div x-chart="b"></div>')
        delete document.readyState; performance.getEntriesByType.mockRestore()
        document.dispatchEvent(new Event('DOMContentLoaded'))
        await settle()
        expect(hints().some(u => u.includes('manifest.charts.'))).toBe(false)
        expect(injected().filter(p => p === 'charts').length).toBe(1)
    })
})
