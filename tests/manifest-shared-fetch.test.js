/**
 * @vitest-environment happy-dom
 *
 * One manifest.json request per boot: the loader publishes its in-flight fetch
 * as window.__manifestPromise; plugins that init before __manifestLoaded is
 * set await it instead of fetching their own (Playcom saw 4 fetches per boot).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.join(__dirname, '../src/scripts', f), 'utf8')
const LOADER = read('manifest.js')
const DATA_CONFIG = read('data/core/manifest.data.config.js')
const AUTH_CONFIG = read('auth/manifest.appwrite.auth.config.js')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await tick() }
const MANIFEST = { name: 'x', data: { a: '/a.json' }, appwrite: { auth: {} } }

let manifestFetches
beforeEach(() => {
    manifestFetches = 0
    for (const k of ['__manifestLoaded', '__manifestPromise', '__manifestLoaderStarted', '__manifestReady', '__manifestSwArmed', 'Manifest', 'ManifestDataConfig', 'ManifestAppwriteAuthConfig', 'ManifestComponentsRegistry']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).includes('manifest.json')) { manifestFetches++; return new Response(JSON.stringify(MANIFEST), { status: 200, headers: { 'content-type': 'application/json' } }) }
        return new Response('', { status: 404 })
    }))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

function bootLoader(attrs = {}) {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = ''
    const s = document.createElement('script')
    s.setAttribute('src', 'https://cdn.manifestx.dev/npm/mnfst@latest/lib/manifest.js')
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    document.head.appendChild(s)
    new Function(LOADER)()
}

describe('shared manifest fetch', () => {
    it('the loader publishes its request at once; plugins initialising before __manifestLoaded share it', async () => {
        bootLoader({ 'data-plugins': 'data,appwrite-auth' })
        expect(window.__manifestPromise).toBeInstanceOf(Promise)
        // Plugins land while the loader's fetch is still in flight
        new Function(DATA_CONFIG)()
        new Function(AUTH_CONFIG)()
        const [a, b] = await Promise.all([window.ManifestDataConfig.ensureManifest(), window.ManifestAppwriteAuthConfig.ensureManifest()])
        await settle(20)
        expect(a.name).toBe('x')
        expect(b).toBe(a)
        expect(window.__manifestLoaded).toBe(a)
        expect(manifestFetches).toBe(1)
    })

    it('without a loader the first plugin fetches once and the rest share it', async () => {
        new Function(DATA_CONFIG)()
        new Function(AUTH_CONFIG)()
        const [a, b, c] = await Promise.all([window.ManifestDataConfig.ensureManifest(), window.ManifestAppwriteAuthConfig.ensureManifest(), window.ManifestDataConfig.ensureManifest()])
        expect(a.name).toBe('x')
        expect(b).toBe(a)
        expect(c).toBe(a)
        expect(manifestFetches).toBe(1)
    })
})
