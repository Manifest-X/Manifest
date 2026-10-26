#!/usr/bin/env node
/*
 * Prerender end-to-end harness.
 *
 * Validates the prerender + runtime hydration pipeline against a fixture
 * project that exercises every interactive Manifest directive in the catalog.
 * The harness runs the ACTUAL prerender script (not a mock), serves the
 * prerendered output from a static file server, and loads each page in a real
 * headless Chromium.  It asserts that every interactive behavior (theme
 * toggles, locale switching, popup visibility, counter increment, baked
 * content, preserved directives, etc.) works correctly on the prerendered
 * output — which is the one thing local SPA serving cannot verify.
 *
 * Failure modes this catches that grep-on-HTML cannot:
 *  - Alpine's `:class` diff logic fighting with baked state
 *  - Plugin re-initialization clobbering prerendered DOM
 *  - Event listeners attached to the wrong element after rehydration
 *  - Icons/markdown plugins re-running and wiping baked content
 *  - Hydration contract parse/apply errors
 */
import { spawn } from 'node:child_process';
import { cp, rm, mkdtemp, readFile, readdir, writeFile, appendFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const FIXTURE_SRC_DIR = join(__dirname, 'fixture');
const REPO_SRC_DIR = join(__dirname, '..', '..', '..', '..', 'src');
const WORK_DIR = await mkdtemp(join(tmpdir(), 'mnfst-render-e2e-'));
const FIXTURE_DIR = join(WORK_DIR, 'site');
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await rm(WORK_DIR, { recursive: true, force: true });
    process.exit(130);
  });
}
const FIXTURE_OUT_DIR = join(FIXTURE_DIR, '.out');
const RENDER_SCRIPT = join(__dirname, '..', '..', 'manifest.render.mjs');
const DEV_PORT = 5099;
const STATIC_PORT = 5100;

// ---- logging ----------------------------------------------------------------
const colors = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m',
};
const log = {
  info: (m) => process.stdout.write(`${colors.cyan}•${colors.reset} ${m}\n`),
  pass: (m) => process.stdout.write(`${colors.green}✓${colors.reset} ${m}\n`),
  fail: (m) => process.stdout.write(`${colors.red}✗${colors.reset} ${m}\n`),
  note: (m) => process.stdout.write(`${colors.gray}  ${m}${colors.reset}\n`),
  head: (m) => process.stdout.write(`\n${colors.bold}${m}${colors.reset}\n`),
};

let failed = 0;
let passed = 0;
function assert(cond, label, detail) {
  if (cond) { passed++; log.pass(label); }
  else { failed++; log.fail(label); if (detail) log.note(detail); }
}

// ---- fixture prep -----------------------------------------------------------
function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error(`node ${args.join(' ')} exited ${code}\n${out}`)));
  });
}

// Fixture copy + scripts built from src/ by the release build, all in a temp dir
async function prepFixture() {
  log.head('Preparing fixture');
  await cp(FIXTURE_SRC_DIR, FIXTURE_DIR, {
    recursive: true,
    filter: (p) => !['.out', 'scripts', 'styles'].includes(relative(FIXTURE_SRC_DIR, p).split('/')[0]),
  });
  await runNode(['scripts/build.mjs', '--scripts-out', join(FIXTURE_DIR, 'scripts')], REPO_SRC_DIR);
  // Vendored Alpine beside the built scripts: e2e must not depend on CDN/DNS.
  await copyFile(join(REPO_SRC_DIR, '..', 'node_modules', 'alpinejs', 'dist', 'cdn.min.js'), join(FIXTURE_DIR, 'scripts', 'alpine.cdn.js'));
  log.note(`fixture prepared in ${FIXTURE_DIR} (scripts built from src/)`);
}

// ---- minimal static file server --------------------------------------------
function startStaticServer(rootDir, port) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.yaml': 'text/plain; charset=utf-8',
    '.yml': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.md': 'text/plain; charset=utf-8',
  };
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        let pathname = decodeURIComponent(url.pathname);
        // Browsers auto-request /favicon.ico; answer it so the absence of one
        // doesn't surface as a spurious 404 in the console-error assertion.
        if (pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
        if (pathname.endsWith('/')) pathname += 'index.html';
        let filePath = join(rootDir, pathname);
        if (!existsSync(filePath)) {
          // Try with /index.html suffix for directory routes
          const withIndex = join(rootDir, pathname, 'index.html');
          if (existsSync(withIndex)) filePath = withIndex;
          else {
            res.statusCode = 404;
            res.end('Not found: ' + pathname);
            return;
          }
        }
        const ext = extname(filePath).toLowerCase();
        res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.end(await readFile(filePath));
      } catch (e) {
        res.statusCode = 500;
        res.end('Error: ' + e.message);
      }
    });
    server.listen(port, () => resolve(server));
  });
}

// ---- run prerender ----------------------------------------------------------
async function runPrerender(extraArgs = [], quiet = false) {
  if (!quiet) log.head('Running prerender');
  // Always run the SOURCE render script (src/scripts/manifest.render.mjs),
  // not the synced copy in packages/render/.  The sync script is separate
  // and may be stale.
  const sourceRenderScript = join(REPO_SRC_DIR, 'scripts', 'manifest.render.mjs');
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('node', [sourceRenderScript, '--root', FIXTURE_DIR, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => {
      if (code !== 0) {
        process.stdout.write(stdout);
        process.stderr.write(stderr);
        reject(new Error(`prerender exited with code ${code}`));
      } else {
        if (!quiet) {
          // Show all relevant prerender output for debugging.
          const lines = stdout.split('\n').filter((l) =>
            l.startsWith('prerender:') || l.includes('total time') || l.includes('hydrate')
          );
          lines.forEach((l) => log.note(l.trim()));
        }
        resolve({ stdout, stderr, ms: Date.now() - startedAt });
      }
    });
  });
}

