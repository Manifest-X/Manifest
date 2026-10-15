/**
 * @vitest-environment happy-dom
 *
 * Publish round trips through the real source writer, in a module of their own so
 * no other test's Edit state (log, areas) reaches them: each test starts from an
 * empty log, checks the exact patches before posting, and leaves nothing pending.
 * The writer's inline allowlist, and publishing across SPA routes.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'
import { withBase } from './helpers/edit-base.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVE = path.join(__dirname, '../packages/run/serve.mjs')
const flush = () => new Promise(r => setTimeout(r, 0))
const frame = () => new Promise(r => setTimeout(r, 30))

let dir, proc, port
const page = (body) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-iso-'))
    writeFileSync(path.join(dir, 'index.html'), page(''))
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'iso' }))
    const ask = 52000 + Math.floor(Math.random() * 4000)
    proc = spawn(process.execPath, [SERVE, dir, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(ask)], { stdio: ['ignore', 'pipe', 'pipe'] })
    port = await new Promise((resolve, reject) => {
        let out = ''
        const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000)
        const scan = c => { out += c; const m = out.match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]) } }
        proc.stdout.on('data', scan); proc.stderr.on('data', scan)
    })
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    new Function(EDIT_SRC)()
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))
    Alpine.store('edit').onPublish = (patches) => post(patches)
}, 15000)

afterAll(() => { try { proc.kill() } catch { } try { rmSync(dir, { recursive: true, force: true }) } catch { } })
// Every test starts clean and must leave nothing pending
beforeEach(() => { expect(store().export().log, 'log left by an earlier test').toEqual([]) })
afterEach(() => { document.body.innerHTML = ''; localStorage.clear() })

async function post(patches) {
    const body = JSON.stringify(await withBase(port, patches))
    return new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port, path: '/__edit/save', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Origin: `http://localhost:${port}` } }, res => {
            let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
        })
        req.on('error', reject); req.end(body)
    })
}
const store = () => Alpine.store('edit')
const log = () => store().export().log
async function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    await flush(); await flush()
    return root
}
const regionSource = () => { const s = readFileSync(path.join(dir, 'index.html'), 'utf8'); return s.slice(s.indexOf('<body>') + 7, s.indexOf('</body>')).trim() }
const editText = (el, value) => { el.dispatchEvent(new Event('focus')); el.innerHTML = value; el.dispatchEvent(new Event('blur')) }
const statuses = (res) => res.results.map(r => r.status)

describe('live reload around our own publishes', () => {
    const reloadEvent = (files) => { const e = new CustomEvent('manifest:live-reload', { cancelable: true, detail: { files } }); window.dispatchEvent(e); return e.defaultPrevented }
    let realFetch, reload, realReload
    const loc = window.location
    beforeEach(() => { store().onPublish = null; realFetch = window.fetch; reload = vi.fn(); realReload = loc.reload; try { loc.reload = reload } catch { } })
    afterEach(() => { window.fetch = realFetch; try { loc.reload = realReload } catch { } store().onPublish = (patches) => post(patches) })

    it('the reload our publish triggers is skipped; other changes, or later ones, still reload', async () => {
        const root = await mount(`<section x-edit="lr1"><p>One</p></section>`)
        const p = root.querySelector('p')
        editText(p, 'Uno')
        let answer
        window.fetch = vi.fn((url) => String(url).includes('/__edit/base') ? Promise.resolve({ ok: true, json: async () => ({ files: { 'index.html': 'h0' }, ids: { 'index.html': {} } }) }) : new Promise(r => { answer = r }))
        const done = store().publish()
        await flush()
        expect(reloadEvent([{ rel: 'index.html', hash: 'h1' }])).toBe(true)          // in flight: held
        answer({ json: () => ({ results: [{ region: 'lr1', status: 'written', file: 'index.html' }], base: { 'index.html': 'h1' } }) })
        await done; await flush()
        expect(reload).not.toHaveBeenCalled()
        expect(reloadEvent([{ rel: 'index.html', hash: 'h1' }])).toBe(true)          // ours, just after
        expect(reloadEvent([{ rel: 'index.html', hash: 'other' }])).toBe(false)      // someone else's change
        expect(reloadEvent([{ rel: 'index.html', hash: 'h1' }, { rel: 'about.html', hash: 'x' }])).toBe(false)
        // An external change arriving during a publish reloads once the answer is in
        editText(p, 'Eins')
        const again = store().publish()
        await flush()
        expect(reloadEvent([{ rel: 'about.html', hash: 'z' }])).toBe(true)
        answer({ json: () => ({ results: [] }) })
        await again; await flush()
        expect(loc.reload).toBe(reload)
        expect(reload).toHaveBeenCalledTimes(1)
    })

    it('after a rebase publish the page re-reads the source: the next reload is not skipped, and with none coming it reloads itself', async () => {
        const root = await mount(`<section x-edit="lr2"><p>One</p></section>`)
        editText(root.querySelector('p'), 'Uno')
        window.fetch = vi.fn(async (url) => String(url).includes('/__edit/base')
            ? { ok: true, json: async () => ({ files: { 'index.html': 'b2' }, ids: { 'index.html': {} } }) }
            : { json: async () => ({ results: [{ region: 'lr2', status: 'written', file: 'index.html' }], base: { 'index.html': 'h2' } }) })
        await store().publish({ rebase: true })
        await flush()
        expect(reloadEvent([{ rel: 'index.html', hash: 'h2' }])).toBe(false)         // our write, but over a source the page never loaded
        expect(reload).not.toHaveBeenCalled()
        await new Promise(r => setTimeout(r, 1600))
        expect(reload).toHaveBeenCalledTimes(1)                                       // no live reload arrived: the page reloads itself
    })

    it('a reload that would lose unpersisted edits is held back, and says so', async () => {
        const root = await mount(`<section x-edit="lr3"><p>One</p></section>`)
        editText(root.querySelector('p'), 'Uno')
        const stale = []
        const onStale = (e) => stale.push(e.detail.files)
        document.addEventListener('edit:stale', onStale)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        expect(reloadEvent([{ rel: 'index.html', hash: 'ext' }])).toBe(true)
        const said = warn.mock.calls.map(c => String(c[0])).join('\n')
        warn.mockRestore(); document.removeEventListener('edit:stale', onStale)
        expect(said).toMatch(/would lose unpublished edits/)
        expect(stale).toEqual([['index.html']])
        expect(store().stale).toContain('index.html')
        expect(reload).not.toHaveBeenCalled()
        store().onPublish = () => ({ results: [{ region: 'lr3', status: 'written' }] })   // leave nothing pending
        await store().publish()
        expect(reload).toHaveBeenCalledTimes(1)                                         // the held reload is taken once nothing would be lost
        store().stale = []
    })

    it('undone steps never hold a reload back; unpersisted edits do, even when their region is not mounted', async () => {
        const root = await mount(`<section x-edit="lr4"><p>One</p></section><section x-edit="lr5"><p>Two</p></section>`)
        editText(root.querySelector('[x-edit="lr4"] p'), 'Uno')
        await store().undo()
        expect(reloadEvent([{ rel: 'index.html', hash: 'ext1' }])).toBe(false)        // only an undone step: the reload goes
        await store().redo()
        expect(reloadEvent([{ rel: 'index.html', hash: 'ext2' }])).toBe(true)         // applied and unpersisted: held
        root.querySelector('[x-edit="lr4"]').remove()                                 // its region leaves the page (x-if, a route)
        await flush()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        expect(reloadEvent([{ rel: 'index.html', hash: 'ext3' }])).toBe(true)          // still this document's unpublished edit: held
        warn.mockRestore()
        expect(reload).not.toHaveBeenCalled()
        // Back on the page, published: nothing left pending
        await mount(`<section x-edit="lr4"><p>One</p></section>`)
        store().onPublish = (patches) => ({ results: patches.map(p => ({ region: p.region, status: 'written' })) })
        await store().publish()
    })

    it('typing in a focused leaf holds a reload (unpersisted) or is committed first (persisted); a publish takes it along', async () => {
        const root = await mount(`<section x-edit="lr6"><p>One</p></section><section x-edit.persist="lr7"><p>Two</p></section>`)
        const [one, two] = root.querySelectorAll('p')
        two.focus(); two.firstChild.nodeValue = 'Two typed'
        expect(reloadEvent([{ rel: 'index.html', hash: 'e1' }])).toBe(false)          // committed and persisted: nothing is lost
        expect(log().map(d => d.value)).toEqual(['Two typed'])
        one.focus(); one.firstChild.nodeValue = 'One typed'
        expect(reloadEvent([{ rel: 'index.html', hash: 'e2' }])).toBe(true)           // unpersisted typing: held
        expect(log().map(d => d.value)).toEqual(['Two typed'])
        let sent = null
        store().onPublish = (patches) => { sent = patches; return { results: patches.map(p => ({ region: p.region, status: 'written' })) } }
        await store().publish()
        expect(JSON.stringify(sent)).toContain('One typed')                             // the typing went with the publish
        await flush(); await flush()
        expect(reload).toHaveBeenCalledTimes(1)                                         // the held reload, once nothing would be lost (an untouched one is the live script's to take)
        one.blur(); two.blur()
    })
})

describe('source writer allowlist', () => {
    const INLINE = '<a href="/x">a</a> <abbr title="t">abbr</abbr> <b>b</b> <bdi>bdi</bdi> <bdo dir="rtl">bdo</bdo> <cite>cite</cite> <code>code</code> <data value="7">data</data> <del>del</del> <dfn title="d">dfn</dfn> <em>em</em> <i>i</i> <ins>ins</ins> <kbd>kbd</kbd> <mark>mark</mark> <q>q</q> <s>s</s> <samp>samp</samp> <small>small</small> <span>span</span> <strong>strong</strong> <sub>sub</sub> <sup>sup</sup> <time datetime="2026-10-15">time</time> <u>u</u> <var>var</var> x<wbr>y<br>z'

    it('every inline tag Rich Text makes survives client sanitize, publish and the written source', async () => {
        const body = `<section x-edit="f1"><p>One</p><p>Two</p></section>`
        writeFileSync(path.join(dir, 'index.html'), page(body))
        const root = await mount(body)
        editText(root.querySelector('p'), INLINE)
        expect(log().at(-1).value).toBe(INLINE)
        expect(store().patches()).toEqual([{ kind: 'static-tree', region: 'f1', tree: { key: '@f1@SECTION:OneTwo', path: true, children: [{ key: '@f1@P:One', at: '0', edits: { text: INLINE } }] } }])
        const res = await store().publish()
        expect(statuses(res), JSON.stringify(res)).toEqual(['written'])
        expect(regionSource()).toBe(`<section x-edit="f1"><p>${INLINE}</p><p>Two</p></section>`)
    })

    it('anything else is refused by the writer even when a client sends it', async () => {
        const body = `<section x-edit="f2"><p>One</p></section>`
        const send = (t) => post([{ kind: 'static-tree', region: 'f2', tree: { key: '', children: [{ key: '@f2@P:One', at: '0', edits: { text: t } }] } }])
        writeFileSync(path.join(dir, 'index.html'), page(body))
        const hostile = '<script>bad()</script><iframe src="//e"></iframe><div onclick="x()">d</div>'
            + '<a href="javascript:alert(1)" onmouseover="x()">a</a><abbr title="ok" class="c" style="color: red">ab</abbr>'
            + '<bdo dir="sideways">bd</bdo><data value="javascript:x" id="i">da</data><time datetime="1" title="no">t</time>'
            + '<img src="x" onerror="alert(1)"><svg><script>bad()</script></svg><form action="/x">f</form><dfn data-x="1">df</dfn>'
        const res = await send(hostile)
        expect(statuses(res), JSON.stringify(res)).toEqual(['written'])
        expect(regionSource()).toBe('<section x-edit="f2"><p>d<a>a</a><abbr title="ok" style="color: red">ab</abbr><bdo>bd</bdo><data>da</data><time datetime="1">t</time><img src="x"><dfn>df</dfn></p></section>')
        // A block that cannot sit in the leaf: nothing is written
        writeFileSync(path.join(dir, 'index.html'), page(body))
        const block = await send('<h1>Big</h1>')
        expect(block.results.map(r => r.status)).toEqual(['error'])
        expect(regionSource()).toBe(body)
    })
})

describe('SPA routes', () => {
    const go = async (path, onA, root) => {
        history.pushState({}, '', path)
        Alpine.$data(root.firstElementChild).onA = onA
        await flush(); await flush()
        window.dispatchEvent(new CustomEvent('manifest:route-change', { detail: { normalizedPath: path } }))
        await flush(); await flush()
    }
    const stored = (path) => JSON.parse(localStorage.getItem('mnfst-edit-log:' + path) || 'null')

    it('a publish from another route writes what is mounted, keeps an unmounted region\'s edits pending, and loses nothing', async () => {
        const body = `<div x-data="{ onA: true }"><section x-edit.persist="ra"><p>A text</p></section><template x-if="onA"><section x-edit.persist="rc"><p>C text</p></section></template><section x-edit.persist="rb"><p>B text</p></section></div>`
        writeFileSync(path.join(dir, 'index.html'), page(body))
        history.pushState({}, '', '/a')
        const root = await mount(body)
        await flush()
        editText(root.querySelector('[x-edit\\.persist="ra"] p'), 'A edited')
        editText(root.querySelector('[x-edit\\.persist="rc"] p'), 'C edited')
        // Route B: the region rendered by x-if is gone
        await go('/b', false, root)
        expect(root.querySelector('[x-edit\\.persist="rc"]')).toBe(null)
        editText(root.querySelector('[x-edit\\.persist="rb"] p'), 'B edited')
        expect(stored('/a').log.length).toBe(3)                           // every path of this page holds the same log
        expect(stored('/b').log.length).toBe(3)
        const patches = store().patches()
        expect(patches.map(p => p.region).sort()).toEqual(['ra', 'rb'])
        const res = await store().publish()
        expect(statuses(res), JSON.stringify(res)).toEqual(['written', 'written'])
        expect(regionSource()).toBe(body.replace('A text', 'A edited').replace('B text', 'B edited'))
        // C's edit stays pending, in memory and under both paths
        expect(store().export().log.map(d => d.region)).toEqual(['rc'])
        expect(stored('/a').log.map(d => d.region)).toEqual(['rc'])
        expect(stored('/b').log.map(d => d.region)).toEqual(['rc'])
        // Back on A: the remounted region shows its edit, and the next publish writes it
        await go('/a', true, root)
        await new Promise(r => setTimeout(r, 30))
        expect(root.querySelector('[x-edit\\.persist="rc"] p').textContent).toBe('C edited')
        const again = await store().publish()
        expect(statuses(again), JSON.stringify(again)).toEqual(['written'])
        expect(regionSource()).toBe(body.replace('A text', 'A edited').replace('B text', 'B edited').replace('C text', 'C edited'))
        expect(stored('/a')).toBe(null)
        expect(stored('/b')).toBe(null)
        history.pushState({}, '', '/')
    })
})

describe('edits whose element changed in the source', () => {
    it('are surfaced ($edit.conflicts, edit:conflict, a warning), kept out of patches and dropped from the log', async () => {
        const body = `<section x-edit.persist="cf"><p>Beta text</p><p>Gamma</p></section>`
        const root = await mount(body)
        const [beta, gamma] = root.querySelectorAll('p')
        editText(beta, 'Beta edited')
        editText(gamma, 'Gamma edited')
        // An external change rewrites the edited paragraph, then the page reloads
        document.body.innerHTML = ''
        const events = [], onConflict = (e) => events.push(e.detail)
        document.addEventListener('edit:conflict', onConflict)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        new Function(EDIT_SRC)()
        await flush()
        const fresh = await mount(body.replace('Beta text', 'Beta external'))
        await new Promise(r => setTimeout(r, 600))
        const said = warn.mock.calls.map(c => String(c[0])).join('\n')
        warn.mockRestore(); document.removeEventListener('edit:conflict', onConflict)
        const conflict = { region: 'cf', key: '@cf@P:Beta text', element: 'P:Beta text', prop: 'text', value: 'Beta edited', before: 'Beta text', reason: 'P:Beta text changed in the source, so the text edited into it was not applied' }
        expect(store().conflicts).toEqual([conflict])
        expect(events).toEqual([{ conflicts: [conflict] }])
        expect(said).toMatch(/changed in the source were dropped/)
        expect(fresh.querySelectorAll('p')[0].textContent).toBe('Beta external')
        expect(fresh.querySelectorAll('p')[1].textContent).toBe('Gamma edited')
        expect(log().map(d => d.path)).toEqual(['@cf@P:Gamma'])
        expect(JSON.stringify(store().patches())).not.toMatch(/Beta edited|@cf@P:Beta/)
        store().onPublish = () => ({ results: [{ region: 'cf', status: 'written' }] })
        await store().publish()
    })

    it('a reorder naming an element that changed is dropped with it: nothing is left that the writer must refuse', async () => {
        const body = `<section x-edit.persist="cf2"><p>Alpha</p><p>Beta text</p><p>Gamma</p></section>`
        writeFileSync(path.join(dir, 'index.html'), page(body))
        const root = await mount(body)
        const [, beta] = root.querySelectorAll('p')
        beta.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
        await flush()
        expect(log().map(d => d.kind)).toEqual(['st-order'])
        // An external change rewrites the moved paragraph, then the page reloads
        const changed = body.replace('Beta text', 'Beta external')
        writeFileSync(path.join(dir, 'index.html'), page(changed))
        document.body.innerHTML = ''
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        new Function(EDIT_SRC)()
        await flush()
        const fresh = await mount(changed)
        await new Promise(r => setTimeout(r, 600))
        warn.mockRestore()
        expect(store().conflicts.filter(c => c.region === 'cf2')).toEqual([{ region: 'cf2', key: '', element: 'cf2', prop: 'structure', before: null,
            value: { changed: [{ was: 'P:Beta text', now: 'P:Beta external' }], moved: ['P:Beta text'], copies: [] },
            reason: 'P:Beta text changed in the source where the layout was edited, so the layout edits (moved P:Beta text) were not applied' }])
        expect(log()).toEqual([])
        expect([...fresh.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Alpha', 'Beta external', 'Gamma'])
        store().onPublish = (patches) => post(patches)
        const res = await store().publish()
        expect(res.results).toEqual([])
        expect(regionSource()).toBe(changed)
    })
})

describe('reloads, keyed regions and lasting conflicts', () => {
    const reloadWith = async (html) => {
        document.body.innerHTML = ''
        new Function(EDIT_SRC)()
        await flush()
        const root = await mount(html)
        await new Promise(r => setTimeout(r, 600))
        store().onPublish = (patches) => post(patches)
        return root
    }
    const done = async () => { store().onPublish = (patches) => ({ results: patches.map(p => ({ region: p.region, status: 'written' })) }); await store().publish(); store().onPublish = (patches) => post(patches) }

    it('a gated .persist region keeps its edits across reloads: a region is judged only once keyed', async () => {
        store().clearConflicts()
        const body = `<section x-edit.gated.persist="gq"><p>Gated</p></section>`
        let root = await mount(body)
        store().on(); await flush(); await flush()
        editText(root.querySelector('p'), 'Gated edited')
        for (let i = 0; i < 2; i++) {
            root = await reloadWith(body)
            expect(store().conflicts).toEqual([])
            expect(log().map(d => d.value)).toEqual(['Gated edited'])
            expect(root.querySelector('p').textContent).toBe('Gated')
            store().on(); await flush(); await flush()
            expect(root.querySelector('p').textContent).toBe('Gated edited')
            expect(store().conflicts).toEqual([])
        }
        await done()
        store().off()
    })

    it('conflicts of .persist regions last across reloads until clearConflicts()', async () => {
        const body = `<section x-edit.persist="cq"><p>Beta text</p></section>`
        let root = await mount(body)
        editText(root.querySelector('p'), 'Beta edited')
        const changed = body.replace('Beta text', 'Beta external')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        root = await reloadWith(changed)
        expect(store().conflicts.map(c => c.value)).toEqual(['Beta edited'])
        root = await reloadWith(changed)
        warn.mockRestore()
        expect(store().conflicts.map(c => c.value)).toEqual(['Beta edited'])          // still there after another reload
        store().clearConflicts()
        expect(store().conflicts).toEqual([])
        root = await reloadWith(changed)
        expect(store().conflicts).toEqual([])
        expect(localStorage.getItem('mnfst-edit-log:' + location.pathname)).toBe(null)
    })

    it('a reorder survives a sibling\'s text changing in place; the writer agrees', async () => {
        const body = `<section x-edit.persist="ro"><p>First line</p><p>Second line</p><p>Third line</p></section>`
        writeFileSync(path.join(dir, 'index.html'), page(body))
        let root = await mount(body)
        const [p1, , p3] = root.querySelectorAll('p')
        store().move(p3, root.querySelector('section'), p1)
        const changed = body.replace('Second line', 'Second CHANGED')
        writeFileSync(path.join(dir, 'index.html'), page(changed))
        root = await reloadWith(changed)
        expect([...root.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Third line', 'First line', 'Second CHANGED'])
        expect(store().conflicts).toEqual([])
        store().onPublish = (patches) => post(patches)
        const res = await store().publish()
        expect(statuses(res), JSON.stringify(res)).toEqual(['written'])
        expect(regionSource()).toBe(`<section x-edit.persist="ro"><p>Third line</p><p>First line</p><p>Second CHANGED</p></section>`)
    })

    it('a move and a typed copy survive when the copied element\'s own text changes in the source', async () => {
        store().clearConflicts()
        const body = `<section x-edit.persist="w2"><p>Alpha</p><p>Beta</p><p>Gamma</p></section>`
        writeFileSync(path.join(dir, 'index.html'), page(body))
        let root = await mount(body)
        const sec = root.querySelector('section'), P = (t) => [...sec.querySelectorAll('p')].find(p => p.textContent === t)
        store().move(P('Gamma'), sec, P('Alpha'))
        store().duplicate(P('Beta')); await flush()
        editText([...sec.querySelectorAll('p')].filter(p => p.textContent === 'Beta')[1], 'Copy typed text')
        const changed = body.replace('<p>Beta</p>', '<p>Beta external</p>')
        writeFileSync(path.join(dir, 'index.html'), page(changed))
        root = await reloadWith(changed)
        expect([...root.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Gamma', 'Alpha', 'Beta external', 'Copy typed text'])
        expect(store().conflicts).toEqual([])
        const res = await store().publish()
        expect(statuses(res), JSON.stringify(res)).toEqual(['written'])
        expect(regionSource()).toBe(`<section x-edit.persist="w2"><p>Gamma</p><p>Alpha</p><p>Beta external</p><p>Copy typed text</p></section>`)
    })

    it('a layout edit that moved a changed element is dropped with its content in the conflict, and the warning names it', async () => {
        store().clearConflicts()
        const body = `<section x-edit.persist="w3"><p>Alpha</p><p>Beta</p><p>Gamma</p></section>`
        let root = await mount(body)
        const sec = root.querySelector('section'), P = (t) => [...sec.querySelectorAll('p')].find(p => p.textContent === t)
        store().move(P('Beta'), sec, P('Alpha'))
        store().duplicate(P('Gamma')); await flush()
        editText([...sec.querySelectorAll('p')].filter(p => p.textContent === 'Gamma')[1], 'Copy typed text')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        root = await reloadWith(body.replace('<p>Beta</p>', '<p>Beta external</p>'))
        const said = warn.mock.calls.map(c => String(c[0])).join('\n')
        warn.mockRestore()
        const [c] = store().conflicts
        expect(c).toMatchObject({ region: 'w3', prop: 'structure', value: { changed: [{ was: 'P:Beta', now: 'P:Beta external' }], moved: ['P:Beta'] } })
        expect(c.value.copies).toEqual([{ of: 'P:Gamma', html: expect.stringContaining('Gamma'), text: 'Copy typed text' }])
        expect(c.reason).toMatch(/moved P:Beta; copied P:Gamma \("Copy typed text"\)/)
        expect(said).toMatch(/Copy typed text/)
        expect(log()).toEqual([])
        store().clearConflicts()
    })

    it('a swap that looks like two renames by position is a conflict, never a copy bound to the wrong element', async () => {
        for (const dup of [false, true]) {
            store().clearConflicts()
            const region = dup ? 'sw2' : 'sw1'
            const body = `<section x-edit.persist="${region}"><p>Alpha</p><p>Beta</p><p>Gamma</p></section>`
            writeFileSync(path.join(dir, 'index.html'), page(body))
            let root = await mount(body)
            const sec = root.querySelector('section'), P = (t) => [...sec.querySelectorAll('p')].find(p => p.textContent === t)
            store().move(P('Gamma'), sec, P('Alpha'))
            if (dup) { store().duplicate(P('Alpha')); await flush() }
            const changed = body.replace('<p>Alpha</p><p>Beta</p>', '<p>Beta</p><p>Alpha changed</p>')
            writeFileSync(path.join(dir, 'index.html'), page(changed))
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
            root = await reloadWith(changed)
            warn.mockRestore()
            expect([...root.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Beta', 'Alpha changed', 'Gamma'])
            const [c] = store().conflicts
            expect(c).toMatchObject({ region, prop: 'structure', value: { changed: [{ was: 'P:Alpha', now: 'P:Beta' }, { was: 'P:Beta', now: 'P:Alpha changed' }], moved: ['P:Gamma'] } })
            expect(c.value.copies.map(x => x.text)).toEqual(dup ? ['Alpha'] : [])
            expect(log()).toEqual([])
            expect((await store().publish()).results).toEqual([])
            expect(regionSource()).toBe(changed)
        }
        store().clearConflicts()
    })

    it('an untyped copy of an element renamed in place follows its new source text, as the writer copies it', async () => {
        const body = `<section x-edit.persist="cp1"><p>Alpha</p><p>Beta</p><p>Gamma</p></section>`
        writeFileSync(path.join(dir, 'index.html'), page(body))
        let root = await mount(body)
        const sec = root.querySelector('section'), P = (t) => [...sec.querySelectorAll('p')].find(p => p.textContent === t)
        store().move(P('Gamma'), sec, P('Alpha'))
        store().duplicate(P('Alpha')); await flush()
        const changed = body.replace('<p>Alpha</p>', '<p>Alpha changed</p>')
        writeFileSync(path.join(dir, 'index.html'), page(changed))
        root = await reloadWith(changed)
        expect([...root.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Gamma', 'Alpha changed', 'Alpha changed', 'Beta'])
        expect(store().conflicts).toEqual([])
        const res = await store().publish()
        expect(statuses(res), JSON.stringify(res)).toEqual(['written'])
        expect(regionSource()).toBe(`<section x-edit.persist="cp1"><p>Gamma</p><p>Alpha changed</p><p>Alpha changed</p><p>Beta</p></section>`)
    })
})
