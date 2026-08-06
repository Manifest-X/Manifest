// mnfst-publish — one-command managed publishing for Manifest projects.
//
// Replaces the old "tool hands you a zip|curl with a scraped token" flow (which
// reads as data-exfiltration to safety tooling and is jargon-heavy for users).
// This is a single named command: it reads the project's API key from .env, does
// the MCP publish handshake, renders if needed, zips gitignore-aware, uploads,
// and prints the live URL. Zero npm deps; cross-platform (pure-Node zip).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';

const DEFAULT_MCP = 'https://manifest-mcp.manifest-c5f.workers.dev/mcp';

function log(msg) {
  process.stdout.write(msg + '\n');
}
function fail(msg) {
  console.error('mnfst-publish: ' + msg);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { env: 'production', render: undefined, promote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staging') out.env = 'staging';
    else if (a === '--production' || a === '--prod') out.env = 'production';
    else if (a === '--env') out.env = argv[++i];
    else if (a === '--source') out.source = argv[++i];
    else if (a === '--no-render') out.render = false;
    else if (a === '--render') out.render = true;
    else if (a === '--promote') out.promote = true;
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--mcp') out.mcp = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
  }
  if (out.env !== 'staging' && out.env !== 'production') fail(`--env must be "staging" or "production" (got "${out.env}")`);
  return out;
}

// Walk up from cwd to find the project root (where manifest.json or .mcp.json lives).
function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'manifest.json')) || existsSync(join(dir, '.mcp.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function readApiKey(root, explicit) {
  if (explicit) return explicit;
  if (process.env.MANIFEST_API_KEY) return process.env.MANIFEST_API_KEY;
  for (const name of ['.env.manifest', '.env']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^\s*MANIFEST_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
    if (m) return m[1].trim();
  }
  return null;
}

function readMcpUrl(root, explicit) {
  if (explicit) return explicit;
  const p = join(root, '.mcp.json');
  if (existsSync(p)) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      const server = cfg.mcpServers && (cfg.mcpServers.manifest || Object.values(cfg.mcpServers)[0]);
      if (server && server.url) return server.url;
    } catch {
      /* fall through to default */
    }
  }
  return DEFAULT_MCP;
}

// "render" when the project prerenders (manifest.json has a prerender block or a
// /website output dir exists); otherwise a root-served SPA.
function detectSource(root, explicit) {
  if (explicit) return explicit;
  try {
    const mf = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    if (mf && (mf.prerender || mf.render)) return 'render';
  } catch {
    /* ignore */
  }
  return existsSync(join(root, 'website')) ? 'render' : 'spa';
}

// The prerender output directory (where mnfst-render writes), honouring
// manifest.prerender.output / manifest.render.output; defaults to "website".
function prerenderOutputDir(root) {
  try {
    const mf = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    const out = mf?.prerender?.output ?? mf?.render?.output;
    if (typeof out === 'string' && out.trim()) return out.trim().replace(/^\/+|\/+$/g, '');
  } catch {
    /* ignore */
  }
  return 'website';
}

// --- MCP JSON-RPC over Streamable HTTP -------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry transient failures — a thrown fetch (network blip, worker cold-start /
// redeploy window) or a 5xx — with a short backoff, so a single hiccup doesn't
// surface as a raw "fetch failed". Publish/promote/upload are idempotent enough
// that a repeat is harmless. 4xx are NOT retried (they're real client errors).
async function fetchRetry(url, init, { tries = 4, label = 'the server' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < tries) {
        log(`  ${label} had a hiccup (HTTP ${res.status}) — retrying (${attempt}/${tries - 1})…`);
        await sleep(500 * attempt);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < tries) {
        log(`  couldn't reach ${label} — retrying (${attempt}/${tries - 1})…`);
        await sleep(500 * attempt);
        continue;
      }
    }
  }
  throw lastErr;
}

