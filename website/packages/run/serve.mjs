#!/usr/bin/env node
/**
 * mnfst-run — zero-dependency dev server for Manifest projects.
 *
 * Usage:
 *   npx mnfst-run [dir] [--port 5001] [--idle-shutdown 30] [--no-idle-shutdown]
 *
 *   dir                 Directory to serve (default: current directory). Any
 *                       depth of nesting is valid, e.g.
 *                       npx mnfst-run docs/articles/publishing
 *   --port              Preferred port (default: PORT env var, then 5001).
 *                       Auto-increments if the port is already in use.
 *   --idle-shutdown N   Exit after N seconds with no open browser tabs
 *                       (default 30). Only arms once a tab has connected, so
 *                       the auto-launched browser has time to load.
 *   --no-idle-shutdown  Disable auto-shutdown (useful in CI / headless cases
 *                       where no browser will connect).
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
import { createServer }                  from 'http';
import { readFileSync, statSync, watch } from 'fs';
import { join, extname, resolve, basename } from 'path';
import { exec }                          from 'child_process';

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
const LIVE_RELOAD_SCRIPT = `<script>
(function () {
  var es = new EventSource('/__mnfst_sse__');
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
  es.onerror = function () { es.close(); };
})();
\x3c/script>`;

// --- CLI args ---
const args = process.argv.slice(2);
let dir  = '.';
let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 5001;
// Auto-shutdown: when the last open browser tab disconnects (SSE drops to 0
// clients) and stays gone for `idleShutdownSec`, the server exits. Cancelled
// by `--no-idle-shutdown` (e.g. CI, headless smoke tests, or any case where
// no browser will ever connect).
let idleShutdownSec = 30;
let idleShutdownEnabled = true;

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) { port = parseInt(args[++i], 10); continue; }
  if (args[i] === '--no-idle-shutdown') { idleShutdownEnabled = false; continue; }
  if (args[i] === '--idle-shutdown' && args[i + 1]) { idleShutdownSec = parseInt(args[++i], 10); continue; }
  if (!args[i].startsWith('-')) dir = args[i];
}

const root = resolve(process.cwd(), dir);

// --- Auto-detect MPA ---
function detectMPA(rootDir) {
  try {
    return /name=["']manifest:prerendered["']/i.test(readFileSync(join(rootDir, 'index.html'), 'utf8'));
  } catch { return false; }
}
const spa = !detectMPA(root);

// --- SSE clients ---
let clients = [];
let debounce = null;

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch { /* client gone */ } });
}

// --- Idle auto-shutdown ---
// `everConnected` keeps the timer dormant until at least one tab has opened —
// otherwise the server would exit before the auto-launched browser tab finishes
// loading. `idleTimer` runs only while clients.length === 0; any new SSE
// connection cancels it. The grace window also covers hard-reload churn (Cmd+R
// drops the SSE briefly, then reconnects in well under a second).
let everConnected = false;
let idleTimer = null;

function armIdleShutdown() {
  if (!idleShutdownEnabled || !everConnected || idleTimer) return;
  if (clients.length > 0) return;
  idleTimer = setTimeout(() => {
    console.log(`\nmnfst-run: no open tabs for ${idleShutdownSec}s — shutting down.\n`);
    process.exit(0);
  }, idleShutdownSec * 1000);
}

function cancelIdleShutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

// --- .env support ---
// Minimal dotenv parser. Skips comments/blank lines, splits on first `=`,
// trims whitespace, strips wrapping single/double quotes. No multiline values,
// no `${VAR}` substitution within .env itself — we just want plain KEY=VALUE.
function parseDotenv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// --- File watcher ---
const IGNORE = /node_modules|\.git/;
try {
  watch(root, { recursive: true }, (_event, filename) => {
    if (!filename || IGNORE.test(filename)) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const ext = extname(filename).toLowerCase();
      const base = basename(filename);
      if (base === '.env') {
        broadcast({ type: 'reload' });
      } else if (ext === '.css') {
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

function serveFile(res, filePath) {
  const ext  = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  let body   = readFileSync(filePath);
  if (ext === '.html') {
    const html = body.toString('utf8');
    // Only inject into full HTML documents — not component fragments
    const isFullDoc = /<!doctype\s/i.test(html) || /<html[\s>]/i.test(html);
    if (isFullDoc) {
      const injected = html.includes('</body>')
        ? html.replace('</body>', LIVE_RELOAD_SCRIPT + '</body>')
        : html + LIVE_RELOAD_SCRIPT;
      body = Buffer.from(injected, 'utf8');
    }
  }
  res.writeHead(200, { 'Content-Type': mime });
  res.end(body);
}

// --- HTTP server ---
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Virtual /env.js — generated from .env at the project root.
  // Loaded by HTML before manifest.data.js so window.env is populated for
  // ${VAR} interpolation in manifest.json. Returns an empty no-op if no
  // .env exists, so the <script src="/env.js"> tag is always safe to include.
  if (urlPath === '/env.js') {
    const envPath = join(root, '.env');
    let body = 'window.env = window.env || {};';
    try {
      if (isFile(envPath)) {
        const env = parseDotenv(readFileSync(envPath, 'utf8'));
        body = `window.env = Object.assign(window.env || {}, ${JSON.stringify(env)});`;
      }
    } catch { /* fall through to no-op */ }
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  // SSE endpoint for live reload
  if (urlPath === '/__mnfst_sse__') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write(':\n\n'); // initial keep-alive comment
    clients.push(res);
    everConnected = true;
    cancelIdleShutdown();
    req.on('close', () => {
      clients = clients.filter(c => c !== res);
      if (clients.length === 0) armIdleShutdown();
    });
    return;
  }

  const exact = join(root, urlPath);
  if (isFile(exact)) return serveFile(res, exact);

  const index = join(root, urlPath.replace(/\/$/, ''), 'index.html');
  if (isFile(index)) return serveFile(res, index);

  if (spa) {
    const fallback = join(root, 'index.html');
    if (isFile(fallback)) return serveFile(res, fallback);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

// --- Auto-port ---
// Human-readable label: the dir arg as given, or the cwd folder name if serving '.'
const label = dir === '.' ? basename(process.cwd()) : dir.replace(/\\/g, '/');

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start ${url}`
    : process.platform === 'darwin'        ? `open ${url}`
    : `xdg-open ${url}`;
  exec(cmd);
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
    console.log(`\n${label} running at ${url}\n`);
    openBrowser(url);
  };
  const onError = err => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE') tryListen(p + 1, attempt + 1);
    else throw err;
  };
  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(p);
}

tryListen(port);
