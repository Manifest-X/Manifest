/**
 * @vitest-environment happy-dom
 *
 * Tabs: a tab and panel added to an existing group later initialise on their own; nothing
 * else on the page is walked or re-initialised.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const wait = (ms) => new Promise(r => setTimeout(r, ms))

window.Alpine = Alpine
window.inits = 0

beforeAll(async () => {
    document.body.innerHTML = `
        <div id="other" x-data x-init="inits++"><span x-init="inits++"></span></div>
        <section id="group">
            <nav><button x-tab="one">One</button><button x-tab="two">Two</button></nav>
            <div x-tabpanel id="one">Panel one</div>
            <div x-tabpanel id="two">Panel two</div>
            <p x-init="inits++">sibling</p>
        </section>`
    new Function(readFileSync(path.join(__dirname, '../src/scripts/manifest.tabs.js'), 'utf8'))()
    Alpine.start()
    await wait(250)
})

const visible = (id) => document.getElementById(id).style.display !== 'none'

describe('tabs added after the group initialised', () => {
    it('the initial group works', async () => {
        expect(visible('one')).toBe(true)
        expect(visible('two')).toBe(false)
        expect(window.inits).toBe(3)
    })

    it('adding one tab + panel re-runs no x-init and walks nothing outside the new nodes', async () => {
        const initTree = vi.spyOn(Alpine, 'initTree')
        const group = document.getElementById('group')
        const btn = document.createElement('button')
        btn.setAttribute('x-tab', 'three')
        btn.textContent = 'Three'
        group.querySelector('nav').appendChild(btn)
        const panel = document.createElement('div')
        panel.setAttribute('x-tabpanel', '')
        panel.id = 'three'
        panel.textContent = 'Panel three'
        group.appendChild(panel)
        await wait(250)

        expect(window.inits).toBe(3)
        const roots = initTree.mock.calls.map(([el]) => el)
        for (const el of roots) expect(el === btn || el === panel).toBe(true)
        initTree.mockRestore()

        expect(visible('three')).toBe(false)
        btn.click()
        await wait(20)
        expect(visible('three')).toBe(true)
        expect(visible('one')).toBe(false)
        group.querySelector('button').click()
        await wait(20)
        expect(visible('one')).toBe(true)
        expect(visible('three')).toBe(false)
    })

    it('a whole named group added later works', async () => {
        const box = document.createElement('div')
        box.innerHTML = '<button x-tab="ga">A</button><button x-tab="gb">B</button><div x-tabpanel="late" id="ga">A</div><div x-tabpanel="late" id="gb">B</div>'
        document.body.appendChild(box)
        await wait(250)
        expect(window.inits).toBe(3)
        expect(visible('ga')).toBe(true)
        expect(visible('gb')).toBe(false)
        box.querySelectorAll('button')[1].click()
        await wait(20)
        expect(visible('gb')).toBe(true)
        expect(visible('ga')).toBe(false)
    })
})
