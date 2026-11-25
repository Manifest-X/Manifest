/**
 * Tailwind engine output cache, harder cases in real Chromium: cascade position, block order and
 * per-block-set entries, short-lived tokens on an interactive page, the engine carrier, bad entries, opt-out.
 *
 * Run: npm run build && node tests/e2e/tailwind-cache-cases.e2e.mjs
 */
import puppeteer from 'puppeteer'
import { serve, sitePage } from './fixtures/tailwind-cache-site.mjs'

const HOST = 'app.example'
const KEY = 'tailwind-engine-cache:v2'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// Cascade: author CSS before and after the loader, a linked sheet, a style added by an inline body script and one added late
const CASCADE_AFTER = `<style>@layer base { h1 { color: rgb(1, 2, 3) } }</style><style>@layer utilities { .author-u { padding-top: 11px } }</style><link rel="stylesheet" href="/author.css">`
const CASCADE_BODY = `<h1 id="h">x</h1>
<div id="c1" class="pt-2 author-u">c</div><div id="c2" class="mt-2 author-l">c</div><div id="c3" class="pl-3 author-s">c</div><div id="c4" class="pr-1 author-late">c</div><div id="c5" class="text-sm author-b">c</div>
<script>document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '@layer utilities { .author-s { padding-left: 9px } }' }))</script>
<script>addEventListener('load', () => setTimeout(() => document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '@layer utilities { .author-late { padding-right: 7px } }' })), 300))</script>`
// Author declares the layer order itself, ahead of Tailwind
const LAYERS_BEFORE = `<style>@layer utilities, components, base, theme, properties; @layer base { h2 { font-size: 10px; margin-top: 3px } }</style>`
const LAYERS_BODY = `<h2 id="l1" class="text-xl mt-6">l</h2><p id="l2" class="leading-loose">p</p>`

const BLK = (c) => `<style type="text/tailwindcss">@theme { --color-brand: ${c}; }</style>`
const BLK_A = `<style type="text/tailwindcss">@theme { --color-brand: #ff0000; } @layer base { p { letter-spacing: 3px } }</style>`
const BRAND = `<p id="t" class="bg-brand text-brand p-2">x</p>`

const APP_BODY = `
<nav class="flex items-center justify-between p-4 bg-white dark:bg-slate-900">
 <div x-data="{open:false}" class="relative">
  <button id="dd" @click="open=!open" :class="open ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-900'" class="px-3 py-2 rounded-md">Menu</button>
  <div x-show="open" x-transition:enter="transition ease-out duration-150" x-transition:enter-start="opacity-0 scale-90" x-transition:enter-end="opacity-100 scale-100"
       x-transition:leave="transition ease-in duration-100" x-transition:leave-start="opacity-100" x-transition:leave-end="opacity-0" class="absolute mt-2 w-48 shadow-lg rounded-md bg-white">
    <a class="block px-4 py-2 hover:bg-gray-50">One</a>
  </div>
 </div>
 <button id="dk" @click="document.documentElement.classList.toggle('dark')" class="p-2">dark</button>
</nav>
<main x-data="{tab:'a', html:''}">
 <button id="tb" @click="tab = tab==='a' ? 'b' : 'a'; html = '<p class=&quot;text-emerald-700 font-semibold mt-3&quot;>loaded</p>'" class="px-2">tab</button>
 <template x-if="tab==='b'"><section class="grid grid-cols-3 gap-6 p-8 bg-amber-50 ring-2 ring-amber-300"><div class="col-span-2 text-lg">B</div></section></template>
 <div x-html="html"></div>
</main>`

const SEED_AFTER = `<style>body:has(.modal-open), html:has(body .modal-open) { background: rgb(9, 9, 9) } main > :last-child, body > :last-child { outline: 5px solid red }</style>`
const SEED_BODY = `<main><div id="m" x-data="{o:false}"><button id="ob" @click="o=!o" :class="o && 'modal-open'">m</button></div></main><footer id="f" class="pt-1">f</footer>`

