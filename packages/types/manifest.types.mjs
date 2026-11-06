// mnfst-types: generate manifest.d.ts for a Manifest project.
//
// Reads ./manifest.json, samples each data source (CSV / JSON / YAML or
// Appwrite-table config), and writes a single manifest.d.ts that contains
// the static ambient declarations plus a project-specific augmentation of
// the ManifestSources interface.
//
// Re-running the CLI overwrites the augmentation block (between the
// AUGMENTATION:start / AUGMENTATION:end markers in the template).

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(PACKAGE_ROOT, 'template', 'manifest.d.ts');

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function main(argv) {
    const opts = parseArgs(argv);

    if (opts.help) {
        printHelp();
        return;
    }

    const cwd = process.cwd();
    const manifestPath = resolve(cwd, opts.manifest);

    if (!existsSync(manifestPath)) {
        throw new Error(`manifest.json not found at ${manifestPath}`);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const projectRoot = dirname(manifestPath);

    const augmentation = await buildAugmentation(manifest, projectRoot);
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    const output = applyAugmentation(template, augmentation);

    const outPath = resolve(cwd, opts.out);
    if (opts.tsc) {
        process.exitCode = runTsc(projectRoot, relative(projectRoot, outPath).split('\\').join('/'));
        return;
    }
    if (opts.check) {
        const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
        if (current !== output) {
            console.error(`mnfst-types: ${opts.out} is out of date with manifest.json — run \`npx mnfst-types\` and commit it`);
            process.exitCode = 1;
            return;
        }
        console.log(`mnfst-types: ${opts.out} is up to date`);
        return;
    }
    writeFileSync(outPath, output);
    console.log(`mnfst-types: wrote ${outPath}`);

    const typesPath = relative(projectRoot, outPath).split('\\').join('/');
    if (opts.init) {
        const jsconfig = join(projectRoot, 'jsconfig.json');
        if (existsSync(jsconfig)) syncJsconfigPaths(jsconfig, typesPath, importMapPaths(projectRoot));
        else writeOnce(jsconfig, defaultJsconfig(typesPath, importMapPaths(projectRoot)));
    }
    if (opts.ci) {
        writeOnce(join(projectRoot, '.github', 'workflows', 'types.yml'), defaultWorkflow(typesPath));
    }
}

function writeOnce(path, content) {
    if (existsSync(path)) {
        console.log(`mnfst-types: ${path} already exists, leaving it alone`);
        if (/"moduleResolution"\s*:\s*"node(10)?"/i.test(readFileSync(path, 'utf8'))) {
            console.warn('mnfst-types: its "moduleResolution": "node" is not supported by TypeScript 7; use "bundler" (delete the file and run --init again for the current defaults)');
        }
        return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`mnfst-types: wrote ${path}`);
}

function parseArgs(argv) {
    const opts = {
        manifest: 'manifest.json',
        out: 'manifest.d.ts',
        init: false,
        ci: false,
        check: false,
        tsc: false,
        help: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') opts.help = true;
        else if (a === '--init') opts.init = true;
        else if (a === '--ci') opts.ci = true;
        else if (a === '--check') opts.check = true;
        else if (a === '--tsc') opts.tsc = true;
        else if (a === '--manifest') opts.manifest = argv[++i];
        else if (a === '--out') opts.out = argv[++i];
        else if (a.startsWith('--manifest=')) opts.manifest = a.slice('--manifest='.length);
        else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    }
    return opts;
}

function printHelp() {
    console.log(`mnfst-types — generate manifest.d.ts from a Manifest project

Usage:
  npx mnfst-types [options]

Options:
  --manifest <path>   Path to manifest.json (default: ./manifest.json)
  --out <path>        Output .d.ts path (default: ./manifest.d.ts)
  --init              Also write a baseline jsconfig.json (only if missing)
  --ci                Also write .github/workflows/types.yml (only if missing)
  --check             Exit 1 if the output file is out of date; write nothing
  --tsc               Type-check app/ and shared/ with tsc; paths come from the
                      import map on every run (extends your jsconfig/tsconfig if any)
  -h, --help          Show this message
`);
}

// index.html's import map as jsconfig paths: "@app/": "/app/" → "@app/*": ["./app/*"]
function importMapPaths(projectRoot) {
    const paths = {};
    let html = '';
    try { html = readFileSync(join(projectRoot, 'index.html'), 'utf8'); } catch { return paths; }
    const m = html.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return paths;
    let map;
    try { map = JSON.parse(m[1]); } catch { return paths; }
    for (const [key, target] of Object.entries((map && map.imports) || {})) {
        if (typeof target !== 'string' || /^[a-z]+:|^\/\//i.test(target)) continue;
        const local = '.' + (target.startsWith('/') ? target : '/' + target);
        if (key.endsWith('/') && local.endsWith('/')) paths[key + '*'] = [local + '*'];
        else paths[key] = [local];
    }
    return paths;
}

const COMPILER_DEFAULTS = {
    target: 'es2022',
    module: 'esnext',
    moduleResolution: 'bundler',
    checkJs: true,
    allowJs: true,
    noEmit: true,
    strict: false,
    skipLibCheck: true,
    lib: ['es2022', 'dom', 'dom.iterable']
};
const DEFAULT_INCLUDE = (types) => ['app/**/*', 'shared/**/*', types, '*.d.ts'];

// JSON with comments and trailing commas, as tsconfig allows; null when unreadable
function readJsonc(path) {
    try {
        const text = readFileSync(path, 'utf8')
            .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
            .replace(/,(\s*[}\]])/g, '$1');
        return JSON.parse(text);
    } catch { return null; }
}

