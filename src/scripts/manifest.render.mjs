#!/usr/bin/env node

/* Manifest Render */

import { readFileSync, readSync, mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, statSync, readdirSync, cpSync, unlinkSync, renameSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, relative, basename, sep } from 'node:path';
import { createServer } from 'node:http';
import { cpus, hostname } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import {
  NOT_FOUND_PATH,
  scriptSrcSet,
  stripInjectedScripts,
  flushAlpineEffects,
  logicalPathToVisibilityNormalizedPath,
  waitForManifestRenderReady,
  normalizeLocaleRouteExclude,
  isLocaleRouteExcluded,
  routeMatchesGlob,
  isLocaleSubstitutionExcludedPath,
  expandLocaleRoutePaths,
  extractXRouteConditions,
  normalizeRouteCondition,
  conditionsToPaths,
  getWildcardBasesFromConditions,
  pathToFileSegments,
  stripDevOnlyContent,
  stripRuntimeTailwindArtifacts,
  stripDataTailwindAttr,
  ensureDoctype,
  debakeThemeClass,
  extractUtilityStyleBlocks,
  injectBeforeHeadClose,
  mergeUtilityCssBlocks,
  buildRootAssetPath,
  stripDuplicatedLoopDirectives,
  isHydrateMarkedAttrs,
  stripPrerenderedXDataDirectives,
  stripPrerenderDynamicBindings,
  stripRedundantImgSrcBindings,
  stripLazyIconSvgs,
  stripResolvedXIconDirectives,
  markPrerenderedManifestComponents,
  stripEmptyInlineMaskStyles,
  isPrerenderBundleAssetPath,
  rewriteHtmlAssetPaths,
  stripPrerenderBakedRadioCheckedForXModel,
  buildCanonicalAndHreflang,
  getAlternateLinksForPath,
  escapeXmlText,
  buildOgLocale,
  stripOgLocaleFromHead,
  hasOtherOgMeta,
  prefixLocaleInternalLinks,
  getXPath,
  resolveHeadXBindings,
  waitForVisualSettle,
  injectMetaInDom,
  htmlToText,
  groupLlmsSections,
  renderRouteDom,
  finalizeRouteHtml,
  extractRouteContentFromHtml,
  buildRobotsTxt,
  buildSitemapXml,
  buildLlmsFiles,
} from './manifest.render.page.mjs';

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

// --- Browser recycle gate ----------------------------------------------------

