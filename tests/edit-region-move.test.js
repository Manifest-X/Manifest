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

    it('projects a static-move source patch plus both regions\' folded orders', async () => {
        const { a, b } = await regions('p1')
        store().move(a.querySelector('p'), b)
        const patches = store().patches()
        const mv = patches.find(p => p.kind === 'static-move')
        expect(mv).toMatchObject({ from: 'from-p1', to: 'to-p1', key: 'P:Alpha', toKey: 'P:Alpha', toOrder: ['P:Gamma', 'P:Alpha'] })
        // Orders always travel (pre-move reorders are not in the move splice); the
        // server skips a reorder that is already true of the file.
        expect(patches.find(p => p.kind === 'static' && p.region === 'from-p1')).toMatchObject({ edits: [], order: ['P:Beta'] })
        expect(patches.find(p => p.kind === 'static' && p.region === 'to-p1')).toMatchObject({ edits: [], order: ['P:Gamma', 'P:Alpha'] })
    })
})

// Regions with text caps, for edit-vs-move interplay.
async function textRegions(suffix) {
    const root = mount(`
        <section x-edit.authoring.sort.text="from-${suffix}"><p>Alpha</p><p>Beta</p></section>
        <section x-edit.authoring.sort.text="to-${suffix}"><p>Gamma</p></section>`)
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
        expect(d).toMatchObject({ kind: 'st-node', region: 'to-d1', path: 'P:Alpha', prop: 'text', value: 'Edited' })
        const st = store().patches().find(p => p.kind === 'static' && p.region === 'to-d1')
        expect(st.edits).toContainEqual(expect.objectContaining({ key: 'P:Alpha', prop: 'text', value: 'Edited' }))
        await store().undo()                              // the edit alone
        expect(alpha.innerHTML).toBe('Alpha')
        expect(alpha.parentElement).toBe(b)
    })

    it('a text edit BEFORE a move travels with the block to the destination patch', async () => {
        const { a, b } = await textRegions('d3')
        const alpha = a.querySelector('p')
        editText(alpha, 'Edited')
        store().move(alpha, b)
        const { log, cursor } = store().export()
        const mv = log[cursor - 1]
        expect(mv.key).toBe('P:Alpha')
        expect(mv.toKey).toBe('P:Edited')                 // re-derived from current content: what a fresh session sees
        expect(mv.remap).toContainEqual(['from-d3', 'P:Alpha', 'to-d3', 'P:Edited'])
        const patches = store().patches()
        const st = patches.find(p => p.kind === 'static' && p.region === 'to-d3')
        expect(st).toBeTruthy()
        expect(st.edits).toContainEqual(expect.objectContaining({ key: 'P:Edited', prop: 'text', value: 'Edited', path: '1' }))
        await store().undo()                              // the move
        expect(texts(a)).toEqual(['Edited', 'Beta'])
        await store().undo()                              // the edit
        expect(texts(a)).toEqual(['Alpha', 'Beta'])
    })

    it('a REAL pre-move reorder still publishes as an order patch (no suppression)', async () => {
        const root = mount(`
            <section x-edit.authoring.sort="from-o1"><p>Card</p><p>Second</p><p>Third</p></section>
            <section x-edit.authoring.sort="to-o1"><p>Dest</p></section>`)
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
        const st = store().patches().find(p => p.kind === 'static' && p.region === 'from-o1')
        expect(st).toBeTruthy()
        expect(st.order).toEqual(['P:Third', 'P:Second'])
    })
})

