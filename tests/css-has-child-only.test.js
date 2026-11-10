/**
 * Regression: :has() arguments stay child/sibling-scoped.
 *
 * WebKit runs ancestor invalidation on every inserted or removed node for a
 * :has() whose argument is a descendant selector matching common elements.
 * Child (`> x`, `> * > x`) and sibling (`+ x`, `~ x`) arguments are cheap.
 * Descendant arguments are allowed only for the rare features listed below.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import path from 'path'
import { globSync } from 'glob'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '../src/styles')

// Descendant arguments that match rare elements only.
const RARE = new Set([
    'dialog:popover-open',
    'dialog:popover-open ~ dialog:popover-open',
    '.combobox-chip',
    '[data-edit-dragging]',
    '[data-edit-dragging=""]',
    'tfoot',
    'legend',
    'data',
    '.label',
    'code',
])

function splitTop(s) {
    const parts = []
    let depth = 0
    let cur = ''
    for (const ch of s) {
        if (ch === '(' || ch === '[') depth++
        else if (ch === ')' || ch === ']') depth--
        if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
    }
    parts.push(cur)
    return parts.map(p => p.trim()).filter(Boolean)
}

// Every :has() argument list in a stylesheet, comments stripped.
function hasArgs(css) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const out = []
    let i = src.indexOf(':has(')
    while (i !== -1) {
        let depth = 1
        let j = i + 5
        while (j < src.length && depth) { if (src[j] === '(') depth++; else if (src[j] === ')') depth--; j++ }
        out.push(src.slice(i + 5, j - 1))
        i = src.indexOf(':has(', i + 5)
    }
    return out
}

const descendantArgs = args => args.flatMap(splitTop).filter(a => !/^[>+~]/.test(a) && !RARE.has(a))

describe(':has() arguments are child or sibling scoped', () => {
    const files = globSync(path.join(SRC, '**/*.css')).sort()

    it('finds stylesheets to check', () => {
        expect(files.length).toBeGreaterThan(20)
    })

    it('has no descendant :has() argument outside the rare list', () => {
        const found = files.flatMap(f => descendantArgs(hasArgs(readFileSync(f, 'utf8'))).map(a => `${path.relative(SRC, f)}: :has(${a})`))
        expect(found).toEqual([])
    })

    it('detects the shapes it is meant to catch', () => {
        expect(descendantArgs(hasArgs('label:has(input, > select)'))).toEqual(['input'])
        expect(descendantArgs(hasArgs('a:has(> b, > * > c, + d, ~ e)'))).toEqual([])
        expect(descendantArgs(hasArgs('x:has(dialog:popover-open)'))).toEqual([])
    })
})
