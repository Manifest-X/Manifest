/**
 * Source writer for static areas: /__edit/save `static-tree` rebuilds each region
 * from the client's final tree of identities, reusing the original markup of every
 * node it keeps. Feeds source + patches to the real server (--edit) and compares the
 * written file against the expected source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, symlinkSync, readdirSync, lstatSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'path'
import { fileURLToPath } from 'url'
import { withBase } from './helpers/edit-base.js'

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

const save = async (patches) => fetch(`http://localhost:${port}/__edit/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': `http://localhost:${port}` },
    body: JSON.stringify(Array.isArray(patches) ? await withBase(port, patches) : patches)
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
// Fingerprints of `src` as a page loading it would get them.
async function loadedIds(src) { writeFileSync(path.join(dir, 'index.html'), src); return (await fetch(`http://localhost:${port}/__edit/base`).then(r => r.json())).ids['index.html'] }
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

    it('takes the origin path only when tag and text agree (just the ordinal differs)', async () => {
        const src = `<section x-edit="p"><p>Same</p><p>Body</p></section>`
        const same = (await loadedIds(src))[K('p', 'P:Same')]
        const { out } = await write(src, [tree('p', [n('p', 'P:Body'), { key: K('p', 'P:Same#3'), at: '0', fp: same }])])
        expect(out).toBe(`<section x-edit="p"><p>Body</p><p>Same</p></section>`)
        const wrong = await write(src, [tree('p', [n('p', 'P:Same'), { key: K('p', 'P:Other'), at: '1' }])])
        expect(wrong.results[0].status).toBe('error')                // a different element at that path is never taken
        expect(wrong.out).toBe(src)
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

describe('/__edit/save parsing as a browser does', () => {
    it('raw-text elements and comments are opaque: "</div>" in a script or comment cannot close anything', async () => {
        const src = `<section x-edit="r"><div><script>var s = "</div><p>";</script><p>One</p></div><!-- </section> --><p>Two</p></section>`
        const { results, out } = await write(src, [tree('r', [n('r', 'P:Two'), n('r', 'DIV:var s = "</div><p>";One')])])
        expect(results[0].status).toBe('written')
        expect(out).toBe(`<section x-edit="r"><!-- </section> --><p>Two</p><div><script>var s = "</div><p>";</script><p>One</p></div></section>`)
    })

    it('reads abrupt comments, --!>, CDATA in SVG, </br> and a stray </p> as browsers do', async () => {
        const src = `<section x-edit="q"><div><!--><p>x</p>--><p>y</p></div><div><!-- a --!><p>z</p></div><p>t<svg><text><![CDATA[<p>x</p> a > b]]></text></svg>u</p><div>a</br>b</p></div><p>last</p></section>`
        const { results, out } = await write(src, [tree('q', [n('q', 'P:last'), n('q', 'DIV:x-->y'), n('q', 'DIV:z'), n('q', 'P:t<p>x</p> a > bu'), n('q', 'DIV:ab')])])
        expect(results[0].status, JSON.stringify(results)).toBe('written')
        expect(out).toBe(`<section x-edit="q"><p>last</p><div><!--><p>x</p>--><p>y</p></div><div><!-- a --!><p>z</p></div><p>t<svg><text><![CDATA[<p>x</p> a > b]]></text></svg>u</p><div>a</br>b</p></div></section>`)
    })

    it('decodes every named entity as the browser does, so keys match', async () => {
        const src = `<section x-edit="e"><p>Caf&eacute; &mdash; &rightarrow; &copy 2024</p><p>Two</p></section>`
        const { results, out } = await write(src, [tree('e', [n('e', 'P:Two'), n('e', 'P:Café — → © 2024', { edits: { text: 'Edited' } })])])
        expect(results[0].status).toBe('written')
        expect(out).toBe(`<section x-edit="e"><p>Two</p><p>Edited</p></section>`)
    })

    it('models implied <tbody> and implied end tags (li, p, dt/dd, td)', async () => {
        const src = `<section x-edit="t"><table><tr><td>A<td>B</table><ul><li>One<li>Two</ul><p>Para<div>Block</div></section>`
        const { results, out } = await write(src, [tree('t', [
            n('t', 'TABLE:AB', { children: [n('t', 'TBODY:AB', { children: [n('t', 'TR:AB', { children: [n('t', 'TD:B'), n('t', 'TD:A', { edits: { text: 'A2' } })] })] })] }),
            n('t', 'UL:OneTwo', { children: [n('t', 'LI:Two'), n('t', 'LI:One')] }),
            n('t', 'P:Para'), n('t', 'DIV:Block')
        ])])
        expect(results[0].status).toBe('written')
        // Rebuilt children with implied end tags get explicit ones; the implied tbody stays implied.
        expect(out).toBe(`<section x-edit="t"><table><tr><td>B</td><td>A2</td></tr></table><ul><li>Two</li><li>One</li></ul><p>Para</p><div>Block</div></section>`)
    })

    it('a titling comment moves with its element; a blank line keeps it in place', async () => {
        const src = `<section x-edit="c">
    <p>Intro</p>
    <!-- Header -->
    <h1>Title</h1>
    <!-- Section label -->

    <p>Body</p>
</section>`
        const { out } = await write(src, [tree('c', [n('c', 'P:Intro'), n('c', 'P:Body'), n('c', 'H1:Title')])])
        expect(out).toBe(`<section x-edit="c">
    <p>Intro</p>
    <p>Body</p>
    <!-- Section label -->

    <!-- Header -->
    <h1>Title</h1>
</section>`)
    })

    it('a comment that opens its container titles the section, not the first child', async () => {
        const src = `<section x-edit="o"><!-- Section --><p>A</p><p>B</p></section>`
        const { out } = await write(src, [tree('o', [n('o', 'P:B'), n('o', 'P:A')])])
        expect(out).toBe(`<section x-edit="o"><!-- Section --><p>B</p><p>A</p></section>`)
    })

    it('rebuilt empty containers use the file\'s line endings', async () => {
        const src = `<section x-edit="l">\r\n  <div class="box"></div>\r\n  <p>Mover</p>\r\n</section>`
        const { out } = await write(src, [tree('l', [n('l', 'DIV:Mover', { at: '0', children: [n('l', 'P:Mover')] })])].map(p => (p.tree.children[0].key = K('l', 'DIV:'), p)))
        expect(out).toBe(`<section x-edit="l">\r\n  <div class="box">\r\n      <p>Mover</p>\r\n  </div>\r\n</section>`)
        expect(out.replace(/\r\n/g, '')).not.toContain('\n')
    })

    it('refuses a removal whose container is kept as is', async () => {
        const src = `<section x-edit="k"><div><p>Child</p></div><p>Two</p></section>`
        const { results, out } = await write(src, [tree('k', [n('k', 'DIV:Child'), n('k', 'P:Two', { edits: { title: 'x' } })], { removed: [K('k', 'P:Child')] })])
        expect(results[0].status).toBe('error')
        expect(out).toBe(src)
    })

    it('refuses script-loading attributes and text edits on raw-text elements', async () => {
        const cases = [
            [`<script>x</script>`, 'SCRIPT:x', { src: 'https://evil.example/x.js' }], [`<script>x</script>`, 'SCRIPT:x', { type: 'module' }],
            [`<script>x</script>`, 'SCRIPT:x', { text: 'alert(1)' }], [`<style>a{}</style>`, 'STYLE:a{}', { text: 'b{}' }],
            [`<iframe src="/a"></iframe>`, 'IFRAME:', { src: 'https://evil.example/' }], [`<object>o</object>`, 'OBJECT:o', { data: '/x.swf' }],
            [`<link href="/a.css">`, 'LINK:', { href: '/evil.css' }], [`<meta content="x">`, 'META:', { 'http-equiv': 'refresh' }],
            [`<form>f</form>`, 'FORM:f', { action: 'https://evil.example/' }], [`<button>b</button>`, 'BUTTON:b', { formaction: '/x' }]
        ]
        for (const [el, k, edits] of cases) {
            const src = `<section x-edit="s">${el}</section>`
            const { results, out } = await write(src, [tree('s', [n('s', k, { edits })])])
            expect(results[0].status, el + JSON.stringify(edits)).toBe('error')
            expect(out).toBe(src)
        }
    })

    it('all or nothing across kinds: a failing theme patch leaves the static rewrite unwritten', async () => {
        const src = `<section x-edit="a"><p>One</p></section>`
        writeFileSync(path.join(dir, 'index.html'), src)
        const { results } = await save([
            tree('a', [n('a', 'P:One', { edits: { text: 'Uno' } })]),
            { kind: 'theme', scope: null, var: 'not a var', value: 'red' }
        ])
        expect(results.map(r => r.status)).toEqual(['skipped', 'error'])
        expect(file()).toBe(src)
    })

    it('refuses drops that break the HTML content model, naming the rule', async () => {
        const cases = [
            [`<table><tbody><tr><td>x</td></tr></tbody></table><p>z</p>`, [{ k: 'TABLE:x', c: [{ k: 'TBODY:x', c: [{ k: 'TR:x' }, { k: 'P:z' }] }] }], 'takes only tr'],
            [`<table><tbody><tr><td>x</td></tr></tbody></table><div><p>d</p></div>`, [{ k: 'TABLE:x', c: [{ k: 'TBODY:x', c: [] }] }, { k: 'DIV:d', c: [{ k: 'P:d' }, { k: 'TR:x' }] }], 'belongs in'],
            [`<form><div><p>in</p></div></form><form><p>f2</p></form>`, [{ k: 'FORM:in', c: [{ k: 'DIV:in', c: [{ k: 'P:in' }, { k: 'FORM:f2' }] }] }], 'form cannot contain a form'],
            [`<a href="/x"><div><p>c</p></div></a><button>b</button>`, [{ k: 'A:c', c: [{ k: 'DIV:c', c: [{ k: 'P:c' }, { k: 'BUTTON:b' }] }] }], 'interactive'],
            [`<ul><li>i</li></ul><div><p>d</p></div>`, [{ k: 'UL:i', c: [] }, { k: 'DIV:d', c: [{ k: 'P:d' }, { k: 'LI:i' }] }], 'belongs in ul'],
            [`<p>para</p><div>block</div>`, [{ k: 'P:para', c: [{ k: 'DIV:block' }] }], 'inline content']
        ]
        const build = (nodes) => nodes.map(x => ({ key: K('m', x.k), ...(x.c ? { children: build(x.c) } : {}) }))
        for (const [inner, nodes, why] of cases) {
            const src = `<section x-edit="m">${inner}</section>`
            const { results, out } = await write(src, [tree('m', build(nodes))])
            expect(results[0].status, inner).toBe('error')
            expect(results[0].reason).toContain(why)
            expect(out).toBe(src)
        }
    })

    it('theme values cannot leave their declaration; $ patterns are literal', async () => {
        const css = `:root {\n    --brand: blue;\n}\n`
        const themeFile = path.join(dir, 'styles/core/manifest.theme.css')
        mkdirSync(path.dirname(themeFile), { recursive: true })
        for (const bad of ['red; } body { color: red } :root { --x: 1', 'a{b', 'x /* c */', 'url(a', '"open']) {
            writeFileSync(themeFile, css)
            const { results } = await save([{ kind: 'theme', scope: null, var: '--brand', value: bad }])
            expect(results[0].status, bad).toBe('error')
            expect(readFileSync(themeFile, 'utf8')).toBe(css)
        }
        writeFileSync(themeFile, css)
        await save([{ kind: 'theme', scope: null, var: '--brand', value: "'$& $' $1'" }])
        expect(readFileSync(themeFile, 'utf8')).toBe(`:root {\n    --brand: blue;\n}\n`)              // unbalanced quote: refused
        await save([{ kind: 'theme', scope: null, var: '--brand', value: "'$& $1 $$'" }])
        expect(readFileSync(themeFile, 'utf8')).toBe(`:root {\n    --brand: '$& $1 $$';\n}\n`)
    })

    it('component patches resolve listed and convention components', async () => {
        mkdirSync(path.join(dir, 'components'), { recursive: true })
        const comp = `<div class="card"><h3>Card title</h3></div>\n`
        for (const listed of [true, false]) {
            writeFileSync(path.join(dir, 'components/card.html'), comp)
            writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(listed ? { components: ['components/card.html'] } : { name: 'x' }))
            writeFileSync(path.join(dir, 'index.html'), `<section x-edit="a"><p>One</p></section>`)
            const { results } = await save([{ kind: 'component', scope: 'main', component: 'card', edits: [{ path: '0', prop: 'text', value: 'Edited title' }] }])
            expect(results[0].status, String(listed)).toBe('written')
            expect(readFileSync(path.join(dir, 'components/card.html'), 'utf8')).toBe(`<div class="card"><h3>Edited title</h3></div>\n`)
        }
        writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'tree-test' }))
    })

    it('an unwritable file fails the batch cleanly: nothing written, a response sent, the server alive', async () => {
        const themeFile = path.join(dir, 'styles/core/manifest.theme.css')
        mkdirSync(path.dirname(themeFile), { recursive: true })
        const css = `:root {\n    --brand: blue;\n}\n`, src = `<section x-edit="a"><p>One</p></section>`
        writeFileSync(themeFile, css); writeFileSync(path.join(dir, 'index.html'), src)
        chmodSync(themeFile, 0o444)
        try {
            const { results } = await save([tree('a', [n('a', 'P:One', { edits: { text: 'Uno' } })]), { kind: 'theme', scope: null, var: '--brand', value: 'red' }])
            expect(results.every(r => r.status === 'error')).toBe(true)
            expect(results[0].reason).toContain('not writable')
            expect(file()).toBe(src)
            expect(readFileSync(themeFile, 'utf8')).toBe(css)
        } finally { chmodSync(themeFile, 0o644) }
        const alive = await fetch(`http://localhost:${port}/manifest.json`).then(r => r.status)
        expect(alive).toBe(200)
    })

    it('a failed commit never live-reloads the page; a successful one does', async () => {
        const events = []
        const sse = http.get(`http://localhost:${port}/__mnfst_sse__?tabId=t-${Date.now()}`, res => res.on('data', c => events.push(String(c))))
        await new Promise(r => setTimeout(r, 300))
        const core = path.join(dir, 'styles/core'), themeFile = path.join(core, 'manifest.theme.css')
        mkdirSync(core, { recursive: true })
        writeFileSync(themeFile, `:root {\n    --brand: blue;\n}\n`)
        const src = `<section x-edit="a"><p>One</p></section>`
        writeFileSync(path.join(dir, 'index.html'), src)
        chmodSync(core, 0o555)
        await new Promise(r => setTimeout(r, 700)); events.length = 0   // the test's own writes and chmod settle first
        try {
            const { results } = await save([tree('a', [n('a', 'P:One', { edits: { text: 'Uno' } })]), { kind: 'theme', scope: null, var: '--brand', value: 'red' }])
            expect(results.every(r => r.status === 'error')).toBe(true)
            await new Promise(r => setTimeout(r, 600))
            expect(events.join('')).not.toMatch(/reload|"css"/)
            expect(readdirSync(core).filter(f => f.includes('.mnfst-edit-'))).toEqual([])
            expect(readdirSync(dir).filter(f => f.includes('.mnfst-edit-'))).toEqual([])
        } finally { chmodSync(core, 0o755) }
        const ok = await save([tree('a', [n('a', 'P:One', { edits: { text: 'Uno' } })])])
        expect(ok.results[0].status).toBe('written')
        await new Promise(r => setTimeout(r, 600))
        expect(events.join('')).toMatch(/reload/)
        sse.destroy()
    })

    it('writes through a symlink to the real file, keeping the link', async () => {
        mkdirSync(path.join(dir, 'real'), { recursive: true })
        const real = path.join(dir, 'real/page.html'), src = `<section x-edit="a"><p>One</p></section>`
        writeFileSync(real, src)
        rmSync(path.join(dir, 'index.html'), { force: true })
        symlinkSync(real, path.join(dir, 'index.html'))
        try {
            const { results } = await save([tree('a', [n('a', 'P:One', { edits: { text: 'Uno' } })])])
            expect(results[0].status).toBe('written')
            expect(lstatSync(path.join(dir, 'index.html')).isSymbolicLink()).toBe(true)
            expect(readFileSync(real, 'utf8')).toBe(`<section x-edit="a"><p>Uno</p></section>`)
        } finally { rmSync(path.join(dir, 'index.html'), { force: true }); writeFileSync(path.join(dir, 'index.html'), '') }
    })

    it('a duplicate does not copy the titling comment', async () => {
        const src = `<section x-edit="d">\n    <p>Zero</p>\n    <!-- Card -->\n    <p>One</p>\n</section>`
        const { out } = await write(src, [tree('d', [n('d', 'P:Zero'), n('d', 'P:One'), { key: '~abc~' + K('d', 'P:One') }])])
        expect(out).toBe(`<section x-edit="d">\n    <p>Zero</p>\n    <!-- Card -->\n    <p>One</p>\n    <p>One</p>\n</section>`)
    })

    it('content model checks use the final tree: ancestors as placed, template contents counted', async () => {
        // the div left its form, so a form-holding piece may now go into it
        const src1 = `<section x-edit="f"><form><div class="x"><p>in</p></div></form><div class="y"><form><p>f</p></form></div></section>`
        const ok = await write(src1, [tree('f', [n('f', 'FORM:in', { children: [] }), n('f', 'DIV:in', { children: [n('f', 'P:in'), n('f', 'DIV:f', { children: [n('f', 'FORM:f')] })] })], { removed: [] })].map(p => (p.tree.children[2] = undefined, p.tree.children = p.tree.children.filter(Boolean), p)))
        expect(ok.results[0].status, JSON.stringify(ok.results)).toBe('written')
        // a piece whose x-if template holds an <a> cannot go into a link
        const src2 = `<section x-edit="g"><a href="/card"><div class="in"><span>card</span></div></a><div class="p"><template x-if="on"><a href="/x">x</a></template></div></section>`
        const bad = await write(src2, [tree('g', [n('g', 'A:card', { children: [n('g', 'DIV:card', { children: [n('g', 'SPAN:card'), n('g', 'DIV:')] })] })])])
        expect(bad.results[0].status).toBe('error')
        expect(bad.results[0].reason).toContain('interactive')
    })

    it('theme values: strings and data images are fine; breakouts, script urls and expression() are not', async () => {
        const themeFile = path.join(dir, 'styles/core/manifest.theme.css'), css = `:root {\n    --brand: blue;\n}\n`
        mkdirSync(path.dirname(themeFile), { recursive: true })
        for (const good of ['url(data:image/png;base64,AAAA)', '"a; b {c}"', "url('x.png') no-repeat", 'calc(1px + 2px)']) {
            writeFileSync(themeFile, css)
            const { results } = await save([{ kind: 'theme', scope: null, var: '--brand', value: good }])
            expect(results[0].status, good).toBe('written')
        }
        writeFileSync(themeFile, css)                                  // a ; inside a string is not the end of the declaration
        await save([{ kind: 'theme', scope: null, var: '--brand', value: '"a;b"' }])
        await save([{ kind: 'theme', scope: null, var: '--brand', value: 'red' }])
        expect(readFileSync(themeFile, 'utf8')).toBe(`:root {\n    --brand: red;\n}\n`)
        for (const bad of ['red; }', 'url(javascript:alert(1))', 'url( "JaVa\tscript:x" )', 'expression(alert(1))', 'url(data:text/html,x)', 'a </style>', 'x /* y', '"open', 'url(a', '(a]']) {
            writeFileSync(themeFile, css)
            const { results } = await save([{ kind: 'theme', scope: null, var: '--brand', value: bad }])
            expect(results[0].status, bad).toBe('error')
            expect(readFileSync(themeFile, 'utf8')).toBe(css)
        }
    })

    it('a publish whose source changed since the page loaded is refused; hashes come back on success', async () => {
        const src = `<section x-edit="h"><p>One</p></section>`
        writeFileSync(path.join(dir, 'index.html'), src)
        const base = await fetch(`http://localhost:${port}/__edit/base`).then(r => r.json())
        expect(base.files['index.html']).toMatch(/^[0-9a-f]{40}$/)
        writeFileSync(path.join(dir, 'index.html'), src.replace('One', 'One ').replace('<p>One </p>', '<p>One</p> '))
        const stale = await fetch(`http://localhost:${port}/__edit/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` }, body: JSON.stringify({ patches: [tree('h', [n('h', 'P:One', { edits: { text: 'Uno' }, fp: base.ids['index.html'][K('h', 'P:One')] })])], base: base.files }) }).then(r => r.json())
        expect(stale.results[0].status).toBe('error')
        expect(stale.results[0].reason).toContain('source changed since this page loaded (index.html)')
        const fresh = await fetch(`http://localhost:${port}/__edit/base`).then(r => r.json())
        const ok = await fetch(`http://localhost:${port}/__edit/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` }, body: JSON.stringify({ patches: [tree('h', [n('h', 'P:One', { edits: { text: 'Uno' }, fp: fresh.ids['index.html'][K('h', 'P:One')] })])], base: fresh.files }) }).then(r => r.json())
        expect(ok.results[0].status).toBe('written')
        expect(ok.base['index.html']).toMatch(/^[0-9a-f]{40}$/)
        expect(ok.base['index.html']).not.toBe(fresh.files['index.html'])
    })
})

