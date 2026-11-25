/**
 * @vitest-environment happy-dom
 *
 * Utilities side of the Tailwind engine output cache (manifest.utilities.tailwind-cache.js):
 * replay mode loads the engine once on the first unseen token or config change and hands off
 * without a gap; engine mode records the engine's output; the sync pass leaves Tailwind's theme to Tailwind.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')
const KEY = 'tailwind-engine-cache:v1'
const VARIANTS = '@custom-variant dark (&:where(.dark, .dark *));'
const CSS = '/*! tailwindcss v4.3.1 */ :root{--text-xs:0.75rem} .p-4{padding:1rem}'
const wait = (ms) => new Promise(r => setTimeout(r, ms))

// The variants block is pre-placed so its text is known (the module keeps an existing one)
async function boot({ bodyHtml = '<div class="p-4 card"></div>', headHtml = '', record = undefined } = {}) {
    document.head.innerHTML = `<style id="manifest-tailwind-variants" type="text/tailwindcss">${VARIANTS}</style>${headHtml}`
    document.body.innerHTML = bodyHtml
    window.tailwind = {}
    window.ManifestComponentsRegistry = { manifest: {} }
    delete window.__manifestUtilitiesReady
    delete window.ManifestUtilities
    window.__manifestUtilitiesPending = 0
    const loadTailwind = vi.fn(() => Promise.resolve())
    window.Manifest = { loadTailwind, loadPlugin: vi.fn(() => Promise.resolve()) }
    const state = { key: KEY, v: 'test|v', record: null, armed: false }
    if (record) {
        const style = document.createElement('style')
        style.setAttribute('data-tailwind-cache', '')
        style.textContent = record.css
        document.head.appendChild(style)
        state.record = record
        state.style = style
    }
    window.__tailwindCache = state
    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + `\n//boot:${Math.random()}`))
    await ready
    return { state, loadTailwind }
}

const rec = (over = {}) => ({ v: 'test|v', t: Date.now(), blocks: [VARIANTS], tokens: ['p-4', 'card', 'w-[37px]'], css: CSS, ...over })
const engineArrives = (css = CSS + ' .pt-7{padding-top:1.75rem}') => {
    const s = document.createElement('style')
    s.textContent = css
    document.head.appendChild(s)
    return s
}

// One window per file: detach the previous boot's observers
afterEach(() => { window.__tailwindCache?.stop?.() })

beforeEach(() => {
    localStorage.clear()
    window.happyDOM.setURL('https://site.example/')
})

