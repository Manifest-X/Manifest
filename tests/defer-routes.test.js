/**
 * @vitest-environment happy-dom
 *
 * Route-level deferral (spike, opt-in): with the flag on, an inactive [x-route] pane keeps its
 * subtree stashed until the router activates it. The router's visibility subscript runs for
 * real (main + visibility); navigation is simulated by moving the current route and firing
 * manifest:route-change, exactly as manifest.router.navigation.js does.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const idleQueue = []
window.requestIdleCallback = (fn) => { idleQueue.push(fn); return idleQueue.length }
window.cancelIdleCallback = () => { }
const drain = () => { let n = 0; while (idleQueue.length && n++ < 1000) idleQueue.shift()({ didTimeout: false, timeRemaining: () => 50 }) }

window.__manifestLoaderStarted = true
window.ensureTabsPluginInitialized = () => { }
window.Alpine = Alpine
window.counts = {}
window.ManifestDeferConfig = { routes: true }

// Router state the visibility subscript reads
let currentRoute = '/'
window.ManifestRoutingNavigation = { getCurrentRoute: () => currentRoute }

const load = (rel) => import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(readFileSync(path.join(__dirname, rel), 'utf8')))
await load('../src/scripts/router/manifest.router.main.js')
await load('../src/scripts/router/manifest.router.visibility.js')
await load('../src/scripts/manifest.defer.js')

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick() }
const toggleEvent = (type, newState) => Object.assign(new Event(type, { bubbles: false }), { newState })
const openPopover = (el) => el.dispatchEvent(toggleEvent('beforetoggle', 'open'))
const stash = (el) => el.querySelector(':scope > template[data-mnfst-defer]')

function navigate(route) {
    currentRoute = route
    const normalizedPath = route === '/' ? '/' : route.replace(/^\/|\/$/g, '')
    window.dispatchEvent(new CustomEvent('manifest:route-change', { detail: { from: null, to: route, normalizedPath } }))
}

function mount(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    Alpine.initTree(host)
    return host
}

beforeAll(() => { Alpine.start() })
beforeEach(() => { window.counts = {}; window.ManifestDeferConfig.routes = true; navigate('/') })

describe('flag off', () => {
    it('leaves inactive routes fully initialised, as today', () => {
        window.ManifestDeferConfig.routes = false
        const host = mount(`<div x-data>
            <div x-route="/off" hidden id="off"><p x-init="counts.off = 1"></p><menu popover id="off-menu"><li x-init="counts.offMenu = 1"></li></menu></div>
        </div>`)
        const route = host.querySelector('#off')
        expect(route.__mnfstDefer).toBeFalsy()
        expect(window.counts.off).toBe(1)
        expect(host.querySelector('#off-menu').__mnfstDefer).toBeTruthy() // closed menus still defer
        expect(window.ManifestDefer.stats().routes.enabled).toBe(false)
    })
})

describe('flag on', () => {
    it('stashes an inactive route at init; its own directives still run; the active route at load is eager', () => {
        const host = mount(`<div x-data>
            <div x-route="/" id="home"><p x-init="counts.home = 1"></p></div>
            <div x-route="/away" hidden x-data="{ n: 7 }" :data-n="n" id="away"><p x-init="counts.away = 1"></p></div>
            <div x-route="/never-hidden" id="unhidden"><p x-init="counts.unhidden = 1"></p></div>
        </div>`)
        expect(window.counts.home).toBe(1)
        expect(host.querySelector('#home').__mnfstDefer).toBeFalsy()
        const away = host.querySelector('#away')
        expect(away.__mnfstDefer.rule).toBe('route')
        expect(stash(away)).toBeTruthy()
        expect(away.getAttribute('data-n')).toBe('7')
        expect(window.counts.away).toBeUndefined()
        // Not yet hidden by the router, but inactive for the URL: still stashed (component roots arrive this way)
        expect(host.querySelector('#unhidden').__mnfstDefer.rule).toBe('route')
        expect(window.counts.unhidden).toBeUndefined()
        expect(window.ManifestDefer.stats().routes.stashed).toBeGreaterThanOrEqual(2)
    })

    it('never prewarms a stashed route', () => {
        mount(`<div x-data><div x-route="/cold" hidden id="cold"><p x-init="counts.cold = 1"></p></div></div>`)
        window.dispatchEvent(new CustomEvent('manifest:ready'))
        drain()
        expect(window.counts.cold).toBeUndefined()
        expect(window.ManifestDefer.isPending(document.getElementById('cold'))).toBe(true)
    })

    it('renders on activation while still hidden, then nested menus register and open on demand', () => {
        const host = mount(`<div x-data>
            <div x-route="/page" hidden id="page">
                <p x-init="counts.page = (counts.page || 0) + 1" x-text="'body'"></p>
                <menu popover id="page-menu"><li x-init="counts.menu = (counts.menu || 0) + 1">A</li></menu>
            </div>
        </div>`)
        const page = host.querySelector('#page')
        let hiddenAtRender = null
        page.addEventListener('manifest:defer-render', () => { hiddenAtRender = page.hasAttribute('hidden') })
        navigate('/page')
        expect(window.counts.page).toBe(1)
        expect(hiddenAtRender).toBe(true)
        expect(page.hasAttribute('hidden')).toBe(false)
        expect(page.style.display).toBe('')
        expect(page.querySelector('p').textContent).toBe('body')
        const menu = page.querySelector('#page-menu')
        expect(menu.__mnfstDefer).toBeTruthy()
        expect(window.counts.menu).toBeUndefined()
        openPopover(menu)
        expect(window.counts.menu).toBe(1)
        expect(window.ManifestDefer.stats().routes.rendered).toBeGreaterThanOrEqual(1)
    })

    it('keeps a visited route alive: no re-init, same nodes, state intact', () => {
        const host = mount(`<div x-data><div x-route="/keep" hidden id="keep"><p x-init="counts.keep = (counts.keep || 0) + 1"></p><input></div></div>`)
        const keep = host.querySelector('#keep')
        navigate('/keep')
        const input = keep.querySelector('input')
        input.value = 'typed'
        navigate('/')
        expect(keep.hasAttribute('hidden')).toBe(true)
        expect(keep.querySelector('input')).toBe(input)
        expect(stash(keep)).toBeNull()
        navigate('/keep')
        expect(window.counts.keep).toBe(1)
        expect(keep.querySelector('input')).toBe(input)
        expect(input.value).toBe('typed')
    })

    it('.discard tears a route down when it hides and re-renders fresh next time', async () => {
        const host = mount(`<div x-data><div x-route="/gone" hidden x-defer.discard id="gone"><p x-init="counts.gone = (counts.gone || 0) + 1"></p><input></div></div>`)
        const gone = host.querySelector('#gone')
        navigate('/gone')
        expect(window.counts.gone).toBe(1)
        const first = gone.querySelector('input')
        navigate('/')
        await settle()
        expect(gone.querySelector('input')).toBeNull()
        expect(stash(gone)).toBeTruthy()
        navigate('/gone')
        expect(window.counts.gone).toBe(2)
        expect(gone.querySelector('input')).not.toBe(first)
    })

    it('falls back to hidden removal when something other than the router unhides the pane', async () => {
        const host = mount(`<div x-data><div x-route="/manual" hidden id="manual"><p x-init="counts.manual = 1"></p></div></div>`)
        const manual = host.querySelector('#manual')
        manual.removeAttribute('hidden')
        await settle()
        expect(window.counts.manual).toBe(1)
    })

    it('adopts a stash serialized by an earlier session', () => {
        const host = mount(`<div x-data><div x-route="/pre" hidden id="pre"><template data-mnfst-defer><p x-init="counts.pre = 1">A</p></template></div></div>`)
        const pre = host.querySelector('#pre')
        expect(pre.children.length).toBe(1)
        expect(stash(pre).content.querySelector('template')).toBeNull()
        navigate('/pre')
        expect(window.counts.pre).toBe(1)
        expect(pre.querySelector('p').textContent).toBe('A')
    })

    it('nested routes revealed by a render get the same pass: matching child eager, sibling stashed and hidden', () => {
        const host = mount(`<div x-data>
            <div x-route="docs" hidden id="outer">
                <div x-route="docs/intro" id="intro"><p x-init="counts.intro = (counts.intro || 0) + 1"></p></div>
                <div x-route="docs/other" id="other"><p x-init="counts.other = (counts.other || 0) + 1"></p></div>
            </div>
        </div>`)
        navigate('/docs/intro')
        const intro = host.querySelector('#intro'), other = host.querySelector('#other')
        expect(window.counts.intro).toBe(1)
        expect(intro.hasAttribute('hidden')).toBe(false)
        expect(intro.__mnfstDefer).toBeFalsy()
        expect(window.counts.other).toBeUndefined()
        expect(other.__mnfstDefer.rule).toBe('route')
        expect(other.hasAttribute('hidden')).toBe(true)
        navigate('/docs/other')
        expect(window.counts.other).toBe(1)
        expect(other.hasAttribute('hidden')).toBe(false)
        expect(intro.hasAttribute('hidden')).toBe(true)
        expect(window.counts.intro).toBe(1)
    })

    it('x-route="!*" counts routes stashed inside a deferred pane as defined', () => {
        const host = mount(`<div x-data>
            <div x-route="=area" hidden id="area"><div x-route="area/deep" id="deep"><p x-init="counts.deep = 1"></p></div></div>
            <div x-route="!*" hidden id="nf"><p x-init="counts.nf = (counts.nf || 0) + 1"></p></div>
        </div>`)
        expect(host.querySelector('#nf').__mnfstDefer.rule).toBe('route')
        navigate('/area/deep')
        expect(window.counts.nf).toBeUndefined() // defined by the stashed nested route, as it is without deferral
        expect(host.querySelector('#nf').hasAttribute('hidden')).toBe(true)
        navigate('/no-such-page')
        expect(window.counts.nf).toBe(1)
        expect(host.querySelector('#nf').hasAttribute('hidden')).toBe(false)
    })

    it('x-defer.off keeps a route eager', () => {
        mount(`<div x-data><div x-route="/eager" hidden x-defer.off id="eager"><p x-init="counts.eager = 1"></p></div></div>`)
        expect(document.getElementById('eager').__mnfstDefer).toBeFalsy()
        expect(window.counts.eager).toBe(1)
    })
})
