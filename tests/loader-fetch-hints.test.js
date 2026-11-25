/**
 * @vitest-environment happy-dom
 *
 * Loader fetch hints: while manifest.json is in flight the loader hints Alpine
 * and the modules that load whatever the manifest says. Script tags (and so
 * execution order) are untouched; conditional modules and integrity mode get no hints.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(process.env.LOADER_SRC || path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const VERSION = '0.5.199-next.0'
const BASE = `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib`
const hints = (rel) => [...document.head.querySelectorAll(`link[data-mnfst-hint][rel="${rel}"]`)].map(l => l.getAttribute('href'))

let manifestRequestedBeforeHints

function boot(attrs = {}, { alpineTag = false } = {}) {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = ''
    if (alpineTag) {
        const a = document.createElement('script')
        a.setAttribute('src', 'https://cdn.example/alpinejs@3/dist/cdn.min.js')
        a.setAttribute('defer', '')
        document.head.appendChild(a)
    }
    const s = document.createElement('script')
    s.setAttribute('src', `${BASE}/manifest.js`)
    s.setAttribute('data-version', VERSION)
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    document.head.appendChild(s)
    new Function(CODE)()
}

beforeEach(() => {
    for (const k of ['__manifestLoaderStarted', '__manifestLoaded', '__manifestPromise', '__manifestReady', '__manifestSwArmed', 'Manifest', 'Alpine']) delete window[k]
    manifestRequestedBeforeHints = null
    vi.stubGlobal('fetch', vi.fn((url) => {
        if (String(url).endsWith('/manifest.json')) {
            if (manifestRequestedBeforeHints === null) manifestRequestedBeforeHints = document.head.querySelectorAll('link[data-mnfst-hint][rel="preload"]').length === 0
            return new Promise(() => {}) // still in flight: hints must not wait for it
        }
        return Promise.resolve(new Response('', { status: 404 }))
    }))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

describe('loader fetch hints', () => {
    it('hints Alpine and unconditional modules before the manifest arrives, and injects no module tag early', () => {
        boot()
        const preloads = hints('preload')
        expect(preloads).toContain(`${BASE}/manifest.toasts.min.js`)
        expect(preloads).toContain(`${BASE}/manifest.defer.min.js`)
        expect(preloads.some(h => /alpinejs@[^/]+\/dist\/cdn\.min\.js$/.test(h))).toBe(true)
        expect(new Set(preloads).size).toBe(preloads.length)
        for (const link of document.head.querySelectorAll('link[data-mnfst-hint][rel="preload"]')) expect(link.getAttribute('as')).toBe('script')
        expect(document.querySelectorAll('script[src*="manifest.toasts"]').length).toBe(0)
        expect(manifestRequestedBeforeHints).toBe(true)
    })

    it('never hints the modules the manifest decides on', () => {
        boot()
        const preloads = hints('preload').join('\n')
        for (const name of ['data', 'localization', 'components', 'status']) expect(preloads).not.toContain(`manifest.${name}.min.js`)
    })

    it('preconnects to the module CDN when it is another origin', () => {
        boot()
        expect(hints('preconnect')).toEqual(['https://cdn.manifestx.dev'])
    })

    it('leaves omitted modules out', () => {
        boot({ 'data-omit': 'toasts' })
        expect(hints('preload').join('\n')).not.toContain('manifest.toasts.min.js')
    })

    it('with an explicit module list, hints only Alpine (the tags go in at once)', () => {
        boot({ 'data-modules': 'toasts' })
        const preloads = hints('preload')
        expect(preloads.length).toBe(1)
        expect(preloads[0]).toMatch(/alpinejs@/)
    })

    it('does not hint Alpine when the page loads its own', () => {
        boot({}, { alpineTag: true })
        expect(hints('preload').some(h => h.includes('alpinejs@'))).toBe(false)
    })

    it('hints a custom Alpine path as given', () => {
        boot({ 'data-alpine': '/vendor/alpine.js' })
        expect(hints('preload')).toContain('/vendor/alpine.js')
    })

    it('issues no hints with integrity checks on', () => {
        boot({ 'data-integrity': '' })
        expect(document.head.querySelectorAll('link[data-mnfst-hint]').length).toBe(0)
    })

    it('uses the module base when one is set, with no preconnect', () => {
        boot({ 'data-module-base': '/scripts' })
        expect(hints('preload')).toContain('/scripts/manifest.toasts.js')
        expect(hints('preconnect')).toEqual([])
    })
})
