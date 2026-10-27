/**
 * @vitest-environment happy-dom
 *
 * Render settle: the page-side tracker (timers up to 2s, frames, holds, plugin
 * counters, loading data, DOM changes), the Node-side request counter and the
 * wait that replaces the fixed quiet windows. Polls drop out after three idle
 * runs; stray timers yield after the long quiet window; a lost page context
 * retries, then reports 'evaluate' so the caller uses the fixed windows.
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
const timers = () => window.__mnfstSettle.snapshot().timers

describe('settle tracker', () => {
  it('counts timers under 2s, not 2s+ fallbacks', () => {
    setTimeout(() => {}, 30)
    setTimeout(() => {}, 1999)
    setTimeout(() => {}, 2000)
    setTimeout(() => {}, 5000)
    expect(timers()).toBe(2)
  })

  it('skips callbacks marked as background housekeeping', () => {
    const fn = () => {}
    fn.__manifestBackground = true
    setTimeout(fn, 100)
    expect(timers()).toBe(0)
  })

  it('forgets a timer cleared through either clear API', () => {
    clearTimeout(setTimeout(() => {}, 100))
    clearInterval(setTimeout(() => {}, 100))
    expect(timers()).toBe(0)
  })

  it('keeps a poll counted for three idle runs, then drops it', async () => {
    let runs = 0
    const poll = () => { runs++; setTimeout(poll, 10) }
    setTimeout(poll, 10)
    await sleep(25)
    expect(timers()).toBeGreaterThan(0)
    await sleep(120)
    expect(runs).toBeGreaterThan(4)
    expect(timers()).toBe(0)
  })

  it('keeps counting a loop whose runs change the DOM', async () => {
    let n = 0
    const step = () => { document.getElementById('m').append(document.createElement('p')); if (++n < 6) setTimeout(step, 10) }
    setTimeout(step, 10)
    await sleep(55)
    expect(timers()).toBeGreaterThan(0)
    await sleep(80)
    expect(n).toBe(6)
    expect(timers()).toBe(0)
  })

  it('never treats distinct bound callbacks as one loop', async () => {
    let n = 0
    const step = function () { if (++n < 6) setTimeout(step.bind(null), 10) }
    setTimeout(step.bind(null), 10)
    await sleep(45)
    expect(n).toBeGreaterThan(2)
    expect(n).toBeLessThan(6)
    expect(timers()).toBeGreaterThan(0)
  })

  it('counts framework holds and, without the registry, the plugin counters', () => {
    window.__manifestMarkdownPending = 1
    expect(window.__mnfstSettle.snapshot().counters).toBe(1)
    window.ManifestPending = { count: 2, labels: () => ['a', 'b'] }
    const s = window.__mnfstSettle.snapshot()
    expect(s.holds).toBe(2)
    expect(s.counters).toBe(0)
  })

  it('counts data sources still loading', () => {
    window.Alpine = { store: () => ({ _posts_state: { loading: true }, _pages_state: { loading: false } }) }
    expect(window.__mnfstSettle.snapshot().loading).toBe(1)
    delete window.Alpine
  })
})

describe('trackNetwork', () => {
  const req = (type = 'fetch') => ({ resourceType: () => type, method: () => 'GET', url: () => 'https://x.test/' + type })
  const res = (r, ct = 'text/plain') => ({ request: () => r, headers: () => ({ 'content-type': ct }) })

  it('counts a request until it finishes or fails, not when headers arrive', () => {
    const page = new EventEmitter()
    const net = trackNetwork(page)
    const a = req(), b = req()
    page.emit('request', a)
    page.emit('request', b)
    page.emit('response', res(a))
    expect(net.inflight()).toBe(2)
    page.emit('requestfinished', a)
    page.emit('requestfailed', b)
    expect(net.inflight()).toBe(0)
  })

  it('ignores streams and media', () => {
    const page = new EventEmitter()
    const net = trackNetwork(page)
    page.emit('request', req('eventsource'))
    page.emit('request', req('media'))
    const sse = req()
    page.emit('request', sse)
    page.emit('response', res(sse, 'text/event-stream'))
    expect(net.inflight()).toBe(0)
  })
})

describe('waitForPageSettle', () => {
  it('returns null when the page has no tracker (caller falls back)', async () => {
    delete window.__mnfstSettle
    expect(await waitForPageSettle(fakePage, idleNet, { capMs: 200 })).toBeNull()
  })

  it('settles once pending work drains and the DOM is quiet', async () => {
    setTimeout(() => { document.getElementById('m').textContent = 'loaded' }, 700)
    const r = await waitForPageSettle(fakePage, idleNet, { quietMs: 30, capMs: 3000 })
    expect(r.ok).toBe(true)
    expect(document.getElementById('m').textContent).toBe('loaded')
    expect(r.ms).toBeGreaterThanOrEqual(690)
  })

  it('waits for a framework hold', async () => {
    let held = true
    window.ManifestPending = { get count() { return held ? 1 : 0 }, labels: () => ['ready'] }
    native.setTimeout.call(window, () => { held = false }, 120)
    const r = await waitForPageSettle(fakePage, idleNet, { quietMs: 20, capMs: 2000 })
    expect(r.ok).toBe(true)
    expect(r.ms).toBeGreaterThanOrEqual(110)
  })

  it('waits for requests in flight', async () => {
    let open = 1
    const net = { inflight: () => open, quietMs: () => (open ? 0 : 1e6), list: () => [] }
    native.setTimeout.call(window, () => { open = 0 }, 100)
    const r = await waitForPageSettle(fakePage, net, { quietMs: 20, capMs: 2000 })
    expect(r.ok).toBe(true)
    expect(r.ms).toBeGreaterThanOrEqual(90)
  })

  it('yields a wedged hold once nothing has moved for stuckMs', async () => {
    window.ManifestPending = { count: 1, labels: () => ['ready'] }
    const r = await waitForPageSettle(fakePage, idleNet, { quietMs: 20, stuckMs: 300, capMs: 3000 })
    expect(r.ok).toBe(true)
    expect(r.stuck).toBeTruthy()
    expect(r.ms).toBeGreaterThanOrEqual(290)
  })

  it('yields to a stray timer after the long quiet window', async () => {
    // Armed outside its own callback each time: not detectable as a poll
    native.setTimeout.call(window, function tick() { setTimeout(() => {}, 300); native.setTimeout.call(window, tick, 100) }, 0)
    const r = await waitForPageSettle(fakePage, idleNet, { quietMs: 20, longQuietMs: 250, capMs: 3000 })
    expect(r.ok).toBe(true)
    expect(r.yielded).toBeTruthy()
    expect(r.ms).toBeGreaterThanOrEqual(240)
    expect(r.ms).toBeLessThan(1500)
  })

  it('retries while the page context is gone (a reload), then settles on the new document', async () => {
    let calls = 0
    const page = { evaluate: (fn, ...args) => (++calls <= 3 ? Promise.reject(new Error('Execution context was destroyed')) : Promise.resolve(fn(...args))) }
    const r = await waitForPageSettle(page, idleNet, { quietMs: 20, capMs: 3000 })
    expect(r.ok).toBe(true)
    expect(calls).toBeGreaterThan(3)
  })

  it("reports 'evaluate' when the context never comes back", async () => {
    const page = { evaluate: () => Promise.reject(new Error('Target closed')) }
    const r = await waitForPageSettle(page, idleNet, { quietMs: 20, capMs: 400 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('evaluate')
  })

  it('reports the cap with what was pending', async () => {
    window.ManifestPending = { count: 1, labels: () => ['stuck'] }
    const busyNet = { inflight: () => 1, quietMs: () => 0, list: () => ['GET /slow'] }
    const r = await waitForPageSettle(fakePage, busyNet, { quietMs: 20, capMs: 300 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('cap')
    expect(r.requests).toEqual(['GET /slow'])
  })
})
