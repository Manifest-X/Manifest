/**
 * Typing and selection in Edit and Rich Text, in real Chromium with real input (mouse
 * clicks and drags, key presses): a caret where you click, word and range selections,
 * typed text, formatting a selection, undo/redo from the keyboard and controls, and a save
 * round trip through mnfst-run --edit (the source file on disk, then a reload).
 * The unit suites run on happy-dom, which has no caret, selection or layout.
 *
 * Run: node tests/e2e/edit-typing.e2e.mjs
 */
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const BODY = `<main>
    <section id="e" x-edit="e">
        <h1>Hello world</h1>
        <p id="p1">First paragraph</p>
        <p id="p2">Some <strong>bold</strong> text</p>
        <p id="p3">Drag inside me</p>
    </section>
    <div id="rich" x-data="{ md: 'Hello there' }">
        <button id="bold" x-rich-text.strong>B</button>
        <button id="undo" x-rich-text.undo>Undo</button>
        <button id="redo" x-rich-text.redo>Redo</button>
        <div id="rt" x-rich-text="md"></div>
        <output id="val" x-text="md"></output>
    </div>
</main>`
const PAGE = `<!doctype html>
<html>
<head>
    <link rel="stylesheet" href="/edit.css">
    <link rel="stylesheet" href="/rich.css">
    <script src="/rich.js"></script>
    <script src="/edit.js"></script>
    <script src="/alpine.js" defer></script>
</head>
<body>
${BODY}
</body>
</html>
`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnfst-edit-typing-'))
const copy = (from, to) => fs.copyFileSync(path.join(ROOT, from), path.join(dir, to))
fs.writeFileSync(path.join(dir, 'index.html'), PAGE)
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'edit-typing' }))
copy('node_modules/alpinejs/dist/cdn.min.js', 'alpine.js')
copy('src/scripts/manifest.rich.text.js', 'rich.js')
copy('src/scripts/manifest.edit.js', 'edit.js')
copy('src/styles/elements/manifest.edit.css', 'edit.css')
copy('src/styles/elements/manifest.rich.text.css', 'rich.css')
const source = () => fs.readFileSync(path.join(dir, 'index.html'), 'utf8')

