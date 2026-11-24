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
const T1 = 'Lorem ipsum dolor sit amet one', T2 = 'Lorem ipsum dolor sit amet two', T3 = 'Lorem ipsum dolor sit amet three'

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
    // Known (master same): the twin <h3>s are identical, so nothing in the source tells them apart;
    // the edit follows the key into the other card.
    it.fails('Q4 a text edit on a twin inside one of two cards, the cards swapped in the source: it stays in its card', async () => {
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
    it('Q6 a rebase publish over an unrelated newer change, then a twin deleted, the twins swapped, reload: remapped', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        S.ext(f => f.replace('<p data-m="g">G</p>', '<p data-m="g">G2</p>'))
        editText(kids(r.a)[2], 'P2'); await flush()
        await store().publish()
        await store().publish({ rebase: true })
        store().remove(kids(r.a)[1]); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        expect(store().conflicts).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
})

const reg = (id) => S.file().match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))[0]
const conf = () => (store().conflicts || []).map(c => c.reason)

// Third review: no swap in the source means master's outcome; a swap is acted on only on evidence
describe('no swap: as master', () => {
    it('A a card holding a twin <h3> moved to region b, its <h3> edited, reload', async () => {
        const card = (m, body) => `<div data-m="${m}"><h3>Title</h3><span>${body}</span></div>`
        const r = R(await S.open(persist([card('c1', 'Alpha body'), card('c2', 'Beta body'), '<p data-m="3">P</p>'], ['<div data-m="g"><p>G</p></div>'])))
        const c1 = kids(r.a)[0]
        store().move(c1, r.b); await flush()
        editText(c1.querySelector('h3'), 'EditedA'); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(reg('b')).toContain('EditedA')
    })
    it('B a twin <h3> (distinct by attribute) moved into the other card, edited, reload', async () => {
        const r = R(await S.open(persist(['<div data-m="c1"><h3 data-m="h1">Title</h3></div>', '<div data-m="c2"><h3 data-m="h2">Title</h3><p>x</p></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        const [c1, c2] = kids(r.a), h1 = c1.querySelector('h3')
        store().move(h1, c2); await flush()
        editText(h1, 'EditedH1'); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(reg('a')).toMatch(/data-m="h1">EditedH1/)
    })
    it('B2 an identical twin <h3> moved into the other card, edited, reload: the edit stays on the moved one', async () => {
        const r = R(await S.open(persist(['<div data-m="c1"><h3>Title</h3></div>', '<div data-m="c2"><h3>Title</h3><p>x</p></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        const [c1, c2] = kids(r.a), h1 = c1.querySelector('h3')
        store().move(h1, c2); await flush()
        editText(h1, 'EditedH1'); await flush()
        await S.reload()
        await store().publish()
        expect(reg('a')).toMatch(/<div data-m="c2"><h3>Title<\/h3><p>x<\/p><h3>EditedH1<\/h3><\/div>/)
    })
    it('C twin containers: a child deleted, the source edits another child of the same container', async () => {
        const card = (m) => `<div data-m="${m}"><h3>Same title text for both</h3><p data-m="${m}p">Body</p><img data-m="${m}i"></div>`
        const r = R(await S.open(persist([card('c1'), card('c2'), '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[0].querySelector('img')); await flush()
        S.ext(f => f.replace('<p data-m="c1p">Body</p>', '<p data-m="c1p" class="new">Body</p>'))
        await S.reload()
        await store().publish()
        expect(reg('a')).not.toContain('data-m="c1i"'); expect(reg('a')).toContain('data-m="c2i"')
    })
    it('D a twin deleted whose own descendant changed in the source', async () => {
        const r = R(await S.open(persist(['<div data-m="1"><span>x</span></div>', '<div data-m="2"><span>x</span></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        S.ext(f => f.replace('<div data-m="2"><span>x</span></div>', '<div data-m="2"><span class="k">x</span></div>'))
        await S.reload()
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('D2 a text edit on a twin whose attribute changed in the source', async () => {
        const r = R(await S.open(persist(['<p data-m="1">Same</p>', '<p data-m="2">Same</p>', '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[1], 'Edited2'); await flush()
        S.ext(f => f.replace('<p data-m="2">Same</p>', '<p data-m="2" class="k">Same</p>'))
        await S.reload()
        await store().publish()
        expect(reg('a')).toMatch(/data-m="2" class="k">Edited2/)
    })
    it('F a whitespace reformat inside a twin, the twin deleted', async () => {
        const r = R(await S.open(persist(['<div data-m="1"><span>x</span></div>', '<div data-m="2"><span>x</span></div>', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        S.ext(f => f.replace('<div data-m="2"><span>x</span></div>', '<div data-m="2">\n            <span>x</span>\n        </div>'))
        await S.reload()
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('I twin 2 copied into b and g2 deleted there; the source adds a class to twin 2', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>', '<p data-m="g2">G2</p>'])))
        store().remove(kids(r.b)[1]); await flush()
        store().copy(kids(r.a)[1]); store().paste(kids(r.b)[0]); await flush()
        S.ext(f => f.replace('<img data-m="2">', '<img data-m="2" class="z">'))
        await S.reload()
        await store().publish()
        expect(fileIds().b).not.toContain('g2'); expect(fileIds().b).toContain('2')
    })
})

describe('swaps: acted on, or reported', () => {
    it('E twins swapped before a rebase publish, the page deletes its "2", reload: reported, "1" kept', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        extRegion('a', swap('1', '2'))
        editText(kids(r.a)[2], 'P2'); await flush()
        await store().publish()
        await store().publish({ rebase: true })
        store().remove(kids(r.a)[1]); await flush()
        await S.reload()
        expect(store().conflicts.some(c => c.prop === 'structure')).toBe(true)
        await store().publish()
        expect(fileIds().a).toContain('1')
    })
    it('G delete twin 2, swap, reload (remapped), undo, publish: both kept', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().undo(); await flush()
        await store().publish()
        expect(fileIds().a.sort()).toEqual(['1', '2', '3'])
    })
    it('H delete twin 2, swap, reload, swap back, reload', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('J a twin deleted and P reordered, twins swapped: reported, "1" kept', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        kbMove(kids(r.a)[1], 'ArrowUp', 1); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        expect(conf().length).toBeGreaterThan(0)
        await store().publish()
        expect(fileIds().a).toContain('1')
    })
    it('K a text edit on a twin, swapped in the source: never written onto the other', async () => {
        const r = R(await S.open(persist(['<p data-m="1">Same</p>', '<p data-m="2">Same</p>', '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[1], 'Edited2'); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().publish()
        expect(reg('a')).not.toMatch(/data-m="1">Edited2/)
    })
    it('L three twins, #3 deleted, the source rotated: remapped', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<img data-m="x">', '<p data-m="p">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[2]); await flush()
        extRegion('a', (ls) => [ls[2], ls[0], ls[1], ls[3]])
        await S.reload()
        await store().publish()
        expect(fileIds().a).toEqual(['1', '2', 'p'])
    })
    it('M twin #2 deleted, twin #1 moved to b, 1/3 swapped: reported, nothing wrong removed', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<img data-m="3">', '<p data-m="p">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        store().move(kids(r.a)[0], r.b); await flush()
        extRegion('a', swap('1', '3'))
        await S.reload()
        expect(conf().length).toBeGreaterThan(0)
        await store().publish()
        const f = fileIds()
        expect(f.a.concat(f.b).sort()).toEqual(['1', '2', '3', 'g', 'p'])
    })
})

// Fourth review: false conflicts removed; better-than-master outcomes kept
describe('rebase window and insertions (fourth review)', () => {
    const rebaseOverUnrelated = async (r) => {
        S.ext(f => f.replace('<p data-m="g">G</p>', '<p data-m="g">G2</p>'))
        editText(kids(r.a)[2], 'P2'); await flush()
        await store().publish(); await store().publish({ rebase: true })
    }
    it('N1 a rebase over an unrelated newer change, then a twin deleted, reload: the delete stays', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        await rebaseOverUnrelated(r)
        store().remove(kids(r.a)[1]); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('N1b a rebase over an unrelated newer change, then a twin text edit, reload: the edit stays', async () => {
        const r = R(await S.open(persist([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        await rebaseOverUnrelated(r)
        editText(kids(r.a)[1], 'EditedTwo'); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(reg('a')).toMatch(/data-m="2">EditedTwo/)
    })
    it('N1e an mnfst-run that sends no content ids: a rebase marks nothing unverifiable', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        const f0 = window.fetch
        window.fetch = (u, o) => f0(u, o).then(res => ({ ...res, json: () => res.json().then(j => { delete j.cids; return j }) }))
        try {
            await rebaseOverUnrelated(r)
            store().remove(kids(r.a)[1]); await flush()
            expect(JSON.stringify(store().export().log)).not.toContain('"unsure"')
            await S.reload()
        } finally { window.fetch = f0 }
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    it('N2 a twin text edit; the source edits it in place and inserts a copy of its old self: the edit stays', async () => {
        const r = R(await S.open(persist([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[0], 'EditedOne'); await flush()
        extRegion('a', (ls) => [ls[0].replace('<p data-m="1">', '<p data-m="1" class="z">'), ls[1], ls[0], ls[2]])
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(reg('a')).toMatch(/data-m="1" class="z">EditedOne/)
    })
    it('N2b identical twins: #2 edited; the source styles #2 and appends another: the edit stays', async () => {
        const r = R(await S.open(persist(['<p>Item item item item item item</p>', '<p>Item item item item item item</p>', '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[1], 'EditedTwo'); await flush()
        extRegion('a', (ls) => [ls[0], ls[1].replace('<p>', '<p class="z">'), ls[0], ls[2]])
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(reg('a')).toMatch(/<p class="z">EditedTwo/)
    })
    it('N3 a three-way rotation of twins, one deleted and another text-edited: both land on their own', async () => {
        const r = R(await S.open(persist([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, `<p data-m="x">${T3}</p>`, '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[0], 'EditedOne'); await flush()
        store().remove(kids(r.a)[1]); await flush()
        extRegion('a', (ls) => [ls[1], ls[2], ls[0], ls[3]])
        await S.reload()
        await store().publish()
        expect(fileIds().a).toEqual(['x', '1', '3'])
        expect(reg('a')).toMatch(/data-m="1">EditedOne/)
    })
    it('N4 a copy of a copy of twin 2 into b, the twins swapped: both copies are of twin 2', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().copy(kids(r.a)[1]); store().paste(kids(r.b)[0]); await flush()
        store().copy(kids(r.b)[1]); store().paste(kids(r.b)[1]); await flush()
        extRegion('a', swap('1', '2'))
        await S.reload()
        await store().publish()
        expect(fileIds().b).toEqual(['g', '2', '2'])
    })
    it('N11 another tab deletes twin 1; this tab edited twin 2: never written onto twin 3', async () => {
        const r = R(await S.open(persist([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, `<p data-m="x">${T3}</p>`, '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[1], 'EditedTwo'); await flush()
        S.ext(f => f.replace(`        <p data-m="1">${T1}</p>\n`, ''))
        await S.reload()
        await store().publish()
        expect(reg('a')).not.toMatch(/data-m="x">EditedTwo/)
        expect(reg('a')).toContain(T3)
    })
    it('N14 a twin text edit; the source rewrites the twins so the other holds its old text: never written over the new text', async () => {
        const r = R(await S.open(persist([`<p class="c">${T1}</p>`, `<p class="c">${T2}</p>`, '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        editText(kids(r.a)[0], 'EditedOne'); await flush()
        extRegion('a', (ls) => [ls[0].replace(T1, T3), ls[1].replace(T2, T1), ls[2]])
        await S.reload()
        await store().publish()
        expect(reg('a')).toContain(T3)
    })
    it('the base never arriving: replay goes ahead after the wait, positionally', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        const f0 = window.fetch
        let release
        window.fetch = (u, o) => String(u).includes('/__edit/base') ? new Promise(res => { release = () => { S.net.bases++; res({ ok: false, status: 500, json: () => Promise.resolve({}) }) } }) : f0(u, o)
        const t0 = Date.now()
        const load = S.reload()
        await new Promise(res => setTimeout(res, 4300))
        const page = ids(R(document.body).a)
        release(); await load
        window.fetch = f0
        expect(page).toEqual(['1', '3'])
        expect(Date.now() - t0).toBeLessThan(8000)
    }, 15000)
})

// Fifth review: the user's own published edit and in-place changes are no reorder; nothing is
// editable while the page waits for the base
describe('rebase window and the base wait (fifth review)', () => {
    const rebase = async (r, ext, edit) => {
        S.ext(ext)
        edit(); await flush()
        await store().publish(); await store().publish({ rebase: true })
    }
    const inB = (f) => f.replace('<p data-m="g">G</p>', '<p data-m="g">G2</p>')
    it('X1 a rebase whose own edit was on twin #1, then twin #2 deleted, reload: the delete stays', async () => {
        const r = R(await S.open(persist([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        await rebase(r, inB, () => editText(kids(r.a)[0], T1 + ' EDITED'))
        store().remove(kids(r.a)[1]); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3']); expect(reg('a')).toContain(T1 + ' EDITED')
    })
    it('X1d a rebase whose own edit was on twin #1, then twin #2 text-edited, reload: the edit stays', async () => {
        const r = R(await S.open(persist([`<p data-m="1">${T1}</p>`, `<p data-m="2">${T2}</p>`, '<h2 data-m="3">P</h2>'], ['<p data-m="g">G</p>'])))
        await rebase(r, inB, () => editText(kids(r.a)[0], T1 + ' EDITED'))
        editText(kids(r.a)[1], 'NewTwo'); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(reg('a')).toMatch(/data-m="2">NewTwo/)
    })
    it('X1e a rebase over a newer in-place change to twin #1, then twin #2 deleted, reload: the delete stays', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        await rebase(r, f => f.replace('<img data-m="1">', '<img data-m="1" class="z">'), () => editText(kids(r.a)[2], 'P2'))
        store().remove(kids(r.a)[1]); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '3'])
    })
    const delayedBase = async (fn) => {
        const f0 = window.fetch
        window.fetch = (u, o) => { const p = f0(u, o); return String(u).includes('/__edit/base') ? p.then(res => new Promise(ok => setTimeout(() => ok(res), 1000))) : p }
        try { return await fn() } finally { window.fetch = f0 }
    }
    it('B2 the base arrives late: the page arms with its pending edits, and an edit made then stays', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        await delayedBase(async () => {
            const r2 = R(await S.reload())
            expect(ids(r2.a)).toEqual(['1', '3'])
            store().remove(r2.a.querySelector('[data-m="3"]')); await flush()
            await new Promise(ok => setTimeout(ok, 1300))
            expect(ids(R(document.body).a)).toEqual(['1'])
        })
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1'])
    })
    it('B4 the base arrives late: twin #1 deleted after the pending delete of #2 replays', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<img data-m="x">', '<p data-m="3">P</p>'], ['<p data-m="g">G</p>'])))
        store().remove(kids(r.a)[1]); await flush()
        await delayedBase(async () => {
            const r2 = R(await S.reload())
            store().remove(kids(r2.a)[0]); await flush()
            await new Promise(ok => setTimeout(ok, 1300))
        })
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['x', '3'])
    })
})

// Sixth review: the user's own published structural edits are no reorder in the rebase window
describe('rebase window after own structural edits (sixth review)', () => {
    const bumpB = () => S.ext(f => f.replace('<p data-m="g">G</p>', '<p data-m="g">G2</p>'))
    const Ps = (xs) => xs.map(m => `<p data-m="${m}">Lorem ipsum dolor sit amet ${m}</p>`)
    const publishOver = async () => { await store().publish(); await store().publish({ rebase: true }) }
    const el = (m) => R(document.body).a.querySelector(`[data-m="${m}"]`)
    it('W1 own delete of twin #1 published, then twin 3 deleted, reload', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<img data-m="3">', '<h2 data-m="h">P</h2>'], ['<p data-m="g">G</p>'])))
        bumpB(); store().remove(kids(r.a)[0]); await flush(); await publishOver()
        store().remove(el('3')); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['2', 'h'])
    })
    it('W2 own duplicate of twin #1 published, then twin 2 deleted, reload', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<h2 data-m="h">P</h2>'], ['<p data-m="g">G</p>'])))
        bumpB(); store().duplicate(kids(r.a)[0]); await flush(); await publishOver()
        store().remove(el('2')); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['1', '1', 'h'])
    })
    it('W3 own reorder of twins published, then twin 1 deleted, reload', async () => {
        const r = R(await S.open(persist(['<img data-m="1">', '<img data-m="2">', '<img data-m="3">', '<h2 data-m="h">P</h2>'], ['<p data-m="g">G</p>'])))
        bumpB(); kbMove(kids(r.a)[1], 'ArrowUp', 1); await flush(); await publishOver()
        store().remove(el('1')); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['2', '3', 'h'])
    })
    it('W4 own delete of a text twin published, then twin 3 text-edited, reload', async () => {
        const r = R(await S.open(persist([...Ps(['1', '2', '3']), '<h2 data-m="h">P</h2>'], ['<p data-m="g">G</p>'])))
        bumpB(); store().remove(kids(r.a)[0]); await flush(); await publishOver()
        editText(el('3'), 'EditedThree'); await flush()
        await S.reload()
        expect(conf()).toEqual([])
        await store().publish()
        expect(fileIds().a).toEqual(['2', '3', 'h']); expect(reg('a')).toMatch(/data-m="3">EditedThree/)
    })
})