async function mcp(url, key, method, params, sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-api-key': key,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetchRetry(
    url,
    { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) },
    { label: 'Manifest' },
  );
  const sid = res.headers.get('mcp-session-id') || sessionId;
  const text = await res.text();
  // Response may be a JSON object or an SSE "data: {...}" line.
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const body = line ? line.slice(5).trim() : text;
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    /* leave null */
  }
  return { json, sessionId: sid, status: res.status, raw: text };
}

async function callTool(url, key, name, args) {
  const init = await mcp(url, key, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mnfst-publish', version: '0.1.0' },
  });
  const sid = init.sessionId;
  if (!sid) throw new Error('no MCP session — check your API key and network connection');
  await mcp(url, key, 'notifications/initialized', {}, sid);
  const res = await mcp(url, key, 'tools/call', { name, arguments: args }, sid);
  const result = res.json && res.json.result;
  if (!result) throw new Error(`unexpected response from ${name} (HTTP ${res.status})`);
  const textPart = (result.content || []).find((c) => c.type === 'text');
  const payloadText = textPart ? textPart.text : '';
  if (result.isError) throw new Error(payloadText || `${name} failed`);
  try {
    return JSON.parse(payloadText);
  } catch {
    return { _text: payloadText };
  }
}

// --- File collection (gitignore-aware) -------------------------------------

// Never ship local config or secrets — matched at ANY depth (by path segment /
// basename), not just the project root. A nested `api/.env` or `sub/.claude/…`
// must be excluded too.
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.claude']);
export function isExcludedPath(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return true;
  const base = parts[parts.length - 1];
  if (base === '.env' || base.startsWith('.env.')) return true; // .env, .env.local, .env.prod …
  if (base === '.npmrc' || base === '.dev.vars' || base === 'id_rsa' || base === '.DS_Store') return true;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  return false;
}

// Publish-time exclusions, declared per-project and DECOUPLED from git — so a file
// can stay versioned yet never ship. Sourced from a `.manifestignore` file
// (gitignore-style) and/or a `publishIgnore: []` array in manifest.json. Supports
// comments (#), directory patterns (`dir/`), path-anchored patterns (`a/b`), and
// `*` / `**` / `?` globs. Returns a matcher; matches nothing when there are no rules.
export function makePublishIgnore(rawPatterns) {
  const rules = [];
  for (let p of rawPatterns || []) {
    if (typeof p !== 'string') continue;
    p = p.trim();
    if (!p || p.startsWith('#')) continue;
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.startsWith('/');
    if (anchored) p = p.replace(/^\/+/, '');
    if (!p) continue;
    const pathScoped = anchored || p.includes('/');
    const body = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*')
      .replace(/\?/g, '[^/]');
    rules.push({ dirOnly, pathScoped, exact: new RegExp('^' + body + '$'), prefix: new RegExp('^' + body + '/') });
  }
  if (!rules.length) return () => false;
  return (rel) => {
    for (const r of rules) {
      if (r.pathScoped) {
        if (!r.dirOnly && r.exact.test(rel)) return true; // exact file/path
        if (r.prefix.test(rel)) return true;              // anything under the dir/prefix
      } else {
        // Unanchored, no slash: match any path segment (a dir name, or a basename).
        const segs = rel.split('/');
        for (let i = 0; i < segs.length; i++) {
          if (r.dirOnly && i === segs.length - 1) continue; // a `dir/` rule can't match the file itself
          if (r.exact.test(segs[i])) return true;
        }
      }
    }
    return false;
  };
}

export function loadPublishIgnore(root) {
  const patterns = [];
  const ignoreFile = join(root, '.manifestignore');
  if (existsSync(ignoreFile)) {
    try { patterns.push(...readFileSync(ignoreFile, 'utf8').split(/\r?\n/)); } catch { /* ignore */ }
  }
  try {
    const mf = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    if (Array.isArray(mf.publishIgnore)) patterns.push(...mf.publishIgnore);
  } catch { /* no / invalid manifest.json — nothing to add */ }
  return makePublishIgnore(patterns);
}

