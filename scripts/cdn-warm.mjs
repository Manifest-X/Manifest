#!/usr/bin/env node
/* Warm cdn.manifestx.dev after a publish: request every lib/ file for the
 * just-published version so each lands in R2 before any user asks for it.
 * The CDN is a pull-through cache — the first request per file is the only
 * one that ever depends on an upstream (npm → unpkg/jsDelivr), so warming at
 * release time removes that dependency from user traffic entirely.
 *
 * Upstreams can lag a fresh npm publish by a few minutes, so this polls a
 * gate file until the version propagates, then sweeps the rest. Best-effort:
 * failures warn but never fail the release (the publish already happened).
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
// Propagation polling can take minutes and the publish is already done —
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

const hit = async (f) => {
    try {
        const r = await fetch(`${base}/${f}`);
        return r.ok;
    } catch {
        return false;
    }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Gate on the loader until the new version is visible upstream (~6 min max).
console.log(`cdn-warm: warming ${CDN_BASE} for mnfst@${version} (${targets.size} files)`);
let propagated = false;
for (let i = 0; i < 24; i++) {
    if (await hit('manifest.js')) { propagated = true; break; }
    if (i === 0) console.log('cdn-warm: waiting for npm → CDN propagation…');
    await sleep(15000);
}
if (!propagated) {
    console.warn(`cdn-warm: ⚠ mnfst@${version} not reachable via ${CDN_BASE} after 6min — warm skipped (users will pull-through on first request).`);
    process.exit(0);
}

// Sweep everything with modest concurrency; one retry pass for stragglers.
async function sweep(list) {
    const failed = [];
    const queue = [...list];
    await Promise.all(Array.from({ length: 6 }, async () => {
        while (queue.length) {
            const f = queue.pop();
            if (!(await hit(f))) failed.push(f);
        }
    }));
    return failed;
}

let failed = await sweep(targets);
if (failed.length) {
    await sleep(20000);
    failed = await sweep(failed);
}
if (failed.length) {
    console.warn(`cdn-warm: ⚠ ${failed.length} file(s) failed to warm:\n  ${failed.join('\n  ')}`);
} else {
    console.log(`cdn-warm: ✓ all ${targets.size} files cached for mnfst@${version}`);
}
process.exit(0);
