/**
 * @vitest-environment happy-dom
 *
 * Components convention fallback: an <x-name> tag with no manifest.json entry
 * resolves to components/<name>.html — no registration, no dev-server restart.
 * A miss leaves the element alone (it may be someone else's custom element)
 * and is fetched only once.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUB = (f) => readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'components', f), 'utf8')

const served = {
  '/components/listed.html': '<div class="listed">Listed</div>',
  '/components/hello.html': '<section class="hello">Hello from convention</section>',
}
let fetchCount
globalThis.fetch = async (url) => {
  const pathname = String(url).split('?')[0]
  fetchCount[pathname] = (fetchCount[pathname] || 0) + 1
  const body = served[pathname]
  return { ok: body !== undefined, status: body !== undefined ? 200 : 404, text: async () => body ?? '' }
}

beforeAll(() => {
  window.__manifestLoaded = { components: ['components/listed.html'] }
  new Function(SUB('manifest.components.registry.js'))()
  new Function(SUB('manifest.components.loader.js'))()
  new Function(SUB('manifest.components.processor.js'))()
})

beforeEach(async () => {
  fetchCount = {}
  document.body.innerHTML = ''
  await window.ManifestComponentsRegistry.initialize()
  window.ManifestComponentsLoader.initialize()
})

async function process(tag) {
  const el = document.createElement(tag)
  document.body.appendChild(el)
  await window.ManifestComponentsProcessor.processComponent(el)
  return el
}

describe('components convention fallback', () => {
  it('renders an unregistered <x-hello> from components/hello.html', async () => {
    await process('x-hello')
    expect(document.body.innerHTML).toContain('Hello from convention')
    expect(window.ManifestComponentsRegistry.registered.has('hello')).toBe(true)
  })

  it('still renders manifest-listed components', async () => {
    await process('x-listed')
    expect(document.body.innerHTML).toContain('Listed')
  })

  it('leaves an unknown tag in place and fetches its convention path only once', async () => {
    const el = await process('x-nope')
    expect(document.contains(el)).toBe(true)
    await process('x-nope')
    expect(fetchCount['/components/nope.html']).toBe(1)
  })

  it('never fetches framework tags like <x-code>', async () => {
    await process('x-code')
    await process('x-code-group')
    expect(Object.keys(fetchCount)).toEqual([])
  })
})
