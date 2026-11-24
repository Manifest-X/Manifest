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
import { editServer, twoRegions, editText, kbMove, flush } from './helpers/edit-sessions.js'

let S
beforeAll(async () => { S = await editServer() }, 15000)
afterAll(() => S && S.stop())

const store = () => S.store()
const persist = twoRegions('.persist')
const R = (root) => ({ a: root.querySelector('#a'), b: root.querySelector('#b') })
const kids = (reg) => [...reg.children].filter(c => !c.hasAttribute('data-edit-handle') && !c.hasAttribute('data-edit-ghost'))
const ids = (el) => kids(el).map(c => c.getAttribute('data-m') || '?')
const fileIds = () => { const d = new DOMParser().parseFromString(S.file(), 'text/html'); return { a: ids(d.getElementById('a')), b: ids(d.getElementById('b')) } }
const count = (list) => list.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {})

// One child per line: `fn` gets the region's lines and returns the new ones (or null)
function extRegion(id, fn) {
    const f = S.file(), lines = f.split('\n')
    const s = lines.findIndex(l => l.includes(`<section id="${id}"`)), e = lines.findIndex((l, i) => i > s && l.includes('</section>'))
    const next = fn(lines.slice(s + 1, e))
    if (!next) return false
    S.ext(() => [...lines.slice(0, s + 1), ...next, ...lines.slice(e)].join('\n'))
    return true
}

