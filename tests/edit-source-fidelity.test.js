/**
 * @vitest-environment happy-dom
 *
 * What the source writer keeps (the 2026-10-04/06 review probes, rounds r5/r6 and the
 * strictly-better pass): text between children and comments on reorder, implicit <tbody>,
 * directive fallback content, live directive output never baked into a duplicate, a same
 * region key earlier in the file, and a save whose response is lost.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import Alpine from 'alpinejs'
import { editServer, editText, kbMove } from './helpers/edit-sessions.js'

let S
beforeAll(async () => { S = await editServer() }, 15000)
afterAll(() => S && S.stop())
afterEach(() => { S.net.lose = false })

const store = () => S.store()
const doc = (body) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`
const kids = (r) => [...r.children].filter(c => !c.hasAttribute('data-edit-handle') && !c.hasAttribute('data-edit-ghost'))
const region = (id) => { const html = S.file(), s = html.indexOf(`id="${id}"`); return html.slice(html.lastIndexOf('<', s), html.indexOf('</section>', s) + 10) }
const statuses = (res) => res.results.map(x => x.status)

describe('reorders keep what sits between children', () => {
    it('T5 same-line comments travel with their element', async () => {
        const root = await S.open(doc(`    <section id="a" x-edit="a">
        <div>A</div> <!-- /A -->
        <div>B</div> <!-- /B -->
        <div>C</div>
    </section>`))
        kbMove(kids(root.querySelector('#a'))[2], 'ArrowUp', 2)
        expect(statuses(await store().publish())).toEqual(['written'])
        const r = region('a')
        expect(r.indexOf('<div>C</div>')).toBeLessThan(r.indexOf('<div>A</div>'))
        expect(r).toContain('<!-- /A -->'); expect(r).toContain('<!-- /B -->')
    })

    it('T4 inline text between children is never dropped', async () => {
        const root = await S.open(doc(`    <section id="a" x-edit="a"><a href="#1">One</a> or <a href="#2">Two</a> <!-- end two --></section>`))
        kbMove(kids(root.querySelector('#a'))[1], 'ArrowUp', 1)
        await store().publish()
        const r = region('a')
        expect(r).toContain(' or ')
        expect(r).toContain('<!-- end two -->')
        expect(r.match(/<a /g).length).toBe(2)
    })

    // The comments directly above a block (no blank line) title it and go with it; a blank line
    // keeps a comment with what comes before (the round-5 probe asked for the first case too).
    for (const [gap, kept] of [['\n', false], ['\n\n', true]]) {
        it(`T11 deleting a block ${kept ? 'keeps a comment a blank line above it' : 'takes the comments directly above it'}, on the page and in the source`, async () => {
            const root = await S.open(doc(`    <section id="a" x-edit="a">
        <div>A</div>
        <!-- /A -->${gap}        <!-- B: pricing -->
        <div>B</div>
        <div>C</div>
    </section>`))
            const a = root.querySelector('#a')
            store().remove(kids(a)[1])
            expect(statuses(await store().publish())).toEqual(['written'])
            const r = region('a')
            expect(r).not.toContain('<div>B</div>'); expect(r).not.toContain('B: pricing')
            expect(r.includes('<!-- /A -->')).toBe(kept)
            expect(a.innerHTML.includes('<!-- /A -->')).toBe(kept)
            expect(r).toMatch(/<div>A<\/div>[\s\S]*<div>C<\/div>/)
        })
    }

    it('C1 a titling comment moves with its element to another region', async () => {
        const root = await S.open(doc(`    <section id="a" x-edit="a">
        <div>Zero</div>
        <!-- Card one -->
        <div>One</div>
        <div>Two</div>
    </section>
    <section id="b" x-edit="b">
        <div>Three</div>
    </section>`))
        store().move(kids(root.querySelector('#a'))[1], root.querySelector('#b'))
        expect(statuses(await store().publish())).toEqual(['written', 'written'])
        expect(region('b')).toMatch(/<!-- Card one -->\s*<div>One<\/div>/)
        expect(region('a')).not.toContain('Card one')
    })
})

describe('the element written is the element edited', () => {
    it('T1 a table with no <tbody> in the source: a cell edit lands in that cell', async () => {
        const root = await S.open(doc(`    <section id="t" x-edit="t">
        <table><tr><td><b>B1</b></td><td><b>B2</b></td></tr><tr><td><b>C1</b></td></tr></table>
    </section>`))
        const c1 = [...root.querySelectorAll('#t b')].find(b => b.textContent === 'C1')
        editText(c1, 'EDITED-C1')
        await store().publish()
        const r = region('t')
        expect(r).toContain('<b>B1</b>'); expect(r).toContain('<b>B2</b>')
        expect(r).not.toContain('<tbody>')
        if (r.includes('EDITED-C1')) expect(r).toContain('<td><b>EDITED-C1</b></td></tr></table>')
    })

    it('T2 rendered directive output is not written over the authored fallback', async () => {
        Alpine.directive('fakemd', (el) => { el.innerHTML = '<h1>Rendered title</h1><p>Rendered body</p>' })
        const root = await S.open(doc(`    <section id="m" x-edit="m">
        <article><div x-fakemd="md"><p>Loading</p><p>Second fallback</p></div></article>
    </section>`))
        const h1 = root.querySelector('#m h1')
        if (h1 && h1.isContentEditable) editText(h1, 'EDITED')
        await store().publish()
        expect(region('m')).toContain('<div x-fakemd="md"><p>Loading</p><p>Second fallback</p></div>')
    })

    it('T6 a duplicated block carries no directive output (x-text values, x-show style)', async () => {
        const root = await S.open(doc(`    <section id="a" x-edit="a" x-data="{ name: 'Bob', on: false }">
        <div><span x-text="name"></span><em x-show="on">hidden</em></div>
        <p>Tail</p>
    </section>`))
        store().duplicate(kids(root.querySelector('#a'))[0])
        expect(statuses(await store().publish())).toEqual(['written'])
        const r = region('a')
        expect(r.match(/<div><span x-text="name"><\/span><em x-show="on">hidden<\/em><\/div>/g).length).toBe(2)
        expect(r).not.toContain('>Bob<'); expect(r).not.toContain('display: none')
    })

    // Known bug: duplicating (or pasting) a block holding a <template>. The copy's tree lists the
    // template's DOM children (none: its markup is in .content), so the writer empties the copied
    // template: the source gets <template x-for="i in items"></template> and the copied list renders
    // nothing. On the page the copy also carries the rendered rows, which Alpine evaluates out of the
    // loop's scope ("i is not defined").
    it.fails('T6b a duplicated block keeps the content of its <template x-for>, and the page copy raises no errors', async () => {
        const errors = []
        Alpine.setErrorHandler((e, el, expression) => errors.push(expression))
        try {
            const root = await S.open(doc(`    <section id="a" x-edit="a" x-data="{ items: ['r1','r2'] }">
        <div><template x-for="i in items"><p x-text="i"></p></template></div>
        <p>Tail</p>
    </section>`))
            store().duplicate(kids(root.querySelector('#a'))[0])
            await store().publish()
            await new Promise(r => setTimeout(r, 50))
            expect(region('a').match(/<template x-for="i in items"><p x-text="i"><\/p><\/template>/g).length).toBe(2)
            expect(region('a')).not.toContain('>r1<')
            expect(errors).toEqual([])
        } finally {
            Alpine.setErrorHandler((e) => { setTimeout(() => { throw e }) })
        }
    })

    it.fails('T6c a pasted block keeps the content of its <template x-if> (same bug)', async () => {
        const root = await S.open(doc(`    <section id="a" x-edit="a" x-data="{ on: true }">
        <div><template x-if="on"><p>Shown</p></template></div>
        <p>Tail</p>
    </section>`))
        const a = root.querySelector('#a')
        store().copy(kids(a)[0]); store().paste(kids(a)[1])
        await store().publish()
        expect(region('a').match(/<template x-if="on"><p>Shown<\/p><\/template>/g).length).toBe(2)
    })

    it('C5 a region with the same key earlier in the file (inside a template) is not the one written', async () => {
        const root = await S.open(doc(`    <template><section x-edit="a"><p>Template copy</p></section></template>
    <section id="a" x-edit="a">
        <p>Live</p>
    </section>`))
        editText(kids(root.querySelector('#a'))[0], 'Live edited')
        await store().publish()
        expect(S.file()).toContain('<p>Template copy</p>')
        expect(S.file()).not.toMatch(/<template><section x-edit="a"><p>Live edited/)
    })

    it('C2 a commented-out copy of the region earlier in the file is not the one written', async () => {
        const root = await S.open(doc(`    <!-- <section x-edit="a"><p>Old</p></section> -->
    <section id="a" x-edit="a">
        <p>Old</p>
    </section>`))
        editText(kids(root.querySelector('#a'))[0], 'New')
        await store().publish()
        expect(S.file()).toContain('<!-- <section x-edit="a"><p>Old</p></section> -->')
    })
})

describe('a save whose response is lost', () => {
    it('T3 republishing and reloading never writes the duplicate twice', async () => {
        const root = await S.open(doc(`    <section id="a" x-edit.persist="a">
        <p>One</p>
        <p>Two</p>
    </section>`))
        store().duplicate(kids(root.querySelector('#a'))[0])
        S.net.lose = true
        await expect(store().publish()).rejects.toThrow()
        S.net.lose = false
        const once = (region('a').match(/<p>One<\/p>/g) || []).length
        expect(once).toBe(2)
        await store().publish()
        expect((region('a').match(/<p>One<\/p>/g) || []).length).toBe(2)
        const again = await S.reload()
        await store().publish()
        expect((region('a').match(/<p>One<\/p>/g) || []).length).toBe(2)
        expect(kids(again.querySelector('#a')).filter(k => k.textContent === 'One').length).toBe(2)
    })

    it('T3b reload without republishing shows the written source once', async () => {
        const root = await S.open(doc(`    <section id="a" x-edit.persist="a">
        <p>One</p>
        <p>Two</p>
    </section>`))
        store().duplicate(kids(root.querySelector('#a'))[0])
        S.net.lose = true
        await expect(store().publish()).rejects.toThrow()
        S.net.lose = false
        const again = await S.reload()
        await store().publish()
        expect((region('a').match(/<p>One<\/p>/g) || []).length).toBe(2)
        expect(kids(again.querySelector('#a')).filter(k => k.textContent === 'One').length).toBe(2)
    })
})
