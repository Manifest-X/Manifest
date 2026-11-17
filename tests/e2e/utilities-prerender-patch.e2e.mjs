/**
 * Runtime utility patches on a prerendered page with a publish bake, in real Chromium.
 *
 * mnfst-render builds the page (Tailwind CLI → prerender.tailwind.css), then a bake
 * (compileUtilities) is linked after manifest.css as publish does. The runtime must not
 * append a bare utility after the shipped sheets without its breakpoint partners:
 *
 *   a) text-3xl md:text-5xl — the bake lacks text-3xl (as on the reported site) but
 *      prerender.tailwind.css has it: 30px below md (600), 48px at 800 and 1440
 *   b) text-xl md:text-4xl — text-xl is in neither sheet, so the runtime must emit it,
 *      and md:text-4xl after it: 20px at 600, 36px at 800 and 1440
 *
 * Line-height is checked where a sheet sets it, catching the split signature
 * (font-size from the bare rule, line-height from the md: one).
 *
 * Run: npm run build && node tests/e2e/utilities-prerender-patch.e2e.mjs
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { compileUtilities } = await import(pathToFileURL(path.join(ROOT, 'lib', 'manifest.utilities.node.mjs')).href)

const CLASSES = ['text-3xl', 'md:text-5xl', 'text-xl', 'md:text-4xl', 'row']
const INDEX = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="stylesheet" href="/fw/manifest.css">
<script src="/fw/manifest.min.js" data-plugin-base="/fw" data-plugins="router,utilities" data-tailwind></script></head>
<body>
  <h1 id="a" class="text-3xl md:text-5xl">a</h1>
  <h2 id="b" class="text-xl md:text-4xl">b</h2>
  <div class="row">r</div>
</body></html>`

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// Drop one class's top-level rule (Tailwind's nested or flat form)
const dropRule = (css, cls) => css.replace(new RegExp(`\\.${cls.replace(/[:]/g, '\\\\$&')}\\s*\\{[^{}]*\\}`, 'g'), '')

async function build() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'mnfst-prerender-patch-'))
    fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'fw'), { recursive: true })
    // Published sites load the minified loader name; render keys Tailwind detection off it
    fs.copyFileSync(path.join(dir, 'fw', 'manifest.js'), path.join(dir, 'fw', 'manifest.min.js'))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'x', render: { paths: ['/'] } }))
    fs.writeFileSync(path.join(dir, 'index.html'), INDEX)
    const r = spawnSync('node', [path.join(ROOT, 'packages', 'render', 'bin', 'mnfst-render.js')], {
        cwd: dir, encoding: 'utf8', timeout: 240000, env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }
    })
    const out = path.join(dir, 'website')
    const twPath = path.join(out, 'prerender.tailwind.css')
    check('prerender: exit 0 with prerender.tailwind.css', r.status === 0 && fs.existsSync(twPath), (r.stdout + r.stderr).split('\n').slice(-6).join(' / '))
    fs.writeFileSync(twPath, dropRule(fs.readFileSync(twPath, 'utf8'), 'text-xl'))

    const bake = await compileUtilities({
        classes: CLASSES.filter((c) => c !== 'text-3xl'),
        baseCss: fs.readFileSync(path.join(ROOT, 'lib', 'manifest.css'), 'utf8')
    })
    fs.writeFileSync(path.join(out, 'manifest.utilities.css'), dropRule(bake, 'text-xl'))
    const htmlPath = path.join(out, 'index.html')
    const html = fs.readFileSync(htmlPath, 'utf8')
    check('prerender: page links prerender.tailwind.css', html.includes('prerender.tailwind.css'))
    fs.writeFileSync(htmlPath, html.replace(/(<link rel="stylesheet" href="\/fw\/manifest\.css">)/, '$1<link rel="stylesheet" href="/manifest.utilities.css?v=dep_test" data-mnfst-utilities>'))
    return { dir, out }
}

function serve(out) {
    const server = http.createServer((req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
        if (p.endsWith('/')) p += 'index.html'
        const file = path.join(out, p)
        if (!file.startsWith(out) || !fs.existsSync(file)) { res.writeHead(404); return res.end() }
        const type = p.endsWith('.css') ? 'text/css' : p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : 'text/html'
        res.writeHead(200, { 'Content-Type': type })
        res.end(fs.readFileSync(file))
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://localhost:${server.address().port}`, close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) }) })))
}

const WANT = { 600: { a: ['30px', '36px'], b: ['20px', null] }, 800: { a: ['48px', '48px'], b: ['36px', '40px'] }, 1440: { a: ['48px', '48px'], b: ['36px', '40px'] } }

async function main() {
    const { dir, out } = await build()
    fs.cpSync(path.join(dir, 'fw'), path.join(out, 'fw'), { recursive: true })
    const srv = await serve(out)
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
    try {
        for (const width of [600, 800, 1440]) {
            const ctx = await browser.createBrowserContext()
            const page = await ctx.newPage()
            await page.setViewport({ width, height: 900 })
            await page.goto(srv.url + '/', { waitUntil: 'load' })
            // Let the runtime finish its first compile (or decide there's nothing to do)
            await page.waitForFunction(() => window.__manifestUtilitiesReady === true || window.__manifestReady === true, { timeout: 15000 }).catch(() => { })
            await new Promise((r) => setTimeout(r, 1200))
            const got = await page.evaluate(() => Object.fromEntries(['a', 'b'].map((id) => {
                const s = getComputedStyle(document.getElementById(id))
                return [id, [s.fontSize, s.lineHeight]]
            })))
            const want = WANT[width]
            for (const id of ['a', 'b']) {
                check(`@${width}px ${id}: font-size ${want[id][0]}`, got[id][0] === want[id][0], JSON.stringify(got[id]))
                if (want[id][1]) check(`@${width}px ${id}: line-height ${want[id][1]} (same breakpoint as font-size)`, got[id][1] === want[id][1], JSON.stringify(got[id]))
            }
            await ctx.close()
        }
    } finally {
        await browser.close()
        await srv.close()
        fs.rmSync(dir, { recursive: true, force: true })
    }
    console.log(failed ? `\n${failed} failed` : '\nall passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
