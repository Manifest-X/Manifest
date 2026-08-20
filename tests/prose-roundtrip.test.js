/**
 * @vitest-environment happy-dom
 *
 * x-prose stores markdown, so its two serializers have to be exact inverses over
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
    readFileSync(path.join(__dirname, '../src/scripts/manifest.prose.js'), 'utf8')
))
const { toMarkdown, fromMarkdown, sanitize } = window.ManifestProse

const roundTrip = (md) => {
    const host = document.createElement('div')
    host.innerHTML = fromMarkdown(md)
    return toMarkdown(host)
}

describe('x-prose markdown round trip', () => {
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
    ])('%s', (_name, md) => {
        expect(roundTrip(md)).toBe(md)
    })
})

describe('x-prose sanitize', () => {
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

describe('x-prose parser hardening', () => {
    it('drops a javascript: link at parse time', () => {
        expect(fromMarkdown('[x](javascript:evil())')).not.toContain('javascript:')
    })

    it('escapes raw html in the source', () => {
        expect(fromMarkdown('<img src=x onerror=evil()>')).not.toContain('<img')
    })
})
