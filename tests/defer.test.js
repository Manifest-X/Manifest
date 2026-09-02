/**
 * @vitest-environment happy-dom
 *
 * x-defer: closed containers (popover, dialog, details, tab panel, hidden) keep their
 * subtree out of Alpine until they open. Real Alpine 3.17.1 drives the walk; the popover
 * API itself is absent in happy-dom, so open/close is simulated with the same
 * beforetoggle/toggle events the browser dispatches.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Idle callbacks are captured so prewarm can be stepped one slice at a time.
const idleQueue = []
const idleOpts = []
window.requestIdleCallback = (fn, opts) => { idleQueue.push(fn); idleOpts.push(opts); return idleQueue.length }
const runIdle = () => { const fn = idleQueue.shift(); if (fn) fn({ didTimeout: false, timeRemaining: () => 50 }) }

// Emulate the loader so the standalone `load` fallback never fires prewarm.
window.__manifestLoaderStarted = true
window.ensureTabsPluginInitialized = () => { }
window.Alpine = Alpine
window.counts = {}

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.defer.js'), 'utf8')
))

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }
const toggleEvent = (type, newState) => Object.assign(new Event(type, { bubbles: false }), { newState })
const openPopover = (el) => el.dispatchEvent(toggleEvent('beforetoggle', 'open'))
const closePopover = (el) => el.dispatchEvent(toggleEvent('toggle', 'closed'))

// Mount markup under body and run Alpine over it, the way a component swap does.
function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

const stash = (el) => el.querySelector(':scope > template[data-mnfst-defer]')

beforeAll(() => { Alpine.start() })
beforeEach(() => { window.counts = {}; idleQueue.length = 0; idleOpts.length = 0 })

describe('automatic detection', () => {
    it('defers every closed container type and leaves open ones alone', () => {
        const host = mount(`
            <div x-data>
                <menu popover id="m"><li x-init="counts.m = (counts.m || 0) + 1">A</li></menu>
                <dialog id="d"><p x-init="counts.d = 1">B</p></dialog>
                <dialog open id="d-open"><p x-init="counts.dOpen = 1">B</p></dialog>
                <details id="t"><summary>S</summary><p x-init="counts.t = 1">C</p></details>
                <details open id="t-open"><p x-init="counts.tOpen = 1">C</p></details>
                <div hidden id="h"><p x-init="counts.h = 1">D</p></div>
                <div hidden x-route="foo" id="r"><p x-init="counts.r = 1">E</p></div>
                <div x-tabpanel="set" id="p1"><p x-init="counts.p1 = 1">F</p></div>
                <div x-tabpanel="set" id="p2"><p x-init="counts.p2 = 1">G</p></div>
                <menu popover id="empty"></menu>
                <div id="plain"><p x-init="counts.plain = 1">H</p></div>
            </div>`)
        for (const id of ['m', 'd', 't', 'h', 'p2']) {
            const el = host.querySelector('#' + id)
            expect(el.__mnfstDefer, id).toBeTruthy()
            expect(stash(el), id).toBeTruthy()
            expect(el.children.length, id).toBe(1)
        }
        for (const id of ['d-open', 't-open', 'r', 'p1', 'empty', 'plain']) {
            expect(host.querySelector('#' + id).__mnfstDefer, id).toBeFalsy()
        }
        expect(window.counts).toEqual({ dOpen: 1, tOpen: 1, r: 1, p1: 1, plain: 1 })
    })

    it('skips containers whose own directive owns the children', () => {
        const host = mount(`<div x-data><menu popover x-html="'<b>x</b>'" id="m"></menu><div hidden x-text="'t'" id="h"><i></i></div></div>`)
        expect(host.querySelector('#m').__mnfstDefer).toBeFalsy()
        expect(host.querySelector('#h').__mnfstDefer).toBeFalsy()
        expect(host.querySelector('#m').innerHTML).toBe('<b>x</b>')
    })

    it('runs the container\'s own directives while the children stay stashed', () => {
        const host = mount(`<div x-data><menu popover x-data="{ n: 7 }" :data-n="n" id="m"><li x-init="counts.m = 1">A</li></menu></div>`)
        const menu = host.querySelector('#m')
        expect(menu.getAttribute('data-n')).toBe('7')
        expect(window.counts.m).toBeUndefined()
    })
})

describe('open signals', () => {
    it('renders a popover synchronously on beforeToggle open, then child directives run', () => {
        const host = mount(`<div x-data><menu popover id="m"><li x-init="counts.m = (counts.m || 0) + 1" x-text="'row'"></li></menu></div>`)
        const menu = host.querySelector('#m')
        let renderedRows = -1
        menu.addEventListener('manifest:defer-render', () => { renderedRows = menu.querySelectorAll('li').length })
        expect(window.counts.m).toBeUndefined()
        openPopover(menu)
        expect(window.counts.m).toBe(1)
        expect(stash(menu)).toBeNull()
        expect(menu.querySelector('li').textContent).toBe('row')
        expect(renderedRows).toBe(1)
    })

    it('renders a dialog when it gains the open attribute', async () => {
        const host = mount(`<div x-data><dialog id="d"><p x-init="counts.d = 1"></p></dialog></div>`)
        const d = host.querySelector('#d')
        d.setAttribute('open', '')
        await settle()
        expect(window.counts.d).toBe(1)
    })

    it('renders details on toggle', async () => {
        const host = mount(`<div x-data><details id="t"><summary>S</summary><p x-init="counts.t = 1"></p></details></div>`)
        const t = host.querySelector('#t')
        t.setAttribute('open', '')
        t.dispatchEvent(new Event('toggle'))
        await settle()
        expect(window.counts.t).toBe(1)
        expect(t.querySelector('summary')).toBeTruthy()
    })

    it('renders a hidden container when hidden is removed', async () => {
        const host = mount(`<div x-data><div hidden id="h"><p x-init="counts.h = 1"></p></div></div>`)
        const h = host.querySelector('#h')
        await settle()
        expect(window.counts.h).toBeUndefined()
        h.removeAttribute('hidden')
        await settle()
        expect(window.counts.h).toBe(1)
    })

    it('renders a non-initial tab panel once the tabs plugin shows it', async () => {
        const host = mount(`<div x-data>
            <div x-tabpanel="s" id="a"><p x-init="counts.a = 1"></p></div>
            <div x-tabpanel="s" id="b"><p x-init="counts.b = 1"></p></div></div>`)
        const b = host.querySelector('#b')
        b.style.display = 'none'
        await settle()
        expect(window.counts.b).toBeUndefined()
        b.style.display = ''
        await settle()
        expect(window.counts).toEqual({ a: 1, b: 1 })
    })
})

describe('modifiers', () => {
    it('keep-alive: state and node identity survive close/open', () => {
        const host = mount(`<div x-data><menu popover id="m"><li x-init="counts.m = (counts.m || 0) + 1"><input></li></menu></div>`)
        const menu = host.querySelector('#m')
        openPopover(menu)
        const input = menu.querySelector('input')
        input.value = 'typed'
        closePopover(menu)
        openPopover(menu)
        expect(menu.querySelector('input')).toBe(input)
        expect(input.value).toBe('typed')
        expect(window.counts.m).toBe(1)
    })

    it('.discard tears down on close and re-renders fresh on open', () => {
        const host = mount(`<div x-data><menu popover x-defer.discard id="m"><li x-init="counts.m = (counts.m || 0) + 1"><input></li></menu></div>`)
        const menu = host.querySelector('#m')
        openPopover(menu)
        const first = menu.querySelector('input')
        first.value = 'typed'
        expect(window.counts.m).toBe(1)
        closePopover(menu)
        expect(menu.querySelector('input')).toBeNull()
        expect(stash(menu)).toBeTruthy()
        openPopover(menu)
        expect(window.counts.m).toBe(2)
        expect(menu.querySelector('input')).not.toBe(first)
        expect(menu.querySelector('input').value).toBe('')
    })

    it('.off keeps the container eager', () => {
        const host = mount(`<div x-data><menu popover x-defer.off id="m"><li x-init="counts.m = 1"></li></menu></div>`)
        expect(host.querySelector('#m').__mnfstDefer).toBeFalsy()
        expect(window.counts.m).toBe(1)
    })

    it('explicit x-defer on an x-show subtree renders when shown', async () => {
        const host = mount(`<div x-data="{ open: false }" id="root"><div x-show="open" x-defer id="s"><p x-init="counts.s = 1"></p></div></div>`)
        const s = host.querySelector('#s')
        expect(s.__mnfstDefer).toBeTruthy()
        await settle()
        expect(window.counts.s).toBeUndefined()
        Alpine.$data(host.querySelector('#root')).open = true
        await settle(5)
        expect(window.counts.s).toBe(1)
    })
})

describe('prewarm', () => {
    it('waits for manifest:ready, then drains by priority and document order, skipping .lazy', () => {
        const host = mount(`<div x-data>
            <menu popover id="p0a"><li x-init="counts.order = (counts.order || []).concat('p0a')"></li></menu>
            <menu popover x-defer.priority="2" id="p2"><li x-init="counts.order = (counts.order || []).concat('p2')"></li></menu>
            <menu popover x-defer.lazy id="lazy"><li x-init="counts.order = (counts.order || []).concat('lazy')"></li></menu>
            <menu popover x-defer.priority="1" id="p1"><li x-init="counts.order = (counts.order || []).concat('p1')"></li></menu>
            <menu popover id="p0b"><li x-init="counts.order = (counts.order || []).concat('p0b')"></li></menu>
        </div>`)
        expect(idleQueue.length).toBe(0)
        expect(window.counts.order).toBeUndefined()
        window.dispatchEvent(new CustomEvent('manifest:ready'))
        expect(idleQueue.length).toBe(1)
        // Still booting (queue not drained yet): a late container is NOT urgent — it queues by priority
        mount(`<div x-data><menu popover x-defer.priority="9" id="late"><li x-init="counts.order = (counts.order || []).concat('late')"></li></menu></div>`)
        // One container per slice; containers left closed by earlier tests drain too
        let slices = 0
        while (idleQueue.length && slices++ < 50) runIdle()
        expect(window.counts.order).toEqual(['p0a', 'p0b', 'p1', 'p2', 'late'])
        expect(slices).toBeGreaterThan(4)
        expect(idleQueue.length).toBe(0)
        expect(window.ManifestDefer.isPending(host.querySelector('#lazy'))).toBe(true)
    })

    it('after boot, a container mounted with no gesture stays on the normal idle timeout', () => {
        while (idleQueue.length) runIdle()
        idleOpts.length = 0
        mount(`<div x-data><menu popover id="quiet"><li x-init="counts.quiet = 1"></li></menu></div>`)
        expect(idleQueue.length).toBe(1)
        expect(idleOpts[0]).toEqual({ timeout: 1000 })
        runIdle()
        expect(window.counts.quiet).toBe(1)
    })

    it('after boot, a container mounted inside a gesture window is urgent (short timeout, front of queue)', () => {
        while (idleQueue.length) runIdle()
        idleOpts.length = 0
        document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        mount(`<div x-data><menu popover id="fresh"><li x-init="counts.fresh = 1"></li></menu></div>`)
        expect(idleQueue.length).toBe(1)
        expect(idleOpts[0]).toEqual({ timeout: 100 })
        runIdle()
        expect(window.counts.fresh).toBe(1)
    })

    it('caps urgent containers per gesture', () => {
        while (idleQueue.length) runIdle()
        document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        const menus = Array.from({ length: 10 }, (_, i) => `<menu popover id="cap${i}"><li x-init="counts.cap = (counts.cap || 0) + 1"></li></menu>`).join('')
        const host = mount(`<div x-data>` + menus + `</div>`)
        const recs = Array.from(host.querySelectorAll('menu')).map((m) => m.__mnfstDefer)
        expect(recs.filter((r) => r.urgent).length).toBe(8)
        expect(recs.filter((r) => !r.urgent).length).toBe(2)
    })
})

describe('cooperative API', () => {
    it('defers a runtime-built menu registered before initTree', () => {
        const menu = document.createElement('menu')
        menu.innerHTML = '<li x-init="counts.rt = (counts.rt || 0) + 1">A</li>'
        menu.setAttribute('popover', '')
        document.body.appendChild(menu)
        expect(window.ManifestDefer.defer(menu)).toBeTruthy()
        Alpine.initTree(menu)
        expect(window.counts.rt).toBeUndefined()
        expect(stash(menu)).toBeTruthy()
        openPopover(menu)
        expect(window.counts.rt).toBe(1)
    })

    it('adopts a stash serialized by a previous session instead of nesting it', () => {
        const host = mount(`<div x-data><menu popover id="m"><template data-mnfst-defer><li x-init="counts.m = 1">A</li></template></menu></div>`)
        const menu = host.querySelector('#m')
        expect(menu.children.length).toBe(1)
        expect(stash(menu).content.querySelector('template')).toBeNull()
        openPopover(menu)
        expect(window.counts.m).toBe(1)
        expect(menu.querySelector('li').textContent).toBe('A')
    })
})
