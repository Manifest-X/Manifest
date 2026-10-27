/**
 * @vitest-environment happy-dom
 *
 * Render settle: the page-side tracker (timers under 3s, frames, holds, plugin
 * counters, loading data, anchor refreshes, DOM changes), the Node-side request
 * counter and the wait that replaces the fixed quiet windows. With nothing
 * pending a page settles after a short quiet window; with anything pending it
 * uses the fixed engine's own windows (network idle, then DOM quiet). A lost
 * page context retries, then reports 'evaluate' for the fixed-window fallback.
 * Real-browser cases live in tests/e2e/render-settle.e2e.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { installSettleTracker, trackNetwork, waitForPageSettle } from '../src/scripts/manifest.render.page.mjs'

const native = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, clearInterval: window.clearInterval, raf: window.requestAnimationFrame, caf: window.cancelAnimationFrame }
const sleep = (ms) => new Promise((r) => native.setTimeout.call(window, r, ms))

beforeEach(() => {
  document.body.innerHTML = '<main id="m"></main>'
  installSettleTracker()
})

afterEach(() => {
  window.setTimeout = native.setTimeout
  window.clearTimeout = native.clearTimeout
  window.clearInterval = native.clearInterval
  window.requestAnimationFrame = native.raf
  window.cancelAnimationFrame = native.caf
  delete window.__mnfstSettle
  delete window.ManifestPending
  delete window.__manifestMarkdownPending
  delete window.__manifestUtilitiesPending
})

const fakePage = { evaluate: (fn, ...args) => Promise.resolve(fn(...args)) }
const idleNet = { inflight: () => 0, quietMs: () => 1e6, list: () => [] }
const snap = () => window.__mnfstSettle.snapshot()
const small = { quietMs: 20, fixedNetMs: 100, fixedQuietMs: 100 }

describe('settle tracker', () => {
  it('counts timers under 3s, not 3s+ fallbacks or background callbacks', () => {
    setTimeout(() => {}, 30)
    setTimeout(() => {}, 2999)
    setTimeout(() => {}, 3000)
    const bg = () => {}
    bg.__manifestBackground = true
    setTimeout(bg, 100)
    expect(snap().timers).toBe(2)
  })

  it('forgets a timer when it fires, or is cleared through either clear API', async () => {
    setTimeout(() => {}, 10)
    clearTimeout(setTimeout(() => {}, 100))
    clearInterval(setTimeout(() => {}, 100))
    await sleep(30)
    expect(snap().timers).toBe(0)
  })

  it('counts framework holds and, without the registry, the plugin counters', () => {
    window.__manifestMarkdownPending = 1
    expect(snap().counters).toBe(1)
    window.ManifestPending = { count: 2, labels: () => ['a', 'b'] }
    expect(snap()).toMatchObject({ holds: 2, counters: 0 })
  })

  it('counts data sources still loading and pending anchor refreshes', () => {
    window.Alpine = { store: () => ({ _posts_state: { loading: true }, _pages_state: { loading: false } }) }
    document.body.innerHTML = '<nav x-anchors="h2"></nav>'
    document.querySelector('nav').__manifestRenderAnchorPending = true
    expect(snap()).toMatchObject({ loading: 1, anchors: 1 })
    delete window.Alpine
  })
})

describe('trackNetwork', () => {
  const req = (type = 'fetch') => ({ resourceType: () => type, method: () => 'GET', url: () => 'https://x.test/' + type })
  const res = (r, ct = 'text/plain') => ({ request: () => r, headers: () => ({ 'content-type': ct }) })

  it('counts from its own CDP session, independent of page request listeners', async () => {
    const cdp = new EventEmitter()
    cdp.send = async () => {}
    const page = new EventEmitter()
    page.createCDPSession = async () => cdp
    const net = await trackNetwork(page)
    page.emit('request', req())
    expect(net.inflight()).toBe(0)
    cdp.emit('Network.requestWillBeSent', { requestId: '1', type: 'Fetch' })
    cdp.emit('Network.requestWillBeSent', { requestId: '2', type: 'EventSource' })
    cdp.emit('Network.requestWillBeSent', { requestId: '3', type: 'Fetch' })
    cdp.emit('Network.responseReceived', { requestId: '1', type: 'Fetch', response: { mimeType: 'text/plain' } })
    expect(net.inflight()).toBe(2)
    cdp.emit('Network.responseReceived', { requestId: '3', type: 'Fetch', response: { mimeType: 'text/event-stream' } })
    cdp.emit('Network.loadingFinished', { requestId: '1' })
    expect(net.inflight()).toBe(0)
  })

  it('falls back to page events: counted until finished or failed; streams and media ignored', async () => {
    const page = new EventEmitter()
    page.createCDPSession = async () => { throw new Error('unsupported') }
    const net = await trackNetwork(page)
    const a = req(), b = req(), sse = req()
    page.emit('request', a)
    page.emit('request', b)
    page.emit('request', req('media'))
    page.emit('request', sse)
    page.emit('response', res(a))
    page.emit('response', res(sse, 'text/event-stream'))
    expect(net.inflight()).toBe(2)
    page.emit('requestfinished', a)
    page.emit('requestfailed', b)
    expect(net.inflight()).toBe(0)
  })
})

describe('waitForPageSettle', () => {
  it('returns null when the page has no tracker (caller falls back)', async () => {
    delete window.__mnfstSettle
    expect(await waitForPageSettle(fakePage, idleNet, { capMs: 200 })).toBeNull()
  })

  it('takes the fast path once nothing is pending and the DOM is quiet', async () => {
    setTimeout(() => { document.getElementById('m').textContent = 'loaded' }, 50)
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, capMs: 2000 })
    expect(r).toMatchObject({ ok: true })
    expect(r.path).toBeUndefined()
    expect(document.getElementById('m').textContent).toBe('loaded')
  })

  it('with work still pending, waits out the fixed windows in sequence (network idle, then DOM quiet)', async () => {
    setTimeout(() => {}, 2500)
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, fixedNetMs: 200, fixedQuietMs: 150, capMs: 3000 })
    expect(r).toMatchObject({ ok: true, path: 'fixed' })
    expect(r.ms).toBeGreaterThanOrEqual(340)
    expect(r.ms).toBeLessThan(1200)
  })

  it('a DOM change inside the fixed window restarts the quiet part', async () => {
    setTimeout(() => {}, 2500)
    setTimeout(() => { document.getElementById('m').textContent = 'late' }, 250)
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, fixedNetMs: 100, fixedQuietMs: 200, capMs: 3000 })
    expect(r.path).toBe('fixed')
    expect(r.ms).toBeGreaterThanOrEqual(440)
  })

  it('holds for anchor refreshes, up to the anchors window', async () => {
    document.body.innerHTML = '<nav x-anchors="h2"></nav>'
    const nav = document.querySelector('nav')
    nav.__manifestRenderAnchorPending = true
    native.setTimeout.call(window, () => { nav.__manifestRenderAnchorPending = false }, 150)
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, anchorsMs: 2000, capMs: 3000 })
    expect(r.ok).toBe(true)
    expect(r.ms).toBeGreaterThanOrEqual(140)
  })

  it('waits for a framework hold', async () => {
    let held = true
    window.ManifestPending = { get count() { return held ? 1 : 0 }, labels: () => ['ready'] }
    native.setTimeout.call(window, () => { held = false }, 120)
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, capMs: 2000 })
    expect(r.ok).toBe(true)
    expect(r.ms).toBeGreaterThanOrEqual(110)
  })

  it('waits for requests in flight', async () => {
    let open = 1
    const net = { inflight: () => open, quietMs: () => (open ? 0 : 1e6), list: () => [] }
    native.setTimeout.call(window, () => { open = 0 }, 100)
    const r = await waitForPageSettle(fakePage, net, { ...small, capMs: 2000 })
    expect(r.ok).toBe(true)
    expect(r.ms).toBeGreaterThanOrEqual(90)
  })

  it('yields a wedged hold once nothing has moved for stuckMs', async () => {
    window.ManifestPending = { count: 1, labels: () => ['ready'] }
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, stuckMs: 300, capMs: 3000 })
    expect(r).toMatchObject({ ok: true })
    expect(r.stuck).toBeTruthy()
    expect(r.ms).toBeGreaterThanOrEqual(290)
  })

  it('retries while the page context is gone (a reload), then settles on the new document', async () => {
    let calls = 0
    const page = { evaluate: (fn, ...args) => (++calls <= 3 ? Promise.reject(new Error('Execution context was destroyed')) : Promise.resolve(fn(...args))) }
    const r = await waitForPageSettle(page, idleNet, { ...small, capMs: 3000 })
    expect(r.ok).toBe(true)
    expect(calls).toBeGreaterThan(3)
  })

  it("reports 'evaluate' when the context never comes back", async () => {
    const page = { evaluate: () => Promise.reject(new Error('Target closed')) }
    expect(await waitForPageSettle(page, idleNet, { ...small, capMs: 400 })).toMatchObject({ ok: false, reason: 'evaluate' })
  })

  it('reports the cap with what was pending', async () => {
    window.ManifestPending = { count: 1, labels: () => ['stuck'] }
    const busyNet = { inflight: () => 1, quietMs: () => 0, list: () => ['GET /slow'] }
    const r = await waitForPageSettle(fakePage, busyNet, { ...small, capMs: 300 })
    expect(r).toMatchObject({ ok: false, reason: 'cap', requests: ['GET /slow'] })
  })
})
