/**
 * @vitest-environment happy-dom
 *
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

// A whitespace (descendant) combinator at the argument's top level, outside any parentheses.
function hasDescendantCombinator(arg) {
    let depth = 0
    let flat = ''
    for (const ch of arg) {
        if (ch === '(' || ch === '[') depth++
        else if (ch === ')' || ch === ']') depth--
        else if (depth === 0) flat += ch
    }
    return /\S\s+\S/.test(flat.trim().replace(/\s*([>+~])\s*/g, '$1'))
}

const descendantArgs = args => args.flatMap(splitTop).filter(a => !RARE.has(a) && (!/^[>+~]/.test(a) || hasDescendantCombinator(a)))

// :has() arguments of the nth :has() after a marker comment in a stylesheet.
function argsAfter(file, marker, nth = 0) {
    const src = readFileSync(path.join(SRC, file), 'utf8')
    const at = src.indexOf(marker)
    if (at === -1) throw new Error(`marker not found: ${marker}`)
    return hasArgs(src.slice(at))[nth]
}

// Expand a standalone `:where(a, b)` compound into one selector per item.
function expandWhere(arg) {
    const m = /(^|[\s>+~]):where\(/.exec(arg)
    if (!m) return [arg]
    const start = m.index + m[1].length
    let depth = 1
    let j = start + 7
    while (depth) { if (arg[j] === '(') depth++; else if (arg[j] === ')') depth--; j++ }
    return splitTop(arg.slice(start + 7, j - 1)).flatMap(item => expandWhere(arg.slice(0, start) + item + arg.slice(j)))
}

// happy-dom mis-matches multi-level :has(), so resolve each child-scoped argument with :scope.
function matchesHas(html, subject, args) {
    document.body.innerHTML = html
    const el = document.body.firstElementChild
    return el.matches(subject) && splitTop(args).flatMap(expandWhere).some(a => el.querySelector(`:scope ${a}`) !== null)
}

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
        expect(descendantArgs(hasArgs('x:has(> div input)'))).toEqual(['> div input'])
        expect(descendantArgs(hasArgs('x:has(> div > input, > a:not(.b c))'))).toEqual([])
    })
})

describe('child-scoped :has() still matches documented markup', () => {
    const group = argsAfter('elements/manifest.form.css', '/* Group & tab bar wrappers */')
    const groupLabel = argsAfter('elements/manifest.form.css', '/* Own rule: a selector list')
    const wrapper = argsAfter('elements/manifest.form.css', '/* Label wrapper */', 1)
    const textarea = argsAfter('elements/manifest.form.css', '/* Align textarea label to top */')
    const search = argsAfter('elements/manifest.input.css', '/* Label wrapper for search and file inputs */')
    const list = argsAfter('elements/manifest.typography.css', 'padding-inline-start: 1.75ch;')
    const item = argsAfter('elements/manifest.typography.css', '/* Checklist items */')
    const avatars = argsAfter('elements/manifest.avatar.css', '/* Group wrapper */')

    it('group participants', () => {
        expect(matchesHas('<div role="group"><select></select><input><button>Go</button></div>', '[role=group]', group)).toBe(true)
        expect(matchesHas('<div role="group"><label><i x-icon></i><input type="search"></label></div>', '[role=group]', group)).toBe(true)
        expect(matchesHas('<div role="group"><button @click="x">A</button></div>', '[role=group]', group)).toBe(true)
        expect(matchesHas('<div role="group"><div class="avatar">X</div></div>', '[role=group]', group)).toBe(false)
        expect(matchesHas('<div role="group"><a href="#"><div class="avatar">X</div></a></div>', '[role=group]', avatars)).toBe(true)
    })

    it('search and file wrappers, including a .label inside an inline label', () => {
        expect(matchesHas('<label><i x-icon></i><input type="search"></label>', 'label', search)).toBe(true)
        expect(matchesHas('<label><i x-icon></i>Upload<input type="file"></label>', 'label', search)).toBe(true)
        expect(matchesHas('<label><data>Search</data><div class="label"><i x-icon></i><input type="search"></div></label>', 'label', search)).toBe(true)
        expect(matchesHas('<label>Name<input></label>', 'label', search)).toBe(false)
    })

    it('fields inside label wrappers, comboboxes included', () => {
        expect(matchesHas('<label>Name<input></label>', 'label', wrapper)).toBe(true)
        expect(matchesHas('<label>Mins<div class="relative"><input type="number"></div></label>', 'label', wrapper)).toBe(true)
        expect(matchesHas('<label>Tags<div class="combobox"><input></div></label>', 'label', wrapper)).toBe(true)
        expect(matchesHas('<label>Tags<div class="combobox"><input></div></label>', 'label', groupLabel)).toBe(true)
        expect(matchesHas('<label><data>Skills</data><div class="combobox"><textarea></textarea></div></label>', 'label', textarea)).toBe(true)
        expect(matchesHas('<label><data>Bio</data><textarea></textarea></label>', 'label', textarea)).toBe(true)
    })

    it('task lists: tight, loose and label-wrapped', () => {
        expect(matchesHas('<ul><li><input type="checkbox"> a</li></ul>', 'ul', list)).toBe(true)
        expect(matchesHas('<ul><li><p><input type="checkbox"> a</p></li></ul>', 'ul', list)).toBe(true)
        expect(matchesHas('<ul><li><label><input type="checkbox"> a</label></li></ul>', 'ul', list)).toBe(true)
        expect(matchesHas('<ul><li>plain</li></ul>', 'ul', list)).toBe(false)
        expect(matchesHas('<li><input type="checkbox"> a</li>', 'li', item)).toBe(true)
        expect(matchesHas('<li><p><input type="checkbox"> a</p></li>', 'li', item)).toBe(true)
        expect(matchesHas('<li><label><input type="checkbox"> a</label></li>', 'li', item)).toBe(true)
    })
})
