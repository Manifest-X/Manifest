/**
 * @vitest-environment happy-dom
 *
 * Element fingerprints end to end: the page loads its source's fingerprints from the real
 * dev server, sends them with each publish, and takes the new ones a publish returns.
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import http from 'http'
import { createHash } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Alpine from 'alpinejs'
import { EDIT_SRC } from './helpers/edit-setup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVE = path.join(__dirname, '../packages/run/serve.mjs')
const flush = () => new Promise(r => setTimeout(r, 0))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const BODY = `<section x-edit="tw">
  <div class="card red"><p>Same</p></div>
  <div class="card blue"><p>Same</p></div>
</section>
<section x-edit="un">
  <p>Alpha</p>
  <p>Beta</p>
  <p>Gamma</p>
</section>`
const page = (body) => `<!doctype html>\n<html>\n<body>\n${body}\n</body>\n</html>\n`
let dir, proc, port
const src = () => readFileSync(path.join(dir, 'index.html'), 'utf8')
const setSrc = (s) => writeFileSync(path.join(dir, 'index.html'), s)

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-fp-'))
    setSrc(page(BODY))
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'fp' }))
    const ask = 41000 + Math.floor(Math.random() * 3000)
    proc = spawn(process.execPath, [SERVE, dir, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(ask)], { stdio: ['ignore', 'pipe', 'pipe'] })
    port = await new Promise((resolve, reject) => {
        let out = ''
        const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000)
        const scan = c => { out += c; const m = out.match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]) } }
        proc.stdout.on('data', scan); proc.stderr.on('data', scan)
    })
    window.happyDOM.setURL(`http://localhost:${port}/`)
    // A browser sends Origin on a POST; happy-dom cannot, so saves go through node's http.
    const fetch0 = window.fetch.bind(window)
    window.fetch = (u, o = {}) => !String(u).includes('/__edit/save') ? fetch0(u, o) : new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port, path: '/__edit/save', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(o.body), Origin: `http://localhost:${port}` } }, res => {
            let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ ok: true, json: () => Promise.resolve(JSON.parse(data)) }))
        })
        req.on('error', reject); req.end(o.body)
    })
    // The page as loaded from the source, then the plugin (which fetches the base).
    const root = document.createElement('div')
    root.setAttribute('x-data', '')
    root.innerHTML = BODY
    document.body.appendChild(root)
    new Function(EDIT_SRC)()
    window.Alpine = Alpine; globalThis.Alpine = Alpine
    Alpine.start()
    await sleep(900)
}, 15000)

afterAll(() => { try { proc.kill() } catch { } try { rmSync(dir, { recursive: true, force: true }) } catch { } })

const store = () => Alpine.store('edit')
const editText = (el, value) => { el.dispatchEvent(new Event('focus')); el.innerHTML = value; el.dispatchEvent(new Event('blur')) }
const section = (name) => document.querySelector(`[x-edit="${name}"]`)

describe('fingerprints from the page', () => {
    it('rebase refuses an edit whose twin was swapped elsewhere, writing nothing', async () => {
        const swapped = src().replace(/(<div class="card red">.*<\/div>)\n  (<div class="card blue">.*<\/div>)/, '$2\n  $1')
        setSrc(swapped)
        editText(section('tw').querySelector('.blue p'), 'Blue page')
        await flush()
        const r = await store().publish({ rebase: true })
        expect(r.results[0].status).toBe('error')
        expect(r.results[0].reason).toContain('identical elements')
        expect(src()).toBe(swapped)
        await store().undo()
        // Put the source back as the page loaded it.
        setSrc(page(BODY))
        await sleep(300)
    })

    it('a unique element still merges; after that rebase, only a rebase publish writes until a reload', async () => {
        setSrc(src().replace('<p>Alpha</p>\n  <p>Beta</p>', '<p>Beta</p>\n  <p>Alpha</p>'))
        editText(section('un').querySelectorAll('p')[2], 'Gamma page')
        await flush()
        const r1 = await store().publish({ rebase: true })
        expect(r1.results.map(x => x.status)).toEqual(['written'])
        // The page still shows Alpha first: a plain publish is stale until it reloads; a
        // rebase one is checked against what it shows, and writes.
        editText(section('un').querySelectorAll('p')[2], 'Gamma again')
        await flush()
        const r2 = await store().publish()
        expect(r2.results.map(x => x.status)).toEqual(['error'])
        expect(r2.stale).toEqual(['index.html'])
        const r3 = await store().publish({ rebase: true })
        expect(r3.results.map(x => x.status)).toEqual(['written'])
        expect(src()).toContain('<p>Beta</p>\n  <p>Alpha</p>\n  <p>Gamma again</p>')
    })

    it('an external HTML change whose live reload is cancelled still refuses a plain publish', async () => {
        setSrc(src().replace('<p>Beta</p>', '<p>Beta external</p>'))
        const hash = createHash('sha1').update(readFileSync(path.join(dir, 'index.html'))).digest('hex')
        // What the dev server's live-reload script dispatches; a listener cancels the reload.
        const cancel = (e) => e.preventDefault()
        window.addEventListener('manifest:live-reload', cancel)
        window.dispatchEvent(new CustomEvent('manifest:source-change', { detail: { file: 'index.html', hash } }))
        const reload = new CustomEvent('manifest:live-reload', { cancelable: true, detail: { files: [{ rel: 'index.html', hash }] } })
        window.dispatchEvent(reload)
        window.removeEventListener('manifest:live-reload', cancel)
        expect(reload.defaultPrevented).toBe(true)
        editText(section('un').querySelectorAll('p')[0], 'Beta page')
        await flush()
        const r = await store().publish()
        expect(r.results[0].status).toBe('error')
        expect(r.stale).toEqual(['index.html'])
        expect(src()).toContain('<p>Beta external</p>')
    })
})
