/**
 * @vitest-environment happy-dom
 *
 * Loader: data-alpine values (pin default, versions and ranges, URLs and paths, skip) and
 * detection of a page's own Alpine tag.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const PIN = /DEFAULT_ALPINE_VERSION = '([^']+)'/.exec(CODE)[1]
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.217'
const LOADER = `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.js`
const cdn = (v) => expect.stringMatching(new RegExp(`^https://[^/]+/(npm/)?alpinejs@${v.replace(/\./g, '\\.')}/dist/cdn\\.min\\.js$`))
const alpineTags = () => [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')).filter(src => src !== LOADER && !src.includes('/lib/manifest.'))

beforeEach(() => {
    for (const k of ['__manifestLoaded', '__manifestPromise', '__manifestLoaderStarted', '__manifestReady', '__manifestReadyCoordinator', '__manifestSwArmed', 'Manifest', 'Capacitor', 'Alpine']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

async function boot(dataAlpine, headHtml = '') {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">' + headHtml
    document.body.innerHTML = ''
    const s = document.createElement('script')
    s.setAttribute('src', LOADER)
    s.setAttribute('data-version', V)
    s.setAttribute('data-plugins', 'icons')
    if (dataAlpine !== undefined) s.setAttribute('data-alpine', dataAlpine)
    document.head.appendChild(s)
    new Function(CODE)()
    await settle()
    return alpineTags()
}

describe('data-alpine', () => {
    it('defaults to the pinned version', async () => {
        expect(await boot()).toEqual([cdn(PIN)])
    })

    it('takes a version as a CDN version tag', async () => {
        expect(await boot('3.14.1')).toEqual([cdn('3.14.1')])
    })

    it('trims whitespace around a version', async () => {
        expect(await boot(' 3.14.1 ')).toEqual([cdn('3.14.1')])
    })

    it('takes a range as a CDN range, so a bare major floats', async () => {
        expect(await boot('3')).toEqual([cdn('3')])
    })

    it.each([
        ['https://example.com/alpine.min.js'],
        ['/vendor/alpine.js'],
        ['./vendor/alpine.js'],
        ['../vendor/alpine.js'],
        ['vendor/alpine.js'],
        ['alpine.min.js'],
    ])('loads %s as a URL', async (value) => {
        expect(await boot(value)).toEqual([value])
    })

    it.each([['false'], ['none'], ['None'], ['off']])('loads no Alpine for %s, without a load error', async (value) => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(await boot(value)).toEqual([])
        expect(error.mock.calls.filter(c => String(c[0]).includes('Alpine'))).toEqual([])
        error.mockRestore()
    })

    it.each([['/vendor/alpine.mjs'], ['https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/module.esm.js']])('warns and loads nothing for an ES module build: %s', async (value) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        expect(await boot(value)).toEqual([])
        expect(warn.mock.calls.some(c => String(c[0]).includes('ES module'))).toBe(true)
        warn.mockRestore()
    })

    it('leaves a page\'s own Alpine tag alone', async () => {
        expect(await boot(undefined, '<script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script>'))
            .toEqual(['https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js'])
    })

    it.each([
        ['https://cdn.jsdelivr.net/npm/@alpinejs/csp@3.14.1/dist/cdn.min.js'],
        ['https://cdn.jsdelivr.net/npm/@alpinejs/csp/dist/cdn.min.js'],
    ])('treats the CSP build as Alpine itself: %s', async (csp) => {
        expect(await boot(undefined, `<script async src="${csp}"></script>`)).toEqual([csp])
    })

    it('still loads Alpine next to an Alpine plugin tag', async () => {
        const focus = 'https://cdn.jsdelivr.net/npm/@alpinejs/focus@3.14.1/dist/cdn.min.js'
        expect(await boot(undefined, `<script defer src="${focus}"></script>`))
            .toEqual([focus, cdn(PIN)])
    })
})
