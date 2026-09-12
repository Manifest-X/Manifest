/**
 * @vitest-environment happy-dom
 *
 * manifest.json `utilities.safelist` (exact class names) / `utilities.patterns`
 * (regex source strings) — classes a project knows are baked, or safe to
 * leave unbaked, even though a plain HTML/component scan can't find them
 * (e.g. built from a runtime value). Covers the full chain: schema shape,
 * the node-side bake (compileUtilities/scanClasses/CLI), and the browser
 * runtime treating them as covered (filterStaticallyCoveredClasses,
 * stripCoveredRulesFromCss, and the uncovered-class watcher's isClassCovered).
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { describe, it, expect } from 'vitest'
import { compileUtilities, scanClasses } from '../lib/manifest.utilities.node.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('manifest.schema.json — utilities.safelist/patterns', () => {
    const schema = JSON.parse(readFileSync(join(__dirname, '../lib/manifest.schema.json'), 'utf8'))

    it('declares utilities.safelist and utilities.patterns as string arrays', () => {
        const utilities = schema.properties.utilities
        expect(utilities.type).toBe('object')
        expect(utilities.properties.safelist.type).toBe('array')
        expect(utilities.properties.safelist.items.type).toBe('string')
        expect(utilities.properties.patterns.type).toBe('array')
        expect(utilities.properties.patterns.items.type).toBe('string')
    })
})

describe('compileUtilities — safelist option', () => {
    it('bakes a safelisted class even when it never appears in classes', async () => {
        const css = await compileUtilities({ classes: [], safelist: ['bg-amber-500', 'bg-green-500'] })
        expect(css).toContain('.bg-amber-500')
        expect(css).toContain('.bg-green-500')
    })

    it('unions safelist with classes rather than replacing them', async () => {
        const css = await compileUtilities({ classes: ['p-4'], themeCss: ':root{--spacing-4:1rem;}', safelist: ['bg-amber-500'] })
        expect(css).toContain('.p-4 { padding: var(--spacing-4) }')
        expect(css).toContain('.bg-amber-500')
    })
})

describe('scanClasses — safelist option', () => {
    it('includes safelisted classes alongside scanned ones', () => {
        const html = '<div class="p-4"></div>'
        const scanned = scanClasses(html, { safelist: ['bg-amber-500', 'bg-green-500'] })
        expect(scanned).toEqual(['bg-amber-500', 'bg-green-500', 'p-4'])
    })

    it('still dedupes when a safelisted class also appears in markup', () => {
        const html = '<div class="p-4 bg-amber-500"></div>'
        const scanned = scanClasses(html, { safelist: ['bg-amber-500'] })
        expect(scanned).toEqual(['bg-amber-500', 'p-4'])
    })
})

describe('scripts/utilities-static.mjs CLI — manifest.json safelist', () => {
    it('bakes utilities.safelist classes from manifest.json even when unused in HTML', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mnfst-utilities-safelist-'))
        try {
            writeFileSync(join(dir, 'index.html'), '<div class="p-4"></div>')
            writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
                utilities: { safelist: ['bg-amber-500', 'bg-green-500'] }
            }))
            const cliPath = join(__dirname, '../scripts/utilities-static.mjs')
            const outPath = join(dir, 'out.css')

            execFileSync(process.execPath, [cliPath, dir, '--out', outPath])
            const css = readFileSync(outPath, 'utf8')

            expect(css).toContain('.bg-amber-500')
            expect(css).toContain('.bg-green-500')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('is a no-op with no manifest.json present', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mnfst-utilities-safelist-'))
        try {
            writeFileSync(join(dir, 'index.html'), '<div class="p-4"></div>')
            const cliPath = join(__dirname, '../scripts/utilities-static.mjs')
            const outPath = join(dir, 'out.css')
            execFileSync(process.execPath, [cliPath, dir, '--out', outPath])
            expect(readFileSync(outPath, 'utf8')).not.toContain('bg-amber-500')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('runtime — safelist/patterns treated as covered', () => {
    const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

    async function bootWithSafelist({ headHtml, bodyHtml, utilities }) {
        document.head.innerHTML = headHtml
        document.body.innerHTML = bodyHtml
        window.tailwind = {}
        window.ManifestComponentsRegistry = { manifest: {} }
        window.__manifestLoaded = { utilities } // read synchronously by loadUtilitiesSafelist
        delete window.__manifestUtilitiesReady
        window.__manifestUtilitiesPending = 0

        const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
        const nonce = `\n//boot:${Math.random()}`
        await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
        await ready
        return window.ManifestUtilities
    }

    it('safelist: does not regenerate a safelisted class, even with no static sheet', async () => {
        const compiler = await bootWithSafelist({
            headHtml: '<style id="theme-vars">:root { --spacing-4: 1rem; }</style>',
            bodyHtml: '<div class="p-4 bg-amber-500"></div>',
            utilities: { safelist: ['bg-amber-500'] }
        })
        expect(compiler.isClassCovered('bg-amber-500')).toBe(true)
        expect(compiler.isClassCovered('p-4')).toBe(false)
        const generated = document.getElementById('manifest-styles').textContent
        expect(generated).not.toMatch(/\.bg-amber-500\s*\{/)
    })

    it('patterns: a class matching a safelisted regex is treated as covered', async () => {
        const compiler = await bootWithSafelist({
            headHtml: '',
            bodyHtml: '<div class="bg-red-500"></div>',
            utilities: { patterns: ['^bg-(red|green|blue)-[0-9]+$'] }
        })
        expect(compiler.isClassCovered('bg-red-500')).toBe(true)
        expect(compiler.isClassCovered('bg-purple-500')).toBe(false)
    })

    it('an invalid pattern is skipped rather than throwing', async () => {
        const compiler = await bootWithSafelist({
            headHtml: '',
            bodyHtml: '<div></div>',
            utilities: { patterns: ['('] } // unbalanced group — invalid regex
        })
        expect(compiler.isClassCovered('anything')).toBe(false)
    })

    it('stripCoveredRulesFromCss drops a rule for a safelisted class with no static sheet at all', async () => {
        const compiler = await bootWithSafelist({
            headHtml: '',
            bodyHtml: '<div></div>',
            utilities: { safelist: ['bg-amber-500'] }
        })
        const cached = '@layer utilities {\n.bg-amber-500 { background-color: #f59e0b }\n\n.p-8 { padding: 2rem }\n}'
        const stripped = compiler.stripCoveredRulesFromCss(cached)
        expect(stripped).not.toMatch(/\.bg-amber-500\s*\{/)
        expect(stripped).toMatch(/\.p-8\s*\{/)
    })
})
