/**
 * The SPA router leaves new-tab clicks to the browser: target="_blank",
 * modifier keys, and non-primary buttons are never intercepted.
 */

import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import vm from 'vm'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let onClick
const pushed = []

beforeAll(() => {
    const source = readFileSync(path.resolve(__dirname, '../src/scripts/router/manifest.router.navigation.js'), 'utf-8')
    const history = { pushState: (_s, _t, url) => pushed.push(url) }
    const ctx = {
        window: {
            getManifestBasePath: () => '',
            location: { pathname: '/', origin: 'http://localhost', href: 'http://localhost/', hash: '', search: '' },
            ManifestComponentsRegistry: null,
            manifest: null,
            dispatchEvent: () => {},
            history,
            addEventListener: () => {},
            scrollTo: () => {},
            getComputedStyle: () => ({ overflowY: 'visible', overflow: 'visible' }),
        },
        document: {
            querySelector: () => null,
            querySelectorAll: () => [],
            head: { appendChild: () => {} },
            addEventListener: (type, fn) => { if (type === 'click') onClick = fn },
            readyState: 'complete',
        },
        history,
        URL,
        console,
        CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail } },
        Promise,
        setTimeout: () => {},
        requestAnimationFrame: () => {},
    }
    vm.runInNewContext(source, ctx)
})

function click(attrs, init = {}) {
    const link = {
        isContentEditable: false,
        getAttribute: (name) => attrs[name] ?? null,
        hasAttribute: (name) => name in attrs,
        closest: (sel) => (sel === 'a' ? link : null),
    }
    let prevented = false
    const event = {
        button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false,
        ...init,
        target: { closest: (sel) => (sel === 'a' ? link : null) },
        preventDefault: () => { prevented = true },
        stopPropagation: () => {},
        stopImmediatePropagation: () => {},
    }
    onClick(event)
    return prevented
}

describe('router link interception', () => {
    it('intercepts a plain same-site click', () => {
        expect(click({ href: '/docs' })).toBe(true)
    })

    it('leaves target="_blank" to the browser', () => {
        expect(click({ href: '/docs', target: '_blank' })).toBe(false)
    })

    it('still intercepts target="_self"', () => {
        expect(click({ href: '/docs', target: '_self' })).toBe(true)
    })

    it('leaves modifier and middle clicks to the browser', () => {
        for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
            expect(click({ href: '/docs' }, init)).toBe(false)
        }
    })
})