// --init on an existing jsconfig: add import-map paths it lacks (plain JSON only)
function syncJsconfigPaths(path, types, aliases) {
    let config;
    try { config = JSON.parse(readFileSync(path, 'utf8')); } catch {
        console.log(`mnfst-types: ${path} has comments; add any import-map aliases to its paths by hand (npx mnfst-types --tsc merges them anyway)`);
        return;
    }
    const paths = (config.compilerOptions ||= {}).paths ||= {};
    const wanted = { mnfst: [`./${types}`], ...aliases };
    const added = Object.keys(wanted).filter((k) => !(k in paths));
    if (!added.length) {
        console.log(`mnfst-types: ${path} already maps every import-map alias`);
        return;
    }
    for (const k of added) paths[k] = wanted[k];
    writeFileSync(path, JSON.stringify(config, null, 4) + '\n');
    console.log(`mnfst-types: added ${added.join(', ')} to ${path}`);
}

// tsc from the project, then next to mnfst-types, else npx
function findTsc(projectRoot) {
    for (const from of [join(projectRoot, 'package.json'), fileURLToPath(import.meta.url)]) {
        try {
            const req = createRequire(from);
            const pkgPath = req.resolve('typescript/package.json');
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.tsc;
            if (bin) return { cmd: process.execPath, args: [join(dirname(pkgPath), bin)] };
        } catch { /* next */ }
    }
    return { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', '-p', 'typescript@7', 'tsc'] };
}

// Type-check with a config built now: import-map paths can't drift. A project
// jsconfig/tsconfig is extended, and its own paths win over the import map.
function runTsc(projectRoot, types) {
    const abs = (p) => resolve(projectRoot, p);
    const own = ['tsconfig.json', 'jsconfig.json'].map((f) => join(projectRoot, f)).find((f) => existsSync(f));
    const config = { compilerOptions: {} };
    const paths = { mnfst: [abs(types)] };
    for (const [k, v] of Object.entries(importMapPaths(projectRoot))) paths[k] = v.map(abs);
    if (own) {
        config.extends = own;
        const parsed = readJsonc(own);
        if (!parsed) console.warn(`mnfst-types: couldn't read ${own}; extending it with import-map paths only`);
        const opts = (parsed && parsed.compilerOptions) || {};
        const base = opts.baseUrl ? resolve(dirname(own), opts.baseUrl) : dirname(own);
        for (const [k, v] of Object.entries(opts.paths || {})) paths[k] = (Array.isArray(v) ? v : [v]).map((x) => resolve(base, x));
        if (parsed && !parsed.include && !parsed.files) config.include = DEFAULT_INCLUDE(types).map(abs);
    } else {
        Object.assign(config.compilerOptions, COMPILER_DEFAULTS);
        config.include = DEFAULT_INCLUDE(types).map(abs);
        config.exclude = ['node_modules', 'website'].map(abs);
    }
    config.compilerOptions.paths = paths;
    config.compilerOptions.noEmit = true;
    const dir = mkdtempSync(join(tmpdir(), 'mnfst-tsc-'));
    const file = join(dir, 'tsconfig.json');
    try {
        writeFileSync(file, JSON.stringify(config, null, 2));
        const { cmd, args } = findTsc(projectRoot);
        const r = spawnSync(cmd, [...args, '-p', file, '--pretty', 'false'], { cwd: realpathSync(projectRoot), encoding: 'utf8' });
        if (r.error) { console.error(`mnfst-types: couldn't run tsc (${r.error.message})`); return 2; }
        process.stdout.write(r.stdout || '');
        process.stderr.write(r.stderr || '');
        if (r.status === 0) console.log('mnfst-types: no type errors');
        return r.status ?? 1;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function defaultJsconfig(types, aliases = {}) {
    return JSON.stringify({
        compilerOptions: { ...COMPILER_DEFAULTS, paths: { mnfst: [`./${types}`], ...aliases } },
        include: DEFAULT_INCLUDE(types),
        exclude: ['node_modules', 'website']
    }, null, 4) + '\n';
}

function defaultWorkflow(out) {
    return [
        'name: Types',
        '',
        'on: [push, pull_request]',
        '',
        'jobs:',
        '  check:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
        `      - run: npx -y mnfst-types@latest --check --out ${out}`,
        `      - run: npx -y -p typescript@7 -p mnfst-types@latest mnfst-types --tsc --out ${out}`,
        ''
    ].join('\n');
}

const START_MARKER = '// AUGMENTATION:start';
const END_MARKER = '// AUGMENTATION:end';

function applyAugmentation(template, body) {
    const startIdx = template.indexOf(START_MARKER);
    const endIdx = template.indexOf(END_MARKER);
    if (startIdx === -1 || endIdx === -1) {
        throw new Error('Template is missing AUGMENTATION:start / AUGMENTATION:end markers');
    }
    // Find the end of the start-marker line and the start of the end-marker line.
    const startLineEnd = template.indexOf('\n', startIdx) + 1;
    // Walk back from endIdx to the previous newline so we replace whole lines.
    let endLineStart = endIdx;
    while (endLineStart > 0 && template[endLineStart - 1] !== '\n') endLineStart--;

    const before = template.slice(0, startLineEnd);
    const after = template.slice(endLineStart);

    const generatedHeader = [
        '// Generated by `npx mnfst-types`. Do not edit by hand —',
        '// hand-edits between AUGMENTATION:start and AUGMENTATION:end are',
        '// overwritten on regeneration.',
        '// ---------------------------------------------------------------------------',
        ''
    ].join('\n');

    return before + generatedHeader + body + '\n' + after;
}

// ---------------------------------------------------------------------------
// Augmentation builder
// ---------------------------------------------------------------------------

async function buildAugmentation(manifest, projectRoot) {
    const data = manifest && typeof manifest === 'object' ? manifest.data : null;
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
        return '// No data sources declared in manifest.json.\nexport interface ManifestSources { [sourceName: string]: any }';
    }

    const contract = await loadContract(manifest, projectRoot);
    const sourceTypes = [];
    const augmentations = [];

    for (const [name, config] of Object.entries(data)) {
        const inferred = await inferSourceType(name, config, projectRoot, manifest, contract);
        if (!inferred) continue;
        sourceTypes.push(inferred.typeBlock);
        augmentations.push(`    ${jsonKey(name)}: ${inferred.augmentationType};`);
    }

    const lines = [];
    lines.push('// ---------------------------------------------------------------------------');
    lines.push('// Inferred row types for each data source.');
    lines.push('// ---------------------------------------------------------------------------');
    lines.push('');
    for (const block of sourceTypes) {
        lines.push(block);
        lines.push('');
    }
    lines.push('export interface ManifestSources {');
    lines.push.apply(lines, augmentations);
    lines.push('    /** Sources added at runtime ($x.$register) or since the last generation. */');
    lines.push('    [sourceName: string]: any;');
    lines.push('}');
    return lines.join('\n');
}

// The project's shared contract (manifest.json `contract`), for Appwrite column names
async function loadContract(manifest, projectRoot) {
    const c = manifest.contract;
    const ref = c && typeof c === 'object' ? c.module : c;
    if (typeof ref !== 'string' || !ref) return null;
    const file = resolve(projectRoot, ref.replace(/^\/+/, ''));
    if (!existsSync(file)) {
        console.warn(`mnfst-types: contract ${ref} not found; Appwrite rows stay loose`);
        return null;
    }
    try {
        const mod = await import(`${pathToFileURL(file).href}?mtime=${statSync(file).mtimeMs}`);
        return mod && mod.tables && typeof mod.tables === 'object' ? mod.tables : null;
    } catch (e) {
        console.warn(`mnfst-types: contract ${ref} failed to load (${e.message}); Appwrite rows stay loose`);
        return null;
    }
}

function contractColumns(tables, manifest, config) {
    if (!tables) return null;
    const defaultDb = manifest.appwrite && (manifest.appwrite.databaseId || manifest.appwrite.database);
    const db = config.appwriteDatabaseId || defaultDb;
    const hit = Object.entries(tables).find(([key, t]) => t && (t.id || key) === config.appwriteTableId && (!t.database || !db || t.database === db));
    return hit && Array.isArray(hit[1].columns) ? { key: hit[0], columns: hit[1].columns.filter((c) => typeof c === 'string') } : null;
}

// ---------------------------------------------------------------------------
// Source-shape inference
// ---------------------------------------------------------------------------

async function inferSourceType(name, config, projectRoot, manifest = {}, contract = null) {
    const safeName = toTypeName(name);

    // Appwrite bucket (storage).
    if (config && typeof config === 'object' && config.appwriteBucketId) {
        return {
            typeBlock: `// ${name}: Appwrite storage bucket`,
            augmentationType: 'ManifestBucketSource'
        };
    }

    // Appwrite table: column names from the contract when it declares the table.
    if (config && typeof config === 'object' && config.appwriteTableId) {
        const rowType = `Row_${safeName}`;
        const declared = contractColumns(contract, manifest, config);
        const typeBlock = declared
            ? [
                `/** Row shape for $x.${name}: columns of "${declared.key}" in the contract (declare ManifestRows.${name} for precise types). */`,
                `export type ${rowType} = ManifestRowSystem & {`,
                ...declared.columns.map((c) => `    ${jsonKey(c)}: any;`),
                `};`
            ].join('\n')
            : [
                `/** Row shape for $x.${name} (Appwrite table; add it to the contract, or declare ManifestRows.${name}, for checked columns). */`,
                `export type ${rowType} = ManifestRowSystem & { [field: string]: any };`
            ].join('\n');
        return {
            typeBlock,
            augmentationType: `ManifestTableSource<ManifestRowFor<${JSON.stringify(name)}, ${rowType}>>`
        };
    }

    // String — direct path/URL to a CSV/JSON/YAML file.
    if (typeof config === 'string') {
        const sample = sampleLocalFile(config, projectRoot);
        return formatLocalSource(name, safeName, sample);
    }

    // Object — could be a localized source (`locales:` or per-locale keys), an
    // HTTP endpoint with `url`, or an explicit defaultValue.
    if (config && typeof config === 'object') {
        if (typeof config.locales === 'string') {
            const sample = sampleLocalFile(config.locales, projectRoot);
            return formatLocalSource(name, safeName, sample);
        }

        // Per-locale keys — sample the first one we find.
        const localeKey = Object.keys(config).find((k) => /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(k));
        if (localeKey && typeof config[localeKey] === 'string') {
            const sample = sampleLocalFile(config[localeKey], projectRoot);
            return formatLocalSource(name, safeName, sample);
        }

        if (typeof config.url === 'string') {
            return {
                typeBlock: `// ${name}: HTTP source — row type left generic.`,
                augmentationType: 'ManifestArraySource<any>'
            };
        }
    }

    return {
        typeBlock: `// ${name}: shape could not be inferred — leaving as ManifestArraySource<any>.`,
        augmentationType: 'ManifestArraySource<any>'
    };
}

function formatLocalSource(name, safeName, sample) {
    if (!sample) {
        return {
            typeBlock: `// ${name}: file not found at sample time.`,
            augmentationType: 'ManifestArraySource<any>'
        };
    }
    if (sample.kind === 'array') {
        const rowType = `Row_${safeName}`;
        const fields = formatFields(sample.fields, '    ');
        const typeBlock = [
            `/** Row shape for $x.${name} inferred from ${sample.path}. */`,
            `export interface ${rowType} {`,
            fields,
            `}`
        ].filter(Boolean).join('\n');
        return {
            typeBlock,
            augmentationType: `ManifestArraySource<${rowType}>`
        };
    }
    if (sample.kind === 'object') {
        const objType = `Obj_${safeName}`;
        const typeBlock = [
            `/** Object shape for $x.${name} inferred from ${sample.path}. */`,
            `export interface ${objType} ${formatObjectShape(sample.shape, '')}`
        ].join('\n');
        return {
            typeBlock,
            augmentationType: `ManifestObjectSource<${objType}>`
        };
    }
    return {
        typeBlock: `// ${name}: empty or unrecognized sample.`,
        augmentationType: 'ManifestArraySource<any>'
    };
}

// ---------------------------------------------------------------------------
// Local file sampling (CSV / JSON / YAML)
// ---------------------------------------------------------------------------

function sampleLocalFile(filePath, projectRoot) {
    if (typeof filePath !== 'string') return null;
    if (filePath.startsWith('http://') || filePath.startsWith('https://')) return null;
    const cleaned = filePath.replace(/^\/+/, '');
    const candidates = [
        isAbsolute(filePath) ? filePath : null,
        join(projectRoot, cleaned),
        join(projectRoot, filePath)
    ].filter(Boolean);

    let resolved = null;
    for (const c of candidates) {
        try {
            if (existsSync(c) && statSync(c).isFile()) {
                resolved = c;
                break;
            }
        } catch (_) { /* skip */ }
    }
    if (!resolved) return null;

    const lower = resolved.toLowerCase();
    try {
        if (lower.endsWith('.csv')) return { ...sampleCsv(resolved), path: filePath };
        if (lower.endsWith('.json')) return { ...sampleJson(resolved), path: filePath };
        if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return { ...sampleYaml(resolved), path: filePath };
    } catch (e) {
        return null;
    }
    return null;
}

function sampleCsv(path) {
    const text = readFileSync(path, 'utf8');
    const rows = parseCsv(text);
    if (rows.length === 0) return { kind: 'array', fields: {} };
    const header = rows[0];
    const sampleRows = rows.slice(1, 51);
    const firstHeader = (header[0] || '').toLowerCase();

    // Same rule as the runtime: a table only when the first header is `id`, there
    // are 3+ columns and most of the first values look like ids; else key → value
    const idLike = (v) => !!v && (/^\d+$/.test(v) || (v.length < 20 && !v.includes('.')));
    const firstFive = sampleRows.slice(0, 5);
    const tabular = header.length > 2 && firstHeader === 'id' && firstFive.filter((r) => idLike(r[0])).length >= firstFive.length * 0.6;
    if (!tabular) {
        const shape = {};
        for (const row of sampleRows) {
            if (!row[0]) continue;
            assignDottedKey(shape, row[0], row[1]);
        }
        return { kind: 'object', shape };
    }

    // Tabular: array of rows with the header as field names.
    const fields = {};
    for (const col of header) {
        if (!col) continue;
        fields[col] = inferFieldType(sampleRows.map((r) => r[header.indexOf(col)]));
    }
    return { kind: 'array', fields };
}

function sampleJson(path) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(data)) {
        const sample = data.slice(0, 50);
        const fields = {};
        for (const item of sample) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                for (const [k, v] of Object.entries(item)) {
                    if (!fields[k]) fields[k] = [];
                    fields[k].push(v);
                }
            }
        }
        const out = {};
        for (const [k, vals] of Object.entries(fields)) {
            out[k] = inferFieldTypeFromValues(vals);
        }
        return { kind: 'array', fields: out };
    }
    if (data && typeof data === 'object') {
        return { kind: 'object', shape: shapeFromValue(data, 0) };
    }
    return { kind: 'object', shape: {} };
}

