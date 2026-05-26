#!/usr/bin/env node

/* mnfst-export — batch and CI exports for Manifest projects.
 *
 * Same six formats as the runtime x-export directive (pdf, png, jpeg, webp,
 * csv, json) plus a CI-only `rss` format for blog feeds, run from Node
 * against a project's source or pre-rendered output.
 *
 * The CLI spins up a minimal static server, opens each configured route in
 * a headless browser, lets Manifest hydrate to manifest:render-ready, and
 * then snapshots or serializes whatever the route exposes.
 *
 * Routes and per-route options come from `manifest.export.routes` in
 * manifest.json, or one-off via CLI flags. Visual exports use Puppeteer's
 * native page.pdf() and page.screenshot() — far more reliable in headless
 * than html-to-image+jsPDF — while data exports evaluate $x.<source>
 * in-page and serialize in Node.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  statSync, readdirSync,
} from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const KNOWN_FORMATS = new Set(['pdf', 'png', 'jpeg', 'jpg', 'webp', 'csv', 'json', 'rss']);

// ----- Arg parsing ---------------------------------------------------------

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    // Format shortcuts: --pdf, --png, etc.
    const bare = a.replace(/^--/, '');
    if (a.startsWith('--') && KNOWN_FORMATS.has(bare.toLowerCase())) {
      out.format = bare.toLowerCase();
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key, value;
      if (eq >= 0) { key = a.slice(2, eq); value = a.slice(eq + 1); }
      else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
        else { value = true; }
      }
      // camelCase the key
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[camel] = value;
      continue;
    }
    out._.push(a);
  }
  return out;
}

function helpText() {
  return `mnfst-export — batch and CI exports for Manifest projects.

Usage:
  npx mnfst-export [options]

Common:
  --root <dir>            Project root (default: cwd).
  --output <dir>          Output directory (default: manifest.export.output or "exports").
  --format <fmt>          One of pdf, png, jpeg, webp, csv, json, rss.
  --pdf, --png, ...       Shortcut for --format.

One-off route (use instead of manifest.export.routes):
  --path <route>          Route to export, e.g. /reports/q3 (default: /).
  --target <selector>     Element to snapshot — visual formats only.
  --source <name>         $x data source name — csv/json/rss only.
  --filename <name>       Output filename for this route.

Visual options:
  --page-size <a4|letter|legal|...>   PDF page size (default: a4).
  --resolution <n>                    Pixel-density multiplier (default: 2).
  --quality <0..1>                    JPEG / WebP quality (default: 0.95).
  --background <css>                  Solid background color.
  --landscape                         Landscape orientation (PDF).

RSS options:
  --rss-title <s>         Channel <title>.
  --rss-link <url>        Channel <link>; falls back to manifest.live_url.
  --rss-description <s>   Channel <description>.

Server / runtime:
  --serve                 Spawn a static server for --root (default: true).
  --no-serve              Skip server; requires --local.
  --local <url>           Existing server URL (e.g. http://localhost:5001).
  --concurrency <n>       Pages in flight at once (default: 2).
  --wait <ms>             Extra wait per page before export (default: 0).
  --headful               Show the browser (for debugging).

manifest.json:
  Per-project defaults and route lists live under "export":
    {
      "export": {
        "output": "exports",
        "routes": [
          { "path": "/reports/q3", "format": "pdf", "target": "#report" },
          { "path": "/customers",  "format": "csv", "source": "customers" }
        ]
      }
    }
`;
}

// ----- Config --------------------------------------------------------------

function loadManifest(rootDir) {
  const p = join(rootDir, 'manifest.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (err) {
    console.error(`mnfst-export: failed to parse ${p}: ${err.message}`);
    process.exit(1);
  }
}

function resolveConfig() {
  const cli = parseArgs();
  if (cli.help) { process.stdout.write(helpText()); process.exit(0); }

  const cwd = process.cwd();
  const root = resolve(cwd, cli.root ?? '.');
  const manifest = loadManifest(root);
  const cfg = manifest.export ?? {};

  // Build the list of routes-to-export.
  // Priority:
  //   1. Explicit --path on the CLI ⇒ a single one-off route (CLI fields take precedence).
  //   2. manifest.export.routes ⇒ each entry is a route + per-route options.
  //   3. Fallback: a single "/" route using CLI defaults.
  let routes;
  if (cli.path !== undefined) {
    routes = [routeFromCli(cli, cfg)];
  } else if (Array.isArray(cfg.routes) && cfg.routes.length > 0) {
    routes = cfg.routes.map((r) => normalizeRoute(r, cli, cfg));
  } else {
    routes = [routeFromCli(cli, cfg)];
  }

  const localUrl = (cli.local ?? cli.baseUrl ?? cfg.localUrl ?? '').toString().replace(/\/$/, '');
  const serve = cli.serve === undefined ? !localUrl : (cli.serve !== false && cli.serve !== 'false');

  return {
    root,
    output: resolve(root, cli.output ?? cfg.output ?? 'exports'),
    serve,
    localUrl,
    headful: !!cli.headful,
    concurrency: Math.max(1, Number(cli.concurrency ?? cfg.concurrency ?? 2) | 0),
    wait: Math.max(0, Number(cli.wait ?? cfg.wait ?? 0) | 0),
    routes,
    manifest, // passed through so RSS can read live_url / name / description
    rssDefaults: {
      title: cli.rssTitle ?? cfg.rss?.title ?? manifest.name ?? 'Untitled',
      link: cli.rssLink ?? cfg.rss?.link ?? manifest.live_url ?? '',
      description: cli.rssDescription ?? cfg.rss?.description ?? manifest.description ?? '',
    },
  };
}

function routeFromCli(cli, cfg) {
  const format = String(cli.format ?? cfg.format ?? 'pdf').toLowerCase();
  return normalizeRoute({
    path: cli.path ?? '/',
    format,
    target: cli.target,
    source: cli.source,
    filename: cli.filename,
    pageSize: cli.pageSize,
    landscape: cli.landscape ? true : undefined,
    resolution: cli.resolution,
    quality: cli.quality,
    backgroundColor: cli.background ?? cli.backgroundColor,
  }, cli, cfg);
}

function normalizeRoute(route, cli, cfg) {
  const out = { ...route };
  out.path = '/' + String(out.path || '/').replace(/^\/+/, '');
  out.format = String(out.format || cli.format || cfg.format || 'pdf').toLowerCase();
  if (!KNOWN_FORMATS.has(out.format)) {
    throw new Error(`unknown format "${out.format}". Supported: ${[...KNOWN_FORMATS].join(', ')}`);
  }
  if (out.format === 'jpg') out.format = 'jpeg';
  if (out.resolution != null) out.resolution = Number(out.resolution);
  if (out.quality != null) out.quality = Number(out.quality);
  out.landscape = out.landscape === true || out.landscape === 'true';
  return out;
}

// ----- Static server (vendored from mnfst-render's --serve) ---------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function startStaticServer(rootDir) {
  const rootResolved = resolve(rootDir);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end(); return;
    }
    const pathname = (req.url || '/').replace(/\?.*$/, '') || '/';
    const segments = pathname.split('/').filter(Boolean);
    const safeSegments = segments.filter((s) => s !== '..' && s !== '');
    const filePath = join(rootResolved, ...safeSegments);
    function sendIndex() {
      const indexFile = join(rootResolved, 'index.html');
      if (!existsSync(indexFile)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(indexFile));
    }
    let resolved;
    try {
      resolved = resolve(filePath);
      if (!resolved.startsWith(rootResolved)) { res.writeHead(403); res.end(); return; }
    } catch { sendIndex(); return; }
    if (!existsSync(resolved)) { sendIndex(); return; }
    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      const indexInDir = join(resolved, 'index.html');
      if (existsSync(indexInDir)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(indexInDir));
        return;
      }
      sendIndex(); return;
    }
    const ext = extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(readFileSync(resolved));
  });
  return new Promise((resolveP, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveP({ server, url: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

// ----- Puppeteer loader (resolve from caller's project first) -------------

async function importPuppeteer() {
  // Prefer the caller's installed puppeteer; fall back to this package's
  // peer (in dev workspaces) so the CLI is usable from the repo as well.
  for (const base of [process.cwd(), __dirname, join(__dirname, '..', '..')]) {
    try {
      const resolved = require.resolve('puppeteer', { paths: [base] });
      const mod = await import(resolved);
      return mod.default || mod;
    } catch { /* try next */ }
  }
  console.error('mnfst-export: puppeteer is required for exports.');
  console.error('  npm i -D puppeteer');
  process.exit(1);
}

