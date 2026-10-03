import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareTrees, normalise, pickVersions } from '../scripts/release-check.mjs'

const sri = s => `sha384-${createHash('sha384').update(s).digest('base64')}`
const tree = (v, body = 'run()') => {
    const js = `const BUILD_VERSION = '${v}';\n${body}\n`
    return new Map([
        ['package.json', Buffer.from(`{ "name": "x", "version": "${v}" }`)],
        ['lib/a.js', Buffer.from(js)],
        ['lib/manifest.integrity.json', Buffer.from(JSON.stringify({ 'a.js': sri(js) }))],
    ])
}
const tmp = mkdtempSync(join(tmpdir(), 'rc-test-'))

describe('release-check', () => {
    it('version bump with matching integrity is stamps only', () => {
        expect(compareTrees(tree('1.0.9'), tree('1.0.10'), '1.0.9', '1.0.10', tmp).verdict).toBe('stamps-only')
    })
    it('real edit is reported, integrity entry included', () => {
        const r = compareTrees(tree('1.0.9'), tree('1.0.10', 'run(2)'), '1.0.9', '1.0.10', tmp)
        expect(r.verdict).toBe('changes')
        expect(r.changed.map(c => c.file).sort()).toEqual(['lib/a.js', 'lib/manifest.integrity.json'])
        expect(r.changed.find(c => c.file === 'lib/a.js')).toMatchObject({ add: 1, del: 1 })
    })
    it('integrity hash that does not match its file is not a stamp', () => {
        const n = tree('1.0.10')
        n.set('lib/manifest.integrity.json', Buffer.from(JSON.stringify({ 'a.js': sri('other') })))
        expect(compareTrees(tree('1.0.9'), n, '1.0.9', '1.0.10', tmp).verdict).toBe('changes')
    })
    it('normalise leaves longer versions alone', () => {
        expect(normalise('1.0.9 1.0.90 1.0.9.1 v1.0.9', '1.0.9', '1.0.10')).toBe('1.0.10 1.0.90 1.0.9.1 v1.0.9')
    })
    it('previous version is the last stable publish before the new one', () => {
        const time = { created: 't', modified: 't', '1.0.0': '2026-01-01', '1.0.1-next.0': '2026-01-02', '1.0.1': '2026-01-03' }
        expect(pickVersions(time, '1.0.1')).toEqual({ newV: '1.0.1', prevV: '1.0.0' })
    })
})
