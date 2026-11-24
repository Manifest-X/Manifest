/**
 * @vitest-environment happy-dom
 *
 * Fence names match case-insensitively, console sessions load the shell grammar
 * (plus bash for its commands), and the lean core never replaces the full bundle,
 * which registers only 36 languages.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.code.js'), 'utf8')
    .replace(/\bimport\(/g, 'window.__imp(')

const LANG_PREFIX = '@highlightjs/cdn-assets@11.11.1/languages/'
const FULL = '@highlightjs/cdn-assets@11.11.1/highlight.min.js'
const CORE_URL = 'https://esm.run/highlight.js@11.11.1/lib/core'
const COMMON = ['bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'graphql', 'ini', 'java', 'javascript',
    'json', 'kotlin', 'less', 'lua', 'makefile', 'markdown', 'objectivec', 'perl', 'php', 'php-template',
    'plaintext', 'python', 'python-repl', 'r', 'ruby', 'rust', 'scss', 'shell', 'sql', 'swift', 'typescript',
    'vbnet', 'wasm', 'xml', 'yaml']

function fakeHljs(name, langs = []) {
    const set = new Set(langs)
    return {
        name,
        listLanguages: () => [...set],
        getLanguage: (l) => set.has(l) ? {} : undefined,
        registerLanguage: (l) => set.add(l),
        highlight: (s, { language }) => {
            if (!set.has(language)) throw new Error(`Unknown language: ${language}`)
            return { value: s }
        },
        highlightElement() {},
    }
}

function deferred() {
    let resolve
    const promise = new Promise(r => { resolve = r })
    return { promise, resolve }
}

let vendor, imports, coreGate
function boot({ checked = false, hljs } = {}) {
    delete window.hljs
    if (hljs) window.hljs = hljs
    imports = []
    coreGate = null
    vendor = {
        checked,
        script: vi.fn(async (p) => {
            if (p === FULL) window.hljs = fakeHljs('full', COMMON)
            else if (p.startsWith(LANG_PREFIX)) window.hljs.registerLanguage(p.slice(LANG_PREFIX.length).replace(/\.min\.js$/, ''))
        }),
        fetch: vi.fn(async () => { throw new Error('unexpected fetch') }),
    }
    window.ManifestVendor = vendor
    window.__imp = vi.fn(async (url) => {
        imports.push(url)
        if (url === CORE_URL) {
            if (coreGate) await coreGate.promise
            return { default: fakeHljs('lean') }
        }
        return { default: () => ({}) }
    })
    globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} }
    new Function(SRC)()
    return window.ManifestCode
}

const langImports = () => imports.filter(u => u !== CORE_URL).map(u => u.split('/').pop())
const langScripts = () => vendor.script.mock.calls.map(c => c[0]).filter(p => p.startsWith(LANG_PREFIX))
    .map(p => p.slice(LANG_PREFIX.length).replace(/\.min\.js$/, ''))
const fullLoads = () => vendor.script.mock.calls.filter(c => c[0] === FULL).length

beforeEach(() => { document.body.innerHTML = '' })

describe('console sessions', () => {
    it('lean: console, shellsession and shell load shell plus bash, never the full bundle', async () => {
        for (const name of ['console', 'shellsession', 'shell']) {
            const code = boot()
            const hl = await code.loadHighlightJS(name)
            expect(hl.name, name).toBe('lean')
            expect(hl.listLanguages().sort(), name).toEqual(['bash', 'shell'])
            expect(langImports().sort(), name).toEqual(['bash', 'shell'])
            expect(fullLoads(), name).toBe(0)
        }
    })

    it('lean: sh, zsh and env stay bash', async () => {
        for (const name of ['sh', 'zsh', 'env']) {
            const code = boot()
            const hl = await code.loadHighlightJS(name)
            expect(hl.listLanguages(), name).toEqual(['bash'])
        }
    })

    it('a console block highlights with the shell grammar', async () => {
        const code = boot()
        document.body.innerHTML = '<pre x-code="console">$ npm install</pre>'
        await code.processCodeElement(document.querySelector('pre'))
        expect(document.querySelector('pre code').className).toBe('hljs language-shell')
    })
})

describe('case-insensitive fence names', () => {
    it('integrity mode: ENV, Vue, CSV, Console resolve inside the verified bundle', async () => {
        for (const name of ['ENV', 'Vue', 'CSV', 'Console', 'RS', 'TOML']) {
            const code = boot({ checked: true })
            await code.loadHighlightJS(name)
            expect(langScripts(), name).toEqual([])
        }
    })

    it('integrity mode: an uppercase name outside the bundle loads its locked file', async () => {
        const code = boot({ checked: true })
        await code.loadHighlightJS('Dockerfile')
        expect(langScripts()).toEqual(['dockerfile'])
    })

    it('lean mode: ENV, Vue, CSV, JSONC, Shell never escalate to the full bundle', async () => {
        for (const [name, want] of [['ENV', ['bash']], ['Vue', ['xml']], ['CSV', []], ['JSONC', ['json']], ['Shell', ['bash', 'shell']]]) {
            const code = boot()
            await code.loadHighlightJS(name)
            expect(fullLoads(), name).toBe(0)
            expect(langImports().sort(), name).toEqual(want)
            await code.loadHighlightJS('bash')
            expect(fullLoads(), name).toBe(0)
        }
    })

    it('uppercase fences highlight with the aliased grammar', async () => {
        const code = boot()
        document.body.innerHTML = '<pre x-code="Vue">&lt;template&gt;&lt;/template&gt;</pre><pre x-code="CSV">a,b</pre><pre x-code="ENV">A=1</pre>'
        const [vue, csv, env] = document.querySelectorAll('pre')
        await code.processCodeElement(vue)
        await code.processCodeElement(csv)
        await code.processCodeElement(env)
        expect(vue.querySelector('code').className).toBe('hljs language-xml')
        expect(csv.querySelector('code').className).toBe('hljs language-plaintext')
        expect(env.querySelector('code').className).toBe('hljs language-bash')
        expect(fullLoads()).toBe(0)
    })
})

describe('full bundle detection', () => {
    it('a lean language loaded after the 36-language full bundle registers on it', async () => {
        const code = boot()
        const full = await code.loadHighlightJS('auto')
        expect(full.listLanguages().length).toBe(36)
        const hl = await code.loadHighlightJS('dockerfile')
        expect(hl).toBe(full)
        expect(window.hljs).toBe(full)
        expect(full.listLanguages()).toContain('dockerfile')
        expect(imports).not.toContain(CORE_URL)
    })

    it('a group registering languages after the full bundle never imports the lean core', async () => {
        const code = boot()
        document.body.innerHTML = '<pre x-code>auto</pre>'
        await code.processCodeElement(document.querySelector('pre'))
        const full = window.hljs
        expect(full.name).toBe('full')
        document.body.innerHTML = '<div x-code-group><pre x-code="dockerfile" name="A">FROM x</pre><pre x-code="elixir" name="B">x</pre></div>'
        await code.setupCodeGroup(document.querySelector('[x-code-group]'))
        expect(window.hljs).toBe(full)
        expect(imports).not.toContain(CORE_URL)
        expect(full.listLanguages()).toEqual(expect.arrayContaining(['dockerfile', 'elixir']))
    })

    it('a lean core import that resolves after the full bundle does not replace it', async () => {
        const code = boot()
        coreGate = deferred()
        const lean = code.loadHighlightJS('dockerfile')
        await Promise.resolve()
        const full = await code.loadHighlightJS('auto')
        coreGate.resolve()
        const hl = await lean
        expect(window.hljs).toBe(full)
        expect(hl).toBe(full)
        expect(full.listLanguages()).toContain('dockerfile')
    })

    it('once the full bundle replaces the lean core, later registrations land on it', async () => {
        const code = boot()
        const lean = await code.loadHighlightJS('dockerfile')
        expect(lean.name).toBe('lean')
        const full = await code.loadHighlightJS('auto')
        expect(full.name).toBe('full')
        expect(window.hljs).toBe(full)
        document.body.innerHTML = '<div x-code-group><pre x-code="elixir" name="A">x</pre><pre x-code="haskell" name="B">x</pre><pre x-code="dockerfile" name="C">x</pre></div>'
        await code.setupCodeGroup(document.querySelector('[x-code-group]'))
        expect(window.hljs).toBe(full)
        expect(full.listLanguages()).toEqual(expect.arrayContaining(['elixir', 'haskell', 'dockerfile']))
        expect(await code.loadHighlightJS('Dockerfile')).toBe(full)
    })

    it('a host page instance is reused, not replaced by the lean core', async () => {
        const host = fakeHljs('host', ['javascript'])
        const code = boot({ hljs: host })
        const hl = await code.loadHighlightJS('rust')
        expect(hl).toBe(host)
        expect(window.hljs).toBe(host)
        expect(imports).not.toContain(CORE_URL)
        expect(host.listLanguages()).toContain('rust')
    })

    it('a grammar load still in flight when the full bundle lands is registered on the full bundle', async () => {
        const code = boot()
        await code.loadHighlightJS('bash')
        const gate = deferred()
        const orig = window.__imp.getMockImplementation()
        window.__imp.mockImplementation(async (url) => { if (url.endsWith('/dockerfile')) await gate.promise; return orig(url) })
        const pending = code.loadHighlightJS('dockerfile')
        await Promise.resolve()
        const full = await code.loadHighlightJS('auto')
        gate.resolve()
        await pending
        await code.loadHighlightJS('dockerfile')
        expect(full.listLanguages()).toContain('dockerfile')
    })
})

describe('grammar names', () => {
    it('a path-like fence name never reaches import(), in lean or full mode', async () => {
        for (const auto of [false, true]) {
            const code = boot()
            if (auto) await code.loadHighlightJS('auto')
            await code.loadHighlightJS('../../../left-pad')
            await code.loadHighlightJS('a/b')
            expect(imports.filter(u => u !== CORE_URL), String(auto)).toEqual([])
        }
    })

    it('a name that failed to load is not fetched again', async () => {
        const code = boot()
        window.__imp.mockImplementation(async (url) => {
            imports.push(url)
            if (url === CORE_URL) return { default: fakeHljs('lean') }
            throw new Error('404')
        })
        await code.loadHighlightJS('jsonl')
        await code.loadHighlightJS('jsonl')
        await code.loadHighlightJS('JSONL')
        expect(imports.filter(u => u.endsWith('/jsonl'))).toHaveLength(1)
    })

    it('Object.prototype keys are not aliases', async () => {
        const code = boot({ checked: true })
        await code.loadHighlightJS('constructor')
        expect(langScripts()).toEqual(['constructor'])
    })
})
