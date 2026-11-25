/**
 * @vitest-environment happy-dom
 *
 * Several x-dropdown triggers sharing one menu: the menu's keyboard and toggle handling is
 * bound once and acts on the trigger that opened it. happy-dom has no Popover API, so it is
 * polyfilled as in dropdown-context-longpress.test.js.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const openPopovers = new WeakSet()
const origMatches = Element.prototype.matches
HTMLElement.prototype.showPopover = function () {
    if (openPopovers.has(this)) return
    openPopovers.add(this)
    this.dispatchEvent(Object.assign(new Event('toggle'), { oldState: 'closed', newState: 'open' }))
}
HTMLElement.prototype.hidePopover = function () {
    if (!openPopovers.has(this)) return
    openPopovers.delete(this)
    this.dispatchEvent(Object.assign(new Event('toggle'), { oldState: 'open', newState: 'closed' }))
}
Element.prototype.matches = function (sel) {
    if (sel === ':popover-open') return openPopovers.has(this)
    return origMatches.call(this, sel)
}

window.__manifestLoaderStarted = true
window.Alpine = Alpine

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.dropdowns.js'), 'utf8')
))
window.ensureDropdownPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await tick() }

// Counts keydown handler runs on the menu, across every listener the plugin adds
function countMenuKeydowns(menu) {
    const counter = { n: 0 }
    const add = menu.addEventListener
    menu.addEventListener = function (type, fn, opts) {
        if (type === 'keydown' && typeof fn === 'function') {
            const wrapped = function (e) { counter.n++; return fn.call(this, e) }
            return add.call(this, type, wrapped, opts)
        }
        return add.call(this, type, fn, opts)
    }
    return counter
}

async function mount() {
    const host = document.createElement('div')
    host.innerHTML = `<div x-data>
        <button id="a" x-dropdown="shared">A</button>
        <button id="b" x-dropdown="shared">B</button>
        <menu popover id="shared"><li>One</li><li>Two</li></menu>
    </div>`
    document.body.appendChild(host)
    const menu = host.querySelector('#shared')
    const counter = countMenuKeydowns(menu)
    Alpine.initTree(host)
    await settle()
    return { host, menu, a: host.querySelector('#a'), b: host.querySelector('#b'), counter }
}

const openFrom = (trigger, menu) => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    menu.showPopover()
}
const escape = (menu) => menu.querySelector('li').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

beforeAll(() => { Alpine.start() })
afterEach(async () => { document.body.innerHTML = ''; await settle() })

describe('x-dropdown menu shared by several triggers', () => {
    it('Escape returns focus to the trigger that opened the menu, running one keydown handler', async () => {
        const { menu, a, b, counter } = await mount()
        openFrom(a, menu)
        counter.n = 0
        escape(menu)
        expect(menu.matches(':popover-open')).toBe(false)
        expect(document.activeElement).toBe(a)
        expect(counter.n).toBe(1)

        openFrom(b, menu)
        escape(menu)
        expect(document.activeElement).toBe(b)
    })

    it('sets aria-expanded on the invoking trigger only, and clears it on close', async () => {
        const { menu, a, b } = await mount()
        openFrom(a, menu)
        expect(a.getAttribute('aria-expanded')).toBe('true')
        expect(b.getAttribute('aria-expanded')).toBe('false')
        escape(menu)
        expect(a.getAttribute('aria-expanded')).toBe('false')
        openFrom(b, menu)
        expect(a.getAttribute('aria-expanded')).toBe('false')
        expect(b.getAttribute('aria-expanded')).toBe('true')
        menu.hidePopover()
        expect(b.getAttribute('aria-expanded')).toBe('false')
    })

    it('keeps working for the remaining trigger when one is removed, and is released with the last', async () => {
        const { menu, a, b, counter } = await mount()
        b.remove()
        await settle()
        openFrom(a, menu)
        counter.n = 0
        escape(menu)
        expect(document.activeElement).toBe(a)
        expect(counter.n).toBe(1)

        a.remove()
        await settle()
        menu.showPopover()
        counter.n = 0
        escape(menu)
        expect(counter.n).toBe(0)
    })
})
