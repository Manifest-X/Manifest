/**
 * Tests for CSV/data loader pure functions.
 *
 * The source is a browser-global script (window.ManifestDataLoaders = {...}).
 * We evaluate it in a vm context with minimal mocks so we can test the pure
 * parsing functions without a real browser.
 */

import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import vm from 'vm'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let parseCSVToNestedObject
let setNestedValue
let numericKeyObjectToArray
let deepMergeWithFallback

beforeAll(() => {
    const source = readFileSync(
        path.resolve(__dirname, '../src/scripts/data/core/manifest.data.loaders.js'),
        'utf-8'
    )

    const ctx = {
        window: {},
        document: {
            createElement: () => ({ onload: null, onerror: null, src: '' }),
            head: { appendChild: () => {} },
            querySelector: () => null,
        },
        console,
        fetch: () => Promise.resolve(),
        Promise,
    }

    vm.runInNewContext(source, ctx)

    ;({
        parseCSVToNestedObject,
        setNestedValue,
        numericKeyObjectToArray,
        deepMergeWithFallback,
    } = ctx.window.ManifestDataLoaders)
})

// ---------------------------------------------------------------------------
// setNestedValue
// ---------------------------------------------------------------------------
describe('setNestedValue', () => {
    it('sets a top-level key', () => {
        const obj = {}
        setNestedValue(obj, 'name', 'Luke')
        expect(obj).toEqual({ name: 'Luke' })
    })

    it('sets a dot-notation nested key', () => {
        const obj = {}
        setNestedValue(obj, 'home.planet', 'Tatooine')
        expect(obj).toEqual({ home: { planet: 'Tatooine' } })
    })

    it('creates an array for numeric path segments', () => {
        const obj = {}
        setNestedValue(obj, 'items.0.name', 'Lightsaber')
        setNestedValue(obj, 'items.1.name', 'Blaster')
        expect(Array.isArray(obj.items)).toBe(true)
        expect(obj.items[0].name).toBe('Lightsaber')
        expect(obj.items[1].name).toBe('Blaster')
    })

    it('deeply nests three levels', () => {
        const obj = {}
        setNestedValue(obj, 'a.b.c', 'deep')
        expect(obj.a.b.c).toBe('deep')
    })
})

// ---------------------------------------------------------------------------
// numericKeyObjectToArray
// ---------------------------------------------------------------------------
describe('numericKeyObjectToArray', () => {
    it('converts an object with all numeric keys to a sorted array', () => {
        const result = numericKeyObjectToArray({ '0': 'a', '1': 'b', '2': 'c' })
        expect(result).toEqual(['a', 'b', 'c'])
    })

    it('returns the original object when keys are mixed', () => {
        const input = { '0': 'a', name: 'b' }
        expect(numericKeyObjectToArray(input)).toBe(input)
    })

    it('returns arrays unchanged', () => {
        const input = [1, 2, 3]
        expect(numericKeyObjectToArray(input)).toBe(input)
    })

    it('returns null unchanged', () => {
        expect(numericKeyObjectToArray(null)).toBe(null)
    })

    it('returns an empty object unchanged', () => {
        const input = {}
        expect(numericKeyObjectToArray(input)).toBe(input)
    })
})

// ---------------------------------------------------------------------------
// deepMergeWithFallback
// ---------------------------------------------------------------------------
describe('deepMergeWithFallback', () => {
    it('returns current when fallback is null', () => {
        expect(deepMergeWithFallback('hello', null)).toBe('hello')
    })

    it('returns fallback when current is null', () => {
        expect(deepMergeWithFallback(null, 'fallback')).toBe('fallback')
    })

    it('returns fallback when current is an empty string', () => {
        expect(deepMergeWithFallback('', 'fallback')).toBe('fallback')
    })

    it('merges objects, preferring current over fallback', () => {
        const current = { a: 'current-a', c: 'current-c' }
        const fallback = { a: 'fallback-a', b: 'fallback-b' }
        const result = deepMergeWithFallback(current, fallback)
        expect(result.a).toBe('current-a')   // current wins
        expect(result.b).toBe('fallback-b')  // fallback fills in
        expect(result.c).toBe('current-c')   // current-only key preserved
    })

    it('falls back for empty string values in objects', () => {
        const current = { greeting: '' }
        const fallback = { greeting: 'Hello' }
        const result = deepMergeWithFallback(current, fallback)
        expect(result.greeting).toBe('Hello')
    })

    it('merges arrays by index', () => {
        const current = [{ a: 'ca' }, null]
        const fallback = [{ a: 'fa', b: 'fb' }, { a: 'fa2' }]
        const result = deepMergeWithFallback(current, fallback)
        expect(result[0].a).toBe('ca')   // current wins
        expect(result[0].b).toBe('fb')   // fallback fills in
        expect(result[1].a).toBe('fa2')  // only fallback item at index 1
    })
})

