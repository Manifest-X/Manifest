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
  createExternalTokenizer,
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
    globalKey: 'v1|mnfst-render@0.0.0|salt|manifesthash',
    inputPairs: ['index.html:aaa', 'data/a.json:bbb'],
    externalTokens: ['https://cdn.test/x@1.2.3/x.js'],
  };
  it('is order-independent for input pairs and external tokens', () => {
    const a = computeRouteSignature(base);
    const b = computeRouteSignature({
      ...base,
      inputPairs: [...base.inputPairs].reverse(),
      externalTokens: [...base.externalTokens].reverse(),
    });
    expect(a).toBe(b);
  });
  it('changes when any part changes', () => {
    const a = computeRouteSignature(base);
    expect(computeRouteSignature({ ...base, globalKey: 'other' })).not.toBe(a);
    expect(computeRouteSignature({ ...base, inputPairs: ['index.html:zzz', 'data/a.json:bbb'] })).not.toBe(a);
    expect(computeRouteSignature({ ...base, externalTokens: ['https://cdn.test/x@1.2.4/x.js'] })).not.toBe(a);
  });
});

describe('evaluateRouteSkip', () => {
  const globalKey = 'gk';
  const hashes = { 'index.html': 'h1', 'data/a.json': 'h2' };
  const tokenize = async (u) => u;
  const goodEntry = () => ({
    sig: computeRouteSignature({
      globalKey,
      inputPairs: ['index.html:h1', 'data/a.json:h2'],
      externalTokens: ['https://cdn.test/a@1.0.0/a.js'],
    }),
    inputs: { 'index.html': 'h1', 'data/a.json': 'h2' },
    external: ['https://cdn.test/a@1.0.0/a.js'],
    outputs: { 'about/index.html': 'o1' },
  });
  const deps = (over = {}) => ({
    entry: goodEntry(),
    hashInput: (p) => hashes[p] || null,
    tokenizeExternal: tokenize,
    globalKey,
    outputHash: (p) => (p === 'about/index.html' ? 'o1' : null),
    ...over,
  });

  it('skips when inputs, signature and outputs all match', async () => {
    expect((await evaluateRouteSkip(deps())).skip).toBe(true);
  });
  it('renders when there is no ledger entry', async () => {
    expect((await evaluateRouteSkip(deps({ entry: undefined }))).skip).toBe(false);
  });
  it('renders when the entry is non-cacheable', async () => {
    const entry = { ...goodEntry(), nonCacheable: true };
    expect((await evaluateRouteSkip(deps({ entry }))).skip).toBe(false);
  });
  it('renders when the entry is malformed', async () => {
    for (const entry of [{}, { sig: 'x' }, { sig: 'x', inputs: {}, external: [], outputs: {} }]) {
      expect((await evaluateRouteSkip(deps({ entry }))).skip).toBe(false);
    }
  });
  it('renders when a recorded input file is missing', async () => {
    const r = await evaluateRouteSkip(deps({ hashInput: (p) => (p === 'index.html' ? 'h1' : null) }));
    expect(r.skip).toBe(false);
    expect(r.reason).toMatch(/input missing/);
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
  it('renders when an external identity resolves differently', async () => {
    const r = await evaluateRouteSkip(deps({ tokenizeExternal: async (u) => `${u}#new-etag` }));
    expect(r.skip).toBe(false);
    expect(r.reason).toMatch(/signature/);
  });
  it('renders when a previous output file is missing or altered', async () => {
    const missing = await evaluateRouteSkip(deps({ outputHash: () => null }));
    expect(missing.skip).toBe(false);
    const altered = await evaluateRouteSkip(deps({ outputHash: () => 'tampered' }));
    expect(altered.skip).toBe(false);
  });
  it('propagates tokenizer failure (caller disables incremental)', async () => {
    await expect(evaluateRouteSkip(deps({ tokenizeExternal: async () => { throw new Error('HEAD failed'); } })))
      .rejects.toThrow('HEAD failed');
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
  it('returns null when nothing (not even index.html) can serve the path', () => {
    expect(resolveStaticRequestFile(dir, '/missing')).toBe(null);
  });
});

describe('createExternalTokenizer', () => {
  it('passes pinned-version URLs through without resolution', async () => {
    const tokenize = createExternalTokenizer({ head: async () => { throw new Error('must not resolve'); } });
    expect(await tokenize('https://cdn.test/mnfst@1.2.3/manifest.js'))
      .toBe('https://cdn.test/mnfst@1.2.3/manifest.js');
  });
  it('resolves unversioned URLs once per run (memoized)', async () => {
    let calls = 0;
    const tokenize = createExternalTokenizer({ head: async () => { calls++; return '200:etag-1'; } });
    const a = await tokenize('https://cdn.test/mnfst@latest/manifest.js');
    const b = await tokenize('https://cdn.test/mnfst@latest/manifest.js');
    expect(a).toBe('https://cdn.test/mnfst@latest/manifest.js#200:etag-1');
    expect(b).toBe(a);
    expect(calls).toBe(1);
  });
  it('propagates resolution failure', async () => {
    const tokenize = createExternalTokenizer({ head: async () => { throw new Error('offline'); } });
    await expect(tokenize('https://cdn.test/unpinned.js')).rejects.toThrow('offline');
  });
});