// ----- Wait for Manifest's render-ready signal ----------------------------

async function waitForRenderReady(page, { wait, timeoutMs = 10000 }) {
  // Mirrors render's approach: prefer manifest:render-ready event when the
  // data plugin is present, fall back to a bounded timeout otherwise.
  await page.evaluate(async (ms) => {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      const onReady = () => finish();
      window.addEventListener('manifest:render-ready', onReady, { once: true });
      // If the data plugin isn't active, give Alpine a tick and resolve.
      const fallback = setTimeout(() => {
        if (typeof Alpine !== 'undefined' && typeof Alpine.nextTick === 'function') {
          Alpine.nextTick(() => Alpine.nextTick(finish));
        } else { finish(); }
      }, Math.min(ms, 1500));
      // Hard upper bound.
      setTimeout(() => { clearTimeout(fallback); finish(); }, ms);
    });
  }, timeoutMs);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// ----- Exporters per format -----------------------------------------------

async function exportVisual(page, route, outPath) {
  const fmt = route.format;
  const fullPage = !route.target;
  if (fmt === 'pdf') {
    // page.pdf needs print media. Force a sane background for solid color.
    await page.emulateMediaType('print');
    if (route.target) {
      // PDFs from element: snapshot the element to PNG and put it on a PDF.
      // Puppeteer's page.pdf() can't natively limit to an element; the
      // straightforward path is screenshot-of-element ⇒ image-on-pdf.
      const buf = await screenshotElement(page, route, 'png');
      const dims = await imageDims(buf);
      const orientation = (route.landscape || dims.w > dims.h) ? 'landscape' : 'portrait';
      // Build a one-page PDF that just contains the image.
      await page.setContent(
        `<!doctype html><html><head><style>
          @page { size: ${route.pageSize || 'a4'} ${orientation}; margin: 0; }
          html, body { margin:0; padding:0; }
          img { display:block; width:100%; height:auto; ${route.backgroundColor ? `background:${route.backgroundColor};` : ''} }
         </style></head><body><img src="data:image/png;base64,${buf.toString('base64')}"></body></html>`,
        { waitUntil: 'networkidle0' }
      );
    }
    const pdf = await page.pdf({
      format: route.pageSize || 'a4',
      landscape: !!route.landscape,
      printBackground: true,
      preferCSSPageSize: !!route.target, // honor @page when we built the wrapper above
    });
    writeFileSync(outPath, pdf);
    return;
  }
  const buf = route.target
    ? await screenshotElement(page, route, fmt)
    : await page.screenshot({
        type: fmt === 'jpeg' ? 'jpeg' : (fmt === 'webp' ? 'webp' : 'png'),
        fullPage: true,
        omitBackground: fmt === 'png' && !route.backgroundColor,
        quality: (fmt === 'jpeg' || fmt === 'webp')
          ? Math.round((route.quality ?? 0.95) * 100)
          : undefined,
      });
  writeFileSync(outPath, buf);
}

