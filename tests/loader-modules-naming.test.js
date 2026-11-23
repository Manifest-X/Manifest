/**
 * @vitest-environment happy-dom
 *
 * `data-modules` / `data-module-base` / `Manifest.loadModule` are canonical;
 * the plugin-named forms stay as aliases.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.199'
const srcs = () => [...document.querySelectorAll('script[src*="manifest."]')].map(s => s.getAttribute('src'))
const injected = () => srcs().filter(s => s.includes('/lib/manifest.')).map(s => s.replace(/.*\/lib\/manifest\.(.*)\.min\.js/, '$1'))

beforeEach(() => {
    for (const k of ['__manifestLoaded', '__manifestPromise', '__manifestLoaderStarted', '__manifestReady', '__manifestSwArmed', 'Manifest']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

function boot(attrs = {}) {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = ''
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.js`)
    s.setAttribute('data-version', V)
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    document.head.appendChild(s)
    new Function(CODE)()
}

describe('module naming', () => {
    it('data-modules selects the set', async () => {
        boot({ 'data-modules': 'toasts' }); await settle()
        expect(injected()).toContain('toasts')
        expect(injected()).not.toContain('router')
    })

    it('data-plugins still works as an alias', async () => {
        boot({ 'data-plugins': 'toasts' }); await settle()
        expect(injected()).toContain('toasts')
        expect(injected()).not.toContain('router')
    })

    it('data-modules wins when both are present', async () => {
        boot({ 'data-modules': 'toasts', 'data-plugins': 'router' }); await settle()
        expect(injected()).toContain('toasts')
        expect(injected()).not.toContain('router')
    })

    it('data-module-base resolves module URLs, like data-plugin-base', async () => {
        boot({ 'data-modules': 'toasts', 'data-module-base': '/fw' }); await settle()
        expect(srcs().some(s => /\/fw\/manifest\.toasts\.js$/.test(s))).toBe(true)
    })

    it('Manifest.loadModule and getModuleUrl alias the plugin-named API', async () => {
        boot({ 'data-modules': 'toasts' }); await settle()
        expect(window.Manifest.loadModule).toBe(window.Manifest.loadPlugin)
        expect(window.Manifest.getModuleUrl).toBe(window.Manifest.getPluginUrl)
    })
})
