/**
 * @vitest-environment happy-dom
 *
 * Render settle: the page-side tracker (next due timer or interval, frames,
 * idle callbacks, streams/sockets/workers, holds, plugin counters, loading
 * data, anchor refreshes, DOM changes), the Node-side request counter and the
 * wait. The fast path needs the page provably quiet, with no timer due within
 * the fixed engine's reach; anything pending uses the fixed engine's windows
 * (network idle or its timeout, then DOM quiet or its cap). A lost page
 * context retries, then reports 'evaluate' for the fixed fallback.
 * Real-browser cases live in tests/e2e/render-settle.e2e.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { installSettleTracker, trackNetwork, waitForPageSettle } from '../src/scripts/manifest.render.page.mjs'

const saved = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'EventSource', 'WebSocket', 'Worker', 'SharedWorker']
const native = Object.fromEntries(saved.map((k) => [k, window[k]]))
const sleep = (ms) => new Promise((r) => native.setTimeout.call(window, r, ms))

beforeEach(() => {
  document.body.innerHTML = '<main id="m"></main>'
  installSettleTracker()
})

afterEach(() => {
  for (const k of saved) window[k] = native[k]
  for (const k of ['__mnfstSettle', '__manifestRenderSettle', 'ManifestPending', '__manifestMarkdownPending', '__manifestUtilitiesPending']) delete window[k]
})

const fakePage = { evaluate: (fn, ...args) => Promise.resolve(fn(...args)) }
const idleNet = { inflight: () => 0, quietMs: () => 1e6, list: () => [] }
const snap = () => window.__mnfstSettle.snapshot()
const small = { quietMs: 20, fixedNetMs: 100, fixedNetTimeoutMs: 1000, fixedQuietMs: 100, fixedDomCapMs: 1000 }

describe('settle tracker', () => {
  it('marks the page as rendered by auto settle', () => {
    expect(window.__manifestRenderSettle).toBe('auto')
  })

  it('reports when the next timer is due, skipping background callbacks', () => {
    const bg = () => {}
    bg.__manifestBackground = true
    setTimeout(bg, 10)
    setTimeout(() => {}, 5000)
    setTimeout(() => {}, 400)
    expect(snap().nextDueMs).toBeGreaterThan(300)
    expect(snap().nextDueMs).toBeLessThanOrEqual(400)
  })

  it('reports intervals under 3s until cleared through either clear API', () => {
    const a = setInterval(() => {}, 100)
    const b = setInterval(() => {}, 200)
    setInterval(() => {}, 5000)
    expect(snap().nextDueMs).toBeLessThanOrEqual(100)
    clearInterval(a)
    expect(snap().nextDueMs).toBeGreaterThan(100)
    clearTimeout(b)
    expect(snap().nextDueMs).toBe(Infinity)
  })

  it('forgets a timer when it fires, or is cleared through either clear API', async () => {
    setTimeout(() => {}, 10)
    clearTimeout(setTimeout(() => {}, 100))
    clearInterval(setTimeout(() => {}, 100))
    await sleep(30)
    expect(snap().nextDueMs).toBe(Infinity)
  })

  it('counts open streams and live workers until closed', () => {
    window.EventSource = native.EventSource = class { close() {} addEventListener() {} }
    window.Worker = native.Worker = class { terminate() {} addEventListener() {} }
    delete window.__mnfstSettle
    installSettleTracker()
    const es = new window.EventSource('/s')
    const w = new window.Worker('/w.js')
    expect(snap().live).toBe(2)
    es.close()
    w.terminate()
    expect(snap().live).toBe(0)
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
  const req = (id, type = 'fetch', extra = {}) => ({ id, resourceType: () => type, method: () => 'GET', url: () => 'https://x.test/' + id, ...extra })
  const res = (r, ct = 'text/plain') => ({ request: () => r, headers: () => ({ 'content-type': ct }) })
  const pageWith = (cdp) => {
    const page = new EventEmitter()
    page.createCDPSession = cdp ? async () => cdp : async () => { throw new Error('unsupported') }
    return page
  }

  it('starts from CDP or page events and finishes from either, by request id', async () => {
    const cdp = new EventEmitter()
    cdp.send = async () => {}
    const page = pageWith(cdp)
    const net = await trackNetwork(page)
    cdp.emit('Network.requestWillBeSent', { requestId: '1', type: 'Fetch' })
    page.emit('request', req('1'))
    page.emit('request', req('w'))
    expect(net.inflight()).toBe(2)
    page.emit('requestfinished', req('1'))
    cdp.emit('Network.loadingFinished', { requestId: 'w' })
    expect(net.inflight()).toBe(0)
  })

  it('drops the old document requests when the main frame navigates', async () => {
    const cdp = new EventEmitter()
    cdp.send = async () => {}
    const net = await trackNetwork(pageWith(cdp))
    cdp.emit('Network.requestWillBeSent', { requestId: 'D1', loaderId: 'D1', type: 'Document', frameId: 'main' })
    cdp.emit('Network.requestWillBeSent', { requestId: 'f', type: 'Fetch' })
    cdp.emit('Network.requestWillBeSent', { requestId: 'D2', loaderId: 'D2', type: 'Document', frameId: 'main' })
    cdp.emit('Network.loadingFinished', { requestId: 'D2' })
    expect(net.inflight()).toBe(0)
  })

  it('ignores streams and media', async () => {
    const cdp = new EventEmitter()
    cdp.send = async () => {}
    const page = pageWith(cdp)
    const net = await trackNetwork(page)
    cdp.emit('Network.requestWillBeSent', { requestId: '2', type: 'EventSource' })
    page.emit('request', req('m', 'media'))
    cdp.emit('Network.requestWillBeSent', { requestId: '3', type: 'Fetch' })
    cdp.emit('Network.responseReceived', { requestId: '3', type: 'Fetch', response: { mimeType: 'text/event-stream' } })
    expect(net.inflight()).toBe(0)
  })

  it('works from page events alone when CDP sessions are unavailable', async () => {
    const page = pageWith(null)
    const net = await trackNetwork(page)
    const a = req('a')
    page.emit('request', a)
    page.emit('response', res(a))
    expect(net.inflight()).toBe(1)
    page.emit('requestfailed', a)
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

  it('with work pending, waits out the fixed windows in sequence (network idle, then DOM quiet)', async () => {
    setInterval(() => {}, 50)
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, fixedNetMs: 200, fixedQuietMs: 150, capMs: 3000 })
    expect(r).toMatchObject({ ok: true, path: 'fixed' })
    expect(r.ms).toBeGreaterThanOrEqual(340)
    expect(r.ms).toBeLessThan(1200)
  })

  it('a DOM change inside the fixed window restarts the quiet part', async () => {
    setInterval(() => {}, 50)
    setTimeout(() => { document.getElementById('m').textContent = 'late' }, 250)
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, fixedNetMs: 100, fixedQuietMs: 200, capMs: 3000 })
    expect(r.path).toBe('fixed')
    expect(r.ms).toBeGreaterThanOrEqual(440)
  })

  it('treats the network as idle after the fixed timeout, then caps DOM churn', async () => {
    const busy = { inflight: () => 1, quietMs: () => 0, list: () => [] }
    const churn = setInterval(() => { document.getElementById('m').textContent = String(Math.random()) }, 20)
    const r = await waitForPageSettle(fakePage, busy, { ...small, fixedNetTimeoutMs: 300, fixedDomCapMs: 300, capMs: 5000 })
    clearInterval(churn)
    expect(r).toMatchObject({ ok: true, path: 'fixed' })
    expect(r.ms).toBeGreaterThanOrEqual(580)
    expect(r.ms).toBeLessThan(1500)
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

  it('a timer due beyond the fixed engine\'s reach does not hold the fast path', async () => {
    setTimeout(() => {}, 2500)
    const r = await waitForPageSettle(fakePage, idleNet, { ...small, capMs: 2000 })
    expect(r).toMatchObject({ ok: true })
    expect(r.path).toBeUndefined()
    expect(r.ms).toBeLessThan(500)
  })

  it('a timer due within reach of recent network activity holds the fast path', async () => {
    setTimeout(() => {}, 2500)
    const recent = { inflight: () => 0, quietMs: () => 100, list: () => [] }
    const r = await waitForPageSettle(fakePage, recent, { ...small, capMs: 3000 })
    expect(r.path).toBe('fixed')
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
