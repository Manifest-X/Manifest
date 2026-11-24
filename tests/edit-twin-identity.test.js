/**
 * @vitest-environment happy-dom
 *
 * Twins (siblings sharing a tag and their first 24 characters, or with no text: images,
 * empty divs) through structural edits, reloads and source changes made underneath the page.
 * Every element carries a `data-m` identity; the oracle counts identities. After the final
 * publish each identity appears in the source between (its count in the source as changed
 * elsewhere, minus what the user removed of it) and (that, plus what the user added): an
 * edit may be refused or reported, but it never removes, copies or keeps the wrong element.
 * From the round-4 review probes (Q cases and the id-oracle fuzzer).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { editServer, editText, kbMove, kids, ids, fileIds as fileIdsOf, identitySession } from './helpers/edit-sessions.js'

let S
beforeAll(async () => { S = await editServer() }, 15000)
afterAll(() => S && S.stop())

const store = () => S.store()
const fileIds = () => fileIdsOf(S)
const session = (a, b) => identitySession(S, a, b)
const swap = (x, y) => (ls) => { const i = ls.findIndex(l => l.includes(`data-m="${x}"`)), j = ls.findIndex(l => l.includes(`data-m="${y}"`)); const c = ls.slice(); [c[i], c[j]] = [c[j], c[i]]; return c }
const IMG3 = ['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>']

describe('twins under source changes', () => {
    it('Q0 an image deleted, nothing changed elsewhere', async () => {
        const t = await session(IMG3, ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[1]))
        const res = await t.check()
        expect(res.results.map(x => x.status)).toEqual(['written'])
        expect(fileIds().a).toEqual(['1', '3'])
    })
    for (const reload of [false, true]) {
        it(`Q1/Q2 an image twin deleted, the twins swapped in the source${reload ? ', reload' : ''}`, async () => {
            const t = await session(IMG3, ['<p data-m="g">G</p>'])
            await t.user(() => store().remove(kids(t.r.a)[1]))
            t.ext('a', swap('1', '2'))
            if (reload) await t.reload()
            await t.check()
            await t.check({ rebase: true })
        })
    }
    it('Q3 an image deleted, another replaced in the source (count kept)', async () => {
        const t = await session(['<img data-m="1">', '<img data-m="2">', '<img data-m="3">', '<p data-m="p">P</p>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[1]))
        t.ext('a', (ls) => { const c = ls.filter(l => !l.includes('data-m="1"')); c.splice(c.length - 1, 0, '        <img data-m="9">'); return c }); t.removed('1'); t.added('9')
        await t.check()
        await t.check({ rebase: true })
    })
    it('Q4 empty div twins (classes differ): delete one, swapped in the source', async () => {
        const t = await session(['<div class="x" data-m="x"></div>', '<div class="y" data-m="y"></div>', '<p data-m="p">P</p>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[0]))
        t.ext('a', swap('x', 'y'))
        await t.check()
        await t.check({ rebase: true })
    })
    it('Q5 an image twin moved to the other region, swapped in the source', async () => {
        const t = await session(IMG3, ['<p data-m="g">G</p>'])
        await t.user(() => store().move(kids(t.r.a)[1], t.r.b))
        t.ext('a', swap('1', '2'))
        await t.check()
        await t.check({ rebase: true })
    })
    it('Q5b the same with a duplicate in the region', async () => {
        const t = await session([...IMG3, '<h2 data-m="h">H</h2>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().duplicate(kids(t.r.a)[2]))
        await t.user(() => store().move(kids(t.r.a)[1], t.r.b))
        t.ext('a', swap('1', '2'))
        await t.check()
        await t.check({ rebase: true })
    })
    it('Q6 same text, different inner markup (a vs span): delete one, swapped in the source', async () => {
        const t = await session(['<p data-m="1"><a href="/x">Go</a></p>', '<p data-m="2"><span>Go</span></p>', '<h2 data-m="h">H</h2>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[0]))
        t.ext('a', swap('1', '2'))
        await t.check()
        await t.check({ rebase: true })
    })
    it('Q9 a twin made by a published text edit, swapped in the source, then deleted', async () => {
        const t = await session(['<p data-m="1">A</p>', '<p data-m="2">B</p>', '<h2 data-m="h">H</h2>'], ['<p data-m="g">G</p>'])
        await t.user(() => editText(kids(t.r.a)[1], 'A'))
        await store().publish()
        await t.user(() => store().remove(kids(t.r.a)[1]))
        t.ext('a', swap('1', '2'))
        await t.check()
        await t.check({ rebase: true })
    })
    it('Q13 a duplicate published, the first image changed in the source, reload, delete the copy', async () => {
        const t = await session(['<img data-m="1">', '<p data-m="p">P</p>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().duplicate(kids(t.r.a)[0]))
        await store().publish()
        t.ext('a', (ls) => { const c = ls.slice(); c[0] = c[0].replace('data-m="1"', 'data-m="z"'); return c }); t.alias.z = '1'
        await t.reload()
        await t.user(() => store().remove(kids(t.r.a)[1]))
        await t.check()
    })
    it('Q16 a pending delete, the deleted element edited in the source', async () => {
        const t = await session(['<p data-m="1">A</p>', '<p data-m="2">B</p>', '<p data-m="3">C</p>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[1]))
        t.ext('a', (ls) => ls.map(l => l.replace('>B<', '>B edited<')))
        await t.check()
        await t.check({ rebase: true })
        expect(S.file()).toContain('B edited')
    })
    it('Q20 a twin deleted, the twins swapped in the source, reload: found by content, the page and the source lose that twin', async () => {
        const t = await session(IMG3, ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[1]))
        t.ext('a', swap('1', '2'))
        await t.reload()
        expect(ids(t.r.a)).toEqual(['1', '3'])
        expect(store().conflicts).toEqual([])
        expect((await t.check()).results.map(x => x.status)).toEqual(['written'])
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('Q21 the same with text twins (same first 24 characters)', async () => {
        const T1 = 'Lorem ipsum dolor sit amet one', T2 = 'Lorem ipsum dolor sit amet two'
        const t = await session(['<p data-m="a">A</p>', `<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`], ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[2]))
        t.ext('a', swap('1', '2'))
        await t.reload()
        expect(ids(t.r.a)).toEqual(['a', '1'])
        await t.check()
        expect(fileIds().a).toEqual(['a', '1'])
    })
    it('Q22 a twin deleted, the other twin replaced by a copy of it in the source, reload: no swap, as master', async () => {
        const t = await session(IMG3, ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[1]))
        t.ext('a', (ls) => ls.map(l => l.replace('data-m="1"', 'data-m="2"'))); t.removed('1'); t.added('2')
        await t.reload()
        await t.check()
    })
    it('Q22b the conflict for a swapped twin delete names it deleted, not moved', async () => {
        const t = await session(IMG3, ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[1]))
        await t.user(() => kbMove(kids(t.r.a)[1], 'ArrowUp', 1))
        t.ext('a', swap('1', '2'))
        await t.reload()
        expect(store().conflicts.some(c => /deleted IMG:#2/.test(c.reason) && !/moved IMG/.test(c.reason))).toBe(true)
        await t.check()
    })
    it('Q23 a text edit on a twin, the twins swapped in the source, reload: reported, never written over the other twin', async () => {
        const T1 = 'Lorem ipsum dolor sit amet one', T2 = 'Lorem ipsum dolor sit amet two'
        const t = await session([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, '<h2 data-m="h">H</h2>'], ['<p data-m="g">G</p>'])
        editText(kids(t.r.a)[0], 'Edited one')
        t.ext('a', swap('1', '2'))
        await t.reload()
        expect(store().conflicts.some(c => c.region === 'a' && c.prop === 'text')).toBe(true)
        await store().publish()
        expect(S.file()).toContain(T1); expect(S.file()).toContain(T2)
    })
})

describe('twins without source changes', () => {
    it('Q7 a pending text edit beside a delete publishes all of it', async () => {
        const t = await session(['<p data-m="1">A</p>', '<p data-m="2">B</p>', '<p data-m="3">C</p>'], ['<p data-m="g">G</p>'])
        editText(kids(t.r.a)[0], 'A2'); await t.user(() => store().remove(kids(t.r.a)[1])); editText(kids(t.r.a)[1], 'C2')
        const res = await t.check()
        expect(res.results.map(x => x.status)).toEqual(['written'])
        expect(S.file()).toMatch(/>A2<[\s\S]*>C2</)
    })
    it('Q8b a copy edited, then the original deleted, then reload', async () => {
        const t = await session(['<p data-m="1">A</p>', '<p data-m="2">B</p>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().duplicate(kids(t.r.a)[0])); editText(kids(t.r.a)[1], 'Z'); await t.user(() => store().remove(kids(t.r.a)[0]))
        await t.check()
        expect(S.file()).toContain('<p data-m="1">Z</p>')
    })
    it('Q10 deleting beside an x-text child is not refused', async () => {
        const t = await session(['<p data-m="1" x-text="\'hi\'">src</p>', '<p data-m="2">B</p>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[1]))
        expect((await t.check()).results.map(x => x.status)).toEqual(['written'])
        expect(S.file()).toContain(`x-text="'hi'">src</p>`)
    })
    it('Q11 entities survive a structural write', async () => {
        const t = await session(['<p data-m="1">a&mdash;b</p>', '<p data-m="2">a&nbsp;b &amp; c</p>', '<p data-m="3">C</p>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().remove(kids(t.r.a)[2]))
        expect((await t.check()).results.map(x => x.status)).toEqual(['written'])
        expect(S.file()).toContain('a&mdash;b'); expect(S.file()).toContain('a&nbsp;b &amp; c')
    })
    it('Q14 a pending text edit, reload, delete a sibling', async () => {
        const t = await session(['<p data-m="1">A</p>', '<p data-m="2">B</p>', '<p data-m="3">C</p>'], ['<p data-m="g">G</p>'])
        editText(kids(t.r.a)[0], 'A2')
        await t.reload()
        await t.user(() => store().remove(kids(t.r.a)[1]))
        expect((await t.check()).results.map(x => x.status)).toEqual(['written'])
        expect(fileIds().a).toEqual(['1', '3']); expect(S.file()).toContain('>A2<')
    })
    it('Q15 a pending text edit and a duplicate, reload, move the edited one away', async () => {
        const t = await session(['<p data-m="1">A</p>', '<p data-m="2">B</p>', '<p data-m="3">C</p>'], ['<p data-m="g">G</p>'])
        await t.user(() => store().duplicate(kids(t.r.a)[2])); editText(kids(t.r.a)[0], 'A2')
        await t.reload()
        await t.user(() => store().move(kids(t.r.a)[0], t.r.b))
        await t.check()
    })
    const gallery = [
        ['paste, then delete before it', (r) => { store().copy(kids(r.b)[0]); store().paste(kids(r.a)[0]); store().remove(kids(r.a)[2]) }],
        ['delete, then paste', (r) => { store().remove(kids(r.a)[0]); store().copy(kids(r.b)[0]); store().paste(kids(r.a)[1]) }],
        ['duplicate, then delete the original', (r) => { store().duplicate(kids(r.a)[1]); store().remove(kids(r.a)[0]) }],
        ['paste, delete, delete', (r) => { store().copy(kids(r.b)[0]); store().paste(kids(r.a)[2]); store().remove(kids(r.a)[1]); store().remove(kids(r.a)[0]) }],
        ['paste, delete twice after it', (r) => { store().copy(kids(r.b)[0]); store().paste(kids(r.a)[0]); store().remove(kids(r.a)[2]); store().remove(kids(r.a)[2]) }],
    ]
    const GAL = [['<img data-m="1">', '<img data-m="2">', '<img data-m="3">', '<h2 data-m="h">H</h2>'], ['<img data-m="4">', '<p data-m="g">G</p>']]
    for (const [name, act] of gallery) {
        it(`Q17 image gallery: ${name}; a reload shows the same images`, async () => {
            const t = await session(...GAL)
            await t.user(() => act(t.r))
            const want = ids(t.r.a)
            await t.reload()
            expect(ids(t.r.a)).toEqual(want)
            await t.check()
            expect(fileIds().a).toEqual(want)
        })
    }
    for (const k of [0, 1]) {
        it(`Q18 image gallery: paste, delete, delete, reload, delete the image at ${k}`, async () => {
            const t = await session(...GAL)
            await t.user(() => gallery[3][1](t.r))
            await t.reload()
            await t.user(() => store().remove(kids(t.r.a)[k]))
            const want = ids(t.r.a)
            await t.check()
            expect(fileIds().a).toEqual(want)
        })
    }
    it('Q19 same-text links: paste, delete, delete, reload, delete the second', async () => {
        const t = await session(['<p data-m="1"><a href="/a">More</a></p>', '<p data-m="2"><a href="/b">More</a></p>', '<p data-m="3"><a href="/c">More</a></p>', '<h2 data-m="h">H</h2>'], ['<p data-m="4"><a href="/d">More</a></p>', '<p data-m="g">G</p>'])
        await t.user(() => gallery[3][1](t.r))
        const want = ids(t.r.a)
        await t.reload()
        expect(ids(t.r.a)).toEqual(want)
        await t.user(() => store().remove(kids(t.r.a)[1]))
        const now = ids(t.r.a)
        await t.check()
        expect(fileIds().a).toEqual(now)
    })
    it('R1 moves, deletes and reorders among twins across a reload do not crash or poison the log', async () => {
        const t = await session(['<p data-m="a1">X</p>', '<p data-m="a2">X</p>', '<img data-m="a3">', '<img data-m="a4">', '<div data-m="a5"></div>', '<h2 data-m="a6">H</h2>'], ['<p data-m="b1">X</p>', '<img data-m="b2">', '<div data-m="b3"></div>'])
        await t.user(() => store().move(kids(t.r.b)[2], t.r.a, kids(t.r.a)[4]))
        await t.user(() => store().remove(kids(t.r.b)[1]))
        await t.user(() => kbMove(kids(t.r.a)[0], 'ArrowDown', 2))
        await t.user(() => store().remove(kids(t.r.a)[2]))
        t.ext('a', (ls) => { const c = ls.filter(l => !l.includes('data-m="a2"')); c.splice(c.length - 1, 0, '        <div data-m="e1"></div>'); return c }); t.removed('a2'); t.added('e1')
        await t.reload()
        await t.user(() => store().move(kids(t.r.a)[2], t.r.b, kids(t.r.b)[0]))
        await t.user(() => kbMove(kids(t.r.b)[0], 'ArrowUp', 1))
        await t.user(() => store().remove(kids(t.r.a)[0]))
        await t.check()
        await t.reload()
        await t.check()
    })
})
