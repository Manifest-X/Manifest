/**
 * @vitest-environment happy-dom
 *
 * A publish to mnfst-run always carries the base the page loaded: when /__edit/base failed
 * at load, it is fetched again; if that fails too, the publish is refused and kept.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Alpine from 'alpinejs'
import { bootLivePage } from './helpers/edit-live-page.js'

const BODY = `<section x-edit="br">
  <div class="card red"><p>Same</p></div>
  <div class="card blue"><p>Same</p></div>
</section>`
const net = { baseDown: true }   // 503 at load
let live
beforeAll(async () => { live = await bootLivePage(BODY, net) }, 15000)
afterAll(() => live && live.stop())

const store = () => Alpine.store('edit')
const flush = () => new Promise(r => setTimeout(r, 0))
const editText = (el, value) => { el.dispatchEvent(new Event('focus')); el.innerHTML = value; el.dispatchEvent(new Event('blur')) }

describe('the base is required', () => {
    it('base unavailable at publish: refused, nothing written, the log kept', async () => {
        const before = live.src()
        editText(document.querySelector('.blue p'), 'Blue page')
        await flush()
        const r = await store().publish()
        expect(r.results[0].status).toBe('error')
        expect(r.results[0].reason).toContain('/__edit/base')
        expect(live.src()).toBe(before)
        expect(store().export().log.length).toBeGreaterThan(0)
    })

    it('base 503 at load, available at publish: fetched again, then written', async () => {
        net.baseDown = false
        const r = await store().publish()
        expect(r.results.map(x => x.status)).toEqual(['written'])
        expect(live.src()).toContain('<div class="card blue"><p>Blue page</p></div>')
        expect(store().export().log.length).toBe(0)
    })
})
