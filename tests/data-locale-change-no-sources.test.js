// @vitest-environment happy-dom
/**
 * A locale change on a project with no manifest.data must clear
 * _localeChanging and fire manifest:render-ready (was stuck true on the
 * early return, withholding render-ready for the rest of the page).
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, '../src/scripts/data')
const SUBSCRIPTS = [
    'core/manifest.data.config.js',
    'core/manifest.data.store.js',
    'shared/manifest.data.mutations.js',
    'shared/manifest.data.proxies.core.js',
    'shared/manifest.data.proxies.cache.js',
    'shared/proxies/creation/manifest.data.proxies.helpers.js',
    'shared/proxies/creation/manifest.data.proxies.array.js',
    'shared/proxies/creation/manifest.data.proxies.route.js',
    'shared/manifest.data.proxies.magic.state.js',
    'shared/manifest.data.proxies.magic.core.js',
    'shared/manifest.data.main.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))

describe('localechange without data sources', () => {
    it('clears _localeChanging and fires render-ready', async () => {
        window.Alpine = Alpine
        window.ManifestComponentsRegistry = { manifest: { name: 'no-data' } }
        const ctx = {
            window, document, Alpine, console, setTimeout, clearTimeout, setInterval, clearInterval,
            requestAnimationFrame: cb => window.requestAnimationFrame(cb),
            cancelAnimationFrame: id => window.cancelAnimationFrame(id),
            CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        }
        vm.createContext(ctx)
        for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
        for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
        await settle(250)

        const ready = []
        window.addEventListener('manifest:render-ready', e => ready.push(e.detail))
        window.__manifestRenderReady = false
        document.documentElement.lang = 'fr'
        window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: 'fr' } }))
        await settle(300)

        expect(Alpine.store('data')._localeChanging).toBe(false)
        expect(ready.map(d => d.locale)).toEqual(['fr'])
    })
})
