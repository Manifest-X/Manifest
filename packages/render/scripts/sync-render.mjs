import { copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const repoRoot = join(packageRoot, '..', '..');

for (const name of ['manifest.render.mjs', 'manifest.render.page.mjs']) {
  const source = join(repoRoot, 'src', 'scripts', name);
  const target = join(packageRoot, name);
  copyFileSync(source, target);
  if (name === 'manifest.render.mjs') chmodSync(target, 0o755);
  console.log('synced', source, '->', target);
}
