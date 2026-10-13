/**
 * Shared JS snippets (src/scripts/snippets/) are synced into each carrying
 * plugin by the build; the copies must match the snippet verbatim.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/scripts')
const read = (...p) => readFileSync(path.join(scripts, ...p), 'utf8')

const SNIPPETS = {
    'manifest.expressions.js': ['manifest.tooltips.js', 'manifest.toasts.js'],
}

describe('script snippets', () => {
    it('build config lists the same carriers', () => {
        const build = read('build.mjs')
        for (const [snippet, plugins] of Object.entries(SNIPPETS)) {
            expect(build).toContain(`'${snippet}': [${plugins.map((p) => `'${p}'`).join(', ')}]`)
        }
    })

    for (const [snippet, plugins] of Object.entries(SNIPPETS)) {
        const body = read('snippets', snippet).trim()
        for (const plugin of plugins) {
            it(`${plugin} carries ${snippet} verbatim (run npm run build)`, () => {
                expect(read(plugin)).toContain(body)
            })
        }
    }
})
