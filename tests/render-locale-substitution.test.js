/**
 * Client-diagnosed defects in the two-phase locale-substitution pipeline
 * (manifest.render.mjs). See BUILD-STATE / the render-locale ticket for the
 * full write-up; this file covers the parts testable without Puppeteer —
 * the e2e fixture (tests/e2e/render-locale-smoke.e2e.mjs) covers the rest.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    routeMatchesGlob,
    isLocaleSubstitutionExcludedPath,
    loadAllLocaleContentData,
    buildSubstitutionPairs,
} from '../src/scripts/manifest.render.mjs'

describe('routeMatchesGlob / isLocaleSubstitutionExcludedPath (Defect 3 config surface)', () => {
    it('matches a trailing /* as a prefix, and an exact pattern only exactly', () => {
        expect(routeMatchesGlob('articles/foo', 'articles/*')).toBe(true)
        expect(routeMatchesGlob('articles', 'articles/*')).toBe(true) // base itself
        expect(routeMatchesGlob('articlesite', 'articles/*')).toBe(false)
        expect(routeMatchesGlob('about', 'about')).toBe(true)
        expect(routeMatchesGlob('about/team', 'about')).toBe(false)
    })
    it('isLocaleSubstitutionExcludedPath checks the LOCALE-STRIPPED route against every pattern', () => {
        const patterns = ['articles/*', 'legal']
        expect(isLocaleSubstitutionExcludedPath('articles/hello', patterns)).toBe(true)
        expect(isLocaleSubstitutionExcludedPath('legal', patterns)).toBe(true)
        expect(isLocaleSubstitutionExcludedPath('home', patterns)).toBe(false)
        expect(isLocaleSubstitutionExcludedPath('home', [])).toBe(false)
    })
})

describe('loadAllLocaleContentData — array-rooted per-locale sources (Defect 2)', () => {
    let root
    afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

    function setupProject() {
        root = mkdtempSync(join(tmpdir(), 'mnfst-locale-array-'))
        mkdirSync(join(root, 'data'), { recursive: true })
        return root
    }

    it('a root-level YAML LIST keyed by slug produces substitution pairs (was 0 before the fix)', () => {
        setupProject()
        writeFileSync(join(root, 'data', 'articles.en.yaml'), `
- slug: hello
  title: Hello
  teaser: Welcome
`.trim())
        writeFileSync(join(root, 'data', 'articles.es.yaml'), `
- slug: hello
  title: Hola
  teaser: Bienvenido
`.trim())
        const manifest = { data: { articles: { en: '/data/articles.en.yaml', es: '/data/articles.es.yaml' } } }
        const result = loadAllLocaleContentData(manifest, root, ['en', 'es'], 'en')
        const pairs = buildSubstitutionPairs(result.get('en'), result.get('es'))
        expect(pairs).toContainEqual(['Hello', 'Hola'])
        expect(pairs).toContainEqual(['Welcome', 'Bienvenido'])
    })

    it('falls back to index-based pairing when items have no stable key', () => {
        setupProject()
        writeFileSync(join(root, 'data', 'items.en.yaml'), `
- Hello
- Goodbye
`.trim())
        writeFileSync(join(root, 'data', 'items.es.yaml'), `
- Hola
- Adios
`.trim())
        const manifest = { data: { items: { en: '/data/items.en.yaml', es: '/data/items.es.yaml' } } }
        const result = loadAllLocaleContentData(manifest, root, ['en', 'es'], 'en')
        const pairs = buildSubstitutionPairs(result.get('en'), result.get('es'))
        expect(pairs).toContainEqual(['Hello', 'Hola'])
        expect(pairs).toContainEqual(['Goodbye', 'Adios'])
    })

    it('warns once when a configured per-locale source produces 0 pairs (untranslated/"empty" variant — content identical to default)', () => {
        setupProject()
        writeFileSync(join(root, 'data', 'articles.en.yaml'), `
- slug: hello
  title: Hello
`.trim())
        // A real (configured) source for "es" — present, but never actually
        // translated, so every value is identical to the default locale's.
        writeFileSync(join(root, 'data', 'articles.es.yaml'), `
- slug: hello
  title: Hello
`.trim())
        const manifest = { data: { articles: { en: '/data/articles.en.yaml', es: '/data/articles.es.yaml' } } }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            loadAllLocaleContentData(manifest, root, ['en', 'es'], 'en')
            expect(warn).toHaveBeenCalledTimes(1)
            expect(warn.mock.calls[0][0]).toMatch(/locale source articles \(es\) produced 0 substitution pairs/)
            // Calling again (e.g. a second read) must not re-warn beyond once per source.
            loadAllLocaleContentData(manifest, root, ['en', 'es'], 'en')
        } finally {
            warn.mockRestore()
        }
    })

    it('does not warn for a locale the source never configured (nothing to be silent about)', () => {
        setupProject()
        writeFileSync(join(root, 'data', 'articles.en.yaml'), `
- slug: hello
  title: Hello
`.trim())
        // No articles.fr.yaml at all — "fr" simply isn't part of this source.
        const manifest = { data: { articles: { en: '/data/articles.en.yaml' } } }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            loadAllLocaleContentData(manifest, root, ['en', 'fr'], 'en')
            expect(warn).not.toHaveBeenCalled()
        } finally {
            warn.mockRestore()
        }
    })
})
