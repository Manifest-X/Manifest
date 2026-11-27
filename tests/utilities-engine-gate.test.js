/**
 * @vitest-environment happy-dom
 *
 * Utilities module side of the publish-time engine skip: once the loader accepts a stamp
 * (window.__tailwindStamp, see loader-tailwind-stamp.test.js), each class token is checked where the
 * module first records it, and the first one outside tokens ∪ sheet ∪ ignore asks for the engine once.
 * No observer of its own. Real-Chromium coverage: tests/e2e/tailwind-stamp.e2e.mjs.
 * STAMP_LIB=<dir> runs it against another lib/.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LIB = process.env.STAMP_LIB || join(__dirname, '../lib')
const bundleSrc = readFileSync(join(LIB, 'manifest.utilities.js'), 'utf8')
const SHEET = '<style data-mnfst-utilities>.p-4{padding:1rem}.md\\:flex{display:flex}</style>'
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

function stamp({ accepted = true, tokens = ['flex', 'card', 'gap-4'] } = {}) {
    const s = { mode: 'skip', accepted, tokens: new Set(tokens), trigger: null, decision: Promise.resolve(accepted) }
    s.needEngine = vi.fn((token, reason) => { if (!s.trigger) s.trigger = { token, reason } })
    return s
}

beforeEach(() => {
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    delete window.__manifestLoaded
})

async function boot({ headHtml = SHEET, bodyHtml = '', tailwindStamp = stamp(), manifest = null, waitReady = true } = {}) {
    document.head.innerHTML = headHtml
    document.body.innerHTML = bodyHtml
    window.tailwind = {}
    window.ManifestComponentsRegistry = { manifest: {} }
    if (manifest) window.__manifestLoaded = manifest
    delete window.__manifestUtilitiesReady
    window.__manifestUtilitiesPending = 0
    if (tailwindStamp) window.__tailwindStamp = tailwindStamp
    else delete window.__tailwindStamp
    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + `\n//boot:${Math.random()}`))
    if (waitReady) await ready
    await settle()
    return { compiler: window.ManifestUtilities, gate: tailwindStamp }
}

const add = (html, parent = document.body) => {
    const wrap = document.createElement('div')
    wrap.innerHTML = html
    parent.appendChild(wrap)
}

describe('arming', () => {
    it('no stamp: no gate', async () => {
        const { compiler } = await boot({ tailwindStamp: null, bodyHtml: '<div class="skew-x-12"></div>' })
        expect(compiler._engineGate).toBe(undefined)
    })

    it('a stamp the loader refused: no gate, no request', async () => {
        const { compiler, gate } = await boot({ tailwindStamp: stamp({ accepted: false }), bodyHtml: '<div class="skew-x-12"></div>' })
        expect(compiler._engineGate).toBe(undefined)
        expect(gate.needEngine).not.toHaveBeenCalled()
    })

    it('a prerendered page (static prerender utilities): no gate', async () => {
        const { compiler, gate } = await boot({
            headHtml: '<meta name="manifest:prerendered" content="1"><link rel="stylesheet" href="/prerender.utilities.css">',
            bodyHtml: '<div class="skew-x-12"></div>',
            waitReady: false
        })
        await new Promise(r => setTimeout(r, 50))
        expect(compiler.usesStaticPrerenderUtilities).toBe(true)
        expect(compiler._engineGate).toBe(undefined)
        expect(gate.needEngine).not.toHaveBeenCalled()
    })

    it('no readable sheet: the engine is asked for', async () => {
        const { gate } = await boot({ headHtml: '', bodyHtml: '<div class="flex"></div>' })
        expect(gate.needEngine).toHaveBeenCalledWith(null, 'sheet')
    })
})

describe('tokens', () => {
    it('known tokens, sheet classes, ignored and framework state classes need nothing', async () => {
        const { compiler, gate } = await boot({
            bodyHtml: '<div class="flex card p-4 md:flex x-cloak-ish dark active iconify"><pre><code class="hljs language-js">x</code></pre></div>'
        })
        document.documentElement.classList.add('dark')
        add('<div class="gap-4 copied"></div>')
        await settle()
        expect(compiler._engineGate).toBe(gate)
        expect(gate.needEngine).not.toHaveBeenCalled()
    })

    it('an unknown token in the initial markup asks once', async () => {
        const { gate } = await boot({ bodyHtml: '<div class="flex skew-x-12 rotate-3"></div>' })
        expect(gate.needEngine).toHaveBeenCalledTimes(1)
        expect(gate.needEngine.mock.calls[0][1]).toBe('token')
        expect(['skew-x-12', 'rotate-3']).toContain(gate.needEngine.mock.calls[0][0])
    })

    it('a node added later asks once; later tokens do not ask again', async () => {
        const { gate } = await boot({ bodyHtml: '<div class="flex"></div>' })
        expect(gate.needEngine).not.toHaveBeenCalled()
        add('<span class="skew-x-12"></span>')
        await settle()
        add('<span class="rotate-3"></span>')
        await settle()
        expect(gate.needEngine.mock.calls).toEqual([['skew-x-12', 'token']])
    })

    it('a class attribute change asks', async () => {
        const { gate } = await boot({ bodyHtml: '<div id="t" class="flex"></div>' })
        document.getElementById('t').setAttribute('class', 'flex ring-2')
        await settle()
        expect(gate.needEngine).toHaveBeenCalledWith('ring-2', 'token')
    })

    it('a :class literal on an added node asks before it is applied', async () => {
        const { gate } = await boot({ bodyHtml: '<div class="flex"></div>' })
        add(`<div x-data="{ on: false }" :class="on ? 'bg-rose-500' : ''"></div>`)
        await settle()
        expect(gate.needEngine).toHaveBeenCalledWith('bg-rose-500', 'token')
    })

    it('injected HTML deep in a subtree asks', async () => {
        const { gate } = await boot({ bodyHtml: '<div id="host" class="flex"></div>' })
        document.getElementById('host').innerHTML = '<section><ul><li class="card underline"></li></ul></section>'
        await settle()
        expect(gate.needEngine).toHaveBeenCalledWith('underline', 'token')
    })

    it('a token inside a code block still asks (the engine would style it)', async () => {
        const { gate } = await boot({ bodyHtml: '<div class="flex"></div>' })
        add('<pre class="p-9"><code>x</code></pre>')
        await settle()
        expect(gate.needEngine).toHaveBeenCalledWith('p-9', 'token')
    })

    it('utilities.patterns do not excuse a token', async () => {
        const { gate } = await boot({ manifest: { utilities: { patterns: ['^bg-'] } }, bodyHtml: '<div class="flex"></div>' })
        add('<div class="bg-amber-500"></div>')
        await settle()
        expect(gate.needEngine).toHaveBeenCalledWith('bg-amber-500', 'token')
    })

    it('tokens the module ignores by pattern (code module) never ask', async () => {
        const { compiler, gate } = await boot({ bodyHtml: '<div class="flex"></div>' })
        compiler.addIgnoredClassPattern(/^expand$/)
        add('<div class="expand hljs-keyword language-ts"></div>')
        await settle()
        expect(gate.needEngine).not.toHaveBeenCalled()
    })
})

describe('which tokens could need the engine', () => {
    const asked = async (tokens) => {
        const { gate } = await boot({ bodyHtml: '<div class="flex"></div>' })
        const out = []
        for (const t of tokens) {
            gate.trigger = null
            gate.needEngine.mockClear()
            const d = document.createElement('div')
            d.setAttribute('class', t)
            document.body.appendChild(d)
            await settle(2)
            out.push(gate.needEngine.mock.calls.length > 0)
        }
        return out
    }

    it('bare words the engine has no utility for never ask (framework hooks, author hooks, junk)', async () => {
        const words = ['iconify', 'prompt', 'prompt_', 'false', 'card', 'toast', 'row', 'col', 'dark', 'light', 'active', 'colorpicker', 'gradient', 'hue', 'alpha', 'solid', 'library']
        expect(await asked(words)).toEqual(words.map(() => false))
    })

    it('bare utilities the engine has always ask when the bake did not see them', async () => {
        const words = ['hidden', 'grow', 'container', 'shadow', 'truncate', 'italic', 'sticky', 'rounded', 'underline', 'transition', 'filter']
        expect(await asked(words)).toEqual(words.map(() => true))
    })

    it('tokens that cannot be candidates never ask', async () => {
        const junk = ['for=', 'name=', '"quoted', "it's", 'a{b}', 'x;y', 'f(x', 'a]b', '`tpl`', 'a,b', '<b>', '${x}', 'gradient-layer-icon-', 'bg-', "content-['(]", "content-[']"]
        expect(await asked(junk)).toEqual(junk.map(() => false))
    })

    it('arbitrary values with = or quotes inside brackets still ask', async () => {
        const real = ["content-['x']", 'data-[state=open]:flex', '[&_a]:underline', 'bg-(--brand)', 'w-[calc(100%-1rem)]',
            "content-['(']", "content-[')']", "content-['[']", "content-[']']", "before:content-['(']", 'content-["]"]', "content-['\\'(']", "[&[data-x=']']]:flex"]
        expect(await asked(real)).toEqual(real.map(() => true))
    })

    it('framework classes the engine emits nothing for never ask', async () => {
        const fw = ['tabs-wrapper', 'color-icon-solid', 'gradient-layer-icon-linear', 'toast-entry', 'window-resizing', 'range-start', 'no-scrollbar', 'p-safe', 'iconify--lucide', 'iconify--simple-icons', 'author-hook-thing']
        expect(await asked(fw)).toEqual(fw.map(() => false))
    })

    it('runtime Tailwind classes the bake missed ask', async () => {
        const real = ['!text-white', 'dark:!bg-pink-900', '!gap-0', 'h-112', 'bg-stone-600', 'font-sans', '[&_strong]:-ml-1', '-mt-2', 'md:hidden', 'hover:underline', 'gap-6!', 'bg-red-500/50', 'w-1/2', 'sr-only', 'pointer-events-none', '-inset-x-full', '@md:flex', '[mask-type:luminance]', 'text-content-stark']
        expect(await asked(real)).toEqual(real.map(() => true))
    })
})

describe('author text/tailwindcss blocks', () => {
    it('one already in the page asks', async () => {
        const { gate } = await boot({ headHtml: SHEET + '<style type="text/tailwindcss">@theme { --color-x: red; }</style>', bodyHtml: '<div class="flex"></div>' })
        expect(gate.needEngine).toHaveBeenCalledWith(null, 'author-block')
    })

    it('one added later (alone or inside a subtree) asks', async () => {
        const { gate } = await boot({ bodyHtml: '<div class="flex"></div>' })
        add('<style type="text/tailwindcss">@theme { --color-x: red; }</style>')
        await settle()
        expect(gate.needEngine).toHaveBeenCalledWith(null, 'author-block')
    })

    it('the module\'s own variants block does not count', async () => {
        const { gate } = await boot({ bodyHtml: '<div class="flex"></div>' })
        expect(document.getElementById('manifest-tailwind-variants')).toBeTruthy()
        expect(gate.needEngine).not.toHaveBeenCalled()
    })
})

describe('retired paths', () => {
    it('the old uncovered-class watcher and -complete check are gone', () => {
        expect(bundleSrc).not.toContain('setupUncoveredClassWatcher')
        expect(bundleSrc).not.toContain('data-mnfst-utilities-complete')
        expect(bundleSrc).not.toContain('manifest:utilities-uncovered')
    })
})
