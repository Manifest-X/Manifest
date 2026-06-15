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

async function mcp(url, key, method, params, sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-api-key': key,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
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
  if (base === '.mnfst-render-complete') return true; // internal render sentinel — not part of the site
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return true;
  return false;
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
  // Final guard — drops nested secret files the git/walk lists may include.
  return rels.filter((r) => !isExcludedPath(r));
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

function buildZip(root, rels) {
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
    const data = readFileSync(join(root, rel));
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
  const key = readApiKey(root, opts.key);
  if (!key) fail('no API key found. Expected MANIFEST_API_KEY in .env (this folder doesn’t look like a Manifest project, or it isn’t set up for publishing).');
  const url = readMcpUrl(root, opts.mcp);
  const source = detectSource(root, opts.source);

  // Promote a previously-staged build straight to production (no upload).
  if (opts.promote) {
    log('Promoting the staged version to production…');
    const res = await callTool(url, key, 'manifest_promote', {});
    log('✓ Live: ' + (res.url || res._text || 'production updated'));
    return;
  }

  if (source === 'render' && opts.render !== false) {
    log('Rendering the site…');
    const r = spawnSync('npx', ['mnfst-render'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) fail('render failed — fix the errors above and try again.');
  }

  // For a render project, confirm the output is a COMPLETE render before shipping
  // it. mnfst-render writes a .mnfst-render-complete sentinel as its final step
  // (atomic swap), so its absence means the dir is stale or half-built — refuse
  // rather than publish a broken/empty site.
  if (source === 'render') {
    const outDir = prerenderOutputDir(root);
    if (!existsSync(join(root, outDir, '.mnfst-render-complete'))) {
      fail(
        `the "${outDir}" directory isn't a complete render` +
          (opts.render === false ? ' — re-run without --no-render.' : ' — run `npx mnfst-render` and try again.'),
      );
    }
  }

  log(`Preparing ${opts.env} deploy…`);
  const handshake = await callTool(url, key, 'manifest_publish', { env: opts.env, source, via_cli: true });
  if (handshake.already_pro) { /* not applicable */ }
  const uploadUrl = handshake.upload_url;
  if (!uploadUrl) fail(handshake._text || 'could not start the publish (no upload URL returned).');
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
  const zip = buildZip(root, rels);
  log(`Uploading ${rels.length} files (${(zip.length / 1048576).toFixed(1)} MB)…`);

  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: zip,
  });
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