describe('/__edit/save static areas in component files', () => {
    const raw = (body) => fetch(`http://localhost:${port}/__edit/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` }, body: JSON.stringify(body) }).then(r => r.json())
    const comp = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text) }
    const cTree = (component, region, children) => ({ kind: 'static-tree', region, component, tree: { key: '', path: true, children } })

    it('writes the component file; its ids and base come from /__edit/base; fingerprints are required', async () => {
        writeFileSync(path.join(dir, 'index.html'), `<x-promo></x-promo>`)
        comp('components/promo.html', `<section x-edit="pr">\n  <h2>Promo</h2>\n</section>\n`)
        const { files, ids } = await fetch(`http://localhost:${port}/__edit/base`).then(r => r.json())
        expect(Object.keys(ids)).toContain('components/promo.html')
        const fp = ids['components/promo.html'][K('pr', 'H2:Promo')]
        expect(fp).toBeTruthy()
        const noFp = await raw({ patches: [cTree('promo', 'pr', [n('pr', 'H2:Promo', { at: '0', edits: { text: 'X' } })])], base: files })
        expect(noFp.results[0].reason).toContain('without the fingerprint')
        const ok = await raw({ patches: [cTree('promo', 'pr', [n('pr', 'H2:Promo', { at: '0', fp, edits: { text: 'Promo page' } })])], base: files })
        expect(ok.results[0].status, JSON.stringify(ok)).toBe('written')
        expect(readFileSync(path.join(dir, 'components/promo.html'), 'utf8')).toBe(`<section x-edit="pr">\n  <h2>Promo page</h2>\n</section>\n`)
        expect(ok.ids['components/promo.html'][K('pr', 'H2:Promo page')]).toBeTruthy()
        expect(file()).toBe(`<x-promo></x-promo>`)
    })

    it('refuses components that are not declared or by convention, and props bound by $modify', async () => {
        writeFileSync(path.join(dir, 'index.html'), `<x-promo></x-promo>`)
        comp('components/promo.html', `<section x-edit="pr">\n  <a href="$modify('link')">Go</a>\n</section>\n`)
        for (const component of ['../index', 'nope', '../.git/x', '../NODE_MODULES/pkg/page']) {
            const r = await save([cTree(component, 'pr', [n('pr', 'A:Go', { at: '0', edits: { text: 'Went' } })])])
            expect(r.results[0].status, component).toBe('error')
        }
        const bound = await save([cTree('promo', 'pr', [n('pr', 'A:Go', { at: '0', edits: { href: '/x' } })])])
        expect(bound.results[0].reason).toContain('$modify')
        const text = await save([cTree('promo', 'pr', [n('pr', 'A:Go', { at: '0', edits: { text: 'Went' } })])])
        expect(text.results[0].status).toBe('written')
        expect(readFileSync(path.join(dir, 'components/promo.html'), 'utf8')).toContain(`<a href="$modify('link')">Went</a>`)
    })
})

