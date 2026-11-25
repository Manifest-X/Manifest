/**
 * @vitest-environment happy-dom
 *
 * x-markdown.headings keeps one window._manifestHeadings entry per element across re-renders
 * and drops it when the element is destroyed; without .headings no headings are extracted.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
window.__manifestLoaderStarted = true
window.Alpine = Alpine
globalThis.marked = {
    parse: (s) => s.split('\n').map(l => l.startsWith('# ') ? `<h1 id="${l.slice(2).toLowerCase()}">${l.slice(2)}</h1>` : `<p>${l}</p>`).join(''),
    use: () => {},
    Renderer: class {},
    setOptions: () => {},
}

const settle = () => new Promise((r) => setTimeout(r, 30))

beforeAll(async () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'scripts', 'manifest.markdown.js'), 'utf8')
    new Function(src)()
    Alpine.start()
})

function mount(attr) {
    const host = document.createElement('div')
    host.innerHTML = `<div x-data="{ body: '# One' }"><article ${attr}="body"></article></div>`
    document.body.appendChild(host)
    Alpine.initTree(host)
    return { host, el: host.querySelector('article'), scope: () => Alpine.$data(host.firstElementChild) }
}

describe('x-markdown.headings registry', () => {
    it('reuses one entry per element across renders and removes it on destroy', async () => {
        const before = Object.keys(window._manifestHeadings || {}).length
        const { host, el, scope } = mount('x-markdown.headings')
        await settle()
        const id = el.getAttribute('data-headings-section')
        expect(id).toBeTruthy()
        for (let i = 2; i <= 6; i++) {
            scope().body = `# Title ${i}\ntext`
            await settle()
        }
        expect(el.innerHTML).toContain('Title 6')
        expect(el.getAttribute('data-headings-section')).toBe(id)
        expect(Object.keys(window._manifestHeadings).length).toBe(before + 1)
        expect(window._manifestHeadings[id]).toEqual([{ id: 'title 6', text: 'Title 6', level: 1 }])

        Alpine.destroyTree(host)
        host.remove()
        expect(window._manifestHeadings[id]).toBeUndefined()
    })

    it('does not extract headings without the modifier', async () => {
        const spy = vi.spyOn(Element.prototype, 'querySelectorAll')
        const { el, scope } = mount('x-markdown')
        await settle()
        scope().body = '# Two'
        await settle()
        expect(el.innerHTML).toContain('Two')
        expect(spy.mock.calls.filter(([sel]) => sel === 'h1, h2, h3').length).toBe(0)
        expect(el.hasAttribute('data-headings-section')).toBe(false)
        spy.mockRestore()
    })
})
