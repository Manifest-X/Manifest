/* Manifest Render: per-route page work and pure transforms (no Node APIs; runs in Workers) */

// URL path matching no route, so the router shows x-route="!*" (404)
const NOT_FOUND_PATH = '__prerender_404__';

/** <script src> values in the source index.html. */
function scriptSrcSet(indexHtml) {
  const out = new Set();
  const srcPattern = /<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = srcPattern.exec(String(indexHtml || ''))) !== null) out.add(m[1]);
  return out;
}

// Drop every <script src> the source index.html didn't have: loader-injected plugins, Alpine, runtime libraries.
function stripInjectedScripts(html, originals) {
  return html.replace(/<script[^>]*\ssrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (full, src) => originals.has(src) ? full : ''
  );
}

// Settle tracking for render.settle 'auto' (page side). Installed before any page script, in every frame. 'Fast' only
// when the page is provably quiet: no frame, idle callback, running CSS animation or transition, open stream or socket,
// live worker, installing service worker, cross-origin frame, recent message-channel activity, loading data source,
// pending anchor refresh or framework hold, and (checked by the caller) no timer, interval, postTask or
// AbortSignal.timeout due within the fixed engine's reach. Anything else keeps the page on the fixed engine's windows.
function installSettleTracker() {
  if (window.__mnfstSettle) return;
  window.__manifestRenderSettle = 'auto';
  const native = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, setInterval: window.setInterval, clearInterval: window.clearInterval };
  const timers = new Map();
  const intervals = new Map();
  const frames = new Set();
  const idles = new Set();
  const live = new Set();
  let lastChange = Date.now();
  let phaseStart = Date.now();
  let openAt = null;
  const background = (fn) => typeof fn === 'function' && fn.__manifestBackground === true;
  window.setTimeout = function (fn, delay, ...args) {
    if (background(fn)) return native.setTimeout.call(window, fn, delay, ...args);
    let id;
    const run = typeof fn === 'function' ? function (...a) { timers.delete(id); return fn.apply(this, a); } : () => { timers.delete(id); (0, eval)(String(fn)); };
    id = native.setTimeout.call(window, run, delay, ...args);
    timers.set(id, Date.now() + (Number(delay) || 0));
    return id;
  };
  window.setInterval = function (fn, delay, ...args) {
    const every = Number(delay) || 0;
    if (background(fn)) return native.setInterval.call(window, fn, delay, ...args);
    let id;
    const run = typeof fn === 'function' ? function (...a) { intervals.set(id, Date.now() + every); return fn.apply(this, a); } : () => { intervals.set(id, Date.now() + every); (0, eval)(String(fn)); };
    id = native.setInterval.call(window, run, delay, ...args);
    intervals.set(id, Date.now() + every);
    return id;
  };
  // Timeout and interval ids share one pool: either clear call can cancel either
  const forget = (id) => { timers.delete(id); intervals.delete(id); };
  window.clearTimeout = function (id) { forget(id); return native.clearTimeout.call(window, id); };
  window.clearInterval = function (id) { forget(id); return native.clearInterval.call(window, id); };
  // Other schedulers report when they're due, like timers
  let seq = 0;
  if (typeof window.scheduler?.postTask === 'function') {
    const postTask = window.scheduler.postTask.bind(window.scheduler);
    window.scheduler.postTask = function (fn, opts) {
      const key = `task${++seq}`;
      timers.set(key, Date.now() + (Number(opts?.delay) || 0));
      const done = () => timers.delete(key);
      opts?.signal?.addEventListener?.('abort', done);
      return postTask(function (...a) { done(); return fn.apply(this, a); }, opts);
    };
  }
  if (typeof window.AbortSignal?.timeout === 'function') {
    const timeout = window.AbortSignal.timeout.bind(window.AbortSignal);
    window.AbortSignal.timeout = function (ms) {
      const key = `abort${++seq}`;
      timers.set(key, Date.now() + (Number(ms) || 0));
      const signal = timeout(ms);
      signal.addEventListener('abort', () => timers.delete(key));
      return signal;
    };
  }
  // Work sliced over message channels (scheduler-style) has gaps no timer covers: recent activity holds
  let lastMessage = 0;
  const messaged = () => { lastMessage = Date.now(); };
  for (const C of [window.MessagePort, window.BroadcastChannel]) {
    const post = C?.prototype?.postMessage;
    if (typeof post === 'function') C.prototype.postMessage = function (...a) { messaged(); return post.apply(this, a); };
  }
  const windowPost = window.postMessage;
  window.postMessage = function (...a) { messaged(); return windowPost.apply(this, a); };
  window.addEventListener('message', messaged, true);
  // A service worker being installed can still resolve serviceWorker.ready and change the page
  const registrations = new Set();
  let lastWorkerState = 0;
  if (navigator.serviceWorker?.register) {
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = function (...a) {
      const key = {};
      registrations.add(key);
      return register(...a).then((reg) => {
        registrations.delete(key);
        registrations.add(reg);
        const watch = (w) => w?.addEventListener?.('statechange', () => { lastWorkerState = Date.now(); });
        watch(reg.installing); watch(reg.waiting);
        reg.addEventListener?.('updatefound', () => { lastWorkerState = Date.now(); watch(reg.installing); });
        lastWorkerState = Date.now();
        return reg;
      }, (e) => { registrations.delete(key); throw e; });
    };
  }
  const installing = () => {
    let n = 0;
    for (const r of registrations) if (!('active' in r) || r.installing || r.waiting) n++;
    return n;
  };
  if (typeof window.requestAnimationFrame === 'function') {
    const raf = window.requestAnimationFrame;
    const caf = window.cancelAnimationFrame;
    window.requestAnimationFrame = function (fn) {
      let id;
      id = raf.call(window, function (t) { frames.delete(id); return fn.call(this, t); });
      frames.add(id);
      return id;
    };
    window.cancelAnimationFrame = function (id) { frames.delete(id); return caf.call(window, id); };
  }
  if (typeof window.requestIdleCallback === 'function') {
    const ric = window.requestIdleCallback;
    const cic = window.cancelIdleCallback;
    window.requestIdleCallback = function (fn, opts) {
      let id;
      id = ric.call(window, function (d) { idles.delete(id); return fn.call(this, d); }, opts);
      idles.add(id);
      return id;
    };
    window.cancelIdleCallback = function (id) { idles.delete(id); return cic.call(window, id); };
  }
  // Streams, sockets and workers can deliver work at any time while they're open
  const track = (name, closers) => {
    const Native = window[name];
    if (typeof Native !== 'function') return;
    window[name] = new Proxy(Native, {
      construct(target, args, newTarget) {
        const obj = Reflect.construct(target, args, newTarget);
        live.add(obj);
        for (const m of closers) {
          const orig = obj[m];
          if (typeof orig === 'function') obj[m] = function (...a) { live.delete(obj); return orig.apply(this, a); };
        }
        try { obj.addEventListener('close', () => live.delete(obj)); } catch { /* no-op */ }
        return obj;
      },
    });
  };
  track('EventSource', ['close']);
  track('WebSocket', ['close']);
  track('Worker', ['terminate']);
  track('SharedWorker', []);
  try {
    new MutationObserver(() => { lastChange = Date.now(); })
      .observe(document, { childList: true, subtree: true, characterData: true });
  } catch { /* no document */ }
  const dataLoading = () => {
    try {
      const d = window.Alpine?.store?.('data');
      if (!d) return 0;
      let n = 0;
      for (const k of Object.keys(d)) if (k.startsWith('_') && k.endsWith('_state') && d[k]?.loading) n++;
      return n;
    } catch { return 0; }
  };
  const animating = () => {
    try {
      let n = 0;
      for (const a of document.getAnimations()) {
        if (a.playState !== 'running' && !a.pending) continue;
        if (a.effect?.getComputedTiming?.().iterations === Infinity) continue;
        n++;
      }
      return n;
    } catch { return 0; }
  };
  const own = () => {
    const now = Date.now();
    let next = Infinity;
    for (const at of timers.values()) if (at > now - 1000) next = Math.min(next, Math.max(0, at - now));
    for (const at of intervals.values()) next = Math.min(next, Math.max(0, at - now));
    // ManifestPending (mnfst 0.5.253+) includes the plugin counters; older frameworks expose only the counters
    const holds = window.ManifestPending ? window.ManifestPending.count || 0 : 0;
    const counters = window.ManifestPending ? 0 : (window.__manifestMarkdownPending || 0) + (window.__manifestUtilitiesPending || 0);
    // Routers with ManifestPending skip their own anchor retries and the engine re-extracts after settling
    let anchors = 0;
    if (!window.ManifestPending) try { for (const el of document.querySelectorAll('[x-anchors]')) if (el.__manifestRenderAnchorPending) anchors++; } catch { /* no-op */ }
    return {
      holds, counters, anchors, loading: dataLoading(), frames: frames.size, idles: idles.size, live: live.size,
      animations: animating(), xframes: 0, workers: installing(), nextDueMs: next, quietMs: now - lastChange,
      messageMs: lastMessage ? now - lastMessage : Infinity, workerStateMs: lastWorkerState ? now - lastWorkerState : Infinity,
    };
  };
  // Same-origin frames count toward the page; a cross-origin frame can't be accounted for
  const snapshot = () => {
    const s = own();
    for (let i = 0; i < window.frames.length; i++) {
      let f = null;
      try { f = window.frames[i].__mnfstSettle?.snapshot() || null; void window.frames[i].document; } catch { s.xframes++; continue; }
      if (!f) continue;
      for (const k of ['holds', 'counters', 'anchors', 'loading', 'frames', 'idles', 'live', 'animations', 'xframes', 'workers']) s[k] += f[k];
      for (const k of ['nextDueMs', 'messageMs', 'workerStateMs']) s[k] = Math.min(s[k], f[k]);
      s.quietMs = Math.min(s.quietMs, f.quietMs);
    }
    return s;
  };
  // Resolves on the fast path ('fast'), once the DOM has been quiet for fixedQuietMs (the caller checks the fixed
  // windows), or after sliceMs. Only the anchors wait holds the fixed windows back, as in the fixed engine; openMs is
  // how long since it ended. Holds and counters only keep the fast path closed.
  const wait = ({ quietMs, fixedQuietMs, anchorsMs, reachDomMs, sliceMs, fresh }) => new Promise((resolve) => {
    if (fresh) { lastChange = Date.now(); phaseStart = Date.now(); openAt = null; }
    const end = Date.now() + sliceMs;
    const tick = () => {
      const s = snapshot();
      const now = Date.now();
      const anchorsWait = s.anchors && now - phaseStart < anchorsMs;
      const soft = s.holds + s.counters + s.frames + s.idles + s.live + s.animations + s.xframes + s.loading + s.anchors + s.workers
        + (s.messageMs < reachDomMs ? 1 : 0) + (s.workerStateMs < reachDomMs ? 1 : 0);
      if (anchorsWait) openAt = null; else if (openAt === null) openAt = now;
      const fast = !soft && s.quietMs >= quietMs;
      const openMs = openAt === null ? 0 : now - openAt;
      if (fast || (!anchorsWait && s.quietMs >= fixedQuietMs) || now >= end) {
        return resolve({ fast, anchorsWait, openMs, ...s, nextDueMs: s.nextDueMs === Infinity ? null : s.nextDueMs, labels: s.holds ? window.ManifestPending?.labels?.() || [] : undefined });
      }
      native.setTimeout.call(window, tick, 15);
    };
    tick();
  });
  window.__mnfstSettle = { snapshot, wait };
}

// Requests in flight for one page (Node side), counted until they finish or fail. Starts come from a CDP session of
// its own (request interception handlers, which Puppeteer runs one after another, can't delay them) and from page
// events (which also cover workers); finishes from either. A new main-frame document drops the old one's requests.
// Streams and media count until their headers arrive (they never finish). A request that never
// finishes keeps the fast path closed. The fixed windows count a request as idle once its headers arrive, as
// Puppeteer's waitForNetworkIdle does, so a response that streams forever can't hold them.
async function trackNetwork(page) {
  const open = new Map();
  const t0 = Date.now();
  let last = Date.now();
  let lastHeaders = Date.now();
  let mainFrame = null;
  const add = (id, method, url) => {
    if (!open.has(id)) open.set(id, { at: Date.now(), method, url, headers: false });
    last = lastHeaders = Date.now();
  };
  const done = (id) => { if (open.delete(id)) last = lastHeaders = Date.now(); };
  const responded = (id) => {
    const o = open.get(id);
    if (o && !o.headers) { o.headers = true; lastHeaders = Date.now(); }
  };
  const endlessType = (t) => /^(eventsource|websocket|media)$/i.test(t || '');
  const endlessMime = (m) => /text\/event-stream|^(audio|video)\//i.test(m || '');
  const navigated = (frameId, id, method, url) => {
    if (mainFrame === null) mainFrame = frameId;
    else if (frameId === mainFrame) { open.clear(); last = lastHeaders = Date.now(); }
    add(id, method, url);
  };
  try {
    const cdp = await page.createCDPSession();
    // Events only: no response bodies kept (the page's own session already buffers them)
    await cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    cdp.on('Network.requestWillBeSent', (e) => {
      const method = e.request?.method, url = e.request?.url;
      if (e.type === 'Document' && e.requestId === e.loaderId && !e.redirectResponse) return navigated(e.frameId, e.requestId, method, url);
      add(e.requestId, method, url);
    });
    cdp.on('Network.responseReceived', (e) => {
      if (endlessType(e.type) || endlessMime(e.response?.mimeType)) done(e.requestId);
      else responded(e.requestId);
    });
    cdp.on('Network.loadingFinished', (e) => done(e.requestId));
    cdp.on('Network.loadingFailed', (e) => done(e.requestId));
  } catch { /* page events only */ }
  page.on('request', (r) => {
    try {
      if (r.isNavigationRequest?.() && r.frame?.() === page.mainFrame?.() && !r.redirectChain?.().length) return void navigated('main', r.id, r.method?.(), r.url?.());
      add(r.id, r.method?.(), r.url?.());
    } catch { /* no-op */ }
  });
  page.on('response', (res) => {
    try {
      const id = res.request().id;
      if (endlessMime(res.headers?.()['content-type'])) done(id); else responded(id);
    } catch { /* no-op */ }
  });
  page.on('requestfinished', (r) => done(r.id));
  page.on('requestfailed', (r) => done(r.id));
  return {
    inflight() { return open.size; },
    quietMs() { return Date.now() - last; },
    // For the fixed windows: requests still waiting for headers, and time since the last start or headers
    awaitingHeaders() { let n = 0; for (const o of open.values()) if (!o.headers) n++; return n; },
    headersQuietMs() { return Date.now() - lastHeaders; },
    list() { return [...open.values()].slice(0, 5).map((o) => `${o.at - t0} ${o.method || '?'} ${String(o.url || '').slice(0, 140)}`); },
  };
}

// The fixed engine's windows per phase, in sequence: network idle (or its timeout), then DOM quiet (or its cap).
// Load: idle 1000ms / timeout 8000, quiet 500 / cap 15000. Route: idle 300 / timeout 5000, quiet 300 / cap 5000.
const SETTLE_FIXED = {
  load: { fixedNetMs: 1000, fixedNetTimeoutMs: 8000, fixedQuietMs: 500, fixedDomCapMs: 15000 },
  route: { fixedNetMs: 300, fixedNetTimeoutMs: 5000, fixedQuietMs: 300, fixedDomCapMs: 5000 },
};
// How long after the last request / DOM change the fixed engine can still be waiting before it reads the page: its
// load + route windows, plus route state, render-ready, flush and og capture (measured per page, see settleExtraMs).
// A timer due within that reach could land before its snapshot.
const SETTLE_REACH = { netMs: 2100, domMs: 1100, marginMs: 400 };
// Recent pages' time from route state to the snapshot (rolling max; slow og capture widens the reach)
const settleExtra = [1000];
function settleExtraMs() { return Math.max(...settleExtra); }
function noteSettleExtra(ms) {
  if (!(ms >= 0)) return;
  settleExtra.push(ms);
  if (settleExtra.length > 8) settleExtra.shift();
}

// Settled on the fast path (nothing pending, no request, DOM quiet briefly) or else on the fixed engine's windows.
// Null when the page never had a tracker; reason 'evaluate' when the page context stayed unreachable. Callers fall
// back to the fixed windows for both.
async function waitForPageSettle(page, net, {
  quietMs = 80, fixedNetMs = 1000, fixedNetTimeoutMs = 8000, fixedQuietMs = 500, fixedDomCapMs = 15000,
  anchorsMs = 2000, capMs = 30000, extraMs = settleExtraMs(),
} = {}) {
  const reachNetMs = SETTLE_REACH.netMs + extraMs + SETTLE_REACH.marginMs;
  const reachDomMs = SETTLE_REACH.domMs + extraMs + SETTLE_REACH.marginMs;
  const t0 = Date.now();
  let last = null;
  let first = true;
  let reached = false;
  let netIdleAt = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (Date.now() - t0 < capMs) {
    const sliceMs = Math.min(250, capMs - (Date.now() - t0));
    // The first slice restarts the quiet clock: work this phase triggered must not ride an earlier quiet stretch.
    const r = await page.evaluate((o) => (window.__mnfstSettle ? window.__mnfstSettle.wait(o) : null), { quietMs, fixedQuietMs, anchorsMs, reachDomMs, sliceMs, fresh: first }).catch(() => undefined);
    if (r === null && !reached) return null;
    // A navigation or reload in a page script destroys the context; the new document gets its own tracker
    if (r === null || r === undefined) { await sleep(100); continue; }
    reached = true;
    first = false;
    last = r;
    const now = Date.now();
    const inflight = net.inflight();
    const reach = Math.max(reachNetMs - net.quietMs(), reachDomMs - r.quietMs);
    const timerDue = r.nextDueMs !== null && r.nextDueMs <= reach;
    if (r.fast && !timerDue && !inflight && net.quietMs() >= quietMs) return { ok: true, ms: now - t0 };
    if (r.anchorsWait) continue;
    // Fixed engine: network idle for fixedNetMs from when it could start (or its timeout), then DOM quiet (or its cap)
    if (netIdleAt === null) {
      const idleFor = net.awaitingHeaders() ? 0 : Math.min(net.headersQuietMs(), r.openMs);
      if (idleFor >= fixedNetMs) netIdleAt = now - (idleFor - fixedNetMs);
      else if (r.openMs >= fixedNetTimeoutMs) netIdleAt = now - (r.openMs - fixedNetTimeoutMs);
    }
    if (netIdleAt !== null) {
      const since = now - netIdleAt;
      if (Math.min(r.quietMs, since) >= fixedQuietMs || since >= fixedDomCapMs) return { ok: true, ms: now - t0, path: 'fixed', pending: r };
      await sleep(Math.max(15, Math.min(100, fixedQuietMs - Math.min(r.quietMs, since))));
    } else await sleep(r.fast ? (timerDue ? Math.max(15, Math.min(100, r.nextDueMs)) : 15) : 50);
  }
  if (!reached) return { ok: false, reason: 'evaluate', ms: Date.now() - t0 };
  return { ok: false, reason: 'cap', ms: Date.now() - t0, pending: last, requests: net.list() };
}

async function flushAlpineEffects(page) {
  // Bounded: Alpine's scheduler can swallow a nextTick callback
  await page
    .evaluate(() => {
      return new Promise((resolve) => {
        const cap = setTimeout(resolve, 3000);
        const done = () => { clearTimeout(cap); resolve(); };
        try {
          if (typeof Alpine !== 'undefined' && typeof Alpine.nextTick === 'function') {
            Alpine.nextTick(() => {
              if (typeof Alpine.nextTick === 'function') Alpine.nextTick(done);
              else done();
            });
          } else {
            queueMicrotask(done);
          }
        } catch {
          done();
        }
      });
    })
    .catch(() => {});
}

/**
 * Same logical path → normalizedPath as waitForManifestPrerenderPipeline and
 * manifest.router.visibility initialize (matchesCondition first argument).
 */
function logicalPathToVisibilityNormalizedPath(pathSeg, locales) {
  const pathname = pathSeg ? `/${pathSeg}` : '/';
  const clean = String(pathname || '/').replace(/^\/+|\/+$/g, '');
  const parts = clean ? clean.split('/') : [];
  const localeList = Array.isArray(locales) ? locales : [];
  const logical =
    parts.length > 0 && localeList.includes(parts[0])
      ? `/${parts.slice(1).join('/')}`
      : clean
        ? `/${clean}`
        : '/';
  const to = logical === '//' ? '/' : logical;
  return typeof to === 'string' && to !== '/' ? to.replace(/^\/|\/$/g, '') : '/';
}

/**
 * Phase 1: align locale state, dispatch route/locale events, warm data sources
 * and run component swapping.  With a localechange, arms the render-ready wait
 * on window before dispatching; otherwise phase 2 asks for a fresh settle.
 */
