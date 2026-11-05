// mnfst-test browser layer: static server robustness
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '../packages/test/browser.mjs'

describe('serve()', () => {
    it('serves dir indexes, falls back for SPA routes, and survives bad URLs', async () => {
        const root = mkdtempSync(join(tmpdir(), 'mnfst-serve-'))
        writeFileSync(join(root, 'index.html'), 'home')
        mkdirSync(join(root, 'docs'))
        mkdirSync(join(root, 'assets'))
        writeFileSync(join(root, 'docs', 'index.html'), 'docs')
        const s = await serve(root)
        const get = async (p) => { const r = await fetch(s.url + p); return [r.status, await r.text()] }
        try {
            expect(await get('/docs')).toEqual([200, 'docs'])
            expect(await get('/docs/')).toEqual([200, 'docs'])
            expect(await get('/assets')).toEqual([200, 'home'])
            expect(await get('/app/route')).toEqual([200, 'home'])
            expect((await get('/%E0'))[0]).toBe(400)
            expect((await get('/missing.js'))[0]).toBe(404)
            expect(await get('/%2e%2e/%2e%2e/etc/passwd')).toEqual([200, 'home'])
            expect((await get('/..%2f..%2fetc%2fpasswd'))[1]).not.toMatch(/root:/)
        } finally {
            await s.close()
        }
    })
})