export function collectFiles(root) {
  const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  let rels;
  if (git.status === 0) {
    rels = git.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } else {
    // Not a git repo — walk, skipping excluded dirs as we go.
    rels = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (EXCLUDED_DIRS.has(name)) continue;
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs);
        else rels.push(relative(root, abs).split(sep).join('/'));
      }
    };
    walk(root);
  }
  // Final guards — drop nested secret files, then project-declared publish exclusions.
  // .manifestignore applies ON TOP of gitignore, so a versioned file can still be
  // kept out of the published bundle.
  const publishIgnored = loadPublishIgnore(root);
  return rels.filter((r) => !isExcludedPath(r) && !publishIgnored(r));
}

// --- Component version stamp ------------------------------------------------

// Stamp each shipped manifest.json (project root, and the prerender output copy)
// with `deployment`: a content hash of its component HTML files. The components
// plugin appends it as ?v= to component fetches, so browser caches bust exactly
// when component markup changes and persist when it doesn't. Purely publish-time:
// the on-disk manifest.json is never modified.
export function stampManifests(root, rels) {
  const overrides = new Map();
  const relSet = new Set(rels);
  const outDir = prerenderOutputDir(root);
  for (const mfRel of ['manifest.json', outDir + '/manifest.json']) {
    if (!relSet.has(mfRel)) continue;
    let mf;
    try {
      mf = JSON.parse(readFileSync(join(root, mfRel), 'utf8'));
    } catch {
      continue; // invalid JSON — ship as-is
    }
    const dir = mfRel.includes('/') ? mfRel.slice(0, mfRel.lastIndexOf('/') + 1) : '';
    const paths = [...(mf.preloadedComponents || []), ...(mf.components || [])]
      .filter((p) => typeof p === 'string' && !p.startsWith('http'))
      .map((p) => dir + p.replace(/^\/+/, ''))
      .filter((p) => relSet.has(p))
      .sort();
    if (!paths.length) continue;
    const hash = createHash('sha256');
    for (const p of paths) {
      hash.update(p + '\0');
      hash.update(readFileSync(join(root, p)));
      hash.update('\0');
    }
    mf.deployment = hash.digest('hex').slice(0, 12);
    overrides.set(mfRel, Buffer.from(JSON.stringify(mf, null, 2) + '\n', 'utf8'));
  }
  return overrides;
}

