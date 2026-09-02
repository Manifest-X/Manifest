#!/usr/bin/env node
// P6 landing harness (PERF-PRIMITIVES-DESIGN.md §5): mutation volume and
// blocked time while N pages land into a `$x` source, then while realtime-
// shaped upserts hit it, then across a cache-miss reload of that source
// (P5, §11.1: identity kept, one request for N concurrent loads). Drives
// /perf?source=x (see perf-demo.html) and prints one JSON line per scenario.
// Companion to probe.mjs; same §2 metrics. `--params '...&reload=legacy'`
// measures the pre-P5 reload shape for a before/after.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const out = { samples: 3, upsertWindowMs: 2000, params: 'pages=10&pageSize=100&cadenceMs=80&upsertEveryMs=200' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--params') out.params = argv[++i];
    else if (a === '--samples') out.samples = parseInt(argv[++i], 10) || 3;
    else if (a === '--upsert-window') out.upsertWindowMs = parseInt(argv[++i], 10) || 2000;
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

// Body-wide MutationObserver + longtask observer from navigation; snapshots
// taken when #perf-status reports the first page, every page, and ready.
function installProbeSource() {
  return `(() => {
    const s = { mutations: 0, lastMutationTime: 0, longtasks: [], marks: {} };
    window.__landingProbe = s;
    // quietMs of MutationObserver quiescence = settle (§2); resolves the window end
    s.waitSettle = (quietMs, hardTimeoutMs) => new Promise((resolve) => {
      const startedAt = performance.now();
      const check = () => {
        const now = performance.now();
        if (s.lastMutationTime && now - s.lastMutationTime >= quietMs) return resolve(s.lastMutationTime);
        if (now - startedAt >= hardTimeoutMs) return resolve(s.lastMutationTime || now);
        setTimeout(check, 30);
      };
      setTimeout(check, 30);
    });
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) s.longtasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) {}
    const snap = () => ({ t: performance.now(), mutations: s.mutations });
    s.snap = snap;
    const attach = () => {
      if (!document.body) { setTimeout(attach, 0); return; }
      new MutationObserver((records) => { s.mutations += records.length; s.lastMutationTime = performance.now(); })
        .observe(document.body, { childList: true, subtree: true, attributes: true });
      const watchStatus = () => {
        const el = document.getElementById('perf-status');
        if (!el) { setTimeout(watchStatus, 10); return; }
        new MutationObserver(() => {
          const landed = el.getAttribute('data-landed-pages');
          if (landed === '1' && !s.marks.firstPage) s.marks.firstPage = snap();
          if (el.getAttribute('data-ready') === 'true' && !s.marks.ready) s.marks.ready = snap();
        }).observe(el, { attributes: true });
      };
      watchStatus();
    };
    attach();
  })();`;
}

function blockedBetween(longtasks, from, to) {
  const inWin = longtasks.filter((t) => t.start >= from && t.start <= to);
  return {
    blockedMs: inWin.reduce((a, t) => a + t.dur, 0),
    longestTaskMs: inWin.reduce((a, t) => Math.max(a, t.dur), 0)
  };
}

async function sample(page, url, upsertWindowMs) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => window.__landingProbe?.marks?.ready != null, { timeout: 60000 }
  );
  await new Promise((r) => setTimeout(r, upsertWindowMs));
  const raw = await page.evaluate(() => {
    const s = window.__landingProbe;
    const end = s.snap();
    const status = document.getElementById('perf-status');
    return { marks: s.marks, end, longtasks: s.longtasks, upserts: Number(status?.getAttribute('data-upserts') || 0), source: status?.getAttribute('data-source') || 'local' };
  });
  const { firstPage, ready } = raw.marks;
  const landing = blockedBetween(raw.longtasks, firstPage.t, ready.t);
  const upserts = blockedBetween(raw.longtasks, ready.t, raw.end.t);
  const out = {
    source: raw.source,
    landing: { mutations: ready.mutations - firstPage.mutations, ...landing, wallMs: ready.t - firstPage.t },
    upserts: { mutations: raw.end.mutations - ready.mutations, ...upserts, count: raw.upserts }
  };
  if (await page.$('#perf-reload')) out.reload = await sampleReload(page);
  return out;
}

// Cache-miss reload of the `feed` source (3 concurrent loadDataSource calls):
// window = click → settle; identity/requests read back from #perf-status
async function sampleReload(page) {
  const seq = await page.evaluate(() => Number(document.getElementById('perf-status')?.getAttribute('data-reload-seq') || 0));
  const start = await page.evaluate(() => window.__landingProbe.snap());
  await page.click('#perf-reload');
  await page.waitForFunction((prev) => {
    const el = document.getElementById('perf-status');
    return Number(el?.getAttribute('data-reload-seq')) > prev && el?.getAttribute('data-reload-done') === 'true';
  }, { timeout: 30000 }, seq);
  const settleEnd = await page.evaluate(() => window.__landingProbe.waitSettle(500, 10000));
  const raw = await page.evaluate(() => {
    const s = window.__landingProbe;
    const el = document.getElementById('perf-status');
    return {
      end: s.snap(), longtasks: s.longtasks,
      shape: el?.getAttribute('data-reload-shape'), identity: el?.getAttribute('data-reload-identity'),
      array: el?.getAttribute('data-reload-array'), requests: Number(el?.getAttribute('data-reload-requests') || 0)
    };
  });
  const win = blockedBetween(raw.longtasks, start.t, settleEnd);
  return {
    shape: raw.shape, identity: raw.identity, array: raw.array, requests: raw.requests,
    mutations: raw.end.mutations - start.mutations, ...win, wallMs: settleEnd - start.t
  };
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
  const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}source=x&${args.params}`;

  const browser = await puppeteer.launch({ headless: !args.headed });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(installProbeSource());
    const samples = [];
    for (let i = 0; i < args.samples; i++) samples.push(await sample(page, url, args.upsertWindowMs));
    for (const scenario of ['landing', 'upserts', 'reload']) {
      if (!samples.every((s) => s[scenario])) continue;
      const pick = (k) => median(samples.map((s) => s[scenario][k]));
      const out = { scenario: `x-${scenario}`, mutations: pick('mutations'), blockedMs: pick('blockedMs'), longestTaskMs: pick('longestTaskMs') };
      if (scenario === 'landing') out.wallMs = pick('wallMs');
      else if (scenario === 'upserts') out.upserts = pick('count');
      else {
        const last = samples[samples.length - 1].reload;
        Object.assign(out, { shape: last.shape, identity: last.identity, array: last.array, requests: pick('requests'), wallMs: pick('wallMs') });
      }
      console.log(JSON.stringify(out));
    }
  } finally {
    await browser.close();
    if (serverHandle?.ownedByUs) serverHandle.child.kill();
  }
}

main().catch((e) => { console.error('[perf] fatal:', e); process.exit(1); });