describe('x-edit move key-collision mirroring', () => {
    const twinRegions = async (suffix, toHtml) => {
        const root = mount(`
            <section x-edit.authoring.sort="from-${suffix}"><p data-m="arr">Same</p><p>Beta</p></section>
            <section x-edit.authoring.sort="to-${suffix}">${toHtml || '<p data-m="nat">Same</p>'}</section>`)
        await flush(); await flush()
        const [a, b] = root.querySelectorAll('section')
        return { root, a, b }
    }

    it('re-keys POSITIONALLY on arrival: a twin dropped first takes the base key', async () => {
        const { a, b } = await twinRegions('t1')
        const arr = a.querySelector('[data-m="arr"]'), nat = b.querySelector('[data-m="nat"]')
        store().move(arr, b, nat)                         // arrival lands BEFORE its same-key twin
        expect(arr.getAttribute('data-edit-key')).toBe('P:Same')
        expect(nat.getAttribute('data-edit-key')).toBe('P:Same#2')
        const d = store().export().log.at(store().export().cursor - 1)
        expect(d.toKey).toBe('P:Same')
        expect(d.toOrder).toEqual(['P:Same', 'P:Same#2'])
        expect(d.remap).toContainEqual(['to-t1', 'P:Same', 'to-t1', 'P:Same#2'])   // the shifted twin travels on the delta
    })

    it('replays a collision move with element identity preserved (unsaved source)', async () => {
        const first = await twinRegions('t2')
        store().move(first.a.querySelector('[data-m="arr"]'), first.b, first.b.querySelector('[data-m="nat"]'))

        document.body.innerHTML = ''
        new Function(SRC)()
        await flush()
        const fresh = await twinRegions('t2')
        await new Promise(r => setTimeout(r, 500))
        const kids = [...fresh.b.children]
        expect(kids.map(c => c.getAttribute('data-m'))).toEqual(['arr', 'nat'])
        expect(kids.map(c => c.getAttribute('data-edit-key'))).toEqual(['P:Same', 'P:Same#2'])
    })

    it('replays idempotently against the WRITTEN source (post-save reload)', async () => {
        const first = await twinRegions('t3')
        store().move(first.a.querySelector('[data-m="arr"]'), first.b, first.b.querySelector('[data-m="nat"]'))

        document.body.innerHTML = ''
        new Function(SRC)()
        await flush()
        // What the source writer produced: arrival already spliced before the twin.
        const root = mount(`
            <section x-edit.authoring.sort="from-t3"><p>Beta</p></section>
            <section x-edit.authoring.sort="to-t3"><p data-m="arr">Same</p><p data-m="nat">Same</p></section>`)
        await flush(); await flush()
        await new Promise(r => setTimeout(r, 500))
        const [, b] = root.querySelectorAll('section')
        const kids = [...b.children]
        expect(kids.map(c => c.getAttribute('data-m'))).toEqual(['arr', 'nat'])   // no twin swap
        expect(kids.map(c => c.getAttribute('data-edit-key'))).toEqual(['P:Same', 'P:Same#2'])
    })
})

