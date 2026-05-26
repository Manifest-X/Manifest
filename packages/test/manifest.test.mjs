// mnfst-test: project linter for Manifest.
//
// Walks a Manifest project and reports issues across several categories:
// manifest.json integrity, component tag references, data-source references,
// route consistency, PWA completeness, locale parity, plus optional runtime
// checks (console errors, a11y, dead links) when puppeteer is available.
//
// Designed for human-readable terminal output by default and machine-readable
// JSON via --json so AI agents can validate their own generated projects.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, basename, extname, isAbsolute, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function main(argv) {
    const opts = parseArgs(argv);

    if (opts.help) {
        printHelp();
        return 0;
    }

    const cwd = process.cwd();
    const root = resolve(cwd, opts.root);
    const manifestPath = resolve(root, opts.manifest);

    if (!existsSync(manifestPath)) {
        printErr(`manifest.json not found at ${manifestPath}`);
        return 2;
    }

    let manifest;
    try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        printErr(`failed to parse ${manifestPath}: ${e.message}`);
        return 2;
    }

    const project = await collectProject(root, manifest, opts);
    const reporter = new Reporter({ json: opts.json, quiet: opts.quiet });

    const checks = pickChecks(opts);
    for (let i = 0; i < checks.length; i++) {
        const check = checks[i];
        progress(opts, `[${i + 1}/${checks.length}] ${check.label || check.name}...`);
        try {
            await check.run(project, reporter, opts);
        } catch (e) {
            reporter.startCheck(check.name);
            reporter.error(`check threw: ${e.message}`);
            reporter.endCheck();
        }
        if (!opts.json) reporter.streamLast();
    }

    return reporter.finish();
}

function parseArgs(argv) {
    const opts = {
        root: '.',
        manifest: 'manifest.json',
        only: null,            // 'static' | 'runtime' | null
        ignore: [],            // extra directory names to skip
        json: false,
        quiet: false,
        external: false,       // include external link checks (slow)
        strictA11y: false,     // also surface axe-core incomplete[] (manual-review)
        help: false
    };
    let positionalRootSet = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') opts.help = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--external') opts.external = true;
        else if (a === '--strict-a11y') opts.strictA11y = true;
        else if (a === '--root') opts.root = argv[++i];
        else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
        else if (a === '--manifest') opts.manifest = argv[++i];
        else if (a.startsWith('--manifest=')) opts.manifest = a.slice('--manifest='.length);
        else if (a === '--only') opts.only = argv[++i];
        else if (a.startsWith('--only=')) opts.only = a.slice('--only='.length);
        else if (a === '--ignore') opts.ignore.push(argv[++i]);
        else if (a.startsWith('--ignore=')) opts.ignore.push(a.slice('--ignore='.length));
        // First non-flag positional is treated as the project root, matching
        // mnfst-run's `npx mnfst-run <dir>` convention.
        else if (!a.startsWith('-') && !positionalRootSet) {
            opts.root = a;
            positionalRootSet = true;
        }
    }
    return opts;
}

function printHelp() {
    console.log(`mnfst-test — project linter for Manifest

Usage:
  npx mnfst-test [path] [options]

Arguments:
  path                Project root, relative or absolute. Default: current dir.
                      Equivalent to --root.

Options:
  --root <path>       Project root (default: .)
  --manifest <path>   manifest.json relative to root (default: manifest.json)
  --only <kind>       Run only "static" or "runtime" checks
  --ignore <dir>      Skip a directory (repeatable). Common: prerender output
  --external          Also fetch external <a href> links and report non-200s
  --strict-a11y       Surface axe "needs review" results (gradients, images)
  --json              Emit machine-readable JSON instead of formatted output
  --quiet, -q         Suppress passing checks; show only warnings/errors
  -h, --help          Show this message

Exit codes:
  0  no errors (warnings allowed)
  1  one or more errors found
  2  setup error (missing manifest, parse failure, etc.)

Runtime checks (console errors, a11y, dead links) require puppeteer.
If not installed, those checks are skipped with install instructions.
`);
}

// ---------------------------------------------------------------------------
// Project collection — read manifest.json + all HTML files once.
// ---------------------------------------------------------------------------