// ---- Puppeteer assertions ---------------------------------------------------
async function runAssertions() {
  log.head('Running browser assertions');
  const puppeteer = require('puppeteer-core');

  // Find a Chrome binary — honor an explicit override, otherwise let the full
  // puppeteer package resolve its own bundled download dynamically.
  let chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || null;
  if (!chromePath) {
    try { chromePath = require('puppeteer').executablePath(); } catch { /* full puppeteer not installed */ }
  }
  if (!chromePath || !existsSync(chromePath)) {
    throw new Error('No Chrome binary found.  Set PUPPETEER_EXECUTABLE_PATH or install Chrome via `npx puppeteer browsers install chrome`.');
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'shell',
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    // Collect console errors
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // Record removals of the late-settling x-if clone (flicker check).
    await page.evaluateOnNewDocument(() => {
      window.__xifLateRemoved = 0;
      window.__xifGuardRemoved = 0;
      new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.removedNodes) {
          if (n.id === 'xif-late') window.__xifLateRemoved++;
          if (n.id === 'xif-guard') window.__xifGuardRemoved++;
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`http://localhost:${STATIC_PORT}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Give Alpine + plugins a beat to settle
    await new Promise((r) => setTimeout(r, 2000));

    // Some sandboxed hosts never produce frames, so page.click (which waits on
    // one) hangs; fall back to a DOM click there.
    const framesWork = await page.evaluate(() => new Promise((r) => {
      requestAnimationFrame(() => r(true));
      setTimeout(() => r(false), 1500);
    }));
    if (!framesWork) log.note('no rendered frames in this environment; using DOM clicks');
    const click = (sel) => framesWork ? page.click(sel) : page.$eval(sel, (el) => el.click());

    // ------- Test: hydration contract was applied and removed --------------
    const contractState = await page.evaluate(() => ({
      blobStillPresent: !!document.getElementById('__manifest_hydrate__'),
      prerenderMeta: document.querySelector('meta[name="manifest:prerendered"]')?.getAttribute('content') || null,
    }));
    assert(contractState.prerenderMeta === '1', 'prerender meta tag present in output',
      `got: ${contractState.prerenderMeta}`);
    assert(!contractState.blobStillPresent, 'hydration contract blob removed by runtime');

    // ------- Test: baked $x content visible ---------------------------------
    const greeting = await page.$eval('#greeting', (el) => el.textContent.trim()).catch(() => null);
    assert(greeting === 'Hello', 'baked $x.content.greeting is "Hello" in prerendered output',
      `got: ${JSON.stringify(greeting)}`);

    // ------- Test: baked x-route section visible ----------------------------
    const homeHeading = await page.$eval('#home-heading', (el) => el.textContent.trim()).catch(() => null);
    assert(homeHeading === 'Home', 'home x-route heading baked and visible',
      `got: ${JSON.stringify(homeHeading)}`);

    // ------- Test: counter island (explicit data-hydrate) ------------------
    const counterBefore = await page.$eval('#counter-value', (el) => el.textContent.trim()).catch(() => null);
    assert(counterBefore === '0', 'counter initial value is 0',
      `got: ${JSON.stringify(counterBefore)}`);

    await click('#counter-btn');
    await new Promise((r) => setTimeout(r, 200));
    const counterAfter = await page.$eval('#counter-value', (el) => el.textContent.trim()).catch(() => null);
    assert(counterAfter === '1', 'counter increments via @click on explicit data-hydrate island',
      `got: ${JSON.stringify(counterAfter)}`);

    // ------- Test: popup toggle (x-data scope + :class + @click) -----------
    const popupAInitial = await page.$eval('#popup-a', (el) => el.className).catch(() => null);
    assert(popupAInitial && popupAInitial.includes('hidden') && popupAInitial.includes('closed'),
      'popup A initial state is hidden/closed (from :class false branch)',
      `got: ${JSON.stringify(popupAInitial)}`);

    await click('#popup-toggle');
    await new Promise((r) => setTimeout(r, 200));
    const popupAToggled = await page.$eval('#popup-a', (el) => el.className).catch(() => null);
    assert(popupAToggled && popupAToggled.includes('visible') && popupAToggled.includes('open') &&
           !popupAToggled.includes('hidden') && !popupAToggled.includes('closed'),
      'popup A toggles to visible/open (:class diff works correctly)',
      `got: ${JSON.stringify(popupAToggled)}`);

    // Toggle back
    await click('#popup-toggle');
    await new Promise((r) => setTimeout(r, 200));
    const popupAToggledBack = await page.$eval('#popup-a', (el) => el.className).catch(() => null);
    assert(popupAToggledBack && popupAToggledBack.includes('hidden') && popupAToggledBack.includes('closed') &&
           !popupAToggledBack.includes('visible') && !popupAToggledBack.includes('open'),
      'popup A toggles back to hidden/closed',
      `got: ${JSON.stringify(popupAToggledBack)}`);

    // ------- Test: theme switching ------------------------------------------
    const lightInitial = await page.$eval('html', (el) => el.className).catch(() => null);
    await click('#theme-dark');
    await new Promise((r) => setTimeout(r, 200));
    const darkClassOnHtml = await page.$eval('html', (el) => el.className).catch(() => null);
    assert(darkClassOnHtml && darkClassOnHtml.includes('dark'),
      'x-color="dark" click switches <html> to .dark',
      `initial: ${JSON.stringify(lightInitial)}; after: ${JSON.stringify(darkClassOnHtml)}`);

    // The active class on the dark button should update via :class diff
    const darkActive = await page.$eval('#theme-dark', (el) => el.className).catch(() => null);
    assert(darkActive && darkActive.includes('active'),
      'dark theme button gains "active" class from :class diff',
      `got: ${JSON.stringify(darkActive)}`);

    // ------- Test: x-markdown baked content visible ------------------------
    const markdownContent = await page.evaluate(() => {
      const el = document.querySelector('#markdown-container');
      if (!el) return null;
      const h1 = el.querySelector('h1');
      const li = el.querySelectorAll('li');
      return {
        hasH1: !!h1,
        h1Text: h1 ? h1.textContent.trim() : null,
        liCount: li.length,
        opacity: window.getComputedStyle(el).opacity,
      };
    });
    assert(markdownContent && markdownContent.hasH1 && markdownContent.h1Text === 'Test Article',
      'x-markdown baked content visible in prerendered output',
      `got: ${JSON.stringify(markdownContent)}`);
    assert(markdownContent && markdownContent.liCount === 3,
      'x-markdown list items preserved (3 items)',
      `got: ${markdownContent && markdownContent.liCount}`);
    assert(markdownContent && markdownContent.opacity === '1',
      'x-markdown element NOT hidden by plugin on load (prerender idempotency)',
      `got opacity: ${markdownContent && markdownContent.opacity}`);

    // Dynamic x-markdown (e.g. route-keyed article): prerender strips x-markdown
    // AND any leftover `opacity:0` inline style the plugin set before rendering.
    const markdownDynamic = await page.evaluate(() => {
      const el = document.querySelector('#markdown-dynamic');
      if (!el) return null;
      return {
        hasContent: !!el.querySelector('h1'),
        opacity: window.getComputedStyle(el).opacity,
        inlineStyle: el.getAttribute('style') || '',
      };
    });
    assert(markdownDynamic && markdownDynamic.hasContent,
      'dynamic x-markdown baked content is present',
      `got: ${JSON.stringify(markdownDynamic)}`);
    assert(markdownDynamic && markdownDynamic.opacity === '1',
      'dynamic x-markdown element opacity is 1 (opacity:0 inline style stripped)',
      `got: ${JSON.stringify(markdownDynamic)}`);

    // Inline reactive x-markdown: the binding must survive prerendering so the
    // mirror keeps updating when its bound value changes at runtime.
    const markdownReactive = await page.evaluate(async () => {
      const out = document.querySelector('#markdown-reactive-out');
      if (!out) return null;
      const baked = out.textContent.includes('first note');
      const kept = out.hasAttribute('x-markdown');
      document.querySelector('#markdown-reactive-btn').click();
      await new Promise((r) => setTimeout(r, 400));
      return { baked, kept, updated: out.textContent.includes('second note') };
    });
    assert(markdownReactive && markdownReactive.baked,
      'reactive x-markdown content baked in prerendered output',
      JSON.stringify(markdownReactive));
    assert(markdownReactive && markdownReactive.kept && markdownReactive.updated,
      'reactive x-markdown keeps its binding and updates at runtime',
      JSON.stringify(markdownReactive));

    // ------- Test: locale switching -----------------------------------------
    const localeInitial = await page.$eval('#current-locale', (el) => el.textContent.trim()).catch(() => null);
    assert(localeInitial === 'en',
      'initial locale is "en"',
      `got: ${JSON.stringify(localeInitial)}`);

    // ------- Test: pricing x-for with data-hydrate price (loop-variable binding) ---
    // Mirrors Playcom's pricing pattern: x-for over plans, each plan has a
    // <p data-hydrate> with an x-text referencing both the loop variable
    // (`plan`) AND a parent-scope variable (`frequency`).  The render script's
    // loop-binding strip MUST skip these elements, so the x-text survives and
    // Alpine can re-evaluate it when `frequency` toggles at runtime.
    const pricingInitial = await page.evaluate(() => {
      const prices = Array.from(document.querySelectorAll('#plans .plan-price span')).map((el) => el.textContent.trim());
      const planCount = document.querySelectorAll('#plans .plan').length;
      return { prices, planCount };
    });
    // $x-driven x-for: static clones are removed so Alpine re-renders from the
    // template at runtime without duplicates.  The plans appear after Alpine +
    // data plugin loads — verify they exist and toggle correctly.
    assert(pricingInitial.planCount === 2,
      'x-for produced 2 plan clones (Alpine rendered from $x data)',
      `got ${pricingInitial.planCount} plans`);
    assert(JSON.stringify(pricingInitial.prices) === JSON.stringify(['$10', '$30']),
      'plan prices show monthly values ("$10", "$30")',
      `got: ${JSON.stringify(pricingInitial.prices)}`);

    await click('#frequency-yearly');
    await new Promise((r) => setTimeout(r, 250));
    const pricingToggled = await page.evaluate(() => {
      const prices = Array.from(document.querySelectorAll('#plans .plan-price span')).map((el) => el.textContent.trim());
      return { prices };
    });
    assert(JSON.stringify(pricingToggled.prices) === JSON.stringify(['$100', '$300']),
      'clicking yearly toggle updates prices reactively via preserved x-text',
      `got: ${JSON.stringify(pricingToggled.prices)}`);

    // ------- Test: bare-tag <x-*> components didn't get mangled by the marker pass ---
    // Regression test for a critical bug in markPrerenderedManifestComponents:
    // when an `<x-*>` tag had no existing attributes, the spacer logic produced
    // `<x-sidebardata-pre-rendered="1">` (attribute fused into the tag name),
    // breaking the components plugin's ability to find the tag at runtime.
    // We strip HTML comments before testing so example text in comments
    // doesn't false-positive.
    const fixtureHtmlPath = join(FIXTURE_OUT_DIR, 'index.html');
    const fixtureHtml = await readFile(fixtureHtmlPath, 'utf8');
    const fixtureHtmlNoComments = fixtureHtml.replace(/<!--[\s\S]*?-->/g, '');
    assert(!/<x-[a-z][\w-]*data-pre-rendered/i.test(fixtureHtmlNoComments),
      'no <x-*> tag has the marker attribute fused into the tag name',
      'mangled tag detected in prerendered HTML');

    // ------- Unit test: markPrerenderedManifestComponents with bare tags ----
    // The end-to-end fixture above can fail to exercise the bare-tag case
    // because the components plugin pre-processes <x-*> placeholders and
    // adds attributes (data-order, data-component) before the marker pass
    // ever sees them.  To prevent regression of the spacer bug, directly
    // import the helper and assert against synthetic input that genuinely
    // has zero attributes — exactly the production case that mangled
    // <x-sidebar></x-sidebar> into <x-sidebardata-pre-rendered="1">.
    const renderModuleUrl = new URL(
      '../../../../src/scripts/manifest.render.mjs',
      import.meta.url,
    ).href;
    const renderMod = await import(renderModuleUrl);
    const mark = renderMod.markPrerenderedManifestComponents;
    assert(typeof mark === 'function',
      'markPrerenderedManifestComponents is exported for unit testing',
      `got ${typeof mark}`);
    const bareInput = '<x-sidebar></x-sidebar><x-header></x-header>';
    const bareOutput = mark(bareInput);
    assert(/<x-sidebar data-pre-rendered="1">/.test(bareOutput),
      'bare <x-sidebar> gets a SPACE before injected marker attribute',
      `got: ${bareOutput}`);
    assert(/<x-header data-pre-rendered="1">/.test(bareOutput),
      'bare <x-header> gets a SPACE before injected marker attribute',
      `got: ${bareOutput}`);
    assert(!/<x-[a-z][\w-]*data-pre-rendered/i.test(bareOutput),
      'no bare-tag mangling in marker output',
      `got: ${bareOutput}`);
    // Also exercise tags WITH attributes — these should still get the
    // marker injected without doubling spaces or losing existing attrs.
    const attrInput = '<x-route x-route="/" class="page"></x-route>';
    const attrOutput = mark(attrInput);
    assert(/<x-route x-route="\/" class="page" data-pre-rendered="1">/.test(attrOutput),
      'attributed <x-*> tag preserves existing attrs and gets marker',
      `got: ${attrOutput}`);
    // data-hydrate islands must NOT receive the marker — runtime
    // restoration replays the placeholder and the components plugin
    // processes it normally.
    const hydrateInput = '<x-webchat data-hydrate></x-webchat>';
    const hydrateOutput = mark(hydrateInput);
    assert(!/data-pre-rendered/.test(hydrateOutput),
      'data-hydrate islands are NOT given the prerender marker',
      `got: ${hydrateOutput}`);
    // Already-marked tags must be left alone (idempotent).
    const idempotentInput = '<x-foo data-pre-rendered="1"></x-foo>';
    const idempotentOutput = mark(idempotentInput);
    assert(idempotentOutput === idempotentInput,
      'marker pass is idempotent on already-marked tags',
      `got: ${idempotentOutput}`);

    // ------- Test: x-show elements retain baked visibility after hydration ----
    // Regression: hydration contract emitted "style": null for x-show elements,
    // removing display:none and making hidden elements visible (e.g. RTL icons
    // appearing alongside LTR icons — "doubled, second inverted").
    const xshowState = await page.evaluate(() => {
      const visible = document.querySelector('#xshow-visible');
      const hidden = document.querySelector('#xshow-hidden');
      const togglable = document.querySelector('#xshow-togglable');
      const getDisplay = (el) => el ? window.getComputedStyle(el).display : 'MISSING';
      return {
        visibleDisplay: getDisplay(visible),
        hiddenDisplay: getDisplay(hidden),
        togglableDisplay: getDisplay(togglable),
      };
    });
    assert(xshowState.visibleDisplay !== 'none',
      'x-show="true" element is visible after hydration',
      `display: ${xshowState.visibleDisplay}`);
    assert(xshowState.hiddenDisplay === 'none',
      'x-show="false" element stays hidden after hydration (no style:null wipe)',
      `display: ${xshowState.hiddenDisplay}`);
    assert(xshowState.togglableDisplay === 'none',
      'x-show="variable" initially-false element stays hidden after hydration',
      `display: ${xshowState.togglableDisplay}`);

    // Toggle x-show on; Alpine routes the show through x-transition's
    // nextTick, which is requestAnimationFrame whenever visibilityState is
    // 'visible' — in a frameless headless environment that rAF never fires,
    // so the toggle is only assertable when the compositor produces frames
    // (same environment split as the click fallback above).
    if (!framesWork) {
      log.note('skipping x-show toggle assertion (no frames: Alpine defers x-show to rAF)');
    } else {
      await click('#xshow-toggle');
      await page.waitForFunction(
        () => { const el = document.querySelector('#xshow-togglable'); return el && getComputedStyle(el).display !== 'none'; },
        { polling: 50, timeout: 5000 },
      ).catch(() => {});
      const xshowToggled = await page.evaluate(() => {
        const el = document.querySelector('#xshow-togglable');
        return el ? window.getComputedStyle(el).display : 'MISSING';
      });
      assert(xshowToggled !== 'none',
        'x-show toggled element becomes visible after click',
        `display: ${xshowToggled}`);
    }

    // ------- Test: adopted x-if clones are live -----------------------------
    // Regression: reconcilePrerenderClones adopted the baked clone via
    // _x_currentIfEl without initTree/_x_undoIf — bindings dead, and a false
    // expression could never remove it.
    const xifHtml = fixtureHtmlNoComments;
    assert(/id="xif-content"[^>]*data-mnfst-prerender-clone|data-mnfst-prerender-clone[^>]*id="xif-content"/.test(xifHtml),
      'x-if clone is baked and tagged in prerendered output');
    assert(/id="xif-stale"/.test(xifHtml),
      'render-only x-if clone is baked into prerendered output');

    const xifState = () => page.evaluate(() => ({
      contents: document.querySelectorAll('#xif-content').length,
      count: document.querySelector('#xif-count')?.textContent.trim() ?? null,
      inner: document.querySelector('#xif-inner')?.textContent.trim() ?? null,
      inits: window.__xifInits || 0,
      stale: document.querySelectorAll('#xif-stale').length,
    }));
    await page.waitForFunction(() => window.__manifestReady === true, { timeout: 16000, polling: 100 }).catch(() => {});
    const xif0 = await xifState();
    assert(xif0.contents === 1, 'adopted x-if clone is not duplicated at boot', `got ${xif0.contents}`);
    assert(xif0.inner === 'ran' && xif0.inits === 1,
      'x-data/x-init inside adopted x-if clone runs exactly once',
      `got: ${JSON.stringify(xif0)}`);
    await click('#xif-btn');
    await click('#xif-btn');
    await new Promise((r) => setTimeout(r, 200));
    const xif1 = await xifState();
    assert(xif1.count === '2', '@click inside adopted x-if clone increments once per click',
      `got: ${JSON.stringify(xif1)}`);
    await click('#xif-hide');
    await new Promise((r) => setTimeout(r, 200));
    const xif2 = await xifState();
    assert(xif2.contents === 0, 'adopted x-if clone is removed when expression turns false',
      `got: ${JSON.stringify(xif2)}`);
    await click('#xif-show');
    await new Promise((r) => setTimeout(r, 200));
    const xif3 = await xifState();
    assert(xif3.contents === 1 && xif3.count === '2' && xif3.inits === 2,
      'x-if re-renders a fresh live clone after hide/show',
      `got: ${JSON.stringify(xif3)}`);
    assert(xif3.stale === 0, 'x-if false at boot removes the baked clone',
      `got ${xif3.stale}`);
    const xifLate = await page.evaluate(() => ({
      count: document.querySelectorAll('#xif-late').length,
      removed: window.__xifLateRemoved,
    }));
    assert(xifLate.count === 1 && xifLate.removed === 0,
      'x-if briefly false at boot keeps the baked clone (no blank frame)',
      `got: ${JSON.stringify(xifLate)}`);
    const guardErrors = consoleErrors.filter((e) => /page\.next|reading 'next'|reading 'href'|reading 'name'/.test(e));
    assert(guardErrors.length === 0,
      'bindings inside an adopted x-if clone never evaluate while its guard is false',
      guardErrors.slice(0, 2).join(' | '));
    await click('#xif-guard-next');
    await new Promise((r) => setTimeout(r, 200));
    const xifGuard = await page.evaluate(() => ({
      navs: document.querySelectorAll('#xif-guard').length,
      links: document.querySelectorAll('#xif-guard-next').length,
      href: document.querySelector('#xif-guard-next')?.getAttribute('href') ?? null,
      clicks: document.querySelector('#xif-guard-clicks')?.textContent.trim() ?? null,
      removed: window.__xifGuardRemoved,
    }));
    assert(xifGuard.navs === 1 && xifGuard.links === 1 && xifGuard.href === '#next' && xifGuard.clicks === '1' && xifGuard.removed === 0,
      'nested adopted x-if clones bind live once their guards hold',
      `got: ${JSON.stringify(xifGuard)}`);
    assert(/id="xif-defer-btn"/.test(xifHtml), 'x-if clone inside <details> is baked');
    await page.evaluate(() => { document.querySelector('#xif-defer').open = true; });
    await new Promise((r) => setTimeout(r, 300));
    await click('#xif-defer-btn');
    await new Promise((r) => setTimeout(r, 200));
    const xifDefer = await page.evaluate(() => ({
      btns: document.querySelectorAll('#xif-defer-btn').length,
      n: document.querySelector('#xif-defer-n')?.textContent.trim() ?? null,
    }));
    assert(xifDefer.btns === 1 && xifDefer.n === '1',
      'adopted x-if clone inside a deferred subtree binds when it opens',
      `got: ${JSON.stringify(xifDefer)}`);
    const dropErrors = consoleErrors.filter((e) => /reading 'a'/.test(e));
    const xifDrop = await page.evaluate(() => document.querySelectorAll('#xif-drop').length);
    assert(dropErrors.length === 0 && xifDrop === 0,
      'outer guard dropping before ready never evaluates the inner guard, and the clone leaves',
      `errors ${dropErrors.length}, clones ${xifDrop}`);

    // ------- Test: $x-driven x-for keeps template, no duplicate clones --------
    // Regression: x-for templates over $x data were removed by the static-template
    // cleanup, preventing Alpine from re-rendering the list at runtime.  When kept
    // but static clones weren't removed, elements appeared twice.
    const xforDataState = await page.evaluate(() => {
      const container = document.querySelector('#xfor-data-test');
      if (!container) return { error: 'container missing' };
      const template = container.querySelector('template[x-for]');
      const spans = container.querySelectorAll('span.data-plan');
      return {
        hasTemplate: !!template,
        spanCount: spans.length,
        spanTexts: Array.from(spans).map(s => s.textContent.trim()),
      };
    });
    assert(xforDataState.hasTemplate,
      '$x-driven x-for <template> survives in prerendered output',
      `hasTemplate: ${xforDataState.hasTemplate}`);
    assert(xforDataState.spanCount === 2,
      '$x-driven x-for renders exactly 2 plans (no duplicates)',
      `got ${xforDataState.spanCount}: ${JSON.stringify(xforDataState.spanTexts)}`);

    // ------- Test: prerendered HTML has no duplicate SVGs inside icon elements --
    // Regression: when hydration removed display:none from x-show RTL icons,
    // both LTR and RTL icon variants became visible, appearing as duplicated
    // icons with the second horizontally mirrored.
    const fixtureHtmlForIcons = await readFile(join(FIXTURE_OUT_DIR, 'index.html'), 'utf8');
    const iconDuplicates = await page.evaluate(() => {
      const icons = document.querySelectorAll('[x-icon]');
      let duplicates = 0;
      icons.forEach(icon => {
        const svgs = icon.querySelectorAll('svg');
        if (svgs.length > 1) duplicates++;
      });
      return duplicates;
    });
    assert(iconDuplicates === 0,
      'no icon elements contain multiple SVGs (no visual duplication)',
      `found ${iconDuplicates} icons with multiple SVGs`);

    // ------- Test: adopted code group re-binds tabs + copy -------------------
    // The prerender bakes groups already built (data-group-processed); the
    // runtime must re-attach listeners to that adopted markup, or tabs and
    // copy buttons ship dead (the manifestx.dev docs regression).
    const codeGroupState = await page.evaluate(() => {
      const group = document.querySelector('#code-group-test, pre[x-code-group][data-group-processed]');
      if (!group) return { error: 'group missing' };
      const tabs = Array.from(group.querySelectorAll(':scope > header [role="tab"]'));
      const panels = Array.from(group.children).filter(c => c.hasAttribute('name'));
      const visible = () => panels.map(p => p.style.display !== 'none');
      const before = visible();
      if (tabs[1]) tabs[1].click();
      const after = visible();
      return {
        baked: group.dataset.groupProcessed === 'yes',
        tabCount: tabs.length,
        copyBtn: !!group.querySelector(':scope > button.copy'),
        before, after,
        secondSelected: tabs[1] ? tabs[1].getAttribute('aria-selected') === 'true' : false,
      };
    });
    assert(!codeGroupState.error && codeGroupState.baked,
      'code group ships prerendered (data-group-processed baked)',
      JSON.stringify(codeGroupState));
    assert(codeGroupState.tabCount === 2 && codeGroupState.copyBtn,
      'baked code group keeps its tabs and copy button',
      JSON.stringify(codeGroupState));
    assert(JSON.stringify(codeGroupState.before) === '[true,false]'
      && JSON.stringify(codeGroupState.after) === '[false,true]'
      && codeGroupState.secondSelected,
      'clicking the second tab of an ADOPTED code group switches panels (listeners re-bound)',
      `before ${JSON.stringify(codeGroupState.before)} after ${JSON.stringify(codeGroupState.after)}`);

    // ------- Test: hydrate marker cleanup -----------------------------------
    const leftoverIds = await page.$$eval('[data-hydrate-id]', (els) => els.length);
    assert(leftoverIds === 0, 'no data-hydrate-id attributes remain after hydration',
      `found ${leftoverIds} leftover`);

    // ------- Test: static MPA skip (route visibility + head) ---------------
    // Baked output holds only this route's sections and head content; the router must leave both alone
    const routeMutLog = () => {
      window.__routeMuts = [];
      new MutationObserver((list) => {
        for (const r of list) {
          const t = r.target;
          if (t.nodeType === 1 && t.hasAttribute('x-route') && ['x-cloak', 'hidden', 'style'].includes(r.attributeName)) {
            window.__routeMuts.push(`${t.getAttribute('x-route')} ${r.attributeName}`);
          }
        }
      }).observe(document, { attributes: true, subtree: true });
    };
    await page.evaluateOnNewDocument(routeMutLog);
    const mpaState = async () => page.evaluate(() => {
      const vis = window.ManifestRoutingVisibility;
      const probe = document.createElement('div');
      probe.setAttribute('x-route', 'no-such-route');
      const shown = (id) => { const el = document.getElementById(id); return el ? getComputedStyle(el.closest('[x-route]')).display !== 'none' : null; };
      return {
        isMPA: vis ? vis.isPrerenderedStaticMPA() : null,
        unmatchedActive: vis ? vis.isRouteActive(probe) : null,
        home: shown('home-heading'),
        about: shown('about-heading'),
        heads: Array.from(document.head.querySelectorAll('meta[name="fixture-route-head"]')).map((m) => m.content),
        muts: window.__routeMuts || [],
      };
    });
    for (const [path, route] of [['/', 'home'], ['/about/', 'about']]) {
      await page.goto(`http://localhost:${STATIC_PORT}${path}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise((r) => setTimeout(r, 2000));
      // Late route-change must not re-run visibility or head injection either
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('manifest:route-change', { detail: { from: location.pathname, to: '/no-such-route', normalizedPath: 'no-such-route' } })));
      await new Promise((r) => setTimeout(r, 400));
      const s = await mpaState();
      const other = route === 'home' ? 'about' : 'home';
      assert(s.isMPA === true, `${path}: ManifestRoutingVisibility.isPrerenderedStaticMPA() is true`, JSON.stringify(s));
      assert(s.unmatchedActive === true, `${path}: isRouteActive short-circuits true on static MPA`, JSON.stringify(s));
      assert(s[route] === true && s[other] === null, `${path}: only the ${route} section is baked and visible`, JSON.stringify(s));
      assert(s.muts.length === 0, `${path}: router does not toggle x-cloak/hidden/style on baked routes`, JSON.stringify(s.muts));
      assert(JSON.stringify(s.heads) === JSON.stringify([route]), `${path}: route head content baked once, not re-injected or removed`, JSON.stringify(s.heads));
    }

    // ------- Test: no console errors during all of the above ----------------
    if (consoleErrors.length > 0) {
      log.fail(`console errors during test run: ${consoleErrors.length}`);
      consoleErrors.slice(0, 5).forEach((e) => log.note(e));
      failed++;
    } else {
      passed++;
      log.pass('no console errors during test run');
    }

  } finally {
    await browser.close();
  }
}

