/**
 * Source writer for static areas: /__edit/save `static-tree` rebuilds each region
 * from the client's final tree of identities, reusing the original markup of every
 * node it keeps. Feeds source + patches to the real server (--edit) and compares the
 * written file against the expected source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVE = path.join(__dirname, '../packages/run/serve.mjs')

let dir, proc, port

beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-tree-'))
    writeFileSync(path.join(dir, 'index.html'), '')
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'tree-test' }))
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

const K = (region, key) => '@' + encodeURIComponent(region) + '@' + key
const file = () => readFileSync(path.join(dir, 'index.html'), 'utf8')
async function write(src, patches) {
    writeFileSync(path.join(dir, 'index.html'), src)
    const { results } = await save(patches)
    return { results, out: file() }
}

const NEST = `<section x-edit="u">
    <div>
        <p>One</p>
        <p>Two</p>
        <p>Three</p>
    </div>
    <p>Four</p>
</section>
`
const tree = (region, children, extra = {}) => ({ kind: 'static-tree', region, tree: { key: '', children }, ...extra })
const n = (region, key, more = {}) => ({ key: K(region, key), ...more })

describe('/__edit/save static-tree', () => {
    it('unnest twice + edit: every node keeps its own markup', async () => {
        const { results, out } = await write(NEST, [tree('u', [
            n('u', 'DIV:One Two Three', { children: [n('u', 'P:Three')] }),
            n('u', 'P:One'),
            n('u', 'P:Two', { edits: { text: 'Two edited' } }),
            n('u', 'P:Four')
        ])])
        expect(results.map(r => r.status)).toEqual(['written'])
        expect(out).toBe(`<section x-edit="u">
    <div>
        <p>Three</p>
    </div>
    <p>One</p>
    <p>Two edited</p>
    <p>Four</p>
</section>
`)
    })

    it('nest into a container keeps indentation; an unchanged tree writes nothing', async () => {
        const { out } = await write(NEST, [tree('u', [n('u', 'DIV:One Two Three', { children: [n('u', 'P:Four'), n('u', 'P:One'), n('u', 'P:Two'), n('u', 'P:Three')] })])])
        expect(out).toBe(`<section x-edit="u">
    <div>
        <p>Four</p>
        <p>One</p>
        <p>Two</p>
        <p>Three</p>
    </div>
</section>
`)
        const same = await write(NEST, [tree('u', [n('u', 'DIV:One Two Three', { children: [n('u', 'P:One'), n('u', 'P:Two'), n('u', 'P:Three')] }), n('u', 'P:Four')])])
        expect(same.out).toBe(NEST)
    })

    it('twins are told apart by ordinal', async () => {
        const src = `<section x-edit="t"><div class="a"><p>Same</p></div><div class="b"><p>Same</p></div></section>`
        const { out } = await write(src, [tree('t', [
            n('t', 'DIV:Same', { children: [n('t', 'P:Same#2')] }),
            n('t', 'DIV:Same#2', { children: [n('t', 'P:Same', { edits: { text: 'First' } })] })
        ])])
        expect(out).toBe(`<section x-edit="t"><div class="a"><p>Same</p></div><div class="b"><p>First</p></div></section>`)
    })

    it('moves across areas, reusing the source markup', async () => {
        const src = `<section x-edit="a"><p data-x="1">One</p><p>Two</p></section>\n<section x-edit="b"><p>Three</p></section>`
        const { out } = await write(src, [
            tree('a', [n('a', 'P:Two')]),
            tree('b', [n('b', 'P:Three'), n('a', 'P:One')])
        ])
        expect(out).toBe(`<section x-edit="a"><p>Two</p></section>\n<section x-edit="b"><p>Three</p><p data-x="1">One</p></section>`)
    })

    it('copies render from their source; removed nodes drop', async () => {
        const src = `<section x-edit="c"><p class="k">Keep</p><p>Gone</p></section>`
        const { out } = await write(src, [tree('c', [
            n('c', 'P:Keep'),
            { key: '~abc~' + K('c', 'P:Keep'), edits: { text: 'Copy' } }
        ], { removed: [K('c', 'P:Gone')] })])
        expect(out).toBe(`<section x-edit="c"><p class="k">Keep</p><p class="k">Copy</p></section>`)
    })

    it('refuses to lose a node that is neither placed nor removed; writes nothing', async () => {
        const src = `<section x-edit="l"><p>One</p><p>Two</p></section>`
        const { results, out } = await write(src, [tree('l', [n('l', 'P:One')])])
        expect(results[0].status).toBe('error')
        expect(results[0].reason).toContain('would be lost')
        expect(out).toBe(src)
    })

    it('refuses a move whose source area is not rebuilt (would duplicate)', async () => {
        const src = `<section x-edit="a"><p>One</p></section><section x-edit="b"><p>Two</p></section>`
        const { results, out } = await write(src, [tree('b', [n('b', 'P:Two'), n('a', 'P:One')])])
        expect(results[0].status).toBe('error')
        expect(out).toBe(src)
    })

    it('falls back to the origin path when the content key differs from source', async () => {
        const src = `<section x-edit="p"><span x-text="name">Fallback</span><p>Body</p></section>`
        const { out } = await write(src, [tree('p', [n('p', 'P:Body'), { key: K('p', 'SPAN:Alice'), at: '0' }])])
        expect(out).toBe(`<section x-edit="p"><p>Body</p><span x-text="name">Fallback</span></section>`)
    })
})

describe('/__edit/save attribute and text safety', () => {
    const one = (edits, tag = 'p', inner = 'One') => write(`<section x-edit="s"><${tag} title=old hidden hidden>${inner}</${tag}></section>`,
        [tree('s', [n('s', `${tag.toUpperCase()}:${inner}`, { edits })])])

    it('escapes & " < so a value can never leave its attribute or decode into a scheme', async () => {
        const { out } = await one({ title: 'a &amp; b" onclick="y<' })
        expect(out).toContain('title="a &amp;amp; b&quot; onclick=&quot;y&lt;"')
        const ent = await one({ href: '&#106;avascript:alert(1)' }, 'a')
        expect(ent.results[0].status).toBe('error')                  // checked entity-decoded too
    })

    it('replaces unquoted values in place, removes every duplicate of a boolean', async () => {
        const { out } = await one({ title: 'new', hidden: null })
        expect(out).toBe(`<section x-edit="s"><p title="new">One</p></section>`)
    })

    it('never matches attribute-like text inside another value', async () => {
        const src = `<section x-edit="s"><h2 x-init="title = 'Hello'">Heading</h2></section>`
        const { out } = await write(src, [tree('s', [n('s', 'H2:Heading', { edits: { title: 'x onmouseover=alert(1) y' } })])])
        expect(out).toBe(`<section x-edit="s"><h2 x-init="title = 'Hello'" title="x onmouseover=alert(1) y">Heading</h2></section>`)
    })

    it('style/class null or empty remove the attribute instead of writing "null"', async () => {
        const src = `<section x-edit="s"><p style="color: red" class="a">One</p></section>`
        const { out } = await write(src, [tree('s', [n('s', 'P:One', { edits: { style: null, class: '' } })])])
        expect(out).toBe(`<section x-edit="s"><p>One</p></section>`)
    })

    it('guardrails refuse the batch: script and data schemes, handlers, SVG animation targets', async () => {
        const bad = [
            [{ href: 'java\tscript:alert(1)' }, 'a'], [{ href: '&#106;avascript:x' }, 'a'], [{ title: 'data:text/html,x' }, 'p'],
            [{ data: 'data:text/html,<script>x</script>' }, 'object'], [{ src: 'data:image/svg+xml,<svg onload=x>' }, 'iframe'],
            [{ src: 'data:image/svg+xml;base64,AAAA' }, 'img'], [{ onclick: 'x' }, 'p'], [{ 'x-on:click': 'x' }, 'p'],
            [{ attributeName: 'href' }, 'set'], [{ style: 'background:url(javascript:x)' }, 'p']
        ]
        for (const [edits, tag] of bad) {
            const src = `<section x-edit="s"><${tag}>One</${tag}></section>`
            const { results, out } = await write(src, [tree('s', [n('s', `${tag.toUpperCase()}:One`, { edits })])])
            expect(results[0].status, JSON.stringify(edits)).toBe('error')
            expect(out).toBe(src)
        }
        const ok = await write(`<section x-edit="s"><img src="/a.png"></section>`, [tree('s', [n('s', 'IMG:', { edits: { src: 'data:image/png;base64,AAAA' } })])])
        expect(ok.results[0].status).toBe('written')
    })

    it('sanitizes text on the server with the client allowlist', async () => {
        const { out } = await one({ text: 'Hi <a href="java&#9;script:alert(1)">x</a> <a href="https://ok.test" onclick="y">ok</a><script>alert(2)</script><img src=x onerror=alert(3)><b>bold</b>' })
        expect(out).toBe(`<section x-edit="s"><p title=old hidden hidden>Hi <a>x</a> <a href="https://ok.test">ok</a><img src="x"><b>bold</b></p></section>`)
    })

    it('path navigation skips plugin-injected nodes, mirroring the client', async () => {
        const src = `<section x-edit="g"><span data-edit-ghost=""></span><h1>Welcome</h1></section>`
        const { out } = await write(src, [tree('g', [n('g', 'H1:Welcome', { edits: { text: 'Hello' } })])])
        expect(out).toBe(`<section x-edit="g"><span data-edit-ghost=""></span><h1>Hello</h1></section>`)
    })
})
