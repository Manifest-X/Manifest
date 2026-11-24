/**
 * @vitest-environment happy-dom
 *
 * ManifestVendor without the loader: one jsDelivr tag carrying the pinned hash; a matching tag
 * that already ran (and never fires load again) settles instead of hanging.
 */
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const SNIPPET = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/scripts/snippets/manifest.vendor.js'), 'utf8')
const SRC = 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js'

beforeEach(() => {
    delete window.ManifestVendor
    delete window.Manifest
    document.head.innerHTML = ''
    new Function(SNIPPET)()
})

describe('ManifestVendor standalone', () => {
    it('injects one tag with integrity + crossorigin', () => {
        window.ManifestVendor.script('marked@15.0.12/marked.min.js', 'sha384-abc')
        const t = document.querySelector(`script[src="${SRC}"]`)
        expect(t.getAttribute('integrity')).toBe('sha384-abc')
        expect(t.getAttribute('crossorigin')).toBe('anonymous')
    })

    it('an existing tag whose fetch finished settles without a load event', async () => {
        const pre = document.createElement('script')
        pre.setAttribute('src', SRC)
        document.head.appendChild(pre)
        vi.spyOn(performance, 'getEntriesByName').mockImplementation((n) => (n === SRC ? [{}] : []))
        await expect(window.ManifestVendor.script('marked@15.0.12/marked.min.js', 'sha384-abc')).resolves.toBeUndefined()
        expect(document.querySelectorAll(`script[src="${SRC}"]`).length).toBe(1)
    })

    it('an existing tag with no timing entry settles after the bound', async () => {
        vi.useFakeTimers()
        const pre = document.createElement('script')
        pre.setAttribute('src', SRC)
        document.head.appendChild(pre)
        vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
        const p = window.ManifestVendor.script('marked@15.0.12/marked.min.js', 'sha384-abc')
        vi.advanceTimersByTime(4100)
        await expect(p).resolves.toBeUndefined()
        vi.useRealTimers()
    })
})