// ---- incremental rendering tests ---------------------------------------------
const EXTERNAL_PORT = 5101; // fixture's #external-note fetches this origin

// Cross-origin resource with switchable validator behavior: mode 'etag'
// serves an ETag and answers matching If-None-Match with 304; mode
// 'no-validator' serves plain 200s with no validator at all.  /conditional is
// independent of the mode: a fixed validator with Cache-Control: no-cache, so
// the page's own second fetch revalidates and gets a 304 at capture time.
const externalState = { mode: 'etag', etag: 'W/"v1"', body: 'external note v1', lmTick: 0 };
function startExternalServer(port, state) {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/conditional')) {
      res.setHeader('ETag', 'W/"pinned"');
      res.setHeader('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === 'W/"pinned"') { res.statusCode = 304; res.end(); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('conditional body');
      return;
    }
    if (state.mode === 'etag') {
      res.setHeader('ETag', state.etag);
      if (req.headers['if-none-match'] === state.etag) { res.statusCode = 304; res.end(); return; }
    }
    if (state.mode === 'request-time-lm') {
      // The iconify pattern: Last-Modified stamped per request over identical
      // bytes, never a 304.  Monotonic stamps so back-to-back runs differ.
      res.setHeader('Last-Modified', new Date(Date.UTC(2026, 9, 23, 0, 0, state.lmTick++)).toUTCString());
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(state.body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// Telemetry endpoint stand-in: records every request that actually reaches it.
// The fixture's beacons route fires a POST matching a curated telemetry
// pattern and a GET matching render.blockRequests — both must be aborted
// in-browser during prerender, so this server must see ZERO hits from renders.
const TELEMETRY_PORT = 5102;
const telemetryState = { hits: [] };
function startTelemetryServer(port, state) {
  const server = createServer((req, res) => {
    state.hits.push(`${req.method} ${req.url}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.statusCode = 204;
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// Shared cross-origin asset (a stand-in for a framework CDN file every page
// loads) with a fixed validator and no-cache, so without the run cache every
// page revalidates against the server — each request is counted.
const ASSET_PORT = 5103;
const assetState = { hits: [] };
function startAssetServer(port, state) {
  const server = createServer((req, res) => {
    state.hits.push(`${req.method} ${req.url}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url.startsWith('/shared.txt')) {
      // A repeated header: the run cache must replay it as separate values.
      res.setHeader('X-Repeated', ['one', 'two']);
      res.setHeader('ETag', 'W/"shared-v1"');
      res.setHeader('Cache-Control', 'no-cache');
      if (req.headers['if-none-match'] === 'W/"shared-v1"') { res.statusCode = 304; res.end(); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('shared framework asset');
      return;
    }
    res.statusCode = 204;
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
async function hashTree(dir) {
  const out = new Map();
  const walk = async (d, rel) => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(p, r);
      else out.set(r, createHash('sha256').update(await readFile(p)).digest('hex'));
    }
  };
  await walk(dir, '');
  return out;
}

function treeDiff(a, b) {
  const diffs = [];
  for (const [k, v] of a) { if (!b.has(k)) diffs.push(`only in A: ${k}`); else if (b.get(k) !== v) diffs.push(`differs: ${k}`); }
  for (const k of b.keys()) { if (!a.has(k)) diffs.push(`only in B: ${k}`); }
  return diffs;
}

const LEDGER_PATH = join(FIXTURE_DIR, '.mnfst-cache', 'routes.json');
const summaryOf = (out) => {
  const m = out.match(/prerender: skipped (\d+) unchanged, rendered (\d+)/);
  return m ? { skipped: Number(m[1]), rendered: Number(m[2]) } : null;
};

async function runIncrementalTests() {
  log.head('Incremental rendering (on by default)');
  const ledgerPath = LEDGER_PATH;

  // The baseline render above ran with no flag and no config: it recorded.
  assert(existsSync(ledgerPath), 'default run (no flag, no config) writes the route ledger');
  const tree0 = await hashTree(FIXTURE_OUT_DIR);
  const run0 = await runPrerender([], true);
  const r0 = summaryOf(run0.stdout);
  assert(r0 && r0.rendered === 0 && r0.skipped > 0,
    'next plain run skips every Puppeteer route',
    `summary: ${JSON.stringify(r0)}`);
  const diff0 = treeDiff(tree0, await hashTree(FIXTURE_OUT_DIR));
  assert(diff0.length === 0, 'default skip output is byte-identical to the asserted baseline output',
    diff0.slice(0, 5).join(' | '));
  await rm(join(FIXTURE_DIR, '.mnfst-cache'), { recursive: true, force: true });

  const runA = await runPrerender(['--incremental'], true);
  const a = summaryOf(runA.stdout);
  assert(a && a.rendered > 0 && a.skipped === 0,
    'first --incremental run renders every Puppeteer route',
    `summary: ${JSON.stringify(a)}`);
  assert(new RegExp(`rendered ${a?.rendered} \\(${a?.rendered} new\\)`).test(runA.stdout),
    'summary explains first-run renders as new routes',
    runA.stdout.match(/prerender: skipped[^\n]*/)?.[0]);
  assert(existsSync(ledgerPath), 'route ledger written after a successful incremental run');
  const total = a ? a.rendered : 0;
  const treeA = await hashTree(FIXTURE_OUT_DIR);

  const runB = await runPrerender(['--incremental'], true);
  const b = summaryOf(runB.stdout);
  assert(b && b.skipped === total && b.rendered === 0,
    'unchanged second run skips every Puppeteer route',
    `summary: ${JSON.stringify(b)} (expected skipped ${total}, rendered 0)`);
  const treeB = await hashTree(FIXTURE_OUT_DIR);
  const diffAB = treeDiff(treeA, treeB);
  assert(diffAB.length === 0, 'all-skipped run output is byte-identical to the previous run',
    diffAB.slice(0, 5).join(' | '));
  log.note(`wall time: full incremental run ${runA.ms}ms, all-skipped run ${runB.ms}ms`);

  // Data file fetched by exactly one route (the x-if guarded /about markdown)
  await appendFile(join(FIXTURE_DIR, 'data', 'about-extra.md'), '\nTouched once more.\n');
  const runC = await runPrerender(['--incremental'], true);
  const c = summaryOf(runC.stdout);
  assert(c && c.rendered === 1 && c.skipped === total - 1,
    'touched data file re-renders only the route that fetched it',
    `summary: ${JSON.stringify(c)} (expected rendered 1, skipped ${total - 1})`);
  assert(/rendered 1 \(1 changed inputs\)/.test(runC.stdout),
    'summary explains the re-render as changed inputs',
    runC.stdout.match(/prerender: skipped[^\n]*/)?.[0]);
  const aboutHtml = await readFile(join(FIXTURE_OUT_DIR, 'about', 'index.html'), 'utf8');
  assert(aboutHtml.includes('Touched once more.'),
    're-rendered /about carries the touched markdown content');

  // Component fetched by every route
  await appendFile(join(FIXTURE_DIR, 'components', 'header.html'), '\n<!-- header touched -->\n');
  const runD = await runPrerender(['--incremental'], true);
  const d = summaryOf(runD.stdout);
  assert(d && d.rendered === total && d.skipped === 0,
    'touched component mounted by all routes re-renders everything',
    `summary: ${JSON.stringify(d)}`);

  // Cross-origin validator changes: new ETag + body → only /external re-renders
  externalState.etag = 'W/"v2"';
  externalState.body = 'external note v2';
  const runX1 = await runPrerender(['--incremental'], true);
  const x1 = summaryOf(runX1.stdout);
  assert(x1 && x1.rendered === 1 && x1.skipped === total - 1,
    'changed cross-origin ETag re-renders only the route that fetched it',
    `summary: ${JSON.stringify(x1)}`);
  const externalHtml1 = await readFile(join(FIXTURE_OUT_DIR, 'external', 'index.html'), 'utf8');
  assert(externalHtml1.includes('external note v2'),
    're-rendered /external carries the new cross-origin content');

  // Validator disappears: conditional request no longer answers 304 → render;
  // the new response is content-addressed instead (hash of its bytes)
  externalState.mode = 'no-validator';
  externalState.body = 'external note without validator';
  const runX2 = await runPrerender(['--incremental'], true);
  const x2 = summaryOf(runX2.stdout);
  assert(x2 && x2.rendered === 1 && x2.skipped === total - 1,
    'cross-origin response losing its validator re-renders the route',
    `summary: ${JSON.stringify(x2)}`);
  const runX3 = await runPrerender(['--incremental'], true);
  const x3 = summaryOf(runX3.stdout);
  assert(x3 && x3.rendered === 0 && x3.skipped === total,
    'validator-less cross-origin resource skips only while its bytes are identical',
    `summary: ${JSON.stringify(x3)}`);
  // The Appwrite-edit case: data changes with no validator anywhere → render
  externalState.body = 'external note without validator EDITED';
  const runX3b = await runPrerender(['--incremental'], true);
  const x3b = summaryOf(runX3b.stdout);
  assert(x3b && x3b.rendered === 1 && x3b.skipped === total - 1,
    'validator-less cross-origin content change re-renders the route',
    `summary: ${JSON.stringify(x3b)}`);
  const externalHtmlNv = await readFile(join(FIXTURE_OUT_DIR, 'external', 'index.html'), 'utf8');
  assert(externalHtmlNv.includes('external note without validator EDITED'),
    're-rendered /external carries the edited validator-less content');

  // Validator returns: one more render records it, then the route skips again
  externalState.mode = 'etag';
  externalState.etag = 'W/"v3"';
  externalState.body = 'external note v3';
  const runX4 = await runPrerender(['--incremental'], true);
  const x4 = summaryOf(runX4.stdout);
  assert(x4 && x4.rendered === 1 && x4.skipped === total - 1,
    'restored validator renders once to re-record it',
    `summary: ${JSON.stringify(x4)}`);
  const runX5 = await runPrerender(['--incremental'], true);
  const x5 = summaryOf(runX5.stdout);
  assert(x5 && x5.rendered === 0 && x5.skipped === total,
    'unchanged validated cross-origin resource (304) lets the route skip again',
    `summary: ${JSON.stringify(x5)}`);

  // The iconify pattern: Last-Modified stamped with the request time over
  // byte-identical bodies.  The validator never matches again, the bytes
  // never change — the stored content hash must keep the route skipping.
  externalState.mode = 'request-time-lm';
  externalState.body = 'external note lm-stamped';
  const runL1 = await runPrerender(['--incremental'], true);
  const l1 = summaryOf(runL1.stdout);
  assert(l1 && l1.rendered === 1 && l1.skipped === total - 1,
    'switching to a request-time Last-Modified origin renders once (bytes changed)',
    `summary: ${JSON.stringify(l1)}`);
  const lmNoteEntry = async () => JSON.parse(await readFile(LEDGER_PATH, 'utf8'))
    .routes['external']?.externalValidated?.['http://127.0.0.1:5101/note.txt'];
  const lmV1 = await lmNoteEntry();
  assert(lmV1 && lmV1.lastModified && /^[0-9a-f]{64}$/.test(lmV1.contentHash || ''),
    'capture records the request-time validator and the body hash together',
    JSON.stringify(lmV1));
  const runL2 = await runPrerender(['--incremental'], true);
  const l2 = summaryOf(runL2.stdout);
  assert(l2 && l2.rendered === 0 && l2.skipped === total,
    'request-time Last-Modified over identical bytes still SKIPS (byte comparison beats the validator)',
    `summary: ${JSON.stringify(l2)}`);
  const lmV2 = await lmNoteEntry();
  assert(lmV2 && lmV2.lastModified !== lmV1.lastModified && lmV2.contentHash === lmV1.contentHash,
    'carried entry self-heals: validator refreshed to the one observed at revalidation',
    `before ${JSON.stringify(lmV1)} after ${JSON.stringify(lmV2)}`);
  externalState.body = 'external note lm-stamped EDITED';
  const runL3 = await runPrerender(['--incremental'], true);
  const l3 = summaryOf(runL3.stdout);
  assert(l3 && l3.rendered === 1 && l3.skipped === total - 1,
    'byte change behind a request-time validator re-renders the route',
    `summary: ${JSON.stringify(l3)}`);
  const externalHtmlLm = await readFile(join(FIXTURE_OUT_DIR, 'external', 'index.html'), 'utf8');
  assert(externalHtmlLm.includes('external note lm-stamped EDITED'),
    're-rendered /external carries the edited lm-stamped content');

  // Without the flag, with a ledger on disk: the project PARTICIPATES —
  // a plain run skips and refreshes the ledger (the one-render upgrade).
  const runE = await runPrerender([], true);
  const e = summaryOf(runE.stdout);
  assert(e && e.skipped === total && e.rendered === 0,
    'plain run with a ledger present participates and skips everything',
    `summary: ${JSON.stringify(e)}`);

  // Corrupt ledger: full render, exit 0, ledger rebuilt
  await writeFile(ledgerPath, '{definitely not json');
  const runF = await runPrerender(['--incremental'], true);
  const f = summaryOf(runF.stdout);
  assert(f && f.skipped === 0 && f.rendered === total,
    'corrupt ledger falls back to a full render without crashing',
    `summary: ${JSON.stringify(f)}`);
  assert(summaryOf(runF.stdout) !== null && JSON.parse(await readFile(ledgerPath, 'utf8')).routes,
    'ledger rebuilt after the corrupt-ledger run');

  // A skipped route's previous output goes missing → that route renders
  await rm(join(FIXTURE_OUT_DIR, 'about', 'index.html'));
  const runG = await runPrerender(['--incremental'], true);
  const g = summaryOf(runG.stdout);
  assert(g && g.rendered === 1 && g.skipped === total - 1,
    'missing previous output re-renders exactly that route',
    `summary: ${JSON.stringify(g)}`);
  assert(existsSync(join(FIXTURE_OUT_DIR, 'about', 'index.html')),
    'missing output file regenerated');

  // SPA-fallback shadowing: /data/ghost.txt resolved to index.html so far;
  // creating the physical file must re-render the route that requested it.
  await writeFile(join(FIXTURE_DIR, 'data', 'ghost.txt'), 'ghost file now exists');
  const runY = await runPrerender(['--incremental'], true);
  const y = summaryOf(runY.stdout);
  assert(y && y.rendered === 1 && y.skipped === total - 1,
    'new physical file shadowing a prior SPA-fallback resolution re-renders its route',
    `summary: ${JSON.stringify(y)}`);
  const externalHtml2 = await readFile(join(FIXTURE_OUT_DIR, 'external', 'index.html'), 'utf8');
  assert(externalHtml2.includes('ghost file now exists'),
    're-rendered route carries the shadowing file content');
  return total;
}

// ---- recording policy & request blocking --------------------------------------
async function runPolicyAndBlockingTests(total) {
  log.head('Recording policy & request blocking');
  const manifestPath = join(FIXTURE_DIR, 'manifest.json');
  const manifestRaw = await readFile(manifestPath, 'utf8');

  // Change 2: the page's own cross-origin 304 was recorded as a VALIDATED
  // external — the route is in every skip total above, and the ledger proves
  // the validator came from the 304.
  const ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf8'));
  const cond = ledger.routes['conditional'];
  assert(cond && !cond.nonCacheable
    && cond.externalValidated?.['http://127.0.0.1:5101/conditional']?.etag === 'W/"pinned"',
    'cross-origin 304 at capture records a validated external (etag), not non-cacheable',
    JSON.stringify(cond && (cond.reason || cond.externalValidated)));

  // Change 3: the beacons route fired a telemetry POST and a blockRequests GET
  // on every render so far; both were aborted in-browser and stayed invisible
  // to capture, so the route is cacheable and the endpoint saw nothing.
  const beac = ledger.routes['beacons'];
  assert(beac && !beac.nonCacheable,
    'route firing blocked beacons stays cacheable (blocked requests are invisible)',
    JSON.stringify(beac && beac.reason));
  assert(telemetryState.hits.length === 0,
    'telemetry endpoint recorded zero hits across all renders',
    telemetryState.hits.slice(0, 5).join(' | '));

  // The blocked-count line prints once per run that actually blocked something.
  await appendFile(join(FIXTURE_DIR, 'components', 'header.html'), '\n<!-- blocking test touch -->\n');
  const runT = await runPrerender(['--incremental'], true);
  const t = summaryOf(runT.stdout);
  assert(t && t.rendered === total && t.skipped === 0,
    'touched component re-renders everything (beacons fire and are blocked)',
    `summary: ${JSON.stringify(t)}`);
  const blockedLine = runT.stdout.match(/prerender: blocked (\d+) telemetry requests \(render\.blockTelemetry: false to allow\)/);
  assert(blockedLine && Number(blockedLine[1]) >= 1,
    'run prints the blocked-telemetry count once with the opt-out hint',
    runT.stdout.split('\n').filter((l) => l.includes('blocked')).join(' | ') || '(no blocked line)');
  assert(telemetryState.hits.length === 0,
    'telemetry endpoint still at zero hits after a full re-render',
    telemetryState.hits.slice(0, 5).join(' | '));

  // Default policy: config false is fully off; with no config every run
  // records, --no-incremental renders everything but still records, and the
  // next plain run skips.
  log.head('Default policy (--no-incremental still records; config false is off)');
  await rm(join(FIXTURE_DIR, '.mnfst-cache'), { recursive: true, force: true });
  const mf = JSON.parse(manifestRaw);
  mf.render.incremental = false;
  await writeFile(manifestPath, JSON.stringify(mf, null, 2));
  const runOff = await runPrerender([], true);
  assert(!existsSync(LEDGER_PATH) && !existsSync(join(FIXTURE_DIR, '.mnfst-cache', 'render-html')),
    'config incremental:false writes no ledger and no snapshots');
  delete mf.render.incremental;
  await writeFile(manifestPath, JSON.stringify(mf, null, 2));
  const runH = await runPrerender(['--no-incremental'], true);
  assert(!/\[skip\]/.test(runH.stdout) && !/skipped \d+ unchanged/.test(runH.stdout),
    '--no-incremental run skips nothing');
  assert(new RegExp(`prerender: rendered ${total} \\(ledger refreshed, skipping off\\)`).test(runH.stdout),
    'summary says the ledger was refreshed with skipping off',
    runH.stdout.match(/prerender: rendered[^\n]*/)?.[0]);
  assert(existsSync(LEDGER_PATH), '--no-incremental run writes the ledger');
  log.note(`wall time: incremental-off run ${runOff.ms}ms, recording-only (--no-incremental) run ${runH.ms}ms`);
  const runI = await runPrerender([], true);
  const i = summaryOf(runI.stdout);
  assert(i && i.skipped === total && i.rendered === 0,
    'next plain run skips everything',
    `summary: ${JSON.stringify(i)}`);

  // Salt pin: the blocking regime is part of the signature — entries rendered
  // under different blocking must never skip.
  mf.render.blockRequests = ['salt-pin-never-matches'];
  await writeFile(manifestPath, JSON.stringify(mf, null, 2));
  const runS = await runPrerender(['--incremental'], true);
  const s = summaryOf(runS.stdout);
  assert(s && s.rendered === total && s.skipped === 0,
    'changed blockRequests forces a full render (blocking regime is in the signature)',
    `summary: ${JSON.stringify(s)}`);
  delete mf.render.blockRequests;

  // Explicit config false: fully off — no capture, no recording, no skipping,
  // even with a valid ledger present.
  const ledgerBytes = await readFile(LEDGER_PATH, 'utf8');
  mf.render.incremental = false;
  await writeFile(manifestPath, JSON.stringify(mf, null, 2));
  const runJ = await runPrerender([], true);
  assert(!/skipped \d+ unchanged|ledger refreshed|\[skip\]/.test(runJ.stdout),
    'config incremental:false prints no incremental output despite the ledger');
  assert((await readFile(LEDGER_PATH, 'utf8')) === ledgerBytes,
    'config incremental:false leaves the ledger untouched');

  await writeFile(manifestPath, manifestRaw);
}

// ---- run cache & non-cacheable causes ------------------------------------------
const sharedAssetHits = () => assetState.hits.filter((h) => h.includes('/shared.txt')).length;
const pagesRendered = (out) => (out.match(/^\s*\[ \d+\/\d+ \]/gm) || []).length;

async function runRunCacheTests() {
  log.head('Run-scoped cross-origin response cache');

  // Fresh ledger so every route renders; the run cache is ON by default.
  await rm(join(FIXTURE_DIR, '.mnfst-cache'), { recursive: true, force: true });
  assetState.hits.length = 0;
  const runOn = await runPrerender(['--incremental'], true);
  const pagesOn = pagesRendered(runOn.stdout);
  const hitsOn = sharedAssetHits();
  assert(pagesOn > 1 && hitsOn === 1,
    `shared cross-origin asset hit the server EXACTLY ONCE for ${pagesOn} pages (run cache on)`,
    `hits ${hitsOn}: ${assetState.hits.slice(0, 8).join(' | ')}`);
  const routeFiles = [...(await hashTree(FIXTURE_OUT_DIR)).keys()].filter((k) => k.endsWith('index.html'));
  const missingShared = [];
  for (const f of routeFiles) {
    if (!(await readFile(join(FIXTURE_OUT_DIR, f), 'utf8')).includes('shared framework asset')) missingShared.push(f);
  }
  assert(routeFiles.length > 1 && missingShared.length === 0,
    `every page (${routeFiles.length}) bakes the shared asset, cache-served ones included (repeated response header)`,
    `missing in: ${missingShared.slice(0, 6).join(', ')}`);
  const cacheLine = runOn.stdout.match(/prerender: run cache served (\d+) cross-origin requests \((\d+) unique\)/);
  assert(cacheLine && Number(cacheLine[1]) >= pagesOn - 1 && Number(cacheLine[2]) >= 1,
    'summary reports the run-cache served count',
    runOn.stdout.split('\n').filter((l) => l.includes('run cache')).join(' | ') || '(no run-cache line)');

  // Served and fetched responses look identical to capture: every route
  // records the SAME validator for the shared asset.
  const ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf8'));
  const sharedUrl = `http://127.0.0.1:${ASSET_PORT}/shared.txt`;
  const withShared = Object.entries(ledger.routes)
    .filter(([, e]) => e.externalValidated && e.externalValidated[sharedUrl]);
  assert(withShared.length > 1
    && withShared.every(([, e]) => e.externalValidated[sharedUrl].etag === 'W/"shared-v1"'),
    `every route (${withShared.length}) records the same shared-asset validator, served or fetched`,
    JSON.stringify(withShared.slice(0, 3).map(([k, e]) => [k || '/', e.externalValidated[sharedUrl]])));

  // Off switch: every page fetches for itself.
  await appendFile(join(FIXTURE_DIR, 'components', 'header.html'), '\n<!-- run-cache off touch -->\n');
  assetState.hits.length = 0;
  const runOff = await runPrerender(['--incremental', '--no-run-cache'], true);
  const pagesOff = pagesRendered(runOff.stdout);
  const hitsOff = sharedAssetHits();
  assert(pagesOff > 1 && hitsOff === pagesOff,
    `--no-run-cache: the shared asset is fetched once per page (${pagesOff} hits)`,
    `hits ${hitsOff}, pages ${pagesOff}`);
  assert(!/run cache served/.test(runOff.stdout),
    '--no-run-cache prints no run-cache summary');
  log.note(`shared-asset requests: ${hitsOn} with run cache vs ${hitsOff} without (${pagesOff} pages)`);
  log.note(`wall time: run-cache run ${runOn.ms}ms, no-run-cache run ${runOff.ms}ms`);
}

async function runCausesTests() {
  log.head('All non-cacheable causes, not just the first');
  const indexPath = join(FIXTURE_DIR, 'index.html');
  const indexRaw = await readFile(indexPath, 'utf8');
  // Route with TWO distinct non-cacheable causes: a non-GET POST and a failed
  // request (nothing listens on 5109) — both must land in the ledger entry
  // and the end-of-run causes summary.
  const causesSection = `
  <section x-route="causes">
    <h1 id="causes-heading">Causes</h1>
    <template x-if="location.pathname.includes('causes')">
      <div id="causes-fire" x-data x-init="
        fetch('http://127.0.0.1:${ASSET_PORT}/cause-post', { method: 'POST', body: 'x' }).catch(() => {});
        fetch('http://127.0.0.1:5109/down').catch(() => {});
      "></div>
    </template>
  </section>
  <section x-route="beacons"`;
  await writeFile(indexPath, indexRaw.replace('  <section x-route="beacons"', causesSection));
  try {
    const run = await runPrerender(['--incremental'], true);
    const ledger = JSON.parse(await readFile(LEDGER_PATH, 'utf8'));
    const entry = ledger.routes['causes'];
    // The POST may also surface follow-on causes (failed/unreadable as the
    // page closes); both INTENDED causes must be present and distinct.
    const wanted = [
      `non-GET POST http://127.0.0.1:${ASSET_PORT}/cause-post`,
      'request failed: http://127.0.0.1:5109/down',
    ];
    assert(entry && entry.nonCacheable === true && Array.isArray(entry.reasons)
      && entry.reasons.length >= 2
      && wanted.every((w) => entry.reasons.includes(w)),
      'ledger entry carries BOTH distinct causes in entry.reasons',
      JSON.stringify(entry));
    assert(entry && entry.reason === entry.reasons?.[0],
      'entry.reason stays the first cause (back-compat)',
      JSON.stringify(entry && { reason: entry.reason, first: entry.reasons?.[0] }));
    const summaryIdx = run.stdout.indexOf('prerender: non-cacheable causes');
    assert(summaryIdx !== -1, 'run prints the non-cacheable causes summary');
    const tail = run.stdout.slice(summaryIdx);
    assert(/1× non-GET POST 127\.0\.0\.1:5103\/cause-post/.test(tail),
      'summary aggregates the non-GET cause with host+path visible',
      tail.split('\n').slice(0, 5).join(' | '));
    assert(/1× request failed: 127\.0\.0\.1:5109\/down/.test(tail),
      'summary aggregates the failed-request cause too',
      tail.split('\n').slice(0, 5).join(' | '));
  } finally {
    await writeFile(indexPath, indexRaw);
  }
}

// ---- readiness: report ready as soon as the page is settled -------------------
const READY_PORT = 5104;
const readyPages = {
  // Router fires before goto() resolves; the loader booted without the data plugin.
  '/routed-early': `<!DOCTYPE html><html lang="en"><head><title>Early</title><script>
    window.ManifestRouting = {};
    window.dispatchEvent(new CustomEvent('manifest:routing-ready'));
    window.__manifestReadyCoordinator = true;
    document.addEventListener('DOMContentLoaded', () => document.dispatchEvent(new CustomEvent('alpine:initialized')));
  </script></head><body><main><h1>Early</h1><p>Routed before navigation resolved.</p></main></body></html>`,
  // Variant utilities live inside @layer/@media; one variant no compile resolves.
  '/variants': `<!DOCTYPE html><html><head><style>
    @layer utilities { @media (min-width: 1px) { .md\\:flex { display: flex } } }
  </style></head><body><div class="md:flex">a</div><div class="nope:thing">b</div></body></html>`,
};
const ROUTED = `<script>
    window.ManifestRouting = {};
    window.dispatchEvent(new CustomEvent('manifest:routing-ready'));
    window.__manifestReadyCoordinator = true;
  </script>`;
const NOISE = (region, hue) => `(() => { const c = document.getElementById('${region}'); const x = c.getContext('2d');
    const d = x.createImageData(c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) { const v = 128 + Math.random() * 127;
      d.data[i] = ${hue === 'red' ? 'v' : '0'}; d.data[i + 1] = 0; d.data[i + 2] = ${hue === 'red' ? '0' : 'v'}; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0); })();`;
Object.assign(readyPages, {
  // Quiet widget: lands 4s after load with no network or DOM activity before it.
  '/late-quiet': `<!DOCTYPE html><html><head>${ROUTED}</head><body><main><h1>Late</h1><p id="late"></p></main>
    <script>setTimeout(() => { document.getElementById('late').textContent = 'late widget'; }, 4000);</script></body></html>`,
  // No Alpine and no Manifest script: nothing will ever boot.
  '/plain': `<!DOCTYPE html><html><head><title>Plain</title></head><body><main><h1>Plain</h1></main></body></html>`,
  // Scrolls itself to the bottom, and back down once more after the renderer scrolls up.
  '/scrolls-back': `<!DOCTYPE html><html><head><style>body{margin:0}canvas{display:block}</style></head><body>
    <canvas id="top" width="1200" height="700"></canvas><canvas id="bottom" width="1200" height="3000"></canvas>
    <script>${NOISE('top', 'red')}${NOISE('bottom', 'blue')}
      scrollTo(0, 2000);
      let again = true;
      addEventListener('scroll', () => { if (again && scrollY === 0) { again = false; setTimeout(() => scrollTo(0, 2000), 0); } });
    </script></body></html>`,
});
function startReadyServer(port) {
  const server = createServer((req, res) => {
    const body = readyPages[new URL(req.url, 'http://x').pathname];
    if (!body) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function runReadinessTests() {
  log.head('Readiness: settled pages are reported ready without fallback timeouts');
  const pageMod = await import(join(REPO_SRC_DIR, 'scripts', 'manifest.render.page.mjs'));
  const server = await startReadyServer(READY_PORT);
  // Launched like the renderer: full puppeteer resolves chrome-headless-shell
  // (new headless can hang captureScreenshot on macOS).
  const browser = await require('puppeteer').launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
  });
  const base = `http://127.0.0.1:${READY_PORT}`;
  try {
    const page = await browser.newPage();
    const t0 = Date.now();
    const { html } = await pageMod.renderRouteDom(page, {
      url: `${base}/routed-early`, pathSeg: 'routed-early', is404: false, currentLocale: 'en', locales: [],
      timeout: 30000, navTimeoutMs: 30000, displayPath: '/routed-early', baseUrl: base, liveUrl: base,
      pipelineTimeout: 10000, waitAfterIdle: 0,
      seo: { ...pageMod.seoConfigFromManifest({}), imageSnapshots: false },
      renderedPaths: ['routed-early'], localeSubstitution: false, onLocaleDependentContent: () => {},
      ogSnapshot: null, onDebug: null,
    });
    const ms = Date.now() - t0;
    await page.close();
    // Fallbacks were 3s (routing) + 10s (render-ready); the real work is ~2s.
    assert(html.includes('Routed before navigation resolved.') && ms < 5000,
      `early routing-ready + no data plugin: page ready in ${ms}ms (no 3s/10s fallbacks)`);

    const vpage = await browser.newPage();
    await vpage.goto(`${base}/variants`, { waitUntil: 'load' });
    const v0 = Date.now();
    await pageMod.waitForVisualSettle(vpage);
    const vms = Date.now() - v0;
    await vpage.close();
    // The cap is 8s: nested rules count as resolved, an unresolvable variant
    // stops holding after its grace window.
    assert(vms < 3000, `visual settle sees @layer/@media utilities and drops unresolvable variants (${vms}ms)`);

    const renderAt = async (path, over = {}) => {
      const p = await browser.newPage();
      const stages = {};
      try {
        const out = await pageMod.renderRouteDom(p, {
          url: `${base}${path}`, pathSeg: path.slice(1), is404: false, currentLocale: 'en', locales: [],
          timeout: 30000, navTimeoutMs: 30000, displayPath: path, baseUrl: base, liveUrl: base,
          pipelineTimeout: 10000, waitAfterIdle: 0,
          seo: { ...pageMod.seoConfigFromManifest({}), imageSnapshots: false },
          renderedPaths: [path.slice(1)], localeSubstitution: false, onLocaleDependentContent: () => {},
          ogSnapshot: null, onDebug: null, onTiming: (row) => Object.assign(stages, row.stages),
          ...over,
        });
        return { ...out, stages };
      } finally { await p.close(); }
    };

    const late = await renderAt('/late-quiet', { waitAfterIdle: 4500 });
    assert(late.html.includes('late widget'), 'render.waitAfterIdle holds the snapshot for late, quiet content');

    const plain = await renderAt('/plain');
    assert(plain.stages.boot < 500, `a page that never boots Alpine skips the boot wait (${plain.stages.boot}ms)`);

    // og: the card is the top of the document even when the page scrolls itself.
    const renderMod = await import(join(REPO_SRC_DIR, 'scripts', 'manifest.render.mjs'));
    const ogOut = await mkdtemp(join(tmpdir(), 'mnfst-og-'));
    const spage = await browser.newPage();
    await spage.setViewport({ width: 1200, height: 800 });
    await spage.goto(`${base}/scrolls-back`, { waitUntil: 'load' });
    const url = await renderMod.takeOgSnapshot(spage, ogOut, 'scrolls-back', 'sig', null);
    await spage.close();
    let top = null;
    if (url) {
      const b64 = (await readFile(join(ogOut, url.replace(/^\//, '')))).toString('base64');
      const probe = await browser.newPage();
      top = await probe.evaluate(async (src) => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        let r = 0, b = 0;
        for (let i = 0; i < d.length; i += 4 * 97) { r += d[i]; b += d[i + 2]; }
        return r > b ? 'top' : 'bottom';
      }, `data:image/png;base64,${b64}`);
      await probe.close();
    }
    await rm(ogOut, { recursive: true, force: true });
    assert(top === 'top', `og snapshot shows the top of a page that scrolls itself (${top || 'no image'})`);
  } finally {
    await browser.close();
    server.close();
  }
}

// ---- main -------------------------------------------------------------------
async function main() {
  await prepFixture();

  log.head(`Starting dev server on ${DEV_PORT}`);
  const devServer = await startStaticServer(FIXTURE_DIR, DEV_PORT);
  log.note(`dev server up`);

  // Cross-origin validator server, up for the whole harness so every render
  // (baseline included) sees the same external resource.
  const externalServer = await startExternalServer(EXTERNAL_PORT, externalState);
  log.note(`external validator server up on ${EXTERNAL_PORT}`);
  const telemetryServer = await startTelemetryServer(TELEMETRY_PORT, telemetryState);
  log.note(`telemetry endpoint server up on ${TELEMETRY_PORT}`);
  const assetServer = await startAssetServer(ASSET_PORT, assetState);
  log.note(`shared-asset server up on ${ASSET_PORT}`);

  try {
    await runPrerender();
  } finally {
    devServer.close();
    log.note('dev server stopped');
  }

  log.head(`Starting static file server on ${STATIC_PORT} for prerendered output`);
  const staticServer = await startStaticServer(FIXTURE_OUT_DIR, STATIC_PORT);
  log.note('static server up');

  try {
    await runAssertions();
  } finally {
    staticServer.close();
    log.note('static server stopped');
  }

  await runReadinessTests();

  try {
    const total = await runIncrementalTests();
    await runPolicyAndBlockingTests(total);
    await runRunCacheTests();
    await runCausesTests();
  } finally {
    externalServer.close();
    telemetryServer.close();
    assetServer.close();
    log.note('external validator + telemetry + shared-asset servers stopped');
  }

  log.head(`Results: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (e) {
  log.fail(e.message || String(e));
  if (e.stack) log.note(e.stack);
} finally {
  await rm(WORK_DIR, { recursive: true, force: true });
}
process.exit(exitCode);
