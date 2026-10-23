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
  refreshCarriedEntry,
  contentFilesForPrerender,
  isSafeRelPath,
  settleCaptureAwaiting,
  EXTERNAL_BODY_HASH_LIMIT,
  resolveIncrementalPolicy,
  classifyExternalResponse,
  createCaptureHooks,
  compileBlockMatcher,
  TELEMETRY_BLOCK_PATTERNS,
  createRunCache,
  classifyRunCacheRequest,
  runCacheReplayHeaders,
  deriveNavTimeoutMs,
  flagNonCacheable,
  normalizeNonCacheableCause,
  NONCACHEABLE_REASONS_CAP,
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
  it('a validator mismatch over identical bytes is UNCHANGED (iconify pattern)', async () => {
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('icon svg bytes');
    const hash = createHash('sha256').update(body).digest('hex');
    const revalidate = createExternalRevalidator({
      request: async () => ({ status: 200, lastModified: 'Thu, 23 Oct 2026 10:00:01 GMT', body }),
    });
    expect(await revalidate('https://api.icons.test/x.svg',
      { lastModified: 'Thu, 23 Oct 2026 10:00:00 GMT', contentHash: hash })).toBe(true);
    expect(revalidate.freshest('https://api.icons.test/x.svg'))
      .toEqual({ lastModified: 'Thu, 23 Oct 2026 10:00:01 GMT', contentHash: hash });
  });
  it('a validator mismatch over different bytes is changed', async () => {
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update('old bytes').digest('hex');
    const revalidate = createExternalRevalidator({
      request: async () => ({ status: 200, etag: 'W/"v2"', body: Buffer.from('new bytes') }),
    });
    expect(await revalidate('https://a.test/x', { etag: 'W/"v1"', contentHash: hash })).toBe(false);
    expect(revalidate.freshest('https://a.test/x')).toBe(null);
  });
  it('the 304 fast path is untouched, with or without a stored hash', async () => {
    const wantBodies = [];
    const revalidate = createExternalRevalidator({
      request: async (url, headers, wantBody) => { wantBodies.push(wantBody); return { status: 304, body: null }; },
    });
    expect(await revalidate('https://a.test/x', { etag: 'e1', contentHash: 'c'.repeat(64) })).toBe(true);
    expect(await revalidate('https://a.test/y', { etag: 'e1' })).toBe(true);
    expect(wantBodies).toEqual([true, false]);
    expect(revalidate.freshest('https://a.test/x')).toBe(null); // nothing to heal on a 304
  });
  it('a 2xx with no stored hash is changed, as before', async () => {
    const revalidate = createExternalRevalidator({
      request: async () => ({ status: 200, etag: 'W/"v2"', body: Buffer.from('whatever') }),
    });
    expect(await revalidate('https://a.test/x', { etag: 'W/"v1"' })).toBe(false);
  });
  it('an oversized or unreadable revalidation body is changed', async () => {
    const { createHash } = await import('node:crypto');
    const big = Buffer.alloc(EXTERNAL_BODY_HASH_LIMIT + 1);
    const hash = createHash('sha256').update(big).digest('hex');
    const oversized = createExternalRevalidator({ request: async () => ({ status: 200, body: big }) });
    expect(await oversized('https://a.test/x', { etag: 'e1', contentHash: hash })).toBe(false);
    const unreadable = createExternalRevalidator({ request: async () => ({ status: 200, body: null }) });
    expect(await unreadable('https://a.test/x', { etag: 'e1', contentHash: hash })).toBe(false);
  });
  it('a fresh 2xx without any validator header heals to a hash-only entry', async () => {
    const { createHash } = await import('node:crypto');
    const body = Buffer.from('stable');
    const hash = createHash('sha256').update(body).digest('hex');
    const revalidate = createExternalRevalidator({ request: async () => ({ status: 200, body }) });
    expect(await revalidate('https://a.test/x', { lastModified: 'lm1', contentHash: hash })).toBe(true);
    expect(revalidate.freshest('https://a.test/x')).toEqual({ contentHash: hash });
  });
});

