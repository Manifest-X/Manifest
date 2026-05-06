#!/usr/bin/env node
// mnfst-claude — install Claude Code defaults for a Manifest project.
//
// Usage:
//   npx mnfst-claude          install (preserve any files the user has customized)
//   npx mnfst-claude --force  install (overwrite everything)
//   npx mnfst-claude --help   show help

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- args ------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const force = args.has('--force') || args.has('-f');
const showHelp = args.has('--help') || args.has('-h');

if (showHelp) {
  console.log(`mnfst-claude — install Claude Code defaults for a Manifest project.

Usage:
  npx mnfst-claude          Install. Preserves any files you've edited since the
                            last install (compares against a hash manifest).
  npx mnfst-claude --force  Wipe and reinstall — overwrites your customizations.
  npx mnfst-claude --help   Show this help.

What gets installed:
  CLAUDE.md                 Project orientation file (in the project root).
  .claude/launch.json       Local preview launch config.
  .claude/commands/*.md     Slash commands (/sync, /staging, /publish, /status, /preview).
  .claude/skills/*/SKILL.md Recipe skills (page, component, theme, data).
  .claude/.mnfst-claude.json  Hash manifest used to detect future customizations.
`);
  process.exit(0);
}

// ---- paths -----------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = resolve(here, '..', 'templates');
const projectDir = process.cwd();
const claudeDir = join(projectDir, '.claude');
const manifestPath = join(claudeDir, '.mnfst-claude.json');

if (!existsSync(templatesDir)) {
  console.error(`Error: bundled templates not found at ${templatesDir}`);
  console.error('This package may have been published incorrectly. Please report it.');
  process.exit(1);
}

// ---- helpers ---------------------------------------------------------------

const hash = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

// Map a path inside templates/ to where it should land in the project.
//   CLAUDE.md            -> <project>/CLAUDE.md
//   commands/foo.md      -> <project>/.claude/commands/foo.md
//   skills/x/SKILL.md    -> <project>/.claude/skills/x/SKILL.md
//   launch.json          -> <project>/.claude/launch.json
function destinationFor(relPath) {
  if (relPath === 'CLAUDE.md') return join(projectDir, 'CLAUDE.md');
  return join(claudeDir, relPath);
}

// ---- read previous manifest (for customization detection) ------------------

let prevManifest = {};
if (existsSync(manifestPath)) {
  try {
    prevManifest = JSON.parse(readFileSync(manifestPath, 'utf8')).files || {};
  } catch {
    // corrupted manifest — treat as missing
    prevManifest = {};
  }
}

// ---- plan ------------------------------------------------------------------

const sourceFiles = walk(templatesDir);
const newManifest = {};
const installed = [];
const preserved = [];
const created = [];

for (const rel of sourceFiles) {
  const src = join(templatesDir, rel);
  const dst = destinationFor(rel);
  const newBuf = readFileSync(src);
  const newHash = hash(newBuf);
  newManifest[rel] = newHash;

  if (!existsSync(dst)) {
    // brand new file — write it
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, newBuf);
    created.push(rel);
    continue;
  }

  if (force) {
    writeFileSync(dst, newBuf);
    installed.push(rel);
    continue;
  }

  // file exists — check whether it matches the previously shipped version
  const existingHash = hash(readFileSync(dst));
  const previouslyShippedHash = prevManifest[rel];

  if (existingHash === newHash) {
    // identical to new version — nothing to do
    installed.push(rel);
    continue;
  }

  if (previouslyShippedHash && existingHash === previouslyShippedHash) {
    // user hasn't touched it since last install — safe to overwrite
    writeFileSync(dst, newBuf);
    installed.push(rel);
    continue;
  }

  // user customized this file (or installed before manifest tracking existed)
  preserved.push(rel);
  // keep the OLD manifest hash for this file so a future install can still detect customization
  newManifest[rel] = previouslyShippedHash || existingHash;
}

// ---- write manifest --------------------------------------------------------

mkdirSync(claudeDir, { recursive: true });
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      generator: 'mnfst-claude',
      generatedAt: new Date().toISOString(),
      files: newManifest,
    },
    null,
    2,
  ) + '\n',
);

// ---- report ----------------------------------------------------------------

const total = sourceFiles.length;
console.log(`mnfst-claude installed ${total} file(s) into ${projectDir}`);
if (created.length) console.log(`  ${created.length} new`);
if (installed.length) console.log(`  ${installed.length} updated`);
if (preserved.length) {
  console.log(`  ${preserved.length} preserved (you've customized these — re-run with --force to overwrite):`);
  for (const p of preserved) console.log(`    - ${p}`);
}

if (preserved.length && !force) {
  process.exit(0);
}

console.log('\nDone. Open this project in Claude Code to use the new commands and skills.');
