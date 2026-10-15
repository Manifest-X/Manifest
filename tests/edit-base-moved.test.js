/**
 * @vitest-environment happy-dom
 *
 * HTML that changes before the page has read its base cannot be checked by a base read
 * later: the publish is refused rather than taking the new source as what the page loaded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Alpine from 'alpinejs'
import { bootLivePage } from './helpers/edit-live-page.js'

const BODY = `<section x-edit="bm">
  <div class="card red"><p>Same</p></div>
  <div class="card blue"><p>Same</p></div>
</section>`
const net = { baseDown: true }
let live
beforeAll(async () => { live = await bootLivePage(BODY, net) }, 15000)
afterAll(() => live && live.stop())

describe('source changed before the base was read', () => {
    it('a twin swap while the base was down, with the reload cancelled: refused, not written onto the other twin', async () => {
        const swapped = live.src().replace(/(<div class="card red">.*<\/div>)\n  (<div class="card blue">.*<\/div>)/, '$2\n  $1')
        live.setSrc(swapped)
        const cancel = (e) => e.preventDefault()
        window.addEventListener('manifest:live-reload', cancel)
        window.dispatchEvent(new CustomEvent('manifest:source-change', { detail: { file: 'index.html', hash: 'x' } }))
        window.dispatchEvent(new CustomEvent('manifest:live-reload', { cancelable: true, detail: { files: [{ rel: 'index.html', hash: 'x' }] } }))
        window.removeEventListener('manifest:live-reload', cancel)
        net.baseDown = false
        const p = document.querySelector('.blue p')
        p.dispatchEvent(new Event('focus')); p.innerHTML = 'Blue page'; p.dispatchEvent(new Event('blur'))
        await new Promise(r => setTimeout(r, 0))
        const r = await Alpine.store('edit').publish()
        expect(r.results[0].status).toBe('error')
        expect(r.results[0].reason).toContain('reload to continue')
        expect(live.src()).toBe(swapped)
    })
})
