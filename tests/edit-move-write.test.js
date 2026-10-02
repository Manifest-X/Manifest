/**
 * B-side of a cross-region move: /__edit/save `static-move` lifts the AUTHORED child
 * markup out of one x-edit region in index.html and splices it into another, placed
 * by the client's toOrder. Runs the real server (--edit) against a temp project.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVE = path.join(__dirname, '../packages/run/serve.mjs')

const INDEX = `<!doctype html>
<html>
<body>
    <section x-edit.authoring="hero">
        <h1>Welcome</h1>
        <p>Intro copy</p>
    </section>
    <section x-edit.authoring="footer">
        <p>Fine print</p>
    </section>
</body>
</html>
`

let dir, proc, port

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-move-'))
    writeFileSync(path.join(dir, 'index.html'), INDEX)
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'move-test' }))
    const ask = 49000 + Math.floor(Math.random() * 5000)
    proc = spawn(process.execPath, [SERVE, dir, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(ask)], { stdio: ['ignore', 'pipe', 'pipe'] })
    port = await new Promise((resolve, reject) => {
        let out = ''
        const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000)
        const scan = c => { out += c; const m = out.match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(t); resolve(+m[1]) } }
        proc.stdout.on('data', scan)
        proc.stderr.on('data', scan)
    })
}, 15000)

afterAll(() => {
    try { proc.kill() } catch { }
    try { rmSync(dir, { recursive: true, force: true }) } catch { }
})

const save = (patches) => fetch(`http://localhost:${port}/__edit/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': `http://localhost:${port}` },
    body: JSON.stringify(patches)
}).then(r => r.json())

describe('/__edit/save static-move', () => {
    it('errors cleanly when the child key is missing (source untouched)', async () => {
        const { results } = await save([{ kind: 'static-move', from: 'hero', to: 'footer', key: 'P:Nope', toKey: 'P:Nope', toOrder: [] }])
        expect(results[0].status).toBe('error')
        expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(INDEX)
    })

    it('moves the authored markup between regions, placed by toOrder', async () => {
        const { results } = await save([{
            kind: 'static-move', from: 'hero', to: 'footer',
            key: 'P:Intro copy', toKey: 'P:Intro copy',
            toOrder: ['P:Intro copy', 'P:Fine print']
        }])
        expect(results[0].status).toBe('written')
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        const hero = html.slice(html.indexOf('"hero"'), html.indexOf('"footer"'))
        expect(hero).toContain('Welcome')
        expect(hero).not.toContain('Intro copy')
        const footer = html.slice(html.indexOf('"footer"'))
        expect(footer).toContain('<p>Intro copy</p>')
        expect(footer.indexOf('Intro copy')).toBeLessThan(footer.indexOf('Fine print'))
    })
})
