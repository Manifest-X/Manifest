/**
 * @vitest-environment happy-dom
 *
 * An on-use module that arrives after Alpine started (content inserted with innerHTML or
 * x-html, Manifest.loadPlugin): elements Alpine walked before its directive existed are
 * walked again once it registers, exactly once, and elements walked after are left alone.
 * Its magics answer with an idle stand-in until then, so expressions never throw, and
 * readers re-run against the real magic once it registers.
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

const warnings = []
beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })))
    if (typeof performance.getEntriesByName !== 'function') performance.getEntriesByName = () => []
    vi.spyOn(console, 'warn').mockImplementation((...a) => warnings.push(a.join(' ')))
    vi.spyOn(console, 'error').mockImplementation((...a) => warnings.push(a.join(' ')))
    window.happyDOM.setURL('https://site.example/')
    document.body.innerHTML = `<div id="app" x-data="{ n: 1 }">
        <div id="early" x-chart.bar="n"></div>
        <div id="outer" x-carousel><span id="inner" x-text="typeof slides"></span></div>
        <p id="date" x-text="'v:' + String($date)"></p>
        <p id="chart" x-text="'c:' + String($chart('a').id)"></p>
        <button id="exp" @click="$export({ format: 'csv' })">e</button>
    </div>`
    new Function(CODE)()
    window.Alpine = Alpine
    Alpine.start()
    await settle()
})

describe('late on-use modules', () => {
    it('magics read before their module arrives answer idle, without errors', async () => {
        expect(document.getElementById('date').textContent).toBe('v:')
        expect(document.getElementById('chart').textContent).toBe('c:')
        document.getElementById('exp').click()
        await settle()
        expect(warnings.filter(w => /Expression Error|not defined/.test(w))).toEqual([])
    })

    it('a directive registered after start walks elements Alpine passed before, once', async () => {
        const ran = []
        Alpine.directive('chart', (el, { modifiers }) => { ran.push(el.id + ':' + modifiers.join('.')) })
        await settle()
        expect(ran).toEqual(['early:bar'])
        // Inserted after registration: Alpine's own walk runs it, no second pass
        document.getElementById('app').insertAdjacentHTML('beforeend', '<div id="later" x-chart></div>')
        await settle()
        expect(ran).toEqual(['early:bar', 'later:'])
    })

    it('a scope-providing directive reaches children walked before it existed', async () => {
        Alpine.directive('carousel', (el) => { Alpine.bind(el, { 'x-data'() { return { slides: [1, 2] } } }) })
        await settle()
        expect(document.getElementById('inner').textContent).toBe('object')
    })

    it('readers re-run against the real magic once it registers', async () => {
        Alpine.magic('date', () => 'real-date')
        Alpine.magic('chart', () => (id) => ({ id: 'chart-' + id }))
        await settle()
        expect(document.getElementById('date').textContent).toBe('v:real-date')
        expect(document.getElementById('chart').textContent).toBe('c:chart-a')
        let called = null
        Alpine.magic('export', () => (opts) => { called = opts })
        document.getElementById('exp').click()
        expect(called).toEqual({ format: 'csv' })
    })

    it('directives outside the on-use set are untouched', async () => {
        const ran = []
        document.getElementById('app').insertAdjacentHTML('beforeend', '<div id="own" x-mine></div>')
        await settle()
        Alpine.directive('mine', (el) => ran.push(el.id))
        await settle()
        expect(ran).toEqual([])
    })
})
