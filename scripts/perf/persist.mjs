#!/usr/bin/env node
// Persisted $x harness (PERF-PRIMITIVES-DESIGN.md §12.2): cold load (no
// IndexedDB) vs warm reload (snapshot present) → time to first row on screen
// and request count for the persisted feed; logout → the scope's IndexedDB
// entries are empty; workspace switch → no previous-scope row is rendered at
// any point (the list is polled every 10ms during the switch). Drives
// /perf?source=x&persist=1 (see perf-demo.html) and prints one JSON line per
// scenario. Companion to landing.mjs.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const out = { samples: 3, params: 'menus=1&rows=20&emoji=20&getters=4&pages=10&pageSize=100&netMs=400&upsertEveryMs=100000' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--params') out.params = argv[++i];
    else if (a === '--samples') out.samples = parseInt(argv[++i], 10) || 3;
    else if (a === '--headed') out.headed = true;
  }
  return out;
}

function median(nums) {
  const s = nums.filter((n) => n != null).slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function ensureDevServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['packages/run/serve.mjs', 'src', '--no-open', '--no-idle-shutdown'], {
      cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' }
    });
    let settled = false;
    const onData = (buf) => {
      const text = buf.toString();
      const m = text.match(/https?:\/\/localhost:(\d+)/);
      if (m && !settled) {
        settled = true;
        resolve({ url: `http://localhost:${m[1]}`, child, ownedByUs: !/already running/i.test(text) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    setTimeout(() => { if (!settled) reject(new Error('Timed out waiting for dev server to start (15s)')); }, 15000);
  });
}

// From navigation: the moment the first .conv-row is in the DOM (and whether
// the feed was still $stale then), plus the moment the fresh landing applied
function installProbeSource() {
  return `(() => {
    const s = { firstRow: null, staleAtFirstRow: null, ready: null };
    window.__persistProbe = s;
    const attach = () => {
      if (!document.body) { setTimeout(attach, 0); return; }
      const status = () => document.getElementById('perf-status');
      new MutationObserver(() => {
        if (s.firstRow == null && document.querySelector('.conv-row')) {
          s.firstRow = performance.now();
          s.staleAtFirstRow = status()?.getAttribute('data-feed-stale');
        }
        if (s.ready == null && status()?.getAttribute('data-ready') === 'true') s.ready = performance.now();
      }).observe(document.body, { childList: true, subtree: true, attributes: true });
    };
    attach();
  })();`;
}

// IndexedDB read-back from inside the page: keys of the harness database
async function idbKeys(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('manifest:' + location.origin, 1);
    req.onerror = () => resolve({ error: String(req.error) });
    req.onupgradeneeded = () => { /* created empty */ };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sources')) { db.close(); resolve([]); return; }
      const tx = db.transaction('sources', 'readonly');
      const r = tx.objectStore('sources').getAll();
      r.onsuccess = () => { db.close(); resolve(r.result.map((x) => ({ key: x.key, rows: Array.isArray(x.rows) ? x.rows.length : 1, savedAt: x.savedAt }))); };
      r.onerror = () => { db.close(); resolve({ error: String(r.error) }); };
    };
  }));
}

async function loadAndMeasure(page, url) {
  const fetchesBefore = 0;
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__persistProbe?.ready != null, { timeout: 60000 });
  const raw = await page.evaluate(() => {
    const s = window.__persistProbe;
    const el = document.getElementById('perf-status');
    return {
      firstRowMs: s.firstRow, staleAtFirstRow: s.staleAtFirstRow, readyMs: s.ready,
      requests: window.__perfFeedFetches, rows: document.querySelectorAll('.conv-row').length,
      feedLength: Number(el?.getAttribute('data-feed-length') || 0),
      diagnostics: window.ManifestData?.persistence?.() || null
    };
  });
  void fetchesBefore;
  // let the debounced snapshot land (500ms after the last landing)
  await new Promise((r) => setTimeout(r, 800));
  return raw;
}

