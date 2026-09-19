// End-to-end renderer smoke: run the REAL mnfst-render binary over a minimal
// project. 0.5.40 shipped a ReferenceError that crashed every render because
// nothing executed runPrerender itself — unit fixtures exercised the extracted
// helpers only. This catches that whole class in one browser boot.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'render-smoke-'));
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'smoke', prerender: { wait: 300 } }));
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>smoke</title>
<script src="${'file://' + join(repo, 'lib', 'manifest.js').replace(/\\/g, '/')}" data-plugins=""></script></head>
<body><main x-data><h1>Smoke</h1><div x-route="about"><p>About page</p></div></main></body></html>`);

const r = spawnSync('node', [join(repo, 'packages', 'render', 'bin', 'mnfst-render.js')], {
  cwd: dir, encoding: 'utf8', timeout: 180_000,
});
const out = (r.stdout || '') + (r.stderr || '');
const ok = r.status === 0 && existsSync(join(dir, 'website', 'index.html')) && !/ReferenceError|TypeError/.test(out);
if (!ok) {
  console.error('RENDER SMOKE FAILED — exit', r.status);
  console.error(out.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
console.log('RENDER SMOKE PASS —', readFileSync(join(dir, 'website', 'index.html'), 'utf8').length, 'bytes; exit', r.status);
rmSync(dir, { recursive: true, force: true });
