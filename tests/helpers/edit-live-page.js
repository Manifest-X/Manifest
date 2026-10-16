// A happy-dom page served by the real dev server (--edit): the source file is the page,
// Edit boots on it and talks to /__edit/base and /__edit/save. `net.baseDown` makes the
// base endpoint answer 503. `opts.files` adds project files; `opts.dom` is the page as
// mounted (default: the body), and `opts.mounted(root)` runs on it before Edit boots.
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './edit-setup.js'

const SERVE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../packages/run/serve.mjs')
const page = (body) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`

export async function bootLivePage(body, net = {}, opts = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-live-'))
    const file = path.join(dir, 'index.html')
    writeFileSync(file, page(body))
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'live' }))
    for (const [rel, text] of Object.entries(opts.files || {})) { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text) }
    const ask = 41000 + Math.floor(Math.random() * 3000)
    const proc = spawn(process.execPath, [SERVE, dir, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(ask)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise((resolve, reject) => {
        let out = ''
        const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000)
        const scan = c => { out += c; const m = out.match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]) } }
        proc.stdout.on('data', scan); proc.stderr.on('data', scan)
    })
    window.happyDOM.setURL(`http://localhost:${port}/`)
    // A browser sends Origin on a POST; happy-dom cannot, so saves go through node's http.
    const fetch0 = window.fetch.bind(window)
    window.fetch = (u, o = {}) => {
        if (String(u).includes('/__edit/base') && net.baseDown) return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
        if (!String(u).includes('/__edit/save')) return fetch0(u, o)
        return new Promise((resolve, reject) => {
            const req = http.request({ host: 'localhost', port, path: '/__edit/save', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(o.body), Origin: `http://localhost:${port}` } }, res => {
                let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ ok: true, json: () => Promise.resolve(JSON.parse(data)) }))
            })
            req.on('error', reject); req.end(o.body)
        })
    }
    const root = document.createElement('div')
    root.setAttribute('x-data', '')
    root.innerHTML = opts.dom || body
    document.body.appendChild(root)
    if (opts.mounted) opts.mounted(root)
    window.__mnfstEdit = true   // as mnfst-run --edit marks the page
    new Function(EDIT_SRC)()
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    Alpine.start()
    await new Promise(r => setTimeout(r, 900))
    return {
        port,
        src: (rel = 'index.html') => readFileSync(path.join(dir, rel), 'utf8'),
        write: (rel, text) => writeFileSync(path.join(dir, rel), text),
        setSrc: (s) => writeFileSync(file, s),
        page,
        stop: () => { try { proc.kill() } catch { } try { rmSync(dir, { recursive: true, force: true }) } catch { } }
    }
}
