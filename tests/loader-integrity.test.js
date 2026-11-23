/**
 * @vitest-environment happy-dom
 *
 * Loader SRI: integrity= on the loader tag turns on hash checks for every script it
 * injects, from a module map verified against the hash stamped into the loader.
 */
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const V = '9.9.9'
const sri = (s) => `sha384-${createHash('sha384').update(s).digest('base64')}`
const MAP = { 'manifest.toasts.min.js': sri('toasts'), 'manifest.toasts.js': sri('toasts-full'), 'manifest.defer.min.js': sri('d'), 'manifest.bindings.min.js': sri('b'), 'manifest.tooltips.min.js': sri('t'), 'alpinejs@3.17.5/dist/cdn.min.js': sri('alpine') }
const MAP_JSON = JSON.stringify(MAP)
const stamped = (map = MAP_JSON) => SRC
    .replace("const LOADER_VERSION = '0.0.0-dev';", `const LOADER_VERSION = '${V}';`)
    .replace("const MODULES_INTEGRITY = '';", `const MODULES_INTEGRITY = '${sri(map)}';`)
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick() }

let mapBody, fetchCalls
function boot(attrs = {}, code = stamped()) {
    window.happyDOM.setURL('https://site.example/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.min.js`)
    s.setAttribute('data-plugins', 'toasts')
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    document.head.appendChild(s)
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true })
    new Function(code)()
}
const injected = () => [...document.querySelectorAll('script[data-mnfst-loaded], script[data-mnfst-loading]')]

beforeEach(() => {
    for (const k of ['__manifestLoaderStarted', '__manifestLoaded', '__manifestReady', '__manifestSwArmed', '__manifestReadyCoordinator', 'Manifest', 'Alpine']) delete window[k]
    mapBody = MAP_JSON
    fetchCalls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
        fetchCalls.push({ url: String(url), opts })
        if (String(url).endsWith('/manifest.modules.integrity.json')) {
            // The browser enforces opts.integrity; mirror that here
            if (opts?.integrity && opts.integrity !== sri(mapBody)) throw new TypeError('integrity mismatch')
            return new Response(mapBody, { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response('', { status: 404 })
    }))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    vi.spyOn(console, 'warn').mockImplementation(() => { })
    vi.spyOn(console, 'error').mockImplementation(() => { })
})

