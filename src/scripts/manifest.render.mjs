#!/usr/bin/env node

/* Manifest Render */

import { readFileSync, readSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync, readdirSync, cpSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, relative, basename, sep } from 'node:path';
import { createServer } from 'node:http';
import { cpus } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

async function importFromProject(moduleName) {
  // Ensure dependencies are resolved from the caller's project (cwd),
  // not from this CLI package's own node_modules location.
  try {
    const resolved = require.resolve(moduleName, { paths: [process.cwd()] });
    return await import(resolved);
  } catch {
    return await import(moduleName);
  }
}


async function flushAlpineEffects(page) {
  await page
    .evaluate(() => {
      return new Promise((resolve) => {
        try {
          if (typeof Alpine !== 'undefined' && typeof Alpine.nextTick === 'function') {
            Alpine.nextTick(() => {
              if (typeof Alpine.nextTick === 'function') Alpine.nextTick(resolve);
              else resolve();
            });
          } else {
            queueMicrotask(resolve);
          }
        } catch {
          resolve();
        }
      });
    })
    .catch(() => {});
}

/**
 * Same logical path → normalizedPath as waitForManifestPrerenderPipeline and
 * manifest.router.visibility initialize (matchesCondition first argument).
 */
function logicalPathToVisibilityNormalizedPath(pathSeg, locales) {
  const pathname = pathSeg ? `/${pathSeg}` : '/';
  const clean = String(pathname || '/').replace(/^\/+|\/+$/g, '');
  const parts = clean ? clean.split('/') : [];
  const localeList = Array.isArray(locales) ? locales : [];
  const logical =
    parts.length > 0 && localeList.includes(parts[0])
      ? `/${parts.slice(1).join('/')}`
      : clean
        ? `/${clean}`
        : '/';
  const to = logical === '//' ? '/' : logical;
  return typeof to === 'string' && to !== '/' ? to.replace(/^\/|\/$/g, '') : '/';
}

/**
 * Set locale, dispatch route/locale events, call component swapping, then wait for
 * manifest:render-ready — the authoritative signal from the data plugin that all tracked
 * sources have settled for the active locale.
 *
 * Falls back to a timeout if the data plugin is absent or predates manifest:render-ready,
 * so this is backward-compatible with any Manifest project.
 */
async function waitForManifestRenderReady(page, { allLocales, currentLocale, timeoutMs }) {
  const result = await page
    .evaluate(
      async ({ localeList, loc, ms }) => {
        try {
          const locales = Array.isArray(localeList) ? localeList : [];

          // 1. Align locale state before dispatching any events.
          if (loc && typeof loc === 'string') {
            try { document.documentElement.lang = loc; } catch { /* no-op */ }
          }
          const localeStore = typeof Alpine !== 'undefined' && Alpine.store
            ? Alpine.store('locale') : null;
          if (localeStore) {
            if (!Array.isArray(localeStore.available) || localeStore.available.length === 0) {
              localeStore.available = locales.slice();
            } else {
              localeStore.available = Array.from(new Set([...localeStore.available, ...locales]));
            }
            if (loc && typeof loc === 'string') localeStore.current = loc;
          }

          // 2. Compute normalised route path (strips locale prefix, matches router logic).
          const rawRoute = window.ManifestRoutingNavigation?.getCurrentRoute?.()
            ?? window.location.pathname;
          const clean = String(rawRoute || '/').replace(/^\/+|\/+$/g, '');
          const parts = clean ? clean.split('/') : [];
          const logical =
            parts.length > 0 && locales.includes(parts[0])
              ? '/' + parts.slice(1).join('/')
              : clean ? '/' + clean : '/';
          const to = logical === '//' ? '/' : logical;
          const normalizedPath =
            typeof to === 'string' && to !== '/' ? to.replace(/^\/|\/$/g, '') : '/';

          // 3. Register the manifest:render-ready listener BEFORE dispatching events so we
          //    never miss a fast-settling response. Falls back to timeout for older data plugins.
          const renderReadyPromise = new Promise((resolve) => {
            const onReady = (e) => resolve({ ok: true, locale: e.detail?.locale });
            window.addEventListener('manifest:render-ready', onReady, { once: true });
            setTimeout(() => {
              window.removeEventListener('manifest:render-ready', onReady);
              resolve({ ok: false, reason: 'timeout' });
            }, ms);
          });

          // 4. Dispatch locale change — triggers localized source reloads in the data plugin.
          if (loc && typeof loc === 'string') {
            window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: loc } }));
          }

          // 5. Dispatch route change — ensures router visibility and head content are current.
          window.dispatchEvent(new CustomEvent('manifest:route-change', {
            detail: { from: to, to, normalizedPath },
          }));
          window.dispatchEvent(new PopStateEvent('popstate'));

          // 5b. Eagerly warm up declared local data sources for the current locale.
          //
          // Without this, sources are loaded lazily — only when a `$x.foo` access
          // triggers the proxy.  For static `<template x-for="group in $x.docs">`
          // patterns the iterator may not run early enough for the load to be
          // in-flight before checkAndDispatchRenderReady's debounced timer fires,
          // and the snapshot captures an empty template (no clones for SEO).
          //
          // Warming up here forces every declared local source into the loading
          // state synchronously (loadDataSource sets _<name>_state.loading = true
          // and registers a promise in loadingPromises before returning), which
          // gates the render-ready dispatch until all loads settle.  Cloud
          // sources (Appwrite collections, object-form API URLs) are skipped —
          // those are typically auth-gated or intentionally dynamic and not
          // appropriate for SEO-baking; lazy access still works for them.
          try {
            const cfg = window.ManifestDataConfig;
            const main = window.ManifestDataMain;
            const manifest = await cfg?.ensureManifest?.();
            if (manifest?.data && typeof main?.loadDataSource === 'function') {
              const isAppwrite = cfg.isAppwriteCollection;
              for (const [name, source] of Object.entries(manifest.data)) {
                if (isAppwrite && isAppwrite(source)) continue;
                if (source && typeof source === 'object' && source.url) continue;
                // Fire-and-forget: we just need the loading flag set and the
                // promise registered.  Failures fall back to lazy behaviour.
                main.loadDataSource(name, loc).catch(() => { });
              }
            }
          } catch { /* warmup is best-effort; existing lazy access is the fallback */ }

          // 6. Run component swapping explicitly so components tied to this route render
          //    and trigger any $x accesses that start on-demand data loads.
          if (window.ManifestComponentsSwapping?.processAll) {
            try {
              await window.ManifestComponentsSwapping.processAll(normalizedPath);
            } catch (e) {
              return { ok: false, reason: 'processAll-error', message: String(e?.message || e) };
            }
          }

          // 7. Await the authoritative signal (or timeout fallback).
          return await renderReadyPromise;
        } catch (err) {
          return { ok: false, reason: 'error', message: String(err?.message || err) };
        }
      },
      { localeList: allLocales, loc: currentLocale, ms: timeoutMs }
    )
    .catch((e) => ({ ok: false, reason: 'evaluate', message: String(e) }));

  // Note: render-ready wait timeouts are silently tolerated.  Earlier versions
  // logged a warning per path, but it fires on essentially every route in
  // projects whose data plugins don't dispatch `manifest:render-ready` (i.e.
  // most of them), drowning the terminal in noise.  The fallback timeout is
  // intentional and benign — the DOM is still captured.
}

// --- Config ------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1]) { out.baseUrl = args[++i]; continue; }
    if (args[i] === '--local' && args[i + 1]) { out.localUrl = args[++i]; continue; }
    if (args[i] === '--live' && args[i + 1]) { out.liveUrl = args[++i]; continue; }
    if (args[i] === '--out' && args[i + 1]) { out.output = args[++i]; continue; }
    if (args[i] === '--root' && args[i + 1]) { out.root = args[++i]; continue; }
    if (args[i] === '--serve') { out.serve = true; continue; }
    if (args[i] === '--wait' && args[i + 1]) { out.wait = parseInt(args[++i], 10); continue; }
    if (args[i] === '--wait-after-idle' && args[i + 1]) { out.waitAfterIdle = parseInt(args[++i], 10); continue; }
    if (args[i] === '--concurrency' && args[i + 1]) { out.concurrency = parseInt(args[++i], 10); continue; }
    if (args[i] === '--retries' && args[i + 1]) { out.retries = parseInt(args[++i], 10); continue; }
    if (args[i] === '--dry-run') { out.dryRun = true; continue; }
    if (args[i] === '--debug-prerender') { out.debugPrerender = true; continue; }
  }
  return out;
}

function loadConfig(rootDir) {
  const manifestPath = join(rootDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { prerender: {} };
  }
  const raw = readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { prerender: {} };
  }
  return manifest;
}

