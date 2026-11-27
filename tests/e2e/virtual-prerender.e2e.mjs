/**
 * x-virtual after mnfst-render in real Chromium: a prerendered list takes over at hydration.
 * Lists: block (local x-data), recycle, table, gallery, masonry, a $x source. Each must show its
 * rows' text after hydration with no ReferenceError, render new rows on scroll, and
 * $virtual(...).scrollToIndex must reach the item. A page baked by the previous module
 * (no loop left on the template) must at least stay quiet and keep its baked text.
 *
 * Run: npm run build && node tests/e2e/virtual-prerender.e2e.mjs   (KEEP=1 keeps the temp sites)
 */
import { spawnSync, execFileSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const N = 500
const PEOPLE = Array.from({ length: N }, (_, i) => ({ id: i, name: 'P' + i, h: 60 + (i * 37) % 90 }))
const LOCAL = `Array.from({ length: ${N} }, (_, i) => ({ id: i, name: 'P' + i, h: 60 + (i * 37) % 90 }))`
const BOX = 'height:300px;width:600px;overflow:auto'

const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>virtual</title>
<script src="/lib/manifest.js" data-plugins="data,virtual" data-plugin-base="/lib" data-alpine="/alpine.js"></script></head>
<body><main x-data="{ people: ${LOCAL}, term: '', clicked: false }">
<button id="jump" @click="$virtual('local').scrollToIndex(250)">jump</button>
<div id="local" x-virtual style="${BOX}">
  <template x-for="person in people" :key="person.id"><div class="r" style="height:30px" x-text="'#' + person.id + ' ' + person.name"></div></template>
</div>
<div id="recycle" x-virtual="{ recycle: true }" style="${BOX}">
  <template x-for="(person, i) in people" :key="person.id"><div class="r" style="height:30px"><span x-text="'#' + person.id"></span> <b x-text="person.name + '/' + i"></b></div></template>
</div>
<div id="table" x-virtual style="${BOX}"><table style="width:100%"><thead><tr><th>Name</th></tr></thead><tbody>
  <template x-for="user in people" :key="user.id"><tr class="r" :class="user.id % 2 ? 'odd' : ''"><td style="height:30px" x-text="'#' + user.id + ' ' + user.name"></td></tr></template>
</tbody></table></div>
<div id="gallery" x-virtual="{ estimate: { width: 120, height: 60 } }" style="${BOX};display:flex;flex-wrap:wrap;align-content:flex-start;gap:4px">
  <template x-for="tile in people" :key="tile.id"><div class="r" style="width:110px;height:60px" x-text="'#' + tile.id + ' ' + tile.name"></div></template>
</div>
<div id="masonry" x-virtual="{ mode: 'masonry', columns: 3, gap: 4, height: b => b.h }" style="${BOX};position:relative">
  <div class="author" style="position:absolute;top:0;right:0" x-text="'badge ' + people.length"></div>
  <template x-for="block in people" :key="block.id"><div class="r" :style="'height:' + block.h + 'px'" x-text="'#' + block.id + ' ' + block.name"></div></template>
</div>
<div id="inner" x-virtual style="${BOX}">
  <template x-for="o in people" :key="o.id"><div class="r" style="height:30px"><span x-text="'#' + o.id + ' ' + o.name"></span> <template x-for="k in [o.id, o.id + 1]" :key="k" data-prerender="dynamic"><i x-text="'c' + k + ' '"></i></template></div></template>
</div>
<div id="xifbefore" x-virtual style="${BOX}">
  <template x-if="people.length"><div class="author" x-text="'notice ' + people.length"></div></template>
  <template x-for="person in people" :key="person.id"><div class="r" style="height:30px" x-text="'#' + person.id + ' ' + person.name"></div></template>
</div>
<div id="xifafter" x-virtual style="${BOX}">
  <template x-for="person in people" :key="person.id"><div class="r" style="height:30px" x-text="'#' + person.id + ' ' + person.name"></div></template>
  <template x-if="people.length"><div class="author" x-text="'notice ' + people.length"></div></template>
</div>
<div id="loopbefore" x-virtual style="${BOX}">
  <template x-for="c in ['a', 'b']" :key="c" data-prerender="dynamic"><span class="hdr" x-text="c"></span></template>
  <template data-virtual x-for="person in people" :key="person.id"><div class="r" style="height:30px" x-text="'#' + person.id + ' ' + person.name"></div></template>
</div>
<div id="tplcls" x-virtual style="${BOX}">
  <template x-for="person in people" :key="person.id" :class="'x'"><div class="r" style="height:30px" x-text="'#' + person.id + ' ' + person.name"></div></template>
</div>
<div id="tplclick" x-virtual style="${BOX}">
  <template x-for="person in people" :key="person.id" @click="clicked = true"><div class="r" style="height:30px" x-text="'#' + person.id + ' ' + person.name"></div></template>
</div>
<div id="tplmagic" x-virtual style="${BOX}">
  <template x-for="row in $x.people.$search(term, 'name')" :key="row.id"><div class="r" style="height:30px" x-text="'#' + row.id + ' ' + row.name"></div></template>
</div>
<div id="masref" x-virtual="{ mode: 'masonry', columns: 3, gap: 4, height: b => b.h }" style="${BOX};position:relative">
  <template x-ref="rows" x-for="block in people" :key="block.id"><div class="r" :style="'height:' + block.h + 'px'" x-text="'#' + block.id + ' ' + block.name"></div></template>
</div>
<div id="source" x-virtual style="${BOX}">
  <template x-for="row in $x.people" :key="row.id"><div class="r" style="height:30px" x-text="'#' + row.id + ' ' + row.name"></div></template>
</div>
</main></body></html>`
const LISTS = ['local', 'recycle', 'table', 'gallery', 'masonry', 'inner', 'xifbefore', 'xifafter', 'loopbefore', 'tplcls', 'tplclick', 'tplmagic', 'masref', 'source']

// A site rendered with the given virtual module (null: this tree's lib)
function bake(virtualFrom) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtual-prerender-'))
    if (virtualFrom) {
        fs.mkdirSync(path.join(dir, 'lib'))
        for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) fs.symlinkSync(path.join(ROOT, 'lib', f), path.join(dir, 'lib', f))
        for (const f of ['manifest.virtual.js', 'manifest.virtual.min.js']) {
            fs.rmSync(path.join(dir, 'lib', f))
            fs.writeFileSync(path.join(dir, 'lib', f), execFileSync('git', ['show', `${virtualFrom}:lib/${f}`], { cwd: ROOT }))
        }
    } else fs.symlinkSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'))
    fs.copyFileSync(path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js'), path.join(dir, 'alpine.js'))
    fs.writeFileSync(path.join(dir, 'people.json'), JSON.stringify(PEOPLE))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'virtual', data: { people: '/people.json' }, prerender: { wait: 300 } }))
    fs.writeFileSync(path.join(dir, 'index.html'), INDEX)
    const r = spawnSync('node', [path.join(ROOT, 'packages/render/bin/mnfst-render.js')], { cwd: dir, encoding: 'utf8', timeout: 180_000 })
    const out = path.join(dir, 'website')
    if (r.status !== 0 || !fs.existsSync(path.join(out, 'index.html'))) {
        console.error('render failed', r.status, ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-20).join('\n'))
        process.exit(1)
    }
    return { dir, out }
}

function serve(out) {
    return http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0])
        const file = url.startsWith('/lib/') ? path.join(ROOT, url) : path.join(out, url === '/' ? 'index.html' : url)
        fs.readFile(file, (err, body) => {
            if (err) { res.statusCode = 404; return res.end() }
            res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html')
            res.end(body)
        })
    }).listen(0)
}

async function open(browser, out) {
    const server = serve(out)
    const base = `http://localhost:${server.address().port}`
    const tab = await browser.newPage()
    await tab.setViewport({ width: 1200, height: 900 })
    const errors = [], warns = []
    tab.on('pageerror', e => errors.push(e.message))
    tab.on('console', m => m.type() === 'error' ? errors.push(m.text()) : m.type() === 'warn' && warns.push(m.text()))
    await tab.setRequestInterception(true)
    tab.on('request', q => q.url().startsWith(base) ? q.continue() : q.abort())
    await tab.goto(`${base}/`, { waitUntil: 'load' })
    await wait(2500)
    return { tab, errors, warns, server }
}

