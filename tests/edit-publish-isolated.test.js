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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'

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

function post(patches) {
    const body = JSON.stringify(patches)
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
