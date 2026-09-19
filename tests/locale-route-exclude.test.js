/**
 * Defect A (client-reported, verified twice incl. a 1,306-file repro):
 * `prerender.localeRouteExclude` was only honoured in `prefixLocaleInternalLinks`
 * (link rewriting), not wherever locale route EXPANSION actually happens — so
 * `npx mnfst-render` still wrote `website/<locale>/docs/**` for every locale,
 * and `mnfst-publish --no-render` then crashed (ENOENT) on stale entries for
 * paths a re-render no longer produced. Docs promise: excluded prefixes (and
 * everything under them, e.g. multi-segment `docs/<group>/<article>`) stay
 * locale-neutral.
 *
 * Covers the shared predicate + the two real callers: the renderer's route
 * expansion (expandLocaleRoutePaths) and the publisher's file-list computation
 * (collectFiles).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
    normalizeLocaleRouteExclude,
    isLocaleRouteExcluded,
    expandLocaleRoutePaths,
    prefixLocaleInternalLinks,
} from '../src/scripts/manifest.render.mjs'
import { collectFiles } from '../packages/publish/manifest.publish.mjs'

describe('normalizeLocaleRouteExclude', () => {
    it('trims, drops leading/trailing slashes, and accepts array or comma string', () => {
        expect(normalizeLocaleRouteExclude(['legal', ' docs/ ', '/api/'])).toEqual(['legal', 'docs', 'api'])
        expect(normalizeLocaleRouteExclude('legal, docs')).toEqual(['legal', 'docs'])
        expect(normalizeLocaleRouteExclude(null)).toEqual([])
    })
})

describe('isLocaleRouteExcluded — shared predicate', () => {
    const exclude = ['legal', 'docs']
    it('matches the prefix itself and multi-segment paths under it', () => {
        expect(isLocaleRouteExcluded('docs', exclude)).toBe(true)
        expect(isLocaleRouteExcluded('docs/group/article', exclude)).toBe(true)
        expect(isLocaleRouteExcluded('legal/terms', exclude)).toBe(true)
    })
    it('does not match a route that merely starts with the same characters', () => {
        expect(isLocaleRouteExcluded('docsite', exclude)).toBe(false)
        expect(isLocaleRouteExcluded('legalese/x', exclude)).toBe(false)
    })
    it('does not match unrelated routes, and treats no-exclude-list as excluding nothing', () => {
        expect(isLocaleRouteExcluded('platform', exclude)).toBe(false)
        expect(isLocaleRouteExcluded('docs', [])).toBe(false)
    })
})

// The client's exact reproduction shape: 2 locales, routes `home` and the
// multi-segment `docs/g/a`, exclude ["docs"].
describe('expandLocaleRoutePaths — renderer route expansion', () => {
    const routeSegments = ['home', 'docs/g/a']
    const locales = ['en', 'fr']

    it('expands the non-excluded route to every locale but leaves the excluded prefix locale-neutral', () => {
        const paths = expandLocaleRoutePaths({ routeSegments, locales, defaultLocale: 'en', localeRouteExclude: ['docs'] })
        expect(paths.has('fr/home')).toBe(true)
        expect(paths.has('home')).toBe(true)
        expect(paths.has('docs/g/a')).toBe(true) // locale-neutral base still renders
        expect(paths.has('fr/docs/g/a')).toBe(false)
        expect(paths.has('en/docs/g/a')).toBe(false) // default-locale-under-slug too
        // No path in the whole set is a locale-prefixed docs/** variant.
        for (const p of paths) expect(/^(en|fr)\/docs(\/|$)/.test(p)).toBe(false)
    })

    it('with no exclusion, docs/g/a IS expanded per locale (behaviour for non-excluded routes is unchanged)', () => {
        const paths = expandLocaleRoutePaths({ routeSegments, locales, defaultLocale: 'en', localeRouteExclude: [] })
        expect(paths.has('fr/docs/g/a')).toBe(true)
    })
})

describe('prefixLocaleInternalLinks — multi-segment excluded routes stay unprefixed', () => {
    it('leaves an excluded multi-segment href alone but prefixes an ordinary one', () => {
        const html = '<a href="/docs/g/a">Article</a> <a href="/home">Home</a>'
        const out = prefixLocaleInternalLinks(html, 'fr', ['en', 'fr'], ['docs'])
        expect(out).toContain('href="/docs/g/a"')
        expect(out).toContain('href="/fr/home"')
    })
})

describe('collectFiles — publisher expected-file computation honours the exclusion (Defect A, publish half)', () => {
    let root
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'mnfst-publish-locale-'))
        const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
        run(['init', '-q'])
        run(['config', 'user.email', 'a@example.com'])
        run(['config', 'user.name', 'a'])
        writeFileSync(join(root, 'manifest.json'), '{}')
        for (const p of ['website/en/home/index.html', 'website/fr/home/index.html', 'website/en/docs/index.html']) {
            mkdirSync(join(root, p, '..'), { recursive: true })
            writeFileSync(join(root, p), '<html></html>')
        }
        run(['add', '-A'])
        run(['commit', '-q', '-m', 'init'])
    })
    afterEach(() => rmSync(root, { recursive: true, force: true }))

    it('never demands a locale/docs path that a corrected render no longer produced', () => {
        // Simulate the sequence the client hit: an OLDER build once committed
        // website/fr/docs/index.html; a later, correctly-excluding render no
        // longer writes it, and the file is deleted on disk without `git rm` —
        // `git ls-files -c` still reports it from the index.
        const staleDocs = join(root, 'website/fr/docs')
        mkdirSync(staleDocs, { recursive: true })
        writeFileSync(join(staleDocs, 'index.html'), '<html></html>')
        spawnSync('git', ['add', '-A'], { cwd: root })
        spawnSync('git', ['commit', '-q', '-m', 'old build with fr/docs'], { cwd: root })
        rmSync(staleDocs, { recursive: true, force: true }) // re-render dropped it; no `git rm`

        expect(existsSync(join(root, 'website/fr/docs/index.html'))).toBe(false)

        let rels
        expect(() => { rels = collectFiles(root, 'website') }).not.toThrow()
        expect(rels).not.toContain('website/fr/docs/index.html')
        // Files that DO still exist are unaffected.
        expect(rels).toContain('website/fr/home/index.html')
        expect(rels).toContain('website/en/docs/index.html')
    })
})
