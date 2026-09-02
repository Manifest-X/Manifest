#!/usr/bin/env node
/* Warm cdn.manifestx.dev after a publish: request every lib/ file for the
 * just-published version so each lands in R2 before any user asks for it.
 * The CDN is a pull-through cache — the first request per file is the only
 * one that ever depends on an upstream (npm → unpkg/jsDelivr), so warming at
 * release time removes that dependency from user traffic entirely.
 *
 * Upstreams can lag a fresh npm publish by minutes and 502 with no-store
 * until the version exists on either — so each file retries with backoff
 * until it 200s, rather than one immediate pass. Best-effort: failures warn
 * but never fail the release (the publish already happened).
 *
 *   Usage: node scripts/cdn-warm.mjs   (after `npm publish`, from repo root)
 */
import { readdirSync, readFileSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CDN_BASE = process.env.MNFST_CDN_BASE || 'https://cdn.manifestx.dev/npm';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const base = `${CDN_BASE}/mnfst@${version}/lib`;

// --detach: re-spawn in the background and return the terminal immediately.
// Propagation + retries can take minutes and the publish is already done —
// nothing here needs to block the release command.
if (process.argv.includes('--detach')) {
    const log = join(tmpdir(), `mnfst-cdn-warm-${version}.log`);
    const fd = openSync(log, 'a');
    spawn(process.execPath, [process.argv[1]], { detached: true, stdio: ['ignore', fd, fd] }).unref();
    console.log(`cdn-warm: warming mnfst@${version} in the background (log: ${log})`);
    process.exit(0);
}

// Every shipped lib/ file, plus the .min.js variant consumers actually request.
const files = readdirSync('lib').filter(f => /\.(js|css|json|ts)$/.test(f));
const targets = new Set(files);
for (const f of files) {
    if (f.endsWith('.js') && !f.endsWith('.min.js')) targets.add(f.replace(/\.js$/, '.min.js'));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry each URL with backoff until the upstream serves the version (a 502
// no-store means neither unpkg nor jsDelivr has it yet) — capped per file
// rather than gating once up front, since three RCs in a row hit transient
// 502s on individual files after the loader itself had already propagated.
const BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];
const MAX_RETRY_MS = 5 * 60 * 1000;
let loggedWaiting = false;

async function hit(f) {
    const start = Date.now();
    for (let attempt = 0; ; attempt++) {
        try {
            const r = await fetch(`${base}/${f}`);
            if (r.ok) return true;
        } catch {
            // network error — treat like a non-ok response and retry
        }
        const elapsed = Date.now() - start;
        if (elapsed >= MAX_RETRY_MS) return false;
        if (!loggedWaiting) { loggedWaiting = true; console.log('cdn-warm: waiting for npm → CDN propagation…'); }
        const wait = Math.min(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], MAX_RETRY_MS - elapsed);
        await sleep(wait);
    }
}

console.log(`cdn-warm: warming ${CDN_BASE} for mnfst@${version} (${targets.size} files)`);
const startedAt = Date.now();
const queue = [...targets];
const failed = [];
await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
        const f = queue.pop();
        if (!(await hit(f))) failed.push(f);
    }
}));
const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);

if (failed.length) console.warn(`cdn-warm: ⚠ ${failed.length} file(s) failed to warm:\n  ${failed.join('\n  ')}`);
console.log(`cdn-warm: ${failed.length ? '⚠' : '✓'} warmed ${targets.size - failed.length}, failed ${failed.length}, elapsed ${elapsedS}s`);
process.exit(0);
