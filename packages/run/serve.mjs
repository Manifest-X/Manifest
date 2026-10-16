#!/usr/bin/env node
/**
 * mnfst-run — zero-dependency dev server for Manifest projects.
 *
 * Usage:
 *   npx mnfst-run [dir] [--port 5001] [--idle-shutdown 30] [--no-idle-shutdown]
 *                 [--open | --no-open]
 *   npx mnfst-run --list
 *
 *   dir                 Directory to serve (default: current directory). Any
 *                       depth of nesting is valid, e.g.
 *                       npx mnfst-run docs/articles/publishing
 *                       If a server is already running for this directory,
 *                       prints its URL and exits instead of starting a
 *                       duplicate. Use `--list` to see everything running.
 *   --port              Preferred port (default: PORT env var, then 5001).
 *                       Auto-increments if the port is already in use.
 *   --idle-shutdown N   Exit N seconds after the last preview tab closes
 *                       (default 30). A tab is only considered closed when
 *                       it fires `pagehide` (real close/navigation) and the
 *                       browser sends an explicit close beacon — SSE drops
 *                       from sleep, network blips, or backgrounding do not
 *                       count, so the server survives e.g. a laptop sleeping
 *                       overnight with the preview tab still open.
 *   --no-idle-shutdown  Disable auto-shutdown (useful in CI / headless cases
 *                       where no browser will connect).
 *   --open / --no-open  Force / suppress auto-opening an OS browser tab on
 *                       start. Default: open for manual runs, but SUPPRESSED
 *                       under CI and Claude Code (CLAUDECODE /
 *                       CLAUDE_CODE_ENTRYPOINT) — there the LLM app's preview
 *                       panel already shows the page, so a second browser tab
 *                       is just noise. Put `--no-open` in an LLM preview's
 *                       launch config to guarantee suppression.
 *   --attach            Supervised/agent mode (e.g. an LLM preview panel that
 *                       assigns a port and tracks the process it spawns). Never
 *                       starts a SECOND dev server for a project already running:
 *                       if a server for this root exists on another port, it
 *                       binds the assigned port and reverse-proxies to that real
 *                       server (live reload included); if it's already on the
 *                       assigned port it just attaches; otherwise it starts one
 *                       normally. Let the supervisor pick the port (no --port;
 *                       it's read from PORT). Pair with `--no-open`.
 *   --list              Print all mnfst-run servers currently running on this
 *                       machine and exit.
 *
 * SPA vs MPA is auto-detected: if the root index.html contains
 * <meta name="manifest:prerendered"> the server disables SPA fallback.
 *
 * Live reload:
 *   .css            → hot-swaps the matching stylesheet href (no reload, no flash)
 *   .csv/.json/etc. → dispatches manifest:dev-reload; data plugin re-fetches local
 *                     sources and updates Alpine store reactively (no reload)
 *   other           → full page reload
 */
import { createServer, get as httpGet, request as httpRequest }  from 'http';
import { request as httpsRequest } from 'https';
import { connect as tlsConnect } from 'tls';
import {
  readFileSync, statSync, watch,
  existsSync, writeFileSync, unlinkSync,
  mkdirSync, readdirSync, renameSync, accessSync, chmodSync, realpathSync, constants as fsConstants,
} from 'fs';
import { join, extname, resolve, basename, sep, dirname, relative, isAbsolute, posix } from 'path';
import { exec }                          from 'child_process';
import { tmpdir }                        from 'os';
import { createHash }                    from 'crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.xml':  'application/xml; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map':  'application/json',
};

// Built once at startup. Injected only into full HTML documents (not fragments).
// - CSS changes       → hot-swaps the matching <link> href (no reload, no flash)
// - data file changes → dispatches manifest:dev-reload (data plugin re-fetches)
// - other changes     → full page reload
//
// Tab lifecycle:
//   The script generates a per-tab id and passes it on every SSE connect so
//   the server can match auto-reconnects (after sleep / network blips) back
//   to the same tab. On real tab close it fires a `sendBeacon` to
//   /__mnfst_close__ — that beacon, not the SSE drop, is what tells the
//   server the tab is gone.
const LIVE_RELOAD_SCRIPT = `<script>
(function () {
  window.__mnfstRun = true; // dev marker: the framework loader skips its service worker here
  var tabId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : (Math.random().toString(36).slice(2) + Date.now().toString(36));
  var es = new EventSource('/__mnfst_sse__?tabId=' + encodeURIComponent(tabId));
  es.onmessage = function (e) {
    var d = JSON.parse(e.data);
    var files = d.files || (d.rel ? [{ rel: d.rel, hash: d.hash }] : []);
    files.forEach(function (f) { window.dispatchEvent(new CustomEvent('manifest:source-change', { detail: { file: f.rel, hash: f.hash } })); });
    if (d.type === 'css') {
      document.querySelectorAll('link[rel="stylesheet"]').forEach(function (l) {
        var base = l.href.split('?')[0];
        if (base.endsWith(d.file)) l.href = base + '?t=' + Date.now();
      });
    } else if (d.type === 'data') {
      window.dispatchEvent(new CustomEvent('manifest:dev-reload'));
    } else {
      // Cancelable: a page that wrote these files itself (and is already up to date) may keep its state
      if (window.dispatchEvent(new CustomEvent('manifest:live-reload', { cancelable: true, detail: { files: files } }))) location.reload();
    }
  };
  // Don't close on error — let EventSource auto-reconnect (carries the same
  // tabId, so the server sees it as the same tab waking back up).
  function notifyClose() {
    var url = '/__mnfst_close__?tabId=' + encodeURIComponent(tabId);
    if (navigator.sendBeacon) navigator.sendBeacon(url);
    else { try { fetch(url, { method: 'POST', keepalive: true }); } catch (_) {} }
  }
  // pagehide w/ persisted=false = real tab close or cross-doc navigation.
  // persisted=true means BFCache (back/forward may restore) — leave it alone.
  window.addEventListener('pagehide', function (e) {
    if (e.persisted) return;
    notifyClose();
  });
})();
\x3c/script>`;

// Read a dotenv-style file from the project root and return two maps: `public`
// (vars eligible to ship to the browser) and `private` (vars kept server-side).
// Only the public map is injected into `window.env`; the private map is logged
// at startup so devs can see what was withheld, but never reaches HTML.
//
// Public/private split is by name prefix — matching the established convention
// (Astro `PUBLIC_`, SvelteKit `PUBLIC_`, Vite `VITE_`, Next `NEXT_PUBLIC_`):
//   - PUBLIC_FOO=…   → exposed via window.env.PUBLIC_FOO
//   - MANIFEST_API_KEY=…, STRIPE_SECRET=…, anything else → server-side only
//
// Rationale: prior versions injected the entire .env, so the scaffold's own
// MANIFEST_API_KEY (which create-starter writes with a "treat like a password"
// comment) was visible in view-source on every served page. The prefix gate
// makes the rule explicit at the call site rather than relying on devs to know
// that .env values reach the browser.
//
// Supported parse subset (intentionally minimal, no expansion / multiline):
//   - KEY=value                  (whitespace around `=` ok)
//   - KEY="quoted"  /  KEY='…'   (surrounding quotes stripped)
//   - # comments and blank lines ignored
//   - lines without `=` ignored
//
// Production note: env injection happens ONLY through this dev server.
// Static deploys (Netlify/Vercel/Cloudflare Pages/S3/etc.) serve manifest.json
// verbatim, so any `${VAR}` placeholder that needs a value in production must
// be hardcoded in manifest.json, baked in at prerender time, or substituted
// by the host. See the Appwrite setup doc for the full pattern.
function loadEnvFile(rootDir) {
  const envPath = join(rootDir, '.env');
  if (!existsSync(envPath)) return { public: {}, private: [], privateValues: {} };
  const publicEnv = {};
  const privateNames = [];
  const privateValues = {};   // server-side only — NEVER injected into window.env
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (!key) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key.startsWith('PUBLIC_')) publicEnv[key] = value;
      else { privateNames.push(key); privateValues[key] = value; }
    }
  } catch (error) {
    console.warn('[mnfst-run] Failed to parse .env:', error.message);
  }
  return { public: publicEnv, private: privateNames, privateValues };
}

// Build a `<script>window.env = {…};</script>` tag from the public env map.
// Returns '' when there are no public vars (so the injection is a no-op for
// projects whose .env contains only server-side secrets). Escapes any
// `</script` substring inside string values so an env value can't break out
// of the script tag.
function buildEnvInjectScript(publicEnv) {
  const keys = Object.keys(publicEnv);
  if (keys.length === 0) return '';
  const json = JSON.stringify(publicEnv).replace(/<\/script/gi, '<\\/script');
  return `<script>window.env = ${json};</script>`;
}

// --- CLI args ---
const args = process.argv.slice(2);
let dir  = '.';
let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 5001;
// Auto-shutdown: when the last preview tab is explicitly closed (the page's
// `pagehide` handler beacons /__mnfst_close__) and stays closed for
// `idleShutdownSec`, the server exits. SSE drops from sleep, network blips,
// or background-throttling do NOT count as a close — the server is happy to
// sit idle overnight if the tab is still open. Disabled by
// `--no-idle-shutdown` for CI / headless cases where no browser will connect.
let idleShutdownSec = 30;
// Auto-disable idle shutdown when running under CI or Claude Code, where the
// host browser (puppeteer / headless Chromium) does not produce the normal
// `pagehide` beacon + SSE heartbeats that the live-tab tracker relies on.
// Without this, the server would self-exit 30s after launch even while the
// automation is actively driving it. Manual override still works via the
// `--no-idle-shutdown` / `--idle-shutdown <sec>` flags below.
let idleShutdownEnabled = !(
  process.env.CI === 'true' ||
  process.env.CLAUDE_CODE_ENTRYPOINT ||
  process.env.CLAUDECODE
);

// Auto-open a browser tab on start — a convenience for manual terminal/IDE
// runs (saves copy-pasting the URL). Suppressed by default under CI / Claude
// Code, where an LLM app's preview panel IS the browser and already shows the
// page — popping a second OS browser tab is just noise. Override either way
// with `--open` / `--no-open` (and `--no-open` belongs in an LLM preview's
// launch config to guarantee suppression regardless of env detection).
let openBrowserEnabled = !(
  process.env.CI === 'true' ||
  process.env.CLAUDE_CODE_ENTRYPOINT ||
  process.env.CLAUDECODE
);

let listMode = false;
// --attach: supervised/agent mode (e.g. Claude Code's preview panel). Guarantees
// a live server in the FOREGROUND on the requested --port: if that exact port is
// already serving this root, stay attached to it (don't exit) instead of bailing;
// a separate server the user started on another port is left alone. Never writes
// or deletes the running-server registry, so it can't clobber the user's entry.
let attachMode = false;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) { port = parseInt(args[++i], 10); continue; }
  if (args[i] === '--no-idle-shutdown') { idleShutdownEnabled = false; continue; }
  if (args[i] === '--idle-shutdown' && args[i + 1]) { idleShutdownSec = parseInt(args[++i], 10); continue; }
  if (args[i] === '--no-open') { openBrowserEnabled = false; continue; }
  if (args[i] === '--open')    { openBrowserEnabled = true;  continue; }
  if (args[i] === '--attach') { attachMode = true; continue; }
  if (args[i] === '--list' || args[i] === '-l') { listMode = true; continue; }
  if (!args[i].startsWith('-')) dir = args[i];
}

// --- Running-server registry ---
// One JSON file per project under `$TMPDIR/mnfst-run/`, keyed by a hash of
// the absolute root. Each holds `{ root, port, pid, startedAt }`. Used for:
//   1. Dedup — a second `mnfst-run <dir>` for an already-running project
//      prints the existing URL instead of spinning up another port.
//   2. `--list` — show what's currently running across all projects.
// Cleanup happens on graceful exit (idle-shutdown, Ctrl+C, SIGTERM). Crash
// recovery is automatic: stale entries are detected by the next startup via
// PID-alive + identity-endpoint check and unlinked.
const REGISTRY_DIR = join(tmpdir(), 'mnfst-run');
const IDENTITY_PATH = '/__mnfst_run__';

function registryFileFor(rootPath) {
  const hash = createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
  return join(REGISTRY_DIR, hash + '.json');
}

function readRegistryEntry(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Quick probe of /__mnfst_run__ to confirm the entry isn't stale (PID may
// have been recycled to an unrelated process). Resolves to the parsed
// identity object on success, null on timeout / non-mnfst response.
function probeIdentity(p, timeoutMs = 400) {
  return new Promise((resolveProbe) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolveProbe(v); };
    const req = httpGet({ host: '127.0.0.1', port: p, path: IDENTITY_PATH, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 4096) { res.destroy(); finish(null); } });
      res.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
  });
}

async function findRunningServer(rootPath) {
  const file = registryFileFor(rootPath);
  if (!existsSync(file)) return null;
  const entry = readRegistryEntry(file);
  if (!entry || entry.root !== rootPath || !pidAlive(entry.pid)) {
    try { unlinkSync(file); } catch {}
    return null;
  }
  const id = await probeIdentity(entry.port);
  if (!id || id.root !== rootPath) {
    try { unlinkSync(file); } catch {}
    return null;
  }
  return entry;
}

function writeRegistry(rootPath, p) {
  try { mkdirSync(REGISTRY_DIR, { recursive: true }); } catch {}
  try {
    writeFileSync(registryFileFor(rootPath), JSON.stringify({
      root: rootPath,
      port: p,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }) + '\n');
  } catch { /* registry is best-effort; serving still works without it */ }
}

function removeRegistry(rootPath) {
  try { unlinkSync(registryFileFor(rootPath)); } catch {}
}

async function listRunningServers() {
  let files;
  try { files = readdirSync(REGISTRY_DIR); } catch { files = []; }
  const rows = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const file = join(REGISTRY_DIR, f);
    const entry = readRegistryEntry(file);
    if (!entry || !pidAlive(entry.pid)) { try { unlinkSync(file); } catch {} continue; }
    const id = await probeIdentity(entry.port);
    if (!id || id.root !== entry.root) { try { unlinkSync(file); } catch {} continue; }
    rows.push(entry);
  }
  if (rows.length === 0) { console.log('No mnfst-run servers running.'); return; }
  const portW = Math.max(4, ...rows.map(r => String(r.port).length));
  const pidW  = Math.max(3, ...rows.map(r => String(r.pid).length));
  console.log(`${'PORT'.padEnd(portW)}  ${'PID'.padEnd(pidW)}  URL                          ROOT`);
  for (const r of rows) {
    const url = `http://localhost:${r.port}`;
    console.log(`${String(r.port).padEnd(portW)}  ${String(r.pid).padEnd(pidW)}  ${url.padEnd(28)}  ${r.root}`);
  }
}

if (listMode) {
  await listRunningServers();
  process.exit(0);
}

const root = resolve(process.cwd(), dir);
const EDIT_ENABLED = process.argv.includes('--edit') || process.env.MNFST_EDIT === '1';   // gates /__edit/save (edit-plugin source write-back, authoring only)

