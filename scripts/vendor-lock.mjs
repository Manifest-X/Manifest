#!/usr/bin/env node
/* Third-party files plugins load, pinned and hashed from their npm tarballs.
 *
 *   node scripts/vendor-lock.mjs           write src/scripts/vendor.lock.json
 *   node scripts/vendor-lock.mjs --check   every CDN mirror serves the locked bytes with CORS
 *
 * The build copies the lock into the loader's integrity maps. Alpine entries are append-only:
 * a page pinned to an Alpine the loader once defaulted to stays verifiable.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = join(root, 'src/scripts/vendor.lock.json');
const MIRRORS = ['https://cdn.manifestx.dev/npm', 'https://cdn.jsdelivr.net/npm', 'https://unpkg.com'];

// package@version → files; a trailing /* hashes every file in that directory (lazy families)
export const VENDOR = {
    'alpinejs@3.17.5': ['dist/cdn.min.js'],
    'dompurify@3.4.10': ['dist/purify.min.js'],
    'marked@15.0.12': ['marked.min.js'],
    'js-yaml@4.2.0': ['dist/js-yaml.min.js'],
    'papaparse@5.5.3': ['papaparse.min.js'],
    '@highlightjs/cdn-assets@11.11.1': ['highlight.min.js', 'languages/*.min.js'],
    'codejar@4.3.0': ['dist/codejar.js'],
    'html2canvas-pro@2.6.4': ['dist/html2canvas-pro.min.js'],
    'jspdf@2.5.2': ['dist/jspdf.umd.min.js'],
    '@polar-sh/checkout@0.3.0': ['dist/embed.global.js'],
    'd3-array@3.2.5': ['dist/d3-array.min.js'],
    'd3-color@3.1.1': ['dist/d3-color.min.js'],
    'd3-format@3.1.3': ['dist/d3-format.min.js'],
    'd3-interpolate@3.0.2': ['dist/d3-interpolate.min.js'],
    'd3-time@3.1.1': ['dist/d3-time.min.js'],
    'd3-time-format@4.1.1': ['dist/d3-time-format.min.js'],
    'd3-scale@4.0.3': ['dist/d3-scale.min.js'],
    'd3-path@3.1.1': ['dist/d3-path.min.js'],
    'd3-shape@3.2.1': ['dist/d3-shape.min.js'],
    'd3-geo@3.1.2': ['dist/d3-geo.min.js'],
    'topojson-client@3.1.0': ['dist/topojson-client.min.js'],
    'world-atlas@2.0.2': ['countries-110m.json'],
    'i18n-iso-countries@7.14.0': ['codes.json', 'langs/*.json'],
    'country-json@2.3.0': ['src/country-by-continent.json'],
};

const sri = (buf) => `sha384-${createHash('sha384').update(buf).digest('base64')}`;

function hashPackage(spec, files, tmp) {
    const dir = mkdtempSync(join(tmp, 'pkg-'));
    const tgz = execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', dir], { encoding: 'utf8' }).trim().split('\n').pop();
    execFileSync('tar', ['-xzf', join(dir, tgz), '-C', dir]);
    const base = join(dir, 'package');
    const out = {};
    for (const f of files) {
        const names = f.endsWith('/*.min.js') || f.endsWith('/*.json')
            ? readdirSync(join(base, dirname(f))).filter((n) => n.endsWith(f.slice(f.lastIndexOf('*') + 1))).map((n) => `${dirname(f)}/${n}`)
            : [f];
        for (const n of names) {
            if (!existsSync(join(base, n))) throw new Error(`${spec}: ${n} not in the package`);
            out[`${spec}/${n}`] = sri(readFileSync(join(base, n)));
        }
    }
    return out;
}

async function write() {
    const tmp = mkdtempSync(join(tmpdir(), 'vendor-lock-'));
    const prior = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {};
    try {
        const lock = {};
        // Alpine entries stay once added
        for (const [k, v] of Object.entries(prior)) if (k.startsWith('alpinejs@')) lock[k] = v;
        for (const [spec, files] of Object.entries(VENDOR)) Object.assign(lock, hashPackage(spec, files, tmp));
        const sorted = Object.fromEntries(Object.keys(lock).sort().map((k) => [k, lock[k]]));
        writeFileSync(LOCK, JSON.stringify(sorted, null, 2) + '\n');
        console.log(`vendor-lock: ${Object.keys(sorted).length} files → ${LOCK}`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

async function check() {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
    const bad = [];
    const entries = Object.entries(lock);
    let i = 0;
    await Promise.all(Array.from({ length: 12 }, async () => {
        while (i < entries.length) {
            const [path, hash] = entries[i++];
            for (const m of MIRRORS) {
                try {
                    const r = await fetch(`${m}/${path}`, { headers: { Origin: 'https://example.com' } });
                    const got = sri(Buffer.from(await r.arrayBuffer()));
                    if (!r.ok || got !== hash || r.headers.get('access-control-allow-origin') !== '*') bad.push(`${r.status} ${got === hash ? '' : 'hash '}${r.headers.get('access-control-allow-origin') ? '' : 'no-cors '}${m}/${path}`);
                } catch (e) { bad.push(`ERR ${m}/${path} ${e.message}`); }
            }
        }
    }));
    console.log(`vendor-lock --check: ${entries.length} files × ${MIRRORS.length} mirrors, ${bad.length} problem(s)`);
    bad.forEach((b) => console.log(`  ${b}`));
    process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    (process.argv.includes('--check') ? check() : write()).catch((e) => { console.error(`vendor-lock: ${e.message}`); process.exit(1); });
}
