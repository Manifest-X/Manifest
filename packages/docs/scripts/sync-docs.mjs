#!/usr/bin/env node
// Sync templates/docs into this package: components at the package root (so CDN
// URLs stay short — mnfst-docs@1/components/docs.html) and the rest under
// template/ for the scaffolder. Mirrors packages/render/scripts/sync-render.mjs.

import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const source = join(packageRoot, '..', '..', 'templates', 'docs');

if (!existsSync(source)) {
    console.error(`sync-docs: source not found at ${source}`);
    process.exit(1);
}

const components = join(packageRoot, 'components');
const template = join(packageRoot, 'template');
rmSync(components, { recursive: true, force: true });
rmSync(template, { recursive: true, force: true });
mkdirSync(components, { recursive: true });
mkdirSync(template, { recursive: true });

cpSync(join(source, 'components'), components, { recursive: true });

for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === 'components' || entry.name.startsWith('.')) continue;
    cpSync(join(source, entry.name), join(template, entry.name), { recursive: true });
}

console.log(`synced ${source} -> ${packageRoot}/{components,template}`);
