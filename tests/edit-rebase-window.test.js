/**
 * @vitest-environment happy-dom
 *
 * After publish({ rebase: true }) writes over a source changed elsewhere, the page still
 * shows the source it loaded: the written file's fingerprints and hashes describe
 * elements it does not show. Until it reloads, a further publish is refused rather than
 * matched against them (a twin added elsewhere would take the page's edit).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Alpine from 'alpinejs'
import { bootLivePage } from './helpers/edit-live-page.js'

const BODY = `<section x-edit="rw">
  <h1>Head</h1>
  <p>Same</p>
</section>`
let live
beforeAll(async () => { live = await bootLivePage(BODY, {}) }, 15000)
afterAll(() => live && live.stop())

const store = () => Alpine.store('edit')
const flush = () => new Promise(r => setTimeout(r, 0))
const editText = (el, value) => { el.dispatchEvent(new Event('focus')); el.innerHTML = value; el.dispatchEvent(new Event('blur')) }

describe('between a rebase write and the reload', () => {
    it('a further publish is refused, not written onto a twin the page never showed', async () => {
        const reload = []
        try { window.location.reload = () => reload.push(1) } catch { }
        live.setSrc(live.src().replace('<h1>Head</h1>', '<h1>Head</h1>\n  <p class="ext">Same</p>'))   // a twin, elsewhere
        editText(document.querySelector('h1'), 'Head page')
        await flush()
        const r1 = await store().publish({ rebase: true })
        expect(r1.results.map(x => x.status)).toEqual(['written'])
        editText(document.querySelector('[x-edit="rw"] p'), 'Mine')
        await flush()
        const r2 = await store().publish()
        expect(r2.results[0].status).toBe('error')
        expect(r2.results[0].reason).toContain('reload')
        expect(live.src()).toContain('<p class="ext">Same</p>\n  <p>Same</p>')
        // With rebase, it is checked against what the page loaded: the twin is refused too.
        const r3 = await store().publish({ rebase: true })
        expect(r3.results[0].status).toBe('error')
        expect(r3.results[0].reason).toContain('identical elements')
        expect(live.src()).toContain('<p class="ext">Same</p>\n  <p>Same</p>')
        expect(store().export().log.length).toBeGreaterThan(0)
    })
})