describe('x-edit move of a region-block (refused)', () => {
    it('refuses $edit.move and can() for a block that is itself an x-edit region', async () => {
        const root = mount(`
            <section x-edit.authoring.sort="outer-n1"><div x-edit.sort="inner-n1"><p>One</p></div><p>Two</p></section>
            <section x-edit.authoring.sort="dest-n1"><p>Three</p></section>`)
        await flush(); await flush()
        const [outer, dest] = root.querySelectorAll('section')
        const inner = outer.firstElementChild
        const before = store().export().log.length
        expect(store().can('move', inner)).toBe(false)
        expect(store().move(inner, dest)).toBe(false)
        expect(inner.parentElement).toBe(outer)
        expect(store().export().log.slice(before).some(d => d.kind === 'st-move')).toBe(false)
    })

    it('pointer-dragging a region-block never commits a cross-region move', async () => {
        const root = mount(`
            <section x-edit.authoring.sort="outer-n2"><div x-edit.sort="inner-n2"><p>One</p></div><p>Two</p></section>
            <section x-edit.authoring.sort="dest-n2"><p>Three</p></section>`)
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

    it('a drag INSIDE a nested region never disturbs the region-block (one drag per gesture)', async () => {
        const root = mount(`
            <section x-edit.authoring.sort="outer-n3"><div x-edit.sort="inner-n3"><p>Inner</p></div><p>Top</p></section>
            <section x-edit.authoring.sort="dest-n3"><p>Dest</p></section>`)
        await flush(); await flush()
        const [outer, dest] = root.querySelectorAll('section')
        const innerDiv = outer.firstElementChild
        const innerP = innerDiv.querySelector('p')
        const before = store().export().log.length
        document.elementFromPoint = () => dest.querySelector('p')
        innerP.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 41, clientY: 41 }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
        expect(innerDiv.parentElement).toBe(outer)        // the region-block never leaves
        expect(innerP.parentElement).toBe(innerDiv)       // the inner item never crosses out
        expect(store().export().log.length).toBe(before)  // no st-move, no bogus st-order
        expect(document.querySelector('[data-edit-ghost]')).toBeNull()
        await store().undo(); await store().undo()        // must not delete the region-block
        expect(outer.contains(innerDiv)).toBe(true)
    })

    it('refuses $edit.move when either endpoint region is nested (not top-level)', async () => {
        const root = mount(`
            <section x-edit.authoring.sort="outer-m4"><div x-edit.sort="inner-m4"><p>One</p></div><p>Top</p></section>
            <section x-edit.authoring.sort="dest-m4"><p>Three</p></section>`)
        await flush(); await flush()
        const [outer, dest] = root.querySelectorAll('section')
        const inner = outer.firstElementChild
        const innerP = inner.querySelector('p')
        const top = outer.children[1]
        const before = store().export().log.length
        expect(store().move(top, inner)).toBe(false)      // destination nested
        expect(top.parentElement).toBe(outer)
        expect(store().move(innerP, dest)).toBe(false)    // origin nested
        expect(innerP.parentElement).toBe(inner)
        expect(store().export().log.length).toBe(before)  // nothing logged either way
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

describe('x-edit publish paths vs the file the server will reach', () => {
    it('an edit after a sibling DELETE addresses the unmodified file order', async () => {
        const root = mount(`<section x-edit.authoring.sort.text="del-e1"><p>Alpha</p><p>Beta</p></section>`)
        await flush(); await flush()
        const area = root.querySelector('section')
        const [alpha, beta] = area.querySelectorAll('p')
        expect(store().remove(alpha)).toBe(true)
        editText(beta, 'Edited')
        const st = store().patches().find(p => p.kind === 'static' && p.region === 'del-e1')
        expect(st).toBeTruthy()
        // The server skips the short order, so the file keeps Alpha at 0 — Beta is 1.
        expect(st.edits).toContainEqual(expect.objectContaining({ key: 'P:Beta', prop: 'text', value: 'Edited', path: '1' }))
    })

    it('cut-then-edit addresses the unmodified file order too', async () => {
        const root = mount(`<section x-edit.authoring.sort.text="cut-e1"><p>Alpha</p><p>Beta</p></section>`)
        await flush(); await flush()
        const area = root.querySelector('section')
        const [alpha, beta] = area.querySelectorAll('p')
        expect(store().cut(alpha)).toBe(true)
        editText(beta, 'Edited')
        const st = store().patches().find(p => p.kind === 'static' && p.region === 'cut-e1')
        expect(st.edits).toContainEqual(expect.objectContaining({ key: 'P:Beta', prop: 'text', value: 'Edited', path: '1' }))
    })

    it('edit-then-reorder still publishes at the post-order position (order applies)', async () => {
        const root = mount(`<section x-edit.authoring.sort.text="ord-e1"><p>Alpha</p><p>Beta</p></section>`)
        await flush(); await flush()
        const area = root.querySelector('section')
        const alpha = area.querySelector('p')
        editText(alpha, 'Edited')
        const key = (k) => new KeyboardEvent('keydown', { key: k, bubbles: true })
        alpha.dispatchEvent(key(' '))                     // grab
        alpha.dispatchEvent(key('ArrowDown'))
        alpha.dispatchEvent(key('Enter'))                 // drop → st-order [Beta, Alpha]
        const st = store().patches().find(p => p.kind === 'static' && p.region === 'ord-e1')
        expect(st.order).toEqual(['P:Beta', 'P:Alpha'])
        // Same-length order IS applied by the server, so the current position is right.
        expect(st.edits).toContainEqual(expect.objectContaining({ key: 'P:Alpha', prop: 'text', value: 'Edited', path: '1' }))
    })
})

describe('x-edit plugin-node indexing (handles/ghosts never count)', () => {
    it('undo of a reorder keeps real children ahead of injected size handles, and paths skip them', async () => {
        const root = mount(`<section x-edit.authoring.sort.text.size="sz1"><p>One</p><p>Two</p></section>`)
        await flush(); await flush()
        const area = root.querySelector('section')
        expect([...area.children].filter(c => c.hasAttribute('data-edit-handle')).length).toBeGreaterThan(0)
        const two = [...area.querySelectorAll('p')].find(p => p.textContent === 'Two')
        const key = (k) => new KeyboardEvent('keydown', { key: k, bubbles: true })
        two.dispatchEvent(key(' '))
        two.dispatchEvent(key('ArrowUp'))
        two.dispatchEvent(key('Enter'))                   // st-order [Two, One]
        await store().undo()                              // applyStaticState reorder branch
        expect(area.firstElementChild.tagName).toBe('P')  // not a handle span
        expect([...area.children].filter(c => c.tagName === 'P').map(c => c.textContent)).toEqual(['One', 'Two'])
        const one = area.querySelector('p')
        editText(one, 'Edited')
        const st = store().patches().find(p => p.kind === 'static' && p.region === 'sz1')
        expect(st.edits).toContainEqual(expect.objectContaining({ key: 'P:One', prop: 'text', value: 'Edited', path: '0' }))
    })
})

describe('x-edit copy/cut of a region element', () => {
    it('returns false instead of throwing (a region is a container, not a block)', async () => {
        const root = mount(`<section x-edit.authoring.sort="solo-c1"><p>Only</p></section>`)
        await flush(); await flush()
        const area = root.querySelector('section')
        expect(store().copy(area)).toBe(false)
        expect(store().cut(area)).toBe(false)
        expect(area.querySelector('p')).toBeTruthy()      // cut must not have removed anything
        expect(store().copy(area.querySelector('p'))).toBe(true)   // a real block still copies
    })
})
