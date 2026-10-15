/**
 * @vitest-environment happy-dom
 *
 * A fetched component that uses an on-use plugin (x-rich-text, $rich, …) waits
 * for that plugin before it is inserted and initialised.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUB = (f) => readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'components', f), 'utf8')

const served = {
  '/components/editor.html': '<section class="editor"><div x-rich-text.html="body"></div></section>',
  '/components/plain.html': '<section class="plain">Plain</section>',
}
globalThis.fetch = async (url) => {
  const body = served[String(url).split('?')[0]]
  return { ok: body !== undefined, status: body !== undefined ? 200 : 404, text: async () => body ?? '' }
}

let calls, release
beforeAll(() => {
  window.__manifestLoaded = { components: [] }
  new Function(SUB('manifest.components.registry.js'))()
  new Function(SUB('manifest.components.loader.js'))()
  new Function(SUB('manifest.components.processor.js'))()
})

beforeEach(async () => {
  calls = []
  window.Manifest = {
    loadUsed: (html) => {
      calls.push(html)
      return new Promise(r => { release = r })
    }
  }
  document.body.innerHTML = ''
  await window.ManifestComponentsRegistry.initialize()
  window.ManifestComponentsLoader.initialize()
})

describe('components and on-use plugins', () => {
  it('awaits Manifest.loadUsed before the component is inserted', async () => {
    const el = document.createElement('x-editor')
    document.body.appendChild(el)
    const done = window.ManifestComponentsProcessor.processComponent(el)
    await new Promise(r => setTimeout(r, 10))
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('x-rich-text')
    expect(document.body.innerHTML).not.toContain('class="editor"')
    release([])
    await done
    expect(document.body.innerHTML).toContain('class="editor"')
  })

  it('still renders when the loader is absent', async () => {
    delete window.Manifest
    const el = document.createElement('x-plain')
    document.body.appendChild(el)
    await window.ManifestComponentsProcessor.processComponent(el)
    expect(document.body.innerHTML).toContain('Plain')
  })
})