const pages = {
    '/casc': () => sitePage({ before: '<style>@layer base { h1 { font-size: 40px } } .author-b { font-size: 21px }</style>', after: CASCADE_AFTER, body: CASCADE_BODY }),
    '/author.css': '@layer utilities { .author-l { margin-top: 13px } }',
    '/layers': () => sitePage({ manifestCss: false, before: LAYERS_BEFORE, body: LAYERS_BODY }),
    '/r1': () => sitePage({ after: BLK('#ff0000') + BLK('#00ff00'), body: BRAND }),
    '/r2': () => sitePage({ after: BLK('#00ff00') + BLK('#ff0000'), body: BRAND }),
    '/a': () => sitePage({ after: BLK_A, body: BRAND }),
    '/b': () => sitePage({ after: BLK('#0000ff'), body: BRAND }),
    '/c': () => sitePage({ body: BRAND }),
    '/a2': () => sitePage({ before: BLK_A, body: BRAND }),
    '/b2': () => sitePage({ before: BLK('#0000ff'), body: BRAND }),
    '/app': () => sitePage({ body: APP_BODY }),
    '/seed': () => sitePage({ after: SEED_AFTER, body: SEED_BODY }),
    '/plain': () => sitePage({ body: '<div id="t" class="p-3 text-red-500">t</div>' }),
    '/nocache': () => sitePage({ body: '<div id="t" class="p-3">t</div>', loaderAttrs: '="no-cache"' }),
}

const engineLoads = (p) => p.evaluate(() => document.querySelectorAll('script[src*="tailwind"]').length)
const cached = (p) => p.evaluate(() => document.querySelectorAll('style[data-tailwind-cache]').length)
const entries = (p) => p.evaluate((k) => { try { const i = JSON.parse(localStorage.getItem(k)); return i ? i.ids.map((id) => JSON.parse(localStorage.getItem(k + ':' + id))) : [] } catch (e) { return [] } }, KEY)

// CSS-bearing <head> nodes in order; Tailwind's sheet (engine or cached) is one slot
const cssHead = (p) => p.evaluate(() => [...document.head.children]
    .filter((e) => (e.localName === 'style' && e.getAttribute('type') !== 'text/tailwindcss' && (e.textContent || '').trim()) || (e.localName === 'link' && e.rel === 'stylesheet'))
    .map((e) => (e.textContent || '').startsWith('/*! tailwindcss') ? 'TW' : e.id ? '#' + e.id : e.localName === 'link' ? 'link:' + e.getAttribute('href').split('/').pop() : 'style:' + e.textContent.trim().slice(0, 32))
    .filter((x) => x !== '#manifest-styles-critical').join(' , '))

// Every distinct value of probe(), recorded each frame from the first
const FRAMES = `(() => { window.__frames = []; const run = () => { try { const v = window.__probe ? window.__probe() : ''; const l = window.__frames[window.__frames.length - 1]; if (!l || l.v !== v) window.__frames.push({ v, t: Math.round(performance.now()) }) } catch (e) {} if (performance.now() < 6000) requestAnimationFrame(run) }; requestAnimationFrame(run) })()`

