/**
 * @vitest-environment happy-dom
 *
 * Edit text leaves run on the Rich Text engine (inline mode): attach/detach,
 * Cmd+B and $rich on page text, Enter and paste rules, the undo hand-off between
 * Rich Text's history (while focused) and Edit's (after blur), x-rich-text blocks
 * inside an area, and the source writer's inline allowlist.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RICH = readFileSync(path.join(__dirname, '../src/scripts/manifest.rich.text.js'), 'utf8')
const EDIT = readFileSync(path.join(__dirname, '../src/scripts/manifest.edit.js'), 'utf8')
const SERVE = path.join(__dirname, '../packages/run/serve.mjs')

const flush = () => new Promise(r => setTimeout(r, 0))
const frame = () => new Promise(r => setTimeout(r, 30))

let dir, proc, port
const page = (body) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-rich-'))
    writeFileSync(path.join(dir, 'index.html'), page(''))
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'rt' }))
    const ask = 48000 + Math.floor(Math.random() * 4000)
    proc = spawn(process.execPath, [SERVE, dir, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(ask)], { stdio: ['ignore', 'pipe', 'pipe'] })
    port = await new Promise((resolve, reject) => {
        let out = ''
        const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000)
        const scan = c => { out += c; const m = out.match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]) } }
        proc.stdout.on('data', scan); proc.stderr.on('data', scan)
    })
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    new Function(RICH)()
    new Function(EDIT)()
    document.execCommand = () => true
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))
}, 15000)

afterAll(() => { try { proc.kill() } catch { } try { rmSync(dir, { recursive: true, force: true }) } catch { } })
afterEach(() => {
    store().off()
    store().onPublish = null
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
    document.body.innerHTML = ''
    localStorage.clear()
})

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
const cursor = () => store().export().cursor
async function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    await flush(); await flush()
    return root
}
const regionSource = () => { const s = readFileSync(path.join(dir, 'index.html'), 'utf8'); return s.slice(s.indexOf('<body>') + 7, s.indexOf('</body>')).trim() }
const key = (el, init) => { const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e }
function select(node, start, end) {
    const s = window.getSelection(), r = document.createRange()
    r.setStart(node, start); r.setEnd(node, end === undefined ? start : end)
    s.removeAllRanges(); s.addRange(r)
    document.dispatchEvent(new Event('selectionchange'))
}
const text = (el) => document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
// Focus a leaf the way a click does, then let Edit's select-all frame pass.
async function enter(el) {
    el.focus()
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await frame()
}
function paste(el, data) {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { getData: (t) => data[t] || '' } })
    el.dispatchEvent(ev)
    return ev
}
const blur = async (el) => { el.blur(); await flush() }

describe('leaves are inline Rich Text fields', () => {
    it('static, component-free text leaves attach in inline html mode; containers do not', async () => {
        const root = await mount(`<section x-edit="a1"><h1>Title</h1><div><p>Body</p></div></section>`)
        const h1 = root.querySelector('h1'), p = root.querySelector('p'), div = root.querySelector('div')
        for (const el of [h1, p]) {
            expect(el._editRt).toBeTruthy()
            expect(el.getAttribute('data-rich-text')).toBe('html')
            expect(el.hasAttribute('data-rich-text-inline')).toBe(true)
            expect(el.hasAttribute('data-edit-text')).toBe(true)
            expect(el.getAttribute('contenteditable')).toBe('true')
        }
        expect(div.hasAttribute('data-rich-text')).toBe(false)
        expect(store().can('text', h1)).toBe(true)
        expect(store().can('text', div)).toBe(false)
    })

    it('data x-text fields are plain; x-html fields are html', async () => {
        const root = await mount(`<div x-data="{ rows: [{ id: 1, name: 'Rose', note: 'red' }] }">
            <ul x-edit.move.data="a2"><template x-for="r in rows" :key="r.id"><li :data-key="r.id"><span x-text="r.name"></span> <b x-html="r.note"></b></li></template></ul></div>`)
        await frame()
        const name = root.querySelector('span'), note = root.querySelector('b')
        expect(name.getAttribute('data-rich-text')).toBe('plain')
        expect(name._editRt).toBeTruthy()
        expect(note.getAttribute('data-rich-text')).toBe('html')
        expect(note._editRt).toBeTruthy()
    })

    it('raw-text and plugin-rendered elements are never attached', async () => {
        const root = await mount(`<section x-edit="a3" x-data="{ h: '<i>r</i>' }"><p>Static</p><div x-html="h"></div><style>p{}</style></section>`)
        expect(root.querySelector('p')._editRt).toBeTruthy()
        expect(root.querySelector('i').hasAttribute('data-rich-text')).toBe(false)
        expect(root.querySelector('style').hasAttribute('data-rich-text')).toBe(false)
    })
})

describe('formatting page text', () => {
    it('Cmd+B on a focused leaf makes <strong>; blur logs one text delta that publishes', async () => {
        const root = await mount(`<section x-edit="b1"><h1>Title</h1><p>Body</p></section>`)
        const h1 = root.querySelector('h1')
        await enter(h1)
        select(text(h1), 0, 5)
        const at = cursor()
        expect(key(h1, { key: 'b', metaKey: true }).defaultPrevented).toBe(true)
        expect(h1.innerHTML).toBe('<strong>Title</strong>')
        expect(cursor()).toBe(at)
        await blur(h1)
        expect(cursor()).toBe(at + 1)
        expect(log().at(-1)).toMatchObject({ kind: 'st-node', prop: 'text', value: '<strong>Title</strong>', before: 'Title' })
        const tree = store().patches().find(p => p.kind === 'static-tree' && p.region === 'b1')
        expect(JSON.stringify(tree)).toContain('<strong>Title</strong>')
    })

    it('$rich.strong() from a toolbar acts on the focused Edit leaf', async () => {
        const root = await mount(`<div x-data><div id="bar"><button x-rich-text.em id="em">I</button></div><section x-edit="b2"><p>One</p><p>Two words</p></section></div>`)
        const two = root.querySelectorAll('p')[1], bar = root.querySelector('#bar')
        const at = cursor()
        await enter(two)
        select(text(two), 4, 9)
        Alpine.evaluate(bar, '$rich').strong()
        expect(two.innerHTML).toBe('Two <strong>words</strong>')
        await flush()
        const em = root.querySelector('#em')
        expect(em.getAttribute('aria-disabled')).toBe('false')
        select(text(two), 0, 3)
        em.click()
        expect(two.innerHTML).toBe('<em>Two</em> <strong>words</strong>')
        await blur(two)
        expect(cursor()).toBe(at + 1)
        expect(log().at(-1).value).toBe('<em>Two</em> <strong>words</strong>')
    })

    it('Enter makes no paragraph; it fires rich-text:enter', async () => {
        const root = await mount(`<section x-edit="b3"><p>Alpha</p><p>Beta</p></section>`)
        const p = root.querySelector('p')
        const heard = []
        p.addEventListener('rich-text:enter', (e) => heard.push(e.detail.value))
        await enter(p)
        select(text(p), 5)
        expect(key(p, { key: 'Enter' }).defaultPrevented).toBe(true)
        expect(p.innerHTML).toBe('Alpha')
        expect(heard).toEqual(['Alpha'])
        expect(p.hasAttribute('data-edit-dragging')).toBe(false)
        expect(key(p, { key: ' ' }).defaultPrevented).toBe(false)
    })

    it('paste is flattened to one line and sanitized', async () => {
        const root = await mount(`<section x-edit="b4"><p>Start</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        select(text(p), 5)
        paste(p, { 'text/html': '<h1>Big</h1><p onclick="x()">one <em>two</em><script>bad()</script></p><iframe src="//e"></iframe><a href="javascript:alert(1)">link</a>' })
        expect(p.querySelector('h1, p, script, iframe')).toBe(null)
        expect(p.innerHTML).not.toMatch(/onclick|javascript|bad\(\)/)
        expect(p.innerHTML).toContain('<em>two</em>')
        expect(p.textContent).toBe('StartBig one two link')
        await blur(p)
        expect(log().at(-1).value).toBe(p.innerHTML)
    })
})

describe('undo hand-off', () => {
    it('Rich Text undoes while focused, Edit after blur, with no double steps', async () => {
        const root = await mount(`<section x-edit="c1"><h1>Title</h1><p>Body</p></section>`)
        const h1 = root.querySelector('h1'), base = cursor(), size = log().length
        // Session 1: bold, blur
        await enter(h1)
        select(text(h1), 0, 5)
        key(h1, { key: 'b', metaKey: true })
        await blur(h1)
        expect(cursor()).toBe(base + 1)
        // After blur: Edit's history
        expect(key(document.body, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
        expect(h1.innerHTML).toBe('Title')
        expect(cursor()).toBe(base)
        expect(key(document.body, { key: 'z', metaKey: true, shiftKey: true }).defaultPrevented).toBe(true)
        expect(h1.innerHTML).toBe('<strong>Title</strong>')
        expect(cursor()).toBe(base + 1)
        // Session 2: Rich Text's history starts empty
        await enter(h1)
        expect(h1._editRt.can('undo')).toBe(false)
        select(text(h1), 0, 2)
        key(h1, { key: 'i', metaKey: true })
        expect(h1.innerHTML).toBe('<strong><em>Ti</em>tle</strong>')
        // First Cmd+Z: Rich Text's step; Edit's cursor stays
        expect(key(h1, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
        expect(h1.innerHTML).toBe('<strong>Title</strong>')
        expect(cursor()).toBe(base + 1)
        // Second: nothing left in Rich Text, so Edit undoes the session-1 delta, once
        expect(key(h1, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
        expect(h1.innerHTML).toBe('Title')
        expect(cursor()).toBe(base)
        // Rich Text's history was reset under the caret: it cannot replay the old steps
        expect(h1._editRt.can('undo')).toBe(false)
        expect(h1._editRt.can('redo')).toBe(false)
        await blur(h1)
        expect(cursor()).toBe(base)
        expect(log().length).toBe(size + 1)
        expect(store().canRedo).toBe(true)
    })

    it('Cmd+Z after typing undoes the typing only', async () => {
        const root = await mount(`<section x-edit="c2"><p>One</p><p>Two</p></section>`)
        const [one, two] = root.querySelectorAll('p'), base = cursor()
        await enter(one); text(one).nodeValue = 'Uno'; one.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'o' })); await blur(one)
        expect(cursor()).toBe(base + 1)
        await enter(two)
        text(two).nodeValue = 'Dos'
        two.dispatchEvent(new InputEvent('input', { bubbles: true, data: 's' }))
        expect(key(two, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
        expect(two.innerHTML).toBe('Two')
        expect(one.innerHTML).toBe('Uno')
        expect(cursor()).toBe(base + 1)
        await blur(two)
        expect(cursor()).toBe(base + 1)
    })
})

describe('arming and disarming', () => {
    it('$edit.off() detaches a gated area; $edit.on() attaches again', async () => {
        const root = await mount(`<section x-edit.gated="d1"><h2>Gated</h2></section>`)
        const h2 = root.querySelector('h2')
        expect(h2.hasAttribute('data-rich-text')).toBe(false)
        store().on()
        expect(h2._editRt).toBeTruthy()
        expect(h2._rt).toBeTruthy()
        store().off()
        expect(h2._editRt).toBeFalsy()
        expect(h2._rt).toBe(undefined)
        expect([...h2.attributes].map(a => a.name).filter(n => /rich-text|contenteditable|role|aria-multiline|data-edit-text/.test(n))).toEqual([])
        store().on()
        expect(h2._editRt).toBeTruthy()
    })

    it('a locked leaf is detached', async () => {
        const root = await mount(`<section x-edit="d2"><p>Free</p></section>`)
        const p = root.querySelector('p')
        expect(p._editRt).toBeTruthy()
        store().lock(p, 'text')
        expect(p._editRt).toBeFalsy()
        expect(p.hasAttribute('contenteditable')).toBe(false)
    })

    it('Escape leaves text with the piece focused, and Alt+ArrowDown moves it', async () => {
        const root = await mount(`<section x-edit="d3"><p>Alpha</p><p>Beta</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        const e = key(p, { key: 'Escape' })
        expect(e.defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(p)
        expect(p.isContentEditable).toBe(false)
        key(p, { key: 'ArrowDown', altKey: true })
        expect([...root.querySelectorAll('p')].map(x => x.textContent)).toEqual(['Beta', 'Alpha'])
    })

    it('a duplicated piece carries no engine attributes and becomes editable itself', async () => {
        const root = await mount(`<section x-edit="d4"><p>One</p></section>`)
        store().duplicate(root.querySelector('p'))
        await flush()
        const copy = root.querySelectorAll('p')[1]
        expect(copy).toBeTruthy()
        expect(copy._editRt).toBeTruthy()
        expect(copy.getAttribute('data-rich-text')).toBe('html')
        expect(JSON.stringify(log().at(-1))).not.toMatch(/rich-text|role=|aria-multiline/)
    })
})

describe('x-rich-text blocks inside an area', () => {
    it('keep block mode, are not attached twice, and log their own text delta', async () => {
        const root = await mount(`<section x-edit="e1"><div x-rich-text.html id="blk"><h2>Head</h2><p>Para</p></div><p>Leaf</p></section>`)
        const blk = root.querySelector('#blk')
        expect(blk._editRt).toBeFalsy()
        expect(blk.hasAttribute('data-rich-text-inline')).toBe(false)
        expect(blk.hasAttribute('data-edit-text')).toBe(false)
        expect(blk.querySelector('h2').hasAttribute('data-rich-text')).toBe(false)
        expect(root.querySelector('section > p')._editRt).toBeTruthy()
        blk.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        select(text(blk.querySelector('p')), 0, 4)
        expect(blk._rt.api.can('h2')).toBe(true)
        blk._rt.api.h3()
        expect(blk.querySelector('h3')).toBeTruthy()
        // Its own history: Edit leaves Cmd+Z alone
        const at = cursor()
        key(blk, { key: 'z', metaKey: true })
        expect(blk.querySelector('h3')).toBe(null)
        key(blk, { key: 'z', metaKey: true, shiftKey: true })
        expect(blk.querySelector('h3')).toBeTruthy()
        expect(cursor()).toBe(at)
        blk.dispatchEvent(new FocusEvent('blur'))
        expect(cursor()).toBe(at + 1)
        expect(log().at(-1).value).toContain('<h3>Para</h3>')
        expect(log().at(-1).value).toContain('<h2>Head</h2>')
    })
})

describe('source writer allowlist', () => {
    const INLINE = '<a href="/x">a</a> <abbr title="t">abbr</abbr> <b>b</b> <bdi>bdi</bdi> <bdo dir="rtl">bdo</bdo> <cite>cite</cite> <code>code</code> <data value="7">data</data> <del>del</del> <dfn title="d">dfn</dfn> <em>em</em> <i>i</i> <ins>ins</ins> <kbd>kbd</kbd> <mark>mark</mark> <q>q</q> <s>s</s> <samp>samp</samp> <small>small</small> <span>span</span> <strong>strong</strong> <sub>sub</sub> <sup>sup</sup> <time datetime="2026-10-15">time</time> <u>u</u> <var>var</var> x<wbr>y<br>z'

    it('every inline tag Rich Text makes survives client sanitize, publish and the written source', async () => {
        const body = `<section x-edit="f1"><p>One</p><p>Two</p></section>`
        writeFileSync(path.join(dir, 'index.html'), page(body))
        store().onPublish = (patches) => post(patches)
        const root = await mount(body)
        const p = root.querySelector('p')
        await enter(p)
        p.innerHTML = INLINE
        await blur(p)
        expect(log().at(-1).value).toBe(INLINE)
        const res = await store().publish()
        expect(res.results.map(r => r.status)).toEqual(['written'])
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
        expect(res.results.map(r => r.status)).toEqual(['written'])
        expect(regionSource()).toBe('<section x-edit="f2"><p>d<a>a</a><abbr title="ok" style="color: red">ab</abbr><bdo>bd</bdo><data>da</data><time datetime="1">t</time><img src="x"><dfn>df</dfn></p></section>')
        // A block that cannot sit in the leaf: nothing is written
        writeFileSync(path.join(dir, 'index.html'), page(body))
        const block = await send('<h1>Big</h1>')
        expect(block.results.map(r => r.status)).toEqual(['error'])
        expect(regionSource()).toBe(body)
    })
})