// ---------------------------------------------------------------------------
// parseCSVToNestedObject — fallback (no PapaParse) parser
// ---------------------------------------------------------------------------
describe('parseCSVToNestedObject (simple parser)', () => {
    it('parses a basic key-value CSV', () => {
        const csv = `key,value\nhero.name,Luke Skywalker\nhero.rank,Jedi`
        const result = parseCSVToNestedObject(csv)
        expect(result.hero.name).toBe('Luke Skywalker')
        expect(result.hero.rank).toBe('Jedi')
    })

    it('parses a tabular CSV (id as first column)', () => {
        const csv = `id,name,role\n1,Darth Vader,Lord\n2,Admiral Piett,Fleet Commander`
        const result = parseCSVToNestedObject(csv)
        expect(Array.isArray(result)).toBe(true)
        expect(result).toHaveLength(2)
        expect(result[0].name).toBe('Darth Vader')
        expect(result[1].role).toBe('Fleet Commander')
    })

    it('picks the locale column when currentLocale is provided', () => {
        const csv = `key,en,fr\nhero.name,Luke,Luc\nhero.rank,Jedi,Jedi`
        const result = parseCSVToNestedObject(csv, { currentLocale: 'fr' })
        expect(result.hero.name).toBe('Luc')
    })

    it('falls back to first locale column when requested locale column is empty', () => {
        const csv = `key,en,fr\nhero.name,Luke,\nhero.rank,Jedi,Jedi`
        const result = parseCSVToNestedObject(csv, { currentLocale: 'fr' })
        expect(result.hero.name).toBe('Luke') // fr is empty → falls back to en
    })

    it('converts numeric root keys to an array', () => {
        // A key-value CSV where keys are purely numeric segments → array at root
        const csv = `key,value\n0.path,/about\n1.path,/contact`
        const result = parseCSVToNestedObject(csv)
        expect(Array.isArray(result)).toBe(true)
        expect(result[0].path).toBe('/about')
        expect(result[1].path).toBe('/contact')
    })

    it('throws on a CSV with fewer than 2 columns', () => {
        const csv = `key\nhello`
        expect(() => parseCSVToNestedObject(csv)).toThrow()
    })

    it('returns an empty object for a header-only key-value CSV (no data rows)', () => {
        const csv = `key,value`
        expect(parseCSVToNestedObject(csv)).toEqual({})
    })

    it('returns an empty array for a header-only tabular CSV', () => {
        const csv = `id,name,role`
        const result = parseCSVToNestedObject(csv)
        expect(Array.isArray(result)).toBe(true)
        expect(result).toHaveLength(0)
    })

    it('returns an empty source for a header-only locales CSV (locale columns, no rows)', () => {
        const csv = `key,en,fr,es`
        expect(parseCSVToNestedObject(csv)).toEqual({})
    })

    it('handles quoted values with commas', () => {
        const csv = `key,value\nhero.quote,"I am your father, Luke"`
        const result = parseCSVToNestedObject(csv)
        expect(result.hero.quote).toBe('I am your father, Luke')
    })

    it('skips rows with empty keys', () => {
        const csv = `key,value\nhero.name,Luke\n,ignored`
        const result = parseCSVToNestedObject(csv)
        expect(Object.keys(result.hero)).toHaveLength(1)
    })
})
