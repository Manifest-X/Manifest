/**
 * @vitest-environment happy-dom
 *
 * Manifest.loadUsed resolves once the modules the content uses have registered their directives
 * (Markdown registers only after its parser loads), so content inserted then is never held; a
 * module that ran but never registers is given up on after 10 s, as a hold would be.
 * LOADER_SRC=<file> runs the suite against another loader (e.g. the old one).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(process.env.LOADER_SRC || path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.217'

beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    vi.spyOn(console, 'warn').mockImplementation(() => { })
    window.__c = {}
    window.count = (k) => { window.__c[k] = (window.__c[k] || 0) + 1 }
    window.happyDOM.setURL('https://site.example/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = '<div id="app" x-data><form id="host"></form></div>'
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.js`)
    s.setAttribute('data-version', V)
    document.head.appendChild(s)
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true })
    new Function(CODE)()
    Object.defineProperty(document, 'currentScript', { value: null, configurable: true })
    await settle()
    window.Alpine = Alpine
    Alpine.start()
    await settle()
})

const ran = (p, present) => { window[present] = () => { } }
const state = (p) => { let v = 'pending'; p.then(x => { v = x }); return () => v }

describe('loadUsed waits for registration', () => {
    it('resolves after the directive registers, not when the script loads', async () => {
        ran('markdown', 'ensureMarkdownPluginInitialized')
        const out = state(window.Manifest.loadUsed('<div x-markdown="m"></div>'))
        await settle()
        expect(out()).toBe('pending')
        Alpine.directive('markdown', () => { })
        await settle()
        expect(out()).toEqual(['markdown'])
    })
    it('content inserted when it resolves is not held', async () => {
        ran('charts', 'ensureChartsPluginInitialized')
        const html = '<div id="c" x-data x-init="count(\'c\')" x-chart="{}"></div>'
        const p = window.Manifest.loadUsed(html)
        await settle()
        Alpine.directive('chart', () => { })
        await p
        document.getElementById('host').innerHTML = html
        await settle()
        expect(window.__manifestHeld(document.getElementById('c'))).toBe(false)
        expect(window.__c.c).toBe(1)
    })
    it('a module that ran but never registers: content after 1.5 s, held elements start at 10 s in all, one warning', async () => {
        ran('datepicker', 'ensureDatepickerPluginInitialized')
        const warn = console.warn
        const said = []
        console.warn = (...a) => said.push(a.join(' '))
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        try {
            const html = '<div id="d1" x-data x-init="count(\'d1\')"><b id="d1t" x-text="\'live\'"></b><input x-date></div>'
            const out = state(window.Manifest.loadUsed(html))
            await vi.advanceTimersByTimeAsync(1400)
            expect(out()).toBe('pending')
            await vi.advanceTimersByTimeAsync(200)
            expect(out()).toEqual(['datepicker'])
            document.getElementById('host').insertAdjacentHTML('beforeend', html)
            await vi.advanceTimersByTimeAsync(10)
            expect(document.getElementById('d1t').textContent).toBe('live')
            expect(window.ManifestPending.labels()).toContain('held')
            await vi.advanceTimersByTimeAsync(8200)
            expect(window.ManifestPending.labels()).toContain('held')
            await vi.advanceTimersByTimeAsync(300)
            expect(window.ManifestPending.labels().filter(l => l !== 'ready')).toEqual([])
            // Given up: later content starts at once, without another wait
            const later = state(window.Manifest.loadUsed('<input id="d2" x-date x-data x-init="count(\'d2\')">'))
            await vi.advanceTimersByTimeAsync(10)
            expect(later()).toEqual([])
            document.getElementById('host').insertAdjacentHTML('beforeend', '<input id="d2" x-date x-data x-init="count(\'d2\')">')
            await vi.advanceTimersByTimeAsync(10)
            expect(window.__c.d2).toBe(1)
            expect(window.ManifestPending.labels().filter(l => l !== 'ready')).toEqual([])
            expect(said.filter(w => w.includes('datepicker has not started')).length).toBe(1)
        } finally { vi.useRealTimers(); console.warn = warn }
    })
    it('a module that registers at 3 s: content after 1.5 s, the element starts once when it registers', async () => {
        ran('virtual', 'ensureVirtualPluginInitialized')
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
        try {
            const html = '<div id="v1" x-virtual x-data x-init="count(\'v1\')"></div>'
            const out = state(window.Manifest.loadUsed(html))
            await vi.advanceTimersByTimeAsync(1600)
            expect(out()).toEqual(['virtual'])
            document.getElementById('host').insertAdjacentHTML('beforeend', html)
            await vi.advanceTimersByTimeAsync(1400)
            expect(window.__c.v1).toBeUndefined()
            const ran = []
            Alpine.directive('virtual', (el) => ran.push(el.id))
            await vi.advanceTimersByTimeAsync(50)
            expect([window.__c.v1, ran]).toEqual([1, ['v1']])
            await vi.advanceTimersByTimeAsync(10000)
            expect([window.__c.v1, ran]).toEqual([1, ['v1']])
            expect(window.ManifestPending.labels().filter(l => l !== 'ready')).toEqual([])
        } finally { vi.useRealTimers() }
    })
    it('a module that never ran (blocked, no execution) does not wait', async () => {
        const out = state(window.Manifest.loadUsed('<div x-carousel></div>'))
        await settle()
        expect(out()).toEqual(['slides'])
    })
})