function normalizeLocaleRouteExclude(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val.map((s) => String(s).trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function resolveConfig() {
  const cli = parseArgs();
  const cwd = process.cwd();
  const root = resolve(cwd, cli.root ?? '.');
  const manifest = loadConfig(root);
  const pre = manifest.prerender ?? {};

  const localUrl = (cli.localUrl ?? cli.baseUrl ?? process.env.PRERENDER_BASE ?? pre.localUrl ?? pre.baseUrl)?.replace(/\/$/, '');
  const serve = cli.localUrl ? false : (cli.serve !== undefined ? !!cli.serve : true);
  if (!serve && !localUrl) {
    console.error('prerender: localUrl is required when not using built-in server. Set manifest.prerender.localUrl or use --local.');
    process.exit(1);
  }
  const liveUrl = (cli.liveUrl ?? process.env.PRERENDER_LIVE ?? manifest.live_url ?? manifest.liveUrl ?? pre.live_url ?? pre.liveUrl ?? localUrl ?? '')?.replace(/\/$/, '');

  return {
    localUrl: localUrl ?? '',
    liveUrl,
    serve,
    output: resolve(root, cli.output ?? pre.output ?? 'website'),
    root,
    manifest,
    routerBase: pre.routerBase ?? null,
    /** Logical path prefixes (after locale) that skip sticky locale prefix; see manifest:locale-route-exclude */
    localeRouteExclude: normalizeLocaleRouteExclude(
      pre.localeRouteExclude ?? pre.localeStickyExclude
    ),
    locales: pre.locales,
    redirects: Array.isArray(pre.redirects) ? pre.redirects : [],
    wait: cli.wait ?? pre.wait ?? null,
    waitAfterIdle: 0,
    // Default concurrency: 2.  Chromium per-page memory overhead is large and
    // our hydration source-attribute map adds more per page.  On big sites
    // (>100 routes) higher concurrency crashes the browser with OOM/target
    // closed errors.  Users can override for small projects with --concurrency.
    concurrency: Math.max(1, cli.concurrency ?? pre.concurrency ?? 2),
    retries: Math.max(0, cli.retries ?? pre.retries ?? 2),
    localeSubstitution: true,
    localeSubstitutionExclude: [],
    /** Explicit locale-neutral paths to render in addition to those discovered automatically.
     *  Each entry is expanded to all locale variants (e.g. "legal/privacy" → "cs/legal/privacy", ...) */
    paths: Array.isArray(pre.paths)
      ? pre.paths.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter(Boolean)
      : [],
    dryRun: !!cli.dryRun,
    debugPrerender: !!cli.debugPrerender,
    // Cap on the manifest:render-ready wait.  When the data plugin dispatches
    // the event, we resolve immediately; when it doesn't (most projects), we
    // fall back to the timeout.  10s gives slow data plugin pipelines a
    // chance while bounding worst-case per-path overhead.
    pipelineTimeout: 10000,
    // SEO / AEO meta injection — see metaInjection() and the prerender.meta
    // section of manifest.json.  Layered precedence (highest first):
    //   1. <template data-head> per-route (already in DOM at snapshot time)
    //   2. <head> in index.html (already in DOM at snapshot time)
    //   3. prerender.meta.* expressions (Alpine-evaluated per route)
    //   4. prerender.meta.fallback.* (static strings if expression empty)
    //   5. PWA-style manifest.json fields (name, description, author, icons)
    //   6. Smart defaults derived from the rendered DOM (h1, first p, etc.)
    //
    // Each layer only fills slots not yet present.  An empty <title></title>
    // or one matching manifest.json "name" counts as missing (placeholder rule).
    seo: {
      siteName: manifest.name || null,
      siteDescription: manifest.description || null,
      siteAuthor: manifest.author || null,
      icons: Array.isArray(manifest.icons) ? manifest.icons : [],
      meta: pre.meta || null,
      structuredData: pre.structuredData || null,
      imageSnapshots: pre.meta?.imageSnapshots !== false, // default true
      defaults: pre.meta?.defaults !== false,             // default true
    },
  };
}

// --- Discovery: locales from manifest.data -----------------------------------
// Picks up (1) object keys that are locale codes (e.g. "en", "fr" in data.features)
// and (2) "locales" properties that point to CSV (or array of CSVs); locale codes from CSV header row.

const LOCALE_CODE_RE = /^[a-z]{2}(-[A-Z]{2})?$/i;

function localeCodesFromCsvHeader(rootDir, filePath) {
  const fullPath = join(rootDir, filePath.startsWith('/') ? filePath.slice(1) : filePath);
  if (!existsSync(fullPath)) return [];
  const text = readFileSync(fullPath, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  if (header.length < 2) return [];
  // First column is key; rest are locale columns (per localization docs)
  return header.slice(1).filter((col) => LOCALE_CODE_RE.test(String(col).trim())).map((c) => String(c).trim().toLowerCase());
}

function discoverLocales(manifest, rootDir) {
  const codes = new Set();
  const data = manifest.data;
  if (!data || typeof data !== 'object') return [];
  for (const v of Object.values(data)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    // Object keys that are locale codes (JSON/YAML per-locale files)
    for (const k of Object.keys(v)) {
      if (LOCALE_CODE_RE.test(k)) codes.add(k.toLowerCase());
    }
    // "locales" → single CSV path or array of CSV paths; locale codes from CSV headers
    const localesRef = v.locales;
    if (localesRef != null) {
      const files = Array.isArray(localesRef) ? localesRef : [localesRef];
      for (const filePath of files) {
        if (typeof filePath !== 'string') continue;
        localeCodesFromCsvHeader(rootDir, filePath).forEach((c) => codes.add(c));
      }
    }
  }
  return [...codes];
}

// --- Discovery: x-route from HTML --------------------------------------------

function extractXRouteConditions(html) {
  const conditions = new Set();
  const re = /x-route\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    m[1].split(',').forEach((c) => {
      const t = c.trim();
      if (t && !t.startsWith('!')) conditions.add(t);
    });
  }
  return conditions;
}

function normalizeRouteCondition(cond) {
  const raw = String(cond || '').trim();
  if (!raw) return { kind: 'all', path: '' };
  if (raw.startsWith('!')) {
    const omitted = raw.slice(1).trim();
    if (!omitted || omitted === '*') return { kind: 'not-found', path: '' }; // !*
    return { kind: 'omit', path: omitted };
  }
  if (raw === '*') return { kind: 'all', path: '' };
  const withoutExact = raw.startsWith('=') ? raw.slice(1) : raw;
  const trimmed = withoutExact.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return { kind: 'root', path: '' };
  if (trimmed.endsWith('/*')) {
    const base = trimmed.slice(0, -2).replace(/^\/+|\/+$/g, '');
    return base ? { kind: 'wildcard-prefix', path: base } : { kind: 'all', path: '' };
  }
  if (trimmed.includes('*')) return { kind: 'unsupported-pattern', path: trimmed };
  return { kind: 'path', path: trimmed };
}

function conditionsToPaths(conditions) {
  const paths = new Set();
  paths.add('/');
  for (const c of conditions) {
    const parsed = normalizeRouteCondition(c);
    // Discovery rules aligned with router docs:
    // - "*" and omitted routes do not define concrete paths.
    // - "!*" is handled separately via explicit NOT_FOUND path.
    // - "about/*" does not include "/about" by itself; concrete children come from data paths.
    if (parsed.kind === 'path') paths.add('/' + parsed.path);
    else if (parsed.kind === 'root') paths.add('/');
  }
  return paths;
}

function getWildcardBasesFromConditions(conditions) {
  const bases = new Set();
  for (const c of conditions) {
    const parsed = normalizeRouteCondition(c);
    if (parsed.kind === 'wildcard-prefix' && parsed.path) bases.add(parsed.path);
  }
  return [...bases];
}

// --- Discovery: data-driven paths (docs-style YAML group/items[].path) ------

function parseYamlPaths(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  const paths = [];
  let currentGroup = '';
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const groupMatch = line.match(/^\s*-?\s*group:\s*["']?([^"'\n]+)["']?/);
    if (groupMatch) {
      currentGroup = groupMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
      continue;
    }
    const pathMatch = line.match(/path:\s*["']?([^"'\n]+)["']?/);
    if (pathMatch && currentGroup) {
      const segment = pathMatch[1].trim();
      paths.push(`${currentGroup}/${segment}`);
    } else {
      // No group context — fall back to a bare path/slug.  Used by data files
      // whose entries are flat (e.g. articles list with `path:` per item).
      const genericPathMatch = line.match(/^\s*(?:-\s*)?(?:path|slug):\s*["']?([^"'\n#]+)["']?/);
      if (genericPathMatch) {
        const v = genericPathMatch[1].trim().replace(/^\/+|\/+$/g, '');
        if (v && !v.includes('*') && !/\.[a-z0-9]+$/i.test(v)) {
          paths.push(v);
        }
      }
    }
  }
  return paths;
}

function parseJsonPaths(filePath, sourceKey) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const paths = [];
  function collectPathSlug(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      obj.forEach((item) => {
        if (item && typeof item === 'object') {
          if (typeof item.path === 'string') paths.push(item.path);
          else if (typeof item.slug === 'string') paths.push(item.slug);
          if (item.group && Array.isArray(item.items)) {
            const group = String(item.group).toLowerCase().replace(/\s+/g, '-');
            item.items.forEach((i) => {
              if (i && typeof i.path === 'string') paths.push(`${group}/${i.path}`);
            });
          }
        }
      });
      return;
    }
    for (const v of Object.values(obj)) collectPathSlug(v);
  }
  collectPathSlug(data);
  return paths;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) {
      out.push(cur.trim().replace(/^["']|["']$/g, ''));
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim().replace(/^["']|["']$/g, ''));
  return out;
}

function parseCsvPaths(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const paths = [];
  const header = splitCsvLine(lines[0]).map((c) => c.toLowerCase());
  const pathIdx = header.indexOf('path');
  const slugIdx = header.indexOf('slug');
  const keyIdx = header.indexOf('key');
  const valIdx = header.indexOf('value');
  if (pathIdx >= 0 || slugIdx >= 0) {
    const col = pathIdx >= 0 ? pathIdx : slugIdx;
    for (let i = 1; i < lines.length; i++) {
      const row = splitCsvLine(lines[i]);
      const v = row[col];
      if (v) paths.push(v);
    }
  }
  if (keyIdx >= 0 && valIdx >= 0) {
    for (let i = 1; i < lines.length; i++) {
      const row = splitCsvLine(lines[i]);
      const key = row[keyIdx];
      const val = row[valIdx];
      if (key && (key === 'path' || key.endsWith('.path')) && val) paths.push(val);
    }
  }
  return paths;
}

function discoverDataPaths(manifest, rootDir, wildcardBases = [], locales = []) {
  const paths = new Set();
  const data = manifest.data;
  if (!data || typeof data !== 'object') return paths;
  const localeSet = new Set((locales || []).map((l) => String(l).toLowerCase()));

  function shouldIncludeDataPath(rawPath) {
    const p = String(rawPath || '').replace(/^\/+|\/+$/g, '');
    if (!p || p.includes('#') || p.includes('?') || p.includes('*')) return false;
    if (wildcardBases.length === 0) return true;
    const segs = p.split('/');
    const rest = segs.length > 1 && localeSet.has(segs[0].toLowerCase()) ? segs.slice(1).join('/') : p;
    return wildcardBases.some((base) => rest.startsWith(base + '/'));
  }

  function expandCandidates(rawPath, sourceKey) {
    const p = String(rawPath || '').replace(/^\/+|\/+$/g, '');
    if (!p) return [];
    const candidates = [p];
    if (wildcardBases.length === 0) return candidates;
    if (!sourceKey || !wildcardBases.includes(sourceKey)) return candidates;
    const parts = p.split('/');
    const hasLocalePrefix = parts.length > 1 && localeSet.has(parts[0].toLowerCase());
    if (hasLocalePrefix) {
      const locale = parts[0];
      const rest = parts.slice(1).join('/');
      if (rest && !rest.startsWith(sourceKey + '/')) candidates.push(`${locale}/${sourceKey}/${rest}`);
    } else if (!p.startsWith(sourceKey + '/')) {
      candidates.push(`${sourceKey}/${p}`);
    }
    return candidates;
  }

  function addFilePaths(value, sourceKey) {
    if (typeof value !== 'string' || !value.startsWith('/')) return;
    const filePath = join(rootDir, value.slice(1));
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      parseYamlPaths(filePath).forEach((p) => {
        for (const c of expandCandidates(p, sourceKey)) {
          if (shouldIncludeDataPath(c)) paths.add('/' + c);
        }
      });
    } else if (filePath.endsWith('.json')) {
      parseJsonPaths(filePath).forEach((p) => {
        const normalized = p.startsWith('/') ? p.slice(1) : p;
        for (const c of expandCandidates(normalized, sourceKey)) {
          if (shouldIncludeDataPath(c)) paths.add('/' + c);
        }
      });
    } else if (filePath.endsWith('.csv')) {
      parseCsvPaths(filePath).forEach((p) => {
        const normalized = p.startsWith('/') ? p.slice(1) : p;
        for (const c of expandCandidates(normalized, sourceKey)) {
          if (shouldIncludeDataPath(c)) paths.add('/' + c);
        }
      });
    }
  }

  for (const [sourceKey, value] of Object.entries(data)) {
    if (typeof value === 'string') addFilePaths(value, sourceKey);
    else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) {
        if (typeof v === 'string') addFilePaths(v, sourceKey);
      }
    }
  }
  return paths;
}

// --- Collect all paths from index + components -------------------------------

function discoverRoutes(manifest, rootDir) {
  const pathSet = new Set();
  pathSet.add('/');
  const allConditions = new Set();
  const locales = discoverLocales(manifest, rootDir);

  const indexPath = join(rootDir, 'index.html');
  if (existsSync(indexPath)) {
    const indexHtml = readFileSync(indexPath, 'utf8');
    const conditions = extractXRouteConditions(indexHtml);
    conditions.forEach((c) => allConditions.add(c));
    conditionsToPaths(conditions).forEach((p) => pathSet.add(p));
  }

  const componentDirs = [
    ...(manifest.preloadedComponents || []),
    ...(manifest.components || []),
  ];
  for (const rel of componentDirs) {
    const compPath = join(rootDir, rel);
    if (existsSync(compPath)) {
      const html = readFileSync(compPath, 'utf8');
      const conditions = extractXRouteConditions(html);
      conditions.forEach((c) => allConditions.add(c));
      conditionsToPaths(conditions).forEach((p) => pathSet.add(p));
    }
  }

  const wildcardBases = getWildcardBasesFromConditions(allConditions);
  discoverDataPaths(manifest, rootDir, wildcardBases, locales).forEach((p) => pathSet.add(p));

  const arr = [...pathSet].map((p) => (p === '/' ? '' : p.replace(/^\//, '').replace(/\/$/, '') || ''));
  return arr.includes('') ? arr : ['', ...arr.filter(Boolean)];
}

// --- Normalize path to file path (no leading slash, empty = index) -----------

function pathToFileSegments(pathname) {
  const normalized = pathname.replace(/^\//, '').replace(/\/$/, '') || '';
  return normalized ? normalized.split('/') : [];
}

function validatePrerenderedOutput(outputDir, pathList) {
  const invalidPathTokens = pathList.filter((p) => /(^|\/)[*=]/.test(p) || p.includes('/*') || p.includes('*'));
  if (invalidPathTokens.length > 0) {
    throw new Error(`prerender validation failed: invalid discovered route token(s): ${invalidPathTokens.join(', ')}`);
  }

  const badFolders = [];
  function walk(dir, rel = '') {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const seg = ent.name;
      const nextRel = rel ? `${rel}/${seg}` : seg;
      if (seg.includes('*') || seg.startsWith('=')) badFolders.push(nextRel);
      walk(join(dir, seg), nextRel);
    }
  }
  if (existsSync(outputDir)) walk(outputDir, '');
  if (badFolders.length > 0) {
    throw new Error(`prerender validation failed: invalid output folder(s): ${badFolders.join(', ')}`);
  }
}

// --- Strip dev-only injected content (e.g. browser-sync) so dist works under any server -

function stripDevOnlyContent(html) {
  let out = html
    .replace(/<script[^>]*id=["']__bs_script__["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*browser-sync[^"']*["'][^>]*>\s*<\/script>/gi, '');
  return out;
}

// --- Strip scripts injected at runtime during prerender ---
// The Manifest loader, Alpine, plugins, and third-party libraries inject
// <script> tags into the DOM during the Puppeteer render.  These must be
// removed from the serialized HTML so the loader can re-inject them fresh
// at runtime (otherwise the addScript function finds an existing tag, waits
// for a load event that already fired, and hangs forever).
//
// Approach: diff the prerendered HTML against the ORIGINAL index.html from
// disk.  Any <script src="..."> whose src does NOT appear in the original
// file was injected at runtime and must be stripped.  Inline scripts without
// src are left alone (author-written analytics snippets, etc.).
//
// This is future-proof — new framework plugins, Alpine version bumps, and
// arbitrary third-party scripts (webchat, analytics) are all handled
// automatically without maintaining a hardcoded allowlist.
let _originalScriptSrcs = null;

function buildOriginalScriptSrcSet(rootDir) {
  if (_originalScriptSrcs) return _originalScriptSrcs;
  _originalScriptSrcs = new Set();
  const indexPath = join(rootDir, 'index.html');
  if (!existsSync(indexPath)) return _originalScriptSrcs;
  const html = readFileSync(indexPath, 'utf8');
  const srcPattern = /<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = srcPattern.exec(html)) !== null) {
    _originalScriptSrcs.add(m[1]);
  }
  return _originalScriptSrcs;
}

function stripInjectedPluginScripts(html, rootDir) {
  const originals = buildOriginalScriptSrcSet(rootDir);
  // Remove every <script src="...">...</script> whose src is NOT in the
  // original index.html.  This catches all loader-injected plugins, Alpine,
  // runtime libraries (js-yaml, marked, highlight, etc.), and any third-party
  // scripts added dynamically during the render.
  return html.replace(/<script[^>]*\ssrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (full, src) => originals.has(src) ? full : ''
  );
}

function stripRuntimeTailwindArtifacts(html) {
  let out = html.replace(/\sdata-tailwind(?:=(["']).*?\1)?/gi, '');
  // Remove PlayCDN-injected runtime Tailwind stylesheet from snapshots.
  out = out.replace(/<style>\s*\/\*!\s*tailwindcss[\s\S]*?<\/style>/gi, '');
  return out;
}

// When tailwindcss isn't installed for the project, the prerender keeps the
// runtime-injected inline tailwind <style> block (it serves the static page
// for crawlers).  But we must still strip `data-tailwind` from the loader
// script tag, otherwise the runtime tailwind plugin loads at page boot and
// injects ANOTHER tailwind <style> block AFTER prerender.utilities.css,
// breaking the cascade order so .hidden wins over .lg:col etc.
function stripDataTailwindAttr(html) {
  return html.replace(/\sdata-tailwind(?:=(["']).*?\1)?/gi, '');
}

/** Prepend `<!DOCTYPE html>` unless one is already present.
 *
 * The snapshot is captured via `document.documentElement.outerHTML`, which
 * serializes only the <html> subtree and drops the document's doctype.
 * Shipping that doctype-less HTML triggers quirks mode in browsers and is
 * flagged by Lighthouse/PageSpeed.  Re-add it at write time so every emitted
 * page (Puppeteer-rendered base pages and substituted locale variants) is in
 * standards mode. */
function ensureDoctype(html) {
  return /^\s*<!doctype\b/i.test(html) ? html : `<!DOCTYPE html>\n${html}`;
}

/** Theme class de-bake + synchronous bootstrap.
 *
 * Puppeteer applies `<html class="light">` or `<html class="dark">` based on
 * the build host's system preference at prerender time.  Shipping that baked
 * class to users in the OPPOSITE preference causes a visible flash on every
 * page load (dark→light or light→dark) until the colors plugin re-evaluates.
 *
 * Fix: strip `light`/`dark` from the baked `<html class>` and inject a tiny
 * synchronous `<script>` at the top of `<head>` that sets the correct class
 * BEFORE the first paint — based on the user's `localStorage.theme` (their
 * saved preference) or `prefers-color-scheme` (their system preference).
 *
 * The color plugin (`manifest.color.js`) still runs later for reactivity
 * (Alpine bindings, click handlers, system-preference change listener), but
 * the initial paint already has the correct class so there's no flash.
 */
function debakeThemeClass(html) {
  // Strip `light`/`dark` from `<html class="...">`.  When the class attribute
  // becomes empty, drop the attribute entirely (including its leading space)
  // while preserving the rest of the `<html ...>` tag.  Bug-fixed twice — the
  // earlier version's regex captured the entire `<html ... class="...` chunk
  // so returning `''` for an empty cleaned class wiped the whole opening tag.
  let out = html.replace(/<html\b([^>]*)>/i, (full, attrs) => {
    const newAttrs = attrs.replace(/\sclass=(["'])([^"']*)\1/i, (_, q, classes) => {
      const cleaned = classes
        .split(/\s+/)
        .filter((c) => c && c !== 'light' && c !== 'dark')
        .join(' ')
        .trim();
      return cleaned ? ` class=${q}${cleaned}${q}` : '';
    });
    return `<html${newAttrs}>`;
  });
  // Inject the synchronous theme bootstrap as the FIRST element inside <head>
  // so it runs before any CSS or other scripts.  Self-contained — reads
  // localStorage + prefers-color-scheme and sets the class atomically.
  const bootstrap = `<script>(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.add(d?'dark':'light');}catch(e){document.documentElement.classList.add('light');}})();</script>`;
  if (!out.includes('id="manifest-theme-bootstrap"')) {
    // Tag the script for idempotency on rebuilds and easy debugging.
    const tagged = bootstrap.replace('<script>', '<script id="manifest-theme-bootstrap">');
    out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n  ${tagged}`);
  }
  return out;
}

/** Manifest utilities plugin: <style id="manifest-styles"> and <style id="manifest-styles-critical"> */
function extractUtilityStyleBlocks(html) {
  const blocks = [];
  let out = html.replace(
    /<style[^>]*\bid=["']manifest-styles-critical["'][^>]*>([\s\S]*?)<\/style>/gi,
    (_, css) => {
      const t = (css || '').trim();
      if (t) blocks.push({ kind: 'critical', css: t });
      return '';
    }
  );
  out = out.replace(/<style[^>]*\bid=["']manifest-styles["'][^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    const t = (css || '').trim();
    if (t) blocks.push({ kind: 'main', css: t });
    return '';
  });
  return { html: out, blocks };
}

function injectBeforeHeadClose(html, snippet) {
  if (!snippet) return html;
  const hrefMatch = snippet.match(/href=["']([^"']+)["']/);
  const href = hrefMatch ? hrefMatch[1] : null;
  let out = html;
  if (href) {
    out = out.replace(new RegExp(`\\s*<link[^>]*href=["']${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>\\s*`, 'gi'), '\n');
  }
  return out.replace(/<\/head>/i, `${snippet}\n</head>`);
}


function indexHtmlUsesTailwind(rootDir) {
  const indexPath = join(rootDir, 'index.html');
  if (!existsSync(indexPath)) return false;
  const html = readFileSync(indexPath, 'utf8');
  return /\sdata-tailwind(?:=(["']).*?\1)?/i.test(html) && /<script[^>]*manifest\.min\.js/i.test(html);
}

function promptContinueWithRuntimeTailwind(rootDir) {
  const installMsg = [
    'prerender: tailwindcss package is not installed for this project.',
    '',
    'To enable static Tailwind CSS compilation, install:',
    '  npm i -D tailwindcss @tailwindcss/cli',
    '',
    `Project: ${rootDir}`,
    '',
    'Continue prerender with runtime data-tailwind instead? [P]roceed/[E]nd (default: P): ',
  ].join('\n');
  process.stdout.write(`${installMsg}\n`);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(
      'prerender: non-interactive terminal detected; continuing with runtime data-tailwind behavior.\n'
    );
    return true;
  }
  const buf = Buffer.alloc(1);
  let answer = '';
  while (true) {
    const n = readSync(0, buf, 0, 1, null);
    if (n <= 0) break;
    const ch = buf.toString('utf8', 0, n);
    if (ch === '\n' || ch === '\r') break;
    answer += ch;
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === '' || normalized === 'p' || normalized === 'proceed' || normalized === 'y' || normalized === 'yes';
}

/**
 * Build a static Tailwind stylesheet via @tailwindcss/cli (v4+), scanning project sources.
 * Only runs when the project uses data-tailwind on the manifest script tag (auto-detected).
 * Set manifest.prerender.tailwindInput to a custom CSS entry file if needed.
 */
function runTailwindCliForPrerender(rootDir, outputDir, pre) {
  if (!indexHtmlUsesTailwind(rootDir)) return false;

  const outCss = join(outputDir, 'prerender.tailwind.css');
  try {
    require.resolve('tailwindcss', { paths: [rootDir] });
  } catch {
    const proceed = promptContinueWithRuntimeTailwind(rootDir);
    if (!proceed) {
      throw new Error('prerender aborted: install tailwindcss/@tailwindcss/cli or remove data-tailwind from your manifest script tag.');
    }
    process.stdout.write('prerender: continuing with runtime data-tailwind behavior.\n');
    return false;
  }
  let inputPath = null;
  let createdTempInput = false;
  const userInput = pre?.tailwindInput;
  if (typeof userInput === 'string' && userInput.trim()) {
    inputPath = resolve(rootDir, userInput.trim());
  }
  if (!inputPath || !existsSync(inputPath)) {
    inputPath = join(rootDir, '.mnfst-prerender-tailwind-input.css');
    writeFileSync(inputPath, '@import "tailwindcss";\n', 'utf8');
    createdTempInput = true;
  }

  const outputBasename = basename(outputDir);
  const contentGlobs = [
    '**/*.html',
    '!**/node_modules/**',
    '!**/dist/**',
    `!**/${outputBasename}/**`,
  ];

  const args = [
    '--yes',
    '@tailwindcss/cli@4',
    '-i',
    inputPath,
    '-o',
    outCss,
  ];
  for (const g of contentGlobs) {
    args.push('--content', g);
  }

  process.stdout.write('prerender: compiling Tailwind CSS (this may take a minute)...\n');
  const r = spawnSync('npx', args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (createdTempInput) {
    try {
      unlinkSync(inputPath);
    } catch {
      // ignore
    }
  }
  if (r.status !== 0) {
    console.error('prerender: Tailwind CLI failed; install with `npm i -D tailwindcss @tailwindcss/cli` or check tailwindInput in manifest.prerender.');
    if (r.stderr) console.error(r.stderr);
    if (r.stdout) console.error(r.stdout);
    return false;
  }
  if (!existsSync(outCss)) {
    console.error('prerender: Tailwind CLI did not produce prerender.tailwind.css');
    return false;
  }
  // Strip Tailwind preflight rules that conflict with Manifest's element-level
  // resets.  Tailwind's `hr { height: 0; border-top-width: 1px }` would win on
  // specificity over Manifest's `:where(hr) {...}` reset (same `@layer base`,
  // higher specificity), even when Manifest CSS loads after Tailwind.  Removing
  // the specific conflicting rules here is surgical: Tailwind's other utility
  // classes (mt-6, md:hidden, etc.) keep their normal `@layer utilities`
  // behaviour and continue to override Manifest's `*` reset as expected.
  try {
    const compiled = readFileSync(outCss, 'utf8');
    // Inside Tailwind's `@layer base { ... }` block, remove the bare `hr { ... }`
    // declaration only.  Other element resets in the same layer don't conflict
    // with Manifest's `:where()` resets (they target other elements or rely on
    // Manifest's resets winning later in source order at equal specificity).
    const stripped = compiled.replace(
      /(\s*)hr\s*\{\s*height:\s*0;\s*color:\s*inherit;\s*border-top-width:\s*1px;?\s*\}/g,
      ''
    );
    if (stripped !== compiled) {
      writeFileSync(outCss, stripped, 'utf8');
    }
  } catch (e) {
    console.warn('prerender: failed to strip conflicting Tailwind preflight rules:', e?.message || e);
  }
  process.stdout.write(`prerender: wrote ${relative(rootDir, outCss)}\n`);
  return true;
}

function mergeUtilityCssBlocks(allBlocks) {
  const critical = [];
  const main = [];
  const seenC = new Set();
  const seenM = new Set();
  for (const b of allBlocks) {
    if (b.kind === 'critical') {
      if (!seenC.has(b.css)) {
        seenC.add(b.css);
        critical.push(b.css);
      }
    } else {
      if (!seenM.has(b.css)) {
        seenM.add(b.css);
        main.push(b.css);
      }
    }
  }
  const parts = [];
  if (critical.length) parts.push('/* manifest utilities: critical */\n', critical.join('\n\n'));
  if (main.length) parts.push('/* manifest utilities */\n', main.join('\n\n'));
  return parts.join('\n');
}

function walkHtmlFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      walkHtmlFiles(p, out);
    } else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

function depthFromOutputRoot(outputDir, filePath) {
  const rel = relative(outputDir, dirname(filePath));
  if (!rel || rel === '.') return 0;
  return rel.split(sep).filter(Boolean).length;
}

/** Root-absolute path for prerender bundles (same URL from every page depth; supports manifest:router-base). */
function buildRootAssetPath(routerBasePath, filename) {
  const base = String(routerBasePath || '').replace(/^\/+|\/+$/g, '');
  const name = String(filename || '').replace(/^\/+/, '');
  const path = base ? `${base}/${name}` : name;
  return '/' + path.replace(/\/{2,}/g, '/');
}

/** Inject stylesheet link with root-absolute href (avoids ../ resolving under locale segments like /en/page/). */
function postProcessInjectStylesheetLink(outputDir, filename, routerBasePath) {
  const cssPath = join(outputDir, filename);
  if (!existsSync(cssPath)) return;
  const stat = statSync(cssPath);
  if (stat.size === 0) return;

  const href = buildRootAssetPath(routerBasePath, filename);
  const tag = `<link rel="stylesheet" href="${href}">`;
  const files = walkHtmlFiles(outputDir);
  for (const file of files) {
    let html = readFileSync(file, 'utf8');
    html = injectBeforeHeadClose(html, tag);
    writeFileSync(file, html, 'utf8');
  }
}

// --- (Removed) We used to strip x-text containing product. / feature. to avoid wrong-scope errors
//    on duplicated x-for output, but that also stripped legitimate loop body bindings (e.g. product
//    search results), breaking reactivity. If "product/feature is not defined" appears again, fix
//    the duplicate structure or scope in the template instead of neutering all such x-text.
function stripDuplicatedLoopDirectives(html) {
  return html;
}

// Returns true if the attribute string contains either the explicit `data-hydrate`
// attribute (source-authored hydrate island root) or a `data-hydrate-id` (element
// that the prerender has tagged as a runtime-restoration target).  String-level
// strip passes use this to skip elements whose attribute state will be restored
// from the hydration contract at runtime — leaving them untouched is the safest
// default even though the contract would correct most damage anyway.
function isHydrateMarkedAttrs(attrsStr) {
  if (!attrsStr) return false;
  return /\sdata-hydrate(?:-id)?(?:\s*=|[\s>])/i.test(attrsStr);
}

// --- Strip x-text and x-html that reference $x when static/SEO (content already in snapshot).
//    Do NOT strip when expression is user-driven: $route(, $search, $query. Those stay so Alpine can update.
//    Same rule for :attr in stripPrerenderDynamicBindings: bindings with $x are kept (content stays for SEO).
function stripPrerenderedXDataDirectives(html) {
  function isStatic(expr) {
    if (expr.includes('$route(')) return false;
    if (expr.includes('$search') || expr.includes('$query')) return false;
    return true;
  }
  return html.replace(/<(\w+)([^>]*)>/g, (full, tag, attrs) => {
    if (isHydrateMarkedAttrs(attrs)) return full;
    let outAttrs = attrs;
    outAttrs = outAttrs.replace(/\s+x-text="([^"]*\$x[^"]*)"/g, (match, expr) => (isStatic(expr) ? '' : match));
    outAttrs = outAttrs.replace(/\s+x-html="([^"]*\$x[^"]*)"/g, (match, expr) => (isStatic(expr) ? '' : match));
    return `<${tag}${outAttrs}>`;
  });
}

// --- Don't bake Alpine-only state into the snapshot; only $x-driven content should be prerendered.
//    For any :attr or x-bind:attr whose expression does NOT contain $x, remove the literal attr from the tag
//    so Alpine re-evaluates on load. Bindings that use $x are left as-is (content stays for SEO), except
//    :style / x-bind:style with $x: those must be removed when a baked inline style exists, or Alpine will
//    overwrite prerendered values (e.g. mask-image) on hydrate when $x is briefly empty in production.
//    Use (?<!:) so we only strip literal attr=, not :attr= (e.g. class= not :class=).
//    Never touch <script> tags (loader + injected plugins must be preserved; static HTML still runs them).
function stripPrerenderDynamicBindings(html) {
  return html.replace(/<(\w+)([^>]*)>/g, (match, tagName, attrsStr) => {
    if (tagName.toLowerCase() === 'script') return match;
    if (isHydrateMarkedAttrs(attrsStr)) return match;
    const isAnchor = tagName.toLowerCase() === 'a';
    const isImg = tagName.toLowerCase() === 'img';
    let workAttrs = attrsStr;
    workAttrs = workAttrs.replace(/\s+:style=(?:"([^"]*)"|'([^']*)')/gi, (sub, d, s) => {
      const val = (d !== undefined ? d : s) || '';
      return val.indexOf('$x') !== -1 ? '' : sub;
    });
    workAttrs = workAttrs.replace(/\s+x-bind:style=(?:"([^"]*)"|'([^']*)')/gi, (sub, d, s) => {
      const val = (d !== undefined ? d : s) || '';
      return val.indexOf('$x') !== -1 ? '' : sub;
    });

    const toStrip = new Set();
    const bindingRegex = /(?:^|\s)(?::|x-bind:)(\w+)=(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = bindingRegex.exec(workAttrs)) !== null) {
      const attrName = (m[1] || '').toLowerCase();
      // Keep href on anchors and src on images: :href / :src often reference x-for iterators (e.g.
      // article?.banner). Stripping the baked literal leaves only :src/:href and breaks static HTML.
      if (attrName === 'class' || attrName === 'style' || (isAnchor && attrName === 'href') || (isImg && attrName === 'src')) continue;
      const val = (m[2] !== undefined ? m[2] : m[3]) || '';
      if (val.indexOf('$x') === -1) toStrip.add(attrName);
    }
    if (toStrip.size === 0 && workAttrs === attrsStr) return match;
    let newAttrs = workAttrs;
    for (const attr of toStrip) {
      const esc = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      newAttrs = newAttrs.replace(new RegExp(`\\s*(?<!:)${esc}="[^"]*"`, 'gi'), '');
      newAttrs = newAttrs.replace(new RegExp(`\\s*(?<!:)${esc}='[^']*'`, 'gi'), '');
    }
    newAttrs = newAttrs.trim();
    if (newAttrs) newAttrs = ' ' + newAttrs;
    return `<${tagName}${newAttrs}>`;
  });
}

// Drop :src / x-bind:src when img already has a baked src= (x-for / iterator expressions break hydrate).
function stripRedundantImgSrcBindings(html) {
  return html.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    if (isHydrateMarkedAttrs(attrs)) return full;
    const srcM = attrs.match(/\ssrc=(["'])([\s\S]*?)\1/i);
    if (!srcM || !String(srcM[2] || '').trim()) return full;
    if (!/\s:src\s*=|\sx-bind:src\s*=/i.test(attrs)) return full;
    let next = attrs.replace(/\s:src=(?:"[^"]*"|'[^']*')/gi, '');
    next = next.replace(/\sx-bind:src=(?:"[^"]*"|'[^']*')/gi, '');
    return `<img${next}>`;
  });
}

/**
 * Manifest runtime replaces <x-*> component placeholders by fetching source .html, which wipes
 * prerender-baked markup (stripped :style, expanded lists, etc.). Tag opens with data-pre-rendered
 * are skipped by manifest.components.processor — required for static prerender output to hydrate correctly.
 */
// Prerender inlined Iconify SVG under <i x-icon="iterator.icon">; clear x-icon value so Alpine does not evaluate
// loop/item expressions while the attribute remains for CSS (e.g. inline layout that keys off [x-icon]).
function stripResolvedXIconDirectives(html) {
  return html.replace(/<i\b([^>]*)>([\s\S]*?)<\/i>/gi, (full, attrs, inner) => {
    if (isHydrateMarkedAttrs(attrs)) return full;
    if (!/\sx-icon\s*=/i.test(attrs)) return full;
    if (!/<svg\b/i.test(inner) || !/\bdata-icon\s*=/i.test(inner)) return full;
    const cleaned = attrs
      .replace(/\s+x-icon\s*=\s*"[^"]*"/gi, ' x-icon=""')
      .replace(/\s+x-icon\s*=\s*'[^']*'/gi, ' x-icon=""')
      .trim();
    const sp = cleaned ? ' ' : '';
    return `<i${sp}${cleaned}>${inner}</i>`;
  });
}

function markPrerenderedManifestComponents(html) {
  return html.replace(/<(x-[a-z][\w-]*)([^>]*)>/gi, (full, tag, attrs) => {
    const a = attrs || '';
    if (/\bdata-pre-rendered\s*=/i.test(a) || /\bdata-processed\s*=/i.test(a)) return full;
    // Inside an explicit hydrate island — the runtime will restore its
    // innerHTML to the authored source, so we must NOT tell the components
    // processor to skip re-fetching.  Leaving the placeholder unmarked lets
    // the runtime restoration reinstate the <x-*> tag and the components
    // plugin processes it normally on load.
    if (/\bdata-hydrate\b/i.test(a)) return full;
    // CRITICAL: always insert a leading space before the injected attribute.
    // For tags with no existing attributes (e.g. `<x-sidebar>`), `a` is empty
    // and concatenating directly produces `<x-sidebardata-pre-rendered=...>`,
    // which mangles the tag name and prevents the components plugin from
    // recognising it.  The trailing-space normalisation on `a` keeps the
    // output tidy when there ARE existing attributes.
    return `<${tag}${a.replace(/\s+$/, '')} data-pre-rendered="1">`;
  });
}

// Remove empty inline mask-image styles emitted before data resolves
// (e.g. style="mask-image: url()"), while keeping any :style/x-bind:style bindings.
function stripEmptyInlineMaskStyles(html) {
  return html.replace(/<(\w+)([^>]*)>/g, (full, tag, attrs) => {
    const styleMatch = attrs.match(/\sstyle=(["'])([\s\S]*?)\1/i);
    if (!styleMatch) return full;
    const quote = styleMatch[1];
    const rawStyle = styleMatch[2] || '';
    const cleaned = rawStyle
      .replace(/\bmask-image\s*:\s*url\(\s*(?:''|""|)\s*\)\s*;?/gi, '')
      .replace(/\b-webkit-mask-image\s*:\s*url\(\s*(?:''|""|)\s*\)\s*;?/gi, '')
      .trim()
      .replace(/^\s*;\s*|\s*;\s*$/g, '');

    if (!cleaned) {
      const newAttrs = attrs.replace(/\sstyle=(["'])[\s\S]*?\1/i, '');
      return `<${tag}${newAttrs}>`;
    }
    const rebuilt = attrs.replace(/\sstyle=(["'])[\s\S]*?\1/i, ` style=${quote}${cleaned}${quote}`);
    return `<${tag}${rebuilt}>`;
  });
}

// --- Rewrite asset URLs: depth = segments from this HTML file up to output root (website). ----
// All project assets are copied into output, so root-relative paths become relative within output.
// Do NOT rewrite href on <a> tags (navigation links); only rewrite link/script/img so router gets clean paths.

function isPrerenderBundleAssetPath(pathAfterSlash) {
  return /(^|\/)prerender\.(tailwind|utilities)\.css$/.test(pathAfterSlash);
}

function rewriteHtmlAssetPaths(html, depthWithinOutput) {
  const prefix = depthWithinOutput > 0 ? '../'.repeat(depthWithinOutput) : '';
  if (!prefix) return html;
  function isAnchorTag(htmlBeforeMatch) {
    const lastOpen = htmlBeforeMatch.lastIndexOf('<');
    if (lastOpen === -1) return false;
    const tag = htmlBeforeMatch.slice(lastOpen + 1).match(/^(\w+)/);
    return tag && tag[1].toLowerCase() === 'a';
  }
  let out = html.replace(/(\s(href|src)=["'])\/(?!\/)([^'"]*)/g, (match, lead, _attr, rest, offset, fullString) => {
    if (isAnchorTag(fullString.slice(0, offset))) return match;
    if (isPrerenderBundleAssetPath(rest)) return match;
    return lead + prefix + rest;
  });
  out = out.replace(/(\s(href|src)=["'])(\.\.\/)+/g, (match, lead, attr, dots, offset, fullString) => {
    if (isAnchorTag(fullString.slice(0, offset))) return match;
    return lead + prefix;
  });
  return out;
}

// Alpine x-data drives radio state; baked checked="" from the live DOM (e.g. yearly) fights monthly defaults.
function stripPrerenderBakedRadioCheckedForXModel(html) {
  return html.replace(/<input\b([^>]*)>/gi, (full, attrs) => {
    if (!/\btype\s*=\s*["']radio["']/i.test(attrs)) return full;
    if (!/\bx-model\s*=/i.test(attrs)) return full;
    const next = attrs.replace(/\s+checked(?:\s*=\s*["'][^"']*["']|\s*=\s*[^\s>]+)?/gi, '');
    if (next === attrs) return full;
    return `<input${next}>`;
  });
}

// --- Canonical and hreflang (per-page injection) ---

function buildCanonicalAndHreflang(pathSeg, locales, defaultLocale, base) {
  const baseClean = base.replace(/\/$/, '');
  const defaultLoc = defaultLocale || locales[0];
  const isDefaultLocalePrefixed =
    defaultLoc && (pathSeg === defaultLoc || pathSeg.startsWith(defaultLoc + '/'));
  const canonicalPath =
    isDefaultLocalePrefixed
      ? pathSeg === defaultLoc
        ? ''
        : pathSeg.slice(defaultLoc.length + 1)
      : pathSeg;
  const canonicalHref = canonicalPath === '' ? `${baseClean}/` : `${baseClean}/${canonicalPath}`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  let out = `<link rel="canonical" href="${esc(canonicalHref)}">\n`;
  if (locales.length > 1) {
    const currentLocale = locales.find((l) => pathSeg === l || pathSeg.startsWith(l + '/')) || defaultLoc;
    const logicalRoute =
      currentLocale === defaultLoc
        ? pathSeg === defaultLoc
          ? ''
          : pathSeg.startsWith(defaultLoc + '/')
            ? pathSeg.slice(defaultLoc.length + 1)
            : pathSeg
        : pathSeg === currentLocale
          ? ''
          : pathSeg.slice(currentLocale.length + 1);
    locales.forEach((loc) => {
      const seg = loc === defaultLoc ? logicalRoute : (logicalRoute ? `${loc}/${logicalRoute}` : loc);
      const href = baseClean + (seg ? `/${seg}` : '');
      const hreflang = loc === defaultLoc ? 'x-default' : loc;
      out += `  <link rel="alternate" hreflang="${esc(hreflang)}" href="${esc(href)}">\n`;
    });
  }
  return out;
}

/** Same alternate URLs as buildCanonicalAndHreflang; used for sitemap xhtml:link entries. */
function getAlternateLinksForPath(pathSeg, locales, defaultLocale, base) {
  const baseClean = base.replace(/\/$/, '');
  const defaultLoc = defaultLocale || locales[0];
  if (!locales || locales.length <= 1) return [];
  const currentLocale = locales.find((l) => pathSeg === l || pathSeg.startsWith(l + '/')) || defaultLoc;
  const logicalRoute =
    currentLocale === defaultLoc
      ? pathSeg === defaultLoc
        ? ''
        : pathSeg.startsWith(defaultLoc + '/')
          ? pathSeg.slice(defaultLoc.length + 1)
          : pathSeg
      : pathSeg === currentLocale
        ? ''
        : pathSeg.slice(currentLocale.length + 1);
  const entries = [];
  locales.forEach((loc) => {
    const seg = loc === defaultLoc ? logicalRoute : (logicalRoute ? `${loc}/${logicalRoute}` : loc);
    const href = baseClean + (seg ? `/${seg}` : '');
    const hreflang = loc === defaultLoc ? 'x-default' : loc;
    entries.push({ hreflang, href });
  });
  return entries;
}

function escapeXmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildOgLocale(pathSeg, locales, defaultLocale) {
  if (locales.length <= 1) return '';
  const defaultLoc = defaultLocale || locales[0];
  const currentLocale = locales.find((l) => pathSeg === l || pathSeg.startsWith(l + '/')) || defaultLoc;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const toOgLocale = (loc) => (loc.indexOf('-') !== -1 ? loc.replace(/-/g, '_').toLowerCase() : loc.toLowerCase());
  let out = `<meta property="og:locale" content="${esc(toOgLocale(currentLocale))}">\n`;
  locales.forEach((loc) => {
    if (loc !== currentLocale) out += `  <meta property="og:locale:alternate" content="${esc(toOgLocale(loc))}">\n`;
  });
  return out;
}

function stripOgLocaleFromHead(html) {
  return html.replace(/\s*<meta[^>]*property="og:locale(?::alternate)?"[^>]*>\s*/gi, '');
}

function hasOtherOgMeta(html) {
  return /<meta[^>]*property="og:(?!locale(?::alternate)?")[^"]*"[^>]*>/i.test(html);
}

// --- Locale text substitution (Node.js post-processing — no Puppeteer for locale variants) ------

/**
 * Load the key→value content data for every locale from every CSV that has locale columns.
 * Returns Map<locale, { key: value }>.
 */
function loadAllLocaleContentData(manifest, rootDir, locales) {
  const data = manifest?.data;
  if (!data || typeof data !== 'object') return new Map();

  // Lazy-load js-yaml for parsing per-locale YAML files
  let jsYaml = null;
  try { jsYaml = require('js-yaml'); } catch { /* yaml not available; YAML locale files will be skipped */ }

  // Deep-merge source into target (for combining multiple data sources per locale)
  function deepMerge(target, source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        target[key] = (target[key] && typeof target[key] === 'object') ? target[key] : {};
        deepMerge(target[key], source[key]);
      } else {
        // Don't overwrite an existing nested object with a primitive — that creates
        // type asymmetry across locales and causes '[object Object]' in substitution pairs
        if (target[key] && typeof target[key] === 'object') continue;
        target[key] = source[key];
      }
    }
  }

  const result = new Map();
  for (const locale of locales) result.set(locale, {});

  // Read just the header row of a CSV to check which locale columns it contains.
  function csvLocaleColumns(csvPath) {
    if (!existsSync(csvPath)) return new Set();
    try {
      const firstLine = readFileSync(csvPath, 'utf8').split(/\r?\n/)[0] || '';
      return new Set(splitCsvLine(firstLine).slice(1)); // skip key column
    } catch { return new Set(); }
  }

  for (const [, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      // Single CSV with locale columns (all locales in one file)
      if (value.endsWith('.csv')) {
        const csvPath = join(rootDir, value.startsWith('/') ? value.slice(1) : value);
        const cols = csvLocaleColumns(csvPath);
        for (const locale of locales) {
          // Only include locales the CSV actually declares; falling back to the English
          // column for a missing locale silently poisons substitution pairs with English values.
          if (!cols.has(locale)) continue;
          deepMerge(result.get(locale), parseCsvToKeyValue(csvPath, locale));
        }
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.locales) {
        // { locales: "/path/to/multi-locale.csv" } format
        const refs = Array.isArray(value.locales) ? value.locales : [value.locales];
        for (const ref of refs) {
          if (typeof ref !== 'string' || !ref.endsWith('.csv')) continue;
          const csvPath = join(rootDir, ref.startsWith('/') ? ref.slice(1) : ref);
          const cols = csvLocaleColumns(csvPath);
          for (const locale of locales) {
            if (!cols.has(locale)) continue;
            deepMerge(result.get(locale), parseCsvToKeyValue(csvPath, locale));
          }
        }
      } else {
        // Per-locale files: { "en": "/data/content.en.yaml", "fr": "/data/content.fr.yaml", ... }
        for (const [localeKey, filePath] of Object.entries(value)) {
          if (!locales.includes(localeKey) || typeof filePath !== 'string') continue;
          const fullPath = join(rootDir, filePath.startsWith('/') ? filePath.slice(1) : filePath);
          if (!existsSync(fullPath)) continue;
          let localeData = null;
          try {
            const raw = readFileSync(fullPath, 'utf8');
            if ((filePath.endsWith('.yaml') || filePath.endsWith('.yml')) && jsYaml) {
              localeData = jsYaml.load(raw);
            } else if (filePath.endsWith('.json')) {
              localeData = JSON.parse(raw);
            } else if (filePath.endsWith('.csv')) {
              localeData = parseCsvToKeyValue(fullPath, localeKey);
            }
          } catch { /* ignore parse errors for individual locale files */ }
          if (localeData && typeof localeData === 'object') {
            deepMerge(result.get(localeKey), localeData);
          }
        }
      }
    }
  }

  return result;
}

/**
 * Build [[defaultValue, targetValue], ...] replacement pairs sorted longest-first.
 * Skips empty strings and identical pairs to reduce noise.
 */
function buildSubstitutionPairs(defaultLocaleData, targetLocaleData) {
  const pairs = [];
  function collectPairs(defaultObj, targetObj) {
    if (!defaultObj || !targetObj) return;
    for (const key of Object.keys(defaultObj)) {
      const defaultVal = defaultObj[key];
      const targetVal = targetObj[key];
      if (defaultVal && typeof defaultVal === 'object') {
        // Recurse into nested objects (produced by setNestedKey for dotted CSV keys)
        collectPairs(defaultVal, targetVal && typeof targetVal === 'object' ? targetVal : {});
      } else {
        // Skip if target is a non-primitive — String(obj) === '[object Object]' is never useful
        if (targetVal !== null && typeof targetVal === 'object') continue;
        const from = String(defaultVal ?? '').trim();
        const to = String(targetVal ?? '').trim();
        if (!from || from === to) continue;
        pairs.push([from, to]);
      }
    }
  }
  collectPairs(defaultLocaleData, targetLocaleData);
  // Sort longest-first so more specific strings are replaced before shorter substrings
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

/**
/**
 * Prefix internal navigation links with the target locale so that prerendered
 * MPA pages link directly to the correct locale variant (e.g. /platform →
 * /fr/platform on the French page).  Without this, users must rely on runtime
 * JS interception (`installMpaStickyLocaleLinks`) which may not be ready by
 * the time they click — causing navigation to fall back to English.
 *
 * Only rewrites `<a href="...">` where the href is a root-relative path that
 * doesn't already carry a locale prefix and isn't an excluded route.
 */
function prefixLocaleInternalLinks(html, locale, locales, localeRouteExclude) {
  if (!locale || !locales || !locales.length) return html;
  const localeSet = new Set(locales);
  const excludeSet = new Set(localeRouteExclude || []);

  // Match <a ... href="..." ...>  — capture the href value
  return html.replace(
    /(<a\b[^>]*\shref=["'])(\/?[^"'#][^"']*)(["'][^>]*>)/gi,
    (full, prefix, href, suffix) => {
      // Only process root-relative paths
      if (!href.startsWith('/')) return full;
      // Skip external protocols embedded as relative (shouldn't happen but guard)
      if (/^\/\//.test(href)) return full;

      const withoutSlash = href.replace(/^\//, '');
      const firstSeg = withoutSlash.split('/')[0].split('#')[0].split('?')[0];

      // Already has a locale prefix
      if (localeSet.has(firstSeg)) return full;

      // Skip asset-like paths
      if (/\.(css|js|json|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|pdf|xml|txt)$/i.test(href)) return full;

      // Respect localeRouteExclude — these routes stay locale-neutral
      if (excludeSet.has(firstSeg)) return full;

      // Prefix with locale
      return `${prefix}/${locale}${href}${suffix}`;
    }
  );
}

/**
 * Apply locale text substitution to rendered HTML.
 * Replaces content in text nodes (between > and <) and in key attributes:
 * content, alt, title, placeholder, aria-label.
 */
function applyLocaleSubstitution(html, pairs) {
  if (!pairs || !pairs.length) return html;

  // 1. Text nodes: walk content between '>' and '<'
  let out = '';
  let pos = 0;
  while (pos < html.length) {
    const gtPos = html.indexOf('>', pos);
    if (gtPos === -1) { out += html.slice(pos); break; }
    const ltPos = html.indexOf('<', gtPos + 1);
    if (ltPos === -1) { out += html.slice(pos); break; }
    out += html.slice(pos, gtPos + 1);
    let text = html.slice(gtPos + 1, ltPos);
    if (text.trim()) {
      for (const [from, to] of pairs) {
        if (text.includes(from)) text = text.split(from).join(to);
      }
    }
    out += text;
    pos = ltPos;
  }

  // 2. Selected attributes that carry visible text
  out = out.replace(
    /(\s(?:content|alt|title|placeholder|aria-label)=["'])([^"']*)(['"])/g,
    (match, prefix, val, suffix) => {
      let v = val;
      for (const [from, to] of pairs) {
        if (v.includes(from)) v = v.split(from).join(to);
      }
      return `${prefix}${v}${suffix}`;
    }
  );

  return out;
}

/**
 * Generate a locale variant's HTML entirely in Node.js from a cached base-path DOM snapshot.
 * Applies text substitution then the full Node.js post-processing pipeline.
 * Returns { html, utilityBlocks }.
 */
function generateLocaleVariantHtml({
  rawHtml, pathSeg, targetLocale, locales, defaultLocale,
  config, manifest, routerBasePath, tailwindBuilt, bundleUtilities,
  substitutionPairs,
}) {
  let html = rawHtml;

  // Update lang attribute before resolveHeadXBindings so it sees the right locale
  html = html.replace(/(<html\b[^>]*)\s+lang=["'][^"']*["']/i, `$1 lang="${targetLocale}"`);
  if (!/<html\b[^>]*\slang=/i.test(html)) {
    html = html.replace(/(<html\b)/i, `$1 lang="${targetLocale}"`);
  }

  // Apply locale text substitution
  html = applyLocaleSubstitution(html, substitutionPairs);

  // Prefix internal <a> links with the locale so MPA navigation stays in-locale
  // without relying on runtime JS interception.
  if (targetLocale && targetLocale !== defaultLocale) {
    html = prefixLocaleInternalLinks(html, targetLocale, locales, config.localeRouteExclude);
  }

  // Standard Node.js post-processing (same sequence as processPath)
  html = stripDevOnlyContent(html);
  html = stripInjectedPluginScripts(html, config.root);
  if (tailwindBuilt) {
    html = stripRuntimeTailwindArtifacts(html);
  } else {
    html = stripDataTailwindAttr(html);
  }
  html = debakeThemeClass(html);

  const pageUtilityBlocks = [];
  if (bundleUtilities) {
    const extracted = extractUtilityStyleBlocks(html);
    html = extracted.html;
    for (const b of extracted.blocks) pageUtilityBlocks.push(b);
  }

  if (tailwindBuilt) {
    html = injectBeforeHeadClose(
      html,
      `<link rel="stylesheet" href="${buildRootAssetPath(routerBasePath, 'prerender.tailwind.css')}">`
    );
  }

  html = stripDuplicatedLoopDirectives(html);
  html = stripPrerenderedXDataDirectives(html);

  const content = loadContentForPrerender(manifest, config.root, targetLocale);
  html = resolveHeadXBindings(html, { manifest, content });

  html = stripPrerenderDynamicBindings(html);
  html = stripPrerenderBakedRadioCheckedForXModel(html);
  html = stripRedundantImgSrcBindings(html);
  html = stripEmptyInlineMaskStyles(html);
  html = stripResolvedXIconDirectives(html);
  // markPrerenderedManifestComponents must run BEFORE stripPrerenderHydrateMarkers so it can
  // detect data-hydrate markers and skip components inside hydrate islands.
  html = markPrerenderedManifestComponents(html);

  const fileSegments = pathToFileSegments(pathSeg ? '/' + pathSeg : '/');
  html = rewriteHtmlAssetPaths(html, fileSegments.length);

  const liveBase = config.liveUrl.replace(/\/$/, '');
  const canonicalHreflang = buildCanonicalAndHreflang(pathSeg, locales, defaultLocale, liveBase);
  const ogLocale = buildOgLocale(pathSeg, locales, defaultLocale);
  const injectOgLocale = ogLocale && hasOtherOgMeta(html);
  if (injectOgLocale) html = stripOgLocaleFromHead(html);

  const routeEx = config.localeRouteExclude || [];
  const routeMeta = routeEx.length > 0
    ? `<meta name="manifest:locale-route-exclude" content="${JSON.stringify(routeEx).replace(/"/g, '&quot;')}">\n`
    : '';
  const baseMeta = routerBasePath !== null
    ? `<meta name="manifest:router-base" content="${String(routerBasePath).replace(/"/g, '&quot;')}">\n`
    : '';
  const routeDepth = fileSegments.length;
  // List of locales that actually have prerendered URL paths, so the runtime
  // localization plugin knows when a locale switch should navigate vs stay on
  // the current page (e.g. example switches in docs that use locale-aware data
  // sources without the host site being multilingual).
  const prerenderLocalesMeta =
    Array.isArray(locales) && locales.length > 0
      ? `<meta name="manifest:prerender-locales" content="${locales.join(',')}">\n`
      : '';

  html = html.replace(
    '</head>',
    `${canonicalHreflang}${injectOgLocale ? ogLocale : ''}${routeMeta}${baseMeta}${prerenderLocalesMeta}<meta name="manifest:prerendered" content="1">\n<meta name="manifest:router-base-depth" content="${routeDepth}">\n</head>`
  );

  return { html, utilityBlocks: pageUtilityBlocks };
}

// --- Resolve $x bindings in <head> (data-head meta/link are injected with :attr="$x.path" but never evaluated) ---

function loadContentForPrerender(manifest, rootDir, locale) {
  const data = manifest?.data?.content;
  if (!data) return {};
  const loc = locale || 'en';
  let content = {};
  if (typeof data === 'string' && data.endsWith('.csv')) {
    content = parseCsvToKeyValue(join(rootDir, data.slice(1)), loc);
  } else if (data && typeof data === 'object' && data.locales && typeof data.locales === 'string') {
    content = parseCsvToKeyValue(join(rootDir, data.locales.slice(1)), loc);
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    // Per-locale files: { "en": "/data/content.en.yaml", "fr": "/data/content.fr.yaml", ... }
    const filePath = data[loc] || data[Object.keys(data)[0]];
    if (typeof filePath === 'string') {
      const fullPath = join(rootDir, filePath.startsWith('/') ? filePath.slice(1) : filePath);
      if (existsSync(fullPath)) {
        try {
          const raw = readFileSync(fullPath, 'utf8');
          if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
            let jsYaml = null;
            try { jsYaml = require('js-yaml'); } catch { /* skip */ }
            if (jsYaml) content = jsYaml.load(raw) || {};
          } else if (filePath.endsWith('.json')) {
            content = JSON.parse(raw);
          } else if (filePath.endsWith('.csv')) {
            content = parseCsvToKeyValue(fullPath, loc);
          }
        } catch { /* ignore parse errors */ }
      }
    }
  }
  if (manifest.description !== undefined && content.description === undefined) {
    content.description = manifest.description;
  }
  return content;
}

function parseCsvToKeyValue(filePath, valueLocale) {
  if (!existsSync(filePath)) return {};
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return {};
  const header = splitCsvLine(lines[0]);
  const keyCol = header[0];
  const valueCol = header.includes(valueLocale) ? valueLocale : (header[1] || header[0]);
  const keyIdx = 0;
  const valueIdx = header.indexOf(valueCol);
  if (valueIdx === -1) return {};
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const row = splitCsvLine(lines[i]);
    const key = row[keyIdx];
    const value = row[valueIdx];
    if (key == null) continue;
    setNestedKey(result, key.trim(), value != null ? String(value).trim() : '');
  }
  return result;
}

function setNestedKey(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    const next = parts[i + 1];
    const nextIsIndex = /^\d+$/.test(next);
    if (!(p in cur) || typeof cur[p] !== 'object') {
      cur[p] = nextIsIndex ? [] : {};
    } else if (nextIsIndex && !Array.isArray(cur[p]) && cur[p] && typeof cur[p] === 'object') {
      const existing = cur[p];
      const keys = Object.keys(existing);
      const numericOnly = keys.every((k) => /^\d+$/.test(k));
      if (numericOnly) {
        const arr = [];
        keys.forEach((k) => {
          arr[parseInt(k, 10)] = existing[k];
        });
        cur[p] = arr;
      }
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function getXPath(obj, path) {
  const parts = path.replace(/^\.+/, '').split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function resolveHeadXBindings(html, xData) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return html.replace(/<head>([\s\S]*?)<\/head>/i, (_, headContent) => {
    // Process each tag in <head> that has a :attr or x-bind:attr binding
    const out = headContent.replace(/<[^>]+>/g, (tag) => {
      // Find all :attr="$x...." or x-bind:attr="$x...." bindings in this tag
      const bindingRe = /\s(?::|x-bind:)(\w+)=["'](\$x\.[^"']+)["']/g;
      let m;
      let newTag = tag;
      while ((m = bindingRe.exec(tag)) !== null) {
        const attr = m[1];
        const expr = m[2];
        const path = expr.replace(/^\$x\./, '').trim();
        const value = getXPath(xData, path);
        if (value === undefined) continue;
        // Remove the binding
        newTag = newTag.replace(m[0], '');
        // Remove existing static fallback for this attr
        newTag = newTag.replace(new RegExp(`\\s${attr}=["'][^"']*["']`), '');
        // Insert the resolved attr before the closing >
        newTag = newTag.replace(/>$/, ` ${attr}="${esc(value)}">`);
      }
      return newTag;
    });
    return `<head>${out}</head>`;
  });
}

// --- SEO: per-route OG image auto-snapshot --------------------------------
//
// When prerender.meta.imageSnapshots is true (the default) and no other source
// has provided an og:image (data-head, prerender.meta.image, or prerender.meta
// .fallback.image), capture a 1200×630 PNG of the rendered page and use that as
// the og:image / twitter:image.  Saved to <output>/og/<sanitized-path>.png.
//
// 1200×630 is the OpenGraph / Twitter / LinkedIn recommended dimension.

const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/**
 * Hash of the project-wide assets that affect every page's visual output
 * (theme CSS, manifest config, root HTML shell).  Computed once per prerender
 * run and folded into each route's snapshot-cache key so that touching any of
 * these invalidates every cached OG image — a more correct behaviour than
 * per-route source-mtime caching, which would miss shared-chrome changes.
 *
 * Files included are conventional Manifest project assets that influence
 * layout/theme; missing files are recorded as the literal `missing` so the
 * hash still differs from an installation that has the file present.
 */
function computeGlobalAssetSignature(rootDir) {
  const candidates = [
    'manifest.json',
    'manifest.theme.css',
    'manifest.utilities.css',
    'index.html',
  ];
  const parts = candidates.map((rel) => {
    const p = join(rootDir, rel);
    try {
      return `${rel}:${sha(readFileSync(p, 'utf8'))}`;
    } catch {
      return `${rel}:missing`;
    }
  });
  return sha(parts.join('|'));
}

/**
 * Snapshot the page at 1200×630 and write to <output>/og/<slug>.png.  Cache
 * sidecar lives in <root>/.mnfst-cache/og/ — outside the output dir, which is
 * wiped at the start of every prerender.  On cache hit, the cached PNG is
 * copied into the output dir and the screenshot is skipped — saves ~0.2–0.5s
 * per hit, which adds up across hundreds of routes × locales.  Hash inputs:
 *   - globalAssetSignature (theme CSS / manifest config / root HTML)
 *   - body outerHTML, normalised to strip non-visual volatile attributes
 *   - html.className (theme variant: light/dark/etc.)
 */
async function takeOgSnapshot(page, outputDir, pathSeg, globalAssetSignature, cacheDir) {
  const fileSeg = pathSeg === '' || pathSeg === '__404__'
    ? 'index'
    : pathSeg.replace(/\//g, '-').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ogDir = join(outputDir, 'og');
  try { mkdirSync(ogDir, { recursive: true }); } catch { /* exists */ }
  const filePath = join(ogDir, `${fileSeg}.png`);
  // Cache locations — outside the output dir so they survive the per-run
  // rmSync.  cacheDir is .mnfst-cache/og under the project root.
  const cachePngPath = cacheDir ? join(cacheDir, `${fileSeg}.png`) : null;
  const cacheHashPath = cacheDir ? join(cacheDir, `${fileSeg}.hash`) : null;

  // Cache lookup: fingerprint the rendered DOM and check against the stored
  // hash.  The fingerprint normalises away attribute values assigned in
  // iteration order (data-hydrate-id, data-component-N) and randomly-generated
  // CSS anchor-name positioning IDs.  Without normalisation the hash would
  // never match across runs and the cache would always miss.
  let contentHash = null;
  try {
    const fingerprint = await page.evaluate(() => {
      const body = document.body?.outerHTML || '';
      const htmlClass = document.documentElement?.className || '';
      const normalised = body
        .replace(/\sdata-hydrate-id="[^"]*"/g, '')
        .replace(/\sdata-component="[^"]*"/g, '')
        .replace(/\sdata-pre-rendered="[^"]*"/g, '')
        .replace(/\sid="(?:tab-|code-)[^"]*"/g, '')
        .replace(/\saria-controls="(?:code-)[^"]*"/g, '')
        .replace(/\saria-labelledby="(?:tab-)[^"]*"/g, '')
        // CSS anchor-positioning IDs (e.g. `--dropdown-zc7nofh3c`) are
        // regenerated per run by the dropdown/popover system.
        .replace(/--dropdown-[a-z0-9]+/g, '--dropdown-X')
        .replace(/--popover-[a-z0-9]+/g, '--popover-X')
        .replace(/--anchor-[a-z0-9]+/g, '--anchor-X');
      return normalised + '\n@html:' + htmlClass;
    });
    contentHash = sha(`${globalAssetSignature || ''}|${fingerprint}`);
    if (cachePngPath && existsSync(cachePngPath) && existsSync(cacheHashPath)) {
      const stored = readFileSync(cacheHashPath, 'utf8').trim();
      if (stored === contentHash) {
        // Cache hit — copy the cached PNG into the output dir.  We still need
        // a copy in /og/ so the served site has it; the cache just lets us
        // skip the screenshot + PNG-encode work.
        try {
          cpSync(cachePngPath, filePath);
          return `/og/${fileSeg}.png`;
        } catch { /* copy failure — fall through to fresh snapshot */ }
      }
    }
  } catch { /* hash failure is non-fatal — fall through to fresh snapshot */ }

  try {
    // Viewport stays at the page-creation default (1200×800).  Clipping a
    // 1200×630 region from the top gives the OG/Twitter card aspect ratio
    // without forcing a layout reflow that would invalidate Chromium's
    // compositor frame — pages whose hero relies on viewport-height (e.g.
    // body min-h-screen + flex grow) can otherwise screenshot as blank if
    // the compositor doesn't repaint between setViewport and screenshot.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: filePath,
      type: 'png',
      clip: { x: 0, y: 0, width: 1200, height: 630 },
      omitBackground: false,
      captureBeyondViewport: false,
    });
    // Sanity check: a blank 1200×630 PNG (header only, white body) is ~8–10KB;
    // a content-rich page is 50KB+.  When the resulting file is suspiciously
    // small the snapshot is treated as failed and the renderer falls through
    // to other og:image sources (manifest icon, first content <img>).  15KB
    // is a safe floor that catches blank/header-only snapshots without false
    // positives for legitimately simple pages.
    try {
      const sz = statSync(filePath).size;
      if (sz < 15 * 1024) {
        unlinkSync(filePath);
        // Drop the cache too so the next run doesn't trust it.
        if (cachePngPath) { try { unlinkSync(cachePngPath); } catch { /* missing is fine */ } }
        if (cacheHashPath) { try { unlinkSync(cacheHashPath); } catch { /* missing is fine */ } }
        return null;
      }
    } catch { /* stat failure is non-fatal */ }
    // Populate the cache: copy the fresh PNG into the cache dir and write the
    // content hash sidecar.  Hash failure earlier leaves contentHash null —
    // in that case we don't cache (correct fallback: prefer to re-snapshot
    // than to claim a stale cache is valid).
    if (cacheDir && contentHash) {
      try { mkdirSync(cacheDir, { recursive: true }); } catch { /* exists */ }
      try { cpSync(filePath, cachePngPath); } catch { /* ignore */ }
      try { writeFileSync(cacheHashPath, contentHash, 'utf8'); } catch { /* ignore */ }
    }
    return `/og/${fileSeg}.png`;
  } catch (e) {
    // Failures here are non-fatal — fall back to whatever other og:image source
    // is available (manifest icon, first content <img>, etc.).
    console.error(`prerender: og snapshot failed for /${pathSeg || ''}: ${e?.message || e}`);
    return null;
  }
}

// --- SEO: per-route meta + structured data injection ----------------------
//
// Runs in the live page right before HTML serialization.  Layers (highest
// precedence first; each layer only fills slots not yet present):
//
//   1. <template data-head> per-route — already in the head by snapshot time
//   2. <head> in index.html — already in the head by snapshot time
//   3. prerender.meta.* expressions — Alpine-evaluated against the live page
//   4. prerender.meta.fallback.* — static strings used when expressions are empty
//   5. PWA-style manifest.json fields (name, description, author, icons)
//   6. Smart defaults from the rendered DOM (h1, first p, first img, etc.)
//
// "Slot taken" detection is by selector: <title>, <meta name=>, <meta property=>.
// An empty <title></title> or one matching manifest.json "name" counts as
// missing (placeholder rule), so smart defaults can fill route-specific titles
// without the author having to clear the static <title> in index.html.
//
// JSON-LD blocks (WebSite, Article, BreadcrumbList) follow the same pattern:
// only inject if no <script type="application/ld+json"> already covers that
// schema type for the route.
async function injectMetaInDom(page, ctx) {
  await page.evaluate((ctx) => {
    const head = document.head;
    if (!head) return;

    // --- Helpers ---------------------------------------------------------

    const SOCIAL_PREFIXES = /^(og:|twitter:|article:|fb:)/;

    const findMeta = (key) => {
      // Selectors are case-sensitive in querySelector; meta name/property are case-insensitive
      // in HTML but always written lowercase by us.  Cover both attribute styles.
      return head.querySelector(`meta[name="${key}"], meta[property="${key}"]`);
    };

    // Slots are "open" if missing, OR if their content equals a known site-wide
    // placeholder (manifest.json's name/description).  Mirrors the title rule so
    // existing projects with hardcoded site-default meta in index.html still get
    // route-specific values from smart defaults.  Per-tag placeholder map:
    const PLACEHOLDER = {
      description: ctx.seo.siteDescription,
    };
    const slotIsOpen = (key, existingEl) => {
      if (!existingEl) return true;
      const current = (existingEl.getAttribute('content') || '').trim();
      if (!current) return true;
      const placeholder = PLACEHOLDER[key];
      return placeholder && current === placeholder;
    };
    const setMeta = (key, content) => {
      if (content == null) return false;
      const str = String(content).trim();
      if (!str) return false;
      const existing = findMeta(key);
      if (!slotIsOpen(key, existing)) return false;
      if (existing) {
        existing.setAttribute('content', str);
      } else {
        const m = document.createElement('meta');
        m.setAttribute(SOCIAL_PREFIXES.test(key) ? 'property' : 'name', key);
        m.setAttribute('content', str);
        head.appendChild(m);
      }
      return true;
    };

    const getCurrentTitle = () => {
      const el = head.querySelector('title');
      return { el, text: el ? (el.textContent || '').trim() : '' };
    };

    const titleSlotIsOpen = () => {
      const { text } = getCurrentTitle();
      if (!text) return true;
      // Equals manifest.name → treat as placeholder (the static <title>Site</title>
      // pattern in starter templates).  Allows smart-defaults to inject a
      // route-specific title without the author having to wipe the static tag.
      if (ctx.seo.siteName && text === ctx.seo.siteName) return true;
      return false;
    };

    const setTitle = (text) => {
      if (!text) return false;
      if (!titleSlotIsOpen()) return false;
      const trimmed = String(text).trim();
      if (!trimmed) return false;
      const { el } = getCurrentTitle();
      if (el) el.textContent = trimmed;
      else {
        const t = document.createElement('title');
        t.textContent = trimmed;
        head.appendChild(t);
      }
      return true;
    };

    const evalAlpine = (expr) => {
      if (typeof expr !== 'string' || !expr.trim()) return null;
      try {
        const A = window.Alpine;
        if (!A || typeof A.evaluate !== 'function') return null;
        const v = A.evaluate(document.body, expr);
        if (v == null) return null;
        const s = typeof v === 'string' ? v : String(v);
        return s.trim() || null;
      } catch { return null; }
    };

    const truncate = (s, max) => {
      const t = String(s).replace(/\s+/g, ' ').trim();
      if (t.length <= max) return t;
      // Cut at the last word boundary before max-3 to leave room for ellipsis.
      const sliced = t.slice(0, max - 1);
      const lastSpace = sliced.lastIndexOf(' ');
      const base = lastSpace > max * 0.6 ? sliced.slice(0, lastSpace) : sliced;
      return base + '…';
    };

    // --- Smart defaults (DOM derivation) ---------------------------------

    const smartDefaults = (() => {
      if (!ctx.seo.defaults) return {};
      // Title source: first <h1> inside <main>/<article>, then any <h1>.
      const h1El = document.querySelector('main h1, article h1') || document.querySelector('h1');
      const h1 = h1El ? (h1El.textContent || '').trim() : '';
      const composedTitle = (() => {
        if (!h1) return ctx.seo.siteName || null;
        if (!ctx.seo.siteName || h1 === ctx.seo.siteName) return h1;
        return `${h1} — ${ctx.seo.siteName}`;
      })();

      // Description: first non-trivial <p> in main/article content.
      const descCandidates = document.querySelectorAll('main p, article p, .prose p');
      let desc = '';
      for (const p of descCandidates) {
        const text = (p.textContent || '').trim();
        if (text.length >= 30) { desc = truncate(text, 160); break; }
      }

      // Image: snapshot URL if auto-snapshot was taken; else first content
      // <img> with a non-data src; else largest manifest icon.  Snapshot wins
      // over content <img> because it represents the rendered page and is
      // sized for OG/Twitter cards (1200×630), whereas a content image could
      // be a thumbnail of arbitrary aspect ratio.
      let imgSrc = ctx.snapshotUrl || '';
      if (!imgSrc) {
        const imgCandidates = document.querySelectorAll('main img[src], article img[src]');
        for (const img of imgCandidates) {
          const src = img.getAttribute('src') || '';
          if (src && !src.startsWith('data:')) { imgSrc = src; break; }
        }
      }
      if (!imgSrc && Array.isArray(ctx.seo.icons) && ctx.seo.icons.length) {
        // Largest icon by area.
        const sorted = ctx.seo.icons.slice().sort((a, b) => {
          const area = (s) => {
            const m = String(s?.sizes || '').match(/(\d+)x(\d+)/);
            return m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
          };
          return area(b) - area(a);
        });
        imgSrc = sorted[0]?.src || '';
      }

      // Type heuristic: 'article' if the page renders an <article> or its path
      // looks like article content (e.g. /docs/foo, /blog/foo, /articles/foo);
      // 'website' otherwise.
      const looksLikeArticle = !!document.querySelector('article')
        || /^\/(?:docs|blog|articles|posts|guides)\//i.test(location.pathname);
      const ogType = looksLikeArticle ? 'article' : 'website';

      return {
        title: composedTitle,
        description: desc || ctx.seo.siteDescription || null,
        image: imgSrc || null,
        ogType,
      };
    })();

    // --- Resolve a single meta value through the precedence chain --------

    const resolve = (key) => {
      // Layer 3: prerender.meta expression
      const exprMap = ctx.seo.meta || {};
      const expr = exprMap[key];
      if (typeof expr === 'string') {
        const v = evalAlpine(expr);
        if (v) return v;
      } else if (typeof expr === 'boolean' || typeof expr === 'number') {
        return String(expr);
      }
      // Layer 4: explicit fallback
      const fallback = exprMap.fallback?.[key];
      if (fallback) return String(fallback);
      // Layer 5: smart defaults from DOM (page-specific — beats generic PWA fields).
      // For title specifically, the placeholder rule in setTitle() also requires
      // the static <title>Site</title> to be treated as missing so this wins.
      if (smartDefaults[key]) return smartDefaults[key];
      // Layer 6: PWA-style manifest.json fields — last-resort generic fallback
      if (key === 'title' && ctx.seo.siteName) return ctx.seo.siteName;
      if (key === 'description' && ctx.seo.siteDescription) return ctx.seo.siteDescription;
      if (key === 'author' && ctx.seo.siteAuthor) return ctx.seo.siteAuthor;
      return null;
    };

    // --- Title -----------------------------------------------------------

    setTitle(resolve('title'));

    // --- Description / author -------------------------------------------

    const description = resolve('description');
    setMeta('description', description);
    setMeta('author', resolve('author'));

    // --- Canonical URL (skip — already injected later by buildCanonicalAndHreflang) ---

    // --- OpenGraph / Twitter --------------------------------------------

    const liveBase = (ctx.liveUrl || '').replace(/\/$/, '');
    const pageUrl = ctx.pathSeg === '' || ctx.pathSeg === '__404__'
      ? (liveBase ? liveBase + '/' : null)
      : (liveBase ? `${liveBase}/${ctx.pathSeg}` : null);
    const finalTitle = getCurrentTitle().text || resolve('title');
    const ogType = resolve('ogType') || smartDefaults.ogType || 'website';
    const image = resolve('image');

    setMeta('og:title', finalTitle);
    setMeta('og:description', description);
    setMeta('og:type', ogType);
    setMeta('og:url', pageUrl);
    setMeta('og:site_name', ctx.seo.siteName);
    if (image) setMeta('og:image', image);

    setMeta('twitter:card', image ? 'summary_large_image' : 'summary');
    setMeta('twitter:title', finalTitle);
    setMeta('twitter:description', description);
    if (image) setMeta('twitter:image', image);

    // --- JSON-LD structured data ----------------------------------------

    const sd = ctx.seo.structuredData;
    if (sd && typeof sd === 'object') {
      const existingLdScripts = head.querySelectorAll('script[type="application/ld+json"]');
      const existingTypes = new Set();
      existingLdScripts.forEach((s) => {
        try {
          const parsed = JSON.parse(s.textContent || '{}');
          const t = Array.isArray(parsed) ? parsed.map((x) => x['@type']) : [parsed['@type']];
          t.forEach((tt) => tt && existingTypes.add(tt));
        } catch { /* skip malformed */ }
      });

      const resolveSdField = (v) => {
        if (typeof v === 'string') {
          const evaled = evalAlpine(v);
          return evaled ?? v; // if eval fails, keep literal (lets users write plain strings)
        }
        return v;
      };
      const resolveSchema = (obj) => {
        if (obj == null || typeof obj !== 'object') return obj;
        const out = {};
        for (const k of Object.keys(obj)) {
          out[k] = resolveSdField(obj[k]);
        }
        return out;
      };

      const blocks = [];
      for (const [type, def] of Object.entries(sd)) {
        if (existingTypes.has(type)) continue;
        if (def === false) continue;
        if (type === 'BreadcrumbList' && def === true) {
          // Auto-derive from URL path segments.
          const parts = location.pathname.split('/').filter(Boolean);
          const items = [{
            '@type': 'ListItem',
            position: 1,
            name: ctx.seo.siteName || 'Home',
            item: liveBase ? liveBase + '/' : '/',
          }];
          parts.forEach((seg, i) => {
            items.push({
              '@type': 'ListItem',
              position: i + 2,
              name: seg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              item: liveBase ? `${liveBase}/${parts.slice(0, i + 1).join('/')}` : '/' + parts.slice(0, i + 1).join('/'),
            });
          });
          blocks.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items });
          continue;
        }
        if (def === true) {
          // Bare-true for known schemas: minimal auto-fill
          if (type === 'WebSite') {
            blocks.push({
              '@context': 'https://schema.org',
              '@type': 'WebSite',
              name: ctx.seo.siteName || finalTitle || '',
              url: liveBase || '',
            });
          } else if (type === 'Article') {
            blocks.push({
              '@context': 'https://schema.org',
              '@type': 'Article',
              headline: finalTitle || '',
              description: description || '',
              ...(image ? { image } : {}),
              ...(pageUrl ? { url: pageUrl } : {}),
              ...(ctx.seo.siteAuthor ? { author: { '@type': 'Person', name: ctx.seo.siteAuthor } } : {}),
            });
          }
          continue;
        }
        if (typeof def === 'object') {
          const resolved = resolveSchema(def);
          blocks.push({ '@context': 'https://schema.org', '@type': type, ...resolved });
        }
      }

      for (const block of blocks) {
        const s = document.createElement('script');
        s.setAttribute('type', 'application/ld+json');
        s.textContent = JSON.stringify(block);
        head.appendChild(s);
      }
    }
  }, ctx);
}

// --- SEO: robots.txt, sitemap.xml, llms.txt, llms-full.txt ---------------
//
// Written to the prerender output directory.  liveUrl is the canonical public
// host (https://...), used for absolute URLs in sitemap entries and the llms.txt
// page index.  llms.txt and llms-full.txt follow the llmstxt.org convention —
// a plain-markdown index and full-content concatenation specifically for LLM
// crawlers (ChatGPT, Claude, Perplexity, etc.) that prefer structured plaintext
// over scraping rendered HTML.

/**
 * Strip HTML tags + collapse whitespace to plaintext.  Crude but sufficient for
 * meta description / llms-full content extraction; we run on prerendered HTML
 * where Alpine bindings have already been resolved to literal values.
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract <title>, <meta name="description">, and the route's article content
 * from a prerendered HTML file.  Targets the article body, not the whole page
 * layout, so the resulting llms-full.txt isn't dominated by repeated nav, TOC,
 * footer, and other site chrome.
 *
 * Selection order (first hit wins):
 *   1. `.prose` — Manifest convention for rendered markdown article content.
 *   2. `<article>` — semantic HTML for article bodies.
 *   3. `<main>` minus chrome — strips [data-static] (nav lists, TOCs marked
 *      static-bake), <nav>, <header>, <footer>, <aside>.
 *   4. `<body>` minus same chrome — last resort.
 */
function extractRouteContent(filePath) {
  if (!existsSync(filePath)) return null;
  const html = readFileSync(filePath, 'utf8');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);

  // Find the article-content region using depth-tracked tag matching.  Naive
  // non-greedy regex breaks on nested same-tag elements (article markdown
  // typically contains many nested <div>s for code blocks, frames, etc.).
  // Walks the source from the opening tag, counting open/close pairs of the
  // same tag, until depth returns to zero.
  const extractByOpener = (source, openerRx) => {
    const m = openerRx.exec(source);
    if (!m) return null;
    const tagName = m[1];
    const start = m.index + m[0].length;
    const open = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
    const close = new RegExp(`</${tagName}\\s*>`, 'gi');
    let depth = 1;
    let cursor = start;
    while (depth > 0) {
      open.lastIndex = cursor;
      close.lastIndex = cursor;
      const nextOpen = open.exec(source);
      const nextClose = close.exec(source);
      if (!nextClose) return source.slice(start);
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        if (depth === 0) return source.slice(start, nextClose.index);
        cursor = nextClose.index + nextClose[0].length;
      }
    }
    return null;
  };

  // Selection order — first hit wins:
  //   1. `.prose` — Manifest convention for rendered markdown article content.
  //      This is the cleanest source: contains only article body, no chrome.
  //   2. `<article>` — semantic HTML for article bodies.
  //   3. `<main>` — last resort.  At this layer we additionally strip the
  //      site-chrome wrappers (data-static nav/TOC, semantic nav/header/footer
  //      tags).  We do NOT strip <aside> because article content commonly uses
  //      <aside class="frame"> for example boxes.
  const proseRegion = extractByOpener(
    html,
    /<([a-z][a-z0-9]*)\b[^>]*\bclass=["'][^"']*\bprose\b[^"']*["'][^>]*>/i
  );
  let region = '';
  if (proseRegion) {
    region = proseRegion;
  } else {
    const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) {
      region = articleMatch[1];
    } else {
      const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
      const bodyMatch = mainMatch ? null : html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
      let candidate = mainMatch ? mainMatch[1] : (bodyMatch ? bodyMatch[1] : '');
      // Strip site chrome: top-level wrappers, not nested article content.
      // <aside> is intentionally NOT stripped here — articles use <aside
      // class="frame"> for example boxes that should appear in llms-full.
      candidate = candidate.replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ');
      candidate = candidate.replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ');
      // Strip data-static containers (depth-tracked because nav lists nest).
      const stripContainer = (s, openerRx) => {
        let out = s;
        let m;
        while ((m = openerRx.exec(out))) {
          const tagName = m[1];
          const innerStart = m.index + m[0].length;
          const open = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
          const close = new RegExp(`</${tagName}\\s*>`, 'gi');
          let depth = 1;
          let cursor = innerStart;
          let endIdx = out.length;
          while (depth > 0) {
            open.lastIndex = cursor;
            close.lastIndex = cursor;
            const nextOpen = open.exec(out);
            const nextClose = close.exec(out);
            if (!nextClose) break;
            if (nextOpen && nextOpen.index < nextClose.index) {
              depth++;
              cursor = nextOpen.index + nextOpen[0].length;
            } else {
              depth--;
              cursor = nextClose.index + nextClose[0].length;
              if (depth === 0) endIdx = cursor;
            }
          }
          out = out.slice(0, m.index) + ' ' + out.slice(endIdx);
          openerRx.lastIndex = 0;
        }
        return out;
      };
      candidate = stripContainer(candidate, /<([a-z][a-z0-9]*)\b[^>]*\bdata-static\b[^>]*>/gi);
      region = candidate;
    }
  }

  return {
    title: titleMatch ? htmlToText(titleMatch[1]) : '',
    description: descMatch ? descMatch[1] : '',
    bodyText: region ? htmlToText(region) : '',
  };
}

/** Resolve the per-route output HTML file (matches the layout writePrerenderOutput uses). */
function routeHtmlPath(outputDir, pathSeg) {
  if (pathSeg === '') return join(outputDir, 'index.html');
  if (pathSeg === '__prerender_404__') return join(outputDir, '404.html');
  return join(outputDir, ...pathSeg.split('/'), 'index.html');
}

/**
 * Collect filesystem paths for all local-file data sources declared in
 * `manifest.json` that are relevant to the given locale. Caller stats them.
 *
 * Skips remote sources (URLs, Appwrite databases / storage) since they have
 * no local mtime. Locale-keyed JSON/YAML sources include only the matching
 * locale's file. Multilingual CSVs (`locales` key) include every listed file
 * because any column edit can affect the routed page.
 */
function collectDataSourceFiles(manifest, rootDir, effectiveLocale) {
  const files = [];
  const data = manifest?.data;
  if (!data || typeof data !== 'object') return files;

  const isLocaleKey = (key) =>
    /^[a-z]{2,3}(?:-[A-Z][a-zA-Z]{1,7})?$/.test(key);

  const localeMatches = (key) => {
    if (!isLocaleKey(key)) return false;
    if (effectiveLocale) return key === effectiveLocale;
    // No locale context: include any locale-shaped key.
    return true;
  };

  const isLocalPath = (s) => typeof s === 'string' && !/^https?:\/\//i.test(s);
  const toAbs = (p) => join(rootDir, p.replace(/^\//, ''));

  for (const value of Object.values(data)) {
    // Plain string path → single locale-agnostic file.
    if (isLocalPath(value)) {
      files.push(toAbs(value));
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    // Skip cloud / remote sources — they have no local file to stat.
    if (value.url || value.appwriteDatabaseId || value.appwriteTableId || value.appwriteBucketId) continue;

    for (const [key, v] of Object.entries(value)) {
      // Multilingual CSV: { locales: "/p.csv" } or { locales: ["/a.csv", "/b.csv"] }
      if (key === 'locales') {
        if (isLocalPath(v)) files.push(toAbs(v));
        else if (Array.isArray(v)) {
          for (const p of v) if (isLocalPath(p)) files.push(toAbs(p));
        }
        continue;
      }
      // Colorpicker palette: { colorpicker: "/p.yaml" } or { colorpicker: { en: ..., fr: ... } }
      if (key === 'colorpicker') {
        if (isLocalPath(v)) files.push(toAbs(v));
        else if (v && typeof v === 'object') {
          for (const [k, p] of Object.entries(v)) {
            if (localeMatches(k) && isLocalPath(p)) files.push(toAbs(p));
          }
        }
        continue;
      }
      // Locale-keyed JSON/YAML: { en: "/p.en.json", fr: "/p.fr.json" }
      if (localeMatches(key) && isLocalPath(v)) {
        files.push(toAbs(v));
      }
    }
  }

  return files;
}

/**
 * Best-effort per-route lastmod date. Takes the most recent mtime across:
 *   1. Backing source-file conventions (markdown under articles/, pages/<path>.html)
 *      so direct content edits are reflected.
 *   2. Data-source files registered in `manifest.json` that are relevant to the
 *      route's locale, so changes to JSON/YAML/CSV content driving the page
 *      bump the date too (important for translated sites).
 *
 * Falls back to the prerendered HTML's own mtime only when nothing else is
 * statable — the HTML mtime reflects rebuild time rather than content change
 * time, so we prefer source/data mtimes when any exist.
 */
function routeLastModDate(rootDir, outputDir, pathSeg, manifest, localeList, defaultLocale) {
  // Detect a locale prefix on the path (e.g. "fr/about" → locale "fr",
  // unlocalized "about"). For unprefixed paths in a multi-locale site we
  // fall back to the default locale when matching data-source locale keys.
  let locale = null;
  let unlocalizedPath = pathSeg;
  if (Array.isArray(localeList) && localeList.length) {
    const first = pathSeg.split('/')[0];
    if (localeList.includes(first)) {
      locale = first;
      unlocalizedPath = pathSeg.slice(first.length + 1);
    }
  }
  const effectiveLocale = locale || defaultLocale || null;

  // Source-file candidates from common conventions, keyed on the unlocalized
  // path (markdown files typically aren't per-locale duplicates).
  const stripPrefix = unlocalizedPath.replace(/^(?:docs|blog|articles|posts|guides)\//, '');
  const candidates = [
    join(rootDir, 'articles', `${stripPrefix}.md`),
    join(rootDir, 'articles', `${unlocalizedPath}.md`),
    join(rootDir, 'pages', `${unlocalizedPath}.html`),
    join(rootDir, `${unlocalizedPath}.md`),
  ];

  // Add data-source files relevant to this locale.
  if (manifest) {
    candidates.push(...collectDataSourceFiles(manifest, rootDir, effectiveLocale));
  }

  // Take the max mtime across all source / data candidates.
  let latest = null;
  for (const c of candidates) {
    try {
      const s = statSync(c);
      if (s.isFile() && (!latest || s.mtime > latest)) latest = s.mtime;
    } catch { /* not found */ }
  }
  if (latest) return latest.toISOString().slice(0, 10);

  // Fallback to the prerendered output mtime (always present).
  try {
    const out = routeHtmlPath(outputDir, pathSeg || '');
    const s = statSync(out);
    return s.mtime.toISOString().slice(0, 10);
  } catch { /* ignore */ }
  return new Date().toISOString().slice(0, 10);
}

function writeSeoFiles(outputDir, pathList, liveUrl, locales, defaultLocale, ctx = {}) {
  const base = liveUrl.replace(/\/$/, '');
  const localeList = Array.isArray(locales) ? locales : [];
  const multiLocale = localeList.length > 1;
  const rootDir = ctx.rootDir || '';
  const manifest = ctx.manifest || null;

  writeFileSync(
    join(outputDir, 'robots.txt'),
    `User-agent: *
Disallow:

Sitemap: ${base}/sitemap.xml
`,
    'utf8'
  );

  const urlsetNs = multiLocale
    ? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
    : '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

  const urlEntries = pathList.map((pathSeg) => {
    const path = pathSeg === '' ? '' : '/' + pathSeg.replace(/\/$/, '');
    const loc = path ? `${base}${path}` : base + '/';
    const escapedLoc = escapeXmlText(loc);
    let body = `        <loc>${escapedLoc}</loc>`;
    if (multiLocale) {
      for (const { hreflang, href } of getAlternateLinksForPath(pathSeg, localeList, defaultLocale, liveUrl)) {
        body += `\n        <xhtml:link rel="alternate" hreflang="${escapeXmlText(hreflang)}" href="${escapeXmlText(href)}" />`;
      }
    }
    const lastmod = routeLastModDate(rootDir, outputDir, pathSeg, manifest, localeList, defaultLocale);
    body += `\n        <lastmod>${lastmod}</lastmod>
        <changefreq>monthly</changefreq>
        <priority>${path === '' ? '1.0' : '0.8'}</priority>`;
    return `    <url>
${body}
    </url>`;
  });

  writeFileSync(
    join(outputDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
${urlsetNs}
${urlEntries.join('\n')}
</urlset>
`,
    'utf8'
  );

  writeLlmsFiles(outputDir, pathList, base, ctx);
}

/**
 * Write llms.txt (curated index) and llms-full.txt (concatenated full content)
 * per the llmstxt.org convention.  Read each prerendered HTML file in pathList
 * and extract title / description / body text — these were already filled by
 * injectMetaInDom + smart defaults, so the output reflects the same layered
 * precedence (data-head → prerender.meta → smart defaults) without re-deriving.
 *
 * Pages are grouped into sections by their first URL segment ("Getting Started"
 * for /docs/getting-started/*, etc.) so the index is browseable.  The root /
 * page is treated as the site overview.
 */
function writeLlmsFiles(outputDir, pathList, liveBase, ctx = {}) {
  const siteName = ctx.siteName || 'Site';
  const siteDescription = ctx.siteDescription || '';

  // Extract content for every route up front so we can build both files in one pass.
  const entries = [];
  for (const pathSeg of pathList) {
    const filePath = routeHtmlPath(outputDir, pathSeg);
    const extracted = extractRouteContent(filePath);
    if (!extracted) continue;
    entries.push({
      pathSeg,
      url: pathSeg === '' ? `${liveBase}/` : `${liveBase}/${pathSeg}`,
      title: extracted.title || pathSeg || siteName,
      description: extracted.description,
      bodyText: extracted.bodyText,
    });
  }

  // Group entries by section.  For /a/b/c, the section is "a"; for the root,
  // "Overview".  Sections are presented in first-encounter order to preserve
  // whatever order the project's manifest.json or yaml index dictated.
  const sections = new Map();
  const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  for (const entry of entries) {
    const first = entry.pathSeg.split('/')[0] || '';
    const sectionKey = first || 'Overview';
    const sectionLabel = first ? titleCase(first) : 'Overview';
    if (!sections.has(sectionKey)) sections.set(sectionKey, { label: sectionLabel, entries: [] });
    sections.get(sectionKey).entries.push(entry);
  }

  // --- llms.txt: short curated index ---
  let llms = `# ${siteName}\n`;
  if (siteDescription) llms += `\n> ${siteDescription}\n`;
  for (const { label, entries: items } of sections.values()) {
    llms += `\n## ${label}\n\n`;
    for (const e of items) {
      const desc = e.description ? `: ${e.description}` : '';
      llms += `- [${e.title}](${e.url})${desc}\n`;
    }
  }
  writeFileSync(join(outputDir, 'llms.txt'), llms, 'utf8');

  // --- llms-full.txt: full concatenated text content ---
  // Description is intentionally omitted per-entry — bodyText typically opens
  // with the same sentence (smart-default description came from the first
  // paragraph), so printing both produces a duplicate first line.  llms.txt
  // already carries descriptions for the curated index.
  let llmsFull = `# ${siteName}\n`;
  if (siteDescription) llmsFull += `\n> ${siteDescription}\n`;
  for (const { label, entries: items } of sections.values()) {
    llmsFull += `\n\n# ${label}\n`;
    for (const e of items) {
      llmsFull += `\n\n## ${e.title}\n`;
      llmsFull += `\nSource: ${e.url}\n`;
      if (e.bodyText) llmsFull += `\n${e.bodyText}\n`;
    }
  }
  writeFileSync(join(outputDir, 'llms-full.txt'), llmsFull, 'utf8');
}

// --- Output protection: keep editors/formatters from rewriting generated HTML ---
//
// Prerendered HTML embeds highlight.js spans inside <pre><code>, where
// whitespace IS significant.  Most HTML formatters (Prettier, VS Code's
// html-language-features, biome) only respect "preserve <pre> content" when
// <pre> sits at the top level — when it's nested inside an unrecognised custom
// element like <x-code>, they recurse in and reformat the spans, breaking the
// indentation in every code block.  These four files tell common tools to
// leave the output alone, so the corruption can't happen in any dev's
// environment regardless of their global editor config.
function writeOutputProtectionFiles(outputDir) {
  // Prettier: hierarchical, walks up the tree from the file being formatted.
  writeFileSync(
    join(outputDir, '.prettierignore'),
    `# Generated by Manifest prerender. Do not edit; re-run \`mnfst-render\`.
*
`,
    'utf8'
  );

  // Git: hide from PR diffs by default and skip text normalisation that could
  // touch <pre> whitespace.
  writeFileSync(
    join(outputDir, '.gitattributes'),
    `# Generated by Manifest prerender. Do not edit; re-run \`mnfst-render\`.
* linguist-generated=true
*.html -text
`,
    'utf8'
  );

  // EditorConfig: hierarchical (editors walk up from the file). \`root = true\`
  // stops the walk at this folder so a parent .editorconfig can't override us.
  // We can't disable formatters via EditorConfig, but pinning indent/charset
  // matches what the renderer emits, so format-on-type doesn't churn the file.
  writeFileSync(
    join(outputDir, '.editorconfig'),
    `# Generated by Manifest prerender. Do not edit; re-run \`mnfst-render\`.
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = false
trim_trailing_whitespace = false
indent_style = space
indent_size = 2
`,
    'utf8'
  );

  // VS Code: applies when this folder is opened directly as a workspace root.
  // (A nested .vscode/settings.json is NOT picked up automatically by a
  // parent workspace; for that case the dev needs to add a pattern to their
  // own settings.)  \`files.readonlyInclude\` is the cleanest defence: VS Code
  // refuses to save the file, so format-on-save can't fire.
  // VS Code settings.json is JSONC — // comments are allowed.
  const vscodeDir = join(outputDir, '.vscode');
  mkdirSync(vscodeDir, { recursive: true });
  writeFileSync(
    join(vscodeDir, 'settings.json'),
    `// Generated by Manifest prerender. Do not edit; re-run mnfst-render.
{
  "files.readonlyInclude": { "**": true },
  "editor.formatOnSave": false,
  "editor.formatOnPaste": false,
  "editor.formatOnType": false,
  "html.format.enable": false
}
`,
    'utf8'
  );
}

// --- Static server for --serve ------------------------------------------------

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function startStaticServer(rootDir) {
  const rootResolved = resolve(rootDir);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }
    const pathname = (req.url || '/').replace(/\?.*$/, '') || '/';
    const segments = pathname.split('/').filter(Boolean);
    const safeSegments = segments.filter((s) => s !== '..' && s !== '');
    const filePath = join(rootResolved, ...safeSegments);
    let resolvedPath;
    try {
      resolvedPath = resolve(filePath);
      if (!resolvedPath.startsWith(rootResolved)) {
        res.writeHead(403);
        res.end();
        return;
      }
    } catch {
      sendIndex();
      return;
    }
    function sendIndex() {
      const indexFile = join(rootResolved, 'index.html');
      if (!existsSync(indexFile)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const html = readFileSync(indexFile, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    }
    if (!existsSync(resolvedPath)) {
      sendIndex();
      return;
    }
    const stat = statSync(resolvedPath);
    if (stat.isDirectory()) {
      const indexInDir = join(resolvedPath, 'index.html');
      if (existsSync(indexInDir)) {
        const html = readFileSync(indexInDir, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }
      sendIndex();
      return;
    }
    const ext = (resolvedPath.match(/\.[^.]+$/) || [])[0] || '';
    const contentType = MIME[ext] || 'application/octet-stream';
    const body = readFileSync(resolvedPath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  });
  return new Promise((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

// --- Copy project into output so website is self-contained (e.g. for Appwrite). ---
const COPY_EXCLUDE = new Set([
  'node_modules', '.git', 'package.json', 'package-lock.json',
  'index.html', 'prerender.mjs', 'prerender.js', '_redirects',
]);

function copyProjectIntoDist(rootResolved, outputResolved) {
  const outputDirName = basename(outputResolved);
  COPY_EXCLUDE.add(outputDirName);
  const entries = readdirSync(rootResolved, { withFileTypes: true });
  for (const ent of entries) {
    const name = ent.name;
    if (COPY_EXCLUDE.has(name) || name.startsWith('.')) continue;
    const src = join(rootResolved, name);
    const dest = join(outputResolved, name);
    cpSync(src, dest, { recursive: true });
  }
  COPY_EXCLUDE.delete(outputDirName);
}

// --- Main --------------------------------------------------------------------

async function main() {
  const config = resolveConfig();
  const startedAt = Date.now();
  let staticServer = null;
  if (config.serve) {
    const { server, url } = await startStaticServer(config.root);
    staticServer = server;
    config.localUrl = url;
  }
  try {
    await runPrerender(config);
  } finally {
    if (staticServer) {
      await new Promise((res) => staticServer.close(res));
    }
  }
  const elapsedMs = Date.now() - startedAt;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  process.stdout.write(`prerender: total time ${hours}h ${minutes}m ${seconds}s\n`);
}

async function runPrerender(config) {
  const manifest = loadConfig(config.root);
  const localesConfig = config.locales;

  let locales = [];
  if (localesConfig !== false) {
    const discovered = discoverLocales(manifest, config.root);
    if (Array.isArray(localesConfig) && localesConfig.length > 0) {
      locales = localesConfig.filter((c) => discovered.includes(c));
    } else {
      locales = discovered;
    }
  }

  const defaultLocale = locales[0] ?? null;
  const routeSegments = discoverRoutes(manifest, config.root);
  // Merge any explicitly configured paths (manifest.prerender.paths) into the discovered segments.
  // These are treated as locale-neutral and get full locale-expansion like all other discovered paths.
  if (config.paths && config.paths.length > 0) {
    const segSet = new Set(routeSegments);
    for (const p of config.paths) {
      if (!segSet.has(p)) { routeSegments.push(p); segSet.add(p); }
    }
  }
  const localeSet = new Set(locales.map((l) => String(l).toLowerCase()));
  const localeNeutralSegments = routeSegments.filter((seg) => {
    if (!seg) return true;
    const first = seg.split('/')[0].toLowerCase();
    return !localeSet.has(first);
  });
  const paths = new Set();
  paths.add('');

  for (const seg of routeSegments) {
    paths.add(seg);
  }
  for (const locale of locales.slice(1)) {
    paths.add(locale);
    for (const seg of localeNeutralSegments) {
      if (!seg) continue;
      paths.add(`${locale}/${seg}`);
    }
  }
  // Default locale also under its slug (e.g. /en/, /en/page-1) so linking is
  // symmetric with other locales; canonical points to root.  Skip this when
  // there's only one locale — the duplicates serve no purpose and bloat the
  // output (every page would be written twice: at root AND under /en/).
  if (defaultLocale && locales.length > 1) {
    paths.add(defaultLocale);
    for (const seg of localeNeutralSegments) {
      if (seg !== '') paths.add(`${defaultLocale}/${seg}`);
    }
  }

  const NOT_FOUND_PATH = '__prerender_404__'; // URL path that matches no route so router shows x-route="!*" (404)
  const pathList = [...paths, NOT_FOUND_PATH];
  if (config.dryRun) {
    return;
  }

  const outputResolved = resolve(config.output);
  const rootResolved = resolve(config.root);
  // Router base = URL pathname to the app root. When dist is deployed as site root (e.g. Appwrite), use "".
  // Set manifest.prerender.routerBase only when the app is served from a subpath (e.g. /app).
  let routerBasePath = null;
  if (config.routerBase != null && String(config.routerBase).trim() !== '') {
    const trimmed = String(config.routerBase).replace(/^\/+|\/+$/g, '').trim();
    routerBasePath = trimmed ? '/' + trimmed : '';
  } else {
    routerBasePath = '';
  }

  if (existsSync(outputResolved)) {
    rmSync(outputResolved, { recursive: true });
  }
  mkdirSync(outputResolved, { recursive: true });
  copyProjectIntoDist(rootResolved, outputResolved);

  const pre = manifest.prerender ?? {};
  const bundleUtilities = pre.utilitiesBundle !== false;
  const tailwindBuilt = runTailwindCliForPrerender(rootResolved, outputResolved, pre);
  const utilityBlocks = [];

  // Launch a fresh browser instance.  Chromium is known to accumulate memory
  // and handle leaks on large prerender runs (we've seen crashes around page
  // ~230 on sites with hundreds of routes).  The launchBrowser function is
  // used both for the initial launch AND for periodic recycling — we close
  // the old browser and start a new one every `browserRecycleEvery` pages to
  // bound memory growth.
  async function launchBrowser() {
    try {
      const chromium = await importFromProject('@sparticuz/chromium');
      const pptr = await importFromProject('puppeteer-core');
      const executablePath = await chromium.default.executablePath();
      return await pptr.default.launch({
        args: chromium.default.args,
        defaultViewport: chromium.default.defaultViewport ?? null,
        executablePath,
        headless: chromium.default.headless ?? true,
        ignoreHTTPSErrors: true,
      });
    } catch (_serverlessErr) {
      let puppeteer;
      try {
        puppeteer = await importFromProject('puppeteer');
      } catch {
        console.error('prerender: missing browser runtime.');
        console.error('Install one of the following, then rerun:');
        console.error('  npm i -D puppeteer');
        console.error('  npm i -D puppeteer-core @sparticuz/chromium');
        process.exit(1);
      }
      return await puppeteer.default.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      });
    }
  }
  let browser = await launchBrowser();

  const timeout = config.wait ?? 30000;
  // Lower default concurrency: Chromium's own memory overhead per page is
  // substantial, and we also now maintain a per-page source-attribute Map for
  // the hydration contract.  On large sites (>100 routes) higher concurrency
  // spikes memory and crashes the browser.  Users can still override via
  // --concurrency or manifest.prerender.concurrency.
  const concurrency = config.concurrency;
  const maxRetries = config.retries ?? 2;
  // Recycle the browser every N processed pages to bound resource growth.
  // Configurable via manifest.prerender.browserRecycleEvery.
  const browserRecycleEvery = Math.max(0, pre.browserRecycleEvery ?? 40);
  let pagesSinceRecycle = 0;
  const recycleLock = { busy: false };
  // Workers block on this promise before touching `browser`.  While a recycle
  // is in progress it's a pending promise; once the new browser is up it
  // resolves and workers can proceed.  This prevents "browser not ready"
  // errors from racing retries during recycle.
  let browserReadyPromise = Promise.resolve();
  const pathTotal = pathList.length;
  const failedPaths = [];
  const debugRows = [];

  // --- Two-phase rendering: Puppeteer for base paths, Node.js substitution for locale variants ---
  // Categorise paths: locale-prefixed paths (en/about, fr/about, ...) are "locale variants"
  // and can be generated from the corresponding base path's DOM snapshot + text substitution.
  // This eliminates Puppeteer for every locale × route combination beyond the base routes.
  const localeSubstEnabled = config.localeSubstitution;
  const localeSubstExclude = new Set(config.localeSubstitutionExclude || []);
  const puppeteerPaths = [];
  const localeVariantPaths = []; // { pathSeg, basePathSeg, targetLocale }

  // Two-pass categorisation: locale substitution only applies when the locale-neutral base path
  // (e.g. 'about' for 'fr/about') is itself in the path list and will be Puppeteer-rendered.
  //
  // Paths whose data is inherently locale-specific (e.g. 'en/articles/slug', 'fr/articles/slug'
  // discovered from per-locale data sources) have no locale-neutral counterpart and must be
  // rendered by Puppeteer directly — their content differs per locale and substitution cannot
  // produce correct output. This mirrors the framework's own data model: locale-neutral paths
  // use a shared structure with CSV text overlay; locale-prefixed paths carry per-locale content.

  // Pass 1: collect all locale-neutral path segments (no locale prefix in the first segment).
  const localeNeutralPathSet = new Set();
  for (const seg of pathList) {
    if (!seg || seg === NOT_FOUND_PATH) continue;
    if (!localeSet.has(seg.split('/')[0])) localeNeutralPathSet.add(seg);
  }

  // Pass 2: categorise.
  for (const seg of pathList) {
    if (!localeSubstEnabled || seg === NOT_FOUND_PATH || !seg) {
      puppeteerPaths.push(seg);
      continue;
    }
    const fp = seg.split('/')[0];
    if (!localeSet.has(fp) || localeSubstExclude.has(fp)) {
      puppeteerPaths.push(seg);
      continue;
    }
    const basePathSeg = seg.slice(fp.length + 1) || '';
    if (localeNeutralPathSet.has(basePathSeg)) {
      // Locale-neutral base exists and will be Puppeteer-rendered → safe to substitute.
      localeVariantPaths.push({ pathSeg: seg, basePathSeg, targetLocale: fp });
    } else {
      // No locale-neutral base — this path has per-locale content; Puppeteer required.
      puppeteerPaths.push(seg);
    }
  }

  // Preload locale data for text substitution (all CSV sources with locale columns)
  const allLocaleData = loadAllLocaleContentData(manifest, config.root, locales);
  const substitutionMaps = new Map(); // locale → [[from, to], ...]
  for (const locale of locales) {
    if (locale === defaultLocale) {
      substitutionMaps.set(locale, []); // default locale: no text substitution needed
    } else {
      substitutionMaps.set(locale, buildSubstitutionPairs(
        allLocaleData.get(defaultLocale) || {},
        allLocaleData.get(locale) || {}
      ));
    }
  }

  // baseHtmlCache: base path segment → raw DOM HTML captured before any Node.js transforms
  const baseHtmlCache = new Map();
  const puppeteerTotal = puppeteerPaths.length;

  process.stdout.write(`Prerendering ${pathTotal} path(s) (${puppeteerTotal} via Puppeteer, ${localeVariantPaths.length} via substitution)...\n`);

  // Asset-wide fingerprint used as a cache-invalidator for OG snapshots:
  // changes to theme CSS, manifest config, or the root index.html mean every
  // route's visual chrome has changed, so the snapshot cache must drop.  Per-
  // route content hashes (in takeOgSnapshot) catch route-specific changes.
  // The cache lives at <root>/.mnfst-cache/og/ — survives the output-dir
  // rmSync that fires at the start of every prerender.
  const globalAssetSig = config.seo?.imageSnapshots
    ? computeGlobalAssetSignature(config.root)
    : '';
  const ogCacheDir = config.seo?.imageSnapshots
    ? join(config.root, '.mnfst-cache', 'og')
    : null;

  function pushDebug(row) {
    if (!config.debugPrerender) return;
    debugRows.push(row);
  }

  async function processPath(pathSeg, pathIndex, { onRawHtml } = {}) {
    const is404 = pathSeg === NOT_FOUND_PATH;
    const pathname = is404 ? `/${NOT_FOUND_PATH}` : (pathSeg ? `/${pathSeg}` : '/');
    const displayPath = pathSeg === '' ? '/' : pathname;
    process.stdout.write(`  [ ${pathIndex + 1}/${puppeteerTotal} ] ${displayPath}\n`);
    const url = `${config.localUrl}${pathname}`;
    const fileSegments = is404 ? [] : pathToFileSegments(pathSeg ? `/${pathSeg}` : '/');
    const outDir = is404 ? config.output : join(config.output, ...fileSegments);
    const outFile = is404 ? join(config.output, '404.html') : join(outDir, 'index.html');
    const currentLocale =
      pathSeg && locales.length > 0
        ? locales.includes(pathSeg.split('/')[0])
          ? pathSeg.split('/')[0]
          : defaultLocale || 'en'
        : defaultLocale || 'en';

    // Wait for any in-progress browser recycle to complete before touching
    // `browser`.  This transparently handles the window between the old
    // browser being closed and the new one being launched — workers block
    // here instead of throwing "browser not ready".
    await browserReadyPromise;
    const page = await browser.newPage();
    // Render at a typical desktop viewport so layouts dependent on viewport
    // width (responsive flex/grid, container queries, media queries) settle
    // into their desktop variant.  Without this the headless default (often
    // 800×600) leaves narrower layouts baked into the prerendered HTML and
    // also produces blank OG screenshots for hero sections that rely on
    // viewport-driven flex distribution.
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
    try {
      // Align <html lang> with the URL being prerendered before any app script runs.
      // initializeDataSourcesPlugin picks locale from document.documentElement.lang first; a mismatch
      // (e.g. headless default vs /en/...) leaves $x.* empty while x-route sections still render.
      await page.evaluateOnNewDocument((locale) => {
        const apply = () => {
          try {
            if (locale && typeof locale === 'string') document.documentElement.lang = locale;
          } catch {
            /* no-op */
          }
        };
        if (typeof document !== 'undefined') {
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', apply, { once: true });
          }
          apply();
        }
      }, currentLocale);

      // Deterministic source-attribute capture via MutationObserver with
      // `attributeOldValue`.  This runs before ANY page script and records the
      // first (pre-mutation) value of every attribute that Alpine or a Manifest
      // plugin ever touches.  It also records the *initial* attributes of every
      // new element added to the DOM via childList mutations — so elements
      // parsed from innerHTML (components, markdown rendering, etc.) are also
      // captured the moment they appear.
      //
      // The observer handles all mutation surfaces at once:
      //   - setAttribute / removeAttribute
      //   - className setter
      //   - classList.add / remove / toggle / replace
      //   - style.* property assignments (which mutate the style attribute)
      //   - Any other path that ultimately modifies an attribute
      //
      // At serialize time we read the map, identify hydrate targets per the
      // catalog, and emit a compact JSON hydration contract.  The runtime
      // (`hydratePrerenderedPage` in manifest.js) reads the contract and
      // restores source attributes before Alpine starts.
      await page.evaluateOnNewDocument(() => {
        // element -> { attrName: originalValue (null if attribute was absent) }
        // Keyed by reference so detached elements drop out naturally.
        const sourceAttrs = new Map();
        // element -> original innerHTML (only populated for elements already
        // marked data-hydrate when we first see them — used for subtree-wide
        // restoration of explicit hydrate islands).
        const sourceInnerHTML = new Map();

        const recordInitialAttrs = (el) => {
          if (!el || el.nodeType !== 1 || sourceAttrs.has(el)) return;
          const rec = {};
          const list = el.attributes;
          for (let i = 0; i < list.length; i++) {
            rec[list[i].name] = list[i].value;
          }
          sourceAttrs.set(el, rec);
          if (el.hasAttribute && el.hasAttribute('data-hydrate')) {
            try { sourceInnerHTML.set(el, el.innerHTML); } catch (_) {}
          }
        };

        const handleMutations = (mutations) => {
          for (const m of mutations) {
            if (m.type === 'attributes') {
              const el = m.target;
              let rec = sourceAttrs.get(el);
              if (!rec) {
                // First time we see this element AT ALL via an attribute record:
                // seed with every current attribute so we never lose attrs that
                // existed before any mutation we happened to observe.
                rec = {};
                const list = el.attributes;
                for (let i = 0; i < list.length; i++) {
                  rec[list[i].name] = list[i].value;
                }
                // Overwrite the one being mutated with the true oldValue
                // (which may be null if the attribute was absent pre-mutation).
                rec[m.attributeName] = m.oldValue;
                sourceAttrs.set(el, rec);
              } else if (!(m.attributeName in rec)) {
                rec[m.attributeName] = m.oldValue;
              }
            } else if (m.type === 'childList') {
              for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                recordInitialAttrs(node);
                if (node.querySelectorAll) {
                  node.querySelectorAll('*').forEach(recordInitialAttrs);
                }
              }
            }
          }
        };

        const observer = new MutationObserver(handleMutations);

        let observing = false;
        const startObserving = () => {
          if (observing) return true;
          // We can observe `document` itself — MutationObserver accepts it as a
          // target and forwards subtree mutations, so we catch <html> creation
          // and everything under it without racing the parser.
          try {
            observer.observe(document, {
              attributes: true,
              attributeOldValue: true,
              childList: true,
              subtree: true,
            });
            observing = true;
          } catch (_) { return false; }
          // Seed whatever already exists.
          if (document.documentElement) {
            recordInitialAttrs(document.documentElement);
            document.documentElement.querySelectorAll('*').forEach(recordInitialAttrs);
          }
          return true;
        };
        startObserving();

        // Flush any pending mutations before the DOM is read for serialization.
        window.__manifestFlushHydrateSources = () => {
          try { handleMutations(observer.takeRecords()); } catch (_) {}
        };
        // Expose for the contract-emission phase.
        window.__manifestSourceAttrs = sourceAttrs;
        window.__manifestSourceInnerHTML = sourceInnerHTML;
      });

      pushDebug({ path: displayPath, stage: 'start' });
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeout, 30000),
      });

      // Settle waits.  These give Manifest plugins (especially the components
      // plugin, which lazy-fetches each component HTML over the network) time
      // to finish loading and expanding everything before we snapshot.  Each
      // wait is bounded; large projects with many components need the full
      // budget on cold runs, but small projects settle long before the cap.
      //
      // Lowered from the original "any wait could hold the prerender for ~50s
      // per path" defaults, but kept generous enough that Playcom-scale sites
      // (~10 preloaded components, dozens of lazy components) actually finish
      // expanding before snapshot.  Earlier reductions were too aggressive and
      // left unexpanded `<x-*>` placeholders in the output.
      await Promise.race([
        page.evaluate(() => {
          return new Promise((resolve) => {
            const done = () => resolve();
            const t = setTimeout(done, 3000);
            window.addEventListener(
              'manifest:routing-ready',
              () => {
                clearTimeout(t);
                setTimeout(done, 1000);
              },
              { once: true }
            );
          });
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ready timeout')), timeout)),
      ]).catch(() => { });

      // Ensure the dynamic loader has injected at least one plugin script.
      // In practice this happens within ~100ms but allow up to 3s for cold
      // CDN cache or slow disk.
      await page.evaluate(() => {
        return new Promise((resolve) => {
          const check = () => document.querySelectorAll('script[src*="manifest"]').length >= 2;
          if (check()) return resolve();
          const deadline = Date.now() + 3000;
          const t = setInterval(() => {
            if (check() || Date.now() >= deadline) {
              clearInterval(t);
              resolve();
            }
          }, 50);
        });
      }).catch(() => { });

      // Network idle: drain pending fetches (component templates, data sources,
      // markdown files, icon SVGs).  Larger projects need the full window;
      // small ones settle in well under 1 second.
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => { });

      // DOM stability after network idle.
      await page.evaluate(() => {
        return new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            clearTimeout(stable);
            stable = setTimeout(finish, 500);
          });
          observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
          const finish = () => { observer.disconnect(); resolve(); };
          let stable = setTimeout(finish, 500);
        });
      }).catch(() => { });

      // Set locale, dispatch route/locale events, call component swapping, then wait for
      // manifest:render-ready — the single authoritative signal that all data sources have
      // settled for this locale/route. Falls back to timeout for older data plugins.
      await waitForManifestRenderReady(page, {
        allLocales: locales,
        currentLocale,
        timeoutMs: config.pipelineTimeout,
      });

      // Flush any remaining Alpine microtask effects after the render-ready signal.
      await flushAlpineEffects(page);

      // OG image auto-snapshot — captured here, BEFORE the heavy DOM-transform
      // passes (template removal, hydration contract, route-hidden cleanup)
      // perturb the rendered visual state.  Skip if og:image is already set
      // by data-head, prerender.meta config, or an explicit fallback.
      let earlySnapshotUrl = null;
      if (config.seo.imageSnapshots) {
        const ogImageHandled = !!config.seo.meta?.image
          || !!config.seo.meta?.fallback?.image
          || await page.evaluate(() => !!document.head.querySelector('meta[property="og:image"]'));
        if (!ogImageHandled) {
          earlySnapshotUrl = await takeOgSnapshot(page, config.output, is404 ? '__404__' : pathSeg, globalAssetSig, ogCacheDir);
        }
      }

      if (config.debugPrerender) {
        const before = await page.evaluate(() => {
          const templates = Array.from(document.querySelectorAll('template[x-for]'));
          const entries = templates.slice(0, 60).map((tpl) => {
            const first = tpl.content?.firstElementChild;
            const tag = first ? first.tagName : null;
            const cls = first ? (first.getAttribute('class') || '') : '';
            let cloneCount = 0;
            let next = tpl.nextElementSibling;
            while (next && (!tag || next.tagName === tag)) {
              if (tag && (next.getAttribute('class') || '') !== cls) break;
              cloneCount++;
              next = next.nextElementSibling;
            }
            return {
              xFor: (tpl.getAttribute('x-for') || '').slice(0, 140),
              collapsed: tpl.getAttribute('data-prerender-collapsed') === '1',
              staticGenerated: tpl.getAttribute('data-prerender-static-generated') === '1',
              cloneCount,
            };
          });

          const listDiagnostics = {
            htmlLang: '',
            localeCurrent: null,
            dataLocaleChanging: null,
            dataStates: {},
            topLevelArrayLengths: {},
            nestedContentCards: null,
            emptyStaticXFors: [],
          };

          try {
            listDiagnostics.htmlLang = document.documentElement.lang || '';
            const Alpine = window.Alpine;
            if (Alpine?.store) {
              const loc = Alpine.store('locale');
              listDiagnostics.localeCurrent = loc?.current ?? null;
              const d = Alpine.store('data');
              if (d) {
                listDiagnostics.dataLocaleChanging = !!d._localeChanging;
                for (const k of Object.keys(d)) {
                  if (k.startsWith('_') && k.endsWith('_state')) {
                    const short = k.slice(1, -'_state'.length);
                    const s = d[k];
                    if (s && typeof s === 'object') {
                      listDiagnostics.dataStates[short] = {
                        loading: !!s.loading,
                        ready: !!s.ready,
                        hasError: s.error != null,
                      };
                    }
                  } else if (!k.startsWith('_') && Array.isArray(d[k])) {
                    listDiagnostics.topLevelArrayLengths[k] = d[k].length;
                  }
                }
                try {
                  const cards = d.content?.home?.differentiators?.cards;
                  if (Array.isArray(cards)) listDiagnostics.nestedContentCards = cards.length;
                  else if (cards && typeof cards === 'object') listDiagnostics.nestedContentCards = Object.keys(cards).length;
                  else listDiagnostics.nestedContentCards = cards == null ? null : 'non-iterable';
                } catch {
                  listDiagnostics.nestedContentCards = 'error';
                }
              }
            }
          } catch (e) {
            listDiagnostics.probeError = String(e?.message || e);
          }

          for (const tpl of templates) {
            if (tpl.getAttribute('data-prerender-collapsed') === '1') continue;
            const first = tpl.content?.firstElementChild;
            const tag = first ? first.tagName : null;
            const cls = first ? (first.getAttribute('class') || '') : '';
            let cloneCount = 0;
            let next = tpl.nextElementSibling;
            while (next && (!tag || next.tagName === tag)) {
              if (tag && (next.getAttribute('class') || '') !== cls) break;
              cloneCount++;
              next = next.nextElementSibling;
            }
            if (cloneCount > 0) continue;
            const routeAnc = tpl.closest('[x-route]');
            let hiddenReason = null;
            let el = tpl.parentElement;
            while (el) {
              if (el.hasAttribute('hidden')) {
                hiddenReason = 'ancestor-hidden';
                break;
              }
              const st = el.getAttribute('style') || '';
              if (/\bdisplay\s*:\s*none\b/i.test(st)) {
                hiddenReason = 'ancestor-display-none';
                break;
              }
              el = el.parentElement;
            }
            const itemsHost = tpl.closest('[items]');
            listDiagnostics.emptyStaticXFors.push({
              xFor: (tpl.getAttribute('x-for') || '').slice(0, 160),
              nearestXRoute: routeAnc ? (routeAnc.getAttribute('x-route') || '').slice(0, 100) : null,
              hiddenReason,
              hostItemsAttr: itemsHost ? (itemsHost.getAttribute('items') || '').slice(0, 120) : null,
            });
          }

          return {
            templateCount: templates.length,
            nonCollapsedTemplateCount: templates.filter((t) => t.getAttribute('data-prerender-collapsed') !== '1').length,
            hint:
              'entries.staticGenerated is read before the x-for mark pass and is always false; use stage post-xfor-mark for data-prerender-static-generated.',
            entries,
            listDiagnostics,
          };
        }).catch(() => null);
        pushDebug({ path: displayPath, stage: 'post-dom-settle', metrics: before });
      }

      // Optional extra delay so in-page async (e.g. fetch() in x-init for client logos) can complete before snapshot.
      if (config.waitAfterIdle > 0) {
        await new Promise((r) => setTimeout(r, config.waitAfterIdle));
      }

      // Wait for async content in static lists: elements with x-init (fetch) + x-html should have content (e.g. inline SVG) before snapshot.
      const asyncContentTimeout = 5000;
      const asyncContentInterval = 100;
      const asyncStart = Date.now();
      for (; ;) {
        const { pending, total } = await page.evaluate(() => {
          const els = document.querySelectorAll('[x-init][x-html]');
          const withFetch = Array.from(els).filter((el) => (el.getAttribute('x-init') || '').includes('fetch'));
          const stillEmpty = withFetch.filter((el) => !el.querySelector('svg') && !el.textContent.trim());
          return { pending: stillEmpty.length, total: withFetch.length };
        });
        if (pending === 0 || total === 0 || Date.now() - asyncStart >= asyncContentTimeout) {
          break;
        }
        await new Promise((r) => setTimeout(r, asyncContentInterval));
      }

      // Strip x-init, x-data, x-html from elements that already have content (e.g. inline SVG from fetch).
      // Keeps the baked-in content as static HTML; Alpine won't re-fetch or overwrite on load.
      await page.evaluate(() => {
        document.querySelectorAll('[x-init][x-html]').forEach((el) => {
          if (!el.querySelector('svg') && !el.textContent.trim()) return;
          el.removeAttribute('x-init');
          el.removeAttribute('x-data');
          el.removeAttribute('x-html');
        });
      });

      // Strip x-markdown from elements that already have baked content.
      // The markdown plugin hides elements with opacity:0 on init, then re-fetches
      // and re-renders.  For prerendered pages the content is already baked —
      // removing x-markdown prevents the runtime plugin from re-processing (and
      // temporarily hiding) the static content.
      //
      // We ALSO clear any leftover `opacity: 0` inline style the plugin set
      // before/while rendering.  On dynamic expressions that initially evaluate
      // empty (e.g. article content keyed off `$route` before `$x.articles` has
      // loaded), the plugin sets opacity to 0 and may never restore it to 1 if
      // the effect re-fires with an empty value.  The end state in the
      // serialized HTML has rendered content but opacity:0 — invisible in
      // production.  Since we're also removing x-markdown (so the runtime
      // plugin doesn't re-hide the element), leaving the inline style would
      // permanently hide authored content.
      await page.evaluate(() => {
        document.querySelectorAll('[x-markdown]').forEach((el) => {
          if (!el.textContent.trim() && !el.innerHTML.trim()) return;
          el.removeAttribute('x-markdown');
          // Clean up opacity-0 + transition inline styles the plugin left behind.
          const style = el.getAttribute('style') || '';
          if (style) {
            const cleaned = style
              .replace(/\bopacity\s*:\s*0(?:\.\d+)?\s*;?/gi, '')
              .replace(/\btransition\s*:\s*opacity[^;]*;?/gi, '')
              .replace(/;\s*;/g, ';')
              .replace(/^\s*;\s*|\s*;\s*$/g, '')
              .trim();
            if (cleaned) el.setAttribute('style', cleaned);
            else el.removeAttribute('style');
          }
        });
      });

      // Emit the hydration contract: walk the DOM, identify every hydrate
      // target (explicit `data-hydrate`, interactive Manifest directives,
      // diff-semantic bindings, runtime-magic-driven bindings), tag each with
      // `data-hydrate-id`, and collect the diff between each target's source
      // attributes (recorded by the MutationObserver in evaluateOnNewDocument)
      // and its current post-render attributes.  The contract is returned as a
      // JSON-serialisable array; the runtime reads it on page load and restores
      // source state before Alpine starts.
      //
      // For explicit `data-hydrate` roots, the entry also carries the original
      // innerHTML so the whole subtree is restored to source, not just its
      // attributes.
      //
      // The catalog here is the authoritative list of "what counts as
      // interactive" and MUST match the docs/articles surface.
      const hydrationContractRaw = await page.evaluate(() => {
        // Drain any mutations not yet delivered to the observer so our source
        // map has the latest values.
        try { window.__manifestFlushHydrateSources && window.__manifestFlushHydrateSources(); } catch (_) {}

        const sourceAttrs = window.__manifestSourceAttrs || new Map();
        const sourceInnerHTML = window.__manifestSourceInnerHTML || new Map();

        // --- CATALOG: what makes an element a hydrate target ---
        // Interactive Manifest-registered directives that attach click/hover/
        // observer state at runtime and therefore need the live Alpine scope.
        const INTERACTIVE_DIRECTIVES = new Set([
          'x-color', 'x-dropdown', 'x-tooltip', 'x-tab', 'x-tabpanel',
          'x-toast', 'x-carousel', 'x-resize', 'x-anchors', 'x-model',
          'x-files', 'x-data-files',
        ]);
        // Runtime-only Alpine magics whose values change after the prerender
        // snapshot (e.g. via media query, route change, auth state).  Bindings
        // referencing these must re-evaluate in the live page.
        const RUNTIME_MAGIC_RX = /(?<!['"])\$(color|locale|url|auth|search|query|toast)\b/;

        const isDiffBindingAttr = (name) =>
          name === ':class' || name === 'x-bind:class' ||
          name === ':style' || name === 'x-bind:style';

        const isEventAttr = (name) =>
          name.charCodeAt(0) === 64 /* @ */ || name.startsWith('x-on:');

        const isBindingAttr = (name) =>
          name.charCodeAt(0) === 58 /* : */ || name.startsWith('x-bind:') || name.startsWith('x-');

        const classifyElement = (el) => {
          // Explicit data-hydrate — subtree-wide restoration.
          if (el.hasAttribute('data-hydrate')) return 'explicit';

          // data-static: the author has frozen this subtree post-bake — Alpine
          // is not re-rendering iteration here, and the baked class/style/etc.
          // represent the intended final state.  Including these elements in
          // the hydration contract would null out their baked class (per the
          // diff-binding rule below), undoing the SEO-baked styling.  Skip.
          if (el.hasAttribute('data-static') || el.closest('[data-static]')) return null;

          const list = el.attributes;
          for (let i = 0; i < list.length; i++) {
            const name = list[i].name;
            const val = list[i].value;

            if (INTERACTIVE_DIRECTIVES.has(name)) return 'interactive';
            if (isEventAttr(name)) return 'event';
            if (isDiffBindingAttr(name)) return 'diff-binding';
            if (isBindingAttr(name) && val && RUNTIME_MAGIC_RX.test(val)) return 'runtime-magic';
          }
          return null;
        };

        // --- Walk: collect all hydrate targets ---
        const targets = new Set();
        const subtreeRoots = new Set(); // explicit roots — restore innerHTML too
        const all = document.body ? document.body.querySelectorAll('*') : [];
        all.forEach((el) => {
          const kind = classifyElement(el);
          if (!kind) return;
          if (kind === 'explicit') {
            subtreeRoots.add(el);
            targets.add(el);
            el.querySelectorAll('*').forEach((d) => targets.add(d));
          } else {
            targets.add(el);
          }
        });

        // --- Build contract entries ---
        let nextId = 0;
        const entries = [];
        targets.forEach((el) => {
          const source = sourceAttrs.get(el);
          const attrsOut = {};
          let dirty = false;

          // Collect attributes that DIVERGED from source.  For each current
          // attribute: if the source recorded a different value (or absent),
          // we need to restore the source value.
          const currentAttrs = {};
          const list = el.attributes;
          for (let i = 0; i < list.length; i++) {
            currentAttrs[list[i].name] = list[i].value;
          }

          if (source) {
            // For every attribute in source, check if current differs.
            for (const name in source) {
              if (name === 'data-hydrate-id') continue;
              const src = source[name];
              const cur = name in currentAttrs ? currentAttrs[name] : null;
              if (src !== cur) {
                // If the source value is null (attribute didn't exist originally)
                // but a reactive Alpine binding controls this attribute, skip the
                // restoration.  Alpine will re-evaluate the binding on init and
                // set the correct value; nulling it in the contract would flash
                // the element unstyled until Alpine + async data loads catch up.
                // The baked value IS the correct initial render.
                if (src === null) {
                  // Keep baked `style` when an Alpine binding manages it.
                  // The baked value (e.g. `mask-image: url(...)` from a `:style`
                  // expression evaluating against $x data, or `display: none`
                  // from `x-show`) is the correct initial render — nulling it
                  // would flash the element while Alpine + async data catch up.
                  // Alpine's :style/x-show handlers diff against the current
                  // DOM correctly, so the baked value is safely toggled later.
                  const skipStyleNull = name === 'style' &&
                    (':style' in source || 'x-bind:style' in source || 'x-show' in source);
                  if (skipStyleNull) continue;
                  // NOTE: do NOT extend this skip to `class`.  Alpine's
                  // `:class="cond ? 'foo' : ''"` (string-form) treats the
                  // pre-existing className as the immutable baseline and only
                  // ADDS classes on top — it cannot REMOVE a baked class.  If
                  // the prerender baked `class="selected"` for the initial
                  // tab, clicking other tabs would never strip `selected`
                  // from the first one.  Always restoring class to null lets
                  // Alpine manage it cleanly from a blank slate.
                }
                attrsOut[name] = src; // may be null (means "remove this attribute")
                dirty = true;
              }
            }
            // For current attributes that weren't in source, remove them.
            for (const name in currentAttrs) {
              if (name === 'data-hydrate-id') continue;
              if (!(name in source)) {
                attrsOut[name] = null;
                dirty = true;
              }
            }
          }
          // If no source recorded and it's not an explicit subtree root, the
          // element had no mutations observed — no restoration needed.

          const innerHTMLSource = sourceInnerHTML.get(el);
          let innerHTMLEntry;
          if (subtreeRoots.has(el) && innerHTMLSource !== undefined) {
            if (innerHTMLSource !== el.innerHTML) {
              innerHTMLEntry = innerHTMLSource;
              dirty = true;
            }
          }

          if (!dirty) return;

          const id = 'h' + nextId++;
          el.setAttribute('data-hydrate-id', id);
          const entry = { id, attrs: attrsOut };
          if (innerHTMLEntry !== undefined) entry.html = innerHTMLEntry;
          entries.push(entry);
        });

        return entries;
      });
      // Stash the contract on the route record for HTML injection later.
      // We carry it through as a string to avoid re-stringifying multiple times.
      const hydrationContractJSON = JSON.stringify(hydrationContractRaw || []);
      if (config.debugPrerender) {
        pushDebug({
          path: displayPath,
          stage: 'hydrate-contract',
          metrics: { entries: (hydrationContractRaw || []).length },
        });
      }

      // x-for lists: keep static lists in the HTML for SEO; collapse only dynamic lists so Alpine re-renders.
      // Explicit: data-prerender="dynamic"|"skip". Inferred: x-for uses $search/$query,
      // $url, $auth, or iterates over getter names (filtered*, results, searchResults). See docs prerender + local.data.
      await page.evaluate(() => {
        document.querySelectorAll('template[x-for]').forEach((tpl) => {
          if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) {
            tpl.removeAttribute('data-prerender-collapsed');
            tpl.removeAttribute('data-prerender-static-generated');
            return;
          }
          const xFor = (tpl.getAttribute('x-for') || '').trim();
          const prerender = (tpl.getAttribute('data-prerender') || '').toLowerCase();
          const explicit = prerender === 'dynamic' || prerender === 'skip';
          const inferred = xFor.includes('$search') || xFor.includes('$query') ||
            xFor.includes('$url') || xFor.includes('$auth') ||
            /\bin\s+(filtered\w*|results|searchResults)\b/.test(xFor);
          // data-static (on template or ancestor) opts the list out of dynamic
          // collapse and pins it to the static-bake path, even if the x-for
          // expression looks dynamic.  Mirrors data-hydrate as the alternative:
          // data-hydrate keeps a subtree live for runtime hydration; data-static
          // freezes baked clones into the HTML for SEO with no further re-render.
          const isStatic = tpl.hasAttribute('data-static') || !!tpl.closest('[data-static]');
          const forceCollapse = !isStatic && (explicit || inferred);
          if (!forceCollapse) {
            tpl.removeAttribute('data-prerender-collapsed');
            tpl.removeAttribute('data-prerender-static-generated');
            // Static mode: if prerender produced concrete siblings, mark template for removal later.
            //
            // Default sibling-match check is strict (tag + class) to avoid
            // capturing unrelated elements that happen to share a tag.  Under
            // data-static the user has explicitly opted in to baking, so we
            // relax to tag-only — Alpine's :class evaluation on clones often
            // differs from the template's static class (e.g. template has no
            // `class=` and clones have an evaluated string), and the strict
            // check would miss the clones and leave the template unmarked.
            const first = tpl.content?.firstElementChild;
            if (first) {
              const tag = first.tagName;
              const cls = first.getAttribute('class') || '';
              let next = tpl.nextElementSibling;
              let generatedCount = 0;
              while (next) {
                if (next.tagName !== tag) break;
                if (!isStatic) {
                  const sameClass = (next.getAttribute('class') || '') === cls;
                  if (!sameClass) break;
                }
                generatedCount++;
                next = next.nextElementSibling;
              }
              if (generatedCount > 0) {
                tpl.setAttribute('data-prerender-static-generated', '1');
              }
            }
            return; // keep prerendered list for SEO
          }
          tpl.setAttribute('data-prerender-collapsed', '1');
          const first = tpl.content?.firstElementChild;
          if (!first) return;
          const tag = first.tagName;
          const cls = first.getAttribute('class') || '';
          let next = tpl.nextElementSibling;
          while (next) {
            const sameTag = next.tagName === tag;
            const sameClass = (next.getAttribute('class') || '') === cls;
            const isLikelyClone = sameTag && sameClass;
            const toRemove = next;
            next = next.nextElementSibling;
            if (isLikelyClone) toRemove.remove();
            else break;
          }
        });
      });

      if (config.debugPrerender) {
        const afterMark = await page.evaluate(() => {
          const rows = [];
          for (const tpl of document.querySelectorAll('template[x-for]')) {
            rows.push({
              xFor: (tpl.getAttribute('x-for') || '').slice(0, 140),
              collapsed: tpl.getAttribute('data-prerender-collapsed') === '1',
              staticGenerated: tpl.getAttribute('data-prerender-static-generated') === '1',
            });
          }
          return {
            templateCount: rows.length,
            staticMarkedCount: rows.filter((r) => r.staticGenerated).length,
            collapsedCount: rows.filter((r) => r.collapsed).length,
            entries: rows.slice(0, 60),
          };
        }).catch(() => null);
        pushDebug({ path: displayPath, stage: 'post-xfor-mark', metrics: afterMark });
      }

      // For static x-for clones that contain data-hydrate elements, inject the loop-scope
      // variable as x-data on the clone element itself. This ensures that after the loop
      // template is removed, data-hydrate bindings referencing loop variables (e.g.
      // plan?.price?.[currency]?.[frequency]) continue to work at runtime via the injected scope.
      // The parent Alpine scope (e.g. <main x-data="{ currency, frequency }") remains accessible.
      await page.evaluate(() => {
        const loopVarRx = /^\s*(?:\(\s*([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*\)|([A-Za-z_$][\w$]*))\s+in\s+/;
        document.querySelectorAll('template[x-for][data-prerender-static-generated="1"]').forEach((tpl) => {
          if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
          const xFor = (tpl.getAttribute('x-for') || '').trim();
          const m = xFor.match(loopVarRx);
          const itemVar = m ? (m[1] || m[3] || '') : '';
          if (!itemVar) return;
          const first = tpl.content && tpl.content.firstElementChild;
          if (!first) return;
          const tag = first.tagName;
          const cls = first.getAttribute('class') || '';
          let n = tpl.nextElementSibling;
          while (n && n.tagName === tag && (n.getAttribute('class') || '') === cls) {
            // Only process clones that contain data-hydrate descendants
            if (
              !n.hasAttribute('x-data') &&
              (n.hasAttribute('data-hydrate') || n.querySelector('[data-hydrate]'))
            ) {
              try {
                const A = window.Alpine;
                if (A) {
                  // Alpine.evaluate(el, expr) evaluates in the full scope chain including
                  // x-for loop variables, unlike Alpine.$data() which only sees x-data attrs.
                  let raw = undefined;
                  if (typeof A.evaluate === 'function') {
                    raw = A.evaluate(n, itemVar);
                  } else if (typeof A.$data === 'function') {
                    // Fallback: $data only sees x-data scopes, not x-for vars
                    const scope = A.$data(n);
                    if (scope && Object.prototype.hasOwnProperty.call(scope, itemVar)) {
                      raw = scope[itemVar];
                    }
                  }
                  if (raw !== undefined && raw !== null) {
                    // Serialize only own-enumerable properties to avoid circular refs / proxies
                    const snapshot = JSON.parse(JSON.stringify(raw));
                    n.setAttribute('x-data', JSON.stringify({ [itemVar]: snapshot }));
                  }
                }
              } catch { /* serialisation failed — leave binding as-is */ }
            }
            n = n.nextElementSibling;
          }
        });
      });

      // Strip loop-scope bindings from x-for clones while <template> nodes still exist.
      // (If we remove static templates first, querySelectorAll('template[x-for]') misses them and clones
      // keep x-text/x-bind referencing card/item — Alpine then mutates or errors on the static HTML.)
      //
      // Wrapped in Alpine.mutateDom so attribute removals (e.g. removing :class)
      // don't trigger Alpine's reactive teardown — without this, Alpine sees
      // the :class attribute disappear, runs its unbind effect, and clears the
      // bound attribute (class) back to its pre-binding value (empty for clones
      // whose template had no static class).  mutateDom suppresses the observer
      // for the duration of the callback.
      await page.evaluate(() => {
        const A = window.Alpine;
        const runBatch = typeof A?.mutateDom === 'function' ? (fn) => A.mutateDom(fn) : (fn) => fn();
        const loopVarRegex = /^\s*(?:\(\s*([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*\)|([A-Za-z_$][\w$]*))\s+in\s+/;
        // Include x-init: expanded clones still had x-init="getDescription(article)" etc.; Alpine then throws (article undefined).
        const bindingAttrRegex = /^(?:x-bind:|:|x-text|x-html|x-show|x-if|x-model|x-effect|x-init|x-icon|x-on:|@)/;
        const hasVar = (expr, varName) => varName && new RegExp(`\\b${varName}\\b`).test(expr || '');
        const stripLoopBindings = (el, itemVar, indexVar) => {
          const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
          for (const node of nodes) {
            // Skip elements inside data-hydrate islands — their bindings must remain live
            if (node.hasAttribute('data-hydrate') || node.closest('[data-hydrate]')) continue;
            const attrs = node.attributes ? Array.from(node.attributes) : [];
            for (const attr of attrs) {
              if (!bindingAttrRegex.test(attr.name)) continue;
              const expr = attr.value || '';
              if (hasVar(expr, itemVar) || hasVar(expr, indexVar)) {
                const name = attr.name;
                if (name === 'x-text' || name === 'x-html') {
                  if ((node.textContent || '').trim() || (node.innerHTML || '').trim()) {
                    node.removeAttribute(name);
                  }
                  continue;
                }
                if (name === 'x-show' || name === 'x-if') {
                  node.removeAttribute(name);
                  continue;
                }
                if (name === 'x-icon') {
                  node.setAttribute('x-icon', '');
                  continue;
                }
                let boundAttr = '';
                if (name.startsWith(':')) boundAttr = name.slice(1);
                else if (name.startsWith('x-bind:')) boundAttr = name.slice('x-bind:'.length);
                if (boundAttr) {
                  const concrete = node.getAttribute(boundAttr);
                  if (concrete != null && String(concrete).trim() !== '') {
                    // Removing :foo triggers Alpine's binding teardown, which
                    // restores the bound attribute to its pre-binding value
                    // (empty for clones whose template had no static class).
                    // Snapshot the eval'd value and re-set it after removal so
                    // the baked attribute survives the unbind.
                    node.removeAttribute(name);
                    node.setAttribute(boundAttr, concrete);
                  }
                  continue;
                }
                node.removeAttribute(name);
              }
            }
          }
        };

        runBatch(() => {
          document.querySelectorAll('template[x-for]').forEach((tpl) => {
            if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
            const xFor = (tpl.getAttribute('x-for') || '').trim();
            const m = xFor.match(loopVarRegex);
            const itemVar = m ? (m[1] || m[3] || '') : '';
            const indexVar = m ? (m[2] || '') : '';
            if (!itemVar && !indexVar) return;

            const first = tpl.content?.firstElementChild;
            if (!first) return;
            const tag = first.tagName;

            let next = tpl.nextElementSibling;
            while (next) {
              if (next.tagName !== tag) break;
              stripLoopBindings(next, itemVar, indexVar);
              next = next.nextElementSibling;
            }
          });
        });
      });

      // Remove static x-for templates once static clones are generated.
      // Alpine registers a cleanup on <template x-for> that removes every node in _x_lookup when the
      // template is detached — so tpl.remove() alone deletes all sibling clones (empty grids in output).
      // Replace each clone with a deep cloneNode first so teardown targets detached nodes; copies stay in DOM.
      //
      // Iterate until quiet: when an outer template's siblings are deep-cloned,
      // any nested templates inside those clones become FRESH DOM nodes that
      // weren't in the original querySelectorAll snapshot.  We re-query and
      // re-process until no marked templates remain, so nested static lists
      // (e.g. <template x-for="group in $x.docs"> with an inner
      // <template x-for="item in group.items">) are fully baked and removed.
      await page.evaluate(() => {
        const A = window.Alpine;
        const runBatch = typeof A?.mutateDom === 'function' ? (fn) => A.mutateDom(fn) : (fn) => fn();
        const SAFETY_PASSES = 8;
        for (let pass = 0; pass < SAFETY_PASSES; pass++) {
          const remaining = document.querySelectorAll('template[x-for][data-prerender-static-generated="1"]');
          if (remaining.length === 0) break;
          let processed = 0;
          runBatch(() => {
            remaining.forEach((tpl) => {
            if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
            // $x-driven x-for: by default, keep the template so Alpine can
            // re-render the list at runtime (locale switching, filtering, etc.)
            // and remove the static clones — Alpine creates fresh clones on
            // init and does NOT adopt existing DOM nodes, so leaving them
            // produces duplicates.  Individual article/pricing pages still
            // have full baked content (via x-text/x-html); the x-for list is
            // only the index/grid view.
            //
            // Opt-in via data-static (on template or ancestor) reverses this:
            // we keep the baked clones for SEO and remove the template instead,
            // which freezes the list (Alpine has nothing left to iterate, so
            // no duplicates and no runtime re-render).  Use this for static
            // navigation lists or any $x-driven list whose source data does
            // not change after first paint.  Loop-scope bindings on the kept
            // clones are stripped earlier in the pipeline.
            const xFor = (tpl.getAttribute('x-for') || '');
            const isStatic = tpl.hasAttribute('data-static') || !!tpl.closest('[data-static]');
            if (xFor.includes('$x') && !isStatic) {
              const first = tpl.content?.firstElementChild;
              if (first) {
                const tag = first.tagName;
                const cls = first.getAttribute('class') || '';
                let n = tpl.nextElementSibling;
                while (n && n.tagName === tag && (n.getAttribute('class') || '') === cls) {
                  const next = n.nextElementSibling;
                  n.remove();
                  n = next;
                }
              }
              tpl.removeAttribute('data-prerender-static-generated');
              return;
            }
            const parent = tpl.parentNode;
            if (!parent) {
              tpl.remove();
              return;
            }
            const first = tpl.content?.firstElementChild;
            if (!first) {
              tpl.remove();
              return;
            }
            const tag = first.tagName;
            const cls = first.getAttribute('class') || '';
            let n = tpl.nextElementSibling;
            while (n && n.tagName === tag) {
              // Same rationale as the marking pass: under data-static, relax
              // class match (Alpine's :class evaluation on clones often differs
              // from the template's static class).
              if (!isStatic && (n.getAttribute('class') || '') !== cls) break;
              const next = n.nextElementSibling;
              n.replaceWith(n.cloneNode(true));
              n = next;
            }
            tpl.remove();
            processed++;
          });
          });
          if (processed === 0) break;
        }
      });

      // Remove orphan x-for clones that still reference loop-scope vars (e.g. image/index)
      // outside their template scope. These throw Alpine errors in live static hosting.
      await page.evaluate(() => {
        const loopVarRegex = /^\s*(?:\(\s*([A-Za-z_$][\w$]*)(?:\s*,\s*([A-Za-z_$][\w$]*))?\s*\)|([A-Za-z_$][\w$]*))\s+in\s+/;
        const bindingAttrRegex = /^(?:x-bind:|:|x-text|x-html|x-show|x-if|x-model|x-effect|x-init|x-icon|x-on:|@)/;
        const hasVar = (expr, varName) => varName && new RegExp(`\\b${varName}\\b`).test(expr || '');
        const elementReferencesLoopScope = (el, itemVar, indexVar) => {
          if (!el) return false;
          const nodes = [el, ...Array.from(el.querySelectorAll('*'))];
          for (const node of nodes) {
            const attrs = node.attributes ? Array.from(node.attributes) : [];
            for (const attr of attrs) {
              if (!bindingAttrRegex.test(attr.name)) continue;
              const expr = attr.value || '';
              if (hasVar(expr, itemVar) || hasVar(expr, indexVar)) return true;
            }
          }
          return false;
        };

        // Only clean up templates we intentionally collapsed above.
        // Running this on all x-for templates can remove valid prerendered list items.
        document.querySelectorAll('template[x-for][data-prerender-collapsed="1"]').forEach((tpl) => {
          const xFor = (tpl.getAttribute('x-for') || '').trim();
          const m = xFor.match(loopVarRegex);
          const itemVar = m ? (m[1] || m[3] || '') : '';
          const indexVar = m ? (m[2] || '') : '';
          if (!itemVar && !indexVar) return;

          const first = tpl.content?.firstElementChild;
          if (!first) return;
          const tag = first.tagName;

          let next = tpl.nextElementSibling;
          while (next) {
            const sameTag = next.tagName === tag;
            if (!sameTag) break;

            const referencesLoopScope = elementReferencesLoopScope(next, itemVar, indexVar);

            const toRemove = next;
            next = next.nextElementSibling;
            if (referencesLoopScope) toRemove.remove();
            else break;
          }
        });
      });

      // data-static cleanup: any <template> still inside a [data-static] subtree
      // is removed.  Plugin-driven templates (x-anchors, custom directives that
      // insert their rendered output as siblings) leave the rendered DOM behind
      // and the template intact — at runtime the plugin would re-run and
      // duplicate the output.  Removing the template here is the equivalent of
      // the x-for static path: bake the rendered content, drop the source.
      // x-for templates have their own staged removal earlier in the pipeline;
      // this catch-all cleans up everything else.
      await page.evaluate(() => {
        document.querySelectorAll('[data-static] template, template[data-static]').forEach((tpl) => {
          // Don't remove templates explicitly marked data-hydrate (those are an
          // opt-out from any prerender transforms within the data-static subtree).
          if (tpl.hasAttribute('data-hydrate') || tpl.closest('[data-hydrate]')) return;
          tpl.remove();
        });
      });

      const visibilityNormalizedPath = logicalPathToVisibilityNormalizedPath(pathSeg, locales);
      await page.evaluate((np) => {
        try {
          window.ManifestRoutingVisibility?.processRouteVisibility?.(np);
        } catch {
          /* no-op */
        }
      }, visibilityNormalizedPath);

      // Remove route-hidden content ([x-route] with inline style display:none) so each prerendered page contains only that route's HTML.
      await page.evaluate(() => {
        const reDisplayNone = /\bdisplay\s*:\s*none\b/i;
        const candidates = document.querySelectorAll('[x-route][style*="display"]');
        const toRemove = Array.from(candidates).filter((el) => reDisplayNone.test(el.getAttribute('style') || ''));
        const depth = (el) => { let d = 0; let n = el; while (n && n !== document.body) { d++; n = n.parentElement; } return d; };
        toRemove.sort((a, b) => depth(a) - depth(b)); // remove outer first so subtrees go in one go
        toRemove.forEach((el) => { if (document.contains(el)) el.remove(); });
      });

      // SEO / AEO meta injection — see resolveConfig().seo for precedence layers.
      // Runs in the live page so prerender.meta expressions can use Alpine context
      // (real $x.* evaluation, not yaml-only paths).  Each pass only fills
      // slots that are still missing; data-head and index.html static head wins.
      // The og:image snapshot was captured earlier (post-Alpine, pre-transforms);
      // this pass uses it as the highest smart-default for the image slot.
      await injectMetaInDom(page, {
        seo: config.seo,
        liveUrl: (config.liveUrl || '').replace(/\/$/, ''),
        pathSeg: is404 ? '__404__' : pathSeg,
        snapshotUrl: earlySnapshotUrl,
      });

      let html = await page.evaluate(() => document.documentElement.outerHTML);
      // Inject the hydration contract blob into the raw HTML *before* caching
      // it for locale variant generation, so every locale variant inherits the
      // same contract (locale substitution only mutates visible text, not the
      // JSON blob).  The same injection happens again later in the Puppeteer
      // path after Node.js post-processing, but injecting early simplifies the
      // cache model: "raw HTML carries its own contract."
      if (hydrationContractJSON && hydrationContractJSON !== '[]') {
        const safe = hydrationContractJSON.replace(/<\/script/gi, '<\\/script');
        html = html.replace(
          '</body>',
          `<script type="application/json" id="__manifest_hydrate__">${safe}</script>\n</body>`
        );
      }
      // Cache raw DOM snapshot for locale variant generation (before any Node.js transforms).
      if (typeof onRawHtml === 'function') onRawHtml(pathSeg, html);
      if (config.debugPrerender) {
        const post = await page.evaluate(() => {
          const templates = document.querySelectorAll('template[x-for]').length;
          const links = document.querySelectorAll('a[href="#"]').length;
          const hidden = document.querySelectorAll('[style*="display: none"]').length;
          return { templateCountAfterCleanup: templates, hashHrefCount: links, displayNoneCount: hidden };
        }).catch(() => null);
        pushDebug({ path: displayPath, stage: 'pre-serialize', metrics: post });
      }
      html = stripDevOnlyContent(html);
      html = stripInjectedPluginScripts(html, config.root);
      if (tailwindBuilt) {
        html = stripRuntimeTailwindArtifacts(html);
      } else {
        html = stripDataTailwindAttr(html);
      }
      html = debakeThemeClass(html);
      if (bundleUtilities) {
        const extracted = extractUtilityStyleBlocks(html);
        html = extracted.html;
        for (const b of extracted.blocks) utilityBlocks.push(b);
      }
      if (tailwindBuilt) {
        html = injectBeforeHeadClose(
          html,
          `<link rel="stylesheet" href="${buildRootAssetPath(routerBasePath, 'prerender.tailwind.css')}">`
        );
      }
      html = stripDuplicatedLoopDirectives(html);
      html = stripPrerenderedXDataDirectives(html);
      const content = loadContentForPrerender(manifest, config.root, currentLocale);
      const xData = { manifest, content };
      html = resolveHeadXBindings(html, xData);
      html = stripPrerenderDynamicBindings(html);
      html = stripPrerenderBakedRadioCheckedForXModel(html);
      html = stripRedundantImgSrcBindings(html);
      html = stripEmptyInlineMaskStyles(html);
      html = stripResolvedXIconDirectives(html);
      html = markPrerenderedManifestComponents(html);

      // Prefix internal <a> links with the locale for non-default locales so
      // MPA navigation stays in-locale without relying on runtime JS.
      if (currentLocale && currentLocale !== defaultLocale) {
        html = prefixLocaleInternalLinks(html, currentLocale, locales, config.localeRouteExclude);
      }

      html = rewriteHtmlAssetPaths(html, fileSegments.length);
      const liveBase = config.liveUrl.replace(/\/$/, '');
      const canonicalHreflang = buildCanonicalAndHreflang(is404 ? '' : pathSeg, locales, defaultLocale, liveBase);
      const ogLocale = buildOgLocale(is404 ? '' : pathSeg, locales, defaultLocale);
      const injectOgLocale = ogLocale && hasOtherOgMeta(html);
      if (injectOgLocale) html = stripOgLocaleFromHead(html);
      const baseMeta = routerBasePath !== null ? `<meta name="manifest:router-base" content="${String(routerBasePath).replace(/"/g, '&quot;')}">\n` : '';
      const routeEx = config.localeRouteExclude || [];
      const routeMeta =
        routeEx.length > 0
          ? `<meta name="manifest:locale-route-exclude" content="${JSON.stringify(routeEx).replace(/"/g, '&quot;')}">\n`
          : '';
      const routeDepth = fileSegments.length;
      const prerenderedMeta = `<meta name="manifest:prerendered" content="1">\n`;
      const prerenderLocalesMeta =
        Array.isArray(locales) && locales.length > 0
          ? `<meta name="manifest:prerender-locales" content="${locales.join(',')}">\n`
          : '';
      html = html.replace(
        '</head>',
        `${canonicalHreflang}${injectOgLocale ? ogLocale : ''}${routeMeta}${baseMeta}${prerenderLocalesMeta}${prerenderedMeta}<meta name="manifest:router-base-depth" content="${routeDepth}">\n</head>`
      );
      // (Hydration contract was already injected into the raw HTML before
      // the Node.js post-processing pipeline ran, so it's already present.)
      html = ensureDoctype(html);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(outFile, html, 'utf8');
      pushDebug({
        path: displayPath,
        stage: 'wrote',
        outFile,
        htmlBytes: Buffer.byteLength(html, 'utf8'),
        hasXForTemplate: html.includes('template x-for') || html.includes('template[x-for]'),
      });
    } catch (err) {
      failedPaths.push({
        path: displayPath,
        message: err && err.message ? err.message : String(err)
      });
      if (failedPaths.length <= 10) {
        process.stderr.write(`prerender: failed ${displayPath}: ${failedPaths[failedPaths.length - 1].message}\n`);
      }
    } finally {
      try { await page.close(); } catch (_) { /* page may be gone if browser died */ }
    }
  }

  // Phase 1: Puppeteer — render base paths, cache raw DOM for substitution.
  // Any failures (e.g. transient navigation timeouts) are retried up to
  // `maxRetries` times with a short backoff before being reported as fatal.
  //
  // Browser recycling: after every `browserRecycleEvery` successful pages,
  // all workers pause, one worker closes the browser and launches a fresh
  // one, then all resume.  This bounds Chromium's memory + handle growth.
  try {
    let index = 0;
    let activeWorkers = 0;
    const recycleGate = { resume: null, waitForZero: null };

    const waitUntilZero = () => new Promise((resolve) => {
      if (activeWorkers === 0) return resolve();
      recycleGate.waitForZero = resolve;
    });
    const waitForResume = () => new Promise((resolve) => {
      if (!recycleLock.busy) return resolve();
      const prev = recycleGate.resume;
      recycleGate.resume = () => { if (prev) prev(); resolve(); };
    });

    const maybeRecycleBrowser = async () => {
      if (browserRecycleEvery <= 0) return;
      if (pagesSinceRecycle < browserRecycleEvery) return;
      if (recycleLock.busy) return;
      recycleLock.busy = true;
      // Wait for all in-flight workers to finish their current page BEFORE
      // we gate `browserReadyPromise`, so workers already mid-processPath
      // don't deadlock awaiting a promise we haven't yet started.
      await waitUntilZero();
      // Now gate newPage() calls from any worker that enters processPath
      // after this point.
      let resolveReady;
      browserReadyPromise = new Promise((r) => { resolveReady = r; });
      try {
        process.stdout.write(`prerender: recycling browser (processed ${pagesSinceRecycle} pages)\n`);
        try { await browser.close(); } catch (_) {}
        browser = await launchBrowser();
        pagesSinceRecycle = 0;
      } finally {
        // Release the gate first so any waiting workers can proceed, then
        // clear the recycle lock so the outer while loop stops pausing.
        try { resolveReady(); } catch (_) {}
        recycleLock.busy = false;
        const r = recycleGate.resume;
        recycleGate.resume = null;
        if (r) r();
      }
    };

    async function worker() {
      while (true) {
        // Pause if a recycle is underway.
        if (recycleLock.busy) await waitForResume();
        // Also wait for any pending browser readiness (e.g. another worker
        // started a recycle while we were processing).
        await browserReadyPromise;

        const i = index++;
        if (i >= puppeteerPaths.length) return;
        const pathSeg = puppeteerPaths[i];
        let attempt = 0;
        while (true) {
          // Re-check recycle state at the start of every retry iteration.
          if (recycleLock.busy) await waitForResume();
          await browserReadyPromise;

          const failureCountBefore = failedPaths.length;
          activeWorkers++;
          try {
            await processPath(pathSeg, i, {
              onRawHtml: (seg, html) => {
                if (seg !== NOT_FOUND_PATH) baseHtmlCache.set(seg || '', html);
              },
            });
          } catch (err) {
            // Unexpected exception escaped processPath (e.g. browser died
            // mid-call).  Record as a failure so the retry logic can handle
            // it gracefully instead of tearing down the whole worker.
            failedPaths.push({
              path: pathSeg === '' ? '/' : '/' + pathSeg,
              message: err && err.message ? err.message : String(err),
            });
            if (failedPaths.length <= 10) {
              process.stderr.write(`prerender: worker exception on ${pathSeg || '/'}: ${failedPaths[failedPaths.length - 1].message}\n`);
            }
          } finally {
            activeWorkers--;
            if (activeWorkers === 0 && recycleGate.waitForZero) {
              const z = recycleGate.waitForZero;
              recycleGate.waitForZero = null;
              z();
            }
          }
          if (failedPaths.length === failureCountBefore) {
            pagesSinceRecycle++;
            break; // success
          }
          if (attempt >= maxRetries) {
            // Exhausted retries — likely an unstable browser (e.g. cascading
            // "detached Frame" errors).  Force a recycle counter past the
            // threshold so the next path triggers a fresh browser.
            pagesSinceRecycle = Math.max(pagesSinceRecycle + 1, browserRecycleEvery);
            break;
          }
          // Halfway through retries with no success → preemptively recycle the
          // browser before the next attempt.  This unblocks cascading frame
          // failures where the browser process needs a fresh start.
          if (attempt + 1 >= Math.ceil(maxRetries / 2) && pagesSinceRecycle > 0) {
            pagesSinceRecycle = Math.max(pagesSinceRecycle, browserRecycleEvery);
            await maybeRecycleBrowser();
          }
          failedPaths.pop();
          attempt++;
          const displayPath = pathSeg === '' ? '/' : (pathSeg === NOT_FOUND_PATH ? '/__prerender_404__' : '/' + pathSeg);
          process.stderr.write(`prerender: retrying ${displayPath} (attempt ${attempt + 1}/${maxRetries + 1})\n`);
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
        // Attempt recycle after each completed path (only one worker will
        // actually perform the recycle; others will be gated by recycleLock).
        await maybeRecycleBrowser();
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, puppeteerPaths.length || 1) }, () => worker())
    );
  } finally {
    try { await browser.close(); } catch (_) {}
  }

  // Phase 2: Node.js — generate locale variants via text substitution
  if (localeVariantPaths.length > 0) {
    process.stdout.write(`  Generating ${localeVariantPaths.length} locale variant(s) via text substitution...\n`);
    let substIndex = 0;
    for (const { pathSeg, basePathSeg, targetLocale } of localeVariantPaths) {
      substIndex++;
      const rawHtml = baseHtmlCache.get(basePathSeg);
      if (!rawHtml) {
        // Base path was expected to be Puppeteer-rendered but is absent — its render likely failed.
        failedPaths.push({ path: '/' + pathSeg, message: `base path "${basePathSeg || '/'}" missing from cache (did its Puppeteer render fail?)` });
        process.stderr.write(`prerender: skipped /${pathSeg} — base "${basePathSeg || '/'}" not in cache\n`);
        continue;
      }

      const displayPath = '/' + pathSeg;
      process.stdout.write(`  [subst ${substIndex}/${localeVariantPaths.length}] ${displayPath}\n`);

      try {
        const pairs = substitutionMaps.get(targetLocale) || [];
        const { html, utilityBlocks: pageBlocks } = generateLocaleVariantHtml({
          rawHtml, pathSeg, targetLocale, locales, defaultLocale,
          config, manifest, routerBasePath, tailwindBuilt, bundleUtilities,
          substitutionPairs: pairs,
        });
        for (const b of pageBlocks) utilityBlocks.push(b);

        const fileSegments = pathToFileSegments(pathSeg ? '/' + pathSeg : '/');
        const outDir = join(config.output, ...fileSegments);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'index.html'), ensureDoctype(html), 'utf8');
      } catch (err) {
        failedPaths.push({ path: displayPath, message: err?.message ?? String(err) });
        process.stderr.write(`prerender: substitution failed ${displayPath}: ${failedPaths[failedPaths.length - 1].message}\n`);
      }
    }
  }

  if (failedPaths.length > 0) {
    const sample = failedPaths.slice(0, 5).map((f) => `${f.path}: ${f.message}`).join(' | ');
    throw new Error(`prerender failed for ${failedPaths.length}/${pathTotal} paths. Sample: ${sample}`);
  }

  if (config.debugPrerender) {
    const reportPath = join(outputResolved, 'prerender.debug.json');
    writeFileSync(reportPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      totalPaths: pathTotal,
      failedPaths,
      rows: debugRows,
    }, null, 2), 'utf8');
    process.stdout.write(`prerender: debug report ${reportPath}\n`);
  }

  if (bundleUtilities) {
    const utilMerged = mergeUtilityCssBlocks(utilityBlocks);
    if (utilMerged.trim()) {
      writeFileSync(join(outputResolved, 'prerender.utilities.css'), `${utilMerged}\n`, 'utf8');
      process.stdout.write('prerender: wrote prerender.utilities.css (Manifest custom utilities)\n');
      postProcessInjectStylesheetLink(outputResolved, 'prerender.utilities.css', routerBasePath || '');
    }
  }

  writeSeoFiles(
    config.output,
    pathList.filter((p) => p !== NOT_FOUND_PATH),
    config.liveUrl,
    locales,
    defaultLocale,
    {
      rootDir: config.root,
      manifest: config.manifest,
      siteName: config.seo?.siteName,
      siteDescription: config.seo?.siteDescription,
    }
  );
  writeOutputProtectionFiles(config.output);
  validatePrerenderedOutput(config.output, pathList.filter((p) => p !== NOT_FOUND_PATH));

  if (config.redirects.length > 0) {
    const lines = config.redirects.map((r) => {
      if (typeof r === 'string') return r;
      const from = r.from ?? r.fromPath ?? '';
      const to = r.to ?? r.toPath ?? r.redirect ?? '';
      const status = r.status ?? r.force ?? 301;
      return `${from} ${to} ${status}`;
    });
    writeFileSync(join(config.output, '_redirects'), lines.join('\n'), 'utf8');
  }

}

// Auto-run main() when this file is the direct entry point (node manifest.render.mjs)
// but NOT when imported by the bin wrapper or test harness.  The bin wrapper
// calls main() explicitly; test harnesses only need the exported helpers.
const _isDirectEntry = (() => {
  try {
    const arg1 = process.argv[1];
    if (!arg1) return false;
    const invoked = String(new URL('file://' + resolve(arg1)));
    return invoked === import.meta.url;
  } catch { return false; }
})();

if (_isDirectEntry) {
  main().catch((err) => {
    console.error('prerender:', err);
    process.exit(1);
  });
}

// Exports for the CLI bin script and for unit testing.
export { main, markPrerenderedManifestComponents };
