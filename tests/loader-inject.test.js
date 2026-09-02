/**
 * @vitest-environment happy-dom
 *
 * Loader plugin injection: a plugin whose <script> tag already exists in the
 * page (an author's explicit pin) must not hang the boot. Script elements have
 * no `.complete`; a tag that already fired `load` never fires it again.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(process.env.LOADER_SRC || path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await tick() }
const VERSION = '0.5.199-next.0'
const PLUGIN = `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib/manifest.toasts.min.js`

function boot({ existingTag = true, existingAttrs = {} } = {}) {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = ''
    if (existingTag) {
        const pre = document.createElement('script')
        pre.setAttribute('src', PLUGIN)
        for (const [k, v] of Object.entries(existingAttrs)) pre.setAttribute(k, v)
        document.head.appendChild(pre)
    }
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib/manifest.js`)
    s.setAttribute('data-version', VERSION)
    s.setAttribute('data-plugins', 'toasts,data')   // data → the loader fetches manifest.json and sets __manifestLoaded
    document.head.appendChild(s)
    new Function(CODE)()
}

beforeEach(() => {
    for (const k of ['__manifestLoaderStarted', '__manifestLoaded', '__manifestReady', '__manifestSwArmed', 'Manifest']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).endsWith('/manifest.json')) return new Response(JSON.stringify({ name: 'x', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response('', { status: 404 })
    }))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

describe('loader: pre-existing plugin tag', () => {
    it('resolves a plugin whose tag already exists ahead of the loader (explicit author pin)', async () => {
        boot()
        await settle(20)
        expect(window.__manifestLoaderStarted).toBe(true)
        expect(window.__manifestLoaded).toBeTruthy()
        // No duplicate tag injected for the pinned plugin
        expect(document.querySelectorAll(`script[src="${PLUGIN}"]`).length).toBe(1)
    })

    it('still boots without a pre-existing tag (control)', async () => {
        boot({ existingTag: false })
        await settle(20)
        expect(window.__manifestLoaded).toBeTruthy()
        expect(document.querySelectorAll(`script[src="${PLUGIN}"]`).length).toBe(1)
    })

    it('marks the tags it injects so a second loader run resolves them at once', async () => {
        boot({ existingTag: false })
        await settle(20)
        const tag = document.querySelector(`script[src="${PLUGIN}"]`)
        expect(tag.hasAttribute('data-mnfst-loaded')).toBe(true)
    })
})
