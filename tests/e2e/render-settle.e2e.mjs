// End-to-end settle checks in real Chrome. The tracker must not snapshot early when a page's own script does work
// after a long timer, polls for a lazy script, reads a slow response body, reloads itself, or chains distinct bound
// callbacks — then the real CLI must bake content a custom script writes after a 700ms timer.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { installSettleTracker, trackNetwork, waitForPageSettle } from '../../src/scripts/manifest.render.page.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];

const pages = {
  'timer-after-fetch': `fetch('/data').then((r) => r.text()).then(() => setTimeout(() => { m.textContent = 'DONE' }, 700))`,
  'lazy-script-poll': `const check = () => { if (window.lib) m.textContent = 'DONE'; else setTimeout(check, 150) }; setTimeout(check, 0);
    setTimeout(() => { const s = document.createElement('script'); s.src = '/lib.js'; document.head.append(s) }, 10)`,
  'slow-body': `fetch('/slowbody').then((r) => r.text()).then(() => { m.textContent = 'DONE' })`,
  'reload': `if (!sessionStorage.r) { sessionStorage.r = 1; setTimeout(() => location.reload(), 50) } else setTimeout(() => { m.textContent = 'DONE' }, 300)`,
  'bound-chain': `const step = function (n) { if (n === 5) { m.textContent = 'DONE'; return } setTimeout(step.bind(null, n + 1), 100) }; setTimeout(step.bind(null, 0), 0)`,
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
  const net = trackNetwork(page);
  await page.goto(`http://127.0.0.1:${port}/${k}`, { waitUntil: 'domcontentloaded' });
  const r = await waitForPageSettle(page, net, { capMs: 15000 });
  const text = await page.evaluate(() => document.getElementById('m').textContent).catch(() => null);
  if (!r?.ok || text !== 'DONE') failures.push(`${k}: settled ${JSON.stringify({ ok: r?.ok, ms: r?.ms, reason: r?.reason })} with "${text}"`);
  else console.log(`  ${k}: settled at ${r.ms}ms`);
  await page.close();
}
await browser.close();
srv.close();

// The CLI wiring: auto settle bakes content written after a 700ms timer
const dir = mkdtempSync(join(tmpdir(), 'render-settle-'));
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'settle' }));
writeFileSync(join(dir, 'data.json'), '{"title":"Baked late"}');
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>settle</title></head>
<body><main id="m">pending</main><script>
fetch('/data.json').then((r) => r.json()).then((d) => setTimeout(() => { document.getElementById('m').textContent = d.title }, 700));
</script></body></html>`);
const run = spawnSync('node', [join(repo, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: dir, encoding: 'utf8', timeout: 180_000 });
const outFile = join(dir, 'website', 'index.html');
const html = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
if (run.status !== 0 || !html.includes('Baked late')) failures.push(`cli: exit ${run.status}, baked ${html.includes('Baked late') ? 'late content' : 'without the late content'}`);
else console.log('  cli: baked content written after a 700ms timer');

if (failures.length) {
  console.error('RENDER SETTLE E2E FAILED —\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('RENDER SETTLE E2E PASS');
