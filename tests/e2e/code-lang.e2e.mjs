/**
 * Code fence languages in real Chromium, loaded through the loader (lib/manifest.js):
 * console sessions use the shell grammar, fence names are case-insensitive, and on a page
 * mixing explicit and auto-detect blocks the lean core never replaces the 36-language full
 * bundle (its import is delayed so it resolves after the bundle, the case that clobbered it).
 * highlight.js comes from jsDelivr / esm.run (network needed).
 *
 * Run: npm run build && node tests/e2e/code-lang.e2e.mjs
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

const blocks = {
    console: ['console', '$ echo "hi"\nhi'],
    shellsession: ['shellsession', '$ ls -la'],
    env: ['ENV', 'API_URL="https://x.dev" # comment'],
    vue: ['Vue', '&lt;template&gt;&lt;div class="a"&gt;x&lt;/div&gt;&lt;/template&gt;'],
    csv: ['CSV', 'a,b\n1,2'],
    sh: ['sh', 'export A=1'],
    docker: ['Dockerfile', 'FROM node:20\nRUN npm ci'],
}
const explicit = Object.entries(blocks).map(([id, [lang, src]]) => `<pre id="${id}" x-code="${lang}">${src}</pre>`).join('\n')
const pageFor = (withAuto) => `<!doctype html><html><head>
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="code"></script>
</head><body>
${explicit}
${withAuto ? '<pre id="auto" x-code>function add(a, b) { return a + b }</pre>\n<pre id="late" x-code="elixir">defmodule A do\nend</pre>' : ''}
</body></html>`

const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/manifest.json') { res.setHeader('content-type', 'application/json'); return res.end('{"name":"x"}') }
    if (u.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(pageFor(u.searchParams.has('auto'))) }
    if (u.pathname.startsWith('/fw/')) {
        const file = path.join(ROOT, 'lib', u.pathname.slice(4))
        if (!fs.existsSync(file)) { res.statusCode = 404; return res.end() }
        res.setHeader('content-type', u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript')
        return res.end(fs.readFileSync(file))
    }
    res.statusCode = 404; res.end()
}).listen(0)
const base = `http://localhost:${server.address().port}`

async function run(browser, query) {
    const tab = await browser.newPage()
    const bad = []
    const urls = []
    await tab.setRequestInterception(true)
    tab.on('request', r => {
        const url = r.url()
        urls.push(url)
        // Delay the lean core so it lands after the full bundle
        if (url.includes('esm.run/highlight.js@11.11.1/lib/core')) return setTimeout(() => r.continue(), 2000)
        r.continue()
    })
    tab.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`) })
    tab.on('requestfailed', r => bad.push(`failed ${r.url()}`))
    await tab.goto(`${base}/${query}`, { waitUntil: 'load' })
    await tab.waitForFunction(() => [...document.querySelectorAll('pre[x-code]')].every(p => p.querySelector('code')?.className), { timeout: 20000 }).catch(() => { })
    await new Promise(r => setTimeout(r, 3000))
    const r = await tab.evaluate(() => {
        const out = {}
        for (const pre of document.querySelectorAll('pre[x-code]')) {
            const code = pre.querySelector('code')
            out[pre.id] = { cls: code?.className || '', tokens: [...new Set([...(code?.querySelectorAll('[class^="hljs-"]') || [])].map(s => s.className))] }
        }
        const langs = typeof window.hljs?.listLanguages === 'function' ? window.hljs.listLanguages() : []
        return { blocks: out, langCount: langs.length, hasPython: langs.includes('python'), hasDocker: langs.includes('dockerfile') }
    })
    await tab.close()
    return { ...r, bad, urls }
}

const browser = await puppeteer.launch({ headless: 'shell' })
try {
    for (const [label, query] of [['lean page', ''], ['mixed page', '?auto']]) {
        const a = await run(browser, query)
        const b = a.blocks
        check(`${label}: console uses shell, prompt + bash tokens`, b.console.cls.includes('language-shell') && b.console.tokens.some(t => t.startsWith('hljs-meta')) && b.console.tokens.includes('hljs-built_in'), b.console)
        check(`${label}: shellsession uses shell`, b.shellsession.cls.includes('language-shell'), b.shellsession)
        check(`${label}: sh stays bash`, b.sh.cls.includes('language-bash'), b.sh)
        check(`${label}: ENV highlights as bash`, b.env.cls.includes('language-bash') && b.env.tokens.includes('hljs-comment'), b.env)
        check(`${label}: Vue highlights as xml`, b.vue.cls.includes('language-xml') && b.vue.tokens.includes('hljs-tag'), b.vue)
        check(`${label}: CSV renders plain`, b.csv.cls.includes('language-plaintext') && b.csv.tokens.length === 0, b.csv)
        check(`${label}: Dockerfile loads its grammar`, b.docker.cls.includes('language-dockerfile') && b.docker.tokens.includes('hljs-keyword'), b.docker)
        check(`${label}: no failed requests`, a.bad.length === 0, a.bad)
        check(`${label}: no request for an uppercase or unaliased grammar`, !a.urls.some(u => /languages\/(ENV|Vue|CSV|Dockerfile|env|csv|vue|console|shellsession)\b/.test(u)), a.urls.filter(u => u.includes('languages/')))
        if (query) {
            check(`${label}: auto block detected`, /language-\w+/.test(b.auto.cls), b.auto)
            check(`${label}: full bundle kept on window.hljs`, a.langCount >= 36 && a.hasPython && a.hasDocker, { count: a.langCount, python: a.hasPython, dockerfile: a.hasDocker })
            check(`${label}: explicit grammar outside the bundle loads`, b.late.cls.includes('language-elixir'), b.late)
        } else {
            check(`${label}: no full bundle`, !a.urls.some(u => u.includes('highlight.min.js')), a.urls.filter(u => u.includes('highlight')))
        }
    }
} finally {
    await browser.close()
    server.close()
}
console.log(failures.length ? `\n${failures.length} failed` : '\nall passed')
process.exit(failures.length ? 1 : 0)
