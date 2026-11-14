/**
 * SPA link clicks keep the query string in every branch (plain, hash, _blank),
 * under a base path and a sticky locale, and _blank honours rel="noreferrer".
 */

import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import vm from 'vm'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.resolve(__dirname, '../src/scripts/router/manifest.router.navigation.js'), 'utf-8')

function boot({ base = '', pathname = '/', locales = null } = {}) {
    let onClick
    const pushed = []
    const opened = []
    const location = { pathname, origin: 'http://localhost', href: 'http://localhost' + pathname, hash: '', search: '' }
    const history = {
        pushState: (_s, _t, url) => {
            pushed.push(url)
            const u = new URL(url, location.href)
            Object.assign(location, { pathname: u.pathname, href: u.href, search: u.search, hash: u.hash })
        },
        replaceState: () => {},
    }
    const manifest = locales ? { data: { strings: Object.fromEntries(locales.map(l => [l, {}])) } } : null
    const ctx = {
        window: {
            getManifestBasePath: () => base,
            location,
            ManifestComponentsRegistry: null,
            manifest,
            dispatchEvent: () => {},
            history,
            addEventListener: () => {},
            scrollTo: () => {},
            getComputedStyle: () => ({ overflowY: 'visible', overflow: 'visible' }),
            open: (url, name, features) => opened.push([url, name, features]),
        },
        document: {
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: () => null,
            head: { appendChild: () => {}, querySelector: () => null },
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

    const click = (attrs) => {
        const rel = (attrs.rel || '').split(/\s+/).filter(Boolean)
        const link = {
            isContentEditable: false,
            relList: { contains: (t) => rel.includes(t) },
            getAttribute: (name) => attrs[name] ?? null,
            hasAttribute: (name) => name in attrs,
            closest: (sel) => (sel === 'a' ? link : null),
        }
        onClick({
            button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false,
            target: { closest: (sel) => (sel === 'a' ? link : null) },
            preventDefault: () => {}, stopPropagation: () => {}, stopImmediatePropagation: () => {},
        })
    }
    return { click, pushed, opened }
}

describe('router keeps the query string', () => {
    it('on a plain link', () => {
        const r = boot()
        r.click({ href: '/other?q=2' })
        expect(r.pushed.at(-1)).toBe('/other?q=2')
    })

    it('on a link with a hash', () => {
        const r = boot()
        r.click({ href: '/other?q=2#part' })
        expect(r.pushed.at(-1)).toBe('/other?q=2#part')
    })

    it('on target="_blank"', () => {
        const r = boot()
        r.click({ href: '/other?q=2#part', target: '_blank' })
        expect(r.opened.at(-1)).toEqual(['/other?q=2#part', '_blank', 'noopener'])
        expect(r.pushed).toEqual([])
    })

    it('keeps a ? inside the hash as part of the hash', () => {
        const r = boot()
        r.click({ href: '/other#a?b' })
        expect(r.pushed.at(-1)).toBe('/other#a?b')
    })

    it('under a base path and a sticky locale', () => {
        const r = boot({ base: '/app', pathname: '/app/fr/settings', locales: ['en', 'fr'] })
        r.click({ href: '/other?q=2' })
        expect(r.pushed.at(-1)).toBe('/app/fr/other?q=2')
        r.click({ href: '/next?q=3', target: '_blank' })
        expect(r.opened.at(-1)[0]).toBe('/app/fr/next?q=3')
    })

    it('on a query-only link, relative to the current page', () => {
        const r = boot({ pathname: '/docs' })
        r.click({ href: '?q=2' })
        expect(r.pushed.at(-1)).toBe('?q=2')
    })
})

describe('router _blank rel', () => {
    it('passes noreferrer when the link asks for it', () => {
        const r = boot()
        r.click({ href: '/other', target: '_blank', rel: 'external noreferrer' })
        expect(r.opened.at(-1)).toEqual(['/other', '_blank', 'noopener,noreferrer'])
    })
})
