// Page sessions against the real dev server (mnfst-run --edit) for publish/reload
// scenarios: each session evaluates Edit afresh on the source as it is, reads the base at
// boot as a served page does, and publishes through Edit's own /__edit/base + /__edit/save
// calls (no onPublish). `ext` changes the source underneath the page (an agent's write);
// `net.lose` drops a save's response after the server wrote it.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './edit-setup.js'

const SERVE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../packages/run/serve.mjs')
export const flush = () => new Promise(r => setTimeout(r, 0))
const settle = () => new Promise(r => setTimeout(r, 500))

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
    const net = { lose: false }
    // A browser sends Origin on a POST; happy-dom cannot, so both calls go through node's http.
    window.fetch = (u, o = {}) => new Promise((resolve, reject) => {
        const save = String(u).includes('/__edit/save')
        const req = http.request({ host: 'localhost', port, path: save ? '/__edit/save' : String(u).replace(/^https?:\/\/[^/]+/, ''), method: save ? 'POST' : 'GET', headers: save ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(o.body), Origin: `http://localhost:${port}` } : {} }, res => {
            let data = ''; res.on('data', c => data += c)
            res.on('end', () => { if (save && net.lose) return reject(new Error('network lost after the write')); resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => Promise.resolve(JSON.parse(data)) }) })
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
        new Function(EDIT_SRC)()
        if (!started) { window.Alpine = Alpine; globalThis.Alpine = Alpine; Alpine.start(); started = true }
        await flush()
        const root = await mount()
        await settle()
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