// Load .env from the serving root (if present) and pre-build the inject
// script. Kept as a single string so serveFile doesn't re-stringify on every
// HTML response. Empty string when no public vars exist — the injection step
// becomes a no-op for projects whose .env holds only server-side secrets.
const { public: publicEnv, private: privateEnvNames, privateValues: privateEnv } = loadEnvFile(root);
// Appwrite dev proxy: when APPWRITE_PROXY_TARGET is set (server-side .env), the
// dev server proxies /_appwrite/* to that Appwrite origin so the session cookie
// is FIRST-PARTY on localhost. Cross-origin Appwrite Cloud blocks the third-party
// session cookie, and some endpoints (e.g. Presences) don't honour the
// X-Fallback-Cookies workaround the SDK uses for the others — so user-scoped
// calls land as the anonymous "guests" role. Proxying makes Appwrite same-origin
// and fixes it uniformly (HTTP + Realtime WebSocket).
const APPWRITE_PROXY_TARGET = (process.env.APPWRITE_PROXY_TARGET || privateEnv.APPWRITE_PROXY_TARGET || '').trim();
const APPWRITE_PROXY_PREFIX = '/_appwrite';

let envInjectScript = buildEnvInjectScript(publicEnv);
// Edit mode marker: the edit plugin reads /__edit/base only when it is served
if (EDIT_ENABLED) envInjectScript += '<script>window.__mnfstEdit=true;</script>';
if (APPWRITE_PROXY_TARGET) {
  // Point the Appwrite endpoint at the same-origin proxy. Computed in the browser
  // from location.origin so it's port-independent (auto-port safe) and prod-safe
  // (production sets PUBLIC_APPWRITE_ENDPOINT to the real/custom domain instead).
  envInjectScript += `<script>window.env=Object.assign(window.env||{},{PUBLIC_APPWRITE_ENDPOINT:location.origin+'${APPWRITE_PROXY_PREFIX}/v1'});</script>`;
}


// --- Turnkey AI relay (gates the same-origin /_ai/chat route) ---------------
// Reads the optional `ai` block from manifest.json and the LLM key from .env
// (server-side only). When the `ai` block is present, the dev server hosts the
// relay so a chat adapter can POST to `/_ai/chat` with no separate proxy, no
// CORS, and no key in the browser. No key → MOCK replies (try keyless); add the
// key for real. The same path is served by managed Manifest hosting in prod.
const aiConfig = (() => {
  try { return JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).ai || null; }
  catch { return null; }
})();

// Doc-grounding: `ai.system` (persona/instructions) + optional `ai.grounding`
// (URL or project-relative file whose text is appended to the system prompt).
// Resolved ONCE at startup so the combined prompt is byte-identical across
// requests — the precondition for the server-side prompt cache to hit.
let aiSystemResolved = (aiConfig && aiConfig.system) || '';
async function resolveAiGrounding() {
  const src = aiConfig && aiConfig.grounding;
  if (!src) return;
  try {
    let text;
    if (/^https?:\/\//.test(src)) {
      const r = await fetch(src);
      if (!r.ok) throw new Error(`http ${r.status}`);
      text = await r.text();
    } else {
      text = readFileSync(join(root, src), 'utf8');
    }
    aiSystemResolved = (aiSystemResolved ? aiSystemResolved + '\n\n' : '')
      + '<reference_documentation>\n' + text + '\n</reference_documentation>';
    console.log(`[mnfst-run] AI grounding loaded from ${src} (${text.length} bytes)`);
  } catch (e) {
    console.warn(`[mnfst-run] AI grounding failed to load from ${src}: ${e.message} — continuing without it`);
  }
}
if (aiConfig) resolveAiGrounding();
const aiKey = process.env.ANTHROPIC_API_KEY || privateEnv.ANTHROPIC_API_KEY || '';
if (publicEnv.PUBLIC_ANTHROPIC_API_KEY) {
  // The one footgun: a PUBLIC_-prefixed LLM key would ship to every visitor.
  console.warn('[mnfst-run] ⚠ PUBLIC_ANTHROPIC_API_KEY is injected into the BROWSER and exposes your key to every visitor. Rename it to ANTHROPIC_API_KEY (no PUBLIC_ prefix) — the dev server uses it server-side via /_ai/chat.');
}
if (aiConfig) {
  console.log(`[mnfst-run] AI relay on /_ai/chat — provider=${aiConfig.provider || 'anthropic'} model=${aiConfig.model || 'claude-haiku-4-5'} mode=${aiKey ? 'REAL' : 'MOCK (no ANTHROPIC_API_KEY)'}`);
}

function aiSse(res, o) { res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`); }
function streamMockAi(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  aiSse(res, { type: 'message_start', message: { id: 'mock', role: 'assistant' } });
  aiSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const text = "Here's a **mock** reply from the in-server relay:\n\n- no separate proxy\n- the key stays server-side\n- add `ANTHROPIC_API_KEY` to `.env` for real Claude\n\n```js\nconst turnkey = true;\n```";
  const chunks = text.match(/\S+\s*/g) || [text];
  let i = 0;
  const tick = setInterval(() => {
    if (i >= chunks.length) { clearInterval(tick); aiSse(res, { type: 'content_block_stop', index: 0 }); aiSse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: chunks.length } }); aiSse(res, { type: 'message_stop' }); res.end(); return; }
    aiSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i++] } });
  }, 45);
  res.on('close', () => clearInterval(tick));
}
async function streamRealAi(res, payload) {
  // System prompt as a cache_control block: the (instructions + grounding) text
  // is byte-identical every request, so Anthropic serves it from the prompt
  // cache (~0.1× input price) after the first request — long doc-grounded
  // prompts cost near-nothing per message. Per-request payload.system overrides
  // (adapter opts) still work but won't share the project-level cache entry.
  const systemText = payload.system || aiSystemResolved;
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': aiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: payload.model || aiConfig.model || 'claude-haiku-4-5',
      max_tokens: payload.max_tokens || aiConfig.maxTokens || 1024,
      stream: true,
      system: systemText ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] : undefined,
      messages: payload.messages || []
    })
  });
  if (!upstream.ok) {
    const body = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'text/event-stream' });
    aiSse(res, { type: 'error', error: { message: `upstream ${upstream.status}: ${body.slice(0, 300)}` } });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for await (const chunk of upstream.body) res.write(chunk);   // passthrough — exact Anthropic SSE
  res.end();
}
const publicCount = Object.keys(publicEnv).length;
if (publicCount > 0) {
  console.log(`Loaded ${publicCount} PUBLIC_ env var(s) into window.env`);
}
if (privateEnvNames.length > 0) {
  // Loud about what was withheld so devs notice when something they expected
  // in the browser is server-side only — and so a misplaced PUBLIC_ prefix is
  // obvious from the startup log.
  console.log(
    `[mnfst-run] ${privateEnvNames.length} non-PUBLIC_ var(s) NOT injected ` +
    `into window.env (kept server-side): ${privateEnvNames.join(', ')}`
  );
}

const label = dir === '.' ? basename(process.cwd()) : dir.replace(/\\/g, '/');

// If a server is already serving this exact root, REUSE it — never start a
// second dev server for the same project.
//   - manual use: print the URL and exit.
//   - --attach (supervisor, e.g. Claude Code's preview panel): the panel only
//     uses a server on the port it assigned us, and can't point at a server it
//     didn't spawn. So if the existing server is on OUR port, just attach; if
//     it's on a different port, bind our port and reverse-proxy to it — the
//     existing server stays the only real dev server (file-watch, live reload),
//     and the proxy is a thin pass-through the panel can track.
const existing = await findRunningServer(root);
if (existing) {
  if (attachMode) {
    if (existing.port === port) attachToExisting(existing.port);  // already on our port — just keep alive
    else startProxy(port, existing.port);                          // bridge our port → the real server
    await new Promise(() => {});       // block here — never fall through and start a duplicate
  }
  const url = `http://localhost:${existing.port}`;
  console.log(`\n${label} already running at ${url} (pid ${existing.pid})\n`);
  // Open the browser anyway — matches the experience of starting fresh.
  // (Skipped under --no-open / Claude Code, where the preview panel is the browser.)
  if (openBrowserEnabled) {
    const cmd = process.platform === 'win32' ? `start ${url}`
      : process.platform === 'darwin'        ? `open ${url}`
      : `xdg-open ${url}`;
    exec(cmd);
  }
  process.exit(0);
}

// --- Auto-detect MPA ---
function detectMPA(rootDir) {
  try {
    return /name=["']manifest:prerendered["']/i.test(readFileSync(join(rootDir, 'index.html'), 'utf8'));
  } catch { return false; }
}
const spa = !detectMPA(root);

// --- SSE clients & tab presence ---
// `clients` is the live SSE socket list (used to broadcast reload events).
// `openTabs` is the durable set of tabs the server thinks are still open —
// only mutated when a tab connects for the first time, when it sends an
// explicit close beacon, or when its SSE has been disconnected longer than
// ORPHAN_GRACE_MS (a safety net for browser crashes / kill -9, not a normal
// path). `staleTimers` holds the per-tab orphan timers so they can be
// cancelled on reconnect.
let clients = [];        // [{ res, tabId }]
let openTabs = new Set();
let staleTimers = new Map(); // tabId -> setTimeout handle
let debounce = null;

// If a tab's SSE drops and never reconnects within this window we give up on
// it. Long enough to survive overnight sleep, multi-hour breaks, and Chrome
// background-tab discards; short enough that a server orphaned by a real
// browser crash eventually exits on its own.
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(({ res }) => { try { res.write(msg); } catch { /* client gone */ } });
}

// --- Idle auto-shutdown ---
// `everConnected` keeps the timer dormant until at least one tab has opened —
// otherwise the server would exit before the auto-launched browser tab
// finishes loading. `idleTimer` runs only while openTabs is empty; any new
// tab (or reconnect) cancels it. The grace window also covers hard-reload
// churn and same-site navigation: pagehide → close beacon → new page loads
// and reconnects, all within a second or two.
let everConnected = false;
let idleTimer = null;

function armIdleShutdown() {
  if (!idleShutdownEnabled || !everConnected || idleTimer) return;
  if (openTabs.size > 0) return;
  idleTimer = setTimeout(() => {
    console.log(`\nmnfst-run: all preview tabs closed for ${idleShutdownSec}s — shutting down.\n`);
    process.exit(0);
  }, idleShutdownSec * 1000);
}

function cancelIdleShutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function dropTab(tabId) {
  if (!tabId) return;
  openTabs.delete(tabId);
  const t = staleTimers.get(tabId);
  if (t) { clearTimeout(t); staleTimers.delete(tabId); }
}

// --- File watcher ---
// Source-writer temps (`<name>.mnfst-edit-<pid>-<time>.tmp`) never trigger a reload, and
// paths a failed commit touched (staging, rollback) stay quiet while it unwinds.
const EDIT_TEMP = /\.mnfst-edit-\d+-\d+\.tmp$/;
const IGNORE = /node_modules|\.git|\.mnfst-edit-\d+-\d+\.tmp$/;
const quietPaths = new Map();   // root-relative path → quiet until (ms)
const relKey = (p) => String(p).replace(/\\/g, '/').replace(/^\/+/, '');
const pendingChanges = new Set();
try {
  watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || IGNORE.test(filename)) return;
    const until = quietPaths.get(relKey(filename));
    if (until && until > Date.now()) return;
    pendingChanges.add(relKey(filename));
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const changed = [...pendingChanges]; pendingChanges.clear();
      const reload = [];
      for (const rel of changed) {
        const ext = extname(rel).toLowerCase();
        let hash = null; try { hash = fileHash(join(root, rel)); } catch { }
        if (ext === '.css') broadcast({ type: 'css', file: '/' + rel, rel, hash });
        else if (['.csv', '.json', '.yaml', '.yml', '.md'].includes(ext)) broadcast({ type: 'data', rel, hash });
        else reload.push({ rel, hash });
      }
      // One reload naming every file (with its hash), so a page can tell its own publish from other changes
      if (reload.length) broadcast({ type: 'reload', files: reload });
    }, 60);
  });
} catch {
  // fs.watch unavailable in this environment — live reload disabled
}

// A crash between staging and renaming can leave temps behind: sweep them at startup.
function sweepEditTemps(dir, depth = 0) {
  if (depth > 12) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sweepEditTemps(p, depth + 1);
    else if (EDIT_TEMP.test(e.name)) { try { unlinkSync(p); } catch { } }
  }
}
if (EDIT_ENABLED) sweepEditTemps(root);

// --- File serving ---
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

