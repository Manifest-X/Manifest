/**
 * Tailwind engine output cache in real Chromium: replay on repeat visits, engine on anything unseen.
 *
 * Run: npm run build && node tests/e2e/tailwind-cache.e2e.mjs
 */
import puppeteer from 'puppeteer'
import { serve, pageHtml, twClasses } from './fixtures/tailwind-cache-site.mjs'

const HOST = 'app.example'
const KEY = 'tailwind-engine-cache:v1'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
function check(name, ok, detail = '') {
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

let themeColor = '#ff0000'
const B_CLASSES = ['pt-7', 'bg-rose-500', 'text-emerald-600', 'skew-x-6', 'w-[41px]', 'author-only-b', 'p-4', 'flex']
const pages = {
    '/': () => pageHtml(),
    '/b': () => pageHtml({ body: `<div id="b1" class="${B_CLASSES.join(' ')}">b</div>` }),
    '/theme': () => pageHtml({ extraHead: `<style type="text/tailwindcss">@theme { --color-tw-accent: ${themeColor}; }</style>`, body: '<div id="acc" class="text-tw-accent p-1">a</div>' }),
    '/vars-plain': () => pageHtml({ extraHead: '<style>:root { --color-brand: #336699; }</style>', body: '<div class="bg-brand p-1 text-red-500">a</div>' }),
    '/vars-none': () => pageHtml({ body: '<div class="bg-brand p-1 text-red-500">a</div>' }),
    '/vars-theme': () => pageHtml({ extraHead: '<style type="text/tailwindcss">@theme { --color-brand: #336699; }</style>', body: '<div class="bg-brand p-1 text-red-500">a</div>' }),
}

const PROPS = ['display', 'padding-top', 'padding-left', 'margin-top', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'width', 'height', 'border-top-width', 'border-top-color', 'border-radius', 'box-shadow', 'grid-template-columns', 'gap', 'opacity', 'transform', 'text-decoration-line', 'text-transform', 'font-style', 'justify-content', 'align-items', 'cursor']

const sample = (page) => page.evaluate((props) => {
    const els = [...document.querySelectorAll('[id^="probe"], .card, .card > *')]
    return els.map((el) => { const cs = getComputedStyle(el); return props.map((p) => cs.getPropertyValue(p)).join('|') })
}, PROPS)

const engineStyles = (page) => page.evaluate(() => ({
    engine: [...document.querySelectorAll('style')].filter((s) => !s.id && !s.hasAttribute('data-tailwind-cache') && (s.textContent || '').startsWith('/*! tailwindcss')).length,
    cached: document.querySelectorAll('style[data-tailwind-cache]').length,
    seed: document.querySelectorAll('[data-tailwind-seed]').length,
}))

const record = (page) => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k)) } catch (e) { return 'throws' } }, KEY)

// Engine script tags injected into this document (the HTTP cache hides repeat fetches from the server)
const engineLoads = (page) => page.evaluate(() => document.querySelectorAll('script[src*="tailwind"]').length)

const engineCss = (page) => page.evaluate(() => [...document.querySelectorAll('style')].filter((s) => !s.hasAttribute('data-tailwind-cache') && (s.textContent || '').startsWith('/*! tailwindcss')).map((s) => s.textContent).join('\n'))