describe('loader integrity', () => {
    it('integrity on the loader: map fetched with its stamped hash, every injected tag carries integrity + crossorigin', async () => {
        boot({ integrity: 'sha384-page' })
        await settle()
        const mapFetch = fetchCalls.find(c => c.url.endsWith('manifest.modules.integrity.json'))
        expect(mapFetch.url).toBe(`https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.modules.integrity.json`)
        expect(mapFetch.opts).toMatchObject({ integrity: sri(MAP_JSON), mode: 'cors', credentials: 'omit' })
        const tags = injected()
        expect(tags.map(t => t.src.split('/').pop()).sort()).toEqual(['cdn.min.js', 'manifest.bindings.min.js', 'manifest.defer.min.js', 'manifest.toasts.min.js'])
        for (const t of tags) {
            const alpine = t.src.includes('alpinejs@')
            expect(t.getAttribute('integrity')).toBe(alpine ? MAP['alpinejs@3.17.5/dist/cdn.min.js'] : MAP[t.src.split('/').pop()])
            expect(t.getAttribute('crossorigin')).toBe('anonymous')
            // No data-version: modules pin to the loader's own version
            if (!alpine) expect(t.src).toContain(`mnfst@${V}/`)
        }
    })

    it('runtime loads are checked too', async () => {
        boot({ integrity: 'sha384-page' })
        await settle()
        await window.Manifest.loadPlugin('tooltips')
        const t = document.querySelector('script[src*="manifest.tooltips.min.js"]')
        expect(t.getAttribute('integrity')).toBe(MAP['manifest.tooltips.min.js'])
    })

    it('data-integrity opts in without integrity on the loader; ="off" opts out', async () => {
        boot({ 'data-integrity': '' })
        await settle()
        expect(injected().every(t => t.getAttribute('integrity'))).toBe(true)
        for (const k of ['__manifestLoaderStarted', '__manifestSwArmed']) delete window[k]
        boot({ integrity: 'sha384-page', 'data-integrity': 'off' })
        await settle()
        expect(fetchCalls.filter(c => c.url.endsWith('integrity.json')).length).toBe(1)
    })

    it('no integrity on the loader: unchanged — no map fetch, no integrity attributes', async () => {
        boot({ 'data-version': V })
        await settle()
        expect(fetchCalls.some(c => c.url.endsWith('integrity.json'))).toBe(false)
        expect(injected().length).toBe(4)
        expect(injected().some(t => t.hasAttribute('integrity') || t.hasAttribute('crossorigin'))).toBe(false)
    })

    it('data-version other than the loader\'s own (e.g. latest) warns and loads unverified', async () => {
        boot({ integrity: 'sha384-page', 'data-version': 'latest' })
        await settle()
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`data-version="${V}"`))
        expect(fetchCalls.some(c => c.url.endsWith('integrity.json'))).toBe(false)
        expect(injected().length).toBe(4)
        expect(injected().some(t => t.hasAttribute('integrity'))).toBe(false)
    })

    it('a tampered map on every CDN fails closed: error naming the file, nothing injected', async () => {
        mapBody = JSON.stringify({ ...MAP, 'manifest.toasts.min.js': sri('evil') })
        boot({ integrity: 'sha384-page' })
        await settle()
        expect(fetchCalls.filter(c => c.url.endsWith('manifest.modules.integrity.json')).length).toBe(3)
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('manifest.modules.integrity.json could not be verified'))
        expect(injected().length).toBe(0)
    })

    it('a data-alpine version with no known hash warns and loads unverified; data-alpine-integrity checks it', async () => {
        boot({ integrity: 'sha384-page', 'data-alpine': '3.15.0' })
        await settle()
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('alpinejs@3.15.0/dist/cdn.min.js; loading it unverified'))
        expect(document.querySelector('script[src*="alpinejs@3.15.0"]').hasAttribute('integrity')).toBe(false)
        for (const k of ['__manifestLoaderStarted', '__manifestSwArmed', 'Alpine']) delete window[k]
        boot({ integrity: 'sha384-page', 'data-alpine': '3.15.0', 'data-alpine-integrity': sri('a315') })
        await settle()
        expect(document.querySelector('script[src*="alpinejs@3.15.0"]').getAttribute('integrity')).toBe(sri('a315'))
    })

    it('a module missing from the map is refused, loudly', async () => {
        boot({ integrity: 'sha384-page', 'data-plugins': 'toasts,router' })
        await settle()
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('manifest.router.min.js has no integrity hash'))
        expect(document.querySelector('script[src*="manifest.router"]')).toBe(null)
        expect(document.querySelector('script[src*="manifest.toasts.min.js"]')).toBeTruthy()
    })

    it('data-plugin-base: map and modules come from the base, unminified files hashed', async () => {
        mapBody = JSON.stringify({ ...MAP, 'manifest.defer.js': sri('d'), 'manifest.bindings.js': sri('b') })
        boot({ integrity: 'sha384-page', 'data-plugin-base': '/fw', 'data-plugins': 'toasts' }, stamped(mapBody))
        await settle()
        expect(fetchCalls.find(c => c.url.endsWith('integrity.json')).url).toBe('/fw/manifest.modules.integrity.json')
        expect(document.querySelector('script[src$="/fw/manifest.toasts.js"]').getAttribute('integrity')).toBe(MAP['manifest.toasts.js'])
    })

    it('an unbuilt loader warns and loads unverified', async () => {
        boot({ integrity: 'sha384-page' }, SRC)
        await settle()
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('need a built loader'))
        expect(injected().length).toBe(4)
    })
})
