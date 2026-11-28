import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import * as page from '../src/scripts/manifest.render.page.mjs'
import * as render from '../src/scripts/manifest.render.mjs'

const LINK = '<link rel="stylesheet" href="/site.css" data-mnfst-utilities data-tailwind-stamp="4.3.1:1a2b3c" data-tailwind-mode="skip">'
const TOKENS = '<script type="application/json" data-tailwind-tokens>{"seed":"4.3.1:1a2b3c","tokens":["flex","p-4"]}</script>'
const STAMPED = `<!DOCTYPE html><html><head>${LINK}
${TOKENS}
<script src="/manifest.min.js" data-tailwind="cache"></script></head>
<body><div class="flex" data-tailwind-seed data-x=" data-tailwind">x</div>
<pre><code>&lt;script src="manifest.min.js" data-tailwind&gt;</code></pre>
<script>const s = '<i data-tailwind>'</script></body></html>`

const strips = [['stripRuntimeTailwindArtifacts', page.stripRuntimeTailwindArtifacts], ['stripDataTailwindAttr', page.stripDataTailwindAttr]]

describe('render: data-tailwind strip matches the bare attribute only', () => {
    for (const [name, strip] of strips) {
        describe(name, () => {
            const out = strip(STAMPED)

            it('removes the loader attribute, with or without a value', () => {
                expect(out).toContain('<script src="/manifest.min.js"></script>')
                expect(strip('<script src="/m.js" data-tailwind defer></script>')).toBe('<script src="/m.js" defer></script>')
                expect(strip("<script data-tailwind='cache' src=/m.js></script>")).toBe('<script src=/m.js></script>')
                expect(strip('<script src="/m.js" data-tailwind=cache>')).toBe('<script src="/m.js">')
                expect(strip('<script src="/m.js" DATA-TAILWIND/>')).toBe('<script src="/m.js"/>')
            })

            it('never produces a fragment of a data-tailwind-* name', () => {
                expect(out).not.toMatch(/(?<!data-tailwind)-(stamp|mode|tokens|seed)\b/)
                expect(out).not.toContain('data-mnfst-utilities-stamp')
            })

            it('drops the stamp attributes and the tokens script, leaving a valid link', () => {
                expect(out).not.toContain('data-tailwind-stamp')
                expect(out).not.toContain('data-tailwind-mode')
                expect(out).not.toContain('data-tailwind-tokens')
                expect(out).not.toContain('"tokens"')
                expect(out).toContain('<link rel="stylesheet" href="/site.css" data-mnfst-utilities>')
            })

            it('leaves other data-tailwind-* attributes, attribute values, text and script bodies alone', () => {
                expect(out).toContain('<div class="flex" data-tailwind-seed data-x=" data-tailwind">x</div>')
                expect(out).toContain('&lt;script src="manifest.min.js" data-tailwind&gt;')
                expect(out).toContain(`const s = '<i data-tailwind>'`)
            })

            it('is a no-op on an unstamped page without the attribute', () => {
                const plain = '<html><head><link rel="stylesheet" href="/a.css" data-mnfst-utilities><script src="/m.js"></script></head><body></body></html>'
                expect(strip(plain)).toBe(plain)
            })
        })
    }

    it('custom elements named like raw-text tags are ordinary tags', () => {
        const html = '<script-x data-tailwind-tokens></script-x><main>KEEP</main><style-guide data-tailwind></style-guide><textarea-autosize></textarea-autosize><script>1</script><style>a{}</style>'
        for (const [, strip] of strips) {
            expect(strip(html)).toBe('<script-x data-tailwind-tokens></script-x><main>KEEP</main><style-guide></style-guide><textarea-autosize></textarea-autosize><script>1</script><style>a{}</style>')
        }
        expect(page.htmlUsesRuntimeTailwind('<style-guide></style-guide><script src="/manifest.min.js" data-tailwind></script><style>a{}</style>')).toBe(true)
        expect(page.htmlUsesRuntimeTailwind('<script-x></script-x><script src="/manifest.min.js" data-tailwind></script><script>1</script>')).toBe(true)
    })

    it('stripRuntimeTailwindArtifacts still drops the runtime engine <style>', () => {
        expect(page.stripRuntimeTailwindArtifacts('<head><style>/*! tailwindcss v4 */ .a{}</style></head>')).toBe('<head></head>')
    })
})

describe('render: runtime Tailwind detection', () => {
    const detect = (html) => {
        const dir = mkdtempSync(join(tmpdir(), 'mnfst-tw-attr-'))
        try {
            writeFileSync(join(dir, 'index.html'), html)
            return render.indexHtmlUsesTailwind(dir)
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    }

    it('detects data-tailwind on the loader', () => {
        expect(detect('<script src="/manifest.min.js" data-tailwind></script>')).toBe(true)
        expect(detect('<script data-tailwind="cache" src="https://cdn.manifestx.dev/manifest.min.js"></script>')).toBe(true)
    })

    it('a stamped page without data-tailwind is not runtime Tailwind', () => {
        expect(detect(`${LINK}${TOKENS}<script src="/manifest.min.js"></script>`)).toBe(false)
    })

    it('ignores data-tailwind outside the loader tag', () => {
        expect(detect('<div data-tailwind></div><script src="/manifest.min.js"></script>')).toBe(false)
        expect(detect('<p>&lt;script data-tailwind&gt;</p><script src="/manifest.min.js"></script>')).toBe(false)
    })
})
