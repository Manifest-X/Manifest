/**
 * @vitest-environment happy-dom
 *
 * Cross-region drag (x-edit.sort): a block lifted out of one static region and dropped
 * into another records ONE st-move delta, undoes in one step, replays from the
 * persisted log on reload, and projects a static-move source patch for publish.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.edit.js'), 'utf8')

const flush = () => new Promise(r => setTimeout(r, 0))

beforeAll(async () => {
    new Function(SRC)()          // registers on alpine:init; window.Alpine is set after, so init runs once
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))   // let the 450ms boot pass run
})

const store = () => Alpine.store('edit')

function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    return root
}

// Two sibling static regions, sort-only (no contenteditable in the way of pointerdown).
async function regions(suffix) {
    const root = mount(`
        <section x-edit.authoring.sort="from-${suffix}"><p>Alpha</p><p>Beta</p></section>
        <section x-edit.authoring.sort="to-${suffix}"><p>Gamma</p></section>`)
    await flush(); await flush()
    const [a, b] = root.querySelectorAll('section')
    return { root, a, b }
}

const texts = (el) => [...el.children].map(c => c.textContent)

afterEach(() => {
    store().off()
    document.body.innerHTML = ''
    localStorage.clear()
    delete document.elementFromPoint
})

describe('x-edit cross-region move', () => {
    it('moves a block into another region and records one st-move delta', async () => {
        const { a, b } = await regions('m1')
        const alpha = a.querySelector('p')
        const before = store().export().cursor
        expect(store().move(alpha, b)).toBe(true)
        expect(alpha.parentElement).toBe(b)
        expect(texts(b)).toEqual(['Gamma', 'Alpha'])
        const { log, cursor } = store().export()
        expect(cursor - before).toBe(1)
        const d = log[cursor - 1]
        expect(d.kind).toBe('st-move')
        expect(d.from).toBe('from-m1')
        expect(d.to).toBe('to-m1')
        expect(d.key).toBe('P:Alpha')
        expect(d.toKey).toBe('P:Alpha')
        expect(d.fromOrder).toEqual(['P:Beta'])
        expect(d.toOrder).toEqual(['P:Gamma', 'P:Alpha'])
    })

    it('inserts before a reference sibling', async () => {
        const { a, b } = await regions('m2')
        store().move(a.querySelector('p'), b, b.querySelector('p'))
        expect(texts(b)).toEqual(['Alpha', 'Gamma'])
    })

    it('re-keys on arrival when the destination already holds the key', async () => {
        const root = mount(`
            <section x-edit.authoring.sort="from-k"><p>Same</p></section>
            <section x-edit.authoring.sort="to-k"><p>Same</p></section>`)
        await flush(); await flush()
        const [a, b] = root.querySelectorAll('section')
        store().move(a.querySelector('p'), b)
        const d = store().export().log.at(store().export().cursor - 1)
        expect(d.key).toBe('P:Same')
        expect(d.toKey).toBe('P:Same#2')
        expect(b.lastElementChild.getAttribute('data-edit-key')).toBe('P:Same#2')
    })

    it('refuses a move into a data region, a locked region, or its own subtree', async () => {
        const root = mount(`
            <section x-edit.authoring.sort="from-r"><div><p>Block</p></div></section>
            <section x-edit="data-r"><template x-for="i in [1]"><p x-text="i"></p></template></section>
            <section x-edit.lock="lock-r"><p>Locked</p></section>`)
        await flush(); await flush()
        const [a, dataR, lockR] = root.querySelectorAll('section')
        const block = a.firstElementChild
        expect(store().move(block, dataR)).toBe(false)
        expect(store().move(block, lockR)).toBe(false)
        expect(store().move(block, block)).toBe(false)
        expect(block.parentElement).toBe(a)
    })

    it('pointer drag drops into the hovered region and commits the move', async () => {
        const { a, b } = await regions('drag')
        const alpha = a.querySelector('p')
        const gamma = b.querySelector('p')
        document.elementFromPoint = () => gamma   // happy-dom has no hit-testing
        alpha.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 41, clientY: 41 }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
        expect(alpha.parentElement).toBe(b)
        expect(a.hasAttribute('data-edit-dragging-in')).toBe(false)
        expect(b.hasAttribute('data-edit-dragging-in')).toBe(false)
        const { log, cursor } = store().export()
        expect(log[cursor - 1].kind).toBe('st-move')
        expect(log[cursor - 1].from).toBe('from-drag')
        expect(log[cursor - 1].to).toBe('to-drag')
    })

    it('one undo returns the block to its source region; redo re-applies', async () => {
        const { a, b } = await regions('u1')
        store().move(a.querySelector('p'), b)
        await store().undo()
        expect(texts(a)).toEqual(['Alpha', 'Beta'])
        expect(texts(b)).toEqual(['Gamma'])
        await store().redo()
        expect(texts(a)).toEqual(['Beta'])
        expect(texts(b)).toEqual(['Gamma', 'Alpha'])
    })

    it('replays a persisted move on reload', async () => {
        const first = await regions('r1')
        store().move(first.a.querySelector('p'), first.b)
        expect(localStorage.getItem('mnfst-edit-log')).toContain('st-move')

        document.body.innerHTML = ''
        new Function(SRC)()                           // fresh closure = reload; log restores from localStorage
        await flush()                                 // init runs on its own setTimeout
        const fresh = await regions('r1')
        await new Promise(r => setTimeout(r, 500))    // boot pass: armAll + restore
        expect(texts(fresh.a)).toEqual(['Beta'])
        expect(texts(fresh.b)).toEqual(['Gamma', 'Alpha'])
    })

    it('projects a static-move source patch, without a duplicate order patch', async () => {
        const { a, b } = await regions('p1')
        store().move(a.querySelector('p'), b)
        const patches = store().patches()
        const mv = patches.find(p => p.kind === 'static-move')
        expect(mv).toMatchObject({ from: 'from-p1', to: 'to-p1', key: 'P:Alpha', toKey: 'P:Alpha', toOrder: ['P:Gamma', 'P:Alpha'] })
        expect(patches.filter(p => p.kind === 'static' && (p.region === 'from-p1' || p.region === 'to-p1'))).toEqual([])
    })
})
