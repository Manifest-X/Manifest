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
    <section x-edit="hero">
        <h1>Welcome</h1>
        <p>Intro copy</p>
    </section>
    <section x-edit="footer">
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

    it('applies the region ORDER before edits, so edit paths are final positions', async () => {
        // Pre-move text edit travels as a destination edit; its path assumes the
        // region's final order, so the server must reorder first.
        writeFileSync(path.join(dir, 'index.html'), INDEX)
        const { results } = await save([
            { kind: 'static-move', from: 'hero', to: 'footer', key: 'P:Intro copy', toKey: 'P:Intro copy', toOrder: ['P:Intro copy', 'P:Fine print'] },
            { kind: 'static', region: 'footer', order: ['P:Fine print', 'P:Intro copy'], edits: [{ path: '1', key: 'P:Intro copy', prop: 'text', value: 'Edited copy' }] }
        ])
        expect(results.map(r => r.status)).toEqual(['written', 'written'])
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        const footer = html.slice(html.indexOf('"footer"'))
        expect(footer).toContain('<p>Edited copy</p>')
        expect(footer).toContain('<p>Fine print</p>')
        expect(footer).not.toContain('Intro copy')
        expect(footer.indexOf('Fine print')).toBeLessThan(footer.indexOf('Edited copy'))
    })

    it('a pre-move reorder of the source region lands via its order patch', async () => {
        const idx = INDEX.replace('<h1>Welcome</h1>\n        <p>Intro copy</p>',
            '<p>Card</p>\n        <p>Second</p>\n        <p>Third</p>')
        writeFileSync(path.join(dir, 'index.html'), idx)
        const { results } = await save([
            { kind: 'static-move', from: 'hero', to: 'footer', key: 'P:Card', toKey: 'P:Card', toOrder: ['P:Card', 'P:Fine print'] },
            { kind: 'static', region: 'hero', order: ['P:Third', 'P:Second'], edits: [] }
        ])
        expect(results.map(r => r.status)).toEqual(['written', 'written'])
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        const hero = html.slice(html.indexOf('"hero"'), html.indexOf('"footer"'))
        expect(hero.indexOf('Third')).toBeGreaterThan(0)
        expect(hero.indexOf('Third')).toBeLessThan(hero.indexOf('Second'))
        expect(hero).not.toContain('Card')
    })

    it('skips an order that is already true of the file (byte-stable)', async () => {
        writeFileSync(path.join(dir, 'index.html'), INDEX)
        const { results } = await save([
            { kind: 'static', region: 'hero', order: ['P:Welcome... wait', 'nope'], edits: [] }
        ])
        expect(results[0].status).toBe('written')         // unknown keys: reorder skipped, file untouched
        expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(INDEX)
        const { results: r2 } = await save([
            { kind: 'static', region: 'hero', order: ['H1:Welcome', 'P:Intro copy'], edits: [] }
        ])
        expect(r2[0].reordered).toBe(false)
        expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(INDEX)
    })

    it('places a colliding arrival POSITIONALLY, mirroring fresh-session keys', async () => {
        const idx = `<!doctype html>
<html>
<body>
    <section x-edit="hero">
        <p data-m="arr">Same</p>
    </section>
    <section x-edit="footer">
        <p data-m="nat">Same</p>
    </section>
</body>
</html>
`
        writeFileSync(path.join(dir, 'index.html'), idx)
        // The arrival landed BEFORE its twin: positionally it takes the base key and
        // the native twin becomes #2 — the file order must put arr first so a fresh
        // session derives the same keys the client recorded.
        const { results } = await save([{
            kind: 'static-move', from: 'hero', to: 'footer',
            key: 'P:Same', toKey: 'P:Same', toOrder: ['P:Same', 'P:Same#2']
        }])
        expect(results[0].status).toBe('written')
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        const footer = html.slice(html.indexOf('"footer"'))
        expect(footer.indexOf('data-m="arr"')).toBeGreaterThan(0)
        expect(footer.indexOf('data-m="arr"')).toBeLessThan(footer.indexOf('data-m="nat"'))
    })

    it('delete-then-edit: a baseline-order path hits the right element while the short order is skipped', async () => {
        // The client deleted <h1> (st-children) — the server can't apply the short
        // order, so the edit's path addresses the UNMODIFIED file: Intro copy is 1.
        writeFileSync(path.join(dir, 'index.html'), INDEX)
        const { results } = await save([
            { kind: 'static', region: 'hero', order: ['P:Intro copy'], edits: [{ path: '1', key: 'P:Intro copy', prop: 'text', value: 'Edited copy' }] }
        ])
        expect(results[0].status).toBe('written')
        expect(results[0].reordered).toBe(false)
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        const hero = html.slice(html.indexOf('"hero"'), html.indexOf('"footer"'))
        expect(hero).toContain('<h1>Welcome</h1>')
        expect(hero).toContain('<p>Edited copy</p>')
        expect(hero).not.toContain('Intro copy')
    })

    it('path navigation skips plugin-injected nodes, mirroring the client', async () => {
        const idx = INDEX.replace('<h1>Welcome</h1>', '<span data-edit-ghost=""></span>\n        <h1>Welcome</h1>')
        writeFileSync(path.join(dir, 'index.html'), idx)
        const { results } = await save([
            { kind: 'static', region: 'hero', edits: [{ path: '0', key: 'H1:Welcome', prop: 'text', value: 'Hello' }] }
        ])
        expect(results[0].status).toBe('written')
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        expect(html).toContain('<h1>Hello</h1>')                       // path 0 = first AUTHORED child
        expect(html).toContain('<span data-edit-ghost=""></span>')     // the stray ghost is untouched
    })

    it('a PRE-move text edit does not poison the destination order patch (repro A)', async () => {
        // Client: edit Alpha → move Alpha to footer → reorder footer (Delta above
        // Gamma). The arrival's live key re-derived from EDITED text (P:EditedAlpha)
        // while the file holds the authored text — the order patch must still apply.
        const idx = INDEX.replace('<p>Intro copy</p>', '<p>Alpha</p>')
            .replace('<p>Fine print</p>', '<p>Gamma</p>\n        <p>Delta</p>')
        writeFileSync(path.join(dir, 'index.html'), idx)
        const { results } = await save([
            { kind: 'static-move', from: 'hero', to: 'footer', key: 'P:Alpha', toKey: 'P:EditedAlpha', toOrder: ['P:Gamma', 'P:Delta', 'P:EditedAlpha'] },
            { kind: 'static', region: 'footer', order: ['P:Delta', 'P:Gamma', 'P:EditedAlpha'], edits: [{ path: '2', key: 'P:EditedAlpha', prop: 'text', value: 'EditedAlpha' }] }
        ])
        expect(results.map(r => r.status)).toEqual(['written', 'written'])
        expect(results[1].reordered).toBe(true)           // the destination order patch APPLIED
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        const footer = html.slice(html.indexOf('"footer"'))
        expect(footer).toContain('<p>EditedAlpha</p>')
        expect(footer.indexOf('<p>Delta</p>')).toBeLessThan(footer.indexOf('<p>Gamma</p>'))
        expect(footer.indexOf('<p>Gamma</p>')).toBeLessThan(footer.indexOf('<p>EditedAlpha</p>'))
    })

    it('a PRE-move edit plus a POST-reorder edit both land on the right elements (repro B)', async () => {
        // Same as repro A plus an edit of Gamma AFTER the reorder: its path (1) is a
        // final position — if the order patch is skipped, path 1 is Delta and the
        // edit destroys Delta's content.
        const idx = INDEX.replace('<p>Intro copy</p>', '<p>Alpha</p>')
            .replace('<p>Fine print</p>', '<p>Gamma</p>\n        <p>Delta</p>')
        writeFileSync(path.join(dir, 'index.html'), idx)
        const { results } = await save([
            { kind: 'static-move', from: 'hero', to: 'footer', key: 'P:Alpha', toKey: 'P:EditedAlpha', toOrder: ['P:Gamma', 'P:Delta', 'P:EditedAlpha'] },
            { kind: 'static', region: 'footer', order: ['P:Delta', 'P:Gamma', 'P:EditedAlpha'], edits: [
                { path: '2', key: 'P:EditedAlpha', prop: 'text', value: 'EditedAlpha' },
                { path: '1', key: 'P:Gamma', prop: 'text', value: 'EditedGamma' }
            ] }
        ])
        expect(results.map(r => r.status)).toEqual(['written', 'written'])
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        const footer = html.slice(html.indexOf('"footer"'))
        expect(footer).toContain('<p>Delta</p>')          // Delta's content survived
        expect(footer).toContain('<p>EditedGamma</p>')
        expect(footer).toContain('<p>EditedAlpha</p>')
        expect(footer).not.toContain('<p>Gamma</p>')
        expect(footer.indexOf('<p>Delta</p>')).toBeLessThan(footer.indexOf('<p>EditedGamma</p>'))
        expect(footer.indexOf('<p>EditedGamma</p>')).toBeLessThan(footer.indexOf('<p>EditedAlpha</p>'))
    })

    it('a PRE-move-edited arrival still resolves next to an authored twin (ordinal dedup)', async () => {
        // Destination holds an authored twin of the arrival's AUTHORED text. The twin
        // keeps its live key P:Same; the edited arrival must bind to the inserted
        // child, not steal the twin's key.
        const idx = `<!doctype html>
<html>
<body>
    <section x-edit="hero">
        <p data-m="arr">Same</p>
    </section>
    <section x-edit="footer">
        <p data-m="nat">Same</p>
    </section>
</body>
</html>
`
        writeFileSync(path.join(dir, 'index.html'), idx)
        const { results } = await save([
            { kind: 'static-move', from: 'hero', to: 'footer', key: 'P:Same', toKey: 'P:Edited', toOrder: ['P:Same', 'P:Edited'] },
            { kind: 'static', region: 'footer', order: ['P:Edited', 'P:Same'], edits: [{ path: '0', key: 'P:Edited', prop: 'text', value: 'Edited' }] }
        ])
        expect(results.map(r => r.status)).toEqual(['written', 'written'])
        expect(results[1].reordered).toBe(true)
        const html = readFileSync(path.join(dir, 'index.html'), 'utf8')
        const footer = html.slice(html.indexOf('"footer"'))
        expect(footer).toContain('<p data-m="arr">Edited</p>')
        expect(footer).toContain('<p data-m="nat">Same</p>')
        expect(footer.indexOf('data-m="arr"')).toBeLessThan(footer.indexOf('data-m="nat"'))
    })

    it('moves the authored markup between regions, placed by toOrder', async () => {
        writeFileSync(path.join(dir, 'index.html'), INDEX)
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

describe('/__edit/save nesting and attributes', () => {
    const NEST = `<!doctype html>
<html>
<body>
    <section x-edit="page">
        <div>
            <h3>Card</h3>
        </div>
        <p>Loose</p>
    </section>
</body>
</html>
`
    const region = () => { const h = readFileSync(path.join(dir, 'index.html'), 'utf8'); return h.slice(h.indexOf('"page"'), h.indexOf('</section>')) }

    it('nests a piece into a container inside the same region', async () => {
        writeFileSync(path.join(dir, 'index.html'), NEST)
        const { results } = await save([{ kind: 'static-move', from: 'page', to: 'page', toParent: 'DIV:Card', key: 'P:Loose', toKey: 'P:Loose', toOrder: ['H3:Card', 'P:Loose'] }])
        expect(results[0].status).toBe('written')
        const r = region()
        expect(r.indexOf('<p>Loose</p>')).toBeGreaterThan(r.indexOf('<h3>Card</h3>'))
        expect(r.indexOf('<p>Loose</p>')).toBeLessThan(r.indexOf('</div>'))
    })

    it('un-nests a piece out of its container', async () => {
        writeFileSync(path.join(dir, 'index.html'), NEST)
        const { results } = await save([{ kind: 'static-move', from: 'page', to: 'page', fromParent: 'DIV:Card', key: 'H3:Card', toKey: 'H3:Card', toOrder: ['DIV:', 'H3:Card', 'P:Loose'] }])
        expect(results[0].status).toBe('written')
        const r = region()
        expect(r.indexOf('<h3>Card</h3>')).toBeGreaterThan(r.indexOf('</div>'))
        expect(r.indexOf('<h3>Card</h3>')).toBeLessThan(r.indexOf('<p>Loose</p>'))
    })

    it('reorders a nested container by its key', async () => {
        writeFileSync(path.join(dir, 'index.html'), NEST.replace('<h3>Card</h3>', '<h3>Card</h3>\n            <p>Body</p>'))
        const { results } = await save([{ kind: 'static', region: 'page', edits: [], orders: { 'DIV:Card Body': ['P:Body', 'H3:Card'] } }])
        expect(results[0].reordered).toBe(true)
        const r = region()
        expect(r.indexOf('<p>Body</p>')).toBeLessThan(r.indexOf('<h3>Card</h3>'))
    })

    it('writes and removes plain attributes, and refuses unsafe ones', async () => {
        writeFileSync(path.join(dir, 'index.html'), NEST.replace('<p>Loose</p>', '<p hidden title="x">Loose</p>'))
        const { results } = await save([{ kind: 'static', region: 'page', edits: [
            { path: '1', key: 'P:Loose', prop: 'hidden', value: null },
            { path: '1', key: 'P:Loose', prop: 'aria-label', value: 'Loose copy' },
            { path: '1', key: 'P:Loose', prop: 'onclick', value: 'alert(1)' },
            { path: '0', key: 'DIV:Card', prop: 'href', value: 'javascript:alert(1)' }
        ] }])
        expect(results[0].status).toBe('written')
        const r = region()
        expect(r).toContain('<p title="x" aria-label="Loose copy">Loose</p>')
        expect(r).not.toContain('onclick')
        expect(r).not.toContain('javascript:')
    })
})
