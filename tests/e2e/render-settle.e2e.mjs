// End-to-end settle checks in real Chrome. The tracker must never snapshot earlier than the fixed engine would: a page
// script that writes after a long timer, polls for a lazy script, reads a slow body, reloads itself, chains distinct
// bound callbacks or runs a typewriter loop. Then the real CLI (real framework from lib/, run cache on, two routes in
// parallel sharing one slow cross-origin URL) must bake every route's late content.
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

const pages = {
  'timer-after-fetch': `fetch('/data').then((r) => r.text()).then(() => setTimeout(() => { m.textContent = 'DONE' }, 700))`,
  'fixed-catches-2s-timer': `fetch('/data').then((r) => r.text()).then(() => setTimeout(() => { m.textContent = 'DONE' }, 2000))`,
  'lazy-script-poll': `const check = () => { if (window.lib) m.textContent = 'DONE'; else setTimeout(check, 900) }; setTimeout(check, 0);
    setTimeout(() => { const s = document.createElement('script'); s.src = '/lib.js'; document.head.append(s) }, 10)`,
  'slow-body': `fetch('/slowbody').then((r) => r.text()).then(() => { m.textContent = 'DONE' })`,
  'reload': `if (!sessionStorage.r) { sessionStorage.r = 1; setTimeout(() => location.reload(), 50) } else setTimeout(() => { m.textContent = 'DONE' }, 300)`,
  'bound-chain': `const step = function (n) { if (n === 5) { m.textContent = 'DONE'; return } setTimeout(step.bind(null, n + 1), 100) }; setTimeout(step.bind(null, 0), 0)`,
  'typewriter': `let i = 0; const w = 'hello'; const t = () => { i = (i + 1) % (w.length + 1); m.textContent = i === w.length ? 'DONE' : w.slice(0, i); setTimeout(t, i === w.length ? 700 : 60) }; t()`,
};
const srv = http.createServer((req, res) => {
  const k = req.url.slice(1);
  if (k === 'data') return void setTimeout(() => res.end('ok'), 200);
  if (k === 'lib.js') return void setTimeout(() => res.end('window.lib = 1'), 300);
  if (k === 'slowbody') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('a'); return void setTimeout(() => res.end('b'), 1800); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><html><body><main id="m">x</main><script>${pages[k] || ''}</script></body></html>`);
}).listen(0);
const port = srv.address().port;

const browser = await puppeteer.launch({ headless: 'shell' });
for (const k of Object.keys(pages)) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(installSettleTracker);
  const net = await trackNetwork(page);
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/${k}`, { waitUntil: 'domcontentloaded' });
  // Both phases, as renderRouteDom runs them (route state changes nothing here)
  const a = await waitForPageSettle(page, net, { capMs: 15000, ...phases.load });
  const b = await waitForPageSettle(page, net, { capMs: 7000, ...phases.route });
  const ms = Date.now() - t0;
  const text = await page.evaluate(() => document.getElementById('m').textContent).catch(() => null);
  const ok = a?.ok && b?.ok && (k === 'typewriter' ? ms < 6000 : text === 'DONE');
  if (!ok) failures.push(`${k}: ${ms}ms ${JSON.stringify({ load: a?.ok ?? a, route: b?.ok ?? b })} "${text}"`);
  else console.log(`  ${k}: settled at ${ms}ms`);
  await page.close();
}
await browser.close();
srv.close();

// Real CLI: real framework, run cache on, concurrency 2, routes sharing a slow cross-origin URL
const api = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  setTimeout(() => res.end('ok'), 2500);
}).listen(0);
const API = `http://127.0.0.1:${api.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'render-settle-'));
cpSync(join(repo, 'lib'), join(dir, 'lib'), { recursive: true });
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'settle', prerender: { concurrency: 2 } }));
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>settle</title>
<script src="/lib/manifest.js" data-plugin-base="/lib" data-plugins="router"></script></head>
<body><main x-data><div x-route="a"><p>A</p></div><div x-route="b"><p>B</p></div><div x-route="c"><p>C</p></div><p id="late">pending</p></main><script>
fetch('${API}/slow').then((r) => r.text()).then(() => { document.getElementById('late').textContent = 'Baked late' });
</script></body></html>`);
// Async: the API server above lives in this process and must keep answering while the CLI runs
const run = await new Promise((resolve) => {
  const p = spawn('node', [join(repo, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: dir });
  let stdout = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', () => {});
  p.on('close', (status) => resolve({ status, stdout }));
});
api.close();
// Whichever route starts second waits on the first one's in-flight fetch (it can be the 404 page): check them all
const outputs = ['index.html', 'a/index.html', 'b/index.html', 'c/index.html', '404.html'];
const missing = outputs.filter((f) => !existsSync(join(dir, 'website', f)) || !readFileSync(join(dir, 'website', f), 'utf8').includes('<p id="late">Baked late</p>'));
if (run.status !== 0 || missing.length) failures.push(`cli: exit ${run.status}, late content missing from ${missing.join(', ') || 'none'}${/run cache served/.test(run.stdout) ? '' : ' (run cache unused)'}`);
else console.log(`  cli: ${outputs.length}/${outputs.length} pages baked content from a shared 2.5s cross-origin fetch (run cache on, concurrency 2)`);

if (failures.length) {
  console.error('RENDER SETTLE E2E FAILED —\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('RENDER SETTLE E2E PASS');
