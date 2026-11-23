/**
 * @vitest-environment happy-dom
 *
 * x-date with x-model: an external change to an empty/non-string value must
 * clear the selection, and a later locale re-render must not write the stale
 * selection back into the model.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

vi.useFakeTimers({ toFake: ['Date'] })
vi.setSystemTime(new Date(2026, 9, 19, 10))

window.ManifestUI = { resolve: (_, fallback) => fallback }
window.Alpine = Alpine
await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/manifest.datepicker.js'), 'utf8')
))
window.ensureDatepickerPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }

async function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    await settle()
    return host.firstElementChild
}

const locale = () => Alpine.store('locale')
const scope = (el) => Alpine.$data(el)
const selectedDays = (cal) => [...cal.querySelectorAll('[aria-selected=true]')].map(b => b.value)
const calendarOf = (input) => document.getElementById(input.getAttribute('aria-controls'))

beforeAll(() => {
    Alpine.store('locale', { current: 'en', direction: 'ltr' })
    Alpine.start()
})
afterAll(() => { vi.useRealTimers() })

async function flipLocale() {
    locale().current = locale().current === 'en' ? 'de' : 'en'
    await settle()
}

describe('x-date model cleared externally', () => {
    for (const empty of [null, undefined, '', 0, {}]) {
        it(`field: model -> ${JSON.stringify(empty)} clears, locale change keeps it empty`, async () => {
            const wrap = await mount(`<div x-data="{ d: '2026-10-05' }"><input x-date x-model="d"></div>`)
            const input = wrap.querySelector('input')
            expect(selectedDays(calendarOf(input))).toEqual(['2026-10-05'])
            scope(wrap).d = empty
            await settle()
            expect(selectedDays(calendarOf(input))).toEqual([])
            expect(input.value).toBe('')
            await flipLocale()
            expect(scope(wrap).d).toEqual(empty)
            expect(selectedDays(calendarOf(input))).toEqual([])
        })
    }

    it('locale change after clearing does not write the old date back', async () => {
        const wrap = await mount(`<div x-data="{ d: '2026-10-05' }"><input x-date x-model="d"></div>`)
        scope(wrap).d = null
        await settle()
        await flipLocale()
        expect(scope(wrap).d).toBe(null)
    })

    it('inline: model -> null clears, locale change keeps it null', async () => {
        const wrap = await mount(`<div x-data="{ d: '2026-10-05' }"><div x-date x-model="d"></div></div>`)
        const cal = wrap.querySelector('[x-date]')
        expect(selectedDays(cal)).toEqual(['2026-10-05'])
        scope(wrap).d = null
        await settle()
        expect(selectedDays(cal)).toEqual([])
        await flipLocale()
        expect(scope(wrap).d).toBe(null)
    })

    it('field menu closes when the model is cleared', async () => {
        const wrap = await mount(`<div x-data="{ d: '2026-10-05' }"><input x-date x-model="d"></div>`)
        const input = wrap.querySelector('input')
        const cal = calendarOf(input)
        const closed = cal.hidePopover = vi.fn()
        vi.spyOn(cal, 'matches').mockImplementation((s) => s === ':popover-open' ? true : Element.prototype.matches.call(cal, s))
        scope(wrap).d = null
        await settle()
        expect(closed).toHaveBeenCalled()
    })

    it('range: model -> null clears, locale change keeps it null', async () => {
        const wrap = await mount(`<div x-data="{ r: { start: '2026-10-05', end: '2026-10-09' } }"><div x-date.range x-model="r"></div></div>`)
        const cal = wrap.querySelector('[x-date\\.range]')
        expect(selectedDays(cal)).toEqual(['2026-10-05', '2026-10-09'])
        scope(wrap).r = null
        await settle()
        expect(selectedDays(cal)).toEqual([])
        await flipLocale()
        expect(scope(wrap).r).toBe(null)
    })

    it('range: external change to a new range is reflected', async () => {
        const wrap = await mount(`<div x-data="{ r: { start: '2026-10-05', end: '2026-10-09' } }"><div x-date.range x-model="r"></div></div>`)
        const cal = wrap.querySelector('[x-date\\.range]')
        scope(wrap).r = { start: '2026-10-12', end: '2026-10-14' }
        await settle()
        expect(selectedDays(cal)).toEqual(['2026-10-12', '2026-10-14'])
    })

    it('multiple: model -> [] and null clear, locale change keeps them', async () => {
        const wrap = await mount(`<div x-data="{ m: ['2026-10-05', '2026-10-07'] }"><div x-date.multiple x-model="m"></div></div>`)
        const cal = wrap.querySelector('[x-date\\.multiple]')
        expect(selectedDays(cal)).toEqual(['2026-10-05', '2026-10-07'])
        scope(wrap).m = []
        await settle()
        expect(selectedDays(cal)).toEqual([])
        await flipLocale()
        expect(scope(wrap).m).toEqual([])
        scope(wrap).m = ['2026-10-09']
        await settle()
        expect(selectedDays(cal)).toEqual(['2026-10-09'])
        scope(wrap).m = null
        await settle()
        expect(selectedDays(cal)).toEqual([])
        await flipLocale()
        expect(scope(wrap).m).toBe(null)
    })

    it('a locale change alone never writes to the model', async () => {
        const wrap = await mount(`<div x-data="{ d: '2026-10-05' }"><input x-date x-model="d"></div>`)
        const input = wrap.querySelector('input')
        const before = input.value
        await flipLocale()
        expect(scope(wrap).d).toBe('2026-10-05')
        expect(input.value).not.toBe(before)
    })

    it('user selection still writes the model', async () => {
        const wrap = await mount(`<div x-data="{ d: null }"><input x-date x-model="d"></div>`)
        const input = wrap.querySelector('input')
        calendarOf(input).querySelector('button[value="2026-10-12"]').click()
        await settle()
        expect(scope(wrap).d).toBe('2026-10-12')
    })
})
