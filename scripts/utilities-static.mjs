#!/usr/bin/env node
/* Generate a static Manifest utilities sheet for a project without a DOM.
 *
 * Walks every .html file under a directory, scans it for utility class
 * tokens the same way the browser JIT does (manifest.utilities.node.mjs
 * scanClasses), compiles the CSS those classes need (compileUtilities —
 * Manifest's own theme-var/custom utilities AND, via the real `tailwindcss`
 * compiler, plain Tailwind-style utilities like `flex`/`gap-2`/`w-[37px]`),
 * and writes the result to a single deterministic stylesheet. Used by
 * hosting/publish (a Cloudflare Worker, no DOM) and locally for any project
 * that wants to ship utilities.css instead of generating it at runtime.
 *
 *   Usage: node scripts/utilities-static.mjs <dir> [--theme path.css] [--base extra.css] [--out manifest.utilities.css]
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileUtilities, scanClasses } from '../lib/manifest.utilities.node.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--theme') args.theme = argv[++i];
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--base') args.base = argv[++i];
        else if (a === '--manifest') args.manifest = argv[++i];
        else args._.push(a);
    }
    return args;
}

// manifest.json's `utilities.safelist`/`utilities.patterns` — see
// manifest.utilities.node.mjs (compileUtilities/scanClasses) and
// manifest.utilities.static.js (runtime coverage) for the full contract.
// Only `safelist` (literal class names) can be baked; `patterns` (regex) is
// runtime-only and has nothing to enumerate here.
function loadUtilitiesSafelist(manifestPath) {
    if (!existsSync(manifestPath)) return [];
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const list = manifest && manifest.utilities && manifest.utilities.safelist;
        return Array.isArray(list) ? list.filter(c => typeof c === 'string' && c) : [];
    } catch (e) {
        console.warn(`utilities-static: could not read ${manifestPath} for a safelist — ${e.message}`);
        return [];
    }
}

// The browser JIT always sees the framework's own utility CSS: compile()'s
// discoverCssFiles() picks up manifest.css from the page's own stylesheets,
// so generateCustomUtilities() recognises Manifest's semantic utilities
// (.row, .col, .center, …) and bakes their variants (md:row, hover:col-wrap).
// A static bake has no page to discover from, so it must load the same file
// itself — otherwise every variant of a semantic utility falls through
// entirely to the runtime JIT (see PERF-PRIMITIVES-DESIGN.md §15).
function loadFrameworkBaseCss() {
    const path = join(__dirname, '..', 'lib', 'manifest.css');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function walkHtmlFiles(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            walkHtmlFiles(p, out);
        } else if (extname(entry.name) === '.html') {
            out.push(p);
        }
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const dir = args._[0];
    if (!dir) {
        console.error('Usage: node scripts/utilities-static.mjs <dir> [--theme path.css] [--base extra.css] [--out manifest.utilities.css]');
        process.exit(1);
    }

    const rootDir = resolve(dir);
    if (!statSync(rootDir, { throwIfNoEntry: false })?.isDirectory()) {
        console.error(`utilities-static: ${rootDir} is not a directory`);
        process.exit(1);
    }

    const themeCss = args.theme ? readFileSync(resolve(args.theme), 'utf8') : '';
    const extraBaseCss = args.base ? readFileSync(resolve(args.base), 'utf8') : '';
    const baseCss = [loadFrameworkBaseCss(), extraBaseCss].filter(Boolean).join('\n');
    const outPath = resolve(args.out || join(rootDir, 'manifest.utilities.css'));
    const manifestPath = resolve(args.manifest || join(rootDir, 'manifest.json'));
    const safelist = loadUtilitiesSafelist(manifestPath);

    const htmlFiles = walkHtmlFiles(rootDir).sort();
    const classSet = new Set();
    for (const file of htmlFiles) {
        const html = readFileSync(file, 'utf8');
        for (const cls of scanClasses(html)) classSet.add(cls);
    }

    // Sort before compiling so the same class set always produces byte-identical output.
    const classes = Array.from(classSet).sort();
    const css = await compileUtilities({ classes, themeCss, baseCss, safelist });

    writeFileSync(outPath, css ? `${css}\n` : '');
    const safelistNote = safelist.length ? `, ${safelist.length} safelisted` : '';
    console.log(`utilities-static: scanned ${htmlFiles.length} file(s), ${classes.length} class token(s)${safelistNote} → ${outPath}`);
}

main().catch((err) => {
    console.error('utilities-static: failed', err);
    process.exit(1);
});