async function startManifestRouteState(page, { allLocales, currentLocale, timeoutMs }) {
  return page
    .evaluate(
      async ({ localeList, loc, ms }) => {
        try {
          const locales = Array.isArray(localeList) ? localeList : [];

          // Locale already live (set before boot): a localechange would only
          // reload localized sources to get the same data back. A direct
          // settle check re-fires render-ready instead (older data plugins
          // without it keep the event).
          const localeStoreBefore = typeof Alpine !== 'undefined' && Alpine.store
            ? Alpine.store('locale') : null;
          const localeLive = typeof window.ManifestDataStore?.checkAndDispatchRenderReady === 'function'
            && document.documentElement.lang === loc
            && (!localeStoreBefore || localeStoreBefore.current === loc);

          // 1. Align locale state before dispatching any events.
          if (loc && typeof loc === 'string') {
            try { document.documentElement.lang = loc; } catch { /* no-op */ }
          }
          const localeStore = typeof Alpine !== 'undefined' && Alpine.store
            ? Alpine.store('locale') : null;
          if (localeStore) {
            if (!Array.isArray(localeStore.available) || localeStore.available.length === 0) {
              localeStore.available = locales.slice();
            } else {
              localeStore.available = Array.from(new Set([...localeStore.available, ...locales]));
            }
            if (loc && typeof loc === 'string') localeStore.current = loc;
          }

          // 2. Compute normalised route path (strips locale prefix, matches router logic).
          const rawRoute = window.ManifestRoutingNavigation?.getCurrentRoute?.()
            ?? window.location.pathname;
          const clean = String(rawRoute || '/').replace(/^\/+|\/+$/g, '');
          const parts = clean ? clean.split('/') : [];
          const logical =
            parts.length > 0 && locales.includes(parts[0])
              ? '/' + parts.slice(1).join('/')
              : clean ? '/' + clean : '/';
          const to = logical === '//' ? '/' : logical;
          const normalizedPath =
            typeof to === 'string' && to !== '/' ? to.replace(/^\/|\/$/g, '') : '/';

          // 3. With a localechange, the render-ready it produces is the signal:
          //    listen BEFORE dispatching so a fast settle is never missed.
          window.__manifestRenderReadyWait = localeLive ? null : new Promise((resolve) => {
            const onReady = (e) => resolve({ ok: true, locale: e.detail?.locale });
            window.addEventListener('manifest:render-ready', onReady, { once: true });
            setTimeout(() => {
              window.removeEventListener('manifest:render-ready', onReady);
              resolve({ ok: false, reason: 'timeout' });
            }, ms);
          });

          // 4. Dispatch locale change — triggers localized source reloads in the data plugin.
          if (loc && typeof loc === 'string' && !localeLive) {
            window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: loc } }));
          }

          // Anchors reset on route-change and re-extract on a timer: mark
          // each until its refresh runs, so the settle can wait for it.
          for (const el of document.querySelectorAll('[x-anchors]')) {
            const refresh = el._x_anchorRefresh;
            if (typeof refresh !== 'function' || refresh.__manifestRenderWrapped) continue;
            el.__manifestRenderAnchorPending = true;
            const wrapped = function (...args) {
              el.__manifestRenderAnchorPending = false;
              return refresh.apply(this, args);
            };
            wrapped.__manifestRenderWrapped = true;
            el._x_anchorRefresh = wrapped;
          }

          // 5. Dispatch route change — ensures router visibility and head content are current.
          window.dispatchEvent(new CustomEvent('manifest:route-change', {
            detail: { from: to, to, normalizedPath },
          }));
          window.dispatchEvent(new PopStateEvent('popstate'));

          // 5b. Eagerly warm up declared local data sources for the current locale.
          //
          // Without this, sources are loaded lazily — only when a `$x.foo` access
          // triggers the proxy.  For static `<template x-for="group in $x.docs">`
          // patterns the iterator may not run early enough for the load to be
          // in-flight before checkAndDispatchRenderReady's debounced timer fires,
          // and the snapshot captures an empty template (no clones for SEO).
          //
          // Warming up here forces every declared local source into the loading
          // state synchronously (loadDataSource sets _<name>_state.loading = true
          // and registers a promise in loadingPromises before returning), which
          // gates the render-ready dispatch until all loads settle.  Cloud
          // sources (Appwrite collections, object-form API URLs) are skipped —
          // those are typically auth-gated or intentionally dynamic and not
          // appropriate for SEO-baking; lazy access still works for them.
          try {
            const cfg = window.ManifestDataConfig;
            const main = window.ManifestDataMain;
            const manifest = await Promise.race([
              Promise.resolve(cfg?.ensureManifest?.()),
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
            if (manifest?.data && typeof main?.loadDataSource === 'function') {
              const isAppwrite = cfg.isAppwriteCollection;
              for (const [name, source] of Object.entries(manifest.data)) {
                if (isAppwrite && isAppwrite(source)) continue;
                if (source && typeof source === 'object' && source.url) continue;
                // Fire-and-forget: we just need the loading flag set and the
                // promise registered.  Failures fall back to lazy behaviour.
                main.loadDataSource(name, loc).catch(() => { });
              }
            }
          } catch { /* warmup is best-effort; existing lazy access is the fallback */ }

          // 6. Run component swapping explicitly so components tied to this route render
          //    and trigger any $x accesses that start on-demand data loads.
          //    Bounded: a stranded component load must not hang the pipeline.
          let paMs = null;
          if (window.ManifestComponentsSwapping?.processAll) {
            try {
              const pa0 = performance.now();
              await Promise.race([
                window.ManifestComponentsSwapping.processAll(normalizedPath).then(() => { paMs = Math.round(performance.now() - pa0); }),
                new Promise((resolve) => setTimeout(resolve, ms)),
              ]);
            } catch (e) {
              return { ok: false, reason: 'processAll-error', message: String(e?.message || e) };
            }
          }
          return { ok: true, processAllMs: paMs, localeLive };
        } catch (err) {
          return { ok: false, reason: 'error', message: String(err?.message || err) };
        }
      },
      { localeList: allLocales, loc: currentLocale, ms: timeoutMs }
    )
    .catch((e) => ({ ok: false, reason: 'evaluate', message: String(e) }));
}

/**
 * Phase 2: wait for manifest:render-ready — the authoritative signal from the
 * data plugin that all tracked sources have settled for the active locale.
 * Without a pending localechange, a direct settle check evaluated now (after
 * the route's components are in) re-fires it.  Falls back to a timeout for
 * data plugins that predate the signal; a loader that booted without the data
 * plugin never sends it, so there is nothing to wait for.
 */
async function awaitManifestRenderReady(page, { timeoutMs, probe = false }) {
  const t0 = Date.now();
  const result = await page
    .evaluate(
      async ({ ms, probeOn }) => {
        try {
          const noData = window.__manifestReadyCoordinator && !window.ManifestDataStore
            && !(typeof Alpine !== 'undefined' && Alpine.store && Alpine.store('data'));
          let wait = window.__manifestRenderReadyWait;
          if (!noData && !wait) {
            wait = new Promise((resolve) => {
              const onReady = (e) => resolve({ ok: true, locale: e.detail?.locale });
              window.addEventListener('manifest:render-ready', onReady, { once: true });
              setTimeout(() => {
                window.removeEventListener('manifest:render-ready', onReady);
                resolve({ ok: false, reason: 'timeout' });
              }, ms);
            });
            window.ManifestDataStore?.checkAndDispatchRenderReady?.();
          }
          const r = noData ? { ok: true, reason: 'no-data-plugin' } : { ...(await wait) };
          if (probeOn && !r.ok) {
            const p = {};
            try {
              p.renderReadyFlag = !!window.__manifestRenderReady;
              p.manifestReady = !!window.__manifestReady;
              p.alpine = typeof Alpine !== 'undefined';
              p.dataPlugin = !!window.ManifestDataStore;
              p.mdPending = window.__manifestMarkdownPending || 0;
              p.utilPending = window.__manifestUtilitiesPending || 0;
              const d = typeof Alpine !== 'undefined' && Alpine.store ? Alpine.store('data') : null;
              if (d) {
                p.localeChanging = !!d._localeChanging;
                p.loading = Object.keys(d).filter((k) => k.startsWith('_') && k.endsWith('_state') && d[k]?.loading);
              }
            } catch (e) { p.err = String(e); }
            r.probe = p;
          }
          return r;
        } catch (err) {
          return { ok: false, reason: 'error', message: String(err?.message || err) };
        }
      },
      { ms: timeoutMs, probeOn: probe }
    )
    .catch((e) => ({ ok: false, reason: 'evaluate', message: String(e) }));
  result.ms = Date.now() - t0;
  // Timeouts are tolerated: the DOM is still captured.
  return result;
}

/** Both phases back to back (no settle waits between). */
async function waitForManifestRenderReady(page, opts) {
  const started = await startManifestRouteState(page, opts);
  if (!started.ok) return started;
  return { ...(await awaitManifestRenderReady(page, opts)), processAllMs: started.processAllMs };
}

function normalizeLocaleRouteExclude(val) {
  const clean = (s) => String(s).trim().replace(/^\/+|\/+$/g, '');
  if (val == null) return [];
  if (Array.isArray(val)) return val.map(clean).filter(Boolean);
  if (typeof val === 'string') return val.split(',').map(clean).filter(Boolean);
  return [];
}

/**
 * Shared predicate: true when route segment `seg` (no leading slash) falls
 * under one of the excluded prefixes — prefix-matched on whole segments, so
 * "docs" excludes "docs" itself and "docs/group/article" but not "docsite".
 * Used by locale route expansion, link prefixing, and (mirrored in
 * mnfst-publish) the publisher's expected-file computation.
 */
function isLocaleRouteExcluded(seg, localeRouteExclude) {
  if (!seg || !localeRouteExclude || !localeRouteExclude.length) return false;
  const clean = String(seg).replace(/^\/+|\/+$/g, '');
  for (const prefix of localeRouteExclude) {
    if (clean === prefix || clean.startsWith(prefix + '/')) return true;
  }
  return false;
}

/** Single glob pattern match against a locale-stripped route. Only a trailing
 * `/*` (prefix wildcard) or bare `*` (match-all) is supported — mirrors the
 * x-route wildcard-prefix convention used elsewhere in this file. */
function routeMatchesGlob(route, pattern) {
  const p = String(pattern || '').replace(/^\/+|\/+$/g, '');
  if (!p || p === '*') return !!p;
  if (p.endsWith('/*')) {
    const base = p.slice(0, -2);
    return route === base || route.startsWith(base + '/');
  }
  return route === p;
}

/**
 * True when `route` (locale-stripped, e.g. "articles/foo") matches any of
 * `patterns` (manifest.prerender.localeSubstitutionExcludePaths) — such
 * routes are Puppeteer-rendered for every locale instead of substituted.
 */
function isLocaleSubstitutionExcludedPath(route, patterns) {
  if (!route || !patterns || !patterns.length) return false;
  return patterns.some((p) => routeMatchesGlob(route, p));
}

/**
 * Expand discovered route segments into the full path list to render:
 * every locale-neutral route as-is, plus a `<locale>/<route>` variant for
 * every non-default locale (and for the default locale itself, under its
 * own slug, when there's more than one locale) — except routes under an
 * excluded prefix (localeRouteExclude), which are never locale-prefixed.
 * Pure/side-effect-free so it can be unit tested without Puppeteer.
 */
function expandLocaleRoutePaths({ routeSegments, locales, defaultLocale, localeRouteExclude }) {
  const localeList = locales || [];
  const localeSet = new Set(localeList.map((l) => String(l).toLowerCase()));
  const localeNeutralSegments = routeSegments.filter((seg) => {
    if (!seg) return true;
    const first = seg.split('/')[0].toLowerCase();
    return !localeSet.has(first);
  });
  const paths = new Set();
  paths.add('');
  for (const seg of routeSegments) paths.add(seg);
  for (const locale of localeList.slice(1)) {
    paths.add(locale);
    for (const seg of localeNeutralSegments) {
      if (!seg) continue;
      if (isLocaleRouteExcluded(seg, localeRouteExclude)) continue;
      paths.add(`${locale}/${seg}`);
    }
  }
  // Default locale also under its slug (e.g. /en/, /en/page-1) so linking is
  // symmetric with other locales; canonical points to root.  Skip this when
  // there's only one locale — the duplicates serve no purpose and bloat the
  // output (every page would be written twice: at root AND under /en/).
  if (defaultLocale && localeList.length > 1) {
    paths.add(defaultLocale);
    for (const seg of localeNeutralSegments) {
      if (seg !== '' && !isLocaleRouteExcluded(seg, localeRouteExclude)) paths.add(`${defaultLocale}/${seg}`);
    }
  }
  return paths;
}

function extractXRouteConditions(html) {
  const conditions = new Set();
  const re = /x-route\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    m[1].split(',').forEach((c) => {
      const t = c.trim();
      if (t && !t.startsWith('!')) conditions.add(t);
    });
  }
  return conditions;
}

function normalizeRouteCondition(cond) {
  const raw = String(cond || '').trim();
  if (!raw) return { kind: 'all', path: '' };
  if (raw.startsWith('!')) {
    const omitted = raw.slice(1).trim();
    if (!omitted || omitted === '*') return { kind: 'not-found', path: '' }; // !*
    return { kind: 'omit', path: omitted };
  }
  if (raw === '*') return { kind: 'all', path: '' };
  const withoutExact = raw.startsWith('=') ? raw.slice(1) : raw;
  const trimmed = withoutExact.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return { kind: 'root', path: '' };
  if (trimmed.endsWith('/*')) {
    const base = trimmed.slice(0, -2).replace(/^\/+|\/+$/g, '');
    return base ? { kind: 'wildcard-prefix', path: base } : { kind: 'all', path: '' };
  }
  if (trimmed.includes('*')) return { kind: 'unsupported-pattern', path: trimmed };
  return { kind: 'path', path: trimmed };
}

const BOUND_X_ROUTE = /(?:^|[\s<])(?::|x-bind:)x-route\s*=/;
const X_TAG = /<x-([a-z][a-z0-9-]*)(?=[\s>/])/gi;

