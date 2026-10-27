// End-to-end settle checks in real Chrome, render.settle 'auto' against the fixed engine's behaviour. Auto must bake
// what fixed bakes when a page script writes after a long timer, an interval (any period), an idle callback, a
// postTask or AbortSignal.timeout, message-channel work slices, a stream message, a CSS animation, a cross-origin frame
// message, a worker reply, a service worker becoming ready, a lazy script, a slow or very slow body, a reload or a
// navigation; and it must not be materially slower on animations, busy polling or wedged counters. Then the real CLI:
// --settle auto with run cache on and two routes sharing a slow cross-origin URL, and the default (fixed) mode keeping
// late anchors with the new router.
// E2E_REPO=<tree> runs the same checks against another checkout (to show they fail on older code).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const repo = process.env.E2E_REPO || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = await import(pathToFileURL(join(repo, 'src', 'scripts', 'manifest.render.page.mjs')).href);
const { installSettleTracker, trackNetwork, waitForPageSettle } = engine;
const phases = engine.SETTLE_FIXED || { load: {}, route: {} };
const failures = [];

const D = `m.textContent = 'DONE'`;
// [script, max ms] — max: auto may take no longer (fixed takes about the same)
const pages = {
  'timer-after-fetch': [`fetch('/data').then((r) => r.text()).then(() => setTimeout(() => { ${D} }, 700))`],
  'fixed-catches-2s-timer': [`fetch('/data').then((r) => r.text()).then(() => setTimeout(() => { ${D} }, 2000))`],
  'timer-3s-during-fetch': [`fetch('/slow2500').then((r) => r.text()); setTimeout(() => { ${D} }, 3000)`],
  'interval-render': [`let n = 0; const iv = setInterval(() => { if (++n === 4) { ${D}; clearInterval(iv) } }, 200)`],
  'idle-callback': [`requestIdleCallback(() => { setTimeout(() => { ${D} }, 3000) }); fetch('/slow1200')`],
  'event-source': [`const es = new EventSource('/sse'); es.onmessage = () => { ${D} }`],
  'css-animation-end': [`const s = document.createElement('style'); s.textContent = '@keyframes k{from{opacity:0}to{opacity:1}} #a{animation:k .6s}';
    document.head.append(s); const a = document.createElement('div'); a.id = 'a'; a.textContent = 'a'; document.body.append(a);
    a.addEventListener('animationend', () => { ${D} })`],
  'cross-origin-frame': [`const f = document.createElement('iframe'); f.src = XO + '/frame'; document.body.append(f); addEventListener('message', () => { ${D} })`],
  'worker-fetch': [`const w = new Worker(URL.createObjectURL(new Blob(["fetch('" + location.origin + "/data').then((r) => r.text()).then((t) => postMessage(t))"], { type: 'text/javascript' })));
    w.onmessage = () => { ${D} }`, 4000],
  'navigate-with-fetch': [`if (!location.search) fetch('/slow1000').then(() => { location.href = location.pathname + '?2' }); else fetch('/data').then(() => { ${D} })`, 5000],
  'lazy-script-poll': [`const check = () => { if (window.lib) ${D}; else setTimeout(check, 900) }; setTimeout(check, 0);
    setTimeout(() => { const s = document.createElement('script'); s.src = '/lib.js'; document.head.append(s) }, 10)`],
  'slow-body': [`fetch('/slowbody').then((r) => r.text()).then(() => { ${D} })`],
  'reload': [`if (!sessionStorage.r) { sessionStorage.r = 1; setTimeout(() => location.reload(), 50) } else setTimeout(() => { ${D} }, 300)`],
  'bound-chain': [`const step = function (n) { if (n === 5) { ${D}; return } setTimeout(step.bind(null, n + 1), 100) }; setTimeout(step.bind(null, 0), 0)`],
  'typewriter': [`let i = 0; const w = 'hello'; const t = () => { i = (i + 1) % (w.length + 1); m.textContent = i === w.length ? 'DONE' : w.slice(0, i); setTimeout(t, i === w.length ? 700 : 60) }; t()`, 6000],
  // Fixed: network never idles (fetch every 400ms), so its 8s + 5s timeouts end the waits (~13.8s)
  'poll-with-pending': [`${D}; const loop = () => setTimeout(loop, 100); loop(); setInterval(() => fetch('/data'), 400)`, 16000],
  'interval-3s': [`fetch('/slow1500').then((r) => r.text()); setInterval(() => { ${D} }, 3000)`],
  'post-task': [`scheduler.postTask(() => { ${D} }, { delay: 1000 })`],
  'abort-timeout': [`AbortSignal.timeout(1000).addEventListener('abort', () => { ${D} })`],
  'message-slices': [`const ch = new MessageChannel(); const t0 = performance.now(); ch.port1.onmessage = () => { const s = performance.now(); while (performance.now() - s < 5) {}
    if (performance.now() - t0 < 700) ch.port2.postMessage(0); else { ${D} } }; ch.port2.postMessage(0)`],
  'post-message-chain': [`const t0 = performance.now(); addEventListener('message', (e) => { if (e.data !== 'tick') return; const s = performance.now(); while (performance.now() - s < 5) {}
    if (performance.now() - t0 < 700) postMessage('tick', '*'); else { ${D} } }); postMessage('tick', '*')`],
  'service-worker-ready': [`navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => { ${D} })`],
  // A counter that never clears must not hold auto past the fixed windows (fixed: ~2.1-2.3s)
  'wedged-counter': [`window.__manifestMarkdownPending = 1; ${D}`, 3500],
  'wedged-counter-ticking': [`window.__manifestMarkdownPending = 1; ${D}; const c = document.createElement('p'); document.body.append(c); setInterval(() => { c.textContent = Date.now() }, 1000)`, 3500],
  'very-slow-fetch': [`fetch('/slow11000').then((r) => r.text()).then(() => { ${D} })`],
  // Responses that stream forever (WebChannel, NDJSON/AI streams): fixed counts them idle once headers arrive (~2.1s)
  'never-ending-fetch-stream': [`fetch('/forever').then((r) => { ${D}; const rd = r.body.getReader(); (async () => { for (;;) { const { done } = await rd.read(); if (done) break } })() })`, 4000],
  'never-ending-xhr': [`const x = new XMLHttpRequest(); x.open('GET', '/forever'); x.onprogress = () => { ${D} }; x.send()`, 4000],
};
const delays = { data: 200, slow1000: 1000, slow1200: 1200, slow1500: 1500, slow2500: 2500, slow11000: 11000 };
const srv = http.createServer((req, res) => {
  const k = req.url.slice(1).split('?')[0];
  if (k in delays) return void setTimeout(() => res.end('ok'), delays[k]);
  if (k === 'lib.js') return void setTimeout(() => res.end('window.lib = 1'), 300);
  if (k === 'sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return void res.end("self.addEventListener('install', (e) => e.waitUntil(new Promise((r) => setTimeout(r, 800)).then(() => self.skipWaiting())))"); }
  if (k === 'slowbody') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('a'); return void setTimeout(() => res.end('b'), 1800); }
  if (k === 'forever') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write('a'.repeat(2048));
    const t = setInterval(() => res.write('x'), 2000); req.on('close', () => clearInterval(t)); return;
  }
  if (k === 'sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); return void setTimeout(() => res.write('data: x\n\n'), 300); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><body><main id="m">x</main><script>const XO = '${XO}'; ${pages[k]?.[0] || ''}</script></body></html>`);
}).listen(0);
// Another origin, for the cross-origin frame
const xo = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<script>setTimeout(() => parent.postMessage(1, '*'), 400)</script>`);
}).listen(0);
const XO = `http://localhost:${xo.address().port}`;
const port = srv.address().port;

