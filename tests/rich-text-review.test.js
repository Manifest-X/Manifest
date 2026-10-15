/**
 * @vitest-environment happy-dom
 *
 * Review regressions: single-line fields stay single-line, html-only blocks in
 * markdown, block commands in cells and items, terms, captions, multi-argument
 * methods, pending attributes, modifier order, detach cleanup, markdown escapes.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.rich.text.js'), 'utf8')
const DTS = readFileSync(path.join(__dirname, '../src/scripts/manifest.d.ts'), 'utf8')

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
const key = (el, init) => { const ev = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(ev); return ev }
function beforeinput(el, inputType, data) {
    const ev = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data })
    el.dispatchEvent(ev)
    return ev
}
function transfer(el, type, data) {
    const ev = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: { getData: (t) => data[t] || '' } })
    el.dispatchEvent(ev)
    return ev
}
const firstText = (el) => document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
const api = (el) => el._rt.api
function area(format, html, start = 0, end) {
    const root = mount(`<div x-rich-text${format ? '.' + format : ''} id="a">${html}</div>`)
    const el = root.querySelector('#a')
    focusin(el); select(firstText(el), start, end)
    return el
}
const parse = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d }

let inserted
beforeEach(() => {
    document.body.replaceChildren()
    document.documentElement.removeAttribute('style')
    window.getSelection().removeAllRanges()
    inserted = []
    document.execCommand = vi.fn((cmd, _ui, value) => { if (cmd === 'insertHTML') inserted.push(value); return true })
})
afterEach(() => { vi.restoreAllMocks() })

describe('2. .inline stays one line', () => {
    it('a multi-line html drop is flattened at the drop point', () => {
        const el = area('html.inline', 'x', 1)
        const ev = transfer(el, 'drop', { 'text/html': '<p>a</p><p>b</p>' })
        expect(ev.defaultPrevented).toBe(true)
        expect(el.innerHTML).toBe('xa b')
    })

    it('a multi-line text drop is flattened; a one-line drop is left native', () => {
        const el = area('inline', 'x', 1)
        expect(transfer(el, 'drop', { 'text/plain': 'a\nb' }).defaultPrevented).toBe(true)
        expect(el.innerHTML).toBe('xa b')
        expect(transfer(el, 'drop', { 'text/plain': 'ab' }).defaultPrevented).toBe(false)
    })

    it.each(['insertText', 'insertReplacementText', 'insertCompositionText'])('%s with a newline lands as one line', (type) => {
        const el = area('html.inline', 'x', 1)
        expect(beforeinput(el, type, 'one\ntwo <b>').defaultPrevented).toBe(true)
        expect(el.innerHTML).toBe('xone two &lt;b&gt;')
        expect(beforeinput(el, type, 'plain').defaultPrevented).toBe(false)
    })

    it('settle flattens blocks and breaks that got in anyway', () => {
        const el = area('html.inline', 'x', 1)
        el.innerHTML = '<p>one</p><p>two<br>three</p>'
        el.dispatchEvent(new window.InputEvent('input', { bubbles: true }))
        expect(el.innerHTML).toBe('one two three')
    })

    it('read and inline markdown join with a space, never glue words', () => {
        const html = area('html.inline', 'x')
        html.innerHTML = 'one<br>two'
        expect(api(html).value).toBe('one two')
        document.body.replaceChildren()
        const md = area('inline', 'x')
        md.innerHTML = '<span>one</span><br><strong>two</strong>'
        expect(api(md).markdown()).toBe('one **two**')
    })
})

describe('3. html-only blocks pasted into markdown', () => {
    it('a description list becomes paragraphs', () => {
        const el = area('', '<p>x</p>', 1)
        transfer(el, 'paste', { 'text/html': '<dl><dt>Term</dt><dd>Definition</dd></dl>' })
        expect(inserted).toEqual(['<p>Term</p><p>Definition</p>'])
    })

    it('a figure and an address become paragraphs', () => {
        const el = area('', '<p>x</p>', 1)
        transfer(el, 'paste', { 'text/html': '<figure><p>Photo</p><figcaption>Caption</figcaption></figure><address>1 Main St</address>' })
        expect(inserted).toEqual(['<p>Photo</p><p>Caption</p><p>1 Main St</p>'])
    })

    it('markdown never glues the blocks of a container', () => {
        expect(RT().toMarkdown(parse('<dl><dt>Term</dt><dd>Definition</dd></dl>'))).toBe('Term\n\nDefinition')
        expect(RT().toMarkdown(parse('<figure><p>Photo</p><figcaption>Cap</figcaption></figure>'))).toBe('Photo\n\nCap')
    })

    it('html mode keeps them', () => {
        const el = area('html', '<p>x</p>', 1)
        transfer(el, 'paste', { 'text/html': '<dl><dt>T</dt><dd>D</dd></dl>' })
        expect(inserted).toEqual(['<dl><dt>T</dt><dd>D</dd></dl>'])
    })
})

describe('4. block commands in cells and list items stay valid', () => {
    const cell = (html = 'cell') => {
        const el = area('html', `<table><tbody><tr><td>${html}</td><td>b</td></tr></tbody></table>`, 2)
        return el
    }
    const td = (el) => el.querySelector('td')

    it.each([
        ['h2', '<h2>cell</h2>'],
        ['blockquote', '<blockquote>cell</blockquote>'],
        ['address', '<address>cell</address>'],
        ['ul', '<ul><li>cell</li></ul>'],
        ['li', '<ul><li>cell</li></ul>'],
        ['dl', '<dl><dt>cell</dt><dd><br></dd></dl>'],
        ['figure', '<figure><p>cell</p><figcaption><br></figcaption></figure>'],
    ])('.%s nests inside the cell', (id, inner) => {
        const el = cell()
        api(el).run(id)
        expect(td(el).innerHTML).toBe(inner)
        expect(el.querySelector('tr').children.length).toBe(2)
        expect([...el.querySelector('tr').children].every(c => c.tagName === 'TD')).toBe(true)
    })

    it('Enter in a cell makes paragraphs inside it', () => {
        const el = cell('ab')
        select(td(el).firstChild, 1)
        key(el, { key: 'Enter' })
        expect(td(el).innerHTML).toBe('<p>a</p><p>b</p>')
        expect(el.querySelector('tr').children.length).toBe(2)
    })

    it('Backspace at the start of a cell never merges cells', () => {
        const el = area('html', '<table><tbody><tr><td>a</td><td>bc</td></tr></tbody></table>')
        select(el.querySelectorAll('td')[1].firstChild, 0)
        key(el, { key: 'Backspace' })
        expect(el.querySelectorAll('td').length).toBe(2)
        expect(el.querySelectorAll('td')[1].textContent).toBe('bc')
    })

    it('.figure and .dl lift a list item out first', () => {
        const el = area('html', '<ul><li>one</li><li>two</li></ul>')
        select(el.querySelectorAll('li')[1].firstChild, 1)
        api(el).run('figure')
        expect(el.querySelector('ul').outerHTML).toBe('<ul><li>one</li></ul>')
        expect(el.querySelector('figure').innerHTML).toBe('<p>two</p><figcaption><br></figcaption>')
        expect(el.querySelector('ul figure, figure li')).toBe(null)
    })

    it('.figure on a term lifts it out of the list', () => {
        const el = area('html', '<dl><dt>a</dt><dd>b</dd></dl>')
        select(el.querySelector('dd').firstChild, 1)
        api(el).run('figure')
        expect(el.querySelector('dl figure')).toBe(null)
        expect(el.querySelector('figure > p').textContent).toBe('b')
    })
})

describe('5. dt/dd retag the term, never a nested block', () => {
    it('dt() in <dd><p>x</p></dd> retags the dd', () => {
        const el = area('html', '<dl><dt>a</dt><dd><p>x</p></dd></dl>')
        select(el.querySelector('dd p').firstChild, 1)
        api(el).run('dt')
        expect(el.querySelector('dl').innerHTML).toBe('<dt>a</dt><dt><p>x</p></dt>')
        expect(el.querySelector('dd dt, dt dt')).toBe(null)
    })
})

describe('7. multi-argument methods', () => {
    it('$rich.img(src, alt) keeps them apart', () => {
        const el = area('html', '<p>x</p>', 1)
        api(el).img('/cat.png', 'A cat')
        expect(inserted).toEqual(['<img src="/cat.png" alt="A cat">'])
    })

    it('a single-argument command ignores extra arguments', () => {
        const el = area('html', '<p>hello</p>', 0, 5)
        api(el).a('https://example.com', 'extra')
        expect(el.querySelector('a').getAttribute('href')).toBe('https://example.com')
    })
})

describe('8. a collapsed caret keeps the attribute value', () => {
    const typeAt = (el, text) => {
        const node = el.querySelector('p').firstChild, at = window.getSelection().getRangeAt(0).startOffset
        node.insertData(at, text)
        select(node, at + text.length)
        el.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: text }))
    }

    it.each([['abbr', 'HyperText', 'title'], ['data', '42', 'value'], ['time', '2026-10-15', 'datetime'], ['bdo', 'ltr', 'dir']])('.%s', (tag, value, attr) => {
        const el = area('html', '<p>hello</p>', 5)
        api(el)[tag](value)
        typeAt(el, 'X')
        expect(el.querySelector(tag).getAttribute(attr)).toBe(value)
        expect(el.querySelector(tag).textContent).toBe('X')
    })

    it('bdo still defaults to rtl', () => {
        const el = area('html', '<p>hello</p>', 5)
        api(el).bdo()
        typeAt(el, 'X')
        expect(el.querySelector('bdo').getAttribute('dir')).toBe('rtl')
    })
})

describe('modifier order', () => {
    it.each(['x-rich-text.align.all.center', 'x-rich-text.align.center.all', 'x-rich-text.all.align.center'])('%s', async (attr) => {
        const root = mount(`<div x-rich-text id="a"><p>x</p></div><button ${attr} id="b">C</button>`)
        await tick()
        root.querySelector('#b').click()
        expect(root.querySelector('#a').style.getPropertyValue('--rich-text-align')).toBe('center')
    })
})

describe('detach() cleanup', () => {
    it('clears the .all properties it set and keeps authored ones', () => {
        document.body.innerHTML = '<div id="t" style="--rich-text-color: red">x</div>'
        const el = document.getElementById('t')
        const field = RT().attach(el)
        field.all = { font: 'Georgia', color: 'blue' }
        field.detach()
        expect(el.style.getPropertyValue('--rich-text-font')).toBe('')
        expect(el.style.getPropertyValue('--rich-text-color')).toBe('red')
    })

    it('clears the root selection variables once no editor remains', () => {
        vi.spyOn(window.Range.prototype, 'getBoundingClientRect').mockImplementation(() =>
            ({ left: 1, top: 2, width: 3, height: 4, right: 4, bottom: 6, x: 1, y: 2 }))
        document.body.innerHTML = '<p id="t">hello</p><p id="u">world</p>'
        const one = RT().attach(document.getElementById('t'), { mode: 'inline' })
        const two = RT().attach(document.getElementById('u'), { mode: 'inline' })
        const t = document.getElementById('t')
        focusin(t); select(t.firstChild, 0, 3)
        const root = document.documentElement
        expect(root.style.getPropertyValue('--rich-text-selection-y')).toBe('2px')
        one.detach()
        expect(root.style.getPropertyValue('--rich-text-selection-y')).toBe('2px')
        two.detach()
        expect(root.style.getPropertyValue('--rich-text-selection-y')).toBe('')
        expect(root.hasAttribute('data-rich-text-selected')).toBe(false)
    })
})

describe('markdown escapes round-trip as literal text', () => {
    const roundTrip = (text) => {
        const host = parse('')
        const p = document.createElement('p'); p.textContent = text; host.appendChild(p)
        const md = RT().toMarkdown(host)
        const back = parse(RT().fromMarkdown(md))
        return { md, back }
    }

    it.each(['~~x~~', '# not a heading', '###### six', '- not a list', '+ not a list', '* not a list', '1. not a list', '> not a quote', '---'])('%s', (text) => {
        const { back } = roundTrip(text)
        expect(back.children.length).toBe(1)
        expect(back.firstElementChild.tagName).toBe('P')
        expect(back.textContent).toBe(text)
    })

    it('escapes a marker after a hard break too', () => {
        const host = parse('<p>line<br># two</p>')
        const back = parse(RT().fromMarkdown(RT().toMarkdown(host)))
        expect(back.querySelector('h1')).toBe(null)
        expect(back.textContent).toBe('line# two')
    })

    it('real markdown still converts', () => {
        expect(RT().fromMarkdown('# Head\n\n- item\n\n~~gone~~')).toBe('<h1>Head</h1><ul><li>item</li></ul><p><s>gone</s></p>')
    })
})

describe('re-review regressions', () => {
    const md = (html) => RT().toMarkdown(parse(html))
    const back = (markdown) => md(RT().fromMarkdown(markdown))

    it.each(['`\\d+\\.\\d+`', '`a\\-b \\+c \\#d`', '`x\\\\y`', '`*not em*`', 'Text with `a_b_c` code.'])('A. code span %s keeps its backslashes', (src) => {
        expect(back(src)).toBe(src)
    })

    it('A. code span content is verbatim html', () => {
        expect(RT().fromMarkdown('`\\d+\\.\\d+`')).toBe('<p><code>\\d+\\.\\d+</code></p>')
    })

    it('A. an escaped backtick outside code stays literal', () => {
        expect(RT().fromMarkdown('a \\` b')).toBe('<p>a ` b</p>')
    })

    it('A. fenced code keeps backslashes', () => {
        expect(back('```\n\\d+\\.\\d+ \\# \\-\n```')).toBe('```\n\\d+\\.\\d+ \\# \\-\n```')
    })

    it.each([[['3x2'], [3, 2]], [[[3, 2]], [3, 2]], [[4, 1], [4, 1]]])('C. table(%j) is columns × rows', (args, want) => {
        const el = area('html', '<p>x</p>', 1)
        api(el).table(...args)
        const host = parse(inserted[0]), rows = host.querySelectorAll('tr')
        expect([rows[0].cells.length, rows.length]).toEqual(want)
    })

    it('D. inline markdown stores no line-start escapes and reloads them literally', () => {
        const root = mount(`<div x-data="{ t: '1. Introduction' }"><div x-rich-text.inline="t" id="a"></div></div>`)
        const el = root.querySelector('#a')
        expect(el.innerHTML).toBe('1. Introduction')
        expect(api(el).value).toBe('1. Introduction')
        api(el).value = '# Not a heading - really'
        expect(el.innerHTML).toBe('# Not a heading - really')
        expect(api(el).value).toBe('# Not a heading - really')
    })

    it('table cells join their paragraphs with a space', () => {
        const el = area('html', '<table><tbody><tr><td><p>a</p><p>b</p></td><td>c</td></tr></tbody></table>')
        expect(api(el).markdown()).toBe('a b · c')
    })

    it.each(['a<br>  1. b', 'a<br>  - b', 'a<br>   # b'])('a line after a break with leading spaces stays text: %s', (html) => {
        const out = parse(RT().fromMarkdown(md(`<p>${html}</p>`)))
        expect(out.querySelector('ol, ul, h1')).toBe(null)
        expect(out.textContent.replace(/\s+/g, ' ')).toBe(parse(html).textContent.replace(/\s+/g, ' '))
    })

    it('.inline backstop keeps one space at block boundaries, never doubled', () => {
        const el = area('html.inline', 'x', 1)
        el.innerHTML = 'bbx<p>y</p>z <strong> w</strong><br> v'
        el.dispatchEvent(new window.InputEvent('input', { bubbles: true }))
        expect(el.innerHTML).toBe('bbx y z <strong>w</strong> v')
    })

    it('.inline.html paste is inserted by hand, never via execCommand', () => {
        const el = area('html.inline', 'x', 1)
        transfer(el, 'paste', { 'text/html': '<span style="font-size: 16px">one</span> <b style="color:red">two</b>' })
        expect(inserted).toEqual([])
        expect(document.execCommand).not.toHaveBeenCalledWith('insertHTML', expect.anything(), expect.anything())
        expect(el.innerHTML).toBe('xone <b>two</b>')
        expect(api(el).value).toBe('xone <b>two</b>')
    })
})

describe('third-pass regressions', () => {
    it.each([
        ['one <img alt="i" src="/i.png"> two', 'one <img alt="i" src="/i.png"> two'],
        ['a <img alt="1" src="/1.png"> <img alt="2" src="/2.png"> b', 'a <img alt="1" src="/1.png"> <img alt="2" src="/2.png"> b'],
        ['x<img alt="i" src="/i.png"> ', 'x<img alt="i" src="/i.png">'],
        ['a<wbr> b', 'a<wbr> b'],
    ])('the space after an image survives in .inline.html: %s', (html, want) => {
        const el = area('html.inline', 'x')
        el.innerHTML = html
        expect(api(el).value).toBe(want)
    })

    it('the space after an image survives in .inline markdown', () => {
        const root = mount(`<div x-data="{ t: 'one ![i](/i.png) two' }"><div x-rich-text.inline="t" id="a"></div></div>`)
        const el = root.querySelector('#a')
        expect(api(el).value).toBe('one ![i](/i.png) two')
    })

    it('the first undo after a value loads restores the caret, not offset 0', () => {
        const el = area('html.inline', 'x')
        api(el).value = 'hello world'
        focusin(el); select(el.firstChild, 5)
        transfer(el, 'paste', { 'text/plain': 'X' })
        expect(api(el).value).toBe('helloX world')
        api(el).undo()
        expect(api(el).value).toBe('hello world')
        const r = window.getSelection().getRangeAt(0), pre = document.createRange()
        pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset)
        expect(pre.toString().length).toBe(5)
    })
})

describe('9. command methods are typed', () => {
    it.each(['strong(', 'abbr(title?', 'img(src', 'table(columns?', 'h2(', 'figcaption(', 'undo(', "'row-before'("])('declares %s', (sig) => {
        expect(DTS).toContain(sig)
    })

    it('declares every command', () => {
        const missing = RT().commands().filter(c => !DTS.includes(/^[a-z0-9]+$/.test(c) ? ` ${c}(` : `'${c}'(`))
        expect(missing).toEqual([])
    })

    it('has no catch-all index signature', () => {
        expect(DTS).not.toMatch(/\[command: string\]: unknown/)
    })
})
