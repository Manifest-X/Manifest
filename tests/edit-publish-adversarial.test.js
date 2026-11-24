/**
 * @vitest-environment happy-dom
 *
 * Reviewer probes (structural edits, Oct 2026 review rounds) as regression tests: duplicate,
 * delete, paste, moves, reorders and text edits published through the real dev server, across
 * reloads and source changes made underneath the page (an agent's write). What holds:
 *   - a written publish leaves the source reading as the page does, and a fresh load shows it
 *   - a refused publish writes nothing and keeps the edits
 *   - content written to the source by someone else is never deleted or overwritten
 *   - an edit that cannot be placed after a source change is surfaced ($edit.conflicts)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { editServer, twoRegions, view, fileView, editText, kbMove, flush } from './helpers/edit-sessions.js'

let S
beforeAll(async () => { S = await editServer() }, 15000)
afterAll(() => S && S.stop())

const store = () => S.store()
const plain = twoRegions(''), persist = twoRegions('.persist')
const R = (root) => ({ a: root.querySelector('#a'), b: root.querySelector('#b') })
const pv = (r) => ({ a: view(r.a), b: view(r.b) })
const statuses = (res) => res.results.map(x => x.status)
const T0 = 'Lorem ipsum dolor sit amet zero', T1 = 'Lorem ipsum dolor sit amet one', T2 = 'Lorem ipsum dolor sit amet two'

async function publishShown(r, opts) {
    const res = await store().publish(opts)
    expect(res.results.filter(x => x.status !== 'written' && x.status !== 'noop')).toEqual([])
    expect(fileView(S.file())).toEqual(pv(r))
    return res
}
// A fresh session on the written source shows what the file holds
async function freshShowsFile() {
    const fv = fileView(S.file())
    const f = R(await S.reload())
    expect(pv(f)).toEqual(fv)
    return f
}
const refusedUnchanged = async (opts) => {
    const before = S.file()
    const res = await store().publish(opts)
    expect(res.results.length).toBeGreaterThan(0)
    expect(res.results.every(x => x.status === 'error' || x.status === 'skipped')).toBe(true)
    expect(S.file()).toBe(before)
    return res
}

describe('structural publishes (round 1)', () => {
    it('P1 a partial refusal, then rebase publishes: written steps are not applied twice', async () => {
        const r = R(await S.open(plain(['<p>Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>', '<p>Delta</p>'])))
        store().remove(r.a.children[0])
        store().copy(r.b.children[0]); store().paste(r.a.children[0])   // a: Beta Gamma
        store().remove(r.b.children[1])                                 // b: Gamma
        S.ext(f => f.replace('<p>Gamma</p>', '<h2>New</h2>\n        <p>Gamma</p>'))
        const r1 = await refusedUnchanged()
        expect(r1.results[0].reason).toContain('rebase')
        const r2 = await store().publish({ rebase: true })
        expect(statuses(r2)).toEqual(['written', 'error'])                // b changed under its edit
        expect(fileView(S.file())).toEqual({ a: ['Beta', 'Gamma'], b: ['New', 'Gamma', 'Delta'] })
        const r3 = await store().publish({ rebase: true })
        expect(statuses(r3)).toEqual(['error'])
        expect(fileView(S.file()).a).toEqual(['Beta', 'Gamma'])
        expect(store().export().log.length).toBe(1)                     // b's delete is kept
    })

    it('P2 publish, reload, more structure, publish again', async () => {
        const r = R(await S.open(plain(['<p>Alpha</p>', '<p>Beta</p>', '<p>Zeta</p>'], ['<p>Gamma</p>'])))
        store().duplicate(r.a.children[0]); editText(r.a.children[1], 'Copy')
        await publishShown(r)
        const f = await freshShowsFile()
        store().remove(f.a.children[2])
        await publishShown(f)
        expect(view(f.a)).toEqual(['Alpha', 'Copy', 'Zeta'])
    })

    it('P3 an edit to the original twin does not jump to the copy after a reload', async () => {
        const r = R(await S.open(plain(['<p>Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>'])))
        store().duplicate(r.a.children[0]); editText(r.a.children[0], 'First')
        await publishShown(r)
        const f = await freshShowsFile()
        expect(view(f.a)).toEqual(['First', 'Alpha', 'Beta'])
        editText(f.a.children[2], 'Beta2')
        await publishShown(f)
        expect(fileView(S.file()).a).toEqual(['First', 'Alpha', 'Beta2'])
    })

    it('P4 duplicated markup carries no editor attributes into the source', async () => {
        const r = R(await S.open(plain(['<p class="c" x-on:click="1">Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>'])))
        store().duplicate(r.a.children[0])
        await publishShown(r)
        expect(S.file()).not.toMatch(/data-edit|contenteditable|draggable/)
        expect(S.file().match(/<p class="c" x-on:click="1">Alpha<\/p>/g).length).toBe(2)
    })

    it('P5 move, publish, edit, publish again', async () => {
        const r = R(await S.open(plain(['<p>Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>'])))
        store().move(r.a.children[0], r.b)
        await publishShown(r)
        editText(r.a.children[0], 'Beta2')
        await publishShown(r)
        expect(fileView(S.file())).toEqual({ a: ['Beta2'], b: ['Gamma', 'Alpha'] })
    })

    it('P7 delete every child, publish, paste into the empty region', async () => {
        const r = R(await S.open(plain(['<p>Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>'])))
        store().copy(r.b.children[0])
        store().remove(r.a.children[0]); store().remove(r.a.children[0])
        await publishShown(r)
        expect(view(r.a)).toEqual([])
        store().target = r.a
        expect(store().paste()).toBe(true)
        store().target = null
        expect(view(r.a)).toEqual(['Gamma'])
        await publishShown(r)
    })

    it('P8 duplicate, reorder, delete the original, edit the copy', async () => {
        const r = R(await S.open(plain(['<p data-m="o">Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>'])))
        store().duplicate(r.a.children[0])                              // o o Beta
        kbMove(r.a.children[2], 'ArrowUp', 2)                           // Beta o o
        expect(view(r.a)).toEqual(['Beta', 'o=Alpha', 'o=Alpha'])
        store().remove(r.a.children[1])
        editText(r.a.children[1], 'Dup edited')
        await publishShown(r)
        await freshShowsFile()
    })

    it('P9 CRLF and tab-indented source', async () => {
        const src = plain(['<p>Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>']).replace(/ {8}/g, '\t\t').replace(/ {4}/g, '\t').replace(/\n/g, '\r\n')
        const r = R(await S.open(src))
        store().duplicate(r.a.children[0])
        store().remove(r.a.children[2])
        await publishShown(r)
        expect(S.file()).toContain('\r\n')
        expect(S.file()).not.toMatch(/[^\r]\n/)
    })

    it('P10 undo before a publish, redo after it', async () => {
        const r = R(await S.open(plain(['<p>Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>'])))
        store().duplicate(r.a.children[0])
        store().remove(r.a.children[2])
        await store().undo()
        await publishShown(r)
        await store().redo()
        await publishShown(r)
    })

    it('P11 a duplicated nested region: an edit in each copy lands in that copy', async () => {
        const r = R(await S.open(plain(['<div x-edit="inner"><p>In</p></div>', '<p>Beta</p>'], ['<p>Gamma</p>'])))
        expect(store().duplicate(r.a.children[0])).toBe(true)
        editText(r.a.querySelectorAll('[x-edit="inner"]')[1].querySelector('p'), 'Second')
        await publishShown(r)
        const f = await freshShowsFile()
        editText(f.a.querySelectorAll('[x-edit="inner"]')[0].querySelector('p'), 'First')
        await publishShown(f)
        expect(S.file()).toContain('<div x-edit="inner"><p>First</p></div>\n        <div x-edit="inner"><p>Second</p></div>')
    })

    it('P12 void children (img, hr, br) duplicate and delete', async () => {
        const r = R(await S.open(plain(['<img src="a.png" alt="A">', '<hr>', '<p>Beta</p>', '<br>'], ['<p>Gamma</p>'])))
        store().duplicate(r.a.children[0])
        store().remove(r.a.children[2])
        await store().publish()
        const d = new DOMParser().parseFromString(S.file(), 'text/html')
        expect([...d.querySelector('#a').children].map(c => c.tagName)).toEqual([...r.a.children].filter(c => !c.hasAttribute('data-edit-handle')).map(c => c.tagName))
    })

    it('P14 moving one of two twins out after a duplicate moves that twin', async () => {
        const r = R(await S.open(plain(['<p data-m="1">Same</p>', '<p data-m="2">Same</p>', '<p>X</p>'], ['<p>Gamma</p>'])))
        store().duplicate(r.a.children[2])                              // 1 2 X X
        expect(store().move(r.a.children[1], r.b)).toBe(true)
        expect(pv(r)).toEqual({ a: ['1=Same', 'X', 'X'], b: ['Gamma', '2=Same'] })
        await publishShown(r)
        await freshShowsFile()
    })

    it('P15 moves into and out of a region, with a delete and a duplicate between', async () => {
        const r = R(await S.open(plain(['<p>Alpha</p>', '<p>Beta</p>'], ['<p>Gamma</p>', '<p>Delta</p>'])))
        store().move(r.b.children[0], r.a, r.a.children[1])
        store().remove(r.a.children[0])
        store().move(r.a.children[1], r.b)
        store().duplicate(r.b.children[0])
        store().move(r.a.children[0], r.b, r.b.children[0])
        expect(pv(r)).toEqual({ a: [], b: ['Gamma', 'Delta', 'Delta', 'Beta'] })
        await publishShown(r)
        await freshShowsFile()
    })

    it('P17 paste before a twin, edit the paste, publish, reload, edit, delete, publish', async () => {
        const r = R(await S.open(plain(['<p>Head</p>', '<p data-m="orig">Same</p>', '<p>Tail</p>'], ['<p data-m="src">Same</p>'])))
        store().copy(r.b.children[0]); store().paste(r.a.children[0])
        editText(r.a.children[1], 'Pasted')
        await publishShown(r)
        const f = await freshShowsFile()
        editText(f.a.children[3], 'Tail2')
        store().remove(f.a.children[0])
        await publishShown(f)
        expect(fileView(S.file()).a).toEqual(['src=Pasted', 'orig=Same', 'Tail2'])
    })

    it('P18 a region holding an inline svg', async () => {
        const r = R(await S.open(plain(['<svg viewBox="0 0 1 1"><rect></rect></svg>', '<p>Beta</p>'], ['<p>Gamma</p>'])))
        store().duplicate(r.a.children[1])
        await publishShown(r)
        expect(S.file()).toContain('<svg viewBox="0 0 1 1"><rect></rect></svg>')
    })
})

describe('structural publishes (round 2)', () => {
    it('Q1 undo while a reorder is publishing, then delete', async () => {
        const r = R(await S.open(plain(['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'])))
        store().duplicate(r.a.children[0])
        await publishShown(r)
        kbMove(r.a.children[3], 'ArrowUp', 3)                           // C A A B
        const pending = store().publish()
        await store().undo()
        await pending
        store().remove(r.a.children[r.a.children.length - 1])
        await store().publish()
        expect(fileView(S.file()).a).toEqual(view(r.a))
        await freshShowsFile()
    })

    it('Q2 one region changed underneath: the other publishes on rebase; the changed one keeps its edits', async () => {
        const r = R(await S.open(plain(['<p>A1</p>', '<p>A2</p>', '<p>A3</p>'], ['<p>B1</p>', '<p>B2</p>', '<p>B3</p>'])))
        store().duplicate(r.a.children[0])
        store().remove(r.b.children[2])
        kbMove(r.a.children[3], 'ArrowUp', 1)
        editText(r.b.children[1], 'B2x')
        S.ext(f => f.replace('<p>B1</p>', '<h3>N</h3>\n        <p>B1</p>'))
        await refusedUnchanged()
        const res = await store().publish({ rebase: true })
        expect(statuses(res)).toEqual(['written', 'error'])
        expect(fileView(S.file())).toEqual({ a: view(r.a), b: ['N', 'B1', 'B2', 'B3'] })
        expect(store().export().log.some(d => d.region === 'b')).toBe(true)
    })

    it('Q6 a move after an external change to its region is refused on rebase, nothing written', async () => {
        const r = R(await S.open(plain(['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'])))
        store().duplicate(r.a.children[0])
        await publishShown(r)
        store().move(r.a.children[2], r.b)
        S.ext(f => f.replace(/(id="a"[^>]*>\n)/, '$1        <h2>N</h2>\n'))
        await refusedUnchanged()
        const res = await refusedUnchanged({ rebase: true })
        expect(res.results[0].reason).toContain('changed since this page loaded')
        expect(pv(r)).toEqual({ a: ['A', 'A', 'C'], b: ['G', 'B'] })        // the move stays on the page
    })

    it('Q7 an addition elsewhere, then a reload with a pending duplicate: the addition survives', async () => {
        const r = R(await S.open(persist(['<p>A</p>', '<p>B</p>'], ['<p>G</p>'])))
        store().duplicate(r.a.children[0])
        S.ext(f => f.replace('<p>B</p>', '<p>B</p>\n        <p>Agent added</p>'))
        await S.reload()
        await store().publish()
        expect(fileView(S.file()).a).toContain('Agent added')
        await freshShowsFile()
    })

    it('Q7b the same with a reorder', async () => {
        const r = R(await S.open(persist(['<p>A</p>', '<p>B</p>'], ['<p>G</p>'])))
        kbMove(r.a.children[1], 'ArrowUp', 1)
        S.ext(f => f.replace('<p>B</p>', '<p>B</p>\n        <p>Agent added</p>'))
        await S.reload()
        await store().publish()
        expect(fileView(S.file()).a).toContain('Agent added')
        await freshShowsFile()
    })
})

describe('source changed underneath pending structure (round 3)', () => {
    // Edits pending in a .persist region; the source changes; the page reloads (or holds the
    // live reload and publishes). The agent's element always survives; an edit that cannot be
    // placed is reported, never applied to another element.
    const settles = async (markers) => {
        const res = await store().publish()
        const fv = fileView(S.file())
        markers.forEach(m => expect(fv.a.concat(fv.b).join('\n')).toContain(m))
        if (res.results.some(x => x.status === 'written')) await freshShowsFile()
        return res
    }

    it('BLOCK-1 a pending card delete, an agent adds a similar card above, live reload held: nothing written, nothing lost', async () => {
        const A = 'Customer story card text: Alpha', B = 'Customer story card text: Beta', G = 'Customer story card text: Gamma'
        const r = R(await S.open(persist([`<p>${A}</p>`, `<p>${B}</p>`, '<p>Footer</p>'], ['<p>X</p>'])))
        store().remove(r.a.children[1])
        S.ext(f => f.replace(`<p>${A}</p>`, `<p>${G}</p>\n        <p>${A}</p>`))
        const ev = new CustomEvent('manifest:live-reload', { cancelable: true, detail: { files: [{ rel: 'index.html', hash: 'x' }] } })
        window.dispatchEvent(ev)
        expect(ev.defaultPrevented).toBe(true)
        await refusedUnchanged()
        await refusedUnchanged({ rebase: true })
        expect(fileView(S.file()).a).toEqual([G, A, B, 'Footer'])
        expect(store().export().log.length).toBe(1)
    })

    it('BLOCK-1 the same across a reload: the delete is reported, the agent card and the target stay', async () => {
        const A = 'Customer story card text: Alpha', B = 'Customer story card text: Beta', G = 'Customer story card text: Gamma'
        const r = R(await S.open(persist([`<p>${A}</p>`, `<p>${B}</p>`, '<p>Footer</p>'], ['<p>X</p>'])))
        store().remove(r.a.children[1])
        S.ext(f => f.replace(`<p>${A}</p>`, `<p>${G}</p>\n        <p>${A}</p>`))
        const f = R(await S.reload())
        expect(view(f.a)).toEqual([G, A, B, 'Footer'])
        expect(store().conflicts.some(c => c.region === 'a' && c.prop === 'structure')).toBe(true)
        await settles([G, A, B])
        expect(fileView(S.file()).a).toEqual([G, A, B, 'Footer'])
    })

    it('BLOCK-2 a pending duplicate and delete of a twin, an agent adds a twin: the agent element survives', async () => {
        const r = R(await S.open(persist(['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'])))
        store().duplicate(r.a.children[1]); store().remove(r.a.children[2]); store().remove(r.a.children[1])
        expect(view(r.a)).toEqual(['A', 'C'])
        S.ext(f => f.replace('<p>A</p>', '<p>B</p>\n        <p>A</p>'))
        await refusedUnchanged()
        await refusedUnchanged({ rebase: true })
        const f = R(await S.reload())
        expect(view(f.a)).toEqual(['B', 'A', 'B', 'C'])
        expect(store().conflicts.length).toBeGreaterThan(0)
        await settles([])
        expect(fileView(S.file()).a).toEqual(['B', 'A', 'B', 'C'])
    })

    const cases = [
        ['P1 twin delete, external twin inserted before', [`<p>A</p>`, `<p>${T1}</p>`, `<p>${T2}</p>`], ['<p>G</p>'],
            (r) => store().remove(r.a.children[2]), (f) => f.replace('<p>A</p>', `<p>${T0}</p>\n        <p>A</p>`), [T0, 'A']],
        ['P2 twin delete, external swap of the twins', [`<p>A</p>`, `<p>${T1}</p>`, `<p>${T2}</p>`], ['<p>G</p>'],
            (r) => store().remove(r.a.children[2]), (f) => f.replace(`<p>${T1}</p>\n        <p>${T2}</p>`, `<p>${T2}</p>\n        <p>${T1}</p>`), ['A', T1]],
        ['P3 duplicate, external reorder', ['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'],
            (r) => store().duplicate(r.a.children[0]), (f) => f.replace('<p>A</p>\n        <p>B</p>\n        <p>C</p>', '<p>C</p>\n        <p>B</p>\n        <p>A</p>'), ['A', 'B', 'C']],
        ['P4 delete, another child deleted externally', ['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'],
            (r) => store().remove(r.a.children[2]), (f) => f.replace('<p>A</p>\n        ', ''), ['B']],
        ['P5 duplicate, reorder, external insert', ['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'],
            (r) => { store().duplicate(r.a.children[1]); kbMove(r.a.children[3], 'ArrowUp', 3) }, (f) => f.replace('<p>A</p>', '<p>A</p>\n        <p>E</p>'), ['E']],
        ['P6 duplicate whose source is deleted externally', ['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'],
            (r) => store().duplicate(r.a.children[1]), (f) => f.replace('<p>B</p>\n        ', ''), ['A', 'C']],
        ['P7 external twin of a duplicate', ['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'],
            (r) => store().duplicate(r.a.children[1]), (f) => f.replace('<p>C</p>', '<p>C</p>\n        <p>B</p>'), ['C']],
        ['P8 move with external inserts in both regions', ['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>', '<p>H</p>'],
            (r) => { store().duplicate(r.a.children[0]); store().move(r.a.children[2], r.b, r.b.children[1]) }, (f) => f.replace('<p>C</p>', '<p>Ea</p>\n        <p>C</p>').replace('<p>H</p>', '<p>Eb</p>\n        <p>H</p>'), ['Ea', 'Eb']],
        ['P10 duplicate and delete twins, external twin before', ['<p>A</p>', '<p>B</p>', '<p>C</p>'], ['<p>G</p>'],
            (r) => { store().duplicate(r.a.children[1]); store().remove(r.a.children[2]); store().remove(r.a.children[1]) }, (f) => f.replace('<p>A</p>', '<p>B</p>\n        <p>A</p>'), ['B', 'A']],
        ['P12 twin move, external twin', [`<p>${T1}</p>`, `<p>${T2}</p>`, '<p>C</p>'], ['<p>G</p>'],
            (r) => store().move(r.a.children[1], r.b), (f) => f.replace(`<p>${T1}</p>`, `<p>${T0}</p>\n        <p>${T1}</p>`), [T0, T1]],
        ['B5 duplicates, a move and a delete among twins', [`<p>${T1}</p>`, `<p>${T2}</p>`, '<h2>H</h2>', `<p>${T1}</p>`], ['<p>G</p>', `<p>${T2}</p>`],
            (r) => { store().duplicate(r.b.children[1]); store().duplicate(r.a.children[1]); store().move(r.b.children[1], r.a); store().remove(r.b.children[1]) }, (f) => f.replace('<h2>H</h2>', '<h2>H</h2>\n        <p>Agent</p>'), ['Agent', 'H']],
    ]
    for (const [name, a, b, act, change, markers] of cases) {
        it(name + ': reload, then publish', async () => {
            const r = R(await S.open(persist(a, b)))
            act(r)
            S.ext(change)
            const fileBefore = S.file()
            await S.reload()
            const res = await settles(markers)
            if (!res.results.some(x => x.status === 'written')) expect(S.file()).toBe(fileBefore)
        })
        it(name + ': no reload, rebase publish', async () => {
            const r = R(await S.open(persist(a, b)))
            act(r)
            S.ext(change)
            await refusedUnchanged()
            const before = S.file()
            const res = await store().publish({ rebase: true })
            const fv = fileView(S.file())
            markers.forEach(m => expect(fv.a.concat(fv.b).join('\n')).toContain(m))
            if (!res.results.some(x => x.status === 'written')) expect(S.file()).toBe(before)
        })
    }
})

describe('no source change across reloads (round 3)', () => {
    it('B1 a published text edit, then a reorder: no duplication', async () => {
        const r = R(await S.open(plain(['<p>One</p>', '<p>Two</p>', '<p>Three</p>'], ['<p>G</p>'])))
        editText(r.a.children[2], 'Edited')
        await publishShown(r)
        kbMove(r.a.children[0], 'ArrowDown', 1)
        await publishShown(r)
        expect(fileView(S.file()).a).toEqual(['Two', 'One', 'Edited'])
    })

    it('B2 a published text edit, then a move: no duplication', async () => {
        const r = R(await S.open(plain(['<p>One</p>', '<h2>H</h2>', '<p>Three</p>'], ['<p>G</p>'])))
        editText(r.a.children[1], 'Edited')
        await publishShown(r)
        store().move(r.a.children[1], r.b)
        await publishShown(r)
        expect(fileView(S.file())).toEqual({ a: ['One', 'Three'], b: ['G', 'Edited'] })
    })

    for (const [name, a, b, act] of [
        ['B3 paste and edit the paste', ['<p>One</p>', '<p>Two</p>'], ['<p>G</p>'], (r) => { store().copy(r.a.children[0]); store().paste(r.b.children[0]); editText(r.b.children[1], 'Pasted edited') }],
        ['B4 duplicate and edit the copy', ['<p>One</p>', '<p>Two</p>'], ['<p>G</p>'], (r) => { store().duplicate(r.a.children[0]); editText(r.a.children[1], 'Dup edited') }],
        ['B5 duplicates, a move and a delete among twins', [`<p>${T1}</p>`, `<p>${T2}</p>`, '<h2>H</h2>', `<p>${T1}</p>`], ['<p>G</p>', `<p>${T2}</p>`],
            (r) => { store().duplicate(r.b.children[1]); store().duplicate(r.a.children[1]); store().move(r.b.children[1], r.a); store().remove(r.b.children[1]) }],
        ['B5b a duplicate and a move, no twins', ['<p>A</p>', '<p>B</p>', '<h2>H</h2>'], ['<p>G</p>', '<p>Y</p>'], (r) => { store().duplicate(r.a.children[1]); store().move(r.b.children[1], r.a) }],
    ]) {
        it(name + ': a reload shows the same page, and it publishes as shown', async () => {
            const r = R(await S.open(persist(a, b)))
            act(r)
            const before = pv(r)
            const f = R(await S.reload())
            expect(pv(f)).toEqual(before)
            await publishShown(f)
            await freshShowsFile()
        })
    }

    it('B6 paste, publish, move a twin in, paste a twin, reload, publish', async () => {
        const r = R(await S.open(persist([`<p>${T1}</p>`, `<p>${T2}</p>`, '<h2>H</h2>', `<p>${T1}</p>`], ['<p>G</p>', `<p>${T2}</p>`])))
        store().copy(r.b.children[1]); store().paste(r.a.children[1])
        await publishShown(r)
        store().move(r.b.children[1], r.a)
        store().copy(r.b.children[0]); store().paste(r.a.children[5])
        const before = pv(r)
        const f = R(await S.reload())
        expect(pv(f)).toEqual(before)
        await publishShown(f)
        await freshShowsFile()
    })

    for (const [name, a, act1, act2] of [
        ['C1 duplicate a twin, publish, delete another, reload', [`<p>${T1}</p>`, `<p>${T2}</p>`, '<p>C</p>'], (r) => store().duplicate(r.a.children[0]), (r) => store().remove(r.a.children[2])],
        ['C2 duplicate the first of two cards, publish, delete the second, reload', ['<p>Card intro text that is long: Alpha</p>', '<p>Card intro text that is long: Beta</p>'], (r) => store().duplicate(r.a.children[0]), (r) => store().remove(r.a.children[2])],
        ['C3 duplicate, publish, reorder, reload', ['<p>Card intro text that is long: Alpha</p>', '<p>Card intro text that is long: Beta</p>', '<p>Z</p>'], (r) => store().duplicate(r.a.children[0]), (r) => kbMove(r.a.children[2], 'ArrowDown', 1)],
    ]) {
        it(name + ', publish', async () => {
            const r = R(await S.open(persist(a, ['<p>G</p>'])))
            act1(r)
            await publishShown(r)
            act2(r)
            const before = pv(r)
            const f = R(await S.reload())
            expect(pv(f)).toEqual(before)
            await publishShown(f)
            await freshShowsFile()
        })
    }
})

// Seeded random sessions (the round-3 fuzzer): duplicate, delete, paste, move, text, reorder,
// publish, undo and reload in .persist regions. Every written publish matches the page;
// every reload shows the page as it was; the final source loads as the page.
describe('seeded sessions', () => {
    let rs = 1
    const rnd = (n) => { rs = (rs * 1103515245 + 12345) % 2147483648; return Math.floor(rs / 65536) % n }
    const kids = (reg) => [...reg.children].filter(c => !c.hasAttribute('data-edit-handle') && !c.hasAttribute('data-edit-ghost'))
    async function session(seed) {
        rs = seed * 7919
        let r = R(await S.open(persist([`<p>${T1}</p>`, `<p>${T2}</p>`, '<h2>H</h2>', `<p>${T1}</p>`], ['<p>G</p>', `<p>${T2}</p>`])))
        const trace = []
        for (let step = 0; step < 8; step++) {
            const op = rnd(9), reg = rnd(2) ? r.a : r.b, ks = kids(reg)
            if (!ks.length) continue
            const el = ks[rnd(ks.length)]
            if (op === 0) { store().duplicate(el); trace.push('dup') }
            else if (op === 1 && ks.length > 1) { store().remove(el); trace.push('del') }
            else if (op === 2) { store().copy(el); const o = rnd(2) ? r.a : r.b, ok = kids(o); store().paste(ok[rnd(ok.length)]); trace.push('paste') }
            else if (op === 3 && ks.length > 1) { store().move(el, reg === r.a ? r.b : r.a); trace.push('mv') }
            else if (op === 4) { editText(el, 'E' + seed + '-' + step); trace.push('txt') }
            else if (op === 5) { kbMove(el, rnd(2) ? 'ArrowUp' : 'ArrowDown', 1 + rnd(2)); trace.push('kb') }
            else if (op === 6) { trace.push('pub'); await publishShown(r) }
            else if (op === 7) { await store().undo(); trace.push('undo') }
            else if (op === 8) { const before = pv(r); r = R(await S.reload()); trace.push('reload'); expect(pv(r), trace.join(' ')).toEqual(before) }
            await flush()
        }
        await publishShown(r)
        await freshShowsFile()
    }
    for (let seed = 1; seed <= 40; seed++) it('seed ' + seed, () => session(seed), 20000)
})
