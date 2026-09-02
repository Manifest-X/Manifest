/**
 * @vitest-environment happy-dom
 *
 * The device plugin (formerly `native`): loaded by a `device` block, the old
 * `native` block, the old plugin name, or by using one of its magics in the page.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.199'
const injected = () => [...document.querySelectorAll('script[src*="/lib/manifest."]')].map(s => s.getAttribute('src').replace(/.*\/lib\/manifest\.(.*)\.min\.js/, '$1'))

let manifest
beforeEach(() => {
    manifest = { name: 'x' }
    for (const k of ['__manifestLoaded', '__manifestPromise', '__manifestLoaderStarted', '__manifestReady', '__manifestSwArmed', 'Manifest', 'Capacitor']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

function boot(attrs = {}, bodyHtml = '') {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = bodyHtml
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.js`)
    s.setAttribute('data-version', V)
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    document.head.appendChild(s)
    new Function(CODE)()
}

describe('device plugin loading', () => {
    it('a `device` block in manifest.json loads manifest.device (derive path)', async () => {
        manifest = { name: 'x', device: {} }
        boot(); await settle()
        expect(injected()).toContain('device')
        expect(injected()).not.toContain('native')
    })

    it('the old `native` block still loads it, as device', async () => {
        manifest = { name: 'x', native: {} }
        boot(); await settle()
        expect(injected()).toContain('device')
        expect(injected()).not.toContain('native')
    })

    it('data-plugins="+native" is an alias of +device', async () => {
        boot({ 'data-plugins': '+native' }); await settle()
        expect(injected().filter(p => p === 'device').length).toBe(1)
        expect(injected()).not.toContain('native')
    })

    it('using $share in the page loads it without any opt-in', async () => {
        boot({}, '<button @click="$share({ title: \'x\' })">Share</button>'); await settle()
        expect(injected()).toContain('device')
    })

    it('a page that uses none of its magics does not load it', async () => {
        boot({}, '<p x-text="$device.os"></p>'); await settle()
        expect(injected()).not.toContain('device')
    })
})