describe('Tailwind cache: replay mode', () => {
    it('arms and stays quiet while every token is known', async () => {
        const { state, loadTailwind } = await boot({ record: rec() })
        expect(state.armed).toBe(true)
        document.body.insertAdjacentHTML('beforeend', '<span class="w-[37px] p-4"></span>')
        await wait(30)
        expect(loadTailwind).not.toHaveBeenCalled()
        expect(document.querySelector('style[data-tailwind-cache]')).not.toBeNull()
    })

    it('ignores framework state classes on <html>', async () => {
        const { loadTailwind } = await boot({ record: rec() })
        document.documentElement.classList.add('dark', 'window-resizing')
        await wait(30)
        expect(loadTailwind).not.toHaveBeenCalled()
    })

    it('loads the engine once on unseen tokens, seeds it with the cached tokens, and hands off without a gap', async () => {
        const { state, loadTailwind } = await boot({ record: rec() })
        const events = []
        window.addEventListener('manifest:tailwind-cache', (e) => events.push(e.detail))
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-7"></span>')
        await wait(10)
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-8"></span>')
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
        const seed = document.querySelector('[data-tailwind-seed]')
        expect(seed.getAttribute('class').split(' ')).toEqual(['p-4', 'card', 'w-[37px]'])
        // Cached copy stays until the engine's own sheet has rules
        expect(document.querySelector('style[data-tailwind-cache]')).not.toBeNull()
        engineArrives()
        await wait(10)
        expect(document.querySelector('style[data-tailwind-cache]')).toBeNull()
        expect(document.querySelector('[data-tailwind-seed]')).toBeNull()
        expect(state.style).toBeNull()
        expect(events).toEqual([{ engineLoaded: true, reason: 'unseen', unseen: ['pt-7'] }])
    })

    it('catches unseen tokens already in the markup', async () => {
        const { loadTailwind } = await boot({ record: rec(), bodyHtml: '<div class="p-4 mt-9"></div>' })
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
    })

    it('loads the engine when a text/tailwindcss block is added', async () => {
        const { loadTailwind, state } = await boot({ record: rec() })
        const s = document.createElement('style')
        s.setAttribute('type', 'text/tailwindcss')
        s.textContent = '@theme { --color-late: red; }'
        document.head.appendChild(s)
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
        expect(state.reason).toBe('config')
        expect(document.querySelector('[data-tailwind-seed]')).toBeNull()
    })

    it('loads the engine when a block changes', async () => {
        const { loadTailwind } = await boot({ record: rec() })
        document.getElementById('manifest-tailwind-variants').textContent = VARIANTS + '\n@custom-variant x (&.x);'
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
    })

    it('loads the engine when the parsed blocks differ from the recorded set', async () => {
        const { loadTailwind } = await boot({ record: rec({ blocks: [VARIANTS, '@theme { --color-gone: red; }'] }) })
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
    })

    it('keeps the cached sheet and retries on the next unseen token if the engine fails to load', async () => {
        const { loadTailwind } = await boot({ record: rec() })
        loadTailwind.mockImplementationOnce(() => Promise.reject(new Error('offline')))
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-7"></span>')
        await wait(10)
        expect(document.querySelector('style[data-tailwind-cache]')).not.toBeNull()
        expect(document.querySelector('[data-tailwind-seed]')).toBeNull()
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-9"></span>')
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(2)
    })
})

describe('Tailwind cache: engine mode', () => {
    it('records the engine output, every class token and the blocks once it goes quiet', async () => {
        const { state } = await boot({ bodyHtml: '<div class="p-4 author-thing"></div>' })
        engineArrives(CSS)
        await wait(1200)
        const saved = JSON.parse(localStorage.getItem(KEY))
        expect(saved.v).toBe('test|v')
        expect(saved.css).toBe(CSS)
        expect(saved.tokens).toEqual(expect.arrayContaining(['p-4', 'author-thing']))
        expect(saved.blocks).toEqual([VARIANTS])
        expect(state.saved).toBeTruthy()
    })

    it('carries the cached tokens forward after a seeded handoff', async () => {
        await boot({ record: rec({ tokens: ['p-4', 'card', 'from-page-a'] }) })
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-7"></span>')
        await wait(10)
        engineArrives()
        await wait(1200)
        const saved = JSON.parse(localStorage.getItem(KEY))
        expect(saved.tokens).toEqual(expect.arrayContaining(['from-page-a', 'pt-7', 'p-4']))
        expect(saved.css).toContain('.pt-7')
    })

    it('does not store an oversize sheet', async () => {
        await boot()
        engineArrives('/*! tailwindcss */' + 'x'.repeat(600 * 1024))
        await wait(1200)
        expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('records nothing when a shipped utilities sheet is present', async () => {
        await boot({ headHtml: '<style data-mnfst-utilities>.gap-2{gap:.5rem}</style>' })
        engineArrives(CSS)
        await wait(1200)
        expect(localStorage.getItem(KEY)).toBeNull()
    })
})

describe('sync utilities pass with Tailwind output already present', () => {
    it('leaves Tailwind theme variables to Tailwind (no .text-xs from --text-xs)', async () => {
        await boot({ record: rec({ tokens: ['text-xs'] }), bodyHtml: '<div class="text-xs"></div>' })
        const ours = (document.getElementById('manifest-styles')?.textContent || '') + (document.getElementById('manifest-styles-critical')?.textContent || '')
        expect(ours).not.toMatch(/\.text-xs\s*\{/)
    })
})
