/**
 * @vitest-environment happy-dom
 *
 * Audit fixes: stored XSS in both serializers, controls that act without a
 * caret, history that drops or desyncs steps, IME, .plain paste and formatting,
 * menu tracking, stylesheet scoping, and tables pasted into markdown.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.rich.text.js'), 'utf8')
const CSS = readFileSync(path.join(__dirname, '../src/styles/elements/manifest.rich.text.css'), 'utf8')

beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    new Function(SRC)()
    Alpine.start()
})

const TE = () => window.ManifestRichText
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
const focusout = (el, relatedTarget = null) =>
    el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true, relatedTarget }))

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
const input = (el, init) => el.dispatchEvent(new window.InputEvent('input', { bubbles: true, ...init }))
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
const parse = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d }
const text = (area) => area.querySelector('p').firstChild

let inserted
beforeEach(() => {
    document.body.replaceChildren()
    window.getSelection().removeAllRanges()
    inserted = []
    // happy-dom has no execCommand; record what the plugin would insert.
    document.execCommand = vi.fn((cmd, _ui, value) => { if (cmd === 'insertHTML') inserted.push(value); return true })
})
afterEach(() => { vi.restoreAllMocks() })

describe('1. markdown mode cannot store live markup through link/image syntax', () => {
    it('keeps a quote inside an image src from opening an attribute', () => {
        const host = parse(TE().fromMarkdown('![a](x"onerror="location=name)'))
        expect(host.querySelector('[onerror]')).toBe(null)
        const img = host.querySelector('img')
        expect(img && img.attributes.length).toBe(2)            // src + alt, nothing smuggled
    })

    it('keeps a quote inside a link href from opening an attribute', () => {
        const host = parse(TE().fromMarkdown('[a](x"onmouseover="alert`1`)'))
        expect(host.querySelector('[onmouseover]')).toBe(null)
    })

    it('writes a bound markdown value through the sanitizer', () => {
        const root = mount(`<div x-data="{ post: '![a](x&quot;onerror=&quot;location=name)' }"><div x-rich-text="post" id="a"></div></div>`)
        expect(root.querySelector('#a [onerror]')).toBe(null)
    })

    it('applies one URL policy: no script schemes, data: only for images', () => {
        const md = (s) => parse(TE().fromMarkdown(s))
        expect(md('[x](data:text/html,<b>)').querySelector('a')).toBe(null)
        expect(md('[x](vbscript:msgbox)').querySelector('a')).toBe(null)
        expect(md('![x](data:text/html,1)').querySelector('img')).toBe(null)
        expect(md('![x](data:image/png;base64,AAAA)').querySelector('img')).not.toBe(null)
        // A tab inside the scheme is ignored by the URL parser, so it must not get past us.
        const clean = parse(TE().sanitize('<a href="java&#9;script:alert(1)">x</a><img src="data:text/html,1">', true))
        expect(clean.querySelector('a').hasAttribute('href')).toBe(false)
        expect(clean.querySelector('img').hasAttribute('src')).toBe(false)
    })

    it('sanitizes markdown pasted as plain text', () => {
        const root = mount('<div x-rich-text id="a"><p>x</p></div>')
        const area = root.querySelector('#a')
        focusin(area); select(text(area), 1)
        paste(area, { 'text/plain': '![a](x"onerror="alert(1))' })
        expect(inserted.length).toBe(1)
        expect(parse(inserted[0]).querySelector('[onerror]')).toBe(null)
    })
})

describe('2. typed HTML is stored as text, not markup', () => {
    const roundTrip = (html) => {
        const md = TE().toMarkdown(parse(html))
        return { md, back: parse(TE().fromMarkdown(md)) }
    }

    it('escapes < and > in text so a markdown renderer cannot see a tag', () => {
        const { md, back } = roundTrip('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
        expect(md).toBe('\\<img src=x onerror=alert(1)\\>')
        expect(back.textContent).toBe('<img src=x onerror=alert(1)>')
        expect(back.querySelector('img')).toBe(null)
    })

    it('escapes an & that would read as an entity, and round-trips it', () => {
        const { md, back } = roundTrip('<p>Tom &amp; Jerry write &amp;lt; and &amp;#58;</p>')
        expect(md).toBe('Tom & Jerry write \\&lt; and \\&#58;')
        expect(back.textContent).toBe('Tom & Jerry write &lt; and &#58;')
    })

    it('keeps a line that starts with > a paragraph', () => {
        const { back } = roundTrip('<p>&gt; not a quote</p>')
        expect(back.querySelector('blockquote')).toBe(null)
        expect(back.textContent).toBe('> not a quote')
    })

    it('encodes characters that would end a link destination early', () => {
        const host = parse('<p><a href="https://x.test/a)<b>">t</a> <img alt="a](y" src="/p q.png"></p>')
        const md = TE().toMarkdown(host)
        expect(md).toBe('[t](https://x.test/a%29%3Cb%3E) ![a\\](y](/p%20q.png)')
        const back = parse(TE().fromMarkdown(md))
        expect(back.querySelector('a').getAttribute('href')).toBe('https://x.test/a%29%3Cb%3E')
        expect(back.querySelector('img').getAttribute('alt')).toBe('a](y')
    })
})

describe('3. an unknown command never turns a control into an area', () => {
    it.each([
        ['button', '<button x-rich-text.bold id="c">B</button>', 'strong'],
        ['select', '<select x-rich-text.heading id="c"><option>p</option></select>', null],
        ['a', '<a href="#" x-rich-text.italic id="c">I</a>', 'em'],
        ['input', '<input x-rich-text.link id="c">', 'a'],
    ])('%s', (_tag, html, hint) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        const root = mount(html)
        const c = root.querySelector('#c')
        expect(c.hasAttribute('contenteditable')).toBe(false)
        expect(c.hasAttribute('data-rich-text')).toBe(false)
        expect(c.getAttribute('role')).not.toBe('textbox')
        const said = warn.mock.calls.map(a => a.join(' ')).join('\n')
        expect(said).toMatch(/unknown command/)
        if (hint) expect(said).toContain(`.${hint}`)
    })

    it('the header comment names a real command', () => {
        expect(SRC.slice(0, 600)).not.toMatch(/x-rich-text\.bold/)
    })
})

describe('4. controls are disabled until the area has a caret', () => {
    it('stays disabled for an area that was never focused', async () => {
        const root = mount('<div x-rich-text id="a"><p>hi</p></div><button x-rich-text.strong id="b">B</button><button x-rich-text.undo id="u">U</button>')
        await tick()
        const [area, b, u] = ['#a', '#b', '#u'].map(s => root.querySelector(s))
        expect(b.getAttribute('aria-disabled')).toBe('true')
        expect(u.getAttribute('aria-disabled')).toBe('true')
        focusin(area); select(text(area), 0, 2)
        expect(b.getAttribute('aria-disabled')).toBe('false')
        expect(u.getAttribute('aria-disabled')).toBe('true')     // still nothing to undo
    })
})

describe('5. a released area is not restored by a toolbar click', () => {
    it('drops the saved range when another field takes focus', () => {
        const root = mount('<div id="dlg"><div x-rich-text id="a"><p>hello world</p></div><button x-rich-text.strong id="b">B</button></div><input id="other">')
        const [area, b, other] = ['#a', '#b', '#other'].map(s => root.querySelector(s))
        focusin(area); select(text(area), 0, 5)
        focusout(area, other)                       // browser order: the area lets go first
        other.focus(); focusin(other)
        expect(b.getAttribute('aria-disabled')).toBe('true')
        b.click()
        expect(area.querySelector('strong')).toBe(null)
        expect(document.activeElement).toBe(other)
    })

    it('a disabled control does not take focus on mousedown', async () => {
        const root = mount('<div x-rich-text id="a"><p>hi</p></div><select x-rich-text.block id="s"><option value="p">P</option></select><button x-rich-text.strong id="b">B</button>')
        await tick()
        for (const c of [root.querySelector('#s'), root.querySelector('#b')]) {
            expect(c.getAttribute('aria-disabled')).toBe('true')
            const ev = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
            c.dispatchEvent(ev)
            expect(ev.defaultPrevented).toBe(true)
        }
    })

    it('disabled controls still receive the pointer, so the click lands on them', () => {
        expect(CSS).toMatch(/\[data-rich-text-control\]\[aria-disabled=true\][^{]*\{[^}]*pointer-events:\s*auto/)
    })
})

describe('6. typing after a converted mark is unmarked', () => {
    it('moves text the browser typed into the mark back out after it', () => {
        const root = mount('<div x-rich-text id="a"><p>make </p></div>')
        const area = root.querySelector('#a')
        focusin(area)
        const node = text(area)
        for (const ch of '**bold**') { node.insertData(node.length, ch); select(node, node.length); input(area, { data: ch }) }
        const strong = area.querySelector('strong')
        expect(strong.textContent).toBe('bold')
        const r = window.getSelection().getRangeAt(0)
        expect(strong.contains(r.startContainer)).toBe(false)

        // Engines normalize a caret at the mark's edge back inside it.
        strong.firstChild.appendData('x')
        select(strong.firstChild, 5)
        input(area, { data: 'x' })
        expect(strong.textContent).toBe('bold')
        expect(area.querySelector('p').innerHTML).toBe('make <strong>bold</strong>x')
        const after = window.getSelection().getRangeAt(0)
        expect(strong.contains(after.startContainer)).toBe(false)
        expect(after.startContainer.nodeValue).toBe('x')
        expect(after.startOffset).toBe(1)
    })
})

describe('7. IME composition', () => {
    it('leaves Enter and Backspace to the IME while composing', () => {
        const root = mount('<div x-rich-text id="a"><p>ab</p></div>')
        const area = root.querySelector('#a')
        focusin(area); select(text(area), 2)
        expect(key(area, { key: 'Enter', isComposing: true }).defaultPrevented).toBe(false)
        expect(area.querySelectorAll('p').length).toBe(1)
        select(text(area), 0)
        expect(key(area, { key: 'Backspace', keyCode: 229 }).defaultPrevented).toBe(false)
        expect(key(area, { key: 'Tab', isComposing: true }).defaultPrevented).toBe(false)
    })

    it('applies an armed mark when composition ends, not mid-composition', () => {
        const root = mount('<div x-rich-text id="a"><p>ab</p></div><button x-rich-text.strong id="b">B</button>')
        const area = root.querySelector('#a')
        focusin(area)
        const node = text(area)
        select(node, 2)
        root.querySelector('#b').click()                       // arms bold for what comes next
        node.insertData(2, 'あ'); select(node, 3)
        input(area, { data: 'あ', isComposing: true })
        expect(area.querySelector('strong')).toBe(null)
        const end = new (window.CompositionEvent || window.Event)('compositionend', { bubbles: true, data: 'あ' })
        if (!('data' in end) || end.data !== 'あ') Object.defineProperty(end, 'data', { value: 'あ' })
        area.dispatchEvent(end)
        expect(area.querySelector('strong') && area.querySelector('strong').textContent).toBe('あ')
    })
})

describe('8–10. history', () => {
    const type = (area, node, s) => { node.appendData(s); select(node, node.length); input(area, { data: s.slice(-1) }) }

    it('8. undo works in .plain (plugin history)', () => {
        const root = mount('<div x-rich-text.plain id="a">hello</div>')
        const area = root.querySelector('#a')
        focusin(area); select(area.firstChild, 5)
        type(area, area.firstChild, ' world')
        const ev = key(area, { key: 'z', metaKey: true })
        expect(ev.defaultPrevented).toBe(true)
        expect(area.textContent).toBe('hello')
        key(area, { key: 'z', metaKey: true, shiftKey: true })
        expect(area.textContent).toBe('hello world')
    })

    it('9. the first undo inside the coalescing window is not swallowed', () => {
        const root = mount(`<div x-data="{ post: 'hello' }"><div x-rich-text="post" id="a"></div><button x-rich-text.undo id="u">U</button></div>`)
        const area = root.querySelector('#a'), u = root.querySelector('#u')
        focusin(area); select(text(area), 5)
        type(area, text(area), ' world')
        expect(u.getAttribute('aria-disabled')).toBe('false')
        key(area, { key: 'z', ctrlKey: true })
        expect(area.textContent).toBe('hello')
    })

    it('10. native undo/redo (Edit menu, shake) route to the plugin history', () => {
        const root = mount(`<div x-data="{ post: 'hello' }"><div x-rich-text="post" id="a"></div></div>`)
        const area = root.querySelector('#a')
        focusin(area); select(text(area), 5)
        type(area, text(area), ' world')
        const undo = beforeinput(area, 'historyUndo')
        expect(undo.defaultPrevented).toBe(true)
        expect(area.textContent).toBe('hello')
        const redo = beforeinput(area, 'historyRedo')
        expect(redo.defaultPrevented).toBe(true)
        expect(area.textContent).toBe('hello world')
    })
})

describe('11. .plain', () => {
    it('keeps the lines of a multi-line paste', () => {
        const root = mount('<div x-rich-text.plain id="a">ab</div>')
        const area = root.querySelector('#a')
        focusin(area); select(area.firstChild, 1)
        paste(area, { 'text/plain': 'one\ntwo <b>\r\nthree' })
        expect(area.innerHTML).toBe('aone<br>two &lt;b&gt;<br>threeb')
    })

    it('refuses formatting shortcuts and formatting input', () => {
        const root = mount('<div x-rich-text.plain id="a">ab</div>')
        const area = root.querySelector('#a')
        focusin(area); select(area.firstChild, 0, 2)
        for (const k of ['b', 'i', 'u']) expect(key(area, { key: k, metaKey: true }).defaultPrevented).toBe(true)
        expect(beforeinput(area, 'formatBold').defaultPrevented).toBe(true)
        expect(area.getAttribute('contenteditable')).toBe('plaintext-only')
    })
})

describe('12. the selection menu follows scrolling', () => {
    it('repositions on scroll while shown', async () => {
        let top = 100
        vi.spyOn(window.Range.prototype, 'getBoundingClientRect').mockImplementation(() =>
            ({ left: 10, top, width: 20, height: 10, right: 30, bottom: top + 10, x: 10, y: top }))
        const root = mount('<div x-rich-text id="a"><p>hello world</p></div><div x-rich-text-menu id="m"><button x-rich-text.strong>B</button></div>')
        const area = root.querySelector('#a')
        focusin(area); select(text(area), 0, 5)
        const y = () => document.documentElement.style.getPropertyValue('--rich-text-selection-y')
        expect(y()).toBe('100px')
        top = 40
        window.dispatchEvent(new window.Event('scroll'))
        await tick(50)
        expect(y()).toBe('40px')
    })
})

describe('13. stylesheet scoping', () => {
    it('only icon-only buttons get the compact icon padding', () => {
        expect(CSS).not.toMatch(/:where\(button\[data-rich-text-control\]\)\s*\{/)
        expect(CSS).toMatch(/button\[data-rich-text-control\]:has\(> svg:only-child\)/)
    })

    it('--rich-text-background applies to unstyled areas too', () => {
        expect(CSS).toMatch(/\.unstyle[^{]*--rich-text-background[^{]*\{[^}]*background:\s*var\(--rich-text-background\)/)
    })
})

describe('14. tables pasted into markdown', () => {
    const TABLE = '<table><tr><th>Stem</th><th>Price</th></tr><tr><td><b>Rose</b></td><td>4</td></tr></table>'

    it('become one paragraph per row with cells joined by " · "', () => {
        const root = mount('<div x-rich-text id="a"><p>x</p></div>')
        const area = root.querySelector('#a')
        focusin(area); select(text(area), 1)
        paste(area, { 'text/html': TABLE })
        expect(inserted[0]).toBe('<p>Stem · Price</p><p><b>Rose</b> · 4</p>')
    })

    it('flatten to one line in an .inline area', () => {
        const root = mount('<div x-rich-text.inline id="a">x</div>')
        const area = root.querySelector('#a')
        focusin(area); select(area.firstChild, 1)
        paste(area, { 'text/html': TABLE })
        expect(area.innerHTML).toBe('xStem · Price <b>Rose</b> · 4')
        expect(inserted).toEqual([])
    })

    it('serialize readably if one reaches a markdown document anyway', () => {
        expect(TE().toMarkdown(parse(TABLE))).toBe('Stem · Price\n\n**Rose** · 4')
    })
})
