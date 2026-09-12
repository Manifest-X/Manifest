/**
 * @vitest-environment happy-dom
 *
 * Loader: `data-tailwind` normally fetches the bundled Tailwind engine in
 * parallel with plugins. A fully-baked page — a `<style data-mnfst-utilities
 * data-mnfst-utilities-complete>` sheet, stamped by publish/render once it
 * verified every scanned class got a rule (Manifest's own + the Tailwind
 * bake pass, see manifest.utilities.node.mjs) — should skip that fetch
 * entirely, since the engine would generate nothing new. Fails open: no such
 * sheet (or a `<link>` instead of an inline `<style>`, or no `-complete`
 * flag) still loads Tailwind as before.
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

describe('loader: Tailwind engine skip on a fully-baked page', () => {
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

    it('still loads it for a <link> sheet even when marked complete (async — fails open)', async () => {
        boot({ headExtra: '<link rel="stylesheet" data-mnfst-utilities data-mnfst-utilities-complete href="data:text/css,.gap-2{gap:.5rem}">' })
        await settle()
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(1)
    })

    it('skips it for an inline <style> sheet marked complete', async () => {
        boot({ headExtra: '<style data-mnfst-utilities data-mnfst-utilities-complete>.gap-2{gap:.5rem}</style>' })
        await settle()
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(0)
        // Everything else still boots normally.
        expect(window.__manifestLoaded).toBeTruthy()
    })
})

describe('loader: Manifest.loadPlugin("tailwind") — the uncovered-class watcher\'s lazy-load path', () => {
    // The utilities plugin's runtime safety net (manifest.utilities.static.js
    // setupUncoveredClassWatcher) calls this when it sees a class the "complete"
    // bake doesn't cover. It must be a recognized plugin, not rejected as unknown.
    it('is accepted (not "Unknown plugin") and fetches manifest.tailwind.min.js', async () => {
        boot({ tailwind: false })
        await settle()
        expect(document.querySelectorAll('script[src*="manifest.tailwind"]').length).toBe(0)

        const warnSpy = vi.spyOn(console, 'warn')
        await window.Manifest.loadPlugin('tailwind')
        await settle()

        expect(warnSpy.mock.calls.some(args => String(args[0]).includes('Unknown plugin'))).toBe(false)
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
