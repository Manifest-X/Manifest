/**
 * @vitest-environment happy-dom
 *
 * An x-edit inside content a plugin renders is not a region (nothing there is source).
 * Regions a move ties to a failed region are held back with it, each named, saying why.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Alpine from 'alpinejs'
import { bootLivePage } from './helpers/edit-live-page.js'

const BODY = `<section x-edit="rx" x-data="{ h: '<div x-edit=&quot;inner&quot;><p>Rendered</p></div>' }"><div x-html="h"></div><p>Own</p></section>
<section x-edit="tx"><p>Mover</p><p>Stay</p></section>
<section x-edit="ty"><p>Y one</p></section>
<section x-edit="tz"><p>Zed</p></section>`

let live, warn
const said = []
beforeAll(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { said.push(String(a[0])) })
    live = await bootLivePage(BODY, {})
}, 15000)
afterAll(() => { warn.mockRestore(); live && live.stop() })

const store = () => Alpine.store('edit')
const flush = () => new Promise(r => setTimeout(r, 0))
const sec = (k) => document.querySelector(`[x-edit="${k}"]`)

describe('an x-edit inside plugin-rendered content', () => {
    it('is not a region: not armed, can() false, warned once', async () => {
        const inner = sec('inner'), p = inner.querySelector('p')
        expect(p.textContent).toBe('Rendered')
        expect(inner.hasAttribute('data-edit-area')).toBe(false)
        expect(p.getAttribute('contenteditable')).toBe(null)
        for (const action of ['text', 'move', 'remove', 'duplicate', 'attrs']) {
            expect(store().can(action, p), action).toBe(false)
            expect(store().can(action, inner), action).toBe(false)
        }
        expect(store().move(inner, sec('rx'), null)).toBe(false)
        expect(said.filter(s => /x-edit="inner" is inside content a plugin renders \(x-html\)/.test(s)).length).toBe(1)
        expect(store().can('text', sec('rx').querySelector(':scope > p'))).toBe(true)
        expect(store().can('move', sec('rx').querySelector('[x-html]'))).toBe(true)
    })
})

describe('regions a move ties to a failed region', () => {
    it('are held back with it, each named, saying why; the rest publish', async () => {
        const [mover] = sec('tx').querySelectorAll('p')
        store().move(mover, sec('ty'), null)
        const z = sec('tz').querySelector('p')
        z.dispatchEvent(new Event('focus')); z.innerHTML = 'Zed page'; z.dispatchEvent(new Event('blur'))
        await flush()
        live.setSrc(live.src().replace('<p>Y one</p>', '<p>Y one</p><p>Y external</p>'))   // ty changed elsewhere
        const r = await store().publish({ rebase: true })
        const by = Object.fromEntries(r.results.map(x => [x.region, x]))
        expect(by.tz.status).toBe('written')
        expect(by.ty.status).toBe('error')
        expect(by.ty.reason).toContain('changed since this page loaded')
        expect(by.tx.status).toBe('error')
        expect(by.tx.reason).toBe('not published: tied by a move to x-edit="ty", which failed')
        expect(live.src()).toContain('<section x-edit="tz"><p>Zed page</p></section>')
        expect(live.src()).toContain('<section x-edit="tx"><p>Mover</p><p>Stay</p></section>')
        expect(store().export().log.filter(d => d.kind === 'st-move')).toHaveLength(1)
    })
})
