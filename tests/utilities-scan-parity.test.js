/**
 * @vitest-environment node
 *
 * Parity: the tokens the node bake shows Tailwind (bakeUtilities over scanClasses)
 * equal the tokens the browser utilities module discovers on the same page
 * (its static scan plus the DOM's class attributes, as getUsedClasses collects them).
 */
import { readFileSync, readdirSync } from 'fs'
import { join, dirname, relative, extname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, afterAll } from 'vitest'
import { Window } from 'happy-dom'
import { bakeUtilities, scanClasses } from '../lib/manifest.utilities.node.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = readFileSync(join(repo, 'lib/manifest.utilities.js'), 'utf8')

const EDGE_CASES = `<!DOCTYPE html>
<html class="scroll-smooth" lang="en">
<head><title>edge</title><style>.plain { color: red; }</style></head>
<body class="antialiased min-h-screen">
<!-- Page -->
<main x-data="{ open: false, tone: 'text-red-500', parts: 'a/b'.split('/') }" class="flex flex-col gap-4 md:flex-row">
  <div class='p-4 rounded-lg' :class="open ? 'bg-white shadow-md' : 'bg-gray-100'"></div>
  <div x-bind:class="{ 'ring-2 ring-blue-500': open, hidden: !open }" class="w-[37px] h-[calc(100%-1rem)]"></div>
  <div :class="\`px-2 \${open ? 'py-1' : ''}\`"></div>
  <div x-show="open"
    x-transition:enter="transition ease-out duration-300"
    x-transition:enter-start="opacity-0 scale-90"
    x-transition:enter-end="opacity-100 scale-100"
    x-transition:leave="transition ease-in duration-150"
    x-transition:leave-end="opacity-0"
    class="absolute inset-0 hover:bg-black/50 dark:bg-slate-900 touch:px-4 mac:font-semibold"></div>
  <template x-if="open"><span class="text-sm font-medium x-cloak">shown</span></template>
  <template x-for="item in []"><li class="list-disc ml-6" :class="item.done && 'line-through'"></li></template>
  <pre><code class="language-js hljs">const a = 1</code></pre>
  <button class="selected copy -mt-2 !font-bold [mask-type:luminance] supports-[display:grid]:grid"></button>
  <svg class="size-6 stroke-current" viewBox="0 0 24 24"><path class="fill-none"></path></svg>
  <p class=italic>unquoted</p>
  <div class="[&amp;_p]:mt-2 [&>*]:p-2 content-[&quot;x&quot;]" x-transition:leave-start=opacity-90></div>
</main>
</body>
</html>`

function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p, out)
        else if (extname(e.name) === '.html') out.push(p)
    }
    return out
}

const FIXTURES = [
    ['edge-cases', EDGE_CASES],
    ...[...walk(join(repo, 'src')), ...walk(join(repo, 'templates/starter'))]
        .sort()
        .map(p => [relative(repo, p), readFileSync(p, 'utf8')]),
]

async function nodeTokens(html) {
    const { tailwind } = await bakeUtilities({ classes: scanClasses(html) })
    return tailwind.candidates
}

const windows = []
afterAll(async () => { for (const w of windows) await w.happyDOM.close() })

async function browserTokens(html) {
    const win = new Window({ url: 'https://example.test/', settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true, navigator: { userAgent: 'parity' } } })
    windows.push(win)
    const doc = win.document
    const parsed = new win.DOMParser().parseFromString(html, 'text/html')
    const root = doc.importNode(parsed.documentElement, true)
    doc.documentElement.remove()
    doc.appendChild(root)
    win.tailwind = {}
    win.ManifestComponentsRegistry = { manifest: {} }
    win.eval(BUNDLE)
    const compiler = win.ManifestUtilities
    compiler.staticScanPromise = null
    compiler.staticClassCache.clear()
    compiler.dynamicClassCache.clear()
    await compiler.scanStaticClasses()
    return compiler.getUsedClasses().classes.slice().sort()
}

describe('node-only sources', () => {
    it('class:token= bindings are read by the bake only (a superset, never a gap)', async () => {
        const html = '<div class="p-2" class:is-open="open"></div>'
        expect(await nodeTokens(html)).toEqual(['is-open', 'p-2'])
        expect(await browserTokens(html)).toEqual(['p-2'])
    })
})

describe('node bake and browser scan see the same tokens', () => {
    it('covers the repo\'s own pages', () => {
        expect(FIXTURES.length).toBeGreaterThan(30)
    })

    it('edge cases reach both sides', async () => {
        const expected = ['scroll-smooth', 'md:flex-row', 'bg-white', 'ring-2', 'hidden', 'py-1', 'duration-300', 'scale-90', 'font-medium', 'line-through',
            'language-js', 'selected', '!font-bold', '[mask-type:luminance]', 'fill-none', 'italic', '[&_p]:mt-2', '[&>*]:p-2', 'content-["x"]', 'opacity-90']
        expect(await nodeTokens(EDGE_CASES)).toEqual(expect.arrayContaining(expected))
        expect(await browserTokens(EDGE_CASES)).toEqual(expect.arrayContaining(expected))
    })

    for (const [name, html] of FIXTURES) {
        it(name, async () => {
            const [node, browser] = await Promise.all([nodeTokens(html), browserTokens(html)])
            const onlyNode = node.filter(t => !browser.includes(t))
            const onlyBrowser = browser.filter(t => !node.includes(t))
            expect({ onlyNode, onlyBrowser }).toEqual({ onlyNode: [], onlyBrowser: [] })
        })
    }
})
