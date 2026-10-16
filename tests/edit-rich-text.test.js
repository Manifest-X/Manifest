/**
 * @vitest-environment happy-dom
 *
 * Edit text leaves run on the Rich Text engine (inline mode): attach/detach,
 * Cmd+B and $rich on page text, Enter and paste rules, the undo hand-off between
 * Rich Text's history (while focused) and Edit's (after blur), x-rich-text blocks
 * inside an area. The writer round trips are in edit-publish-isolated.test.js.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'


const flush = () => new Promise(r => setTimeout(r, 0))
const frame = () => new Promise(r => setTimeout(r, 30))

beforeAll(async () => {
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    new Function(EDIT_SRC)()
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))
})

afterEach(() => {
    store().off()
    store().onPublish = null
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
    document.body.innerHTML = ''
    localStorage.clear()
})


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
        const root = await mount(`<div x-data="{ rows: [{ id: 1, name: 'Rose', note: '<em>red</em>' }] }">
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

    it('Enter makes a line break, not a paragraph, and fires no rich-text:enter', async () => {
        const root = await mount(`<section x-edit="b3"><p>Alpha</p><p>Beta</p></section>`)
        const p = root.querySelector('p')
        const heard = []
        p.addEventListener('rich-text:enter', (e) => heard.push(e.detail.value))
        await enter(p)
        select(text(p), 5)
        expect(key(p, { key: 'Enter' }).defaultPrevented).toBe(true)
        expect(p.innerHTML).toBe('Alpha<br><br>')                          // a trailing pair shows the new line
        expect(root.querySelectorAll('p').length).toBe(2)
        expect(heard).toEqual([])
        expect(p.hasAttribute('data-edit-dragging')).toBe(false)
        expect(key(p, { key: ' ' }).defaultPrevented).toBe(false)
    })

    it('paste is sanitized; its blocks become <br>-separated lines', async () => {
        const root = await mount(`<section x-edit="b4"><p>Start</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        select(text(p), 5)
        paste(p, { 'text/html': '<h1>Big</h1><p onclick="x()">one <em>two</em><script>bad()</script></p><iframe src="//e"></iframe><a href="javascript:alert(1)">link</a>' })
        expect(p.querySelector('h1, p, script, iframe')).toBe(null)
        expect(p.innerHTML).not.toMatch(/onclick|javascript|bad\(\)/)
        expect(p.innerHTML).toContain('<em>two</em>')
        expect(p.innerHTML).toBe('StartBig<br>one <em>two</em><br><a>link</a>')
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
        // The italic session (undone in Rich Text) was kept as one undone Edit step after the bold
        expect(log().length).toBe(size + 2)
        expect(store().canRedo).toBe(true)
        key(document.body, { key: 'z', metaKey: true, shiftKey: true })
        expect(h1.innerHTML).toBe('<strong>Title</strong>')
        key(document.body, { key: 'z', metaKey: true, shiftKey: true })
        expect(h1.innerHTML).toBe('<strong><em>Ti</em>tle</strong>')
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

describe('whole leaves', () => {
    it('a paragraph of plain formatting is one leaf, <br> included; a class or a directive keeps it granular', async () => {
        const root = await mount(`<section x-edit="w0"><p id="a">Read <a href="/x">guide</a> <em>now</em></p><p id="b">Go <a class="btn" href="/y">there</a></p><p id="c">Hi <code x-tooltip="t">x</code></p><p id="d">One<br>two</p></section>`)
        const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(x => root.querySelector('#' + x))
        expect(a._editRt).toBeTruthy()
        expect(a.querySelector('a').hasAttribute('data-rich-text')).toBe(false)
        for (const el of [b, c]) expect(el.hasAttribute('data-rich-text')).toBe(false)
        expect(d._editRt).toBeTruthy()
        expect(d.innerHTML).toBe('One<br>two')
        expect(b.querySelector('a')._editRt).toBeTruthy()            // its plain-text children stay their own leaves
        expect(store().can('text', a)).toBe(true)
    })

    it('$edit.attr on a link inside a leaf is the leaf\'s text delta; classes are refused', async () => {
        const root = await mount(`<section x-edit="w2"><p>Read <a href="/x">guide</a> now</p></section>`)
        const p = root.querySelector('p'), a = p.querySelector('a'), at = cursor()
        expect(store().can('attrs', a)).toBe(true)
        expect(store().can('class', a)).toBe(false)
        expect(store().attr('href', '/docs', a)).toBe(true)
        expect(cursor()).toBe(at + 1)
        expect(log().at(-1)).toMatchObject({ kind: 'st-node', path: p.getAttribute('data-edit-key'), prop: 'text', before: 'Read <a href="/x">guide</a> now', value: 'Read <a href="/docs">guide</a> now' })
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        expect(store().classes.add('big', a)).toBe(false)
        expect(store().attr('class', 'big', a)).toBe(false)
        expect(store().attr('onclick', 'x()', a)).toBe(false)
        warn.mockRestore()
        expect(a.hasAttribute('class')).toBe(false)
        expect(cursor()).toBe(at + 1)
        await store().undo()
        expect(p.innerHTML).toBe('Read <a href="/x">guide</a> now')
        await store().redo()
        expect(p.querySelector('a').getAttribute('href')).toBe('/docs')
    })

    it('an href change while typing is one delta with the typing; blur adds none', async () => {
        const root = await mount(`<section x-edit="w4"><p>Read <a href="/x">guide</a></p></section>`)
        const p = root.querySelector('p'), at = cursor()
        await enter(p)
        p.firstChild.nodeValue = 'Please read '
        p.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'e' }))
        expect(store().attr('href', '/y', p.querySelector('a'))).toBe(true)
        expect(cursor()).toBe(at + 1)
        expect(log().at(-1)).toMatchObject({ before: 'Read <a href="/x">guide</a>', value: 'Please read <a href="/y">guide</a>' })
        expect(p._editRt.can('undo')).toBe(false)
        await blur(p)
        expect(cursor()).toBe(at + 1)
    })
})

describe('a leaf resting as a focused piece', () => {
    it('Alt+Enter, then $edit.attr on its link, then undo and redo: one leaf, no keys inside, piece mode kept', async () => {
        const root = await mount(`<section x-edit="pm1"><p>Read <a href="/x">guide</a> now</p><p>Other</p></section>`)
        const p = root.querySelector('p'), at = cursor()
        await enter(p)
        p.firstChild.nodeValue = 'Please read '
        p.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'd' }))
        key(p, { key: 'Enter', altKey: true })
        await flush()
        expect(document.activeElement).toBe(p)
        expect(p._pieceMode).toBe(true)
        expect(cursor()).toBe(at + 1)
        expect(store().attr('href', '/docs', p.querySelector('a'))).toBe(true)
        expect(cursor()).toBe(at + 2)
        expect(key(p, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
        await flush(); await flush()
        expect(p.innerHTML).toBe('Please read <a href="/x">guide</a> now')
        expect(p.getAttribute('contenteditable')).toBe('false')                 // still a piece, not re-attached under it
        expect(key(p, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
        await flush(); await flush()
        expect(p.innerHTML).toBe('Read <a href="/x">guide</a> now')
        expect(key(p, { key: 'z', metaKey: true, shiftKey: true }).defaultPrevented).toBe(true)
        expect(key(p, { key: 'z', metaKey: true, shiftKey: true }).defaultPrevented).toBe(true)
        await flush(); await flush()
        expect(p.innerHTML).toBe('Please read <a href="/docs">guide</a> now')
        expect(cursor()).toBe(at + 2)
    })
})

describe('links never nest', () => {
    it('a link leaf takes no link: $rich.a and unlink are unavailable, a pasted link is unwrapped', async () => {
        const root = await mount(`<section x-edit="ln1"><p>Go <a class="btn" href="/y">there now</a></p></section>`)
        const a = root.querySelector('a')
        expect(a._editRt).toBeTruthy()
        await enter(a)
        select(a.firstChild, 1, 4)
        expect(a._editRt.can('a')).toBe(false)
        a._editRt.a('https://z.com')
        expect(a.querySelector('a')).toBe(null)
        select(a.firstChild, 9)
        paste(a, { 'text/html': 'see <a href="https://evil.example">x</a>' })
        expect(a.querySelector('a')).toBe(null)
        expect(a.innerHTML).toBe('there nowsee x')
        await blur(a)
        expect(log().at(-1).value).toBe('there nowsee x')
    })

    it('a link over part of an existing link splits it, leaving no nested or empty link', async () => {
        const root = await mount(`<section x-edit="ln2"><p>Read the <a href="/guide">guide</a> today.</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        const r = document.createRange(); r.setStart(p.firstChild, 5); r.setEnd(p.querySelector('a').firstChild, 2)
        window.getSelection().removeAllRanges(); window.getSelection().addRange(r); document.dispatchEvent(new Event('selectionchange'))
        p._editRt.a('https://y.com')
        expect(p.innerHTML).toBe('Read <a href="https://y.com">the gu</a><a href="/guide">ide</a> today.')
        await blur(p)
        expect(log().at(-1).value).toBe('Read <a href="https://y.com">the gu</a><a href="/guide">ide</a> today.')
    })

    it('a selection covering a whole link replaces it; unlink over a selection removes every link it touches', async () => {
        const root = await mount(`<section x-edit="ln3"><p>Read the <a href="/guide">guide</a> today.</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        select(p.lastChild, 0, 3)
        const r = document.createRange(); r.setStart(p.firstChild, 5); r.setEnd(p.lastChild, 3)
        window.getSelection().removeAllRanges(); window.getSelection().addRange(r); document.dispatchEvent(new Event('selectionchange'))
        p._editRt.a('https://y.com')
        expect(p.innerHTML).toBe('Read <a href="https://y.com">the guide to</a>day.')
        const r2 = document.createRange(); r2.selectNodeContents(p)
        window.getSelection().removeAllRanges(); window.getSelection().addRange(r2); document.dispatchEvent(new Event('selectionchange'))
        p._editRt.unlink()
        expect(p.querySelector('a')).toBe(null)
        // Unlinking part of a link keeps the rest linked
        p.innerHTML = 'Go <a href="/x">Alpha</a> end'
        const a = p.querySelector('a'), r3 = document.createRange(); r3.setStart(a.firstChild, 1); r3.setEnd(a.firstChild, 3)
        window.getSelection().removeAllRanges(); window.getSelection().addRange(r3); document.dispatchEvent(new Event('selectionchange'))
        p._editRt.unlink()
        expect(p.innerHTML).toBe('Go <a href="/x">A</a>lp<a href="/x">ha</a> end')
    })

    it('leaf text never carries a nested or empty link, whatever reaches the DOM', async () => {
        const root = await mount(`<section x-edit="ln4"><p>One <a href="/a">two</a></p><p>Btn</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        const inner = document.createElement('a'); inner.href = '/b'; inner.textContent = 'w'
        const outer = p.querySelector('a'); outer.textContent = 'tx'; outer.firstChild.splitText(1); outer.insertBefore(inner, outer.lastChild)
        const empty = document.createElement('a'); empty.setAttribute('href', '/c'); p.append(' ', empty)
        await blur(p)
        expect(log().at(-1).value).toBe('One <a href="/a">twx</a>')
    })
})

describe('links: minors', () => {
    const selectRange = (sc, so, ec, eo) => { const r = document.createRange(); r.setStart(sc, so); r.setEnd(ec, eo); window.getSelection().removeAllRanges(); window.getSelection().addRange(r); document.dispatchEvent(new Event('selectionchange')) }
    it('a button leaf takes no link', async () => {
        const root = await mount(`<section x-edit="lm1"><button>Buy <strong>now</strong></button></section>`)
        const b = root.querySelector('button')
        expect(b._editRt).toBeTruthy()
        await enter(b)
        select(b.firstChild, 0, 3)
        expect(b._editRt.can('a')).toBe(false)
        b._editRt.a('https://x.com')
        expect(b.querySelector('a')).toBe(null)
    })

    it('a selection inside a link splits it; across formatting the links stay outermost and merge', async () => {
        const root = await mount(`<section x-edit="lm2"><p>Go <a href="/x">Alpha <strong>Beta</strong></a> end</p><p>Go <a href="/x">Alpha <strong>Beta</strong></a> end</p></section>`)
        const [p, q] = root.querySelectorAll('p')
        await enter(p)
        selectRange(p.querySelector('a').firstChild, 1, p.querySelector('a').firstChild, 4)
        p._editRt.a('https://y.com')
        expect(p.innerHTML).toBe('Go <a href="/x">A</a><a href="https://y.com">lph</a><a href="/x">a <strong>Beta</strong></a> end')
        await blur(p)
        await enter(q)
        const a = q.querySelector('a')
        selectRange(a.firstChild, 2, a.querySelector('strong').firstChild, 2)
        q._editRt.a('https://y.com')
        expect(q.innerHTML).toBe('Go <a href="/x">Al</a><a href="https://y.com">pha <strong>Be</strong></a><a href="/x"><strong>ta</strong></a> end')
        await blur(q)
    })
})

describe('hand-off respects data-edit-hotkeys="off"', () => {
    it('no session is logged when Edit will not act on the key', async () => {
        const root = await mount(`<section x-edit="ho1" data-edit-hotkeys="off"><p>One</p></section>`)
        const p = root.querySelector('p'), size = log().length
        await enter(p)
        p.firstChild.nodeValue = 'Onex'; window.getSelection().collapse(p.firstChild, 4)
        p.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }))
        key(p, { key: 'z', metaKey: true })
        expect(p.innerHTML).toBe('One')
        key(p, { key: 'z', metaKey: true })
        expect(log().length).toBe(size)
        await blur(p)
        expect(log().length).toBe(size)
    })
})

describe('publishes run one at a time', () => {
    it('a second publish waits for the first and builds on its result', async () => {
        const root = await mount(`<section x-edit="pb1"><p>One</p></section>`)
        const p = root.querySelector('p')
        await enter(p); p.firstChild.nodeValue = 'Uno'; await blur(p)
        const calls = []
        let release
        store().onPublish = (patches) => { calls.push(patches.length); return calls.length === 1 ? new Promise(r => { release = () => r({ results: [{ status: 'written' }] }) }) : { results: [] } }
        const first = store().publish(), second = store().publish()
        await flush(); await flush()
        expect(calls).toEqual([1])
        release()
        await first; await second
        expect(calls).toEqual([1, 0])                                     // rebased by the first: nothing left to send
    })
})

describe('selection geometry stays out of content', () => {
    it('selecting in a leaf sets --rich-text-selection-* on <html> only; styles and copies never carry --rich-text-*', async () => {
        const root = await mount(`<section x-edit="sg1"><h2 style="color: red">Float title</h2><p>Two</p></section>`)
        const h2 = root.querySelector('h2')
        await enter(h2)
        select(h2.firstChild, 0, 5)
        expect(h2.getAttribute('style')).toMatch(/^color: red;?$/)
        expect(document.documentElement.style.getPropertyValue('--rich-text-selection-width')).not.toBe('')
        await blur(h2)
        h2.style.setProperty('--rich-text-selection-x', '9px')            // left by an older build
        store().duplicate(h2)
        await flush()
        const copy = root.querySelectorAll('h2')[1]
        expect(copy.getAttribute('style')).toMatch(/^color: red;?$/)
        expect(JSON.stringify(store().patches())).not.toContain('--rich-text-')
        expect(JSON.stringify(log())).not.toContain('--rich-text-')
    })
})

describe('line breaks in leaves', () => {
    it('an address is one leaf: its <br>s stay, and Enter or Shift+Enter adds one', async () => {
        const root = await mount(`<section x-edit="br1"><p>1 Main St<br>Springfield</p></section>`)
        const p = root.querySelector('p'), at = cursor()
        expect(p._editRt).toBeTruthy()
        expect(p.innerHTML).toBe('1 Main St<br>Springfield')
        expect(p.getAttribute('aria-multiline')).toBe('true')
        await enter(p)
        select(p.lastChild, 11)
        const heard = []
        p.addEventListener('rich-text:enter', () => heard.push(1))
        expect(key(p, { key: 'Enter' }).defaultPrevented).toBe(true)
        expect(heard.length).toBe(0)
        expect(p.innerHTML).toBe('1 Main St<br>Springfield<br><br>')   // a trailing pair shows the new line
        const caret = window.getSelection().getRangeAt(0)
        caret.insertNode(document.createTextNode('USA'))
        p.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'A' }))
        await blur(p)
        expect(cursor()).toBe(at + 1)
        expect(log().at(-1).value).toBe('1 Main St<br>Springfield<br>USA')
        expect(p.innerHTML).toBe('1 Main St<br>Springfield<br>USA')
    })

    it('Shift+Enter in a leaf makes a line break, as Enter does', async () => {
        const root = await mount(`<section x-edit="br1s"><p>One</p></section>`)
        const p = root.querySelector('p'), heard = []
        p.addEventListener('rich-text:enter', () => heard.push(1))
        await enter(p)
        select(p.firstChild, 3)
        expect(key(p, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(true)
        expect(heard).toEqual([])
        expect(p.innerHTML).toBe('One<br><br>')
    })

    it('a trailing <br> inside an inline element is not logged; the element it empties goes too', async () => {
        const root = await mount(`<section x-edit="br5"><h1>Hello <strong>world</strong></h1><p>Read the <a href="/g">guide</a></p></section>`)
        const h1 = root.querySelector('h1'), p = root.querySelector('p'), at = cursor()
        await enter(h1)
        select(h1.querySelector('strong').firstChild, 5)
        key(h1, { key: 'Enter', shiftKey: true })
        expect(h1.innerHTML).toBe('Hello <strong>world<br><br></strong>')
        await blur(h1)
        expect(cursor()).toBe(at)
        await enter(p)
        const a = p.querySelector('a')
        select(a.firstChild, 5)
        key(p, { key: 'Enter', shiftKey: true })
        a.lastChild.before(document.createTextNode(' '))
        p.append(document.createElement('em'))
        await blur(p)
        expect(cursor()).toBe(at)
        expect(store().patches().some(x => JSON.stringify(x).includes('<br>'))).toBe(false)
    })

    it('Shift+Enter mid-line splits the line with one <br>', async () => {
        const root = await mount(`<section x-edit="br2"><p>Roses are red</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        select(p.firstChild, 9)
        let inputs = 0; p.addEventListener('input', () => inputs++)
        key(p, { key: 'Enter', shiftKey: true })
        expect(p.innerHTML).toBe('Roses are<br> red')
        expect(inputs).toBe(1)                                            // so component mirroring and listeners see it
        expect(p._editRt.can('undo')).toBe(true)
    })

    it('a multi-paragraph paste becomes <br>-separated lines', async () => {
        const root = await mount(`<section x-edit="br3"><p>Note: </p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        select(p.firstChild, 6)
        paste(p, { 'text/html': '<p>Dear Ada,</p>\n<p>Thanks for <b>everything</b>.</p><ul><li>One</li><li>Two</li></ul>' })
        expect(p.innerHTML).toBe('Note: Dear Ada,<br>Thanks for <b>everything</b>.<br>One<br>Two')
        p.innerHTML = 'x'
        select(p.firstChild, 1)
        paste(p, { 'text/plain': 'line one\n\nline two\nline three' })
        expect(p.innerHTML).toBe('xline one<br>line two<br>line three')
    })

    it('x-rich-text.inline without breaks stays one line', async () => {
        const root = await mount(`<div x-data><div x-rich-text.html.inline id="one">A<br>B</div></div>`)
        const el = root.querySelector('#one')
        expect(el.innerHTML).toBe('A B')
        expect(el.getAttribute('aria-multiline')).toBe('false')
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        select(el.firstChild, 3)
        const heard = []
        el.addEventListener('rich-text:enter', (e) => heard.push(e.detail.shiftKey))
        key(el, { key: 'Enter', shiftKey: true })
        expect(heard).toEqual([true])
        expect(el.innerHTML).toBe('A B')
        expect(el._rt.api.can('br')).toBe(false)
        paste(el, { 'text/html': '<p>one</p><p>two</p>' })
        expect(el.innerHTML).toBe('A Bone two')
    })
})

describe('history across the hand-off', () => {
    const type = async (el, text, data) => { el.lastChild.nodeValue = text; window.getSelection().collapse(el.lastChild, text.length); el.dispatchEvent(new InputEvent('input', { bubbles: true, data })); await new Promise(r => setTimeout(r, 450)) }
    const z = (el, shift) => key(el, { key: 'z', metaKey: true, shiftKey: !!shift })

    it('typing undone past the session start becomes one Edit step: redo brings it all back', async () => {
        const root = await mount(`<table x-edit="hh1"><tbody><tr><td>Cell <b>1</b></td><td>Cell 2</td></tr></tbody></table>`)
        const [td1, td2] = root.querySelectorAll('td'), base = cursor(), size = log().length
        await enter(td1); td1.lastChild.lastChild.nodeValue = '1X'; await blur(td1)
        expect(cursor()).toBe(base + 1)
        await enter(td2)
        await type(td2, 'Cell 2ab', 'b')
        await type(td2, 'Cell 2abcd', 'd')
        z(td2); expect(td2.innerHTML).toBe('Cell 2ab'); expect(cursor()).toBe(base + 1)
        z(td2); expect(td2.innerHTML).toBe('Cell 2'); expect(cursor()).toBe(base + 1)
        expect(z(td2).defaultPrevented).toBe(true)                        // hand-off: the session is logged and undone, then Edit undoes td1
        await flush()
        expect(td1.innerHTML).toBe('Cell <b>1</b>')
        expect(td2.innerHTML).toBe('Cell 2')
        expect(cursor()).toBe(base)
        expect(z(td2, true).defaultPrevented).toBe(true); await flush()
        expect(td1.innerHTML).toBe('Cell <b>1X</b>')
        expect(z(td2, true).defaultPrevented).toBe(true); await flush()
        expect(td2.innerHTML).toBe('Cell 2abcd')
        z(td2, true); await flush()
        expect(td2.innerHTML).toBe('Cell 2abcd')
        await blur(td2)
        expect(cursor()).toBe(base + 2)
        expect(log().length).toBe(size + 2)
    })

    it('a command undone past the start is kept the same way', async () => {
        const root = await mount(`<section x-edit="hh2"><p>One</p><p>Two</p></section>`)
        const [one, two] = root.querySelectorAll('p'), base = cursor()
        await enter(one); one.firstChild.nodeValue = 'Uno'; await blur(one)
        await enter(two); select(two.firstChild, 0, 3)
        key(two, { key: 'b', metaKey: true })
        expect(two.innerHTML).toBe('<strong>Two</strong>')
        z(two); expect(two.innerHTML).toBe('Two')
        z(two); await flush()
        expect(one.innerHTML).toBe('One')
        z(two, true); await flush(); expect(one.innerHTML).toBe('Uno')
        z(two, true); await flush(); expect(two.innerHTML).toBe('<strong>Two</strong>')
        await blur(two)
        expect(cursor()).toBe(base + 2)
    })

    it('steps that fire no input (Shift+Enter, autoformat) are part of the handed-off session', async () => {
        const root = await mount(`<section x-edit="hh4"><p>Cell</p><p>Other</p></section>`)
        const p = root.querySelector('p'), base = cursor()
        await enter(p)
        await type(p, 'Cellab', 'b')
        select(p.firstChild, 5)
        key(p, { key: 'Enter', shiftKey: true })
        expect(p.innerHTML).toBe('Cella<br>b')
        z(p); z(p)
        expect(p.innerHTML).toBe('Cell')
        z(p); await flush()                                               // hand-off: the session is logged, undone, then Edit undoes on
        expect(log()[base]).toMatchObject({ prop: 'text', before: 'Cell', value: 'Cella<br>b' })
        while (cursor() <= base) { z(p, true); await flush() }
        expect(p.innerHTML).toBe('Cella<br>b')
        await blur(p)
        expect(cursor()).toBe(base + 1)
        const q = root.querySelectorAll('p')[1]
        await enter(q)
        q.firstChild.nodeValue = 'Other **bold**'; window.getSelection().collapse(q.firstChild, 14)
        q.dispatchEvent(new InputEvent('input', { bubbles: true, data: '*' }))
        await new Promise(r => setTimeout(r, 450))
        expect(q.innerHTML).toBe('Other <strong>bold</strong>')
        while (q._editRt.can('undo')) z(q)
        z(q); await flush()                                               // the session is logged and undone, then the paragraph's edit
        expect(p.innerHTML).toBe('Cell')
        expect(log()[base + 1]).toMatchObject({ value: 'Other <strong>bold</strong>' })
        while (cursor() < base + 2) { z(q, true); await flush() }
        expect(q.innerHTML).toBe('Other <strong>bold</strong>')
        await blur(q)
    })

    it('Ctrl+Y redoes the leaf\'s own step, not Edit\'s', async () => {
        const root = await mount(`<section x-edit="hh3"><p>One</p><p>Two</p></section>`)
        const [one, two] = root.querySelectorAll('p')
        await enter(one); one.firstChild.nodeValue = 'Uno'; await blur(one)
        key(document.body, { key: 'z', metaKey: true })
        expect(one.innerHTML).toBe('One')
        const at = cursor()
        await enter(two)
        await type(two, 'Twox', 'x')
        z(two); expect(two.innerHTML).toBe('Two')
        expect(key(two, { key: 'y', ctrlKey: true }).defaultPrevented).toBe(true)
        expect(two.innerHTML).toBe('Twox')
        expect(one.innerHTML).toBe('One')
        expect(cursor()).toBe(at)
    })
})

describe('client and writer agree', () => {
    it('leaf text drops what the writer drops: @import styles and non-raster data images', async () => {
        const root = await mount(`<section x-edit="ag1"><p>One</p><p>Two <span style="color: red">x</span></p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        p.innerHTML = 'One <span style="color: blue; @import \'x.css\'">a</span><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="s"><img src="data:image/png;base64,iVBO" alt="r"><span style="color: green">b</span>'
        await blur(p)
        expect(log().at(-1).value).toBe('One <span>a</span><img alt="s"><img src="data:image/png;base64,iVBO" alt="r"><span style="color: green">b</span>')
        expect(window.ManifestRichText.sanitize('<img src="data:image/svg+xml,<svg/>">', false)).toBe('<img>')
    })
})

describe('.all on leaves', () => {
    it('.all controls and $rich.all are unavailable on an Edit leaf; standalone fields keep them', async () => {
        const root = await mount(`<div x-data><div id="bar"><button x-rich-text.align.all.center id="al">C</button></div><section x-edit="al1"><p>One two</p></section><div x-rich-text.html id="fld"><p>Field</p></div></div>`)
        const p = root.querySelector('p'), btn = root.querySelector('#al'), fld = root.querySelector('#fld')
        await enter(p)
        select(p.firstChild, 0, 3)
        await flush()
        expect(btn.getAttribute('aria-disabled')).toBe('true')
        btn.click()
        p._editRt.all = { align: 'center' }
        expect(p.getAttribute('style')).toBe(null)
        await blur(p)
        fld._rt.api.all = { align: 'center' }
        expect(fld.getAttribute('style')).toContain('--rich-text-align')
    })
})

describe('data values', () => {
    it('rows need no :data-key: the x-for scope names the record; a row that is itself the field is editable', async () => {
        const root = await mount(`<div x-data="{ rows: [{ id: 7, name: 'Rose' }, { id: 8, name: 'Lily' }] }"><ul x-edit.move.data="dv2"><template x-for="r in rows" :key="r.id"><li x-text="r.name"></li></template></ul><i id="out" x-text="rows.map(r => r.name).join()"></i></div>`)
        await frame()
        const li = root.querySelectorAll('li')[1], at = cursor()
        expect(li._editRt).toBeTruthy()
        await enter(li)
        li.textContent = 'Iris'
        await blur(li)
        await frame()
        expect(cursor()).toBe(at + 1)
        expect(log().at(-1)).toMatchObject({ kind: 'data-val', id: '8', field: 'name', value: 'Iris', before: 'Lily' })
        expect(root.querySelector('#out').textContent).toBe('Rose,Iris')
        await store().undo(); await frame()
        expect(root.querySelector('#out').textContent).toBe('Rose,Lily')
    })

    it('undoing the only data-val delta restores the model', async () => {
        const root = await mount(`<div x-data="{ rows: [{ id: 1, name: 'Rose' }] }"><ul x-edit.move.data="dv1"><template x-for="r in rows" :key="r.id"><li :data-key="r.id"><span x-text="r.name"></span></li></template></ul><i id="out" x-text="rows[0].name"></i></div>`)
        await frame()
        const span = root.querySelector('span'), at = cursor()
        await enter(span)
        span.textContent = 'Tulip'
        await blur(span)
        await frame()
        expect(cursor()).toBe(at + 1)
        expect(root.querySelector('#out').textContent).toBe('Tulip')
        await store().undo()
        await frame()
        expect(root.querySelector('#out').textContent).toBe('Rose')
        await store().redo()
        await frame()
        expect(root.querySelector('#out').textContent).toBe('Tulip')
        await store().undo()                                             // leave no data patch for later publishes
    })
})

describe('no floating grip', () => {
    it('hovering or focusing a text piece adds nothing to the page', async () => {
        const root = await mount(`<section x-edit="gr1"><p>One</p><p>Two</p></section>`)
        const p = root.querySelector('p')
        p.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
        p.focus()
        expect(document.querySelector('[data-edit-grip]')).toBe(null)
        expect(document.body.lastElementChild).toBe(root)
    })
})

describe('data rows that are themselves the field', () => {
    it('drag by their own surface in a .move.data region', async () => {
        const root = await mount(`<div x-data="{ rows: [{ id: 1, n: 'One' }, { id: 2, n: 'Two' }] }"><ul x-edit.move.data="dr1"><template x-for="row in rows" :key="row.id"><li x-text="row.n"></li></template></ul><i id="o" x-text="rows.map(r => r.n).join()"></i></div>`)
        await frame()
        const [one, two] = root.querySelectorAll('li')
        expect(one._editRt).toBeTruthy()
        expect(one.hasAttribute('data-edit-piece')).toBe(true)
        one.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 20, width: 200, height: 20, x: 0, y: 0 })
        two.getBoundingClientRect = () => ({ left: 0, top: 20, right: 200, bottom: 40, width: 200, height: 20, x: 0, y: 20 })
        document.elementFromPoint = () => two
        one.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 5, button: 0, pointerType: 'mouse', pointerId: 3 }))
        document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 10, clientY: 38, pointerId: 3 }))
        expect(one.hasAttribute('data-edit-dragging')).toBe(true)
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 10, clientY: 38, pointerId: 3 }))
        await frame()
        expect(root.querySelector('#o').textContent).toBe('Two,One')
        delete document.elementFromPoint
    })
})

describe('links in active areas and fields are content', () => {
    const click = (el) => { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented }
    it('a link click is never followed in an Edit area (a resting piece included) or a Rich Text field; islands keep theirs', async () => {
        const root = await mount(`<div x-data><section x-edit="lk1"><p>See <a href="/a">the link</a> here</p><p>Two</p><div contenteditable="false"><a href="/b" id="isl">island</a></div></section>
            <div x-rich-text.html id="f"><p>Go <a href="/c" id="l2">c</a></p><p contenteditable="false"><a href="/d" id="isl2">d</a></p></div><a href="/e" id="out">out</a></div>`)
        await flush()
        const p = root.querySelector('section p')
        expect([p.hasAttribute('data-edit-piece'), !!p._editRt]).toEqual([true, true])
        expect(click(root.querySelector('section a'))).toBe(true)
        await enter(p); key(p, { key: 'Enter', altKey: true }); await flush()
        expect(p.getAttribute('contenteditable')).toBe('false')
        expect(p.hasAttribute('data-edit-piece-mode')).toBe(true)
        expect(click(root.querySelector('section a'))).toBe(true)                            // a resting piece: still content
        expect(click(root.querySelector('#isl'))).toBe(false)                          // an authored island keeps its link
        expect(click(root.querySelector('#l2'))).toBe(true)
        expect(click(root.querySelector('#isl2'))).toBe(false)
        expect(click(root.querySelector('#out'))).toBe(false)
        p.blur(); await flush()
        expect(p.hasAttribute('data-edit-piece-mode')).toBe(false)
    })

    it('a middle-click is blocked as a click is; Enter on an island link is left to the link', async () => {
        const root = await mount(`<div x-data><section x-edit="lk2"><p>See <a href="/a">the link</a></p><a href="/i" id="img"><img src="/x.png" alt=""></a><div contenteditable="false" id="isle"><a href="/b" id="isl">island</a></div></section>
            <div x-rich-text.html id="f2"><p>Go <a href="/c" id="l2">c</a></p><p contenteditable="false"><a href="/d" id="isl2">d</a></p></div></div>`)
        await flush()
        const aux = (el) => { const e = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }); el.dispatchEvent(e); return e.defaultPrevented }
        expect(aux(root.querySelector('section p a'))).toBe(true)
        expect(aux(root.querySelector('#img img'))).toBe(true)
        expect(aux(root.querySelector('#l2'))).toBe(true)
        expect(aux(root.querySelector('#isl'))).toBe(false)
        expect(aux(root.querySelector('#isl2'))).toBe(false)
        expect(key(root.querySelector('#isl'), { key: 'Enter' }).defaultPrevented).toBe(false)
        expect(root.querySelector('#isle').hasAttribute('data-edit-dragging')).toBe(false)
        expect(key(root.querySelector('#isl2'), { key: 'Enter' }).defaultPrevented).toBe(false)
        expect(root.querySelector('#f2').innerHTML).toBe('<p>Go <a href="/c" id="l2">c</a></p><p contenteditable="false"><a href="/d" id="isl2">d</a></p>')
    })
})

describe('drops', () => {
    it('a leaf in an active area takes no drop, multi-line or not, as the area takes none', async () => {
        const root = await mount(`<section x-edit="dr1"><h1>Hello <strong>world</strong></h1></section>`)
        const h1 = root.querySelector('h1'), at = cursor()
        const drop = (data) => { const ev = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(ev, 'dataTransfer', { value: { getData: (t) => data[t] || '' } }); h1.dispatchEvent(ev); return ev }
        expect(drop({ 'text/html': '<p>dropped</p><p>two</p>', 'text/plain': 'dropped\ntwo' }).defaultPrevented).toBe(true)
        expect(drop({ 'text/plain': 'one line' }).defaultPrevented).toBe(true)
        expect(h1.innerHTML).toBe('Hello <strong>world</strong>')
        expect(cursor()).toBe(at)
    })
})

describe('standalone fields', () => {
    it('Ctrl+Y redoes in an x-rich-text field off the Mac', async () => {
        const root = await mount(`<div x-data><div x-rich-text.html id="st"><p>One</p></div></div>`)
        const el = root.querySelector('#st'), p = el.querySelector('p')
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        p.firstChild.nodeValue = 'Onex'; window.getSelection().collapse(p.firstChild, 4)
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }))
        key(el, { key: 'z', metaKey: true })
        expect(el.innerHTML).toBe('<p>One</p>')
        const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '')
        expect(key(el, { key: 'y', ctrlKey: true }).defaultPrevented).toBe(!mac)
        expect(el.innerHTML).toBe(mac ? '<p>One</p>' : '<p>Onex</p>')
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

    it('Alt+Enter leaves text with the piece focused, and Alt+ArrowDown moves it', async () => {
        const root = await mount(`<section x-edit="d3"><p>Alpha</p><p>Beta</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        const e = key(p, { key: 'Enter', altKey: true })
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

    it('a field ending in a list logs and publishes no empty paragraph after it', async () => {
        const root = await mount(`<section x-edit="e2"><div x-rich-text.html id="lst"><ul><li>One</li></ul></div></section>`)
        const blk = root.querySelector('#lst')
        expect(blk.lastElementChild.tagName).toBe('P')                                  // the affordance, on the page only
        blk.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        const t = text(blk.querySelector('li')); t.nodeValue = 'One more'; select(t, 8)
        blk.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'e' }))
        blk.dispatchEvent(new FocusEvent('blur'))
        expect(log().at(-1).value).toBe('<ul><li>One more</li></ul>')
        expect(JSON.stringify(store().patches())).not.toContain('<p><br></p>')
    })
})

describe('typing after a converted mark in a leaf', () => {
    it('logs and publishes a plain space after the mark; the author\'s U+00A0 stays', async () => {
        const root = await mount(`<section x-edit="nb1"><p>Cell&nbsp;2</p></section>`)
        const p = root.querySelector('p')
        await enter(p)
        const type = (ch) => {
            const bi = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch })
            p.dispatchEvent(bi)
            if (bi.defaultPrevented) return
            const r = window.getSelection().getRangeAt(0), t = r.startContainer, o = r.startOffset
            t.insertData(o, ch); window.getSelection().collapse(t, o + ch.length)
            p.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }))
        }
        p.firstChild.nodeValue = 'Cell 2 **b*'; window.getSelection().collapse(p.firstChild, p.firstChild.length)
        type('*')
        expect(p.innerHTML).toBe('Cell&nbsp;2 <strong>b</strong>')
        for (const ch of ' more') type(ch)
        await blur(p)
        expect(log().pop()).toMatchObject({ prop: 'text', value: 'Cell&nbsp;2 <strong>b</strong> more' })
        const sent = JSON.stringify(store().patches())
        expect(sent).toContain('<strong>b</strong> more')
        expect(sent).toContain('Cell&nbsp;2')
    })
})

describe('theme colour controls', () => {
    it('a colour input bound to a theme variable is never given a value that is not #rrggbb', async () => {
        document.documentElement.style.setProperty('--tc-x', 'oklch(0.852 0.199 91.936)')
        const set = vi.spyOn(HTMLInputElement.prototype, 'value', 'set')
        await mount(`<section x-edit="tc"><p>T</p></section><input type="color" id="tc" x-edit.cssvar="--tc-x">`)
        await new Promise(r => setTimeout(r, 500))
        expect(set.mock.calls.filter(([v]) => !/^#[0-9a-f]{6}$/i.test(v))).toEqual([])
        set.mockRestore()
        document.documentElement.style.removeProperty('--tc-x')
    })
})

describe('focus and blur without a change', () => {
    it('log nothing, for every kind of field, and leave a rich field its editing line', async () => {
        const root = await mount(`<div x-data="{ rows: [{ id: 1, name: 'Rose' }] }">
            <section x-edit="nb1">
                <p id="leaf">Plain <b>leaf</b></p>
                <div id="r1" x-rich-text.html><p>Block intro</p><ul><li>Item</li></ul></div>
                <div id="r2" x-rich-text.html><p>Grid</p><table><tbody><tr><td>x</td></tr></tbody></table></div>
                <div id="r3" x-rich-text.html><pre><code>let x</code></pre></div>
                <div id="r4" x-rich-text><p>Markdown <strong>field</strong></p><ul><li>a</li></ul></div>
                <div id="r5" x-rich-text.plain>Plain field</div>
                <p><span id="r6" x-rich-text.html.inline>Inline <b>rich</b></span></p>
            </section>
            <ul x-edit.data="nb2"><template x-for="r in rows" :key="r.id"><li :data-key="r.id" x-text="r.name"></li></template></ul></div>`)
        await new Promise(r => setTimeout(r, 0))
        const at = cursor()
        const shown = (el) => el.innerHTML
        const targets = ['#leaf', '#r1', '#r2', '#r3', '#r4', '#r5', '#r6', 'ul li'].map(s => root.querySelector(s))
        const before = targets.map(shown)
        for (const el of targets) {
            el.focus(); el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); el.dispatchEvent(new FocusEvent('focus'))
            await frame()
            el.dispatchEvent(new FocusEvent('blur')); el.blur(); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
            await flush()
        }
        expect(cursor()).toBe(at)
        expect(log().length).toBe(at)
        expect(targets.map(shown)).toEqual(before)                                       // nothing written back into them
        expect(root.querySelector('#r1').lastElementChild.tagName).toBe('P')            // the line after the list stays
    })
})

describe('tables in a rich field', () => {
    it('focus, click (on a border too), type and blur log only the typed text: no widths, no colgroup', async () => {
        const root = await mount(`<section x-edit="tb1"><div id="tf" x-rich-text.html><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table></div></section>`)
        const fld = root.querySelector('#tf'), td = fld.querySelector('td')
        const at = cursor()
        const efp = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => td)        // the pointer is on the cell's border
        fld.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        const pd = (type, x = 0) => td.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 0 }))
        pd('pointerdown'); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))   // a click on (what reads as) a border
        td.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        efp.mockRestore()
        expect(fld.querySelector('colgroup')).toBe(null)
        expect(fld.querySelector('table').getAttribute('style')).toBe(null)
        const t = text(td); t.nodeValue = 'ax'; select(t, 2)
        fld.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'x' }))
        fld.dispatchEvent(new FocusEvent('blur'))
        expect(cursor()).toBe(at + 1)
        expect(log().at(-1).value).toBe('<table><tbody><tr><td>ax</td><td>b</td></tr></tbody></table>')
    })

})

describe('column resizing', () => {
    it('tracks the pointer: width moves between neighbours, widths add up, the table stays within the field', async () => {
        const root = await mount(`<div id="cf" x-rich-text.html style="padding: 0"><table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table></div>`)
        const fld = root.querySelector('#cf'), table = fld.querySelector('table'), cells = [...table.rows[0].cells]
        // Layout: three 200px columns in a 600px table filling a 600px field
        const rect = (w, left = 0) => ({ width: w, height: 20, left, top: 0, right: left + w, bottom: 20, x: left, y: 0 })
        const edge = (i) => layout.slice(0, i + 1).reduce((a, b) => a + b, 0)
        const widths = () => [...table.querySelectorAll('col')].map(c => parseFloat(c.style.width))
        let layout = [200, 200, 200]
        cells.forEach((c, i) => vi.spyOn(c, 'getBoundingClientRect').mockImplementation(() => rect(layout[i], edge(i) - layout[i])))
        vi.spyOn(table, 'getBoundingClientRect').mockImplementation(() => rect(layout.reduce((a, b) => a + b, 0)))
        Object.defineProperty(fld, 'clientWidth', { configurable: true, get: () => 600 })
        const drag = (cell, dx) => {
            const efp = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => cell)
            const x = edge(cells.indexOf(cell))                                            // on its right border
            cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 10 }))
            document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x + dx, clientY: 10 }))
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
            efp.mockRestore()
            const w = widths(), total = w.reduce((a, b) => a + b, 0)
            layout = w.map(p => p / 100 * parseFloat(table.style.width) / 100 * 600)   // as a browser renders them
            return { w, total }
        }
        fld.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        let r = drag(cells[0], 80)                                                        // between columns 1 and 2
        expect(r.w).toEqual([46.67, 20, 33.33])
        expect(r.total).toBeCloseTo(100, 5)
        expect(table.style.width).toBe('100%')
        expect(layout[0] - 200).toBeCloseTo(80, 0)                                        // the border moved with the pointer
        r = drag(cells[0], 500)                                                           // never past the neighbour's minimum
        expect(Math.round(layout[1])).toBe(28)
        expect(r.total).toBeCloseTo(100, 5)
        r = drag(cells[2], -60)                                                           // the outer border: last column and table
        expect(table.style.width).toBe('90%')
        expect(r.total).toBeCloseTo(100, 5)
        drag(cells[2], 400)                                                               // grows to the field, no further
        expect(table.style.width).toBe('100%')
    })
})

describe('column widths as columns change', () => {
    const setup = async (cols, tableWidth = 600) => {
        const group = cols ? `<colgroup>${cols.map(w => `<col style="width: ${w}%;">`).join('')}</colgroup>` : ''
        const n = cols ? cols.length : 3
        const root = await mount(`<div id="cw" x-rich-text.html><table${cols ? ' style="width: 100%; table-layout: fixed;"' : ''}>${group}<tbody><tr>${'<td>x</td>'.repeat(n)}</tr><tr>${'<td>y</td>'.repeat(n)}</tr></tbody></table></div>`)
        const fld = root.querySelector('#cw'), table = fld.querySelector('table')
        vi.spyOn(table, 'getBoundingClientRect').mockImplementation(() => ({ width: tableWidth, height: 40, left: 0, top: 0, right: tableWidth, bottom: 40, x: 0, y: 0 }))
        fld.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
        const widths = () => [...table.querySelectorAll('col')].map(c => parseFloat(c.style.width))
        const into = (i) => { const td = table.rows[0].cells[i]; select(td.firstChild || td, 0); document.dispatchEvent(new Event('selectionchange')) }
        return { fld, table, widths, into, api: fld._rt.api }
    }
    const sum = (a) => Math.round(a.reduce((x, y) => x + y, 0) * 100) / 100

    it("an added column takes an equal share, the others scale down; a removed one's share goes to all the others", async () => {
        const t = await setup([50, 30, 20])
        t.into(0); t.api['column-after']()
        expect(t.widths()).toEqual([37.5, 25, 22.5, 15])
        expect(t.table.rows[0].cells.length).toBe(4)
        t.into(1); t.api['column-remove']()
        expect(t.widths()).toEqual([50, 30, 20])                                         // spread over all the others, in proportion
        expect(sum(t.widths())).toBe(100)
    })

    it('many adds and removes never pile width onto a few columns', async () => {
        const t = await setup([25, 25, 25, 25])
        for (let i = 0; i < 15; i++) {
            t.into(t.table.rows[0].cells.length - 1); t.api['column-after']()
            t.into(1); t.api["column-remove"]()
        }
        const w = t.widths()
        expect(w.length).toBe(4)
        expect(sum(w)).toBe(100)
        expect(Math.max(...w) / Math.min(...w)).toBeLessThan(2.5)
    })

    it('no column falls under the minimum; a table without widths is left alone', async () => {
        let t = await setup([70, 20, 10], 200)                                              // 28px is 14% here
        t.into(0); t.api['column-before']()
        expect(t.widths().every(w => w >= 14 - 0.01)).toBe(true)
        expect(sum(t.widths())).toBe(100)
        t = await setup(null)
        t.into(0); t.api['column-after']()
        expect(t.table.querySelector('colgroup')).toBe(null)
        expect(t.table.getAttribute('style')).toBe(null)
    })
})
