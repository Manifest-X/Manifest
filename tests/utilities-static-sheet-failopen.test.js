/**
 * @vitest-environment happy-dom
 *
 * Fail-open behavior for `<link data-mnfst-utilities>` detection
 * (manifest.utilities.static.js): a read failure — no sheet yet, a thrown
 * error (cross-origin), or zero readable rules — must mean "cover nothing",
 * never "everything covered", and must never be cached as a permanent
 * failure: a link that loads late should still end up correctly covered for
 * later compiles, with nothing lost from the classes compiled before it did.
 */
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bundleSrc = readFileSync(join(__dirname, '../lib/manifest.utilities.js'), 'utf8')

let compiler

beforeEach(async () => {
    vi.restoreAllMocks() // clear the previous test's document.styleSheets spy before booting a new instance
    document.head.innerHTML = ''
    document.body.innerHTML = '<div></div>'
    window.tailwind = {} // isTailwindAvailable() true immediately — skip the 5s poll
    window.ManifestComponentsRegistry = { manifest: {} } // skip the 2s registry wait
    delete window.__manifestUtilitiesReady
    window.__manifestUtilitiesPending = 0

    const ready = new Promise((resolve) => window.addEventListener('manifest:utilities-ready', resolve, { once: true }))
    // Fresh module evaluation per test (fresh instance/listeners) — see
    // utilities-static-sheet.test.js for why the nonce is needed.
    const nonce = `\n//boot:${Math.random()}`
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(bundleSrc + nonce))
    await ready
    compiler = window.ManifestUtilities
})

function makeLinkEl() {
    const link = document.createElement('link')
    link.setAttribute('rel', 'stylesheet')
    link.setAttribute('data-mnfst-utilities', '')
    // A data: href avoids happy-dom actually fetching it over the network —
    // this suite never reads `href` itself (readStaticUtilitiesRules only
    // reads document.styleSheets), so its value is otherwise irrelevant.
    link.setAttribute('href', 'data:text/css,')
    document.head.appendChild(link)
    return link
}

describe('detectStaticUtilitiesSheet / readStaticUtilitiesRules — fail open', () => {
    it('a link with no matching stylesheet yet (null sheet) covers nothing', async () => {
        const link = makeLinkEl() // happy-dom never populates document.styleSheets for it — no fetch
        const settle = compiler.detectStaticUtilitiesSheet()
        link.dispatchEvent(new Event('error'))
        await settle

        expect(compiler.staticUtilitiesCoveredClasses).toBeNull()
        expect(compiler.filterStaticallyCoveredClasses(['p-4', 'row'])).toEqual(['p-4', 'row'])
    })

    it('a readable sheet covers only its own classes, nothing else', async () => {
        const link = makeLinkEl()
        vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([
            { ownerNode: link, cssRules: [{ cssText: '.p-4 { padding: 1rem }' }] }
        ])

        await compiler.detectStaticUtilitiesSheet()

        expect(compiler.staticUtilitiesCoveredClasses.has('p-4')).toBe(true)
        expect(compiler.filterStaticallyCoveredClasses(['p-4', 'row'])).toEqual(['row'])
    })

    it('a thrown read (cross-origin sheet) covers nothing, not everything', async () => {
        const link = makeLinkEl()
        vi.spyOn(document, 'styleSheets', 'get').mockImplementation(() => {
            throw new Error('SecurityError: cross-origin stylesheet')
        })

        const settle = compiler.detectStaticUtilitiesSheet()
        link.dispatchEvent(new Event('load'))
        await settle

        expect(compiler.staticUtilitiesCoveredClasses).toBeNull()
        expect(compiler.filterStaticallyCoveredClasses(['p-4'])).toEqual(['p-4'])
    })

    it('zero readable rules at read time covers nothing (not "everything")', async () => {
        const link = makeLinkEl()
        vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([
            { ownerNode: link, cssRules: [] }
        ])

        const settle = compiler.detectStaticUtilitiesSheet()
        link.dispatchEvent(new Event('load'))
        await settle

        expect(compiler.staticUtilitiesCoveredClasses).toBeNull()
        expect(compiler.filterStaticallyCoveredClasses(['p-4'])).toEqual(['p-4'])
    })

    it('a late-loading sheet ends up covered once load fires — nothing lost before', async () => {
        const link = makeLinkEl()
        const styleSheetsSpy = vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([])

        const settle = compiler.detectStaticUtilitiesSheet()

        // Before load: unreadable, so nothing is treated as covered.
        expect(compiler.staticUtilitiesCoveredClasses).toBeNull()
        expect(compiler.filterStaticallyCoveredClasses(['p-4', 'row'])).toEqual(['p-4', 'row'])

        // Sheet finishes loading — now readable.
        styleSheetsSpy.mockReturnValue([
            { ownerNode: link, cssRules: [{ cssText: '.p-4 { padding: 1rem }' }] }
        ])
        link.dispatchEvent(new Event('load'))
        await settle

        expect(compiler.staticUtilitiesCoveredClasses.has('p-4')).toBe(true)
        expect(compiler.filterStaticallyCoveredClasses(['p-4', 'row'])).toEqual(['row'])
    })

    it('never caches an empty read as a permanent failure — never treated as "everything covered"', async () => {
        const link = makeLinkEl()
        vi.spyOn(document, 'styleSheets', 'get').mockReturnValue([{ ownerNode: link, cssRules: [] }])

        const settle = compiler.detectStaticUtilitiesSheet()
        link.dispatchEvent(new Event('load'))
        await settle

        // Whatever the app's real class list is, an unresolved read must
        // never zero it out — that's the "page rendered with no utilities"
        // failure mode this guards against.
        const classes = ['p-4', 'row', 'md:row', 'hover:bg-brand']
        expect(compiler.filterStaticallyCoveredClasses(classes)).toEqual(classes)
    })
})
