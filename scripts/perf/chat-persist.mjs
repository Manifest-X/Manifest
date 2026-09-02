#!/usr/bin/env node
// Persisted $chat windows harness (PERF-PRIMITIVES-DESIGN.md §12.2 primitive 3):
// cold page load vs warm reload → time to first message row and adapter loads;
// in-page warm vs cold open; a 31st conversation evicting the oldest record;
// workspace switch A→B polled every 10ms → zero rows from A at any sample.
// Drives /chat-persist?persist=1 (src/test/components/chat-persist-demo.html)
// and prints one JSON line per scenario. Companion to persist.mjs.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const out = { samples: 3, netMs: 400, conversations: 31 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--samples') out.samples = parseInt(argv[++i], 10) || 3;
    else if (a === '--netMs') out.netMs = parseInt(argv[++i], 10) || 400;
    else if (a === '--conversations') out.conversations = parseInt(argv[++i], 10) || 31;
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

// From navigation: first .msg-row in the DOM (and whether the window was stale
// then), plus the moment the handle is ready and not stale
function installProbeSource() {
  return `(() => {
    const s = { firstRow: null, staleAtFirstRow: null, ready: null };
    window.__chatProbe = s;
    const attach = () => {
      if (!document.body) { setTimeout(attach, 0); return; }
      const status = () => document.getElementById('chat-persist-status');
      new MutationObserver(() => {
        if (s.firstRow == null && document.querySelector('.msg-row')) {
          s.firstRow = performance.now();
          s.staleAtFirstRow = status()?.getAttribute('data-stale');
        }
        const el = status();
        if (s.ready == null && el?.getAttribute('data-status') === 'ready' && el?.getAttribute('data-stale') === 'false') s.ready = performance.now();
      }).observe(document.body, { childList: true, subtree: true, attributes: true });
    };
    attach();
  })();`;
}

async function idbRecords(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('manifest:' + location.origin, 1);
    req.onerror = () => resolve({ error: String(req.error) });
    req.onupgradeneeded = () => { /* created empty */ };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sources')) { db.close(); resolve([]); return; }
      const tx = db.transaction('sources', 'readonly');
      const r = tx.objectStore('sources').getAll();
      r.onsuccess = () => { db.close(); resolve(r.result.map((x) => ({ key: x.key, kind: x.kind, rows: Array.isArray(x.rows) ? x.rows.length : null, recent: x.recent, savedAt: x.savedAt }))); };
      r.onerror = () => { db.close(); resolve({ error: String(r.error) }); };
    };
  }));
}

async function loadAndMeasure(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__chatProbe?.ready != null, { timeout: 60000 });
  const raw = await page.evaluate(() => {
    const s = window.__chatProbe;
    const el = document.getElementById('chat-persist-status');
    return {
      firstRowMs: s.firstRow, staleAtFirstRow: s.staleAtFirstRow, readyMs: s.ready,
      adapterLoads: window.__chatLoads, rows: document.querySelectorAll('.msg-row').length,
      count: Number(el?.getAttribute('data-count') || 0)
    };
  });
  await new Promise((r) => setTimeout(r, 800)); // debounced snapshot (500ms after the last change)
  return raw;
}

