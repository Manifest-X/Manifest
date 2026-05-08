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
import { cp, rm, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const FIXTURE_DIR = join(__dirname, 'fixture');
const FIXTURE_OUT_DIR = join(FIXTURE_DIR, '.out');
const SRC_SCRIPTS_DIR = join(__dirname, '..', '..', '..', '..', 'src', 'scripts');
const SRC_STYLES_DIR = join(__dirname, '..', '..', '..', '..', 'src', 'styles');
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
async function prepFixture() {
  log.head('Preparing fixture');

  // Copy the local built Manifest loader + plugins into fixture/scripts.
  // We want to test the exact local source, not a published version.
  const fixtureScripts = join(FIXTURE_DIR, 'scripts');
  if (existsSync(fixtureScripts)) await rm(fixtureScripts, { recursive: true, force: true });
  await mkdir(fixtureScripts, { recursive: true });

  const scriptFiles = await readdir(SRC_SCRIPTS_DIR, { withFileTypes: true });
  for (const f of scriptFiles) {
    if (f.isFile() && f.name.endsWith('.js')) {
      await cp(join(SRC_SCRIPTS_DIR, f.name), join(fixtureScripts, f.name));
    }
  }
  // Components processor lives in a subdir; we need the monolith build though,
  // which is what manifest.components.js is.  The monolith is produced by
  // `npm run build` and copied over manifest.components.js.  If the monolith
  // hasn't been built yet, the individual pieces won't work.  Try to copy
  // from /lib as fallback.
  const libDir = join(__dirname, '..', '..', '..', '..', 'lib');
  if (existsSync(libDir)) {
    const libFiles = await readdir(libDir, { withFileTypes: true });
    for (const f of libFiles) {
      if (f.isFile() && f.name.endsWith('.js')) {
        await cp(join(libDir, f.name), join(fixtureScripts, f.name));
      }
    }
  }

  // Also copy styles so <link> tags resolve (even though the fixture doesn't
  // reference any — prevents 404s if something does).
  const fixtureStyles = join(FIXTURE_DIR, 'styles');
  if (existsSync(fixtureStyles)) await rm(fixtureStyles, { recursive: true, force: true });
  await mkdir(fixtureStyles, { recursive: true });

  if (existsSync(FIXTURE_OUT_DIR)) {
    await rm(FIXTURE_OUT_DIR, { recursive: true, force: true });
  }

  log.note('fixture prepared');
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
async function runPrerender() {
  log.head('Running prerender');
  // Always run the SOURCE render script (src/scripts/manifest.render.mjs),
  // not the synced copy in packages/render/.  The sync script is separate
  // and may be stale.
  const sourceRenderScript = join(__dirname, '..', '..', '..', '..', 'src', 'scripts', 'manifest.render.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn('node', [sourceRenderScript, '--root', FIXTURE_DIR], {
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
        // Show all relevant prerender output for debugging.
        const lines = stdout.split('\n').filter((l) =>
          l.startsWith('prerender:') || l.includes('total time') || l.includes('hydrate')
        );
        lines.forEach((l) => log.note(l.trim()));
        resolve();
      }
    });
  });
}

// ---- Puppeteer assertions ---------------------------------------------------
async function runAssertions() {
  log.head('Running browser assertions');
  const puppeteer = require('puppeteer-core');

  // Find a Chrome binary
  const chromeCandidates = [
    '/Users/andrewmatlock/.cache/puppeteer/chrome-headless-shell/mac-131.0.6778.204/chrome-headless-shell-mac-x64/chrome-headless-shell',
    process.env.PUPPETEER_EXECUTABLE_PATH,
  ].filter(Boolean);
  let chromePath = null;
  for (const p of chromeCandidates) {
    if (existsSync(p)) { chromePath = p; break; }
  }
  if (!chromePath) {
    throw new Error('No Chrome binary found.  Set PUPPETEER_EXECUTABLE_PATH or install chrome-headless-shell via `npx puppeteer browsers install chrome-headless-shell`.');
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
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

    await page.goto(`http://localhost:${STATIC_PORT}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Give Alpine + plugins a beat to settle
    await new Promise((r) => setTimeout(r, 2000));

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

    await page.click('#counter-btn');
    await new Promise((r) => setTimeout(r, 200));
    const counterAfter = await page.$eval('#counter-value', (el) => el.textContent.trim()).catch(() => null);
    assert(counterAfter === '1', 'counter increments via @click on explicit data-hydrate island',
      `got: ${JSON.stringify(counterAfter)}`);

    // ------- Test: popup toggle (x-data scope + :class + @click) -----------
    const popupAInitial = await page.$eval('#popup-a', (el) => el.className).catch(() => null);
    assert(popupAInitial && popupAInitial.includes('hidden') && popupAInitial.includes('closed'),
      'popup A initial state is hidden/closed (from :class false branch)',
      `got: ${JSON.stringify(popupAInitial)}`);

    await page.click('#popup-toggle');
    await new Promise((r) => setTimeout(r, 200));
    const popupAToggled = await page.$eval('#popup-a', (el) => el.className).catch(() => null);
    assert(popupAToggled && popupAToggled.includes('visible') && popupAToggled.includes('open') &&
           !popupAToggled.includes('hidden') && !popupAToggled.includes('closed'),
      'popup A toggles to visible/open (:class diff works correctly)',
      `got: ${JSON.stringify(popupAToggled)}`);

    // Toggle back
    await page.click('#popup-toggle');
    await new Promise((r) => setTimeout(r, 200));
    const popupAToggledBack = await page.$eval('#popup-a', (el) => el.className).catch(() => null);
    assert(popupAToggledBack && popupAToggledBack.includes('hidden') && popupAToggledBack.includes('closed') &&
           !popupAToggledBack.includes('visible') && !popupAToggledBack.includes('open'),
      'popup A toggles back to hidden/closed',
      `got: ${JSON.stringify(popupAToggledBack)}`);

    // ------- Test: theme switching ------------------------------------------
    const lightInitial = await page.$eval('html', (el) => el.className).catch(() => null);
    await page.click('#theme-dark');
    await new Promise((r) => setTimeout(r, 200));
    const darkClassOnHtml = await page.$eval('html', (el) => el.className).catch(() => null);
    assert(darkClassOnHtml && darkClassOnHtml.includes('dark'),
      'x-colors="dark" click switches <html> to .dark',
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

    await page.click('#frequency-yearly');
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

    // Toggle the x-show element on and verify it becomes visible
    await page.click('#xshow-toggle');
    await new Promise((r) => setTimeout(r, 250));
    const xshowToggled = await page.evaluate(() => {
      const el = document.querySelector('#xshow-togglable');
      return el ? window.getComputedStyle(el).display : 'MISSING';
    });
    assert(xshowToggled !== 'none',
      'x-show toggled element becomes visible after click',
      `display: ${xshowToggled}`);

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

    // ------- Test: hydrate marker cleanup -----------------------------------
    const leftoverIds = await page.$$eval('[data-hydrate-id]', (els) => els.length);
    assert(leftoverIds === 0, 'no data-hydrate-id attributes remain after hydration',
      `found ${leftoverIds} leftover`);

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

// ---- main -------------------------------------------------------------------
async function main() {
  await prepFixture();

  log.head(`Starting dev server on ${DEV_PORT}`);
  const devServer = await startStaticServer(FIXTURE_DIR, DEV_PORT);
  log.note(`dev server up`);

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

  log.head(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  log.fail(e.message || String(e));
  if (e.stack) log.note(e.stack);
  process.exit(1);
});
