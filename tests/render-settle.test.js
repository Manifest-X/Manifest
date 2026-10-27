/**
 * @vitest-environment happy-dom
 *
 * Render settle: the page-side tracker (short timers, frames, holds, plugin
 * counters, loading data, DOM changes) and the Node-side wait that replaces
 * the fixed quiet windows. Loops that only poll drop out; loops that change
 * the DOM stay counted; stray timers yield after the long quiet window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installSettleTracker, waitForPageSettle } from '../src/scripts/manifest.render.page.mjs'

const native = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, raf: window.requestAnimationFrame, caf: window.cancelAnimationFrame }
const sleep = (ms) => new Promise((r) => native.setTimeout.call(window, r, ms))

beforeEach(() => {
  document.body.innerHTML = '<main id="m"></main>'
  installSettleTracker()
})

afterEach(() => {
  window.setTimeout = native.setTimeout
  window.clearTimeout = native.clearTimeout
  window.requestAnimationFrame = native.raf
  window.cancelAnimationFrame = native.caf
  delete window.__mnfstSettle
  delete window.ManifestPending
  delete window.__manifestMarkdownPending
  delete window.__manifestUtilitiesPending
})

// A page over this window, and a network that is idle
const fakePage = { evaluate: (fn, ...args) => Promise.resolve(fn(...args)) }
const idleNet = { inflight: () => 0, quietMs: () => 1e6, list: () => [] }

describe('settle tracker', () => {
  it('counts short timers until they fire, not long ones', async () => {
    setTimeout(() => {}, 30)
    setTimeout(() => {}, 5000)
    expect(window.__mnfstSettle.snapshot().timers).toBe(1)
    await sleep(60)
    expect(window.__mnfstSettle.snapshot().timers).toBe(0)
  })

  it('forgets cleared timers', () => {
    const id = setTimeout(() => {}, 100)
    clearTimeout(id)
    expect(window.__mnfstSettle.snapshot().timers).toBe(0)
  })

  it('drops a polling loop that never changes the DOM', async () => {
    let runs = 0
    const poll = () => { runs++; setTimeout(poll, 10) }
    setTimeout(poll, 10)
    await sleep(80)
    expect(runs).toBeGreaterThan(2)
    expect(window.__mnfstSettle.snapshot().timers).toBe(0)
  })

  it('keeps counting a loop whose runs change the DOM', async () => {
    let n = 0
    const step = () => { document.getElementById('m').append(document.createElement('p')); if (++n < 4) setTimeout(step, 10) }
    setTimeout(step, 10)
    await sleep(25)
    expect(window.__mnfstSettle.snapshot().timers).toBe(1)
    await sleep(80)
    expect(n).toBe(4)
    expect(window.__mnfstSettle.snapshot().timers).toBe(0)
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

  it('records DOM changes', async () => {
    await sleep(30)
    const before = window.__mnfstSettle.snapshot().quietMs
    document.getElementById('m').textContent = 'x'
    await sleep(0)
    expect(window.__mnfstSettle.snapshot().quietMs).toBeLessThan(before)
  })
})

describe('waitForPageSettle', () => {
  it('returns null when the page has no tracker (caller falls back)', async () => {
    delete window.__mnfstSettle
    expect(await waitForPageSettle(fakePage, idleNet, { capMs: 200 })).toBeNull()
  })

  it('settles once pending work drains and the DOM is quiet', async () => {
    setTimeout(() => { document.getElementById('m').textContent = 'loaded' }, 40)
    const r = await waitForPageSettle(fakePage, idleNet, { quietMs: 30, capMs: 2000 })
    expect(r.ok).toBe(true)
    expect(document.getElementById('m').textContent).toBe('loaded')
    expect(r.ms).toBeGreaterThanOrEqual(60)
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

  it('yields to a stray timer after the long quiet window', async () => {
    // Armed outside its own callback each time: not detectable as a loop
    native.setTimeout.call(window, function tick() { setTimeout(() => {}, 300); native.setTimeout.call(window, tick, 100) }, 0)
    const r = await waitForPageSettle(fakePage, idleNet, { quietMs: 20, longQuietMs: 250, capMs: 3000 })
    expect(r.ok).toBe(true)
    expect(r.yielded).toBeTruthy()
    expect(r.ms).toBeGreaterThanOrEqual(240)
    expect(r.ms).toBeLessThan(1500)
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
