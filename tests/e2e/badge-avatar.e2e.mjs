/**
 * Badges and avatars in real Chromium with the built manifest.css: badge padding survives a prerendered
 * Tailwind stylesheet linked after it, badge .sm is smaller, color classes recolor avatars and status dots.
 *
 * Run: npm run build && node tests/e2e/badge-avatar.e2e.mjs
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const { stripTailwindPreflightConflicts } = await import(path.join(ROOT, 'src/scripts/manifest.render.mjs'))

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const preflight = fs.readFileSync(require.resolve('tailwindcss/preflight.css'), 'utf8')
const tailwind = stripTailwindPreflightConflicts(`@layer theme, base, components, utilities;\n@layer base {\n${preflight}\n}\n`)
const page = `<!doctype html><html><head>
<link rel="stylesheet" href="/lib/manifest.css">
<link rel="stylesheet" href="/prerender.tailwind.css">
</head><body style="font-size:16px">
<span class="badge" id="b">Default</span><span class="badge sm" id="bs">Small</span>
<div class="avatar" id="a">W<figure id="f"></figure></div>
${['brand', 'accent', 'positive', 'negative'].map(c => `<div class="avatar ${c}" id="a-${c}">W</div><div class="avatar"><span>W</span><figure class="${c}" id="f-${c}"></figure></div>`).join('')}
<button class="avatar brand" id="ab">W</button>
</body></html>`

const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page) }
    if (req.url === '/prerender.tailwind.css') { res.setHeader('content-type', 'text/css'); return res.end(tailwind) }
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]))
    if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end() }
    fs.readFile(file, (err, body) => {
        if (err) { res.statusCode = 404; return res.end() }
        res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'application/octet-stream')
        res.end(body)
    })
}).listen(0)
const base = `http://localhost:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const tab = await browser.newPage()
    await tab.goto(`${base}/`, { waitUntil: 'load' })
    const s = await tab.evaluate(() => {
        const cs = (id) => getComputedStyle(document.getElementById(id))
        const out = { badgePad: cs('b').paddingLeft, badgeFont: cs('b').fontSize, smFont: cs('bs').fontSize, avatar: cs('a').backgroundColor, figure: cs('f').backgroundColor }
        for (const c of ['brand', 'accent', 'positive', 'negative']) {
            out['a-' + c] = cs('a-' + c).backgroundColor
            out['f-' + c] = cs('f-' + c).backgroundColor
            out['ink-' + c] = cs('a-' + c).color
        }
        return out
    })
    check('badge keeps padding under a prerendered Tailwind stylesheet', parseFloat(s.badgePad) > 0, s.badgePad)
    check('badge .sm is smaller than the default badge', parseFloat(s.smFont) < parseFloat(s.badgeFont), [s.smFont, s.badgeFont])
    const colors = ['brand', 'accent', 'positive', 'negative']
    check('color classes recolor the avatar', colors.every(c => s['a-' + c] !== s.avatar), colors.map(c => s['a-' + c]))
    check('colored avatars differ from each other', new Set(colors.map(c => s['a-' + c])).size === 4)
    check('color classes recolor the status dot', colors.every(c => s['f-' + c] !== s.figure), colors.map(c => s['f-' + c]))
    const rest = await tab.evaluate(() => getComputedStyle(document.getElementById('ab')).backgroundColor)
    await tab.hover('#ab')
    await new Promise(r => setTimeout(r, 150))
    const hover = await tab.evaluate(() => getComputedStyle(document.getElementById('ab')).backgroundColor)
    check('a colored avatar button hovers to its own hover surface', hover !== rest && hover !== s.avatar && !/oklch\(0\.8\d* 0 0\)/.test(hover), [rest, hover])
} finally {
    await browser.close()
    server.close()
}
if (failures.length) { console.log(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nall passed')