async function main() {
    const srv = await serve({ pages })
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })
    const base = `http://${HOST}:${srv.port}`
    const dev = `http://localhost:${srv.port}`

    async function visit(page, url, settle = 2200) {
        srv.counts.engine = 0
        await page.goto(url, { waitUntil: 'load' })
        await page.waitForFunction(() => getComputedStyle(document.getElementById('probe-w')).width === '37px', { timeout: 15000 }).catch(() => { })
        await wait(settle)
        return engineLoads(page)
    }

    try {
        // Control: engine output with the variants we compare
        const ctx = await browser.createBrowserContext()
        const page = await ctx.newPage()
        const n1 = await visit(page, `${base}/`)
        const control = await sample(page)
        await page.hover('#probe-hover')
        const controlHover = await page.$eval('#probe-hover', (e) => getComputedStyle(e).backgroundColor)
        await page.evaluate(() => document.documentElement.classList.add('dark'))
        const controlDark = await page.$eval('#probe-hover', (e) => getComputedStyle(e).backgroundColor)
        const rec1 = await record(page)
        check('first visit: engine requested once', n1 === 1, `requests ${n1}`)
        check('first visit: cache written with tokens, blocks and CSS', rec1 && rec1.css.startsWith('/*! tailwindcss') && rec1.tokens.includes('w-[37px]') && rec1.tokens.includes('author-thing') && rec1.blocks.some((b) => b.includes('@custom-variant')), rec1 ? `${rec1.tokens.length} tokens, ${rec1.css.length} chars` : 'none')

        // Repeat visit
        await page.mouse.move(0, 0)
        const n2 = await visit(page, `${base}/`, 1500)
        const st2 = await engineStyles(page)
        const repeat = await sample(page)
        const diffs = control.filter((v, i) => v !== repeat[i]).length
        check('repeat visit: engine never requested', n2 === 0, `requests ${n2}`)
        check('repeat visit: cached sheet in place, no engine sheet', st2.cached === 1 && st2.engine === 0, JSON.stringify(st2))
        control.forEach((v, i) => { if (v !== repeat[i]) console.log('   differs', i, v, '\n          ', repeat[i]) })
        check('repeat visit: computed styles match the engine run', control.length > 50 && diffs === 0, `${control.length} elements, ${diffs} differ`)
        await page.hover('#probe-hover')
        const hover = await page.$eval('#probe-hover', (e) => getComputedStyle(e).backgroundColor)
        await page.evaluate(() => document.documentElement.classList.add('dark'))
        const dark = await page.$eval('#probe-hover', (e) => getComputedStyle(e).backgroundColor)
        check('variants survive: hover:', hover === controlHover, `${hover} vs ${controlHover}`)
        check('variants survive: dark:', dark === controlDark, `${dark} vs ${controlDark}`)
        const n2b = await engineLoads(page)
        check('toggling dark does not load the engine', n2b === 0, `requests ${n2b}`)
        await page.mouse.move(0, 0)

        // Unseen class after load: engine once, no flash, no duplicates
        await visit(page, `${base}/`, 800)
        await page.evaluate(() => {
            window.__frames = { total: 0, bad: 0 }
            const tick = () => {
                const ok = getComputedStyle(document.getElementById('probe-w')).width === '37px' && getComputedStyle(document.querySelector('.card')).display !== 'inline'
                window.__frames.total++
                if (!ok) window.__frames.bad++
                if (window.__frames.total < 240) requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
            const d = document.createElement('div')
            d.id = 'late'
            d.className = 'pt-7 bg-rose-500'
            document.body.appendChild(d)
        })
        await page.waitForFunction(() => getComputedStyle(document.getElementById('late')).paddingTop === '28px', { timeout: 15000 }).catch(() => { })
        await wait(2000)
        const st3 = await engineStyles(page)
        const frames = await page.evaluate(() => window.__frames)
        const late = await page.$eval('#late', (e) => getComputedStyle(e).paddingTop)
        const dupes = await page.evaluate(() => {
            let n = 0
            for (const s of document.styleSheets) { try { const walk = (rules) => { for (const r of rules) { if (r.selectorText === '.w-\\[37px\\]') n++; if (r.cssRules) walk(r.cssRules) } }; walk(s.cssRules) } catch (e) { } }
            return n
        })
        const rec3 = await record(page)
        check('unseen class: engine loaded exactly once', (await engineLoads(page)) === 1, `requests ${await engineLoads(page)}`)
        check('unseen class: new class styled', late === '28px', late)
        check('unseen class: cached copy and seed removed, one engine sheet', st3.cached === 0 && st3.engine === 1 && st3.seed === 0, JSON.stringify(st3))
        check('unseen class: no duplicate rules left', dupes === 1, `.w-[37px] rules: ${dupes}`)
        check('unseen class: no unstyled frame', frames.total > 30 && frames.bad === 0, JSON.stringify(frames))
        check('unseen class: cache now covers the union', rec3 && rec3.tokens.includes('pt-7') && rec3.tokens.includes('w-[37px]') && rec3.css.includes('rose-500'))

        // MPA: second page with different classes, then back and forth
        const nb1 = await visit(page, `${base}/b`)
        const recB = await record(page)
        const b1 = await page.$eval('#b1', (e) => [getComputedStyle(e).paddingTop, getComputedStyle(e).width].join(' '))
        check('MPA: page B with unseen classes loads the engine', nb1 === 1, `requests ${nb1}`)
        check('MPA: page B styled', b1 === '28px 41px', b1)
        check('MPA: cache covers both pages', recB && recB.tokens.includes('w-[41px]') && recB.tokens.includes('grid-cols-6') && recB.css.includes('41px') && recB.css.includes('grid-template-columns'))
        const na = await visit(page, `${base}/`, 1200)
        const repeatA = await sample(page)
        const nb2 = await visit(page, `${base}/b`, 1200)
        const b2 = await page.$eval('#b1', (e) => [getComputedStyle(e).paddingTop, getComputedStyle(e).width].join(' '))
        check('MPA: back on A, no engine and identical styles', na === 0 && control.filter((v, i) => v !== repeatA[i]).length === 0, `requests ${na}`)
        check('MPA: back on B, no engine and styled', nb2 === 0 && b2 === '28px 41px', `requests ${nb2}, ${b2}`)

        // Block added after boot
        await visit(page, `${base}/`, 800)
        await page.evaluate(() => { const s = document.createElement('style'); s.type = 'text/tailwindcss'; s.textContent = '@theme { --color-late: #010203; }'; document.head.appendChild(s) })
        await wait(2500)
        check('block added after boot: engine loads', (await engineLoads(page)) === 1, `requests ${await engineLoads(page)}`)
        await ctx.close()

        // Changed text/tailwindcss block between visits
        {
            const c = await browser.createBrowserContext()
            const p = await c.newPage()
            themeColor = '#ff0000'
            await visit(p, `${base}/theme`)
            const r0 = await p.$eval('#acc', (e) => getComputedStyle(e).color)
            const nSame = await visit(p, `${base}/theme`, 1200)
            themeColor = '#00ff00'
            const nChanged = await visit(p, `${base}/theme`)
            const r1 = await p.$eval('#acc', (e) => getComputedStyle(e).color)
            check('theme block unchanged: replayed', nSame === 0, `requests ${nSame}`)
            check('theme block changed: engine loads and new value applies', nChanged === 1 && r0 === 'rgb(255, 0, 0)' && r1 === 'rgb(0, 255, 0)', `requests ${nChanged}, ${r0} -> ${r1}`)
            await c.close()
        }

        // Storage disabled
        {
            const c = await browser.createBrowserContext()
            const p = await c.newPage()
            await p.evaluateOnNewDocument(() => {
                const boom = () => { throw new DOMException('denied', 'SecurityError') }
                Object.defineProperty(window, 'localStorage', { get: boom, configurable: true })
            })
            const a = await visit(p, `${base}/`)
            const b = await visit(p, `${base}/`)
            const w = await p.$eval('#probe-w', (e) => getComputedStyle(e).width)
            check('storage disabled: engine runs every visit, page styled', a === 1 && b === 1 && w === '37px', `requests ${a}/${b}, ${w}`)
            await c.close()
        }

        // Quota: setItem throws
        {
            const c = await browser.createBrowserContext()
            const p = await c.newPage()
            await p.evaluateOnNewDocument(() => { Storage.prototype.setItem = function () { throw new DOMException('full', 'QuotaExceededError') } })
            const a = await visit(p, `${base}/`)
            const b = await visit(p, `${base}/`)
            check('quota full: engine runs every visit', a === 1 && b === 1, `requests ${a}/${b}`)
            await c.close()
        }

        // Dev host
        {
            const c = await browser.createBrowserContext()
            const p = await c.newPage()
            const a = await visit(p, `${dev}/`)
            const b = await visit(p, `${dev}/`)
            const r = await record(p)
            check('dev host: engine every visit, nothing cached', a === 1 && b === 1 && !r, `requests ${a}/${b}`)
            await c.close()
        }

        // Prerender flag
        {
            const c = await browser.createBrowserContext()
            const p = await c.newPage()
            await visit(p, `${base}/`)
            await p.evaluateOnNewDocument(() => { window.__manifestRender = true })
            const b = await visit(p, `${base}/`)
            const st = await engineStyles(p)
            check('prerender flag: engine loads, no replay', b === 1 && st.cached === 0, `requests ${b}, ${JSON.stringify(st)}`)
            await c.close()
        }

        // Which CSS variables change Tailwind's output (dev host: engine always runs)
        {
            const c = await browser.createBrowserContext()
            const p = await c.newPage()
            await visit(p, `${dev}/vars-none`, 1500)
            const none = await engineCss(p)
            await visit(p, `${dev}/vars-plain`, 1500)
            const plain = await engineCss(p)
            await visit(p, `${dev}/vars-theme`, 1500)
            const theme = await engineCss(p)
            await visit(p, `${dev}/vars-none`, 1500)
            await p.evaluate(() => document.documentElement.style.setProperty('--color-brand', '#336699'))
            await wait(800)
            const runtime = await engineCss(p)
            check('--color-brand in ordinary CSS: Tailwind output unchanged', plain === none, `${plain.length} vs ${none.length}`)
            check('--color-brand set at runtime: Tailwind output unchanged', runtime === none, `${runtime.length} vs ${none.length}`)
            check('--color-brand in a text/tailwindcss @theme: Tailwind output changes', theme !== none && theme.includes('--color-brand') && !none.includes('.bg-brand'), `${theme.length} vs ${none.length}`)
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