function sampleYaml(path) {
    let yaml;
    try { yaml = require('js-yaml'); } catch {
        return null;
    }
    const data = yaml.load(readFileSync(path, 'utf8'));
    if (Array.isArray(data)) {
        return sampleJsonFromObject(data);
    }
    if (data && typeof data === 'object') {
        return { kind: 'object', shape: shapeFromValue(data, 0) };
    }
    return { kind: 'object', shape: {} };
}

function sampleJsonFromObject(arr) {
    const sample = arr.slice(0, 50);
    const fields = {};
    for (const item of sample) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            for (const [k, v] of Object.entries(item)) {
                if (!fields[k]) fields[k] = [];
                fields[k].push(v);
            }
        }
    }
    const out = {};
    for (const [k, vals] of Object.entries(fields)) {
        out[k] = inferFieldTypeFromValues(vals);
    }
    return { kind: 'array', fields: out };
}

// ---------------------------------------------------------------------------
// CSV parsing (header + rows, RFC-4180-ish: handles quotes and escapes)
// ---------------------------------------------------------------------------

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else { inQuotes = false; }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') { inQuotes = true; continue; }
        if (ch === ',') { row.push(field); field = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function assignDottedKey(target, dottedKey, value) {
    const parts = dottedKey.split('.');
    let cur = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        const isIndex = /^\d+$/.test(part);
        if (isIndex) {
            // Numeric segment indicates an array element; we still model as object for typing.
            if (!cur._array) cur._array = true;
        }
        if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
        cur = cur[part];
    }
    const leaf = parts[parts.length - 1];
    cur[leaf] = inferLiteralType(value);
}

// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------

function inferFieldType(values) {
    return inferFieldTypeFromValues(values);
}

function inferFieldTypeFromValues(values) {
    let sawNumber = false, sawBool = false, sawString = false, sawNull = false, sawObject = false, sawArray = false;
    for (const v of values) {
        if (v === undefined || v === null || v === '') { sawNull = true; continue; }
        if (typeof v === 'number') { sawNumber = true; continue; }
        if (typeof v === 'boolean') { sawBool = true; continue; }
        if (Array.isArray(v)) { sawArray = true; continue; }
        if (typeof v === 'object') { sawObject = true; continue; }
        if (typeof v === 'string') {
            const t = v.trim();
            if (t === 'true' || t === 'false') { sawBool = true; continue; }
            if (t !== '' && !isNaN(Number(t))) { sawNumber = true; continue; }
            sawString = true;
        }
    }
    const parts = [];
    if (sawString) parts.push('string');
    if (sawNumber) parts.push('number');
    if (sawBool) parts.push('boolean');
    if (sawArray) parts.push('unknown[]');
    if (sawObject) parts.push('Record<string, unknown>');
    if (sawNull) parts.push('null');
    if (parts.length === 0) return 'string';
    return parts.join(' | ');
}

function inferLiteralType(value) {
    if (value === undefined || value === null || value === '') return 'string';
    const s = String(value).trim();
    if (s === 'true' || s === 'false') return 'boolean';
    if (!isNaN(Number(s))) return 'number';
    return 'string';
}

