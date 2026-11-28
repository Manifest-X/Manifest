/**
 * @vitest-environment happy-dom
 *
 * Loader: `data-tailwind` fetches the bundled Tailwind engine in parallel with modules. The retired
 * `data-mnfst-utilities-complete` flag no longer skips it, on a <style> or a <link>; the publish-time
 * stamp that replaces it is covered in loader-tailwind-stamp.test.js.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const VERSION = '0.5.199-next.0'

function boot({ headExtra = '', tailwind = true } = {}) {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = `<link rel="manifest" href="/manifest.json">${headExtra}`
    document.body.innerHTML = ''
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib/manifest.js`)
    s.setAttribute('data-version', VERSION)
    s.setAttribute('data-plugins', 'toasts,data')
    if (tailwind) s.setAttribute('data-tailwind', '')
    document.head.appendChild(s)
    new Function(CODE)()
}

beforeEach(() => {
    for (const k of ['__manifestLoaderStarted', '__manifestLoaded', '__manifestReady', 'Manifest']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).endsWith('/manifest.json')) return new Response(JSON.stringify({ name: 'x', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response('', { status: 404 })
    }))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

describe('loader: shipped utilities sheets without a stamp still load the engine', () => {
    it('loads the Tailwind engine normally with no static sheet', async () => {
        boot()
        await settle()
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(1)
    })

    it('still loads it when the static sheet is present but not marked complete', async () => {
        boot({ headExtra: '<style data-mnfst-utilities>.gap-2{gap:.5rem}</style>' })
        await settle()
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(1)
    })

    it('loads it for a <link> sheet carrying the retired complete flag', async () => {
        boot({ headExtra: '<link rel="stylesheet" data-mnfst-utilities data-mnfst-utilities-complete href="data:text/css,.gap-2{gap:.5rem}">' })
        await settle()
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(1)
    })

    it('loads it for an inline <style> sheet carrying the retired complete flag', async () => {
        boot({ headExtra: '<style data-mnfst-utilities data-mnfst-utilities-complete>.gap-2{gap:.5rem}</style>' })
        await settle()
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(1)
        expect(window.__manifestLoaded).toBeTruthy()
    })
})

describe('loader: Manifest.loadPlugin("tailwind")', () => {
    it('is accepted (not "Unknown module") and fetches manifest.tailwind.min.js', async () => {
        boot({ tailwind: false })
        await settle()
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(0)

        const warnSpy = vi.spyOn(console, 'warn')
        await window.Manifest.loadPlugin('tailwind')
        await settle()

        expect(warnSpy.mock.calls.some(args => String(args[0]).includes('Unknown module'))).toBe(false)
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(1)
    })

    it('defaults to the booted version, same as any other plugin', async () => {
        boot({ tailwind: false })
        await settle()
        await window.Manifest.loadPlugin('tailwind')
        await settle()
        const script = document.querySelector('script[src*="manifest.tailwind"]')
        expect(script.getAttribute('src')).toContain(`mnfst@${VERSION}`)
    })
})
