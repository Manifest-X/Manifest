/**
 * @vitest-environment happy-dom
 *
 * x-text-edit stores markdown, so its two serializers have to be exact inverses over
 * everything the toolbar can author. A drift here is silent: the editor still looks
 * right while the stored value quietly loses structure on every save.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The plugin registers on alpine:init and exports its serializers on the window.
await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.text.edit.js'), 'utf8')
))
const { toMarkdown, fromMarkdown, sanitize } = window.ManifestTextEdit

const roundTrip = (md) => {
    const host = document.createElement('div')
    host.innerHTML = fromMarkdown(md)
    return toMarkdown(host)
}

describe('x-text-edit markdown round trip', () => {
    it.each([
        ['heading', '# Title'],
        ['inline marks', 'A **bold** and *italic* and ~~struck~~ and `code` line.'],
        ['bullet list', '- one\n- two\n- three'],
        ['ordered list', '1. first\n2. second'],
        ['nested list', '- one\n    - nested\n- two'],
        ['three levels', '- a\n    - b\n        - c\n- d'],
        ['mixed nesting', '1. first\n    - sub bullet\n2. second'],
        ['blockquote', '> quoted\n> lines'],
        ['rule', '---'],
        ['link', 'A [link](https://example.com) inline.'],
        ['code fence', '```\nconst x = 1;\n```'],
        ['paragraphs', 'Para one.\n\nPara two.'],
        ['hard break', 'Line one  \nLine two'],
        ['escapes', 'Escaped \\*not italic\\* here.'],
        ['nested marks', 'Mixed **bold `code` inside** text.'],
        ['document', '# Head\n\n- a\n- b\n\n> quote\n\nTail.'],
        ['image', 'An ![alt text](/cat.png) inline.'],
        ['task list', '- [ ] open\n- [x] done'],
        ['task list nested', '- [ ] parent\n    - [x] child'],
        ['deep headings', '#### Four\n\n##### Five\n\n###### Six'],
    ])('%s', (_name, md) => {
        expect(roundTrip(md)).toBe(md)
    })
})

describe('x-text-edit command surface', () => {
    const commands = window.ManifestTextEdit.commands()

    it('names every command for the tag it produces', () => {
        // The whole point of the rename: no Manifest vocabulary to map onto HTML.
        for (const tag of ['strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'code', 'mark', 'small',
            'sub', 'sup', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'time',
            'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'address',
            'figure', 'figcaption', 'dl', 'dt', 'dd', 'ul', 'ol', 'hr', 'a', 'img', 'table']) {
            expect(commands, `missing command .${tag}`).toContain(tag)
        }
    })

    it('excludes generic containers', () => {
        // The editable area is itself a <div>. Treating div/section as blocks lets the
        // block lookup walk past the paragraph onto the area, and a block command then
        // replaces the whole editor.
        for (const container of ['div', 'section', 'article', 'aside', 'main', 'body']) {
            expect(commands, `.${container} must not be a block command`).not.toContain(container)
        }
    })

    it('has no invented synonym for a tag that exists', () => {
        for (const invented of ['quote', 'bold', 'italic', 'strike', 'bullets', 'numbers', 'divider', 'link', 'paragraph']) {
            expect(commands, `.${invented} should be the tag name instead`).not.toContain(invented)
        }
    })

    it('keeps the operations that have no tag of their own', () => {
        for (const op of ['indent', 'outdent', 'align', 'color', 'background', 'font', 'size', 'checklist', 'clear', 'undo', 'redo', 'block']) {
            expect(commands).toContain(op)
        }
    })
})

describe('x-text-edit code blocks', () => {
    it('reads a <br> inside a <pre> as a line break', () => {
        // Chrome writes <br> into a <pre> rather than a newline. textContent alone
        // runs the lines together, which silently flattens every code block on save.
        const host = document.createElement('div')
        host.innerHTML = '<pre>const x = 1;<br>return x;</pre>'
        expect(toMarkdown(host)).toBe('```\nconst x = 1;\nreturn x;\n```')
    })

    it('does not accumulate trailing blank lines', () => {
        const host = document.createElement('div')
        host.innerHTML = '<pre>code<br><br></pre>'
        expect(toMarkdown(host)).toBe('```\ncode\n```')
    })
})

describe('x-text-edit tables', () => {
    it('keeps a merged cell merged', () => {
        // Without colspan/rowspan surviving, every merge comes apart on the next save
        // and the feature is decorative.
        expect(sanitize('<table><tbody><tr><td colspan="2">a</td></tr></tbody></table>', true, true))
            .toBe('<table><tbody><tr><td colspan="2">a</td></tr></tbody></table>')
        expect(sanitize('<table><tbody><tr><td rowspan="3">a</td></tr></tbody></table>', true, true))
            .toBe('<table><tbody><tr><td rowspan="3">a</td></tr></tbody></table>')
    })

    it('keeps column widths', () => {
        // Widths live on a colgroup; losing it on save would undo every resize.
        const html = '<table><colgroup><col style="width: 120px;"></colgroup><tbody><tr><td>a</td></tr></tbody></table>'
        expect(sanitize(html, true, true)).toBe(html)
    })

    it('keeps a header row', () => {
        const html = '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>b</td></tr></tbody></table>'
        expect(sanitize(html, true, true)).toBe(html)
    })

    it('refuses a span that is not a plain count', () => {
        expect(sanitize('<td colspan="evil()">a</td>', true, true)).toBe('<td>a</td>')
        expect(sanitize('<td colspan="0">a</td>', true, true)).toBe('<td>a</td>')
    })
})

describe('x-text-edit sanitize', () => {
    it('unwraps tags outside the allowlist but keeps their text', () => {
        expect(sanitize('<div><script>alert(1)</script>hi</div>', false)).toBe('hi')
    })

    it('keeps inline marks and strips their attributes', () => {
        expect(sanitize('<strong class="x" onclick="evil()">bold</strong>', false)).toBe('<strong>bold</strong>')
    })

    it('keeps a safe href but drops a javascript: one', () => {
        expect(sanitize('<a href="https://example.com">ok</a>', false)).toBe('<a href="https://example.com">ok</a>')
        expect(sanitize('<a href="javascript:evil()">bad</a>', false)).toBe('<a>bad</a>')
    })

    it('removes a script hoisted out of a stripped wrapper', () => {
        expect(sanitize('<div><script>alert(1)</script>hi</div>', false)).toBe('hi')
        expect(sanitize('<section><b><script>alert(1)</script>x</b></section>', true)).toBe('<b>x</b>')
    })

    it('strips an event handler smuggled under an allowed wrapper', () => {
        expect(sanitize('<span><a href="#" onmouseover="evil()">x</a></span>', false)).toBe('<span><a href="#">x</a></span>')
    })

    it('admits block tags only when blocks are allowed', () => {
        expect(sanitize('<h2>Head</h2>', true)).toBe('<h2>Head</h2>')
        expect(sanitize('<h2>Head</h2>', false)).toBe('Head')
    })
})

describe('x-text-edit parser hardening', () => {
    it('drops a javascript: link at parse time', () => {
        expect(fromMarkdown('[x](javascript:evil())')).not.toContain('javascript:')
    })

    it('escapes raw html in the source', () => {
        expect(fromMarkdown('<img src=x onerror=evil()>')).not.toContain('<img')
    })
})
