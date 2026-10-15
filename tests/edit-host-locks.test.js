/**
 * @vitest-environment happy-dom
 *
 * Runtime locks on a component host: keyed by its host key, covering all its roots and
 * what is in them; they survive a publish and, in a .persist area, a reload.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'

const flush = () => new Promise(r => setTimeout(r, 0))
const BODY = `<section x-edit.persist="lk"><h1>Title</h1><div class="card"><h3>Card</h3></div><p class="note">Note</p><p>Intro</p></section>`
// The page as the components plugin leaves it: the card's two roots, one instance
function hostMarks(root) {
    const roots = [root.querySelector('.card'), root.querySelector('.note')], host = { roots }
    roots.forEach(r => { r._manifestComponent = 'card'; r._manifestHost = host })
}
async function mount() {
    const root = document.createElement('div')
    root.innerHTML = BODY
    hostMarks(root)
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    await flush(); await flush()
    return root
}
const store = () => Alpine.store('edit')

beforeAll(async () => {
    new Function(EDIT_SRC)()
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))
})

describe('locks on a component host', () => {
    it('lock and unlock by the host, or any of its roots; can() follows; keyed by the host key', async () => {
        const root = await mount()
        const card = root.querySelector('.card'), note = root.querySelector('.note')
        expect(card.getAttribute('data-edit-host')).toBe('@lk@X-CARD:')
        expect(store().can('move', card)).toBe(true)
        expect(store().lock(card, 'move')).toBe(true)
        expect(store().export().log.at(-1)).toMatchObject({ kind: 'lock', region: 'lk', key: '@lk@X-CARD:', actions: ['move'], value: true })
        expect(store().can('move', card)).toBe(false)
        expect(store().can('move', note)).toBe(false)                    // the whole group
        expect(store().can('move', card.querySelector('h3'))).toBe(false)
        expect(store().move(card, root.querySelector('section'), null)).toBe(false)
        expect(store().can('duplicate', card)).toBe(true)
        expect(store().lock(note, 'remove')).toBe(true)                 // through another root
        expect(store().can('remove', card)).toBe(false)
        expect(store().remove(card)).toBe(false)
        expect(store().unlock(card, 'move')).toBe(true)
        expect(store().can('move', card)).toBe(true)
        expect(store().can('remove', card)).toBe(false)
    })

    it('survive a publish, on the same host', async () => {
        store().onPublish = () => ({ results: [{ region: 'lk', status: 'written' }] })
        const h1 = document.querySelector('h1')
        h1.dispatchEvent(new Event('focus')); h1.innerHTML = 'Title page'; h1.dispatchEvent(new Event('blur'))
        await store().publish()
        const log = store().export().log
        expect(log.every(d => d.kind === 'lock')).toBe(true)
        expect(new Set(log.map(d => d.key))).toEqual(new Set(['@lk@X-CARD:']))
        expect(store().can('remove', document.querySelector('.card'))).toBe(false)
        expect(store().can('move', document.querySelector('.card'))).toBe(true)
    })

    it('survive a reload in a .persist area', async () => {
        document.body.innerHTML = ''
        new Function(EDIT_SRC)()                                        // the page loads again
        await flush()
        const root = await mount()
        await new Promise(r => setTimeout(r, 600))
        const card = root.querySelector('.card')
        expect(store().can('remove', card)).toBe(false)
        expect(store().can('remove', root.querySelector('.note'))).toBe(false)
        expect(store().can('move', card)).toBe(true)
    })
})

describe('a component never goes inside markup that includes it', () => {
    it('however deep: a host whose markup includes card cannot go into card\'s region', async () => {
        const root = document.createElement('div')
        root.innerHTML = `<section x-edit="cy"><div class="hero"><div class="mid"><div class="card"><p>C</p></div></div></div></section><div class="cardroot"><section x-edit="cardr"><p>In card</p></section></div>`
        const mark = (el, name) => { el._manifestComponent = name; el._manifestHost = { roots: [el] } }
        mark(root.querySelector('.hero'), 'hero'); mark(root.querySelector('.mid'), 'mid'); mark(root.querySelector('.card'), 'card')
        mark(root.querySelector('.cardroot'), 'card')
        window.ManifestComponentsLoader = { cache: { card: '<div class="cardroot"><section x-edit="cardr"><p>In card</p></section></div>' } }
        Alpine.mutateDom(() => document.body.appendChild(root))
        Alpine.initTree(root)
        await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0))
        const hero = root.querySelector('.hero')
        expect(store().can('move', hero)).toBe(true)
        expect(store().move(hero, 'cardr', null)).toBe(false)
        expect(hero.parentElement.getAttribute('x-edit')).toBe('cy')
    })
})
