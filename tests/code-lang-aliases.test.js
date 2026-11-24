/**
 * @vitest-environment happy-dom
 *
 * Fence names highlight.js has no grammar file for (env, csv, ...) used to fetch
 * a 404ing module, escalating the page to the full bundle. They now alias to a
 * locked grammar file or render as plain text.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.code.js'), 'utf8')
const LOCK = JSON.parse(readFileSync(path.join(__dirname, '../src/scripts/vendor.lock.json'), 'utf8'))

const LANG_PREFIX = '@highlightjs/cdn-assets@11.11.1/languages/'
const FULL = '@highlightjs/cdn-assets@11.11.1/highlight.min.js'
const LOCKED_LANGS = new Set(Object.keys(LOCK)
    .filter(k => k.startsWith(LANG_PREFIX))
    .map(k => k.slice(LANG_PREFIX.length).replace(/\.min\.js$/, '')))

const literal = (re) => new Function(`return ${SRC.match(re)[1]}`)()
const ALIASES = literal(/const LANGUAGE_ALIASES = (\{[\s\S]*?\});/)
const PLAINTEXT = literal(/const PLAINTEXT_LANGS = (new Set\(\[[\s\S]*?\]\));/)

const FENCES = ['env', 'dotenv', 'csv', 'tsv', 'text', 'txt', 'plain', 'console', 'shell', 'sh', 'zsh',
    'shellsession', 'jsonc', 'json5', 'vue', 'svelte', 'astro', 'mdx', 'md', 'gitignore', 'conf', 'toml',
    'dockerfile', 'docker', 'html', 'htm', 'xhtml', 'svg', 'jsx', 'tsx', 'mjs', 'cjs', 'ps1', 'patch',
    'js', 'ts', 'py', 'rb', 'yml', 'rs', 'kt', 'cs', 'golang']

let vendor
function boot(checked) {
    vendor = {
        checked,
        script: vi.fn(async () => {}),
        fetch: vi.fn(async () => { throw new Error('unexpected fetch') }),
    }
    window.ManifestVendor = vendor
    // Full-bundle stand-in with no grammars registered, so every language triggers a load
    window.hljs = {
        listLanguages: () => Array.from({ length: 60 }, (_, i) => `l${i}`),
        getLanguage: () => null,
        registerLanguage() {},
        highlight: (s) => ({ value: s }),
        highlightElement() {},
    }
    globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    new Function(SRC)()
    return window.ManifestCode
}

beforeEach(() => { document.body.innerHTML = '' })

describe('code fence language aliases', () => {
    it('every alias targets a locked grammar file', () => {
        for (const [from, to] of Object.entries(ALIASES)) {
            expect(LOCKED_LANGS.has(to), `${from} -> ${to}`).toBe(true)
        }
    })

    it('common fence names resolve to a locked file or plain text', () => {
        for (const name of FENCES) {
            const resolved = ALIASES[name] || name
            expect(LOCKED_LANGS.has(resolved) || PLAINTEXT.has(resolved), name).toBe(true)
        }
    })

    it('env/dotenv highlight as bash; csv/tsv as plain text', () => {
        expect(ALIASES.env).toBe('bash')
        expect(ALIASES.dotenv).toBe('bash')
        expect(PLAINTEXT.has('csv')).toBe(true)
        expect(PLAINTEXT.has('tsv')).toBe(true)
    })

    it('integrity mode: only locked files load, never a missing grammar', async () => {
        for (const name of FENCES) {
            const code = boot(true)
            await code.loadHighlightJS(name)
            const paths = vendor.script.mock.calls.map(c => c[0])
            for (const p of paths) expect(p in LOCK, `${name}: ${p}`).toBe(true)
            const resolved = ALIASES[name] || name
            const langPaths = paths.filter(p => p.startsWith(LANG_PREFIX))
            if (PLAINTEXT.has(resolved)) expect(langPaths, name).toEqual([])
            else expect(langPaths, name).toEqual([`${LANG_PREFIX}${resolved}.min.js`])
        }
    })

    it('lean mode: no fetch fails, so the page never escalates to the full bundle', async () => {
        for (const name of FENCES) {
            const code = boot(false)
            // Grammars already present for aliased targets; an unaliased miss would import and fail
            const listed = [...LOCKED_LANGS]
            window.hljs.listLanguages = () => listed
            await code.loadHighlightJS(name)
            await code.loadHighlightJS('bash')
            expect(vendor.script.mock.calls.map(c => c[0]), name).not.toContain(FULL)
        }
    })

    it('lean mode control: an unknown name still escalates', async () => {
        const code = boot(false)
        const listed = [...LOCKED_LANGS]
        window.hljs.listLanguages = () => listed
        await code.loadHighlightJS('definitely-not-a-language')
        await code.loadHighlightJS('bash')
        expect(vendor.script.mock.calls.map(c => c[0])).toContain(FULL)
    })
})
