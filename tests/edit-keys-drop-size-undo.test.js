/**
 * @vitest-environment happy-dom
 *
 * Edit plugin input fixes:
 *   1. Space/Enter reach reorderable text rows; Alt+arrow moves a row one step.
 *   2. Cross-region drop lands within reach of a region (or inside its column).
 *   3. Resize resolves %/none min/max limits instead of reading "100%" as 100px.
 *   4. Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and Ctrl+Y drive Edit's history.
 *   5. Sortable rows get a hover outline in the UI scope.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import postcss from 'postcss'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.edit.js'), 'utf8')
const CSS = path.join(__dirname, '../src/styles/elements/manifest.edit.css')

const flush = () => new Promise(r => setTimeout(r, 0))

beforeAll(async () => {
    new Function(SRC)()
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 500))   // let the 450ms boot pass run
})

const store = () => Alpine.store('edit')

async function mount(html) {
    const root = document.createElement('div')
    root.innerHTML = html
    Alpine.mutateDom(() => document.body.appendChild(root))
    Alpine.initTree(root)
    await flush(); await flush()
    return root
}

const texts = (el) => [...el.children].filter(c => !c.hasAttribute('data-edit-handle')).map(c => c.textContent)
const key = (target, init) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(e)
    return e
}
const rect = (el, left, top, right, bottom) => {
    el.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top })
}

afterEach(() => {
    store().off()
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-edit-hotkeys')
    localStorage.clear()
    delete document.elementFromPoint
})

describe('reorderable text keeps Space/Enter; Alt+arrow moves rows', () => {
    it('Space and Enter in a text row reach the text instead of grabbing', async () => {
        const root = await mount(`<section x-edit="k-space"><p>Alpha</p><p>Beta</p></section>`)
        const p = root.querySelector('p')
        expect(p.hasAttribute('data-edit-sortable')).toBe(true)
        expect(p.getAttribute('contenteditable')).toBe('true')
        expect(key(p, { key: ' ' }).defaultPrevented).toBe(false)
        expect(key(p, { key: 'Enter' }).defaultPrevented).toBe(false)
        expect(p.hasAttribute('data-edit-grabbed')).toBe(false)
    })

    it('Space still grabs a row that is not itself text', async () => {
        const root = await mount(`<section x-edit="k-grab"><div><p>Alpha</p></div><div><p>Beta</p></div></section>`)
        const row = root.querySelector('section > div')
        expect(key(row, { key: ' ' }).defaultPrevented).toBe(true)
        expect(row.hasAttribute('data-edit-grabbed')).toBe(true)
        key(row, { key: 'Escape' })
    })

    it('Alt+ArrowDown/Up moves a text row one step, commits, and announces', async () => {
        const root = await mount(`<section x-edit="k-alt"><p>Alpha</p><p>Beta</p><p>Gamma</p></section>`)
        const a = root.querySelector('section'), alpha = a.querySelector('p')
        const before = store().export().cursor
        expect(key(alpha, { key: 'ArrowDown', altKey: true }).defaultPrevented).toBe(true)
        expect(texts(a)).toEqual(['Beta', 'Alpha', 'Gamma'])
        const { log, cursor } = store().export()
        expect(cursor - before).toBe(1)
        expect(log[cursor - 1].kind).toBe('st-order')
        expect(document.querySelector('[data-edit-live]').textContent).toBe('Moved to position 2 of 3')
        key(alpha, { key: 'ArrowUp', altKey: true })
        expect(texts(a)).toEqual(['Alpha', 'Beta', 'Gamma'])
    })

    it('Alt+Left/Right in a text row stay native word-jump', async () => {
        const root = await mount(`<section x-edit="k-word"><p>Alpha</p><p>Beta</p></section>`)
        const a = root.querySelector('section'), alpha = a.querySelector('p')
        const at = store().export().cursor
        expect(key(alpha, { key: 'ArrowRight', altKey: true }).defaultPrevented).toBe(false)
        expect(key(alpha.nextElementSibling, { key: 'ArrowLeft', altKey: true }).defaultPrevented).toBe(false)
        expect(texts(a)).toEqual(['Alpha', 'Beta'])
        expect(store().export().cursor).toBe(at)
    })

    it('Alt+Left/Right move a non-text row (horizontal rows)', async () => {
        const root = await mount(`<section x-edit="k-horiz" style="display:flex"><div><p>Alpha</p></div><div><p>Beta</p></div><div><p>Gamma</p></div></section>`)
        const a = root.querySelector('section'), row = a.querySelector('div')
        expect(key(row, { key: 'ArrowRight', altKey: true }).defaultPrevented).toBe(true)
        expect(texts(a)).toEqual(['Beta', 'Alpha', 'Gamma'])
        key(row, { key: 'ArrowLeft', altKey: true })
        expect(texts(a)).toEqual(['Alpha', 'Beta', 'Gamma'])
    })

    it('Alt+arrow keeps the row in the DOM, skips locked siblings, and stops at the ends', async () => {
        const root = await mount(`<section x-edit="k-lock"><p>Alpha</p><p x-edit.lock>Fixed</p><p>Beta</p></section>`)
        const a = root.querySelector('section'), alpha = a.querySelector('p')
        let detached = false
        new MutationObserver(recs => { if (recs.some(r => [...r.removedNodes].includes(alpha))) detached = true })
            .observe(a, { childList: true })
        key(alpha, { key: 'ArrowDown', altKey: true })
        await flush()
        expect(texts(a)).toEqual(['Beta', 'Fixed', 'Alpha'])
        expect(detached).toBe(false)
        const at = store().export().cursor
        key(alpha, { key: 'ArrowDown', altKey: true })
        expect(texts(a)).toEqual(['Beta', 'Fixed', 'Alpha'])
        expect(store().export().cursor).toBe(at)
    })

    it('Alt+Shift+arrow is left to text selection', async () => {
        const root = await mount(`<section x-edit="k-shift"><p>Alpha</p><p>Beta</p></section>`)
        const alpha = root.querySelector('p')
        expect(key(alpha, { key: 'ArrowDown', altKey: true, shiftKey: true }).defaultPrevented).toBe(false)
        expect(texts(root.querySelector('section'))).toEqual(['Alpha', 'Beta'])
    })
})

describe('cross-region drop reach', () => {
    async function columns(suffix, reach) {
        const root = await mount(`
            <div class="col-a"><section x-edit.authoring.sort="from-${suffix}"><p>Alpha</p><p>Beta</p></section></div>
            <div class="col-b"><section x-edit.authoring.sort="to-${suffix}"${reach ? ` style="--edit-drop-reach: ${reach}"` : ''}><p>Gamma</p></section></div>`)
        const [colA, colB] = root.querySelectorAll('div')
        const [a, b] = root.querySelectorAll('section')
        rect(colA, 0, 0, 200, 600); rect(a, 0, 0, 200, 100)
        rect(a.children[0], 0, 0, 200, 50); rect(a.children[1], 0, 50, 200, 100)
        rect(colB, 300, 0, 500, 120); rect(b, 300, 0, 500, 50); rect(b.children[0], 300, 0, 500, 50)
        return { root, colA, colB, a, b, alpha: a.children[0] }
    }
    function drag(item, x, y, under) {
        document.elementFromPoint = () => under
        item.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x + 1, clientY: y }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    }

    it('drops into a region when the pointer is just below it', async () => {
        const { colB, b, alpha } = await columns('near')
        drag(alpha, 400, 80, colB)                 // 30px under the region, over its column
        expect(alpha.parentElement).toBe(b)
        expect(texts(b)).toEqual(['Gamma', 'Alpha'])
    })

    it('accepts anywhere inside the column wrapping the region', async () => {
        const { colB, b, alpha } = await columns('col')
        rect(colB, 300, 0, 500, 600)
        drag(alpha, 400, 400, colB)
        expect(alpha.parentElement).toBe(b)
    })

    it('does nothing far from any region', async () => {
        const { a, alpha } = await columns('far')
        drag(alpha, 250, 900, document.body)
        expect(alpha.parentElement).toBe(a)
    })

    it('honours --edit-drop-reach', async () => {
        const near = await columns('reach-default')
        drag(near.alpha, 400, 130, document.body)  // 80px under: outside the column, beyond 48px
        expect(near.alpha.parentElement).toBe(near.a)
        document.body.innerHTML = ''
        const wide = await columns('reach-wide', '100px')
        drag(wide.alpha, 400, 130, document.body)
        expect(wide.alpha.parentElement).toBe(wide.b)
    })

    it('same-region drag still reorders in place', async () => {
        const { a, alpha } = await columns('same')
        drag(alpha, 100, 90, a.children[1])
        expect(alpha.parentElement).toBe(a)
        expect(texts(a)).toEqual(['Beta', 'Alpha'])
    })
})

describe('resize limits', () => {
    async function sizable(style, parentStyle = '') {
        const root = await mount(`<div class="parent" style="${parentStyle}"><div x-edit.size="sz-${Math.random().toString(36).slice(2)}" style="${style}">Box</div></div>`)
        const parent = root.querySelector('.parent'), el = parent.firstElementChild
        Object.defineProperty(parent, 'clientWidth', { configurable: true, value: 800 })
        Object.defineProperty(parent, 'clientHeight', { configurable: true, value: 600 })
        return { parent, el, handle: (pos) => el.querySelector(`[data-edit-handle="${pos}"]`) }
    }
    const dragHandle = (h, dx, dy) => {
        h.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: dx, clientY: dy }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    }

    it('keyboard: max-width 100% is the containing block, not 100px', async () => {
        const { el, handle } = await sizable('width: 200px; min-width: 50px; max-width: 100%')
        key(handle('right'), { key: 'ArrowRight' })
        expect(el.style.width).toBe('208px')
    })

    it('drag: max-width 100% does not clamp to 100px', async () => {
        const { el, handle } = await sizable('width: 200px; min-width: 50px; max-width: 100%')
        dragHandle(handle('right'), 150, 0)
        expect(el.style.width).toBe('350px')
    })

    it('percentages resolve against the parent content box', async () => {
        const { el, handle } = await sizable('width: 200px; max-width: 50%', 'padding: 0 20px')
        dragHandle(handle('right'), 400, 0)
        expect(el.style.width).toBe('380px')       // (800 - 40) * 50%
    })

    it('max-height 100% resolves against a definite (inline) parent height', async () => {
        const { el, handle } = await sizable('height: 100px; max-height: 100%; min-height: 20px', 'height: 600px')
        dragHandle(handle('bottom'), 0, 900)
        expect(el.style.height).toBe('600px')
    })

    it('% max-height/min-height under an auto-height parent mean no limit / 0', async () => {
        const { el, handle } = await sizable('height: 100px; max-height: 100%; min-height: 50%')
        dragHandle(handle('bottom'), 0, 900)
        expect(el.style.height).toBe('1000px')
        dragHandle(handle('bottom'), 0, -990)
        expect(el.style.height).toBe('10px')
    })

    it('reads the parent specified height through computedStyleMap when available', async () => {
        const auto = await sizable('height: 100px; max-height: 100%')
        auto.parent.computedStyleMap = () => ({ get: () => ({ toString: () => 'auto' }) })
        dragHandle(auto.handle('bottom'), 0, 900)
        expect(auto.el.style.height).toBe('1000px')
        document.body.innerHTML = ''
        const fixed = await sizable('height: 100px; max-height: 100%')
        fixed.parent.computedStyleMap = () => ({ get: () => ({ toString: () => '600px' }) })
        dragHandle(fixed.handle('bottom'), 0, 900)
        expect(fixed.el.style.height).toBe('600px')
    })

    it('a min larger than a % max wins, as in CSS', async () => {
        const { el, handle } = await sizable('width: 200px; min-width: 300px; max-width: 10%')
        dragHandle(handle('right'), -150, 0)
        expect(el.style.width).toBe('300px')
    })
})

describe('undo/redo hotkeys', () => {
    // A committed text edit: focus records the baseline, blur commits it.
    async function edited(attrs = '') {
        const root = await mount(`<section x-edit="hk-${Math.random().toString(36).slice(2)}" ${attrs}><p>One</p><p>Two</p></section>`)
        const p = root.querySelector('p')
        p.dispatchEvent(new Event('focus'))
        p.innerHTML = 'Changed'
        p.dispatchEvent(new Event('blur'))
        expect(store().canUndo).toBe(true)
        return { root, p }
    }

    it('Cmd+Z undoes and Cmd+Shift+Z redoes, updating canUndo/canRedo', async () => {
        const { p } = await edited()
        const at = store().export().cursor
        expect(key(document.body, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
        expect(p.innerHTML).toBe('One')
        expect(store().export().cursor).toBe(at - 1)
        expect(store().canRedo).toBe(true)
        expect(key(document.body, { key: 'z', metaKey: true, shiftKey: true }).defaultPrevented).toBe(true)
        expect(p.innerHTML).toBe('Changed')
        expect(store().canRedo).toBe(false)
    })

    it('Ctrl+Z undoes and Ctrl+Y redoes', async () => {
        const { p } = await edited()
        key(document.body, { key: 'z', ctrlKey: true })
        expect(p.innerHTML).toBe('One')
        key(document.body, { key: 'y', ctrlKey: true })
        expect(p.innerHTML).toBe('Changed')
    })

    it('uncommitted typing keeps the native undo', async () => {
        const { p } = await edited()
        const two = p.nextElementSibling
        two.dispatchEvent(new Event('focus'))
        two.innerHTML = 'Two typed'
        const at = store().export().cursor
        expect(key(two, { key: 'z', metaKey: true }).defaultPrevented).toBe(false)
        expect(store().export().cursor).toBe(at)
    })

    it('focused but committed text uses Edit history, and blur adds no stray delta', async () => {
        const { p } = await edited()
        p.focus()
        expect(document.activeElement).toBe(p)
        const at = store().export().cursor
        expect(key(p, { key: 'z', metaKey: true }).defaultPrevented).toBe(true)
        expect(p.innerHTML).toBe('One')
        p.blur()
        await flush()
        expect(store().export().cursor).toBe(at - 1)
        expect(store().canRedo).toBe(true)
    })

    it('leaves x-rich-text fields and ordinary inputs alone', async () => {
        const { root } = await edited()
        const rich = document.createElement('div')
        rich.setAttribute('data-rich-text', '')
        root.querySelector('section').appendChild(rich)
        const input = document.createElement('input')
        document.body.appendChild(input)
        const at = store().export().cursor
        expect(key(rich, { key: 'z', metaKey: true }).defaultPrevented).toBe(false)
        expect(key(input, { key: 'z', metaKey: true }).defaultPrevented).toBe(false)
        expect(store().export().cursor).toBe(at)
    })

    it('data-edit-hotkeys="off" on a region or <html> opts out', async () => {
        const { root } = await edited('data-edit-hotkeys="off"')
        const at = store().export().cursor
        expect(key(root.querySelector('p'), { key: 'z', metaKey: true }).defaultPrevented).toBe(false)
        expect(key(document.body, { key: 'z', metaKey: true }).defaultPrevented).toBe(false)   // the only active region is off
        expect(store().export().cursor).toBe(at)
        document.body.innerHTML = ''
        await flush()
        await edited()
        document.documentElement.setAttribute('data-edit-hotkeys', 'off')
        expect(key(document.body, { key: 'z', metaKey: true }).defaultPrevented).toBe(false)
    })
})

describe('sortable row hover', () => {
    it('draws an accent outline on hover in the UI scope, not while dragging or on the ghost', () => {
        const rules = []
        postcss.parse(readFileSync(CSS, 'utf8')).walkRules(r => {
            if (r.selector.includes('[data-edit-sortable]') && r.selector.includes(':hover')) rules.push(r)
        })
        expect(rules.length).toBe(1)
        const [rule] = rules
        expect(rule.selector).toContain('[data-edit-ui]')
        expect(rule.selector).toMatch(/:not\([^)]*\[data-edit-dragging\]/)
        expect(rule.selector).toContain('[data-edit-ghost]')
        expect(rule.selector).toContain('[data-edit-dragging-in]')
        const outline = rule.nodes.find(d => d.prop === 'outline')
        expect(outline && outline.value).toContain('--edit-accent')
    })
})
