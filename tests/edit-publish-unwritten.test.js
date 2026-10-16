/**
 * @vitest-environment happy-dom
 *
 * Publishing what mnfst-run writes elsewhere, or not at all, against the real server:
 * global theme values go to the theme stylesheet index.html links; a scoped value goes
 * to its scope element's inline style (never :root) - with its area's tree, or found by its
 * own x-edit.theme name - and inside generated content is refused by name; a list
 * mnfst-run can't write is refused by name, its edits kept; a failing theme value fails
 * only itself.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Alpine from 'alpinejs'
import { bootLivePage } from './helpers/edit-live-page.js'

const THEME = `:root {\n    --color-brand: blue;\n    --color-brand-surface: gray;\n}\n`
const BODY = `<link rel="stylesheet" href="/manifest.theme.css">
<section x-edit="pg"><h1>Title</h1><div x-edit.theme="card" class="card" style="--color-brand-surface: white"><p>Card</p></div></section>
<div x-edit.theme="loose" class="loose"><p>Loose</p></div>
<div x-data="{ pets: [{ id: 1, name: 'Rex' }, { id: 2, name: 'Fido' }] }"><ul x-edit.data="pets"><template x-for="pet in pets" :key="pet.id"><li x-text="pet.name"></li></template></ul></div>
<input x-edit.cssvar="--color-brand" id="brand" value="blue">
<input x-edit.cssvar="card:--color-brand-surface" id="surface" value="white">
<input x-edit.cssvar="loose:--color-brand-surface" id="loose" value="gray">
<div x-data="{ h: '<div x-edit.theme=&quot;gen&quot; style=&quot;--color-brand-surface: tan&quot;><p>Gen</p></div>' }" x-html="h"></div>
<input x-edit.cssvar="gen:--color-brand-surface" id="gen" value="tan">`

let live, warn
const said = []
beforeAll(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { said.push(String(a[0])) })
    live = await bootLivePage(BODY, {}, { files: { 'manifest.theme.css': THEME } })
}, 15000)
afterAll(() => { warn.mockRestore(); live && live.stop() })

const store = () => Alpine.store('edit')
const flush = () => new Promise(r => setTimeout(r, 0))
const setVar = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')) }
const by = (r) => Object.fromEntries(r.results.map(x => [x.region, x]))

describe('theme values', () => {
    it('global: the linked theme stylesheet; scoped: the scope element\'s inline style, never :root', async () => {
        setVar('brand', 'red')
        setVar('surface', 'rgb(1, 2, 3)')
        await flush()
        expect(document.querySelector('.card').style.getPropertyValue('--color-brand-surface')).toBe('rgb(1, 2, 3)')
        const patches = store().patches()
        expect(patches.filter(p => p.kind === 'theme').map(p => p.var)).toEqual(['--color-brand'])   // the scoped one rides the area's tree
        const r = await store().publish()
        expect(r.results.every(x => x.status === 'written'), JSON.stringify(r.results)).toBe(true)
        expect(live.src('manifest.theme.css')).toBe(THEME.replace('--color-brand: blue', '--color-brand: red'))
        expect(live.src()).toContain('<div x-edit.theme="card" class="card" style="--color-brand-surface: rgb(1, 2, 3);"><p>Card</p></div>')
        expect(store().canUndo).toBe(false)
    })

    it('a scope element outside any area is written by its own name, in its inline style', async () => {
        setVar('loose', 'pink')
        await flush()
        expect(store().patches()).toContainEqual({ kind: 'static-tree', region: 'loose', tree: { key: '', edits: { style: '--color-brand-surface: pink;' } } })
        const r = await store().publish()
        expect(by(r).loose.status, JSON.stringify(r.results)).toBe('written')
        expect(live.src()).toContain('<div x-edit.theme="loose" class="loose" style="--color-brand-surface: pink;"><p>Loose</p></div>')
        expect(live.src('manifest.theme.css')).not.toContain('pink')
    })

    it('a scope element in generated content is refused by name; it fails only itself and its value stays', async () => {
        expect(document.querySelector('[x-edit\\.theme="gen"]')).toBeTruthy()
        setVar('gen', 'olive')
        const h1 = document.querySelector('h1')
        h1.dispatchEvent(new Event('focus')); h1.innerHTML = 'Title page'; h1.dispatchEvent(new Event('blur'))
        await flush()
        const r = await store().publish()
        const res = by(r)
        expect(res.pg.status).toBe('written')
        expect(res['gen:--color-brand-surface'].status).toBe('error')
        expect(res['gen:--color-brand-surface'].reason).toContain('generated content')
        expect(live.src()).toContain('<h1>Title page</h1>')
        expect(live.src('manifest.theme.css')).not.toContain('olive')
        expect(store().export().log.map(d => d.kind)).toEqual(['theme'])          // its edit stays
        expect(store().canUndo).toBe(true)
        await store().undo()
    })
})

describe('a list mnfst-run cannot write', () => {
    it('is refused by name, warned once; its edits stay and do not clear history', async () => {
        const li = document.querySelector('li')
        expect(li.textContent).toBe('Rex')
        li.dispatchEvent(new Event('focus')); li.textContent = 'Rexie'; li.dispatchEvent(new Event('blur'))
        await flush()
        expect(store().patches().some(p => p.kind === 'data-val' && p.region === 'pets')).toBe(true)
        const r = await store().publish()
        expect(by(r).pets.status).toBe('error')
        expect(by(r).pets.reason).toBe('x-edit="pets": inline x-data list: mnfst-run writes data only to CSV/JSON/YAML sources declared in manifest.json')
        expect(store().canUndo).toBe(true)
        expect(store().patches().length).toBeGreaterThan(0)
        expect(said.filter(s => /x-edit="pets": inline x-data list/.test(s)).length).toBe(1)
    })
})
