/**
 * @vitest-environment happy-dom
 *
 * Vendored Tailwind engine, Manifest patch: incremental builds read only what changed instead of
 * every [class] in the document, and the engine records no performance timeline entries.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(dir, '../src/scripts/tailwind.v4.3.1.js'), 'utf8')
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms))
const css = () => [...document.head.querySelectorAll('style')].map(s => s.textContent).join('\n')

let mark
let scans
beforeAll(async () => {
    mark = vi.spyOn(performance, 'mark')
    document.body.innerHTML = '<div class="mt-[1px]"></div>'
    new Function(CODE)()
    for (let i = 0; i < 100 && !css().includes('1px'); i++) await wait()
    const qsa = document.querySelectorAll.bind(document)
    scans = 0
    document.querySelectorAll = (sel) => { if (sel === '[class]') scans++; return qsa(sel) }
})

describe('tailwind engine', () => {
    it('picks up the initial document', () => {
        expect(css()).toContain('1px')
    })

    it('builds classes on an added subtree without scanning the document', async () => {
        const a = document.createElement('section')
        a.innerHTML = '<div><b class="mt-[3px]"></b></div>'
        document.body.appendChild(a)
        await wait()
        expect(css()).toContain('3px')
        expect(scans).toBe(0)
    })

    it('builds a class set on an existing element', async () => {
        const p = document.createElement('p')
        document.body.appendChild(p)
        await wait()
        p.setAttribute('class', 'mt-[5px]')
        await wait()
        expect(css()).toContain('5px')
        expect(scans).toBe(0)
    })

    it('rebuilds everything on a new theme stylesheet, then keeps building', async () => {
        const s = document.createElement('style')
        s.setAttribute('type', 'text/tailwindcss')
        s.textContent = '@theme{--color-zzz:#123456}'
        document.head.appendChild(s)
        for (let i = 0; i < 100 && !scans; i++) await wait()
        await wait(100)
        expect(scans).toBeGreaterThan(0)
        expect(css()).toContain('3px')
        const d = document.createElement('p')
        d.className = 'bg-zzz'
        document.body.appendChild(d)
        await wait()
        expect(css()).toContain('bg-zzz')
    })

    it('records no marks', () => {
        expect(mark).not.toHaveBeenCalled()
    })
})
