/**
 * x-markdown present at boot, loaded through the loader (lib/manifest.js): .safe renders sanitized,
 * plain renders, and .safe never falls back to unsanitized HTML when DOMPurify can't load.
 * CDN requests are served from node_modules (same pinned bytes, so SRI holds).
 *
 * Run: npm run build && node tests/e2e/markdown-boot.e2e.mjs
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const hostile = `# Hi\n\n<img src="x" onerror="hit('onerror')"><span x-init="hit('xinit')">s</span>`
const page = `<!doctype html><html><head>
<script>window.__hits=[];window.hit=(n)=>window.__hits.push(n);window.D=${JSON.stringify({ hostile, plain: '# Plain\n\n**bold**' })}</script>
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="markdown"></script>
</head><body x-data="D">
<div id="safe" x-markdown.safe="hostile"></div>
<div id="safelit" x-markdown.safe="'# Literal'"></div>
<div id="plain" x-markdown="plain"></div>
<div id="plainlit" x-markdown="'# Plain literal'"></div>
</body></html>`

const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/') { res.setHeader('content-type', 'text/html'); return res.end(page) }
    if (p.startsWith('/fw/')) {
        const file = path.join(ROOT, 'lib', p.slice(4))
        if (!fs.existsSync(file)) { res.statusCode = 404; return res.end() }
        res.setHeader('content-type', p.endsWith('.css') ? 'text/css' : 'text/javascript')
        return res.end(fs.readFileSync(file))
    }
    res.statusCode = 404; res.end()
}).listen(0)
const base = `http://localhost:${server.address().port}`

// https://cdn.jsdelivr.net/npm/<pkg>@<ver>/<path> → node_modules/<pkg>/<path>
const fromNodeModules = (url) => {
    const m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/)
    if (!m) return null
    const file = path.join(ROOT, 'node_modules', m[1], m[2])
    return fs.existsSync(file) ? fs.readFileSync(file) : null
}

async function run(browser, { blockPurify = false } = {}) {
    const tab = await browser.newPage()
    const requested = []
    await tab.setRequestInterception(true)
    tab.on('request', r => {
        const url = r.url()
        if (url.startsWith(base)) return r.continue()
        requested.push(url)
        if (blockPurify && url.includes('dompurify')) return r.abort()
        const body = fromNodeModules(url)
        if (!body) return r.abort()
        r.respond({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body })
    })
    await tab.goto(`${base}/`, { waitUntil: 'load' })
    await tab.waitForFunction(() => document.querySelector('#plain h1') && document.querySelector('#plainlit h1'), { timeout: 15000 }).catch(() => { })
    await tab.waitForFunction(() => document.querySelector('#safe').childNodes.length && document.querySelector('#safelit').childNodes.length, { timeout: 5000 }).catch(() => { })
    await new Promise(r => setTimeout(r, 500))
    const r = await tab.evaluate(() => {
        const q = (s) => document.querySelector(s)
        return {
            hits: window.__hits,
            safe: q('#safe').innerHTML, safeOpacity: q('#safe').style.opacity,
            safelit: q('#safelit').innerHTML,
            plain: q('#plain').innerHTML, plainlit: q('#plainlit').innerHTML,
        }
    })
    await tab.close()
    return { ...r, purifyRequested: requested.some(u => u.includes('dompurify')) }
}

const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const a = await run(browser)
    check('boot .safe requests DOMPurify', a.purifyRequested)
    check('boot .safe expression renders', /<h1[^>]*>Hi<\/h1>/.test(a.safe) && a.safeOpacity !== '0', a.safe)
    check('boot .safe literal renders', /<h1[^>]*>Literal<\/h1>/.test(a.safelit), a.safelit)
    check('boot .safe output is sanitized', !/onerror|x-init/.test(a.safe) && a.hits.length === 0, { safe: a.safe, hits: a.hits })
    check('boot plain expression renders', /<h1[^>]*>Plain<\/h1>/.test(a.plain) && a.plain.includes('<strong>bold</strong>'), a.plain)
    check('boot plain literal renders', /<h1[^>]*>Plain literal<\/h1>/.test(a.plainlit), a.plainlit)

    const b = await run(browser, { blockPurify: true })
    check('DOMPurify blocked: .safe never emits HTML', !/<(h1|img|span)/.test(b.safe) && !/<h1/.test(b.safelit) && b.hits.length === 0, { safe: b.safe, safelit: b.safelit, hits: b.hits })
    check('DOMPurify blocked: plain still renders', /<h1/.test(b.plain), b.plain)
} finally {
    await browser.close()
    server.close()
}
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