// Reorder a data file's rows/items to match `order` (array of ids). CSV (tabular,
// header with an `id` column) or JSON (array of {id}). Ids not in `order` keep their
// relative order at the end. Returns true if written. Used by /__edit/save (spike).
// Source writes go through an in-memory overlay during a save batch: every patch is
// prepared against it, and the files are written only if all of them succeed.
let VFS = null;
// Write a batch atomically: every target is resolved through symlinks to the real file,
// checked writable, staged as a temp file beside it (mode kept), then renamed over it;
// any failure restores the files already replaced and removes the temps. While the
// commit runs its paths are quiet for the watcher; after a rollback they stay quiet
// briefly, so a failed publish never live-reloads the page.
function commitFiles(files) {
  const jobs = [...files].map(([file, content]) => {
    let real = file;
    try { real = realpathSync(file); } catch { try { real = join(realpathSync(dirname(file)), basename(file)); } catch { } }
    return { file, real, content };
  });
  const keys = new Set();
  jobs.forEach(j => { for (const p of [j.file, j.real]) { const r = relative(root, p); if (!r.startsWith('..')) keys.add(relKey(r)); } });
  const quiet = (until) => keys.forEach(k => quietPaths.set(k, until));
  quiet(Infinity);
  try {
    for (const j of jobs) { const why = writeRefusal(j.file, 'any'); if (why) throw new Error(`${relKey(relative(root, j.file))} refused: ${why}`); }
    for (const j of jobs) {
      try { accessSync(existsSync(j.real) ? j.real : dirname(j.real), fsConstants.W_OK); accessSync(dirname(j.real), fsConstants.W_OK); }
      catch { throw new Error(`${basename(j.file)} is not writable`); }
    }
    const tag = `.mnfst-edit-${process.pid}-${Date.now()}.tmp`;
    const cleanup = () => jobs.forEach(j => { if (j.tmp) try { unlinkSync(j.tmp); } catch { } });
    try {
      for (const j of jobs) {
        j.tmp = j.real + tag;
        writeFileSync(j.tmp, j.content);
        if (existsSync(j.real)) { j.orig = readFileSync(j.real); try { chmodSync(j.tmp, statSync(j.real).mode); } catch { } }
      }
    } catch (e) { cleanup(); throw e; }
    const done = [];
    try {
      for (const j of jobs) { renameSync(j.tmp, j.real); j.tmp = null; done.push(j); }
    } catch (e) {
      for (const j of done) { try { if (j.orig == null) unlinkSync(j.real); else writeFileSync(j.real, j.orig); } catch { } }
      cleanup();
      throw e;
    }
    keys.forEach(k => quietPaths.delete(k));   // success: the watcher reports the change as usual
  } catch (e) {
    quiet(Date.now() + 2000);
    throw e;
  }
}
let READS = null;   // files a save batch read, for the base-version check
const vread = (file) => { if (READS) READS.add(file); return VFS && VFS.has(file) ? VFS.get(file) : readFileSync(file, 'utf8'); };
// What the source writer may touch. Every target must have its kind's extension,
// stay inside the project once symlinks are resolved, and never go through a hidden
// (dot) segment or node_modules.
const WRITE_EXT = { html: ['.html'], css: ['.css'], data: ['.json', '.csv', '.yaml', '.yml', '.md'] };
WRITE_EXT.any = [...WRITE_EXT.html, ...WRITE_EXT.css, ...WRITE_EXT.data];
let REAL_ROOT = null;
const realRoot = () => REAL_ROOT || (REAL_ROOT = realpathSync.native(root));
// Case-insensitive (APFS/NTFS), and segments Windows would alias (trailing dot or space).
const hiddenSegment = (rel) => rel.split(/[\\/]/).some(seg => seg.startsWith('.') || seg.toLowerCase() === 'node_modules' || /[. ]$/.test(seg));
const outside = (rel) => !rel || rel.startsWith('..') || isAbsolute(rel);
function realTarget(file) {
  try { return realpathSync.native(file); } catch { }
  try { return join(realpathSync.native(dirname(file)), basename(file)); } catch { return null; }
}
function writeRefusal(file, kind) {
  const exts = WRITE_EXT[kind] || WRITE_EXT.any, ext = extname(file).toLowerCase();
  if (!exts.includes(ext)) return `${kind === 'any' ? 'the editor' : kind} writes only ${exts.join(' ')} files`;
  const rel = relative(root, file);
  if (outside(rel)) return 'outside the project';
  if (hiddenSegment(rel)) return 'a hidden or node_modules path';
  const real = realTarget(file);
  if (!real) return 'its folder does not exist';
  const rrel = relative(realRoot(), real);
  if (outside(rrel)) return 'it resolves outside the project';
  if (hiddenSegment(rrel)) return 'it resolves into a hidden or node_modules path';
  if (!exts.includes(extname(real).toLowerCase())) return 'it resolves to another file type';
  return null;
}
// Base versions: content hashes of the files publish can write, so a publish can tell
// whether one changed since its page loaded. Cached by mtime+size.
const hashCache = new Map();
function fileHash(file) {
  const st = statSync(file), c = hashCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.hash;
  const hash = createHash('sha1').update(readFileSync(file)).digest('hex');
  hashCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, hash });
  return hash;
}
function baseHashes() {
  const out = {}; let n = 0;
  const walk = (dir, depth) => {
    if (depth > 12 || n > 5000) return;
    let entries = []; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || EDIT_TEMP.test(e.name)) continue;
      const p = join(dir, e.name);
      let real; try { real = realpathSync.native(p); } catch { continue; }
      const rrel = relative(realRoot(), real);
      if (outside(rrel) && real !== realRoot()) continue;
      if (hiddenSegment(rrel)) continue;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!e.isSymbolicLink()) dirs.push(p); }
      else if (WRITE_EXT.any.includes(extname(e.name).toLowerCase())) { try { out[relKey(relative(root, p))] = fileHash(p); n++; } catch { } }
    }
    dirs.forEach(d => walk(d, depth + 1));
  };
  walk(root, 0);
  return out;
}
const vwrite = (file, content) => { if (!VFS) throw new Error('source writes happen only inside a save batch'); VFS.set(file, String(content)); };
const vexists = (file) => (VFS && VFS.has(file)) || isFile(file);
function reorderDataFile(file, order) {
  const why = writeRefusal(file, 'data'); if (why) throw new Error(`refused: ${why}`);
  const ext = extname(file).toLowerCase();
  const text = vread(file);
  const ord = (order || []).map(String);
  if (ext === '.json') {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return false;
    const byId = new Map(data.map(it => [String(it.id), it]));
    const next = ord.map(id => byId.get(id)).filter(Boolean);
    data.forEach(it => { if (!ord.includes(String(it.id))) next.push(it); });
    vwrite(file, JSON.stringify(next, null, 2) + (text.endsWith('\n') ? '\n' : ''));
    return true;
  }
  if (ext === '.csv') {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const trailing = lines.length && lines[lines.length - 1] === '';
    if (trailing) lines.pop();
    if (lines.length < 2) return false;
    const header = lines[0];
    const idIdx = header.split(',').map(s => s.trim().toLowerCase()).indexOf('id');
    if (idIdx < 0) return false;
    const rows = lines.slice(1);
    const idOf = (r) => (r.split(',')[idIdx] || '').trim();   // id col is simple (unquoted); full row line preserved
    const byId = new Map(rows.map(r => [idOf(r), r]));
    const next = ord.map(id => byId.get(id)).filter(Boolean);
    rows.forEach(r => { if (!ord.includes(idOf(r))) next.push(r); });
    vwrite(file, [header, ...next].join(eol) + (trailing ? eol : ''));
    return true;
  }
  return false;
}

// Quote-aware CSV line split + cell quoting (so editing an early column doesn't corrupt
// a later quoted field with commas).
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else { if (ch === ',') { out.push(cur); cur = ''; } else if (ch === '"') q = true; else cur += ch; } }
  out.push(cur); return out;
}
const csvCell = (v) => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
// Why a data source is not a file mnfst-run writes.
const dataSourceRefusal = (name, manifest) => (manifest.data || {})[name] == null
  ? `data source '${name}' is not declared in manifest.json: mnfst-run writes data only to CSV/JSON/YAML files declared there`
  : `data source '${name}' is not a file (a cloud or remote source): save it with $x.${name}.$update, not mnfst-run`;
// Data-value write-back (local CSV/JSON cell). Cloud sources are not files → caller should
// persist via $x.<source>.$update(id,{field}) instead.
function writeDataValue(p, manifest) {
  const src = (manifest.data || {})[p.source], rel = typeof src === 'string' ? src : null;
  if (!rel) return { kind: 'data-val', source: p.source, status: 'error', reason: dataSourceRefusal(p.source, manifest) };
  const file = resolveRel(rel); if (!file || !isFile(file)) return { kind: 'data-val', source: p.source, status: 'error', reason: `file not found: ${rel}` };
  const refused = writeRefusal(file, 'data'); if (refused) return { kind: 'data-val', source: p.source, status: 'error', reason: `refused: ${refused}` };
  const ext = extname(file).toLowerCase(), text = vread(file);
  if (ext === '.json') {
    const data = JSON.parse(text); if (!Array.isArray(data)) return { kind: 'data-val', source: p.source, status: 'error', reason: 'JSON is not an array' };
    const rec = data.find(r => String(r.id) === String(p.id)); if (!rec) return { kind: 'data-val', source: p.source, status: 'error', reason: `id ${p.id} not found` };
    rec[p.field] = p.value; vwrite(file, JSON.stringify(data, null, 2) + (text.endsWith('\n') ? '\n' : ''));
    return { kind: 'data-val', source: p.source, id: p.id, field: p.field, status: 'written', file: basename(file) };
  }
  if (ext === '.csv') {
    const eol = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/);
    const trailing = lines.length && lines[lines.length - 1] === ''; if (trailing) lines.pop();
    if (lines.length < 2) return { kind: 'data-val', source: p.source, status: 'error', reason: 'empty CSV' };
    const header = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
    const idIdx = header.indexOf('id'), fIdx = header.indexOf(String(p.field).toLowerCase());
    if (idIdx < 0 || fIdx < 0) return { kind: 'data-val', source: p.source, status: 'error', reason: `column not found (id/${p.field})` };
    let hit = false;
    const rows = lines.slice(1).map(line => { const cells = parseCsvLine(line); if (String(cells[idIdx]).trim() === String(p.id)) { cells[fIdx] = p.value; hit = true; return cells.map(csvCell).join(','); } return line; });
    if (!hit) return { kind: 'data-val', source: p.source, status: 'error', reason: `id ${p.id} not found` };
    vwrite(file, [lines[0], ...rows].join(eol) + (trailing ? eol : ''));
    return { kind: 'data-val', source: p.source, id: p.id, field: p.field, status: 'written', file: basename(file) };
  }
  return { kind: 'data-val', source: p.source, status: 'error', reason: `unsupported ext ${ext}` };
}

// --- Dependency-free HTML editor ---
// packages/run is zero-dep by design, so the source writer carries its own small HTML
// parser: tokenizer (raw-text elements, comments and attribute quoting as browsers read
// them) plus the tree builder's implied end tags and implied <tbody>, which is what makes
// its element tree match the DOM the client keyed.
const escapeReg = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Index of the '>' that ends the tag opened at `from`, reading attributes as a browser does.
function tagEnd(s, from) {
  let i = from + 1;
  while (i < s.length && !/[\s/>]/.test(s[i])) i++;
  for (;;) {
    while (i < s.length && /[\s/]/.test(s[i])) i++;
    if (i >= s.length) return -1;
    if (s[i] === '>') return i;
    i++;
    while (i < s.length && !/[\s/>=]/.test(s[i])) i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '=') continue;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === '"' || s[i] === "'") { const q = s.indexOf(s[i], i + 1); if (q < 0) return -1; i = q + 1; }
    else while (i < s.length && !/[\s>]/.test(s[i])) i++;
  }
}