// A session that keeps the identity books: user additions/removals and changes elsewhere
async function session(a, b) {
    const t = { r: R(await S.open(persist(a, b))), init: count([...a, ...b].map(l => l.match(/data-m="([^"]+)"/)[1])), E: {}, Up: {}, Un: {}, alias: {} }
    const canon = (k) => t.alias[k] || k
    const page = () => count([...ids(t.r.a), ...ids(t.r.b)].map(canon))
    t.user = async (fn) => {
        const before = page(); const res = await fn(); const after = page()
        new Set([...Object.keys(after), ...Object.keys(before)]).forEach(k => { const d = (after[k] || 0) - (before[k] || 0); if (d > 0) t.Up[k] = (t.Up[k] || 0) + d; if (d < 0) t.Un[k] = (t.Un[k] || 0) + d })
        return res
    }
    t.ext = (id, fn) => extRegion(id, fn)
    t.added = (id) => { t.E[id] = (t.E[id] || 0) + 1 }
    t.removed = (id) => { t.E[canon(id)] = (t.E[canon(id)] || 0) - 1 }
    t.reload = async () => { t.r = R(await S.reload()) }
    // The final publish and the books
    t.check = async (opts) => {
        const res = await store().publish(opts)
        const fi = fileIds(), fc = count([...fi.a, ...fi.b].map(canon)), wrong = []
        new Set([...Object.keys(t.init), ...Object.keys(t.E), ...Object.keys(fc), ...Object.keys(t.Up)]).forEach(k => {
            const base = (t.init[k] || 0) + (t.E[k] || 0), lo = base + (t.Un[k] || 0), hi = base + (t.Up[k] || 0), got = fc[k] || 0
            if (got < Math.max(0, lo) || got > hi) wrong.push(`${k}: ${got} in the source, expected ${Math.max(0, lo)}..${hi}`)
        })
        expect(wrong, JSON.stringify({ file: fi, results: res.results })).toEqual([])
        return res
    }
    return t
}
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
    // Known bug (twin identity, WORK.md "Edit: twin identity by content"): with the reload, the
    // pending delete of image 2 resolves by position in the swapped source and removes image 1.
    for (const reload of [false, true]) {
        ;(reload ? it.fails : it)(`Q1/Q2 an image twin deleted, the twins swapped in the source${reload ? ', reload' : ''}`, async () => {
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

// The round-4 id-oracle fuzzer: twin- and empty-heavy regions, user edits mixed with
// publishes, undo, reloads and changes elsewhere (swaps, replacements, inserts, attribute edits).
describe('seeded twin sessions', () => {
    let rs = 1
    const rnd = (n) => { rs = (rs * 1103515245 + 12345) % 2147483648; return Math.floor(rs / 65536) % n }
    const sig = (l) => l.trim().replace(/\sdata-m="[^"]*"/, '')
    const OPS = ['dup', 'del', 'paste', 'mv', 'txt', 'kb', 'pub', 'undo', 'reload', 'ext', 'del', 'dup']
    async function fuzz(seed) {
        rs = seed * 104729
        const t = await session(['<p data-m="a1">X</p>', '<p data-m="a2">X</p>', '<img data-m="a3">', '<img data-m="a4">', '<div data-m="a5"></div>', '<h2 data-m="a6">H</h2>'], ['<p data-m="b1">X</p>', '<img data-m="b2">', '<div data-m="b3"></div>'])
        let newId = 0
        for (let step = 0; step < 10; step++) {
            const op = OPS[rnd(OPS.length)], reg = rnd(2) ? t.r.a : t.r.b, ks = kids(reg)
            if (!ks.length) continue
            const el = ks[rnd(ks.length)]
            if (op === 'dup') await t.user(() => store().duplicate(el))
            else if (op === 'del' && ks.length > 1) await t.user(() => store().remove(el))
            else if (op === 'paste') { store().copy(el); const o = rnd(2) ? t.r.a : t.r.b, ok = kids(o); const target = ok[rnd(ok.length)]; await t.user(() => store().paste(target)) }
            else if (op === 'mv' && ks.length > 1) { const dst = reg === t.r.a ? t.r.b : t.r.a, dk = kids(dst), before = dk[rnd(dk.length + 1)]; await t.user(() => store().move(el, dst, before)) }
            else if (op === 'txt') { if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') { const v = ['X', '', 'Y', 'X'][rnd(4)]; await t.user(() => editText(el, v)) } }
            else if (op === 'kb') { const d = rnd(2) ? 'ArrowUp' : 'ArrowDown', n = 1 + rnd(2); await t.user(() => kbMove(el, d, n)) }
            else if (op === 'pub') await store().publish()
            else if (op === 'undo') await t.user(() => store().undo())
            else if (op === 'reload') await t.reload()
            else if (op === 'ext') {
                const id = rnd(2) ? 'a' : 'b', kind = rnd(4)
                t.ext(id, (ls) => {
                    if (kind === 0) {
                        const pairs = []; ls.forEach((l, i) => ls.forEach((m, j) => { if (i < j && sig(l) === sig(m) && l !== m) pairs.push([i, j]) }))
                        if (!pairs.length) return null
                        const [i, j] = pairs[rnd(pairs.length)]; const c = ls.slice(); [c[i], c[j]] = [c[j], c[i]]; return c
                    }
                    if (kind === 1 && ls.length > 1) {
                        const i = rnd(ls.length), gone = ls[i].match(/data-m="([^"]+)"/)[1], nid = 'e' + (++newId)
                        const twin = ls[rnd(ls.length)].replace(/data-m="[^"]+"/, `data-m="${nid}"`), c = ls.slice()
                        c.splice(i, 1); c.splice(rnd(c.length + 1), 0, twin); t.removed(gone); t.added(nid); return c
                    }
                    if (kind === 2) { const nid = 'e' + (++newId), twin = ls[rnd(ls.length)].replace(/data-m="[^"]+"/, `data-m="${nid}"`), c = ls.slice(); c.splice(rnd(c.length + 1), 0, twin); t.added(nid); return c }
                    if (kind === 3 && ls.length > 1) { const i = rnd(ls.length), m = ls[i].match(/data-m="([^"]+)"/)[1], nid = 'e' + (++newId), c = ls.slice(); c[i] = c[i].replace(/data-m="[^"]+"/, `data-m="${nid}"`); t.alias[nid] = t.alias[m] || m; return c }
                    return null
                })
            }
            await flush()
        }
        await t.check()
    }
    for (let seed = 1; seed <= 60; seed++) it('seed ' + seed, () => fuzz(seed), 20000)
})
