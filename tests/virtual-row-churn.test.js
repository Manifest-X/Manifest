/**
 * @vitest-environment happy-dom
 *
 * x-virtual leaves rows that stay in the window where they are. Re-inserting them on every
 * render woke every MutationObserver on the page and dropped focus inside them.
 */
import { readFileSync } from 'fs'
import { it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const frame = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 20)) }

window.Alpine = Alpine
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

let g, data
beforeAll(async () => {
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(readFileSync(path.join(dir, '../src/scripts/manifest.virtual.js'), 'utf8')))
    window.ensureVirtualPluginInitialized()
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 40 } })
    document.body.innerHTML = `<main id=m x-data="{ rows: Array.from({length:200},(_,i)=>({id:'r'+i})) }"><div id=g x-virtual="{estimate:40,overscan:1}" style="overflow:auto"><template x-for="row in rows" :key="row.id"><div class=r x-text="row.id"></div></template></div></main>`
    g = document.getElementById('g')
    Object.defineProperty(g, 'clientHeight', { configurable: true, get() { return 200 } })
    Alpine.start()
    await frame()
    data = Alpine.$data(document.getElementById('m'))
})

const ids = () => [...g.querySelectorAll('.r')].map(e => e.textContent)

it('moves only the rows entering and leaving the window', async () => {
    g.scrollTop = 0
    g.dispatchEvent(new Event('scroll'))
    await frame()
    const before = ids()
    expect(before.length).toBeGreaterThan(3)
    const added = [], removed = []
    const o = new MutationObserver(ms => { for (const m of ms) { added.push(...[...m.addedNodes].filter(n => n.classList?.contains('r'))); removed.push(...[...m.removedNodes].filter(n => n.classList?.contains('r'))) } })
    o.observe(g, { childList: true, subtree: true })
    g.scrollTop = 80
    g.dispatchEvent(new Event('scroll'))
    await frame()
    o.disconnect()
    const after = ids()
    const stayed = before.filter(k => after.includes(k))
    expect(stayed.length).toBeGreaterThan(0)
    expect(removed.map(n => n.textContent).filter(k => stayed.includes(k))).toEqual([])
    expect(added.map(n => n.textContent).filter(k => stayed.includes(k))).toEqual([])
})

it('still reorders rows to match the data', async () => {
    data.rows = data.rows.slice().reverse()
    await frame()
    g.dispatchEvent(new Event('scroll'))
    await frame()
    const shown = ids()
    const i = data.rows.findIndex(r => r.id === shown[0])
    expect(shown).toEqual(data.rows.slice(i, i + shown.length).map(r => r.id))
})

it('source guards the placement cursor against non-row nodes and detachment', () => {
    const src = readFileSync(path.join(dir, '../src/scripts/manifest.virtual.js'), 'utf8')
    expect(src).toMatch(/const nextRow = /)
    expect(src).toMatch(/if \(cursor\.parentNode !== host\) cursor = botSpacer;/)
    expect(src).toMatch(/if \(!destroyed\) render\(\)/)
})
