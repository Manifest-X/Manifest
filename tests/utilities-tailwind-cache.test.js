/**
 * @vitest-environment happy-dom
 *
 * Utilities side of the Tailwind engine output cache (manifest.utilities.tailwind-cache.js):
 * replay mode loads the engine once on the first unseen token or config change and hands off
 * without a gap; engine mode records every token the engine has been shown, in a bounded LRU;
 * the sync pass leaves Tailwind's theme to Tailwind.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')
const KEY = 'tailwind-engine-cache:v2'
const VARIANTS = '@custom-variant dark (&:where(.dark, .dark *));'
const CSS = '/*! tailwindcss v4.3.1 */ :root{--text-xs:0.75rem} .p-4{padding:1rem}'
const A = '@theme { --color-a: red; }'
const B = '@theme { --color-b: blue; }'
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const block = (t) => `<style type="text/tailwindcss">${t}</style>`
const idFor = (blocks) => 'id-' + blocks.length + '-' + blocks.join('|').length

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
    const state = { key: KEY, v: 'test|v', idFor, record: null, armed: false }
    if (record) {
        const style = document.createElement('style')
        style.setAttribute('data-tailwind-cache', '')
        style.textContent = record.css
        document.head.appendChild(style)
        state.record = record
        state.style = style
        state.id = window.__tailwindCacheId
        delete window.__tailwindCacheId
    }
    window.__tailwindCache = state
    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + `\n//boot:${Math.random()}`))
    await ready
    return { state, loadTailwind }
}

