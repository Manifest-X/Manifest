#!/usr/bin/env node
// Copies templates/starter/ from the monorepo root into ./templates/ so the
// published npm package is self-contained. Run via prepack and via the root
// build orchestrator.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', '..', 'templates', 'starter');
const dest = resolve(here, '..', 'templates');

if (!existsSync(src)) {
  console.error(`sync-template: source not found at ${src}`);
  process.exit(1);
}

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`sync-template: copied ${src} -> ${dest}`);
