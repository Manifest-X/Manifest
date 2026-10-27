// Spike: a Puppeteer-shaped browser over happy-dom, so the render engine runs unchanged without Chromium.
// Enabled with MNFST_RENDER_ENGINE=happy. No pixels: screenshots throw (no OG snapshots).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadHappyDom() {
  const paths = [process.cwd()];
  const main = require.resolve('happy-dom', { paths });
  return import(main).then(async (mod) => {
    const symbols = await import(new URL('./PropertySymbol.js', 'file://' + main).href);
    const { default: NamedNodeMap } = await import(new URL('./nodes/element/NamedNodeMap.js', 'file://' + main).href);
    // happy-dom gives `:class` the local name `class`, colliding with the real class attribute; un-namespaced names are their own local name.
    const setNamedItem = NamedNodeMap.prototype[symbols.setNamedItem];
    if (!setNamedItem.__mnfstPatched) {
      NamedNodeMap.prototype[symbols.setNamedItem] = function (item, ...rest) {
        if (!item[symbols.namespaceURI] && item[symbols.name]) item[symbols.localName] = item[symbols.name];
        return setNamedItem.call(this, item, ...rest);
      };
      NamedNodeMap.prototype[symbols.setNamedItem].__mnfstPatched = true;
    }
    return { Browser: mod.Browser, PropertySymbol: symbols };
  });
}

// Settles a value the way Puppeteer's serialization does.
function serialize(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return undefined; }
}

// No layout engine: displayed elements measure 1×1, hidden ones 0×0, so visibility checks hold.
const LAYOUT_SHIM = `(() => {
  const hidden = (el) => {
    if (!el.isConnected) return true;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute('hidden') || n.tagName === 'TEMPLATE') return true;
      if (getComputedStyle(n).display === 'none') return true;
    }
    return false;
  };
  Element.prototype.getBoundingClientRect = function () {
    const v = hidden(this) ? 0 : 1;
    return { x: 0, y: 0, top: 0, left: 0, right: v, bottom: v, width: v, height: v, toJSON() { return this; } };
  };
  window.__manifestRenderNoLayout = true;
})()`;

function toPattern(glob) {
  const re = glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(re);
}

const isScript = (url, type) => /javascript/i.test(type || '') || /\.m?js$/.test(new URL(url).pathname);

// Shared across pages for one run, like Chrome's HTTP cache: every page reuses CDN scripts, components and data.
function createResponseCache() {
  const entries = new Map();
  const store = (url, status, statusText, headers, body) => {
    // happy-dom wraps scripts in try{…}: a trailing //# sourceMappingURL comment eats the closing brace.
    if (isScript(url, headers['content-type'])) body = Buffer.concat([body, Buffer.from('\n')]);
    const entry = { status, statusText, headers, body };
    if (status >= 200 && status < 300) entries.set(url, entry);
    return entry;
  };
  return {
    get: (url) => entries.get(url),
    store,
    async warm(urls) {
      await Promise.all(urls.filter((u) => !entries.has(u)).map(async (u) => {
        try {
          const r = await fetch(u);
          store(u, r.status, r.statusText, Object.fromEntries(r.headers), Buffer.from(await r.arrayBuffer()));
        } catch { /* the page fetches it itself */ }
      }));
    },
  };
}