describe('refreshCarriedEntry', () => {
  const globalKey = 'gk';
  const entry = () => ({
    sig: computeRouteSignature({
      globalKey,
      inputPairs: ['index.html:h1'],
      requestedPairs: ['/=>index.html'],
      externalTokens: [
        'https://cdn.test/a@1.0.0/a.js',
        'https://api.icons.test/x.svg#etag:|lm:lm1|ch:aaa',
      ],
    }),
    inputs: { 'index.html': 'h1' },
    requested: { '/': 'index.html' },
    external: ['https://cdn.test/a@1.0.0/a.js'],
    externalValidated: { 'https://api.icons.test/x.svg': { lastModified: 'lm1', contentHash: 'aaa' } },
    outputs: { 'index.html': 'o1' },
  });
  it('replaces a refreshed validator and re-signs consistently', async () => {
    const fresh = { lastModified: 'lm2', contentHash: 'aaa' };
    const out = refreshCarriedEntry(entry(), () => fresh, globalKey);
    expect(out.externalValidated['https://api.icons.test/x.svg']).toEqual(fresh);
    expect(out.sig).not.toBe(entry().sig);
    // The healed entry passes its own signature check next run.
    const verdict = await evaluateRouteSkip({
      entry: out,
      hashInput: () => 'h1',
      resolveRequest: () => 'index.html',
      revalidateExternal: async () => true,
      globalKey,
      outputHash: () => 'o1',
    });
    expect(verdict.skip).toBe(true);
  });
  it('returns the entry untouched when nothing fresher was observed', () => {
    const e = entry();
    expect(refreshCarriedEntry(e, () => null, globalKey)).toBe(e);
    expect(refreshCarriedEntry(e, () => ({ lastModified: 'lm1', contentHash: 'aaa' }), globalKey)).toBe(e);
  });
  it('leaves non-cacheable and shapeless entries alone', () => {
    const nc = { nonCacheable: true, reason: 'x' };
    expect(refreshCarriedEntry(nc, () => ({ etag: 'e' }), globalKey)).toBe(nc);
    expect(refreshCarriedEntry(undefined, () => null, globalKey)).toBe(undefined);
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

describe('resolveIncrementalPolicy', () => {
  const p = (over) => resolveIncrementalPolicy({
    configValue: undefined, flagIncremental: undefined, flagNoIncremental: undefined, ledgerExists: false, ...over,
  });
  it('never-opted-in stays fully inert', () => {
    expect(p({})).toEqual({ record: false, skip: false, explicit: false });
    expect(p({ flagNoIncremental: true })).toEqual({ record: false, skip: false, explicit: false });
  });
  it('participates via config true, the flag, or an existing ledger', () => {
    expect(p({ configValue: true })).toEqual({ record: true, skip: true, explicit: true });
    expect(p({ flagIncremental: true })).toEqual({ record: true, skip: true, explicit: true });
    expect(p({ ledgerExists: true })).toEqual({ record: true, skip: true, explicit: false });
  });
  it('--no-incremental disables skipping only, recording stays on', () => {
    expect(p({ configValue: true, flagNoIncremental: true })).toEqual({ record: true, skip: false, explicit: true });
    expect(p({ ledgerExists: true, flagNoIncremental: true })).toEqual({ record: true, skip: false, explicit: false });
    expect(p({ flagIncremental: true, flagNoIncremental: true })).toEqual({ record: true, skip: false, explicit: true });
  });
  it('explicit config false is fully off, even with a ledger present', () => {
    expect(p({ configValue: false, ledgerExists: true })).toEqual({ record: false, skip: false, explicit: false });
    expect(p({ configValue: false, ledgerExists: true, flagNoIncremental: true }))
      .toEqual({ record: false, skip: false, explicit: false });
  });
  it('the CLI flag overrides config false', () => {
    expect(p({ configValue: false, flagIncremental: true }).record).toBe(true);
  });
});

describe('classifyExternalResponse', () => {
  it('records a cross-origin 304 as validated from its own headers', () => {
    expect(classifyExternalResponse(304, { etag: 'W/"v1"' })).toEqual({ validator: { etag: 'W/"v1"' } });
    expect(classifyExternalResponse(304, { 'last-modified': 'Tue, 01 Oct 2026 00:00:00 GMT' }))
      .toEqual({ validator: { lastModified: 'Tue, 01 Oct 2026 00:00:00 GMT' } });
  });
  it('falls back to the request conditional values on a bare 304', () => {
    expect(classifyExternalResponse(304, {}, { 'if-none-match': 'W/"req"' }))
      .toEqual({ validator: { etag: 'W/"req"' } });
    expect(classifyExternalResponse(304, {}, { 'if-modified-since': 'Mon, 05 Oct 2026 00:00:00 GMT' }))
      .toEqual({ validator: { lastModified: 'Mon, 05 Oct 2026 00:00:00 GMT' } });
  });
  it('flags only a 304 with no extractable validator', () => {
    expect(classifyExternalResponse(304, {}, {})).toEqual({ flag: 'external 304 without validator' });
  });
  it('keeps the non-2xx failure rule for other statuses', () => {
    expect(classifyExternalResponse(404)).toEqual({ flag: 'external 404' });
    expect(classifyExternalResponse(302)).toEqual({ flag: 'external 302' });
    expect(classifyExternalResponse(500)).toEqual({ flag: 'external 500' });
  });
  it('2xx: validator from headers, else content-address fallthrough', () => {
    expect(classifyExternalResponse(200, { etag: 'e' })).toEqual({ validator: { etag: 'e' } });
    expect(classifyExternalResponse(200, { 'last-modified': 'lm' })).toEqual({ validator: { lastModified: 'lm' } });
    expect(classifyExternalResponse(200, {})).toEqual({});
  });
});

describe('compileBlockMatcher', () => {
  it('matches by substring and supports * globs within a pattern', () => {
    const m = compileBlockMatcher(['api.mixpanel.com/track', '*.facebook.com/tr']);
    expect(m('https://api.mixpanel.com/track?data=x')).toBe(true);
    expect(m('https://api.mixpanel.com/decide')).toBe(false);
    expect(m('https://www.facebook.com/tr?id=1')).toBe(true);
    expect(m('https://connect.facebook.net/en_US/fbevents.js')).toBe(false);
  });
  it('returns null with nothing to block', () => {
    expect(compileBlockMatcher([])).toBe(null);
    expect(compileBlockMatcher()).toBe(null);
  });
  it('covers every curated telemetry collection endpoint', () => {
    const m = compileBlockMatcher(TELEMETRY_BLOCK_PATTERNS);
    for (const hit of [
      'https://www.google-analytics.com/g/collect?v=2',
      'https://region1.google-analytics.com/mp/collect',
      'https://stats.g.doubleclick.net/j/collect',
      'https://www.analytics.google.com/g/collect',
      'https://plausible.io/api/event',
      'https://api.segment.io/v1/t',
      'https://api.mixpanel.com/track/',
      'https://www.facebook.com/tr/',
    ]) expect(m(hit), hit).toBe(true);
    expect(m('https://www.facebook.com/tr?id=123')).toBe(true);
    // Never script loads: blocking gtag.js could break page code; beacons cannot.
    expect(m('https://www.googletagmanager.com/gtag/js?id=G-X')).toBe(false);
    expect(m('https://plausible.io/js/script.js')).toBe(false);
    // Prefix overmatch guard: /tr? and /tr/ only, never /tr-anything.
    expect(m('https://www.facebook.com/tracking')).toBe(false);
    expect(m('https://www.facebook.com/transparency')).toBe(false);
  });
  it('covers error/RUM collection endpoints, never their docs or SDK loads', () => {
    const m = compileBlockMatcher(TELEMETRY_BLOCK_PATTERNS);
    for (const hit of [
      'https://o123456.ingest.sentry.io/api/123/envelope/',
      'https://notify.bugsnag.com/',
      'https://api.rollbar.com/api/1/item/',
      'https://cloudflareinsights.com/cdn-cgi/rum',
      'https://bam.nr-data.net/events/1/abc',
      'https://browser-intake-datadoghq.com/api/v2/rum',
    ]) expect(m(hit), hit).toBe(true);
    for (const miss of [
      'https://docs.sentry.io/platforms/javascript/',
      'https://sentry.io/welcome/',
      'https://browser.sentry-cdn.com/7.0.0/bundle.min.js',
      'https://d2wy8f7a9ursnm.cloudfront.net/v7/bugsnag.min.js',
      'https://cdn.rollbar.com/rollbarjs/refs/tags/v2/rollbar.min.js',
      'https://static.cloudflareinsights.com/beacon.min.js',
      'https://js-agent.newrelic.com/nr-loader-spa.min.js',
      'https://www.datadoghq-browser-agent.com/us1/v5/datadog-rum.js',
    ]) expect(m(miss), miss).toBe(false);
  });
});

describe('createCaptureHooks', () => {
  const localOrigin = 'http://127.0.0.1:5099';
  const freshCapture = () => ({
    requested: new Map(), files: new Set(),
    externalPinned: new Set(), externalValidated: new Map(),
    awaiting: new Set(), pending: [], nonCacheable: false, reason: null,
  });
  const make = (over = {}) => {
    const capture = freshCapture();
    const hooks = createCaptureHooks({
      capture, localOrigin,
      resolveRequest: (p) => (p === '/' ? 'index.html' : null),
      isBlocked: null,
      ...over,
    });
    return { capture, hooks };
  };

  it('a blocked request never happened: not an input, not a failure, not awaited', () => {
    const isBlocked = compileBlockMatcher(['api.mixpanel.com/track', 'custom-tracker']);
    const { capture, hooks } = make({ isBlocked });
    hooks.request({ url: 'https://api.mixpanel.com/track?d=1', method: 'POST' });
    hooks.request({ url: 'https://cdn.test/custom-tracker/ping', method: 'GET' });
    hooks.requestFailed({ url: 'https://api.mixpanel.com/track?d=1' });
    hooks.requestFailed({ url: 'https://cdn.test/custom-tracker/ping' });
    expect(capture.nonCacheable).toBe(false);
    expect(capture.awaiting.size).toBe(0);
    expect(capture.files.size).toBe(0);
    expect(capture.externalPinned.size).toBe(0);
    expect(settleCaptureAwaiting(capture).nonCacheable).toBe(false);
  });
  it('unblocked traffic still captures and flags as before', () => {
    const isBlocked = compileBlockMatcher(['api.mixpanel.com/track']);
    const { capture, hooks } = make({ isBlocked });
    hooks.request({ url: `${localOrigin}/`, method: 'GET' });
    expect(capture.requested.get('/')).toBe('index.html');
    hooks.request({ url: 'https://api.test/rows', method: 'GET' });
    expect(capture.awaiting.has('https://api.test/rows')).toBe(true);
    hooks.request({ url: 'https://other.test/beacon', method: 'POST' });
    expect(capture.nonCacheable).toBe(true);
    expect(capture.reason).toMatch(/non-GET POST/);
  });
  it('a cross-origin 304 records a validated external, not a failure', () => {
    const { capture, hooks } = make();
    hooks.request({ url: 'https://api.test/rows', method: 'GET' });
    hooks.response({
      url: 'https://api.test/rows', status: 304,
      headers: { etag: 'W/"v9"' }, requestHeaders: { 'if-none-match': 'W/"v9"' },
      buffer: () => { throw new Error('a 304 has no body'); },
    });
    expect(capture.externalValidated.get('https://api.test/rows')).toEqual({ etag: 'W/"v9"' });
    expect(capture.awaiting.size).toBe(0);
    expect(capture.nonCacheable).toBe(false);
    expect(capture.pending.length).toBe(0);
  });
  it('a bare 304 (no validator anywhere) stays non-cacheable', () => {
    const { capture, hooks } = make();
    hooks.request({ url: 'https://api.test/rows', method: 'GET' });
    hooks.response({
      url: 'https://api.test/rows', status: 304, headers: {}, requestHeaders: {},
      buffer: () => { throw new Error('a 304 has no body'); },
    });
    expect(capture.nonCacheable).toBe(true);
    expect(capture.reason).toMatch(/external 304 without validator/);
    expect(capture.awaiting.size).toBe(0);
  });
  it('a validator 2xx records the validator and the body hash together', async () => {
    const { capture, hooks } = make();
    hooks.request({ url: 'https://api.icons.test/x.svg', method: 'GET' });
    hooks.response({
      url: 'https://api.icons.test/x.svg', status: 200,
      headers: { 'last-modified': 'Thu, 23 Oct 2026 10:00:00 GMT' }, requestHeaders: {},
      buffer: async () => Buffer.from('icon bytes'),
    });
    // Validator lands synchronously; the hash upgrade drains via pending.
    expect(capture.externalValidated.get('https://api.icons.test/x.svg'))
      .toEqual({ lastModified: 'Thu, 23 Oct 2026 10:00:00 GMT' });
    expect(capture.awaiting.size).toBe(0);
    await Promise.allSettled(capture.pending);
    const v = capture.externalValidated.get('https://api.icons.test/x.svg');
    expect(v.lastModified).toBe('Thu, 23 Oct 2026 10:00:00 GMT');
    expect(v.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.nonCacheable).toBe(false);
  });
  it('an oversized or unreadable validator body keeps a validator-only entry, unflagged', async () => {
    const { capture, hooks } = make();
    hooks.response({
      url: 'https://big.test/blob', status: 200, headers: { etag: 'W/"b"' }, requestHeaders: {},
      buffer: async () => Buffer.alloc(EXTERNAL_BODY_HASH_LIMIT + 1),
    });
    hooks.response({
      url: 'https://flaky.test/x', status: 200, headers: { etag: 'W/"f"' }, requestHeaders: {},
      buffer: async () => { throw new Error('body gone'); },
    });
    await Promise.allSettled(capture.pending);
    expect(capture.externalValidated.get('https://big.test/blob')).toEqual({ etag: 'W/"b"' });
    expect(capture.externalValidated.get('https://flaky.test/x')).toEqual({ etag: 'W/"f"' });
    expect(capture.nonCacheable).toBe(false);
  });
  it('content-addresses a validator-less 2xx body via the pending queue', async () => {
    const { capture, hooks } = make();
    hooks.request({ url: 'https://cdn.test/app.js', method: 'GET' });
    hooks.response({
      url: 'https://cdn.test/app.js', status: 200, headers: {}, requestHeaders: {},
      buffer: async () => Buffer.from('bytes'),
    });
    await Promise.allSettled(capture.pending);
    expect(capture.externalValidated.get('https://cdn.test/app.js')?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.awaiting.size).toBe(0);
  });
});

describe('deriveNavTimeoutMs', () => {
  it('caps navigation at min(pageTimeout, 60s)', () => {
    expect(deriveNavTimeoutMs(120000)).toBe(60000);
    expect(deriveNavTimeoutMs(45000)).toBe(45000);
    expect(deriveNavTimeoutMs(60000)).toBe(60000);
  });
  it('keeps pageTimeout 0 = disabled semantics', () => {
    expect(deriveNavTimeoutMs(0)).toBe(0);
  });
});

describe('classifyRunCacheRequest', () => {
  const localOrigin = 'http://localhost:5099';
  const base = { method: 'GET', localOrigin, isBlocked: null };
  it('blocked URLs abort first, even cacheable-looking ones', () => {
    const isBlocked = compileBlockMatcher(['api.mixpanel.com/track']);
    expect(classifyRunCacheRequest({ ...base, url: 'https://api.mixpanel.com/track?d=1', isBlocked })).toBe('block');
    expect(classifyRunCacheRequest({ ...base, url: 'https://cdn.test/app.js', isBlocked })).toBe('cache');
  });
  it('same-origin, non-GET, and non-http(s) traffic passes through', () => {
    expect(classifyRunCacheRequest({ ...base, url: `${localOrigin}/app.js` })).toBe('bypass');
    expect(classifyRunCacheRequest({ ...base, url: 'https://cdn.test/x', method: 'POST' })).toBe('bypass');
    expect(classifyRunCacheRequest({ ...base, url: 'data:text/plain,x' })).toBe('bypass');
    expect(classifyRunCacheRequest({ ...base, url: 'not a url' })).toBe('bypass');
  });
  it('cross-origin http(s) GETs are cache-eligible', () => {
    expect(classifyRunCacheRequest({ ...base, url: 'https://cdn.test/framework.css' })).toBe('cache');
    expect(classifyRunCacheRequest({ ...base, url: 'http://127.0.0.1:5101/note.txt' })).toBe('cache');
  });
});

describe('runCacheReplayHeaders', () => {
  it('preserves etag/last-modified/content-type verbatim, drops transfer framing', () => {
    const out = runCacheReplayHeaders({
      etag: 'W/"v1"', 'last-modified': 'Tue, 01 Oct 2026 00:00:00 GMT',
      'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache',
      'content-encoding': 'br', 'content-length': '123',
      'transfer-encoding': 'chunked', 'set-cookie': 'a=b',
    });
    expect(out).toEqual({
      etag: 'W/"v1"', 'last-modified': 'Tue, 01 Oct 2026 00:00:00 GMT',
      'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache',
    });
  });
});

describe('createRunCache', () => {
  const entry = (status, bytes, headers = {}) =>
    ({ status, headers, body: Buffer.alloc(bytes, 1) });
  it('caches only 2xx responses', () => {
    const c = createRunCache();
    expect(c.set('https://a.test/404', entry(404, 10))).toBe(false);
    expect(c.set('https://a.test/302', entry(302, 10))).toBe(false);
    expect(c.set('https://a.test/500', entry(500, 10))).toBe(false);
    expect(c.set('https://a.test/ok', entry(200, 10))).toBe(true);
    expect(c.get('https://a.test/404')).toBe(null);
    expect(c.get('https://a.test/ok')?.status).toBe(200);
  });
  it('never caches a body over the per-entry cap (passthrough)', () => {
    const c = createRunCache({ maxEntryBytes: 100 });
    expect(c.set('https://a.test/big', entry(200, 101))).toBe(false);
    expect(c.get('https://a.test/big')).toBe(null);
    expect(c.set('https://a.test/fit', entry(200, 100))).toBe(true);
  });
  it('first 2xx wins; headers come back verbatim', () => {
    const c = createRunCache();
    c.set('https://a.test/x', entry(200, 5, { etag: 'W/"first"' }));
    c.set('https://a.test/x', entry(200, 5, { etag: 'W/"second"' }));
    expect(c.get('https://a.test/x')?.headers).toEqual({ etag: 'W/"first"' });
  });
  it('evicts least-recently-used entries over the entry-count cap', () => {
    const c = createRunCache({ maxEntries: 2 });
    c.set('https://a.test/1', entry(200, 1));
    c.set('https://a.test/2', entry(200, 1));
    c.get('https://a.test/1'); // refresh recency: /2 is now oldest
    c.set('https://a.test/3', entry(200, 1));
    expect(c.get('https://a.test/2')).toBe(null);
    expect(c.get('https://a.test/1')).not.toBe(null);
    expect(c.get('https://a.test/3')).not.toBe(null);
    expect(c.size).toBe(2);
  });
  it('evicts over the total-bytes cap and keeps the byte count honest', () => {
    const c = createRunCache({ maxTotalBytes: 100 });
    c.set('https://a.test/1', entry(200, 60));
    c.set('https://a.test/2', entry(200, 60));
    expect(c.get('https://a.test/1')).toBe(null);
    expect(c.get('https://a.test/2')).not.toBe(null);
    expect(c.totalBytes).toBe(60);
  });
  it('coalesces in-flight fetches and settles waiters', async () => {
    const c = createRunCache();
    const f = c.beginFlight('https://a.test/x');
    expect(c.flight('https://a.test/x')).toBe(f);
    const e = entry(200, 3);
    c.set('https://a.test/x', e);
    c.settleFlight('https://a.test/x', e);
    expect(await f.promise).toBe(e);
    expect(c.flight('https://a.test/x')).toBe(null);
  });
  it('a failed flight settles null so waiters retry the network', async () => {
    const c = createRunCache();
    const f = c.beginFlight('https://a.test/x');
    c.settleFlight('https://a.test/x', null);
    expect(await f.promise).toBe(null);
    expect(c.get('https://a.test/x')).toBe(null);
  });
});

describe('non-cacheable reasons list', () => {
  const localOrigin = 'http://127.0.0.1:5099';
  const make = () => {
    const capture = {
      requested: new Map(), files: new Set(),
      externalPinned: new Set(), externalValidated: new Map(),
      awaiting: new Set(), pending: [], nonCacheable: false, reason: null, reasons: [],
    };
    const hooks = createCaptureHooks({
      capture, localOrigin, resolveRequest: () => null, isBlocked: null,
    });
    return { capture, hooks };
  };
  it('records every distinct cause, ordered; .reason stays the first', () => {
    const { capture, hooks } = make();
    hooks.request({ url: 'https://calendar.test/api', method: 'POST' });
    hooks.requestFailed({ url: 'https://cdn.test/app.js' });
    expect(capture.nonCacheable).toBe(true);
    expect(capture.reason).toBe('non-GET POST https://calendar.test/api');
    expect(capture.reasons).toEqual([
      'non-GET POST https://calendar.test/api',
      'request failed: https://cdn.test/app.js',
    ]);
  });
  it('dedupes on the normalized form: per-page query strings collapse', () => {
    const { capture, hooks } = make();
    hooks.request({ url: 'https://ga.test/collect?page=1', method: 'POST' });
    hooks.request({ url: 'https://ga.test/collect?page=2', method: 'POST' });
    hooks.request({ url: 'https://ga.test/other?x=1', method: 'POST' });
    expect(capture.reasons.length).toBe(2);
    expect(capture.reasons[0]).toBe('non-GET POST https://ga.test/collect?page=1');
  });
  it('caps the list without losing the non-cacheable verdict', () => {
    const { capture, hooks } = make();
    for (let i = 0; i < NONCACHEABLE_REASONS_CAP + 5; i++) {
      hooks.request({ url: `https://t${i}.test/beacon`, method: 'POST' });
    }
    expect(capture.reasons.length).toBe(NONCACHEABLE_REASONS_CAP);
    expect(capture.nonCacheable).toBe(true);
  });
  it('settleCaptureAwaiting records its cause in the list too', () => {
    const capture = { awaiting: new Set(['https://api.test/cached']), nonCacheable: false, reason: null };
    settleCaptureAwaiting(capture);
    expect(capture.reasons).toEqual(['unverified external: https://api.test/cached']);
    expect(capture.reason).toBe(capture.reasons[0]);
  });
  it('flagNonCacheable tolerates captures without a reasons array', () => {
    const capture = { nonCacheable: false, reason: null };
    flagNonCacheable(capture, 'non-GET POST https://a.test/x');
    expect(capture.reasons).toEqual(['non-GET POST https://a.test/x']);
  });
  it('normalizeNonCacheableCause keeps host+path, drops scheme and query', () => {
    expect(normalizeNonCacheableCause('non-GET POST https://calendar.google.com/u/0/post?sid=1'))
      .toBe('non-GET POST calendar.google.com/u/0/post');
    expect(normalizeNonCacheableCause('unresolvable request /nope'))
      .toBe('unresolvable request /nope');
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