async function main() {
    const srv = await serve({ pages })
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })
    const base = `http://${HOST}:${srv.port}`
    const fresh = async () => { const c = await browser.createBrowserContext(); return { c, p: await c.newPage() } }
    const visit = async (p, path, settle = 2500) => {
        await p.goto(base + path, { waitUntil: 'load' })
        await p.waitForFunction(() => getComputedStyle(document.getElementById('probe-w')).width === '37px', { timeout: 15000 }).catch(() => { })
        await wait(settle)
        return engineLoads(p)
    }

    try {
        // 1. Cascade position
        for (const [path, ids] of [['/casc', ['h', 'c1', 'c2', 'c3', 'c4', 'c5']], ['/layers', ['l1', 'l2']]]) {
            const { c, p } = await fresh()
            const snap = () => p.evaluate((ids) => ids.map((id) => { const s = getComputedStyle(document.getElementById(id)); return `${id}:${s.fontSize}/${s.color}/${s.paddingTop}/${s.paddingLeft}/${s.paddingRight}/${s.marginTop}/${s.lineHeight}` }).join(' '), ids)
            await p.evaluateOnNewDocument(`window.__probe = () => ${JSON.stringify(ids)}.map((id) => { const e = document.getElementById(id); if (!e) return ''; const s = getComputedStyle(e); return s.fontSize + s.color + s.paddingTop + s.paddingLeft + s.marginTop + s.lineHeight }).join('|')`)
            await visit(p, path, 3000)
            const engine = await snap(), engineHead = await cssHead(p)
            const loads = await visit(p, path, 3000)
            const replay = await snap(), replayHead = await cssHead(p)
            check(`cascade ${path}: replayed`, loads === 0 && (await cached(p)) === 1, `loads ${loads}`)
            check(`cascade ${path}: computed styles match the engine run`, replay === engine, `\n      engine ${engine}\n      replay ${replay}`)
            check(`cascade ${path}: CSS order in <head> matches the engine run`, replayHead === engineHead, `\n      engine ${engineHead}\n      replay ${replayHead}`)
            await p.evaluate(FRAMES)
            await p.evaluate(() => document.body.appendChild(Object.assign(document.createElement('div'), { className: 'pt-9' })))
            await wait(2500)
            const frames = await p.evaluate(() => window.__frames)
            check(`cascade ${path}: handoff keeps every value (no flip)`, frames.length === 1 && (await engineLoads(p)) === 1 && (await snap()) === engine, `${frames.length} distinct frames, head ${await cssHead(p)}`)
            await c.close()
        }

        // 2a. Blocks compared in order (Tailwind concatenates in DOM order: last @theme wins)
        {
            const { c, p } = await fresh()
            await p.evaluateOnNewDocument(`window.__probe = () => { const e = document.getElementById('t'); return e ? getComputedStyle(e).backgroundColor : '' }`)
            await p.evaluateOnNewDocument(FRAMES)
            await visit(p, '/r1'); const r1 = await visit(p, '/r1')
            const r1c = await p.$eval('#t', (e) => getComputedStyle(e).backgroundColor)
            const r2Loads = await visit(p, '/r2')
            const r2frames = await p.evaluate(() => window.__frames.map((f) => f.v))
            const r2again = await visit(p, '/r2')
            const r2c = await p.$eval('#t', (e) => getComputedStyle(e).backgroundColor)
            check('block order: /r1 replays its own last @theme', r1 === 0 && r1c === 'rgb(0, 255, 0)', `loads ${r1}, ${r1c}`)
            check('block order: reversed blocks on /r2 never show /r1\'s colour', r2Loads === 1 && !r2frames.includes('rgb(0, 255, 0)'), `loads ${r2Loads}, frames ${JSON.stringify(r2frames)}`)
            check('block order: /r2 then replays its own entry', r2again === 0 && r2c === 'rgb(255, 0, 0)', `loads ${r2again}, ${r2c}`)
            await c.close()
        }

        // 2b. Blocks after the loader tag: another page's theme is never rendered
        {
            const { c, p } = await fresh()
            await p.evaluateOnNewDocument(`window.__probe = () => { const e = document.getElementById('t'); return e ? getComputedStyle(e).backgroundColor + ' ls=' + getComputedStyle(e).letterSpacing : '' }`)
            await p.evaluateOnNewDocument(FRAMES)
            const seen = {}
            const loads = []
            for (const path of ['/a', '/a', '/b', '/c', '/a', '/b', '/c']) {
                loads.push(await visit(p, path))
                seen[path] = [...(seen[path] || []), ...(await p.evaluate(() => window.__frames.map((f) => f.v)))]
            }
            const red = (v) => v.startsWith('rgb(255, 0, 0)') || v.includes('ls=3px')
            check('blocks after loader: /b never shows /a\'s theme or base rules', !seen['/b'].some(red), JSON.stringify([...new Set(seen['/b'])]))
            check('blocks after loader: /c never shows /a\'s theme or base rules', !seen['/c'].some(red), JSON.stringify([...new Set(seen['/c'])]))
            check('blocks after loader: each page replays on its second visit', loads.join(',') === '1,0,1,1,0,0,0', loads.join(','))
            check('blocks after loader: one entry per block set', (await entries(p)).length === 3, `${(await entries(p)).length} entries`)
            await c.close()
        }

        // 2c. Pages with different block sets don't thrash
        {
            const { c, p } = await fresh()
            const loads = []
            for (const path of ['/a2', '/b2', '/a2', '/b2', '/a2', '/b2']) loads.push(await visit(p, path))
            const a2 = await p.$eval('#t', (e) => getComputedStyle(e).backgroundColor)
            check('alternating block sets: engine only on each set\'s first visit', loads.join(',') === '1,1,0,0,0,0', loads.join(','))
            check('alternating block sets: right colour after replay', a2 === 'rgb(0, 0, 255)', a2)
            await c.close()
        }

        // 2c'. LRU bound
        {
            const { c, p } = await fresh()
            const extra = {}
            for (let i = 0; i < 6; i++) { const path = `/lru${i}`; pages[path] = () => sitePage({ before: BLK(`#0000${(10 + i).toString(16)}`), body: BRAND }); extra[path] = 1 }
            for (const path of Object.keys(extra)) await visit(p, path, 1600)
            const n = await entries(p)
            check('entries are bounded (LRU of 4)', n.length === 4, `${n.length} entries`)
            await c.close()
        }

        // 3. Short-lived tokens: an interactive page wakes the engine on its first visit only
        {
            const { c, p } = await fresh()
            const user = async () => {
                await p.click('#dd'); await wait(400); await p.click('#dd'); await wait(300)
                await p.click('#dk'); await wait(200); await p.click('#dk')
                await p.click('#tb'); await wait(500); await p.click('#tb'); await wait(300)
            }
            const rows = []
            for (let v = 1; v <= 4; v++) {
                await visit(p, '/app', 1500)
                const atLoad = await engineLoads(p)
                await user()
                await wait(1500)
                rows.push(`${atLoad}/${await engineLoads(p)}`)
            }
            const rec = (await entries(p))[0]
            const want = ['bg-indigo-600', 'opacity-0', 'scale-90', 'transition', 'ease-out', 'duration-150', 'ease-in', 'duration-100', 'opacity-100', 'scale-100', 'grid-cols-3', 'col-span-2', 'ring-amber-300']
            check('interactive page: visits 2-4 load the engine zero times (at load / after interaction)', rows.slice(1).every((r) => r === '0/0'), rows.join('  '))
            check('interactive page: transition, :class and template tokens recorded', rec && want.every((t) => rec.tokens.includes(t)), rec ? want.filter((t) => !rec.tokens.includes(t)).join(',') || 'all' : 'no entry')
            const opacity = await p.evaluate(async () => { document.getElementById('dd').click(); await new Promise((r) => setTimeout(r, 400)); return getComputedStyle(document.querySelector('[x-show]')).opacity })
            check('interactive page: replayed transition ends styled', opacity === '1', opacity)
            await c.close()
        }

        // 4. Engine carrier never reaches body, never renders
        {
            const srvSlow = await serve({ pages, delayEngineMs: 600 })
            const slowBase = `http://${HOST}:${srvSlow.port}`
            const { c, p } = await fresh()
            await p.goto(slowBase + '/seed', { waitUntil: 'load' }); await wait(1500)
            await p.click('#ob'); await wait(1600); await p.click('#ob'); await wait(1600)
            await p.goto(slowBase + '/seed', { waitUntil: 'load' }); await wait(1000)
            const r = await p.evaluate(async () => {
                const obs = []
                const t0 = performance.now()
                const tick = () => {
                    const s = document.querySelector('[data-tailwind-seed]')
                    obs.push({ seed: !!s, inBody: !!document.body.querySelector('[data-tailwind-seed]'), bg: getComputedStyle(document.body).backgroundColor, outline: getComputedStyle(document.getElementById('f')).outlineStyle, qs: document.querySelector('.modal-open') ? document.querySelector('.modal-open').localName : null })
                    if (performance.now() - t0 < 2500) requestAnimationFrame(tick)
                }
                requestAnimationFrame(tick)
                document.querySelector('main').appendChild(Object.assign(document.createElement('div'), { className: 'pt-11' }))
                await new Promise((res) => setTimeout(res, 2800))
                return { frames: obs.length, seedFrames: obs.filter((o) => o.seed).length, bodyFrames: obs.filter((o) => o.inBody).length, bg: [...new Set(obs.map((o) => o.bg))], outline: [...new Set(obs.map((o) => o.outline))], qs: [...new Set(obs.map((o) => o.qs))], engine: document.querySelectorAll('script[src*="tailwind"]').length }
            })
            check('carrier: engine woke and no frame saw the carrier', r.engine === 1 && r.frames > 30 && r.seedFrames === 0 && r.bodyFrames === 0, JSON.stringify(r))
            check('carrier: body:has(), :last-child and querySelector unaffected in every frame', r.bg.length === 1 && r.outline.length === 1 && r.qs.length === 1 && r.qs[0] === null, JSON.stringify({ bg: r.bg, outline: r.outline, qs: r.qs }))
            await c.close()
            await srvSlow.close()
        }

        // 6. Entries from the future, and broken entries
        {
            const { c, p } = await fresh()
            await visit(p, '/plain')
            const mutate = async (fn) => { await p.evaluate((k, f) => { const i = JSON.parse(localStorage.getItem(k)); const key = k + ':' + i.ids[0]; localStorage.setItem(key, (new Function('return ' + f))()(localStorage.getItem(key))) }, KEY, fn.toString()) }
            const cases = [
                ['timestamp in the future', (s) => { const r = JSON.parse(s); r.t = Date.now() + 1e9; return JSON.stringify(r) }],
                ['truncated JSON', (s) => s.slice(0, s.length / 2)],
                ['tokens not strings', (s) => { const r = JSON.parse(s); r.tokens = [null, {}]; return JSON.stringify(r) }],
                ['blocks not strings', (s) => { const r = JSON.parse(s); r.blocks = [1]; return JSON.stringify(r) }],
            ]
            for (const [name, fn] of cases) {
                await visit(p, '/plain', 1800)
                await mutate(fn)
                const errors = []
                const onErr = (e) => errors.push(e.message)
                p.on('pageerror', onErr)
                const loads = await visit(p, '/plain', 1800)
                p.off('pageerror', onErr)
                const pad = await p.$eval('#t', (e) => getComputedStyle(e).paddingTop)
                check(`bad entry (${name}): engine runs, page styled`, loads === 1 && (await cached(p)) === 0 && pad === '12px' && !errors.length, `loads ${loads}, pad ${pad}, errors ${errors.join(';')}`)
            }
            await visit(p, '/plain', 1800)
            await mutate((s) => { const r = JSON.parse(s); r.css += '</style><script>window.__pwned=1</script><style>'; return JSON.stringify(r) })
            await visit(p, '/plain', 1800)
            check('poisoned entry: CSS text never becomes markup', !(await p.evaluate(() => window.__pwned)) && (await p.$eval('#t', (e) => getComputedStyle(e).paddingTop)) === '12px')
            await c.close()
        }

        // 8. Opt-out
        {
            const { c, p } = await fresh()
            const a = await visit(p, '/nocache', 1800)
            const b = await visit(p, '/nocache', 1800)
            const keys = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tailwind-engine-cache')).length)
            const pad = await p.$eval('#t', (e) => getComputedStyle(e).paddingTop)
            check('data-tailwind="no-cache": engine every visit, nothing stored, Tailwind on', a === 1 && b === 1 && keys === 0 && pad === '12px', `loads ${a}/${b}, keys ${keys}, pad ${pad}`)
            await c.close()
        }
    } finally {
        await browser.close()
        await srv.close()
    }
    console.log(failed ? `\n${failed} failed` : '\nall passed')
    process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