// Opening-tag attribute scanner: attributes in order, with the exact span each occupies
// (leading whitespace included), so edits replace or remove in place and quoted values
// can never be mistaken for attributes.
function scanTag(openTag) {
  const m = /^<([a-zA-Z][^\s/>]*)/.exec(openTag); if (!m) return null;
  const re = /(\s*)([^\s"'>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/y;
  const attrs = []; let i = m[0].length;
  for (;;) {
    while (i < openTag.length && /[\s/]/.test(openTag[i]) && openTag.slice(i, i + 2) !== '/>') i++;
    if (i >= openTag.length || openTag[i] === '>' || openTag.slice(i, i + 2) === '/>') break;
    let j = i; while (j > m[0].length && /\s/.test(openTag[j - 1])) j--;
    re.lastIndex = i;
    const a = re.exec(openTag); if (!a || !a[0]) break;
    let v = a[3] === undefined ? null : a[3];
    if (v != null && /^["']/.test(v)) v = v.slice(1, -1);
    attrs.push({ name: a[2], lower: a[2].toLowerCase(), value: v, start: j, end: re.lastIndex });
    i = re.lastIndex;
  }
  while (i > m[0].length && /\s/.test(openTag[i - 1])) i--;
  return { tag: m[1], attrs, end: i };
}
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// Set (null removes) one attribute; repeats of the name collapse into the first.
function setAttr(openTag, name, value) {
  const t = scanTag(openTag); if (!t) return openTag;
  const lower = String(name).toLowerCase(), hits = t.attrs.filter(a => a.lower === lower);
  const put = value == null ? '' : ` ${name}="${escAttr(value)}"`;
  if (!hits.length) return value == null ? openTag : openTag.slice(0, t.end) + put + openTag.slice(t.end);
  let out = openTag;
  for (let i = hits.length - 1; i >= 0; i--) out = out.slice(0, hits[i].start) + (i === 0 ? put : '') + out.slice(hits[i].end);
  return out;
}
const removeAttr = (openTag, name) => setAttr(openTag, name, null);
const attrOf = (openTag, name) => { const t = scanTag(openTag); const a = t && t.attrs.find(x => x.lower === String(name).toLowerCase()); return a ? (a.value == null ? '' : decodeEntities(a.value, true)) : null; };
const hasAttrNamed = (openTag, test) => { const t = scanTag(openTag); return !!t && t.attrs.some(a => test(a.lower)); };

// Character references: the full WHATWG table (html-entities.json, generated by
// scripts/gen-html-entities.mjs), legacy semicolon-less names, and numeric references
// with the spec's replacements.
let ENTITIES = null;
const entityTable = () => ENTITIES || (ENTITIES = JSON.parse(readFileSync(new URL('./html-entities.json', import.meta.url), 'utf8')));
const C1 = { 0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178 };
function decodeEntities(s, attr) {
  const t = entityTable();
  return String(s).replace(/&(#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)/g, (m, e, off, str) => {
    if (e[0] === '#') {
      let n = /^#[xX]/.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '�';
      return String.fromCodePoint(C1[n] || n);
    }
    if (e.endsWith(';') && t[e] !== undefined) return t[e];
    const name = e.replace(/;$/, '');
    for (let k = name.length; k > 1; k--) {
      const p = name.slice(0, k);
      if (t[p] === undefined) continue;
      if (attr) { const next = k < name.length ? name[k] : (e.endsWith(';') ? ';' : str[off + m.length] || ''); if (/[A-Za-z0-9=]/.test(next)) return m; }
      return t[p] + e.slice(k);
    }
    return m;
  });
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen', 'frame']);
const RAW_TEXT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const RCDATA = new Set(['textarea', 'title']);
const SCOPE = ['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template', '#root'];
const BUTTON_SCOPE = new Set([...SCOPE, 'button']);
const LIST_STOP = new Set([...SCOPE, 'ol', 'ul']);
const DL_STOP = new Set([...SCOPE, 'dl']);
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'search', 'summary', 'table', 'ul', 'li', 'dd', 'dt', 'listing', 'plaintext', 'xmp']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const set = (...a) => new Set(a);

// Element tree of s[from, to). Nodes: { name, tag, tagStart, openEnd, innerStart, innerEnd,
// closeEnd, void?, implied? (no tags in source), impliedEnd? (no end tag), children, content }.
function parseHTML(s, from = 0, to = s.length) {
  const root = { name: '#root', tag: '#root', tagStart: from, openEnd: from - 1, innerStart: from, innerEnd: to, closeEnd: to, children: [], content: [], parent: null };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const close = (idx, at, end) => {
    while (stack.length > idx) {
      const el = stack.pop();
      if (stack.length === idx && end) { el.innerEnd = end.start; el.closeEnd = end.end; }
      else { el.innerEnd = at; el.closeEnd = at; el.impliedEnd = true; }
    }
  };
  const find = (names, stops) => { for (let k = stack.length - 1; k > 0; k--) { const n = stack[k].name; if (names.has(n)) return k; if (stops && stops.has(n)) return -1; } return -1; };
  const insert = (name, tag, start, openEnd, extra) => {
    const el = Object.assign({ name, tag, tagStart: start, openEnd, innerStart: openEnd + 1, children: [], content: [], parent: top() }, extra);
    top().children.push(el); top().content.push({ el });
    return el;
  };
  const implied = (name, at) => stack.push(insert(name, name, at, at - 1, { implied: true }));
  const text = (a, b, raw) => { if (b > a) top().content.push({ text: raw ? s.slice(a, b) : decodeEntities(s.slice(a, b)) }); };
  const foreign = () => stack.some(n => n.name === 'svg' || n.name === 'math');
  let i = from;
  while (i < to) {
    const lt = s.indexOf('<', i);
    if (lt < 0 || lt >= to) { text(i, to); break; }
    text(i, lt);
    if (s.startsWith('<!--', lt)) {
      // Comments end at --> or --!>; <!--> and <!---> are complete (empty) comments.
      if (s.startsWith('<!-->', lt)) { i = lt + 5; continue; }
      if (s.startsWith('<!--->', lt)) { i = lt + 6; continue; }
      const re = /--!?>/g; re.lastIndex = lt + 4; const e = re.exec(s);
      i = !e || e.index + e[0].length > to ? to : e.index + e[0].length; continue;
    }
    const c = s[lt + 1];
    if (s.startsWith('<![CDATA[', lt) && foreign()) { const e = s.indexOf(']]>', lt + 9); const end = e < 0 || e >= to ? to : e; text(lt + 9, end, true); i = Math.min(to, end + 3); continue; }
    if (c === '!' || c === '?') { const e = s.indexOf('>', lt); i = e < 0 || e >= to ? to : e + 1; continue; }
    if (c === '/') {
      const m = /^<\/([a-zA-Z][^\s/>]*)/.exec(s.slice(lt, lt + 80));
      const e = s.indexOf('>', lt), end = e < 0 || e >= to ? to : e + 1;
      if (m) {
        const name = m[1].toLowerCase(), k = find(set(name));
        if (name === 'br' && !foreign()) insert('br', 'br', lt, end - 1, { void: true, implied: true, innerEnd: end, closeEnd: end });   // </br> is a <br>
        else if (name === 'p' && find(set('p'), BUTTON_SCOPE) < 0 && !foreign()) insert('p', 'p', lt, lt - 1, { implied: true, innerEnd: lt, closeEnd: end });   // stray </p> makes an empty <p>
        else if (k > 0) close(k, lt, { start: lt, end });
      }
      i = end; continue;
    }
    const m = /^<([a-zA-Z][^\s/>]*)/.exec(s.slice(lt, lt + 80));
    if (!m) { text(lt, lt + 1); i = lt + 1; continue; }
    const e = tagEnd(s, lt);
    if (e < 0 || e >= to) { i = to; break; }
    const tag = m[1], name = tag.toLowerCase(), inForeign = foreign();
    if (!inForeign) {
      if (CLOSES_P.has(name)) { const k = find(set('p'), BUTTON_SCOPE); if (k > 0) close(k, lt); }
      if (HEADINGS.has(name) && HEADINGS.has(top().name)) close(stack.length - 1, lt);
      if (name === 'li') { const k = find(set('li'), LIST_STOP); if (k > 0) close(k, lt); }
      if (name === 'dd' || name === 'dt') { const k = find(set('dd', 'dt'), DL_STOP); if (k > 0) close(k, lt); }
      if (name === 'option' || name === 'optgroup') { if (top().name === 'option') close(stack.length - 1, lt); if (name === 'optgroup' && top().name === 'optgroup') close(stack.length - 1, lt); }
      if (name === 'td' || name === 'th') {
        const k = find(set('td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'table'));
        if (k > 0 && (stack[k].name === 'td' || stack[k].name === 'th')) close(k, lt);
        if (top().name === 'table') implied('tbody', lt);
        if (/^t(body|head|foot)$/.test(top().name)) implied('tr', lt);
      }
      if (name === 'tr') {
        const k = find(set('tr', 'tbody', 'thead', 'tfoot', 'table'));
        if (k > 0 && stack[k].name === 'tr') close(k, lt);
        if (top().name === 'table') implied('tbody', lt);
      }
      if (name === 'tbody' || name === 'thead' || name === 'tfoot') { const k = find(set('tbody', 'thead', 'tfoot', 'table')); if (k > 0 && stack[k].name !== 'table') close(k, lt); }
    }
    const el = insert(name, tag, lt, e);
    i = e + 1;
    if (VOID_TAGS.has(name) || ((inForeign || name === 'svg' || name === 'math') && s[e - 1] === '/')) { el.void = true; el.innerEnd = el.closeEnd = e + 1; continue; }
    stack.push(el);
    if (!inForeign && (RAW_TEXT.has(name) || RCDATA.has(name))) {
      const re = new RegExp(`</${escapeReg(name)}(?=[\\s/>])`, 'ig'); re.lastIndex = i;
      const r = re.exec(s);
      if (!r || r.index >= to) { text(i, to, RAW_TEXT.has(name)); i = to; break; }
      text(i, r.index, RAW_TEXT.has(name));
      const ce = s.indexOf('>', r.index);
      close(stack.length - 1, r.index, { start: r.index, end: ce + 1 });
      i = ce + 1;
    }
  }
  close(1, to);
  return root;
}
const openOf = (s, n) => n.implied ? '' : s.slice(n.tagStart, n.openEnd + 1);
const isPluginNode = (s, n) => !n.implied && /\sdata-edit-(handle|ghost|grip)[\s=/>]/.test(openOf(s, n));
const kidsOf = (s, n) => n.children.filter(k => !isPluginNode(s, k));
const ancestorsOf = (n) => { const out = []; for (let p = n.parent; p && p.name; p = p.parent) out.push(p.name); return out; };
function allElements(root) { const out = []; const walk = (n) => n.children.forEach(k => { out.push(k); walk(k); }); walk(root); return out; }
// The element carrying x-edit*="<key>" as a real attribute.
function locateEditEl(html, key, doc) {
  doc = doc || parseHTML(html);
  return allElements(doc).find(n => !n.implied && (scanTag(openOf(html, n)) || { attrs: [] }).attrs.some(a => /^x-edit(\.|$)/.test(a.lower) && a.value === key)) || null;
}
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Attribute guardrails — the same rules the client applies, checked here on both the
// raw and the entity-decoded value.
const SVG_ANIM = new Set(['set', 'animate', 'animatetransform', 'animatemotion']);
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|avif)[;,]/;
const LOADS = { script: ['src', 'type'], iframe: ['src', 'srcdoc'], embed: ['src', 'srcdoc'], object: ['src', 'srcdoc', 'data'], frame: ['src', 'srcdoc'], link: ['href', 'rel'], base: ['href', 'rel'], meta: ['http-equiv', 'content'] };
function attrRefusal(name, value, tag) {
  const n = String(name || '').trim().toLowerCase(), t = String(tag || '').toLowerCase();
  if (!n || !/^[a-z_][\w:.-]*$/i.test(n)) return 'invalid name';
  if (n === 'text' || n === 'srcdoc' || n === 'action' || n === 'formaction' || n.startsWith('on') || n.startsWith('x-') || n.startsWith('data-edit-')) return 'refused name';
  if (LOADS[t] && LOADS[t].includes(n)) return 'loads or runs content';
  if (SVG_ANIM.has(t) && ['attributename', 'to', 'values', 'from', 'by'].includes(n)) return 'SVG animation target';
  if (value == null) return null;
  for (const raw of [String(value), decodeEntities(value, true)]) {
    const v = raw.replace(/[\u0000- \u007f]/g, '').toLowerCase();
    if (/(^|[,(;'"=])(javascript|vbscript):/.test(v)) return 'script URL';
    const datas = v.match(/(^|[,(;'"=])data:[^,)]*/g) || [];
    if (datas.length && !((t === 'img' || t === 'source') && (n === 'src' || n === 'srcset') && datas.every(d => DATA_IMAGE.test(d.replace(/^[,(;'"=]/, ''))))) return 'data URL';
  }
  return null;
}
// HTML content model: drops the parser would re-nest, foster-parent or drop. Mirrors
// the client's CONTENT_RULES (manifest.edit.core.js).
const CONTENT_RULES = {
  only: {   // parent → the only children it takes
    table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'script', 'template', 'style'],
    thead: ['tr', 'script', 'template'], tbody: ['tr', 'script', 'template'], tfoot: ['tr', 'script', 'template'],
    tr: ['td', 'th', 'script', 'template'], colgroup: ['col', 'template'],
    ul: ['li', 'script', 'template'], ol: ['li', 'script', 'template'], menu: ['li', 'script', 'template'],
    dl: ['dt', 'dd', 'div', 'script', 'template'],
    select: ['option', 'optgroup', 'hr', 'script', 'template'], datalist: ['option', 'script', 'template'], optgroup: ['option', 'script', 'template']
  },
  parent: {   // child → the parents it needs
    tr: ['thead', 'tbody', 'tfoot'], td: ['tr'], th: ['tr'], caption: ['table'], colgroup: ['table'], col: ['colgroup'],
    thead: ['table'], tbody: ['table'], tfoot: ['table'], li: ['ul', 'ol', 'menu'], dt: ['dl', 'div'], dd: ['dl', 'div'],
    option: ['select', 'datalist', 'optgroup'], optgroup: ['select']
  },
  interactive: ['a', 'button', 'input', 'select', 'textarea', 'details', 'label', 'iframe', 'embed', 'object', 'audio', 'video', 'keygen'],
  phrasingOnly: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'],
  block: ['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul', 'li', 'dd', 'dt']
};
// Reason a <child> (with its subtree's tag names) cannot be placed in <parent> (whose
// ancestor tag names are given, nearest first), or null.
function contentRefusal(child, parent, ancestors, subtree) {
  const R = CONTENT_RULES;
  if (R.only[parent] && !R.only[parent].includes(child)) return `<${parent}> takes only ${R.only[parent].filter(t => t !== 'script' && t !== 'template' && t !== 'style').join(', ')}`;
  if (R.parent[child] && !R.parent[child].includes(parent)) return `<${child}> belongs in ${R.parent[child].join(' or ')}`;
  if ((child === 'dt' || child === 'dd') && parent === 'div' && ancestors[1] !== 'dl') return `<${child}> belongs in a dl`;
  if (subtree.has('form') && ancestors.includes('form')) return 'a form cannot contain a form';
  if ((ancestors.includes('a') || ancestors.includes('button')) && R.interactive.some(t => subtree.has(t))) return 'interactive content cannot go inside a link or button';
  if (R.phrasingOnly.includes(parent) && R.block.some(t => subtree.has(t))) return `<${parent}> takes only inline content`;
  return null;
}
// Elements whose content is not markup: never given text edits.
const RAW_EDIT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'xmp', 'iframe', 'noembed', 'noframes']);

// Text sanitizer for edited content: the client's allowlist (inline marks, plus the
// rich editor's blocks), script-bearing elements dropped with their content, other
// tags unwrapped, attributes allowlisted per tag.
const SAN_OK = new Set(['b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'small', 'code', 'mark', 'sub', 'sup', 'br', 'wbr', 'span', 'a', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'time', 'data', 'bdi', 'bdo', 'img',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'address', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'ul', 'ol', 'li', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'input']);
const SAN_DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'noscript', 'template', 'svg', 'math', 'textarea', 'title', 'select', 'frame', 'frameset', 'base', 'form', 'button', 'xmp', 'noembed', 'noframes', 'plaintext']);
// The one attribute Rich Text keeps on each of these inline tags.
const TEXT_ATTR = { abbr: 'title', dfn: 'title', bdo: 'dir', data: 'value', time: 'datetime' };
function textAttrOk(tag, n, v) {
  if (tag === 'a' && (n === 'href' || n === 'title')) return !attrRefusal(n, v, tag);
  if (tag === 'img' && (n === 'alt' || n === 'src')) return !attrRefusal(n, v, tag);
  if (TEXT_ATTR[tag] === n) return n === 'dir' ? /^(ltr|rtl|auto)$/i.test(v) : !attrRefusal(n, v, tag);
  if (tag === 'input') return n === 'type' ? /^checkbox$/i.test(v) : n === 'checked';
  if ((tag === 'td' || tag === 'th') && (n === 'colspan' || n === 'rowspan')) return /^[1-9]\d{0,2}$/.test(v);
  if (n === 'style') return !/expression|url\s*\(|javascript:|@import/i.test(v) && !attrRefusal(n, v, tag);
  return false;
}
function sanitizeHTML(html) {
  const s = String(html == null ? '' : html);
  let out = '', i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    // A comment is kept verbatim when the HTML spec allows its text, so it parses back the same
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e >= 0 && !/^-?>|--!>|<!-$/.test(s.slice(lt + 4, e))) out += s.slice(lt, e + 3); i = e < 0 ? s.length : e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(s.slice(lt, lt + 80));
    if (!m) { out += '&lt;'; i = lt + 1; continue; }
    const end = m[1] ? s.indexOf('>', lt) : tagEnd(s, lt);
    if (end < 0) break;
    const name = m[2].toLowerCase(), closing = !!m[1];
    i = end + 1;
    if (SAN_DROP.has(name)) {
      if (!closing && s[end - 1] !== '/') { const r = new RegExp(`</${escapeReg(name)}(?=[\\s/>])`, 'ig'); r.lastIndex = i; const c = r.exec(s); i = c ? s.indexOf('>', c.index) + 1 || s.length : s.length; }
      continue;
    }
    if (!SAN_OK.has(name)) continue;
    if (closing) { out += `</${name}>`; continue; }
    let tag = '<' + name;
    for (const a of scanTag(s.slice(lt, end + 1)).attrs) {
      const v = a.value == null ? '' : decodeEntities(a.value, true);
      if (textAttrOk(name, a.lower, v)) tag += a.lower === 'checked' ? ' checked' : ` ${a.lower}="${escAttr(v)}"`;
    }
    out += tag + '>';
  }
  return out;
}

// Plugin-rendered hosts: their children are produced at runtime, not authored.
const RENDERED = ['x-html', 'x-text', 'x-markdown', 'x-icon', 'x-svg', 'x-code', 'x-code-group', 'x-chart', 'x-anchors', 'x-carousel', 'x-color', 'x-colorpicker', 'x-combobox', 'x-date', 'x-defer', 'x-virtual', 'x-import', 'x-files', 'x-data-files'];
const isRenderedAttr = (a) => RENDERED.some(r => a === r || a.startsWith(r + '.'));

// A static area's identities, mirroring the client: origin area + tag + the first 24
// chars of source text (rendered content left out), ordinal per repeat, document order;
// plus each element's path and the comment titling it (moves with it).
const canonKey = (region, k) => '@' + encodeURIComponent(region) + '@' + k;
function indexRegion(html, name, node) {
  const reg = { name, root: node, byKey: new Map(), byPath: new Map() };
  const open = (n) => openOf(html, n);
  const rendered = (n) => !n.implied && hasAttrNamed(open(n), isRenderedAttr);
  const textOf = (n) => {
    if (n.void || n.name === 'template' || rendered(n)) return '';
    let t = '';
    for (const c of n.content) t += c.text != null ? c.text : (isPluginNode(html, c.el) || c.el.name === 'template' ? '' : textOf(c.el));
    return t;
  };
  const baseOf = (n) => n.name.toUpperCase() + ':' + textOf(n).replace(/\s+/g, ' ').trim().slice(0, 24);
  const seen = Object.create(null);
  const visit = (n) => {
    const base = n.base = baseOf(n);
    const c = seen[base] = (seen[base] || 0) + 1;
    n.key = canonKey(name, c > 1 ? base + '#' + c : base);
    reg.byKey.set(n.key, n); reg.byPath.set(n.path, n);
    n.kids = kidsOf(html, n);
    let floor = n.innerStart;
    n.kids.forEach((k, i) => { k.path = (n.path ? n.path + '.' : '') + i; k.lead = leadOf(html, k, floor, i === 0); floor = k.closeEnd; });
    if (n.name === 'template' || rendered(n) || (!n.implied && hasAttrNamed(open(n), a => a.startsWith('x-rich-text')))) return;
    n.kids.forEach(visit);
  };
  node.path = '';
  visit(node);
  // Fingerprint: the opening tag and own text; where the key has twins, also their
  // number and the element's ancestors (tag and key), so a reordered twin cannot match.
  const count = Object.create(null);
  for (const n of reg.byKey.values()) count[n.base] = (count[n.base] || 0) + 1;
  for (const n of reg.byKey.values()) {
    if (n === node) continue;
    let own = open(n);
    for (const c of n.content) if (c.text != null) own += '\0' + c.text.replace(/\s+/g, ' ').trim();
    n.fp = fpHash(own);
    if (count[n.base] > 1) {
      let ctx = String(count[n.base]);
      for (let a = n.parent; a && a !== node; a = a.parent) ctx += '\0' + open(a) + '\0' + a.base;
      n.fp += '.' + fpHash(ctx);
    }
  }
  return reg;
}
const fpHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
// Fingerprints of every static element by file: index.html and each component file.
function allSourceIds(files) {
  let manifest = {}; try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); } catch {}
  const out = { 'index.html': sourceIds(join(root, 'index.html')) };
  for (const rel of files) {
    if (rel === 'index.html' || !/\.html$/i.test(rel)) continue;
    const names = [basename(rel, '.html'), rel.replace(/^components\//, '').replace(/\.html$/i, '')];
    if (names.some(n => resolveComponentFile(manifest, n) === rel)) out[rel] = sourceIds(join(root, rel));
  }
  return out;
}
function sourceIds(file) {
  const out = {};
  let html; try { html = readFileSync(file, 'utf8'); } catch { return out; }
  const doc = parseHTML(html);
  if (checkNesting(doc)) return out;
  for (const n of allElements(doc)) {
    if (n.implied) continue;
    const a = (scanTag(openOf(html, n)) || { attrs: [] }).attrs.find(x => /^x-edit(\.|$)/.test(x.lower));
    if (!a || !a.value) continue;
    for (const [k, m] of indexRegion(html, a.value, n).byKey) if (m.fp) out[k] = m.fp;
  }
  return out;
}
// A comment directly above an element (whitespace between, no blank line) titles it.
// A comment that opens its container titles the section, not the first child.
function leadOf(html, n, floor, first) {
  let lead = n.tagStart;
  for (;;) {
    const before = html.slice(floor, lead);
    const m = /<!--(?:(?!-->)[\s\S])*-->([ \t]*\r?\n?[ \t]*)$/.exec(before);
    if (!m || (m[1].match(/\n/g) || []).length > 1) return lead;
    if (first && !before.slice(0, m.index).trim()) return lead;
    lead = floor + m.index;
  }
}
// Element skeleton (tags only), for checking the written file parses as intended.
const skeletonOf = (html, n) => n.name + (n.name === 'template' ? '()' : '(' + kidsOf(html, n).map(k => skeletonOf(html, k)).join(',') + ')');
// Returns the first element whose range does not nest in its parent, or null.
function checkNesting(n) {
  let prev = n.innerStart;
  for (const k of n.children) {
    if (k.tagStart < prev || k.closeEnd > n.innerEnd || k.closeEnd < k.tagStart) return k;
    prev = k.closeEnd;
    const bad = checkNesting(k);
    if (bad) return bad;
  }
  return null;
}
// Where two skeletons first differ, as "<tag> ... (expected …, got …)".
function skeletonDiff(want, got) {
  let i = 0; while (i < want.length && want[i] === got[i]) i++;
  const ctx = (s) => s.slice(Math.max(0, i - 40), i + 40);
  return `expected …${ctx(want)}… got …${ctx(got || '')}…`;
}

// Rebuild every static area from the client's final trees, from the original files: one
// writer per file; an element moved between files is rendered by its own file's writer.
// All files render, then all are checked, then all are written (or none).
function writeStaticTrees(groups, manifest) {
  const writers = [], byRegion = new Map(), early = new Map();
  for (const [file, patches] of groups) {
    const w = staticWriter(file, patches, (name) => byRegion.get(name) || null, manifest || {});
    if (w.refusal) { patches.forEach(p => early.set(p, { region: p.region, status: 'error', reason: w.refusal })); continue; }
    writers.push(w); patches.forEach(p => byRegion.set(p.region, w));
  }
  const all = groups.flatMap(([, ps]) => ps), results = new Map(early);
  if (early.size) { all.forEach(p => { if (!results.has(p)) results.set(p, { region: p.region, status: 'skipped', reason: 'batch aborted: another patch failed; nothing was written' }); }); return results; }
  try {
    writers.forEach(w => w.render());
    writers.forEach(w => w.check());
  } catch (e) {
    if (!e.edit) throw e;
    if (!all.some(p => p.region === e.region)) e.region = null;
    all.forEach(p => results.set(p, e.region == null || p.region === e.region ? { region: p.region, status: 'error', reason: e.message, ...(e.region != null ? { failed: e.region } : {}) }
      : { region: p.region, status: 'skipped', reason: `not written: x-edit="${e.region}" failed; nothing was written` }));
    return results;
  }
  const texts = [];
  for (const w of writers) {
    const r = w.assemble();
    if (r.error) { all.forEach(p => results.set(p, { region: p.region, status: 'error', reason: r.error })); return results; }
    texts.push([w, r.next]);
  }
  for (const [w, next] of texts) if (next !== null) vwrite(w.file, next);
  writers.forEach(w => w.patches.forEach(p => results.set(p, { region: p.region, status: 'written', file: basename(w.file) })));
  return results;
}
function staticWriter(file, patches, foreign, manifest) {
  const self = { file, patches };
  const refused = writeRefusal(file, 'html');
  if (refused) return { refusal: `refused: ${refused}` };
  const html = vread(file);
  const doc = parseHTML(html);
  // A failure names the area it is in, so the page can publish the others without it.
  let current = null;
  const regionOfKey = (k) => { const m = /^(?:~[a-z0-9]+~)?@([^@]*)@/.exec(String(k || '')); return m ? decodeURIComponent(m[1]) : current; };
  const fail = (msg, region) => { const e = new Error(msg); e.edit = true; e.region = region === undefined ? current : region; throw e; };
  const bad = checkNesting(doc);
  if (bad) return { refusal: `source does not nest cleanly at <${bad.name}> (offset ${bad.tagStart}); not editing it` };
  // A component's <x-name> host counts as what the component renders: its first root's tag, and every tag in it.
  const hosts = new Map();
  const hostOf = (tag) => {
    if (!/^x-/.test(tag)) return null;
    if (!hosts.has(tag)) {
      let info = null;
      const rel = resolveComponentFile(manifest, tag.slice(2));
      if (rel) { try { const f = resolveRel(rel), t = f && readFileSync(f, 'utf8'), d = t && parseHTML(t), top = d && kidsOf(t, d); if (top && top.length) info = { tag: top[0].name, tags: new Set(allElements(d).map(k => k.name)) }; } catch { } }
      hosts.set(tag, info);
    }
    return hosts.get(tag);
  };
  // Whether component `tag` includes `target`, directly or through other components.
  const reaches = (tag, target) => {
    const seen = new Set(), stack = [tag];
    while (stack.length) {
      const t = stack.pop();
      if (t === target) return true;
      if (seen.has(t)) continue; seen.add(t);
      const h = hostOf(t); if (h) h.tags.forEach(x => { if (/^x-/.test(x) && !seen.has(x)) stack.push(x); });
    }
    return false;
  };
  const ownComponent = /^components\//.test(relKey(relative(root, file))) || basename(file) !== 'index.html' ? 'x-' + basename(file, '.html') : null;
  const regions = new Map();
  const region = (name) => {
    if (!regions.has(name)) { const node = locateEditEl(html, name, doc); regions.set(name, node ? indexRegion(html, name, node) : null); }
    return regions.get(name);
  };
  const removed = new Set(patches.flatMap(p => p.removed || []));
  const placed = new Map(), rebuilt = new Set(), renderedUnder = new Map();
  // `kids` (the node's listed children) lets a container whose text changed (its children
  // reordered elsewhere) be found by path: its listed children must all sit in it.
  // A node the page sent with a fingerprint must still match it in the source.
  const resolve = (t) => {
    const { key: k, at, children: kids, fp } = t || {};
    const m = /^(?:~([a-z0-9]+)~)?@([^@]*)@([\s\S]*)$/.exec(String(k || ''));
    if (!m) fail(`not a source element: ${k}`);
    const reg = region(decodeURIComponent(m[2]));
    if (!reg) { const w = foreign(decodeURIComponent(m[2])); if (w && w !== self) return Object.assign(w.resolve(t), { w }); }
    if (!reg) fail(`x-edit="${decodeURIComponent(m[2])}" not found in ${basename(file)}`);
    let node = reg.byKey.get('@' + m[2] + '@' + m[3]);
    // The path is a fallback only when tag and text agree, i.e. just the ordinal differs.
    if (!node && at != null) {
      const p = reg.byPath.get(String(at));
      if (p && p.base === m[3].replace(/#\d+$/, '')) node = p;
      else if (p && p.name.toUpperCase() === m[3].split(':')[0] && Array.isArray(kids) && kids.some(c => !/^~/.test(c.key))
        && kids.every(c => { if (/^~/.test(c.key)) return true; try { return resolve(c).node.parent === p; } catch { return false; } })) node = p;
    }
    if (!node) fail(`element '${m[3]}' not found in x-edit="${reg.name}": it changed or was removed since this page loaded; reload to continue`);
    // Required on source elements; a copy names one only when its source has one.
    if (typeof fp !== 'string' && !m[1] && node !== reg.root) fail(`'${m[3]}' came without the fingerprint it loaded with; reload to continue`);
    if (typeof fp === 'string' && node !== reg.root && fp !== node.fp) {
      if (fp.includes('.') || String(node.fp).includes('.')) fail(`identical elements '${m[3].replace(/#\d+$/, '')}' were reordered or changed since this page loaded; reload to continue`);
      fail(`'${m[3]}' changed or moved since this page loaded; reload to continue`);
    }
    return { node, copy: !!m[1] };
  };
  const indentOf = (n) => { const nl = html.lastIndexOf('\n', n.tagStart); const pre = html.slice(nl + 1, n.tagStart); return /^[ \t]*$/.test(pre) ? pre : ''; };
  const EOL = html.includes('\r\n') ? '\r\n' : '\n';
  // The separator a gap ends with: its last line break and indent (no blank lines, no comments).
  const trailingWs = (s) => { const t = s.replace(/<!--[\s\S]*?-->/g, ''); return (/\r?\n[ \t]*$/.exec(t) || /[ \t]*$/.exec(t))[0]; };
  const fragSkeleton = (frag) => { const d = parseHTML(frag); return kidsOf(frag, d).map(k => skeletonOf(frag, k)).join(','); };
  // Returns [markup, skeleton].
  // `anc`: tag names of the node's final ancestors, nearest first (the node itself excluded).
  function renderAt(node, n, copy, inRebuilt, anc) {
    let open = node.implied ? `<${node.name}>` : openOf(html, node);
    const e = n.edits || {};
    let attrsEdited = false;
    for (const [prop, v] of Object.entries(e)) {
      if (prop === 'text') continue;
      const val = (prop === 'class' || prop === 'style') && (v === '' || v == null) ? null : v === false ? null : v === true ? '' : v;
      const why = attrRefusal(prop, val, node.name);
      if (why) fail(`${prop} on ${node.name}: ${why}`);
      const cur = ((scanTag(open) || { attrs: [] }).attrs.find(a => a.lower === String(prop).toLowerCase()) || {}).value;
      if (cur && /\$modify\(/.test(cur)) fail(`${prop} on ${node.name} is set by a component prop ($modify); edit it where the component is used`);
      open = setAttr(open, prop, val == null ? null : String(val));
      attrsEdited = true;
    }
    if (node.implied && !attrsEdited) open = '';
    if (node.void) return [node.implied && !attrsEdited ? html.slice(node.tagStart, node.closeEnd) : open, node.name + '()'];
    let inner, sk;
    if ('text' in e) {
      if (RAW_EDIT.has(node.name)) fail(`text edits are refused on <${node.name}>`);
      inner = sanitizeHTML(e.text); sk = fragSkeleton(inner);
      const chain = [node.name, ...(anc || [])];
      for (let p = node.parent; !anc && p && p.name; p = p.parent) chain.push(p.name);
      const nested = allElements(parseHTML(inner)).find(k => CONTENT_RULES.interactive.includes(k.name) && (chain.includes('a') || chain.includes('button') || ancestorsOf(k).some(t => CONTENT_RULES.interactive.includes(t))));
      if (nested) fail(`text in <${node.name}>: <${nested.name}> is interactive content and cannot go inside a link or button`);
    } else if (Array.isArray(n.children)) [inner, sk] = n.path && !copy
      ? renderPathInner(node, n.children, [node.name, ...(anc || [])])
      : rebuildInner(node, n.children, copy, [node.name, ...(anc || [])], n.base);
    else { inner = html.slice(node.innerStart, node.innerEnd); sk = kidsOf(html, node).map(k => skeletonOf(html, k)).join(','); }
    let close = html.slice(node.innerEnd, node.closeEnd);
    if ((node.implied && attrsEdited) || (node.impliedEnd && inRebuilt && !node.implied)) close = `</${node.name}>`;
    return [open + inner + close, node.name + '(' + (node.name === 'template' ? '' : sk) + ')'];
  }
  function renderNode(n, parentRebuilt, anc) {
    if (!n || typeof n !== 'object') fail('malformed tree');
    const { node, copy, w } = resolve(n);
    if (w) { const was = current; try { return w.renderNode(n, parentRebuilt, anc, regionOfKey(n.key)); } finally { current = was; } }
    return renderHere(n, parentRebuilt, anc, node, copy);
  }
  function renderHere(n, parentRebuilt, anc, node, copy) {
    if (copy && [...regions.values()].some(r => r && r.root === node)) fail(`an area cannot be copied: ${n.key}`);
    if (!copy) {
      if (placed.has(node)) fail(`'${n.key}' placed twice`);
      if (removed.has(node.key)) fail(`'${n.key}' is both placed and removed`);
      placed.set(node, Array.isArray(n.children) ? (n.path ? 'path' : 'rebuilt') : 'kept');
    }
    const [markup, sk] = renderAt(node, n, copy, parentRebuilt, anc);
    return [(copy ? '' : html.slice(node.lead ?? node.tagStart, node.tagStart)) + markup, sk];
  }
  // Source ancestors of a node (for content-model checks on what moves in).
  // Tag names in a node's final subtree: listed children as placed, otherwise its source
  // subtree (template contents included — an x-if can render them here); text edits by
  // what they parse to.
  function finalSubtree(n, out = new Set()) {
    const { node } = resolve(n);
    const add = (name) => { out.add(name); const h = hostOf(name); if (h) h.tags.forEach(t => out.add(t)); };
    add(node.name);
    if (n.edits && 'text' in n.edits) { const f = sanitizeHTML(n.edits.text); allElements(parseHTML(f)).forEach(k => out.add(k.name)); }
    else if (Array.isArray(n.children)) n.children.forEach(c => finalSubtree(c, out));
    else allElements(node).forEach(k => add(k.name));
    return out;
  }
  // A container listed only as a path to edits: its current children, in the source's
  // current order; listed ones render with their edits, the rest stay as written.
  function renderPathInner(node, listed, anc) {
    const kids = node.kids || kidsOf(html, node);
    const want = new Map();
    for (const c of listed) {
      const { node: k, copy } = resolve(c);
      if (copy || k.parent !== node) fail(`'${c.key}' is no longer in its <${node.name}> (the source changed since this page loaded); reload to continue`);
      want.set(k, c);
    }
    let out = '', prev = node.innerStart;
    const sk = [];
    for (const k of kids) {
      const c = want.get(k);
      if (!c) { sk.push(skeletonOf(html, k)); continue; }
      out += html.slice(prev, k.lead ?? k.tagStart);
      renderedUnder.set(k, node);
      const [m, s2] = renderNode(c, false, anc);
      out += m; sk.push(s2); prev = k.closeEnd;
    }
    return [out + html.slice(prev, node.innerEnd), sk.join(',')];
  }
  function rebuildInner(node, children, copy, anc, base) {
    if (!copy) rebuilt.add(node);
    const kids = node.kids || kidsOf(html, node);
    // A restructured container must still hold what the page loaded with.
    if (Array.isArray(base) && !copy) {
      const changed = () => fail(`<${node.name}> ${node.key ? `'${node.key}' ` : ''}changed since this page loaded; reload to continue`);
      const current = kids.filter(k => k.name !== 'template');
      if (base.length !== current.length) changed();
      base.forEach((b, i) => { let r; try { r = resolve(b); } catch (e) { if (/reordered or changed/.test(e.message)) throw e; changed(); } if (r.node !== current[i]) changed(); });
    }
    for (const c of children) {
      const { node: child } = resolve(c);
      if (child.parent === node && !/^~/.test(c.key)) continue;    // authored placement is left as written
      const sub = finalSubtree(c);
      const loop = ownComponent && [...sub].find(t => reaches(t, ownComponent));
      if (loop) fail(loop === ownComponent ? `<${ownComponent}> cannot go into its own component file` : `<${loop}> cannot go into ${basename(file)}: it includes <${ownComponent}>, which would then include itself`);
      const h = hostOf(child.name);
      const why = contentRefusal(h ? h.tag : child.name, node.name, anc, sub);
      if (why) fail(`<${child.name}> cannot go into <${node.name}>: ${why}`);
    }
    children.forEach(c => { const r = resolve(c); if (!r.copy) (r.w ? r.w.renderedUnder : renderedUnder).set(r.node, node); });
    const rendered = children.map(c => renderNode(c, true, anc));
    const sk = rendered.map(r => r[1]).join(',');
    const gaps = []; let prev = node.innerStart;
    for (const k of kids) { const start = k.lead ?? k.tagStart; gaps.push(html.slice(prev, start)); prev = k.closeEnd; }
    gaps.push(html.slice(prev, node.innerEnd));
    if (!kids.length) {
      if (!rendered.length) return [gaps[0], sk];
      const ind = indentOf(node);
      return [rendered.map(r => EOL + ind + '    ' + r[0]).join('') + EOL + ind, sk];
    }
    if (!rendered.length) return [trailingWs(gaps[kids.length]) || '', sk];
    const extra = trailingWs(kids.length > 1 ? gaps[kids.length - 1] : gaps[0]);
    let out = gaps[0];
    rendered.forEach((r, i) => { if (i > 0) out += i < kids.length ? gaps[i] : extra; out += r[0]; });
    return [out + gaps[kids.length], sk];
  }

  const out = [];
  self.resolve = resolve;
  self.renderedUnder = renderedUnder;
  // An element of this file placed by another file's tree.
  self.renderNode = (n, parentRebuilt, anc, region) => { current = region; const r = resolve(n); return renderHere(n, parentRebuilt, anc, r.node, r.copy); };
  self.render = () => {
    for (const p of patches) {
      current = p.region;
      const reg = region(p.region);
      if (!reg) fail(`x-edit="${p.region}" not found in ${basename(file)}`);
      const t = p.tree || {};
      if (!t.edits && !Array.isArray(t.children)) continue;
      placed.set(reg.root, Array.isArray(t.children) ? (t.path ? 'path' : 'rebuilt') : 'kept');
      const rootAnc = []; for (let a = reg.root.parent; a && a !== doc; a = a.parent) rootAnc.push(a.name);
      const [markup, sk] = renderAt(reg.root, t, false, false, rootAnc);
      out.push({ reg, text: markup, sk });
    }
  };
  self.check = () => {
    for (const r of rebuilt) for (const k of r.kids || []) if (!placed.has(k) && !removed.has(k.key)) fail(`'${k.key}' would be lost (not placed, not removed)`, regionOfKey(k.key));
    const roots = new Set([...regions.values()].filter(Boolean).map(r => r.root));
    // Every placed element's source ancestors must be rebuilt (or removed), up to its area.
    for (const [node] of placed) {
      if (roots.has(node) || renderedUnder.get(node) === node.parent) continue;   // in place: its parent is checked in turn
      for (let a = node.parent; a; a = a.parent) {
        // Its source parent must be rebuilt; higher up, a path (rendered from the tree) is fine too.
        const how = placed.get(a);
        if (how === 'rebuilt' || (how === 'path' && a !== node.parent)) { if (roots.has(a)) break; continue; }
        if (how) fail(`'${node.key}' would appear twice: its source container is kept as is`, regionOfKey(node.key));
        if (removed.has(a.key)) break;
        if (roots.has(a) || !a.parent || a.parent === doc) fail(`'${node.key}' moved, but its source area is not rebuilt`, regionOfKey(node.key));
      }
    }
    // A removal needs its container rebuilt (or an ancestor removed), or it stays in the file.
    for (const k of removed) {
      const m = /^@([^@]*)@/.exec(k); if (!m) fail(`not a source element: ${k}`, null);
      current = decodeURIComponent(m[1]);
      const reg = region(current); const node = reg && reg.byKey.get(k);
      if (!node) fail(`removed element '${k}' not found`);
      let ok = placed.get(node.parent) === 'rebuilt';
      for (let a = node.parent; !ok && a && !roots.has(a); a = a.parent) if (removed.has(a.key)) ok = true;
      if (!ok) fail(`'${k}' removed, but its container is kept as is`);
    }
  };
  // The written file must parse into exactly the structure that was rendered.
  self.assemble = () => {
    let next = html;
    out.slice().sort((a, b) => b.reg.root.tagStart - a.reg.root.tagStart).forEach(({ reg, text }) => { next = next.slice(0, reg.root.tagStart) + text + next.slice(reg.root.closeEnd); });
    if (next === html) return { next: null };
    const after = parseHTML(next);
    for (const { reg, sk } of out) {
      const node = locateEditEl(next, reg.name, after);
      const got = node && skeletonOf(next, node), want = sk;
      if (got !== want) return { error: `x-edit="${reg.name}" would not parse as rebuilt (${skeletonDiff(want, got)}); nothing written` };
    }
    return { next };
  };
  return self;
}
// Component files: the first top-level element, then paths through element children.
function navigateToNode(html, path) {
  const doc = parseHTML(html);
  let node = kidsOf(html, doc)[0]; if (!node) return null;
  if (!path) return node;
  for (const i of path.split('.').map(Number)) { node = kidsOf(html, node)[i]; if (!node) return null; }
  return node;
}
// A project-relative path from manifest.json ("components/x.html", "/data/a.csv").
const resolveRel = (rel) => safeResolve('/' + String(rel).replace(/^\/+/, ''));
// A component the project declares: a manifest.json entry (matched by file name, as the
// client names components by tag), or the convention components/<name>.html.
const COMPONENT_NAME = /^[\w-]+(\/[\w-]+)*$/;
function resolveComponentFile(manifest, name) {
  if (typeof name !== 'string' || !COMPONENT_NAME.test(name)) return null;
  const all = [...(manifest.preloadedComponents || []), ...(manifest.components || [])];
  const listed = all.find(p => String(p).split('/').pop().replace('.html', '') === name.split('/').pop());
  if (listed) { const rel = String(listed).replace(/^\/+/, ''); return /(^|\/)\.\.?(\/|$)/.test(rel) ? null : rel; }
  // Convention component: components/<name>.html needs no manifest entry.
  const rel = 'components/' + name + '.html';
  const file = safeResolve('/' + rel);
  return file && isFile(file) ? rel : null;
}

// Theme var write: rewrite (or append) a single `--var: value;` in the target CSS file.
// Global vars go to the theme stylesheet the page links (else the default path);
// a patch may name another stylesheet the page links. Surgical — rewrites the existing declaration in place, else
// appends into the first :root{} block, else creates one.
const DEFAULT_THEME_FILE = 'styles/core/manifest.theme.css';
// A custom-property value must stay inside its declaration. A small tokenizer: strings
// and url(...) are opaque, so ; { } and comment openers are refused only outside them.
// Script schemes in url() and expression() are refused anywhere; data: urls only as images.
function themeValueRefusal(v) {
  const s = String(v == null ? '' : v);
  if (!s.trim()) return 'empty';
  if (/expression\s*\(/i.test(s)) return 'expression()';
  if (/`|\$\(/.test(s)) return 'contains ` or $(';
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      for (; j < s.length && s[j] !== ch; j++) { if (s[j] === '\\') j++; else if (s[j] === '\n') return 'unbalanced quotes'; }
      if (j >= s.length) return 'unbalanced quotes';
      i = j; continue;
    }
    if (/^url\(/i.test(s.slice(i, i + 4)) && !/[\w-]/.test(s[i - 1] || '')) {
      let j = i + 4, q = null, body = '';
      for (; j < s.length; j++) {
        const c = s[j];
        if (q) { if (c === '\\') { body += s[++j] || ''; continue; } if (c === q) { q = null; continue; } body += c; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === ')') break;
        body += c;
      }
      if (j >= s.length) return 'unterminated url()';
      const u = body.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
      if (/^(javascript|vbscript):/.test(u)) return 'script URL';
      if (u.startsWith('data:') && !u.startsWith('data:image/')) return 'data URL';
      i = j; continue;
    }
    if (ch === ';' || ch === '{' || ch === '}') return `contains ${ch}`;
    if (s.startsWith('/*', i) || s.startsWith('<!--', i) || s.startsWith('</', i)) return 'contains a comment or markup';
    if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch === ')' || ch === ']') { if (stack.pop() !== (ch === ')' ? '(' : '[')) return 'unbalanced brackets'; }
  }
  return stack.length ? 'unbalanced brackets' : null;
}
// Stylesheets a theme edit may write: the default theme file and stylesheets index.html links.
// The theme stylesheet index.html links (manifest.theme.css, wherever it lives), else the framework's default path.
function defaultThemeFile() {
  let html = '';
  try { html = readFileSync(join(root, 'index.html'), 'utf8'); } catch { return DEFAULT_THEME_FILE; }
  for (const n of allElements(parseHTML(html))) {
    if (n.implied || n.name !== 'link') continue;
    const open = openOf(html, n), href = String(attrOf(open, 'href') || '').trim().split(/[?#]/)[0];
    if (!/(^|\s)stylesheet(\s|$)/i.test(attrOf(open, 'rel') || '') || /^[a-z][\w+.-]*:|^\/\//i.test(href)) continue;
    if (basename(href) === 'manifest.theme.css') { const rel = posix.normalize(href.replace(/^\/+/, '')); if (!rel.startsWith('..')) return rel; }
  }
  return DEFAULT_THEME_FILE;
}
function themeTargets() {
  const out = new Set([DEFAULT_THEME_FILE, defaultThemeFile()]);
  let html = '';
  try { html = readFileSync(join(root, 'index.html'), 'utf8'); } catch { return out; }   // read off-batch: not a base-checked input
  const add = (href) => {
    const h = String(href || '').trim().split(/[?#]/)[0];
    if (!h || /^[a-z][\w+.-]*:|^\/\//i.test(h)) return;   // other origins and schemes
    const rel = posix.normalize(h.replace(/^\/+/, ''));
    if (!rel.startsWith('..')) out.add(rel);
  };
  for (const n of allElements(parseHTML(html))) {
    if (n.implied) continue;
    const open = openOf(html, n);
    if (n.name === 'link' && /(^|\s)stylesheet(\s|$)/i.test(attrOf(open, 'rel') || '')) add(attrOf(open, 'href'));
  }
  return out;
}
// Why a scoped theme value is not written to a stylesheet, for the case at hand
function scopedThemeRefusal(p) {
  const what = `scoped value ${p.scope}:${p.var}`;
  for (const rel of Object.keys(baseHashes()).filter(f => /\.html?$/i.test(f))) {
    const file = safeResolve('/' + rel); if (!file) continue;
    let html = ''; try { html = readFileSync(file, 'utf8'); } catch { continue; }
    if (locateEditEl(html, p.scope)) return `${what} applies on its scope element (x-edit="${p.scope}" in ${rel}): it is written there as an inline style edit, not to a stylesheet, which would apply it site-wide`;
  }
  return `${what}: no source file mnfst-run can write holds x-edit="${p.scope}" (generated content, or not on any page), and a stylesheet would apply it site-wide`;
}
function writeThemeVar(p) {
  if (!/^--[\w-]+$/.test(p.var || '')) return { region: p.var, status: 'error', reason: 'bad var name' };
  // A scoped value applies on its scope element: the page writes it there (its inline style).
  // One sent here has no element mnfst-run can address; a stylesheet would apply it site-wide.
  if (p.scope) return { region: `${p.scope}:${p.var}`, status: 'error', reason: scopedThemeRefusal(p) };
  const rel = posix.normalize(String(p.file || defaultThemeFile()).replace(/^\/+/, ''));
  if (!themeTargets().has(rel)) return { region: p.var, status: 'error', reason: `${rel} is not a stylesheet this page links` };
  const file = safeResolve('/' + rel);
  if (!file) return { region: p.var, status: 'error', reason: `path outside root: ${rel}` };
  const refused = writeRefusal(file, 'css'); if (refused) return { region: p.var, status: 'error', reason: `refused: ${refused}` };
  const why = themeValueRefusal(p.value);
  if (why) return { region: p.var, status: 'error', reason: `value refused (${why})` };
  const value = String(p.value).trim();
  let css = vexists(file) ? vread(file) : '';
  const decl = `${p.var}: ${value};`;
  const head = new RegExp(`(^|[\\s;{])${escapeReg(p.var)}\\s*:`).exec(css);
  if (head) {
    // The declaration ends at the first ; or } outside strings and url(), as CSS reads it.
    const from = head.index + head[0].length;
    let i = from;
    for (; i < css.length; i++) {
      const ch = css[i];
      if (ch === '"' || ch === "'") { for (i++; i < css.length && css[i] !== ch; i++) if (css[i] === '\\') i++; continue; }
      if (/^url\(/i.test(css.slice(i, i + 4))) { const e = css.indexOf(')', i); i = e < 0 ? css.length : e; continue; }
      if (ch === ';' || ch === '}') break;
    }
    css = css.slice(0, from) + ' ' + value + (css[i] === ';' ? '' : ';') + css.slice(i);
  } else if (/:root\s*[^{]*\{/.test(css)) css = css.replace(/(:root\s*[^{]*\{)/, (m) => `${m}\n    ${decl}`);
  else css = `:root {\n    ${decl}\n}\n${css}`;
  vwrite(file, css);
  return { region: `${p.scope ? p.scope + ':' : ''}${p.var}`, status: 'written', file: rel };
}
const modParamIn = (openTag, attr) => { const v = attrOf(openTag, attr); const mm = v && v.match(/\$modify\(['"]([\w-]+)['"]\)/); return mm ? mm[1] : null; };
// A value placed inside a single-quoted JS string in an Alpine expression.
const jsStr = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n').replace(/\u2028|\u2029/g, '');
const allModifyParams = (html) => { const s = new Set(); let m; const re = /\$modify\(['"]([\w-]+)['"]\)/g; while ((m = re.exec(html))) s.add(m[1]); return [...s]; };
const classOf = (openTag) => attrOf(openTag, 'class') || '';

// Component edits, per node (structural path), per prop (text|class), routed by scope.
//   main     → edit the component source literal/class (affects every instance)
//   instance → set the $modify instance attr; AUTO-PROMOTE a plain node first
//              (text → x-text="$modify('p_…') ?? 'orig'"; class → :class="$modify('c_…') ?? 'orig'")
//   reverts  → remove the instance's $modify attrs so it falls back to the component default
function writeComponentEdits(p, manifest) {
  const compRel = resolveComponentFile(manifest, p.component);
  if (!compRel) return { region: p.region, status: 'error', reason: `component '${p.component}' not registered` };
  const compFile = resolveRel(compRel);
  if (!compFile || !isFile(compFile)) return { region: p.region, status: 'error', reason: `component file not found: ${compRel}` };
  const refused = writeRefusal(compFile, 'html'); if (refused) return { region: p.region, status: 'error', reason: `refused: ${refused}` };
  const indexFile = join(root, 'index.html'), instanceAttrs = {}, removeNames = new Set(), applied = [];
  for (const ed of (p.edits || [])) {
    const prop = ed.prop || 'text';
    let html = vread(compFile);
    const node = navigateToNode(html, ed.path);
    if (!node) { applied.push({ path: ed.path, status: 'not-found' }); continue; }
    let openTag = html.slice(node.tagStart, node.openEnd + 1);
    const seg = ed.path === '' ? 'root' : ed.path.replace(/\./g, '_');

    if (prop === 'style') {
      if (p.scope !== 'main') { applied.push({ path: ed.path, prop, status: 'error', reason: 'instance styles are not written (only the component\'s own, in main scope)' }); continue; }
      const why = attrRefusal('style', ed.value, node.tag);
      if (why) { applied.push({ path: ed.path, prop, status: 'error', reason: why }); continue; }
      vwrite(compFile, html.slice(0, node.tagStart) + setAttr(openTag, 'style', ed.value ? String(ed.value) : null) + html.slice(node.openEnd + 1));
      applied.push({ path: ed.path, prop, status: 'main' });
      continue;
    }
    if (prop === 'class') {
      const param = modParamIn(openTag, ':class');
      if (p.scope === 'main') { vwrite(compFile, html.slice(0, node.tagStart) + setAttr(openTag, 'class', ed.value ? String(ed.value) : null) + html.slice(node.openEnd + 1)); applied.push({ path: ed.path, prop, status: 'main' }); }
      else if (param) { instanceAttrs[param] = ed.value; applied.push({ path: ed.path, prop, status: 'instance', param }); }
      else { const name = 'c_' + seg; vwrite(compFile, html.slice(0, node.tagStart) + setAttr(openTag, ':class', `$modify('${name}') ?? '${jsStr(classOf(openTag))}'`) + html.slice(node.openEnd + 1)); instanceAttrs[name] = ed.value; applied.push({ path: ed.path, prop, status: 'promoted', param: name }); }
      continue;
    }

    // text — value is innerHTML, sanitized like the client's; bound via x-html when it has markup.
    const value = sanitizeHTML(ed.value);
    const hasMarkup = /<[a-z!\/][\s\S]*>/i.test(value);
    const param = modParamIn(openTag, 'x-html') || modParamIn(openTag, 'x-text');
    if (p.scope === 'main') {
      if (param) {
        const bound = attrOf(openTag, 'x-html') != null && modParamIn(openTag, 'x-html') ? 'x-html' : 'x-text';
        const expr = attrOf(openTag, bound).replace(/((?:\?\?|\|\|)\s*)(['"])(?:\\.|(?!\2)[^\\])*\2/, (_, op) => `${op}'${jsStr(value)}'`);
        vwrite(compFile, html.slice(0, node.tagStart) + setAttr(openTag, bound, expr) + html.slice(node.openEnd + 1));
      } else vwrite(compFile, html.slice(0, node.innerStart) + value + html.slice(node.innerEnd));
      applied.push({ path: ed.path, prop, status: 'main' });
    } else if (param) {
      if (hasMarkup && attrOf(openTag, 'x-text') != null && attrOf(openTag, 'x-html') == null) { vwrite(compFile, html.slice(0, node.tagStart) + setAttr(setAttr(openTag, 'x-text', null), 'x-html', attrOf(openTag, 'x-text')) + html.slice(node.openEnd + 1)); }
      instanceAttrs[param] = value; applied.push({ path: ed.path, prop, status: 'instance', param });
    } else {                                        // PROMOTE: x-html if rich, else x-text
      const name = 'p_' + seg, bind = hasMarkup ? 'x-html' : 'x-text';
      const orig = jsStr(html.slice(node.innerStart, node.innerEnd).trim());
      vwrite(compFile, html.slice(0, node.tagStart) + setAttr(openTag, bind, `$modify('${name}') ?? '${orig}'`) + html.slice(node.openEnd + 1));
      instanceAttrs[name] = value; applied.push({ path: ed.path, prop, status: 'promoted', param: name, bind });
    }
  }
  if (p.scope === 'instance' && (p.reverts || []).length) {
    const html = vread(compFile);
    for (const rp of p.reverts) {
      if (rp === '*') { allModifyParams(html).forEach(n => removeNames.add(n)); applied.push({ path: '*', status: 'revert-all' }); continue; }
      const node = navigateToNode(html, rp); if (!node) continue;
      const openTag = html.slice(node.tagStart, node.openEnd + 1);
      [modParamIn(openTag, 'x-text'), modParamIn(openTag, 'x-html'), modParamIn(openTag, ':class')].forEach(n => { if (n) removeNames.add(n); });
      applied.push({ path: rp, status: 'reverted' });
    }
  }
  const inst = (Object.keys(instanceAttrs).length || removeNames.size) ? writeComponentInstance(indexFile, p.region, instanceAttrs, [...removeNames]) : null;
  const failed = applied.find(x => x.status === 'error' || x.status === 'not-found') || (inst && inst.status === 'error' && inst);
  if (failed) return { region: p.region, status: 'error', reason: failed.reason || `node ${failed.path} not found`, applied };
  return { region: p.region, status: 'written', scope: p.scope, file: basename(compFile), applied, instance: inst && inst.status };
}
function writeComponentInstance(file, key, overrides, removals) {
  const refused = writeRefusal(file, 'html'); if (refused) return { region: key, status: 'error', reason: `refused: ${refused}` };
  let html = vread(file);
  const loc = locateEditEl(html, key);
  if (!loc) return { region: key, status: 'error', reason: `x-edit="${key}" not found in ${basename(file)}` };
  const cm = allElements(loc).find(n => /^x-/.test(n.name) && !n.implied);   // first component instance in the region
  if (!cm) return { region: key, status: 'error', reason: 'no <x-*> instance in region' };
  const instStart = cm.tagStart, instEnd = cm.openEnd;
  let openTag = html.slice(instStart, instEnd + 1);
  for (const [k, v] of Object.entries(overrides || {})) { if (attrRefusal(k, null, 'x')) continue; openTag = setAttr(openTag, k, v == null ? null : String(v)); }
  for (const name of (removals || [])) openTag = removeAttr(openTag, name);
  html = html.slice(0, instStart) + openTag + html.slice(instEnd + 1);
  vwrite(file, html);
  return { region: key, status: 'written', file: basename(file), applied: Object.keys(overrides || {}), removed: removals || [] };
}

// No-op service worker served at /sw.js when the project has none: a stale
// production worker (cached shell from a previous deploy) can never hold a
// dev session. It replaces that worker at the next update check, clears the
// framework's caches and unregisters itself.
const NOOP_SW = `// mnfst-run: no-op service worker (unregisters itself, clears Manifest caches)
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    try { var keys = await caches.keys(); await Promise.all(keys.filter(function (k) { return k.indexOf('mnfst-sw:') === 0; }).map(function (k) { return caches.delete(k); })); } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
  })());
});
`;

// Resolve a request path against `root` and refuse anything that escapes.
// `path.join` does NOT prevent `..` traversal — `join('/a/b', '/../../etc/passwd')`
// returns `/etc/passwd`. Use `path.resolve` + an explicit prefix check.
// Returns the absolute path on success, or null if the request would escape root
// (or contains a NUL byte).
function safeResolve(urlPath) {
  if (urlPath.includes('\0')) return null;
  const candidate = resolve(root, '.' + urlPath);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function serveFile(res, filePath) {
  const ext  = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  let body   = readFileSync(filePath);
  if (ext === '.html') {
    const html = body.toString('utf8');
    // Only inject into full HTML documents — not component fragments
    const isFullDoc = /<!doctype\s/i.test(html) || /<html[\s>]/i.test(html);
    if (isFullDoc) {
      // 1) Inject window.env into <head> (when public env vars exist) so the
      //    framework's manifest.json env-var substitution can resolve
      //    `${VAR}` placeholders before any plugin reads the manifest.
      //    Must come BEFORE framework scripts execute — <head> insertion
      //    guarantees that ordering regardless of where script tags sit.
      //    ONLY PUBLIC_-prefixed vars are eligible; see loadEnvFile().
      let injected = html;
      if (envInjectScript) {
        injected = injected.includes('</head>')
          ? injected.replace('</head>', envInjectScript + '</head>')
          : envInjectScript + injected;
      }
      // 2) Inject the live-reload script before </body> (or at end).
      injected = injected.includes('</body>')
        ? injected.replace('</body>', LIVE_RELOAD_SCRIPT + '</body>')
        : injected + LIVE_RELOAD_SCRIPT;
      body = Buffer.from(injected, 'utf8');
    }
  }
  res.writeHead(200, { 'Content-Type': mime });
  res.end(body);
}

// DNS-rebinding defence. Even though the server binds 127.0.0.1, a malicious
// public page (attacker.com) can perform DNS rebinding: initial resolution
// returns the attacker's IP so the dev visits it, then DNS is flipped to
// 127.0.0.1 so subsequent fetches reach mnfst-run while the browser still
// treats the page origin as attacker.com (giving attacker JS read access).
// The browser sends `Host: attacker.com` after the rebind — so reject any
// request whose Host header isn't a known-local form on our listening port.
function isLocalHostHeader(host, port) {
  if (!host || typeof host !== 'string') return false;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  return allowed.has(host.toLowerCase());
}

// Stricter check used by state-changing endpoints (close beacon). Same
// allowlist applied to the Origin header.
function isLocalOrigin(origin, port) {
  if (!origin || typeof origin !== 'string') return false;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  return allowed.has(origin.toLowerCase());
}

// --- HTTP server ---
// --- Appwrite dev proxy (see APPWRITE_PROXY_TARGET above) ---

// Rewrite upstream Set-Cookie so the session cookie is storable + sent on
// http://localhost: drop Domain (defaults to our host), drop Secure (we're http),
// and downgrade SameSite=None → Lax (None requires Secure, which we just removed).
function rewriteAppwriteSetCookie(values) {
  return (Array.isArray(values) ? values : [values]).map(v => v
    .replace(/;\s*Domain=[^;]*/ig, '')
    .replace(/;\s*Secure\b/ig, '')
    .replace(/;\s*SameSite=None/ig, '; SameSite=Lax'));
}

// /_appwrite/v1/account?x → /v1/account?x  (strip our prefix, keep path + query)
function appwriteUpstreamPath(reqUrl, urlPath) {
  const search = reqUrl.includes('?') ? reqUrl.slice(reqUrl.indexOf('?')) : '';
  return urlPath.slice(APPWRITE_PROXY_PREFIX.length) + search;
}

function proxyAppwriteHttp(req, res, urlPath) {
  let u;
  try { u = new URL(APPWRITE_PROXY_TARGET); } catch { res.writeHead(502); res.end('bad APPWRITE_PROXY_TARGET'); return; }
  const headers = { ...req.headers, host: u.host };
  delete headers.connection;
  // Force cookie-only auth. Appwrite emits X-Fallback-Cookies (because the
  // forwarded Origin looks cross-origin) and the SDK then replays it on every
  // request — but the Presences endpoint REJECTS any request carrying the
  // fallback, even with a valid session cookie present. Strip it both ways so
  // the real first-party cookie (which the proxy makes same-origin) is used.
  delete headers['x-fallback-cookies'];
  const transport = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = transport({
    protocol: u.protocol, hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    method: req.method, path: appwriteUpstreamPath(req.url, urlPath), headers,
  }, (up) => {
    const outHeaders = { ...up.headers };
    delete outHeaders.connection; delete outHeaders['transfer-encoding'];
    delete outHeaders['x-fallback-cookies']; // keep the SDK out of localStorage-fallback mode
    if (up.headers['set-cookie']) outHeaders['set-cookie'] = rewriteAppwriteSetCookie(up.headers['set-cookie']);
    res.writeHead(up.statusCode || 502, outHeaders);
    up.pipe(res);
  });
  upstream.on('error', (e) => { try { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('appwrite proxy error: ' + e.message); } catch { /* client gone */ } });
  req.pipe(upstream);
}

// Raw WebSocket tunnel for Appwrite Realtime (wss). Replays the HTTP upgrade over
// a TLS socket to the upstream and pipes both ways; the browser's first-party
// localhost cookie rides the upgrade headers, so realtime auth works too.
function proxyAppwriteWs(req, socket, head, urlPath) {
  let u;
  try { u = new URL(APPWRITE_PROXY_TARGET); } catch { socket.destroy(); return; }
  const upstream = tlsConnect({ host: u.hostname, port: u.port || 443, servername: u.hostname }, () => {
    const headers = { ...req.headers, host: u.host };
    delete headers['x-fallback-cookies']; // cookie-only auth (see HTTP proxy)
    let handshake = `${req.method} ${appwriteUpstreamPath(req.url, urlPath)} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) {
      (Array.isArray(v) ? v : [v]).forEach(val => { handshake += `${k}: ${val}\r\n`; });
    }
    handshake += '\r\n';
    upstream.write(handshake);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Reject any request whose Host header doesn't match our listening origin —
  // closes DNS-rebinding even though we're bound to loopback. server.address()
  // is the source of truth for the actual port (auto-port may have shifted).
  const listenPort = server.address()?.port;
  if (listenPort && !isLocalHostHeader(req.headers.host, listenPort)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden — invalid Host header');
    return;
  }

  // Appwrite dev proxy — forward to the configured Appwrite origin so the
  // session cookie is first-party (see APPWRITE_PROXY_TARGET).
  if (APPWRITE_PROXY_TARGET && urlPath.startsWith(APPWRITE_PROXY_PREFIX + '/')) {
    proxyAppwriteHttp(req, res, urlPath);
    return;
  }

  // Identity endpoint: lets `mnfst-run` (and `--list`) confirm that a server
  // on a registered port really is OUR server for the expected root, not
  // some unrelated process that happened to inherit a recycled PID/port.
  if (urlPath === IDENTITY_PATH) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ name: 'mnfst-run', root, pid: process.pid }));
    return;
  }

  // SSE endpoint for live reload
  if (urlPath === '/__mnfst_sse__') {
    const tabId = new URL(req.url, 'http://localhost').searchParams.get('tabId');
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(':\n\n'); // initial keep-alive comment
    clients.push({ res, tabId });
    if (tabId) {
      openTabs.add(tabId);
      const pending = staleTimers.get(tabId);
      if (pending) { clearTimeout(pending); staleTimers.delete(tabId); }
    }
    everConnected = true;
    cancelIdleShutdown();
    req.on('close', () => {
      clients = clients.filter(c => c.res !== res);
      // SSE socket is gone, but the tab itself might just be sleeping. Hold
      // its slot in openTabs until either the EventSource auto-reconnects
      // (carrying the same tabId), the tab beacons /__mnfst_close__, or the
      // orphan grace expires.
      if (tabId && openTabs.has(tabId) && !staleTimers.has(tabId)) {
        const t = setTimeout(() => {
          staleTimers.delete(tabId);
          openTabs.delete(tabId);
          if (openTabs.size === 0) armIdleShutdown();
        }, ORPHAN_GRACE_MS);
        staleTimers.set(tabId, t);
      }
    });
    return;
  }

  // Close beacon: fired by the injected script's pagehide handler when a tab
  // is actually being closed/navigated away from. This is the only signal
  // that drops a tab from openTabs in normal operation.
  // Locked to POST + same-origin: the live-reload script already POSTs (both
  // sendBeacon and the fetch fallback), so no DX cost; this closes the
  // CSRF-via-GET surface where a third-party page could fire <img src=...>
  // to nuke tabs (would still need an unguessable tabId, but defence in depth).
  if (urlPath === '/__mnfst_close__') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Allow': 'POST' });
      res.end();
      return;
    }
    if (listenPort && !isLocalOrigin(req.headers.origin, listenPort)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const tabId = new URL(req.url, 'http://localhost').searchParams.get('tabId');
    dropTab(tabId);
    res.writeHead(204);
    res.end();
    if (openTabs.size === 0) armIdleShutdown();
    return;
  }

  // Edit-plugin B-side write-back (SPIKE, dev-only). POST + same-origin. Currently
  // handles the `data` regime: reorder the source CSV/JSON for a registered data
  // source. static/component regimes are reported unsupported (need an HTML parser).
  // Turnkey AI relay — same-origin chat proxy; key held server-side, never in
  // the browser. Inert (404) unless manifest.json has an `ai` block. No key →
  // mock stream so keyless dev works; add ANTHROPIC_API_KEY to .env for real.
  if (urlPath === '/_ai/chat') {
    if (!aiConfig) { res.writeHead(404); res.end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { 'Allow': 'POST' }); res.end(); return; }
    if (listenPort && !isLocalOrigin(req.headers.origin, listenPort)) { res.writeHead(403); res.end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 25e6) req.destroy(); });   // 25MB cap (attachments)
    req.on('end', async () => {
      let payload = {}; try { payload = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400); res.end('bad json'); return; }
      try { if (aiKey) await streamRealAi(res, payload); else streamMockAi(res); }
      catch (e) { try { res.writeHead(500); res.end(String(e && e.message || e)); } catch (_) {} }
    });
    return;
  }

  if (urlPath === '/__edit/base') {
    if (!EDIT_ENABLED) { res.writeHead(404); res.end(); return; }
    if (listenPort && req.headers.origin && !isLocalOrigin(req.headers.origin, listenPort)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const files = baseHashes();
    res.end(JSON.stringify({ files, ids: allSourceIds(Object.keys(files)) }));
    return;
  }

  if (urlPath === '/__edit/save') {
    if (!EDIT_ENABLED) { res.writeHead(404); res.end(); return; }   // opt-in (--edit / MNFST_EDIT=1): source write-back is authoring-only
    if (req.method !== 'POST') { res.writeHead(405, { 'Allow': 'POST' }); res.end(); return; }
    if (listenPort && !isLocalOrigin(req.headers.origin, listenPort)) { res.writeHead(403); res.end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    const reply = (code, body) => { if (res.headersSent) { try { res.end(); } catch { } return; } res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    req.on('end', () => { try {
      let patches; try { patches = JSON.parse(raw); } catch { res.writeHead(400); res.end('bad json'); return; }
      // Body: an array of patches, or { patches, base } where base maps files to the hashes the page loaded with.
      let base = null;
      if (patches && !Array.isArray(patches) && Array.isArray(patches.patches)) { base = patches.base && typeof patches.base === 'object' ? patches.base : null; patches = patches.patches; }
      if (!Array.isArray(patches)) patches = [patches];
      let manifest = {}; try { manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')); } catch {}
      const indexFile = join(root, 'index.html');
      // All or nothing: every patch is prepared against an in-memory overlay; files are
      // written only if none of them failed.
      VFS = new Map(); READS = new Set();
      let results, written = null;
      try {
        // Static areas: index.html, or the component file a region is authored in.
        const trees = patches.filter(p => p && p.kind === 'static-tree');
        const treeResults = new Map(), byFile = new Map();
        for (const p of trees) {
          let file = indexFile;
          if (p.component != null) {
            const rel = resolveComponentFile(manifest, p.component);
            if (!rel) { treeResults.set(p, { region: p.region, status: 'error', reason: `component '${p.component}' not registered` }); continue; }
            file = resolveRel(rel);
            if (!file || !isFile(file)) { treeResults.set(p, { region: p.region, status: 'error', reason: `file not found: ${rel}` }); continue; }
          }
          if (!byFile.has(file)) byFile.set(file, []);
          byFile.get(file).push(p);
        }
        if (byFile.size) {
          try { writeStaticTrees([...byFile], manifest).forEach((r, p) => treeResults.set(p, r)); }
          catch (e) { [...byFile.values()].flat().forEach(p => treeResults.set(p, { region: p.region, status: 'error', reason: e.message })); }
        }
        results = patches.map(p => {
          if (p && p.kind === 'static-tree') return treeResults.get(p);
          try {
            if (!p || typeof p !== 'object') return { status: 'error', reason: 'malformed patch' };
            if (p.kind === 'data') {
              const src = (manifest.data || {})[p.source];
              const rel = typeof src === 'string' ? src : null;
              if (!rel) return { region: p.region, status: 'error', reason: dataSourceRefusal(p.source, manifest) };
              const file = resolveRel(rel);
              if (!file || !isFile(file)) return { region: p.region, status: 'error', reason: `file not found: ${rel}` };
              const refused = writeRefusal(file, 'data'); if (refused) return { region: p.region, status: 'error', reason: `refused: ${refused}` };
              return { region: p.region, status: reorderDataFile(file, p.order) ? 'written' : 'noop', file: rel };
            }
            if (p.kind === 'data-val') return writeDataValue(p, manifest);
            if (p.kind === 'component') return writeComponentEdits(p, manifest);
            if (p.kind === 'theme') return writeThemeVar(p);
            return { region: p.region, status: 'error', reason: `unknown kind ${p.kind}` };
          } catch (e) { return { region: p && p.region, status: 'error', reason: e.message }; }
        });
        const abort = (why) => results.map(r => r && r.status === 'error' ? r : Object.assign({}, r, { status: 'skipped', reason: why }));
        // Refuse the whole batch if a file it read changed since the page loaded.
        // Structural rewrites (HTML) need the version the page loaded; CSS declarations and
        // data records are written by key, so changes elsewhere in those files are fine.
        const html = [...new Set([...READS, ...VFS.keys()].map(f => relKey(relative(root, f))))].filter(rel => extname(rel).toLowerCase() === '.html');
        const staleFiles = !base ? [] : html.filter(rel => !(rel in base) || (() => { try { return fileHash(join(root, rel)) !== base[rel]; } catch { return true; } })());
        if (html.length && !base) results = results.map(r => Object.assign({}, r, { status: 'error', reason: 'the publish carries no base (the source hashes the page loaded with); reload the page and publish again' }));
        else if (staleFiles.length) results = results.map(r => Object.assign({}, r, { status: 'error', stale: staleFiles, reason: `source changed since this page loaded (${staleFiles.join(', ')}); reload, or publish again with rebase to write over it` }));
        else if (results.some(r => r && r.status === 'error')) results = abort('batch aborted: another patch failed; nothing was written');
        else {
          try { commitFiles(VFS); written = {}; for (const f of VFS.keys()) { const rel = relKey(relative(root, f)); try { written[rel] = fileHash(f); } catch { } } }
          catch (e) { results = results.map(r => Object.assign({}, r, { status: 'error', reason: `nothing written: ${e.message}` })); }
        }
      } finally { VFS = null; READS = null; }
      const stale = results.find(r => r && r.stale);
      reply(200, written ? { results, base: written, ids: allSourceIds(Object.keys(baseHashes())) } : stale ? { results, stale: stale.stale } : { results });
    } catch (e) {
      console.error('[mnfst-run] /__edit/save failed:', e);
      reply(500, { results: [], error: String(e && e.message || e) });
    } });
    return;
  }

  const exact = safeResolve(urlPath);
  if (exact && isFile(exact)) return serveFile(res, exact);

  if (urlPath === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(NOOP_SW);
    return;
  }

  const indexPath = safeResolve(urlPath.replace(/\/$/, '') + '/index.html');
  if (indexPath && isFile(indexPath)) return serveFile(res, indexPath);

  if (spa) {
    const fallback = join(root, 'index.html');
    if (isFile(fallback)) return serveFile(res, fallback);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

// --- Auto-port ---
// (`label` is defined earlier, before the reuse/dedup check.)

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start ${url}`
    : process.platform === 'darwin'        ? `open ${url}`
    : `xdg-open ${url}`;
  exec(cmd);
}

// Whether THIS process owns the running-server registry entry for `root`.
// Stays false in --attach mode (we never claim the entry), so the exit handler
// can't delete an entry belonging to the user's own server for the same root.
let weOwnServer = false;

// --attach: the requested port is already serving this root. Stay in the
// foreground so the supervising preview panel keeps tracking this process,
// without owning the server — never touch its registry; just re-probe and exit
// once it goes away.
function attachToExisting(p) {
  const url = `http://localhost:${p}`;
  console.log(`\n${label} already running at ${url} — attached.\n`);
  if (openBrowserEnabled) openBrowser(url);
  watchUpstream(p);
}

// Exit once the server we're bridging/attached to goes away — we're only a
// pass-through, so there's nothing to serve without it.
function watchUpstream(upstreamPort) {
  setInterval(async () => {
    const id = await probeIdentity(upstreamPort);
    if (!id || id.root !== root) {
      console.log('\nmnfst-run: the server it was bridging has stopped — exiting.\n');
      process.exit(0);
    }
  }, 5000);
}

// --attach: a real dev server for this root is already running on `upstreamPort`,
// but the preview panel can only use a server on the port it assigned us
// (`listenPort`). Bind that port and transparently reverse-proxy every request
// to the real server — including the live-reload SSE stream — so the existing
// server stays the ONE dev server and the panel still works. We don't own a
// server, so we never touch the registry.
function startProxy(listenPort, upstreamPort) {
  const proxy = createServer((creq, cres) => {
    // Rewrite host/origin to the upstream so its loopback host + same-origin
    // checks pass (the client speaks to us on listenPort, the server on upstream).
    const headers = { ...creq.headers, host: `localhost:${upstreamPort}` };
    if (headers.origin) headers.origin = `http://localhost:${upstreamPort}`;
    if (headers.referer) {
      headers.referer = headers.referer.split(`localhost:${listenPort}`).join(`localhost:${upstreamPort}`);
    }
    const preq = httpRequest(
      { host: '127.0.0.1', port: upstreamPort, method: creq.method, path: creq.url, headers },
      (pres) => {
        cres.writeHead(pres.statusCode || 502, pres.headers);
        pres.pipe(cres);   // stream — keeps SSE (text/event-stream) flowing live
      },
    );
    preq.on('error', () => { try { cres.writeHead(502); cres.end('mnfst-run proxy: upstream unavailable'); } catch { /* client gone */ } });
    creq.pipe(preq);
  });
  proxy.on('error', (err) => {
    console.error(`mnfst-run: could not bind proxy port ${listenPort}: ${err.code || err.message}`);
    process.exit(1);
  });
  proxy.listen(listenPort, '127.0.0.1', () => {
    console.log(
      `\n${label} already running at http://localhost:${upstreamPort} — ` +
      `bridged to http://localhost:${listenPort} for the preview panel.\n`,
    );
  });
  watchUpstream(upstreamPort);
}

// Appwrite Realtime (WebSocket) proxy — same first-party-cookie rationale as the
// HTTP proxy. Without it, switching the endpoint to the proxy would break realtime.
if (APPWRITE_PROXY_TARGET) {
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url || '').split('?')[0];
    if (p.startsWith(APPWRITE_PROXY_PREFIX + '/')) proxyAppwriteWs(req, socket, head, p);
    else socket.destroy();
  });
}

function tryListen(p, attempt = 0) {
  if (attempt > 20) {
    console.error('mnfst-run: could not find a free port after 20 attempts.');
    process.exit(1);
  }
  // Use explicit listeners so we can remove the pending 'listening' handler
  // when retrying — otherwise each failed attempt leaves a once('listening')
  // handler registered, and the eventual successful listen fires ALL of them,
  // opening a browser tab for every port that was tried (including ports
  // already taken by other projects).
  const onListening = () => {
    server.removeListener('error', onError);
    const url = `http://localhost:${p}`;
    // A successful fresh bind means WE are the server for this root — register it
    // (so a later manual `mnfst-run` for the same project reuses it instead of
    // starting another). In --attach we only reach here when nothing was already
    // running, so there's no entry to clobber.
    writeRegistry(root, p);
    weOwnServer = true;
    console.log(`\n${label} running at ${url}\n`);
    if (openBrowserEnabled) openBrowser(url);
  };
  const onError = err => {
    server.removeListener('listening', onListening);
    if (err.code !== 'EADDRINUSE') { throw err; }
    // Under --attach, if the requested port is already OUR project, attach to it
    // (stay alive) rather than spawn a duplicate on the next port up.
    if (attachMode && attempt === 0) {
      probeIdentity(p).then((id) => {
        if (id && id.root === root) attachToExisting(p);
        else tryListen(p + 1, attempt + 1);
      });
      return;
    }
    tryListen(p + 1, attempt + 1);
  };
  server.once('listening', onListening);
  server.once('error', onError);
  // Bind to loopback only. Without an explicit host Node listens on `::` (all
  // interfaces), which exposes the dev server — and every file under `root` —
  // to anyone sharing the network (café, hotel, conference, coworking).
  server.listen(p, '127.0.0.1');
}

// Clean up the registry entry on graceful exit — but only if we actually own it
// (never in --attach mode, where the entry may belong to the user's server).
// process.exit() (used by idle-shutdown) fires 'exit'; SIGINT/SIGTERM are
// translated into a process.exit so the same path runs for Ctrl+C and `kill`.
process.on('exit', () => { if (weOwnServer) removeRegistry(root); });
process.on('SIGINT',  () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

tryListen(port);
