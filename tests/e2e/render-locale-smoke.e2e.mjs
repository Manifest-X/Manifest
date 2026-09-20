// End-to-end renderer smoke: locale-substitution defects (client-diagnosed,
// see BUILD-STATE render-locale ticket). Runs the REAL mnfst-render binary
// (packages/render — run `npm run build` first so it's in sync with src/)
// over a 2-locale fixture that exercises:
//  1. a content-fetching directive (x-markdown's real-world shape: an
//     expression resolving to a per-locale URL, fetched at runtime) whose
//     fetched path is locale-parameterized — must be Puppeteer-rendered per
//     locale, not substituted (else the es page ships the English body baked
//     at Puppeteer-render time). Uses x-init+fetch rather than x-markdown
//     itself to avoid an unrelated pre-existing bug in the markdown plugin.
//  2. an ARRAY-rooted per-locale data source (articles.<locale>.yaml) feeding
//     a static link's text — must still produce substitution pairs. Lives on
//     its own route (not site root) since the root path is never a
//     substitution candidate (it's always Puppeteer-rendered directly).
//  3. prerender.localeSubstitutionExcludePaths — an excluded route must be
//     Puppeteer-rendered per locale (verified via a distinct per-locale
//     marker that substitution could never produce correctly).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'render-locale-smoke-'));

// Local plugin files (built via `npm run build`) instead of CDN "latest" —
// hermetic, and avoids depending on published-package state. Alpine itself
// still comes from CDN (same trade-off the existing packages/render/test/e2e
// fixture makes) since there's no free local URL to hand it without a fixed
// port.
mkdirSync(join(dir, 'lib'), { recursive: true });
for (const f of ['manifest.js', 'manifest.router.js', 'manifest.localization.js']) {
  copyFileSync(join(repo, 'lib', f), join(dir, 'lib', f));
}

writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
  name: 'locale-smoke',
  data: { articles: { en: '/data/articles.en.yaml', es: '/data/articles.es.yaml' } },
  prerender: { wait: 15000, localeSubstitutionExcludePaths: ['excluded/*'] },
}));

mkdirSync(join(dir, 'data'), { recursive: true });
writeFileSync(join(dir, 'data', 'articles.en.yaml'), '- slug: hello\n  title: Hello\n');
writeFileSync(join(dir, 'data', 'articles.es.yaml'), '- slug: hello\n  title: Hola\n');

mkdirSync(join(dir, 'content', 'en'), { recursive: true });
mkdirSync(join(dir, 'content', 'es'), { recursive: true });
writeFileSync(join(dir, 'content', 'en', 'hello.md'), '# Hello World\n\nEnglish body.\n');
writeFileSync(join(dir, 'content', 'es', 'hello.md'), '# Hola Mundo\n\nCuerpo en espanol.\n');

writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>locale-smoke</title>
<script src="/lib/manifest.js" data-plugin-base="/lib" data-plugins="router,localization"></script></head>
<body><main x-data>
<div x-route="links">
  <a href="/articles/hello">Hello</a>
</div>
<div x-route="articles/*">
  <!-- The client's exact shape: x-markdown resolving a per-locale URL at
       runtime. The fetch-hook classification must send every locale variant
       of this route to Puppeteer instead of substitution. -->
  <div id="article-body" x-markdown="'/content/' + $locale.current + '/hello.md'"></div>
</div>
<div x-route="excluded/page">
  <p id="excluded-marker" x-text="'locale:' + $locale.current"></p>
</div>
</main></body></html>`);

const r = spawnSync('node', [join(repo, 'packages', 'render', 'bin', 'mnfst-render.js')], {
  cwd: dir, encoding: 'utf8', timeout: 180_000,
});
const out = (r.stdout || '') + (r.stderr || '');

function read(rel) {
  const p = join(dir, 'website', rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

const failures = [];
function check(label, cond) { if (!cond) failures.push(label); }

check('render exited 0', r.status === 0);
check('no ReferenceError/TypeError', !/ReferenceError|TypeError/.test(out));

const esArticle = read('es/articles/hello/index.html');
check('es/articles/hello exists', !!esArticle);
// Defect 1 fail-before: substitution shipped the English body baked at
// Puppeteer-render time (base is locale-neutral); fix classifies this route
// as locale-dependent (fetched .md path embeds the locale) and Puppeteer-
// renders each locale directly.
check('es article body is Spanish, not English', !!esArticle && esArticle.includes('Hola Mundo') && !esArticle.includes('Hello World'));

const esLinks = read('es/links/index.html');
check('es/links exists', !!esLinks);
// Defect 2 fail-before: array-rooted articles.<locale>.yaml produced 0
// substitution pairs (deepMerge bailed on a root array), so the link stayed English.
check('es link text translated via array-sourced substitution pairs', !!esLinks && esLinks.includes('>Hola<') && !esLinks.includes('>Hello<'));

const esExcluded = read('es/excluded/page/index.html');
check('es/excluded/page exists', !!esExcluded);
// Defect 3 fail-before: without localeSubstitutionExcludePaths wired to config,
// this route would be substituted like any other, baking the DEFAULT locale's
// marker ("locale:en") into the es page instead of a real per-locale render.
check('excluded route rendered per-locale (marker reflects es, not en)', !!esExcluded && esExcluded.includes('locale:es') && !esExcluded.includes('locale:en'));

if (failures.length) {
  console.error('RENDER LOCALE SMOKE FAILED —', failures.join(' | '));
  console.error(out.split('\n').slice(-40).join('\n'));
  process.exit(1);
}
console.log('RENDER LOCALE SMOKE PASS');
rmSync(dir, { recursive: true, force: true });