/** Bound a promise: resolves true if it settles first, false on timeout. */
function withDeadline(promise, ms) {
  if (!(ms > 0)) return Promise.resolve(promise).then(() => true);
  let timer;
  const settled = Promise.resolve(promise).then(
    () => { clearTimeout(timer); return true; },
    (err) => { clearTimeout(timer); throw err; }
  );
  return Promise.race([
    settled,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

/**
 * True for a Puppeteer failure message caused by a browser-recycle race
 * (page/frame torn down mid-evaluate) rather than the page's own content —
 * retrying with backoff wastes time on a race; the caller requeues these
 * immediately instead. Exported for unit tests.
 */
export function isTransientFrameError(message) {
  return /detached frame|Execution context (is not available|was destroyed)/i.test(String(message || ''));
}

/**
 * Coordinates render workers around a shared browser swapped every `every`
 * completed paths. A recycle pauses new slots, drains in-flight ones, swaps,
 * resumes. Forced recycles are coalesced per browser generation and rate
 * limited by `forcedCooldown` completed paths, unless `healthy()` reports a
 * dead browser. Exported for unit tests.
 */
export function createRecycleGate({
  every = 40,
  forcedCooldown = Math.max(1, Math.ceil(every / 4)),
  healthy = () => true,
  recycle = async () => {},
  drainTimeoutMs = 60000,
  recycleTimeoutMs = 180000,
  onLog = () => {},
} = {}) {
  let active = 0;
  let pages = 0;
  let sinceForced = Infinity;
  let forced = false;
  let paused = false;
  let generation = 0;
  let recycles = 0;
  let forcedRecycles = 0;
  const zeroWaiters = [];
  const resumeWaiters = [];
  const wake = (list) => { for (const resolve of list.splice(0)) resolve(); };
  const due = () => every > 0 && (pages >= every || (forced && (sinceForced >= forcedCooldown || !healthy())));

  return {
    get active() { return active; },
    get pages() { return pages; },
    get paused() { return paused; },
    get generation() { return generation; },
    get forced() { return forced; },
    get recycles() { return recycles; },
    get forcedRecycles() { return forcedRecycles; },
    /** Claim a browser slot; resolves with the browser generation. */
    async acquire() {
      while (paused) await new Promise((resolve) => { resumeWaiters.push(resolve); });
      active++;
      return generation;
    },
    release() {
      active = Math.max(0, active - 1);
      if (active === 0) wake(zeroWaiters);
    },
    /** Count one completed path. */
    countPage() { pages++; sinceForced++; },
    /** Ask for a fresh browser; ignored if `gen` is already replaced. */
    requestRecycle(gen) {
      if (every <= 0) return false;
      if (gen !== undefined && gen !== generation) return false;
      forced = true;
      return true;
    },
    /** Swap the browser if due.  Never throws. */
    async maybeRecycle() {
      if (paused || !due()) return false;
      paused = true;
      const processed = pages;
      const isForced = pages < every;
      try {
        while (active > 0) {
          const drained = await withDeadline(
            new Promise((resolve) => { zeroWaiters.push(resolve); }),
            drainTimeoutMs
          );
          if (!drained) onLog(`recycle: ${active} page(s) still in flight after ${drainTimeoutMs}ms — waiting (a leaked page never released its slot)`);
        }
        recycles++;
        if (isForced) { forcedRecycles++; sinceForced = 0; }
        const swapped = await withDeadline(recycle(processed, { forced: isForced }), recycleTimeoutMs);
        if (!swapped) onLog(`recycle: browser swap exceeded ${recycleTimeoutMs}ms — continuing`);
        return swapped;
      } catch (err) {
        onLog(`recycle: failed (${err && err.message ? err.message : err}) — continuing`);
        return false;
      } finally {
        pages = 0;
        forced = false;
        generation++;
        paused = false;
        wake(resumeWaiters);
      }
    },
  };
}

/**
 * Render `items` through the gate with per-attempt watchdog and retries.
 * `render(item, index, token)` may set `token.cancel` to tear down a wedged
 * attempt; a timed-out attempt keeps its slot until cancelled/settled
 * (bounded by `abandonGraceMs`) so a swap never lands under it.
 * Exported for unit tests.
 */
export async function runRenderQueue({
  items,
  concurrency = 1,
  gate,
  render,
  pageTimeoutMs = 0,
  maxRetries = 2,
  abandonGraceMs = 15000,
  labelOf = (item) => String(item),
  onRetry = () => {},
  onFail = () => {},
} = {}) {
  let index = 0;
  const failures = [];

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      const item = items[i];
      const label = labelOf(item);
      let attempt = 0;
      while (true) {
        const token = { abandoned: false, failure: null, cancel: null };
        const gen = await gate.acquire();
        let timedOut = false;
        try {
          const run = Promise.resolve().then(() => render(item, i, token));
          const finished = await withDeadline(run, pageTimeoutMs);
          if (!finished) {
            timedOut = true;
            token.abandoned = true;
            token.failure = { path: label, message: `page render exceeded ${pageTimeoutMs}ms` };
            // Hold the slot until the orphan is torn down
            await withDeadline(Promise.resolve().then(() => token.cancel?.()).catch(() => {}), abandonGraceMs);
            await withDeadline(run.catch(() => {}), abandonGraceMs);
          }
        } catch (err) {
          token.failure = { path: label, message: err && err.message ? err.message : String(err) };
        } finally {
          gate.release();
        }
        if (!token.failure) { gate.countPage(); break; }
        if (attempt >= maxRetries) {
          failures.push(token.failure);
          onFail(token.failure, failures.length);
          gate.countPage();
          gate.requestRecycle(gen);
          break;
        }
        const immediate = isTransientFrameError(token.failure.message);
        // Suspect browser: fresh one before the retry
        if (timedOut || (!immediate && attempt + 1 >= Math.ceil(maxRetries / 2))) {
          gate.requestRecycle(gen);
          await gate.maybeRecycle();
        }
        attempt++;
        onRetry(token.failure, attempt, immediate);
        if (!immediate) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
      await gate.maybeRecycle();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()));
  return failures;
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
    if (args[i] === '--force-lock') { out.forceLock = true; continue; }
    if (args[i] === '--debug-prerender') { out.debugPrerender = true; continue; }
    if (args[i] === '--locale-substitution') { out.localeSubstitution = true; continue; }
    if (args[i] === '--no-locale-substitution') { out.localeSubstitution = false; continue; }
    if (args[i] === '--locale-substitution-exclude' && args[i + 1]) { out.localeSubstitutionExclude = args[++i]; continue; }
    if (args[i] === '--locale-substitution-exclude-paths' && args[i + 1]) { out.localeSubstitutionExcludePaths = args[++i]; continue; }
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

function resolveConfig() {
  const cli = parseArgs();
  const cwd = process.cwd();
  const root = resolve(cwd, cli.root ?? '.');
  const manifest = loadConfig(root);
  // Render config lives under manifest.render (per schema + docs). Older
  // projects used manifest.prerender — keep reading it as a fallback so they
  // don't silently lose their config.
  const pre = manifest.render ?? manifest.prerender ?? {};

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
    // Locale substitution on/off + exclusions — read from CLI, then manifest.json
    // prerender.*, like their sibling config values above (was hardcoded before).
    localeSubstitution: cli.localeSubstitution ?? pre.localeSubstitution ?? true,
    localeSubstitutionExclude: normalizeLocaleRouteExclude(
      cli.localeSubstitutionExclude ?? pre.localeSubstitutionExclude
    ),
    /** Route globs (e.g. "articles/*"), matched against the locale-stripped route —
     *  matching routes are Puppeteer-rendered for every locale instead of substituted. */
    localeSubstitutionExcludePaths: normalizeLocaleRouteExclude(
      cli.localeSubstitutionExcludePaths ?? pre.localeSubstitutionExcludePaths
    ),
    /** Explicit locale-neutral paths to render in addition to those discovered automatically.
     *  Each entry is expanded to all locale variants (e.g. "legal/privacy" → "cs/legal/privacy", ...) */
    paths: Array.isArray(pre.paths)
      ? pre.paths.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter(Boolean)
      : [],
    dryRun: !!cli.dryRun,
    forceLock: !!cli.forceLock,
    debugPrerender: !!cli.debugPrerender,
    // render.icons: "lazy" strips prerender-inlined x-icon SVGs from the
    // output — the icons plugin re-renders them at boot (decorative content;
    // an icon-heavy nav duplicates kilobytes of identical SVG per link).
    lazyIcons: pre.icons === 'lazy',
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

  // A source mounts under the wildcard route named after it: `docs/*` for key
  // `docs`, or a nested base ending in the key (`docs/framework/*` for key
  // `framework`).
  const mounts = new Map();
  function mountFor(sourceKey) {
    if (!sourceKey) return null;
    if (mounts.has(sourceKey)) return mounts.get(sourceKey);
    let mount = null;
    if (wildcardBases.includes(sourceKey)) mount = sourceKey;
    else {
      const nested = wildcardBases.filter((b) => b.split('/').pop() === sourceKey);
      if (nested.length === 1) {
        mount = nested[0];
        process.stderr.write(`prerender: data source "${sourceKey}" mounts under ${mount}/*\n`);
      } else if (nested.length > 1) {
        process.stderr.write(`prerender: data source "${sourceKey}" matches ${nested.map((b) => b + '/*').join(', ')}; not mounted (ambiguous)\n`);
      }
    }
    mounts.set(sourceKey, mount);
    return mount;
  }

  function expandCandidates(rawPath, sourceKey) {
    const p = String(rawPath || '').replace(/^\/+|\/+$/g, '');
    if (!p) return [];
    const candidates = [p];
    if (wildcardBases.length === 0) return candidates;
    const mount = mountFor(sourceKey);
    if (!mount) return candidates;
    const parts = p.split('/');
    const hasLocalePrefix = parts.length > 1 && localeSet.has(parts[0].toLowerCase());
    if (hasLocalePrefix) {
      const locale = parts[0];
      const rest = parts.slice(1).join('/');
      if (rest && !rest.startsWith(mount + '/')) candidates.push(`${locale}/${mount}/${rest}`);
    } else if (!p.startsWith(mount + '/')) {
      candidates.push(`${mount}/${p}`);
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
  const indexPath = join(rootDir, 'index.html');
  _originalScriptSrcs = scriptSrcSet(existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '');
  return _originalScriptSrcs;
}

function stripInjectedPluginScripts(html, rootDir) {
  return stripInjectedScripts(html, buildOriginalScriptSrcSet(rootDir));
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

/** Inject stylesheet link with root-absolute href (avoids ../ resolving under locale segments like /en/page/).
 * `attrs` (e.g. `data-mnfst-utilities`) lets the runtime utilities plugin find and skip classes this sheet covers. */
function postProcessInjectStylesheetLink(outputDir, filename, routerBasePath, attrs = '') {
  const cssPath = join(outputDir, filename);
  if (!existsSync(cssPath)) return;
  const stat = statSync(cssPath);
  if (stat.size === 0) return;

  const href = buildRootAssetPath(routerBasePath, filename);
  const tag = `<link rel="stylesheet" href="${href}"${attrs ? ` ${attrs}` : ''}>`;
  const files = walkHtmlFiles(outputDir);
  for (const file of files) {
    let html = readFileSync(file, 'utf8');
    html = injectBeforeHeadClose(html, tag);
    writeFileSync(file, html, 'utf8');
  }
}

// --- (Removed) We used to strip x-text containing product. / feature. to avoid wrong-scope errors

// --- Strip x-text and x-html that reference $x when static/SEO (content already in snapshot).

// --- Don't bake Alpine-only state into the snapshot; only $x-driven content should be prerendered.

// --- Rewrite asset URLs: depth = segments from this HTML file up to output root (website). ----
// All project assets are copied into output, so root-relative paths become relative within output.
// Do NOT rewrite href on <a> tags (navigation links); only rewrite link/script/img so router gets clean paths.

// --- Canonical and hreflang (per-page injection) ---

// --- Locale text substitution (Node.js post-processing — no Puppeteer for locale variants) ------

/**
 * Load the key→value content data for every locale from every CSV that has locale columns.
 * Returns Map<locale, { key: value }>.
 */
function loadAllLocaleContentData(manifest, rootDir, locales, defaultLocale) {
  const data = manifest?.data;
  if (!data || typeof data !== 'object') return new Map();
  const defaultLoc = defaultLocale || locales[0];

  // Lazy-load js-yaml for parsing per-locale YAML files
  let jsYaml = null;
  try { jsYaml = require('js-yaml'); } catch { /* yaml not available; YAML locale files will be skipped */ }

  // A root-level YAML/JSON LIST (e.g. articles.<locale>.yaml) has no natural
  // key to merge on — key each item by the first present of slug/id/key/path,
  // falling back to its index, so same-item pairing works across locales.
  function arrayItemKey(item, idx) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const k = item.slug ?? item.id ?? item.key ?? item.path;
      if (k != null) return String(k);
    }
    return String(idx);
  }
  function arrayToKeyedObject(arr) {
    const out = {};
    arr.forEach((item, idx) => { out[arrayItemKey(item, idx)] = item; });
    return out;
  }

  // Deep-merge source into target (for combining multiple data sources per locale).
  // A root-level array source is keyed first (see above) then merged as an object.
  function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return;
    const src = Array.isArray(source) ? arrayToKeyedObject(source) : source;
    for (const key of Object.keys(src)) {
      if (src[key] && typeof src[key] === 'object' && !Array.isArray(src[key])) {
        target[key] = (target[key] && typeof target[key] === 'object') ? target[key] : {};
        deepMerge(target[key], src[key]);
      } else {
        // Don't overwrite an existing nested object with a primitive — that creates
        // type asymmetry across locales and causes '[object Object]' in substitution pairs
        if (target[key] && typeof target[key] === 'object') continue;
        target[key] = src[key];
      }
    }
  }

  const result = new Map();
  for (const locale of locales) result.set(locale, {});

  // A configured per-locale source that resolves to 0 substitution pairs against
  // the default locale is silent data loss (e.g. the array-rooted bug above, before
  // the fix) — warn once per (source, locale) so it surfaces instead of shipping quietly.
  const warnedZeroPairs = new Set();
  function warnIfZeroPairs(name, locale, defaultData, localeData) {
    if (locale === defaultLoc || !defaultData || !localeData) return;
    const warnKey = `${name}:${locale}`;
    if (warnedZeroPairs.has(warnKey)) return;
    if (buildSubstitutionPairs(defaultData, localeData).length === 0) {
      warnedZeroPairs.add(warnKey);
      console.warn(`prerender: warning — locale source ${name} (${locale}) produced 0 substitution pairs`);
    }
  }

  // Read just the header row of a CSV to check which locale columns it contains.
  function csvLocaleColumns(csvPath) {
    if (!existsSync(csvPath)) return new Set();
    try {
      const firstLine = readFileSync(csvPath, 'utf8').split(/\r?\n/)[0] || '';
      return new Set(splitCsvLine(firstLine).slice(1)); // skip key column
    } catch { return new Set(); }
  }

  for (const [name, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      // Single CSV with locale columns (all locales in one file)
      if (value.endsWith('.csv')) {
        const csvPath = join(rootDir, value.startsWith('/') ? value.slice(1) : value);
        const cols = csvLocaleColumns(csvPath);
        const defaultData = cols.has(defaultLoc) ? parseCsvToKeyValue(csvPath, defaultLoc) : null;
        for (const locale of locales) {
          // Only include locales the CSV actually declares; falling back to the English
          // column for a missing locale silently poisons substitution pairs with English values.
          if (!cols.has(locale)) continue;
          const localeData = parseCsvToKeyValue(csvPath, locale);
          deepMerge(result.get(locale), localeData);
          warnIfZeroPairs(name, locale, defaultData, localeData);
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
          const defaultData = cols.has(defaultLoc) ? parseCsvToKeyValue(csvPath, defaultLoc) : null;
          for (const locale of locales) {
            if (!cols.has(locale)) continue;
            const localeData = parseCsvToKeyValue(csvPath, locale);
            deepMerge(result.get(locale), localeData);
            warnIfZeroPairs(name, locale, defaultData, localeData);
          }
        }
      } else {
        // Per-locale files: { "en": "/data/content.en.yaml", "fr": "/data/content.fr.yaml", ... }
        // (each file's content may be an object OR a root-level array — see deepMerge).
        const loadedByLocale = new Map();
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
            loadedByLocale.set(localeKey, Array.isArray(localeData) ? arrayToKeyedObject(localeData) : localeData);
            deepMerge(result.get(localeKey), localeData);
          }
        }
        const defaultData = loadedByLocale.get(defaultLoc) || null;
        for (const [localeKey, localeData] of loadedByLocale) {
          warnIfZeroPairs(name, localeKey, defaultData, localeData);
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
  if (config.lazyIcons) html = stripLazyIconSvgs(html);
  // markPrerenderedManifestComponents must run BEFORE stripPrerenderHydrateMarkers so it can
  // detect data-hydrate markers and skip components inside hydrate islands.
  html = markPrerenderedManifestComponents(html);

  const fileSegments = pathToFileSegments(pathSeg ? '/' + pathSeg : '/');
  html = rewriteHtmlAssetPaths(html, fileSegments.length);

  const liveBase = config.liveUrl.replace(/\/$/, '');
  const hasSourceCanonical = /<link\b[^>]*\brel=(["'])\s*canonical\s*\1/i.test(html);
  const canonicalHreflang = buildCanonicalAndHreflang(pathSeg, locales, defaultLocale, liveBase, { skipCanonical: hasSourceCanonical });
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
  // Settle BEFORE the cache fingerprint: the hash must describe the same
  // steady-state DOM the screenshot captures, or late-arriving content makes
  // the cache key unstable across runs.
  await waitForVisualSettle(page);
  // The 404 page must NOT share the homepage's 'index' slug: both pages render
  // concurrently and would otherwise race on the same og/index.png + cache
  // files. The 404 (route hidden, near-empty body) screenshots blank, and that
  // blank would clobber — or get mis-read as — the homepage's real snapshot.
  const fileSeg = pathSeg === ''
    ? 'index'
    : pathSeg === '__404__'
      ? '404'
      : pathSeg.replace(/\//g, '-').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ogDir = join(outputDir, 'og');
  try { mkdirSync(ogDir, { recursive: true }); } catch { /* exists */ }
  const filePath = join(ogDir, `${fileSeg}.png`);
  // Cache locations — outside the output dir so they survive the per-run
  // rmSync.  cacheDir is .mnfst-cache/og under the project root.
  const cachePngPath = cacheDir ? join(cacheDir, `${fileSeg}.png`) : null;
  const cacheHashPath = cacheDir ? join(cacheDir, `${fileSeg}.hash`) : null;

  // Restore the last good cached PNG into the output dir. Used whenever a fresh
  // snapshot can't be produced (error or blank result) so a transient failure
  // never leaves the page with no OG image — and never destroys the prior.
  const restoreFromCache = () => {
    if (cachePngPath && existsSync(cachePngPath)) {
      try { cpSync(cachePngPath, filePath); return `/og/${fileSeg}.png`; } catch { /* ignore */ }
    }
    return null;
  };

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
    // Throwaway shot first: it forces the compositor to produce a fresh frame,
    // so the real capture below reflects the current DOM rather than a stale
    // surface (headless pages can sit frames behind after heavy updates).
    await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 8, height: 8 }, captureBeyondViewport: false }).catch(() => { });
    await new Promise((r) => setTimeout(r, 120));
    const shoot = () => page.screenshot({
      path: filePath,
      type: 'png',
      clip: { x: 0, y: 0, width: 1200, height: 630 },
      omitBackground: false,
      captureBeyondViewport: false,
    });
    await shoot();
    // Residual-race retry: a text-heavy page yielding a shell-weight card
    // means the main content missed the frame — settle again and reshoot.
    for (let attempt = 0; attempt < 2; attempt++) {
      let size = 0;
      try { size = statSync(filePath).size; } catch { break; }
      if (size >= 34 * 1024) break;
      const textLen = await page.evaluate(() => document.body?.innerText.length || 0).catch(() => 0);
      if (textLen < 2500) break;
      await new Promise((r) => setTimeout(r, 1200));
      await waitForVisualSettle(page, { settleMs: 400, capMs: 5000 });
      await shoot();
    }
    // Sanity check: a blank 1200×630 PNG (header only, white body) is ~8–10KB;
    // a content-rich page is 50KB+.  When the resulting file is suspiciously
    // small the snapshot is treated as failed and the renderer falls through
    // to other og:image sources (manifest icon, first content <img>).  15KB
    // is a safe floor that catches blank/header-only snapshots without false
    // positives for legitimately simple pages.
    try {
      const sz = statSync(filePath).size;
      if (sz < 15 * 1024) {
        // Blank/header-only snapshot — don't trust it, but don't destroy the
        // good cached prior either (a transient blank must not wipe a real
        // image). Drop the blank output and restore the last good cached PNG;
        // if there's no cache, fall through to other og:image sources.
        try { unlinkSync(filePath); } catch { /* missing is fine */ }
        return restoreFromCache();
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
    // Failures here are non-fatal and must be non-destructive: prefer the last
    // good cached PNG (restored into the output) over leaving the page with no
    // OG image. Only if there's no cache do we fall through to other og:image
    // sources (manifest icon, first content <img>, etc.).
    console.error(`prerender: og snapshot failed for /${pathSeg || ''}: ${e?.message || e}`);
    return restoreFromCache();
  }
}

// --- SEO: per-route meta + structured data injection ----------------------

// --- SEO: robots.txt, sitemap.xml, llms.txt, llms-full.txt ---------------
//
// Written to the prerender output directory.  liveUrl is the canonical public
// host (https://...), used for absolute URLs in sitemap entries and the llms.txt
// page index.  llms.txt and llms-full.txt follow the llmstxt.org convention —
// a plain-markdown index and full-content concatenation specifically for LLM
// crawlers (ChatGPT, Claude, Perplexity, etc.) that prefer structured plaintext
// over scraping rendered HTML.

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
  return extractRouteContentFromHtml(readFileSync(filePath, 'utf8'));
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
  const rootDir = ctx.rootDir || '';
  const manifest = ctx.manifest || null;

  writeFileSync(join(outputDir, 'robots.txt'), buildRobotsTxt(base), 'utf8');
  writeFileSync(
    join(outputDir, 'sitemap.xml'),
    buildSitemapXml(pathList, {
      base, liveUrl, locales: localeList, defaultLocale,
      lastmodOf: (pathSeg) => routeLastModDate(rootDir, outputDir, pathSeg, manifest, localeList, defaultLocale),
    }),
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
 * Sections come from groupLlmsSections.
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

  const { llms, llmsFull } = buildLlmsFiles(entries, { siteName, siteDescription });
  writeFileSync(join(outputDir, 'llms.txt'), llms, 'utf8');
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

// --- Output lock (one render per output dir) ---------------------------------

const LOCK_SUFFIX = '.mnfst-lock';

function outputLockPath(outputDir) {
  return resolve(outputDir) + LOCK_SUFFIX;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function readLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}

function describeLock(entry, lockPath) {
  if (!entry) return `unreadable lock file ${lockPath}`;
  const started = entry.startedAt ? ` since ${entry.startedAt}` : '';
  const host = entry.hostname && entry.hostname !== hostname() ? ` on ${entry.hostname}` : '';
  const cmd = entry.argv ? `\n  command: ${entry.argv}` : '';
  return `pid ${entry.pid}${host}${started}${cmd}`;
}

function lockIsStale(entry) {
  if (!entry) return false;
  if (entry.hostname && entry.hostname !== hostname()) return false;
  return !pidAlive(entry.pid);
}

function lockedError(outputDir, lockPath, entry) {
  const err = new Error(
    `prerender: another render is already writing ${outputDir}\n` +
    `  held by ${describeLock(entry, lockPath)}\n` +
    `  lock: ${lockPath}\n` +
    `Wait for it to finish, or rerun with --force-lock if that render is gone.`
  );
  err.code = 'MNFST_RENDER_LOCKED';
  err.lock = entry;
  return err;
}

/** Remove the lock only if it still carries `token` (undefined = unconditionally). */
function removeLockIfToken(lockPath, token) {
  const aside = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}`;
  try { renameSync(lockPath, aside); } catch { return false; }
  const moved = readLock(aside);
  if (token === undefined || moved?.token === token) {
    try { unlinkSync(aside); } catch {}
    return true;
  }
  try { linkSync(aside, lockPath); } catch {}
  try { unlinkSync(aside); } catch {}
  return false;
}

function acquireOutputLock(outputDir, { force = false, root = null, onLog = () => {} } = {}) {
  const lockPath = outputLockPath(outputDir);
  const entry = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    root,
    output: resolve(outputDir),
    argv: process.argv.slice(1).join(' '),
    token: randomBytes(12).toString('hex'),
  };
  mkdirSync(dirname(lockPath), { recursive: true });
  const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
      try {
        linkSync(tmp, lockPath);
        acquired = true;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      const held = readLock(lockPath);
      if (force) {
        onLog(`prerender: --force-lock: taking over lock from ${describeLock(held, lockPath)}`);
        removeLockIfToken(lockPath, held ? held.token : undefined);
      } else if (lockIsStale(held)) {
        onLog(`prerender: removing stale lock from ${describeLock(held, lockPath)} (process is gone)`);
        removeLockIfToken(lockPath, held.token);
      } else {
        throw lockedError(outputDir, lockPath, held);
      }
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  if (!acquired) throw lockedError(outputDir, lockPath, readLock(lockPath));

  let released = false;
  const lock = {
    path: lockPath,
    entry,
    held() {
      return !released && readLock(lockPath)?.token === entry.token;
    },
    release() {
      if (released) return;
      released = true;
      process.off('exit', lock.release);
      removeLockIfToken(lockPath, entry.token);
    },
  };
  process.on('exit', lock.release);
  return lock;
}

// --- Copy project into output so website is self-contained (e.g. for Appwrite). ---
// Internal/tooling files stay out of the published output: agent instructions,
// the schema copy, and OS metadata anywhere in the tree.
const COPY_EXCLUDE = new Set([
  'node_modules', '.git', 'package.json', 'package-lock.json',
  'index.html', 'prerender.mjs', 'prerender.js', '_redirects',
  'CLAUDE.md', 'AGENTS.md', 'manifest.schema.json',
]);

// Capacitor-wrapped projects: native projects and config stay out of the web
// output, else each `cap sync` nests ios/App/App/public/ios/… deeper.
const CAPACITOR_CONFIGS = ['capacitor.config.json', 'capacitor.config.ts', 'capacitor.config.js'];
const CAPACITOR_EXCLUDE = new Set(['ios', 'android', ...CAPACITOR_CONFIGS]);

function copyProjectIntoDist(rootResolved, outputResolved) {
  const outputDirName = basename(outputResolved);
  COPY_EXCLUDE.add(outputDirName);
  const wrapped = CAPACITOR_CONFIGS.some((f) => existsSync(join(rootResolved, f)));
  const entries = readdirSync(rootResolved, { withFileTypes: true });
  for (const ent of entries) {
    const name = ent.name;
    if (COPY_EXCLUDE.has(name) || name.startsWith('.')) continue;
    if (wrapped && CAPACITOR_EXCLUDE.has(name)) continue;
    const src = join(rootResolved, name);
    const dest = join(outputResolved, name);
    cpSync(src, dest, {
      recursive: true,
      filter: (p) => { const b = basename(p); return b !== '.DS_Store' && b !== 'Thumbs.db'; },
    });
  }
  COPY_EXCLUDE.delete(outputDirName);
}

/** Remove bare `@import "tailwindcss"` (and `tailwindcss/*` sub-imports) from
 * CSS files copied into the output.
 *
 * Tailwind v4 conventions put `@import "tailwindcss";` at the top of a
 * project's main CSS so the build tool pulls in the framework.  When that same
 * file is also linked directly in the browser (as Manifest's
 * `manifest.theme.css` convention does), the browser's native CSS loader
 * resolves the bare specifier against the page origin and fetches
 * `/tailwindcss` — which 404s to the SPA shell (text/html), tripping
 * "Refused to apply style … is not a supported stylesheet MIME type" (flagged
 * by PageSpeed Best Practices).  Manifest supplies Tailwind its own way
 * (compiled `prerender.tailwind.css` for MPA, the Play-CDN style engine for
 * SPA), so a raw import in a browser-served stylesheet is always redundant and
 * harmful.  Strip it from the emitted copies only; source files are untouched. */
function stripTailwindCssImportsFromOutput(outputDir) {
  const importRx = /@import\s+(?:url\(\s*)?["']tailwindcss(?:\/[^"']*)?["']\s*\)?[^;\n]*;?[ \t]*\r?\n?/gi;
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') continue;
        walk(p);
      } else if (ent.name.endsWith('.css') && ent.name !== 'prerender.tailwind.css') {
        try {
          const css = readFileSync(p, 'utf8');
          if (!/tailwindcss/i.test(css)) continue;
          const next = css.replace(importRx, '');
          if (next !== css) writeFileSync(p, next, 'utf8');
        } catch { /* unreadable file — skip */ }
      }
    }
  };
  walk(outputDir);
}

// --- Main --------------------------------------------------------------------

async function main() {
  const config = resolveConfig();
  const startedAt = Date.now();
  let lock = null;
  if (!config.dryRun) {
    try {
      lock = acquireOutputLock(config.output, {
        force: config.forceLock,
        root: config.root,
        onLog: (message) => console.warn(message),
      });
    } catch (err) {
      if (err.code !== 'MNFST_RENDER_LOCKED') throw err;
      console.error(err.message);
      process.exit(1);
    }
    config.lock = lock;
  }
  const onSignal = (signal) => {
    if (lock) lock.release();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
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
    if (lock) lock.release();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  const elapsedMs = Date.now() - startedAt;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  process.stdout.write(`prerender: total time ${hours}h ${minutes}m ${seconds}s\n`);
}

/** Remove unresolved `${VAR}` env-var placeholders from the output manifest.json.
 *
 * Env interpolation is runtime-only: the loader's interpolateManifestEnv resolves
 * `${VAR}` against window.env, which the mnfst-run dev server fills from .env (or
 * a developer's inline <script>window.env={…}</script>). A prerendered static
 * site has no window.env, so an unresolved placeholder ships literally and any
 * plugin reading it errors. Such placeholders are dev-only by definition (a
 * production value would be hard-coded), so delete object keys and drop array
 * items whose string value still contains a `${VAR}` reference. We never
 * substitute from process.env — that would risk baking a dev secret (e.g. an
 * Appwrite devKey) into the public manifest.json. */
function stripUnresolvedEnvFromOutputManifest(outputDir) {
  const manifestPath = join(outputDir, 'manifest.json');
  if (!existsSync(manifestPath)) return;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return; }
  const unresolved = (v) => typeof v === 'string' && /\$\{[^}]+\}/.test(v);
  let changed = false;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        if (unresolved(node[i])) { node.splice(i, 1); changed = true; }
        else if (node[i] && typeof node[i] === 'object') walk(node[i]);
      }
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (unresolved(node[key])) { delete node[key]; changed = true; }
        else if (node[key] && typeof node[key] === 'object') walk(node[key]);
      }
    }
  };
  walk(manifest);
  if (changed) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
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
  // Expand routeSegments into the full path list: locale-neutral routes as-is,
  // plus a `<locale>/<route>` variant per locale (skipping localeRouteExclude
  // prefixes). Factored into a pure function so it's unit-testable without
  // Puppeteer — see expandLocaleRoutePaths.
  const paths = expandLocaleRoutePaths({ routeSegments, locales, defaultLocale, localeRouteExclude: config.localeRouteExclude });

  const pathList = [...paths, NOT_FOUND_PATH];
  if (config.dryRun) {
    return;
  }

  const finalOutput = resolve(config.output);
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

  // Atomic output: build into a sibling staging dir, then swap it into place
  // only after every step below succeeds (see the end of this function). A
  // crashed or interrupted render therefore never leaves a half-written or empty
  // output dir for mnfst-publish to ship — the previous good build stays put
  // until the new one is complete.
  const stagingOutput = finalOutput + '.mnfst-staging';
  if (existsSync(stagingOutput)) rmSync(stagingOutput, { recursive: true });
  mkdirSync(stagingOutput, { recursive: true });
  // Redirect ALL downstream writes (both config.output and outputResolved) to
  // the staging dir for the remainder of the build.
  config.output = stagingOutput;
  const outputResolved = stagingOutput;
  // Don't copy the previous build (the final output dir) into staging — only the
  // staging dir's own basename is excluded by copyProjectIntoDist.
  const finalBasename = basename(finalOutput);
  const lockBasename = basename(outputLockPath(finalOutput));
  COPY_EXCLUDE.add(finalBasename);
  COPY_EXCLUDE.add(lockBasename);
  // An --out render (e.g. a Capacitor webDir) also skips the configured web output.
  const renderBlock = config.manifest?.render ?? config.manifest?.prerender ?? {};
  const configuredOutput = resolve(rootResolved, renderBlock.output ?? 'website');
  const configuredBasename = dirname(configuredOutput) === rootResolved && !COPY_EXCLUDE.has(basename(configuredOutput))
    ? basename(configuredOutput)
    : null;
  if (configuredBasename) COPY_EXCLUDE.add(configuredBasename);
  try {
    copyProjectIntoDist(rootResolved, outputResolved);
  } finally {
    COPY_EXCLUDE.delete(finalBasename);
    COPY_EXCLUDE.delete(lockBasename);
    if (configuredBasename) COPY_EXCLUDE.delete(configuredBasename);
  }
  // Env placeholders (${VAR}) only resolve at runtime via window.env (populated
  // by the mnfst-run dev server from .env). A static prod build has no
  // window.env, so any ${VAR} left in the shipped manifest.json stays literal
  // and plugins that read it (e.g. appwrite-auth) log a console error. Strip the
  // unresolved placeholders from the copy.
  stripUnresolvedEnvFromOutputManifest(outputResolved);
  // Projects that use data-tailwind get their Tailwind from Manifest (compiled
  // prerender.tailwind.css below, or the runtime style engine).  A leftover
  // `@import "tailwindcss"` in a browser-linked stylesheet (e.g. the
  // manifest.theme.css convention) would make the browser fetch /tailwindcss
  // and fail; strip those imports from the copied CSS.
  if (indexHtmlUsesTailwind(rootResolved)) {
    stripTailwindCssImportsFromOutput(outputResolved);
  }

  const pre = manifest.render ?? manifest.prerender ?? {};
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
      // Headless shell: new headless can hang captureScreenshot on macOS
      return await puppeteer.default.launch({
        headless: 'shell',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // Background tabs must keep producing frames and timers
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
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
  // Bounds on the recycle handshake and on a single page render.  A stuck
  // page must never pin the whole run: each is capped, logged and stepped
  // over — and a page that hits the ceiling forces a browser recycle, since
  // a wedged page.evaluate() may have poisoned the shared browser process.
  // pageTimeout is configurable via manifest.prerender.pageTimeout; 0 disables.
  const pageTimeoutMs = Math.max(0, pre.pageTimeout ?? Math.max(120000, (config.wait ?? 30000) * 4));
  // The recycle gate must never swap the browser out from under a live page,
  // so its drain wait has to outlast the per-page timeout above (every page
  // is guaranteed to release its slot by then). Configurable via
  // manifest.prerender.recycleDrainTimeout, floored at pageTimeoutMs + 30s.
  const drainTimeoutMs = Math.max(pageTimeoutMs + 30000, pre.recycleDrainTimeout ?? 60000);
  const recycleTimeoutMs = Math.max(0, pre.recycleTimeout ?? 180000);

  // Close the browser without hanging: SIGKILL the process if close stalls.
  async function closeBrowser(target) {
    if (!target) return;
    const proc = typeof target.process === 'function' ? target.process() : null;
    const closed = await withDeadline(Promise.resolve(target.close()).catch(() => {}), 15000);
    if (!closed) {
      process.stderr.write('prerender: browser close timed out — killing the process\n');
      try { proc?.kill('SIGKILL'); } catch (_) {}
    }
  }

  // Launch with a deadline and one retry; a hung launch would otherwise stall
  // every worker behind the recycle gate.
  async function launchBrowserBounded() {
    for (let attempt = 0; attempt < 2; attempt++) {
      let launched = null;
      const ok = await withDeadline(
        launchBrowser().then((b) => { launched = b; }),
        60000
      );
      if (ok && launched) return launched;
      process.stderr.write('prerender: browser launch timed out — retrying\n');
    }
    throw new Error('browser launch timed out');
  }

  const recycleGate = createRecycleGate({
    every: browserRecycleEvery,
    drainTimeoutMs,
    recycleTimeoutMs,
    healthy: () => !!browser && browser.connected !== false,
    onLog: (message) => process.stderr.write(`prerender: ${message}\n`),
    recycle: async (processed, { forced } = {}) => {
      process.stdout.write(`prerender: recycling browser (${forced ? `forced after ${processed}` : `processed ${processed}`} pages)\n`);
      await closeBrowser(browser);
      browser = await launchBrowserBounded();
    },
  });
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
  const localeSet = new Set(locales);
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
    if (isLocaleSubstitutionExcludedPath(basePathSeg, config.localeSubstitutionExcludePaths)) {
      // Route explicitly configured (prerender.localeSubstitutionExcludePaths) to
      // always be Puppeteer-rendered per locale — e.g. it has other per-locale
      // runtime behaviour the client wants verified directly, not substituted.
      puppeteerPaths.push(seg);
      continue;
    }
    if (localeNeutralPathSet.has(basePathSeg)) {
      // Locale-neutral base exists and will be Puppeteer-rendered → safe to substitute.
      localeVariantPaths.push({ pathSeg: seg, basePathSeg, targetLocale: fp });
    } else {
      // No locale-neutral base — this path has per-locale content; Puppeteer required.
      puppeteerPaths.push(seg);
    }
  }

  // variantsByBase: basePathSeg → its pending substitution-variant entries.
  // Populated above; consumed by promoteLocaleVariants() during Phase 1 when a
  // base page turns out to have per-locale runtime content (see below).
  const variantsByBase = new Map();
  for (const v of localeVariantPaths) {
    if (!variantsByBase.has(v.basePathSeg)) variantsByBase.set(v.basePathSeg, []);
    variantsByBase.get(v.basePathSeg).push(v);
  }
  // Collected during Phase 1, rendered in a follow-up Puppeteer pass after it.
  const promotedPaths = [];
  /**
   * Defect: locale substitution ships default-locale bodies for paths whose
   * content is fetched per-locale at runtime (e.g. `x-markdown` resolving
   * `/assets/articles/<locale>/slug.md`). Substitution only rewrites text
   * matched by configured locale data — it can't touch content injected by a
   * runtime fetch, so the baked (default-locale) body shipped for every
   * locale. Detection: instrument `window.fetch` before app scripts run (see
   * evaluateOnNewDocument below) and, after the base page renders, check
   * whether any fetched URL contains the CURRENT locale as a path segment —
   * strong evidence the URL is locale-parameterized (a locale-neutral URL
   * would not coincidentally embed the active locale code as its own
   * segment). When it does, every locale variant of this base is moved from
   * substitution to a real per-locale Puppeteer render.
   */
  function promoteLocaleVariants(basePathSeg) {
    const variants = variantsByBase.get(basePathSeg);
    if (!variants || !variants.length) return;
    process.stdout.write(
      `prerender: locale-dependent runtime content detected for "${basePathSeg || '/'}" — rendering ${variants.length} locale variant(s) via Puppeteer instead of substitution\n`
    );
    for (const v of variants) {
      promotedPaths.push(v.pathSeg);
      const idx = localeVariantPaths.indexOf(v);
      if (idx !== -1) localeVariantPaths.splice(idx, 1);
    }
    variantsByBase.delete(basePathSeg);
  }

  // Preload locale data for text substitution (all CSV sources with locale columns)
  const allLocaleData = loadAllLocaleContentData(manifest, config.root, locales, defaultLocale);
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

  async function processPath(pathSeg, pathIndex, { onRawHtml, attempt, onLocaleDependentContent } = {}) {
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

    // No recycle can run while the caller holds a gate slot, so `browser` is
    // live for the whole call.
    const page = await browser.newPage();
    if (attempt) attempt.cancel = () => page.close();
    try {
      const { html: rawHtml } = await renderRouteDom(page, {
        url, pathSeg, is404, currentLocale, locales, timeout, displayPath,
        baseUrl: config.localUrl,
        liveUrl: config.liveUrl,
        pipelineTimeout: config.pipelineTimeout,
        waitAfterIdle: config.waitAfterIdle,
        seo: config.seo,
        renderedPaths: pathList.filter((p) => p !== NOT_FOUND_PATH),
        localeSubstitution: config.localeSubstitution,
        onLocaleDependentContent,
        ogSnapshot: (p, key) => takeOgSnapshot(p, config.output, key, globalAssetSig, ogCacheDir),
        onDebug: config.debugPrerender ? pushDebug : null,
      });
      // Cache raw DOM snapshot for locale variant generation (before any Node.js transforms).
      if (typeof onRawHtml === 'function') onRawHtml(pathSeg, rawHtml);
      const { html, utilityBlocks: pageBlocks } = finalizeRouteHtml(rawHtml, {
        pathSeg, is404, currentLocale, locales, defaultLocale, routerBasePath, tailwindBuilt, bundleUtilities,
        originalScriptSrcs: buildOriginalScriptSrcSet(config.root),
        xData: { manifest, content: loadContentForPrerender(manifest, config.root, currentLocale) },
        lazyIcons: config.lazyIcons,
        localeRouteExclude: config.localeRouteExclude,
        liveUrl: config.liveUrl,
      });
      for (const b of pageBlocks) utilityBlocks.push(b);
      if (attempt?.abandoned) return; // a retry owns the output now
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
      if (attempt?.abandoned) return;
      const message = err && err.message ? err.message : String(err);
      // The worker owns retries and reporting; a shared array can't be popped
      // safely while other workers push to it.
      if (attempt) { attempt.failure = { path: displayPath, message }; return; }
      failedPaths.push({ path: displayPath, message });
      process.stderr.write(`prerender: failed ${displayPath}: ${message}\n`);
    } finally {
      try { await page.close(); } catch (_) { /* page may be gone if browser died */ }
    }
  }

  // Phase 1: Puppeteer — render base paths, cache raw DOM for substitution
  async function renderPuppeteerPaths(paths) {
    const failures = await runRenderQueue({
      items: paths,
      concurrency,
      gate: recycleGate,
      pageTimeoutMs,
      maxRetries,
      labelOf: (seg) => (seg === '' ? '/' : (seg === NOT_FOUND_PATH ? '/__prerender_404__' : '/' + seg)),
      render: (pathSeg, i, attempt) => processPath(pathSeg, i, {
        attempt,
        onRawHtml: (seg, html) => {
          if (seg !== NOT_FOUND_PATH) baseHtmlCache.set(seg || '', html);
        },
        onLocaleDependentContent: promoteLocaleVariants,
      }),
      onRetry: (failure, attempt, immediate) => {
        process.stderr.write(
          `prerender: retrying ${failure.path} (${failure.message}) (attempt ${attempt + 1}/${maxRetries + 1})${immediate ? ' — immediate requeue' : ''}\n`
        );
      },
      onFail: (failure, count) => {
        if (count <= 10) process.stderr.write(`prerender: failed ${failure.path}: ${failure.message}\n`);
      },
    });
    failedPaths.push(...failures);
  }

  try {
    await renderPuppeteerPaths(puppeteerPaths);
    // Any base page found to have per-locale runtime content during the pass
    // above gets its locale variants rendered here — real Puppeteer render
    // per locale instead of the (incorrect) text substitution.
    if (promotedPaths.length > 0) {
      process.stdout.write(`prerender: rendering ${promotedPaths.length} promoted locale variant(s) via Puppeteer...\n`);
      await renderPuppeteerPaths(promotedPaths);
    }
  } finally {
    await closeBrowser(browser);
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
      // Append to prerender.tailwind.css when it exists — one render-blocking
      // stylesheet instead of two, same cascade order (utilities last). The
      // separate file remains only for projects without a Tailwind build.
      const twPath = join(outputResolved, 'prerender.tailwind.css');
      if (existsSync(twPath)) {
        appendFileSync(twPath, `\n/* Manifest custom utilities */\n${utilMerged}\n`, 'utf8');
        process.stdout.write('prerender: merged custom utilities into prerender.tailwind.css\n');
      } else {
        writeFileSync(join(outputResolved, 'prerender.utilities.css'), `${utilMerged}\n`, 'utf8');
        process.stdout.write('prerender: wrote prerender.utilities.css (Manifest custom utilities)\n');
        postProcessInjectStylesheetLink(outputResolved, 'prerender.utilities.css', routerBasePath || '', 'data-mnfst-utilities');
      }
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

  // Atomic swap: replace the previous output with the freshly built staging dir.
  // rename() is atomic on the same filesystem (staging is a sibling of output),
  // so a consumer never sees a partially written output directory.
  if (config.lock && !config.lock.held()) {
    throw new Error(`output lock ${config.lock.path} was taken over by another render; not replacing ${finalOutput}`);
  }
  if (existsSync(finalOutput)) rmSync(finalOutput, { recursive: true });
  renameSync(stagingOutput, finalOutput);
  config.output = finalOutput;
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
export {
  main,
  discoverRoutes,
  groupLlmsSections,
  acquireOutputLock,
  outputLockPath,
  copyProjectIntoDist,
  markPrerenderedManifestComponents,
  normalizeLocaleRouteExclude,
  isLocaleRouteExcluded,
  expandLocaleRoutePaths,
  prefixLocaleInternalLinks,
  routeMatchesGlob,
  isLocaleSubstitutionExcludedPath,
  loadAllLocaleContentData,
  buildSubstitutionPairs,
};
