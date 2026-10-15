/**
 * @vitest-environment happy-dom
 *
 * Rich Text is not in the default bundle: it loads on use (x-rich-text / $rich),
 * when listed in data-plugins, and ahead of Edit, which depends on it.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.217'
const injected = () => [...document.querySelectorAll('script[src*="/lib/manifest."]')].map(s => s.getAttribute('src').replace(/.*\/lib\/manifest\.(.*)\.min\.js/, '$1'))

beforeEach(() => {
    for (const k of ['__manifestLoaded', '__manifestPromise', '__manifestLoaderStarted', '__manifestReady', '__manifestSwArmed', 'Manifest', 'Capacitor']) delete window[k]
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

describe('rich-text plugin loading', () => {
    it('is not in the default bundle', async () => {
        boot({}, '<p>Plain page</p>'); await settle()
        expect(injected()).toContain('tabs')
        expect(injected()).not.toContain('rich.text')
        expect(injected()).not.toContain('text.edit')
    })

    it('loads when the page uses x-rich-text', async () => {
        boot({}, '<div x-rich-text.html="post"></div>'); await settle()
        expect(injected().filter(p => p === 'rich.text').length).toBe(1)
    })

    it('loads for a bare control or menu attribute', async () => {
        boot({}, '<button x-rich-text-menu></button>'); await settle()
        expect(injected()).toContain('rich.text')
    })

    it('loads when the page uses $rich', async () => {
        boot({}, '<button @click="$rich.strong()">B</button>'); await settle()
        expect(injected()).toContain('rich.text')
    })

    it('loads from template content', async () => {
        boot({}, '<template x-if="open"><div x-rich-text></div></template>'); await settle()
        expect(injected()).toContain('rich.text')
    })

    it('loads when listed explicitly', async () => {
        boot({ 'data-plugins': 'rich-text' }); await settle()
        expect(injected()).toContain('rich.text')
    })

    it('loads additively with +rich-text', async () => {
        boot({ 'data-plugins': '+rich-text' }); await settle()
        expect(injected().filter(p => p === 'rich.text').length).toBe(1)
        expect(injected()).toContain('tabs')
    })

    it('loads ahead of edit, which depends on it', async () => {
        boot({ 'data-plugins': 'edit' }); await settle()
        const list = injected()
        expect(list).toContain('edit')
        expect(list.indexOf('rich.text')).toBeGreaterThan(-1)
        expect(list.indexOf('rich.text')).toBeLessThan(list.indexOf('edit'))
    })

    it('Manifest.loadPlugin("edit") brings rich-text first', async () => {
        boot({ 'data-plugins': 'tabs' }); await settle()
        expect(injected()).not.toContain('rich.text')
        window.Manifest.loadPlugin('edit', V)
        await settle()
        const list = injected()
        expect(list.indexOf('rich.text')).toBeGreaterThan(-1)
        expect(list.indexOf('rich.text')).toBeLessThan(list.indexOf('edit'))
    })

    it('Manifest.loadPlugin("rich-text") is a known plugin', async () => {
        boot({ 'data-plugins': 'tabs' }); await settle()
        window.Manifest.loadPlugin('rich-text', V)
        await settle()
        expect(injected()).toContain('rich.text')
    })

    it('$rich detection is word-bounded', async () => {
        boot({}, '<button @click="$richness = 1">x</button>'); await settle()
        expect(injected()).not.toContain('rich.text')
    })

    it('data-plugins="text-edit" warns once about the rename and loads nothing for it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        boot({ 'data-plugins': 'tabs,text-edit' }); await settle()
        const said = warn.mock.calls.map(a => a.join(' ')).filter(s => s.includes('text-edit was renamed to rich-text'))
        expect(said.length).toBe(1)
        expect(injected()).not.toContain('text.edit')
        expect(injected()).not.toContain('rich.text')
        warn.mockRestore()
    })

    it('Manifest.loadUsed() loads on-use plugins referenced by component HTML', async () => {
        boot({}, '<p>x</p>'); await settle()
        expect(injected()).not.toContain('rich.text')
        const loading = window.Manifest.loadUsed('<section><div x-rich-text.html="body"></div></section>')
        await settle()
        expect(injected()).toContain('rich.text')
        await loading
    })

    it('Manifest.loadUsed() ignores HTML that uses nothing', async () => {
        boot({}, '<p>x</p>'); await settle()
        expect(await window.Manifest.loadUsed('<p x-text="$x.title"></p>')).toEqual([])
        expect(injected()).not.toContain('rich.text')
    })

    it('content inserted after boot (x-html, markdown) loads the plugin', async () => {
        boot({}, '<main id="m"></main>'); await settle()
        expect(injected()).not.toContain('rich.text')
        document.getElementById('m').innerHTML = '<div x-rich-text></div>'
        await settle()
        expect(injected()).toContain('rich.text')
    })

    it('an explicit list without it stays a constraint', async () => {
        boot({ 'data-plugins': 'tabs' }, '<div x-rich-text></div>'); await settle()
        expect(injected()).not.toContain('rich.text')
    })
})
