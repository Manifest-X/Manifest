/**
 * @vitest-environment happy-dom
 *
 * Markdown round trip, as a property: random runs of plain text, strong, em, strike, code and
 * links (nested in each other, beside each other, with awkward characters) written as
 * markdown and read back carry the same formatting on every character.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { RICH_SRC } from './helpers/edit-setup.js'

beforeAll(() => { if (!window.ManifestRichText) new Function(RICH_SRC)() })

// Seeded, so a failure names a case that reproduces
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 } }
const WORDS = ['alpha', 'beta', 'go', 'x', '42', 'snake_case', 'a*b', 'tilde~', 'back`tick', '[br]', 'dot.', 'end!', '(paren)', 'R&D', '<tag>', 'q_', '*', '__', 'it’s']
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
        else out += noLink ? esc(words()) : `<a href="${esc(HREFS[Math.floor(r() * HREFS.length)])}">${gen(r, depth + 1, true)}</a>`
    }
    return out
}

// Every character with the formatting it shows; strong/em/strike on spaces shows nothing
function shape(html) {
    const d = document.createElement('div'); d.innerHTML = html
    const out = []
    const walk = (n, f) => n.childNodes.forEach(c => {
        if (c.nodeType === 3) { for (const ch of c.nodeValue) out.push(ch + ' ' + f.filter(x => !/\s/.test(ch) || /^(c|a:)/.test(x)).sort().join(',')); return }
        if (c.nodeType !== 1) return
        const t = c.tagName, add = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', S: 's', DEL: 's', CODE: 'c' }[t]
        const href = t === 'A' ? 'a:' + (c.getAttribute('href') || '') : null
        walk(c, [...new Set([...f, ...(add ? [add] : []), ...(href ? [href] : [])])])
    })
    walk(d.firstElementChild || d, [])
    while (out.length && /^\s /.test(out[0])) out.shift()
    while (out.length && /^\s /.test(out[out.length - 1])) out.pop()
    return out.join('\n')
}

describe('markdown round trip', () => {
    it('link destinations: balanced parentheses, <…>, a title; written back unchanged', () => {
        const RT = window.ManifestRichText
        const md = (html) => { const d = document.createElement('div'); d.innerHTML = html; return RT.toMarkdown(d) }
        expect(RT.fromMarkdown('[x](https://en.wikipedia.org/wiki/Foo_(bar)) after')).toBe('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">x</a> after</p>')
        expect(RT.fromMarkdown('[t](<https://x.dev/a b>)')).toBe('<p><a href="https://x.dev/a b">t</a></p>')
        expect(RT.fromMarkdown('[t](https://x.example "title")')).toBe('<p><a href="https://x.example">t</a></p>')
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
            const md = RT.toMarkdown(d), back = RT.fromMarkdown(md)
            if (shape(back) !== shape(html)) failures.push({ seed, html, md, back })
        }
        expect(failures).toEqual([])
    }, 60000)
})
