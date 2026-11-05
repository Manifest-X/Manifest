// Golden journeys in a real browser (puppeteer): fake data, screenshots, diffs.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakeAppwrite } from './fake.mjs';

const MIME = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.csv': 'text/csv', '.yaml': 'text/yaml', '.yml': 'text/yaml',
    '.md': 'text/markdown', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain'
};

const STABILISE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}`;

// Appwrite Web SDK script tags (CDN or self-hosted) are answered with the fake
const APPWRITE_SDK = /\/(appwrite)(@[^/]*)?(\/dist\/[^?]*)?(\?.*)?$/;

// Static server with SPA fallback; mounts map URL prefixes to extra dirs
export async function serve(root, { mounts = {}, spa = true } = {}) {
    const bases = [['/', resolve(root)], ...Object.entries(mounts).map(([p, d]) => [p.endsWith('/') ? p : p + '/', resolve(d)])]
        .sort((a, b) => b[0].length - a[0].length);
    const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
    const server = createServer((req, res) => {
        try { handle(req, res); } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    function handle(req, res) {
        let path;
        try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return res.writeHead(400).end(); }
        if (path.includes('\0')) return res.writeHead(400).end();
        const [prefix, dir] = bases.find(([p]) => path.startsWith(p));
        let file = resolve(dir, '.' + path.slice(prefix.length - 1));
        if (file !== dir && !file.startsWith(dir + sep)) return res.writeHead(403).end();
        if (!isFile(file) && isFile(join(file, 'index.html'))) file = join(file, 'index.html');
        else if (!isFile(file) && !extname(file) && isFile(file + '.html')) file += '.html';
        if (!isFile(file) && spa && !extname(path)) file = join(bases.find(([p]) => p === '/')[1], 'index.html');
        if (!isFile(file)) return res.writeHead(path === '/favicon.ico' ? 204 : 404).end();
        res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(readFileSync(file));
    }
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

async function loadPuppeteer(given) {
    if (given) return given;
    try {
        const m = await import('puppeteer');
        return m.default || m;
    } catch {
        throw new Error('mnfst-test browser journeys need puppeteer:\n  npm install -D puppeteer');
    }
}

function fakeScript(options) {
    return `(() => {
        const fake = (${createFakeAppwrite.toString()})(${JSON.stringify(options)});
        window.__manifestFake = fake;
        Object.defineProperty(window, 'Appwrite', { configurable: true, get: () => fake.sdk, set: () => {} });
    })();`;
}

// Pixel diff inside Chromium: no image dependencies
async function diffPngs(page, a, b, threshold) {
    return page.evaluate(async (a, b, threshold) => {
        const load = (src) => new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = 'data:image/png;base64,' + src; });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        if (ia.width !== ib.width || ia.height !== ib.height) {
            return { sizeMismatch: true, expected: [ia.width, ia.height], actual: [ib.width, ib.height] };
        }
        const w = ia.width, h = ia.height;
        const px = (img) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
        const da = px(ia), db = px(ib);
        const out = new ImageData(w, h);
        let diff = 0;
        const limit = threshold * 255;
        for (let i = 0; i < da.length; i += 4) {
            const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]));
            if (d > limit) { diff++; out.data.set([255, 0, 64, 255], i); }
            else { const g = (da[i] + da[i + 1] + da[i + 2]) / 3; out.data.set([g, g, g, 60], i); }
        }
        let image = null;
        if (diff) {
            const c = new OffscreenCanvas(w, h);
            c.getContext('2d').putImageData(out, 0, 0);
            const blob = await c.convertToBlob({ type: 'image/png' });
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let s = '';
            for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            image = btoa(s);
        }
        return { diff, total: w * h, image };
    }, a, b, threshold);
}

// Node-side handle on the in-page fake (window.__manifestFake)
function remoteFake(page) {
    const run = (fn, ...args) => page.evaluate(fn, ...args);
    return {
        table: (db, t) => {
            const op = (name) => (...args) => run((db, t, name, args) => window.__manifestFake.table(db, t)[name](...args), db, t, name, args);
            return { rows: op('rows'), get: op('get'), count: op('count'), insert: op('insert'), update: op('update'), remove: op('remove'), seed: op('seed'), clear: op('clear') };
        },
        calls: () => run(() => window.__manifestFake.calls),
        lastQueries: (t) => run((t) => window.__manifestFake.lastQueries(t), t),
        failNext: (method, error) => run((m, e) => window.__manifestFake.failNext(m, e), method, error),
        signIn: (user, teams) => run((u, t) => window.__manifestFake.signIn(u, t), user, teams),
        signOut: () => run(() => window.__manifestFake.signOut())
    };
}

export async function launch(config = {}) {
    const {
        root, baseURL, mounts, routes = [], viewport = { width: 1280, height: 800 },
        snapshots = 'tests/__screenshots__', update = false, ci = !!process.env.CI && process.env.CI !== 'false',
        threshold = 0.1, maxDiffPixels = 0, headless = true, launchOptions = {}
    } = config;
    const puppeteer = await loadPuppeteer(config.puppeteer);
    const server = root ? await serve(root, { mounts }) : null;
    const origin = (baseURL || server?.url || '').replace(/\/$/, '');
    if (!origin) throw new Error('launch: pass `root` (a project dir to serve) or `baseURL`');
    let browser;
    try {
        browser = await puppeteer.launch({ headless, args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars'], ...launchOptions });
    } catch (e) {
        if (server) await server.close();
        throw e;
    }
    const snapDir = resolve(snapshots);
    let diffPage = null;

    async function open(path = '/', opts = {}) {
        const page = await browser.newPage();
        await page.setViewport({ deviceScaleFactor: 1, ...viewport, ...(opts.viewport || {}) });
        const errors = [];
        page.on('pageerror', e => errors.push(String(e?.message || e)));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        const fakeOptions = opts.fake === undefined ? config.fake : opts.fake;
        if (fakeOptions) await page.evaluateOnNewDocument(fakeScript(fakeOptions));
        const allRoutes = [...routes, ...(opts.routes || [])];
        if (fakeOptions || allRoutes.length) {
            await page.setRequestInterception(true);
            page.on('request', req => {
                const url = req.url();
                const route = allRoutes.find(r => typeof r.url === 'string' ? url.startsWith(r.url) : r.url.test(url));
                if (route) {
                    const body = route.file ? readFileSync(typeof route.file === 'function' ? route.file(url) : route.file) : (route.body ?? '');
                    return req.respond({ status: route.status || 200, contentType: route.contentType || MIME[extname(new URL(url).pathname)] || 'text/plain', body });
                }
                if (fakeOptions && req.resourceType() === 'script' && APPWRITE_SDK.test(new URL(url).pathname)) {
                    return req.respond({ status: 200, contentType: 'application/javascript', body: '/* Appwrite SDK replaced by mnfst-test fake */' });
                }
                req.continue();
            });
        }
        try {
            await page.goto(origin + path, { waitUntil: 'load' });
        } catch (e) {
            await page.close().catch(() => {});
            throw new Error(`${e.message}${errors.length ? `\n    console: ${errors.join('\n    console: ')}` : ''}`);
        }

        const journey = {
            page,
            errors,
            fake: remoteFake(page),
            name: opts.name || path,
            snapshots: [],
            // Evaluate an Alpine expression, e.g. x('$x.tasks.length')
            x: (expr) => page.evaluate(e => window.Alpine.evaluate(document.body, e), expr),
            async settle({ idle = 150, timeout = 10000 } = {}) {
                await page.waitForFunction(() => !!window.Alpine, { timeout });
                await page.waitForNetworkIdle({ idleTime: idle, timeout }).catch(() => {});
                await page.evaluate(() => document.fonts?.ready);
                await page.evaluate(() => new Promise(r => { setTimeout(r, 100); requestAnimationFrame(() => requestAnimationFrame(r)); }));
            },
            async waitForData(source, { timeout = 10000 } = {}) {
                await page.waitForFunction(s => {
                    try { const v = window.Alpine.evaluate(document.body, `$x.${s}`); return v && v.$ready && !v.$loading; } catch { return false; }
                }, { timeout }, source);
                await journey.settle();
            },
            async snap(name, { selector, fullPage = false, mask = [] } = {}) {
                await journey.settle();
                const style = await page.addStyleTag({ content: STABILISE_CSS + mask.map(s => `${s}{visibility:hidden!important}`).join('') });
                await page.evaluate(() => { document.activeElement?.blur?.(); });
                const target = selector ? await page.$(selector) : page;
                if (!target) throw new Error(`snap(${name}): no element matches ${selector}`);
                const actual = Buffer.from(await target.screenshot({ type: 'png', ...(selector ? {} : { fullPage }) }));
                await style.evaluate(el => el.remove());
                const file = join(snapDir, `${slug(journey.name)}--${slug(name)}-${process.platform}.png`);
                const result = { name, file, status: 'pass' };
                if (update || !existsSync(file)) {
                    if (!update && ci) { result.status = 'missing'; }
                    else { mkdirSync(snapDir, { recursive: true }); writeFileSync(file, actual); result.status = update ? 'updated' : 'new'; }
                } else {
                    diffPage ||= await browser.newPage();
                    const d = await diffPngs(diffPage, readFileSync(file).toString('base64'), actual.toString('base64'), threshold);
                    await page.bringToFront();
                    if (d.sizeMismatch || d.diff > maxDiffPixels) {
                        const failDir = join(snapDir, '__diff__');
                        mkdirSync(failDir, { recursive: true });
                        const stem = file.slice(snapDir.length + 1, -4);
                        writeFileSync(join(failDir, `${stem}-actual.png`), actual);
                        if (d.image) writeFileSync(join(failDir, `${stem}-diff.png`), Buffer.from(d.image, 'base64'));
                        result.status = 'fail';
                        result.message = d.sizeMismatch
                            ? `size ${d.actual.join('x')} != baseline ${d.expected.join('x')}`
                            : `${d.diff} of ${d.total} pixels differ`;
                        result.actual = join(failDir, `${stem}-actual.png`);
                    }
                }
                journey.snapshots.push(result);
                return result;
            },
            close: () => page.close()
        };
        return journey;
    }

    return {
        origin,
        browser,
        open,
        async close() {
            await browser.close();
            if (server) await server.close();
        }
    };
}

const slug = (s) => String(s).replace(/^\/+/, '').replace(/\//g, '~').replace(/[^a-z0-9._~-]+/gi, '-').replace(/^-+|-+$/g, '') || 'root';

// Run a list of journeys; a journey fails on a thrown step, a screenshot
// mismatch, a missing baseline under CI, or (by default) any console error
export async function runJourneys(config) {
    const { journeys = [], failOnConsoleError = true, log = console.log, filter } = config;
    const kit = await launch(config);
    const results = [];
    try {
        for (const j of journeys) {
            if (filter && !String(j.name).includes(filter)) continue;
            const r = { name: j.name, status: 'pass', snapshots: [], errors: [] };
            let journey = null;
            try {
                journey = await kit.open(j.path || '/', { name: j.name, fake: j.fake, viewport: j.viewport, routes: j.routes });
                await journey.settle();
                if (j.steps) await j.steps(journey);
            } catch (e) {
                r.status = 'fail';
                r.error = e?.message || String(e);
            }
            if (journey) {
                r.snapshots = journey.snapshots;
                r.errors = (j.ignoreErrors ? journey.errors.filter(e => !j.ignoreErrors.some(p => p instanceof RegExp ? p.test(e) : e.includes(p))) : journey.errors);
                if (r.snapshots.some(s => s.status === 'fail' || s.status === 'missing')) r.status = 'fail';
                if (failOnConsoleError && r.errors.length) r.status = 'fail';
                await journey.close().catch(() => {});
            }
            results.push(r);
            if (log) report(r, log);
        }
    } finally {
        await kit.close();
    }
    const failed = results.filter(r => r.status === 'fail').length;
    if (log) log(`\n${results.length - failed} passed, ${failed} failed (${kit.origin})`);
    return { ok: failed === 0, failed, results };
}

function report(r, log) {
    log(`${r.status === 'pass' ? '✓' : '✗'} ${r.name}`);
    if (r.error) log(`    error: ${r.error}`);
    for (const s of r.snapshots) {
        if (s.status !== 'pass') log(`    ${s.status === 'fail' ? '✗' : '•'} ${s.name}: ${s.status}${s.message ? ` (${s.message})` : ''}${s.actual ? `\n      actual: ${s.actual}` : ''}`);
    }
    for (const e of r.errors) log(`    console: ${e}`);
}

// `mnfst-test journeys <file> [--update] [--base-url <url>] [--root <dir>] [--ci] [--filter <name>] [--json]`
export async function cli(argv) {
    const args = { file: 'journeys.mjs' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--update' || a === '-u') args.update = true;
        else if (a === '--ci') args.ci = true;
        else if (a === '--json') args.json = true;
        else if (a === '--base-url') args.baseURL = argv[++i];
        else if (a === '--root') args.root = argv[++i];
        else if (a === '--filter') args.filter = argv[++i];
        else if (a === '-h' || a === '--help') { console.log(CLI_HELP); return 0; }
        else if (!a.startsWith('-')) args.file = a;
        else throw new Error(`unknown option ${a}`);
    }
    const file = resolve(args.file);
    const mod = await import(pathToFileURL(file).href);
    const config = { ...(mod.default || mod) };
    const here = dirname(file);
    if (config.root) config.root = resolve(here, config.root);
    if (config.snapshots) config.snapshots = resolve(here, config.snapshots);
    else config.snapshots = join(here, '__screenshots__');
    if (config.mounts) config.mounts = Object.fromEntries(Object.entries(config.mounts).map(([k, v]) => [k, resolve(here, v)]));
    if (args.baseURL) { config.baseURL = args.baseURL; delete config.root; }
    if (args.root) config.root = resolve(args.root);
    if (args.update) config.update = true;
    if (args.ci) config.ci = true;
    if (args.filter) config.filter = args.filter;
    if (args.json) config.log = null;
    const out = await runJourneys(config);
    if (args.json) console.log(JSON.stringify(out, null, 2));
    return out.ok ? 0 : 1;
}

const CLI_HELP = `mnfst-test journeys [file] [options]

Run golden journeys (default file: journeys.mjs) in headless Chrome.

  --update, -u        Rewrite screenshot baselines
  --base-url <url>    Run against a deployed site (e.g. staging) instead of serving root
  --root <dir>        Serve this directory instead of the config's root
  --ci                Fail when a baseline is missing (also on when CI is set)
  --filter <text>     Only journeys whose name contains text
  --json              Machine-readable results`;
