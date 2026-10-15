/**
 * @vitest-environment happy-dom
 *
 * Cross-area move (x-edit.move): a piece lifted out of one static area and dropped
 * into another records ONE st-move delta naming it by identity, undoes in one step,
 * replays from the persisted log on reload, and publishes as each area's final tree.
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
async function regions(suffix, mods = '') {
    const root = mount(`
        <section x-edit.move${mods}="from-${suffix}"><p>Alpha</p><p>Beta</p></section>
        <section x-edit.move${mods}="to-${suffix}"><p>Gamma</p></section>`)
    await flush(); await flush()
    const [a, b] = root.querySelectorAll('section')
    return { root, a, b }
}

const texts = (el) => [...el.children].map(c => c.textContent)
const K = (region, key) => '@' + region + '@' + key
const LS = () => localStorage.getItem('mnfst-edit-log:' + location.pathname)
const treeOf = (region) => { const p = store().patches().find(x => x.kind === 'static-tree' && x.region === region); return p && p.tree }
const kidKeys = (node) => (node.children || []).map(c => c.key)
const findNode = (node, key) => { if (!node) return null; if (node.key === key) return node; for (const c of node.children || []) { const f = findNode(c, key); if (f) return f } return null }

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
        expect(d.key).toBe(K('from-m1', 'P:Alpha'))
        expect(d.fromOrder).toEqual([K('from-m1', 'P:Beta')])
        expect(d.toOrder).toEqual([K('to-m1', 'P:Gamma'), K('from-m1', 'P:Alpha')])
    })

    it('inserts before a reference sibling', async () => {
        const { a, b } = await regions('m2')
        store().move(a.querySelector('p'), b, b.querySelector('p'))
        expect(texts(b)).toEqual(['Alpha', 'Gamma'])
    })

    it('keeps its identity on arrival, even beside a same-content twin', async () => {
        const root = mount(`
            <section x-edit.move="from-k"><p>Same</p></section>
            <section x-edit.move="to-k"><p>Same</p></section>`)
        await flush(); await flush()
        const [a, b] = root.querySelectorAll('section')
        const moved = a.querySelector('p')
        store().move(moved, b)
        expect(store().export().log.at(-1).key).toBe(K('from-k', 'P:Same'))
        expect([...b.children].map(c => c.getAttribute('data-edit-key'))).toEqual([K('to-k', 'P:Same'), K('from-k', 'P:Same')])
    })

    it('refuses a move into a data region, a locked region, or its own subtree', async () => {
        const root = mount(`
            <section x-edit.move="from-r"><div><p>Block</p></div></section>
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
        expect(document.querySelector('[data-edit-dragging]')).toBeNull()
        expect(document.querySelector('[data-edit-drop-target]')).toBeNull()
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
        const first = await regions('r1', '.persist')
        store().move(first.a.querySelector('p'), first.b)
        expect(LS()).toContain('st-move')

        document.body.innerHTML = ''
        new Function(SRC)()                           // fresh closure = reload; log restores from localStorage
        await flush()                                 // init runs on its own setTimeout
        const fresh = await regions('r1', '.persist')
        await new Promise(r => setTimeout(r, 500))    // boot pass: armAll + restore
        expect(texts(fresh.a)).toEqual(['Beta'])
        expect(texts(fresh.b)).toEqual(['Gamma', 'Alpha'])
    })

    it('publishes both areas\' final trees, naming the piece by identity', async () => {
        const { a, b } = await regions('p1')
        store().move(a.querySelector('p'), b)
        expect(kidKeys(treeOf('from-p1'))).toEqual([K('from-p1', 'P:Beta')])
        expect(kidKeys(treeOf('to-p1'))).toEqual([K('to-p1', 'P:Gamma'), K('from-p1', 'P:Alpha')])
    })
})

// Regions with text caps, for edit-vs-move interplay.
async function textRegions(suffix) {
    const root = mount(`
        <section x-edit.move.text="from-${suffix}"><p>Alpha</p><p>Beta</p></section>
        <section x-edit.move.text="to-${suffix}"><p>Gamma</p></section>`)
    await flush(); await flush()
    const [a, b] = root.querySelectorAll('section')
    return { root, a, b }
}
const editText = (el, value) => {
    el.dispatchEvent(new Event('focus'))
    el.innerHTML = value
    el.dispatchEvent(new Event('blur'))
}

describe('x-edit move + text edits (stale-region regressions)', () => {
    it('a text edit AFTER a move commits against the destination region', async () => {
        const { a, b } = await textRegions('d1')
        const alpha = a.querySelector('p')
        store().move(alpha, b)
        editText(alpha, 'Edited')
        const { log, cursor } = store().export()
        const d = log[cursor - 1]
        expect(d).toMatchObject({ kind: 'st-node', region: 'to-d1', path: K('from-d1', 'P:Alpha'), prop: 'text', value: 'Edited' })
        expect(findNode(treeOf('to-d1'), K('from-d1', 'P:Alpha')).edits).toEqual({ text: 'Edited' })
        await store().undo()                              // the edit alone
        expect(alpha.innerHTML).toBe('Alpha')
        expect(alpha.parentElement).toBe(b)
    })

    it('a text edit BEFORE a move travels with the block to the destination patch', async () => {
        const { a, b } = await textRegions('d3')
        const alpha = a.querySelector('p')
        editText(alpha, 'Edited')
        store().move(alpha, b)
        const mv = store().export().log.at(-1)
        expect(mv.key).toBe(K('from-d3', 'P:Alpha'))
        expect(findNode(treeOf('to-d3'), K('from-d3', 'P:Alpha')).edits).toEqual({ text: 'Edited' })
        await store().undo()                              // the move
        expect(texts(a)).toEqual(['Edited', 'Beta'])
        await store().undo()                              // the edit
        expect(texts(a)).toEqual(['Alpha', 'Beta'])
    })

    it('a REAL pre-move reorder still publishes as an order patch (no suppression)', async () => {
        const root = mount(`
            <section x-edit.move="from-o1"><p>Card</p><p>Second</p><p>Third</p></section>
            <section x-edit.move="to-o1"><p>Dest</p></section>`)
        await flush(); await flush()
        const [a, b] = root.querySelectorAll('section')
        const third = a.children[2]
        const key = (k) => new KeyboardEvent('keydown', { key: k, bubbles: true })
        third.dispatchEvent(key(' '))                     // grab
        third.dispatchEvent(key('ArrowUp'))
        third.dispatchEvent(key('ArrowUp'))
        third.dispatchEvent(key('Enter'))                 // drop → st-order [Third, Card, Second]
        expect(texts(a)).toEqual(['Third', 'Card', 'Second'])
        store().move(a.children[1], b)                    // Card leaves; folded order === fromOrder
        expect(kidKeys(treeOf('from-o1'))).toEqual([K('from-o1', 'P:Third'), K('from-o1', 'P:Second')])
    })
})

describe('x-edit move identity across reloads', () => {
    const twinRegions = async (suffix) => {
        const root = mount(`
            <section x-edit.move.persist="from-${suffix}"><p data-m="arr">Same</p><p>Beta</p></section>
            <section x-edit.move.persist="to-${suffix}"><p data-m="nat">Same</p></section>`)
        await flush(); await flush()
        const [a, b] = root.querySelectorAll('section')
        return { root, a, b }
    }

    it('replays a move beside a twin with element identity preserved', async () => {
        const first = await twinRegions('t2')
        store().move(first.a.querySelector('[data-m="arr"]'), first.b, first.b.querySelector('[data-m="nat"]'))

        document.body.innerHTML = ''
        new Function(SRC)()
        await flush()
        const fresh = await twinRegions('t2')
        await new Promise(r => setTimeout(r, 500))
        const kids = [...fresh.b.children]
        expect(kids.map(c => c.getAttribute('data-m'))).toEqual(['arr', 'nat'])
        expect(kids.map(c => c.getAttribute('data-edit-key'))).toEqual([K('from-t2', 'P:Same'), K('to-t2', 'P:Same')])
    })
})

describe('x-edit nested areas', () => {
    it('refuses a cross-region $edit.move for a piece that is itself an x-edit area', async () => {
        const root = mount(`
            <section x-edit.move="outer-n1"><div x-edit.move="inner-n1"><p>One</p></div><p>Two</p></section>
            <section x-edit.move="dest-n1"><p>Three</p></section>`)
        await flush(); await flush()
        const [outer, dest] = root.querySelectorAll('section')
        const inner = outer.firstElementChild
        const before = store().export().log.length
        expect(store().can('move', inner)).toBe(true)      // it still moves within its own region
        expect(store().move(inner, dest)).toBe(false)
        expect(inner.parentElement).toBe(outer)
        expect(store().export().log.slice(before).some(d => d.kind === 'st-move')).toBe(false)
    })

    it('pointer-dragging a region-block never commits a cross-region move', async () => {
        const root = mount(`
            <section x-edit.move="outer-n2"><div x-edit.move="inner-n2"><p>One</p></div><p>Two</p></section>
            <section x-edit.move="dest-n2"><p>Three</p></section>`)
        await flush(); await flush()
        const [outer, dest] = root.querySelectorAll('section')
        const inner = outer.firstElementChild
        const before = store().export().log.length
        document.elementFromPoint = () => dest.querySelector('p')
        inner.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 41, clientY: 41 }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
        expect(inner.parentElement).toBe(outer)
        expect(store().export().log.slice(before).some(d => d.kind === 'st-move')).toBe(false)
    })

    it('a piece inside a nested area drags out to another region; the nested area stays', async () => {
        const root = mount(`
            <section x-edit.move="outer-n3"><div x-edit.move="inner-n3"><p>Inner</p></div><p>Top</p></section>
            <section x-edit.move="dest-n3"><p>Dest</p></section>`)
        await flush(); await flush()
        const [outer, dest] = root.querySelectorAll('section')
        const innerDiv = outer.firstElementChild
        const innerP = innerDiv.querySelector('p')
        document.elementFromPoint = () => dest.querySelector('p')
        innerP.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 41, clientY: 41 }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
        expect(innerDiv.parentElement).toBe(outer)
        expect(innerP.parentElement).toBe(dest)
        const d = store().export().log.at(-1)
        expect(d).toMatchObject({ kind: 'st-move', from: 'outer-n3', to: 'dest-n3', fromParent: innerDiv.getAttribute('data-edit-key'), toParent: '' })
        expect(document.querySelector('[data-edit-ghost]')).toBeNull()
        await store().undo()
        expect(innerDiv.querySelector('p').textContent).toBe('Inner')
        expect(outer.contains(innerDiv)).toBe(true)
        expect([...dest.children].map(c => c.textContent)).toEqual(['Dest'])
    })

    it('a nested area is a container of its region: move() nests into it and out of it', async () => {
        const root = mount(`
            <section x-edit.move="outer-m4"><div x-edit.move="inner-m4"><p>One</p></div><p>Top</p></section>
            <section x-edit.move="dest-m4"><p>Three</p></section>`)
        await flush(); await flush()
        const [outer, dest] = root.querySelectorAll('section')
        const inner = outer.firstElementChild
        const innerP = inner.querySelector('p')
        const top = outer.children[1]
        expect(store().move(top, inner)).toBe(true)
        expect(top.parentElement).toBe(inner)
        expect(store().export().log.at(-1)).toMatchObject({ kind: 'st-move', from: 'outer-m4', to: 'outer-m4', toParent: inner.getAttribute('data-edit-key'), fromParent: '' })
        expect(store().move(innerP, dest)).toBe(true)
        expect(innerP.parentElement).toBe(dest)
    })

    it('cancels a drop into a region locked mid-drag', async () => {
        const { a, b } = await regions('lk')
        const alpha = a.querySelector('p')
        const before = store().export().log.length
        document.elementFromPoint = () => b.querySelector('p')
        alpha.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 41, clientY: 41 }))
        store().lock(b)
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
        expect(alpha.parentElement).toBe(a)
        expect(store().export().log.slice(before).some(d => d.kind === 'st-move')).toBe(false)
    })
})

describe('x-edit publish trees address elements by identity', () => {
    it('a delete lists the removed element; a later edit names its target', async () => {
        const root = mount(`<section x-edit.move.text="del-e1"><p>Alpha</p><p>Beta</p></section>`)
        await flush(); await flush()
        const [alpha, beta] = root.querySelectorAll('p')
        expect(store().remove(alpha)).toBe(true)
        editText(beta, 'Edited')
        const p = store().patches().find(x => x.kind === 'static-tree' && x.region === 'del-e1')
        expect(p.removed).toEqual([K('del-e1', 'P:Alpha')])
        expect(p.tree.children).toEqual([{ key: K('del-e1', 'P:Beta'), at: '1', edits: { text: 'Edited' } }])
    })

    it('cut-then-edit too', async () => {
        const root = mount(`<section x-edit.move.text="cut-e1"><p>Alpha</p><p>Beta</p></section>`)
        await flush(); await flush()
        const [alpha, beta] = root.querySelectorAll('p')
        expect(store().cut(alpha)).toBe(true)
        editText(beta, 'Edited')
        const p = store().patches().find(x => x.kind === 'static-tree' && x.region === 'cut-e1')
        expect(p.removed).toEqual([K('cut-e1', 'P:Alpha')])
        expect(findNode(p.tree, K('cut-e1', 'P:Beta')).edits).toEqual({ text: 'Edited' })
    })

    it('edit-then-reorder: the final order and the edit on the same node', async () => {
        const root = mount(`<section x-edit.move.text="ord-e1"><p>Alpha</p><p>Beta</p></section>`)
        await flush(); await flush()
        const alpha = root.querySelector('p')
        editText(alpha, 'Edited')
        alpha.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
        const t = treeOf('ord-e1')
        expect(kidKeys(t)).toEqual([K('ord-e1', 'P:Beta'), K('ord-e1', 'P:Alpha')])
        expect(t.children[1].edits).toEqual({ text: 'Edited' })
    })
})

describe('x-edit plugin-node indexing (handles/ghosts never count)', () => {
    it('undo of a reorder keeps real children ahead of injected size handles; trees skip them', async () => {
        const root = mount(`<section x-edit.move.text.size="sz1"><p>One</p><p>Two</p></section>`)
        await flush(); await flush()
        const area = root.querySelector('section')
        expect([...area.children].filter(c => c.hasAttribute('data-edit-handle')).length).toBeGreaterThan(0)
        const two = [...area.querySelectorAll('p')].find(p => p.textContent === 'Two')
        two.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
        expect([...area.children].filter(c => c.tagName === 'P').map(c => c.textContent)).toEqual(['Two', 'One'])
        await store().undo()
        expect(area.firstElementChild.tagName).toBe('P')
        expect([...area.children].filter(c => c.tagName === 'P').map(c => c.textContent)).toEqual(['One', 'Two'])
        editText(area.querySelector('p'), 'Edited')
        expect(kidKeys(treeOf('sz1'))).toEqual([K('sz1', 'P:One'), K('sz1', 'P:Two')])
        expect(findNode(treeOf('sz1'), K('sz1', 'P:One')).edits).toEqual({ text: 'Edited' })
    })
})

describe('x-edit copy/cut of a region element', () => {
    it('returns false instead of throwing (a region is a container, not a block)', async () => {
        const root = mount(`<section x-edit.move="solo-c1"><p>Only</p></section>`)
        await flush(); await flush()
        const area = root.querySelector('section')
        expect(store().copy(area)).toBe(false)
        expect(store().cut(area)).toBe(false)
        expect(area.querySelector('p')).toBeTruthy()      // cut must not have removed anything
        expect(store().copy(area.querySelector('p'))).toBe(true)   // a real block still copies
    })
})
