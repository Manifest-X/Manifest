/**
 * @vitest-environment happy-dom
 *
 * Loader: a stored Tailwind engine output (written by the utilities module) is replayed on a
 * repeat visit and the engine is not fetched; anything uncertain falls back to the eager engine.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const VERSION = '0.5.199'
const KEY = 'tailwind-engine-cache:v1'
const V = `0.0.0-dev|${VERSION}|4.3.1`
const CSS = '/*! tailwindcss v4.3.1 */ .p-4{padding:1rem}'

function store(over = {}) {
    localStorage.setItem(KEY, JSON.stringify({ v: V, t: Date.now(), blocks: ['@theme { --color-x: red; }'], tokens: ['p-4'], css: CSS, ...over }))
}

// armUtilities: stand in for the utilities module arming the watcher as it executes
function boot({ url = 'https://site.example/app/', headExtra = '', plugins = 'utilities,toasts', armUtilities = true, before } = {}) {
    window.happyDOM.setURL(url)
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = `<link rel="manifest" href="/manifest.json">${headExtra}`
    document.body.innerHTML = '<div class="p-4"></div>'
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib/manifest.js`)
    s.setAttribute('data-version', VERSION)
    s.setAttribute('data-plugins', plugins)
    s.setAttribute('data-tailwind', '')
    document.head.appendChild(s)
    if (before) before()
    new Function(CODE)()
    if (armUtilities && window.__tailwindCache) window.__tailwindCache.armed = true
}

const engineScripts = () => document.querySelectorAll('script[src*="manifest.tailwind"]').length
const cachedStyle = () => document.querySelector('style[data-tailwind-cache]')

beforeEach(() => {
    for (const k of ['__manifestLoaderStarted', '__manifestLoaded', '__manifestReady', 'Manifest', '__tailwindCache', '__manifestRender', '__mnfstRun']) delete window[k]
    localStorage.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).endsWith('/manifest.json')) return new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response('', { status: 404 })
    }))
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

describe('loader: Tailwind engine output cache', () => {
    it('replays a matching cache before first paint and does not fetch the engine', async () => {
        store()
        boot()
        expect(cachedStyle()?.textContent).toBe(CSS)
        await settle()
        expect(engineScripts()).toBe(0)
        expect(window.__tailwindCache.record.tokens).toEqual(['p-4'])
    })

    it('fetches the engine when the utilities module never arms the watcher', async () => {
        store()
        boot({ armUtilities: false })
        await settle()
        expect(engineScripts()).toBe(1)
    })

    it('records nothing and loads the engine with no cache', async () => {
        boot()
        await settle()
        expect(engineScripts()).toBe(1)
        expect(cachedStyle()).toBeNull()
        expect(window.__tailwindCache.v).toBe(V)
    })

    const fallbacks = {
        'another framework version': () => store({ v: `0.0.0-dev|0.5.1|4.3.1` }),
        'an expired entry': () => store({ t: Date.now() - 8 * 24 * 3600 * 1000 }),
        'unparseable JSON': () => localStorage.setItem(KEY, '{nope'),
        'a malformed record': () => store({ tokens: 'p-4' }),
    }
    for (const [name, setup] of Object.entries(fallbacks)) {
        it(`loads the engine for ${name}`, async () => {
            setup()
            boot()
            await settle()
            expect(cachedStyle()).toBeNull()
            expect(engineScripts()).toBe(1)
        })
    }

    it('loads the engine when storage throws', async () => {
        store()
        const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')
        Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError') } })
        try {
            boot()
            await settle()
        } finally {
            if (desc) Object.defineProperty(window, 'localStorage', desc)
            else delete window.localStorage
        }
        expect(cachedStyle()).toBeNull()
        expect(engineScripts()).toBe(1)
    })

    it('loads the engine when an already-parsed text/tailwindcss block is not one the cache was built from', async () => {
        store()
        boot({ headExtra: '<style type="text/tailwindcss">@theme { --color-x: blue; }</style>' })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(engineScripts()).toBe(1)
    })

    it('replays when the parsed block matches', async () => {
        store()
        boot({ headExtra: '<style type="text/tailwindcss">@theme { --color-x: red; }</style>' })
        await settle()
        expect(cachedStyle()).not.toBeNull()
        expect(engineScripts()).toBe(0)
    })

    it('never replays on a dev host', async () => {
        store()
        boot({ url: 'http://localhost:3000/' })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(window.__tailwindCache).toBeUndefined()
        expect(engineScripts()).toBe(1)
    })

    it('never replays for the prerenderer', async () => {
        store()
        boot({ before: () => { window.__manifestRender = true } })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(window.__tailwindCache).toBeUndefined()
    })

    it('never replays without the utilities module (nothing would watch for unseen classes)', async () => {
        store()
        boot({ plugins: 'toasts' })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(engineScripts()).toBe(1)
    })

    it('leaves a shipped utilities sheet in charge', async () => {
        store()
        boot({ headExtra: '<style data-mnfst-utilities>.gap-2{gap:.5rem}</style>' })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(engineScripts()).toBe(1)
    })

    it('leaves a complete shipped sheet in charge (no engine, no replay)', async () => {
        store()
        boot({ headExtra: '<style data-mnfst-utilities data-mnfst-utilities-complete>.gap-2{gap:.5rem}</style>' })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(engineScripts()).toBe(0)
    })
})
