/**
 * Regression: no selector list may pair an unprotected :has() with selectors
 * that don't need it.
 *
 * A comma-separated list is NOT forgiving — one selector the browser can't
 * parse invalidates the whole rule. So a list like
 *   `& input, & .combobox, & label:has(input)`
 * loses `& input` and `& .combobox` too on a browser without :has().
 *
 * :is() and :where() ARE forgiving and drop only the offending branch, so
 * :has() nested inside them is safe. :not() is NOT forgiving, so
 * `:not(:has(…))` still takes its whole list down. Both verified in-browser.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import postcss from 'postcss'
import path from 'path'
import { globSync } from 'glob'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '../src/styles')

// Split a selector list on top-level commas only.
function splitTop(selector) {
    const parts = []
    let depth = 0
    let cur = ''
    for (const ch of selector) {
        if (ch === '(' || ch === '[') depth++
        else if (ch === ')' || ch === ']') depth--
        if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
    }
    parts.push(cur)
    return parts.map(s => s.trim()).filter(Boolean)
}

// Does this selector reach :has() outside any :is()/:where() wrapper?
function hasUnprotected(selector) {
    const stack = []
    let guard = 0
    let i = 0
    while (i < selector.length) {
        const m = /^:(is|where|has)\(/i.exec(selector.slice(i))
        if (m) {
            const name = m[1].toLowerCase()
            if (name === 'has' && guard === 0) return true
            const forgiving = name === 'is' || name === 'where'
            stack.push(forgiving)
            if (forgiving) guard++
            i += m[0].length
            continue
        }
        if (selector[i] === '(') { stack.push(null); i++; continue }
        if (selector[i] === ')') { if (stack.pop() === true) guard--; i++; continue }
        i++
    }
    return false
}

function offenders(file) {
    const found = []
    postcss.parse(readFileSync(file, 'utf8'), { from: file }).walkRules(rule => {
        const sels = splitTop(rule.selector)
        if (sels.length < 2) return
        const risky = sels.filter(hasUnprotected)
        // All-:has() lists are fine — nothing unrelated goes down with them.
        if (risky.length === 0 || risky.length === sels.length) return
        found.push(`${path.relative(SRC, file)}:${rule.source?.start?.line} — ${rule.selector.replace(/\s+/g, ' ')}`)
    })
    return found
}

describe('CSS selector lists survive a browser without :has()', () => {
    const files = globSync(path.join(SRC, '**/*.css')).sort()

    it('finds stylesheets to check', () => {
        expect(files.length).toBeGreaterThan(20)
    })

    it('never mixes an unprotected :has() with selectors that do not need it', () => {
        expect(files.flatMap(offenders)).toEqual([])
    })

    // Guard the detector itself, so a broken scan can't pass by finding nothing.
    it('detects the shapes it is meant to catch', () => {
        expect(hasUnprotected('& label:has(input)')).toBe(true)
        expect(hasUnprotected('&>details:not(:last-child):not(:has(+ details))')).toBe(true)
        expect(hasUnprotected(':where(a:has(b), c)')).toBe(false)
        expect(hasUnprotected(':is(a:has(b), c)')).toBe(false)
        expect(hasUnprotected('.plain > .selector')).toBe(false)
        expect(splitTop('a:has(b, c), d')).toEqual(['a:has(b, c)', 'd'])
    })
})
