// Generates packages/run/html-entities.json — every HTML named character reference
// (the WHATWG table, as compiled into the `entities` package's decode trie), keyed by
// name as written after "&": "amp;" and the legacy semicolon-less "amp".
// Run: node scripts/gen-html-entities.mjs
import { createRequire } from 'module'
import { writeFileSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const require = createRequire(import.meta.url)
// Pinned in devDependencies; refuse any other copy (its trie layout is internal).
const PINNED = '4.5.0'
const decodePath = require.resolve('entities/lib/decode.js')
const version = JSON.parse(readFileSync(path.join(path.dirname(decodePath), '..', 'package.json'), 'utf8')).version
if (version !== PINNED) throw new Error(`entities ${version} resolved; this generator is pinned to ${PINNED}`)
const E = require('entities/lib/decode.js')
const tree = E.htmlDecodeTree, VL = E.BinTrieFlags.VALUE_LENGTH
const chars = []
for (let c = 48; c < 123; c++) if (/[0-9A-Za-z;]/.test(String.fromCharCode(c))) chars.push(c)
const names = []
const walk = (idx, name) => {
    const cur = tree[idx], vl = (cur & VL) >> 14
    if (vl && name) names.push(name)
    if (name.endsWith(';') || name.length > 40) return
    for (const c of chars) { const n = E.determineBranch(tree, cur, idx + Math.max(1, vl), c); if (n >= 0) walk(n, name + String.fromCharCode(c)) }
}
walk(0, '')
const table = {}
for (const n of names.sort()) {
    const v = n.endsWith(';') ? E.decodeHTMLStrict('&' + n) : E.decodeHTML('&' + n)
    if (v === '&' + n) continue
    table[n] = v
}
if (Object.keys(table).length !== 2231) throw new Error('entity table looks incomplete: ' + Object.keys(table).length)
// Spot checks against the WHATWG table.
const expect = { 'amp;': '&', 'AMP': '&', 'eacute;': '\u00e9', 'mdash;': '\u2014', 'rightarrow;': '\u2192', 'NotEqualTilde;': '\u2242\u0338', 'nbsp': '\u00a0', 'fjlig;': 'fj' }
for (const [k, v] of Object.entries(expect)) if (table[k] !== v) throw new Error(`entity ${k} decoded to ${JSON.stringify(table[k])}`)
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/run/html-entities.json')
writeFileSync(out, JSON.stringify(table) + '\n')
console.log('wrote', Object.keys(table).length, 'entities to', out)
