/**
 * @vitest-environment happy-dom
 *
 * Markdown round trip, as a property: random runs of plain text, strong, em, strike, code and
 * links (nested in each other, beside each other, with awkward characters) written as
 * markdown and read back carry the same formatting on every character.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { RICH_SRC } from './helpers/edit-setup.js'
import { Marked } from 'marked'

// x-markdown's renderer: marked, at the version and options manifest.markdown.js loads
const markedLike = new Marked({ gfm: true, breaks: true })

beforeAll(() => { if (!window.ManifestRichText) new Function(RICH_SRC)() })

// Seeded, so a failure names a case that reproduces
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 } }
const WORDS = ['alpha', 'beta', 'go', 'x', '42', 'snake_case', 'a*b', 'tilde~', 'back`tick', '[br]', 'dot.', 'end!', '(paren)', 'R&D', '<tag>', 'q_', '*', '__', 'it’s']
const TITLES = ['Docs', 'say "hi"', 'back\\slash', "it's (x)", '']
const HREFS = ['https://x.dev/a', '/p?q=1&r=2', 'https://e.com/(x)', '#top', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'https://x.dev/a)b', 'https://x.dev/(a', 'https://x.dev/((a)b)c)', 'https://x.dev/a\\b', 'https://x.dev/a%20b']
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function gen(r, depth, noLink) {
    const words = () => { const n = 1 + Math.floor(r() * 3); let t = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' '); if (r() < 0.25) t = ' ' + t; if (r() < 0.25) t += ' '; return t }
    const runs = 1 + Math.floor(r() * 4)
    let out = ''
    for (let i = 0; i < runs; i++) {
        const k = depth > 2 ? 0 : Math.floor(r() * 7)
        if (k <= 1) out += esc(words())
        else if (k === 2) out += `<strong>${gen(r, depth + 1, noLink)}</strong>`
        else if (k === 3) out += `<em>${gen(r, depth + 1, noLink)}</em>`
        else if (k === 4) out += `<s>${gen(r, depth + 1, noLink)}</s>`
        else if (k === 5) out += `<code>${esc(words().trim() || 'c')}</code>`
        else {
            const title = r() < 0.4 ? TITLES[Math.floor(r() * TITLES.length)] : null
            out += noLink ? esc(words()) : `<a href="${esc(HREFS[Math.floor(r() * HREFS.length)])}"${title != null ? ` title="${esc(title).replace(/"/g, '&quot;')}"` : ''}>${gen(r, depth + 1, true)}</a>`
        }
    }
    return out
}

// marked percent-encodes hrefs; compared decoded
const uri = (h) => { try { return decodeURI(h) } catch { return h } }
// Every character with the formatting it shows; strong/em/strike on spaces shows nothing
function shape(html) {
    const d = document.createElement('div'); d.innerHTML = html
    const out = []
    const walk = (n, f) => n.childNodes.forEach(c => {
        if (c.nodeType === 3) { for (const ch of c.nodeValue) out.push(ch + ' ' + f.filter(x => !/\s/.test(ch) || /^(c|a:)/.test(x)).sort().join(',')); return }
        if (c.nodeType !== 1) return
        const t = c.tagName, add = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', S: 's', DEL: 's', CODE: 'c' }[t]
        const href = t === 'A' ? 'a:' + uri(c.getAttribute('href') || '') + (c.getAttribute('title') ? '|' + c.getAttribute('title') : '') : null
        walk(c, [...new Set([...f, ...(add ? [add] : []), ...(href ? [href] : [])])])
    })
    walk(d.firstElementChild || d, [])
    while (out.length && /^\s /.test(out[0])) out.shift()
    while (out.length && /^\s /.test(out[out.length - 1])) out.pop()
    return out.join('\n')
}

// A README as people write it. Saved back byte for byte, but for the documented normalisations:
// _em_ / __strong__ are written *em* / **strong**; a lone * between characters is escaped;
// inline HTML for marks markdown has (<b>, <i>, …) is written as markdown.
const README = [
    '# Project *Name*',
    '',
    '[![Build](https://img.shields.io/badge/build-passing-green.svg)](https://ci.example/build) ![Logo](https://x.example/logo.png)',
    '',
    'A **fast** library for `parsing` things. See [the docs](https://docs.example/guide_(v2)) or <https://autolink.example>.',
    '',
    '## Install',
    '',
    '```bash',
    'npm install my_lib --save',
    '```',
    '',
    '## Usage',
    '',
    '1. Import it: `import { x } from \'lib\'`',
    '2. Call `x()` with **options**:',
    '    - `debug` (*boolean*): logs to __stderr__',
    '    - `max_size`: defaults to 2*1024',
    '3. Done!',
    '',
    '> **Note:** this is _experimental_ and may change.',
    '',
    'Escapes: \\*not em\\*, \\_not em\\_, 5 \\* 3 = 15, a_b_c, C# and F#, 100% of <b>html</b>.',
    '',
    'Emphasis: ***all***, **bold *and em***, *em **and bold***, ~~old~~ new.',
    '',
    '---',
    '',
    'MIT © 2026'
].join('\n')

describe('markdown round trip', () => {
    it('a README saves back as written, but for the documented normalisations', () => {
        const RT = window.ManifestRichText
        const d = document.createElement('div'); d.innerHTML = RT.fromMarkdown(README)
        const saved = RT.toMarkdown(d)
        expect(saved).toBe(README
            .replace('__stderr__', '**stderr**').replace('_experimental_', '*experimental*')
            .replace('2*1024', '2\\*1024').replace('<b>html</b>', '**html**'))
        const again = document.createElement('div'); again.innerHTML = RT.fromMarkdown(saved)
        expect(RT.toMarkdown(again)).toBe(saved)                                         // and is stable from there
        for (const block of saved.split(/\n\n+/).filter(b => !/^(#|```|---|\d\.|>)/.test(b)))   // paragraphs read alike in x-markdown
            expect(shape(markedLike.parse(block)), block).toBe(shape(RT.fromMarkdown(block)))
    })

    it('marks with letters or tags right outside them are written so x-markdown shows them too', () => {
        const RT = window.ManifestRichText
        for (const html of ['<p>x<em><strong>b</strong>c</em>y</p>', '<p><em>a<strong>b</strong></em>c</p>', '<p>x<strong><em>a</em>b</strong>y</p>', '<p>w<strong>x</strong><em>y</em>z</p>', '<p>2<em>3</em>4</p>']) {
            const d = document.createElement('div'); d.innerHTML = html
            const md = RT.toMarkdown(d)
            expect(shape(RT.fromMarkdown(md)), md).toBe(shape(html))
            expect(shape(markedLike.parse(md)), md).toBe(shape(html))
        }
    })

    it('link destinations: balanced parentheses, <…>, a title; written back unchanged', () => {
        const RT = window.ManifestRichText
        const md = (html) => { const d = document.createElement('div'); d.innerHTML = html; return RT.toMarkdown(d) }
        expect(RT.fromMarkdown('[x](https://en.wikipedia.org/wiki/Foo_(bar)) after')).toBe('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">x</a> after</p>')
        expect(RT.fromMarkdown('[t](<https://x.dev/a b>)')).toBe('<p><a href="https://x.dev/a b">t</a></p>')
        expect(RT.fromMarkdown('[t](https://x.example "title")')).toBe('<p><a href="https://x.example" title="title">t</a></p>')
        expect(RT.fromMarkdown('[t](https://x.example \'it\\\'s\')')).toBe('<p><a href="https://x.example" title="it\'s">t</a></p>')
        expect(md('<p><a href="https://x.example" title="say &quot;hi&quot; \\ now">t</a></p>')).toBe('[t](https://x.example \'say "hi" \\\\ now\')')
        expect(md('<p><a href="https://x.example" title="it\'s &quot;x&quot;">t</a></p>')).toBe('[t](https://x.example "it\'s \\"x\\"")')
        expect(RT.fromMarkdown(md('<p><a href="https://x.example" title="say &quot;hi&quot; \\ now">t</a></p>'))).toBe('<p><a href="https://x.example" title="say &quot;hi&quot; \\ now">t</a></p>')
        expect(RT.fromMarkdown('[t](https://x.dev/a\\)b)')).toBe('<p><a href="https://x.dev/a)b">t</a></p>')
        let v = '[x](https://en.wikipedia.org/wiki/Foo_(bar)) after'
        for (let i = 0; i < 3; i++) v = md(RT.fromMarkdown(v))
        expect(v).toBe('[x](https://en.wikipedia.org/wiki/Foo_(bar)) after')
        expect(md('<p><a href="https://x.dev/a)b(c">t</a></p>')).toBe('[t](https://x.dev/a\\)b\\(c)')
    })

    it('random runs, nested and adjacent, read back with the same formatting on every character', () => {
        const RT = window.ManifestRichText, failures = []
        for (let seed = 1; seed <= 4000 && failures.length < 5; seed++) {
            const r = rng(seed), html = `<p>${gen(r, 0, false)}</p>`
            const d = document.createElement('div'); d.innerHTML = html
            const md = RT.toMarkdown(d), back = RT.fromMarkdown(md), shown = markedLike.parse(md)
            if (shape(back) !== shape(html)) failures.push({ seed, html, md, back })
            else if (shape(shown) !== shape(html)) failures.push({ seed, html, md, shown })      // what x-markdown displays
        }
        expect(failures).toEqual([])
    }, 60000)
})