class HappyPage {
  constructor(hd, browserOpts) {
    this.hd = hd;
    this.cache = browserOpts.cache;
    this.idleCap = browserOpts.idleCap;
    this.inflight = 0;
    this.lastActivity = Date.now();
    this.blocked = [];
    this.preScripts = [];
    const self = this;
    const cache = this.cache;
    const isBlocked = (url) => self.blocked.some((re) => re.test(url));
    this.browser = new hd.Browser({
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
        navigator: { userAgent: browserOpts.userAgent },
        fetch: {
          disableSameOriginPolicy: true,
          interceptor: {
            async beforeAsyncRequest({ request, window }) {
              if (isBlocked(request.url)) return new window.Response('', { status: 499 });
              const hit = request.method === 'GET' && cache.get(request.url);
              if (hit) return new window.Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
              self.inflight++;
              self.lastActivity = Date.now();
              return undefined;
            },
            async afterAsyncResponse({ request, response, window }) {
              self.inflight = Math.max(0, self.inflight - 1);
              self.lastActivity = Date.now();
              if (request.method !== 'GET') return undefined;
              const headers = Object.fromEntries(response.headers);
              const e = cache.store(request.url, response.status, response.statusText, headers, Buffer.from(await response.arrayBuffer()));
              return new window.Response(e.body, { status: e.status, statusText: e.statusText, headers: e.headers });
            },
            beforeSyncRequest({ request, window }) {
              const hit = request.method === 'GET' && cache.get(request.url);
              if (!hit) return undefined;
              return { status: hit.status, statusText: hit.statusText, ok: true, url: request.url, redirected: false, headers: new window.Headers(hit.headers), body: hit.body };
            },
            afterSyncResponse({ request, response, window }) {
              self.lastActivity = Date.now();
              if (request.method !== 'GET' || !response.body) return undefined;
              const e = cache.store(request.url, response.status, response.statusText, Object.fromEntries(response.headers), Buffer.from(response.body));
              return { ...response, headers: new window.Headers(e.headers), body: e.body };
            },
          },
        },
        errorCapture: 'tryAndCatch',
        ...(browserOpts.maxTimeout ? { timer: { maxTimeout: browserOpts.maxTimeout, maxIntervalTime: browserOpts.maxTimeout, maxIntervalIterations: -1, preventTimerLoops: false } } : {}),
      },
      console: browserOpts.console || this.collectingConsole(),
    });
    this.page = this.browser.newPage();
    this.page.setViewport({ width: 1200, height: 800, devicePixelRatio: 1 });
  }

  collectingConsole() {
    this.logs = [];
    const keep = (level) => (...args) => {
      if (this.logs.length < 200) this.logs.push({ level, text: args.map((a) => (typeof a === 'string' ? a : a?.stack || a?.message || a?.constructor?.name || String(a))).join(' ').slice(0, 500) });
    };
    const noop = () => {};
    return { log: noop, info: noop, debug: noop, trace: noop, group: noop, groupEnd: noop, groupCollapsed: noop, table: noop, dir: noop, time: noop, timeEnd: noop, count: noop, assert: noop, warn: keep('warn'), error: keep('error') };
  }

  async setViewport({ width, height, deviceScaleFactor }) {
    this.page.setViewport({ width, height, devicePixelRatio: deviceScaleFactor ?? 1 });
  }

  async evaluateOnNewDocument(fn, ...args) {
    this.preScripts.push(`(${fn.toString()})(...${JSON.stringify(args)})`);
  }

  on() { return this; }

  async createCDPSession() {
    return {
      send: async (method, params) => {
        if (method === 'Network.setBlockedURLs') this.blocked = (params?.urls || []).map(toPattern);
      },
    };
  }

  async setRequestInterception() {
    throw new Error('happy-dom engine: request interception unsupported (use --no-run-cache)');
  }

  async goto(url, { timeout = 30000 } = {}) {
    const ctl = AbortSignal.timeout(timeout);
    const res = await fetch(url, { signal: ctl });
    const html = await res.text();
    // Blocking scripts load through happy-dom's synchronous fetch (a child process each): fetch them first.
    const blocking = [...html.matchAll(/<script\b([^>]*)>/gi)]
      .filter((m) => !/\b(async|defer)\b|type=["']?module/i.test(m[1]))
      .map((m) => /\bsrc=["']?([^"'\s>]+)/i.exec(m[1])?.[1])
      .filter(Boolean)
      .map((src) => new URL(src, url).href)
      .filter((u) => !this.blocked.some((re) => re.test(u)));
    await this.cache.warm(blocking);
    const frame = this.page.mainFrame;
    const doc = frame.window.document;
    const P = this.hd.PropertySymbol;
    frame.url = url;
    doc[P.isFirstWrite] = true;
    doc[P.isFirstWriteAfterOpen] = false;
    doc.open();
    frame.evaluate(LAYOUT_SHIM);
    for (const s of this.preScripts) frame.evaluate(s);
    doc.write(html);
    return { ok: () => res.ok, status: () => res.status };
  }

  async evaluate(fn, ...args) {
    const src = typeof fn === 'function' ? `(${fn.toString()})(...${JSON.stringify(args)})` : String(fn);
    return serialize(await this.page.mainFrame.evaluate(src));
  }

  async waitForNetworkIdle({ idleTime = 500, timeout = 30000 } = {}) {
    if (this.idleCap) idleTime = Math.min(idleTime, this.idleCap);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.inflight === 0 && Date.now() - this.lastActivity >= idleTime) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('waitForNetworkIdle timeout');
  }

  async screenshot() {
    throw new Error('happy-dom engine: no pixels');
  }

  async close() {
    try { await this.browser.close(); } catch { /* already closed */ }
  }
}

export async function launchHappyBrowser() {
  const hd = await loadHappyDom();
  const opts = {
    cache: createResponseCache(),
    // Experimental: compress wall-clock settle windows (all page timers are capped at this many ms).
    maxTimeout: Number(process.env.MNFST_RENDER_HAPPY_MAX_TIMEOUT) || 0,
    idleCap: Number(process.env.MNFST_RENDER_HAPPY_IDLE) || 0,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36 mnfst-render-happy',
    console: process.env.MNFST_RENDER_HAPPY_CONSOLE ? console : null,
  };
  return {
    connected: true,
    async newPage() { return new HappyPage(hd, opts); },
    async version() { return 'happy-dom'; },
    noPixels: true,
    async close() { this.connected = false; },
  };
}
