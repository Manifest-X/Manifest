/**
 * @vitest-environment happy-dom
 *
 * manifest.components processor/swapping: processAll() re-entrancy.
 *
 * Each test runs the real source (not a mock) in an isolated vm context so
 * module-level state (componentInstanceCounters, swappedInstances,
 * activeRun/trailingRun) never leaks between tests. A fake
 * ManifestComponentsRegistry + ManifestComponentsLoader stand in for the
 * real registry/network fetch, following the same source-under-vm pattern
 * used by tests/router-navigation.test.js.
 */
import vm from 'vm'
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const processorSrc = readFileSync(path.resolve(__dirname, '../src/scripts/components/manifest.components.processor.js'), 'utf8')
const swappingSrc = readFileSync(path.resolve(__dirname, '../src/scripts/components/manifest.components.swapping.js'), 'utf8')

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// Fresh vm context per call: real `document` (shared/cleared per test), a
// throwaway `window` so registry/loader/routing never leak across tests.
function makeEnv({ names = ['widget'], loadDelayMs = 5, routing = null, path: currentPath = '/' } = {}) {
    const loadCalls = []
    const debugCalls = []
    const fakeWindow = { location: { pathname: currentPath } }
    fakeWindow.ManifestComponentsRegistry = { registered: new Set(names) }
    fakeWindow.ManifestComponentsLoader = {
        async loadComponent(name) {
            loadCalls.push(name)
            await tick(loadDelayMs)
            return `<div class="rendered-${name}"><span>content</span></div>`
        }
    }
    if (routing) fakeWindow.ManifestRouting = routing
    const fakeConsole = { ...console, debug: (...args) => debugCalls.push(args) }
    const ctx = { window: fakeWindow, document, console: fakeConsole, setTimeout, Promise, Set, Map, Array }
    vm.createContext(ctx)
    vm.runInContext(processorSrc, ctx)
    vm.runInContext(swappingSrc, ctx)
    return { window: fakeWindow, swapping: fakeWindow.ManifestComponentsSwapping, loadCalls, debugCalls }
}

function mountPlaceholders(tag, count) {
    document.body.innerHTML = `<div id="root">${Array.from({ length: count }, (_, i) => `<${tag} data-order="${i}"></${tag}>`).join('')}</div>`
}

beforeEach(() => {
    document.body.innerHTML = ''
})

describe('processAll concurrency', () => {
    it('(a) two concurrent calls: each placeholder swapped exactly once, zero reverts, live node untouched', async () => {
        mountPlaceholders('x-widget', 3)
        const { swapping, loadCalls } = makeEnv({ names: ['widget'] })

        const runA = swapping.processAll()
        const runB = swapping.processAll()
        await Promise.all([runA, runB])

        // Exactly one load per placeholder -> no double-processing.
        expect(loadCalls.length).toBe(3)

        const rendered = Array.from(document.querySelectorAll('[data-component]'))
        expect(rendered).toHaveLength(3)
        const ids = rendered.map((el) => el.getAttribute('data-component'))
        expect(new Set(ids).size).toBe(3) // no id collisions

        const liveNode = document.querySelector('[data-component="widget-1"]')
        expect(liveNode).toBeTruthy()

        // A third run over the now-stable tree must not touch the live node
        // (proves no teardown of an already-swapped, "open", component).
        await swapping.processAll()
        expect(loadCalls.length).toBe(3)
        const liveNodeAfter = document.querySelector('[data-component="widget-1"]')
        expect(liveNodeAfter.isSameNode(liveNode)).toBe(true)
    })

    it('(b) a call during an in-flight run with a DIFFERENT path: exactly two sequential runs, final state matches the second path', async () => {
        mountPlaceholders('x-widget', 2)
        const routing = {
            // Placeholder 0 only shows on '/a', placeholder 1 only on '/b'.
            matchesCondition: (currentPath, cond) => currentPath === cond
        }
        document.querySelectorAll('x-widget').forEach((el, i) => el.setAttribute('x-route', i === 0 ? 'a' : 'b'))
        const { swapping, loadCalls } = makeEnv({ names: ['widget'], routing })

        const runA = swapping.processAll('a')
        const runB = swapping.processAll('b')
        await Promise.all([runA, runB])

        // Two sequential runs total: one load for 'a's matching placeholder in
        // run 1, one load for 'b's matching placeholder in the coalesced run 2.
        expect(loadCalls.length).toBe(2)

        // Final state matches path 'b': widget for 'a' reverted, widget for 'b' live.
        const rendered = document.querySelectorAll('.rendered-widget')
        expect(rendered).toHaveLength(1)

        // The reverted placeholder is back as an unswapped <x-widget x-route="a">.
        const revertedPlaceholder = document.querySelector('x-widget[x-route="a"]')
        expect(revertedPlaceholder).toBeTruthy()
    })

    it('(c) a skip branch emits a console.debug line instead of nothing', async () => {
        // A nested placeholder whose custom element isn't in the registry yet
        // (the cold-boot scenario from the ticket: registration races the swap
        // pass) — processAll still queues it, processComponent silently bailed
        // with nothing to see pre-fix.
        mountPlaceholders('x-mystery', 1)
        const { swapping, debugCalls, loadCalls } = makeEnv({ names: ['widget'] }) // 'mystery' not registered

        await swapping.processAll()

        expect(loadCalls.length).toBe(0) // never fetched -> would be a silent ghost pre-fix
        expect(debugCalls.some((args) => String(args[0]).includes('skipped'))).toBe(true)
    })

    it('(d) three consecutive runs over a stable tree: swapIn/load called once per placeholder total', async () => {
        mountPlaceholders('x-widget', 3)
        const { swapping, loadCalls } = makeEnv({ names: ['widget'] })

        await swapping.processAll()
        await swapping.processAll()
        await swapping.processAll()

        expect(loadCalls.length).toBe(3)
        expect(document.querySelectorAll('[data-component]')).toHaveLength(3)
    })
})
