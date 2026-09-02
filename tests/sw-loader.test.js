/**
 * @vitest-environment happy-dom
 *
 * Loader-side service worker inference (§13.2): the matrix of reasons not to
 * register, the kill switch, the stub probe, the registration URL, and the
 * "after the page settles" timing. The loader is evaluated fresh per test with
 * a script tag it can discover (happy-dom has no document.currentScript).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')

const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick() }

let sw, fetchMock, cachesMock, existing

function fakeRegistration(url = 'https://site.example/sw.js?v=latest&d=') {
    const worker = { postMessage: vi.fn(), scriptURL: url }
    return { active: worker, waiting: null, installing: null, unregister: vi.fn(async () => true), update: vi.fn(async () => { }) }
}

// Default responses: manifest.json + a JavaScript stub. Tests override per case.
function setResponses({ manifest = { name: 'x' }, stub = { status: 200, type: 'text/javascript; charset=utf-8' } } = {}) {
    fetchMock.mockImplementation(async (url, init) => {
        const u = String(url)
        if (u.endsWith('/manifest.json')) return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } })
        if (u.endsWith('/sw.js')) return new Response('', { status: stub.status, headers: { 'content-type': stub.type } })
        return new Response('', { status: 404 })
    })
}

// Evaluate the loader as a page would, given a script tag with these attributes.
function loadLoader(attrs = {}, { url = 'https://site.example/app/', secure = true } = {}) {
    window.happyDOM.setURL(url)
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true })
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = ''
    const s = document.createElement('script')
    s.setAttribute('src', 'https://cdn.manifestx.dev/npm/mnfst@latest/lib/manifest.js')
    // Loads nothing (explicit list fully omitted) so only the SW path runs.
    s.setAttribute('data-plugins', 'components')
    s.setAttribute('data-omit', 'components')
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    document.head.appendChild(s)
    new Function(CODE)()
}

beforeEach(() => {
    delete window.__manifestSwArmed
    delete window.__manifestLoaderStarted
    delete window.__manifestReady
    delete window.__manifestLoaded
    delete window.__mnfstRun
    delete window.Manifest
    existing = null
    sw = {
        register: vi.fn(async () => fakeRegistration()),
        getRegistration: vi.fn(async () => existing),
    }
    Object.defineProperty(window.navigator, 'serviceWorker', { value: sw, configurable: true })
    fetchMock = vi.fn()
    window.fetch = fetchMock
    globalThis.fetch = fetchMock
    cachesMock = { keys: vi.fn(async () => ['mnfst-sw:1:a:assets', 'other']), delete: vi.fn(async () => true) }
    Object.defineProperty(window, 'caches', { value: cachesMock, configurable: true })
    try { sessionStorage.clear() } catch (_) { }
    setResponses()
})
afterEach(() => { vi.restoreAllMocks() })

describe('happy path', () => {
    it('registers /sw.js?v=<version>&d=<deployment> at scope / on https after the page settles', async () => {
        setResponses({ manifest: { deployment: 'abc123' } })
        loadLoader({ 'data-version': '0.5.198' })
        await settle()
        expect(sw.register).toHaveBeenCalledTimes(1)
        expect(sw.register).toHaveBeenCalledWith('/sw.js?v=0.5.198&d=abc123', { scope: '/' })
        expect(window.Manifest.sw.registered).toBe(true)
        expect(window.Manifest.sw.version).toBe('0.5.198')
    })

    it('defaults to v=latest and an empty deployment', async () => {
        loadLoader()
        await settle()
        expect(sw.register).toHaveBeenCalledWith('/sw.js?v=latest&d=', { scope: '/' })
    })

    it('probes the stub with a no-store GET before registering, once per session', async () => {
        loadLoader()
        await settle()
        const probe = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sw.js'))
        expect(probe[1]).toEqual({ cache: 'no-store' })
        expect(sessionStorage.getItem('manifest:sw-probe')).toBe('ok')
        delete window.__manifestSwArmed
        loadLoader()
        await settle()
        expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sw.js')).length).toBe(1)
        expect(sw.register).toHaveBeenCalledTimes(2)
    })

    it('uses the already-loaded manifest instead of refetching it', async () => {
        window.__manifestLoaded = { deployment: 'fromloader' }
        loadLoader()
        await settle()
        expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/manifest.json'))).toBe(false)
        expect(sw.register).toHaveBeenCalledWith('/sw.js?v=latest&d=fromloader', { scope: '/' })
    })

    it('waits for manifest:ready when this loader boots the page', async () => {
        window.__manifestLoaderStarted = true
        loadLoader()
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
        window.__manifestReady = true
        window.dispatchEvent(new CustomEvent('manifest:ready'))
        await settle()
        expect(sw.register).toHaveBeenCalledTimes(1)
    })

    it('never throws when registration rejects', async () => {
        sw.register.mockImplementation(async () => { throw new Error('SecurityError') })
        loadLoader()
        await settle()
        expect(window.Manifest.sw.registered).toBe(false)
    })
})

describe('skips', () => {
    it.each([
        ['localhost', 'http://localhost:5001/'],
        ['127.0.0.1', 'http://127.0.0.1:5001/'],
        ['[::1]', 'http://[::1]:5001/'],
        ['*.local', 'https://mymac.local/'],
        ['*.localhost', 'https://app.localhost/'],
    ])('dev origin %s', async (_n, url) => {
        loadLoader({}, { url })
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
    })

    it('mnfst-run marker, even with data-sw="on"', async () => {
        window.__mnfstRun = true
        loadLoader({ 'data-sw': 'on' }, { url: 'http://localhost:5001/' })
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
    })

    it('plain http', async () => {
        loadLoader({}, { url: 'http://site.example/', secure: false })
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
        expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/sw.js'))).toBe(false)
    })

    it('data-sw="off"', async () => {
        loadLoader({ 'data-sw': 'off' })
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
    })

    it('manifest.json "sw": false', async () => {
        setResponses({ manifest: { sw: false } })
        loadLoader()
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
    })

    it('missing stub (404)', async () => {
        setResponses({ stub: { status: 404, type: 'text/html' } })
        loadLoader()
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
        expect(sessionStorage.getItem('manifest:sw-probe')).toBeNull()
    })

    it('SPA fallback answering the probe with HTML', async () => {
        setResponses({ stub: { status: 200, type: 'text/html; charset=utf-8' } })
        loadLoader()
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
    })

    it('unsupported browser', async () => {
        Object.defineProperty(window.navigator, 'serviceWorker', { value: undefined, configurable: true })
        loadLoader()
        await settle()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('is silent unless data-sw="on"', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => { })
        setResponses({ stub: { status: 404, type: 'text/html' } })
        loadLoader()
        await settle()
        expect(info).not.toHaveBeenCalled()
        delete window.__manifestSwArmed
        loadLoader({ 'data-sw': 'on' })
        await settle()
        expect(info).toHaveBeenCalled()
    })
})

describe('data-sw="on" (testing override)', () => {
    it('registers on localhost when the context is secure', async () => {
        loadLoader({ 'data-sw': 'on' }, { url: 'http://localhost:5001/' })
        await settle()
        expect(sw.register).toHaveBeenCalledWith('/sw.js?v=latest&d=', { scope: '/' })
    })

    it('still refuses an insecure context', async () => {
        loadLoader({ 'data-sw': 'on' }, { url: 'http://site.example/', secure: false })
        await settle()
        expect(sw.register).not.toHaveBeenCalled()
    })
})

describe('kill switch', () => {
    it('data-sw="off" with an existing registration: kill message, unregister, cache sweep', async () => {
        existing = fakeRegistration()
        loadLoader({ 'data-sw': 'off' })
        await settle()
        expect(existing.active.postMessage).toHaveBeenCalledWith({ type: 'manifest:sw', action: 'kill' })
        expect(existing.unregister).toHaveBeenCalledTimes(1)
        expect(cachesMock.delete).toHaveBeenCalledWith('mnfst-sw:1:a:assets')
        expect(cachesMock.delete).not.toHaveBeenCalledWith('other')
        expect(sw.register).not.toHaveBeenCalled()
    })

    it('manifest "sw": false unregisters too', async () => {
        existing = fakeRegistration()
        setResponses({ manifest: { sw: false } })
        loadLoader()
        await settle()
        expect(existing.unregister).toHaveBeenCalledTimes(1)
    })

    it('a stale production worker on a dev origin is removed', async () => {
        existing = fakeRegistration()
        loadLoader({}, { url: 'http://localhost:5001/' })
        await settle()
        expect(existing.unregister).toHaveBeenCalledTimes(1)
        expect(existing.active.postMessage).toHaveBeenCalledWith({ type: 'manifest:sw', action: 'kill' })
    })

    it('Manifest.sw.kill() is the same path', async () => {
        loadLoader()
        await settle()
        expect(window.Manifest.sw.registered).toBe(true)
        existing = fakeRegistration()
        await window.Manifest.sw.kill()
        expect(existing.unregister).toHaveBeenCalledTimes(1)
        expect(window.Manifest.sw.registered).toBe(false)
    })
})

describe('Manifest.swStub', () => {
    it('emits the exact two-line stub for a pinned version', () => {
        loadLoader()
        expect(window.Manifest.swStub('0.5.198')).toBe(
            "try { importScripts('https://cdn.manifestx.dev/npm/mnfst@0.5.198/lib/manifest.sw.min.js'); } catch (e) { importScripts('https://cdn.jsdelivr.net/npm/mnfst@0.5.198/lib/manifest.sw.min.js'); }\n" +
            "if (!self.__mnfstSw) self.addEventListener('activate', function () { self.registration.unregister(); });\n")
    })

    it('defaults to latest and strips unsafe characters', () => {
        loadLoader()
        expect(window.Manifest.swStub()).toContain('mnfst@latest/lib/manifest.sw.min.js')
        expect(window.Manifest.swStub("0.5.198'); evil(")).toContain("mnfst@0.5.198evil/lib")
    })
})
