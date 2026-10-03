#!/usr/bin/env node
/**
 * Release content check: does a published npm version contain more than version stamps?
 * Read-only report (exit 0 unless the script itself fails).
 * Release boundary = npm `time` publish timestamps vs git committer dates (stamp commits lag or are missing).
 *
 *   node scripts/release-check.mjs [pkg=mnfst] [newVersion=latest] [prevVersion=previous publish] [--json] [--ref <git ref>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Source paths whose commits should show up in each package's tarball
const SOURCES = {
  mnfst: ['src/scripts', 'src/styles', 'lib', 'README.md', ':(exclude)src/scripts/manifest.render.mjs', ':(exclude)src/scripts/build.mjs'],
  'mnfst-render': ['packages/render', 'src/scripts/manifest.render.mjs'],
};

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const isPre = v => v.includes('-');

function sourcePaths(pkg) {
  if (SOURCES[pkg]) return SOURCES[pkg];
  const ws = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).workspaces || [];
  const dir = ws.find(d => {
    try { return JSON.parse(readFileSync(join(repoRoot, d, 'package.json'), 'utf8')).name === pkg; } catch { return false; }
  });
  return dir ? [dir] : null;
}

export function pickVersions(time, latest, newV, prevV) {
  newV = newV || latest;
  if (!time[newV]) throw new Error(`version ${newV} not found on npm`);
  if (!prevV) {
    const t = Date.parse(time[newV]);
    prevV = Object.entries(time)
      .filter(([v, ts]) => v !== 'created' && v !== 'modified' && v !== newV && Date.parse(ts) < t && (isPre(newV) || !isPre(v)))
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))[0]?.[0];
    if (!prevV) throw new Error(`no version published before ${newV}`);
  }
  return { newV, prevV };
}

function pack(pkg, ver, dir) {
  const d = join(dir, ver);
  sh('mkdir', ['-p', d]);
  const tgz = sh('npm', ['pack', `${pkg}@${ver}`, '--silent'], { cwd: d }).trim().split('\n').pop();
  sh('tar', ['xzf', tgz], { cwd: d });
  const root = readdirSync(d).find(n => statSync(join(d, n)).isDirectory());
  return join(d, root);
}

function walk(root, dir = root, out = new Map()) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out.set(relative(root, p).split('\\').join('/'), readFileSync(p));
  }
  return out;
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isText = buf => !buf.includes(0);
const INTEGRITY = /^sha(256|384|512)-[A-Za-z0-9+/=]+$/;

// Old text with every standalone occurrence of the old version rewritten to the new one
export function normalise(text, oldV, newV) {
  return text.replace(new RegExp(`(?<![\\w.])${esc(oldV)}(?![\\w]|\\.\\d)`, 'g'), newV);
}

function lineCounts(a, b, tmp) {
  const fa = join(tmp, '.a'), fb = join(tmp, '.b');
  writeFileSync(fa, a); writeFileSync(fb, b);
  const out = spawnSync('diff', [fa, fb], { encoding: 'utf8', maxBuffer: 256 << 20 }).stdout || '';
  let add = 0, del = 0;
  for (const l of out.split('\n')) { if (l.startsWith('> ')) add++; else if (l.startsWith('< ')) del++; }
  return { add, del };
}

// Integrity maps: changed entries are stamps only if each hash is the real hash of a stamp-only file
function integrityVerdict(rel, oldBuf, newBuf, oldFiles, newFiles, stampOnly) {
  let a, b;
  try { a = JSON.parse(oldBuf); b = JSON.parse(newBuf); } catch { return null; }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return null;
  const base = posix.dirname(rel);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const bad = [];
  for (const k of keys) {
    if (a[k] === b[k]) continue;
    if (typeof a[k] !== 'string' || typeof b[k] !== 'string' || !INTEGRITY.test(a[k]) || !INTEGRITY.test(b[k])) return null;
    const f = base === '.' ? k : `${base}/${k}`;
    const ok = (files, val) => {
      const buf = files.get(f);
      if (!buf) return false;
      const [algo] = val.split('-');
      return `${algo}-${createHash(algo).update(buf).digest('base64')}` === val;
    };
    if (!ok(oldFiles, a[k]) || !ok(newFiles, b[k])) bad.push(`${k} (hash does not match file)`);
    else if (!stampOnly.has(f)) bad.push(k);
  }
  return bad;
}

export function compareTrees(oldFiles, newFiles, oldV, newV, tmp) {
  const added = [], removed = [], changed = [], stamps = [];
  const stampOnly = new Set();
  const deferred = [];
  for (const rel of oldFiles.keys()) if (!newFiles.has(rel)) removed.push(rel);
  for (const [rel, nb] of newFiles) {
    const ob = oldFiles.get(rel);
    if (!ob) { added.push({ file: rel, add: isText(nb) ? nb.toString('utf8').split('\n').length : 0 }); continue; }
    if (ob.equals(nb)) continue;
    if (!isText(ob) || !isText(nb)) { changed.push({ file: rel, binary: true }); continue; }
    const norm = normalise(ob.toString('utf8'), oldV, newV);
    if (norm === nb.toString('utf8')) { stamps.push(rel); stampOnly.add(rel); continue; }
    deferred.push(rel);
  }
  for (const rel of deferred) {
    const ob = oldFiles.get(rel), nb = newFiles.get(rel);
    const bad = integrityVerdict(rel, ob, nb, oldFiles, newFiles, stampOnly);
    if (bad && bad.length === 0) { stamps.push(rel); continue; }
    const c = lineCounts(normalise(ob.toString('utf8'), oldV, newV), nb.toString('utf8'), tmp);
    changed.push({ file: rel, ...c, ...(bad ? { integrity: bad } : {}) });
  }
  const verdict = added.length || removed.length || changed.length ? 'changes' : stamps.length ? 'stamps-only' : 'identical';
  return { verdict, stamps, added, removed, changed };
}

function lineSet(files) {
  const s = new Set();
  for (const buf of files.values()) if (isText(buf)) for (const l of buf.toString('utf8').split('\n')) s.add(l.trim());
  return s;
}

const SEMVER = /\d+\.\d+\.\d+(-[\w.]+)?/g;
const distinctive = l => l.length >= 16 && !/^(\/\/|\/\*|\*|<!--|#)/.test(l) && /[A-Za-z]/.test(l) && !/\d+\.\d+\.\d+/.test(l);

// Best-effort: does a commit's diff show up in the new tarball (added lines present / removed lines gone)?
function commitInTarball(sha, paths, oldSet, newSet) {
  const diff = sh('git', ['-C', repoRoot, 'show', '--format=', '-U0', sha, '--', ...paths]);
  const lines = diff.split('\n').filter(r => /^[+-]/.test(r) && !/^(\+\+\+|---)/.test(r));
  const strip = sign => lines.filter(r => r[0] === sign).map(r => r.slice(1).replace(SEMVER, 'V').replace(/sha(256|384|512)-[A-Za-z0-9+/=]+/g, 'H')).sort().join('\n');
  if (lines.length && strip('+') === strip('-')) return 'stamp';
  let forE = 0, against = 0;
  for (const raw of lines) {
    const sign = raw[0];
    const l = raw.slice(1).trim();
    if (!distinctive(l)) continue;
    if (sign === '+') { if (newSet.has(l) && !oldSet.has(l)) forE++; else if (!newSet.has(l)) against++; }
    else { if (oldSet.has(l) && !newSet.has(l)) forE++; else if (newSet.has(l)) against++; }
  }
  return forE ? "shipped" : against ? "missing" : "unclear";
}

function gitCommits(ref, paths, sinceIso) {
  const out = sh('git', ['-C', repoRoot, 'log', ref, `--since=${sinceIso}`, '--format=%h%x09%cI%x09%s', '--', ...paths]).trim();
  return out ? out.split('\n').map(l => { const [sha, date, subject] = l.split('\t'); return { sha, date, subject }; }) : [];
}

function gitSection(pkg, ref, prevT, newT, oldFiles, newFiles) {
  const paths = sourcePaths(pkg);
  if (!paths) return { skipped: `no source paths known for ${pkg}` };
  const oldSet = lineSet(oldFiles), newSet = lineSet(newFiles);
  const all = gitCommits(ref, paths, prevT).filter(c => Date.parse(c.date) > Date.parse(prevT));
  const tag = c => ({ ...c, inTarball: commitInTarball(c.sha, paths, oldSet, newSet) });
  const window = all.filter(c => Date.parse(c.date) <= Date.parse(newT)).map(tag);
  const after = all.filter(c => Date.parse(c.date) > Date.parse(newT)).map(tag);
  return { ref, paths, window, after };
}

function resolveRef(ref) {
  for (const r of ref ? [ref] : ['origin/master', 'master']) {
    if (spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', r]).status === 0) return r;
  }
  return null;
}

export async function run(argv) {
  const json = argv.includes('--json');
  const refIdx = argv.indexOf('--ref');
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(refIdx !== -1 && i === refIdx + 1));
  const [pkg = 'mnfst', newArg, prevArg] = pos;
  const meta = JSON.parse(sh('npm', ['view', pkg, 'time', 'dist-tags', '--json']));
  const { newV, prevV } = pickVersions(meta.time, meta['dist-tags'].latest, newArg, prevArg);
  const tmp = mkdtempSync(join(tmpdir(), 'release-check-'));
  try {
    const oldFiles = walk(pack(pkg, prevV, tmp));
    const newFiles = walk(pack(pkg, newV, tmp));
    const cmp = compareTrees(oldFiles, newFiles, prevV, newV, tmp);
    const ref = resolveRef(refIdx !== -1 ? argv[refIdx + 1] : null);
    const git = ref ? gitSection(pkg, ref, meta.time[prevV], meta.time[newV], oldFiles, newFiles) : { skipped: 'no git ref' };
    const result = { pkg, prev: { version: prevV, published: meta.time[prevV] }, next: { version: newV, published: meta.time[newV] }, ...cmp, git };
    result.summary = summary(result);
    console.log(json ? JSON.stringify(result, null, 2) : report(result));
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function summary(r) {
  const head = `${r.pkg} ${r.prev.version} → ${r.next.version}`;
  const missing = r.git.window?.filter(c => c.inTarball === 'missing').length || 0;
  const pending = r.git.after?.filter(c => c.inTarball === 'missing').length || 0;
  const tail = (missing ? `; ${missing} window commit(s) look absent (heuristic)` : '') + (pending ? `; ${pending} later source commit(s) unreleased` : '');
  if (r.verdict === 'stamps-only') return `${head}: VERSION STAMPS ONLY (${r.stamps.length} files differ only by version)${tail}`;
  if (r.verdict === 'identical') return `${head}: IDENTICAL CONTENT${tail}`;
  const add = r.changed.reduce((n, c) => n + (c.add || 0), 0), del = r.changed.reduce((n, c) => n + (c.del || 0), 0);
  return `${head}: REAL CHANGES (${r.changed.length} changed +${add}/-${del}, ${r.added.length} added, ${r.removed.length} removed)${tail}`;
}

function report(r) {
  const d = s => s.slice(0, 10);
  const out = [r.summary, `  published ${d(r.prev.published)} → ${d(r.next.published)}`];
  for (const c of r.changed) out.push(`  M ${c.file}${c.binary ? ' (binary)' : ` +${c.add}/-${c.del}`}${c.integrity ? ` [entries: ${c.integrity.join(', ')}]` : ''}`);
  for (const a of r.added) out.push(`  A ${a.file} +${a.add}`);
  for (const f of r.removed) out.push(`  D ${f}`);
  if (r.stamps.length) out.push(`  stamps only: ${r.stamps.join(', ')}`);
  const g = r.git;
  if (g.skipped) { out.push(`  git: skipped (${g.skipped})`); return out.join('\n'); }
  const line = c => `    ${c.sha} ${d(c.date)} [${c.inTarball}] ${c.subject}`;
  out.push(`  git ${g.ref}, source commits in release window: ${g.window.length} (tarball match is a best-effort heuristic)`);
  g.window.forEach(c => out.push(line(c)));
  if (g.after.length) {
    out.push(`  source commits after ${r.next.version} published: ${g.after.length}`);
    g.after.forEach(c => out.push(line(c)));
  }
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error(`release-check: ${e.message}`); process.exit(1); });
}