// --- Minimal ZIP writer (DEFLATE), pure Node, no deps ----------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function buildZip(root, rels, overrides = new Map()) {
  // This packer writes classic (non-Zip64) ZIP records: file count is a uint16
  // and offsets are uint32. Fail loudly rather than emit a silently-corrupt
  // archive past those limits.
  if (rels.length > 0xffff) {
    fail(`too many files to package (${rels.length} > 65535). Split the project or contact support.`);
  }
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const rel of rels) {
    if (offset > 0xffffffff) {
      fail('project is too large to package (>4 GB). Contact support.');
    }
    const data = overrides.get(rel) ?? readFileSync(join(root, rel));
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data);
    // Store uncompressed if deflate didn't help (e.g. already-compressed assets).
    const useStore = deflated.length >= data.length;
    const method = useStore ? 0 : 8;
    const body = useStore ? data : deflated;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0, 8); // flags
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(rels.length, 8);
  end.writeUInt16LE(rels.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// --- Main ------------------------------------------------------------------

export async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log('Usage: npx mnfst-publish [--staging|--production] [--no-render] [--promote]');
    log('Publishes the current Manifest project to managed hosting and prints the live URL.');
    return;
  }

  const root = opts.root ? opts.root : findRoot(process.cwd());
  const url = readMcpUrl(root, opts.mcp);
  const source = detectSource(root, opts.source);

  // A connector-driven publish passes a pre-authorised, one-time upload URL in
  // the environment (minted by the manifest_publish tool for the signed-in
  // user). When present, no API key is needed — the token IS the authorisation,
  // so an invited teammate publishes without ever handling a project secret.
  const injectedUpload = process.env.MNFST_PUBLISH_UPLOAD_URL || null;
  const key = readApiKey(root, opts.key);

  // Promote a previously-staged build straight to production (no upload). Headless
  // convenience; interactive users promote via the connector's manifest_promote
  // tool (no key). Needs a key.
  if (opts.promote) {
    if (!key) fail('no API key found for --promote. Set MANIFEST_API_KEY in .env for headless use, or promote from Claude with the Manifest connector (no key needed).');
    log('Promoting the staged version to production…');
    const res = await callTool(url, key, 'manifest_promote', {});
    log('✓ Live: ' + (res.url || res._text || 'production updated'));
    return;
  }

  // A normal publish needs either the injected one-time URL (connector) or a
  // stored key (headless/CI). Without either, there's nothing to authorise with.
  if (!injectedUpload && !key) {
    fail('no API key found. Publish from Claude with the Manifest connector (no key needed), or set MANIFEST_API_KEY in .env for headless/CI use.');
  }

  if (source === 'render' && opts.render !== false) {
    log('Rendering the site…');
    const r = spawnSync('npx', ['mnfst-render'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) fail('render failed — fix the errors above and try again.');
  }

  // For a render project, sanity-check there's actually a built site to ship —
  // an output folder with an index.html. (When we just ran the render above, its
  // exit code was already checked; this also covers --no-render and hand-built
  // output.) Deliberately forgiving: no hard dependency on any marker file, so a
  // good build always publishes regardless of which mnfst-render produced it.
  if (source === 'render') {
    const outDir = prerenderOutputDir(root);
    if (!existsSync(join(root, outDir, 'index.html'))) {
      fail(
        `the "${outDir}" folder doesn't have a built site yet (no index.html). ` +
          (opts.render === false
            ? 'Remove --no-render so it builds first, or run `npx mnfst-render`, then publish again.'
            : 'Run `npx mnfst-render` first, then publish again.'),
      );
    }
  }

  let uploadUrl;
  if (injectedUpload) {
    // Connector path: the manifest_publish tool already minted the deployment
    // and a one-time upload URL for the signed-in user. No handshake, no key.
    uploadUrl = injectedUpload;
  } else {
    // Headless/CI: authenticate the handshake with the key to get an upload URL.
    log(`Preparing ${opts.env} deploy…`);
    const handshake = await callTool(url, key, 'manifest_publish', { env: opts.env, source, via_cli: true });
    uploadUrl = handshake.upload_url;
    if (!uploadUrl) fail(handshake._text || 'could not start the publish (no upload URL returned).');
  }
  // The upload carries the whole project. Only POST it to an HTTPS endpoint on
  // the SAME host as the MCP server — never to an arbitrary URL a tampered
  // response or misconfigured .mcp.json could inject.
  try {
    const u = new URL(uploadUrl);
    const mcpHost = new URL(url).host;
    if (u.protocol !== 'https:' || u.host !== mcpHost) {
      fail(`refusing to upload to an unexpected endpoint (${u.protocol}//${u.host}); expected https://${mcpHost}.`);
    }
  } catch {
    fail('the upload URL returned by the server was malformed.');
  }

  const rels = collectFiles(root);
  if (!rels.length) fail('nothing to publish (no files found).');
  const zip = buildZip(root, rels, stampManifests(root, rels));
  log(`Uploading ${rels.length} files (${(zip.length / 1048576).toFixed(1)} MB)…`);

  const up = await fetchRetry(
    uploadUrl,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip },
    { label: 'the upload server' },
  );
  const upText = await up.text();
  let upJson = null;
  try {
    upJson = JSON.parse(upText);
  } catch {
    /* ignore */
  }
  if (!up.ok || !upJson || upJson.ok !== true) {
    fail(`upload failed (HTTP ${up.status}): ${upText.slice(0, 300)}`);
  }

  log('');
  log(`✓ Published to ${opts.env}: ${upJson.url}`);
  if (opts.env === 'staging') log('  Review it, then run `npx mnfst-publish --promote` to take it live.');
}