// Workspace switch A→B while polling the rendered list every 10ms: any row
// carrying the previous workspace after the switch is a contract violation
async function switchScope(page, to) {
  const before = await page.evaluate(() => performance.now());
  const result = await page.evaluate((to) => new Promise((resolve) => {
    const from = window.__perfWorkspace;
    const samples = [];
    const start = performance.now();
    const poll = setInterval(() => {
      const ws = [...document.querySelectorAll('.conv-row')].map((r) => r.getAttribute('data-ws'));
      samples.push({ t: performance.now() - start, rows: ws.length, stale: ws.filter((w) => w === from).length, fresh: ws.filter((w) => w === to).length });
    }, 10);
    window.__perfWorkspace = to;
    const fetches = window.__perfFeedFetches;
    window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'));
    const check = () => {
      const el = document.getElementById('perf-status');
      const done = el?.getAttribute('data-feed-stale') === 'false' && el?.getAttribute('data-feed-ws') === to;
      if (done || performance.now() - start > 15000) {
        clearInterval(poll);
        const ws = [...document.querySelectorAll('.conv-row')].map((r) => r.getAttribute('data-ws'));
        samples.push({ t: performance.now() - start, rows: ws.length, stale: ws.filter((w) => w === from).length, fresh: ws.filter((w) => w === to).length });
        const firstFresh = samples.find((s) => s.fresh > 0);
        const emptyFirst = samples.find((s) => s.rows === 0);
        resolve({
          from, to, samples: samples.length, staleSamples: samples.filter((s) => s.stale > 0).length,
          emptyAtMs: emptyFirst ? emptyFirst.t : null, firstFreshRowMs: firstFresh ? firstFresh.t : null,
          readyMs: performance.now() - start, requests: window.__perfFeedFetches - fetches,
          scope: window.ManifestData?.persistence?.().scope
        });
        return;
      }
      setTimeout(check, 10);
    };
    check();
  }), to);
  void before;
  await new Promise((r) => setTimeout(r, 800));
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let puppeteer;
  try { ({ default: puppeteer } = await import('puppeteer')); }
  catch (e) { console.error('[perf] puppeteer is not installed/resolvable:', e.message); process.exit(1); }

  let serverHandle = null;
  let baseUrl;
  if (args.url) baseUrl = args.url;
  else {
    serverHandle = await ensureDevServer();
    baseUrl = `${serverHandle.url}/perf`;
  }
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}source=x&persist=1&${args.params}`;

  const browser = await puppeteer.launch({ headless: !args.headed });
  try {
    const cold = [], warm = [];
    let logout = null, switched = null;
    for (let i = 0; i < args.samples; i++) {
      // fresh context per sample: no IndexedDB, no HTTP cache
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.evaluateOnNewDocument(installProbeSource());
      const c = await loadAndMeasure(page, url);
      c.idb = await idbKeys(page);
      cold.push(c);
      const w = await loadAndMeasure(page, url);
      warm.push(w);
      if (i === args.samples - 1) {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('manifest:auth:logout')));
        await new Promise((r) => setTimeout(r, 300));
        const keys = await idbKeys(page);
        logout = { scopeKeysAfterLogout: Array.isArray(keys) ? keys.filter((k) => k.key.startsWith('A|')).length : keys, allKeys: Array.isArray(keys) ? keys.map((k) => k.key) : keys };
        // re-populate A, then switch A → B
        await loadAndMeasure(page, url);
        switched = await switchScope(page, 'B');
        const after = await idbKeys(page);
        switched.idbKeysAfter = Array.isArray(after) ? after.map((k) => k.key) : after;
      }
      await context.close();
    }
    const pick = (list, k) => median(list.map((s) => s[k]));
    console.log(JSON.stringify({
      scenario: 'persist-cold', firstRowMs: pick(cold, 'firstRowMs'), readyMs: pick(cold, 'readyMs'), requests: pick(cold, 'requests'),
      rowsOnScreen: cold[cold.length - 1].rows, feedLength: cold[cold.length - 1].feedLength, staleAtFirstRow: cold[cold.length - 1].staleAtFirstRow,
      idbAfter: cold[cold.length - 1].idb
    }));
    console.log(JSON.stringify({
      scenario: 'persist-warm', firstRowMs: pick(warm, 'firstRowMs'), readyMs: pick(warm, 'readyMs'), requests: pick(warm, 'requests'),
      rowsOnScreen: warm[warm.length - 1].rows, feedLength: warm[warm.length - 1].feedLength, staleAtFirstRow: warm[warm.length - 1].staleAtFirstRow,
      diagnostics: warm[warm.length - 1].diagnostics
    }));
    console.log(JSON.stringify({ scenario: 'persist-logout', ...logout }));
    console.log(JSON.stringify({ scenario: 'persist-switch', ...switched }));
  } finally {
    await browser.close();
    if (serverHandle?.ownedByUs) serverHandle.child.kill();
  }
}

main().catch((e) => { console.error('[perf] fatal:', e); process.exit(1); });