const browser = await puppeteer.launch({ headless: 'shell' });
for (const [k, [, maxMs]] of Object.entries(pages)) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(installSettleTracker);
  const net = await trackNetwork(page);
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/${k}`, { waitUntil: 'domcontentloaded' });
  // Both phases, as renderRouteDom runs them (route state changes nothing here)
  const a = await waitForPageSettle(page, net, { capMs: 30000, ...phases.load });
  const b = await waitForPageSettle(page, net, { capMs: 15000, ...phases.route });
  const ms = Date.now() - t0;
  const text = await page.evaluate(() => document.getElementById('m').textContent).catch(() => null);
  const ok = a?.ok && b?.ok && text === 'DONE' && (!maxMs || ms <= maxMs);
  if (!ok) failures.push(`${k}: ${ms}ms${maxMs ? ` (max ${maxMs})` : ''} ${JSON.stringify({ load: a?.ok ?? a, route: b?.ok ?? b })} "${text}"`);
  else console.log(`  ${k}: settled at ${ms}ms`);
  await page.close();
}
await browser.close();
srv.close();
xo.close();

// The real CLI. Async spawn: servers in this process must keep answering while it runs.
const cli = (dir, args = []) => new Promise((resolve) => {
  const p = spawn('node', [join(repo, 'packages', 'render', 'bin', 'mnfst-render.js'), ...args], { cwd: dir });
  let stdout = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', () => {});
  p.on('close', (status) => resolve({ status, stdout }));
});
const site = (body, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'render-settle-'));
  cpSync(join(repo, 'lib'), join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'settle', ...extra }));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>settle</title>
<script src="/lib/manifest.js" data-plugin-base="/lib" data-plugins="router"></script></head>${body}</html>`);
  return dir;
};

