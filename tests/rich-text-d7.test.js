/**
 * @vitest-environment happy-dom
 *
 * Rich Text D7: tag-name commands (markdown vs html), .inline, .all,
 * columns × rows tables, and the attach() engine API.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.rich.text.js'), 'utf8')

beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    new Function(SRC)()
    Alpine.start()
})

const RT = () => window.ManifestRichText
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

function mount(html) {
    const root = document.createElement('div')
    root.setAttribute('x-data', '{}')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    return root
}

const focusin = (el) => el.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
function select(node, start, end) {
    const s = window.getSelection(), r = document.createRange()
    r.setStart(node, start); r.setEnd(node, end === undefined ? start : end)
    s.removeAllRanges(); s.addRange(r)
    document.dispatchEvent(new window.Event('selectionchange'))
}
const key = (el, init) => {
    const ev = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    el.dispatchEvent(ev)
    return ev
}
const beforeinput = (el, inputType) => {
    const ev = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType })
    el.dispatchEvent(ev)
    return ev
}
function paste(el, data) {
    const ev = new window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { getData: (t) => data[t] || '' } })
    el.dispatchEvent(ev)
    return ev
}
const api = (el) => el._rt.api
const firstText = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); return w.nextNode() }

// An area of the given format with the caret (or a selection) in its first paragraph
function area(format, html = '<p>hello world</p>', start = 0, end) {
    const root = mount(`<div x-rich-text${format ? '.' + format : ''} id="a">${html}</div>`)
    const el = root.querySelector('#a')
    focusin(el); select(firstText(el), start, end)
    return el
}

let inserted
beforeEach(() => {
    document.body.replaceChildren()
    window.getSelection().removeAllRanges()
    inserted = []
    document.execCommand = vi.fn((cmd, _ui, value) => { if (cmd === 'insertHTML') inserted.push(value); return true })
})
afterEach(() => { vi.restoreAllMocks() })

const INLINE = ['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins', 'kbd', 'mark',
    'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']
const BLOCK = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'address', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'figure', 'figcaption', 'hr']
const MARKDOWN = new Set(['a', 'b', 'br', 'code', 'del', 'em', 'i', 's', 'strong',
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'hr'])

describe('every HTML text element is a command', () => {
    it.each([...INLINE, ...BLOCK])('.%s', (tag) => {
        expect(RT().commands()).toContain(tag)
    })
})

describe('markdown availability', () => {
    const inlineTags = INLINE.filter(t => !['a', 'br', 'wbr'].includes(t))

    it.each(inlineTags)('inline .%s: markdown %s', (tag) => {
        const md = area('', '<p>hello world</p>', 0, 5)
        expect(api(md).can(tag)).toBe(MARKDOWN.has(tag))
        document.body.replaceChildren()
        const html = area('html', '<p>hello world</p>', 0, 5)
        expect(api(html).can(tag)).toBe(true)
    })

    it.each(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'address', 'ul', 'ol', 'li', 'dl', 'figure', 'hr'])('block .%s', (tag) => {
        const md = area('', '<p>hello world</p>', 2)
        expect(api(md).can(tag)).toBe(MARKDOWN.has(tag))
        document.body.replaceChildren()
        const html = area('html', '<p>hello world</p>', 2)
        expect(api(html).can(tag)).toBe(true)
    })

    it('.br is markdown, .wbr is html only', () => {
        expect(api(area('', '<p>hello</p>', 2)).can('br')).toBe(true)
        expect(api(area('', '<p>hello</p>', 2)).can('wbr')).toBe(false)
        document.body.replaceChildren()
        expect(api(area('html', '<p>hello</p>', 2)).can('wbr')).toBe(true)
    })

    it('an html-only command does nothing in markdown, even through .block', () => {
        const el = area('', '<p>hello world</p>', 0, 5)
        api(el).run('u')
        api(el).run('block', 'address')
        api(el).run('dl')
        expect(el.querySelector('u, address, dl')).toBe(null)
        expect(api(el).value).toBe('hello world')
    })

    it('dt, dd and figcaption need their container', () => {
        const el = area('html', '<p>hello</p>', 2)
        expect(api(el).can('dt')).toBe(false)
        expect(api(el).can('dd')).toBe(false)
        expect(api(el).can('figcaption')).toBe(false)
    })
})

describe('new inline commands (html)', () => {
    const wrap = (tag, arg) => {
        const el = area('html', '<p>hello world</p>', 0, 5)
        api(el).run(tag, arg)
        return el
    }

    it('.bdi wraps the selection', () => {
        expect(wrap('bdi').querySelector('p').innerHTML).toBe('<bdi>hello</bdi> world')
    })

    it('.bdo defaults dir to rtl, or takes the argument', () => {
        expect(wrap('bdo').querySelector('bdo').getAttribute('dir')).toBe('rtl')
        document.body.replaceChildren()
        expect(wrap('bdo', 'ltr').querySelector('bdo').getAttribute('dir')).toBe('ltr')
    })

    it('.data takes its machine value', () => {
        expect(wrap('data', '42').querySelector('p').innerHTML).toBe('<data value="42">hello</data> world')
    })

    it('.time takes a datetime and .abbr a title', () => {
        expect(wrap('time', '2026-10-15').querySelector('time').getAttribute('datetime')).toBe('2026-10-15')
        document.body.replaceChildren()
        expect(wrap('abbr', 'Hello').querySelector('abbr').getAttribute('title')).toBe('Hello')
    })

    it('toggles off again', () => {
        const el = wrap('bdi')
        select(el.querySelector('bdi').firstChild, 0, 5)
        api(el).run('bdi')
        expect(el.querySelector('bdi')).toBe(null)
    })

    it('stores the tags and their attributes as html', () => {
        const el = wrap('data', '7')
        expect(api(el).value).toBe('<p><data value="7">hello</data> world</p>')
    })

    it('the sanitizer keeps only the meaningful attribute', () => {
        expect(RT().sanitize('<bdo dir="rtl" class="x">a</bdo><bdo dir="evil">b</bdo>', false))
            .toBe('<bdo dir="rtl">a</bdo><bdo>b</bdo>')
        expect(RT().sanitize('<data value="1" title="t">a</data><time datetime="2026" onclick="x()">b</time>', false))
            .toBe('<data value="1">a</data><time datetime="2026">b</time>')
    })

    it('.wbr inserts a break opportunity at the caret', () => {
        const el = area('html', '<p>hello</p>', 2)
        api(el).run('wbr')
        expect(el.querySelector('p').innerHTML).toBe('he<wbr>llo')
        expect(api(el).value).toBe('<p>he<wbr>llo</p>')
    })

    it('.br inserts through the browser', () => {
        const el = area('html', '<p>hello</p>', 2)
        api(el).run('br')
        expect(inserted).toEqual(['<br>'])
    })
})

describe('new block commands (html)', () => {
    it('.li joins the list above', () => {
        const el = area('html', '<ul><li>one</li></ul><p>two</p>')
        select(el.querySelector('p').firstChild, 1)
        api(el).run('li')
        expect(el.innerHTML).toBe('<ul><li>one</li><li>two</li></ul><p><br></p>')
    })

    it('.li starts a list, and toggles back to a paragraph', () => {
        const el = area('html', '<p>one</p>', 1)
        api(el).run('li')
        expect(el.querySelector('ul > li').textContent).toBe('one')
        api(el).run('li')
        expect(el.querySelector('ul')).toBe(null)
        expect(el.querySelector('p').textContent).toBe('one')
    })

    it('.li is markdown-storable', () => {
        const el = area('', '<p>one</p>', 1)
        api(el).run('li')
        expect(api(el).value).toBe('- one')
    })

    it('.dl makes a term and a description, and unwraps', () => {
        const el = area('html', '<p>Term</p>', 2)
        api(el).run('dl')
        expect(el.querySelector('dl').outerHTML).toBe('<dl><dt>Term</dt><dd><br></dd></dl>')
        expect(api(el).can('dt')).toBe(true)
        api(el).run('dl')
        expect(el.querySelector('dl')).toBe(null)
        expect([...el.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Term', '', ''])   // term, description, trailing line
    })

    it('.dt and .dd retag inside a list', () => {
        const el = area('html', '<dl><dt>a</dt><dt>b</dt></dl>')
        select(el.querySelectorAll('dt')[1].firstChild, 1)
        api(el).run('dd')
        expect(el.querySelector('dl').innerHTML).toBe('<dt>a</dt><dd>b</dd>')
        api(el).run('dt')
        expect(el.querySelector('dl').innerHTML).toBe('<dt>a</dt><dt>b</dt>')
    })

    it('a heading lifts a term out of its list', () => {
        const el = area('html', '<dl><dt>a</dt><dd>b</dd></dl>')
        select(el.querySelector('dd').firstChild, 1)
        api(el).run('h2')
        expect(el.innerHTML).toBe('<dl><dt>a</dt></dl><h2>b</h2><p><br></p>')
    })

    it('Enter alternates term and description, and an empty one leaves the list', () => {
        const el = area('html', '<dl><dt>a</dt></dl>')
        select(el.querySelector('dt').firstChild, 1)
        key(el, { key: 'Enter' })
        expect(el.querySelector('dl').innerHTML).toBe('<dt>a</dt><dd><br></dd>')
        key(el, { key: 'Enter' })
        expect(el.querySelector('dl').innerHTML).toBe('<dt>a</dt>')
        expect(el.querySelector('dl + p')).not.toBe(null)
    })

    it('.figure wraps the block with a caption; .figcaption retags inside it', () => {
        const el = area('html', '<p>photo</p><p>after</p>', 1)
        api(el).run('figure')
        expect(el.querySelector('figure').innerHTML).toBe('<p>photo</p><figcaption><br></figcaption>')
        el.querySelector('figcaption').remove()
        select(el.querySelector('figure p').firstChild, 1)
        expect(api(el).can('figcaption')).toBe(true)
        api(el).run('figcaption')
        expect(el.querySelector('figure').innerHTML).toBe('<figcaption>photo</figcaption>')
    })

    it('.figcaption never makes a second caption: the caret moves into the existing one', () => {
        const el = area('html', '<figure><p>photo</p><figcaption>cap</figcaption></figure>')
        select(el.querySelector('figure p').firstChild, 1)
        api(el).run('figcaption')
        expect(el.querySelectorAll('figcaption').length).toBe(1)
        expect(el.querySelector('figure').innerHTML).toBe('<p>photo</p><figcaption>cap</figcaption>')
        expect(el.querySelector('figcaption').contains(window.getSelection().getRangeAt(0).startContainer)).toBe(true)
    })

    it('.address retags the block', () => {
        const el = area('html', '<p>1 Main St</p>', 1)
        api(el).run('address')
        expect(api(el).value).toBe('<address>1 Main St</address>')
    })

    it('.hr inserts a rule', () => {
        const el = area('html', '<p>x</p>', 1)
        api(el).run('hr')
        expect(inserted).toEqual(['<hr><p><br></p>'])
    })

    it('.block reaches the new block commands', () => {
        const el = area('html', '<p>one</p>', 1)
        api(el).run('block', 'dl')
        expect(el.querySelector('dl > dt').textContent).toBe('one')
    })
})

describe('tables are columns × rows', () => {
    const rowsAndCols = () => {
        const host = document.createElement('div'); host.innerHTML = inserted[0]
        const rows = host.querySelectorAll('tr')
        return [rows[0].cells.length, rows.length]
    }

    it('$rich.table(3, 2) is 3 columns, 2 rows', () => {
        const el = area('html', '<p>x</p>', 1)
        api(el).table(3, 2)
        expect(rowsAndCols()).toEqual([3, 2])
    })

    it('a "CxR" argument reads columns first', () => {
        const el = area('html', '<p>x</p>', 1)
        api(el).run('table', '4x1')
        expect(rowsAndCols()).toEqual([4, 1])
    })

    it('a control argument reads columns first', () => {
        const root = mount('<div x-rich-text.html id="a"><p>x</p></div><button x-rich-text.table.2x5 id="b">T</button>')
        const el = root.querySelector('#a')
        focusin(el); select(firstText(el), 1)
        root.querySelector('#b').click()
        expect(rowsAndCols()).toEqual([2, 5])
    })

    it('defaults to 3 × 3', () => {
        const el = area('html', '<p>x</p>', 1)
        api(el).table()
        expect(rowsAndCols()).toEqual([3, 3])
    })
})

describe('.inline', () => {
    it('keeps content inline, with no paragraph wrapper', () => {
        const el = area('html.inline', 'Hello <strong>there</strong>')
        expect(el.innerHTML).toBe('Hello <strong>there</strong>')
        expect(el.getAttribute('aria-multiline')).toBe('false')
        expect(el.hasAttribute('data-rich-text-inline')).toBe(true)
        expect(api(el).value).toBe('Hello <strong>there</strong>')
    })

    it('flattens authored blocks to one line', () => {
        const el = area('html.inline', '<p>one</p><p>two</p>')
        expect(el.innerHTML).toBe('one two')
    })

    it('Enter makes no paragraph and fires rich-text:enter', () => {
        const el = area('inline', 'Title', 5)
        const seen = []
        el.addEventListener('rich-text:enter', (e) => seen.push(e.detail))
        expect(key(el, { key: 'Enter' }).defaultPrevented).toBe(true)
        expect(key(el, { key: 'Enter', shiftKey: true }).defaultPrevented).toBe(true)
        expect(el.querySelector('p, br')).toBe(null)
        expect(el.innerHTML).toBe('Title')
        expect(seen).toEqual([{ value: 'Title', shiftKey: false }, { value: 'Title', shiftKey: true }])
    })

    it('blocks native paragraph and line-break input', () => {
        const el = area('inline', 'Title', 5)
        expect(beforeinput(el, 'insertParagraph').defaultPrevented).toBe(true)
        expect(beforeinput(el, 'insertLineBreak').defaultPrevented).toBe(true)
        expect(beforeinput(el, 'insertText').defaultPrevented).toBe(false)
    })

    it('Enter is blocked in .plain.inline too', () => {
        const el = area('plain.inline', 'Title', 5)
        expect(key(el, { key: 'Enter' }).defaultPrevented).toBe(true)
    })

    it('flattens a multi-paragraph html paste to one line', () => {
        const el = area('html.inline', 'x', 1)
        paste(el, { 'text/html': '<h1>Big</h1>\n<p>one <em>two</em></p><ul><li>three</li><li>four<br>five</li></ul>' })
        expect(el.innerHTML).toBe('xBig one <em>two</em> three four five')
    })

    it('flattens a multi-line text paste to one line', () => {
        const el = area('inline', 'x', 1)
        paste(el, { 'text/plain': 'one\n\ntwo **bold**\nthree' })
        expect(el.innerHTML).toBe('xone two <strong>bold</strong> three')
    })

    it('flattens a plain paste in .plain.inline', () => {
        const el = area('plain.inline', 'x', 1)
        paste(el, { 'text/plain': 'one\ntwo' })
        expect(el.innerHTML).toBe('xone two')
    })

    it('makes block commands and line breaks unavailable, inline ones available', () => {
        const el = area('html.inline', 'hello world', 0, 5)
        for (const id of ['p', 'h1', 'h2', 'blockquote', 'pre', 'address', 'ul', 'ol', 'li', 'dl', 'figure', 'hr', 'table', 'checklist', 'indent', 'align', 'block', 'br']) {
            expect(api(el).can(id), `.${id}`).toBe(false)
        }
        for (const id of ['strong', 'em', 'u', 'mark', 'code', 'a', 'sup', 'bdi', 'data', 'wbr', 'clear']) {
            expect(api(el).can(id), `.${id}`).toBe(true)
        }
        api(el).run('h2')
        expect(el.querySelector('h2')).toBe(null)
    })

    it('allows inline formatting and stores inline markdown', () => {
        const el = area('inline', 'hello world', 0, 5)
        api(el).run('strong')
        expect(api(el).value).toBe('**hello** world')
    })

    it('loads a bound markdown value as one line', () => {
        const root = mount(`<div x-data="{ t: 'one\\n\\n*two*' }"><div x-rich-text.inline="t" id="a"></div></div>`)
        const el = root.querySelector('#a')
        expect(el.innerHTML).toBe('one <em>two</em>')
    })

    it('Tab keeps native focus order', () => {
        const el = area('inline', 'Title', 5)
        expect(key(el, { key: 'Tab' }).defaultPrevented).toBe(false)
    })

    it('.minimal is gone', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        mount('<div x-rich-text.minimal id="a">x</div>')
        expect(warn.mock.calls.map(a => a.join(' ')).join('\n')).toMatch(/unknown modifier: \.minimal — did you mean \.inline\?/)
    })
})

describe('.all', () => {
    it('writes a document-wide style as a variable on the area', async () => {
        const root = mount('<div x-rich-text id="a"><p>hello</p></div><select x-rich-text.font.all id="f"><option value="">-</option><option value="Georgia">G</option></select>')
        const el = root.querySelector('#a'), f = root.querySelector('#f')
        const seen = []
        el.addEventListener('rich-text:all', (e) => seen.push(e.detail))
        await tick()
        expect(f.hasAttribute('data-rich-text-all')).toBe(true)
        expect(f.getAttribute('aria-disabled')).toBe('false')     // needs no caret
        f.value = 'Georgia'
        f.dispatchEvent(new window.Event('change'))
        expect(el.style.getPropertyValue('--rich-text-font')).toBe('Georgia')
        expect(api(el).all).toEqual({ font: 'Georgia' })
        expect(seen).toEqual([{ font: 'Georgia' }])
        expect(api(el).value).toBe('hello')                      // never in the stored value
    })

    it('$rich.all is assignable and clears with {}', () => {
        const el = area('', '<p>hello</p>')
        api(el).all = { size: '18px', color: 'red' }
        expect(el.style.getPropertyValue('--rich-text-size')).toBe('18px')
        api(el).all = {}
        expect(api(el).all).toEqual({})
    })

    it('.page is not a modifier any more', () => {
        const root = mount('<div x-rich-text id="a"><p>hello</p></div><select x-rich-text.font.page id="f"><option>x</option></select>')
        expect(root.querySelector('#f').hasAttribute('data-rich-text-all')).toBe(false)
        expect(api(root.querySelector('#a')).page).toBe(undefined)
    })
})

describe('$rich', () => {
    it('resolves to the area and exposes every command as a method', () => {
        const root = mount('<div x-rich-text.html id="a"><p>hello world</p></div><button id="b">B</button>')
        const el = root.querySelector('#a')
        focusin(el); select(firstText(el), 0, 5)
        const rich = Alpine.evaluate(root.querySelector('#b'), '$rich')
        expect(typeof rich.strong).toBe('function')
        rich.strong()
        expect(el.querySelector('strong').textContent).toBe('hello')
    })

    it('has no-op methods when nothing resolves', () => {
        const root = mount('<button id="b">B</button>')
        const rich = Alpine.evaluate(root.querySelector('#b'), '$rich')
        expect(() => rich.strong()).not.toThrow()
        expect(rich.can('strong')).toBe(false)
        expect(rich.all).toEqual({})
    })
})

describe('ManifestRichText.attach()', () => {
    it('makes an element an inline html field without wrapping it', () => {
        document.body.innerHTML = '<h1 id="t">Hello <em>world</em></h1>'
        const h1 = document.getElementById('t')
        const changes = []
        const field = RT().attach(h1, { mode: 'inline', format: 'html', onChange: (v) => changes.push(v) })
        expect(h1.getAttribute('contenteditable')).toBe('true')
        expect(h1.getAttribute('data-rich-text')).toBe('html')
        expect(h1.hasAttribute('data-rich-text-inline')).toBe(true)
        expect(h1.hasAttribute('data-rich-text-bound')).toBe(true)
        expect(h1.innerHTML).toBe('Hello <em>world</em>')
        expect(field.el).toBe(h1)
        expect(field.value).toBe('Hello <em>world</em>')

        focusin(h1); select(h1.firstChild, 0, 5)
        field.strong()
        expect(h1.innerHTML).toBe('<strong>Hello</strong> <em>world</em>')
        expect(changes.at(-1)).toBe('<strong>Hello</strong> <em>world</em>')
        expect(field.can('h2')).toBe(false)
        expect(field.can('em')).toBe(true)
    })

    it('reports typing through onChange', () => {
        document.body.innerHTML = '<p id="t">Hi</p>'
        const el = document.getElementById('t')
        const changes = []
        RT().attach(el, { mode: 'inline', format: 'html', onChange: (v) => changes.push(v) })
        el.firstChild.nodeValue = 'Hi there'
        el.dispatchEvent(new window.InputEvent('input', { bubbles: true }))
        expect(changes).toEqual(['Hi there'])
    })

    it('loads an initial value in the given format', () => {
        document.body.innerHTML = '<div id="t"></div>'
        const field = RT().attach(document.getElementById('t'), { value: '# Title\n\nBody' })
        expect(field.html()).toBe('<h1>Title</h1><p>Body</p>')
        expect(field.value).toBe('# Title\n\nBody')
    })

    it('defaults to block markdown and wraps loose content in a paragraph', () => {
        document.body.innerHTML = '<div id="t">loose</div>'
        const el = document.getElementById('t')
        const field = RT().attach(el)
        expect(el.innerHTML).toBe('<p>loose</p>')
        expect(el.getAttribute('aria-multiline')).toBe('true')
        expect(field.value).toBe('loose')
    })

    it('drives authored controls and $rich once focused', async () => {
        const root = mount('<p id="t">hello world</p><button x-rich-text.em id="b">I</button><span id="s"></span>')
        const el = root.querySelector('#t'), b = root.querySelector('#b')
        RT().attach(el, { mode: 'inline', format: 'html' })
        focusin(el); select(el.firstChild, 6, 11)
        await tick()
        expect(b.getAttribute('aria-disabled')).toBe('false')
        b.click()
        expect(el.innerHTML).toBe('hello <em>world</em>')
        expect(Alpine.evaluate(root.querySelector('#s'), '$rich').value).toBe('hello <em>world</em>')
    })

    it('returns the same handle for an element already attached', () => {
        document.body.innerHTML = '<p id="t">x</p>'
        const el = document.getElementById('t')
        expect(RT().attach(el)).toBe(RT().attach(el))
        expect(RT().attach(null)).toBe(null)
    })

    it('detach() restores the element and stops editing', async () => {
        document.body.innerHTML = '<p id="t" contenteditable="false" role="heading">hello</p><button x-rich-text.strong id="b">B</button>'
        const el = document.getElementById('t')
        const changes = []
        const field = RT().attach(el, { mode: 'inline', format: 'html', onChange: (v) => changes.push(v) })
        focusin(el); select(el.firstChild, 0, 2)
        field.detach()
        expect(el.getAttribute('contenteditable')).toBe('false')
        expect(el.getAttribute('role')).toBe('heading')
        expect(el.hasAttribute('aria-multiline')).toBe(false)
        expect([...el.attributes].some(a => a.name.startsWith('data-rich-text'))).toBe(false)
        expect(el._rt).toBe(undefined)
        el.dispatchEvent(new window.InputEvent('input', { bubbles: true }))
        expect(changes).toEqual([])
        expect(key(el, { key: 'Enter' }).defaultPrevented).toBe(false)
        expect(field.can('strong')).toBe(false)
        field.strong()
        expect(el.innerHTML).toBe('hello')
        // A fresh attach works after detach
        const again = RT().attach(el, { format: 'html' })
        expect(again).not.toBe(field)
        again.detach()
    })
})