// Rows in a list: count, blank ones, the first's text, spacers
const rowsOf = (tab, id) => tab.evaluate((id) => {
    const el = document.getElementById(id)
    const rows = [...el.querySelectorAll('.r')].filter(r => !r.closest('template'))
    return {
        rows: rows.length,
        dupes: rows.length - new Set(rows.map(r => r.textContent.trim())).size,
        ignored: rows.filter(r => r.hasAttribute('x-ignore')).length,
        authors: [...el.querySelectorAll('.author, .hdr')].map(a => a.textContent.trim()),
        blank: rows.filter(r => !r.textContent.trim()).length,
        first: rows[0] ? rows[0].textContent.trim().replace(/\s+/g, ' ') : null,
        spacers: el.querySelectorAll('[data-virtual-spacer]').length,
        scrollHeight: el.scrollHeight,
    }
}, id)

const fresh = bake(null)
const legacy = bake('origin/master')
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const html = fs.readFileSync(path.join(fresh.out, 'index.html'), 'utf8')
    check('baked HTML keeps row text for crawlers', html.includes('#3 P3'))
    check('baked spacers carry the render mark', (html.match(/data-virtual-spacer="baked"/g) || []).length === 2 * 12 + 2, (html.match(/data-virtual-spacer="baked"/g) || []).length)

    const { tab, errors, warns, server } = await open(browser, fresh.out)
    for (const id of LISTS) {
        const s = await rowsOf(tab, id)
        const spacers = /^mas/.test(id) ? 1 : 2
        check(`${id}: rows show text after hydration`, s.rows > 3 && s.blank === 0 && /^#0 P0/.test(s.first), s)
        check(`${id}: one set of spacers, list sized`, s.spacers === spacers && s.scrollHeight > 1000, s)
        check(`${id}: one live list (no duplicate or frozen rows)`, s.dupes === 0 && s.ignored === 0 && s.rows <= (id === 'gallery' ? 80 : 40), s)
    }
    for (const id of LISTS) {
        await tab.evaluate((id) => { document.getElementById(id).scrollTop = 4000 }, id)
        await wait(400)
        const s = await rowsOf(tab, id)
        check(`${id}: scrolling renders new rows with text`, s.rows > 3 && s.blank === 0 && s.first && !/^#0 /.test(s.first), s)
    }
    const box = await (await tab.$('#jump')).boundingBox()
    await tab.evaluate(() => { document.getElementById('local').scrollTop = 0 })
    await wait(200)
    await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await wait(1000)
    const landed = await tab.evaluate(() => {
        const el = document.getElementById('local'), top = el.getBoundingClientRect().top
        const row = [...el.querySelectorAll('.r')].find(r => r.textContent.trim() === '#250 P250')
        return { scrollTop: el.scrollTop, offset: row ? Math.round(row.getBoundingClientRect().top - top) : null }
    })
    check('scrollToIndex(250) lands on a prerendered list', landed.scrollTop > 0 && landed.offset !== null && Math.abs(landed.offset) <= 1, landed)
    const restored = await tab.evaluate(async () => {
        const el = document.getElementById('tplcls')
        el.scrollTop = 0
        const node = await Alpine.$data(el).$virtual('tplcls').scrollToIndex(250)
        return { text: node && node.textContent.trim(), offset: node ? Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top) : null }
    })
    check('tplcls: scrollToIndex(250) lands', restored.text === '#250 P250' && Math.abs(restored.offset) <= 1, restored)
    const inner = await tab.evaluate(() => document.querySelector('#inner .r')?.textContent.replace(/\s+/g, ' ').trim())
    check('inner x-for in rows renders', /^#(\d+) P\1 c\1 c\d+$/.test(inner || ''), inner)
    const badge = await tab.evaluate(() => document.querySelector('#masonry .author')?.textContent)
    check('masonry: author element beside the rows survives hydration', badge === 'badge 500', badge)
    for (const [id, want] of [['xifbefore', ['notice 500']], ['xifafter', ['notice 500']], ['loopbefore', ['a', 'b']]]) {
        const s = await rowsOf(tab, id)
        check(`${id}: author template content renders once`, JSON.stringify(s.authors) === JSON.stringify(want), s.authors)
    }
    check('no x-virtual warnings', !warns.some(w => w.includes('[x-virtual]')), warns.filter(w => w.includes('[x-virtual]')))
    const marks = await tab.evaluate(() => document.querySelectorAll('[data-virtual-spacer="baked"], [data-virtual-row]').length)
    check('no render marks on the live page', marks === 0, marks)
    const refs = errors.filter(e => /ReferenceError|is not defined/.test(e))
    check('no ReferenceError at hydration', refs.length === 0, refs.slice(0, 5))
    check('no page errors', errors.length === 0, errors.slice(0, 5))
    await tab.close(); server.close()

    // A page baked before the fix: the loop left the template, so the list cannot run.
    // The new module keeps the baked rows as they are, quietly
    const old = await open(browser, legacy.out)
    const oldRefs = old.errors.filter(e => /ReferenceError|is not defined/.test(e))
    check('legacy bake: no ReferenceError with the new module', oldRefs.length === 0, { count: oldRefs.length, first: oldRefs[0] })
    for (const id of ['local', 'table', 'masonry', 'inner', 'xifbefore', 'xifafter', 'loopbefore', 'tplcls', 'tplclick', 'tplmagic', 'masref']) {
        const s = await rowsOf(old.tab, id)
        check(`legacy bake: ${id} keeps its baked text`, s.rows > 3 && s.blank === 0 && /^#0 P0/.test(s.first), s)
        check(`legacy bake: ${id} starts no second list`, s.dupes === 0 && s.rows <= 40 && s.spacers === (/^mas/.test(id) ? 1 : 2), s)
    }
    const hdr = await rowsOf(old.tab, 'loopbefore')
    check('legacy bake: an author x-for beside the rows stays an ordinary loop', JSON.stringify(hdr.authors) === '["a","b"]', hdr.authors)
    const oldBadge = await old.tab.evaluate(() => document.querySelector('#masonry .author')?.textContent)
    check('legacy bake: masonry author element kept live', oldBadge === 'badge 500' && await old.tab.evaluate(() => !document.querySelector('#masonry .author').hasAttribute('x-ignore')), oldBadge)
    check('legacy bake: no x-virtual template warning', !old.warns.some(w => w.includes('expects a descendant')), old.warns.filter(w => w.includes('[x-virtual]')))
    await old.tab.close(); old.server.close()
} finally {
    await browser.close()
    for (const s of [fresh, legacy]) if (!process.env.KEEP) fs.rmSync(s.dir, { recursive: true, force: true }); else console.log(s.dir)
}
if (failures.length) { console.log(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nall passed')
