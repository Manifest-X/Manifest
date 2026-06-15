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
 *   --attach            Supervised/agent mode (e.g. an LLM preview panel).
 *                       Provides a live FOREGROUND process the supervisor can
 *                       track, while NEVER starting a second server for a
 *                       project that's already running: if a server for this
 *                       root already exists (on ANY port) it stays attached to
 *                       it and prints that URL; otherwise it starts one normally.
 *                       Relies on the launch config's `autoPort` to follow the
 *                       printed URL. Pair with `--no-open`.
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
import { createServer, get as httpGet }  from 'http';
import {
  readFileSync, statSync, watch,
  existsSync, writeFileSync, unlinkSync,
  mkdirSync, readdirSync,
} from 'fs';
import { join, extname, resolve, basename, sep } from 'path';
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
  var tabId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : (Math.random().toString(36).slice(2) + Date.now().toString(36));
  var es = new EventSource('/__mnfst_sse__?tabId=' + encodeURIComponent(tabId));
  es.onmessage = function (e) {
    var d = JSON.parse(e.data);
    if (d.type === 'css') {
      document.querySelectorAll('link[rel="stylesheet"]').forEach(function (l) {
        var base = l.href.split('?')[0];
        if (base.endsWith(d.file)) l.href = base + '?t=' + Date.now();
      });
    } else if (d.type === 'data') {
      window.dispatchEvent(new CustomEvent('manifest:dev-reload'));
    } else {
      location.reload();
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
  if (!existsSync(envPath)) return { public: {}, private: [] };
  const publicEnv = {};
  const privateNames = [];
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
      else privateNames.push(key);
    }
  } catch (error) {
    console.warn('[mnfst-run] Failed to parse .env:', error.message);
  }
  return { public: publicEnv, private: privateNames };
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

// Load .env from the serving root (if present) and pre-build the inject
// script. Kept as a single string so serveFile doesn't re-stringify on every
// HTML response. Empty string when no public vars exist — the injection step
// becomes a no-op for projects whose .env holds only server-side secrets.
const { public: publicEnv, private: privateEnvNames } = loadEnvFile(root);
const envInjectScript = buildEnvInjectScript(publicEnv);
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
// second one for the same project.
//   - manual use: print the URL and exit.
//   - --attach (supervisor, e.g. Claude Code's preview panel): stay alive
//     attached to it on WHATEVER port it's already on, so the panel tracks this
//     process and points at the existing server. `autoPort` in the launch config
//     follows the URL we print, so the port needn't match the configured one.
const existing = await findRunningServer(root);
if (existing) {
  if (attachMode) {
    attachToExisting(existing.port);   // prints the URL + keep-alive
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
const IGNORE = /node_modules|\.git/;
try {
  watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || IGNORE.test(filename)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const ext = extname(filename).toLowerCase();
      if (ext === '.css') {
        broadcast({ type: 'css', file: '/' + filename.replace(/\\/g, '/') });
      } else if (['.csv', '.json', '.yaml', '.yml', '.md'].includes(ext)) {
        broadcast({ type: 'data' });
      } else {
        broadcast({ type: 'reload' });
      }
    }, 60);
  });
} catch {
  // fs.watch unavailable in this environment — live reload disabled
}

// --- File serving ---
function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

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

  const exact = safeResolve(urlPath);
  if (exact && isFile(exact)) return serveFile(res, exact);

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
  setInterval(async () => {
    const id = await probeIdentity(p);
    if (!id || id.root !== root) {
      console.log('\nmnfst-run: the server it attached to has stopped — exiting.\n');
      process.exit(0);
    }
  }, 5000);
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
