/**
 * @vitest-environment happy-dom
 *
 * x-text guard: an effect re-run that yields the same string must not touch the
 * DOM. Alpine writes textContent on every run, which makes a 1s ticker over N
 * rows emit N mutations per second and keeps settle-based metrics from settling.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.bindings.js'), 'utf8')

beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    new Function(SRC)()
    Alpine.start()
})

function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    return root.firstElementChild
}

const records = (el, fn) => new Promise(async (resolve) => {
    let n = 0
    const mo = new MutationObserver((list) => { n += list.length })
    mo.observe(el, { childList: true, characterData: true, subtree: true })
    await fn()
    await Alpine.nextTick()
    await new Promise((r) => setTimeout(r, 0))
    mo.disconnect()
    resolve(n)
})

describe('x-text equality guard', () => {
    it('renders and updates like Alpine', async () => {
        const el = mount(`<div x-data="{ n: 1 }"><span x-text="'count ' + n"></span></div>`)
        expect(el.querySelector('span').textContent).toBe('count 1')
        Alpine.$data(el).n = 2
        await Alpine.nextTick()
        expect(el.querySelector('span').textContent).toBe('count 2')
    })

    it('skips the DOM write when the string is unchanged', async () => {
        const el = mount(`<div x-data="{ tick: 0, label: 'same' }"><span x-text="label + (tick, '')"></span></div>`)
        const span = el.querySelector('span')
        const data = Alpine.$data(el)
        const n = await records(span, async () => { data.tick++; await Alpine.nextTick(); data.tick++ })
        expect(span.textContent).toBe('same')
        expect(n).toBe(0)
    })

    it('still writes when the string changes', async () => {
        const el = mount(`<div x-data="{ v: 'a' }"><span x-text="v"></span></div>`)
        const span = el.querySelector('span')
        const n = await records(span, async () => { Alpine.$data(el).v = 'b' })
        expect(span.textContent).toBe('b')
        expect(n).toBeGreaterThan(0)
    })

    it('treats null and undefined as empty text', async () => {
        const el = mount(`<div x-data="{ v: null }"><span x-text="v">x</span></div>`)
        expect(el.querySelector('span').textContent).toBe('')
    })
})
