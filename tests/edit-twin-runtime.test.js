/**
 * @vitest-environment happy-dom
 *
 * Twin identity is the source's, never the live DOM's: attributes set at runtime (bound
 * :class, x-init setters, random popover ids) must not make unchanged twins look swapped
 * after a reload; real swaps in the source still resolve or are reported. From the
 * 2026-11-24 review probes of the twin-identity fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { editServer, twoRegions, editText, kbMove, flush, kids, ids, fileIds as fileIdsOf } from './helpers/edit-sessions.js'

let S
beforeAll(async () => { S = await editServer() }, 15000)
afterAll(() => S && S.stop())
const store = () => S.store()
const persist = twoRegions('.persist')
const R = (root) => ({ a: root.querySelector('#a'), b: root.querySelector('#b') })
const fileIds = () => fileIdsOf(S)
function extRegion(id, fn) {
    const f = S.file(), lines = f.split('\n')
    const s = lines.findIndex(l => l.includes(`<section id="${id}"`)), e = lines.findIndex((l, i) => i > s && l.includes('</section>'))
    S.ext(() => [...lines.slice(0, s + 1), ...fn(lines.slice(s + 1, e)), ...lines.slice(e)].join('\n'))
}
const swap = (x, y) => (ls) => { const i = ls.findIndex(l => l.includes(`data-m="${x}"`)), j = ls.findIndex(l => l.includes(`data-m="${y}"`)); const c = ls.slice(); [c[i], c[j]] = [c[j], c[i]]; return c }
const stripIds = () => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); try { const s = JSON.parse(localStorage.getItem(k)); if (s && s.log) { s.log.forEach(d => { delete d.ids; delete d.id }); localStorage.setItem(k, JSON.stringify(s)) } } catch { } } }
const T1 = 'Lorem ipsum dolor sit amet one', T2 = 'Lorem ipsum dolor sit amet two'

describe('runtime attributes on twins, no source change', () => {
    it('P1 :class bound to stored state that changes across the reload: the delete stays', async () => {
        localStorage.setItem('probe-k', 'x')
        const r = R(await S.open(persist(['<img data-m="1" :class="localStorage.getItem(\'probe-k\')">', '<img data-m="2" :class="localStorage.getItem(\'probe-k\')">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        localStorage.setItem('probe-k', 'x')
        store().remove(kids(r.a)[1]); await flush()
        localStorage.setItem('probe-k', 'y')
        const r2 = R(await S.reload())
        expect(store().conflicts).toEqual([])
        expect(ids(r2.a)).toEqual(['1', '3'])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('P1b a random attribute set by x-init: the delete stays', async () => {
        const r = R(await S.open(persist(['<div data-m="1" x-data x-init="$el.setAttribute(\'data-n\', Math.random())"></div>', '<div data-m="2" x-data x-init="$el.setAttribute(\'data-n\', Math.random())"></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        await S.reload()
        expect(store().conflicts).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('P1c a random popovertarget on a text twin: the text edit stays', async () => {
        const r = R(await S.open(persist([`<p data-m="1" x-data x-init="$el.setAttribute('popovertarget', 'dropdown-' + Math.random())">${T1}</p>`, `<p data-m="2">${T2}</p>`, '<h2 data-m="h">H</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[0], 'Edited one'); await flush()
        await S.reload()
        expect(store().conflicts).toEqual([])
        await store().publish()
        expect(S.file()).toContain('Edited one'); expect(S.file()).toContain(T2)
    })
    it('P1d a plain reorder of twins with a random attribute: the reorder stays', async () => {
        const r = R(await S.open(persist(['<div data-m="1" x-data x-init="$el.setAttribute(\'popovertarget\', Math.random())"></div>', '<div data-m="2"></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        kbMove(kids(r.a)[2], 'ArrowUp', 2); await flush()
        const r2 = R(await S.reload())
        expect(store().conflicts).toEqual([])
        expect(ids(r2.a)).toEqual(['3', '1', '2'])
        await store().publish()
        expect(fileIds().a).toEqual(['3', '1', '2'])
    })
    it('P11 a runtime attribute added after arming: the delete stays', async () => {
        const r = R(await S.open(persist(['<div data-m="1"><span>x</span></div>', '<div data-m="2"><span>x</span></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        kids(r.a)[0].setAttribute('data-late', '1')
        store().remove(kids(r.a)[1]); await flush()
        await S.reload()
        expect(store().conflicts).toEqual([])
        await store().publish(); expect(fileIds().a).toEqual(['1', '3'])
    })
    it('P1e a runtime attribute on twins that ARE swapped in the source: still found by content', async () => {
        const r = R(await S.open(persist(['<img data-m="1" x-data x-init="$el.setAttribute(\'data-n\', Math.random())">', '<img data-m="2" x-data x-init="$el.setAttribute(\'data-n\', Math.random())">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        extRegion('a', swap('1', '2'))
        const r2 = R(await S.reload())
        expect(store().conflicts).toEqual([])
        expect(ids(r2.a)).toEqual(['1', '3'])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
})

describe('twins across reloads (review probes)', () => {
    it('P2 text edit on twin A, delete twin B, no source change, reload', async () => {
        const r = R(await S.open(persist([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, '<h2 data-m="h">H</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[0], 'Edited one'); await flush()
        store().remove(kids(r.a)[1]); await flush()
        const r2 = R(await S.reload())
        expect(store().conflicts).toEqual([])
        expect(ids(r2.a)).toEqual(['1', 'h'])
        await store().publish()
        expect(fileIds().a).toEqual(['1', 'h']); expect(S.file()).toContain('Edited one')
    })
    it('P3 text edit on twin A, delete twin B, external swap, reload: twin B never survives as A', async () => {
        const r = R(await S.open(persist([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, '<h2 data-m="h">H</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[0], 'Edited one'); await flush()
        store().remove(kids(r.a)[1]); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().publish()
        expect(fileIds().a).not.toContain('2')
    })
    it('P4 move a twin to b, external swap in a, reload: image 1 never moves', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().move(kids(r.a)[1], r.b); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().publish()
        expect(fileIds().b.includes('1')).toBe(false)
    })
    it('P5 a log without ids (older), no source change, reload: the delete stays', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        stripIds()
        const r2 = R(await S.reload())
        expect(store().conflicts).toEqual([])
        expect(ids(r2.a)).toEqual(['1', '3'])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('P6 nested twins: delete an inner twin, inner twins swapped in the source', async () => {
        const r = R(await S.open(persist(['<div data-m="d1"><img data-m="i1"><img data-m="i2"></div>', '<div data-m="d2"><img data-m="i3"><img data-m="i4"></div>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[0].children[1]); await flush()
        S.ext(f => f.replace('<img data-m="i1"><img data-m="i2">', '<img data-m="i2"><img data-m="i1">'))
        await S.reload()
        await store().publish()
        expect(S.file()).toContain('data-m="i1"')
    })
    it('P7 nested templates: a duplicated block with x-if inside x-for keeps both', async () => {
        const doc = (body) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`
        const root = await S.open(doc(`    <section id="a" x-edit="a" x-data="{ items: [1,2] }">
        <div><template x-for="i in items"><div><template x-if="i > 1"><b x-text="i"></b></template><span>row</span></div></template></div>
        <p>Tail</p>
    </section>`))
        store().duplicate(kids(root.querySelector('#a'))[0])
        await new Promise(r => setTimeout(r, 50))
        await store().publish()
        const reg = S.file().match(/<section id="a"[\s\S]*?<\/section>/)[0]
        expect(reg.match(/<template x-for="i in items"><div><template x-if="i > 1"><b x-text="i"><\/b><\/template><span>row<\/span><\/div><\/template>/g).length).toBe(2)
    })
    it('P8 delete a twin, reload (no change), then an external swap, reload again', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[0]); await flush()
        await S.reload()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().publish()
        expect(fileIds().a).toEqual(['2', '3'])
    })
    it('P9 delete a twin, undo, external swap, reload, redo', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        await store().undo(); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().redo(); await flush()
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('P10 two of three twins deleted, external rotation, reload', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<img data-m="3">', '<p data-m="p">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[0]); await flush()
        store().remove(kids(r.a)[0]); await flush()
        extRegion('a', (ls) => [ls[2], ls[0], ls[1], ls[3]])
        await S.reload()
        await store().publish()
        const f = fileIds().a
        expect(f.includes('3') || f.length === 4).toBe(true)
    })
})

describe('twins the edits act on (re-review probes)', () => {
    it('Q1 a twin pasted into the other region, the twins swapped in the source, reload: the copy is of the twin copied', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().copy(kids(r.a)[1]); store().paste(kids(r.b)[0]); await flush()
        extRegion('a', swap('1', '2'))
        const r2 = R(await S.reload())
        expect(store().conflicts).toEqual([])
        expect(ids(r2.b)).toContain('2')
        await store().publish()
        expect(fileIds().b).not.toContain('1'); expect(fileIds().b).toContain('2')
    })
    it('Q2 a twin duplicated in place, the twins swapped in the source, reload: no copy of the other twin', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().duplicate(kids(r.a)[1]); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().publish()
        expect(fileIds().a.filter(x => x === '1').length).toBe(1)
    })
    it('Q3 a twin deleted, the OTHER twin changed in the source (a bystander), reload: the delete stays', async () => {
        const r = R(await S.open(persist(['<div data-m="1"><span>x</span></div>', '<div data-m="2"><span>x</span></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        S.ext(f => f.replace('<div data-m="1"><span>x</span></div>', '<div data-m="1" class="z"><span>x</span></div>'))
        await S.reload()
        expect(store().conflicts).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
        expect(S.file()).toContain('class="z"')
    })
    it('Q3b a twin deleted, a non-twin sibling changed in the source, reload: the delete stays', async () => {
        const r = R(await S.open(persist(['<div data-m="1"><span>x</span></div>', '<div data-m="2"><span>x</span></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        S.ext(f => f.replace('<p data-m="3">P</p>', '<p data-m="3" class="q">P</p>'))
        await S.reload()
        expect(store().conflicts).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('Q4 a text edit on a twin inside one of two cards, the cards swapped in the source: it stays in its card', async () => {
        const card = (m, body) => `<div data-m="${m}"><h3>Title</h3><span>${body}</span></div>`
        const r = R(await S.open(persist([card('c1', 'Alpha body text that is long'), card('c2', 'Beta body text that is long'), '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[0].querySelector('h3'), 'EditedA'); await flush()
        extRegion('a', swap('c1', 'c2'))
        await S.reload()
        await store().publish()
        expect(S.file()).toMatch(/data-m="c1"><h3>EditedA/)
        expect(S.file()).toMatch(/data-m="c2"><h3>Title/)
    })
    it('Q5 CRLF, entities and void twins: a delete persists unchanged', async () => {
        const html = persist(['<img data-m="1" alt="a &amp; b">', '<img data-m="2" alt="a &amp; b">', '<br data-m="4">', '<p data-m="3">P&nbsp;Q</p>'], ['<p data-m="g">G</p>']).replace(/\n/g, '\r\n')
        const r = R(await S.open(html))
        store().remove(kids(r.a)[1]); await flush()
        await S.reload()
        expect(store().conflicts).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '4', '3'])
    })
    it('Q6 a rebase publish over a newer file, then a twin deleted, the twins swapped, reload: never the other twin', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        S.ext(f => f.replace('<p data-m="g">G</p>', '<p data-m="g">G2</p>'))
        editText(kids(r.a)[2], 'P2'); await flush()
        await store().publish()
        await store().publish({ rebase: true })
        store().remove(kids(r.a)[1]); await flush()
        expect(JSON.stringify(store().export().log)).toContain('"ids"')
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
})
