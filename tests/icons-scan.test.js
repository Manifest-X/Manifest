// @vitest-environment happy-dom
/**
 * Icons render where they are created; Iconify's document observer (a rescan
 * of every rendered icon on any insertion) stays paused.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.icons.js'), 'utf8')
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const HOUSE = { body: '<path d="M0 0h24v24H0z"/>', width: 24, height: 24 }
const STAR = { body: '<path d="M1 1h2v2H1z"/>', width: 24, height: 24 }

let processIcon

beforeAll(async () => {
    document.body.innerHTML = '<div id="list"></div>'
    new Function(SRC + '\nwindow.__processIcon = processIconElement;')()
    processIcon = window.__processIcon
    window.Iconify._api.setFetch(() => new Promise(() => {})) // no network
    window.Iconify.addIcon('lucide:house', HOUSE)
    window.Iconify.addIcon('lucide:star', STAR)
    await wait(30)
})

const host = (tag = 'i') => document.getElementById('list').appendChild(document.createElement(tag))

describe('icons scan where they are created', () => {
    it('a held icon renders synchronously', () => {
        const el = host()
        processIcon(el, 'lucide:house')
        expect(el.querySelector('svg.iconify')?.getAttribute('data-icon')).toBe('lucide:house')
    })

    it('a changed icon name re-renders in place', () => {
        const el = host()
        processIcon(el, 'lucide:house')
        processIcon(el, 'lucide:star')
        expect(el.querySelectorAll('svg')).toHaveLength(1)
        expect(el.querySelector('svg').getAttribute('data-icon')).toBe('lucide:star')
        expect(el.innerHTML).toContain('M1 1h2v2H1z')
    })

    it('an <li> keeps its text and gets the icon inside its x-icon wrapper, sync', () => {
        const li = host('li')
        li.textContent = 'Item'
        processIcon(li, 'lucide:house')
        expect(li.querySelector('span[x-icon] > svg.iconify')).not.toBeNull()
        expect(li.textContent).toContain('Item')
        processIcon(li, 'lucide:star')
        expect(li.querySelector('svg').getAttribute('data-icon')).toBe('lucide:star')
    })

    it('an icon whose data arrives later renders without another insertion', async () => {
        const el = host()
        processIcon(el, 'lucide:late')
        expect(el.querySelector('svg')).toBeNull()
        window.Iconify.addIcon('lucide:late', STAR)
        window.Iconify.scan(el)
        expect(el.querySelector('svg')).not.toBeNull()
    })

    it('authored Iconify placeholders added later still render', async () => {
        const wrap = document.createElement('div')
        wrap.innerHTML = '<p><span class="iconify" data-icon="lucide:house"></span></p>'
        document.getElementById('list').appendChild(wrap)
        const direct = document.createElement('span')
        direct.className = 'iconify'
        direct.setAttribute('data-icon', 'lucide:house')
        const parent = host('div')
        parent.appendChild(direct)
        await wait(20)
        expect(wrap.querySelector('svg.iconify')).not.toBeNull()
        expect(parent.querySelector('svg.iconify')).not.toBeNull()
    })

    it('an unrelated insertion never re-reads the rendered icons', async () => {
        for (let i = 0; i < 300; i++) processIcon(host(), 'lucide:house')
        await wait(30)
        const rendered = document.querySelectorAll('svg.iconify').length
        expect(rendered).toBeGreaterThanOrEqual(300)
        let reads = 0
        const original = window.Element.prototype.getAttribute
        window.Element.prototype.getAttribute = function (...args) {
            if (this.localName === 'svg') reads++
            return original.apply(this, args)
        }
        try {
            for (let i = 0; i < 10; i++) document.body.appendChild(document.createElement('div'))
            await wait(40)
        } finally {
            window.Element.prototype.getAttribute = original
        }
        expect(reads).toBe(0)
    })
})
