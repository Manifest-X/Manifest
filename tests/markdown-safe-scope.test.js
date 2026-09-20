/**
 * @vitest-environment happy-dom
 *
 * x-markdown's second update path (content changes after the first render —
 * e.g. a client-side locale switch resolving a new .md path) referenced `safe`
 * from a sibling scope where it was never declared, throwing ReferenceError
 * and leaving the region stuck on its previous body. The declaration is now
 * hoisted to directive scope. Also covers the prerender classification stamp:
 * the resolved source lands on data-mnfst-md-src before the fetch.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
window.__manifestLoaderStarted = true
window.Alpine = Alpine
// Plugin lazy-loads marked from a CDN unless a global already exists.
globalThis.marked = {
  parse: (s) => `<p>${s}</p>`,
  use: () => {},
  Renderer: class {},
  setOptions: () => {},
}

const bodies = { '/c/en/a.md': 'Hello World', '/c/es/a.md': 'Hola Mundo' }
const fetched = []
globalThis.fetch = async (url) => {
  fetched.push(String(url))
  const body = bodies[String(url)]
  return { ok: body !== undefined, text: async () => body ?? '' }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

beforeAll(async () => {
  const src = readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'manifest.markdown.js'), 'utf8')
  new Function(src)()
  Alpine.start()
})

describe('x-markdown second update path', () => {
  it('re-renders on a source change instead of throwing over an undeclared `safe`, and stamps the resolved source', async () => {
    const errs = []
    const onErr = (e) => errs.push(String(e.reason || e.error || e.message))
    window.addEventListener('unhandledrejection', onErr)
    window.addEventListener('error', onErr)

    const host = document.createElement('div')
    host.innerHTML = `<div x-data="{ loc: 'en' }"><article x-markdown="'/c/' + loc + '/a.md'"></article></div>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    await settle(); await settle()

    const el = host.querySelector('article')
    expect(el.innerHTML).toContain('Hello World')
    expect(el.getAttribute('data-mnfst-md-src')).toBe('/c/en/a.md')

    // Content change → the SECOND update path (this threw before the hoist).
    Alpine.$data(host.firstElementChild).loc = 'es'
    await settle(); await settle(); await settle()

    expect(errs.filter((e) => /safe is not defined/.test(e))).toEqual([])
    expect(el.innerHTML).toContain('Hola Mundo')
    expect(el.getAttribute('data-mnfst-md-src')).toBe('/c/es/a.md')
  })
})
