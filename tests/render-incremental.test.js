import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEDGER_SCHEMA_VERSION,
  stableStringify,
  computeRouteSignature,
  evaluateRouteSkip,
  loadRouteLedger,
  resolveStaticRequestFile,
  createExternalRevalidator,
  contentFilesForPrerender,
  isSafeRelPath,
  settleCaptureAwaiting,
  EXTERNAL_BODY_HASH_LIMIT,
} from '../src/scripts/manifest.render.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mnfst-render-inc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });
  it('is insensitive to key insertion order', () => {
    const x = {}; x.one = 1; x.two = { z: 0, y: null };
    const y = {}; y.two = { y: null, z: 0 }; y.one = 1;
    expect(stableStringify(x)).toBe(stableStringify(y));
  });
  it('serializes undefined as null', () => {
    expect(stableStringify(undefined)).toBe('null');
  });
});

describe('computeRouteSignature', () => {
  const base = {
    globalKey: 'v2|mnfst-render@0.0.0|salt|manifesthash',
    inputPairs: ['index.html:aaa', 'data/a.json:bbb'],
    requestedPairs: ['/=>index.html', '/data/a.json=>data/a.json'],
    externalTokens: ['https://cdn.test/x@1.2.3/x.js', 'https://api.test/rows#etag:W/"v1"|lm:'],
  };
  it('is order-independent for pairs and tokens', () => {
    const a = computeRouteSignature(base);
    const b = computeRouteSignature({
      ...base,
      inputPairs: [...base.inputPairs].reverse(),
      requestedPairs: [...base.requestedPairs].reverse(),
      externalTokens: [...base.externalTokens].reverse(),
    });
    expect(a).toBe(b);
  });
  it('changes when any part changes', () => {
    const a = computeRouteSignature(base);
    expect(computeRouteSignature({ ...base, globalKey: 'other' })).not.toBe(a);
    expect(computeRouteSignature({ ...base, inputPairs: ['index.html:zzz', 'data/a.json:bbb'] })).not.toBe(a);
    expect(computeRouteSignature({ ...base, requestedPairs: ['/=>other.html', '/data/a.json=>data/a.json'] })).not.toBe(a);
    expect(computeRouteSignature({ ...base, externalTokens: ['https://cdn.test/x@1.2.4/x.js', base.externalTokens[1]] })).not.toBe(a);
    expect(computeRouteSignature({ ...base, externalTokens: [base.externalTokens[0], 'https://api.test/rows#etag:W/"v2"|lm:'] })).not.toBe(a);
  });
});

describe('evaluateRouteSkip', () => {
  const globalKey = 'gk';
  const hashes = { 'index.html': 'h1', 'data/a.json': 'h2' };
  const resolution = { '/': 'index.html', '/data/a.json': 'data/a.json', '/ghost': 'index.html' };
  const validator = { etag: 'W/"v7"' };
  const goodEntry = () => ({
    sig: computeRouteSignature({
      globalKey,
      inputPairs: ['index.html:h1', 'data/a.json:h2'],
      requestedPairs: ['/=>index.html', '/data/a.json=>data/a.json', '/ghost=>index.html'],
      externalTokens: ['https://cdn.test/a@1.0.0/a.js', 'https://api.test/rows#etag:W/"v7"|lm:|ch:'],
    }),
    inputs: { 'index.html': 'h1', 'data/a.json': 'h2' },
    requested: { '/': 'index.html', '/data/a.json': 'data/a.json', '/ghost': 'index.html' },
    external: ['https://cdn.test/a@1.0.0/a.js'],
    externalValidated: { 'https://api.test/rows': validator },
    outputs: { 'about/index.html': 'o1' },
  });
  const deps = (over = {}) => ({
    entry: goodEntry(),
    hashInput: (p) => hashes[p] || 'absent',
    resolveRequest: (p) => resolution[p] ?? null,
    revalidateExternal: async () => true,
    globalKey,
    outputHash: (p) => (p === 'about/index.html' ? 'o1' : null),
    ...over,
  });

  it('skips when requests, inputs, signature, outputs and validators all match', async () => {
    expect((await evaluateRouteSkip(deps())).skip).toBe(true);
  });
  it('renders when there is no ledger entry', async () => {
    expect((await evaluateRouteSkip(deps({ entry: undefined }))).skip).toBe(false);
  });
  it('renders when the entry is non-cacheable', async () => {
    const entry = { ...goodEntry(), nonCacheable: true };
    expect((await evaluateRouteSkip(deps({ entry }))).skip).toBe(false);
  });
  it('renders when the entry is malformed (incl. pre-v2 shapes)', async () => {
    for (const entry of [
      {},
      { sig: 'x' },
      { sig: 'x', inputs: {}, external: [], outputs: { a: 'b' } }, // v1 shape: no requested/externalValidated
      { sig: 'x', inputs: {}, requested: {}, external: [], externalValidated: {}, outputs: {} },
    ]) {
      expect((await evaluateRouteSkip(deps({ entry }))).skip).toBe(false);
    }
  });
  it('renders when a requested pathname resolves to a different file now', async () => {
    // SPA-fallback shadowing: /ghost used to fall back to index.html, now a real file serves it.
    const r = await evaluateRouteSkip(deps({
      resolveRequest: (p) => (p === '/ghost' ? 'ghost/index.html' : resolution[p] ?? null),
    }));
    expect(r.skip).toBe(false);
    expect(r.reason).toMatch(/resolution changed: \/ghost/);
  });
  it('renders when a recorded input file is missing', async () => {
    const r = await evaluateRouteSkip(deps({ hashInput: (p) => (p === 'index.html' ? 'h1' : 'absent') }));
    expect(r.skip).toBe(false);
    expect(r.reason).toMatch(/input changed/);
  });
  it('renders when a recorded input re-hashes differently', async () => {
    const r = await evaluateRouteSkip(deps({ hashInput: (p) => (p === 'index.html' ? 'CHANGED' : hashes[p]) }));
    expect(r.skip).toBe(false);
    expect(r.reason).toMatch(/input changed/);
  });
  it('renders when the global key changed (config/version/manifest)', async () => {
    const r = await evaluateRouteSkip(deps({ globalKey: 'different' }));
    expect(r.skip).toBe(false);
    expect(r.reason).toMatch(/signature/);
  });
  it('renders when a cross-origin validator fails conditional revalidation', async () => {
    const r = await evaluateRouteSkip(deps({ revalidateExternal: async () => false }));
    expect(r.skip).toBe(false);
    expect(r.reason).toMatch(/external changed: https:\/\/api\.test\/rows/);
  });
  it('renders when a previous output file is missing or altered', async () => {
    const missing = await evaluateRouteSkip(deps({ outputHash: () => null }));
    expect(missing.skip).toBe(false);
    const altered = await evaluateRouteSkip(deps({ outputHash: () => 'tampered' }));
    expect(altered.skip).toBe(false);
  });
  it('renders when any entry path would escape its base dir', async () => {
    for (const bad of ['../secrets.txt', '/etc/passwd', 'a/../../b', 'a\\b']) {
      const entry = goodEntry();
      entry.outputs = { [bad]: 'o1' };
      const r = await evaluateRouteSkip(deps({ entry }));
      expect(r.skip).toBe(false);
      expect(r.reason).toMatch(/unsafe path/);
    }
  });
});

