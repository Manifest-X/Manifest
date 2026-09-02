#!/usr/bin/env node
// P6 landing harness (PERF-PRIMITIVES-DESIGN.md §5): mutation volume and
// blocked time while N pages land into a `$x` source, then while realtime-
// shaped upserts hit it. Drives /perf?source=x (see perf-demo.html) and prints
// one JSON line per scenario. Companion to probe.mjs; same §2 metrics.
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
    const s = { mutations: 0, longtasks: [], marks: {} };
    window.__landingProbe = s;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) s.longtasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch (e) {}
    const snap = () => ({ t: performance.now(), mutations: s.mutations });
    s.snap = snap;
    const attach = () => {
      if (!document.body) { setTimeout(attach, 0); return; }
      new MutationObserver((records) => { s.mutations += records.length; })
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
  return {
    source: raw.source,
    landing: { mutations: ready.mutations - firstPage.mutations, ...landing, wallMs: ready.t - firstPage.t },
    upserts: { mutations: raw.end.mutations - ready.mutations, ...upserts, count: raw.upserts }
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
    for (const scenario of ['landing', 'upserts']) {
      const pick = (k) => median(samples.map((s) => s[scenario][k]));
      const out = { scenario: `x-${scenario}`, mutations: pick('mutations'), blockedMs: pick('blockedMs'), longestTaskMs: pick('longestTaskMs') };
      if (scenario === 'landing') out.wallMs = pick('wallMs');
      else out.upserts = pick('count');
      console.log(JSON.stringify(out));
    }
  } finally {
    await browser.close();
    if (serverHandle?.ownedByUs) serverHandle.child.kill();
  }
}

main().catch((e) => { console.error('[perf] fatal:', e); process.exit(1); });
