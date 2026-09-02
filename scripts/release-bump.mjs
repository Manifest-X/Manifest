#!/usr/bin/env node
/**
 * Bump a package to (npm-published-latest + 1 patch) so a stale local
 * package.json version can never collide with what's already on the registry.
 *
 * The old `npm version patch` bumped off the LOCAL version and assumed it equaled
 * the last publish — but when another machine/session publishes without committing
 * the bump back, local falls behind npm and `patch` lands on an already-taken
 * version (npm 403 "cannot publish over previously published versions").
 *
 * This derives the next version from the REGISTRY instead; the local version is
 * only a fallback for a never-published package. It edits just the "version" line
 * so the file's existing formatting is preserved.
 *
 *   Usage: node scripts/release-bump.mjs <packageDir>   (default ".")
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const dir = process.argv[2] || '.';
const pkgPath = join(dir, 'package.json');
const raw = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

let published = null;
try {
  published =
    execSync(`npm view ${pkg.name} version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
} catch {
  /* unpublished — first release; fall back to the local version */
}

const base = published || pkg.version;
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(base);
if (!m) {
  console.error(`release-bump: can't parse a semver from "${base}" for ${pkg.name}`);
  process.exit(1);
}
let next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
// --pre <tag>: prerelease off the next patch (0.5.198-next.0), so `latest` stays clear for the real release
const preIdx = process.argv.indexOf('--pre');
const pre = preIdx !== -1 ? process.argv[preIdx + 1] : null;
if (pre) {
  let taken = [];
  try {
    const out = execSync(`npm view ${pkg.name} versions --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(out);
    taken = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    /* unpublished or offline — first prerelease */
  }
  const prefix = `${next}-${pre}.`;
  next = `${prefix}${taken.filter(v => typeof v === 'string' && v.startsWith(prefix)).length}`;
}

const versionRe = /("version"\s*:\s*")[^"]*(")/;
if (!versionRe.test(raw)) {
  console.error(`release-bump: no "version" field found in ${pkgPath}`);
  process.exit(1);
}
const updated = raw.replace(versionRe, `$1${next}$2`);
writeFileSync(pkgPath, updated);
console.log(`release-bump: ${pkg.name} ${published ? `npm@${published}` : '(unpublished)'} → ${next}`);
