/**
 * @vitest-environment happy-dom
 *
 * Loader: window.ManifestPending — plugins hold() pending work until their DOM
 * update lands, and prerender waits for the count to reach zero. The count
 * includes the markdown and utilities counters; the ready coordinator holds
 * until manifest:ready fires.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const VERSION = '0.5.199-next.0'

function boot() {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = ''
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib/manifest.js`)
    s.setAttribute('data-version', VERSION)
    s.setAttribute('data-plugins', 'toasts,data')
    document.head.appendChild(s)
    new Function(CODE)()
}

beforeEach(() => {
    for (const k of ['__manifestLoaderStarted', '__manifestLoaded', '__manifestReady', '__manifestReadyCoordinator', '__manifestRenderReady', 'Manifest', 'ManifestPending', '__manifestMarkdownPending', '__manifestUtilitiesPending']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).endsWith('/manifest.json')) return new Response(JSON.stringify({ name: 'x', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response('', { status: 404 })
    }))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

describe('loader: ManifestPending', () => {
    it('holds and releases', () => {
        boot()
        const before = window.ManifestPending.count
        const release = window.ManifestPending.hold('components')
        expect(window.ManifestPending.count).toBe(before + 1)
        expect(window.ManifestPending.labels()).toContain('components')
        release()
        release()
        expect(window.ManifestPending.count).toBe(before)
    })

    it('includes the markdown and utilities counters', () => {
        boot()
        const before = window.ManifestPending.count
        window.__manifestMarkdownPending = 2
        window.__manifestUtilitiesPending = 1
        expect(window.ManifestPending.count).toBe(before + 3)
        expect(window.ManifestPending.labels()).toEqual(expect.arrayContaining(['markdown', 'utilities']))
    })

    it('holds until manifest:ready', async () => {
        boot()
        await settle()
        expect(window.__manifestReadyCoordinator).toBe(true)
        expect(window.ManifestPending.labels()).toContain('ready')
        window.dispatchEvent(new CustomEvent('manifest:render-ready'))
        await new Promise((r) => setTimeout(r, 350))
        expect(window.__manifestReady).toBe(true)
        expect(window.ManifestPending.labels()).not.toContain('ready')
    })

    it('marks background callbacks', () => {
        boot()
        const fn = () => {}
        expect(window.ManifestPending.background(fn)).toBe(fn)
        expect(fn.__manifestBackground).toBe(true)
    })

    it('keeps a registry a page already defined', () => {
        const own = { hold: () => () => {}, count: 0, labels: () => [] }
        window.ManifestPending = own
        boot()
        expect(window.ManifestPending).toBe(own)
    })
})
