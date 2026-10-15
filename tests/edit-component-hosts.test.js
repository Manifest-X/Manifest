/**
 * @vitest-environment happy-dom
 *
 * A component host (<x-name> in the source; its rendered roots on the page) is a piece of
 * the area around it: it moves (pointer API, keyboard, nest/un-nest), duplicates and goes
 * as one group, undo/redo included, between areas of one file or of two; the writer moves
 * the host markup, attributes and props included.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Alpine from 'alpinejs'
import { bootLivePage } from './helpers/edit-live-page.js'

const CARD = `<div class="card"><h3>Card</h3></div>\n<p class="note">Note</p>\n`
const PROMO = `<div x-edit="promo"><p>Promo</p></div>\n`
const HERO = `<section x-edit="hero"><h2>Hero</h2></section>\n`
const PAGE = `<section x-edit="page">
  <h1>Title</h1>
  <x-card variant="a"></x-card>
  <p>Intro</p>
  <div class="box"><p>In box</p></div>
  <x-promo></x-promo>
</section>
<x-hero></x-hero>`
const DOM = `<section x-edit="page"><h1>Title</h1><div class="card" data-component="card-1"><h3>Card</h3></div><p class="note" data-component="card-1">Note</p><p>Intro</p><div class="box"><p>In box</p></div><div x-edit="promo"><p>Promo</p></div></section>`
    + `<section x-edit="hero"><h2>Hero</h2></section>`

let live
const page = (body) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`
beforeAll(async () => {
    live = await bootLivePage(PAGE, {}, {
        files: { 'components/card.html': CARD, 'components/promo.html': PROMO, 'components/hero.html': HERO },
        dom: DOM,
        mounted: (root) => {
            window.ManifestComponentsLoader = { cache: { card: CARD, promo: PROMO, hero: HERO } }
            const mark = (name, ...roots) => { const host = { roots }; roots.forEach(r => { r._manifestComponent = name; r._manifestHost = host }) }
            mark('card', root.querySelector('.card'), root.querySelector('.note'))
            mark('promo', root.querySelector('[x-edit="promo"]'))
            mark('hero', root.querySelector('[x-edit="hero"]'))
        }
    })
}, 15000)
afterAll(() => live && live.stop())

const store = () => Alpine.store('edit')
const flush = () => new Promise(r => setTimeout(r, 0))
const sec = (k) => document.querySelector(`[x-edit="${k}"]`)
const order = (k) => [...sec(k).children].filter(c => !c.hasAttribute('data-edit-handle')).map(c => c.className || c.getAttribute('x-edit') || c.textContent)
const card = () => document.querySelector('.card')
const pageSrc = () => { const s = live.src(); return s.slice(s.indexOf('<section'), s.indexOf('</section>') + 10).replace(/\n\s*/g, '') }
const statuses = (r) => r.results.map(x => x.region + ':' + x.status + (x.reason ? ': ' + x.reason : ''))
const altKey = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true }))

