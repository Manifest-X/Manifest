/**
 * @vitest-environment happy-dom
 *
 * Multi-month x-date initial view: with `max`, panels past max's month were
 * entirely disabled. The view now opens with max's month as the last panel
 * (and min's month as the first), keeping any selection visible. Prev/next
 * navigation is unchanged.
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

const panels = (cal) => [...cal.querySelectorAll('section')]
    .map(s => s.querySelector('button[role=gridcell]:not(.outside)').value.slice(0, 7))

beforeAll(() => { Alpine.start() })
afterAll(() => { vi.useRealTimers() })

describe('x-date initial view with max', () => {
    it('months 2, max today: previous and current month', async () => {
        const cal = await mount(`<div x-date="{ months: 2, max: '2026-10-19' }"></div>`)
        expect(panels(cal)).toEqual(['2026-09', '2026-10'])
    })

    it('months 3, max next month: max month is the last panel', async () => {
        const cal = await mount(`<div x-date="{ months: 3, max: '2026-11-05' }"></div>`)
        expect(panels(cal)).toEqual(['2026-09', '2026-10', '2026-11'])
    })

    it('native max attribute on a field trigger', async () => {
        const input = await mount(`<input x-date="{ months: 2 }" max="2026-10-19">`)
        expect(panels(document.getElementById(input.getAttribute('aria-controls')))).toEqual(['2026-09', '2026-10'])
    })

    it('unchanged without max, with one month, or when max is far enough ahead', async () => {
        expect(panels(await mount(`<div x-date="{ months: 2 }"></div>`))).toEqual(['2026-10', '2026-11'])
        expect(panels(await mount(`<div x-date="{ max: '2026-10-19' }"></div>`))).toEqual(['2026-10'])
        expect(panels(await mount(`<div x-date="{ months: 2, max: '2026-12-01' }"></div>`))).toEqual(['2026-10', '2026-11'])
    })

    it('single value in max month sits in the last panel', async () => {
        const cal = await mount(`<div x-date="{ months: 2, max: '2026-10-19' }" value="2026-10-03"></div>`)
        expect(panels(cal)).toEqual(['2026-09', '2026-10'])
    })

    it('single value earlier than the window keeps its own view', async () => {
        const cal = await mount(`<div x-date="{ months: 2, max: '2026-10-19' }" value="2026-06-10"></div>`)
        expect(panels(cal)).toEqual(['2026-06', '2026-07'])
    })

    it('range ending in max month: end in the last panel', async () => {
        const cal = await mount(`<div x-date.range="{ months: 2, max: '2026-10-19' }" value="2026-10-01/2026-10-15"></div>`)
        expect(panels(cal)).toEqual(['2026-09', '2026-10'])
    })

    it('range spanning two months stays as is', async () => {
        const cal = await mount(`<div x-date.range="{ months: 2, max: '2026-10-19' }" value="2026-09-20/2026-10-19"></div>`)
        expect(panels(cal)).toEqual(['2026-09', '2026-10'])
    })

    it('a value past max is left visible', async () => {
        const cal = await mount(`<div x-date="{ months: 2, max: '2026-10-19' }" value="2026-12-01"></div>`)
        expect(panels(cal)).toEqual(['2026-12', '2027-01'])
    })

    it('prev and next still step one month', async () => {
        const cal = await mount(`<div x-date="{ months: 2, max: '2026-10-19' }"></div>`)
        const nav = () => cal.querySelectorAll('header > button')
        nav()[2].click()
        expect(panels(cal)).toEqual(['2026-10', '2026-11'])
        nav()[0].click()
        nav()[0].click()
        expect(panels(cal)).toEqual(['2026-08', '2026-09'])
    })

    it('crosses the year boundary', async () => {
        const cal = await mount(`<div x-date="{ months: 4, max: '2026-11-30', min: '2026-01-01' }"></div>`)
        expect(panels(cal)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11'])
        const jan = await mount(`<div x-date="{ months: 2, max: '2027-01-02' }" value="2027-01-02"></div>`)
        expect(panels(jan)).toEqual(['2026-12', '2027-01'])
    })
})

describe('x-date initial view with min', () => {
    it('min after today opens on the min month', async () => {
        const cal = await mount(`<div x-date="{ months: 2, min: '2026-12-01' }"></div>`)
        expect(panels(cal)).toEqual(['2026-12', '2027-01'])
    })

    it('min in the past changes nothing', async () => {
        const cal = await mount(`<div x-date="{ months: 2, min: '2026-01-01' }"></div>`)
        expect(panels(cal)).toEqual(['2026-10', '2026-11'])
    })
})