describe('/__edit/save component hosts', () => {
    const comp = (rel, text) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), text) }
    const st = (region, children, base, extra = {}) => ({ kind: 'static-tree', region, ...extra, tree: { key: '', children, base } })

    it('a host counts as what its component renders: a block root never goes into a <p>, an inline one does', async () => {
        comp('components/card.html', `<div class="card"><h3>Card</h3></div>\n`)
        comp('components/badge.html', `<span class="badge">B</span>\n`)
        for (const [tag, ok] of [['card', false], ['badge', true]]) {
            const src = `<section x-edit="hc"><p><span>x</span></p><x-${tag} size="s"></x-${tag}></section>`
            writeFileSync(path.join(dir, 'index.html'), src)
            const H = 'X-' + tag.toUpperCase() + ':'
            const { results, out } = await (async () => {
                const r = await save([st('hc', [n('hc', 'P:x', { at: '0', base: [n('hc', 'SPAN:x', { at: '0.0' })], children: [n('hc', 'SPAN:x', { at: '0.0' }), n('hc', H, { at: '1' })] })], [n('hc', 'P:x', { at: '0' }), n('hc', H, { at: '1' })])])
                return { results: r.results, out: file() }
            })()
            if (ok) { expect(results[0].status, JSON.stringify(results)).toBe('written'); expect(out).toBe(`<section x-edit="hc"><p><span>x</span><x-badge size="s"></x-badge></p></section>`) }
            else { expect(results[0].reason).toContain('inline content'); expect(out).toBe(src) }
        }
    })

    it('nor into a file it includes through other components', async () => {
        comp('components/hero.html', `<section class="hero"><x-mid></x-mid></section>\n`)
        comp('components/mid.html', `<div class="mid"><x-card></x-card></div>\n`)
        comp('components/card.html', `<div x-edit="cr"><p>C</p></div>\n`)
        writeFileSync(path.join(dir, 'index.html'), `<section x-edit="ix"><h1>T</h1><x-hero></x-hero></section>`)
        const r = await save([
            st('ix', [n('ix', 'H1:T', { at: '0' })], [n('ix', 'H1:T', { at: '0' }), n('ix', 'X-HERO:', { at: '1' })]),
            st('cr', [n('cr', 'P:C', { at: '0' }), n('ix', 'X-HERO:', { at: '1' })], [n('cr', 'P:C', { at: '0' })], { component: 'card' })
        ])
        expect(r.results.map(x => x.status)).toContain('error')
        expect(JSON.stringify(r.results)).toContain('which would then include itself')
        expect(readFileSync(path.join(dir, 'components/card.html'), 'utf8')).toBe(`<div x-edit="cr"><p>C</p></div>\n`)
        expect(file()).toBe(`<section x-edit="ix"><h1>T</h1><x-hero></x-hero></section>`)
    })

    it('a component never goes into its own file', async () => {
        comp('components/promo.html', `<div x-edit="pr2"><p>P</p></div>\n`)
        writeFileSync(path.join(dir, 'index.html'), `<section x-edit="ix"><h1>T</h1><x-promo></x-promo></section>`)
        const r = await save([
            st('ix', [n('ix', 'H1:T', { at: '0' })], [n('ix', 'H1:T', { at: '0' }), n('ix', 'X-PROMO:', { at: '1' })]),
            st('pr2', [n('pr2', 'P:P', { at: '0' }), n('ix', 'X-PROMO:', { at: '1' })], [n('pr2', 'P:P', { at: '0' })], { component: 'promo' })
        ])
        expect(r.results.map(x => x.status)).toContain('error')
        expect(JSON.stringify(r.results)).toContain('its own component file')
        expect(readFileSync(path.join(dir, 'components/promo.html'), 'utf8')).toBe(`<div x-edit="pr2"><p>P</p></div>\n`)
    })
})