async function collectProject(root, manifest, opts) {
    const components = (manifest.components || []).slice();
    const preloaded = (manifest.preloadedComponents || []).slice();
    const allComponents = [...components, ...preloaded];

    const componentRegistry = new Map();
    for (const path of allComponents) {
        const tag = pathToTagName(path);
        if (!componentRegistry.has(tag)) componentRegistry.set(tag, []);
        componentRegistry.get(tag).push(path);
    }

    const dataSources = manifest.data && typeof manifest.data === 'object' ? manifest.data : {};

    // Compute skip directories: defaults + render output + user --ignore.
    const skip = new Set(DEFAULT_HTML_SKIP_DIRS);
    if (manifest.render && typeof manifest.render.output === 'string') {
        skip.add(manifest.render.output);
    }
    if (opts && Array.isArray(opts.ignore)) {
        for (const i of opts.ignore) skip.add(i);
    }

    // Compute locale prefixes for route matching: from render.locales,
    // from any data source with per-locale string keys, or with `locales:` key.
    const localePrefixes = new Set();
    if (Array.isArray(manifest.render?.locales)) {
        for (const l of manifest.render.locales) localePrefixes.add(l);
    }
    for (const config of Object.values(dataSources)) {
        if (!config || typeof config !== 'object') continue;
        for (const k of Object.keys(config)) {
            if (/^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(k)) localePrefixes.add(k);
        }
    }

    // Walk every source file in the project (HTML + Markdown), skipping
    // output and tooling dirs. Markdown is included so component/data-source
    // references inside .md articles are accounted for — Manifest projects
    // commonly render markdown to HTML at runtime, so a `<x-disclaimer>` tag
    // in an article counts as legitimate component usage.
    progress(opts, 'Scanning source files...');
    const htmlFiles = [];
    walkHtml(root, root, htmlFiles, skip);

    // Two-pass: first detect prerendered subtrees by the meta tag in any
    // index.html, then read the rest skipping those subtrees.
    const prerenderedRoots = [];
    for (const file of htmlFiles) {
        if (basename(file) !== 'index.html') continue;
        try {
            const head = readFileSync(file, 'utf8').slice(0, 4096);
            if (/<meta\s+name=["']manifest:prerendered["']\s+content=["']1["']/.test(head)) {
                prerenderedRoots.push(dirname(file));
            }
        } catch { /* skip */ }
    }

    const htmlContents = new Map();
    let n = 0;
    for (const file of htmlFiles) {
        if (isUnderAny(file, prerenderedRoots)) continue;
        try {
            let content = readFileSync(file, 'utf8');
            // For markdown, blank out fenced/inline code so example component
            // names like `<x-home>` and `$x.team` inside tutorials don't get
            // flagged as live usage. Whitespace replacement preserves line
            // numbers for accurate error locations.
            if (file.endsWith('.md') || file.endsWith('.mdx')) {
                content = stripMarkdownCode(content);
            }
            htmlContents.set(file, content);
        } catch { /* skip */ }
        if (++n % 250 === 0) progress(opts, `  …${n}/${htmlFiles.length} files read`);
    }
    progress(opts, `Read ${htmlContents.size} source files (${prerenderedRoots.length} prerendered subtree(s) auto-skipped)`);

    return {
        root, manifest, allComponents, componentRegistry, dataSources,
        htmlFiles: Array.from(htmlContents.keys()), htmlContents, localePrefixes
    };
}

function isUnderAny(file, roots) {
    for (const r of roots) {
        if (file === r || file.startsWith(r + '/')) return true;
    }
    return false;
}

// Replace fenced (```...```) and inline (`...`) code in markdown with
// whitespace, preserving newlines so line numbers stay accurate. Regex
// scans then see only prose plus any HTML the author embedded for real.
function stripMarkdownCode(content) {
    return content
        .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/~~~[\s\S]*?~~~/g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

function progress(opts, message) {
    if (opts && opts.json) return; // keep stdout clean for JSON consumers
    if (opts && opts.quiet) return;
    process.stderr.write(`\x1b[2m→ ${message}\x1b[0m\n`);
}

const DEFAULT_HTML_SKIP_DIRS = [
    'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.output',
    'coverage', '.vercel', '.netlify', '.manifest', 'out', 'public'
];

// Tags provided by Manifest plugins (registered as Web Components inside lib/).
// These are valid <x-*> usage even when not declared in manifest.json.
const FRAMEWORK_TAGS = new Set([
    'code', 'code-group'
]);

function walkHtml(root, dir, out, skip) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (skip.has(entry.name)) continue;
            walkHtml(root, full, out, skip);
        } else if (entry.isFile() && (
            entry.name.endsWith('.html') ||
            entry.name.endsWith('.md') ||
            entry.name.endsWith('.mdx')
        )) {
            out.push(full);
        }
    }
}

function pathToTagName(filePath) {
    // Manifest registers components by their basename without extension.
    return basename(filePath, extname(filePath));
}

// ---------------------------------------------------------------------------
// Reporter — terminal + JSON output, severity tracking, exit-code resolution.
// ---------------------------------------------------------------------------

class Reporter {
    constructor({ json, quiet }) {
        this.json = json;
        this.quiet = quiet;
        this.checks = [];
        this.current = null;
        this.skipped = [];
    }

    startCheck(name, label) {
        this.current = { name, label: label || name, status: 'ok', issues: [], details: null };
    }

    setDetails(details) {
        if (this.current) this.current.details = details;
    }

    issue(severity, message, location) {
        if (!this.current) return;
        const entry = { severity, message };
        if (location) Object.assign(entry, location);
        this.current.issues.push(entry);
        if (severity === 'error' && this.current.status !== 'error') this.current.status = 'error';
        else if (severity === 'warning' && this.current.status === 'ok') this.current.status = 'warning';
    }

    error(msg, location) { this.issue('error', msg, location); }
    warning(msg, location) { this.issue('warning', msg, location); }
    info(msg, location) { this.issue('info', msg, location); }

    endCheck() {
        if (this.current) this.checks.push(this.current);
        this.current = null;
    }

    skip(name, reason) {
        this.skipped.push({ name, reason });
    }

    streamLast() {
        // Render the most recently completed check to stdout (terminal mode).
        const c = this.checks[this.checks.length - 1];
        if (!c) return;
        if (c.status === 'ok' && this.quiet) return;
        const C = colors();
        const icon = c.status === 'error' ? C.red('✗') : c.status === 'warning' ? C.yellow('⚠') : C.green('✓');
        const det = c.details ? C.dim(` (${c.details})`) : '';
        console.log(`${icon} ${c.label}${det}`);
        for (const i of c.issues) {
            const sev = i.severity === 'error' ? C.red('•') : i.severity === 'warning' ? C.yellow('•') : C.dim('•');
            let loc = '';
            if (i.file) {
                const l = i.line ? `:${i.line}` : '';
                loc = C.dim(`  (${i.file}${l})`);
            }
            console.log(`  ${sev} ${i.message}${loc}`);
            if (i.expression) {
                console.log(C.dim(`      ${truncate(i.expression, 100)}`));
            }
        }
    }

    finish() {
        const errors = this.checks.reduce((n, c) => n + c.issues.filter((i) => i.severity === 'error').length, 0);
        const warnings = this.checks.reduce((n, c) => n + c.issues.filter((i) => i.severity === 'warning').length, 0);

        if (this.json) {
            process.stdout.write(JSON.stringify({
                status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok',
                summary: { errors, warnings, checks: this.checks.length },
                checks: this.checks,
                skipped: this.skipped
            }, null, 2) + '\n');
        } else {
            const C = colors();
            if (this.skipped.length) {
                console.log('');
                console.log(C.dim('Skipped:'));
                for (const s of this.skipped) {
                    console.log(C.dim(`  ${s.name} — ${s.reason}`));
                }
            }
            console.log('');
            const status = errors > 0 ? C.red(`${errors} error(s)`) : warnings > 0 ? C.yellow(`${warnings} warning(s)`) : C.green('all checks passed');
            console.log(`${status}`);
        }
        return errors > 0 ? 1 : 0;
    }
}

