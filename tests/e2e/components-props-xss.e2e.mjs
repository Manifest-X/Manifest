/**
 * Component props never run data values as code (security audit H1), in real
 * Chromium, live and after mnfst-render.
 *
 *   a) x-for over a data source: payload titles/lists/classes/icons render as text, never run
 *   b) x-for over x-data: same
 *   c) benign rows still render (title, list items, x-show flag)
 *   d) static and bound-outside-x-for props keep working
 *   e) .camel bindings, x-bind objects and nested pass-through (outer → inner
 *      component) never hand data to a component as author text
 *   f) mnfst-render: the bake runs nothing, baked directives hold no payload,
 *      x-for components keep their tag in templates, the baked page runs nothing
 *
 * Run: npm run build && node tests/e2e/components-props-xss.e2e.mjs
 * FW_DIR=<dir> serves another build's lib (e.g. the old one, to see it fail).
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FW = process.env.FW_DIR ? path.resolve(process.env.FW_DIR) : path.join(ROOT, 'lib')
const ALPINE = path.join(ROOT, 'node_modules', 'alpinejs', 'dist', 'cdn.min.js')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const EVIL = {
    title: "$el.ownerDocument.defaultView.hit('x-text')",
    list: "[hit('x-for')]",
    cls: "$el.ownerDocument.defaultView.hit(':class')",
    icon: "hit('x-icon')",
    flag: "hit('x-show')"
}
const GOOD = { title: 'Hello', list: ['a', 'b'], cls: 'good', icon: '', flag: true }

const CARD = `<article class="card" :class="$modify('cls')">
  <h3 x-text="$modify('title')"></h3>
  <ul><template x-for="x in $modify('list')"><li x-text="x"></li></template></ul>
  <b class="flag" x-show="$modify('flag')">F</b>
  <i x-icon="$modify('icon')"></i>
</article>`

const CAMEL = `<article class="card"><h3 x-text="$modify('myTitle')"></h3></article>`
const OUTER = `<div class="outer"><x-card title="$modify('title')" list="$modify('list')" icon="$modify('icon')"></x-card></div>`

const FILES = {
    '/manifest.json': JSON.stringify({ name: 'x', components: ['components/card.html', 'components/camel.html', 'components/outer.html'], data: { posts: '/data/posts.json', site: '/data/site.json' } }),
    '/components/card.html': CARD,
    '/components/camel.html': CAMEL,
    '/components/outer.html': OUTER,
    '/data/posts.json': JSON.stringify([EVIL, GOOD]),
    '/data/site.json': JSON.stringify({ title: 'From site' })
}

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
<link rel="manifest" href="/manifest.json">
<script>window.__hits = []; window.hit = (k) => { window.__hits.push(k); return [] }</script>
<script src="/fw/manifest.js" data-plugin-base="/fw" data-plugins="components,data,icons" data-alpine="/alpine.js"></script></head>
<body x-data='{ local: ${JSON.stringify([EVIL, GOOD]).replace(/'/g, '&#39;')} }'>
  <section id="ds"><template x-for="p in $x.posts"><x-card :title="p.title" :list="p.list" :cls="p.cls" :icon="p.icon" :flag="p.flag"></x-card></template></section>
  <section id="xd"><template x-for="p in local"><x-card :title="p.title" :list="p.list" x-bind:cls="p.cls" :icon="p.icon" :flag="p.flag"></x-card></template></section>
  <section id="st"><x-card title="Static" list="['s1','s2','s3']" flag="yes"></x-card></section>
  <section id="bx"><x-card :title="$x.site.title"></x-card></section>
  <section id="camel"><template x-for="p in $x.posts"><x-camel :my-title.camel="p.title"></x-camel></template></section>
  <section id="xbo"><template x-for="p in $x.posts"><x-camel x-bind="{ myTitle: p.title }"></x-camel></template></section>
  <section id="xbl"><template x-for="p in $x.posts"><x-card x-bind="{ title: p.title, list: p.list }"></x-card></template></section>
  <section id="nest"><template x-for="p in $x.posts"><x-outer :title="p.title" :list="p.list" :icon="p.icon"></x-outer></template></section>
  <section id="bp"><div x-data="{ post: { title: 'Plain' } }"><x-card :title="post.title"></x-card></div></section>
</body></html>`

function serveDir(files, dir) {
    const server = http.createServer((req, res) => {
        const p = new URL(req.url, 'http://x').pathname
        if (p === '/alpine.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(ALPINE)) }
        if (p.startsWith('/fw/')) {
            const file = path.join(FW, p.slice(4))
            if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
            res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
            return res.end(fs.readFileSync(file))
        }
        const type = p.endsWith('.json') ? 'application/json' : 'text/html'
        if (dir) {
            const file = path.join(dir, p === '/' ? 'index.html' : p)
            if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': type }); return res.end(fs.readFileSync(file)) }
        } else {
            if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE) }
            if (files[p]) { res.writeHead(200, { 'Content-Type': type }); return res.end(files[p]) }
        }
        res.writeHead(404); res.end()
    })
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((c) => { server.closeAllConnections(); server.close(() => c()) })
    })))
}

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const snapshot = (pg) => pg.evaluate(() => {
    const cards = (id) => [...document.querySelectorAll(`#${id} article.card`)].map((c) => ({
        title: c.querySelector('h3')?.textContent,
        items: [...c.querySelectorAll('li')].map((li) => li.textContent),
        flag: !!c.querySelector('.flag') && getComputedStyle(c.querySelector('.flag')).display !== 'none',
        good: c.classList.contains('good')
    }))
    return { hits: window.__hits, ds: cards('ds'), xd: cards('xd'), st: cards('st'), bx: cards('bx'), bp: cards('bp'), camel: cards('camel'), xbo: cards('xbo'), xbl: cards('xbl'), nest: cards('nest') }
})

async function live(browser, label, url) {
    const pg = await browser.newPage()
    const errors = []
    pg.on('pageerror', (e) => errors.push(e.message))
    await pg.goto(url, { waitUntil: 'domcontentloaded' })
    await pg.waitForFunction(() => document.querySelectorAll('#ds article.card').length === 2 && document.querySelectorAll('#xd article.card').length === 2, { timeout: 10000 }).catch(() => {})
    await wait(800)
    const s = await snapshot(pg)
    check(`${label}: no payload ran`, s.hits.length === 0, JSON.stringify(s.hits))
    for (const id of ['ds', 'xd']) {
        const [evil, good] = s[id]
        check(`${label} ${id}: payload title rendered as text`, evil?.title === EVIL.title, JSON.stringify(evil))
        check(`${label} ${id}: payload flag string is truthy text, not code`, evil?.flag === true, JSON.stringify(evil))
        check(`${label} ${id}: benign row renders title, list and flag`, good?.title === 'Hello' && good.items.join() === 'a,b' && good.flag && good.good, JSON.stringify(good))
    }
    for (const id of ['camel', 'xbo', 'xbl', 'nest']) {
        const [evil, good] = s[id]
        check(`${label} ${id}: payload title rendered as text, benign title intact`, evil?.title === EVIL.title && good?.title === 'Hello', JSON.stringify(s[id]))
    }
    check(`${label} xbl/nest: lists pass through as values`, s.xbl[1]?.items.join() === 'a,b' && s.nest[1]?.items.join() === 'a,b', JSON.stringify([s.xbl[1], s.nest[1]]))
    check(`${label}: static props still work`, s.st[0]?.title === 'Static' && s.st[0].items.join() === 's1,s2,s3' && s.st[0].flag, JSON.stringify(s.st))
    check(`${label}: bound $x prop outside x-for`, s.bx[0]?.title === 'From site', JSON.stringify(s.bx))
    check(`${label}: bound scope prop outside x-for`, s.bp[0]?.title === 'Plain', JSON.stringify(s.bp))
    await pg.close()
    return errors
}

function prerender() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'mnfst-components-props-xss-'))
    fs.cpSync(FW, path.join(dir, 'fw'), { recursive: true })
    for (const [p, body] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
        fs.writeFileSync(path.join(dir, p), body)
    }
    // hits during the bake land in the serialized markup
    const page = PAGE.replace('window.__hits.push(k);', 'window.__hits.push(k); document.documentElement.setAttribute("data-bake-hits", window.__hits.join());')
    fs.copyFileSync(ALPINE, path.join(dir, 'alpine.js'))
    fs.writeFileSync(path.join(dir, 'index.html'), page)
    const r = spawnSync('node', [path.join(ROOT, 'packages', 'render', 'bin', 'mnfst-render.js')], { cwd: dir, encoding: 'utf8', timeout: 240000 })
    check('prerender: exit 0', r.status === 0, r.status === 0 ? '' : (r.stdout + r.stderr).split('\n').slice(-8).join(' / '))
    const html = (() => { try { return fs.readFileSync(path.join(dir, 'website', 'index.html'), 'utf8') } catch { return '' } })()
    check('prerender: baked the page', html.includes('article'), html.length + ' bytes')
    check('prerender: the bake ran no payload', !/data-bake-hits="/.test(html), (html.match(/data-bake-hits="[^"]*"/) || [''])[0])
    const bad = [...html.matchAll(/\s((?:x-|:|@)[\w:.-]*)="([^"]*)"/g)].filter((m) => m[1] !== 'x-data' && /hit\(|hit&#39;|defaultView/.test(m[2])).map((m) => `${m[1]}="${m[2]}"`)
    check('prerender: no payload in any baked directive', bad.length === 0, bad.slice(0, 4).join(' | '))
    check('prerender: template placeholders keep their tag name', !/<x\s+-/.test(html), (html.match(/<x\s+-[^>]{0,60}/) || [''])[0])
    return dir
}

async function main() {
    let bakeDir
    if (!process.env.SKIP_PRERENDER) bakeDir = prerender()
    const srv = await serveDir(FILES)
    try {
        const chrome = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
        try {
            const errs = await live(chrome, 'live', srv.url + '/')
            if (errs.length) console.log('  page errors:', errs.slice(0, 5).join(' | '))
            if (bakeDir) {
                const baked = await serveDir(null, path.join(bakeDir, 'website'))
                try {
                    const pg = await chrome.newPage()
                    await pg.goto(baked.url + '/', { waitUntil: 'domcontentloaded' })
                    await wait(2500)
                    const s = await snapshot(pg)
                    check('prerender: baked page runs no payload on load', s.hits.length === 0, JSON.stringify(s.hits))
                    check('prerender: baked page keeps a bound prop', s.bx[0]?.title === 'From site', JSON.stringify(s.bx[0]))
                    check('prerender: baked x-for components show the payload as text', s.ds[0]?.title === EVIL.title && s.ds[1]?.title === 'Hello', JSON.stringify(s.ds))
                    await pg.close()
                } finally { await baked.close() }
            }
        } finally { await chrome.close() }
    } finally {
        await srv.close()
        if (bakeDir && !process.env.KEEP_BAKE) fs.rmSync(bakeDir, { recursive: true, force: true }); else if (bakeDir) console.log("bake:", bakeDir)
    }
    console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
