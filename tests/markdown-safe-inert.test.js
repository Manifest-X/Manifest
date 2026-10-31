/**
 * @vitest-environment happy-dom
 *
 * x-markdown.safe: unsanitized HTML is only ever parsed inert (template), and
 * DOMPurify runs on its defaults, so x-* custom elements don't survive.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { marked } from 'marked'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
window.__manifestLoaderStarted = true
window.Alpine = Alpine
globalThis.marked = marked

const configs = []
window.DOMPurify = {
  sanitize: (html, config) => { configs.push(config); return '<p>clean</p>' },
}

const liveParses = []
const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
Object.defineProperty(Element.prototype, 'innerHTML', {
  configurable: true,
  get() { return desc.get.call(this) },
  set(v) {
    if (!(this instanceof HTMLTemplateElement) && String(v).includes('onerror')) liveParses.push(String(v))
    desc.set.call(this, v)
  },
})

const settle = () => new Promise((r) => setTimeout(r, 30))

beforeAll(async () => {
  const src = readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'manifest.markdown.js'), 'utf8')
  new Function(src)()
  Alpine.start()
})

describe('x-markdown.safe', () => {
  it('never parses unsanitized markup into a live element, and sanitizes on defaults', async () => {
    window.D = {
      md: `- [ ] <img src="x" onerror="hit()"> task\n\n::: info\nhi <img src="z" onerror="hit()">\n\nmore\n:::\n\n<x-foo x-init="hit()">c</x-foo>`,
    }
    const host = document.createElement('div')
    host.innerHTML = `<div x-data="D"><article x-markdown.safe="md"></article></div>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    await settle(); await settle()

    expect(host.querySelector('article').innerHTML).toContain('clean')
    expect(liveParses).toEqual([])
    expect(configs.length).toBeGreaterThan(0)
    for (const c of configs) expect(c?.CUSTOM_ELEMENT_HANDLING).toBeUndefined()
  })
})
