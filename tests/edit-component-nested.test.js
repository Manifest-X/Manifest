/**
 * @vitest-environment happy-dom
 *
 * Component regions inside other regions: a component's own x-edit is an area of its
 * own, publishing to its file; in the region around it, the component is one opaque
 * element, its <x-name> host, as the writer sees the source. A region the writer
 * cannot resolve does not hold the others back. A route component (data-component)
 * with its own region is edited there, not through instance overrides.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Alpine from 'alpinejs'
import { bootLivePage } from './helpers/edit-live-page.js'

const HERO = `<section x-edit="hero"><h2>Hero title</h2><x-card></x-card></section>\n`
const CARD = `<div x-edit="card"><p>Card text</p></div>\n`
const PROMO = `<div class="promo"><p x-edit="promo">Promo text</p></div>\n`
const INDEX = `<section x-edit="shell"><h1>Shell</h1></section>\n<x-hero></x-hero>\n<section x-edit="page"><h1>Page</h1><x-promo x-route="/"></x-promo></section>`
const DOM = `<section x-edit="shell"><h1>Shell</h1></section>\n<section x-edit="hero"><h2>Hero title</h2><div x-edit="card"><p>Card text</p></div></section>\n`
    + `<section x-edit="page"><h1>Page</h1><div class="promo" data-component="promo-1"><p x-edit="promo">Promo text</p></div></section>`

let live
beforeAll(async () => {
    live = await bootLivePage(INDEX, {}, {
        files: { 'components/hero.html': HERO, 'components/card.html': CARD, 'components/promo.html': PROMO },
        dom: DOM,
        mounted: (root) => {
            window.ManifestComponentsLoader = { cache: { hero: HERO, card: CARD, promo: PROMO } }
            const mark = (el, name) => { el._manifestComponent = name; el._manifestHost = {} }
            mark(root.querySelector('[x-edit="hero"]'), 'hero')
            mark(root.querySelector('[x-edit="card"]'), 'card')
            mark(root.querySelector('.promo'), 'promo')
        }
    })
}, 15000)
afterAll(() => live && live.stop())

const store = () => Alpine.store('edit')
const flush = () => new Promise(r => setTimeout(r, 0))
const editText = (el, value) => { el.dispatchEvent(new Event('focus')); el.innerHTML = value; el.dispatchEvent(new Event('blur')) }
const area = (k) => document.querySelector(`[x-edit="${k}"]`)
const statuses = (r) => r.results.map(x => x.region + ':' + x.status)

describe('a component region inside another component\'s region', () => {
    it('publishes to its own file', async () => {
        editText(area('card').querySelector('p'), 'Card page')
        await flush()
        const r = await store().publish()
        expect(statuses(r)).toEqual(['card:written'])
        expect(live.src('components/card.html')).toBe(CARD.replace('Card text', 'Card page'))
        expect(live.src('components/hero.html')).toBe(HERO)
    })

    it('in the outer region the component is its host: text and a move around it publish to the outer file', async () => {
        const h2 = area('hero').querySelector('h2')
        editText(h2, 'Hero page')
        store().move(h2, area('hero'), null)
        await flush()
        expect([...area('hero').children].map(c => c.tagName)).toEqual(['DIV', 'H2'])
        const r = await store().publish()
        expect(statuses(r)).toEqual(['hero:written'])
        expect(live.src('components/hero.html')).toBe(`<section x-edit="hero"><x-card></x-card><h2>Hero page</h2></section>\n`)
        expect(live.src('components/card.html')).toBe(CARD.replace('Card text', 'Card page'))
        // and again, without a reload
        editText(area('card').querySelector('p'), 'Card again')
        await flush()
        expect(statuses(await store().publish())).toEqual(['card:written'])
    })
})

describe('a region the writer cannot resolve', () => {
    it('is refused by name; the other regions publish; its edits stay', async () => {
        editText(area('shell').querySelector('h1'), 'Shell page')
        editText(area('card').querySelector('p'), 'Card third')
        await flush()
        live.setSrc(live.src().replace('<h1>Shell</h1>', '<h1>Shell external</h1>'))   // its element changed elsewhere
        const r = await store().publish({ rebase: true })
        expect(statuses(r)).toEqual(['shell:error', 'card:written'])
        expect(r.results[0].reason).toContain('H1:Shell')
        expect(live.src('components/card.html')).toContain('Card third')
        expect(live.src()).toContain('<h1>Shell external</h1>')
        expect(store().export().log.map(d => d.region)).toEqual(['shell'])
        // Published again: still refused, nothing else pending
        const again = await store().publish({ rebase: true })
        expect(statuses(again)).toEqual(['shell:error'])
        await store().undo()
    })
})

describe('a route component with its own region inside an index.html region', () => {
    it('is edited in its region and file, not by instance override', async () => {
        expect(store().can('text', area('promo'))).toBe(true)
        editText(area('promo'), 'Promo page')
        editText(area('page').querySelector('h1'), 'Page edited')
        await flush()
        expect(store().export().log.map(d => d.kind)).toEqual(['st-node', 'st-node'])
        const r = await store().publish({ rebase: true })
        expect(statuses(r).sort()).toEqual(['page:written', 'promo:written'])
        expect(live.src('components/promo.html')).toBe(PROMO.replace('Promo text', 'Promo page'))
        expect(live.src()).toContain('<section x-edit="page"><h1>Page edited</h1><x-promo x-route="/"></x-promo></section>')
        expect(live.src()).not.toContain('$modify')
    })
})
