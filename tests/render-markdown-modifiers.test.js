/**
 * @vitest-environment happy-dom
 *
 * Visual settle counts empty x-markdown regions with modifiers (x-markdown.safe) like plain x-markdown.
 * Baking/cleanup in a real browser: packages/render/test/e2e/run.mjs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { waitForVisualSettle } from '../src/scripts/manifest.render.page.mjs'

const fakePage = { evaluate: (fn, ...args) => Promise.resolve(fn(...args)) }

afterEach(() => { document.body.innerHTML = '' })

describe('waitForVisualSettle', () => {
    for (const attr of ['x-markdown', 'x-markdown.safe', 'x-markdown.safe.other']) {
        it(`holds while an ${attr} region is empty`, async () => {
            document.body.innerHTML = '<main><p>chrome</p><div id="md"></div></main>'
            document.getElementById('md').setAttribute(attr, 'data/a.md')
            let filledAt = 0
            setTimeout(() => { document.getElementById('md').innerHTML = '<h1>A</h1>'; filledAt = Date.now() }, 900)
            await waitForVisualSettle(fakePage, { settleMs: 150, mdWaitMs: 3000, capMs: 4000 })
            expect(filledAt).toBeGreaterThan(0)
        })
    }
})
