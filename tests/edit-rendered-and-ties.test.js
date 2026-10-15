/**
 * @vitest-environment happy-dom
 *
 * An x-edit inside content a plugin generates (x-markdown output, x-html) is a region: it
 * edits, undoes and persists on the page, and onPublish receives it, but mnfst-run
 * cannot write it, so a publish there refuses it by name while the others write. One
 * inside a host that keeps its authored children (x-code-group) publishes as usual.
 * Mirrors the docs: a demo region in an x-code-group in x-markdown output.
 * Regions a move ties to a failed region are held back with it, each named.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'
import { bootLivePage } from './helpers/edit-live-page.js'

const TAIL = `<div x-code-group><div name="Preview"><section x-edit="authored"><p>One</p><p>Two</p></section></div><pre name="HTML"><code>x</code></pre></div>
<section x-edit="tx"><p>Mover</p><p>Stay</p></section>
<section x-edit="ty"><p>Y one</p></section>
<section x-edit="tz"><p>Zed</p></section>`
// In the source the article is empty (its markdown comes from a .md file); on the page it holds the output
const SOURCE = `<article x-markdown="$x.docs.page"></article>\n` + TAIL
const DEMO = `<h2>Doc</h2><div x-code-group><div name="Preview"><section x-edit.persist="demo"><p>Alpha</p><p>Beta</p></section></div><pre name="HTML"><code>y</code></pre></div>`
const DOM = `<article x-markdown="$x.docs.page">${DEMO}</article>\n` + TAIL

let live, warn
const said = []
beforeAll(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { said.push(String(a[0])) })
    live = await bootLivePage(SOURCE, {}, { dom: DOM })
}, 15000)
afterAll(() => { warn.mockRestore(); live && live.stop() })

const store = () => Alpine.store('edit')
const flush = () => new Promise(r => setTimeout(r, 0))
const sec = (k) => document.querySelector(`[x-edit="${k}"], [x-edit\\.persist="${k}"]`)
const editText = (el, v) => { el.dispatchEvent(new Event('focus')); el.innerHTML = v; el.dispatchEvent(new Event('blur')) }

describe('an x-edit inside generated content', () => {
    it('is a region: editable, undoable, persisted; warned once that mnfst-run cannot write it', async () => {
        const demo = sec('demo'), [a, b] = demo.querySelectorAll('p')
        expect(demo.hasAttribute('data-edit-area')).toBe(true)
        expect(a.getAttribute('contenteditable')).toBe('true')
        for (const action of ['text', 'move', 'remove', 'duplicate', 'attrs']) expect(store().can(action, a), action).toBe(true)
        editText(a, 'Alpha page')
        store().move(b, demo, a)
        await flush()
        expect([...demo.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Beta', 'Alpha page'])
        await store().undo()
        expect([...demo.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Alpha page', 'Beta'])
        await store().redo()
        expect([...demo.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Beta', 'Alpha page'])
        expect(JSON.parse(localStorage.getItem('mnfst-edit-log:' + location.pathname)).log.length).toBe(2)
        expect(store().patches().map(p => p.region)).toContain('demo')
        expect(said.filter(s => /x-edit="demo" is inside content x-markdown renders/.test(s)).length).toBe(1)
        // the authored region in a code group is editable too
        expect(sec('authored').querySelector('p').getAttribute('contenteditable')).toBe('true')
    })

    it('onPublish handlers receive its patch', async () => {
        let got = null
        store().onPublish = (patches) => { got = patches; return { results: patches.map(p => ({ region: p.region, status: 'error', reason: 'held for the test' })) } }
        await store().publish()
        store().onPublish = null
        expect(got.map(p => p.region)).toContain('demo')
        expect(got.find(p => p.region === 'demo').tree.children.length).toBe(2)
    })

    it('mnfst-run refuses it by name; the others write; its edits stay', async () => {
        editText(sec('authored').querySelector('p'), 'One page')
        await flush()
        const r = await store().publish()
        const by = Object.fromEntries(r.results.map(x => [x.region, x]))
        expect(by.demo.status).toBe('error')
        expect(by.demo.reason).toBe(`x-edit="demo" is inside content x-markdown renders, so mnfst-run can't write it to a source file`)
        expect(by.authored.status).toBe('written')
        expect(live.src()).toContain('<section x-edit="authored"><p>One page</p><p>Two</p></section>')
        expect(store().export().log.every(d => d.region === 'demo')).toBe(true)
        expect(store().export().log.length).toBe(2)
    })

    it('its persisted edits come back after a reload', async () => {
        document.body.innerHTML = ''
        new Function(EDIT_SRC)()
        await flush()
        const root = document.createElement('div')
        root.setAttribute('x-data', '')
        root.innerHTML = DOM.replace('<p>One</p>', '<p>One page</p>')
        Alpine.mutateDom(() => document.body.appendChild(root))
        Alpine.initTree(root)
        await new Promise(r => setTimeout(r, 700))
        expect([...sec('demo').querySelectorAll('p')].map(p => p.textContent)).toEqual(['Beta', 'Alpha page'])
    })
})

describe('regions a move ties to a failed region', () => {
    it('are held back with it, each named, saying why; the rest publish', async () => {
        const [mover] = sec('tx').querySelectorAll('p')
        store().move(mover, sec('ty'), null)
        const z = sec('tz').querySelector('p')
        z.dispatchEvent(new Event('focus')); z.innerHTML = 'Zed page'; z.dispatchEvent(new Event('blur'))
        await flush()
        live.setSrc(live.src().replace('<p>Y one</p>', '<p>Y one</p><p>Y external</p>'))   // ty changed elsewhere
        const r = await store().publish({ rebase: true })
        const by = Object.fromEntries(r.results.map(x => [x.region, x]))
        expect(by.tz.status).toBe('written')
        expect(by.ty.status).toBe('error')
        expect(by.ty.reason).toContain('changed since this page loaded')
        expect(by.tx.status).toBe('error')
        expect(by.tx.reason).toBe('not published: tied by a move to x-edit="ty", which failed')
        expect(live.src()).toContain('<section x-edit="tz"><p>Zed page</p></section>')
        expect(live.src()).toContain('<section x-edit="tx"><p>Mover</p><p>Stay</p></section>')
        expect(store().export().log.filter(d => d.kind === 'st-move')).toHaveLength(1)
    })
})
