/**
 * @vitest-environment happy-dom
 *
 * Loader: data-omit holds on the derive-from-manifest path, for every module source
 * (defaults, manifest triggers, +extras, the usage sniff before and after boot).
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

// Each boot leaves a post-boot usage watcher; earlier tests' watchers must not see later bodies
const observers = []
const RealMO = window.MutationObserver
window.MutationObserver = class extends RealMO { constructor(cb) { super(cb); observers.push(this) } }

let manifestBody
beforeEach(() => {
    observers.splice(0).forEach(o => o.disconnect())
    for (const k of ['__manifestLoaded', '__manifestPromise', '__manifestLoaderStarted', '__manifestReady', '__manifestSwArmed', 'Manifest', 'Capacitor']) delete window[k]
    manifestBody = { name: 'x' }
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify(manifestBody), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

async function boot(attrs = {}, bodyHtml = '') {
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
    await settle()
}

describe('data-omit on the derive path', () => {
    it('drops omitted defaults and keeps the rest', async () => {
        await boot({ 'data-omit': 'toasts, charts' })
        const list = injected()
        expect(list).not.toContain('toasts')
        expect(list).not.toContain('charts')
        expect(list).toContain('tooltips')
    })

    it('never omits always-on behaviours', async () => {
        await boot({ 'data-omit': 'defer,bindings' })
        expect(injected()).toEqual(expect.arrayContaining(['defer', 'bindings']))
    })

    it('drops modules a manifest block or +extra would add', async () => {
        manifestBody = { name: 'x', ai: true, payments: { provider: 'stripe' } }
        await boot({ 'data-modules': '+export', 'data-omit': 'chat,payments,export' })
        const list = injected()
        for (const m of ['chat', 'payments', 'export']) expect(list).not.toContain(m)
    })

    it('an omitted module pulled back in as a dependency of a loaded module stays loaded', async () => {
        manifestBody = { name: 'x', device: {} }
        await boot({ 'data-omit': 'utilities' })
        expect(injected()).toEqual(expect.arrayContaining(['device', 'utilities']))
    })

    it('the boot usage sniff does not re-add an omitted module', async () => {
        await boot({ 'data-omit': 'chat,components' }, '<div x-text="$chat.status"></div><x-card></x-card>')
        const list = injected()
        expect(list).not.toContain('chat')
        expect(list).not.toContain('components')
    })

    it('the post-boot usage sniff does not re-add an omitted module, and still loads others', async () => {
        await boot({ 'data-omit': 'chat' }, '<main id=m></main>')
        document.getElementById('m').insertAdjacentHTML('beforeend', '<div x-text="$chat.status"></div><div x-submit></div>')
        await settle()
        const list = injected()
        expect(list).not.toContain('chat')
        expect(list).toContain('submissions')
        await window.Manifest.loadUsed('<p x-text="$chat.x"></p>')
        expect(injected()).not.toContain('chat')
    })
})