describe('isSafeRelPath', () => {
  it('accepts plain relative paths and rejects escapes', () => {
    expect(isSafeRelPath('about/index.html')).toBe(true);
    expect(isSafeRelPath('og/x.png')).toBe(true);
    expect(isSafeRelPath('../x')).toBe(false);
    expect(isSafeRelPath('a/../x')).toBe(false);
    expect(isSafeRelPath('/abs')).toBe(false);
    expect(isSafeRelPath('C:/x')).toBe(false);
    expect(isSafeRelPath('a//b')).toBe(false);
    expect(isSafeRelPath('')).toBe(false);
  });
});

describe('loadRouteLedger', () => {
  it('returns null when the ledger is absent, corrupt, or schema-mismatched', () => {
    expect(loadRouteLedger(dir)).toBe(null);
    mkdirSync(join(dir, '.mnfst-cache'), { recursive: true });
    writeFileSync(join(dir, '.mnfst-cache', 'routes.json'), '{nope');
    expect(loadRouteLedger(dir)).toBe(null);
    writeFileSync(join(dir, '.mnfst-cache', 'routes.json'), JSON.stringify({ schemaVersion: -1, routes: {} }));
    expect(loadRouteLedger(dir)).toBe(null);
  });
  it('returns the parsed ledger when the schema matches', () => {
    mkdirSync(join(dir, '.mnfst-cache'), { recursive: true });
    writeFileSync(join(dir, '.mnfst-cache', 'routes.json'),
      JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, routes: { '': { sig: 'x' } } }));
    expect(loadRouteLedger(dir)?.routes['']).toEqual({ sig: 'x' });
  });
});

describe('resolveStaticRequestFile', () => {
  it('mirrors the static server: file, directory index, SPA fallback, traversal', () => {
    writeFileSync(join(dir, 'index.html'), 'root');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'index.html'), 'docs');
    writeFileSync(join(dir, 'app.js'), 'js');
    expect(resolveStaticRequestFile(dir, '/app.js')).toBe('app.js');
    expect(resolveStaticRequestFile(dir, '/docs/')).toBe('docs/index.html');
    expect(resolveStaticRequestFile(dir, '/no/such/route')).toBe('index.html');
    expect(resolveStaticRequestFile(dir, '/../../etc/passwd')).toBe('index.html');
  });
  it('resolution changes when a physical file appears where the fallback served', () => {
    writeFileSync(join(dir, 'index.html'), 'root');
    expect(resolveStaticRequestFile(dir, '/data/ghost.txt')).toBe('index.html');
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'ghost.txt'), 'now exists');
    expect(resolveStaticRequestFile(dir, '/data/ghost.txt')).toBe('data/ghost.txt');
  });
  it('returns null when nothing (not even index.html) can serve the path', () => {
    expect(resolveStaticRequestFile(dir, '/missing')).toBe(null);
  });
});

