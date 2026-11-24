// Page sessions against the real dev server (mnfst-run --edit) for publish/reload
// scenarios: each session evaluates Edit afresh on the source as it is, reads the base at
// boot as a served page does, and publishes through Edit's own /__edit/base + /__edit/save
// calls (no onPublish). `ext` changes the source underneath the page (an agent's write);
// `net.lose` drops a save's response after the server wrote it.
// A load waits for Edit's boot, not a fixed delay: Edit queues its boot pass (arm + restore)
// 450ms after init so a real page can finish rendering; here the page is mounted before that
// pass is let run, then the load resolves once every region is armed and the base has arrived.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { expect } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './edit-setup.js'

const SERVE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../packages/run/serve.mjs')
export const flush = () => new Promise(r => setTimeout(r, 0))
async function until(ready, what, ms = 5000) {
    const end = Date.now() + ms
    while (!ready()) {
        if (Date.now() > end) throw new Error('timed out waiting for ' + what)
        await new Promise(r => setTimeout(r, 2))
    }
}
const BOOT_DELAY = 450   // manifest.edit.main.js: setTimeout(() => { armAll(); restore(); }, 450)

// Two sibling regions, `a` and `b`, one child per line, as an author writes them.
export const twoRegions = (mods = '') => (a, b) => `<!doctype html>
<html>
<body>
    <section id="a" x-edit${mods}="a">
${a.map(x => '        ' + x).join('\n')}
    </section>
    <section id="b" x-edit${mods}="b">
${b.map(x => '        ' + x).join('\n')}
    </section>
</body>
</html>
`

export async function editServer() {
    const dir = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-sessions-'))
    const index = path.join(dir, 'index.html')
    writeFileSync(index, '<!doctype html><html><body></body></html>')
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'sessions' }))
    const ask = 47000 + Math.floor(Math.random() * 3000)
    const proc = spawn(process.execPath, [SERVE, dir, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(ask)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise((resolve, reject) => {
        let out = ''
        const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000)
        const scan = c => { out += c; const m = out.match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]) } }
        proc.stdout.on('data', scan); proc.stderr.on('data', scan)
    })
    window.happyDOM.setURL(`http://localhost:${port}/`)
    // `net.lose`: a save is written, then its response is lost
    const net = { lose: false, bases: 0 }
    // A browser sends Origin on a POST; happy-dom cannot, so both calls go through node's http.
    window.fetch = (u, o = {}) => new Promise((resolve, reject) => {
        const save = String(u).includes('/__edit/save')
        const req = http.request({ host: 'localhost', port, path: save ? '/__edit/save' : String(u).replace(/^https?:\/\/[^/]+/, ''), method: save ? 'POST' : 'GET', headers: save ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(o.body), Origin: `http://localhost:${port}` } : {} }, res => {
            let data = ''; res.on('data', c => data += c)
            res.on('end', () => { if (!save && String(u).includes('/__edit/base')) net.bases++; if (save && net.lose) return reject(new Error('network lost after the write')); resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => Promise.resolve(JSON.parse(data)) }) })
        })
        req.on('error', reject); req.end(save ? o.body : undefined)
    })
    window.__mnfstEdit = true
    try { window.location.reload = () => { } } catch { }
    let started = false
    const store = () => Alpine.store('edit')
    const file = () => readFileSync(index, 'utf8')

    // Mount the body exactly as the file holds it, so the page's DOM is the source's.
    async function mount() {
        const html = file()
        const root = document.createElement('div')
        root.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
        Alpine.mutateDom(() => document.body.appendChild(root))
        Alpine.initTree(root)
        await flush(); await flush()
        return root
    }
    // A page load: Edit evaluated afresh (its log restored only for .persist regions)
    async function load() {
        document.body.innerHTML = ''
        const bases = net.bases
        let boot = null
        const timer = (fn, ms, ...args) => {
            if (ms === BOOT_DELAY && !boot) { boot = fn; return 0 }
            return setTimeout(fn, ms, ...args)
        }
        new Function('setTimeout', EDIT_SRC)(timer)
        if (!started) { window.Alpine = Alpine; globalThis.Alpine = Alpine; Alpine.start(); started = true }
        await until(() => boot, "Edit's init")
        const root = await mount()
        boot()
        const regions = [...root.querySelectorAll('[data-edit-area]')].filter(a => a._edit && !a._edit.gated && !a.parentElement.closest('[data-edit-area]'))   // top-level areas arm
        await until(() => regions.every(a => a._armed) && net.bases > bases, 'Edit to arm its regions and read the base')
        await flush()
        return root
    }
    return {
        port, store, file, net,
        // A new session on `html`: empty log and storage
        async open(html) { if (started) store().off(); localStorage.clear(); writeFileSync(index, html); return load() },
        reload: load,
        ext(fn) { writeFileSync(index, fn(file())) },
        stop() { try { proc.kill() } catch { } try { rmSync(dir, { recursive: true, force: true }) } catch { } }
    }
}

