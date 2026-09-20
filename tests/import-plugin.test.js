/**
 * @vitest-environment happy-dom
 *
 * x-import / $import (shipped inside the export plugin): pick a local file,
 * parse json/csv, deliver via the manifest:import event and (optionally) a
 * data-source replace.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
window.Alpine = Alpine

const settle = () => new Promise((r) => setTimeout(r, 20))

// Feed the hidden file input the plugin appends for each pick.
async function providePickedFile(file) {
  await settle()
  const inputs = document.body.querySelectorAll('input[type="file"]')
  const input = inputs[inputs.length - 1]
  expect(input).toBeTruthy()
  Object.defineProperty(input, 'files', { value: file ? [file] : [], configurable: true })
  input.dispatchEvent(new Event('change'))
  await settle()
}

function makeFile(name, content, type) {
  const f = new File([content], name, { type })
  if (typeof f.text !== 'function') f.text = async () => content
  return f
}

const storeWrites = []
window.ManifestDataStore = {
  updateStore: (name, data, options) => storeWrites.push({ name, data, options }),
}

beforeAll(async () => {
  const src = readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'manifest.export.js'), 'utf8')
  new Function(src)()
  Alpine.start()
})

beforeEach(() => {
  storeWrites.length = 0
  document.body.innerHTML = ''
})

describe('x-import', () => {
  it('parses a picked JSON file, fires manifest:import, and replaces the named source', async () => {
    const events = []
    window.addEventListener('manifest:import', (e) => events.push(e.detail))

    const host = document.createElement('div')
    host.innerHTML = `<button x-data x-import="{ source: 'saves' }">Load</button>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    await settle()

    host.querySelector('button').click()
    await providePickedFile(makeFile('save.json', JSON.stringify({ tower: { floors: 12 } }), 'application/json'))

    expect(events).toHaveLength(1)
    expect(events[0].data).toEqual({ tower: { floors: 12 } })
    expect(events[0].format).toBe('json')
    expect(events[0].source).toBe('saves')
    expect(events[0].file.name).toBe('save.json')
    expect(storeWrites).toEqual([
      { name: 'saves', data: { tower: { floors: 12 } }, options: { loading: false, error: null, ready: true, fresh: true, allowDuringInit: true } },
    ])
  })

  it('parses CSV back into typed rows (quotes, embedded commas, JSON cells, numbers, booleans)', async () => {
    const events = []
    window.addEventListener('manifest:import', (e) => events.push(e.detail))

    const host = document.createElement('div')
    host.innerHTML = `<button x-data x-import.csv>Load</button>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    await settle()

    const csv = 'name,count,active,meta\n"Lobby, main",3,true,"{""kind"":""floor""}"\nCafé,0.5,false,null\n'
    host.querySelector('button').click()
    await providePickedFile(makeFile('rows.csv', csv, 'text/csv'))

    expect(events).toHaveLength(1)
    expect(events[0].format).toBe('csv')
    expect(events[0].data).toEqual([
      { name: 'Lobby, main', count: 3, active: true, meta: { kind: 'floor' } },
      { name: 'Café', count: 0.5, active: false, meta: null },
    ])
    expect(storeWrites).toHaveLength(0)
  })

  it('fires manifest:import-error on unparseable content and writes nothing', async () => {
    const errors = []
    window.addEventListener('manifest:import-error', (e) => errors.push(e.detail))

    const host = document.createElement('div')
    host.innerHTML = `<button x-data x-import="{ format: 'json', source: 'saves' }">Load</button>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    await settle()

    host.querySelector('button').click()
    await providePickedFile(makeFile('broken.json', '{ not json', 'application/json'))

    expect(errors).toHaveLength(1)
    expect(errors[0].format).toBe('json')
    expect(errors[0].error).toContain('broken.json')
    expect(storeWrites).toHaveLength(0)
  })

  it('infers csv format from the file extension when none is declared', async () => {
    const events = []
    window.addEventListener('manifest:import', (e) => events.push(e.detail))

    const host = document.createElement('div')
    host.innerHTML = `<button x-data x-import>Load</button>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    await settle()

    host.querySelector('button').click()
    await providePickedFile(makeFile('rows.csv', 'a;b\n1;2\n', 'text/csv'))

    expect(events).toHaveLength(1)
    expect(events[0].format).toBe('csv')
    expect(events[0].data).toEqual([{ a: 1, b: 2 }])
  })
})