describe('/__edit/save element fingerprints', () => {
    const ids = () => fetch(`http://localhost:${port}/__edit/base`).then(r => r.json()).then(j => j.ids['index.html'])
    // Every node carries the fingerprint the page loaded with, as the client sends it.
    const withFp = (t, map) => { if (map[t.key]) t.fp = map[t.key]; (t.children || []).forEach(c => withFp(c, map)); (t.base || []).forEach(b => withFp(b, map)); return t }
    // A root without a base is only a path to its edits, as the client sends it.
    const send = (patches, map) => save(patches.map(p => ({ ...p, tree: { ...(p.tree.base ? {} : { path: true }), ...p.tree, children: p.tree.children.map(c => withFp(c, map)) } })))
    const page = (body) => writeFileSync(path.join(dir, 'index.html'), body)

    it('twins swapped elsewhere: an edit to one is refused, not written into the other', async () => {
        const src = `<section x-edit="f1">\n  <div class="card red"><p>Same</p></div>\n  <div class="card blue"><p>Same</p></div>\n</section>`
        page(src); const map = await ids()
        const swapped = src.replace(/(<div class="card red">.*<\/div>)\n  (<div class="card blue">.*<\/div>)/, '$2\n  $1')
        page(swapped)
        const { results } = await send([tree('f1', [n('f1', 'DIV:Same#2', { at: '1', path: true, children: [n('f1', 'P:Same#2', { at: '1.0', edits: { text: 'Blue page' } })] })])], map)
        expect(results[0].status).toBe('error')
        expect(results[0].reason).toContain(`identical elements`)
        expect(file()).toBe(swapped)
    })

    it('twin lists swapped elsewhere: the list item edit is refused', async () => {
        const src = `<section x-edit="f2">\n  <ul class="first"><li>Item</li></ul>\n  <ul class="second"><li>Item</li></ul>\n</section>`
        page(src); const map = await ids()
        const swapped = src.replace('<ul class="first"><li>Item</li></ul>\n  <ul class="second"><li>Item</li></ul>', '<ul class="second"><li>Item</li></ul>\n  <ul class="first"><li>Item</li></ul>')
        page(swapped)
        const { results } = await send([tree('f2', [n('f2', 'UL:Item#2', { at: '1', path: true, children: [n('f2', 'LI:Item#2', { at: '1.0', edits: { text: 'Second page' } })] })])], map)
        expect(results[0].status).toBe('error')
        expect(results[0].reason).toContain(`identical elements`)
        expect(file()).toBe(swapped)
    })

    it('the path fallback does not bind another container that took the old place', async () => {
        const src = `<section x-edit="f3">\n  <div class="A"><p>Xray</p><p>Zulu</p></div>\n  <div class="B"><p>Whiskey</p></div>\n</section>`
        page(src); const map = await ids()
        const moved = `<section x-edit="f3">\n  <div class="B"><p>Xray</p><p>Whiskey</p></div>\n  <div class="A"><p>Zulu</p></div>\n</section>`
        page(moved)
        const { results } = await send([tree('f3', [n('f3', 'DIV:XrayZulu', { at: '0', path: true, edits: { title: 'page-title' }, children: [n('f3', 'P:Xray', { at: '0.0', edits: { text: 'Xray page' } })] })])], map)
        expect(results[0].status).toBe('error')
        expect(results[0].reason).toContain(`changed or moved since this page loaded`)
        expect(file()).toBe(moved)
    })

    it('a restructured container whose twins swapped is refused', async () => {
        const src = `<ul x-edit="f4">\n  <li class="a">Item</li>\n  <li class="b">Item</li>\n  <li>Last</li>\n</ul>`
        page(src); const map = await ids()
        const swapped = src.replace('<li class="a">Item</li>\n  <li class="b">Item</li>', '<li class="b">Item</li>\n  <li class="a">Item</li>')
        page(swapped)
        const base = ['LI:Item', 'LI:Item#2', 'LI:Last'].map((k, i) => n('f4', k, { at: String(i) }))
        const { results } = await send([tree('f4', [n('f4', 'LI:Last', { at: '2' }), n('f4', 'LI:Item', { at: '0' }), n('f4', 'LI:Item#2', { at: '1' })], { tree: { key: '', base: base.map(b => withFp(b, map)), children: [n('f4', 'LI:Last', { at: '2' }), n('f4', 'LI:Item', { at: '0' }), n('f4', 'LI:Item#2', { at: '1' })] } })], map)
        expect(results[0].status).toBe('error')
        expect(results[0].reason).toContain(`identical elements`)
        expect(file()).toBe(swapped)
    })

    it('unique elements still merge over external changes elsewhere; ids come back for the next publish', async () => {
        const src = `<section x-edit="f5">\n  <p>Alpha</p>\n  <p>Beta</p>\n  <p>Gamma</p>\n</section>`
        page(src); const map = await ids()
        page(src.replace('<p>Alpha</p>\n  <p>Beta</p>', '<p>Beta</p>\n  <p>Alpha</p>'))
        const first = await send([tree('f5', [n('f5', 'P:Gamma', { at: '2', edits: { text: 'Gamma page' } })])], map)
        expect(first.results[0].status).toBe('written')
        expect(first.ids['index.html'][K('f5', 'P:Gamma page')]).toBeTruthy()
        // A second publish without a reload uses the ids the first returned.
        const second = await send([tree('f5', [n('f5', 'P:Gamma page', { at: '2', edits: { text: 'Gamma again' } })])], first.ids['index.html'])
        expect(second.results[0].status).toBe('written')
        expect(file()).toContain('<p>Beta</p>\n  <p>Alpha</p>\n  <p>Gamma again</p>')
        // A stale fingerprint for the same key is refused.
        const third = await send([tree('f5', [n('f5', 'P:Beta', { at: '0', edits: { text: 'B' } })])], { [K('f5', 'P:Beta')]: 'ffffffffffff' })
        expect(third.results[0].status).toBe('error')
    })

    it('a node without its fingerprint is refused, even after a twin swap; so is HTML without a base', async () => {
        const src = `<section x-edit="f6">\n  <div class="card red"><p>Same</p></div>\n  <div class="card blue"><p>Same</p></div>\n</section>`
        page(src)
        const { files } = await fetch(`http://localhost:${port}/__edit/base`).then(r => r.json())
        const swapped = src.replace(/(<div class="card red">.*<\/div>)\n  (<div class="card blue">.*<\/div>)/, '$2\n  $1')
        page(swapped)
        const raw = (body) => fetch(`http://localhost:${port}/__edit/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` }, body: JSON.stringify(body) }).then(r => r.json())
        const patches = [tree('f6', [n('f6', 'DIV:Same#2', { at: '1', path: true, children: [n('f6', 'P:Same#2', { at: '1.0', edits: { text: 'Blue page' } })] })], { tree: { key: '', path: true, children: [n('f6', 'DIV:Same#2', { at: '1', path: true, children: [n('f6', 'P:Same#2', { at: '1.0', edits: { text: 'Blue page' } })] })] } })]
        const fresh = (await fetch(`http://localhost:${port}/__edit/base`).then(r => r.json())).files
        const noFp = await raw({ patches, base: fresh })
        expect(noFp.results[0].status).toBe('error')
        expect(noFp.results[0].reason).toContain('without the fingerprint it loaded with')
        const noBase = await raw(patches)
        expect(noBase.results[0].status).toBe('error')
        expect(noBase.results[0].reason).toContain('carries no base')
        expect(file()).toBe(swapped)
        expect(files['index.html']).not.toBe(fresh['index.html'])
    })
})

