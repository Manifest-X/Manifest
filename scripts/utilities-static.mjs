#!/usr/bin/env node
/* Generate a static Manifest utilities sheet for a project without a DOM.
 *
 * Walks every .html file under a directory, scans it for utility class
 * tokens the same way the browser JIT does (manifest.utilities.node.mjs
 * scanClasses), compiles the CSS those classes need (compileUtilities), and
 * writes the result to a single deterministic stylesheet. Used by hosting/
 * publish (a Cloudflare Worker, no DOM) and locally for any project that
 * wants to ship utilities.css instead of generating it at runtime.
 *
 *   Usage: node scripts/utilities-static.mjs <dir> [--theme path.css] [--out manifest.utilities.css]
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { compileUtilities, scanClasses } from '../lib/manifest.utilities.node.mjs';

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--theme') args.theme = argv[++i];
        else if (a === '--out') args.out = argv[++i];
        else args._.push(a);
    }
    return args;
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
        console.error('Usage: node scripts/utilities-static.mjs <dir> [--theme path.css] [--out manifest.utilities.css]');
        process.exit(1);
    }

    const rootDir = resolve(dir);
    if (!statSync(rootDir, { throwIfNoEntry: false })?.isDirectory()) {
        console.error(`utilities-static: ${rootDir} is not a directory`);
        process.exit(1);
    }

    const themeCss = args.theme ? readFileSync(resolve(args.theme), 'utf8') : '';
    const outPath = resolve(args.out || join(rootDir, 'manifest.utilities.css'));

    const htmlFiles = walkHtmlFiles(rootDir).sort();
    const classSet = new Set();
    for (const file of htmlFiles) {
        const html = readFileSync(file, 'utf8');
        for (const cls of scanClasses(html)) classSet.add(cls);
    }

    // Sort before compiling so the same class set always produces byte-identical output.
    const classes = Array.from(classSet).sort();
    const css = await compileUtilities({ classes, themeCss });

    writeFileSync(outPath, css ? `${css}\n` : '');
    console.log(`utilities-static: scanned ${htmlFiles.length} file(s), ${classes.length} class token(s) → ${outPath}`);
}

main().catch((err) => {
    console.error('utilities-static: failed', err);
    process.exit(1);
});
