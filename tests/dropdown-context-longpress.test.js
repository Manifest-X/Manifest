/**
 * @vitest-environment happy-dom
 *
 * iOS Safari never fires `contextmenu` for a touch long-press (Android does), so
 * x-dropdown.context menus never opened on iOS. manifest.dropdowns.js now drives the
 * same open from pointer events — touch/pen only, ~500ms hold, cancelled by
 * move-beyond-slop/up/cancel/scroll — reusing the contextmenu handler's positioning.
 * happy-dom has no real Popover API, so show/hidePopover and `:popover-open` are
 * polyfilled here the way combobox-defer.test.js documents doing for that gap.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Popover polyfill: track open state in a WeakSet, mirror the toggle event the
// browser fires, and teach matches() the :popover-open pseudo-class.
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
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

const pointer = (type, target, opts = {}) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', clientX: 40, clientY: 60, ...opts }))

beforeAll(() => { Alpine.start() })

describe('x-dropdown.context touch long-press', () => {
    it('opens the menu after a touch long-press, positioned at the press point', async () => {
        const host = mount(`<div x-data>
            <div id="trig" x-dropdown.context="ctx-open">Right-click here</div>
            <menu popover id="ctx-open"><li>Cut</li></menu>
        </div>`)
        await settle()
        const trigger = host.querySelector('#trig')
        const menu = host.querySelector('#ctx-open')

        pointer('pointerdown', trigger, { clientX: 40, clientY: 60 })
        expect(menu.matches(':popover-open')).toBe(false) // fails on master: contextmenu never arrives on iOS touch
        await wait(550)

        expect(menu.matches(':popover-open')).toBe(true)
        expect(menu.style.left).toBe('40px')
        expect(menu.style.top).toBe('60px')
    })

    it('cancels the long-press when the pointer moves beyond the slop', async () => {
        const host = mount(`<div x-data>
            <div id="trig" x-dropdown.context="ctx-move">Right-click here</div>
            <menu popover id="ctx-move"><li>Cut</li></menu>
        </div>`)
        await settle()
        const trigger = host.querySelector('#trig')
        const menu = host.querySelector('#ctx-move')

        pointer('pointerdown', trigger, { clientX: 40, clientY: 60 })
        pointer('pointermove', trigger, { clientX: 65, clientY: 60 }) // > 10px slop
        await wait(550)

        expect(menu.matches(':popover-open')).toBe(false)
    })

    it('cancels the long-press on an early pointerup', async () => {
        const host = mount(`<div x-data>
            <div id="trig" x-dropdown.context="ctx-up">Right-click here</div>
            <menu popover id="ctx-up"><li>Cut</li></menu>
        </div>`)
        await settle()
        const trigger = host.querySelector('#trig')
        const menu = host.querySelector('#ctx-up')

        pointer('pointerdown', trigger)
        await wait(100)
        pointer('pointerup', trigger)
        await wait(550)

        expect(menu.matches(':popover-open')).toBe(false)
    })

    it('leaves the mouse contextmenu path untouched — no pointer timer for mouse', async () => {
        const host = mount(`<div x-data>
            <div id="trig" x-dropdown.context="ctx-mouse">Right-click here</div>
            <menu popover id="ctx-mouse"><li>Cut</li></menu>
        </div>`)
        await settle()
        const trigger = host.querySelector('#trig')
        const menu = host.querySelector('#ctx-mouse')

        pointer('pointerdown', trigger, { pointerType: 'mouse' })
        await wait(550)

        expect(menu.matches(':popover-open')).toBe(false)
    })

    it('ignores a synthetic contextmenu that follows a long-press open (Android dupe)', async () => {
        const host = mount(`<div x-data>
            <div id="trig" x-dropdown.context="ctx-dupe">Right-click here</div>
            <menu popover id="ctx-dupe"><li>Cut</li></menu>
        </div>`)
        await settle()
        const trigger = host.querySelector('#trig')
        const menu = host.querySelector('#ctx-dupe')
        const opens = []
        const origShow = menu.showPopover.bind(menu)
        menu.showPopover = (...a) => { opens.push(Date.now()); return origShow(...a) }

        pointer('pointerdown', trigger)
        await wait(550)
        expect(menu.matches(':popover-open')).toBe(true)
        expect(opens.length).toBe(1)

        // Android fires a real contextmenu right after the long-press too.
        trigger.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }))

        expect(opens.length).toBe(1) // guarded — no second (re)open call
        expect(menu.matches(':popover-open')).toBe(true) // still open, not toggled closed
    })

    it('suppresses the synthetic click that follows a long-press open', async () => {
        const host = mount(`<div x-data>
            <div id="trig" x-dropdown.context="ctx-click">Right-click here</div>
            <menu popover id="ctx-click"><li>Cut</li></menu>
        </div>`)
        await settle()
        const trigger = host.querySelector('#trig')

        pointer('pointerdown', trigger)
        await wait(550)

        const clickEvent = new Event('click', { bubbles: true, cancelable: true })
        trigger.dispatchEvent(clickEvent)

        expect(clickEvent.defaultPrevented).toBe(true)
    })
})