function truncate(s, max) {
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function colors() {
    const tty = process.stdout.isTTY && !process.env.NO_COLOR;
    const wrap = (code) => (s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
    return {
        red: wrap(31), green: wrap(32), yellow: wrap(33), dim: wrap(2)
    };
}

function printErr(msg) { console.error(`mnfst-test: ${msg}`); }

// ---------------------------------------------------------------------------
// Static checks — no headless browser required.
// ---------------------------------------------------------------------------

const STATIC_CHECKS = [
    { name: 'integrity', label: 'Manifest integrity', run: checkIntegrity },
    { name: 'pwa', label: 'PWA completeness', run: checkPwa },
    { name: 'components', label: 'Component references', run: checkComponents },
    { name: 'dataSources', label: 'Data source references', run: checkDataSources },
    { name: 'expressions', label: 'Directive expression syntax', run: checkExpressions },
    { name: 'routes', label: 'Route consistency', run: checkRoutes },
    { name: 'locales', label: 'Locale parity', run: checkLocales }
];

const RUNTIME_CHECKS = [
    { name: 'runtime', label: 'Runtime — console + a11y + links', run: checkRuntime }
];

function pickChecks(opts) {
    if (opts.only === 'static') return STATIC_CHECKS;
    if (opts.only === 'runtime') return RUNTIME_CHECKS;
    return [...STATIC_CHECKS, ...RUNTIME_CHECKS];
}

// 1. Manifest integrity --------------------------------------------------

async function checkIntegrity(project, reporter) {
    reporter.startCheck('integrity', 'Manifest integrity');
    const { manifest, root, allComponents, dataSources } = project;

    if (!manifest || typeof manifest !== 'object') {
        reporter.error('manifest.json is not an object');
        return reporter.endCheck();
    }

    // $schema reference (optional but encouraged).
    if (!manifest.$schema) {
        reporter.warning('No $schema set on manifest.json — editor autocomplete will be limited. Add "$schema": "https://manifestx.dev/manifest.schema.json"');
    }

    // Component file paths.
    const seenComponents = new Set();
    for (const p of allComponents) {
        if (typeof p !== 'string') {
            reporter.error(`components entry is not a string: ${JSON.stringify(p)}`);
            continue;
        }
        if (seenComponents.has(p)) {
            reporter.warning(`Duplicate component path: ${p}`);
        }
        seenComponents.add(p);
        const full = join(root, p.replace(/^\/+/, ''));
        if (!existsSync(full)) {
            reporter.error(`Component file not found on disk: ${p}`, { file: 'manifest.json' });
        }
    }

    // Data source file paths.
    for (const [name, config] of Object.entries(dataSources)) {
        const paths = extractFilePaths(config);
        for (const p of paths) {
            if (typeof p !== 'string' || p.startsWith('http://') || p.startsWith('https://')) continue;
            const full = join(root, p.replace(/^\/+/, ''));
            if (!existsSync(full)) {
                reporter.error(`Data source "${name}" references missing file: ${p}`, { file: 'manifest.json' });
            }
        }
    }

    // Icons.
    if (Array.isArray(manifest.icons)) {
        for (const icon of manifest.icons) {
            if (icon && typeof icon === 'object' && typeof icon.src === 'string') {
                const full = join(root, icon.src.replace(/^\/+/, ''));
                if (!existsSync(full)) {
                    reporter.warning(`Icon file not found: ${icon.src}`, { file: 'manifest.json' });
                }
            }
        }
    }

    reporter.setDetails(`${allComponents.length} component(s), ${Object.keys(dataSources).length} data source(s)`);
    reporter.endCheck();
}

function extractFilePaths(config) {
    if (typeof config === 'string') return [config];
    if (config && typeof config === 'object') {
        if (config.appwriteTableId || config.appwriteBucketId) return [];
        if (typeof config.url === 'string') return [];
        if (typeof config.locales === 'string') return [config.locales];
        const out = [];
        for (const [k, v] of Object.entries(config)) {
            if (['url', 'headers', 'params', 'transform', 'defaultValue'].includes(k)) continue;
            if (typeof v === 'string') out.push(v);
        }
        return out;
    }
    return [];
}

// 2. PWA completeness ----------------------------------------------------

async function checkPwa(project, reporter) {
    reporter.startCheck('pwa', 'PWA completeness');
    const m = project.manifest;
    if (!m.name) reporter.warning('Missing "name" — required for installable PWAs');
    if (!m.short_name) reporter.info('Missing "short_name" — recommended for home screens');
    if (!m.icons || !Array.isArray(m.icons) || m.icons.length === 0) {
        reporter.warning('Missing "icons" — required for installable PWAs');
    }
    if (!m.start_url) reporter.info('Missing "start_url" — defaults to "/"');
    if (!m.display) reporter.info('Missing "display" — defaults to "browser"');
    if (!m.theme_color) reporter.info('Missing "theme_color" — recommended for branded UI');
    reporter.endCheck();
}

// 3. Component references -----------------------------------------------

async function checkComponents(project, reporter) {
    reporter.startCheck('components', 'Component references');
    const { componentRegistry, htmlContents, root } = project;

    const used = new Set();
    const tagPattern = /<x-([a-z][a-z0-9-]*)/gi;

    for (const [file, content] of htmlContents) {
        let m;
        while ((m = tagPattern.exec(content)) !== null) {
            const tag = m[1].toLowerCase();
            if (FRAMEWORK_TAGS.has(tag)) continue;
            if (!componentRegistry.has(tag)) {
                const { line } = offsetToLine(content, m.index);
                reporter.error(`<x-${tag}> used but no component named "${tag}" is registered in manifest.json`, {
                    file: relative(root, file), line
                });
            } else {
                used.add(tag);
            }
        }
    }

    for (const [tag, paths] of componentRegistry) {
        if (!used.has(tag)) {
            reporter.warning(`Component "${tag}" is registered but never used (${paths[0]})`, { file: 'manifest.json' });
        }
        if (paths.length > 1) {
            reporter.error(`Multiple files registered as <x-${tag}>: ${paths.join(', ')}`, { file: 'manifest.json' });
        }
    }

    reporter.setDetails(`${componentRegistry.size} component(s), ${used.size} used`);
    reporter.endCheck();
}

// 4. Data source references ---------------------------------------------

async function checkDataSources(project, reporter) {
    reporter.startCheck('dataSources', 'Data source references');
    const { dataSources, htmlContents, root } = project;
    const registered = new Set(Object.keys(dataSources));
    const used = new Set();

    // Match $x.NAME (and $x['NAME'] / $x["NAME"]).
    const dotPattern = /\$x\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
    const bracketPattern = /\$x\[\s*['"]([^'"]+)['"]\s*\]/g;

    for (const [file, content] of htmlContents) {
        let m;
        while ((m = dotPattern.exec(content)) !== null) {
            const name = m[1];
            if (!registered.has(name)) {
                const { line } = offsetToLine(content, m.index);
                reporter.error(`$x.${name} referenced but not registered in manifest.json data`, {
                    file: relative(root, file), line
                });
            } else {
                used.add(name);
            }
        }
        while ((m = bracketPattern.exec(content)) !== null) {
            const name = m[1];
            if (!registered.has(name)) {
                const { line } = offsetToLine(content, m.index);
                reporter.error(`$x['${name}'] referenced but not registered`, {
                    file: relative(root, file), line
                });
            } else {
                used.add(name);
            }
        }
    }

    for (const name of registered) {
        if (!used.has(name)) {
            reporter.info(`Data source "${name}" is registered but never referenced via $x`, { file: 'manifest.json' });
        }
    }

    reporter.setDetails(`${registered.size} source(s), ${used.size} used`);
    reporter.endCheck();
}

// 5. Directive expression syntax ----------------------------------------

// Directives whose value is a JavaScript expression (or "x-for" header).
// Excludes string-only directives like x-route, x-modify, x-tooltip, x-ref,
// x-transition, x-teleport whose values are patterns/selectors/identifiers.
const DIRECTIVE_ATTR_RE = /\s(x-(?:data|init|show|if|for|text|html|model|effect)|x-bind:[a-z-]+|x-on:[a-z-]+(?:\.[a-z]+)*|@[a-z-]+(?:\.[a-z]+)*|:[a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

async function checkExpressions(project, reporter) {
    reporter.startCheck('expressions', 'Directive expression syntax');
    const { htmlContents, root } = project;

    let parsed = 0;
    let errors = 0;
    for (const [file, content] of htmlContents) {
        DIRECTIVE_ATTR_RE.lastIndex = 0;
        let m;
        while ((m = DIRECTIVE_ATTR_RE.exec(content)) !== null) {
            const directive = m[1];
            const rawExpr = m[2] != null ? m[2] : m[3];
            if (!rawExpr || !rawExpr.trim()) continue;
            // HTML-decode entities (`&amp;` → `&`, `&&` shows up as `&amp;&amp;`
            // in prerendered HTML). Without this we get spurious "Unexpected
            // token '&'" errors on perfectly valid expressions.
            const expr = decodeHtmlEntities(rawExpr);
            // x-for has the form "item in items" — wrap it so it parses.
            const wrapped = directive === 'x-for'
                ? wrapForExpression(expr)
                : expr;
            const err = tryParseExpression(wrapped);
            parsed++;
            if (err) {
                errors++;
                const { line } = offsetToLine(content, m.index + 1);
                reporter.error(`${directive} expression failed to parse: ${err}`, {
                    file: relative(root, file), line, expression: expr
                });
            }
        }
    }

    reporter.setDetails(`${parsed} expression(s) checked, ${errors} failed`);
    reporter.endCheck();
}

function decodeHtmlEntities(s) {
    return String(s)
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&'); // keep last so we don't double-decode
}

function tryParseExpression(expr) {
    try {
        // new Function throws on syntax error. The expression returns a value,
        // so wrap it; this also catches statements that aren't expressions.
        new Function(`return (${expr});`);
        return null;
    } catch (e) {
        // Some Alpine expressions are statements (e.g. "count++") — retry as a body.
        try {
            new Function(expr);
            return null;
        } catch (_) {
            return e.message;
        }
    }
}

function wrapForExpression(expr) {
    // x-for="item in items" / "item, index in items" / "(a, b) in pairs"
    const m = /^\s*(.+?)\s+(?:in|of)\s+(.+)$/.exec(expr);
    if (!m) return expr;
    return `(${m[2]});`;
}

// 6. Route consistency --------------------------------------------------

async function checkRoutes(project, reporter) {
    reporter.startCheck('routes', 'Route consistency');
    const { htmlContents, root, localePrefixes } = project;

    const routes = new Set();
    const wildcardRoutes = [];
    let hasCatchAll = false;

    const routeAttrRe = /\sx-route\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    for (const [, content] of htmlContents) {
        routeAttrRe.lastIndex = 0;
        let m;
        while ((m = routeAttrRe.exec(content)) !== null) {
            const raw = (m[1] != null ? m[1] : m[2]).trim();
            if (!raw) continue;
            for (const piece of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
                if (piece === '!*') { hasCatchAll = true; continue; }
                if (piece.startsWith('!')) continue;
                if (piece.startsWith('=')) { routes.add(stripSlash(piece.slice(1))); continue; }
                if (piece.endsWith('/*')) { wildcardRoutes.push(stripSlash(piece.slice(0, -2))); continue; }
                routes.add(stripSlash(piece));
            }
        }
    }

    if (!hasCatchAll && routes.size > 0) {
        reporter.info('No catch-all route (x-route="!*") found — consider adding a 404 view');
    }

    // Internal <a href> walk. Match literal href= only, NOT :href= or x-bind:href= (Alpine bindings).
    const linkRe = /<a\s[^>]*?(?<![\-:])\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
    let internalLinks = 0;
    let dead = 0;
    for (const [file, content] of htmlContents) {
        linkRe.lastIndex = 0;
        let m;
        while ((m = linkRe.exec(content)) !== null) {
            const href = m[1] != null ? m[1] : m[2];
            if (!href || href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;
            internalLinks++;
            // Strip query/hash for matching.
            const path = href.split('#')[0].split('?')[0];
            if (!path || path === '/') continue;
            // Strip leading locale prefix (e.g. /en/about → /about).
            const stripped = stripLocalePrefix(path, localePrefixes);
            if (matchesAnyRoute(stripped, routes, wildcardRoutes)) continue;
            // Static-file resolution: try the path as-is, with .html, or as a directory index.
            if (resolvesToStaticFile(root, stripped)) continue;
            dead++;
            const { line } = offsetToLine(content, m.index);
            // "info" rather than "warning" — link checks have many shapes
            // of legitimate dynamic-route patterns we can't statically prove.
            reporter.info(`Internal link "${href}" doesn't match any x-route or static file`, {
                file: relative(root, file), line
            });
        }
    }

    reporter.setDetails(`${routes.size} route(s), ${internalLinks} internal link(s), ${dead} unresolved`);
    reporter.endCheck();
}

function stripSlash(s) {
    return s.replace(/^\/+/, '').replace(/\/+$/, '');
}

function stripLocalePrefix(path, locales) {
    if (!locales || locales.size === 0) return path;
    const m = /^\/([a-zA-Z]{2}(?:-[a-zA-Z]{2})?)(\/|$)/.exec(path);
    if (!m) return path;
    if (!locales.has(m[1])) return path;
    const rest = path.slice(m[1].length + 1) || '/';
    return rest;
}

function matchesAnyRoute(path, exact, wildcards) {
    const stripped = stripSlash(path);
    if (exact.has(stripped) || exact.has(path)) return true;
    for (const w of wildcards) {
        if (stripped === w) return true;
        if (stripped.startsWith(w + '/')) return true;
    }
    return false;
}

function resolvesToStaticFile(root, path) {
    const rel = path.replace(/^\/+/, '');
    // Also try common content-collection conventions where Manifest projects
    // route a URL like `/resources/privacy` to a backing markdown file under
    // `articles/` or `content/`. Without these, link checks misfire for any
    // doc-style site that maps URLs onto a content tree at runtime.
    const candidates = [
        join(root, rel),
        join(root, rel + '.html'),
        join(root, rel + '.md'),
        join(root, rel, 'index.html'),
        join(root, rel, 'index.md'),
        join(root, 'articles', rel + '.md'),
        join(root, 'articles', rel + '.html'),
        join(root, 'articles', rel, 'index.md'),
        join(root, 'content', rel + '.md'),
        join(root, 'content', rel, 'index.md'),
        join(root, 'pages', rel + '.md'),
        join(root, 'pages', rel + '.html')
    ];
    for (const c of candidates) {
        try {
            if (existsSync(c) && statSync(c).isFile()) return true;
        } catch { /* skip */ }
    }
    return false;
}

// 7. Locale parity -------------------------------------------------------

async function checkLocales(project, reporter) {
    reporter.startCheck('locales', 'Locale parity');
    const { dataSources, root } = project;
    let localizedCount = 0;
    let mismatched = 0;

    for (const [name, config] of Object.entries(dataSources)) {
        if (!config || typeof config !== 'object') continue;
        const localeKeys = Object.keys(config).filter((k) => /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(k));
        if (localeKeys.length < 2) continue;
        localizedCount++;

        const keysByLocale = {};
        for (const loc of localeKeys) {
            const path = config[loc];
            if (typeof path !== 'string') continue;
            const full = join(root, path.replace(/^\/+/, ''));
            if (!existsSync(full)) continue;
            try {
                keysByLocale[loc] = collectKeys(full);
            } catch { /* skip */ }
        }

        const allKeys = new Set();
        for (const ks of Object.values(keysByLocale)) for (const k of ks) allKeys.add(k);
        for (const [loc, ks] of Object.entries(keysByLocale)) {
            const set = new Set(ks);
            for (const k of allKeys) {
                if (!set.has(k)) {
                    reporter.warning(`Source "${name}": locale "${loc}" missing key "${k}"`);
                    mismatched++;
                }
            }
        }
    }

    reporter.setDetails(`${localizedCount} localized source(s), ${mismatched} missing key(s)`);
    reporter.endCheck();
}

function collectKeys(filePath) {
    const lower = filePath.toLowerCase();
    const text = readFileSync(filePath, 'utf8');
    if (lower.endsWith('.json')) return flattenKeys(JSON.parse(text));
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        let yaml;
        try { yaml = require('js-yaml'); } catch { return []; }
        return flattenKeys(yaml.load(text));
    }
    if (lower.endsWith('.csv')) {
        // Key-value mode: first column "key".
        const rows = parseSimpleCsv(text);
        if (rows.length && (rows[0][0] || '').toLowerCase() === 'key') {
            return rows.slice(1).map((r) => r[0]).filter(Boolean);
        }
        return rows.length ? rows.slice(1).map((_, i) => String(i)) : [];
    }
    return [];
}

function flattenKeys(value, prefix = '', out = []) {
    if (value === null || value === undefined) { out.push(prefix); return out; }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) flattenKeys(value[i], prefix ? `${prefix}.${i}` : String(i), out);
        return out;
    }
    if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) flattenKeys(v, prefix ? `${prefix}.${k}` : k, out);
        return out;
    }
    out.push(prefix);
    return out;
}