describe('startup sweep', () => {
    it('removes orphaned source-writer temps when the server starts with --edit', async () => {
        const d = mkdtempSync(path.join(tmpdir(), 'mnfst-edit-sweep-'))
        writeFileSync(path.join(d, 'index.html'), '<p>x</p>')
        mkdirSync(path.join(d, 'components'))
        writeFileSync(path.join(d, 'components/card.html.mnfst-edit-123-456.tmp'), 'stale')
        writeFileSync(path.join(d, 'index.html.mnfst-edit-9-9.tmp'), 'stale')
        writeFileSync(path.join(d, 'notes.tmp'), 'keep')
        const ask = 47000 + Math.floor(Math.random() * 1500)
        const p = spawn(process.execPath, [SERVE, d, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(ask)], { stdio: ['ignore', 'pipe', 'pipe'] })
        try {
            await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error(out)), 10000); const scan = c => { out += c; if (/running at/.test(out)) { clearTimeout(t); resolve() } }; p.stdout.on('data', scan); p.stderr.on('data', scan) })
            expect(readdirSync(path.join(d, 'components'))).toEqual([])
            expect(readdirSync(d).sort()).toEqual(['components', 'index.html', 'notes.tmp'])
        } finally { p.kill(); rmSync(d, { recursive: true, force: true }) }
    })

    it('theme writes go only to a stylesheet the page uses: never hooks, config, HTML or outside the project', async () => {
        const css = `:root {\n    --x: 1;\n}\n`
        mkdirSync(path.join(dir, '.husky'), { recursive: true }); mkdirSync(path.join(dir, 'styles/core'), { recursive: true }); mkdirSync(path.join(dir, 'css'), { recursive: true })
        const outsideDir = mkdtempSync(path.join(tmpdir(), 'mnfst-outside-'))
        writeFileSync(path.join(outsideDir, 'x.css'), css)
        rmSync(path.join(dir, 'shared'), { force: true, recursive: true })
        symlinkSync(outsideDir, path.join(dir, 'shared'))
        const hook = path.join(dir, '.husky/pre-commit'), hookSrc = '#!/bin/sh\necho ok\n'
        writeFileSync(hook, hookSrc); chmodSync(hook, 0o755)
        writeFileSync(path.join(dir, 'css/site.css'), css); writeFileSync(path.join(dir, 'css/unlinked.css'), css); writeFileSync(path.join(dir, 'styles/core/manifest.theme.css'), css)
        writeFileSync(path.join(dir, 'index.html'), `<link rel="stylesheet" href="/css/site.css?v=2"><link rel="stylesheet" href="shared/x.css"><section x-edit="a" data-edit-theme-file="styles/core/manifest.theme.css"><p>One</p></section>`)
        const manifestBefore = readFileSync(path.join(dir, 'manifest.json'), 'utf8')
        try {
            for (const file of ['.husky/pre-commit', 'manifest.json', 'index.html', 'css/unlinked.css', 'shared/x.css', '../outside.css']) {
                const { results } = await save([{ kind: 'theme', scope: null, var: '--x', value: 'red', file }])
                expect(results[0].status, file).toBe('error')
            }
            expect(readFileSync(hook, 'utf8')).toBe(hookSrc)
            expect(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).toBe(manifestBefore)
            expect(readFileSync(path.join(outsideDir, 'x.css'), 'utf8')).toBe(css)
            for (const [file, value] of [['css/site.css', 'red'], ['styles/core/manifest.theme.css', 'blue'], [undefined, 'green']]) {
                const { results } = await save([{ kind: 'theme', scope: null, var: '--x', value, file }])
                expect(results[0].status, String(file)).toBe('written')
            }
            for (const value of ['$(touch PWNED)', '`id`']) {
                const { results } = await save([{ kind: 'theme', scope: null, var: '--x', value, file: 'css/site.css' }])
                expect(results[0].status, value).toBe('error')
            }
        } finally { rmSync(path.join(dir, 'shared'), { force: true }); rmSync(outsideDir, { recursive: true, force: true }) }
    })

    it('data, component and static writes refuse hidden paths, other file types and out-of-project links', async () => {
        mkdirSync(path.join(dir, '.secrets'), { recursive: true })
        writeFileSync(path.join(dir, '.secrets/rows.json'), '[{"id":"1","t":"a"}]\n')
        writeFileSync(path.join(dir, 'rows.js'), '[{"id":"1","t":"a"}]\n')
        writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ data: { hidden: '.secrets/rows.json', script: 'rows.js' } }))
        try {
            for (const source of ['hidden', 'script']) {
                const { results } = await save([{ kind: 'data-val', source, id: '1', field: 't', value: 'b' }])
                expect(results[0].status, source).toBe('error')
                expect(results[0].reason).toContain('refused')
            }
            expect(readFileSync(path.join(dir, '.secrets/rows.json'), 'utf8')).toBe('[{"id":"1","t":"a"}]\n')
            // index.html linked outside the project
            const outsideDir = mkdtempSync(path.join(tmpdir(), 'mnfst-outside-'))
            writeFileSync(path.join(outsideDir, 'page.html'), `<section x-edit="a"><p>One</p></section>`)
            rmSync(path.join(dir, 'index.html'), { force: true })
            symlinkSync(path.join(outsideDir, 'page.html'), path.join(dir, 'index.html'))
            try {
                const { results } = await save([tree('a', [n('a', 'P:One', { edits: { text: 'Uno' } })])])
                expect(results[0].status).toBe('error')
                expect(results[0].reason).toContain('outside the project')
                expect(readFileSync(path.join(outsideDir, 'page.html'), 'utf8')).toBe(`<section x-edit="a"><p>One</p></section>`)
            } finally { rmSync(path.join(dir, 'index.html'), { force: true }); writeFileSync(path.join(dir, 'index.html'), ''); rmSync(outsideDir, { recursive: true, force: true }) }
        } finally { writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'tree-test' })); rmSync(path.join(dir, '.secrets'), { recursive: true, force: true }); rmSync(path.join(dir, 'rows.js'), { force: true }) }
    })

    it('/__edit/base lists only writable source types, never dot entries or out-of-project links', async () => {
        mkdirSync(path.join(dir, '.secrets'), { recursive: true }); writeFileSync(path.join(dir, '.secrets/k.json'), '{}'); writeFileSync(path.join(dir, '.env.json'), '{}')
        writeFileSync(path.join(dir, 'app.js'), 'x'); writeFileSync(path.join(dir, 'index.html'), '<p>x</p>')
        const outsideDir = mkdtempSync(path.join(tmpdir(), 'mnfst-outside-'))
        writeFileSync(path.join(outsideDir, 'o.css'), 'a{}')
        rmSync(path.join(dir, 'linked'), { force: true, recursive: true })
        symlinkSync(outsideDir, path.join(dir, 'linked'))
        try {
            const { files } = await fetch(`http://localhost:${port}/__edit/base`).then(r => r.json())
            const names = Object.keys(files)
            expect(names).toContain('index.html')
            expect(names.some(f => f.startsWith('.') || f.includes('/.'))).toBe(false)
            expect(names).not.toContain('app.js')
            expect(names.some(f => f.startsWith('linked/'))).toBe(false)
        } finally { rmSync(path.join(dir, 'linked'), { force: true }); rmSync(outsideDir, { recursive: true, force: true }); rmSync(path.join(dir, '.secrets'), { recursive: true, force: true }); rmSync(path.join(dir, '.env.json'), { force: true }); rmSync(path.join(dir, 'app.js'), { force: true }) }
    })

    it('an external CSS save never blocks a theme publish; a changed HTML file is reported as stale', async () => {
        const themeFile = path.join(dir, 'styles/core/manifest.theme.css')
        mkdirSync(path.dirname(themeFile), { recursive: true })
        writeFileSync(themeFile, `:root {\n    --brand: blue;\n}\n`)
        writeFileSync(path.join(dir, 'index.html'), `<section x-edit="h"><p>One</p></section>`)
        const { files } = await fetch(`http://localhost:${port}/__edit/base`).then(r => r.json())
        writeFileSync(themeFile, `:root {\n    --brand: blue;\n    --other: 1;\n}\n`)       // saved elsewhere
        const post = (body) => fetch(`http://localhost:${port}/__edit/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${port}` }, body: JSON.stringify(body) }).then(r => r.json())
        const ok = await post({ patches: [{ kind: 'theme', scope: null, var: '--brand', value: 'red' }], base: files })
        expect(ok.results[0].status).toBe('written')
        expect(readFileSync(themeFile, 'utf8')).toBe(`:root {\n    --brand: red;\n    --other: 1;\n}\n`)
        writeFileSync(path.join(dir, 'index.html'), `<section x-edit="h"><p>One</p> </section>`)
        const stale = await post({ patches: [tree('h', [n('h', 'P:One', { edits: { text: 'Uno' } })])], base: files })
        expect(stale.stale).toEqual(['index.html'])
        expect(stale.results[0].reason).toContain('rebase')
    })

    it('SSE reload messages name every file with its hash, matching what the save returned', async () => {
        const events = []
        const sse = http.get(`http://localhost:${port}/__mnfst_sse__?tabId=r-${Date.now()}`, res => res.on('data', c => events.push(String(c))))
        await new Promise(r => setTimeout(r, 300))
        writeFileSync(path.join(dir, 'index.html'), `<section x-edit="r"><p>One</p></section>`)
        await new Promise(r => setTimeout(r, 700)); events.length = 0
        const res = await save([tree('r', [n('r', 'P:One', { edits: { text: 'Uno' } })])])
        expect(res.results[0].status).toBe('written')
        await new Promise(r => setTimeout(r, 600))
        sse.destroy()
        const msg = events.join('').split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))).find(m => m.type === 'reload')
        expect(msg.files).toEqual([{ rel: 'index.html', hash: res.base['index.html'] }])
    })

    it('SSE css messages carry the file and its new hash', async () => {
        const events = []
        const sse = http.get(`http://localhost:${port}/__mnfst_sse__?tabId=h-${Date.now()}`, res => res.on('data', c => events.push(String(c))))
        await new Promise(r => setTimeout(r, 300))
        const themeFile = path.join(dir, 'styles/core/manifest.theme.css')
        writeFileSync(themeFile, `:root {\n    --brand: teal;\n}\n`)
        await new Promise(r => setTimeout(r, 800))
        sse.destroy()
        const msg = events.join('').split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))).find(m => m.type === 'css')
        expect(msg).toMatchObject({ rel: 'styles/core/manifest.theme.css' })
        expect(msg.hash).toMatch(/^[0-9a-f]{40}$/)
    })

    it('a container listed only as a path keeps the source\'s current order; a restructured one must match its base', async () => {
        const src = `<section x-edit="r"><p>Beta</p><p>Alpha</p><p>Gamma</p></section>`   // reordered since the page loaded
        const path = await write(src, [{ kind: 'static-tree', region: 'r', tree: { key: '', path: true, children: [n('r', 'P:Gamma', { edits: { text: 'Gamma edited' } })] } }])
        expect(path.results[0].status).toBe('written')
        expect(path.out).toBe(`<section x-edit="r"><p>Beta</p><p>Alpha</p><p>Gamma edited</p></section>`)
        const base = ['P:Alpha', 'P:Beta', 'P:Gamma'].map((k, i) => ({ key: K('r', k), at: String(i) }))
        const moved = await write(src, [{ kind: 'static-tree', region: 'r', tree: { key: '', base, children: [n('r', 'P:Beta'), n('r', 'P:Gamma'), n('r', 'P:Alpha')] } }])
        expect(moved.results[0].status).toBe('error')
        expect(moved.results[0].reason).toContain('changed since this page loaded')
        expect(moved.out).toBe(src)
    })

    it('an external reorder of a different container merges with the page\'s restructure', async () => {
        const loaded = await loadedIds(`<section x-edit="m"><ul class="a"><li>A1</li><li>A2</li></ul><ul class="b"><li>B1</li><li>B2</li></ul></section>`)
        const src = `<section x-edit="m"><ul class="a"><li>A1</li><li>A2</li></ul><ul class="b"><li>B2</li><li>B1</li></ul></section>`   // list b reordered externally
        const base = [{ key: K('m', 'LI:A1'), at: '0.0' }, { key: K('m', 'LI:A2'), at: '0.1' }]
        const { results, out } = await write(src, [{ kind: 'static-tree', region: 'm', tree: { key: '', path: true, children: [
            n('m', 'UL:A1A2', { base, children: [n('m', 'LI:A2'), n('m', 'LI:A1')] }),
            n('m', 'UL:B1B2', { at: '1', path: true, fp: loaded[K('m', 'UL:B1B2')], children: [n('m', 'LI:B1', { edits: { text: 'B1 edited' } })] })
        ] } }])
        expect(results[0].status, JSON.stringify(results)).toBe('written')
        expect(out).toBe(`<section x-edit="m"><ul class="a"><li>A2</li><li>A1</li></ul><ul class="b"><li>B2</li><li>B1 edited</li></ul></section>`)
        // found by path only when its listed children really sit in it
        const wrong = await write(src, [{ kind: 'static-tree', region: 'm', tree: { key: '', path: true, children: [n('m', 'UL:B1B2', { at: '1', path: true, fp: loaded[K('m', 'UL:B1B2')], children: [n('m', 'LI:A1', { edits: { text: 'x' } })] })] } }])
        expect(wrong.results[0].status).toBe('error')
    })

    it('component names must be declared: no traversal, no hidden or node_modules paths (any case)', async () => {
        mkdirSync(path.join(dir, 'components/cards'), { recursive: true }); mkdirSync(path.join(dir, 'NODE_MODULES/pkg'), { recursive: true })
        const page = `<div class="card"><h3>T</h3></div>\n`
        writeFileSync(path.join(dir, 'NODE_MODULES/pkg/page.html'), page)
        writeFileSync(path.join(dir, 'components/cards/promo.html'), page)
        writeFileSync(path.join(dir, 'index.html'), `<section x-edit="a"><p>One</p></section>`)
        const edit = (component) => save([{ kind: 'component', scope: 'main', component, edits: [{ path: '0', prop: 'text', value: 'X' }] }])
        try {
            for (const bad of ['../NODE_MODULES/pkg/page', '../index', '/index', 'cards/../../index', '.hidden', 'cards/.x']) {
                const { results } = await edit(bad)
                expect(results[0].status, bad).toBe('error')
            }
            expect(readFileSync(path.join(dir, 'NODE_MODULES/pkg/page.html'), 'utf8')).toBe(page)
            expect(readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(`<section x-edit="a"><p>One</p></section>`)
            const ok = await edit('cards/promo')
            expect(ok.results[0].status).toBe('written')
        } finally { rmSync(path.join(dir, 'NODE_MODULES'), { recursive: true, force: true }); rmSync(path.join(dir, 'components/cards'), { recursive: true, force: true }) }
    })

    it('confinement compares segments case-insensitively and refuses Windows aliases', async () => {
        mkdirSync(path.join(dir, 'Node_Modules/x'), { recursive: true }); mkdirSync(path.join(dir, 'styles./t'), { recursive: true })
        const css = `:root {\n    --x: 1;\n}\n`
        writeFileSync(path.join(dir, 'Node_Modules/x/theme.css'), css); writeFileSync(path.join(dir, 'styles./t/theme.css'), css)
        writeFileSync(path.join(dir, 'index.html'), `<link rel="stylesheet" href="Node_Modules/x/theme.css"><link rel="stylesheet" href="styles./t/theme.css"><section x-edit="a"><p>One</p></section>`)
        try {
            for (const file of ['Node_Modules/x/theme.css', 'styles./t/theme.css']) {
                const { results } = await save([{ kind: 'theme', scope: null, var: '--x', value: 'red', file }])
                expect(results[0].status, file).toBe('error')
                expect(readFileSync(path.join(dir, file), 'utf8')).toBe(css)
            }
        } finally { rmSync(path.join(dir, 'Node_Modules'), { recursive: true, force: true }); rmSync(path.join(dir, 'styles.'), { recursive: true, force: true }) }
    })
})

