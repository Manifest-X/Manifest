/**
 * @vitest-environment happy-dom
 *
 * Edit API: modifiers and defaults, visuals and .bare, .persist, patches for every
 * area, nesting (drag, keyboard, undo), flow vs freeform drops, size snap/close
 * variables, and the $edit target / can / lock / classes / attr surface.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import postcss from 'postcss'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.edit.js'), 'utf8')
const CSS = path.join(__dirname, '../src/styles/elements/manifest.edit.css')

const flush = () => new Promise(r => setTimeout(r, 0))
let uid = 0
const id = (p) => `${p}-${++uid}`

beforeAll(async () => {
    new Function(SRC)()
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))
})

const store = () => Alpine.store('edit')
const last = () => { const { log, cursor } = store().export(); return log[cursor - 1] }
const LS = () => JSON.parse(localStorage.getItem('mnfst-edit-log:' + location.pathname))
const K = (region, key) => '@' + region + '@' + key
const treeOf = (region) => { const p = store().patches().find(x => x.kind === 'static-tree' && x.region === region); return p && p.tree }
const findNode = (node, key) => { if (!node) return null; if (node.key === key) return node; for (const c of node.children || []) { const f = findNode(c, key); if (f) return f } return null }

async function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    await flush(); await flush()
    return root
}
const key = (target, init) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(e)
    return e
}
const rect = (el, left, top, right, bottom) => {
    el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top })
}
function drag(item, x, y, under) {
    document.elementFromPoint = () => under
    item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x + 1, clientY: y }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
}
const editText = (el, value) => {
    el.dispatchEvent(new Event('focus'))
    el.innerHTML = value
    el.dispatchEvent(new Event('blur'))
}
const names = (el) => [...el.children].filter(c => !c.hasAttribute('data-edit-handle')).map(c => c.getAttribute('data-n') || c.textContent)

afterEach(() => {
    store().off()
    document.body.innerHTML = ''
    localStorage.clear()
    delete document.elementFromPoint
    store().target = null
})

describe('modifiers and defaults', () => {
    it('no capability modifier = text + move', async () => {
        const root = await mount(`<section x-edit="${id('def')}"><p>Alpha</p><p>Beta</p></section>`)
        const p = root.querySelector('p')
        expect(p.getAttribute('contenteditable')).toBe('true')
        expect(p.hasAttribute('data-edit-piece')).toBe(true)
        expect(root.querySelector('section').hasAttribute('data-edit-handle')).toBe(false)
    })

    it('.text alone has no pieces; .move alone has no text', async () => {
        const root = await mount(`
            <section x-edit.text="${id('t')}"><p>Alpha</p></section>
            <section x-edit.move="${id('m')}"><p>Beta</p></section>`)
        const [t, m] = root.querySelectorAll('p')
        expect(t.getAttribute('contenteditable')).toBe('true')
        expect(t.hasAttribute('data-edit-piece')).toBe(false)
        expect(m.hasAttribute('contenteditable')).toBe(false)
        expect(m.hasAttribute('data-edit-piece')).toBe(true)
    })

    it('retired modifiers warn and are ignored (no alias)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        const root = await mount(`<section x-edit.sort.authoring.style="${id('old')}"><p>Alpha</p></section>`)
        const said = warn.mock.calls.map(c => String(c[0])).join('\n')
        warn.mockRestore()
        expect(said).toContain('x-edit.sort was removed')
        expect(said).toContain('x-edit.authoring was removed')
        expect(said).toContain('x-edit.style was removed')
        const area = root.querySelector('section')
        expect([...area._edit.caps].sort()).toEqual(['move', 'text'])
    })
})

describe('visuals and .bare', () => {
    it('every area carries the area attribute; .bare marks it bare', async () => {
        const root = await mount(`
            <section x-edit="${id('vis')}"><p>Alpha</p></section>
            <section x-edit.bare="${id('bare')}"><p>Beta</p></section>`)
        const [a, b] = root.querySelectorAll('section')
        expect(a.getAttribute('data-edit-area')).toBe('')
        expect(b.getAttribute('data-edit-area')).toBe('bare')
        expect(b.querySelector('p').hasAttribute('data-edit-piece')).toBe(true)     // still editable
        expect(b.querySelector('p').getAttribute('contenteditable')).toBe('true')
    })

    it('draws no toolbar, menu or retired attributes', async () => {
        const root = await mount(`<section x-edit="${id('none')}"><p>Alpha</p></section>`)
        const p = root.querySelector('p')
        editText(p, 'Edited')
        const attrs = [...document.querySelectorAll('*')].flatMap(el => [...el.attributes].map(a => a.name)).filter(n => n.startsWith('data-edit-'))
        expect(new Set(attrs)).toEqual(new Set(['data-edit-area', 'data-edit-key', 'data-edit-piece']))
        expect(document.querySelector('[data-edit-toolbar], [data-edit-menu]')).toBeNull()
        expect(document.documentElement.hasAttribute('data-edit-active')).toBe(false)
    })

    it('every drawing rule excludes bare areas (outlines, shadows, min-heights)', () => {
        const visual = []
        postcss.parse(readFileSync(CSS, 'utf8')).walkRules(r => {
            if (r.parent.type === 'rule') return
            if (r.nodes.some(d => d.type === 'decl' && ['outline', 'box-shadow', 'min-height'].includes(d.prop))) visual.push(r.selector)
        })
        expect(visual.length).toBeGreaterThan(6)
        visual.forEach(sel => expect(sel).toContain('bare'))
    })

    it('size handles take touch input', () => {
        let rule
        postcss.parse(readFileSync(CSS, 'utf8')).walkRules(r => { if (r.selector === ':where([data-edit-handle])') rule = r })
        expect(rule.nodes.find(d => d.prop === 'touch-action').value).toBe('none')
    })
})

describe('undo/redo state for author buttons', () => {
    it('canUndo / canRedo follow the log', async () => {
        const root = await mount(`<section x-edit="${id('btn')}"><p>One</p></section>`)
        editText(root.querySelector('p'), 'Two')
        expect(store().canUndo).toBe(true)
        expect(store().canRedo).toBe(false)
        await store().undo()
        expect(store().canRedo).toBe(true)
        await store().redo()
        expect(store().canRedo).toBe(false)
    })
})

describe('.persist', () => {
    it('only .persist areas reach localStorage', async () => {
        const root = await mount(`
            <section x-edit="${id('mem')}"><p>Alpha</p></section>
            <section x-edit.persist="keep-p"><p>Beta</p></section>`)
        const [a, b] = root.querySelectorAll('p')
        editText(a, 'Edited A')
        expect(LS()).toBeNull()
        editText(b, 'Edited B')
        const saved = LS()
        expect(saved.log.map(d => d.region)).toEqual(['keep-p'])
        expect(saved.cursor).toBe(1)
    })

    it('a reload restores .persist edits and drops the rest', async () => {
        const first = await mount(`
            <section x-edit="gone-r"><p>Alpha</p></section>
            <section x-edit.persist="kept-r"><p>Beta</p></section>`)
        const [a, b] = first.querySelectorAll('p')
        editText(a, 'Edited A')
        editText(b, 'Edited B')
        document.body.innerHTML = ''
        new Function(SRC)()
        await flush()
        const fresh = await mount(`
            <section x-edit="gone-r"><p>Alpha</p></section>
            <section x-edit.persist="kept-r"><p>Beta</p></section>`)
        await new Promise(r => setTimeout(r, 500))
        const [a2, b2] = fresh.querySelectorAll('p')
        expect(a2.innerHTML).toBe('Alpha')
        expect(b2.innerHTML).toBe('Edited B')
    })
})

describe('patches cover every area', () => {
    it('a plain area (no .persist) publishes its edits', async () => {
        const region = id('plain')
        const root = await mount(`<section x-edit="${region}"><p>Alpha</p></section>`)
        editText(root.querySelector('p'), 'Edited')
        expect(findNode(treeOf(region), K(region, 'P:Alpha')).edits).toEqual({ text: 'Edited' })
    })

    it('every edit stays in memory', async () => {
        const root = await mount(`<section x-edit.move="${id('mem')}"><p>Alpha</p><p>Beta</p></section>`)
        const at = store().export().log.length
        key(root.querySelector('p'), { key: 'ArrowDown', altKey: true })
        expect(store().export().log.length).toBe(at + 1)
    })
})

describe('.move nesting', () => {
    async function page() {
        const region = id('nest')
        const root = await mount(`<section x-edit.move="${region}"><div data-n="card"><p>Inside</p></div><p>Loose</p><div data-n="empty"></div></section>`)
        const area = root.querySelector('section')
        const [card, loose, empty] = area.children
        rect(area, 0, 0, 400, 400); rect(card, 0, 0, 400, 100); rect(card.firstElementChild, 0, 10, 400, 40)
        rect(loose, 0, 100, 400, 140); rect(empty, 0, 140, 400, 240)
        return { region, area, card, loose, empty, inside: card.firstElementChild }
    }

    it('detects containers by rule: element children or empty non-text; text elements never', async () => {
        const { area, card, loose, empty, inside } = await page()
        expect([card, loose, empty, inside].every(el => el.hasAttribute('data-edit-piece'))).toBe(true)
        expect(store().move(loose, empty)).toBe(true)                 // empty div nests
        expect(loose.parentElement).toBe(empty)
        expect(store().move(card, inside)).toBe(false)                // own subtree
        const p2 = document.createElement('p'); p2.textContent = 'x'; area.appendChild(p2); await flush()
        expect(store().move(card, loose)).toBe(false)                 // a <p> is text, never a container
    })

    it('dropping in the middle band of a container nests; its edge inserts beside it', async () => {
        const { area, card, loose } = await page()
        drag(loose, 200, 50, card)                                     // middle of the card
        expect(loose.parentElement).toBe(card)
        expect(last()).toMatchObject({ kind: 'st-move', fromParent: '', toParent: card.getAttribute('data-edit-key') })
        await store().undo()
        expect(loose.parentElement).toBe(area)
        drag(loose, 200, 4, card)                                      // top edge band
        expect(loose.parentElement).toBe(area)
        expect(names(area)).toEqual(['Loose', 'card', 'empty'])
    })

    it('dragging out of a container un-nests', async () => {
        const { area, card, inside, empty } = await page()
        drag(inside, 200, 230, empty)                                  // bottom edge band of the empty div
        expect(inside.parentElement).toBe(area)
        expect(names(area)).toEqual(['card', 'Loose', 'empty', 'Inside'])
        expect(card.children.length).toBe(0)
    })

    it('nest and un-nest go through undo/redo', async () => {
        const { area, card, loose } = await page()
        expect(store().move(loose, card)).toBe(true)
        expect(store().move(card.querySelector('p'), area, loose)).toBe(true)   // Inside out, before Loose
        expect(names(card)).toEqual(['Loose'])
        await store().undo()
        expect(names(card)).toEqual(['Inside', 'Loose'])
        await store().undo()
        expect(names(card)).toEqual(['Inside'])
        expect(names(area)).toEqual(['card', 'Loose', 'empty'])
        await store().redo(); await store().redo()
        expect(names(card)).toEqual(['Loose'])
        expect(names(area)).toEqual(['card', 'empty', 'Inside'])        // Loose had left, so Inside went to the end
    })

    it('keyboard: Alt+Right nests into the previous container, Alt+Left un-nests, both undo', async () => {
        const { area, card, loose } = await page()
        loose.setAttribute('contenteditable', 'false')                 // not typing
        expect(key(loose, { key: 'ArrowRight', altKey: true }).defaultPrevented).toBe(true)
        expect(loose.parentElement).toBe(card)
        expect(names(card)).toEqual(['Inside', 'Loose'])
        key(loose, { key: 'ArrowLeft', altKey: true })
        expect(loose.parentElement).toBe(area)
        expect(loose.previousElementSibling).toBe(card)
        await store().undo()
        expect(loose.parentElement).toBe(card)
        await store().undo()
        expect(names(area)).toEqual(['card', 'Loose', 'empty'])
    })

    it('in text, Alt+Left/Right stay native; Escape leaves text with the piece focused', async () => {
        const root = await mount(`<section x-edit="${id('esc')}"><div><p>Inside</p></div><p>Loose</p></section>`)
        const card = root.querySelector('div'), loose = root.querySelector('section > p')
        expect(loose.getAttribute('contenteditable')).toBe('true')
        loose.focus()
        expect(key(loose, { key: 'ArrowRight', altKey: true }).defaultPrevented).toBe(false)
        expect(loose.parentElement).not.toBe(card)
        key(loose, { key: 'Escape' })
        expect(document.activeElement).toBe(loose)
        expect(loose.isContentEditable).toBe(false)
        expect(key(loose, { key: 'ArrowRight', altKey: true }).defaultPrevented).toBe(true)
        expect(loose.parentElement).toBe(card)
        key(loose, { key: 'Enter' })                                   // back into text
        expect(loose.getAttribute('contenteditable')).toBe('true')
    })

    it('Escape from a text leaf inside a piece focuses that piece', async () => {
        const root = await mount(`<section x-edit="${id('esc2')}"><div><h3>Title</h3></div><div></div></section>`)
        const [card] = root.querySelectorAll('section > div'), h3 = card.querySelector('h3')
        h3.focus()
        key(h3, { key: 'Escape' })
        expect(document.activeElement).toBe(h3)                        // h3 is itself a piece of the card
        expect(h3.isContentEditable).toBe(false)
    })

    it('remove and duplicate work inside a nested container, and undo restores identity', async () => {
        const { card, inside } = await page()
        const k = inside.getAttribute('data-edit-key')
        expect(store().duplicate(inside)).toBe(true)
        expect(names(card)).toEqual(['Inside', 'Inside'])
        expect(last()).toMatchObject({ kind: 'st-children', parent: card.getAttribute('data-edit-key') })
        await store().undo()
        expect(store().remove(inside)).toBe(true)
        expect(card.children.length).toBe(0)
        await store().undo()
        expect(card.firstElementChild.getAttribute('data-edit-key')).toBe(k)
        await store().redo()
        expect(card.children.length).toBe(0)
    })

    it('publishes nesting as a static-move with container keys plus nested orders', async () => {
        const { region, card, loose, inside, empty } = await page()
        store().move(loose, card)
        key(loose, { key: 'ArrowUp', altKey: true })                   // reorder inside the card
        const t = treeOf(region)
        expect(t.children.map(c => c.key)).toEqual([card, empty].map(e => e.getAttribute('data-edit-key')))
        expect(t.children[0].children.map(c => c.key)).toEqual([K(region, 'P:Loose'), inside.getAttribute('data-edit-key')])
    })

    it('.data lists reorder within their own list only', async () => {
        const root = await mount(`<div x-data="{ rows: [{ id: 'a', t: 'A' }, { id: 'b', t: 'B' }] }"><ul x-edit.move="${id('rows')}"><template x-for="r in rows" :key="r.id"><li x-text="r.t"></li></template></ul><div x-edit.move="${id('other')}"><div></div></div></div>`)
        await flush()
        const [a] = root.querySelectorAll('li')
        const other = root.querySelector('[data-edit-area] + [data-edit-area] > div') || root.querySelectorAll('[data-edit-area]')[1]
        expect(store().move(a, other)).toBe(false)
        expect(a.parentElement.tagName).toBe('UL')
    })
})

describe('grip for text pieces', () => {
    const gripEl = () => document.querySelector('[data-edit-grip]')
    const over = (el) => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    const shown = () => !!gripEl() && !gripEl().hidden

    it('hovering a text piece shows a grip at its inline-start edge, outside the area', async () => {
        const root = await mount(`<section x-edit="${id('grip')}"><p>Alpha</p><p>Beta</p></section>`)
        const area = root.querySelector('section'), [alpha] = area.querySelectorAll('p')
        rect(alpha, 40, 100, 400, 130)
        over(alpha)
        expect(shown()).toBe(true)
        expect(gripEl().parentElement).toBe(document.body)
        expect(gripEl().style.left).toBe('40px')
        expect(gripEl().style.top).toBe('100px')
        expect(area.contains(gripEl())).toBe(false)
    })

    it('mouse and touch drags on the grip move the piece', async () => {
        const root = await mount(`<section x-edit="${id('grip-d')}"><p>Alpha</p><p>Beta</p><p>Gamma</p></section>`)
        const area = root.querySelector('section'), [alpha, beta, gamma] = area.querySelectorAll('p')
        rect(alpha, 0, 0, 400, 50); rect(beta, 0, 50, 400, 100); rect(gamma, 0, 100, 400, 150)
        for (const pointerType of ['mouse', 'touch']) {
            over(alpha)
            const g = gripEl()
            document.elementFromPoint = () => gamma
            g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: -5, clientY: 10, button: 0, pointerType, pointerId: 7 }))
            document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: 100, clientY: 140, pointerType, pointerId: 7 }))
            expect(gripEl().hidden).toBe(true)
            document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 100, clientY: 140, pointerType, pointerId: 7 }))
            expect(area.lastElementChild).toBe(alpha)
            expect(last()).toMatchObject({ kind: 'st-order' })
            area.insertBefore(alpha, area.firstElementChild)   // reset for the next pointer type
        }
    })

    it('focusing a text piece shows the grip; blur hides it', async () => {
        const root = await mount(`<section x-edit="${id('grip-f')}"><p>Alpha</p></section>`)
        const p = root.querySelector('p')
        p.focus()
        expect(shown()).toBe(true)
        p.blur()
        expect(shown()).toBe(false)
    })

    it('non-text pieces get no grip and keep whole-element drag', async () => {
        const root = await mount(`<section x-edit="${id('grip-n')}"><div><p>Card</p></div><div><p>Other</p></div></section>`)
        const card = root.querySelector('div')
        over(card)
        expect(shown()).toBe(false)
        over(card.querySelector('p'))                                  // the text inside is its own piece
        expect(shown()).toBe(true)
    })

    it('.bare areas show no grip; move-only areas drag text whole', async () => {
        const root = await mount(`
            <section x-edit.bare="${id('grip-b')}"><p>Bare</p></section>
            <section x-edit.move="${id('grip-m')}"><p>Moves</p></section>`)
        const [bare, moves] = root.querySelectorAll('p')
        over(bare)
        expect(shown()).toBe(false)
        over(moves)
        expect(shown()).toBe(false)
    })

    it('the grip never reaches text, markup or patches', async () => {
        const region = id('grip-p')
        const root = await mount(`<section x-edit="${region}"><p>Alpha</p></section>`)
        const p = root.querySelector('p')
        over(p)
        editText(p, 'Edited')
        expect(store().copy(p)).toBe(true)
        expect(JSON.stringify(store().patches())).not.toContain('data-edit-grip')
        expect(JSON.stringify(store().export())).not.toContain('data-edit-grip')
        expect(root.innerHTML).not.toContain('data-edit-grip')
        expect(p.innerHTML).toBe('Edited')
    })
})

describe('identity', () => {
    it('duplicating a twin mints a unique key; undo/redo keep the copy', async () => {
        const region = id('twin')
        const root = await mount(`<section x-edit="${region}"><p>Same</p><p>Same</p><p>Other</p></section>`)
        const area = root.querySelector('section')
        const keys = () => [...area.children].map(c => c.getAttribute('data-edit-key'))
        store().duplicate(area.querySelector('p'))
        const after = keys()
        expect(new Set(after).size).toBe(4)
        expect(after[1]).toMatch(new RegExp('^~[a-z0-9]+~' + K(region, 'P:Same').replace(/[$^@]/g, '\\$&') + '$'))
        await store().undo()
        expect(keys()).toEqual([K(region, 'P:Same'), K(region, 'P:Same#2'), K(region, 'P:Other')])
        await store().redo()
        expect(keys()).toEqual(after)
        expect(names(area)).toEqual(['Same', 'Same', 'Same', 'Other'])
    })

    it('a lock follows its element across areas', async () => {
        const root = await mount(`
            <section x-edit="${id('la')}"><p>One</p><p>Two</p></section>
            <section x-edit="lb-x"><p>Three</p></section>`)
        const one = root.querySelector('p'), b = root.querySelectorAll('section')[1]
        store().lock(one, 'remove')
        expect(store().move(one, b)).toBe(true)
        expect(one.parentElement).toBe(b)
        expect(store().can('remove', one)).toBe(false)
        expect(store().can('remove', b.querySelector('p'))).toBe(true)
        await store().undo()
        expect(store().can('remove', one)).toBe(false)
    })

    it('x-text and x-if output stay out of identity, so keys match the source', async () => {
        const region = id('src')
        const root = await mount(`<div x-data="{ name: 'Alice', on: true }"><section x-edit="${region}"><template x-if="on"><p>Same</p></template><p>Same</p><div><span x-text="name"></span><p>Static</p></div></section></div>`)
        await flush()
        const ps = root.querySelectorAll('section > p')
        const generated = ps[0], authored = ps[1]
        expect(generated.hasAttribute('data-edit-key')).toBe(false)
        expect(authored.getAttribute('data-edit-key')).toBe(K(region, 'P:Same'))
        expect(root.querySelector('section > div').getAttribute('data-edit-key')).toBe(K(region, 'DIV:Static'))
    })
})

describe('source safety and scope', () => {
    it('script-loading attributes are refused; raw-text elements are never contenteditable', async () => {
        const root = await mount(`<section x-edit="${id('ld')}"><p>One</p><script type="text/plain">x</script><style>a{}</style><iframe src="/a"></iframe><link href="/a.css"><meta content="x"><form>f</form></section>`)
        const $ = (s) => root.querySelector(s)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        expect([
            store().attr('src', 'https://x.example/a.js', $('script')), store().attr('type', 'module', $('script')),
            store().attr('src', 'https://x.example/', $('iframe')), store().attr('href', '/b.css', $('link')), store().attr('rel', 'import', $('link')),
            store().attr('http-equiv', 'refresh', $('meta')), store().attr('action', '/x', $('form')), store().attr('formaction', '/x', $('p'))
        ]).toEqual([false, false, false, false, false, false, false, false])
        warn.mockRestore()
        expect($('script').hasAttribute('contenteditable')).toBe(false)
        expect($('style').hasAttribute('contenteditable')).toBe(false)
        expect(store().can('text', $('script'))).toBe(false)
    })

    it('a cssvar control without a --name logs nothing (so it can never block a publish)', async () => {
        const root = await mount(`<input x-edit.cssvar="badname" value="3">`)
        const at = store().export().log.length
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        root.querySelector('input').dispatchEvent(new Event('change'))
        warn.mockRestore()
        expect(store().export().log.length).toBe(at)
    })

    it('a piece copied from a list cannot be pasted into a static area', async () => {
        const root = await mount(`<div x-data="{ rows: [{ id: 'a', t: 'A' }] }"><ul x-edit="${id('dl')}"><template x-for="r in rows" :key="r.id"><li x-text="r.t"></li></template></ul><section x-edit="${id('st')}"><p>One</p></section></div>`)
        await flush()
        expect(store().copy(root.querySelector('li'))).toBe(true)
        const p = root.querySelector('section p')
        expect(store().can('paste', p)).toBe(false)
        expect(store().paste(p)).toBe(false)
        expect(root.querySelectorAll('section p').length).toBe(1)
    })

    it('the persisted log follows the page path; a route change saves the earlier page first', async () => {
        const root = await mount(`<section x-edit.persist="${id('rp')}"><p>One</p></section>`)
        const first = location.pathname
        editText(root.querySelector('p'), 'Uno')
        expect(localStorage.getItem('mnfst-edit-log:' + first)).toContain('Uno')
        history.pushState({}, '', '/other-page')
        window.dispatchEvent(new Event('manifest:route-change'))
        expect(localStorage.getItem('mnfst-edit-log:' + first)).toContain('Uno')
        editText(root.querySelector('p'), 'Eins')
        expect(localStorage.getItem('mnfst-edit-log:/other-page')).toContain('Eins')
        history.pushState({}, '', first)
        window.dispatchEvent(new Event('manifest:route-change'))
    })
})

describe('flow vs freeform after the drop', () => {
    async function board() {
        const root = await mount(`
            <style>.canvas > * { position: absolute; }</style>
            <section x-edit.move="${id('board')}">
                <ul class="list"><li data-n="one">One</li><li data-n="two">Two</li></ul>
                <div class="canvas"><div data-n="note" style="left: 10%; top: 20px">Note</div></div>
            </section>`)
        const area = root.querySelector('section'), list = area.querySelector('.list'), canvas = area.querySelector('.canvas')
        rect(area, 0, 0, 800, 800); rect(list, 0, 0, 800, 100); rect(canvas, 100, 200, 500, 600)
        list.querySelectorAll('li').forEach((li, i) => rect(li, 0, i * 50, 800, i * 50 + 50))
        return { area, list, canvas, note: canvas.firstElementChild, one: list.firstElementChild }
    }

    it('a piece dropped into an absolute layout lands at the drop point, in px', async () => {
        const { canvas, one } = await board()
        drag(one, 250, 400, canvas)
        expect(one.parentElement).toBe(canvas)
        expect(one.style.left).toBe('151px')                           // final pointer 251 − canvas left 100
        expect(one.style.top).toBe('200px')
        const { log, cursor } = store().export()
        expect(log[cursor - 1]).toMatchObject({ kind: 'st-node', prop: 'style', join: true })
        expect(log[cursor - 2].kind).toBe('st-move')
        await store().undo()                                           // one step: move + placement
        expect(one.parentElement.classList.contains('list')).toBe(true)
        expect(one.hasAttribute('style')).toBe(false)
    })

    it('keeps % units it already used', async () => {
        const { canvas, note } = await board()
        Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 400 })
        rect(note, 140, 220, 200, 260)
        note.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 140, clientY: 220, button: 0 }))
        document.elementFromPoint = () => canvas
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 300 }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
        expect(note.parentElement).toBe(canvas)
        expect(note.style.left).toBe('50%')                           // 200px of the 400px canvas
        expect(note.style.top).toBe('100px')
    })

    it('canvas → list takes DOM order and drops leftover left/top', async () => {
        const { list, note } = await board()
        const two = list.children[1]
        drag(note, 400, 90, two)
        expect(note.parentElement).toBe(list)
        expect(names(list)).toEqual(['one', 'two', 'note'])
        expect(note.style.left).toBe('')
        expect(note.style.top).toBe('')
    })
})

describe('size variables', () => {
    async function box(style, parentStyle = '', extra = '') {
        const root = await mount(`<div class="parent" style="${parentStyle}"><div x-edit.size="${id('sz')}" ${extra} style="${style}">Box</div></div>`)
        const el = root.querySelector('[x-edit\\.size]')
        return { root, el, handle: (pos) => el.querySelector(`[data-edit-handle="${pos}"]`) }
    }
    const pull = (h, dx, dy = 0) => {
        h.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: dx, clientY: dy }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    }

    it('snapping is off when unset', async () => {
        const { el, handle } = await box('width: 200px')
        pull(handle('right'), 37)
        expect(el.style.width).toBe('237px')
    })

    it('stops alone snap to the nearest stop; a distance limits the reach', async () => {
        const a = await box('width: 200px; --edit-size-snap: 300px 400px')
        pull(a.handle('right'), 37)
        expect(a.el.style.width).toBe('300px')
        const b = await box('width: 200px; --edit-size-snap: 300px 400px; --edit-size-snap-distance: 20px')
        pull(b.handle('right'), 37)
        expect(b.el.style.width).toBe('237px')
        pull(b.handle('right'), 90)                                    // 327 → within 20 of… no; 237+90=327
        expect(b.el.style.width).toBe('327px')
        pull(b.handle('right'), 65)                                    // 392 → 400
        expect(b.el.style.width).toBe('400px')
    })

    it('inherits project-level values; none cancels them', async () => {
        const inherited = await box('width: 200px', '--edit-size-snap: 300px')
        pull(inherited.handle('right'), 37)
        expect(inherited.el.style.width).toBe('300px')
        const cancelled = await box('width: 200px; --edit-size-snap: none', '--edit-size-snap: 300px')
        pull(cancelled.handle('right'), 37)
        expect(cancelled.el.style.width).toBe('237px')
    })

    it('close: below --edit-size-close an x-show element snaps to its minimum and hides', async () => {
        const root = await mount(`<div x-data="{ sidebar: true }"><aside x-show="sidebar" x-edit.size="${id('side')}" style="width: 300px; min-width: 120px; --edit-size: x; --edit-size-close: 100px">Side</aside></div>`)
        const aside = root.querySelector('aside'), host = root.firstElementChild
        pull(aside.querySelector('[data-edit-handle="right"]'), -250)   // raw 50px < 100px
        expect(aside.style.width).toBe('120px')
        expect(Alpine.$data(host).sidebar).toBe(false)
        const { log, cursor } = store().export()
        expect(log[cursor - 2]).toMatchObject({ kind: 'st-node', prop: 'style' })
        expect(log[cursor - 1]).toMatchObject({ kind: 'show', expr: 'sidebar', before: true, value: false, join: true })
    })

    it('one undo after a close restores the size and reopens; redo closes again', async () => {
        const root = await mount(`<div x-data="{ panel: { open: 'yes' } }"><aside x-show="panel.open" x-edit.size="${id('side4')}" style="width: 300px; min-width: 120px; --edit-size: x; --edit-size-close: 100px">Side</aside></div>`)
        const aside = root.querySelector('aside'), data = Alpine.$data(root.firstElementChild)
        const at = store().export().cursor
        pull(aside.querySelector('[data-edit-handle="right"]'), -250)
        expect(data.panel.open).toBe(false)
        expect(aside.style.width).toBe('120px')
        expect(store().export().cursor).toBe(at + 2)
        expect(last()).toMatchObject({ kind: 'show', expr: 'panel.open', before: 'yes', value: false, join: true })
        await store().undo()
        expect(store().export().cursor).toBe(at)
        expect(data.panel.open).toBe('yes')
        expect(aside.getAttribute('style')).toContain('width: 300px')
        await store().redo()
        expect(data.panel.open).toBe(false)
        expect(aside.getAttribute('style')).toContain('width: 120px')   // happy-dom's style object lags the attribute after x-show
        expect(store().export().cursor).toBe(at + 2)
    })

    it('a close is not persisted or published', async () => {
        const root = await mount(`<div x-data="{ open: true }"><aside x-show="open" x-edit.size.persist="side-p" style="width: 300px; --edit-size-close: 100px">Side</aside></div>`)
        pull(root.querySelector('[data-edit-handle="right"]'), -250)
        expect(LS().log.some(d => d.kind === 'show')).toBe(false)
        expect(store().patches().some(p => p.kind === 'show')).toBe(false)
    })

    it('close needs an assignable x-show: otherwise it warns once and leaves the size alone', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        const root = await mount(`<div x-data="{ shut: false, k() { return 'a' }, p: { a: true } }"><aside x-show="!shut" x-edit.size="${id('side2')}" style="width: 300px; --edit-size-close: 100px">A</aside><aside x-show="p[k()]" x-edit.size="${id('side2b')}" style="width: 300px; --edit-size-close: 100px">B</aside></div>`)
        const [a, b] = root.querySelectorAll('aside'), at = store().export().cursor
        pull(a.querySelector('[data-edit-handle="right"]'), -250)
        pull(a.querySelector('[data-edit-handle="right"]'), -250)
        pull(b.querySelector('[data-edit-handle="right"]'), -250)
        expect(warn.mock.calls.filter(c => String(c[0]).includes('assignable')).length).toBe(2)   // once per element
        warn.mockRestore()
        expect(a.getAttribute('style')).toContain('width: 300px')
        expect(b.getAttribute('style')).toContain('width: 300px')
        expect(Alpine.$data(root.firstElementChild).shut).toBe(false)
        expect(store().export().cursor).toBe(at)
    })

    it('close with no min-width keeps the pre-drag size, so it reopens sensibly', async () => {
        const root = await mount(`<div x-data="{ open: true }"><aside x-show="open" x-edit.size="${id('side5')}" style="width: 300px; --edit-size-close: 100px">Side</aside></div>`)
        const aside = root.querySelector('aside')
        pull(aside.querySelector('[data-edit-handle="right"]'), -250)
        expect(Alpine.$data(root.firstElementChild).open).toBe(false)
        expect(aside.getAttribute('style')).toContain('width: 300px')
        expect(last()).toMatchObject({ kind: 'show', value: false })
        expect(last().join).toBeUndefined()                            // no size change to join
    })

    it('an axis-specific none cancels the base value (snap, distance, close)', async () => {
        const snapX = await box('width: 200px; --edit-size-snap-x: none', '--edit-size-snap: 300px')
        pull(snapX.handle('right'), 37)
        expect(snapX.el.style.width).toBe('237px')
        const dist = await box('width: 200px; --edit-size-snap: 300px; --edit-size-snap-distance: 10px; --edit-size-snap-distance-x: none')
        pull(dist.handle('right'), 37)
        expect(dist.el.style.width).toBe('300px')                     // distance cancelled: always the nearest stop
        const root = await mount(`<div x-data="{ open: true }" style="--edit-size-close: 100px"><aside x-show="open" x-edit.size="${id('side6')}" style="width: 300px; --edit-size-close-x: none">S</aside></div>`)
        pull(root.querySelector('[data-edit-handle="right"]'), -250)
        expect(Alpine.$data(root.firstElementChild).open).toBe(true)
    })

    it('the plugin-applied position never reaches the log or the source', async () => {
        const region = id('pos')
        const { el, handle } = await box('width: 200px')
        expect(el.style.position).toBe('relative')
        pull(handle('right'), 20)
        expect(last()).toMatchObject({ kind: 'st-node', prop: 'style' })
        expect(last().value).not.toContain('position')
        expect(last().before).not.toContain('position')
        await store().undo()
        expect(el.style.position).toBe('relative')                    // handles stay anchored
    })

    it('a cancelled pointer restores the size and logs nothing', async () => {
        const { el, handle } = await box('width: 200px')
        const at = store().export().cursor
        handle('right').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 0 }))
        document.dispatchEvent(new Event('pointercancel'))
        expect(el.style.width).toBe('200px')
        expect(store().export().cursor).toBe(at)
    })

    it('keyboard bursts on two elements commit separately', async () => {
        const a = await box('width: 200px'), b = await box('width: 200px')
        const at = store().export().cursor
        a.handle('right').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        b.handle('right').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        await new Promise(r => setTimeout(r, 400))
        expect(store().export().cursor).toBe(at + 2)
    })

    it('no close variable: nothing hides', async () => {
        const root = await mount(`<div x-data="{ open: true }"><aside x-show="open" x-edit.size="${id('side3')}" style="width: 300px">Side</aside></div>`)
        pull(root.querySelector('[data-edit-handle="right"]'), -280)
        expect(Alpine.$data(root.firstElementChild).open).toBe(true)
    })
})

describe('$edit.target / can / lock', () => {
    it('right-click sets $edit.target to the nearest piece before any menu opens', async () => {
        const root = await mount(`<section x-edit="${id('ctx')}"><div><p>Card <b>bold</b></p></div></section>`)
        const b = root.querySelector('b'), p = root.querySelector('p')
        let seen = null
        root.querySelector('section').addEventListener('contextmenu', () => { seen = store().target })
        b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        expect(seen).toBe(p)
        expect(store().target).toBe(p)
    })

    it('actions default to $edit.target', async () => {
        const root = await mount(`<section x-edit="${id('def-t')}"><p>One</p><p>Two</p></section>`)
        const [one] = root.querySelectorAll('p')
        store().target = one
        expect(store().can('duplicate')).toBe(true)
        expect(store().duplicate()).toBe(true)
        expect(names(root.querySelector('section'))).toEqual(['One', 'One', 'Two'])
        store().target = one
        expect(store().remove()).toBe(true)
        expect(names(root.querySelector('section'))).toEqual(['One', 'Two'])
        expect(store().target).toBe(null)
    })

    it('can(): text only on editable leaves; attrs vs class', async () => {
        const root = await mount(`<div x-data="{ n: 'x' }"><section x-edit="${id('cx')}"><div><p>Leaf</p></div><span x-text="n"></span></section></div>`)
        const div = root.querySelector('section > div'), leaf = root.querySelector('p'), bound = root.querySelector('span')
        expect(store().can('text', leaf)).toBe(true)
        expect(store().can('text', div)).toBe(false)
        expect(store().can('text', bound)).toBe(false)
        expect(store().can('attrs', leaf)).toBe(true)
        expect(store().can('class', leaf)).toBe(true)
    })

    it('a long-press menu (no contextmenu event) still sets $edit.target', async () => {
        const root = await mount(`<section x-edit="${id('lp')}"><div><p>Card</p></div></section>`)
        const p = root.querySelector('p')
        p.dispatchEvent(new CustomEvent('dropdown:context', { bubbles: true }))
        expect(store().target).toBe(p)
    })

    it('can() follows capabilities', async () => {
        const root = await mount(`
            <section x-edit.text="${id('c-t')}"><p>Text</p></section>
            <section x-edit.move="${id('c-m')}"><p>Move</p></section>
            <div x-edit.size="${id('c-s')}">Size</div>`)
        const [t, m] = root.querySelectorAll('p'), s = root.querySelector('[x-edit\\.size]')
        expect(['move', 'remove', 'duplicate', 'text', 'attrs'].map(a => store().can(a, t))).toEqual([false, false, false, true, true])
        expect(['move', 'remove', 'duplicate', 'text', 'attrs'].map(a => store().can(a, m))).toEqual([true, true, true, false, true])
        expect(store().can('size', s)).toBe(true)
        expect(store().can('size', m)).toBe(false)
        expect(store().can('nonsense', m)).toBe(false)
    })

    it('declarative per-action locks: .lock.move blocks moving only; .lock blocks everything', async () => {
        const root = await mount(`<section x-edit="${id('dl')}"><div x-edit.lock.move><p>Pinned</p></div><div x-edit.lock><p>Frozen</p></div><p>Free</p></section>`)
        const [pinned, frozen] = root.querySelectorAll('div > p'), free = root.querySelectorAll('section > p')[0]
        expect(store().can('move', pinned)).toBe(false)
        expect(store().can('move', pinned.parentElement)).toBe(false)
        expect(store().can('text', pinned)).toBe(true)
        expect(pinned.getAttribute('contenteditable')).toBe('true')
        expect(['move', 'remove', 'text', 'attrs'].map(a => store().can(a, frozen))).toEqual([false, false, false, false])
        expect(frozen.hasAttribute('contenteditable')).toBe(false)
        expect(store().can('move', free)).toBe(true)
    })

    it('.lock.attrs blocks attribute and class changes', async () => {
        const root = await mount(`<section x-edit="${id('la')}"><p x-edit.lock.attrs>Locked</p></section>`)
        const p = root.querySelector('p')
        expect(store().can('attrs', p)).toBe(false)
        expect(store().classes.add('big', p)).toBe(false)
        expect(store().attr('title', 'x', p)).toBe(false)
        expect(p.hasAttribute('title')).toBe(false)
    })

    it('runtime lock/unlock are logged, undo, and persist with .persist', async () => {
        const root = await mount(`<section x-edit.persist="lock-rt"><p>One</p><p>Two</p></section>`)
        const one = root.querySelector('p')
        expect(store().lock(one, 'move')).toBe(true)
        expect(last()).toMatchObject({ kind: 'lock', region: 'lock-rt', key: K('lock-rt', 'P:One'), actions: ['move'], value: true })
        expect(store().can('move', one)).toBe(false)
        expect(one.hasAttribute('data-edit-piece')).toBe(false)
        expect(store().can('text', one)).toBe(true)
        expect(JSON.stringify(LS())).toContain('"lock"')
        await store().undo()
        expect(store().can('move', one)).toBe(true)
        expect(one.hasAttribute('data-edit-piece')).toBe(true)
        await store().redo()
        store().unlock(one)
        expect(store().can('move', one)).toBe(true)
        store().lock(one)
        expect(['move', 'remove', 'duplicate', 'text', 'attrs'].some(a => store().can(a, one))).toBe(false)
        expect(one.hasAttribute('contenteditable')).toBe(false)
    })

    it('runtime unlock lifts a declarative lock on the same element', async () => {
        const root = await mount(`<section x-edit="${id('ul')}"><p x-edit.lock.move>Pinned</p></section>`)
        const p = root.querySelector('p')
        expect(store().can('move', p)).toBe(false)
        store().unlock(p, 'move')
        expect(store().can('move', p)).toBe(true)
    })
})

describe('$edit.classes and $edit.attr', () => {
    it('add / remove / toggle / has record deltas that undo', async () => {
        const region = id('cls')
        const root = await mount(`<section x-edit="${region}"><p class="a">One</p></section>`)
        const p = root.querySelector('p')
        store().target = p
        expect(store().classes.add('b c')).toBe(true)
        expect(p.className).toBe('a b c')
        expect(store().classes.has('b')).toBe(true)
        expect(last()).toMatchObject({ kind: 'st-node', prop: 'class', before: 'a', value: 'a b c' })
        expect(store().classes.list()).toEqual(['a', 'b', 'c'])
        await store().undo()
        expect(p.className).toBe('a')
        expect(store().classes.toggle('a', p)).toBe(true)
        expect(p.hasAttribute('class')).toBe(false)
        expect(findNode(treeOf(region), K(region, 'P:One')).edits).toEqual({ class: null })
    })

    it('consecutive changes to the same attribute coalesce into one undo step', async () => {
        const root = await mount(`<section x-edit="${id('co')}"><p>One</p></section>`)
        const p = root.querySelector('p'), at = store().export().log.length
        store().classes.add('x', p)
        store().classes.add('y', p)
        expect(store().export().log.length).toBe(at + 1)
        expect(last()).toMatchObject({ before: '', value: 'x y' })
        store().classes.remove('x y', p)                               // back to the start: the delta goes away
        expect(store().export().log.length).toBe(at)
    })

    it('attr: value sets, true sets empty, null/false removes; each undoes', async () => {
        const root = await mount(`<section x-edit="${id('at')}"><a href="/a">Link</a></section>`)
        const a = root.querySelector('a')
        store().target = a
        expect(store().attr('title', 'Hello')).toBe(true)
        expect(store().attr('hidden', true)).toBe(true)
        expect(a.getAttribute('hidden')).toBe('')
        expect(store().attr('href', false)).toBe(true)
        expect(a.hasAttribute('href')).toBe(false)
        await store().undo()
        expect(a.getAttribute('href')).toBe('/a')
        await store().undo(); await store().undo()
        expect(a.hasAttribute('title')).toBe(false)
        expect(a.hasAttribute('hidden')).toBe(false)
    })

    it('guardrails refuse with a warning and no delta', async () => {
        const root = await mount(`<section x-edit="${id('gr')}"><a href="/a">Link</a><img src="/x.png"></section>`)
        const a = root.querySelector('a'), img = root.querySelector('img')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        const at = store().export().log.length
        const refused = [
            ['onclick', 'alert(1)', a], ['x-on:click', 'x', a], ['@click', 'x', a], [':title', 'x', a], ['data-edit-key', 'x', a],
            ['href', 'javascript:alert(1)', a], ['href', ' JaVaScRiPt:alert(1)', a], ['href', 'vbscript:x', a], ['href', 'data:text/html,x', a],
            ['src', 'data:text/html,x', img], ['action', 'javascript:x', a], ['formaction', 'javascript:x', a], ['xlink:href', 'javascript:x', a]
        ]
        refused.forEach(([n, v, el]) => expect(store().attr(n, v, el)).toBe(false))
        expect(warn).toHaveBeenCalledTimes(refused.length)
        warn.mockRestore()
        expect(store().export().log.length).toBe(at)
        expect(store().attr('src', 'data:image/png;base64,AAAA', img)).toBe(true)
        expect(store().attr('href', 'https://example.com', a)).toBe(true)
    })

    it('guardrails: script/data schemes in any value, data images only on img/source, SVG animation targets', async () => {
        const root = await mount(`<section x-edit="${id('gr2')}"><p>Text</p><img src="/a.png"><object>o</object><iframe></iframe><svg><set></set></svg></section>`)
        const p = root.querySelector('p'), img = root.querySelector('img'), obj = root.querySelector('object'), ifr = root.querySelector('iframe'), set = root.querySelector('set')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        expect(store().attr('data', 'data:text/html,<script>x</script>', obj)).toBe(false)
        expect(store().attr('src', 'data:image/svg+xml,<svg onload=x>', ifr)).toBe(false)
        expect(store().attr('src', 'data:image/svg+xml;base64,AAAA', img)).toBe(false)
        expect(store().attr('title', 'data:text/plain,x', p)).toBe(false)
        expect(store().attr('title', 'java\tscript:x', p)).toBe(false)
        expect(store().attr('title', '&#106;avascript:x', p)).toBe(false)
        expect(store().attr('style', 'background:url(javascript:x)', p)).toBe(false)
        expect(store().attr('attributeName', 'href', set)).toBe(false)
        expect(store().attr('to', 'x', set)).toBe(false)
        warn.mockRestore()
        expect(store().attr('srcset', 'data:image/webp;base64,AAAA 1x', img)).toBe(true)
        expect(store().attr('title', 'Learn javascript: the basics', p)).toBe(true)
    })

    it('text is sanitized with the URL policy: control chars and data: in hrefs are dropped', async () => {
        const root = await mount(`<section x-edit="${id('san')}"><p>Hello</p></section>`)
        const p = root.querySelector('p')
        editText(p, 'Hi <a href="java&#9;script:alert(1)">x</a> <a href="&#1;javascript:alert(2)">y</a> <a href="data:text/html,z">z</a> <a href="https://ok.test">ok</a>')
        expect(last().value).toBe('Hi <a>x</a> <a>y</a> <a>z</a> <a href="https://ok.test">ok</a>')
    })

    it(':class bound: only the static class is edited; the binding keeps its classes', async () => {
        const root = await mount(`<div x-data="{ on: true }"><section x-edit="${id('bc')}"><p class="base" :class="on && 'live'">One</p></section></div>`)
        const p = root.querySelector('p')
        // happy-dom confuses `class` with `:class`; emulate the browser's class attribute
        let cls = 'base live'
        const get = p.getAttribute.bind(p), set = p.setAttribute.bind(p)
        p.getAttribute = (n) => n === 'class' ? cls : get(n)
        p.setAttribute = (n, v) => { if (n === 'class') cls = v; else set(n, v) }
        store().classes.add('extra', p)
        expect(last()).toMatchObject({ prop: 'class', before: 'base', value: 'base extra' })
        expect(cls).toBe('base extra live')
        expect(store().classes.list(p)).toEqual(['base', 'extra'])
        await store().undo()
        expect(cls).toBe('base live')
    })

    it('a bound attribute warns that the binding wins', async () => {
        const root = await mount(`<div x-data="{ t: 'x' }"><section x-edit="${id('ba')}"><p :title="t">One</p></section></div>`)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { })
        expect(store().attr('title', 'y', root.querySelector('p'))).toBe(true)
        expect(warn.mock.calls.some(c => String(c[0]).includes('binding will override'))).toBe(true)
        warn.mockRestore()
    })

    it('attribute edits publish as static edits', async () => {
        const region = id('pub')
        const root = await mount(`<section x-edit="${region}"><p>One</p></section>`)
        store().attr('aria-label', 'First', root.querySelector('p'))
        expect(treeOf(region)).toEqual({ key: K(region, 'SECTION:One'), children: [{ key: K(region, 'P:One'), at: '0', edits: { 'aria-label': 'First' } }] })
    })
})
