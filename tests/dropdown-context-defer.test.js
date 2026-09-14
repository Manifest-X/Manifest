/**
 * @vitest-environment happy-dom
 *
 * Client-reported regression: right-click on an x-dropdown.context target whose
 * <menu> content is x-defer-stashed opens an EMPTY popover. The old contextmenu
 * handler happened to render before showing; the shared openContextMenuAt path
 * (extracted for iOS long-press, c98ebed) does not hydrate the stash.
 *
 * happy-dom has no real Popover API. The polyfill here matches
 * dropdown-context-longpress.test.js: showPopover only fires `toggle`, not
 * `beforetoggle` — reproducing the manual-popover event gap this fix works around.
 * Real defer stashes are built via Alpine init over popover content, same technique
 * as combobox-defer.test.js.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Popover polyfill (see dropdown-context-longpress.test.js): only `toggle` fires.
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

const load = (file) => import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/' + file), 'utf8')
))
await load('manifest.defer.js')
await load('manifest.dropdowns.js')
window.ensureDropdownPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await tick() }

function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

const menuRows = (menu) => Array.from(menu.querySelectorAll('li')).map((li) => li.textContent)

const contextMenuMarkup = (id) => `<div x-data>
    <div id="trig-${id}" x-dropdown.context="${id}">Right-click here</div>
    <menu popover id="${id}">
        <template x-for="item in ['Cut', 'Copy', 'Paste']" :key="item">
            <li x-text="item"></li>
        </template>
    </menu>
</div>`

const pointer = (type, target, opts = {}) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', clientX: 40, clientY: 60, ...opts }))

beforeAll(() => { Alpine.start() })

describe('x-dropdown.context defer regression', () => {
    it('a desktop right-click assertion on a .context menu: renders its rows, not an empty popover', async () => {
        const host = mount(contextMenuMarkup('ctx-defer-mouse'))
        await settle()
        const trigger = host.querySelector('#trig-ctx-defer-mouse')
        const menu = host.querySelector('#ctx-defer-mouse')

        // Stashed before any open.
        expect(menu.querySelector(':scope > template[data-mnfst-defer]')).toBeTruthy()

        trigger.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
        await settle()

        expect(menu.matches(':popover-open')).toBe(true)
        expect(menu.querySelectorAll('li').length).toBeGreaterThan(0)
        expect(menuRows(menu)).toEqual(['Cut', 'Copy', 'Paste'])
    })

    it('a touch long-press on a .context menu: renders its rows too', async () => {
        const host = mount(contextMenuMarkup('ctx-defer-touch'))
        await settle()
        const trigger = host.querySelector('#trig-ctx-defer-touch')
        const menu = host.querySelector('#ctx-defer-touch')

        expect(menu.querySelector(':scope > template[data-mnfst-defer]')).toBeTruthy()

        pointer('pointerdown', trigger, { clientX: 40, clientY: 60 })
        await new Promise((r) => setTimeout(r, 550))
        await settle()

        expect(menu.matches(':popover-open')).toBe(true)
        expect(menu.querySelectorAll('li').length).toBeGreaterThan(0)
        expect(menuRows(menu)).toEqual(['Cut', 'Copy', 'Paste'])
    })

    it('inverse: a non-deferred (no popover attribute) .context menu still opens with its rows', async () => {
        const host = mount(`<div x-data>
            <div id="trig-plain" x-dropdown.context="ctx-plain">Right-click here</div>
            <menu id="ctx-plain"><li>Cut</li><li>Copy</li></menu>
        </div>`)
        await settle()
        const trigger = host.querySelector('#trig-plain')
        const menu = host.querySelector('#ctx-plain')

        // Never stashed — no popover attribute at init, so defer's rule never applies.
        expect(menu.querySelector(':scope > template[data-mnfst-defer]')).toBeFalsy()

        trigger.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
        await settle()

        expect(menu.matches(':popover-open')).toBe(true)
        expect(menuRows(menu)).toEqual(['Cut', 'Copy'])
    })
})
