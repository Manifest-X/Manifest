/**
 * @vitest-environment happy-dom
 *
 * Publish round trips: the page is mounted from a source file, edited through the
 * real plugin, published to the real dev server (/__edit/save), and the written
 * source is mounted again. The region must read the same as the live page did.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = EDIT_SRC
const SERVE = path.join(__dirname, '../packages/run/serve.mjs')
const flush = () => new Promise(r => setTimeout(r, 0))

let dir, proc, port
const page = (body) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-rt-'))
    writeFileSync(path.join(dir, 'index.html'), page(''))
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'rt' }))
    const ask = 44000 + Math.floor(Math.random() * 4000)
    proc = spawn(process.execPath, [SERVE, dir, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(ask)], { stdio: ['ignore', 'pipe', 'pipe'] })
    port = await new Promise((resolve, reject) => {
        let out = ''
        const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000)
        const scan = c => { out += c; const m = out.match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]) } }
        proc.stdout.on('data', scan); proc.stderr.on('data', scan)
    })
    new Function(SRC)()
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))
    Alpine.store('edit').onPublish = (patches) => post(patches)
}, 15000)

afterAll(() => { try { proc.kill() } catch { } try { rmSync(dir, { recursive: true, force: true }) } catch { } })
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
async function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    await flush(); await flush()
    return root
}
const norm = (root) => {
    const out = {}
    root.querySelectorAll('[data-edit-area]').forEach(a => {
        if (a.parentElement.closest('[data-edit-area]')) return
        const c = a.cloneNode(true)
        c.querySelectorAll('[data-edit-handle],[data-edit-ghost]').forEach(n => n.remove())
        ;[c, ...c.querySelectorAll('*')].forEach(n => [...n.attributes].forEach(at => { if (/^(data-edit-|data-rich-text|role$|aria-multiline$|contenteditable$|tabindex$)/.test(at.name)) n.removeAttribute(at.name) }))
        out[a.getAttribute('data-edit-key')] = c.innerHTML.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim()
    })
    return Object.values(out)
}
const regionSource = () => { const s = readFileSync(path.join(dir, 'index.html'), 'utf8'); return s.slice(s.indexOf('<body>') + 7, s.indexOf('</body>')).trim() }
const editText = (el, value) => { el.dispatchEvent(new Event('focus')); el.innerHTML = value; el.dispatchEvent(new Event('blur')) }

// Mount `body` as both the page and the source file, run `act`, publish, remount.
async function roundTrip(body, act) {
    writeFileSync(path.join(dir, 'index.html'), page(body))
    const root = await mount(body)
    await act(root)
    const live = norm(root)
    const res = await store().publish()
    document.body.innerHTML = ''
    await flush()
    const fresh = await mount(regionSource())
    return { live, after: norm(fresh), res, src: regionSource(), cursor: store().export().cursor }
}

describe('publish round trips', () => {
    it('unnest twice, then edit: nothing is destroyed', async () => {
        const r = await roundTrip(`<section x-edit="u1"><div><p>One</p><p>Two</p><p>Three</p></div><p>Four</p></section>`, async (root) => {
            const [one, two] = root.querySelectorAll('div p')
            store().unnest(one); store().unnest(two)
            editText(two, 'Two edited')
        })
        expect(r.res.results.map(x => x.status)).toEqual(['written'])
        expect(r.after).toEqual(r.live)
        expect(r.src).toContain('<p>One</p>')
        expect(r.src).toContain('<p>Two edited</p>')
    })

    it('nest, move first, edit: no overwrite, no duplication', async () => {
        const r = await roundTrip(`<section x-edit="u2"><div><p>One</p><p>Two</p></div><p>Three</p></section>`, async (root) => {
            const three = root.querySelector('section > p'), div = root.querySelector('div')
            store().nest(three)
            store().move(three, div, div.querySelector('p'))
            editText(three, 'Three edited')
        })
        expect(r.after).toEqual(r.live)
        expect(r.src.match(/Three/g).length).toBe(1)
        expect(r.src).toContain('<p>One</p>')
    })

    it('reorder the root, then nest', async () => {
        const r = await roundTrip(`<section x-edit="u3"><div><p>In</p></div><p>A</p><p>B</p></section>`, async (root) => {
            const [a, b] = root.querySelectorAll('section > p')
            b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
            store().nest(a)
        })
        expect(r.after).toEqual(r.live)
    })

    it('nest, then reorder inside the container', async () => {
        const r = await roundTrip(`<section x-edit="u4"><div><p>In</p></div><p>A</p></section>`, async (root) => {
            const a = root.querySelector('section > p')
            store().nest(a)
            a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
        })
        expect(r.after).toEqual(r.live)
        expect(r.src.indexOf('<p>A</p>')).toBeLessThan(r.src.indexOf('<p>In</p>'))
    })

    it('twins moved between containers keep their identities', async () => {
        const r = await roundTrip(`<section x-edit="u5"><div class="x"><p>Same</p></div><div class="y"><p>Same</p></div></section>`, async (root) => {
            const [x, y] = root.querySelectorAll('div'), [s1, s2] = root.querySelectorAll('p')
            store().move(s1, y); store().move(s2, x)
            editText(s1, 'First')
        })
        expect(r.after).toEqual(r.live)
        expect(r.src).toMatch(/class="x"><p>Same<\/p>/)
        expect(r.src).toMatch(/class="y"><p>First<\/p>/)
    })

    it('a nested delete and duplicate reach the source; later edits hit the right element', async () => {
        const r = await roundTrip(`<section x-edit="u6"><div><p>Alpha</p><p>Beta</p></div><p>Tail</p></section>`, async (root) => {
            const [alpha, beta] = root.querySelectorAll('div p')
            store().remove(alpha)
            store().duplicate(beta)
            editText(beta, 'Beta edited')
        })
        expect(r.after).toEqual(r.live)
        expect(r.src).not.toContain('Alpha')
        expect(r.src).toContain('<p>Beta edited</p>')
        expect(r.src.match(/<p>Beta<\/p>/g).length).toBe(1)
    })

    it('cross-area move, with attributes and classes', async () => {
        const r = await roundTrip(`<section x-edit="a7"><p>One</p><p>Two</p></section>\n<section x-edit="b7"><p>Three</p></section>`, async (root) => {
            const one = root.querySelector('p')
            store().move(one, 'b7')
            store().attr('title', 'Moved', one)
            store().classes.add('lead', one)
        })
        expect(r.after).toEqual(r.live)
        expect(r.src).toMatch(/x-edit="b7"><p>Three<\/p><p title="Moved" class="lead">One<\/p>/)
    })

    it('untouched formatting, comments and Alpine attributes survive', async () => {
        const body = `<section x-edit="u8">
    <!-- hero -->
    <h1 x-data="{ n: 1 }" :class="n && 'on'">Title</h1>
    <div>
        <p @click="n++">Click</p>
    </div>
</section>`
        const r = await roundTrip(body, async (root) => { editText(root.querySelector('h1'), 'New title') })
        expect(r.src).toBe(body.replace('>Title<', '>New title<'))
    })

    it('a successful publish clears history and localStorage', async () => {
        const r = await roundTrip(`<section x-edit.persist="u9"><p>One</p></section>`, async (root) => { editText(root.querySelector('p'), 'Uno') })
        expect(r.res.results[0].status).toBe('written')
        expect(r.cursor).toBe(0)
        expect(localStorage.getItem('mnfst-edit-log:' + location.pathname)).toBeNull()
    })

    it('a failing region writes nothing at all', async () => {
        const body = `<section x-edit="u10"><p>One</p></section>`
        writeFileSync(path.join(dir, 'index.html'), page(body))
        const res = await post([
            { kind: 'static-tree', region: 'u10', tree: { key: '@u10@SECTION:One', edits: { title: 'x' } } },
            { kind: 'static-tree', region: 'missing', tree: { key: '', children: [] } }
        ])
        expect(res.results.map(x => x.status)).toEqual(['error', 'error'])
        expect(regionSource()).toBe(body)
    })

    it('edits inside text elements publish: link text, an href in a paragraph, code in a list item', async () => {
        const r = await roundTrip(`<section x-edit="t1"><p>Read <a href="/a">the guide</a> now.</p><ul><li>Run <code>npm i</code></li></ul></section>`, async (root) => {
            const a = root.querySelector('a'), code = root.querySelector('code')
            editText(a, 'the docs')
            store().attr('href', '/docs', a)
            editText(code, 'npm install')
        })
        expect(r.res.results.map(x => x.status)).toEqual(['written'])
        expect(r.src).toBe(`<section x-edit="t1"><p>Read <a href="/docs">the docs</a> now.</p><ul><li>Run <code>npm install</code></li></ul></section>`)
    })

    it('plugin-rendered content is not source: not editable, not keyed, never blocks a publish', async () => {
        const r = await roundTrip(`<section x-edit="t2"><div x-data="{ h: '<p>Rendered</p>' }" x-html="h"><p>Fallback</p></div><p>Static</p></section>`, async (root) => {
            const rendered = root.querySelector('[x-html] p')
            expect(rendered.hasAttribute('contenteditable')).toBe(false)
            expect(rendered.hasAttribute('data-edit-key')).toBe(false)
            editText(root.querySelector('section > p'), 'Static edited')
        })
        expect(r.res.results.map(x => x.status)).toEqual(['written'])
        expect(r.src).toBe(`<section x-edit="t2"><div x-data="{ h: '<p>Rendered</p>' }" x-html="h"><p>Fallback</p></div><p>Static edited</p></section>`)
    })

    it('an area with a nested x-for list is static: its own text publishes; list rows and x-if output are not editable', async () => {
        const body = `<section x-edit="t3" x-data="{ on: true, rows: [{ id: 1, t: 'R1' }] }"><template x-if="on"><p>Gen</p></template><p>Static A</p><ul><template x-for="r in rows" :key="r.id"><li x-text="r.t"></li></template><li>Static li</li></ul></section>`
        const r = await roundTrip(body, async (root) => {
            await flush()
            const gen = [...root.querySelectorAll('p')].find(p => p.textContent === 'Gen')
            const row = [...root.querySelectorAll('li')].find(l => l.textContent === 'R1')
            expect(gen.hasAttribute('contenteditable')).toBe(false)
            expect(row.hasAttribute('contenteditable')).toBe(false)
            const li = [...root.querySelectorAll('li')].find(l => l.textContent === 'Static li')
            expect(li.getAttribute('contenteditable')).toBe('true')
            editText(li, 'Static li edited')
            editText([...root.querySelectorAll('p')].find(p => p.textContent === 'Static A'), 'Static A edited')
        })
        expect(r.res.results.map(x => x.status)).toEqual(['written'])
        expect(r.src).toBe(body.replace('Static li<', 'Static li edited<').replace('Static A<', 'Static A edited<'))
    })

    it('entity text keys match the server', async () => {
        const r = await roundTrip(`<section x-edit="t4"><p>Caf&eacute; &mdash; one</p><p>Two</p></section>`, async (root) => {
            editText(root.querySelector('p'), 'Edited')
        })
        expect(r.res.results.map(x => x.status)).toEqual(['written'])
        expect(r.src).toBe(`<section x-edit="t4"><p>Edited</p><p>Two</p></section>`)
    })

    it('runtime locks survive a publish, by element', async () => {
        const r = await roundTrip(`<section x-edit.persist="t5"><p>One</p><p>Two</p></section>`, async (root) => {
            const one = root.querySelector('p')
            store().lock(one, 'move')
            editText(one, 'Uno')
        })
        expect(r.res.results.map(x => x.status)).toEqual(['written'])
        // roundTrip remounted from the written source; the lock was re-addressed to the new identity
        const live = store().export().log.filter(d => d.kind === 'lock')
        expect(live).toEqual([expect.objectContaining({ key: '@t5@P:Uno', actions: ['move'], value: true })])
    })
})

