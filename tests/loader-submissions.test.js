/**
 * @vitest-environment happy-dom
 *
 * Submissions is not in the default bundle: it loads on first x-submit,
 * when listed in data-plugins, or for x-submit in content added later.
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

describe('submissions plugin loading', () => {
    it('is not in the default bundle', async () => {
        boot({}, '<form action="/_forms" method="post"></form>'); await settle()
        expect(injected()).toContain('tabs')
        expect(injected()).not.toContain('submissions')
    })

    it('loads once when a form uses x-submit', async () => {
        boot({}, '<form x-submit action="/_forms"></form><form x-submit action="/_forms/b"></form>'); await settle()
        expect(injected().filter(p => p === 'submissions').length).toBe(1)
    })

    it('does not load for look-alike attributes or @submit', async () => {
        boot({}, '<form x-submitted @submit.prevent="go()" x-on:submit="go()"></form>'); await settle()
        expect(injected()).not.toContain('submissions')
    })

    it('loads from template content', async () => {
        boot({}, '<template x-if="open"><form x-submit></form></template>'); await settle()
        expect(injected()).toContain('submissions')
    })

    it('loads when listed explicitly or additively', async () => {
        boot({ 'data-plugins': '+submissions' }); await settle()
        expect(injected()).toContain('submissions')
        expect(injected()).toContain('tabs')
    })

    it('Manifest.loadPlugin("submissions") is a known plugin', async () => {
        boot({ 'data-plugins': 'tabs' }); await settle()
        window.Manifest.loadPlugin('submissions', V)
        await settle()
        expect(injected()).toContain('submissions')
    })

    it('content inserted after boot loads the plugin', async () => {
        boot({}, '<main id="m"></main>'); await settle()
        expect(injected()).not.toContain('submissions')
        document.getElementById('m').innerHTML = '<form x-submit action="/_forms"></form>'
        await settle()
        expect(injected()).toContain('submissions')
    })

    it('rich text still loads alongside it', async () => {
        boot({}, '<form x-submit><div x-rich-text></div></form>'); await settle()
        expect(injected()).toContain('submissions')
        expect(injected()).toContain('rich.text')
    })

    it('an explicit list without it stays a constraint', async () => {
        boot({ 'data-plugins': 'tabs' }, '<form x-submit></form>'); await settle()
        expect(injected()).not.toContain('submissions')
    })
})
