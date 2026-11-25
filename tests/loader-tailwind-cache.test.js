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
const KEY = 'tailwind-engine-cache:v2'
// Unstamped source loader: engine version is filled in at build
const V = `0.0.0-dev|${VERSION}|`
const CSS = '/*! tailwindcss v4.3.1 */ .p-4{padding:1rem}'
const A = '@theme { --color-x: red; }'
const B = '@theme { --color-x: blue; }'

// Same id the loader computes: FNV-1a over the version and the ordered author blocks
function idFor(blocks) {
    const text = [V, ...blocks].join('\u0000')
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
    return (h >>> 0).toString(36)
}

function store(over = {}) {
    const rec = { v: V, t: Date.now(), blocks: [A], tokens: ['p-4'], css: CSS, ...over }
    const id = idFor(rec.blocks)
    localStorage.setItem(`${KEY}:${id}`, JSON.stringify(rec))
    localStorage.setItem(KEY, JSON.stringify({ ids: [id], sizes: { [id]: 100 } }))
}

const block = (t) => `<style type="text/tailwindcss">${t}</style>`

// armUtilities: stand in for the utilities module arming the watcher as it executes
function boot({ url = 'https://site.example/app/', headExtra = block(A), afterLoader = '', plugins = 'utilities,toasts', armUtilities = true, tailwindAttr = '', before } = {}) {
    window.happyDOM.setURL(url)
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = `<link rel="manifest" href="/manifest.json">${headExtra}`
    document.body.innerHTML = '<div class="p-4"></div>'
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib/manifest.js`)
    s.setAttribute('data-version', VERSION)
    s.setAttribute('data-plugins', plugins)
    s.setAttribute('data-tailwind', tailwindAttr)
    document.head.appendChild(s)
    document.head.insertAdjacentHTML('beforeend', afterLoader)
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
    it('replays the entry for these blocks and does not fetch the engine', async () => {
        store()
        boot()
        expect(cachedStyle()?.textContent).toBe(CSS)
        await settle()
        expect(engineScripts()).toBe(0)
        expect(window.__tailwindCache.record.tokens).toEqual(['p-4'])
        expect(window.__tailwindCache.idFor([A])).toBe(idFor([A]))
    })

    it('places the replay at the end of <head>, where the engine sheet goes, after author CSS that follows the loader', async () => {
        store()
        boot({ afterLoader: '<style id="author">.a{}</style><link id="l" rel="stylesheet" href="data:text/css,">' })
        const kids = [...document.head.children]
        expect(kids.indexOf(cachedStyle())).toBeGreaterThan(kids.indexOf(document.getElementById('l')))
    })

    it('stays before #manifest-styles', async () => {
        store()
        boot({ afterLoader: '<style id="manifest-styles"></style>' })
        expect(cachedStyle().nextElementSibling.id).toBe('manifest-styles')
    })

    it('moves to the end of <head> after the module wave if CSS was added after it', async () => {
        store()
        boot()
        const late = document.createElement('style')
        late.id = 'late'
        document.head.appendChild(late)
        await settle()
        const kids = [...document.head.children]
        expect(kids.indexOf(cachedStyle())).toBeGreaterThan(kids.indexOf(late))
    })

    it('compares blocks as an ordered sequence', async () => {
        store({ blocks: [A, B] })
        boot({ headExtra: block(B) + block(A) })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(engineScripts()).toBe(1)
    })

    it('replays when the ordered blocks match, wherever they sit in <head>', async () => {
        store({ blocks: [A, B] })
        boot({ headExtra: block(A), afterLoader: block(B) })
        await settle()
        expect(cachedStyle()).not.toBeNull()
        expect(engineScripts()).toBe(0)
    })

    it('fetches the engine when the utilities module never arms the watcher', async () => {
        store()
        boot({ armUtilities: false })
        await settle()
        expect(engineScripts()).toBe(1)
    })

    it('loads the engine with no cache, and sets up recording', async () => {
        boot()
        await settle()
        expect(engineScripts()).toBe(1)
        expect(cachedStyle()).toBeNull()
        expect(window.__tailwindCache.v).toBe(V)
    })

    const fallbacks = {
        'another framework version': () => store({ v: `0.0.0-dev|0.5.1|` }),
        'an expired entry': () => store({ t: Date.now() - 8 * 24 * 3600 * 1000 }),
        'a timestamp in the future': () => store({ t: Date.now() + 60 * 1000 }),
        'a missing timestamp': () => store({ t: undefined }),
        'unparseable JSON': () => { store(); localStorage.setItem(`${KEY}:${idFor([A])}`, '{nope') },
        'tokens that are not strings': () => store({ tokens: [null] }),
        'blocks that are not strings': () => { store(); const k = `${KEY}:${idFor([A])}`; const r = JSON.parse(localStorage.getItem(k)); r.blocks = [1]; localStorage.setItem(k, JSON.stringify(r)) },
        'an unparseable index': () => { store(); localStorage.setItem(KEY, 'x') },
        'an entry for other blocks only': () => store({ blocks: [B] }),
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

    it('data-tailwind="no-cache" keeps the eager engine and records nothing', async () => {
        store()
        boot({ tailwindAttr: 'no-cache' })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(window.__tailwindCache).toBeUndefined()
        expect(engineScripts()).toBe(1)
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
        boot({ headExtra: block(A) + '<style data-mnfst-utilities>.gap-2{gap:.5rem}</style>' })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(engineScripts()).toBe(1)
    })

    it('leaves a complete shipped sheet in charge (no engine, no replay)', async () => {
        store()
        boot({ headExtra: block(A) + '<style data-mnfst-utilities data-mnfst-utilities-complete>.gap-2{gap:.5rem}</style>' })
        await settle()
        expect(cachedStyle()).toBeNull()
        expect(engineScripts()).toBe(0)
    })
})