async function screenshotElement(page, route, fmt) {
  const handle = await page.$(route.target);
  if (!handle) throw new Error(`target "${route.target}" matched no element on ${route.path}`);
  const opts = {
    type: fmt === 'jpeg' ? 'jpeg' : (fmt === 'webp' ? 'webp' : 'png'),
    omitBackground: fmt === 'png' && !route.backgroundColor,
  };
  if (fmt === 'jpeg' || fmt === 'webp') {
    opts.quality = Math.round((route.quality ?? 0.95) * 100);
  }
  return await handle.screenshot(opts);
}

async function imageDims(buf) {
  // Minimal PNG-only header read (puppeteer screenshots are PNG here).
  // Bytes 16-23 are width/height big-endian uint32.
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return { w: 1, h: 1 };
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return { w, h };
}

async function exportCsv(page, route, outPath) {
  const data = await readDataSource(page, route);
  if (!Array.isArray(data)) throw new Error(`csv export expects an array source; got ${typeof data}`);
  const csv = toCsv(data);
  writeFileSync(outPath, csv, 'utf8');
}

async function exportJson(page, route, outPath) {
  const data = await readDataSource(page, route);
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
}

async function exportRss(page, route, outPath, rssDefaults, manifest) {
  const data = await readDataSource(page, route);
  if (!Array.isArray(data)) throw new Error('rss export expects an array source');
  const xml = toRss(data, {
    title: route.title ?? rssDefaults.title,
    link: route.link ?? rssDefaults.link,
    description: route.description ?? rssDefaults.description,
    map: route.map || null,
  });
  writeFileSync(outPath, xml, 'utf8');
}

async function readDataSource(page, route) {
  if (!route.source) throw new Error('csv/json/rss export needs "source" — the name of an $x data source');
  return await page.evaluate((name) => {
    // Resolve $x.<name> the same way the runtime $export magic does.
    let src = null;
    try {
      if (window.$x && window.$x[name] != null) src = window.$x[name];
      else if (window.Alpine && Alpine.store && Alpine.store('x') && Alpine.store('x')[name] != null) {
        src = Alpine.store('x')[name];
      }
    } catch { /* swallow */ }
    if (src == null) throw new Error(`data source "${name}" not found in $x`);
    // Sanitize: drop $-prefixed reactivity helpers and loading flags.
    const sanitize = (v) => {
      if (Array.isArray(v)) return v.map(sanitize);
      if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) {
          if (k.startsWith('$') || k === '_loading' || k === '_error') continue;
          out[k] = sanitize(v[k]);
        }
        return out;
      }
      return v;
    };
    return sanitize(src);
  }, route.source);
}

// ----- CSV / RSS serializers ----------------------------------------------