// Children of a region as text, skipping editor chrome; `data-m` marks identity.
export const view = (el) => [...el.children].filter(c => !c.hasAttribute('data-edit-handle') && !c.hasAttribute('data-edit-ghost')).map(c => (c.getAttribute('data-m') ? c.getAttribute('data-m') + '=' : '') + c.textContent.trim())
export function fileView(html, ids = ['a', 'b']) {
    const d = new DOMParser().parseFromString(html, 'text/html')
    return Object.fromEntries(ids.map(id => [id, view(d.getElementById(id))]))
}
export const editText = (el, value) => { el.dispatchEvent(new Event('focus')); el.innerHTML = value; el.dispatchEvent(new Event('blur')) }
// Keyboard reorder: Alt+arrow moves the focused piece one place per press
export const kbMove = (el, dir, n = 1) => { for (let i = 0; i < n; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: dir, altKey: true, bubbles: true, cancelable: true })) }

export const regions = (root) => ({ a: root.querySelector('#a'), b: root.querySelector('#b') })
export const pageView = (r) => ({ a: view(r.a), b: view(r.b) })
// A written publish leaves the source reading as the page does
export async function publishShown(S, r, opts) {
    const res = await S.store().publish(opts)
    expect(res.results.filter(x => x.status !== 'written' && x.status !== 'noop')).toEqual([])
    expect(fileView(S.file())).toEqual(pageView(r))
    return res
}
// A fresh session on the written source shows what the file holds
export async function freshShowsFile(S) {
    const fv = fileView(S.file())
    const f = regions(await S.reload())
    expect(pageView(f)).toEqual(fv)
    return f
}
// Seeded integers in [0, n): mulberry32
export function seeded(seed) {
    let s = seed >>> 0
    return (n) => {
        s = (s + 0x6D2B79F5) | 0
        let x = Math.imul(s ^ (s >>> 15), 1 | s)
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
        return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n)
    }
}

// ---- Identity books (twins): every element carries a data-m identity ----
export const kids = (reg) => [...reg.children].filter(c => !c.hasAttribute('data-edit-handle') && !c.hasAttribute('data-edit-ghost'))
export const ids = (el) => kids(el).map(c => c.getAttribute('data-m') || '?')
export const fileIds = (S) => { const d = new DOMParser().parseFromString(S.file(), 'text/html'); return { a: ids(d.getElementById('a')), b: ids(d.getElementById('b')) } }
const count = (list) => list.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {})

// One child per line: `fn` gets the region's lines and returns the new ones (or null)
function extRegion(S, id, fn) {
    const f = S.file(), lines = f.split('\n')
    const s = lines.findIndex(l => l.includes(`<section id="${id}"`)), e = lines.findIndex((l, i) => i > s && l.includes('</section>'))
    const next = fn(lines.slice(s + 1, e))
    if (!next) return false
    S.ext(() => [...lines.slice(0, s + 1), ...next, ...lines.slice(e)].join('\n'))
    return true
}

// A session that keeps the identity books: user additions/removals and changes elsewhere
export async function identitySession(S, a, b) {
    const t = { r: regions(await S.open(twoRegions('.persist')(a, b))), init: count([...a, ...b].map(l => l.match(/data-m="([^"]+)"/)[1])), E: {}, Up: {}, Un: {}, alias: {} }
    const canon = (k) => t.alias[k] || k
    const page = () => count([...ids(t.r.a), ...ids(t.r.b)].map(canon))
    t.user = async (fn) => {
        const before = page(); const res = await fn(); const after = page()
        new Set([...Object.keys(after), ...Object.keys(before)]).forEach(k => { const d = (after[k] || 0) - (before[k] || 0); if (d > 0) t.Up[k] = (t.Up[k] || 0) + d; if (d < 0) t.Un[k] = (t.Un[k] || 0) + d })
        return res
    }
    t.ext = (id, fn) => extRegion(S, id, fn)
    t.added = (id) => { t.E[id] = (t.E[id] || 0) + 1 }
    t.removed = (id) => { t.E[canon(id)] = (t.E[canon(id)] || 0) - 1 }
    t.reload = async () => { t.r = regions(await S.reload()) }
    // The final publish and the books
    t.check = async (opts) => {
        const res = await S.store().publish(opts)
        const fi = fileIds(S), fc = count([...fi.a, ...fi.b].map(canon)), wrong = []
        new Set([...Object.keys(t.init), ...Object.keys(t.E), ...Object.keys(fc), ...Object.keys(t.Up)]).forEach(k => {
            const base = (t.init[k] || 0) + (t.E[k] || 0), lo = base + (t.Un[k] || 0), hi = base + (t.Up[k] || 0), got = fc[k] || 0
            if (got < Math.max(0, lo) || got > hi) wrong.push(`${k}: ${got} in the source, expected ${Math.max(0, lo)}..${hi}`)
        })
        expect(wrong, JSON.stringify({ file: fi, results: res.results })).toEqual([])
        return res
    }
    return t
}
