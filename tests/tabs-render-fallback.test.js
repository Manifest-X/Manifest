/**
 * @vitest-environment happy-dom
 *
 * Tabs: the "events didn't fire" fallback runs at 2s, and at 200ms only under
 * mnfst-render's auto settle (window.__manifestRenderSettle === 'auto'), so
 * fixed-mode renders and older engines keep the original timing.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.tabs.js'), 'utf8')

function fallbackDelays() {
    const spy = vi.spyOn(window, 'setTimeout')
    new Function(CODE)()
    const delays = spy.mock.calls.map((c) => c[1]).filter((d) => d >= 200)
    spy.mockRestore()
    return delays
}

afterEach(() => { delete window.__manifestRender; delete window.__manifestRenderSettle })

describe('tabs fallback timer', () => {
    it('keeps 2s in fixed-mode prerender', () => {
        window.__manifestRender = true
        expect(fallbackDelays()).toContain(2000)
    })

    it('runs at 200ms under auto settle', () => {
        window.__manifestRender = true
        window.__manifestRenderSettle = 'auto'
        const d = fallbackDelays()
        expect(d).toContain(200)
        expect(d).not.toContain(2000)
    })
})
