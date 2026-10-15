/**
 * @vitest-environment happy-dom
 *
 * x-edit regions authored in component files publish to those files: a route component
 * (the region is a component root), a region nested inside one, together with a region
 * in index.html, under the same base and fingerprint checks. A component used more
 * than once is not editable. Component markup is mounted as the components plugin
 * inserts it (roots carry _manifestComponent; the loader caches the file).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Alpine from 'alpinejs'
import { bootLivePage } from './helpers/edit-live-page.js'

const HOME = `<section x-edit="hero">\n  <h1>Hello</h1>\n  <p>World</p>\n</section>\n<div class="wrap">\n  <article x-edit="more"><p>Inner</p><p>Second</p></article>\n</div>\n`
const CARD = `<div class="card">\n  <section x-edit="cardbody"><p>Card</p></section>\n</div>\n`
const INDEX = `<section x-edit="shell"><h1>Shell</h1></section>\n<x-home></x-home>\n<x-card></x-card>\n<x-card></x-card>`
const DOM = `<section x-edit="shell"><h1>Shell</h1></section>\n${HOME}${CARD}${CARD}`

let live
beforeAll(async () => {
    live = await bootLivePage(INDEX, {}, {
        files: { 'components/home.html': HOME, 'components/card.html': CARD },
        dom: DOM,
        mounted: (root) => {
            window.ManifestComponentsLoader = { cache: { home: HOME, card: CARD } }
            const [, hero, wrap, card1, card2] = root.children
            hero._manifestComponent = 'home'; wrap._manifestComponent = 'home'
            card1._manifestComponent = 'card'; card2._manifestComponent = 'card'
        }
    })
}, 15000)
afterAll(() => live && live.stop())

const store = () => Alpine.store('edit')
const flush = () => new Promise(r => setTimeout(r, 0))
const editText = (el, value) => { el.dispatchEvent(new Event('focus')); el.innerHTML = value; el.dispatchEvent(new Event('blur')) }
const area = (k) => document.querySelector(`[x-edit="${k}"]`)

describe('regions authored in component files', () => {
    it('a route component region publishes to its component file; index.html is untouched', async () => {
        const index = live.src()
        editText(area('hero').querySelector('h1'), 'Hello page')
        await flush()
        const r = await store().publish()
        expect(r.results.map(x => x.status + (x.reason ? ': ' + x.reason : ''))).toEqual(['written'])
        expect(live.src('components/home.html')).toBe(HOME.replace('<h1>Hello</h1>', '<h1>Hello page</h1>'))
        expect(live.src()).toBe(index)
    })

    it('a second publish without a reload uses the component file\'s new fingerprints', async () => {
        editText(area('hero').querySelector('h1'), 'Hello again')
        await flush()
        const r = await store().publish()
        expect(r.results.map(x => x.status)).toEqual(['written'])
        expect(live.src('components/home.html')).toContain('<h1>Hello again</h1>')
    })

    it('index.html and a nested component region publish in one batch', async () => {
        editText(area('shell').querySelector('h1'), 'Shell page')
        const [inner, second] = area('more').querySelectorAll('p')
        store().move(second, area('more'), inner)
        await flush()
        const r = await store().publish()
        expect(r.results.map(x => x.status)).toEqual(['written', 'written'])
        expect(live.src()).toContain('<section x-edit="shell"><h1>Shell page</h1></section>')
        expect(live.src('components/home.html')).toContain('<article x-edit="more"><p>Second</p><p>Inner</p></article>')
    })

    it('a component file changed elsewhere refuses the whole batch, index.html included', async () => {
        const index = live.src(), changed = live.src('components/home.html').replace('<p>World</p>', '<p>World external</p>')
        live.write('components/home.html', changed)
        editText(area('shell').querySelector('h1'), 'Shell again')
        editText(area('more').querySelector('p'), 'Second page')
        await flush()
        const r = await store().publish()
        expect(r.results.every(x => x.status === 'error')).toBe(true)
        expect(r.stale).toEqual(['components/home.html'])
        expect(live.src()).toBe(index)
        expect(live.src('components/home.html')).toBe(changed)
    })

    it('rebase writes over it; fingerprints still guard the component file', async () => {
        const r = await store().publish({ rebase: true })
        expect(r.results.map(x => x.status)).toEqual(['written', 'written'])
        expect(live.src('components/home.html')).toContain('<p>World external</p>')
        expect(live.src('components/home.html')).toContain('<article x-edit="more"><p>Second page</p><p>Inner</p></article>')
    })

    it('a component used more than once is not editable, and nothing of it publishes', async () => {
        const [a, b] = document.querySelectorAll('[x-edit="cardbody"]')
        const p = a.querySelector('p')
        expect(store().can('text', p)).toBe(false)
        expect(store().can('move', p)).toBe(false)
        expect(p.getAttribute('contenteditable')).toBe(null)
        expect(b.querySelector('p').getAttribute('contenteditable')).toBe(null)
        expect(store().attr('title', 'x', p)).toBe(false)
    })

    it('a route component root keeps its attributes: they carry the placeholder\'s', async () => {
        expect(store().can('attrs', area('hero'))).toBe(false)
        expect(store().can('class', area('hero'))).toBe(false)
        expect(store().can('attrs', area('hero').querySelector('p'))).toBe(true)
    })
})
