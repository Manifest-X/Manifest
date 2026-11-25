/**
 * @vitest-environment happy-dom
 *
 * The cache's theme hash covers the whole theme text (it used to be the first
 * eight encoded characters, the same leading comment for every theme).
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

let compiler

beforeAll(async () => {
    document.head.innerHTML = '<style id="theme-vars">:root { --color-brand: #f00; }</style>'
    window.tailwind = {}
    window.ManifestComponentsRegistry = { manifest: {} }
    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc))
    await ready
    compiler = window.ManifestUtilities
})

describe('theme hash', () => {
    const header = '/* Manifest theme */\n:root {\n'
    it('differs when only a value deep in the theme changes', () => {
        const a = compiler.generateThemeHash(header + '  --color-brand: #f00;\n}')
        const b = compiler.generateThemeHash(header + '  --color-brand: #0f0;\n}')
        expect(a).not.toBe(b)
    })

    it('is stable for the same text and safe in a cache key', () => {
        const css = header + '  --font-sans: "Inter", sans-serif; /* ü */\n}'
        expect(compiler.generateThemeHash(css)).toBe(compiler.generateThemeHash(css))
        expect(compiler.generateThemeHash(css)).toMatch(/^[0-9a-z]+$/)
    })
})
