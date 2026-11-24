/**
 * @vitest-environment happy-dom
 *
 * The round-4 review id-oracle fuzzer: twin- and empty-heavy regions, user edits mixed with
 * publishes, undo, reloads and changes elsewhere (swaps, replacements, inserts, attribute
 * edits). After the final publish every identity's count in the source is within what the
 * user's own additions and removals allow (see edit-twin-identity.test.js).
 */
import { describe, it, beforeAll, afterAll } from 'vitest'
import { editServer, editText, kbMove, flush, kids, identitySession, seeded } from './helpers/edit-sessions.js'

let S
beforeAll(async () => { S = await editServer() }, 15000)
afterAll(() => S && S.stop())

const store = () => S.store()

describe('seeded twin sessions', () => {
    const sig = (l) => l.trim().replace(/\sdata-m="[^"]*"/, '')
    const OPS = ['dup', 'del', 'paste', 'mv', 'txt', 'kb', 'pub', 'undo', 'reload', 'ext', 'del', 'dup']
    async function fuzz(seed) {
        const rnd = seeded(seed)
        const t = await identitySession(S, ['<p data-m="a1">X</p>', '<p data-m="a2">X</p>', '<img data-m="a3">', '<img data-m="a4">', '<div data-m="a5"></div>', '<h2 data-m="a6">H</h2>'], ['<p data-m="b1">X</p>', '<img data-m="b2">', '<div data-m="b3"></div>'])
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
    // Seed 46: the page duplicates image a3, the source swaps the twins a3/a4, reload: reported, no copy of a4
    for (let seed = 1; seed <= 60; seed++) it('seed ' + seed, () => fuzz(seed), 20000)
})