describe('createExternalRevalidator', () => {
  it('treats only 304 as unchanged', async () => {
    const revalidate = createExternalRevalidator({ request: async () => 304 });
    expect(await revalidate('https://api.test/rows', { etag: 'W/"v1"' })).toBe(true);
    const changed = createExternalRevalidator({ request: async () => 200 });
    expect(await changed('https://api.test/rows', { etag: 'W/"v1"' })).toBe(false);
  });
  it('re-downloads and compares bytes for content-addressed validators', async () => {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update('payload v1').digest('hex');
    const same = createExternalRevalidator({ download: async () => Buffer.from('payload v1') });
    expect(await same('https://api.test/rows', { contentHash: hash })).toBe(true);
    const diff = createExternalRevalidator({ download: async () => Buffer.from('payload v2') });
    expect(await diff('https://api.test/rows', { contentHash: hash })).toBe(false);
    const gone = createExternalRevalidator({ download: async () => null });
    expect(await gone('https://api.test/rows', { contentHash: hash })).toBe(false);
  });
  it('renders when the validator carries nothing usable', async () => {
    const revalidate = createExternalRevalidator({ request: async () => 304, download: async () => Buffer.from('x') });
    expect(await revalidate('https://api.test/rows', {})).toBe(false);
  });
  it('never trusts a body above the hash limit', async () => {
    const { createHash } = await import('node:crypto');
    const big = Buffer.alloc(EXTERNAL_BODY_HASH_LIMIT + 1);
    const hash = createHash('sha256').update(big).digest('hex');
    const revalidate = createExternalRevalidator({ download: async () => big });
    expect(await revalidate('https://api.test/blob', { contentHash: hash })).toBe(false);
  });
  it('sends the recorded validator as a conditional header', async () => {
    const seen = [];
    const revalidate = createExternalRevalidator({ request: async (url, headers) => { seen.push(headers); return 304; } });
    await revalidate('https://a.test/x', { etag: 'W/"e"' });
    await revalidate('https://a.test/y', { lastModified: 'Tue, 01 Oct 2026 00:00:00 GMT' });
    expect(seen[0]).toEqual({ 'If-None-Match': 'W/"e"' });
    expect(seen[1]).toEqual({ 'If-Modified-Since': 'Tue, 01 Oct 2026 00:00:00 GMT' });
  });
  it('memoizes per url+validator and maps failure to "changed"', async () => {
    let calls = 0;
    const revalidate = createExternalRevalidator({ request: async () => { calls++; return 304; } });
    await revalidate('https://a.test/x', { etag: 'e1' });
    await revalidate('https://a.test/x', { etag: 'e1' });
    expect(calls).toBe(1);
    await revalidate('https://a.test/x', { etag: 'e2' });
    expect(calls).toBe(2);
    const failing = createExternalRevalidator({ request: async () => { throw new Error('offline'); } });
    expect(await failing('https://a.test/x', { etag: 'e1' })).toBe(false);
  });
});

describe('settleCaptureAwaiting', () => {
  it('flags the route when an unpinned cross-origin request never got a processed response', () => {
    const capture = { awaiting: new Set(['https://api.test/cached']), nonCacheable: false, reason: null };
    settleCaptureAwaiting(capture);
    expect(capture.nonCacheable).toBe(true);
    expect(capture.reason).toMatch(/unverified external: https:\/\/api\.test\/cached/);
  });
  it('leaves a fully settled capture cacheable and an existing flag untouched', () => {
    const settled = { awaiting: new Set(), nonCacheable: false, reason: null };
    settleCaptureAwaiting(settled);
    expect(settled.nonCacheable).toBe(false);
    const flagged = { awaiting: new Set(['https://a.test/x']), nonCacheable: true, reason: 'non-GET POST' };
    settleCaptureAwaiting(flagged);
    expect(flagged.reason).toBe('non-GET POST');
  });
});

describe('contentFilesForPrerender', () => {
  it('resolves the per-locale content file loadContentForPrerender would read', () => {
    const manifest = { data: { content: { en: '/data/content.en.yaml', fr: '/data/content.fr.yaml' } } };
    expect(contentFilesForPrerender(manifest, 'fr')).toEqual(['data/content.fr.yaml']);
    expect(contentFilesForPrerender(manifest, 'xx')).toEqual(['data/content.en.yaml']);
    expect(contentFilesForPrerender({ data: { content: '/data/content.csv' } }, 'en')).toEqual(['data/content.csv']);
    expect(contentFilesForPrerender({ data: { content: { locales: '/data/locales.csv' } } }, 'en')).toEqual(['data/locales.csv']);
    expect(contentFilesForPrerender({}, 'en')).toEqual([]);
  });
});
