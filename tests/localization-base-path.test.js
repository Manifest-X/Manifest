/**
 * @vitest-environment happy-dom
 *
 * Locale URL rewrites keep the router base path: /app/fr/settings stays put on
 * load, and switching or adding a locale edits the segment after the base.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(dir, '../src/scripts/manifest.localization.js'), 'utf8')
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

let base = '/app'
const go = (p) => window.history.replaceState({}, '', p)
const here = () => window.location.pathname + window.location.search

beforeAll(async () => {
    window.happyDOM.setURL('http://localhost/app/fr/settings')
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    window.getManifestBasePath = () => base
    window.__manifestLoaded = { data: { strings: { en: { hi: 'Hi' }, fr: { hi: 'Salut' } } } }
    new Function(source)()
    await settle()
})

describe('localization with a base path', () => {
    it('leaves a based locale URL alone on load', () => {
        expect(here()).toBe('/app/fr/settings')
        expect(Alpine.store('locale').current).toBe('fr')
    })

    it('switches the locale segment after the base', async () => {
        go('/app/fr/settings?tab=2')
        await window.__manifestSetLocale('en')
        expect(here()).toBe('/app/en/settings?tab=2')
    })

    it('adds the locale after the base, not before it', async () => {
        go('/app/other')
        await window.__manifestSetLocale('fr', true)
        expect(here()).toBe('/app/fr/other')
    })

    it('reset strips the locale after the base', () => {
        go('/app/fr/other')
        window.__manifestResetLocale()
        expect(here()).toBe('/app/other')
    })
})

describe('localization without a base path', () => {
    it('switches and adds the leading locale segment', async () => {
        base = ''
        go('/en/settings')
        await window.__manifestSetLocale('fr')
        expect(here()).toBe('/fr/settings')
        go('/other')
        await window.__manifestSetLocale('en', true)
        expect(here()).toBe('/en/other')
    })

    it('treats a path that only resembles the base as unbased', async () => {
        base = '/app'
        go('/apple/fr/x')
        await window.__manifestSetLocale('fr')
        expect(here()).toBe('/apple/fr/x')
    })
})