const rec = (over = {}) => ({ v: 'test|v', t: Date.now(), blocks: [], variants: VARIANTS, tokens: ['p-4', 'card', 'w-[37px]'], css: CSS, ...over })
const engineArrives = (css = CSS + ' .pt-7{padding-top:1.75rem}') => {
    const s = document.createElement('style')
    s.textContent = css
    document.head.appendChild(s)
    return s
}
const entries = () => { const i = JSON.parse(localStorage.getItem(KEY) || 'null'); return i ? i.ids.map(id => JSON.parse(localStorage.getItem(`${KEY}:${id}`))) : [] }

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

    it('moves a replayed entry to the front of the LRU', async () => {
        localStorage.setItem(KEY, JSON.stringify({ ids: ['other', 'mine'], sizes: { other: 1, mine: 1 } }))
        window.__tailwindCacheId = 'mine'
        const r = rec()
        await boot({ record: r })
        expect(JSON.parse(localStorage.getItem(KEY)).ids).toEqual(['mine', 'other'])
    })

    it('ignores framework state classes on <html>', async () => {
        const { loadTailwind } = await boot({ record: rec() })
        document.documentElement.classList.add('dark', 'window-resizing')
        await wait(30)
        expect(loadTailwind).not.toHaveBeenCalled()
    })

    it('sees a class that came and went within one task', async () => {
        const { loadTailwind } = await boot({ record: rec() })
        const el = document.querySelector('.card')
        el.classList.add('opacity-0')
        el.classList.remove('opacity-0')
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
    })

    it('loads the engine once on unseen tokens, feeds it the cached tokens from <head>, and swaps sheets in place', async () => {
        const { state, loadTailwind } = await boot({ record: rec(), headHtml: '<style id="after">.x{}</style>' })
        const events = []
        window.addEventListener('manifest:tailwind-cache', (e) => events.push(e.detail))
        const carriers = []
        new MutationObserver((ms) => ms.forEach(m => m.addedNodes.forEach(n => n.hasAttribute?.('data-tailwind-seed') && carriers.push({ parent: n.parentNode.localName, cls: n.getAttribute('class') })))).observe(document.documentElement, { childList: true, subtree: true })
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-7"></span>')
        await wait(5)
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-8"></span>')
        await wait(5)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
        expect(carriers).toEqual([{ parent: 'head', cls: 'p-4 card w-[37px]' }])
        // Cached copy stays until the engine's own sheet has rules
        expect(document.querySelector('style[data-tailwind-cache]')).not.toBeNull()
        const cachedNext = state.style.nextElementSibling
        const engine = engineArrives()
        await wait(50)
        expect(document.querySelector('style[data-tailwind-cache]')).toBeNull()
        expect(document.querySelector('[data-tailwind-seed]')).toBeNull()
        expect(engine.nextElementSibling).toBe(cachedNext)
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
        document.head.insertAdjacentHTML('beforeend', block('@theme { --color-late: red; }'))
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
        expect(state.reason).toBe('config')
        expect(document.querySelector('[data-tailwind-seed]')).toBeNull()
    })

    it('loads the engine when an author block changes', async () => {
        const { loadTailwind } = await boot({ record: rec({ blocks: [A] }), headHtml: block(A) })
        expect(loadTailwind).not.toHaveBeenCalled()
        document.querySelector('style[type="text/tailwindcss"]:not(#manifest-tailwind-variants)').textContent = B
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
    })

    it('compares author blocks in order', async () => {
        const { loadTailwind } = await boot({ record: rec({ blocks: [A, B] }), headHtml: block(B) + block(A) })
        await wait(10)
        expect(loadTailwind).toHaveBeenCalledTimes(1)
    })

    it('loads the engine when the variants block differs from the recorded one', async () => {
        const { loadTailwind } = await boot({ record: rec({ variants: VARIANTS + '\n@custom-variant x (&.x);' }) })
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
    it('records the engine output, the tokens it was shown, the ordered blocks and the variants text', async () => {
        const { state } = await boot({ bodyHtml: '<div class="p-4 author-thing"></div>', headHtml: block(A) + block(B) })
        engineArrives(CSS)
        await wait(1200)
        const [saved] = entries()
        expect(saved.v).toBe('test|v')
        expect(saved.css).toBe(CSS)
        expect(saved.tokens).toEqual(expect.arrayContaining(['p-4', 'author-thing']))
        expect(saved.blocks).toEqual([A, B])
        expect(saved.variants).toBe(VARIANTS)
        expect(JSON.parse(localStorage.getItem(KEY)).ids).toEqual([idFor([A, B])])
        expect(state.saved).toBeTruthy()
    })

    it('records classes that came and went, <template> contents and literal Alpine class strings, showing the engine the ones not on the page', async () => {
        await boot({
            bodyHtml: `<div class="p-4"><button :class="open ? 'bg-indigo-600 text-white' : { 'ring-2': x, active: y }">b</button>
                <div x-transition:enter="transition ease-out" x-transition:enter-start="opacity-0 scale-90"></div>
                <template x-if="t"><section class="grid-cols-3"><template><i class="col-span-2"></i></template></section></template></div>`
        })
        engineArrives(CSS)
        const carriers = []
        new MutationObserver((ms) => ms.forEach(m => m.addedNodes.forEach(n => n.hasAttribute?.('data-tailwind-seed') && carriers.push(n.parentNode.localName + ':' + n.getAttribute('class'))))).observe(document.documentElement, { childList: true, subtree: true })
        const el = document.querySelector('.p-4')
        el.classList.add('scale-95')
        el.classList.remove('scale-95')
        await wait(1300)
        const [saved] = entries()
        for (const t of ['scale-95', 'bg-indigo-600', 'text-white', 'ring-2', 'active', 'transition', 'ease-out', 'opacity-0', 'scale-90', 'grid-cols-3', 'col-span-2', 'p-4']) expect(saved.tokens).toContain(t)
        expect(carriers.every(c => c.startsWith('head:'))).toBe(true)
        expect(carriers.join(' ')).toContain('bg-indigo-600')
        expect(carriers.join(' ')).not.toMatch(/\bp-4\b/)
    })

    it('carries the cached tokens forward after a seeded handoff', async () => {
        await boot({ record: rec({ tokens: ['p-4', 'card', 'from-page-a'] }) })
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-7"></span>')
        await wait(10)
        engineArrives()
        await wait(1300)
        const [saved] = entries()
        expect(saved.tokens).toEqual(expect.arrayContaining(['from-page-a', 'pt-7', 'p-4']))
        expect(saved.css).toContain('.pt-7')
    })

    it('saves at most once per interval, and flushes on pagehide', async () => {
        const { state } = await boot()
        const engine = engineArrives(CSS)
        await wait(1200)
        const first = state.saved
        expect(first).toBeTruthy()
        document.body.insertAdjacentHTML('beforeend', '<span class="pt-3"></span>')
        engine.textContent = CSS + ' .pt-3{}'
        await wait(1500)
        expect(state.saved).toBe(first)
        window.dispatchEvent(new Event('pagehide'))
        expect(state.saved).not.toBe(first)
        expect(entries()[0].tokens).toContain('pt-3')
    })

    it('keeps one entry per block set, at most four, newest first', async () => {
        for (let i = 0; i < 6; i++) {
            await boot({ headHtml: block(`@theme { --c: ${'x'.repeat(i + 1)}; }`) })
            engineArrives(CSS)
            await wait(1400)
            window.__tailwindCache.stop()
        }
        const index = JSON.parse(localStorage.getItem(KEY))
        expect(index.ids.length).toBe(4)
        expect(index.ids[0]).toBe(idFor([`@theme { --c: xxxxxx; }`]))
        expect(Object.keys(localStorage).filter(k => k.startsWith(KEY + ':')).length).toBe(4)
    }, 20000)

    it('does not store an oversize sheet, and drops the old entry for that block set', async () => {
        await boot()
        engineArrives(CSS)
        await wait(1400)
        expect(entries().length).toBe(1)
        window.__tailwindCache.stop()
        await boot()
        engineArrives('/*! tailwindcss */' + 'x'.repeat(260 * 1024))
        await wait(1400)
        expect(entries().length).toBe(0)
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
