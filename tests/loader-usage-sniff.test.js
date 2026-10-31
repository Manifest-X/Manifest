/**
 * @vitest-environment happy-dom
 *
 * Loader: the post-boot usage sniff skips attribute values it has already seen hold no usage
 * magic.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.217'
const injected = () => [...document.querySelectorAll('script[src*="/lib/manifest."]')].map(s => s.getAttribute('src').replace(/.*\/lib\/manifest\.(.*)\.min\.js/, '$1'))

beforeEach(() => {
    for (const k of ['__manifestLoaded', '__manifestPromise', '__manifestLoaderStarted', '__manifestReady', '__manifestSwArmed', 'Manifest', 'Capacitor']) delete window[k]
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

function boot(bodyHtml = '') {
    window.happyDOM.setURL('https://site.example/app/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = bodyHtml
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.js`)
    s.setAttribute('data-version', V)
    document.head.appendChild(s)
    new Function(CODE)()
}

const row = (i) => `<div class="row" x-text="$x.rows[${i % 3}].name" :class="$x.rows.length && 'on'"><span @click="open = $x.rows[0]">a</span></div>`

describe('usage sniff', () => {
    it('re-tests repeated attribute values once, and still finds a new magic', async () => {
        boot('<main id=list></main>'); await settle()
        const list = document.getElementById('list')
        list.insertAdjacentHTML('beforeend', row(0))
        await settle(5)
        const test = vi.spyOn(RegExp.prototype, 'test')
        for (let i = 0; i < 60; i++) list.insertAdjacentHTML('beforeend', row(i))
        await settle(5)
        const usage = test.mock.contexts.filter(re => re.source.startsWith('\\$'))
        expect(usage.length).toBeLessThan(10)
        test.mockRestore()
        list.insertAdjacentHTML('beforeend', '<div x-text="$chat.status"></div>')
        await settle()
        expect(injected()).toContain('chat')
    })
})

describe('alpine pin', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'))

    it('loads the exact version the suite tests against, unless data-alpine overrides it', () => {
        const pinned = /DEFAULT_ALPINE_VERSION = '([^']+)'/.exec(CODE)[1]
        expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
        expect(pkg.devDependencies.alpinejs).toBe(pinned)
        expect(JSON.parse(readFileSync(path.join(__dirname, '../node_modules/alpinejs/package.json'), 'utf8')).version).toBe(pinned)
        expect(CODE).toMatch(/const v = dataAlpine \|\| DEFAULT_ALPINE_VERSION/)
    })
})