describe('a component host is a piece', () => {
    it('is the piece for anything inside it; it moves, duplicates and goes, but is not copied', () => {
        expect(store().block(card().querySelector('h3'))).toBe(card())
        expect(store().block(document.querySelector('.note'))).toBe(card())
        expect(store().can('move', card())).toBe(true)
        expect(store().can('duplicate', card())).toBe(true)
        expect(store().can('remove', card())).toBe(true)
        expect(store().can('copy', card())).toBe(false)
        expect(store().can('move', sec('promo'))).toBe(true)          // a host whose markup is a region of its own
        expect(store().can('text', sec('promo').querySelector('p'))).toBe(true)
        expect(card().hasAttribute('data-edit-piece')).toBe(true)
        expect(card().querySelector('h3').hasAttribute('data-edit-piece')).toBe(false)
    })

    it('moves as one group, with undo and redo; the writer moves the host and its props', async () => {
        store().move(card(), sec('page'), document.querySelector('.box'))
        await flush()
        expect(order('page')).toEqual(['Title', 'Intro', 'card', 'note', 'box', 'promo'])
        await store().undo()
        expect(order('page')).toEqual(['Title', 'card', 'note', 'Intro', 'box', 'promo'])
        await store().redo()
        expect(order('page')).toEqual(['Title', 'Intro', 'card', 'note', 'box', 'promo'])
        const r = await store().publish()
        expect(statuses(r)).toEqual(['page:written'])
        expect(pageSrc()).toBe('<section x-edit="page"><h1>Title</h1><p>Intro</p><x-card variant="a"></x-card><div class="box"><p>In box</p></div><x-promo></x-promo></section>')
    })

    it('Alt+arrows step it; Alt+Right nests it into a container, Alt+Left takes it out', async () => {
        altKey(card(), 'ArrowUp')
        expect(order('page')).toEqual(['Title', 'card', 'note', 'Intro', 'box', 'promo'])
        altKey(card(), 'ArrowDown'); altKey(card(), 'ArrowDown')
        expect(order('page')).toEqual(['Title', 'Intro', 'box', 'card', 'note', 'promo'])
        altKey(card(), 'ArrowRight')                                   // into the box before it
        expect(card().parentElement.className).toBe('box')
        expect(card().nextElementSibling.className).toBe('note')
        const r = await store().publish()
        expect(statuses(r)).toEqual(['page:written'])
        expect(pageSrc()).toBe('<section x-edit="page"><h1>Title</h1><p>Intro</p><div class="box"><p>In box</p><x-card variant="a"></x-card></div><x-promo></x-promo></section>')
        altKey(card(), 'ArrowLeft')
        expect(order('page')).toEqual(['Title', 'Intro', 'box', 'card', 'note', 'promo'])
        await store().undo()
        expect(card().parentElement.className).toBe('box')
    })
})

describe('the writer', () => {
    it('duplicate: a second host with the same props; remove: the host goes', async () => {
        expect(store().duplicate(card())).toBe(true)
        await flush()
        const box = () => [...document.querySelector('.box').children].map(c => c.className || c.textContent)
        expect(box()).toEqual(['In box', 'card', 'note', 'card', 'note'])
        const r = await store().publish()
        expect(statuses(r)).toEqual(['page:written'])
        expect(pageSrc()).toContain('<div class="box"><p>In box</p><x-card variant="a"></x-card><x-card variant="a"></x-card></div>')
        expect(store().remove(document.querySelectorAll('.card')[1])).toBe(true)
        await flush()
        expect(box()).toEqual(['In box', 'card', 'note'])
        await store().undo()
        expect(box()).toEqual(['In box', 'card', 'note', 'card', 'note'])
        await store().redo()
        const r2 = await store().publish()
        expect(statuses(r2)).toEqual(['page:written'])
        expect(pageSrc()).toContain('<div class="box"><p>In box</p><x-card variant="a"></x-card></div>')
    })

    it('moves a host between areas of different files, all or nothing', async () => {
        expect(store().move(card(), sec('hero'), null)).toBe(true)
        await flush()
        expect([...sec('hero').children].map(c => c.className || c.tagName)).toEqual(['H2', 'card', 'note'])
        // the target file changed elsewhere: nothing is written in either
        live.write('components/hero.html', HERO.replace('Hero', 'Hero external'))
        const refused = await store().publish()
        expect(refused.results.every(x => x.status === 'error')).toBe(true)
        expect(live.src()).toContain('<x-card variant="a"></x-card>')
        live.write('components/hero.html', HERO)
        const r = await store().publish()
        expect(statuses(r).sort()).toEqual(['hero:written', 'page:written'])
        expect(live.src('components/hero.html')).toBe('<section x-edit="hero"><h2>Hero</h2><x-card variant="a"></x-card></section>\n')
        expect(live.src()).not.toContain('<x-card')
    })
})
