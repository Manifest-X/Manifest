/**
 * @vitest-environment happy-dom
 *
 * A held element inside another held element: input typed during the hold is replayed to each
 * control exactly once, whichever module registers first (inner first, outer first, or the inner
 * held and started in the same task as the outer), and still once when the inner hold gives up.
 * Handlers between the inner and outer roots see the replay once; listeners outside see none.
 * LOADER_SRC=<file> runs the suite against another loader (e.g. the old one).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(process.env.LOADER_SRC || path.join(__dirname, '../src/scripts/manifest.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick() }
const V = '0.5.217'

beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).includes('manifest.json')
        ? new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
    if (typeof performance.getEntriesByName === 'function') vi.spyOn(performance, 'getEntriesByName').mockReturnValue([])
    else performance.getEntriesByName = () => []
    vi.spyOn(console, 'warn').mockImplementation(() => { })
    window.__c = {}
    window.count = (k) => { window.__c[k] = (window.__c[k] || 0) + 1 }
    window.happyDOM.setURL('https://site.example/')
    window.happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
    document.head.innerHTML = '<link rel="manifest" href="/manifest.json">'
    document.body.innerHTML = '<div id="app" x-data><form id="host"></form></div>'
    const s = document.createElement('script')
    s.setAttribute('src', `https://cdn.manifestx.dev/npm/mnfst@${V}/lib/manifest.js`)
    s.setAttribute('data-version', V)
    document.head.appendChild(s)
    Object.defineProperty(document, 'currentScript', { value: s, configurable: true })
    new Function(CODE)()
    Object.defineProperty(document, 'currentScript', { value: null, configurable: true })
    await settle()
    window.Alpine = Alpine
    Alpine.start()
    await settle()
    document.getElementById('host').addEventListener('input', () => window.count('nativeOut'))
})

// outer > mid > inner > control, each with input/change handlers
const insert = (p, outer, inner) => {
    document.getElementById('host').insertAdjacentHTML('beforeend', `<div id="${p}o" ${outer} x-data="{ t: '' }" @input="count('${p}oIn')">
        <div @input="count('${p}midIn')"><div id="${p}i" ${inner} @input="count('${p}iIn')">
            <input id="${p}f" x-model="t" @input="count('${p}fIn')" @change="count('${p}fCh')">
        </div></div></div>`)
}
const counts = (p) => ['fIn', 'fCh', 'iIn', 'midIn', 'oIn'].map(k => window.__c[p + k] || 0)
const held = (id) => window.__manifestHeld(document.getElementById(id))

describe('nested holds replay each control once', () => {
    it('inner held and started in the same task as the outer', async () => {
        insert('a', 'x-carousel', 'x-export')
        await settle()
        expect(held('ao')).toBe(true)
        document.getElementById('af').value = 'ab'
        // The inner module runs in the next task, before the outer restore's timer (as a script that already downloaded)
        Alpine.directive('carousel', () => { })
        let innerHeld = null
        setTimeout(() => { innerHeld = held('ai'); Alpine.directive('export', () => { }) }, 0)
        await settle()
        expect(innerHeld).toBe(true)
        expect(counts('a')).toEqual([1, 1, 1, 1, 1])
        expect(Alpine.$data(document.getElementById('af')).t).toBe('ab')
    })

    it('outer first, inner module later', async () => {
        insert('b', 'x-chart', 'x-date')
        await settle()
        document.getElementById('bf').value = 'ab'
        Alpine.directive('chart', () => { })
        await settle()
        expect(held('bi')).toBe(true)
        expect(counts('b')).toEqual([0, 0, 0, 0, 0])
        Alpine.directive('date', () => { })
        await settle()
        expect(counts('b')).toEqual([1, 1, 1, 1, 1])
        expect(Alpine.$data(document.getElementById('bf')).t).toBe('ab')
    })

    it('inner module first: no inner hold, the outer replays', async () => {
        insert('c', 'x-virtual', 'x-colorpicker')
        await settle()
        document.getElementById('cf').value = 'ab'
        Alpine.directive('colorpicker', () => { })
        await settle()
        Alpine.directive('virtual', () => { })
        await settle()
        expect(held('ci')).toBe(false)
        expect(counts('c')).toEqual([1, 1, 1, 1, 1])
    })

    it('an inner hold that gives up still replays once', async () => {
        const append = document.head.appendChild.bind(document.head)
        const spy = vi.spyOn(document.head, 'appendChild').mockImplementation((n) => {
            if (n.tagName === 'SCRIPT' && /manifest\.svg/.test(n.src)) { setTimeout(() => n.onerror && n.onerror(new Event('error')), 5); return n }
            return append(n)
        })
        insert('d', 'x-combobox', 'x-svg')
        await settle()
        document.getElementById('df').value = 'ab'
        Alpine.directive('combobox', () => { })
        await settle(40)
        expect(counts('d')).toEqual([1, 1, 1, 1, 1])
        spy.mockRestore()
    })

    it('a control that is itself a nested hold replays once', async () => {
        document.getElementById('host').insertAdjacentHTML('beforeend', `<div id="eo" x-markdown="m" x-data="{ t: '' }" @input="count('eoIn')"><input id="ef" x-code x-model="t" @input="count('efIn')"></div>`)
        await settle()
        document.getElementById('ef').value = 'ab'
        Alpine.directive('markdown', () => { })
        let innerHeld = null
        setTimeout(() => { innerHeld = held('ef'); Alpine.directive('code', () => { }) }, 0)
        await settle()
        expect(innerHeld).toBe(true)
        expect([window.__c.efIn, window.__c.eoIn]).toEqual([1, 1])
    })

    it('listeners outside the outer root see no replay', () => {
        expect(window.__c.nativeOut || 0).toBe(0)
    })
})
