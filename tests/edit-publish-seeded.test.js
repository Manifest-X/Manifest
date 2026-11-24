/**
 * @vitest-environment happy-dom
 *
 * Seeded random sessions (the round-3 review fuzzer): duplicate, delete, paste, move, text,
 * reorder, publish, undo and reload in .persist regions. Every written publish matches the
 * page; every reload shows the page as it was; the final source loads as the page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { editServer, twoRegions, editText, kbMove, flush, kids, regions as R, pageView as pv, publishShown, freshShowsFile, seeded } from './helpers/edit-sessions.js'

let S
beforeAll(async () => { S = await editServer() }, 15000)
afterAll(() => S && S.stop())

const store = () => S.store()
const T1 = 'Lorem ipsum dolor sit amet one', T2 = 'Lorem ipsum dolor sit amet two'

async function session(seed) {
    const rnd = seeded(seed)
    let r = R(await S.open(twoRegions('.persist')([`<p>${T1}</p>`, `<p>${T2}</p>`, '<h2>H</h2>', `<p>${T1}</p>`], ['<p>G</p>', `<p>${T2}</p>`])))
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
        else if (op === 6) { trace.push('pub'); await publishShown(S, r) }
        else if (op === 7) { await store().undo(); trace.push('undo') }
        else if (op === 8) { const before = pv(r); r = R(await S.reload()); trace.push('reload'); expect(pv(r), trace.join(' ')).toEqual(before) }
        await flush()
    }
    await publishShown(S, r)
    await freshShowsFile(S)
}

describe('seeded sessions', () => {
    for (let seed = 1; seed <= 120; seed++) it('seed ' + seed, () => session(seed), 20000)
})
