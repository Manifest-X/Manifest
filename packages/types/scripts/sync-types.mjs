#!/usr/bin/env node
// Sync the ambient-types template from src/scripts/manifest.d.ts into the
// package's template/ directory so the published package is self-contained.
// Mirrors the pattern in packages/render/scripts/sync-render.mjs.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repoRoot = join(packageRoot, '..', '..');
const source = join(repoRoot, 'src', 'scripts', 'manifest.d.ts');
const targetDir = join(packageRoot, 'template');
const target = join(targetDir, 'manifest.d.ts');

if (!existsSync(source)) {
    console.error(`sync-types: source not found at ${source}`);
    process.exit(1);
}

if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`sync-types: copied ${source} -> ${target}`);
