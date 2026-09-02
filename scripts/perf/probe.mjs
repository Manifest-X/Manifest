#!/usr/bin/env node
// Phase 0 perf harness runner (PERF-PRIMITIVES-DESIGN.md §7). Drives a page
// through first-open / warm-switch / menu-open and reports the §2 shared
// metrics as JSON lines. App-agnostic: point it at any app with --url and
// --selectors; defaults target this repo's /perf test route.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_SELECTORS = {
  openRow: '#perf-open-row',
  altRow: '[data-perf-alt-row]',
  openMenu: '#perf-open-menu',
  menuPopover: '#perf-menu-0',
  localWrite: '#perf-local-write' // optional: one-field local write on one row (P6); skipped when absent
};

// ---- CLI args ----
function parseArgs(argv) {
  const out = { samples: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--params') out.params = argv[++i];
    else if (a === '--selectors') out.selectors = JSON.parse(argv[++i]);
    else if (a === '--budget') out.budget = JSON.parse(argv[++i]);
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

// ---- dev server (only used when --url isn't given) ----
function ensureDevServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['packages/run/serve.mjs', 'src', '--no-open', '--no-idle-shutdown'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' }
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

// ---- browser-side probe (installed on every navigation) ----
function installProbeSource() {
  return `(() => {
    const state = {
      longtasks: [], mutations: 0, lastMutationTime: 0, gestureStart: null, toggleFirstPaint: null, mo: null
    };
    window.__perfProbe = state;
    try {
      const lto = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) state.longtasks.push({ start: e.startTime, dur: e.duration });
      });
      lto.observe({ type: 'longtask', buffered: true });
    } catch (e) { /* longtask not supported */ }
    const attachBodyObserver = () => {
      if (!document.documentElement) { setTimeout(attachBodyObserver, 0); return; }
      if (!document.body) {
        const bootObs = new MutationObserver(() => {
          if (document.body) { bootObs.disconnect(); attachBodyObserver(); }
        });
        bootObs.observe(document.documentElement, { childList: true });
        return;
      }
      state.mo = new MutationObserver((records) => {
        state.mutations += records.length;
        state.lastMutationTime = performance.now();
      });
      state.mo.observe(document.body, { childList: true, subtree: true, attributes: true });
    };
    attachBodyObserver();
    state.reset = function () {
      state.longtasks = []; state.mutations = 0; state.lastMutationTime = 0;
      state.gestureStart = null; state.toggleFirstPaint = null;
    };
    // Capture-phase pointerdown = gesture start (§2). Fires once, then detaches.
    state.armGesture = function (selector) {
      const onDown = () => { state.gestureStart = performance.now(); document.removeEventListener('pointerdown', onDown, true); };
      document.addEventListener('pointerdown', onDown, true);
    };
    // Popover 'toggle' -> first rAF after = menu input latency anchor.
    state.armToggleLatency = function (selector) {
      const el = document.querySelector(selector);
      if (!el) return;
      const onToggle = () => {
        el.removeEventListener('toggle', onToggle);
        requestAnimationFrame(() => { state.toggleFirstPaint = performance.now(); });
      };
      el.addEventListener('toggle', onToggle);
    };
    // 500ms of MutationObserver quiescence on document.body = settle (§2).
    state.waitSettle = function (quietMs, hardTimeoutMs) {
      quietMs = quietMs || 500; hardTimeoutMs = hardTimeoutMs || 15000;
      return new Promise((resolve) => {
        const startedAt = performance.now();
        const check = () => {
          const now = performance.now();
          const since = now - (state.lastMutationTime || startedAt);
          if (state.lastMutationTime && since >= quietMs) return resolve(state.lastMutationTime);
          if (now - startedAt >= hardTimeoutMs) return resolve(state.lastMutationTime || now);
          setTimeout(check, 30);
        };
        setTimeout(check, 30);
      });
    };
  })();`;
}

async function gotoAndBoot(page, url, timeoutMs) {
  await page.goto(url, { waitUntil: 'load', timeout: timeoutMs || 30000 });
  await page.waitForSelector('#perf-status', { timeout: timeoutMs || 30000 });
  await page.waitForFunction(
    () => document.getElementById('perf-status')?.getAttribute('data-ready') === 'true',
    { timeout: timeoutMs || 30000 }
  );
}

async function collectWindow(page, settleEnd) {
  const raw = await page.evaluate(() => {
    const s = window.__perfProbe;
    return { gestureStart: s.gestureStart, longtasks: s.longtasks, mutations: s.mutations };
  });
  const end = settleEnd || raw.gestureStart;
  const inWindow = raw.gestureStart == null ? [] : raw.longtasks.filter((t) => t.start >= raw.gestureStart && t.start <= end);
  const blockedMs = inWindow.reduce((a, t) => a + t.dur, 0);
  const longestTaskMs = inWindow.reduce((a, t) => Math.max(a, t.dur), 0);
  return { blockedMs, longestTaskMs, mutations: raw.mutations };
}

async function sampleFirstOpen(page, url, selectors) {
  await gotoAndBoot(page, url);
  await page.evaluate(() => window.__perfProbe.reset());
  await page.evaluate((sel) => window.__perfProbe.armGesture(sel), selectors.openRow);
  await page.click(selectors.openRow);
  const settleEnd = await page.evaluate(() => window.__perfProbe.waitSettle());
  const win = await collectWindow(page, settleEnd);
  return { scenario: 'first-open', ...win, inputLatencyMs: null };
}

async function sampleWarmSwitch(page, selectors) {
  // Assumes openRow is already warm and altRow is currently active.
  await page.evaluate(() => window.__perfProbe.reset());
  await page.evaluate((sel) => window.__perfProbe.armGesture(sel), selectors.openRow);
  await page.click(selectors.openRow);
  const settleEnd = await page.evaluate(() => window.__perfProbe.waitSettle());
  const win = await collectWindow(page, settleEnd);
  // switch away so the next sample is a real switch back, not a no-op click
  await page.click(selectors.altRow);
  await page.evaluate(() => window.__perfProbe.waitSettle());
  return { scenario: 'warm-switch', ...win, inputLatencyMs: null };
}

async function sampleMenuOpen(page, selectors) {
  const isOpen = await page.evaluate((sel) => !!document.querySelector(sel)?.matches(':popover-open'), selectors.menuPopover);
  if (isOpen) {
    await page.click(selectors.openMenu);
    await page.evaluate(() => window.__perfProbe.waitSettle());
  }
  await page.evaluate(() => window.__perfProbe.reset());
  await page.evaluate((sel) => window.__perfProbe.armGesture(sel), selectors.openMenu);
  await page.evaluate((sel) => window.__perfProbe.armToggleLatency(sel), selectors.menuPopover);
  await page.click(selectors.openMenu);
  const settleEnd = await page.evaluate(() => window.__perfProbe.waitSettle());
  const win = await collectWindow(page, settleEnd);
  const inputLatencyMs = await page.evaluate(() => {
    const s = window.__perfProbe;
    return (s.toggleFirstPaint != null && s.gestureStart != null) ? (s.toggleFirstPaint - s.gestureStart) : null;
  });
  // leave it closed for the next sample
  await page.click(selectors.openMenu);
  await page.evaluate(() => window.__perfProbe.waitSettle());
  return { scenario: 'menu-open', ...win, inputLatencyMs };
}

async function sampleLocalWrite(page, selectors) {
  await page.evaluate(() => window.__perfProbe.reset());
  await page.evaluate((sel) => window.__perfProbe.armGesture(sel), selectors.localWrite);
  await page.click(selectors.localWrite);
  const settleEnd = await page.evaluate(() => window.__perfProbe.waitSettle());
  const win = await collectWindow(page, settleEnd);
  return { scenario: 'local-write', ...win, inputLatencyMs: null };
}

function reportBudget(scenario, medians, budget) {
  if (!budget || !budget[scenario]) return true;
  let ok = true;
  for (const [key, limit] of Object.entries(budget[scenario])) {
    const value = medians[key];
    if (value != null && value > limit) {
      console.error(`[perf] BUDGET FAIL ${scenario}.${key}: ${value.toFixed(2)} > ${limit}`);
      ok = false;
    }
  }
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectors = { ...DEFAULT_SELECTORS, ...(args.selectors || {}) };

  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch (e) {
    console.error('[perf] puppeteer is not installed/resolvable:', e.message);
    process.exit(1);
  }

  let serverHandle = null;
  let baseUrl;
  if (args.url) {
    baseUrl = args.url;
  } else {
    try {
      serverHandle = await ensureDevServer();
      baseUrl = `${serverHandle.url}/perf`;
    } catch (e) {
      console.error('[perf] could not start/reach the test project dev server:', e.message);
      process.exit(1);
    }
  }
  const url = args.params ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${args.params}` : baseUrl;

  let browser;
  try {
    browser = await puppeteer.launch({ headless: !args.headed });
  } catch (e) {
    console.error('[perf] puppeteer failed to launch Chrome:', e.message);
    if (serverHandle?.ownedByUs) serverHandle.child.kill();
    process.exit(1);
  }

  const allResults = [];
  let exitCode = 0;

  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(installProbeSource());

    // ---- first-open: fresh navigation per sample (never opened this session) ----
    const firstOpenSamples = [];
    for (let i = 0; i < args.samples; i++) {
      firstOpenSamples.push(await sampleFirstOpen(page, url, selectors));
    }

    // ---- warm-switch: same session, alternate open-row / alt-row ----
    await page.click(selectors.altRow); // ensure alt-row is active before the loop switches back
    await page.evaluate(() => window.__perfProbe.waitSettle());
    const warmSwitchSamples = [];
    for (let i = 0; i < args.samples; i++) {
      warmSwitchSamples.push(await sampleWarmSwitch(page, selectors));
    }

    // ---- menu-open: same session, toggle closed -> open each time ----
    const menuOpenSamples = [];
    for (let i = 0; i < args.samples; i++) {
      menuOpenSamples.push(await sampleMenuOpen(page, selectors));
    }

    // ---- local-write: same session, one-field write on one row (only when the page exposes it) ----
    const localWriteSamples = [];
    if (selectors.localWrite && await page.$(selectors.localWrite)) {
      for (let i = 0; i < args.samples; i++) {
        localWriteSamples.push(await sampleLocalWrite(page, selectors));
      }
    }

    for (const [scenario, samples] of [
      ['first-open', firstOpenSamples],
      ['warm-switch', warmSwitchSamples],
      ['menu-open', menuOpenSamples],
      ['local-write', localWriteSamples]
    ]) {
      if (!samples.length) continue;
      const medians = {
        scenario,
        blockedMs: median(samples.map((s) => s.blockedMs)),
        longestTaskMs: median(samples.map((s) => s.longestTaskMs)),
        mutations: median(samples.map((s) => s.mutations)),
        inputLatencyMs: median(samples.map((s) => s.inputLatencyMs))
      };
      allResults.push(medians);
      console.log(JSON.stringify(medians));
      if (!reportBudget(scenario, medians, args.budget)) exitCode = 1;
    }
  } finally {
    await browser.close();
    if (serverHandle?.ownedByUs) serverHandle.child.kill();
  }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[perf] fatal:', e);
  process.exit(1);
});
