// Real mnfst-render over a page carrying data-tailwind and a source engine-skip stamp:
// the loader attribute and the stale stamp go, data-tailwind-* names are never cut, the link stays valid.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'render-twsite-'));
const loader = 'file://' + join(repo, 'lib', 'manifest.min.js').replace(/\\/g, '/');
writeFileSync(join(dir, 'site.css'), '.flex{display:flex}');
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'twsite', prerender: { wait: 300 } }));
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>stamp</title>
<link rel="stylesheet" href="/site.css" data-mnfst-utilities data-tailwind-stamp="4.3.1:1a2b3c" data-tailwind-mode="skip">
<script type="application/json" data-tailwind-tokens>{"seed":"4.3.1:1a2b3c","tokens":["flex"]}</script>
<script src="${loader}" data-plugins="" data-tailwind></script></head>
<body><main x-data class="flex"><h1>Stamp</h1><pre><code>&lt;script data-tailwind&gt;</code></pre></main></body></html>`);

const r = spawnSync('node', [join(repo, 'packages', 'render', 'bin', 'mnfst-render.js')], {
  cwd: dir, encoding: 'utf8', timeout: 180_000, input: '',
});
const out = (r.stdout || '') + (r.stderr || '');
const file = join(dir, 'website', 'index.html');
if (r.status !== 0 || !existsSync(file)) {
  console.error('RENDER TAILWIND STAMP FAILED — exit', r.status);
  console.error(out.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
const html = readFileSync(file, 'utf8');
const tags = html.match(/<[a-z][^>]*>/gi) || [];
const checks = [
  ['loader keeps no data-tailwind', !tags.some(t => /\sdata-tailwind(?=[\s=>/])/i.test(t))],
  ['no stamp attributes', !/data-tailwind-(stamp|mode)/.test(html)],
  ['no tokens script', !/data-tailwind-tokens|"tokens"/.test(html)],
  ['no cut names', !/(?<!data-tailwind)-(stamp|mode|tokens)\b/.test(html)],
  ['source link intact', /<link rel="stylesheet" href="\/site\.css" data-mnfst-utilities(="")?>/.test(html)],
  ['code text untouched', html.includes('&lt;script data-tailwind&gt;')],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(html);
  process.exit(1);
}
console.log('RENDER TAILWIND STAMP PASS');
rmSync(dir, { recursive: true, force: true });
