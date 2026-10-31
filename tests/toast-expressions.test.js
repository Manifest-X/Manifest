/**
 * @vitest-environment happy-dom
 *
 * x-toast content classification (shared with x-tooltip via
 * scripts/snippets/manifest.expressions.js): any JS expression evaluates on
 * every click, plain text (including text that happens to parse as JS) shows
 * verbatim.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

window.Alpine = Alpine

const xAccess = vi.fn()
Alpine.magic('x', () => {
    xAccess()
    return { example: { toast: 'From a data source', rich: 'Saved <b>draft</b>' } }
})

await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.toasts.js'), 'utf8')
))
window.ensureToastPluginInitialized()

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await wait() }

function mount(html) {
    const host = document.createElement('section')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

const toasts = () => [...document.querySelectorAll('.toast-container .toast-content')]

// Click `el`; returns the toast it showed (or null when nothing shows)
async function click(el) {
    const before = toasts().length
    el.click()
    await settle()
    const added = toasts().slice(before)
    expect(added.length).toBeLessThanOrEqual(1)
    return added[0] ? { text: added[0].textContent, html: added[0].innerHTML } : null
}

async function toastFor(attr, data = '{}') {
    const host = mount(`<div x-data="${data}"><button ${attr}>T</button></div>`)
    await settle()
    return click(host.querySelector('button'))
}

const warn = vi.spyOn(console, 'warn')
const error = vi.spyOn(console, 'error')

beforeAll(() => { Alpine.start() })
afterEach(() => {
    document.body.querySelectorAll(':scope > section').forEach((d) => d.remove())
    document.querySelector('.toast-container')?.replaceChildren()
})

describe('x-toast plain text stays plain', () => {
    it.each([
        ['This is a toast', 'This is a toast'],
        ['Default 3 seconds', 'Default 3 seconds'],
        ['Something went wrong', 'Something went wrong'],
        ['Negative toast with 2s duration and dismiss button', 'Negative toast with 2s duration and dismiss button'],
        ['Saved', 'Saved'],
        ["Don&#39;t save", "Don't save"],
        ['Re-run', 'Re-run'],
        ['Hello, world', 'Hello, world'],
        ['Ctrl+S', 'Ctrl+S'],
        ['Saved!', 'Saved!'],
        ['C:\\new\\table', 'C:\\new\\table'],
        ['Node.js', 'Node.js'],
        ['top-parent', 'top-parent'],
        ['2026-10-13', '2026-10-13'],
        ['24/7', '24/7'],
        ['1,000', '1,000'],
        ['50-50', '50-50'],
        ['3.0', '3.0'],
        ['[]', '[]'],
        ['{}', '{}'],
        ['new', 'new'],
        ['default', 'default'],
    ])('%s', async (attr, expected) => {
        warn.mockClear(); error.mockClear()
        const toast = await toastFor(`x-toast="${attr}"`)
        expect(toast.text).toBe(expected)
        expect(warn).not.toHaveBeenCalled()
        expect(error).not.toHaveBeenCalled()
    })

    it('a bare word naming a global (Image, close) is text, never evaluated or called', async () => {
        const close = vi.spyOn(window, 'close').mockImplementation(() => {})
        expect((await toastFor('x-toast="Image"')).text).toBe('Image')
        expect((await toastFor('x-toast="close"')).text).toBe('close')
        expect(close).not.toHaveBeenCalled()
        close.mockRestore()
    })

    it('a bare word that coincides with nothing in scope is text', async () => {
        warn.mockClear()
        expect((await toastFor('x-toast="Toast"', '{ n: 2 }')).text).toBe('Toast')
        expect(warn).not.toHaveBeenCalled()
    })

    it('literal HTML renders as markup', async () => {
        const toast = await toastFor(`x-toast="<span class='i'></span>Hello <b>bold</b> and <em>it's</em> world"`)
        expect(toast.html).toBe(`<span class="i"></span>Hello <b>bold</b> and <em>it's</em> world`)
    })

    it('modifiers keep working on static text', async () => {
        const host = mount(`<div><button x-toast.positive.dismiss="Positive with dismiss button">T</button></div>`)
        await settle()
        await click(host.querySelector('button'))
        const toast = document.querySelector('.toast-container .toast:last-child')
        expect(toast.className).toContain('positive')
        expect(toast.querySelector('.toast-dismiss-button')).not.toBeNull()
    })
})

describe('x-toast expressions evaluate', () => {
    it('scope variable', async () => {
        expect((await toastFor('x-toast="n"', '{ n: 2 }')).text).toBe('2')
    })

    it('ternary', async () => {
        expect((await toastFor(`x-toast="saved ? 'Saved' : 'Failed'"`, '{ saved: false }')).text).toBe('Failed')
    })

    it('.map().join(\', \')', async () => {
        const toast = await toastFor(`x-toast="list.map(m => m.name).join(', ')"`, `{ list: [{ name: 'Ann' }, { name: 'Bo' }] }`)
        expect(toast.text).toBe('Ann, Bo')
    })

    it('template literal', async () => {
        expect((await toastFor('x-toast="`Hi ${name}`"', `{ name: 'Ann' }`)).text).toBe('Hi Ann')
    })

    it('+ concatenation', async () => {
        expect((await toastFor(`x-toast="'Count: ' + count"`, '{ count: 42 }')).text).toBe('Count: 42')
    })

    it('$x. path evaluates, and touches the source at init so it starts loading', async () => {
        xAccess.mockClear()
        const host = mount(`<div><button x-toast="$x.example.toast">T</button></div>`)
        await settle()
        expect(xAccess).toHaveBeenCalled()
        expect((await click(host.querySelector('button'))).text).toBe('From a data source')
    })

    it('$x. values render as text; .html renders them as markup', async () => {
        expect((await toastFor('x-toast="$x.example.rich"')).html).toBe('Saved &lt;b&gt;draft&lt;/b&gt;')
        expect((await toastFor('x-toast.html="$x.example.rich"')).html).toBe('Saved <b>draft</b>')
    })

    it('x-for loop variable without a template literal', async () => {
        const host = mount(`<div x-data="{ items: [{ msg: 'First' }, { msg: 'Second' }] }">
            <template x-for="item in items"><button x-toast="item.msg">T</button></template>
        </div>`)
        await settle()
        const [a, b] = host.querySelectorAll('button')
        expect((await click(a)).text).toBe('First')
        expect((await click(b)).text).toBe('Second')
    })

    it('empty results (false, null, \'\') show no toast', async () => {
        expect(await toastFor(`x-toast="off && 'Reason'"`, '{ off: false }')).toBeNull()
        expect(await toastFor(`x-toast="off ? 'Reason' : ''"`, '{ off: false }')).toBeNull()
        expect(await toastFor('x-toast="v"', '{ v: null }')).toBeNull()
        expect(await toastFor('x-toast="v"', '{ v: [] }')).toBeNull()
    })

    it('real errors warn with the authored expression and show nothing', async () => {
        warn.mockClear()
        const silence = warn.mockImplementation(() => {})
        const toast = await toastFor('x-toast="user.name"', '{ user: null }')
        expect(toast).toBeNull()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0][0]).toContain('Expression: "user.name"')
        expect(warn.mock.calls[0][0]).not.toContain('__exprError')
        silence.mockRestore()
    })
})

describe('x-toast re-evaluates per click', () => {
    it('each click shows the current value', async () => {
        const host = mount(`<div x-data="{ n: 2, saved: true }">
            <button id="a" x-toast="n">T</button>
            <button id="b" x-toast="saved ? 'Saved' : 'Failed'">T</button>
            <button id="c" x-toast="\`Clicked at \${n}\`">T</button>
        </div>`)
        await settle()
        const [a, b, c] = ['#a', '#b', '#c'].map((s) => host.querySelector(s))
        expect((await click(a)).text).toBe('2')
        expect((await click(b)).text).toBe('Saved')
        expect((await click(c)).text).toBe('Clicked at 2')
        Alpine.$data(host.firstElementChild).n = 5
        Alpine.$data(host.firstElementChild).saved = false
        await settle()
        expect((await click(a)).text).toBe('5')
        expect((await click(b)).text).toBe('Failed')
        expect((await click(c)).text).toBe('Clicked at 5')
    })

    it('an existing onclick handler runs first', async () => {
        const host = document.createElement('section')
        host.innerHTML = `<div x-data="{ n: 0 }"><button x-toast="\`n is \${n}\`">T</button></div>`
        const btn = host.querySelector('button')
        btn.onclick = () => { Alpine.$data(btn).n++ }
        document.body.appendChild(host)
        Alpine.initTree(host)
        await settle()
        expect((await click(btn)).text).toBe('n is 1')
        expect((await click(btn)).text).toBe('n is 2')
    })
})

describe('toast content is text unless authored or opted in', () => {
    const evil = `<img src="x" onerror="window.__hit=1"><span x-init="window.__hit=2">n</span>`

    it('expression results never become elements', async () => {
        const t = await toastFor('x-toast="evil"', `{ evil: ${JSON.stringify(evil).replace(/"/g, '&quot;')} }`)
        expect(t.text).toBe(evil)
        expect(document.querySelector('.toast-content img, .toast-content span')).toBeNull()
    })

    it('$toast and its variants show text; { html: true } renders markup', async () => {
        const host = mount(`<div x-data="{ evil: ${JSON.stringify(evil).replace(/"/g, '&quot;')} }">
            <button id="a" @click="$toast(evil)">A</button>
            <button id="b" @click="$toast.negative.dismiss(evil)">B</button>
            <button id="c" @click="$toast.positive.fixed('<b>ok</b>', { html: true })">C</button>
        </div>`)
        await settle()
        expect((await click(host.querySelector('#a'))).text).toBe(evil)
        expect((await click(host.querySelector('#b'))).text).toBe(evil)
        expect((await click(host.querySelector('#c'))).html).toBe('<b>ok</b>')
        expect(document.querySelectorAll('.toast-content img, .toast-content span')).toHaveLength(0)
    })

    it('authored static markup still renders', async () => {
        expect((await toastFor(`x-toast="Hello <b>bold</b>"`)).html).toBe('Hello <b>bold</b>')
    })
})