// Run cache on, concurrency 2, routes sharing a slow cross-origin URL
const api = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  setTimeout(() => res.end('ok'), 2500);
}).listen(0);
const shared = site(`<body><main x-data><div x-route="a"><p>A</p></div><div x-route="b"><p>B</p></div><div x-route="c"><p>C</p></div><p id="late">pending</p></main><script>
fetch('http://127.0.0.1:${api.address().port}/slow').then((r) => r.text()).then(() => { document.getElementById('late').textContent = 'Baked late' });
</script></body>`, { prerender: { concurrency: 2 } });
const run = await cli(shared, ['--settle', 'auto']);
api.close();
// Whichever route starts second waits on the first one's in-flight fetch (it can be the 404 page): check them all
const outputs = ['index.html', 'a/index.html', 'b/index.html', 'c/index.html', '404.html'];
const missing = outputs.filter((f) => !existsSync(join(shared, 'website', f)) || !readFileSync(join(shared, 'website', f), 'utf8').includes('<p id="late">Baked late</p>'));
if (run.status !== 0 || missing.length) failures.push(`cli shared fetch: exit ${run.status}, late content missing from ${missing.join(', ') || 'none'}${/run cache served/.test(run.stdout) ? '' : ' (run cache unused)'}`);
else console.log(`  cli shared fetch: ${outputs.length}/${outputs.length} pages baked content from a shared 2.5s cross-origin fetch (run cache on, concurrency 2)`);

// Default (fixed) mode, new router: a heading that lands after the route-change refresh still gets its anchor link
const anchors = site(`<body x-data><nav><template x-anchors="h2"><div><a x-text="anchor.text"></a></div></template></nav><main id="m"></main><script>
addEventListener('manifest:route-change', () => setTimeout(() => { const h = document.createElement('h2'); h.id = 'late'; h.textContent = 'Late heading'; document.getElementById('m').append(h) }, 500), { once: true });
</script></body>`);
const fixedRun = await cli(anchors);
const anchorsHtml = existsSync(join(anchors, 'website', 'index.html')) ? readFileSync(join(anchors, 'website', 'index.html'), 'utf8') : '';
if (fixedRun.status !== 0 || !/<a[^>]*href="#late"/.test(anchorsHtml)) failures.push(`cli default anchors: exit ${fixedRun.status}, ${anchorsHtml.includes('Late heading</h2>') ? 'heading baked without its anchor link' : 'heading missing'}`);
else console.log('  cli default (fixed) anchors: late heading baked with its anchor link');

if (failures.length) {
  console.error('RENDER SETTLE E2E FAILED —\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('RENDER SETTLE E2E PASS');
