/**
 * @vitest-environment happy-dom
 *
 * Runtime safety net for the loader's Tailwind-engine skip (manifest.js
 * staticUtilitiesFullyCovered / loader-tailwind-skip.test.js): a "complete"
 * bake means the loader never fetches the Tailwind engine. If that stamp
 * were ever wrong, or a class only shows up after boot, this watcher
 * (manifest.utilities.static.js setupUncoveredClassWatcher) is what notices
 * and lazily loads the real engine — the failure mode a silently unstyled
 * page would be, per PERF-PRIMITIVES-DESIGN's requirement to fail loud.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

// happy-dom keeps one `window`/`document` per test file (see
// utilities-static-sheet.test.js), so each test's fresh compiler instance
// leaves its MutationObserver attached to document.documentElement unless
// disconnected — otherwise a later test's DOM mutations would still reach an
// earlier test's (stale) observer, which calls whatever `window.Manifest`
// happens to be at that later moment. Disconnect after every test.
afterEach(() => {
    window.ManifestUtilities?.uncoveredClassObserver?.disconnect()
})

beforeEach(() => {
    // The LOADER_TAG's src is fake — treat the "load" as an immediate no-op
    // success instead of a console-noisy failed fetch (it's never awaited).
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
})

// The watcher only arms when it finds `<script src=*manifest.js* data-tailwind>`
// in the page — mirror the real loader tag without booting the full loader.
const LOADER_TAG = '<script src="https://cdn.manifestx.dev/npm/mnfst@0.5.199/lib/manifest.js" data-tailwind></script>'

async function boot({ headHtml, bodyHtml, loaderTag = LOADER_TAG }) {
    document.head.innerHTML = `${loaderTag}${headHtml}`
    document.body.innerHTML = bodyHtml
    window.tailwind = {} // isTailwindAvailable() true immediately — skip the 5s poll
    window.ManifestComponentsRegistry = { manifest: {} } // skip the 2s registry wait
    delete window.__manifestUtilitiesReady
    delete window.__mnfstTailwindWatcherArmed
    window.__manifestUtilitiesPending = 0
    window.Manifest = { loadPlugin: vi.fn(() => Promise.resolve()) }

    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    const nonce = `\n//boot:${Math.random()}`
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
    await ready
    return window.ManifestUtilities
}

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
// Debounce timers are real (setTimeout), so waiting matters more than tick
// count — settle() alone can resolve in under a millisecond of wall time.
const waitForDebounce = () => new Promise(r => setTimeout(r, 150))
const COMPLETE_SHEET = '<style data-mnfst-utilities data-mnfst-utilities-complete>.p-4{padding:1rem}</style>'

describe('uncovered-class watcher — arming conditions', () => {
    it('does not arm when the page never requested the Tailwind engine (no data-tailwind)', async () => {
        await boot({
            headHtml: COMPLETE_SHEET,
            bodyHtml: '<div class="p-4"></div>',
            loaderTag: '<script src="https://cdn.manifestx.dev/npm/mnfst@0.5.199/lib/manifest.js"></script>'
        })
        expect(window.__mnfstTailwindWatcherArmed).toBeFalsy()
    })

    it('does not arm when the static sheet is present but not marked complete', async () => {
        await boot({
            headHtml: '<style data-mnfst-utilities>.p-4{padding:1rem}</style>',
            bodyHtml: '<div class="p-4"></div>'
        })
        expect(window.__mnfstTailwindWatcherArmed).toBeFalsy()
    })

    it('does not arm when there is no static sheet at all', async () => {
        await boot({ headHtml: '', bodyHtml: '<div class="p-4"></div>' })
        expect(window.__mnfstTailwindWatcherArmed).toBeFalsy()
    })

    it('arms when data-tailwind is present and the sheet is marked complete', async () => {
        await boot({ headHtml: COMPLETE_SHEET, bodyHtml: '<div class="p-4"></div>' })
        expect(window.__mnfstTailwindWatcherArmed).toBe(true)
    })
})

describe('uncovered-class watcher — detection and lazy load', () => {
    it('does nothing when every class on the page is covered', async () => {
        await boot({ headHtml: COMPLETE_SHEET, bodyHtml: '<div class="p-4"></div>' })
        await settle()
        expect(window.Manifest.loadPlugin).not.toHaveBeenCalled()
    })

    it('an uncovered class already in the initial markup triggers a lazy load', async () => {
        await boot({ headHtml: COMPLETE_SHEET, bodyHtml: '<div class="p-4 gap-2"></div>' })
        await waitForDebounce()
        expect(window.Manifest.loadPlugin).toHaveBeenCalledWith('tailwind')

        let detail = null
        window.addEventListener('manifest:utilities-uncovered', (e) => { detail = e.detail })
        // Event already fired before the listener was attached in this test —
        // assert via the mock call instead of re-listening; see next test for
        // the event-detail shape on a fresh detection.
        expect(detail).toBeNull()
    })

    it('a class added after boot triggers one debounced lazy load, and warns once', async () => {
        const compiler = await boot({ headHtml: COMPLETE_SHEET, bodyHtml: '<div class="p-4"></div>' })
        await settle()
        expect(window.Manifest.loadPlugin).not.toHaveBeenCalled()

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        let eventDetail = null
        window.addEventListener('manifest:utilities-uncovered', (e) => { eventDetail = e.detail }, { once: true })

        const el = document.createElement('div')
        el.className = 'gap-2'
        document.body.appendChild(el)
        await waitForDebounce()

        expect(window.Manifest.loadPlugin).toHaveBeenCalledTimes(1)
        expect(window.Manifest.loadPlugin).toHaveBeenCalledWith('tailwind')
        expect(warnSpy).toHaveBeenCalledTimes(1)
        expect(warnSpy.mock.calls[0].join(' ')).toContain('gap-2')
        expect(eventDetail).toEqual({ classes: ['gap-2'], engineLoaded: true })
    })

    it('a burst of nodes across one tick coalesces into a single lazy load', async () => {
        await boot({ headHtml: COMPLETE_SHEET, bodyHtml: '<div class="p-4"></div>' })
        await settle()

        for (const cls of ['gap-1', 'gap-2', 'gap-3']) {
            const el = document.createElement('div')
            el.className = cls
            document.body.appendChild(el)
        }
        await waitForDebounce()

        expect(window.Manifest.loadPlugin).toHaveBeenCalledTimes(1)
    })

    it('a class-attribute mutation on an existing element is also detected', async () => {
        await boot({ headHtml: COMPLETE_SHEET, bodyHtml: '<div id="target" class="p-4"></div>' })
        await settle()
        document.getElementById('target').setAttribute('class', 'p-4 rounded-full')
        await waitForDebounce()
        expect(window.Manifest.loadPlugin).toHaveBeenCalledWith('tailwind')
    })

    it('disconnects the observer once the engine loads — a later uncovered class does not call loadPlugin again', async () => {
        await boot({ headHtml: COMPLETE_SHEET, bodyHtml: '<div class="p-4"></div>' })
        await settle()

        const el = document.createElement('div')
        el.className = 'gap-2'
        document.body.appendChild(el)
        await waitForDebounce()
        expect(window.Manifest.loadPlugin).toHaveBeenCalledTimes(1)

        const el2 = document.createElement('div')
        el2.className = 'space-x-4'
        document.body.appendChild(el2)
        await waitForDebounce()
        expect(window.Manifest.loadPlugin).toHaveBeenCalledTimes(1) // still one — observer disconnected
    })

    it('dispatches engineLoaded: false and console.errors when the lazy load rejects', async () => {
        document.head.innerHTML = `${LOADER_TAG}${COMPLETE_SHEET}`
        document.body.innerHTML = '<div class="p-4"></div>'
        window.tailwind = {}
        window.ManifestComponentsRegistry = { manifest: {} }
        delete window.__manifestUtilitiesReady
        delete window.__mnfstTailwindWatcherArmed
        window.__manifestUtilitiesPending = 0
        window.Manifest = { loadPlugin: vi.fn(() => Promise.reject(new Error('network down'))) }

        const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
        const nonce = `\n//boot:${Math.random()}`
        await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
        await ready

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        let eventDetail = null
        window.addEventListener('manifest:utilities-uncovered', (e) => { eventDetail = e.detail }, { once: true })

        const el = document.createElement('div')
        el.className = 'gap-2'
        document.body.appendChild(el)
        await waitForDebounce()

        expect(errorSpy).toHaveBeenCalled()
        expect(eventDetail).toEqual({ classes: ['gap-2'], engineLoaded: false })
    })
})

describe('uncovered-class watcher — safelist excuses a class', () => {
    it('a safelisted class never triggers the watcher', async () => {
        document.head.innerHTML = `${LOADER_TAG}${COMPLETE_SHEET}`
        document.body.innerHTML = '<div class="p-4"></div>'
        window.tailwind = {}
        window.ManifestComponentsRegistry = { manifest: {} }
        window.__manifestLoaded = { utilities: { safelist: ['bg-amber-500'] } }
        delete window.__manifestUtilitiesReady
        delete window.__mnfstTailwindWatcherArmed
        window.__manifestUtilitiesPending = 0
        window.Manifest = { loadPlugin: vi.fn(() => Promise.resolve()) }

        const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
        const nonce = `\n//boot:${Math.random()}`
        await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
        await ready

        const el = document.createElement('div')
        el.className = 'bg-amber-500'
        document.body.appendChild(el)
        await waitForDebounce()

        expect(window.Manifest.loadPlugin).not.toHaveBeenCalled()
    })
})
