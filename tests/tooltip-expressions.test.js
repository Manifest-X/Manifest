/**
 * @vitest-environment happy-dom
 *
 * x-tooltip content classification: any JS expression evaluates, plain text
 * (including text that happens to parse as JS) renders verbatim.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Popover polyfill (happy-dom has no Popover API)
const openPopovers = new WeakSet()
const origMatches = Element.prototype.matches
HTMLElement.prototype.showPopover = function () { openPopovers.add(this) }
HTMLElement.prototype.hidePopover = function () { openPopovers.delete(this) }
Element.prototype.matches = function (sel) {
    if (sel === ':popover-open') return openPopovers.has(this)
    return origMatches.call(this, sel)
}

window.Alpine = Alpine
document.documentElement.style.setProperty('--tooltip-hover-delay', '0ms')

const loadCollection = vi.fn()
Alpine.store('collections', { loadCollection })
Alpine.magic('x', () => ({ example: { tooltip: 'From a data source' } }))

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.tooltips.js'), 'utf8')
))
window.ensureTooltipPluginInitialized()

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await wait() }

function mount(html) {
    const host = document.createElement('section')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

const singleton = () => document.body.querySelector(':scope > .tooltip[popover="hint"]')
const isOpen = () => !!singleton() && singleton().matches(':popover-open')

async function hide(el) {
    el.dispatchEvent(new Event('mouseleave'))
    await wait(80)
}

// Show the tooltip for `el`; returns the singleton (or null when nothing shows)
async function show(el) {
    el.dispatchEvent(new Event('mouseenter'))
    await wait(10)
    await settle()
    const tip = isOpen() ? singleton() : null
    await hide(el)
    return tip && { text: tip.textContent, html: tip.innerHTML }
}

async function tooltipFor(attr, data = '{}') {
    const host = mount(`<div x-data="${data}"><button ${attr}>T</button></div>`)
    await settle()
    return show(host.querySelector('button'))
}

const warn = vi.spyOn(console, 'warn')
const error = vi.spyOn(console, 'error')

beforeAll(() => { Alpine.start() })
afterEach(() => { document.body.querySelectorAll(':scope > section').forEach((d) => d.remove()) })

describe('x-tooltip plain text stays plain', () => {
    it.each([
        ['Delete', 'Delete'],
        ['Copy email', 'Copy email'],
        ['Underline ⌘U', 'Underline ⌘U'],
        ["Don&#39;t save", "Don't save"],
        ['Using the CLI instead? Copies the claude mcp add command', 'Using the CLI instead? Copies the claude mcp add command'],
        ['Re-run', 'Re-run'],
        ['Hello, world', 'Hello, world'],
        ['Ctrl+S', 'Ctrl+S'],
        ['open in new tab', 'open in new tab'],
        ['C:\\new\\table', 'C:\\new\\table'],
        ['Node.js', 'Node.js'],
        ['top-parent', 'top-parent'],
    ])('%s', async (attr, expected) => {
        warn.mockClear(); error.mockClear()
        const tip = await tooltipFor(`x-tooltip="${attr}"`)
        expect(tip.text).toBe(expected)
        expect(warn).not.toHaveBeenCalled()
        expect(error).not.toHaveBeenCalled()
    })

    it('a bare word naming a global (Image, close) is text, never evaluated or called', async () => {
        const close = vi.spyOn(window, 'close').mockImplementation(() => {})
        expect((await tooltipFor('x-tooltip="Image"')).text).toBe('Image')
        expect((await tooltipFor('x-tooltip="close"')).text).toBe('close')
        expect(close).not.toHaveBeenCalled()
        close.mockRestore()
    })

    it('a bare word that coincides with nothing in scope is text', async () => {
        warn.mockClear()
        const tip = await tooltipFor('x-tooltip="Tooltip"', '{ n: 2 }')
        expect(tip.text).toBe('Tooltip')
        expect(warn).not.toHaveBeenCalled()
    })

    it('literal HTML renders as markup', async () => {
        const tip = await tooltipFor(`x-tooltip="<span class='i'></span>Hello <b>bold</b> and <em>it's</em> world"`)
        expect(tip.html).toBe(`<span class="i"></span>Hello <b>bold</b> and <em>it's</em> world`)
    })

    it('plain text is escaped, not parsed as markup', async () => {
        const tip = await tooltipFor('x-tooltip="Less than &lt;3"')
        expect(tip.text).toBe('Less than <3')
    })
})

describe('x-tooltip expressions evaluate', () => {
    it('scope variable', async () => {
        expect((await tooltipFor('x-tooltip="n"', '{ n: 2 }')).text).toBe('2')
    })

    it('ternary', async () => {
        expect((await tooltipFor(`x-tooltip="ok ? 'Yes' : 'No'"`, '{ ok: false }')).text).toBe('No')
    })

    it('.map().join(\', \')', async () => {
        const tip = await tooltipFor(`x-tooltip="list.map(m => m.name).join(', ')"`, `{ list: [{ name: 'Ann' }, { name: 'Bo' }] }`)
        expect(tip.text).toBe('Ann, Bo')
    })

    it('template literal', async () => {
        expect((await tooltipFor('x-tooltip="`Hi ${name}`"', `{ name: 'Ann' }`)).text).toBe('Hi Ann')
    })

    it('+ concatenation', async () => {
        expect((await tooltipFor(`x-tooltip="'Count: ' + count"`, '{ count: 42 }')).text).toBe('Count: 42')
    })

    it('$x. path evaluates and loads its collection', async () => {
        loadCollection.mockClear()
        expect((await tooltipFor('x-tooltip="$x.example.tooltip"')).text).toBe('From a data source')
        expect(loadCollection).toHaveBeenCalledWith('example')
    })

    it('x-for loop variable without a template literal', async () => {
        const host = mount(`<div x-data="{ items: [{ tip: 'First' }, { tip: 'Second' }] }">
            <template x-for="item in items"><button x-tooltip="item.tip">T</button></template>
        </div>`)
        await settle()
        const [a, b] = host.querySelectorAll('button')
        expect((await show(a)).text).toBe('First')
        expect((await show(b)).text).toBe('Second')
    })

    it('evaluated content is escaped unless .html', async () => {
        const plain = await tooltipFor(`x-tooltip="'<b>' + name + '</b>'"`, `{ name: 'Ann' }`)
        expect(plain.text).toBe('<b>Ann</b>')
        const html = await tooltipFor(`x-tooltip.html="'<b>' + name + '</b>'"`, `{ name: 'Ann' }`)
        expect(html.html).toBe('<b>Ann</b>')
    })

    it('empty results (false, null, \'\') show no tooltip', async () => {
        expect(await tooltipFor(`x-tooltip="off && 'Reason'"`, '{ off: false }')).toBeNull()
        expect(await tooltipFor(`x-tooltip="off ? 'Reason' : ''"`, '{ off: false }')).toBeNull()
        expect(await tooltipFor('x-tooltip="v"', '{ v: null }')).toBeNull()
    })

    it('real errors warn with the authored expression and show nothing', async () => {
        warn.mockClear()
        const silence = warn.mockImplementation(() => {})
        const tip = await tooltipFor('x-tooltip="user.name"', '{ user: null }')
        expect(tip).toBeNull()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0][0]).toContain('Expression: "user.name"')
        expect(warn.mock.calls[0][0]).not.toContain('__tooltipError')
        silence.mockRestore()
    })
})

describe('x-tooltip reactivity', () => {
    it('re-shows with the current value', async () => {
        const host = mount(`<div x-data="{ n: 2, ok: true }">
            <button id="a" x-tooltip="n">T</button>
            <button id="b" x-tooltip="ok ? 'Yes' : 'No'">T</button>
        </div>`)
        await settle()
        const a = host.querySelector('#a')
        const b = host.querySelector('#b')
        expect((await show(a)).text).toBe('2')
        expect((await show(b)).text).toBe('Yes')
        Alpine.$data(host.firstElementChild).n = 5
        Alpine.$data(host.firstElementChild).ok = false
        await settle()
        expect((await show(a)).text).toBe('5')
        expect((await show(b)).text).toBe('No')
    })
})