const port = 46000 + Math.floor(Math.random() * 3000)
const server = spawn(process.execPath, [path.join(ROOT, 'packages/run/serve.mjs'), dir, '--edit', '--no-open', '--no-idle-shutdown', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
const origin = await new Promise((resolve, reject) => {
    let out = ''
    const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000)
    const scan = (c) => { out += c; const m = out.match(/running at (http:\/\/localhost:\d+)/); if (m) { clearTimeout(t); resolve(m[1]) } }
    server.stdout.on('data', scan); server.stderr.on('data', scan)
})

const browser = await puppeteer.launch({ headless: 'shell' })
const cleanup = async () => { await browser.close().catch(() => { }); server.kill(); fs.rmSync(dir, { recursive: true, force: true }) }

try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('dialog', (d) => d.dismiss())
    const open = async () => {
        await page.goto(origin + '/', { waitUntil: 'load' })
        await page.waitForFunction(() => window.Alpine && Alpine.store('edit') && document.querySelector('#p1[contenteditable]') && document.querySelector('#rt[contenteditable]'), { timeout: 10000 })
        await new Promise(r => setTimeout(r, 600))
    }
    await open()

    const text = (sel) => page.$eval(sel, el => el.textContent)
    const selection = () => page.evaluate(() => String(window.getSelection()))
    const focused = () => page.evaluate(() => document.activeElement && document.activeElement.id)
    const boxOf = (sel, word) => page.evaluate((sel, word) => {
        const el = document.querySelector(sel)
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n; (n = walker.nextNode());) {
            const i = n.data.indexOf(word)
            if (i < 0) continue
            const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length)
            const b = r.getBoundingClientRect()
            return { x: b.left, y: b.top + b.height / 2, w: b.width }
        }
        return null
    }, sel, word)
    // The first click focuses a leaf (selecting it all); the next places the caret
    const caretAt = async (sel, word, at = 'end') => {
        let p = await boxOf(sel, word)
        await page.mouse.click(p.x + 1, p.y); await new Promise(r => setTimeout(r, 150))
        p = await boxOf(sel, word)
        await page.mouse.click(at === 'end' ? p.x + p.w - 1 : p.x + 1, p.y); await new Promise(r => setTimeout(r, 150))
    }
    const blur = async () => { await page.mouse.click(5, 5); await new Promise(r => setTimeout(r, 100)) }

    // ---- Edit: caret, typing, selection ----
    let b = await boxOf('#p1', 'paragraph')
    await page.mouse.click(b.x + b.w + 1, b.y)
    await new Promise(r => setTimeout(r, 150))
    check('Edit: a click focuses the leaf', await focused() === 'p1')
    check('Edit: focusing a leaf selects its content', await selection() === 'First paragraph', await selection())
    await page.keyboard.press('End')
    await page.keyboard.type(' more')
    check('Edit: typing at the end of a leaf', await text('#p1') === 'First paragraph more', await text('#p1'))

    b = await boxOf('#p1', 'First')
    await page.mouse.click(b.x + b.w / 2, b.y, { clickCount: 2 })
    await new Promise(r => setTimeout(r, 100))
    check('Edit: a double-click selects the word', (await selection()).trim() === 'First', await selection())
    await page.keyboard.type('Primary')
    check('Edit: typing replaces the selected word', await text('#p1') === 'Primary paragraph more', await text('#p1'))

    await page.keyboard.press('Home')
    await page.keyboard.down('Shift'); await page.keyboard.press('End'); await page.keyboard.up('Shift')
    check('Edit: Shift+End selects to the end of the line', await selection() === 'Primary paragraph more', await selection())
    await page.keyboard.press('ArrowRight')
    await page.keyboard.down('Shift'); for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift')
    check('Edit: Shift+ArrowLeft extends the selection by characters', await selection() === 'more', await selection())
    await blur()
    check('Edit: leaving the leaf logs one text edit', await page.evaluate(() => Alpine.store('edit').export().log.filter(d => d.kind === 'st-node' && d.prop === 'text').length) === 1)

    // A drag that starts inside the text being typed selects text; the piece does not move
    await caretAt('#p3', 'me')
    check('Edit: a second click in the focused leaf places a caret', await selection() === '', await selection())
    b = await boxOf('#p3', 'Drag')
    const order = () => page.$$eval('#e > *', els => els.map(e => e.id || e.tagName))
    const before = await order()
    const e3 = await boxOf('#p3', 'inside')
    await page.mouse.move(b.x + 1, b.y); await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + 1 + (e3.x + e3.w - b.x) * i / 8, b.y)
    await page.mouse.up()
    await new Promise(r => setTimeout(r, 150))
    check('Edit: dragging inside the focused leaf selects text', (await selection()).includes('Drag inside'), { sel: await selection(), focused: await focused(), b, e3, html: await page.$eval('#p3', el => el.outerHTML) })
    check('Edit: ... and does not move the piece', JSON.stringify(await order()) === JSON.stringify(before), await order())
    await blur()

    // Formatting inside an Edit leaf: type into the bold run, then bold another word with the hotkey
    await caretAt('#p2', 'bold')
    await page.keyboard.type('er')
    check('Edit: typing inside a bold run stays in it', await page.$eval('#p2', el => (el.querySelector('strong, b') || {}).textContent) === 'bolder', await page.$eval('#p2', el => el.outerHTML))
    b = await boxOf('#p2', 'text')
    await page.mouse.click(b.x + b.w / 2, b.y, { clickCount: 2 })
    await page.keyboard.down(MOD); await page.keyboard.press('b'); await page.keyboard.up(MOD)
    await new Promise(r => setTimeout(r, 100))
    const p2 = await page.$eval('#p2', el => el.innerHTML)
    check('Edit: the bold hotkey formats the selected word', /<(strong|b)>text<\/(strong|b)>/.test(p2), p2)
    await blur()

    // Undo / redo from the keyboard (outside text)
    await page.keyboard.down(MOD); await page.keyboard.press('z'); await page.keyboard.up(MOD)
    await new Promise(r => setTimeout(r, 150))
    check('Edit: undo restores the leaf', !/<(strong|b)>text/.test(await page.$eval('#p2', el => el.innerHTML)) && (await text('#p2')) === 'Some bold text', await page.$eval('#p2', el => el.innerHTML))
    await page.keyboard.down(MOD); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up(MOD)
    await new Promise(r => setTimeout(r, 150))
    check('Edit: redo puts the edit back', /<(strong|b)>text<\/(strong|b)>/.test(await page.$eval('#p2', el => el.innerHTML)) && (await text('#p2')) === 'Some bolder text', await page.$eval('#p2', el => el.innerHTML))

    // ---- Edit: save round trip ----
    const res = await page.evaluate(() => Alpine.store('edit').publish().then(r => r.results.map(x => x.status)))
    check('Edit: publish writes the region', JSON.stringify(res) === '["written"]', res)
    const src = source()
    check('Edit: the source holds the typed text', src.includes('<p id="p1">Primary paragraph more</p>'), src.slice(src.indexOf('<section'), src.indexOf('</section>')))
    check('Edit: the source holds the formatting', /<p id="p2">Some <strong>bolder<\/strong> <(strong|b)>text<\/(strong|b)><\/p>/.test(src), src.slice(src.indexOf('<section'), src.indexOf('</section>')))
    check('Edit: no editor attributes reach the source', !/contenteditable|data-edit-|data-rich-text/.test(src))
    await open()
    check('Edit: a reload shows the saved text', await text('#p1') === 'Primary paragraph more' && await text('#p2') === 'Some bolder text')
    check('Edit: the reloaded page starts with an empty history', await page.evaluate(() => !Alpine.store('edit').canUndo))

    // ---- Rich Text: caret, typing, selection, formatting, undo ----
    const val = () => text('#val')
    b = await boxOf('#rt', 'there')
    await page.mouse.click(b.x + b.w + 1, b.y)
    await new Promise(r => setTimeout(r, 100))
    check('Rich Text: a click puts the caret in the area', await focused() === 'rt')
    await page.keyboard.press('End')
    await page.keyboard.type(' friend')
    await new Promise(r => setTimeout(r, 100))
    check('Rich Text: typing updates the bound value', await val() === 'Hello there friend', await val())

    b = await boxOf('#rt', 'friend')
    await page.mouse.click(b.x + b.w / 2, b.y, { clickCount: 2 })
    await new Promise(r => setTimeout(r, 100))
    check('Rich Text: a double-click selects the word', (await selection()).trim() === 'friend', await selection())
    await page.click('#bold')
    await new Promise(r => setTimeout(r, 100))
    check('Rich Text: the bold control formats the selection (markdown)', await val() === 'Hello there **friend**', await val())
    check('Rich Text: the selection survives the control press', (await selection()).trim() === 'friend', await selection())
    check('Rich Text: the control reports active', await page.$eval('#bold', el => el.getAttribute('aria-pressed')) === 'true')

    await page.keyboard.press('ArrowRight')
    await page.keyboard.down('Shift'); for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift')
    check('Rich Text: Shift+ArrowLeft selects characters', await selection() === 'end', await selection())
    await page.keyboard.type('END')
    await new Promise(r => setTimeout(r, 100))
    check('Rich Text: typing over a selection inside a mark keeps the mark', await val() === 'Hello there **friEND**', await val())

    await new Promise(r => setTimeout(r, 700))   // history records after a pause in typing
    await page.click('#undo')
    await new Promise(r => setTimeout(r, 150))
    check('Rich Text: the undo control steps back', await val() === 'Hello there **friend**', await val())
    await page.click('#redo')
    await new Promise(r => setTimeout(r, 150))
    check('Rich Text: the redo control steps forward', await val() === 'Hello there **friEND**', await val())
    await page.focus('#rt')
    await page.keyboard.down(MOD); await page.keyboard.press('z'); await page.keyboard.up(MOD)
    await new Promise(r => setTimeout(r, 150))
    check('Rich Text: the undo hotkey steps back', await val() === 'Hello there **friend**', await val())

    // Value round trip: the markdown loads back into a fresh area as the same document
    const back = await page.evaluate(async () => {
        const md = document.querySelector('#val').textContent
        const host = document.createElement('div')
        host.innerHTML = `<div x-data="{ v: ${JSON.stringify(md).replace(/"/g, '&quot;')} }"><div id="rt2" x-rich-text="v"></div><output id="v2" x-text="v"></output></div>`
        document.body.appendChild(host)
        Alpine.initTree(host)
        await new Promise(r => setTimeout(r, 100))
        return { md, html: document.querySelector('#rt2').innerHTML, v: document.querySelector('#v2').textContent }
    })
    check('Rich Text: the value loads back as the same markup', /Hello there <strong>friend<\/strong>/.test(back.html) && back.v === back.md, back)

    check('no page errors', errors.length === 0, errors)
} catch (e) {
    check('run', false, String(e && e.stack || e))
} finally {
    await cleanup()
}

if (failures.length) {
    console.log(`\n${failures.length} failed`)
    process.exit(1)
}
console.log('\nall passed')