function toCsv(rows) {
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) { seen.add(k); headers.push(k); }
    }
  }
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => cell(row && row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

function toRss(items, opts) {
  const xml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const pick = (item, key, fallback) => {
    const m = opts.map && opts.map[key];
    if (m && item[m] != null) return item[m];
    if (item[key] != null) return item[key];
    return fallback;
  };
  const linkBase = (opts.link || '').replace(/\/$/, '');
  const entries = items.map((item) => {
    const title = xml(pick(item, 'title', ''));
    const linkRaw = pick(item, 'link', '');
    const link = linkRaw && /^https?:\/\//.test(linkRaw)
      ? linkRaw
      : (linkBase && linkRaw ? `${linkBase}${linkRaw.startsWith('/') ? '' : '/'}${linkRaw}` : (linkBase || ''));
    const description = xml(pick(item, 'description', pick(item, 'summary', '')));
    const dateRaw = pick(item, 'pubDate', pick(item, 'date', null));
    const date = dateRaw ? new Date(dateRaw) : null;
    const pubDate = date && !isNaN(date.valueOf()) ? date.toUTCString() : '';
    return `    <item>
      <title>${title}</title>
      ${link ? `<link>${xml(link)}</link>` : ''}
      ${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}
      <description>${description}</description>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xml(opts.title)}</title>
    <link>${xml(opts.link || '')}</link>
    <description>${xml(opts.description)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${entries}
  </channel>
</rss>
`;
}

// ----- Filename helpers ----------------------------------------------------

function defaultFilename(route) {
  const fmt = route.format === 'jpeg' ? 'jpg' : (route.format === 'rss' ? 'xml' : route.format);
  const slug = route.path === '/' ? 'index' : route.path.replace(/^\/|\/$/g, '').replace(/\//g, '-');
  return `${slug || 'index'}.${fmt}`;
}

function resolveFilename(route, output) {
  const name = route.filename || defaultFilename(route);
  return resolve(output, name);
}

// ----- Concurrency runner --------------------------------------------------

async function runRoutes(browser, baseUrl, config) {
  const queue = config.routes.slice();
  const results = [];
  const workers = Array.from({ length: Math.min(config.concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const route = queue.shift();
      const url = baseUrl + route.path;
      const outPath = resolveFilename(route, config.output);
      mkdirSync(dirname(outPath), { recursive: true });
      let page;
      try {
        page = await browser.newPage();
        if (route.resolution && (route.format !== 'pdf' && route.format !== 'csv' && route.format !== 'json' && route.format !== 'rss')) {
          await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: route.resolution });
        }
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        await waitForRenderReady(page, { wait: config.wait });
        switch (route.format) {
          case 'pdf':
          case 'png':
          case 'jpeg':
          case 'webp':
            await exportVisual(page, route, outPath);
            break;
          case 'csv':
            await exportCsv(page, route, outPath);
            break;
          case 'json':
            await exportJson(page, route, outPath);
            break;
          case 'rss':
            await exportRss(page, route, outPath, config.rssDefaults, config.manifest);
            break;
          default:
            throw new Error(`format "${route.format}" not implemented`);
        }
        const size = statSync(outPath).size;
        process.stdout.write(`  ✓ ${route.format.padEnd(4)}  ${route.path.padEnd(28)} → ${outPath.replace(config.root + '/', '')} (${formatBytes(size)})\n`);
        results.push({ ok: true, route });
      } catch (err) {
        process.stdout.write(`  ✗ ${route.format.padEnd(4)}  ${route.path.padEnd(28)} — ${err.message}\n`);
        results.push({ ok: false, route, error: err });
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ----- Main ----------------------------------------------------------------

export async function main() {
  const config = resolveConfig();
  if (!config.serve && !config.localUrl) {
    console.error('mnfst-export: --no-serve requires --local <url>');
    process.exit(1);
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    console.error('mnfst-export: no routes to export. Configure manifest.export.routes or pass --path.');
    process.exit(1);
  }

  mkdirSync(config.output, { recursive: true });

  let staticServer = null;
  let baseUrl = config.localUrl;
  if (config.serve) {
    const started = await startStaticServer(config.root);
    staticServer = started.server;
    baseUrl = started.url;
  }

  const startedAt = Date.now();
  process.stdout.write(`mnfst-export: ${config.routes.length} route(s) → ${config.output.replace(config.root + '/', '')}/\n`);

  const puppeteer = await importPuppeteer();
  const browser = await puppeteer.launch({
    headless: config.headful ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let results = [];
  try {
    results = await runRoutes(browser, baseUrl, config);
  } finally {
    await browser.close().catch(() => {});
    if (staticServer) await new Promise((r) => staticServer.close(r));
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`mnfst-export: ${ok} succeeded, ${fail} failed in ${elapsed}s\n`);
  if (fail > 0) process.exit(1);
}

// Allow `node manifest.export.mjs ...` to run directly (in addition to via the bin shim).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('mnfst-export:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
