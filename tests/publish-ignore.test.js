/**
 * Publish exclusions: `.manifestignore` / `publishIgnore` decouple "not published"
 * from "not in git", so a versioned file can still be kept out of the bundle.
 * Tests the pure matcher (makePublishIgnore) + the existing secret guard (isExcludedPath).
 */
import { describe, it, expect } from 'vitest'
import { makePublishIgnore, isExcludedPath } from '../packages/publish/manifest.publish.mjs'

describe('makePublishIgnore', () => {
    it('matches nothing when there are no rules', () => {
        const m = makePublishIgnore([])
        expect(m('anything.js')).toBe(false)
        expect(makePublishIgnore(['', '   ', '# just a comment'])('x')).toBe(false)
    })

    it('directory pattern excludes the dir contents at any depth, but not a like-named file', () => {
        const m = makePublishIgnore(['internal/'])
        expect(m('internal/notes.md')).toBe(true)
        expect(m('sub/internal/a.txt')).toBe(true)
        expect(m('internal')).toBe(false)      // a `dir/` rule can't match a file named `internal`
        expect(m('public/readme.md')).toBe(false)
    })

    it('path-scoped patterns are anchored to the project root', () => {
        const m = makePublishIgnore(['data/seed.json', '/config.local.js'])
        expect(m('data/seed.json')).toBe(true)
        expect(m('config.local.js')).toBe(true)
        expect(m('nested/data/seed.json')).toBe(false)   // has a slash → root-anchored
        expect(m('sub/config.local.js')).toBe(false)     // leading slash → root-anchored
    })

    it('basename globs match at any depth', () => {
        const m = makePublishIgnore(['*.psd', 'notes.md'])
        expect(m('design/hero.psd')).toBe(true)
        expect(m('hero.psd')).toBe(true)
        expect(m('a/b/notes.md')).toBe(true)
        expect(m('a/b/readme.md')).toBe(false)
    })

    it('supports ** across path segments', () => {
        const m = makePublishIgnore(['docs/**/*.internal.md'])
        expect(m('docs/a/b/spec.internal.md')).toBe(true)
        expect(m('docs/x.internal.md')).toBe(false) // ** requires an intermediate segment here
        expect(m('other/a.internal.md')).toBe(false)
    })

    it('ignores comments and blank lines', () => {
        const m = makePublishIgnore(['# secrets below', '', 'private/'])
        expect(m('private/key.txt')).toBe(true)
        expect(m('# secrets below')).toBe(false)
    })
})

describe('isExcludedPath (secret guard — regression)', () => {
    it('still drops secrets and build/system dirs at any depth', () => {
        for (const p of ['.env', '.env.local', 'api/.env.production', 'id_rsa', 'certs/server.pem',
            'sub/.claude/x.json', '.git/config', 'node_modules/pkg/index.js', 'a/b/.DS_Store', 'x.key']) {
            expect(isExcludedPath(p)).toBe(true)
        }
    })
    it('keeps ordinary project files', () => {
        for (const p of ['index.html', 'src/app.js', 'data/products.csv', 'manifest.json']) {
            expect(isExcludedPath(p)).toBe(false)
        }
    })
})
