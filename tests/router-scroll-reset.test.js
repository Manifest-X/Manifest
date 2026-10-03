/**
 * @vitest-environment happy-dom
 *
 * Route-change scroll reset on a large page: only containers that actually
 * scrolled are inspected (no document-wide getComputedStyle sweep per click),
 * and a scrolled container is still reset on every real route change.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

window.Alpine = Alpine

const counts = { gcs: 0 }
const gcs = window.getComputedStyle.bind(window)
window.getComputedStyle = (...args) => { counts.gcs++; return gcs(...args) }
window.scrollTo = () => { }

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function scrollable(el) {
    let top = 0
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
    // Chrome: under display:none scrollTop reads 0 and has no client rects, but the offset survives
    const hidden = () => !!el.closest('[hidden]')
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => hidden() ? 0 : top, set: (v) => { if (!hidden()) top = v } })
    el.getClientRects = () => hidden() ? [] : [{ width: 1, height: 1 }]
    el.__offset = () => top
    return el
}
function scroll(el, y) {
    el.scrollTop = y
    el.dispatchEvent(new Event('scroll'))
}
function navigate(href) {
    const a = document.createElement('a')
    a.setAttribute('href', href)
    document.body.appendChild(a)
    a.click()
    a.remove()
}

beforeAll(async () => {
    document.body.innerHTML = `
        <main id="main">
            <div x-route="records" id="records">
                <div id="list" style="overflow-y: auto; height: 400px"></div>
                <section id="detail" style="overflow: auto"></section>
            </div>
            ${Array.from({ length: 600 }, (_, i) => `<div x-route="page-${i % 40}" style="overflow: auto"><section><article>${i}</article></section></div>`).join('')}
        </main>`
    scrollable(document.getElementById('list'))
    scrollable(document.getElementById('detail'))
    history.replaceState(null, '', '/records')
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(
        readFileSync(path.join(__dirname, '../lib/manifest.router.js'), 'utf8')
    ))
    await wait(20)
    // First change after a late load sweeps once (elements may have scrolled before the router listened)
    navigate('/records/contacts/c0')
    await wait(80)
})

describe('scroll reset on route change', () => {
    it('inspects only scrolled containers, not the whole document', async () => {
        const list = document.getElementById('list')
        scroll(list, 300)
        counts.gcs = 0
        navigate('/records/contacts/c1')
        await wait(80)
        expect(list.scrollTop).toBe(0)
        expect(counts.gcs).toBeLessThanOrEqual(1)
    })

    it('leaves containers that never scrolled alone and costs nothing when none did', async () => {
        counts.gcs = 0
        navigate('/records/contacts/c2')
        await wait(80)
        expect(counts.gcs).toBe(0)
    })

    it('resets every container scrolled since the last change', async () => {
        const list = document.getElementById('list')
        const detail = document.getElementById('detail')
        scroll(list, 120)
        scroll(detail, 900)
        navigate('/page-3')
        await wait(80)
        expect(list.scrollTop).toBe(0)
        expect(detail.scrollTop).toBe(0)
    })

    it('resets a container whose route was hidden when the reset ran, once it shows again', async () => {
        navigate('/records')
        await wait(80)
        const list = document.getElementById('list')
        scroll(list, 300)
        navigate('/page-3') // records hidden before the reset runs
        await wait(80)
        expect(list.__offset()).toBe(300)
        navigate('/records')
        await wait(80)
        expect(list.__offset()).toBe(0)
    })

    it('does not reset for anchor navigation', async () => {
        const list = document.getElementById('list')
        scroll(list, 50)
        navigate('/records#top')
        await wait(80)
        expect(list.scrollTop).toBe(50)
    })
})