function parseSimpleCsv(text) {
    return text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
}

// ---------------------------------------------------------------------------
// Runtime check — boot the project headlessly and capture issues.
// ---------------------------------------------------------------------------

async function checkRuntime(project, reporter, opts) {
    reporter.startCheck('runtime', 'Runtime — console + a11y + links');

    const puppeteer = await tryLoadPuppeteer();
    if (!puppeteer) {
        const msg = [
            'puppeteer not installed — runtime checks skipped.',
            '',
            'To enable, install puppeteer in your project:',
            '  npm install -D puppeteer',
            '',
            'Then re-run:',
            '  npx mnfst-test'
        ].join('\n');
        reporter.skip('runtime', 'puppeteer not installed');
        reporter.endCheck();
        if (!opts.json && !opts.quiet) console.log('\n' + msg + '\n');
        return;
    }

    // Find a static-server entry point. Prefer index.html at root.
    const indexPath = join(project.root, 'index.html');
    if (!existsSync(indexPath)) {
        reporter.warning(`No index.html at ${project.root} — cannot boot runtime checks. Pass --root <dir> if your entry lives elsewhere.`);
        return reporter.endCheck();
    }

    let browser;
    try {
        progress(opts, '   launching headless Chrome...');
        browser = await puppeteer.launch({ headless: 'new' });
    } catch (e) {
        reporter.skip('runtime', `puppeteer failed to launch: ${e.message}`);
        reporter.endCheck();
        if (!opts.json) {
            console.log([
                '',
                'puppeteer is installed but failed to launch (often missing a Chromium binary).',
                'Try:',
                '  npx puppeteer browsers install chrome',
                ''
            ].join('\n'));
        }
        return;
    }

    try {
        progress(opts, '   starting static server...');
        const url = await startStaticServer(project.root);
        const page = await browser.newPage();
        const consoleErrors = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        page.on('pageerror', (err) => consoleErrors.push(String(err)));

        progress(opts, `   navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });

        // Wait briefly for Alpine to settle.
        await page.waitForFunction(() => !!window.Alpine, { timeout: 5000 }).catch(() => { });
        await new Promise((r) => setTimeout(r, 500));

        // Sort console errors so genuine code bugs surface as errors and
        // localhost-only third-party CORS noise is downgraded with a hint.
        for (const err of consoleErrors) {
            if (isCorsError(err)) {
                reporter.warning(`Console (CORS, third-party): ${truncate(err, 200)}`);
                reporter.issue('info',
                    `  ↳ likely a localhost-origin issue — whitelist 127.0.0.1/localhost in the upstream service config, or run mnfst-test against the deployed URL`);
            } else if (isNetworkLoadFailure(err)) {
                // "Failed to load resource: net::ERR_FAILED" usually pairs with the
                // CORS error above; downgrade together.
                reporter.warning(`Console (network): ${truncate(err, 200)}`);
            } else {
                reporter.error(`Console error: ${err}`);
            }
        }

        // Inject axe-core for an a11y pass. We also pass in the project's
        // theme-variable names (extracted from local CSS) so that when axe
        // reports a color-contrast violation, we can resolve which CSS
        // custom property drives the failing color and point the user at
        // the theme layer rather than the leaf element.
        try {
            progress(opts, '   running axe-core...');
            await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js' });
            const themeVars = extractThemeVars(project.root);
            const a11y = await page.evaluate(async (themeVars) => {
                if (!window.axe) return null;
                const res = await window.axe.run();

                function normalizeColor(v) {
                    if (!v) return '';
                    v = String(v).trim().toLowerCase();
                    let m = /^#([0-9a-f]{3,8})$/.exec(v);
                    if (m) {
                        let h = m[1];
                        if (h.length === 3 || h.length === 4) {
                            h = h.split('').map((c) => c + c).join('');
                        }
                        const r = parseInt(h.slice(0, 2), 16);
                        const g = parseInt(h.slice(2, 4), 16);
                        const b = parseInt(h.slice(4, 6), 16);
                        const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
                        return `${r},${g},${b},${a.toFixed(3)}`;
                    }
                    m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(v);
                    if (m) {
                        const r = Math.round(parseFloat(m[1]));
                        const g = Math.round(parseFloat(m[2]));
                        const b = Math.round(parseFloat(m[3]));
                        let a = 1;
                        if (m[4]) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
                        return `${r},${g},${b},${a.toFixed(3)}`;
                    }
                    return v;
                }

                function resolveVarsAt(el) {
                    const cs = getComputedStyle(el);
                    const map = new Map(); // normalized value -> [{ name, source, rawValue, value }]
                    for (const v of themeVars) {
                        const resolved = cs.getPropertyValue(v.name).trim();
                        if (!resolved) continue;
                        const key = normalizeColor(resolved);
                        if (!map.has(key)) map.set(key, []);
                        map.get(key).push({
                            name: v.name,
                            source: v.source,
                            rawValue: v.rawValue,
                            value: resolved
                        });
                    }
                    return map;
                }

                function processViolation(v) { return {
                    id: v.id,
                    impact: v.impact,
                    help: v.help,
                    helpUrl: v.helpUrl,
                    // Take up to 50 nodes — enough to group color-contrast by
                    // (fg-var, bg-var) without losing fidelity. Renderer caps
                    // ungrouped output to keep terminals readable.
                    nodes: v.nodes.slice(0, 50).map((n) => {
                        const target = Array.isArray(n.target) ? n.target.join(' ') : String(n.target);
                        let el = null;
                        try { el = document.querySelector(target); } catch { /* invalid sel */ }
                        const meta = {
                            target,
                            html: typeof n.html === 'string' ? n.html.slice(0, 160) : '',
                            failureSummary: n.failureSummary || '',
                            tag: el ? el.tagName.toLowerCase() : null,
                            classes: el && typeof el.className === 'string'
                                ? el.className.split(/\s+/).filter(Boolean).slice(0, 8)
                                : [],
                            id: el ? (el.id || null) : null,
                            inlineStyle: el ? (el.getAttribute('style') || null) : null,
                            matchedVars: []
                        };

                        // For colour-related violations, axe stores fg/bg on `any[].data`.
                        // We always emit both roles (with var attribution if any
                        // matches) so reviewers can see exactly what axe compared.
                        meta.colorPair = null;
                        if (el && Array.isArray(n.any)) {
                            const valueMap = resolveVarsAt(el);
                            for (const ax of n.any) {
                                if (!ax.data || typeof ax.data !== 'object') continue;
                                if (!ax.data.fgColor && !ax.data.bgColor) continue;
                                const pair = {
                                    contrastRatio: ax.data.contrastRatio,
                                    expectedContrastRatio: ax.data.expectedContrastRatio,
                                    fg: null,
                                    bg: null
                                };
                                for (const role of ['fgColor', 'bgColor']) {
                                    const c = ax.data[role];
                                    if (!c) continue;
                                    const matches = valueMap.get(normalizeColor(c)) || [];
                                    const slot = role === 'fgColor' ? 'fg' : 'bg';
                                    pair[slot] = {
                                        color: c,
                                        vars: matches.map((mv) => ({
                                            name: mv.name,
                                            source: mv.source,
                                            rawValue: mv.rawValue
                                        }))
                                    };
                                    for (const mv of matches) {
                                        meta.matchedVars.push({
                                            role: role === 'fgColor' ? 'foreground' : 'background',
                                            color: c,
                                            var: mv.name,
                                            source: mv.source,
                                            rawValue: mv.rawValue
                                        });
                                    }
                                }
                                meta.colorPair = pair;
                                break;
                            }
                        }

                        return meta;
                    }),
                    totalNodes: v.nodes.length
                }; }
                return {
                    violations: res.violations.map(processViolation),
                    incomplete: res.incomplete.map(processViolation)
                };
            }, themeVars);

            if (a11y) {
                renderA11yResults(a11y.violations, false, reporter);
                if (opts.strictA11y && a11y.incomplete && a11y.incomplete.length) {
                    renderA11yResults(a11y.incomplete, true, reporter);
                }
            }
        } catch (e) {
            reporter.info(`Could not run axe-core: ${e.message}`);
        }

        // Optional external link check.
        if (opts.external) {
            const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
                .map((a) => a.href)
                .filter((h) => /^https?:\/\//.test(h)));
            const checked = new Set();
            for (const link of links) {
                if (checked.has(link)) continue;
                checked.add(link);
                try {
                    const res = await fetch(link, { method: 'HEAD' });
                    if (!res.ok) reporter.warning(`External link returned ${res.status}: ${link}`);
                } catch (e) {
                    reporter.warning(`External link unreachable: ${link} (${e.message})`);
                }
            }
        }

        await page.close();
    } finally {
        await browser.close().catch(() => { });
    }

    reporter.endCheck();
}

function renderA11yResults(items, isIncomplete, reporter) {
    // The heading line carries the real severity (error/warning) and counts
    // toward the exit-code total. Sub-lines (per-node + theme-var attribution)
    // are descriptive details rendered under the heading at info severity so
    // they don't multiply the error count.
    for (const v of items) {
        const sev = isIncomplete
            ? 'info'
            : (v.impact === 'critical' || v.impact === 'serious' ? 'error' : 'warning');
        const prefix = isIncomplete ? 'a11y? (review) ' : 'a11y ';
        const heading = `${prefix}[${v.id}]: ${v.help} (${v.totalNodes} node${v.totalNodes === 1 ? '' : 's'})`;
        reporter.issue(sev, heading, { helpUrl: v.helpUrl });

        // Group color-contrast nodes by the (fg-var, bg-var, ratio) signature.
        // When a contrast failure originates in a theme variable, the fix is
        // upstream — pointing at every leaf element is noise. We surface one
        // line per unique var combination plus a count.
        const { groups, ungrouped } = groupVarMatchedNodes(v.nodes);

        for (const g of groups) {
            const ratio = g.contrastRatio != null
                ? ` contrast ${g.contrastRatio.toFixed(2)} (need ≥ ${g.expectedContrastRatio})`
                : '';
            const count = g.nodes.length;
            reporter.issue('info',
                `  ↳${ratio} — ${count} node${count === 1 ? '' : 's'}`);
            renderColorPair(g.fg, g.bg, reporter);
        }

        for (const n of ungrouped) {
            const target = truncate(n.target, 80);
            const detail = n.colorPair
                ? (n.colorPair.contrastRatio != null
                    ? ` — contrast ${n.colorPair.contrastRatio.toFixed(2)} (need ≥ ${n.colorPair.expectedContrastRatio})`
                    : '')
                : (n.failureSummary ? ` — ${truncate(n.failureSummary, 120)}` : '');
            reporter.issue('info', `  ↳ ${target}${detail}`, { snippet: n.html });

            if (n.colorPair) {
                renderColorPair(n.colorPair.fg, n.colorPair.bg, reporter);
            } else if (n.classes && n.classes.length > 0) {
                reporter.issue('info',
                    `     ↳ classes: ${n.classes.map((c) => '.' + c).join(' ')}`);
            }
        }

        const shownCount = groups.reduce((s, g) => s + g.nodes.length, 0) + ungrouped.length;
        if (v.totalNodes > shownCount) {
            reporter.issue('info', `  ↳ …and ${v.totalNodes - shownCount} more`);
        }
    }
}

function groupVarMatchedNodes(nodes) {
    // A node is "var-matched" if at least one side (fg or bg) of its colorPair
    // resolves to a theme CSS variable. We group by the sorted set of var names
    // on each side plus the resolved colors and contrast ratio. Nodes with no
    // var match on either side fall through to per-element rendering.
    const groups = new Map();
    const ungrouped = [];
    for (const n of nodes) {
        if (!n.colorPair) { ungrouped.push(n); continue; }
        const fgVarKey = (n.colorPair.fg?.vars || []).map((v) => v.name).sort().join('+');
        const bgVarKey = (n.colorPair.bg?.vars || []).map((v) => v.name).sort().join('+');
        if (!fgVarKey && !bgVarKey) { ungrouped.push(n); continue; }
        const fgColor = n.colorPair.fg?.color || '';
        const bgColor = n.colorPair.bg?.color || '';
        const ratio = n.colorPair.contrastRatio;
        const sigKey = `${fgVarKey}|${bgVarKey}|${fgColor}|${bgColor}|${ratio}`;
        let bucket = groups.get(sigKey);
        if (!bucket) {
            bucket = {
                fg: n.colorPair.fg,
                bg: n.colorPair.bg,
                contrastRatio: n.colorPair.contrastRatio,
                expectedContrastRatio: n.colorPair.expectedContrastRatio,
                nodes: []
            };
            groups.set(sigKey, bucket);
        }
        bucket.nodes.push(n);
    }
    return { groups: Array.from(groups.values()), ungrouped };
}

function renderColorPair(fg, bg, reporter) {
    for (const [data, role] of [[fg, 'foreground'], [bg, 'background']]) {
        if (!data) continue;
        if (data.vars && data.vars.length > 0) {
            for (const v of data.vars) {
                // Prefer the user-authored CSS expression (oklch / hsl / hex /
                // var()) — it's more actionable than the resolved hex axe sees.
                const display = v.rawValue || data.color;
                reporter.issue('info',
                    `     ↳ ${role} ${v.name}: ${display} (${v.source})`);
            }
        } else {
            reporter.issue('info',
                `     ↳ ${role} ${data.color} (no theme var match)`);
        }
    }
}

function isCorsError(msg) {
    if (typeof msg !== 'string') return false;
    return /CORS policy|blocked by CORS|Access to fetch.*has been blocked|Cross-Origin Request Blocked/i.test(msg);
}

function isNetworkLoadFailure(msg) {
    if (typeof msg !== 'string') return false;
    return /Failed to load resource:.*net::ERR_FAILED|net::ERR_BLOCKED_BY_RESPONSE/i.test(msg);
}

async function tryLoadPuppeteer() {
    try {
        const m = await import('puppeteer');
        return m.default || m;
    } catch {
        return null;
    }
}

// Extract CSS custom-property declarations from local theme/styles files.
// We can't reliably introspect cross-origin CDN stylesheets at runtime
// (CORS blocks `cssRules`), so we scan local files instead and resolve each
// var on the failing element via getComputedStyle inside the page.
//
// The order here matters for the source-of-truth attribution that gets
// surfaced under each a11y finding — file paths closer to the project root
// (and `manifest.theme.css` in particular) win.
function extractThemeVars(root) {
    const candidatePaths = [
        'manifest.theme.css',
        'styles/manifest.theme.css',
        'src/styles/manifest.theme.css',
        'website/manifest.theme.css'
    ];
    // Plus any *.theme.css or theme.css we find at common depths.
    try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (entry.isFile() && /(?:^|\.)theme\.css$/.test(entry.name) && !candidatePaths.includes(entry.name)) {
                candidatePaths.push(entry.name);
            }
        }
    } catch { /* skip */ }

    const result = [];
    const seen = new Set();
    // Capture the raw declaration value too (everything up to the next `;` or `}`)
    // so we can surface the user-authored color expression — `oklch(...)`,
    // `hsl(...)`, `var(--alias)` — instead of the canonical hex axe sees.
    const declRe = /(--[a-zA-Z][\w-]*)\s*:\s*([^;}]+?)\s*[;}]/g;
    for (const p of candidatePaths) {
        const full = isAbsolute(p) ? p : join(root, p);
        try {
            if (!existsSync(full)) continue;
            if (!statSync(full).isFile()) continue;
            const content = readFileSync(full, 'utf8');
            let m;
            while ((m = declRe.exec(content)) !== null) {
                const name = m[1];
                const rawValue = m[2].trim();
                if (seen.has(name)) continue;
                seen.add(name);
                result.push({ name, source: p, rawValue });
            }
        } catch { /* skip */ }
    }
    return result;
}

// Tiny static server for the headless run.
async function startStaticServer(root) {
    const http = await import('node:http');
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const rootResolved = resolve(root);
    // Refuse requests that would escape `root` via `..` or NUL injection.
    // `path.join` doesn't block `..` — only `path.resolve` + a prefix check
    // does. Bound to 127.0.0.1 below, so the realistic threat is another
    // local user reading test-time files on a shared host.
    function safeResolve(urlPath) {
        if (urlPath.includes('\0')) return null;
        const candidate = resolve(rootResolved, '.' + urlPath);
        if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return null;
        return candidate;
    }
    const server = http.createServer(async (req, res) => {
        try {
            const parsed = url.parse(req.url);
            let p = decodeURIComponent(parsed.pathname || '/');
            if (p.endsWith('/')) p += 'index.html';
            if (!p.startsWith('/')) p = '/' + p;
            const full = safeResolve(p);
            if (!full) {
                res.writeHead(403);
                res.end();
                return;
            }
            const buf = await fs.readFile(full);
            res.writeHead(200, { 'Content-Type': mime(full) });
            res.end(buf);
        } catch {
            // SPA fallback.
            try {
                const buf = await fs.readFile(join(root, 'index.html'));
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(buf);
            } catch (e) {
                res.writeHead(404);
                res.end();
            }
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    process.on('exit', () => server.close());
    return `http://127.0.0.1:${port}/`;
}

function mime(path) {
    const ext = path.toLowerCase().split('.').pop();
    return {
        html: 'text/html', js: 'application/javascript', mjs: 'application/javascript',
        css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
        ico: 'image/x-icon', csv: 'text/csv', yaml: 'text/yaml', yml: 'text/yaml',
        woff2: 'font/woff2', woff: 'font/woff'
    }[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function offsetToLine(text, offset) {
    let line = 1, col = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === '\n') { line++; col = 1; } else col++;
    }
    return { line, col };
}