function shapeFromValue(value, depth) {
    if (depth > 5 || value === null || value === undefined) return 'unknown';
    if (Array.isArray(value)) {
        if (value.length === 0) return 'unknown[]';
        const inner = shapeFromValue(value[0], depth + 1);
        if (typeof inner === 'object' && inner !== null) {
            return inlineShape(inner) + '[]';
        }
        return inner + '[]';
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = shapeFromValue(v, depth + 1);
        }
        return out;
    }
    return typeof value;
}

function inlineShape(tree) {
    if (typeof tree === 'string') return tree;
    if (typeof tree !== 'object' || tree === null) return 'unknown';
    const parts = [];
    for (const [k, v] of Object.entries(tree)) {
        if (k === '_array') continue;
        parts.push(`${jsonKey(k)}: ${inlineShape(v)}`);
    }
    return parts.length === 0 ? 'Record<string, unknown>' : `{ ${parts.join('; ')} }`;
}

// ---------------------------------------------------------------------------
// Type rendering
// ---------------------------------------------------------------------------

function formatFields(fields, indent) {
    return Object.entries(fields)
        .map(([k, t]) => `${indent}${jsonKey(k)}: ${t};`)
        .join('\n');
}

function formatObjectShape(shape, indent) {
    if (typeof shape === 'string') return shape;
    if (typeof shape !== 'object' || shape === null) return 'unknown';
    const inner = indent + '    ';
    const lines = [];
    for (const [k, v] of Object.entries(shape)) {
        if (k === '_array') continue;
        const formatted = typeof v === 'object' && v !== null && !Array.isArray(v)
            ? formatObjectShape(v, inner)
            : v;
        lines.push(`${inner}${jsonKey(k)}: ${formatted};`);
    }
    return `{\n${lines.join('\n')}\n${indent}}`;
}

function jsonKey(name) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function toTypeName(name) {
    return name.replace(/[^A-Za-z0-9_$]/g, '_');
}