// In-page open: time from __chatOpen(id) to the first row of THAT conversation and to ready
async function openAndMeasure(page, id) {
  const result = await page.evaluate((id) => new Promise((resolve) => {
    const start = performance.now();
    const loads = window.__chatLoads;
    let firstRow = null, staleAtFirstRow = null;
    const status = () => document.getElementById('chat-persist-status');
    const mo = new MutationObserver(() => {
      if (firstRow == null && document.querySelector(`.msg-row[data-id^="${id}-"]`)) { firstRow = performance.now() - start; staleAtFirstRow = status()?.getAttribute('data-stale'); }
      const el = status();
      if (el?.getAttribute('data-conv') === id && el?.getAttribute('data-status') === 'ready' && el?.getAttribute('data-stale') === 'false') {
        mo.disconnect();
        resolve({ id, firstRowMs: firstRow, staleAtFirstRow, readyMs: performance.now() - start, adapterLoads: window.__chatLoads - loads, rows: document.querySelectorAll('.msg-row').length });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.__chatOpen(id);
    setTimeout(() => { mo.disconnect(); resolve({ id, firstRowMs: firstRow, staleAtFirstRow, readyMs: null, timeout: true }); }, 15000);
  }), id);
  await new Promise((r) => setTimeout(r, 800));
  return result;
}

// Workspace switch A→B while polling the rendered rows every 10ms: any row
// stamped with the previous workspace after the switch is a contract violation
async function switchScope(page, to) {
  const result = await page.evaluate((to) => new Promise((resolve) => {
    const from = window.__perfWorkspace;
    const samples = [];
    const start = performance.now();
    const poll = setInterval(() => {
      const ws = [...document.querySelectorAll('.msg-row')].map((r) => r.getAttribute('data-ws'));
      samples.push({ t: performance.now() - start, rows: ws.length, foreign: ws.filter((w) => w === from).length });
    }, 10);
    window.__chatSwitch(to);
    const check = () => {
      const el = document.getElementById('chat-persist-status');
      const idle = el?.getAttribute('data-status') === 'idle' && el?.getAttribute('data-ws') === to;
      if (idle || performance.now() - start > 5000) {
        clearInterval(poll);
        const ws = [...document.querySelectorAll('.msg-row')].map((r) => r.getAttribute('data-ws'));
        samples.push({ t: performance.now() - start, rows: ws.length, foreign: ws.filter((w) => w === from).length });
        const emptyFirst = samples.find((s) => s.rows === 0);
        resolve({
          from, to, samples: samples.length, foreignSamples: samples.filter((s) => s.foreign > 0).length,
          emptyAtMs: emptyFirst ? emptyFirst.t : null, idle,
          scope: window.ManifestData?.persistence?.().scope
        });
        return;
      }
      setTimeout(check, 10);
    };
    check();
  }), to);
  await new Promise((r) => setTimeout(r, 300));
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
    baseUrl = `${serverHandle.url}/chat-persist`;
  }
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}persist=1&netMs=${args.netMs}&conv=c1&ws=A`;

  const browser = await puppeteer.launch({ headless: !args.headed });
  try {
    const cold = [], warm = [], openCold = [], openWarm = [];
    let eviction = null, switched = null, afterSwitch = null;
    for (let i = 0; i < args.samples; i++) {
      // fresh context per sample: no IndexedDB, no HTTP cache
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.evaluateOnNewDocument(installProbeSource());
      const c = await loadAndMeasure(page, url);
      c.idb = await idbRecords(page);
      cold.push(c);
      warm.push(await loadAndMeasure(page, url));
      // in-page: c2 cold (no record), then c1 warm (record from the page loads)
      openCold.push(await openAndMeasure(page, 'c2'));
      openWarm.push(await openAndMeasure(page, 'c1'));
      if (i === args.samples - 1) {
        // open up to `conversations` distinct conversations: the oldest record is evicted past the cap
        const opened = [];
        for (let n = 3; n <= args.conversations; n++) opened.push(await openAndMeasure(page, `c${n}`));
        const recs = await idbRecords(page);
        const chatKeys = Array.isArray(recs) ? recs.filter((r) => r.kind === 'chat').map((r) => r.key) : recs;
        const index = Array.isArray(recs) ? recs.find((r) => r.kind === 'chat-index') : null;
        // open order so far: c1 (page loads), c2, c1 again, c3…cN → c2 is the least recently opened
        const all = ['c1', 'c2', ...opened.map((o) => o.id)];
        eviction = {
          opened: all.length, cap: 30, chatRecords: chatKeys.length, indexRecent: index?.recent?.length,
          newest: index?.recent?.[0], oldestKept: index?.recent?.[index.recent.length - 1],
          evicted: all.filter((id) => !chatKeys.includes(`A|chat|${id}`)), expectedEvicted: all.length > 30 ? ['c2'] : [],
          openMs: median(opened.map((o) => o.readyMs)),
          diagnostics: await page.evaluate(() => { const d = window.ManifestChatPersist?.persistence(); return d && { enabled: d.enabled, conversations: d.conversations.length }; })
        };
        switched = await switchScope(page, 'B');
        afterSwitch = await openAndMeasure(page, 'c1');
        const after = await idbRecords(page);
        afterSwitch.foreignRowsNow = await page.evaluate(() => document.querySelectorAll('.msg-row[data-ws="A"]').length);
        afterSwitch.idbKeys = Array.isArray(after) ? after.map((r) => r.key) : after;
      }
      await context.close();
    }
    const pick = (list, k) => median(list.map((s) => s[k]));
    const last = (list) => list[list.length - 1];
    console.log(JSON.stringify({ scenario: 'chat-persist-cold', netMs: args.netMs, firstRowMs: pick(cold, 'firstRowMs'), readyMs: pick(cold, 'readyMs'), adapterLoads: pick(cold, 'adapterLoads'), staleAtFirstRow: last(cold).staleAtFirstRow, rows: last(cold).rows, idbAfter: last(cold).idb }));
    console.log(JSON.stringify({ scenario: 'chat-persist-warm', netMs: args.netMs, firstRowMs: pick(warm, 'firstRowMs'), readyMs: pick(warm, 'readyMs'), adapterLoads: pick(warm, 'adapterLoads'), staleAtFirstRow: last(warm).staleAtFirstRow, rows: last(warm).rows }));
    console.log(JSON.stringify({ scenario: 'chat-open-cold', firstRowMs: pick(openCold, 'firstRowMs'), readyMs: pick(openCold, 'readyMs'), adapterLoads: pick(openCold, 'adapterLoads'), staleAtFirstRow: last(openCold).staleAtFirstRow }));
    console.log(JSON.stringify({ scenario: 'chat-open-warm', firstRowMs: pick(openWarm, 'firstRowMs'), readyMs: pick(openWarm, 'readyMs'), adapterLoads: pick(openWarm, 'adapterLoads'), staleAtFirstRow: last(openWarm).staleAtFirstRow, rowsAtFirst: 50, rowsAfterReconcile: last(openWarm).rows }));
    console.log(JSON.stringify({ scenario: 'chat-persist-eviction', ...eviction }));
    console.log(JSON.stringify({ scenario: 'chat-persist-switch', ...switched, reopenUnderB: afterSwitch }));
  } finally {
    await browser.close();
    if (serverHandle?.ownedByUs) serverHandle.child.kill();
  }
}

main().catch((e) => { console.error('[perf] fatal:', e); process.exit(1); });
