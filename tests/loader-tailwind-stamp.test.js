/**
 * @vitest-environment happy-dom
 *
 * Loader: publish-time Tailwind engine skip. Built loaders (lib/manifest.js and lib/manifest.min.js,
 * which carry the seed constant). No stamp: the engine loads as before. A stamp is honoured only in
 * skip mode with this loader's seed, matching tokens and a readable sheet; anything else loads the engine.
 * Real-Chromium coverage: tests/e2e/tailwind-stamp.e2e.mjs. STAMP_LIB=<dir> runs it against another lib/.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import { tailwindSeed } from '../src/scripts/manifest.tailwind.variants.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LIB = process.env.STAMP_LIB || path.join(__dirname, '../lib')
const ENGINE = readFileSync(path.join(__dirname, '../src/scripts/build.mjs'), 'utf8').match(/TAILWIND_V4_FILE: 'tailwind\.v(\d+\.\d+\.\d+)\.js'/)[1]
const SEED = tailwindSeed(ENGINE)
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }
const VERSION = '0.5.199-next.0'
const engineScripts = () => document.querySelectorAll('script[src*="manifest.tailwind"]').length

function stampHead({ seed = SEED, mode = 'skip', tokens = ['flex', 'p-4'], tokensSeed = seed, tokensEl = true, author = '' } = {}) {
    const json = tokensEl ? `<script type="application/json" data-tailwind-tokens>${JSON.stringify({ seed: tokensSeed, tokens })}</script>` : ''
    return `<link rel="stylesheet" href="/manifest.utilities.css?v=1" data-mnfst-utilities data-tailwind-stamp="${seed}"${mode ? ` data-tailwind-mode="${mode}"` : ''}>${json}${author}`
}

beforeEach(() => {
    for (const k of ['__manifestLoaderStarted', '__manifestLoaded', '__manifestReady', 'Manifest', '__tailwindStamp']) delete window[k]
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        if (String(url).endsWith('/manifest.json')) return new Response(JSON.stringify({ name: 'x', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response('', { status: 404 })
    }))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    if (!window.requestIdleCallback) window.requestIdleCallback = (fn) => setTimeout(fn, 0)
})

for (const file of ['manifest.js', 'manifest.min.js']) {
    const CODE = readFileSync(path.join(LIB, file), 'utf8')

    function boot({ headExtra = '', tailwind = true, plugins = 'toasts,data,utilities', readable = false } = {}) {
        window.happyDOM.setURL('https://site.example/app/')
        window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
        window.happyDOM.settings.disableCSSFileLoading = true
        document.head.innerHTML = `<link rel="manifest" href="/manifest.json">${headExtra}`
        if (readable) {
            const link = document.querySelector('link[data-tailwind-stamp]')
            Object.defineProperty(link, 'sheet', { configurable: true, get: () => ({ cssRules: [{ cssText: '.flex{display:flex}' }] }) })
        }
        document.body.innerHTML = ''
        const s = document.createElement('script')
        // happy-dom has no currentScript for new Function(): the loader finds its tag by src (manifest.js), whichever build runs
        s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib/manifest.js`)
        s.setAttribute('data-version', VERSION)
        s.setAttribute('data-plugins', plugins)
        if (tailwind) s.setAttribute('data-tailwind', '')
        document.head.appendChild(s)
        new Function(CODE)()
    }
    const decided = async () => { await window.__tailwindStamp.decision; await settle() }

    describe(`${file}: Tailwind engine-skip stamp`, () => {
        it('no stamp: the engine loads and no verdict exists', async () => {
            boot()
            await settle()
            expect(engineScripts()).toBe(1)
            expect(window.__tailwindStamp).toBe(undefined)
            expect(window.Manifest.tailwindStamp).toBe(null)
        })

        it('an unstamped utilities sheet changes nothing', async () => {
            boot({ headExtra: '<link rel="stylesheet" href="/manifest.utilities.css" data-mnfst-utilities>' })
            await settle()
            expect(engineScripts()).toBe(1)
            expect(window.__tailwindStamp).toBe(undefined)
        })

        it('no data-tailwind: a stamp loads nothing and decides nothing', async () => {
            boot({ tailwind: false, headExtra: stampHead(), readable: true })
            await settle()
            expect(engineScripts()).toBe(0)
            expect(window.__tailwindStamp).toBe(undefined)
        })

        it('skip mode, matching seed and tokens, readable sheet: no engine', async () => {
            boot({ headExtra: stampHead(), readable: true })
            await decided()
            expect(engineScripts()).toBe(0)
            expect(window.Manifest.tailwindStamp).toEqual({ mode: 'skip', seed: SEED, accepted: true, reason: null, wouldSkip: true, engine: 'skipped', trigger: null })
            expect(window.__manifestLoaded).toBeTruthy()
        })

        it('a token that needs the engine loads it once and is remembered for this sheet', async () => {
            boot({ headExtra: stampHead(), readable: true })
            await decided()
            const events = []
            window.addEventListener('manifest:tailwind-engine', (e) => events.push(e.detail))
            window.__tailwindStamp.needEngine('skew-x-12', 'token')
            window.__tailwindStamp.needEngine('rotate-3', 'token')
            await settle()
            expect(engineScripts()).toBe(1)
            expect(events).toEqual([{ token: 'skew-x-12', reason: 'token', mode: 'skip' }])
            const v = window.Manifest.tailwindStamp
            expect(v.engine).toBe('loaded')
            expect(v.wouldSkip).toBe(false)
            expect(v.trigger.token).toBe('skew-x-12')
            const rec = JSON.parse(localStorage.getItem('tailwind-engine-needed'))
            expect(rec.seed).toBe(SEED)
            expect(rec.href).toContain('/manifest.utilities.css?v=1')

            // Next visit: the engine loads eagerly
            for (const k of ['__manifestLoaderStarted', '__manifestLoaded', 'Manifest', '__tailwindStamp']) delete window[k]
            boot({ headExtra: stampHead(), readable: true })
            await decided()
            expect(engineScripts()).toBe(1)
            expect(window.Manifest.tailwindStamp.reason).toBe('remembered')
        })

        it('a remembered need for another sheet does not count', async () => {
            localStorage.setItem('tailwind-engine-needed', JSON.stringify({ href: 'https://site.example/manifest.utilities.css?v=0', seed: SEED, t: Date.now() }))
            boot({ headExtra: stampHead(), readable: true })
            await decided()
            expect(engineScripts()).toBe(0)
        })

        it('a remembered need older than 7 days does not count', async () => {
            localStorage.setItem('tailwind-engine-needed', JSON.stringify({ href: 'https://site.example/manifest.utilities.css?v=1', seed: SEED, t: Date.now() - 8 * 86400000 }))
            boot({ headExtra: stampHead(), readable: true })
            await decided()
            expect(engineScripts()).toBe(0)
        })

        const rejected = [
            ['engine version mismatch', { headExtra: stampHead({ seed: SEED.replace(ENGINE, '4.3.3') }), readable: true }, 'seed'],
            ['input hash mismatch', { headExtra: stampHead({ seed: `${ENGINE}:zzzzzz` }), readable: true }, 'seed'],
            ['no tokens element', { headExtra: stampHead({ tokensEl: false }), readable: true }, 'tokens'],
            ['tokens for another seed', { headExtra: stampHead({ tokensSeed: `${ENGINE}:other` }), readable: true }, 'tokens'],
            ['tokens that are not strings', { headExtra: stampHead({ tokens: ['flex', 3] }), readable: true }, 'tokens'],
            ['an author text/tailwindcss block', { headExtra: stampHead({ author: '<style type="text/tailwindcss">@theme { --color-x: red; }</style>' }), readable: true }, 'author-block'],
            ['no utilities module', { headExtra: stampHead(), readable: true, plugins: 'toasts,data' }, 'utilities'],
            ['a prerendered page', { headExtra: '<meta name="manifest:prerendered" content="1">' + stampHead(), readable: true }, 'prerendered'],
        ]
        for (const [name, opts, reason] of rejected) {
            it(`skip mode with ${name}: the engine loads`, async () => {
                boot(opts)
                await decided()
                expect(engineScripts()).toBe(1)
                expect(window.Manifest.tailwindStamp).toMatchObject({ mode: 'skip', accepted: false, reason, wouldSkip: false, engine: 'loaded' })
                window.__tailwindStamp.needEngine('x', 'token')
                await settle()
                expect(engineScripts()).toBe(1)
            })
        }

        it('skip mode with a sheet that ends unreadable: the engine loads', async () => {
            boot({ headExtra: stampHead() })
            await decided()
            expect(engineScripts()).toBe(1)
            expect(window.Manifest.tailwindStamp).toMatchObject({ accepted: false, reason: 'sheet', engine: 'loaded' })
        }, 10000)

        it('a sheet whose cssRules throws (cross-origin) is unreadable', async () => {
            boot({ headExtra: stampHead() })
            Object.defineProperty(document.querySelector('link[data-tailwind-stamp]'), 'sheet', { configurable: true, get: () => ({ get cssRules() { throw new Error('SecurityError') } }) })
            await decided()
            expect(window.Manifest.tailwindStamp.reason).toBe('sheet')
            expect(engineScripts()).toBe(1)
        }, 10000)

        for (const mode of ['shadow', '', 'on']) {
            it(`mode ${JSON.stringify(mode)} is shadow: the engine loads at once and the verdict is recorded`, async () => {
                boot({ headExtra: stampHead({ mode }), readable: true })
                await settle(2)
                expect(engineScripts()).toBe(1)
                await decided()
                expect(window.Manifest.tailwindStamp).toEqual({ mode: 'shadow', seed: SEED, accepted: true, reason: null, wouldSkip: true, engine: 'loaded', trigger: null })
                window.__tailwindStamp.needEngine('skew-x-12', 'token')
                await settle()
                expect(engineScripts()).toBe(1)
                expect(window.Manifest.tailwindStamp).toMatchObject({ wouldSkip: false, trigger: { token: 'skew-x-12', reason: 'token' } })
            })
        }

        it('shadow mode reports why a stamp would be refused', async () => {
            boot({ headExtra: stampHead({ mode: 'shadow', seed: SEED.replace(ENGINE, '4.3.3') }), readable: true })
            await decided()
            expect(window.Manifest.tailwindStamp).toMatchObject({ mode: 'shadow', accepted: false, reason: 'seed', wouldSkip: false })
        })

        it('the verdict is a copy: callers cannot change it', async () => {
            boot({ headExtra: stampHead(), readable: true })
            await decided()
            const v = window.Manifest.tailwindStamp
            v.accepted = false
            expect(window.Manifest.tailwindStamp.accepted).toBe(true)
        })
    })
}

describe('src/scripts/manifest.js (unbuilt): no seed, so a stamp never skips', () => {
    it('loads the engine for a matching skip stamp', async () => {
        const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
        window.happyDOM.setURL('https://site.example/app/')
        window.happyDOM.settings.disableCSSFileLoading = true
        document.head.innerHTML = `<link rel="manifest" href="/manifest.json">${stampHead()}`
        Object.defineProperty(document.querySelector('link[data-tailwind-stamp]'), 'sheet', { configurable: true, get: () => ({ cssRules: [{}] }) })
        const s = document.createElement('script')
        s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${VERSION}/lib/manifest.js`)
        s.setAttribute('data-version', VERSION)
        s.setAttribute('data-plugins', 'toasts,utilities')
        s.setAttribute('data-tailwind', '')
        document.head.appendChild(s)
        new Function(CODE)()
        await window.__tailwindStamp.decision
        await settle()
        expect(window.__tailwindStamp.reason).toBe('seed')
        expect(engineScripts()).toBe(1)
    })
})