/** ManifestRouting.matchesCondition for a locale-stripped path. */
function routeConditionMatches(path, condition) {
  const p = String(path).replace(/^\/+|\/+$/g, '') || '/';
  if (condition.includes('*')) {
    if (condition === '*') return true;
    return p.startsWith(condition.replace('*', '').replace(/^\/+|\/+$/g, '') + '/');
  }
  if (condition.startsWith('=')) {
    const exact = condition.slice(1);
    return exact === '/' ? p === '/' : p === exact.replace(/^\/+|\/+$/g, '');
  }
  if (condition.startsWith('/')) {
    if (condition === '/') return p === '/';
    const route = condition.replace(/^\//, '');
    return p === route || p.startsWith(route + '/');
  }
  return p.includes(condition);
}

function conditionsToPaths(conditions) {
  const paths = new Set();
  paths.add('/');
  for (const c of conditions) {
    const parsed = normalizeRouteCondition(c);
    // Discovery rules aligned with router docs:
    // - "*" and omitted routes do not define concrete paths.
    // - "!*" is handled separately via explicit NOT_FOUND path.
    // - "about/*" does not include "/about" by itself; concrete children come from data paths.
    if (parsed.kind === 'path') paths.add('/' + parsed.path);
    else if (parsed.kind === 'root') paths.add('/');
  }
  return paths;
}

function getWildcardBasesFromConditions(conditions) {
  const bases = new Set();
  for (const c of conditions) {
    const parsed = normalizeRouteCondition(c);
    if (parsed.kind === 'wildcard-prefix' && parsed.path) bases.add(parsed.path);
  }
  return [...bases];
}

function pathToFileSegments(pathname) {
  const normalized = pathname.replace(/^\//, '').replace(/\/$/, '') || '';
  return normalized ? normalized.split('/') : [];
}

function stripDevOnlyContent(html) {
  let out = html
    .replace(/<script[^>]*id=["']__bs_script__["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*browser-sync[^"']*["'][^>]*>\s*<\/script>/gi, '');
  return out;
}

function stripRuntimeTailwindArtifacts(html) {
  let out = html.replace(/\sdata-tailwind(?:=(["']).*?\1)?/gi, '');
  // Remove PlayCDN-injected runtime Tailwind stylesheet from snapshots.
  out = out.replace(/<style>\s*\/\*!\s*tailwindcss[\s\S]*?<\/style>/gi, '');
  return out;
}

// When tailwindcss isn't installed for the project, the prerender keeps the
// runtime-injected inline tailwind <style> block (it serves the static page
// for crawlers).  But we must still strip `data-tailwind` from the loader
// script tag, otherwise the runtime tailwind plugin loads at page boot and
// injects ANOTHER tailwind <style> block AFTER prerender.utilities.css,
// breaking the cascade order so .hidden wins over .lg:col etc.
function stripDataTailwindAttr(html) {
  return html.replace(/\sdata-tailwind(?:=(["']).*?\1)?/gi, '');
}

/** Prepend `<!DOCTYPE html>` unless one is already present.
 *
 * The snapshot is captured via `document.documentElement.outerHTML`, which
 * serializes only the <html> subtree and drops the document's doctype.
 * Shipping that doctype-less HTML triggers quirks mode in browsers and is
 * flagged by Lighthouse/PageSpeed.  Re-add it at write time so every emitted
 * page (Puppeteer-rendered base pages and substituted locale variants) is in
 * standards mode. */
function ensureDoctype(html) {
  return /^\s*<!doctype\b/i.test(html) ? html : `<!DOCTYPE html>\n${html}`;
}

/** Theme class de-bake + synchronous bootstrap.
 *
 * Puppeteer applies `<html class="light">` or `<html class="dark">` based on
 * the build host's system preference at prerender time.  Shipping that baked
 * class to users in the OPPOSITE preference causes a visible flash on every
 * page load (dark→light or light→dark) until the colors plugin re-evaluates.
 *
 * Fix: strip `light`/`dark` from the baked `<html class>` and inject a tiny
 * synchronous `<script>` at the top of `<head>` that sets the correct class
 * BEFORE the first paint — based on the user's `localStorage.theme` (their
 * saved preference) or `prefers-color-scheme` (their system preference).
 *
 * The color plugin (`manifest.color.js`) still runs later for reactivity
 * (Alpine bindings, click handlers, system-preference change listener), but
 * the initial paint already has the correct class so there's no flash.
 */
function debakeThemeClass(html) {
  // Strip `light`/`dark` from `<html class="...">`.  When the class attribute
  // becomes empty, drop the attribute entirely (including its leading space)
  // while preserving the rest of the `<html ...>` tag.  Bug-fixed twice — the
  // earlier version's regex captured the entire `<html ... class="...` chunk
  // so returning `''` for an empty cleaned class wiped the whole opening tag.
  let out = html.replace(/<html\b([^>]*)>/i, (full, attrs) => {
    const newAttrs = attrs.replace(/\sclass=(["'])([^"']*)\1/i, (_, q, classes) => {
      const cleaned = classes
        .split(/\s+/)
        .filter((c) => c && c !== 'light' && c !== 'dark')
        .join(' ')
        .trim();
      return cleaned ? ` class=${q}${cleaned}${q}` : '';
    });
    return `<html${newAttrs}>`;
  });
  // Inject the synchronous theme bootstrap as the FIRST element inside <head>
  // so it runs before any CSS or other scripts.  Self-contained — reads
  // localStorage + prefers-color-scheme and sets the class atomically.
  const bootstrap = `<script>(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.add(d?'dark':'light');}catch(e){document.documentElement.classList.add('light');}})();</script>`;
  if (!out.includes('id="manifest-theme-bootstrap"')) {
    // Tag the script for idempotency on rebuilds and easy debugging.
    const tagged = bootstrap.replace('<script>', '<script id="manifest-theme-bootstrap">');
    out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n  ${tagged}`);
  }
  return out;
}

/** Manifest utilities plugin: <style id="manifest-styles"> and <style id="manifest-styles-critical"> */
function extractUtilityStyleBlocks(html) {
  const blocks = [];
  let out = html.replace(
    /<style[^>]*\bid=["']manifest-styles-critical["'][^>]*>([\s\S]*?)<\/style>/gi,
    (_, css) => {
      const t = (css || '').trim();
      if (t) blocks.push({ kind: 'critical', css: t });
      return '';
    }
  );
  out = out.replace(/<style[^>]*\bid=["']manifest-styles["'][^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    const t = (css || '').trim();
    if (t) blocks.push({ kind: 'main', css: t });
    return '';
  });
  return { html: out, blocks };
}

function injectBeforeHeadClose(html, snippet) {
  if (!snippet) return html;
  const hrefMatch = snippet.match(/href=["']([^"']+)["']/);
  const href = hrefMatch ? hrefMatch[1] : null;
  let out = html;
  if (href) {
    out = out.replace(new RegExp(`\\s*<link[^>]*href=["']${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>\\s*`, 'gi'), '\n');
  }
  return out.replace(/<\/head>/i, `${snippet}\n</head>`);
}

function mergeUtilityCssBlocks(allBlocks) {
  const critical = [];
  const main = [];
  const seenC = new Set();
  const seenM = new Set();
  for (const b of allBlocks) {
    if (b.kind === 'critical') {
      if (!seenC.has(b.css)) {
        seenC.add(b.css);
        critical.push(b.css);
      }
    } else {
      if (!seenM.has(b.css)) {
        seenM.add(b.css);
        main.push(b.css);
      }
    }
  }
  const parts = [];
  if (critical.length) parts.push('/* manifest utilities: critical */\n', critical.join('\n\n'));
  if (main.length) parts.push('/* manifest utilities */\n', main.join('\n\n'));
  return parts.join('\n');
}

/** Root-absolute path for prerender bundles (same URL from every page depth; supports manifest:router-base). */
function buildRootAssetPath(routerBasePath, filename) {
  const base = String(routerBasePath || '').replace(/^\/+|\/+$/g, '');
  const name = String(filename || '').replace(/^\/+/, '');
  const path = base ? `${base}/${name}` : name;
  return '/' + path.replace(/\/{2,}/g, '/');
}

//    on duplicated x-for output, but that also stripped legitimate loop body bindings (e.g. product
//    search results), breaking reactivity. If "product/feature is not defined" appears again, fix
//    the duplicate structure or scope in the template instead of neutering all such x-text.
function stripDuplicatedLoopDirectives(html) {
  return html;
}

// Returns true if the attribute string contains either the explicit `data-hydrate`
// attribute (source-authored hydrate island root) or a `data-hydrate-id` (element
// that the prerender has tagged as a runtime-restoration target).  String-level
// strip passes use this to skip elements whose attribute state will be restored
// from the hydration contract at runtime — leaving them untouched is the safest
// default even though the contract would correct most damage anyway.
function isHydrateMarkedAttrs(attrsStr) {
  if (!attrsStr) return false;
  return /\sdata-hydrate(?:-id)?(?:\s*=|[\s>])/i.test(attrsStr);
}

const SCOPE_FREE_IDENTIFIERS = new Set([
  '$x', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'in', 'of', 'new', 'void',
  'Math', 'JSON', 'Number', 'String', 'Boolean', 'Object', 'Array', 'Date', 'Intl',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'NaN', 'Infinity',
]);

// Identifiers a serialized attribute expression reads from Alpine scope (not $x, property names, strings or arrow params).
function scopeIdentifiers(expr) {
  let src = String(expr || '')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const quoted = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
  src = src.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, (lit) => (lit[0] === '`'
    ? ' ' + [...lit.matchAll(/\$\{([^}]*)\}/g)].map((m) => '(' + m[1].replace(quoted, '""') + ')').join(' ') + ' '
    : '""'));
  const params = new Set();
  for (const m of src.matchAll(/(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>/g)) {
    for (const p of (m[1] ?? m[2] ?? '').match(/[A-Za-z_$][\w$]*/g) || []) params.add(p);
  }
  return (src.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) || [])
    .filter((id) => !params.has(id) && !SCOPE_FREE_IDENTIFIERS.has(id));
}

//    Do NOT strip when expression is user-driven: $route(, $search, $query, or reads any other scope
//    state (e.g. $x.docs.find(d => d.key === family)). Those stay so Alpine can update.
//    Same rule for :attr in stripPrerenderDynamicBindings: bindings with $x are kept (content stays for SEO).
function stripPrerenderedXDataDirectives(html) {
  function isStatic(expr) {
    if (expr.includes('$route(')) return false;
    if (expr.includes('$search') || expr.includes('$query')) return false;
    return scopeIdentifiers(expr).length === 0;
  }
  return html.replace(/<(\w+)([^>]*)>/g, (full, tag, attrs) => {
    if (isHydrateMarkedAttrs(attrs)) return full;
    let outAttrs = attrs;
    outAttrs = outAttrs.replace(/\s+x-text="([^"]*\$x[^"]*)"/g, (match, expr) => (isStatic(expr) ? '' : match));
    outAttrs = outAttrs.replace(/\s+x-html="([^"]*\$x[^"]*)"/g, (match, expr) => (isStatic(expr) ? '' : match));
    return `<${tag}${outAttrs}>`;
  });
}

//    For any :attr or x-bind:attr whose expression does NOT contain $x, remove the literal attr from the tag
//    so Alpine re-evaluates on load. Bindings that use $x are left as-is (content stays for SEO), except
//    :style / x-bind:style with $x: those must be removed when a baked inline style exists, or Alpine will
//    overwrite prerendered values (e.g. mask-image) on hydrate when $x is briefly empty in production.
//    Use (?<!:) so we only strip literal attr=, not :attr= (e.g. class= not :class=).
//    Never touch <script> tags (loader + injected plugins must be preserved; static HTML still runs them).
function stripPrerenderDynamicBindings(html) {
  return html.replace(/<(\w+)([^>]*)>/g, (match, tagName, attrsStr) => {
    if (tagName.toLowerCase() === 'script') return match;
    if (isHydrateMarkedAttrs(attrsStr)) return match;
    const isAnchor = tagName.toLowerCase() === 'a';
    const isImg = tagName.toLowerCase() === 'img';
    let workAttrs = attrsStr;
    workAttrs = workAttrs.replace(/\s+:style=(?:"([^"]*)"|'([^']*)')/gi, (sub, d, s) => {
      const val = (d !== undefined ? d : s) || '';
      return val.indexOf('$x') !== -1 ? '' : sub;
    });
    workAttrs = workAttrs.replace(/\s+x-bind:style=(?:"([^"]*)"|'([^']*)')/gi, (sub, d, s) => {
      const val = (d !== undefined ? d : s) || '';
      return val.indexOf('$x') !== -1 ? '' : sub;
    });

    const toStrip = new Set();
    const bindingRegex = /(?:^|\s)(?::|x-bind:)(\w+)=(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = bindingRegex.exec(workAttrs)) !== null) {
      const attrName = (m[1] || '').toLowerCase();
      // Keep href on anchors and src on images: :href / :src often reference x-for iterators (e.g.
      // article?.banner). Stripping the baked literal leaves only :src/:href and breaks static HTML.
      if (attrName === 'class' || attrName === 'style' || (isAnchor && attrName === 'href') || (isImg && attrName === 'src')) continue;
      const val = (m[2] !== undefined ? m[2] : m[3]) || '';
      if (val.indexOf('$x') === -1) toStrip.add(attrName);
    }
    if (toStrip.size === 0 && workAttrs === attrsStr) return match;
    let newAttrs = workAttrs;
    for (const attr of toStrip) {
      const esc = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      newAttrs = newAttrs.replace(new RegExp(`\\s*(?<!:)${esc}="[^"]*"`, 'gi'), '');
      newAttrs = newAttrs.replace(new RegExp(`\\s*(?<!:)${esc}='[^']*'`, 'gi'), '');
    }
    newAttrs = newAttrs.trim();
    if (newAttrs) newAttrs = ' ' + newAttrs;
    return `<${tagName}${newAttrs}>`;
  });
}

// Drop :src / x-bind:src when img already has a baked src= (x-for / iterator expressions break hydrate).
function stripRedundantImgSrcBindings(html) {
  return html.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    if (isHydrateMarkedAttrs(attrs)) return full;
    const srcM = attrs.match(/\ssrc=(["'])([\s\S]*?)\1/i);
    if (!srcM || !String(srcM[2] || '').trim()) return full;
    if (!/\s:src\s*=|\sx-bind:src\s*=/i.test(attrs)) return full;
    let next = attrs.replace(/\s:src=(?:"[^"]*"|'[^']*')/gi, '');
    next = next.replace(/\sx-bind:src=(?:"[^"]*"|'[^']*')/gi, '');
    return `<img${next}>`;
  });
}

/**
 * Manifest runtime replaces <x-*> component placeholders by fetching source .html, which wipes
 * prerender-baked markup (stripped :style, expanded lists, etc.). Tag opens with data-pre-rendered
 * are skipped by manifest.components.processor — required for static prerender output to hydrate correctly.
 */
// Prerender inlined Iconify SVG under <i x-icon="iterator.icon">; clear x-icon value so Alpine does not evaluate
// loop/item expressions while the attribute remains for CSS (e.g. inline layout that keys off [x-icon]).
// render.icons: "lazy" — drop prerender-inlined icon SVGs from the output.
// Each svg carries its resolved name (data-icon), which is written back into
// the host's x-icon attribute as a static, scope-free value — so the icons
// plugin re-renders it at boot even on baked clones whose expression attrs
// were emptied. Only svg-as-first-child hosts match; anything else stays inline.
function stripLazyIconSvgs(html) {
  return html.replace(
    /(x-icon\s*=\s*")[^"]*("[^>]*>\s*)<svg\b[^>]*\bdata-icon="([^"]+)"[^>]*>[\s\S]*?<\/svg>/gi,
    (m, pre, post, name) => `${pre}${name}${post}`
  );
}

function stripResolvedXIconDirectives(html) {
  return html.replace(/<i\b([^>]*)>([\s\S]*?)<\/i>/gi, (full, attrs, inner) => {
    if (isHydrateMarkedAttrs(attrs)) return full;
    if (!/\sx-icon\s*=/i.test(attrs)) return full;
    if (!/<svg\b/i.test(inner) || !/\bdata-icon\s*=/i.test(inner)) return full;
    const cleaned = attrs
      .replace(/\s+x-icon\s*=\s*"[^"]*"/gi, ' x-icon=""')
      .replace(/\s+x-icon\s*=\s*'[^']*'/gi, ' x-icon=""')
      .trim();
    const sp = cleaned ? ' ' : '';
    return `<i${sp}${cleaned}>${inner}</i>`;
  });
}

function markPrerenderedManifestComponents(html) {
  // x-if/x-for template content is authored source Alpine clones at runtime — never mark it.
  const templates = [];
  return html.replace(/<(\/?)template(?=[\s>])([^>]*)>|<(x-[a-z][\w-]*)([^>]*)>/gi, (full, close, tplAttrs, tag, attrs) => {
    if (!tag) {
      if (close) templates.pop();
      else templates.push(/\sx-(?:if|for)\s*=/i.test(tplAttrs || ''));
      return full;
    }
    if (templates.includes(true)) return full;
    const a = attrs || '';
    if (/\bdata-pre-rendered\s*=/i.test(a) || /\bdata-processed\s*=/i.test(a)) return full;
    // Inside an explicit hydrate island — the runtime will restore its
    // innerHTML to the authored source, so we must NOT tell the components
    // processor to skip re-fetching.  Leaving the placeholder unmarked lets
    // the runtime restoration reinstate the <x-*> tag and the components
    // plugin processes it normally on load.
    if (/\bdata-hydrate\b/i.test(a)) return full;
    // CRITICAL: always insert a leading space before the injected attribute.
    // For tags with no existing attributes (e.g. `<x-sidebar>`), `a` is empty
    // and concatenating directly produces `<x-sidebardata-pre-rendered=...>`,
    // which mangles the tag name and prevents the components plugin from
    // recognising it.  The trailing-space normalisation on `a` keeps the
    // output tidy when there ARE existing attributes.
    return `<${tag}${a.replace(/\s+$/, '')} data-pre-rendered="1">`;
  });
}

// Remove empty inline mask-image styles emitted before data resolves
// (e.g. style="mask-image: url()"), while keeping any :style/x-bind:style bindings.
function stripEmptyInlineMaskStyles(html) {
  return html.replace(/<(\w+)([^>]*)>/g, (full, tag, attrs) => {
    const styleMatch = attrs.match(/\sstyle=(["'])([\s\S]*?)\1/i);
    if (!styleMatch) return full;
    const quote = styleMatch[1];
    const rawStyle = styleMatch[2] || '';
    const cleaned = rawStyle
      .replace(/\bmask-image\s*:\s*url\(\s*(?:''|""|)\s*\)\s*;?/gi, '')
      .replace(/\b-webkit-mask-image\s*:\s*url\(\s*(?:''|""|)\s*\)\s*;?/gi, '')
      .trim()
      .replace(/^\s*;\s*|\s*;\s*$/g, '');

    if (!cleaned) {
      const newAttrs = attrs.replace(/\sstyle=(["'])[\s\S]*?\1/i, '');
      return `<${tag}${newAttrs}>`;
    }
    const rebuilt = attrs.replace(/\sstyle=(["'])[\s\S]*?\1/i, ` style=${quote}${cleaned}${quote}`);
    return `<${tag}${rebuilt}>`;
  });
}

function isPrerenderBundleAssetPath(pathAfterSlash) {
  return /(^|\/)prerender\.(tailwind|utilities)\.css$/.test(pathAfterSlash);
}

function rewriteHtmlAssetPaths(html, depthWithinOutput) {
  const prefix = depthWithinOutput > 0 ? '../'.repeat(depthWithinOutput) : '';
  if (!prefix) return html;
  function isAnchorTag(htmlBeforeMatch) {
    const lastOpen = htmlBeforeMatch.lastIndexOf('<');
    if (lastOpen === -1) return false;
    const tag = htmlBeforeMatch.slice(lastOpen + 1).match(/^(\w+)/);
    return tag && tag[1].toLowerCase() === 'a';
  }
  let out = html.replace(/(\s(href|src)=["'])\/(?!\/)([^'"]*)/g, (match, lead, _attr, rest, offset, fullString) => {
    if (isAnchorTag(fullString.slice(0, offset))) return match;
    if (isPrerenderBundleAssetPath(rest)) return match;
    return lead + prefix + rest;
  });
  out = out.replace(/(\s(href|src)=["'])(\.\.\/)+/g, (match, lead, attr, dots, offset, fullString) => {
    if (isAnchorTag(fullString.slice(0, offset))) return match;
    return lead + prefix;
  });
  return out;
}

// Alpine x-data drives radio state; baked checked="" from the live DOM (e.g. yearly) fights monthly defaults.
function stripPrerenderBakedRadioCheckedForXModel(html) {
  return html.replace(/<input\b([^>]*)>/gi, (full, attrs) => {
    if (!/\btype\s*=\s*["']radio["']/i.test(attrs)) return full;
    if (!/\bx-model\s*=/i.test(attrs)) return full;
    const next = attrs.replace(/\s+checked(?:\s*=\s*["'][^"']*["']|\s*=\s*[^\s>]+)?/gi, '');
    if (next === attrs) return full;
    return `<input${next}>`;
  });
}

function buildCanonicalAndHreflang(pathSeg, locales, defaultLocale, base, opts = {}) {
  const { skipCanonical = false } = opts;
  const baseClean = base.replace(/\/$/, '');
  const defaultLoc = defaultLocale || locales[0];
  const isDefaultLocalePrefixed =
    defaultLoc && (pathSeg === defaultLoc || pathSeg.startsWith(defaultLoc + '/'));
  const canonicalPath =
    isDefaultLocalePrefixed
      ? pathSeg === defaultLoc
        ? ''
        : pathSeg.slice(defaultLoc.length + 1)
      : pathSeg;
  const canonicalHref = canonicalPath === '' ? `${baseClean}/` : `${baseClean}/${canonicalPath}`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // Skip the canonical <link> when the source head already declares one
  // (first-wins, per seo-aeo.md); hreflang alternates are still emitted since
  // those are framework-derived and rarely authored by hand.
  let out = skipCanonical ? '' : `<link rel="canonical" href="${esc(canonicalHref)}">\n`;
  if (locales.length > 1) {
    const currentLocale = locales.find((l) => pathSeg === l || pathSeg.startsWith(l + '/')) || defaultLoc;
    const logicalRoute =
      currentLocale === defaultLoc
        ? pathSeg === defaultLoc
          ? ''
          : pathSeg.startsWith(defaultLoc + '/')
            ? pathSeg.slice(defaultLoc.length + 1)
            : pathSeg
        : pathSeg === currentLocale
          ? ''
          : pathSeg.slice(currentLocale.length + 1);
    locales.forEach((loc) => {
      const seg = loc === defaultLoc ? logicalRoute : (logicalRoute ? `${loc}/${logicalRoute}` : loc);
      const href = baseClean + (seg ? `/${seg}` : '');
      const hreflang = loc === defaultLoc ? 'x-default' : loc;
      out += `  <link rel="alternate" hreflang="${esc(hreflang)}" href="${esc(href)}">\n`;
    });
  }
  return out;
}

/** Same alternate URLs as buildCanonicalAndHreflang; used for sitemap xhtml:link entries. */
function getAlternateLinksForPath(pathSeg, locales, defaultLocale, base) {
  const baseClean = base.replace(/\/$/, '');
  const defaultLoc = defaultLocale || locales[0];
  if (!locales || locales.length <= 1) return [];
  const currentLocale = locales.find((l) => pathSeg === l || pathSeg.startsWith(l + '/')) || defaultLoc;
  const logicalRoute =
    currentLocale === defaultLoc
      ? pathSeg === defaultLoc
        ? ''
        : pathSeg.startsWith(defaultLoc + '/')
          ? pathSeg.slice(defaultLoc.length + 1)
          : pathSeg
      : pathSeg === currentLocale
        ? ''
        : pathSeg.slice(currentLocale.length + 1);
  const entries = [];
  locales.forEach((loc) => {
    const seg = loc === defaultLoc ? logicalRoute : (logicalRoute ? `${loc}/${logicalRoute}` : loc);
    const href = baseClean + (seg ? `/${seg}` : '');
    const hreflang = loc === defaultLoc ? 'x-default' : loc;
    entries.push({ hreflang, href });
  });
  return entries;
}

function escapeXmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildOgLocale(pathSeg, locales, defaultLocale) {
  if (locales.length <= 1) return '';
  const defaultLoc = defaultLocale || locales[0];
  const currentLocale = locales.find((l) => pathSeg === l || pathSeg.startsWith(l + '/')) || defaultLoc;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const toOgLocale = (loc) => (loc.indexOf('-') !== -1 ? loc.replace(/-/g, '_').toLowerCase() : loc.toLowerCase());
  let out = `<meta property="og:locale" content="${esc(toOgLocale(currentLocale))}">\n`;
  locales.forEach((loc) => {
    if (loc !== currentLocale) out += `  <meta property="og:locale:alternate" content="${esc(toOgLocale(loc))}">\n`;
  });
  return out;
}

function stripOgLocaleFromHead(html) {
  return html.replace(/\s*<meta[^>]*property="og:locale(?::alternate)?"[^>]*>\s*/gi, '');
}

function hasOtherOgMeta(html) {
  return /<meta[^>]*property="og:(?!locale(?::alternate)?")[^"]*"[^>]*>/i.test(html);
}

/**
/**
 * Prefix internal navigation links with the target locale so that prerendered
 * MPA pages link directly to the correct locale variant (e.g. /platform →
 * /fr/platform on the French page).  Without this, users must rely on runtime
 * JS interception (`installMpaStickyLocaleLinks`) which may not be ready by
 * the time they click — causing navigation to fall back to English.
 *
 * Only rewrites `<a href="...">` where the href is a root-relative path that
 * doesn't already carry a locale prefix and isn't an excluded route.
 */
function prefixLocaleInternalLinks(html, locale, locales, localeRouteExclude) {
  if (!locale || !locales || !locales.length) return html;
  const localeSet = new Set(locales);

  // Match <a ... href="..." ...>  — capture the href value
  return html.replace(
    /(<a\b[^>]*\shref=["'])(\/?[^"'#][^"']*)(["'][^>]*>)/gi,
    (full, prefix, href, suffix) => {
      // Only process root-relative paths
      if (!href.startsWith('/')) return full;
      // Skip external protocols embedded as relative (shouldn't happen but guard)
      if (/^\/\//.test(href)) return full;

      const withoutSlash = href.replace(/^\//, '');
      const firstSeg = withoutSlash.split('/')[0].split('#')[0].split('?')[0];

      // Already has a locale prefix
      if (localeSet.has(firstSeg)) return full;

      // Skip asset-like paths
      if (/\.(css|js|json|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|pdf|xml|txt)$/i.test(href)) return full;

      // Respect localeRouteExclude — these routes stay locale-neutral
      if (isLocaleRouteExcluded(withoutSlash, localeRouteExclude)) return full;

      // Prefix with locale
      return `${prefix}/${locale}${href}${suffix}`;
    }
  );
}

function getXPath(obj, path) {
  const parts = path.replace(/^\.+/, '').split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolveHeadXBindings(html, xData) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return html.replace(/<head>([\s\S]*?)<\/head>/i, (_, headContent) => {
    // Process each tag in <head> that has a :attr or x-bind:attr binding
    const out = headContent.replace(/<[^>]+>/g, (tag) => {
      // Find all :attr="$x...." or x-bind:attr="$x...." bindings in this tag
      const bindingRe = /\s(?::|x-bind:)(\w+)=["'](\$x\.[^"']+)["']/g;
      let m;
      let newTag = tag;
      while ((m = bindingRe.exec(tag)) !== null) {
        const attr = m[1];
        const expr = m[2];
        const path = expr.replace(/^\$x\./, '').trim();
        const value = getXPath(xData, path);
        if (value === undefined) continue;
        // Remove the binding
        newTag = newTag.replace(m[0], '');
        // Remove existing static fallback for this attr
        newTag = newTag.replace(new RegExp(`\\s${attr}=["'][^"']*["']`), '');
        // Insert the resolved attr before the closing >
        newTag = newTag.replace(/>$/, ` ${attr}="${esc(value)}">`);
      }
      return newTag;
    });
    return `<head>${out}</head>`;
  });
}

/**
 * Wait for the page to visually settle before OG fingerprint/screenshot.
 * manifest:render-ready covers tracked data sources, but async work can land
 * after it — x-markdown article fetches, runtime-compiled utility CSS, and
 * webfonts — and screenshotting early captures a blank article region.  Two
 * conditions gate the snapshot: every [x-markdown] region has rendered
 * content (or the cap expires — some regions are legitimately empty in
 * prerender, e.g. demos), and a cheap DOM signature (text length + injected
 * style bytes + font status + empty-markdown count) holds steady.  Then let
 * fonts finish and the compositor paint.
 */
async function waitForVisualSettle(page, { settleMs = 300, mdWaitMs = 5000, capMs = 8000 } = {}) {
  try {
    await page.evaluate(async ({ settleMs, mdWaitMs, capMs }) => {
      // The framework's boot signal (loader ≥0.5.190) gates the start, but it
      // fires once per page — per-ROUTE work is tracked by the live markdown
      // pending counter and the DOM heuristic below, so all three AND together.
      const state = () => {
        let styleLen = 0;
        for (const s of document.querySelectorAll('style')) styleLen += (s.textContent || '').length;
        let mdEmpty = 0;
        for (const e of document.querySelectorAll('[x-markdown]')) {
          if (!e.innerHTML.trim()) mdEmpty++;
        }
        const sig = `${mdEmpty}:${document.body?.innerText.length || 0}:${styleLen}:${document.fonts ? document.fonts.status : ''}`;
        return { sig, mdEmpty };
      };
      // Alpine 3.x can strand already-flushed effects when a sibling effect
      // creates state mid-flush — a route's x-if chain then never stamps until
      // something re-queues it. Bumping the data store's version re-runs every
      // store-reading effect: a no-op on settled pages, an unstick on stuck ones.
      const nudge = () => {
        try {
          if (window.Alpine?.store) {
            const s = window.Alpine.store('data');
            if (s) window.Alpine.store('data', { ...s, _dataVersion: (s._dataVersion || 0) + 1 });
          }
        } catch { /* best-effort */ }
      };
      // Responsive/variant utilities (md:row, dark:bg-*) are compiled at
      // runtime and the compiler throttles recompiles — a late-discovered
      // variant class leaves the layout in its mobile/stacked state at capture.
      // Hold while any variant class used in the DOM has no matching CSS rule.
      // Utilities sit inside @layer/@media blocks: walk nested rules.
      const collect = (rules, out) => {
        for (const r of rules) {
          if (r.selectorText) out.push(r.selectorText);
          if (r.cssRules && r.cssRules.length) collect(r.cssRules, out);
        }
      };
      const unresolvedVariants = () => {
        try {
          const used = new Set();
          for (const el of document.querySelectorAll('[class*=":"]')) {
            for (const c of el.classList) if (c.includes(':') && !c.startsWith('[')) used.add(c);
            if (used.size > 300) break;
          }
          if (!used.size) return 0;
          const parts = [];
          for (const sheet of document.styleSheets) {
            try { collect(sheet.cssRules, parts); } catch { /* cross-origin */ }
          }
          const selectors = parts.join('\n');
          let missing = 0;
          for (const c of used) {
            if (!selectors.includes('.' + CSS.escape(c))) missing++;
          }
          return missing;
        } catch { return 0; }
      };
      // A variant no compile resolves (unknown or non-utility) stops holding
      // once its count stays unchanged through a nudge + recompile window.
      const UNRESOLVED_GRACE_MS = 1000;
      let missPrev = -1;
      let missSince = Date.now();
      const start = Date.now();
      let last = state();
      let stableSince = Date.now();
      let nudged = 0;
      while (Date.now() - start < capMs) {
        await new Promise((r) => setTimeout(r, 100));
        const elapsed = Date.now() - start;
        if ((nudged === 0 && elapsed > 300) || (nudged === 1 && elapsed > 2000)) { nudged++; nudge(); }
        const cur = state();
        const bootPending = !!window.__manifestReadyCoordinator && !window.__manifestReady;
        const inflight = (window.__manifestMarkdownPending || 0) > 0;
        const mdPending = cur.mdEmpty > 0 && Date.now() - start < mdWaitMs;
        const miss = elapsed < mdWaitMs + 4000 ? unresolvedVariants() : 0;
        if (miss !== missPrev) { missPrev = miss; missSince = Date.now(); }
        const utilPending = (window.__manifestUtilitiesPending || 0) > 0
          || (miss > 0 && Date.now() - missSince < UNRESOLVED_GRACE_MS);
        // A throttled compiler can DROP the request that would resolve them —
        // a class mutation re-triggers its observer's schedule.
        if (utilPending && elapsed % 500 < 100) document.body.classList.toggle('mnfst-og-nudge');
        if (cur.sig !== last.sig || bootPending || inflight || mdPending || utilPending) {
          last = cur;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= settleMs) {
          break;
        }
      }
      // The nudge is a probe, never content.
      document.body?.classList.remove('mnfst-og-nudge');
      if (document.fonts?.ready) { try { await document.fonts.ready; } catch { /* best-effort */ } }
      // Let the compositor paint the settled state — but raced against a
      // timeout: a frame-idle headless page may never fire rAF, and an
      // unresolved evaluate() wedges the whole render worker.
      await new Promise((r) => {
        const t = setTimeout(r, 250);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); }));
      });
    }, { settleMs, mdWaitMs, capMs });
  } catch { /* settle is best-effort — never blocks the snapshot */ }
}

//
// Runs in the live page right before HTML serialization.  Layers (highest
// precedence first; each layer only fills slots not yet present):
//
//   1. <template data-head> per-route — already in the head by snapshot time
//   2. <head> in index.html — already in the head by snapshot time
//   3. prerender.meta.* expressions — Alpine-evaluated against the live page
//   4. prerender.meta.fallback.* — static strings used when expressions are empty
//   5. PWA-style manifest.json fields (name, description, author, icons)
//   6. Smart defaults from the rendered DOM (h1, first p, first img, etc.)
//
// "Slot taken" detection is by selector: <title>, <meta name=>, <meta property=>.
// An empty <title></title> or one matching manifest.json "name" counts as
// missing (placeholder rule), so smart defaults can fill route-specific titles
// without the author having to clear the static <title> in index.html.
//
// JSON-LD blocks (WebSite, Article, BreadcrumbList) follow the same pattern:
// only inject if no <script type="application/ld+json"> already covers that
// schema type for the route.
async function injectMetaInDom(page, ctx) {
  await page.evaluate((ctx) => {
    const head = document.head;
    if (!head) return;

    // --- Helpers ---------------------------------------------------------

    const SOCIAL_PREFIXES = /^(og:|twitter:|article:|fb:)/;

    const findMeta = (key) => {
      // Selectors are case-sensitive in querySelector; meta name/property are case-insensitive
      // in HTML but always written lowercase by us.  Cover both attribute styles.
      return head.querySelector(`meta[name="${key}"], meta[property="${key}"]`);
    };

    // Slots are "open" if missing, OR if their content equals a known site-wide
    // placeholder (manifest.json's name/description).  Mirrors the title rule so
    // existing projects with hardcoded site-default meta in index.html still get
    // route-specific values from smart defaults.  Per-tag placeholder map:
    const PLACEHOLDER = {
      description: ctx.seo.siteDescription,
    };
    const slotIsOpen = (key, existingEl) => {
      if (!existingEl) return true;
      const current = (existingEl.getAttribute('content') || '').trim();
      if (!current) return true;
      const placeholder = PLACEHOLDER[key];
      return placeholder && current === placeholder;
    };
    const setMeta = (key, content) => {
      if (content == null) return false;
      const str = String(content).trim();
      if (!str) return false;
      const existing = findMeta(key);
      if (!slotIsOpen(key, existing)) return false;
      if (existing) {
        existing.setAttribute('content', str);
      } else {
        const m = document.createElement('meta');
        m.setAttribute(SOCIAL_PREFIXES.test(key) ? 'property' : 'name', key);
        m.setAttribute('content', str);
        head.appendChild(m);
      }
      return true;
    };

    const getCurrentTitle = () => {
      const el = head.querySelector('title');
      return { el, text: el ? (el.textContent || '').trim() : '' };
    };

    const titleSlotIsOpen = () => {
      const { text } = getCurrentTitle();
      if (!text) return true;
      // Equals manifest.name → treat as placeholder (the static <title>Site</title>
      // pattern in starter templates).  Allows smart-defaults to inject a
      // route-specific title without the author having to wipe the static tag.
      if (ctx.seo.siteName && text === ctx.seo.siteName) return true;
      return false;
    };

    const setTitle = (text) => {
      if (!text) return false;
      if (!titleSlotIsOpen()) return false;
      const trimmed = String(text).trim();
      if (!trimmed) return false;
      const { el } = getCurrentTitle();
      if (el) el.textContent = trimmed;
      else {
        const t = document.createElement('title');
        t.textContent = trimmed;
        head.appendChild(t);
      }
      return true;
    };

    const evalAlpine = (expr) => {
      if (typeof expr !== 'string' || !expr.trim()) return null;
      try {
        const A = window.Alpine;
        if (!A || typeof A.evaluate !== 'function') return null;
        const v = A.evaluate(document.body, expr);
        if (v == null) return null;
        const s = typeof v === 'string' ? v : String(v);
        return s.trim() || null;
      } catch { return null; }
    };

    const truncate = (s, max) => {
      const t = String(s).replace(/\s+/g, ' ').trim();
      if (t.length <= max) return t;
      // Cut at the last word boundary before max-3 to leave room for ellipsis.
      const sliced = t.slice(0, max - 1);
      const lastSpace = sliced.lastIndexOf(' ');
      const base = lastSpace > max * 0.6 ? sliced.slice(0, lastSpace) : sliced;
      return base + '…';
    };

    // --- Smart defaults (DOM derivation) ---------------------------------

    const smartDefaults = (() => {
      if (!ctx.seo.defaults) return {};
      // Title source: first <h1> inside <main>/<article>, then any <h1>.
      const h1El = document.querySelector('main h1, article h1') || document.querySelector('h1');
      const h1 = h1El ? (h1El.textContent || '').trim() : '';
      const composedTitle = (() => {
        if (!h1) return ctx.seo.siteName || null;
        if (!ctx.seo.siteName || h1 === ctx.seo.siteName) return h1;
        return `${h1} — ${ctx.seo.siteName}`;
      })();

      // Description: first non-trivial <p> in main/article content.
      const descCandidates = document.querySelectorAll('main p, article p, .prose p');
      let desc = '';
      for (const p of descCandidates) {
        const text = (p.textContent || '').trim();
        if (text.length >= 30) { desc = truncate(text, 160); break; }
      }

      // Image: snapshot URL if auto-snapshot was taken; else first content
      // <img> with a non-data src; else largest manifest icon.  Snapshot wins
      // over content <img> because it represents the rendered page and is
      // sized for OG/Twitter cards (1200×630), whereas a content image could
      // be a thumbnail of arbitrary aspect ratio.
      let imgSrc = ctx.snapshotUrl || '';
      if (!imgSrc) {
        const imgCandidates = document.querySelectorAll('main img[src], article img[src]');
        for (const img of imgCandidates) {
          const src = img.getAttribute('src') || '';
          if (src && !src.startsWith('data:')) { imgSrc = src; break; }
        }
      }
      if (!imgSrc && Array.isArray(ctx.seo.icons) && ctx.seo.icons.length) {
        // Largest icon by area.
        const sorted = ctx.seo.icons.slice().sort((a, b) => {
          const area = (s) => {
            const m = String(s?.sizes || '').match(/(\d+)x(\d+)/);
            return m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
          };
          return area(b) - area(a);
        });
        imgSrc = sorted[0]?.src || '';
      }

      // Type heuristic: 'article' if the page renders an <article> or its path
      // looks like article content (e.g. /docs/foo, /blog/foo, /articles/foo);
      // 'website' otherwise.
      const looksLikeArticle = !!document.querySelector('article')
        || /^\/(?:docs|blog|articles|posts|guides)\//i.test(location.pathname);
      const ogType = looksLikeArticle ? 'article' : 'website';

      return {
        title: composedTitle,
        description: desc || ctx.seo.siteDescription || null,
        image: imgSrc || null,
        ogType,
      };
    })();

    // --- Resolve a single meta value through the precedence chain --------

    const resolve = (key) => {
      // Layer 3: prerender.meta expression
      const exprMap = ctx.seo.meta || {};
      const expr = exprMap[key];
      if (typeof expr === 'string') {
        const v = evalAlpine(expr);
        if (v) return v;
      } else if (typeof expr === 'boolean' || typeof expr === 'number') {
        return String(expr);
      }
      // Image only: the per-page auto-snapshot outranks the generic static
      // fallback.image — it depicts this exact page and is sized for OG cards.
      // The fallback then only applies to pages with no snapshot.
      if (key === 'image' && ctx.snapshotUrl) return ctx.snapshotUrl;
      // Layer 4: explicit fallback
      const fallback = exprMap.fallback?.[key];
      if (fallback) return String(fallback);
      // Layer 5: smart defaults from DOM (page-specific — beats generic PWA fields).
      // For title specifically, the placeholder rule in setTitle() also requires
      // the static <title>Site</title> to be treated as missing so this wins.
      if (smartDefaults[key]) return smartDefaults[key];
      // Layer 6: PWA-style manifest.json fields — last-resort generic fallback
      if (key === 'title' && ctx.seo.siteName) return ctx.seo.siteName;
      if (key === 'description' && ctx.seo.siteDescription) return ctx.seo.siteDescription;
      if (key === 'author' && ctx.seo.siteAuthor) return ctx.seo.siteAuthor;
      return null;
    };

    // --- Title -----------------------------------------------------------

    setTitle(resolve('title'));

    // --- Description / author -------------------------------------------

    const description = resolve('description');
    setMeta('description', description);
    setMeta('author', resolve('author'));

    // --- Canonical URL (skip — already injected later by buildCanonicalAndHreflang) ---

    // --- OpenGraph / Twitter --------------------------------------------

    const liveBase = (ctx.liveUrl || '').replace(/\/$/, '');
    const pageUrl = ctx.pathSeg === '' || ctx.pathSeg === '__404__'
      ? (liveBase ? liveBase + '/' : null)
      : (liveBase ? `${liveBase}/${ctx.pathSeg}` : null);
    const finalTitle = getCurrentTitle().text || resolve('title');
    const ogType = resolve('ogType') || smartDefaults.ogType || 'website';
    const image = resolve('image');

    setMeta('og:title', finalTitle);
    setMeta('og:description', description);
    setMeta('og:type', ogType);
    setMeta('og:url', pageUrl);
    setMeta('og:site_name', ctx.seo.siteName);
    if (image) setMeta('og:image', image);

    setMeta('twitter:card', image ? 'summary_large_image' : 'summary');
    setMeta('twitter:title', finalTitle);
    setMeta('twitter:description', description);
    if (image) setMeta('twitter:image', image);

    // --- JSON-LD structured data ----------------------------------------

    const sd = ctx.seo.structuredData;
    if (sd && typeof sd === 'object') {
      const existingLdScripts = head.querySelectorAll('script[type="application/ld+json"]');
      const existingTypes = new Set();
      existingLdScripts.forEach((s) => {
        try {
          const parsed = JSON.parse(s.textContent || '{}');
          const t = Array.isArray(parsed) ? parsed.map((x) => x['@type']) : [parsed['@type']];
          t.forEach((tt) => tt && existingTypes.add(tt));
        } catch { /* skip malformed */ }
      });

      const resolveSdField = (v) => {
        if (typeof v === 'string') {
          const evaled = evalAlpine(v);
          return evaled ?? v; // if eval fails, keep literal (lets users write plain strings)
        }
        return v;
      };
      const resolveSchema = (obj) => {
        if (obj == null || typeof obj !== 'object') return obj;
        const out = {};
        for (const k of Object.keys(obj)) {
          out[k] = resolveSdField(obj[k]);
        }
        return out;
      };

      const blocks = [];
      for (const [type, def] of Object.entries(sd)) {
        if (existingTypes.has(type)) continue;
        if (def === false) continue;
        if (type === 'BreadcrumbList' && def === true) {
          // Auto-derive from URL path segments; skip crumbs whose URL has no
          // rendered page (avoids linking soft-404 intermediate paths).
          const parts = location.pathname.split('/').filter(Boolean);
          const rendered = Array.isArray(ctx.renderedPaths) ? new Set(ctx.renderedPaths) : null;
          const items = [{
            '@type': 'ListItem',
            position: 1,
            name: ctx.seo.siteName || 'Home',
            item: liveBase ? liveBase + '/' : '/',
          }];
          parts.forEach((seg, i) => {
            const crumbPath = parts.slice(0, i + 1).join('/');
            if (rendered && !rendered.has(crumbPath)) return;
            items.push({
              '@type': 'ListItem',
              position: items.length + 1,
              name: seg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              item: liveBase ? `${liveBase}/${crumbPath}` : '/' + crumbPath,
            });
          });
          blocks.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items });
          continue;
        }
        if (def === true) {
          // Bare-true for known schemas: minimal auto-fill
          if (type === 'WebSite') {
            blocks.push({
              '@context': 'https://schema.org',
              '@type': 'WebSite',
              name: ctx.seo.siteName || finalTitle || '',
              url: liveBase || '',
            });
          } else if (type === 'Article') {
            blocks.push({
              '@context': 'https://schema.org',
              '@type': 'Article',
              headline: finalTitle || '',
              description: description || '',
              ...(image ? { image } : {}),
              ...(pageUrl ? { url: pageUrl } : {}),
              ...(ctx.seo.siteAuthor ? { author: { '@type': 'Person', name: ctx.seo.siteAuthor } } : {}),
            });
          }
          continue;
        }
        if (typeof def === 'object') {
          const resolved = resolveSchema(def);
          blocks.push({ '@context': 'https://schema.org', '@type': type, ...resolved });
        }
      }

      for (const block of blocks) {
        const s = document.createElement('script');
        s.setAttribute('type', 'application/ld+json');
        s.textContent = JSON.stringify(block);
        head.appendChild(s);
      }
    }
  }, ctx);
}

/**
 * Strip HTML tags + collapse whitespace to plaintext.  Crude but sufficient for
 * meta description / llms-full content extraction; we run on prerendered HTML
 * where Alpine bindings have already been resolved to literal values.
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Group llms entries into sections by first URL segment ("Blog" for /blog/*),
 * root page as "Overview", in first-encounter order with each split section
 * placed directly after its parent.  Wherever a path holds two
 * or more sub-areas that each have their own page and children, each sub-area
 * becomes its own section labelled by its page title, recursively: /docs/ai/*
 * and /docs/framework/* split into "AI Plugins" and "Framework", and groups
 * inside them into "Framework / Core Plugins" and so on.  A lone sub-area
 * (/fr/docs under /fr) is walked through when a split lies below it, and the
 * first segment then leads the label ("Fr / AI Plugins").
 */
function groupLlmsSections(entries, siteName = '') {
  const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const paths = new Set(entries.map((e) => e.pathSeg));
  const parents = new Set();
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) parents.add(segs.slice(0, i).join('/'));
  }
  const childAreas = new Map();
  for (const p of paths) {
    if (!parents.has(p) || !p.includes('/')) continue;
    const parent = p.slice(0, p.lastIndexOf('/'));
    if (!childAreas.has(parent)) childAreas.set(parent, new Set());
    childAreas.get(parent).add(p);
  }
  const splits = (prefix) => (childAreas.get(prefix)?.size || 0) >= 2;
  const below = new Map();
  const splitsBelow = (prefix) => {
    if (!below.has(prefix)) {
      const kids = childAreas.get(prefix);
      below.set(prefix, splits(prefix) || (kids?.size === 1 && splitsBelow(kids.values().next().value)));
    }
    return below.get(prefix);
  };
  const suffix = siteName ? new RegExp(`\\s+[—–|-]\\s+${siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) : null;
  const titles = new Map(entries.map((e) => [e.pathSeg, e.title || '']));
  const labelCache = new Map();
  const titleOf = (area) => {
    if (labelCache.has(area)) return labelCache.get(area);
    let t = titles.get(area) || '';
    if (suffix) t = t.replace(suffix, '');
    t = t.trim();
    if (!t || t === siteName || t === area) t = titleCase(area.split('/').pop());
    labelCache.set(area, t);
    return t;
  };
  const sections = new Map();
  for (const entry of entries) {
    const segs = entry.pathSeg.split('/');
    const first = segs[0] || '';
    let key = first || 'Overview';
    const parts = first && !splits(first) && splitsBelow(first) ? [titleCase(first)] : [];
    let prefix = first;
    for (let i = 1; first && i < segs.length && splitsBelow(prefix); i++) {
      const child = segs.slice(0, i + 1).join('/');
      if (!childAreas.get(prefix).has(child)) break;
      if (splits(prefix)) {
        key = child;
        parts.push(titleOf(child));
      }
      prefix = child;
    }
    const label = parts.length > 1 || (parts.length && splits(first)) ? parts.join(' / ') : (first ? titleCase(first) : 'Overview');
    if (!sections.has(key)) sections.set(key, { label, entries: [] });
    sections.get(key).entries.push(entry);
  }
  const keys = [...sections.keys()];
  const parentOf = (key) => keys.filter((k) => key.startsWith(k + '/')).sort((a, b) => b.length - a.length)[0];
  const kids = new Map();
  for (const key of keys) {
    const parent = parentOf(key) ?? '';
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(key);
  }
  const ordered = new Map();
  const visit = (key) => {
    ordered.set(key, sections.get(key));
    for (const child of kids.get(key) || []) visit(child);
  };
  for (const key of kids.get('') || []) visit(key);
  return ordered;
}

async function renderRouteDom(page, ctx) {
  const { url, pathSeg, is404, currentLocale, locales, timeout, displayPath } = ctx;
  const navTimeoutMs = ctx.navTimeoutMs ?? Math.min(timeout, 30000);
  const debugOn = typeof ctx.onDebug === 'function';
  const pushDebug = (row) => { if (debugOn) ctx.onDebug(row); };
  const traceOn = typeof ctx.onTiming === 'function';
  const traceT0 = Date.now();
  let traceLast = traceT0;
  const stages = {};
  const mark = (stage) => { const n = Date.now(); stages[stage] = n - traceLast; traceLast = n; };
  // Render at a typical desktop viewport so layouts dependent on viewport
  // width (responsive flex/grid, container queries, media queries) settle
  // into their desktop variant.  Without this the headless default (often
  // 800×600) leaves narrower layouts baked into the prerendered HTML and
  // also produces blank OG screenshots for hero sections that rely on
  // viewport-driven flex distribution.
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
  // Align <html lang> with the URL being prerendered before any app script runs.
  // initializeDataSourcesPlugin picks locale from document.documentElement.lang first; a mismatch
  // (e.g. headless default vs /en/...) leaves $x.* empty while x-route sections still render.
  await page.evaluateOnNewDocument((locale) => {
    // Render pass: the defer plugin keeps closed containers eager so the
    // snapshot carries their markup (hydration stashes it again).
    window.__manifestRender = true;
    // routing-ready can fire before goto() resolves: latch it for the wait below.
    window.addEventListener('manifest:routing-ready', () => { window.__manifestRenderRoutingReady = true; }, { once: true });
    document.addEventListener('alpine:initialized', () => { window.__manifestRenderAlpineReady = true; }, { once: true });
    const apply = () => {
      try {
        if (locale && typeof locale === 'string') document.documentElement.lang = locale;
        // View transitions freeze a snapshot layer over the updated DOM in
        // headless — OG screenshots then capture stale pre-route pixels.
        // Router opt-out for SPA swaps, plus a late <style> so the reset's
        // cross-document @view-transition{navigation:auto} is overridden
        // (appended after stylesheets; last descriptor wins).
        document.documentElement.setAttribute('data-no-view-transitions', '');
        const killCrossDocVT = () => {
          try {
            const s = document.createElement('style');
            s.textContent = '@view-transition { navigation: none }';
            (document.head || document.documentElement).appendChild(s);
          } catch { /* no-op */ }
        };
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', killCrossDocVT, { once: true });
        } else {
          killCrossDocVT();
        }
      } catch {
        /* no-op */
      }
    };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply, { once: true });
      }
      apply();
    }
  }, currentLocale);

  // Record fetch() URLs for CONTENT files (e.g. x-markdown resolving
  // `/assets/articles/<locale>/slug.md`) so the caller can detect, after
  // this page renders, whether its content was fetched from a
  // locale-parameterized path — see promoteLocaleVariants() above.
  // Deliberately excludes structured-data extensions (.json/.yaml/.yml/.csv)
  // — those are the data/localization plugins' own per-locale fetches,
  // already handled correctly by the Node-side substitution pipeline
  // (loadAllLocaleContentData); counting them here false-positives on
  // every page that merely has locale-keyed data configured, regardless
  // of whether IT actually renders anything locale-dependent.
  await page.evaluateOnNewDocument(() => {
    window.__mnfstFetchedUrls = [];
    const CONTENT_URL_RE = /\.(md|markdown|html?|txt)([?#]|$)/i;
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url);
          if (url && CONTENT_URL_RE.test(String(url))) window.__mnfstFetchedUrls.push(String(url));
        } catch { /* no-op */ }
        return origFetch.call(this, input, init);
      };
    }
  });

  // Deterministic source-attribute capture via MutationObserver with
  // `attributeOldValue`.  This runs before ANY page script and records the
  // first (pre-mutation) value of every attribute that Alpine or a Manifest
  // plugin ever touches.  It also records the *initial* attributes of every
  // new element added to the DOM via childList mutations — so elements
  // parsed from innerHTML (components, markdown rendering, etc.) are also
  // captured the moment they appear.
  //
  // The observer handles all mutation surfaces at once:
  //   - setAttribute / removeAttribute
  //   - className setter
  //   - classList.add / remove / toggle / replace
  //   - style.* property assignments (which mutate the style attribute)
  //   - Any other path that ultimately modifies an attribute
  //
  // At serialize time we read the map, identify hydrate targets per the
  // catalog, and emit a compact JSON hydration contract.  The runtime
  // (`hydratePrerenderedPage` in manifest.js) reads the contract and
  // restores source attributes before Alpine starts.
  await page.evaluateOnNewDocument(() => {
    // element -> { attrName: originalValue (null if attribute was absent) }
    // Keyed by reference so detached elements drop out naturally.
    const sourceAttrs = new Map();
    // element -> original innerHTML (only populated for elements already
    // marked data-hydrate when we first see them — used for subtree-wide
    // restoration of explicit hydrate islands).
    const sourceInnerHTML = new Map();

    const recordInitialAttrs = (el) => {
      if (!el || el.nodeType !== 1 || sourceAttrs.has(el)) return;
      const rec = {};
      const list = el.attributes;
      for (let i = 0; i < list.length; i++) {
        rec[list[i].name] = list[i].value;
      }
      sourceAttrs.set(el, rec);
      if (el.hasAttribute && el.hasAttribute('data-hydrate')) {
        try { sourceInnerHTML.set(el, el.innerHTML); } catch (_) {}
      }
    };

    const handleMutations = (mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          const el = m.target;
          let rec = sourceAttrs.get(el);
          if (!rec) {
            // First time we see this element AT ALL via an attribute record:
            // seed with every current attribute so we never lose attrs that
            // existed before any mutation we happened to observe.
            rec = {};
            const list = el.attributes;
            for (let i = 0; i < list.length; i++) {
              rec[list[i].name] = list[i].value;
            }
            // Overwrite the one being mutated with the true oldValue
            // (which may be null if the attribute was absent pre-mutation).
            rec[m.attributeName] = m.oldValue;
            sourceAttrs.set(el, rec);
          } else if (!(m.attributeName in rec)) {
            rec[m.attributeName] = m.oldValue;
          }
        } else if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            recordInitialAttrs(node);
            if (node.querySelectorAll) {
              node.querySelectorAll('*').forEach(recordInitialAttrs);
            }
          }
        }
      }
    };

    const observer = new MutationObserver(handleMutations);

    let observing = false;
    const startObserving = () => {
      if (observing) return true;
      // We can observe `document` itself — MutationObserver accepts it as a
      // target and forwards subtree mutations, so we catch <html> creation
      // and everything under it without racing the parser.
      try {
        observer.observe(document, {
          attributes: true,
          attributeOldValue: true,
          childList: true,
          subtree: true,
        });
        observing = true;
      } catch (_) { return false; }
      // Seed whatever already exists.
      if (document.documentElement) {
        recordInitialAttrs(document.documentElement);
        document.documentElement.querySelectorAll('*').forEach(recordInitialAttrs);
      }
      return true;
    };
    startObserving();

    // Flush any pending mutations before the DOM is read for serialization.
    window.__manifestFlushHydrateSources = () => {
      try { handleMutations(observer.takeRecords()); } catch (_) {}
    };
    // Expose for the contract-emission phase.
    window.__manifestSourceAttrs = sourceAttrs;
    window.__manifestSourceInnerHTML = sourceInnerHTML;
  });

  // render.settle 'auto' (opt-in): the tracker reports pending work and quiet pages skip the fixed windows.
  const settleOn = ctx.settle === 'auto';
  if (settleOn) await page.evaluateOnNewDocument(installSettleTracker);
  // Tracking in auto, or for tracing's in-flight report; the fixed windows don't need it (it costs a CDP session)
  const net = settleOn || traceOn ? await trackNetwork(page) : null;
  const settleLog = [];
  // False: no tracker or the context stayed unreachable, so the caller runs the fixed windows for this route.
  const settle = async (phase, capMs) => {
    if (!settleOn) return false;
    const r = await waitForPageSettle(page, net, { capMs, ...SETTLE_FIXED[phase] });
    if (!r) return false;
    settleLog.push({ phase, ...r });
    return r.ok || r.reason === 'cap';
  };
  pushDebug({ path: displayPath, stage: 'start' });
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: navTimeoutMs,
  });
  mark('goto');

  // Settle waits.  These give Manifest plugins (especially the components
  // plugin, which lazy-fetches each component HTML over the network) time
  // to finish loading and expanding everything before we snapshot.  Each
  // wait is bounded; large projects with many components need the full
  // budget on cold runs, but small projects settle long before the cap.
  //
  // Lowered from the original "any wait could hold the prerender for ~50s
  // per path" defaults, but kept generous enough that Playcom-scale sites
  // (~10 preloaded components, dozens of lazy components) actually finish
  // expanding before snapshot.  Earlier reductions were too aggressive and
  // left unexpanded `<x-*>` placeholders in the output.
  let readyTimer;
  await Promise.race([
    page.evaluate(() => {
      return new Promise((resolve) => {
        // Routed: the latched event (or the router's own flag). Unrouted: the
        // loader has loaded every plugin (coordinator up) and none is a router.
        const settled = () => window.__manifestRenderRoutingReady
          || window.__manifestRoutingInitialized
          || (window.__manifestReadyCoordinator && !window.ManifestRouting);
        if (settled()) return resolve();
        const deadline = Date.now() + 3000;
        const t = setInterval(() => {
          if (settled() || Date.now() >= deadline) { clearInterval(t); resolve(); }
        }, 25);
      });
    }),
    new Promise((_, rej) => { readyTimer = setTimeout(() => rej(new Error('ready timeout')), timeout); }),
  ]).catch(() => { });
  clearTimeout(readyTimer);
  mark('routingReady');

  // Boot: plugins loaded and Alpine initialized — the route/locale events
  // below need their listeners. No wait when nothing on the page will boot
  // Alpine (no Alpine or Manifest script); otherwise capped at 3s.
  await page.evaluate(() => {
    return new Promise((resolve) => {
      const expected = () => typeof window.Alpine !== 'undefined'
        || !!document.querySelector('script[src*="alpine" i], script[src*="manifest" i]');
      const check = () => window.__manifestRenderAlpineReady || !expected();
      if (check()) return resolve();
      const deadline = Date.now() + 3000;
      const t = setInterval(() => {
        if (check() || Date.now() >= deadline) {
          clearInterval(t);
          resolve();
        }
      }, 25);
    });
  }).catch(() => { });
  mark('boot');

  // Content load: component templates, data sources, markdown, icons. Fixed windows when the page has no tracker.
  if (!(await settle('load', 30000))) {
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => { });
    mark('netIdle');
    await page.evaluate(() => {
      return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          clearTimeout(stable);
          stable = setTimeout(finish, 500);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        const finish = () => { clearTimeout(cap); observer.disconnect(); resolve(); };
        let stable = setTimeout(finish, 500);
        const cap = setTimeout(finish, 15000);
      });
    }).catch(() => { });
  }
  mark('domStable');

  // Set locale, dispatch route/locale events, warm data, run component
  // swapping — after content has loaded, so route-change handlers that scan
  // the DOM (data-head, anchors) see it, as on a settled SPA navigation.
  const started = await startManifestRouteState(page, {
    allLocales: locales,
    currentLocale,
    timeoutMs: ctx.pipelineTimeout,
  });
  mark('routeState');

  // Reactions to those events: deferred anchor refreshes, then the network
  // and DOM going quiet again (all capped). Routers with ManifestPending skip
  // anchor retries in prerender, so anchors re-extract once from settled content.
  if (await settle('route', 15000)) {
    const refreshed = await page.evaluate(() => {
      if (!window.ManifestPending) return 0;
      const els = document.querySelectorAll('[x-anchors]');
      for (const el of els) { try { el._x_anchorRefresh?.(); } catch { /* no-op */ } }
      return els.length;
    }).catch(() => 0);
    if (refreshed) await settle('route', 15000);
  } else {
    await page.evaluate(() => new Promise((resolve) => {
      const deadline = Date.now() + 2000;
      const t = setInterval(() => {
        const pending = Array.from(document.querySelectorAll('[x-anchors]'))
          .some((el) => el.__manifestRenderAnchorPending);
        if (!pending || Date.now() >= deadline) { clearInterval(t); resolve(); }
      }, 25);
    })).catch(() => { });
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => { });
    await page.evaluate(() => new Promise((resolve) => {
      let stable;
      const observer = new MutationObserver(() => { clearTimeout(stable); stable = setTimeout(finish, 300); });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      const finish = () => { clearTimeout(cap); observer.disconnect(); resolve(); };
      stable = setTimeout(finish, 300);
      const cap = setTimeout(finish, 5000);
    })).catch(() => { });
  }
  mark('routeSettle');

  // manifest:render-ready — the single authoritative signal that all data
  // sources have settled for this locale/route.
  const readyResult = started.ok
    ? { ...(await awaitManifestRenderReady(page, { timeoutMs: ctx.pipelineTimeout, probe: traceOn })), processAllMs: started.processAllMs }
    : started;
  mark('renderReady');
  if (traceOn && !readyResult.ok && net) readyResult.inflight = net.list();

  // Flush any remaining Alpine microtask effects after the render-ready signal.
  await flushAlpineEffects(page);
  mark('flush');

  // render.waitAfterIdle: extra time for late, quiet content (widgets that
  // settle seconds after load) — before the og image and the snapshot.
  if (ctx.waitAfterIdle > 0) {
    await new Promise((r) => setTimeout(r, ctx.waitAfterIdle));
    await flushAlpineEffects(page);
  }

  // OG image auto-snapshot — captured here, BEFORE the heavy DOM-transform
  // passes (template removal, hydration contract, route-hidden cleanup)
  // perturb the rendered visual state.  Skip if og:image is already set
  // by data-head, prerender.meta config, or an explicit fallback.
  let earlySnapshotUrl = null;
  if (ctx.seo.imageSnapshots) {
    // Only an EXPLICIT per-page image suppresses the auto-snapshot:
    // prerender.meta.image (a config expression) or an og:image already in
    // the head (data-head / index.html).  A generic prerender.meta.fallback
    // .image must NOT skip it — the per-page snapshot is the primary image
    // and the static fallback is only used when a snapshot isn't available
    // (see resolve('image') in injectMetaInDom).
    const ogImageHandled = !!ctx.seo.meta?.image
      || await page.evaluate(() => !!document.head.querySelector('meta[property="og:image"]'));
    if (!ogImageHandled) {
      // Bounded: a hung CDP call costs only this page's og image
      let ogTimer;
      try {
        earlySnapshotUrl = await Promise.race([
          ctx.ogSnapshot ? ctx.ogSnapshot(page, is404 ? '__404__' : pathSeg) : null,
          new Promise((resolve) => { ogTimer = setTimeout(() => resolve(null), 30000); }),
        ]);
      } finally {
        clearTimeout(ogTimer);
      }
    }
  }
  mark('og');
  if (settleOn) noteSettleExtra(stages.routeState + stages.renderReady + stages.flush + stages.og + (ctx.waitAfterIdle || 0));

  if (debugOn) {
    const before = await page.evaluate(() => {
      const templates = Array.from(document.querySelectorAll('template[x-for]'));
      const ownClones = (tpl) => {
        const lookup = tpl._x_lookup;
        if (!lookup || typeof lookup !== 'object') return null;
        try { return new Set(lookup instanceof Map ? lookup.values() : Object.values(lookup)); } catch { return null; }
      };
      const entries = templates.slice(0, 60).map((tpl) => {
        const first = tpl.content?.firstElementChild;
        const tag = first ? first.tagName : null;
        const cls = first ? (first.getAttribute('class') || '') : '';
        const own = ownClones(tpl);
        let cloneCount = 0;
        let next = tpl.nextElementSibling;
        while (next && (!tag || next.tagName === tag) && (!own || own.has(next))) {
          if (tag && (next.getAttribute('class') || '') !== cls) break;
          cloneCount++;
          next = next.nextElementSibling;
        }
        return {
          xFor: (tpl.getAttribute('x-for') || '').slice(0, 140),
          collapsed: tpl.getAttribute('data-prerender-collapsed') === '1',
          staticGenerated: tpl.getAttribute('data-prerender-static-generated') === '1',
          cloneCount,
        };
      });

      const listDiagnostics = {
        htmlLang: '',
        localeCurrent: null,
        dataLocaleChanging: null,
        dataStates: {},
        topLevelArrayLengths: {},
        nestedContentCards: null,
        emptyStaticXFors: [],
      };

      try {
        listDiagnostics.htmlLang = document.documentElement.lang || '';
        const Alpine = window.Alpine;
        if (Alpine?.store) {
          const loc = Alpine.store('locale');
          listDiagnostics.localeCurrent = loc?.current ?? null;
          const d = Alpine.store('data');
          if (d) {
            listDiagnostics.dataLocaleChanging = !!d._localeChanging;
            for (const k of Object.keys(d)) {
              if (k.startsWith('_') && k.endsWith('_state')) {
                const short = k.slice(1, -'_state'.length);
                const s = d[k];
                if (s && typeof s === 'object') {
                  listDiagnostics.dataStates[short] = {
                    loading: !!s.loading,
                    ready: !!s.ready,
                    hasError: s.error != null,
                  };
                }
              } else if (!k.startsWith('_') && Array.isArray(d[k])) {
                listDiagnostics.topLevelArrayLengths[k] = d[k].length;
              }
            }
            try {
              const cards = d.content?.home?.differentiators?.cards;
              if (Array.isArray(cards)) listDiagnostics.nestedContentCards = cards.length;
              else if (cards && typeof cards === 'object') listDiagnostics.nestedContentCards = Object.keys(cards).length;
              else listDiagnostics.nestedContentCards = cards == null ? null : 'non-iterable';
            } catch {
              listDiagnostics.nestedContentCards = 'error';
            }
          }
        }
      } catch (e) {
        listDiagnostics.probeError = String(e?.message || e);
      }

      for (const tpl of templates) {
        if (tpl.getAttribute('data-prerender-collapsed') === '1') continue;
        const first = tpl.content?.firstElementChild;
        const tag = first ? first.tagName : null;
        const cls = first ? (first.getAttribute('class') || '') : '';
        const own = ownClones(tpl);
        let cloneCount = 0;
        let next = tpl.nextElementSibling;
        while (next && (!tag || next.tagName === tag) && (!own || own.has(next))) {
          if (tag && (next.getAttribute('class') || '') !== cls) break;
          cloneCount++;
          next = next.nextElementSibling;
        }
        if (cloneCount > 0) continue;
        const routeAnc = tpl.closest('[x-route]');
        let hiddenReason = null;
        let el = tpl.parentElement;
        while (el) {
          if (el.hasAttribute('hidden')) {
            hiddenReason = 'ancestor-hidden';
            break;
          }
          const st = el.getAttribute('style') || '';
          if (/\bdisplay\s*:\s*none\b/i.test(st)) {
            hiddenReason = 'ancestor-display-none';
            break;
          }
          el = el.parentElement;
        }
        const itemsHost = tpl.closest('[items]');
        listDiagnostics.emptyStaticXFors.push({
          xFor: (tpl.getAttribute('x-for') || '').slice(0, 160),
          nearestXRoute: routeAnc ? (routeAnc.getAttribute('x-route') || '').slice(0, 100) : null,
          hiddenReason,
          hostItemsAttr: itemsHost ? (itemsHost.getAttribute('items') || '').slice(0, 120) : null,
        });
      }

      return {
        templateCount: templates.length,
        nonCollapsedTemplateCount: templates.filter((t) => t.getAttribute('data-prerender-collapsed') !== '1').length,
        hint:
          'entries.staticGenerated is read before the x-for mark pass and is always false; use stage post-xfor-mark for data-prerender-static-generated.',
        entries,
        listDiagnostics,
      };
    }).catch(() => null);
    pushDebug({ path: displayPath, stage: 'post-dom-settle', metrics: before });
  }


  // Wait for async content in static lists: elements with x-init (fetch) + x-html should have content (e.g. inline SVG) before snapshot.
  const asyncContentTimeout = 5000;
  const asyncContentInterval = 100;
  const asyncStart = Date.now();
  for (; ;) {
    const { pending, total } = await page.evaluate(() => {
      const els = document.querySelectorAll('[x-init][x-html]');
      const withFetch = Array.from(els).filter((el) => (el.getAttribute('x-init') || '').includes('fetch'));
      const stillEmpty = withFetch.filter((el) => !el.querySelector('svg') && !el.textContent.trim());
      return { pending: stillEmpty.length, total: withFetch.length };
    });
    if (pending === 0 || total === 0 || Date.now() - asyncStart >= asyncContentTimeout) {
      break;
    }
    await new Promise((r) => setTimeout(r, asyncContentInterval));
  }
  mark('asyncContent');

  // Strip x-init, x-data, x-html from elements that already have content (e.g. inline SVG from fetch).
  // Keeps the baked-in content as static HTML; Alpine won't re-fetch or overwrite on load.
  await page.evaluate(() => {
    document.querySelectorAll('[x-init][x-html]').forEach((el) => {
      if (!el.querySelector('svg') && !el.textContent.trim()) return;
      el.removeAttribute('x-init');
      el.removeAttribute('x-data');
      el.removeAttribute('x-html');
    });
  });

  // Strip x-markdown from elements that already have baked content.
  // The markdown plugin hides elements with opacity:0 on init, then re-fetches
  // and re-renders.  For prerendered pages the content is already baked —
  // removing x-markdown prevents the runtime plugin from re-processing (and
  // temporarily hiding) the static content.
  //
  // We ALSO clear any leftover `opacity: 0` inline style the plugin set
  // before/while rendering.  On dynamic expressions that initially evaluate
  // empty (e.g. article content keyed off `$route` before `$x.articles` has
  // loaded), the plugin sets opacity to 0 and may never restore it to 1 if
  // the effect re-fires with an empty value.  The end state in the
  // serialized HTML has rendered content but opacity:0 — invisible in
  // production.  Since we're also removing x-markdown (so the runtime
  // plugin doesn't re-hide the element), leaving the inline style would
  // permanently hide authored content.
  await page.evaluate(() => {
    document.querySelectorAll('[x-markdown]').forEach((el) => {
      if (!el.textContent.trim() && !el.innerHTML.trim()) return;
      // Only FILE-BACKED markdown is safe to freeze: its content is baked and
      // the runtime would only re-fetch and re-render the same thing (with an
      // opacity flash, or a wipe when a route-keyed source starts empty). The
      // plugin stamps those with data-mnfst-md-src before fetching. An inline
      // reactive value (x-markdown="note") must KEEP its binding — stripping
      // it froze live-updating markdown mirrors on prerendered pages.
      const src = el.getAttribute('data-mnfst-md-src');
      const literal = /^\s*(['"`]).*\1\s*$/.test(el.getAttribute('x-markdown') || '');
      if (!src && !literal) {
        // Reactive: keep the binding, still clean the plugin's leftover styles.
        const s = el.getAttribute('style') || '';
        if (s) {
          const c = s.replace(/\bopacity\s*:\s*0(?:\.\d+)?\s*;?/gi, '')
            .replace(/\btransition\s*:\s*opacity[^;]*;?/gi, '')
            .replace(/;\s*;/g, ';').replace(/^\s*;\s*|\s*;\s*$/g, '').trim();
          if (c) el.setAttribute('style', c); else el.removeAttribute('style');
        }
        return;
      }
      el.removeAttribute('x-markdown');
      // Clean up opacity-0 + transition inline styles the plugin left behind.
      const style = el.getAttribute('style') || '';
      if (style) {
        const cleaned = style
          .replace(/\bopacity\s*:\s*0(?:\.\d+)?\s*;?/gi, '')
          .replace(/\btransition\s*:\s*opacity[^;]*;?/gi, '')
          .replace(/;\s*;/g, ';')
          .replace(/^\s*;\s*|\s*;\s*$/g, '')
          .trim();
        if (cleaned) el.setAttribute('style', cleaned);
        else el.removeAttribute('style');
      }
    });
  });

  // Classification for the locale-substitution defect (see promoteLocaleVariants
  // above): did this page fetch a URL that embeds the locale it was just
  // rendered at? If so its content is locale-parameterized at runtime and
  // substitution would ship this (possibly default-locale) body to every
  // locale — flag it so the caller Puppeteer-renders each locale variant instead.
  if (ctx.localeSubstitution && ctx.onLocaleDependentContent && currentLocale) {
    const fetchedUrls = await page
      .evaluate(() => {
        const seen = (window.__mnfstFetchedUrls || []).slice();
        // Deterministic complement to the fetch hook: content directives
        // stamp their resolved source before fetching, so a fetch that
        // races page settle is still visible here.
        for (const el of document.querySelectorAll('[data-mnfst-md-src]')) {
          const v = el.getAttribute('data-mnfst-md-src');
          if (v) seen.push(v);
        }
        return seen;
      })
      .catch(() => []);
    const localeToken = currentLocale.toLowerCase();
    const localeDependent = fetchedUrls.some((u) => {
      try {
        const p = new URL(u, ctx.baseUrl).pathname;
        return p.split('/').filter(Boolean).some((s) => s.toLowerCase() === localeToken);
      } catch { return false; }
    });
    if (localeDependent) ctx.onLocaleDependentContent(pathSeg || '');
  }

  // Emit the hydration contract: walk the DOM, identify every hydrate
  // target (explicit `data-hydrate`, interactive Manifest directives,
  // diff-semantic bindings, runtime-magic-driven bindings), tag each with
  // `data-hydrate-id`, and collect the diff between each target's source
  // attributes (recorded by the MutationObserver in evaluateOnNewDocument)
  // and its current post-render attributes.  The contract is returned as a
  // JSON-serialisable array; the runtime reads it on page load and restores
  // source state before Alpine starts.
  //
  // For explicit `data-hydrate` roots, the entry also carries the original
  // innerHTML so the whole subtree is restored to source, not just its
  // attributes.
  //
  // The catalog here is the authoritative list of "what counts as
  // interactive" and MUST match the docs/articles surface.
  const hydrationContractRaw = await page.evaluate(() => {
    // Drain any mutations not yet delivered to the observer so our source
    // map has the latest values.
    try { window.__manifestFlushHydrateSources && window.__manifestFlushHydrateSources(); } catch (_) {}

    const sourceAttrs = window.__manifestSourceAttrs || new Map();
    const sourceInnerHTML = window.__manifestSourceInnerHTML || new Map();

    // --- CATALOG: what makes an element a hydrate target ---
    // Interactive Manifest-registered directives that attach click/hover/
    // observer state at runtime and therefore need the live Alpine scope.
    const INTERACTIVE_DIRECTIVES = new Set([
      'x-color', 'x-dropdown', 'x-tooltip', 'x-tab', 'x-tabpanel',
      'x-toast', 'x-carousel', 'x-anchors', 'x-model',
      'x-files', 'x-data-files',
    ]);
    // Runtime-only Alpine magics whose values change after the prerender
    // snapshot (e.g. via media query, route change, auth state).  Bindings
    // referencing these must re-evaluate in the live page.
    const RUNTIME_MAGIC_RX = /(?<!['"])\$(color|locale|url|auth|search|query|toast)\b/;

    const isDiffBindingAttr = (name) =>
      name === ':class' || name === 'x-bind:class' ||
      name === ':style' || name === 'x-bind:style';

    const isEventAttr = (name) =>
      name.charCodeAt(0) === 64 /* @ */ || name.startsWith('x-on:');

    const isBindingAttr = (name) =>
      name.charCodeAt(0) === 58 /* : */ || name.startsWith('x-bind:') || name.startsWith('x-');

    const classifyElement = (el) => {
      // Explicit data-hydrate — subtree-wide restoration.
      if (el.hasAttribute('data-hydrate')) return 'explicit';

      // data-static: the author has frozen this subtree post-bake — Alpine
      // is not re-rendering iteration here, and the baked class/style/etc.
      // represent the intended final state.  Including these elements in
      // the hydration contract would null out their baked class (per the
      // diff-binding rule below), undoing the SEO-baked styling.  Skip.
      if (el.hasAttribute('data-static') || el.closest('[data-static]')) return null;

      const list = el.attributes;
      for (let i = 0; i < list.length; i++) {
        const name = list[i].name;
        const val = list[i].value;

        if (INTERACTIVE_DIRECTIVES.has(name)) return 'interactive';
        if (isEventAttr(name)) return 'event';
        if (isDiffBindingAttr(name)) return 'diff-binding';
        if (isBindingAttr(name) && val && RUNTIME_MAGIC_RX.test(val)) return 'runtime-magic';
      }
      return null;
    };

    // --- Walk: collect all hydrate targets ---
    const targets = new Set();
    const subtreeRoots = new Set(); // explicit roots — restore innerHTML too
    const all = document.body ? document.body.querySelectorAll('*') : [];
    all.forEach((el) => {
      const kind = classifyElement(el);
      if (!kind) return;
      if (kind === 'explicit') {
        subtreeRoots.add(el);
        targets.add(el);
        el.querySelectorAll('*').forEach((d) => targets.add(d));
      } else {
        targets.add(el);
      }
    });

    // --- Build contract entries ---
    let nextId = 0;
    const entries = [];
    targets.forEach((el) => {
      const source = sourceAttrs.get(el);
      const attrsOut = {};
      let dirty = false;

      // Collect attributes that DIVERGED from source.  For each current
      // attribute: if the source recorded a different value (or absent),
      // we need to restore the source value.
      const currentAttrs = {};
      const list = el.attributes;
      for (let i = 0; i < list.length; i++) {
        currentAttrs[list[i].name] = list[i].value;
      }

      if (source) {
        // For every attribute in source, check if current differs.
        for (const name in source) {
          if (name === 'data-hydrate-id') continue;
          const src = source[name];
          const cur = name in currentAttrs ? currentAttrs[name] : null;
          if (src !== cur) {
            // If the source value is null (attribute didn't exist originally)
            // but a reactive Alpine binding controls this attribute, skip the
            // restoration.  Alpine will re-evaluate the binding on init and
            // set the correct value; nulling it in the contract would flash
            // the element unstyled until Alpine + async data loads catch up.
            // The baked value IS the correct initial render.
            if (src === null) {
              // Keep baked `style` when an Alpine binding manages it.
              // The baked value (e.g. `mask-image: url(...)` from a `:style`
              // expression evaluating against $x data, or `display: none`
              // from `x-show`) is the correct initial render — nulling it
              // would flash the element while Alpine + async data catch up.
              // Alpine's :style/x-show handlers diff against the current
              // DOM correctly, so the baked value is safely toggled later.
              const skipStyleNull = name === 'style' &&
                (':style' in source || 'x-bind:style' in source || 'x-show' in source);
              if (skipStyleNull) continue;
              // NOTE: do NOT extend this skip to `class`.  Alpine's
              // `:class="cond ? 'foo' : ''"` (string-form) treats the
              // pre-existing className as the immutable baseline and only
              // ADDS classes on top — it cannot REMOVE a baked class.  If
              // the prerender baked `class="selected"` for the initial
              // tab, clicking other tabs would never strip `selected`
              // from the first one.  Always restoring class to null lets
              // Alpine manage it cleanly from a blank slate.
            }
            attrsOut[name] = src; // may be null (means "remove this attribute")
            dirty = true;
          }
        }
        // For current attributes that weren't in source, remove them.
        for (const name in currentAttrs) {
          if (name === 'data-hydrate-id') continue;
          if (!(name in source)) {
            attrsOut[name] = null;
            dirty = true;
          }
        }
      }
      // If no source recorded and it's not an explicit subtree root, the
      // element had no mutations observed — no restoration needed.

      const innerHTMLSource = sourceInnerHTML.get(el);
      let innerHTMLEntry;
      if (subtreeRoots.has(el) && innerHTMLSource !== undefined) {
        if (innerHTMLSource !== el.innerHTML) {
          innerHTMLEntry = innerHTMLSource;
          dirty = true;
        }
      }

      if (!dirty) return;

      const id = 'h' + nextId++;
      el.setAttribute('data-hydrate-id', id);
      const entry = { id, attrs: attrsOut };
      if (innerHTMLEntry !== undefined) entry.html = innerHTMLEntry;
      entries.push(entry);
    });

    return entries;
  });
  // Stash the contract on the route record for HTML injection later.
  // We carry it through as a string to avoid re-stringifying multiple times.
  const hydrationContractJSON = JSON.stringify(hydrationContractRaw || []);
  if (debugOn) {
    pushDebug({
      path: displayPath,
      stage: 'hydrate-contract',
      metrics: { entries: (hydrationContractRaw || []).length },
    });
  }

  // Stamp each x-for's clones from Alpine's own bookkeeping (_x_lookup) so the passes below stop at the
  // list's real end, not at the next same-tag sibling. Stamps survive cloneNode; removed before serialization.
  await page.evaluate(() => {
    const A = window.Alpine;
    const runBatch = typeof A?.mutateDom === 'function' ? (fn) => A.mutateDom(fn) : (fn) => fn();
    runBatch(() => {
      document.querySelectorAll('template[x-for]').forEach((tpl) => {
        const lookup = tpl._x_lookup;
        if (!lookup || typeof lookup !== 'object') return;
        let els;
        try { els = new Set(lookup instanceof Map ? lookup.values() : Object.values(lookup)); } catch { return; }
        window.__mnfstXforSeq = (window.__mnfstXforSeq || 0) + 1;
        const key = 'f' + window.__mnfstXforSeq;
        tpl.setAttribute('data-mnfst-xfor', key);
        // Everything up to the last tracked clone (untracked orphans between still belong to the list).
        const run = [];
        let last = 0;
        let found = 0;
        for (let n = tpl.nextElementSibling; n && found < els.size; n = n.nextElementSibling) {
          run.push(n);
          if (els.has(n)) { last = run.length; found++; } else if (run.length - last > 50) break;
        }
        run.slice(0, last).forEach((el) => el.setAttribute('data-mnfst-xfor-of', key));
      });
    });
  });

  // x-for lists: keep static lists in the HTML for SEO; collapse only dynamic lists so Alpine re-renders.
  // Explicit: data-prerender="dynamic"|"skip". Inferred: x-for uses $search/$query,
  // $url, $auth, or iterates over getter names (filtered*, results, searchResults). See docs prerender + local.data.
  await page.evaluate(() => {
    document.querySelectorAll('template[x-for]').forEach((tpl) => {
      if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) {
        tpl.removeAttribute('data-prerender-collapsed');
        tpl.removeAttribute('data-prerender-static-generated');
        return;
      }
      const xFor = (tpl.getAttribute('x-for') || '').trim();
      const prerender = (tpl.getAttribute('data-prerender') || '').toLowerCase();
      const explicit = prerender === 'dynamic' || prerender === 'skip';
      const inferred = xFor.includes('$search') || xFor.includes('$query') ||
        xFor.includes('$url') || xFor.includes('$auth') ||
        /\bin\s+(filtered\w*|results|searchResults)\b/.test(xFor);
      // data-static (on template or ancestor) opts the list out of dynamic
      // collapse and pins it to the static-bake path, even if the x-for
      // expression looks dynamic.  Mirrors data-hydrate as the alternative:
      // data-hydrate keeps a subtree live for runtime hydration; data-static
      // freezes baked clones into the HTML for SEO with no further re-render.
      const isStatic = tpl.hasAttribute('data-static') || !!tpl.closest('[data-static]');
      const forceCollapse = !isStatic && (explicit || inferred);
      if (!forceCollapse) {
        tpl.removeAttribute('data-prerender-collapsed');
        tpl.removeAttribute('data-prerender-static-generated');
        // Static mode: if prerender produced concrete siblings, mark template for removal later.
        //
        // Default sibling-match check is strict (tag + class) to avoid
        // capturing unrelated elements that happen to share a tag.  Under
        // data-static the user has explicitly opted in to baking, so we
        // relax to tag-only — Alpine's :class evaluation on clones often
        // differs from the template's static class (e.g. template has no
        // `class=` and clones have an evaluated string), and the strict
        // check would miss the clones and leave the template unmarked.
        const first = tpl.content?.firstElementChild;
        if (first) {
          const tag = first.tagName;
          const cls = first.getAttribute('class') || '';
          const own = tpl.getAttribute('data-mnfst-xfor');
          let next = tpl.nextElementSibling;
          let generatedCount = 0;
          while (next) {
            if (next.tagName !== tag) break;
            if (own && next.getAttribute('data-mnfst-xfor-of') !== own) break;
            if (!isStatic) {
              const sameClass = (next.getAttribute('class') || '') === cls;
              if (!sameClass) break;
            }
            generatedCount++;
            next = next.nextElementSibling;
          }
          if (generatedCount > 0) {
            tpl.setAttribute('data-prerender-static-generated', '1');
          }
        }
        return; // keep prerendered list for SEO
      }
      tpl.setAttribute('data-prerender-collapsed', '1');
      const first = tpl.content?.firstElementChild;
      if (!first) return;
      const tag = first.tagName;
      const cls = first.getAttribute('class') || '';
      const own = tpl.getAttribute('data-mnfst-xfor');
      let next = tpl.nextElementSibling;
      while (next) {
        const sameTag = next.tagName === tag;
        const sameClass = (next.getAttribute('class') || '') === cls;
        const isLikelyClone = sameTag && sameClass && (!own || next.getAttribute('data-mnfst-xfor-of') === own);
        const toRemove = next;
        next = next.nextElementSibling;
        if (isLikelyClone) toRemove.remove();
        else break;
      }
    });
  });

  if (debugOn) {
    const afterMark = await page.evaluate(() => {
      const rows = [];
      for (const tpl of document.querySelectorAll('template[x-for]')) {
        rows.push({
          xFor: (tpl.getAttribute('x-for') || '').slice(0, 140),
          collapsed: tpl.getAttribute('data-prerender-collapsed') === '1',
          staticGenerated: tpl.getAttribute('data-prerender-static-generated') === '1',
        });
      }
      return {
        templateCount: rows.length,
        staticMarkedCount: rows.filter((r) => r.staticGenerated).length,
        collapsedCount: rows.filter((r) => r.collapsed).length,
        entries: rows.slice(0, 60),
      };
    }).catch(() => null);
    pushDebug({ path: displayPath, stage: 'post-xfor-mark', metrics: afterMark });
  }

  // For static x-for clones that contain data-hydrate elements, inject the loop-scope
  // variable as x-data on the clone element itself. This ensures that after the loop
  // template is removed, data-hydrate bindings referencing loop variables (e.g.
  // plan?.price?.[currency]?.[frequency]) continue to work at runtime via the injected scope.
  // The parent Alpine scope (e.g. <main x-data="{ currency, frequency }") remains accessible.
  await page.evaluate(() => {
    const loopVarRx = /^\s*(?:\(\s*([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*\)|([A-Za-z_$][\w$]*))\s+in\s+/;
    document.querySelectorAll('template[x-for][data-prerender-static-generated="1"]').forEach((tpl) => {
      if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
      const xFor = (tpl.getAttribute('x-for') || '').trim();
      const m = xFor.match(loopVarRx);
      const itemVar = m ? (m[1] || m[3] || '') : '';
      if (!itemVar) return;
      const first = tpl.content && tpl.content.firstElementChild;
      if (!first) return;
      const tag = first.tagName;
      const cls = first.getAttribute('class') || '';
      const own = tpl.getAttribute('data-mnfst-xfor');
      let n = tpl.nextElementSibling;
      while (n && n.tagName === tag && (n.getAttribute('class') || '') === cls && (!own || n.getAttribute('data-mnfst-xfor-of') === own)) {
        // Only process clones that contain data-hydrate descendants
        if (
          !n.hasAttribute('x-data') &&
          (n.hasAttribute('data-hydrate') || n.querySelector('[data-hydrate]'))
        ) {
          try {
            const A = window.Alpine;
            if (A) {
              // Alpine.evaluate(el, expr) evaluates in the full scope chain including
              // x-for loop variables, unlike Alpine.$data() which only sees x-data attrs.
              let raw = undefined;
              if (typeof A.evaluate === 'function') {
                raw = A.evaluate(n, itemVar);
              } else if (typeof A.$data === 'function') {
                // Fallback: $data only sees x-data scopes, not x-for vars
                const scope = A.$data(n);
                if (scope && Object.prototype.hasOwnProperty.call(scope, itemVar)) {
                  raw = scope[itemVar];
                }
              }
              if (raw !== undefined && raw !== null) {
                // Serialize only own-enumerable properties to avoid circular refs / proxies
                const snapshot = JSON.parse(JSON.stringify(raw));
                n.setAttribute('x-data', JSON.stringify({ [itemVar]: snapshot }));
              }
            }
          } catch { /* serialisation failed — leave binding as-is */ }
        }
        n = n.nextElementSibling;
      }
    });
  });

  // Strip loop-scope bindings from x-for clones while <template> nodes still exist.
  // (If we remove static templates first, querySelectorAll('template[x-for]') misses them and clones
  // keep x-text/x-bind referencing card/item — Alpine then mutates or errors on the static HTML.)
  //
  // Wrapped in Alpine.mutateDom so attribute removals (e.g. removing :class)
  // don't trigger Alpine's reactive teardown — without this, Alpine sees
  // the :class attribute disappear, runs its unbind effect, and clears the
  // bound attribute (class) back to its pre-binding value (empty for clones
  // whose template had no static class).  mutateDom suppresses the observer
  // for the duration of the callback.
  await page.evaluate(() => {
    const A = window.Alpine;
    const runBatch = typeof A?.mutateDom === 'function' ? (fn) => A.mutateDom(fn) : (fn) => fn();
    // Collect every loop-scope identifier from the x-for LHS, including
    // destructuring forms — `item`, `(item, index)`, `[key, val]`,
    // `{ a, b }`.  The old single/paren-only regex skipped destructured
    // loops entirely, leaving bindings like x-text="file?.label" on baked
    // clones; at runtime Alpine evaluated them outside the iteration scope
    // and threw "file is not defined".
    const extractLoopVars = (xForExpr) => {
      const m = String(xForExpr || '').match(/^([\s\S]*?)\s+(?:in|of)\s+/);
      return m ? (m[1].match(/[A-Za-z_$][\w$]*/g) || []) : [];
    };
    // Include x-init: expanded clones still had x-init="getDescription(article)" etc.; Alpine then throws (article undefined).
    const bindingAttrRegex = /^(?:x-bind:|:|x-text|x-html|x-show|x-if|x-model|x-effect|x-init|x-icon|x-on:|@)/;
    const hasVar = (expr, varName) => varName && new RegExp(`\\b${varName}\\b`).test(expr || '');
    const stripLoopBindings = (el, loopVars) => {
      const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
      // A clone given its own loop scope (x-data injected for hydrate islands) keeps empty bindings live.
      const scoped = loopVars.some((v) => hasVar(el.getAttribute('x-data'), v));
      for (const node of nodes) {
        // Skip elements inside data-hydrate islands — their bindings must remain live
        if (node.hasAttribute('data-hydrate') || node.closest('[data-hydrate]')) continue;
        const attrs = node.attributes ? Array.from(node.attributes) : [];
        for (const attr of attrs) {
          if (!bindingAttrRegex.test(attr.name)) continue;
          const expr = attr.value || '';
          if (loopVars.some((v) => hasVar(expr, v))) {
            const name = attr.name;
            if (name === 'x-text' || name === 'x-html') {
              if (!scoped || (node.textContent || '').trim() || (node.innerHTML || '').trim()) {
                node.removeAttribute(name);
              }
              continue;
            }
            if (name === 'x-show' || name === 'x-if') {
              node.removeAttribute(name);
              continue;
            }
            if (name === 'x-icon') {
              node.setAttribute('x-icon', '');
              continue;
            }
            let boundAttr = '';
            if (name.startsWith(':')) boundAttr = name.slice(1);
            else if (name.startsWith('x-bind:')) boundAttr = name.slice('x-bind:'.length);
            if (boundAttr) {
              // Removing :foo triggers Alpine's binding teardown, which
              // restores the bound attribute to its pre-binding value
              // (empty for clones whose template had no static class).
              // Snapshot the eval'd value and re-set it after removal so
              // the baked attribute survives the unbind. A binding whose
              // value evaluated to null (no attribute) is removed all the
              // same — left in place it re-evaluates at runtime outside
              // the loop scope and throws on every render.
              const concrete = node.getAttribute(boundAttr);
              node.removeAttribute(name);
              if (concrete != null && String(concrete).trim() !== '') {
                node.setAttribute(boundAttr, concrete);
              }
              continue;
            }
            node.removeAttribute(name);
          }
        }
      }
    };

    runBatch(() => {
      document.querySelectorAll('template[x-for]').forEach((tpl) => {
        if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
        const xFor = (tpl.getAttribute('x-for') || '').trim();
        const loopVars = extractLoopVars(xFor);
        if (!loopVars.length) return;

        const first = tpl.content?.firstElementChild;
        if (!first) return;
        const tag = first.tagName;
        const own = tpl.getAttribute('data-mnfst-xfor');

        let next = tpl.nextElementSibling;
        while (next) {
          if (next.tagName !== tag) break;
          if (own && next.getAttribute('data-mnfst-xfor-of') !== own) break;
          stripLoopBindings(next, loopVars);
          next = next.nextElementSibling;
        }
      });
    });
  });

  // Remove static x-for templates once static clones are generated.
  // Alpine registers a cleanup on <template x-for> that removes every node in _x_lookup when the
  // template is detached — so tpl.remove() alone deletes all sibling clones (empty grids in output).
  // Replace each clone with a deep cloneNode first so teardown targets detached nodes; copies stay in DOM.
  //
  // Iterate until quiet: when an outer template's siblings are deep-cloned,
  // any nested templates inside those clones become FRESH DOM nodes that
  // weren't in the original querySelectorAll snapshot.  We re-query and
  // re-process until no marked templates remain, so nested static lists
  // (e.g. <template x-for="group in $x.docs"> with an inner
  // <template x-for="item in group.items">) are fully baked and removed.
  await page.evaluate(() => {
    const A = window.Alpine;
    const runBatch = typeof A?.mutateDom === 'function' ? (fn) => A.mutateDom(fn) : (fn) => fn();
    const SAFETY_PASSES = 8;
    for (let pass = 0; pass < SAFETY_PASSES; pass++) {
      const remaining = document.querySelectorAll('template[x-for][data-prerender-static-generated="1"]');
      if (remaining.length === 0) break;
      let processed = 0;
      runBatch(() => {
        remaining.forEach((tpl) => {
        if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
        // $x-driven x-for: by default, keep the template so Alpine can
        // re-render the list at runtime (locale switching, filtering, etc.)
        // and remove the static clones — Alpine creates fresh clones on
        // init and does NOT adopt existing DOM nodes, so leaving them
        // produces duplicates.  Individual article/pricing pages still
        // have full baked content (via x-text/x-html); the x-for list is
        // only the index/grid view.
        //
        // Opt-in via data-static (on template or ancestor) reverses this:
        // we keep the baked clones for SEO and remove the template instead,
        // which freezes the list (Alpine has nothing left to iterate, so
        // no duplicates and no runtime re-render).  Use this for static
        // navigation lists or any $x-driven list whose source data does
        // not change after first paint.  Loop-scope bindings on the kept
        // clones are stripped earlier in the pipeline.
        const xFor = (tpl.getAttribute('x-for') || '');
        const isStatic = tpl.hasAttribute('data-static') || !!tpl.closest('[data-static]');
        if (xFor.includes('$x') && !isStatic) {
          const first = tpl.content?.firstElementChild;
          if (first) {
            const tag = first.tagName;
            const cls = first.getAttribute('class') || '';
            const own = tpl.getAttribute('data-mnfst-xfor');
            let n = tpl.nextElementSibling;
            while (n && n.tagName === tag && (n.getAttribute('class') || '') === cls && (!own || n.getAttribute('data-mnfst-xfor-of') === own)) {
              const next = n.nextElementSibling;
              n.remove();
              n = next;
            }
          }
          tpl.removeAttribute('data-prerender-static-generated');
          return;
        }
        const parent = tpl.parentNode;
        if (!parent) {
          tpl.remove();
          return;
        }
        const first = tpl.content?.firstElementChild;
        if (!first) {
          tpl.remove();
          return;
        }
        const tag = first.tagName;
        const cls = first.getAttribute('class') || '';
        const own = tpl.getAttribute('data-mnfst-xfor');
        let n = tpl.nextElementSibling;
        while (n && n.tagName === tag && (!own || n.getAttribute('data-mnfst-xfor-of') === own)) {
          // Same rationale as the marking pass: under data-static, relax
          // class match (Alpine's :class evaluation on clones often differs
          // from the template's static class).
          if (!isStatic && (n.getAttribute('class') || '') !== cls) break;
          const next = n.nextElementSibling;
          n.replaceWith(n.cloneNode(true));
          n = next;
        }
        tpl.remove();
        processed++;
      });
      });
      if (processed === 0) break;
    }
  });

  // Remove orphan x-for clones that still reference loop-scope vars (e.g. image/index)
  // outside their template scope. These throw Alpine errors in live static hosting.
  await page.evaluate(() => {
    const extractLoopVars = (xForExpr) => {
      const m = String(xForExpr || '').match(/^([\s\S]*?)\s+(?:in|of)\s+/);
      return m ? (m[1].match(/[A-Za-z_$][\w$]*/g) || []) : [];
    };
    const bindingAttrRegex = /^(?:x-bind:|:|x-text|x-html|x-show|x-if|x-model|x-effect|x-init|x-icon|x-on:|@)/;
    const hasVar = (expr, varName) => varName && new RegExp(`\\b${varName}\\b`).test(expr || '');
    const elementReferencesLoopScope = (el, loopVars) => {
      if (!el) return false;
      const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
      for (const node of nodes) {
        const attrs = node.attributes ? Array.from(node.attributes) : [];
        for (const attr of attrs) {
          if (!bindingAttrRegex.test(attr.name)) continue;
          const expr = attr.value || '';
          if (loopVars.some((v) => hasVar(expr, v))) return true;
        }
      }
      return false;
    };

    // Only clean up templates we intentionally collapsed above.
    // Running this on all x-for templates can remove valid prerendered list items.
    document.querySelectorAll('template[x-for][data-prerender-collapsed="1"]').forEach((tpl) => {
      const xFor = (tpl.getAttribute('x-for') || '').trim();
      const loopVars = extractLoopVars(xFor);
      if (!loopVars.length) return;

      const first = tpl.content?.firstElementChild;
      if (!first) return;
      const tag = first.tagName;
      const own = tpl.getAttribute('data-mnfst-xfor');

      let next = tpl.nextElementSibling;
      while (next) {
        const sameTag = next.tagName === tag;
        if (!sameTag) break;
        if (own && next.getAttribute('data-mnfst-xfor-of') !== own) break;

        const referencesLoopScope = elementReferencesLoopScope(next, loopVars);

        const toRemove = next;
        next = next.nextElementSibling;
        if (referencesLoopScope) toRemove.remove();
        else break;
      }
    });
  });

  // data-static cleanup: any <template> still inside a [data-static] subtree
  // is removed.  Plugin-driven templates (x-anchors, custom directives that
  // insert their rendered output as siblings) leave the rendered DOM behind
  // and the template intact — at runtime the plugin would re-run and
  // duplicate the output.  Removing the template here is the equivalent of
  // the x-for static path: bake the rendered content, drop the source.
  // x-for templates have their own staged removal earlier in the pipeline;
  // this catch-all cleans up everything else.
  await page.evaluate(() => {
    document.querySelectorAll('[data-static] template, template[data-static]').forEach((tpl) => {
      // Don't remove templates explicitly marked data-hydrate (those are an
      // opt-out from any prerender transforms within the data-static subtree).
      if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
      tpl.remove();
    });
  });

  const visibilityNormalizedPath = logicalPathToVisibilityNormalizedPath(pathSeg, locales);
  await page.evaluate((np) => {
    try {
      window.ManifestRoutingVisibility?.processRouteVisibility?.(np);
    } catch {
      /* no-op */
    }
  }, visibilityNormalizedPath);

  // Remove route-hidden content ([x-route] with inline style display:none) so each prerendered page contains only that route's HTML.
  await page.evaluate(() => {
    const reDisplayNone = /\bdisplay\s*:\s*none\b/i;
    const candidates = document.querySelectorAll('[x-route][style*="display"]');
    const toRemove = Array.from(candidates).filter((el) => reDisplayNone.test(el.getAttribute('style') || ''));
    const depth = (el) => { let d = 0; let n = el; while (n && n !== document.body) { d++; n = n.parentElement; } return d; };
    toRemove.sort((a, b) => depth(a) - depth(b)); // remove outer first so subtrees go in one go
    toRemove.forEach((el) => { if (document.contains(el)) el.remove(); });
  });

  // Tag baked x-for/x-if clones that Alpine produced during prerender but
  // whose <template> is still in the output (so Alpine WILL re-render the
  // list/conditional at runtime).  Without this, the runtime shows both the
  // baked copy AND Alpine's fresh render — a duplicate (the hero file tabs,
  // the docs eyebrow + article, etc.).  We KEEP the baked copies in the
  // shipped HTML so crawlers see the content, and tag them so the loader can
  // remove them right before Alpine boots — giving exactly one live render.
  //
  // Identify clones via Alpine's own bookkeeping rather than DOM heuristics:
  // x-for tracks its generated elements in template._x_lookup, and x-if in
  // template._x_currentIfEl.  Templates already removed earlier (static-bake
  // freeze) or whose clones were already stripped (dynamic collapse) simply
  // have nothing to tag here.  data-hydrate islands are left untouched.
  await page.evaluate(() => {
    const tag = (el) => {
      if (!el || el.nodeType !== 1 || !el.setAttribute) return;
      if (el.closest('[data-hydrate]')) return;
      el.setAttribute('data-mnfst-prerender-clone', '1');
    };
    document.querySelectorAll('template[x-for]').forEach((tpl) => {
      if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
      // Prefer Alpine's own lookup when populated; otherwise fall back to
      // walking the consecutive same-tag siblings Alpine emitted right after
      // the template (the pattern the collapse passes already use).
      let tagged = false;
      const lookup = tpl._x_lookup;
      if (lookup) {
        try { (lookup instanceof Map ? [...lookup.values()] : Object.values(lookup)).forEach((el) => { if (el) { tag(el); tagged = true; } }); } catch { /* not iterable */ }
      }
      if (tagged) return;
      const first = tpl.content && tpl.content.firstElementChild;
      if (!first) return;
      const cloneTag = first.tagName;
      const own = tpl.getAttribute('data-mnfst-xfor');
      let n = tpl.nextElementSibling;
      while (n && n.tagName === cloneTag && (!own || n.getAttribute('data-mnfst-xfor-of') === own)) {
        const next = n.nextElementSibling;
        tag(n);
        n = next;
      }
    });
    document.querySelectorAll('template[x-if]').forEach((tpl) => {
      if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
      tag(tpl._x_currentIfEl);
    });
    document.querySelectorAll('[data-mnfst-xfor], [data-mnfst-xfor-of]').forEach((el) => {
      el.removeAttribute('data-mnfst-xfor');
      el.removeAttribute('data-mnfst-xfor-of');
    });

    // Clones inside CLOSED popovers carry no crawler value and are wiped
    // at boot anyway (Alpine re-renders from the template) — drop them from
    // the output entirely.
    document.querySelectorAll('[data-mnfst-prerender-clone]').forEach((el) => {
      if (!document.contains(el)) return;
      const pop = el.closest('[popover]');
      if (pop && !pop.matches(':popover-open')) el.remove();
    });

    // Containers stamped data-mnfst-generated are fully rebuilt by their
    // plugin at boot (e.g. a colorpicker's palette library — thousands of
    // swatch nodes with full palette JSON in x-data). Serialize them empty.
    document.querySelectorAll('[data-mnfst-generated]').forEach((el) => {
      if (document.contains(el)) el.innerHTML = '';
    });

    // Legacy bridge for colorpickers older than the stamp (<0.5.190): the
    // palette library wrapper is rebuilt from scratch at boot regardless,
    // so drop it from the output. Remove once sites pin a stamped build.
    document.querySelectorAll('.library-wrapper').forEach((el) => {
      if (el.querySelector('.library-palette, [data-cp-library-group]')) el.remove();
    });
  });

  // (render.icons: "lazy" is applied on the serialized HTML string — see
  // stripLazyIconSvgs. Doing it in the live DOM re-triggers the icons
  // plugin's observer, which re-injects every svg before serialization.)

  // x-virtual recomputes spacer geometry at boot; measured heights vary
  // run to run — zero them so identical content serializes identically.
  await page.evaluate(() => {
    document.querySelectorAll('[data-virtual-spacer]').forEach((el) => { el.style.height = '0px'; });
  });

  // Deterministic output: randomized CSS anchor-positioning names
  // (--dropdown-x7f2, --popover-…, --anchor-…) are regenerated per run and
  // made every render a phantom diff. Renumber them sequentially in DOM
  // order so identical content serializes identically.
  await page.evaluate(() => {
    const RE = /--(dropdown|popover|anchor)-[a-z0-9]+/g;
    const map = new Map();
    const counters = { dropdown: 0, popover: 0, anchor: 0 };
    const rename = (m, kind) => {
      if (!map.has(m)) map.set(m, `--${kind}-p${++counters[kind]}`);
      return map.get(m);
    };
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        if (!attr.value || attr.value.indexOf('--') === -1) continue;
        const next = attr.value.replace(RE, (m, kind) => rename(m, kind));
        if (next !== attr.value) el.setAttribute(attr.name, next);
      }
    }

    // Component bookkeeping attrs land in whichever order the swap raced —
    // re-set the pair canonically so it can't flip between runs. (They are
    // not Alpine directives; position carries no behavior.)
    for (const el of document.querySelectorAll('[data-component][data-order]')) {
      const c = el.getAttribute('data-component');
      const o = el.getAttribute('data-order');
      el.removeAttribute('data-component');
      el.removeAttribute('data-order');
      el.setAttribute('data-component', c);
      el.setAttribute('data-order', o);
    }
  });

  // SEO / AEO meta injection — see resolveConfig().seo for precedence layers.
  // Runs in the live page so prerender.meta expressions can use Alpine context
  // (real $x.* evaluation, not yaml-only paths).  Each pass only fills
  // slots that are still missing; data-head and index.html static head wins.
  // The og:image snapshot was captured earlier (post-Alpine, pre-transforms);
  // this pass uses it as the highest smart-default for the image slot.
  await injectMetaInDom(page, {
    seo: ctx.seo,
    liveUrl: (ctx.liveUrl || '').replace(/\/$/, ''),
    pathSeg: is404 ? '__404__' : pathSeg,
    snapshotUrl: earlySnapshotUrl,
    renderedPaths: ctx.renderedPaths,
  });

  let html = await page.evaluate(() => document.documentElement.outerHTML);
  // Inject the hydration contract blob into the raw HTML *before* caching
  // it for locale variant generation, so every locale variant inherits the
  // same contract (locale substitution only mutates visible text, not the
  // JSON blob).  The same injection happens again later in the Puppeteer
  // path after Node.js post-processing, but injecting early simplifies the
  // cache model: "raw HTML carries its own contract."
  if (hydrationContractJSON && hydrationContractJSON !== '[]') {
    const safe = hydrationContractJSON.replace(/<\/script/gi, '<\\/script');
    html = html.replace(
      '</body>',
      `<script type="application/json" id="__manifest_hydrate__">${safe}</script>\n</body>`
    );
  }
  if (debugOn) {
    const post = await page.evaluate(() => {
      const templates = document.querySelectorAll('template[x-for]').length;
      const links = document.querySelectorAll('a[href="#"]').length;
      const hidden = document.querySelectorAll('[style*="display: none"]').length;
      return { templateCountAfterCleanup: templates, hashHrefCount: links, displayNoneCount: hidden };
    }).catch(() => null);
    pushDebug({ path: displayPath, stage: 'pre-serialize', metrics: post });
  }
  mark('transforms');
  if (traceOn) ctx.onTiming({ path: displayPath, total: Date.now() - traceT0, stages, ready: readyResult, settle: settleLog });
  return { html, earlySnapshotUrl };
}

function finalizeRouteHtml(rawHtml, ctx) {
  const { pathSeg, is404, currentLocale, locales, defaultLocale, routerBasePath, tailwindBuilt, bundleUtilities } = ctx;
  const fileSegments = is404 ? [] : pathToFileSegments(pathSeg ? `/${pathSeg}` : '/');
  const utilityBlocks = [];
  let html = rawHtml;
  html = stripDevOnlyContent(html);
  html = stripInjectedScripts(html, ctx.originalScriptSrcs);
  if (tailwindBuilt) {
    html = stripRuntimeTailwindArtifacts(html);
  } else {
    html = stripDataTailwindAttr(html);
  }
  html = debakeThemeClass(html);
  if (bundleUtilities) {
    const extracted = extractUtilityStyleBlocks(html);
    html = extracted.html;
    for (const b of extracted.blocks) utilityBlocks.push(b);
  }
  if (tailwindBuilt) {
    html = injectBeforeHeadClose(
      html,
      `<link rel="stylesheet" href="${buildRootAssetPath(routerBasePath, 'prerender.tailwind.css')}">`
    );
  }
  html = stripDuplicatedLoopDirectives(html);
  html = stripPrerenderedXDataDirectives(html);
  html = resolveHeadXBindings(html, ctx.xData);
  html = stripPrerenderDynamicBindings(html);
  html = stripPrerenderBakedRadioCheckedForXModel(html);
  html = stripRedundantImgSrcBindings(html);
  html = stripEmptyInlineMaskStyles(html);
  html = stripResolvedXIconDirectives(html);
  if (ctx.lazyIcons) html = stripLazyIconSvgs(html);
  html = markPrerenderedManifestComponents(html);

  // Prefix internal <a> links with the locale for non-default locales so
  // MPA navigation stays in-locale without relying on runtime JS.
  if (currentLocale && currentLocale !== defaultLocale) {
    html = prefixLocaleInternalLinks(html, currentLocale, locales, ctx.localeRouteExclude);
  }

  html = rewriteHtmlAssetPaths(html, fileSegments.length);
  const liveBase = (ctx.liveUrl || '').replace(/\/$/, '');
  const hasSourceCanonical = /<link\b[^>]*\brel=(["'])\s*canonical\s*\1/i.test(html);
  const canonicalHreflang = buildCanonicalAndHreflang(is404 ? '' : pathSeg, locales, defaultLocale, liveBase, { skipCanonical: hasSourceCanonical });
  const ogLocale = buildOgLocale(is404 ? '' : pathSeg, locales, defaultLocale);
  const injectOgLocale = ogLocale && hasOtherOgMeta(html);
  if (injectOgLocale) html = stripOgLocaleFromHead(html);
  const baseMeta = routerBasePath !== null ? `<meta name="manifest:router-base" content="${String(routerBasePath).replace(/"/g, '&quot;')}">\n` : '';
  const routeEx = ctx.localeRouteExclude || [];
  const routeMeta =
    routeEx.length > 0
      ? `<meta name="manifest:locale-route-exclude" content="${JSON.stringify(routeEx).replace(/"/g, '&quot;')}">\n`
      : '';
  const routeDepth = fileSegments.length;
  const prerenderedMeta = `<meta name="manifest:prerendered" content="1">\n`;
  const prerenderLocalesMeta =
    Array.isArray(locales) && locales.length > 0
      ? `<meta name="manifest:prerender-locales" content="${locales.join(',')}">\n`
      : '';
  html = html.replace(
    '</head>',
    `${canonicalHreflang}${injectOgLocale ? ogLocale : ''}${routeMeta}${baseMeta}${prerenderLocalesMeta}${prerenderedMeta}<meta name="manifest:router-base-depth" content="${routeDepth}">\n</head>`
  );
  // (Hydration contract was already injected into the raw HTML before
  // the Node.js post-processing pipeline ran, so it's already present.)
  html = ensureDoctype(html);
  return { html, utilityBlocks };
}

/** Title, description and article text of a rendered page (.prose, then <article>, then <main>/<body> minus chrome). */
function extractRouteContentFromHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);

  // Find the article-content region using depth-tracked tag matching.  Naive
  // non-greedy regex breaks on nested same-tag elements (article markdown
  // typically contains many nested <div>s for code blocks, frames, etc.).
  // Walks the source from the opening tag, counting open/close pairs of the
  // same tag, until depth returns to zero.
  const extractByOpener = (source, openerRx) => {
    const m = openerRx.exec(source);
    if (!m) return null;
    const tagName = m[1];
    const start = m.index + m[0].length;
    const open = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
    const close = new RegExp(`</${tagName}\\s*>`, 'gi');
    let depth = 1;
    let cursor = start;
    while (depth > 0) {
      open.lastIndex = cursor;
      close.lastIndex = cursor;
      const nextOpen = open.exec(source);
      const nextClose = close.exec(source);
      if (!nextClose) return source.slice(start);
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        if (depth === 0) return source.slice(start, nextClose.index);
        cursor = nextClose.index + nextClose[0].length;
      }
    }
    return null;
  };

  // Selection order — first hit wins:
  //   1. `.prose` — Manifest convention for rendered markdown article content.
  //      This is the cleanest source: contains only article body, no chrome.
  //   2. `<article>` — semantic HTML for article bodies.
  //   3. `<main>` — last resort.  At this layer we additionally strip the
  //      site-chrome wrappers (data-static nav/TOC, semantic nav/header/footer
  //      tags).  We do NOT strip <aside> because article content commonly uses
  //      <aside class="frame"> for example boxes.
  const proseRegion = extractByOpener(
    html,
    /<([a-z][a-z0-9]*)\b[^>]*\bclass=["'][^"']*\bprose\b[^"']*["'][^>]*>/i
  );
  let region = '';
  if (proseRegion) {
    region = proseRegion;
  } else {
    const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) {
      region = articleMatch[1];
    } else {
      const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
      const bodyMatch = mainMatch ? null : html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
      let candidate = mainMatch ? mainMatch[1] : (bodyMatch ? bodyMatch[1] : '');
      // Strip site chrome: top-level wrappers, not nested article content.
      // <aside> is intentionally NOT stripped here — articles use <aside
      // class="frame"> for example boxes that should appear in llms-full.
      candidate = candidate.replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ');
      candidate = candidate.replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ');
      // Strip data-static containers (depth-tracked because nav lists nest).
      const stripContainer = (s, openerRx) => {
        let out = s;
        let m;
        while ((m = openerRx.exec(out))) {
          const tagName = m[1];
          const innerStart = m.index + m[0].length;
          const open = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
          const close = new RegExp(`</${tagName}\\s*>`, 'gi');
          let depth = 1;
          let cursor = innerStart;
          let endIdx = out.length;
          while (depth > 0) {
            open.lastIndex = cursor;
            close.lastIndex = cursor;
            const nextOpen = open.exec(out);
            const nextClose = close.exec(out);
            if (!nextClose) break;
            if (nextOpen && nextOpen.index < nextClose.index) {
              depth++;
              cursor = nextOpen.index + nextOpen[0].length;
            } else {
              depth--;
              cursor = nextClose.index + nextClose[0].length;
              if (depth === 0) endIdx = cursor;
            }
          }
          out = out.slice(0, m.index) + ' ' + out.slice(endIdx);
          openerRx.lastIndex = 0;
        }
        return out;
      };
      candidate = stripContainer(candidate, /<([a-z][a-z0-9]*)\b[^>]*\bdata-static\b[^>]*>/gi);
      region = candidate;
    }
  }

  return {
    title: titleMatch ? htmlToText(titleMatch[1]) : '',
    description: descMatch ? descMatch[1] : '',
    bodyText: region ? htmlToText(region) : '',
  };
}

function buildRobotsTxt(base) {
  return `User-agent: *
Disallow:

Sitemap: ${base}/sitemap.xml
`;
}

/** sitemap.xml for pathList; lastmodOf(pathSeg) → YYYY-MM-DD. */
function buildSitemapXml(pathList, { base, liveUrl, locales, defaultLocale, lastmodOf }) {
  const localeList = Array.isArray(locales) ? locales : [];
  const multiLocale = localeList.length > 1;
  const urlsetNs = multiLocale
    ? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
    : '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

  const urlEntries = pathList.map((pathSeg) => {
    const path = pathSeg === '' ? '' : '/' + pathSeg.replace(/\/$/, '');
    const loc = path ? `${base}${path}` : base + '/';
    const escapedLoc = escapeXmlText(loc);
    let body = `        <loc>${escapedLoc}</loc>`;
    if (multiLocale) {
      for (const { hreflang, href } of getAlternateLinksForPath(pathSeg, localeList, defaultLocale, liveUrl)) {
        body += `\n        <xhtml:link rel="alternate" hreflang="${escapeXmlText(hreflang)}" href="${escapeXmlText(href)}" />`;
      }
    }
    const lastmod = lastmodOf(pathSeg);
    body += `\n        <lastmod>${lastmod}</lastmod>
        <changefreq>monthly</changefreq>
        <priority>${path === '' ? '1.0' : '0.8'}</priority>`;
    return `    <url>
${body}
    </url>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
${urlsetNs}
${urlEntries.join('\n')}
</urlset>
`;
}
/** llms.txt (index) and llms-full.txt (full text) from {pathSeg, url, title, description, bodyText} entries. */
function buildLlmsFiles(entries, { siteName = 'Site', siteDescription = '' } = {}) {
  const sections = groupLlmsSections(entries, siteName);

  // --- llms.txt: short curated index ---
  let llms = `# ${siteName}\n`;
  if (siteDescription) llms += `\n> ${siteDescription}\n`;
  for (const { label, entries: items } of sections.values()) {
    llms += `\n## ${label}\n\n`;
    for (const e of items) {
      const desc = e.description ? `: ${e.description}` : '';
      llms += `- [${e.title}](${e.url})${desc}\n`;
    }
  }

  // --- llms-full.txt: full concatenated text content ---
  // Description is intentionally omitted per-entry — bodyText typically opens
  // with the same sentence (smart-default description came from the first
  // paragraph), so printing both produces a duplicate first line.  llms.txt
  // already carries descriptions for the curated index.
  let llmsFull = `# ${siteName}\n`;
  if (siteDescription) llmsFull += `\n> ${siteDescription}\n`;
  for (const { label, entries: items } of sections.values()) {
    llmsFull += `\n\n# ${label}\n`;
    for (const e of items) {
      llmsFull += `\n\n## ${e.title}\n`;
      llmsFull += `\nSource: ${e.url}\n`;
      if (e.bodyText) llmsFull += `\n${e.bodyText}\n`;
    }
  }
  return { llms, llmsFull };
}

// --- Discovery: locales from manifest.data -----------------------------------
// Picks up (1) object keys that are locale codes (e.g. "en", "fr" in data.features)
// and (2) "locales" properties that point to CSV (or array of CSVs); locale codes from CSV header row.

const LOCALE_CODE_RE = /^[a-z]{2}(-[A-Z]{2})?$/i;

function localeCodesFromCsvHeader(read, filePath) {
  const text = read(filePath);
  if (text == null) return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  if (header.length < 2) return [];
  // First column is key; rest are locale columns (per localization docs)
  return header.slice(1).filter((col) => LOCALE_CODE_RE.test(String(col).trim())).map((c) => String(c).trim().toLowerCase());
}

function discoverLocalesFrom(manifest, read) {
  const codes = new Set();
  const data = manifest.data;
  if (!data || typeof data !== 'object') return [];
  for (const v of Object.values(data)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    // Object keys that are locale codes (JSON/YAML per-locale files)
    for (const k of Object.keys(v)) {
      if (LOCALE_CODE_RE.test(k)) codes.add(k.toLowerCase());
    }
    // "locales" → single CSV path or array of CSV paths; locale codes from CSV headers
    const localesRef = v.locales;
    if (localesRef != null) {
      const files = Array.isArray(localesRef) ? localesRef : [localesRef];
      for (const filePath of files) {
        if (typeof filePath !== 'string') continue;
        localeCodesFromCsvHeader(read, filePath).forEach((c) => codes.add(c));
      }
    }
  }
  return [...codes];
}

// --- Discovery: x-route from HTML --------------------------------------------

// --- Discovery: data-driven paths (docs-style YAML group/items[].path) ------

// js-yaml (default schema) plain-scalar resolution, as the runtime data plugin loads YAML.
const YAML_NULL = /^(?:~|null|Null|NULL)?$/;
const YAML_BOOL = /^(?:true|True|TRUE|false|False|FALSE)$/;
const YAML_INT = /^[-+]?(?:0b[01_]+|0o[0-7_]+|0x[0-9a-fA-F_]+|[0-9][0-9_]*)$/;
const YAML_FLOAT = /^(?:[-+]?(?:[0-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

/** A YAML value as text, from the raw text after `key:` (quotes, comments, numbers, null). Null for YAML null. Timestamps stay verbatim. */
function yamlScalar(raw) {
  const t = String(raw).trim();
  if (t.startsWith('"')) {
    const m = t.match(/^"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[c] ?? c));
  }
  if (t.startsWith("'")) {
    const m = t.match(/^'((?:[^']|'')*)'/);
    if (m) return m[1].replace(/''/g, "'");
  }
  const v = t.replace(/(^|\s)#.*$/, '').trim();
  if (YAML_NULL.test(v)) return null;
  if (YAML_BOOL.test(v)) return String(/^t/i.test(v));
  if (YAML_INT.test(v) && !v.endsWith('_')) {
    const sign = v.startsWith('-') ? -1 : 1;
    const digits = v.replace(/^[-+]/, '').replace(/_/g, '');
    const n = digits.startsWith('0b') ? parseInt(digits.slice(2), 2)
      : digits.startsWith('0o') ? parseInt(digits.slice(2), 8)
      : digits.startsWith('0x') ? parseInt(digits.slice(2), 16)
      : parseInt(digits, 10);
    return String(sign * n === 0 ? 0 : sign * n);
  }
  if (YAML_FLOAT.test(v) && !v.endsWith('_')) {
    const lower = v.toLowerCase();
    if (lower.endsWith('.inf')) return lower.startsWith('-') ? '-Infinity' : 'Infinity';
    if (lower === '.nan') return 'NaN';
    return String(parseFloat(v.replace(/_/g, '')));
  }
  return v;
}

const YAML_GROUP_LINE = /^\s*-?\s*group:\s*["']?([^"'\n]+)["']?/;

/** Each `group:` line's sibling `slug:` in the same mapping, wherever it sits; undefined when there is none. */
function yamlGroupSlugs(lines) {
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const blank = (l) => !l.trim() || /^\s*#/.test(l);
  const slugs = new Map();
  lines.forEach((line, i) => {
    if (!YAML_GROUP_LINE.test(line)) return;
    const col = line.indexOf('group:');
    let start = i;
    if (!/^\s*-\s/.test(line)) {
      for (let j = i - 1; j >= 0; j--) {
        const l = lines[j];
        if (blank(l)) continue;
        if (indentOf(l) < col) {
          if (/^\s*-\s/.test(l) && l.indexOf('-') === col - 2) start = j;
          break;
        }
      }
    }
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      if (!blank(lines[j]) && indentOf(lines[j]) < col) { end = j; break; }
    }
    for (let j = start; j < end; j++) {
      const m = lines[j].match(/^\s*-?\s*slug:(.*)$/);
      if (m && lines[j].indexOf('slug:') === col) { slugs.set(i, yamlScalar(m[1])); break; }
    }
  });
  return slugs;
}

/** URL segment for a group: its slug (as the docs template builds URLs), else its lowercased, hyphenated name. */
function groupSegment(name, slug, warn) {
  const fallback = String(name).trim().toLowerCase().replace(/\s+/g, '-');
  if (slug === undefined) return fallback;
  const s = slug === null ? '' : String(slug).trim().replace(/^\/+|\/+$/g, '');
  if (s) return s;
  warn(`prerender: data group "${String(name).trim()}" has an empty slug; using "${fallback}"\n`);
  return fallback;
}

function parseYamlPaths(text, warn = () => {}) {
  if (text == null) return [];
  const paths = [];
  let currentGroup = '';
  const lines = text.split(/\r?\n/);
  const groupSlugs = yamlGroupSlugs(lines);
  lines.forEach((line, i) => {
    // A nested group: line takes over until the next group: line.
    const groupMatch = line.match(YAML_GROUP_LINE);
    if (groupMatch) {
      currentGroup = groupSegment(groupMatch[1], groupSlugs.get(i), warn);
      return;
    }
    const pathMatch = line.match(/path:\s*["']?([^"'\n]+)["']?/);
    if (pathMatch && currentGroup) {
      const segment = yamlScalar(line.slice(line.indexOf('path:') + 5));
      if (segment !== null && segment !== '') paths.push(`${currentGroup}/${segment}`);
    } else {
      // No group context — fall back to a bare path/slug.  Used by data files
      // whose entries are flat (e.g. articles list with `path:` per item).
      const genericPathMatch = line.match(/^\s*(?:-\s*)?(?:path|slug):(.*)$/);
      if (genericPathMatch) {
        const v = (yamlScalar(genericPathMatch[1]) ?? '').replace(/^\/+|\/+$/g, '');
        if (v && !v.includes('*') && !/\.[a-z0-9]+$/i.test(v)) {
          paths.push(v);
        }
      }
    }
  });
  return paths;
}

function parseJsonPaths(raw, warn = () => {}) {
  if (raw == null) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const paths = [];
  function collectPathSlug(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (item && typeof item === 'object') {
          if (typeof item.path === 'string') paths.push(item.path);
          else if (typeof item.slug === 'string' || typeof item.slug === 'number') paths.push(String(item.slug));
          if (item.group && Array.isArray(item.items)) {
            const slug = typeof item.slug === 'string' || typeof item.slug === 'number' ? item.slug : 'slug' in item ? null : undefined;
            const group = groupSegment(item.group, slug, warn);
            item.items.forEach((i) => {
              if (i && typeof i.path === 'string') paths.push(`${group}/${i.path}`);
            });
          }
        }
      });
      return;
    }
    for (const v of Object.values(obj)) collectPathSlug(v);
  }
  collectPathSlug(data);
  return paths;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) {
      out.push(cur.trim().replace(/^["']|["']$/g, ''));
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim().replace(/^["']|["']$/g, ''));
  return out;
}

function parseCsvPaths(text) {
  if (text == null) return [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const paths = [];
  const header = splitCsvLine(lines[0]).map((c) => c.toLowerCase());
  const pathIdx = header.indexOf('path');
  const slugIdx = header.indexOf('slug');
  const keyIdx = header.indexOf('key');
  const valIdx = header.indexOf('value');
  if (pathIdx >= 0 || slugIdx >= 0) {
    const col = pathIdx >= 0 ? pathIdx : slugIdx;
    for (let i = 1; i < lines.length; i++) {
      const row = splitCsvLine(lines[i]);
      const v = row[col];
      if (v) paths.push(v);
    }
  }
  if (keyIdx >= 0 && valIdx >= 0) {
    for (let i = 1; i < lines.length; i++) {
      const row = splitCsvLine(lines[i]);
      const key = row[keyIdx];
      const val = row[valIdx];
      if (key && (key === 'path' || key.endsWith('.path')) && val) paths.push(val);
    }
  }
  return paths;
}

function discoverDataPaths(manifest, read, wildcardBases = [], locales = [], warn = () => {}, conditions = []) {
  const paths = new Set();
  // Plain routes that show their children too (`docs`, `/docs`; not `=docs`): a source named after one mounts there.
  const plainBases = conditions
    .filter((c) => !c.includes('*') && !c.startsWith('=') && !c.startsWith('!'))
    .map((c) => c.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  // With no wildcard base, a data path counts only if some x-route shows it; a site without any keeps them all.
  const routed = conditions.filter((c) => !c.startsWith('!') && normalizeRouteCondition(c).kind !== 'root');
  const data = manifest.data;
  if (!data || typeof data !== 'object') return paths;
  const localeSet = new Set((locales || []).map((l) => String(l).toLowerCase()));

  function shouldIncludeDataPath(rawPath) {
    const p = String(rawPath || '').replace(/^\/+|\/+$/g, '');
    if (!p || p.includes('#') || p.includes('?') || p.includes('*')) return false;
    const segs = p.split('/');
    const rest = segs.length > 1 && localeSet.has(segs[0].toLowerCase()) ? segs.slice(1).join('/') : p;
    if (wildcardBases.length === 0) return routed.length === 0 || routed.some((c) => routeConditionMatches(rest, c));
    return wildcardBases.some((base) => rest.startsWith(base + '/'));
  }

  // A source mounts under the wildcard route named after it: `docs/*` for key
  // `docs`, or a nested base ending in the key (`docs/framework/*` for key
  // `framework`).
  const mounts = new Map();
  function mountFor(sourceKey) {
    if (!sourceKey) return null;
    if (mounts.has(sourceKey)) return mounts.get(sourceKey);
    let mount = null;
    if (wildcardBases.includes(sourceKey)) mount = sourceKey;
    else {
      const nested = wildcardBases.filter((b) => b.split('/').pop() === sourceKey);
      if (nested.length === 1) {
        mount = nested[0];
        warn(`prerender: data source "${sourceKey}" mounts under ${mount}/*\n`);
      } else if (nested.length > 1) {
        warn(`prerender: data source "${sourceKey}" matches ${nested.map((b) => b + '/*').join(', ')}; not mounted (ambiguous)\n`);
      } else if (plainBases.includes(sourceKey)) {
        mount = sourceKey;
      }
    }
    mounts.set(sourceKey, mount);
    return mount;
  }

  function expandCandidates(rawPath, sourceKey) {
    const p = String(rawPath || '').replace(/^\/+|\/+$/g, '');
    if (!p) return [];
    const candidates = [p];
    if (wildcardBases.length === 0 && plainBases.length === 0) return candidates;
    const mount = mountFor(sourceKey);
    if (!mount) return candidates;
    const parts = p.split('/');
    const hasLocalePrefix = parts.length > 1 && localeSet.has(parts[0].toLowerCase());
    if (hasLocalePrefix) {
      const locale = parts[0];
      const rest = parts.slice(1).join('/');
      if (rest && !rest.startsWith(mount + '/')) candidates.push(`${locale}/${mount}/${rest}`);
    } else if (!p.startsWith(mount + '/')) {
      candidates.push(`${mount}/${p}`);
    }
    return candidates;
  }

  function addFilePaths(value, sourceKey) {
    if (typeof value !== 'string' || !value.startsWith('/')) return;
    const filePath = value;
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      parseYamlPaths(read(filePath), warn).forEach((p) => {
        for (const c of expandCandidates(p, sourceKey)) {
          if (shouldIncludeDataPath(c)) paths.add('/' + c);
        }
      });
    } else if (filePath.endsWith('.json')) {
      parseJsonPaths(read(filePath), warn).forEach((p) => {
        const normalized = p.startsWith('/') ? p.slice(1) : p;
        for (const c of expandCandidates(normalized, sourceKey)) {
          if (shouldIncludeDataPath(c)) paths.add('/' + c);
        }
      });
    } else if (filePath.endsWith('.csv')) {
      parseCsvPaths(read(filePath)).forEach((p) => {
        const normalized = p.startsWith('/') ? p.slice(1) : p;
        for (const c of expandCandidates(normalized, sourceKey)) {
          if (shouldIncludeDataPath(c)) paths.add('/' + c);
        }
      });
    }
  }

  for (const [sourceKey, value] of Object.entries(data)) {
    if (typeof value === 'string') addFilePaths(value, sourceKey);
    else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) {
        if (typeof v === 'string') addFilePaths(v, sourceKey);
      }
    }
  }
  return paths;
}

// --- Collect all paths from index + components -------------------------------

function discoverRoutesFrom(manifest, read, warn = () => {}) {
  const pathSet = new Set();
  pathSet.add('/');
  const allConditions = new Set();
  const locales = discoverLocalesFrom(manifest, read);
  let boundRoute = false;
  const tags = [];
  const scan = (html) => {
    const conditions = extractXRouteConditions(html);
    conditions.forEach((c) => allConditions.add(c));
    conditionsToPaths(conditions).forEach((p) => pathSet.add(p));
    if (BOUND_X_ROUTE.test(html)) boundRoute = true;
    for (const m of html.matchAll(X_TAG)) tags.push(m[1].toLowerCase());
  };

  const indexHtml = read('index.html');
  if (indexHtml != null) scan(indexHtml);

  const componentDirs = [
    ...(manifest.preloadedComponents || []),
    ...(manifest.components || []),
  ];
  for (const rel of componentDirs) {
    const html = read(rel);
    if (html != null) scan(html);
  }

  // Unlisted <x-name> tags load components/<name>.html (the components plugin's convention).
  const seen = new Set(componentDirs.map((p) => String(p).split('/').pop().replace('.html', '')));
  while (tags.length) {
    const name = tags.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const html = read(`components/${name}.html`);
    if (html != null) scan(html);
  }

  const wildcardBases = getWildcardBasesFromConditions(allConditions);
  // A bound x-route can show any path: keep every data path.
  discoverDataPaths(manifest, read, wildcardBases, locales, warn, boundRoute ? [...allConditions, '*'] : [...allConditions]).forEach((p) => pathSet.add(p));

  const arr = [...pathSet].map((p) => (p === '/' ? '' : p.replace(/^\//, '').replace(/\/$/, '') || ''));
  return arr.includes('') ? arr : ['', ...arr.filter(Boolean)];
}

/** Head-binding content for a locale (manifest.data.content). parseYaml: optional YAML parser. */
function loadContentFrom(manifest, read, locale, parseYaml = null) {
  const data = manifest?.data?.content;
  if (!data) return {};
  const loc = locale || 'en';
  let content = {};
  if (typeof data === 'string' && data.endsWith('.csv')) {
    content = csvToKeyValue(read(data), loc);
  } else if (data && typeof data === 'object' && data.locales && typeof data.locales === 'string') {
    content = csvToKeyValue(read(data.locales), loc);
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    // Per-locale files: { "en": "/data/content.en.yaml", "fr": "/data/content.fr.yaml", ... }
    const filePath = data[loc] || data[Object.keys(data)[0]];
    if (typeof filePath === 'string') {
      const raw = read(filePath);
      if (raw != null) {
        try {
          if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
            if (parseYaml) content = parseYaml(raw) || {};
          } else if (filePath.endsWith('.json')) {
            content = JSON.parse(raw);
          } else if (filePath.endsWith('.csv')) {
            content = csvToKeyValue(raw, loc);
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }
  if (manifest.description !== undefined && content.description === undefined) {
    content.description = manifest.description;
  }
  return content;
}

function csvToKeyValue(text, valueLocale) {
  if (text == null) return {};
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};
  const header = splitCsvLine(lines[0]);
  const keyCol = header[0];
  const valueCol = header.includes(valueLocale) ? valueLocale : (header[1] || header[0]);
  const keyIdx = 0;
  const valueIdx = header.indexOf(valueCol);
  if (valueIdx === -1) return {};
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const row = splitCsvLine(lines[i]);
    const key = row[keyIdx];
    const value = row[valueIdx];
    if (key == null) continue;
    setNestedKey(result, key.trim(), value != null ? String(value).trim() : '');
  }
  return result;
}

function setNestedKey(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(next);
    if (!(p in cur) || typeof cur[p] !== 'object') {
      cur[p] = nextIsIndex ? [] : {};
    } else if (nextIsIndex && !Array.isArray(cur[p]) && cur[p] && typeof cur[p] === 'object') {
      const existing = cur[p];
      const keys = Object.keys(existing);
      const numericOnly = keys.every((k) => /^\d+$/.test(k));
      if (numericOnly) {
        const arr = [];
        keys.forEach((k) => {
          arr[parseInt(k, 10)] = existing[k];
        });
        cur[p] = arr;
      }
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/** SEO / AEO meta config from manifest.json (render.meta, render.structuredData, PWA fields). */
function seoConfigFromManifest(manifest) {
  const pre = manifest.render ?? manifest.prerender ?? {};
  return {
    siteName: manifest.name || null,
    siteDescription: manifest.description || null,
    siteAuthor: manifest.author || null,
    icons: Array.isArray(manifest.icons) ? manifest.icons : [],
    meta: pre.meta || null,
    structuredData: pre.structuredData || null,
    imageSnapshots: pre.meta?.imageSnapshots !== false, // default true
    defaults: pre.meta?.defaults !== false,             // default true
  };
}

export {
  NOT_FOUND_PATH,
  scriptSrcSet,
  stripInjectedScripts,
  flushAlpineEffects,
  installSettleTracker,
  trackNetwork,
  waitForPageSettle,
  SETTLE_FIXED,
  SETTLE_REACH,
  logicalPathToVisibilityNormalizedPath,
  waitForManifestRenderReady,
  startManifestRouteState,
  awaitManifestRenderReady,
  normalizeLocaleRouteExclude,
  isLocaleRouteExcluded,
  routeMatchesGlob,
  isLocaleSubstitutionExcludedPath,
  expandLocaleRoutePaths,
  extractXRouteConditions,
  normalizeRouteCondition,
  conditionsToPaths,
  getWildcardBasesFromConditions,
  pathToFileSegments,
  stripDevOnlyContent,
  stripRuntimeTailwindArtifacts,
  stripDataTailwindAttr,
  ensureDoctype,
  debakeThemeClass,
  extractUtilityStyleBlocks,
  injectBeforeHeadClose,
  mergeUtilityCssBlocks,
  buildRootAssetPath,
  stripDuplicatedLoopDirectives,
  isHydrateMarkedAttrs,
  stripPrerenderedXDataDirectives,
  stripPrerenderDynamicBindings,
  stripRedundantImgSrcBindings,
  stripLazyIconSvgs,
  stripResolvedXIconDirectives,
  markPrerenderedManifestComponents,
  stripEmptyInlineMaskStyles,
  isPrerenderBundleAssetPath,
  rewriteHtmlAssetPaths,
  stripPrerenderBakedRadioCheckedForXModel,
  buildCanonicalAndHreflang,
  getAlternateLinksForPath,
  escapeXmlText,
  buildOgLocale,
  stripOgLocaleFromHead,
  hasOtherOgMeta,
  prefixLocaleInternalLinks,
  getXPath,
  resolveHeadXBindings,
  waitForVisualSettle,
  injectMetaInDom,
  htmlToText,
  groupLlmsSections,
  renderRouteDom,
  finalizeRouteHtml,
  extractRouteContentFromHtml,
  buildRobotsTxt,
  buildSitemapXml,
  buildLlmsFiles,
  splitCsvLine,
  setNestedKey,
  csvToKeyValue,
  discoverLocalesFrom,
  discoverRoutesFrom,
  loadContentFrom,
  seoConfigFromManifest,
  yamlScalar,
};
