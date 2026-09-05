/**
 * @vitest-environment happy-dom
 *
 * x-combobox reads its options from a source menu's rendered <li> rows. When that
 * source sits under x-defer (auto-stashed: popover menus defer by default), the rows
 * don't exist yet — x-for hasn't run — so a naive read falls back to the raw id.
 * These tests reproduce the stash the way manifest.defer.js builds it (via real Alpine
 * init over a popover <menu>, same as defer.test.js) and confirm the combobox hydrates
 * the source before reading it.
 *
 * The second describe block below reproduces a distinct, later regression: a
 * `<dialog popover>`/`[popover]` ancestor can itself be mid-restash — manifest.defer's
 * idle prewarm speculatively renders a still-closed container (scheduling its
 * x-combobox's build() one macrotask later) and its idle-driven eviction can re-stash
 * that same container's subtree back into a `<template>` BEFORE that build() runs.
 * build() then appended the generated menu into a now-disconnected ancestor. The idle
 * queue is captured (same technique as defer.test.js) so prewarm/evict can be stepped
 * deterministically instead of racing real timers.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Idle callbacks are captured so prewarm can be stepped one slice at a time (mirrors
// defer.test.js). A low cap makes the prewarm/evict race reproducible with just two
// containers instead of needing dozens.
window.ManifestDeferConfig = { prewarmCap: 1 }
const idleQueue = []
let idleId = 0
window.requestIdleCallback = (fn) => { const id = ++idleId; idleQueue.push({ id, fn }); return id }
window.cancelIdleCallback = (id) => { const i = idleQueue.findIndex((x) => x.id === id); if (i >= 0) idleQueue.splice(i, 1) }
const BATCH_DEADLINE = { didTimeout: false, timeRemaining: () => 50 }
const runIdle = () => { const job = idleQueue.shift(); if (job) job.fn(BATCH_DEADLINE) }
window.__manifestLoaderStarted = true
window.Alpine = Alpine

const load = (file) => import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
    readFileSync(path.join(__dirname, '../src/scripts/' + file), 'utf8')
))
await load('manifest.defer.js')
await load('manifest.combobox.js')
window.ensureComboboxPluginInitialized()

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }
const toggleEvent = (type, newState) => Object.assign(new Event(type, { bubbles: false }), { newState })
const openPopover = (el) => el.dispatchEvent(toggleEvent('beforetoggle', 'open'))

function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

const items = (id) => `
    <template x-for="item in items" :key="item.id">
        <li :data-value="item.id" :data-label="item.name" x-text="item.name"></li>
    </template>`

beforeAll(() => { Alpine.start() })

describe('combobox reads a deferred source', () => {
    it('resolves chip labels (not raw ids) at init through x-model', async () => {
        const host = mount(`
            <div x-data="{
                items: [ { id: 'p1', name: 'Foundry' }, { id: 'p2', name: 'Playcom' }, { id: 'p3', name: 'Acme' } ],
                tags: ['p2', 'p3']
            }">
                <menu popover id="src-a">${items()}</menu>
                <input x-combobox.multiple.chips="src-a" x-model="tags">
            </div>`)
        // Source starts stashed: x-for never ran, no <li> rows yet.
        expect(host.querySelector('#src-a > template[data-mnfst-defer]')).toBeTruthy()

        await settle()

        const labels = Array.from(host.querySelectorAll('.combobox-chip span')).map(s => s.textContent)
        expect(labels).toEqual(['Playcom', 'Acme'])
        // Source is hydrated as a side effect of the read.
        expect(host.querySelector('#src-a > template[data-mnfst-defer]')).toBeFalsy()
    })

    it('resolves all chips across several fields (6 chips / 3 fields)', async () => {
        const field = (n, a, b) => `
            <div x-data="{
                items: [ { id: '${n}1', name: '${n}-One' }, { id: '${n}2', name: '${n}-Two' }, { id: '${n}3', name: '${n}-Three' } ],
                tags: ['${n}${a}', '${n}${b}']
            }">
                <menu popover id="src-${n}">${items()}</menu>
                <input x-combobox.multiple.chips="src-${n}" x-model="tags">
            </div>`
        const host = mount(field('x', 1, 2) + field('y', 2, 3) + field('z', 1, 3))
        await settle()

        const labels = Array.from(host.querySelectorAll('.combobox-chip span')).map(s => s.textContent)
        expect(labels).toHaveLength(6)
        expect(labels).toEqual(['x-One', 'x-Two', 'y-Two', 'y-Three', 'z-One', 'z-Three'])
    })

    it('lists real options instead of an empty "No matches" menu', async () => {
        const host = mount(`
            <div x-data="{ items: [ { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' } ] }">
                <menu popover id="src-b">${items()}</menu>
                <input x-combobox="src-b">
            </div>`)
        await settle()

        const input = host.querySelector('input')
        const genMenu = document.getElementById(input.getAttribute('aria-controls'))
        const optLabels = Array.from(genMenu.querySelectorAll('li[role=option]')).map(li => li.dataset.label)
        expect(optLabels).toEqual(['Alpha', 'Beta'])
    })
})

describe('combobox regressions', () => {
    it('still resolves labels when the source was never deferred', async () => {
        const host = mount(`
            <div x-data="{ items: [ { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' } ] }">
                <menu id="src-c">${items()}</menu>
                <input x-combobox="src-c" value="b">
            </div>`)
        await settle()
        expect(host.querySelector('input').value).toBe('Beta')
    })

    it('does not throw when ManifestDefer is absent', async () => {
        const saved = window.ManifestDefer
        delete window.ManifestDefer
        try {
            const host = mount(`
                <div x-data="{ items: [ { id: 'a', name: 'Alpha' } ] }">
                    <menu popover id="src-d">${items()}</menu>
                    <input x-combobox="src-d" value="a">
                </div>`)
            await expect(settle()).resolves.not.toThrow()
            // Still functions without the defer API — falls back to today's (possibly
            // stale) read rather than crashing.
            expect(host.querySelector('input')).toBeTruthy()
        } finally {
            window.ManifestDefer = saved
        }
    })
})

describe('combobox inside a deferred [popover]/dialog (client-blocking regression)', () => {
    // Earlier tests in this file leave mounted hosts (and their defer records) sitting
    // in the document; the eviction race below depends on tie-break/score ordering
    // among exactly the containers each test cares about, so start each one clean.
    beforeEach(() => {
        document.body.innerHTML = ''
        idleQueue.length = 0
    })

    it('connects the generated menu once a plain closed dialog popover opens', async () => {
        // No prewarm/eviction involved — a single closed dialog, opened for real.
        // This already worked pre-fix; kept as a baseline so a future change can't
        // silently break the common (non-raced) case while "fixing" the race.
        const host = mount(`<div x-data>
            <dialog popover id="dlg-plain">
                <input x-combobox="opts-plain" id="inp-plain">
                <menu popover id="opts-plain"><li data-value="a">Alpha</li></menu>
            </dialog>
        </div>`)
        const dlg = host.querySelector('#dlg-plain')
        openPopover(dlg)
        await settle()   // build() is scheduled a macrotask after the directive fires
        const input = host.querySelector('#inp-plain')
        const controls = input.getAttribute('aria-controls')
        expect(controls).toBeTruthy()
        expect(document.getElementById(controls)).toBeTruthy()
    })

    // Force both containers past the prewarm cap in a single idle slice: fire
    // manifest:ready with NOTHING pending yet (so bootDrained flips true immediately —
    // promoteNearViewport refuses to run otherwise), then mount and mock each
    // invoker's rect so the gesture-promotion (promoteNearViewport) marks BOTH urgent.
    // Urgent renders bypass the per-slice cap check, so both render synchronously in
    // one runIdle() call, and evict() (called at the end of that same call, still
    // before either combobox's setTimeout(0) build has had a chance to fire) trims
    // back down to the cap. Mirrors the real trigger: a page-browsing gesture (mouse
    // move/click) reaching the idle scheduler while several closed dialogs are pending.
    async function raceOneContainerPastCap(html, raceId, padId) {
        window.dispatchEvent(new CustomEvent('manifest:ready'))
        const host = mount(html)
        const raceBtn = document.querySelector(`[popovertarget="${raceId}"]`)
        const padBtn = document.querySelector(`[popovertarget="${padId}"]`)
        const rect = { top: 10, bottom: 40, left: 10, right: 100, width: 90, height: 30 }
        raceBtn.getBoundingClientRect = () => rect
        padBtn.getBoundingClientRect = () => rect
        document.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { clientX: 50, clientY: 25 }))
        await new Promise((r) => setTimeout(r, 100))   // let the (real-timer) promoteTimer fire
        runIdle()   // renders both (urgent, bypassing the cap), then evict() trims one —
                    // synchronous, so this all happens before either combobox's build() runs
        return host
    }

    it('reattaches the generated menu when its owning dialog is mid-restash when build() runs (prewarm/evict race)', async () => {
        const host = await raceOneContainerPastCap(`<div x-data>
            <button popovertarget="dlg-race">open</button>
            <dialog popover id="dlg-race">
                <input x-combobox="opts-race" id="inp-race">
                <menu popover id="opts-race"><li data-value="a">Alpha</li></menu>
            </dialog>
            <button popovertarget="dlg-pad">open</button>
            <dialog popover id="dlg-pad"><p>padding</p></dialog>
        </div>`, 'dlg-race', 'dlg-pad')

        const dlg = host.querySelector('#dlg-race')
        expect(dlg.__mnfstDefer.rendered).toBe(false)   // confirms the race actually happened
        expect(host.querySelector('#inp-race')).toBeNull()   // stashed away, not in the live tree

        await settle()   // now let the pending build() actually run

        // Fixed: build() detects the owner is disconnected, reattach() and the re-entry
        // repair keep the menu connected. Broken: aria-controls points at an id that
        // exists nowhere connected to `document`.
        const stashedInput = dlg.querySelector('template[data-mnfst-defer]').content.querySelector('#inp-race')
        expect(stashedInput).toBeTruthy()
        const controls = stashedInput.getAttribute('aria-controls')
        expect(controls).toBeTruthy()
        expect(document.getElementById(controls)).toBeTruthy()
        const menu = document.getElementById(controls)
        expect(menu.isConnected).toBe(true)
    })

    it('repairs a previously-raced combobox once its container is genuinely re-rendered', async () => {
        // Same race as above, but then simulate the container actually being opened
        // for real afterwards (re-render from its stash) — the field must come back
        // to life rather than staying permanently dead (el.__mnfstCombobox guards
        // against rebuilding, so a stale disconnected menu needs active repair).
        const host = await raceOneContainerPastCap(`<div x-data>
            <button popovertarget="dlg-race2">open</button>
            <dialog popover id="dlg-race2">
                <input x-combobox="opts-race2" id="inp-race2">
                <menu popover id="opts-race2"><li data-value="a">Alpha</li></menu>
            </dialog>
            <button popovertarget="dlg-pad2">open</button>
            <dialog popover id="dlg-pad2"><p>padding</p></dialog>
        </div>`, 'dlg-race2', 'dlg-pad2')
        await settle()

        const dlg = host.querySelector('#dlg-race2')
        expect(dlg.__mnfstDefer.rendered).toBe(false)

        // A real open: manifest.defer's own 'popover' wiring re-renders from the stash.
        openPopover(dlg)
        await settle()

        const input = host.querySelector('#inp-race2')
        expect(input).toBeTruthy()
        const controls = input.getAttribute('aria-controls')
        expect(controls).toBeTruthy()
        const menu = document.getElementById(controls)
        expect(menu).toBeTruthy()
        expect(menu.isConnected).toBe(true)
        expect(dlg.contains(menu)).toBe(true)
    })
})
