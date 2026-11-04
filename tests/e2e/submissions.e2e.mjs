/**
 * x-submit and form validation styling in real Chromium: native validation gates the send,
 * :user-invalid styles apply, the form posts without navigating, server field errors reach
 * the control, and the same form without script still posts natively.
 *
 * Run: node tests/e2e/submissions.e2e.mjs
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const PLUGIN = read('src/scripts/manifest.submissions.js')
const CSS = read('src/styles/core/manifest.theme.css') + read('src/styles/elements/manifest.form.css') + read('src/styles/elements/manifest.input.css')

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const FORM = `<form id="f" x-submit action="/_forms/contact" method="post">
    <input name="name" required minlength="2">
    <input name="email" type="email" required>
    <input type="hidden" name="_redirect" value="/thanks?sent=1">
    <button name="intent" value="send">Send</button>
</form>`
const page = (script) => `<!doctype html><html><head><style>${CSS}</style></head><body>${FORM}${script ? `<script>${PLUGIN}</script>` : ''}</body></html>`

const received = []
const server = http.createServer((req, res) => {
    if (req.url === '/js') return res.end(page(true))
    if (req.url === '/nojs') return res.end(page(false))
    if (req.url.startsWith('/thanks')) return res.end('<!doctype html><p id="thanks">Thanks</p>')
    if (req.url === '/_forms/contact' && req.method === 'POST') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
            const fields = Object.fromEntries(new URLSearchParams(body))
            received.push({ accept: req.headers.accept, type: req.headers['content-type'], fields })
            const wantsJson = (req.headers.accept || '').includes('application/json')
            if (fields.email === 'taken@example.com') {
                res.writeHead(422, { 'content-type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, error: 'invalid', fields: { email: 'Already registered' } }))
            }
            if (!wantsJson && fields._redirect) {
                res.writeHead(303, { location: fields._redirect })
                return res.end()
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, id: 'sub_1' }))
        })
        return
    }
    res.writeHead(404); res.end()
})
await new Promise(r => server.listen(0, r))
const BASE = `http://localhost:${server.address().port}`
const browser = await puppeteer.launch({ headless: 'shell' })

try {
    // With x-submit
    {
        const p = await browser.newPage()
        const errors = []
        p.on('pageerror', e => errors.push(e.message))
        await p.goto(`${BASE}/js`, { waitUntil: 'load' })

        await p.click('button')
        await new Promise(r => setTimeout(r, 200))
        check('invalid form never sends', received.length === 0, received.length)
        const shadow = await p.evaluate(() => {
            const el = document.querySelector('[name=name]')
            return { invalid: el.matches(':user-invalid'), shadow: getComputedStyle(el).boxShadow }
        })
        check(':user-invalid applies after a submit attempt', shadow.invalid, shadow)
        check(':user-invalid draws the field ring', shadow.shadow && shadow.shadow !== 'none', shadow.shadow)

        await p.type('[name=name]', 'Ada')
        await p.type('[name=email]', 'ada@example.com')
        const valid = await p.evaluate(() => document.querySelector('[name=name]').matches(':user-valid'))
        check(':user-valid applies once fixed', valid)

        const sent = p.evaluate(() => new Promise(r => document.getElementById('f').addEventListener('submit-sent', e => r({ ok: e.detail.ok, data: e.detail.data }), { once: true })))
        await p.click('button')
        const detail = await sent
        check('submit-sent carries the JSON response', detail.ok && detail.data.id === 'sub_1', detail)
        const last = received.at(-1)
        check('sent with Accept: application/json', last.accept === 'application/json', last.accept)
        check('urlencoded like a native post', /x-www-form-urlencoded/.test(last.type), last.type)
        check('submitter name/value included', last.fields.intent === 'send', last.fields)
        check('page did not navigate', p.url() === `${BASE}/js`, p.url())
        const state = await p.evaluate(() => ({ s: document.getElementById('f').dataset.state, busy: document.getElementById('f').getAttribute('aria-busy') }))
        check('data-state=sent, aria-busy removed', state.s === 'sent' && state.busy === null, state)

        await p.evaluate(() => { document.querySelector('[name=email]').value = '' })
        await p.type('[name=email]', 'taken@example.com')
        const failed = p.evaluate(() => new Promise(r => document.getElementById('f').addEventListener('submit-error', e => r({ status: e.detail.status, error: e.detail.error }), { once: true })))
        await p.click('button')
        const err = await failed
        check('submit-error carries status and code', err.status === 422 && err.error === 'invalid', err)
        const msg = await p.evaluate(() => document.querySelector('[name=email]').validationMessage)
        check('server field error lands on the control', msg === 'Already registered', msg)
        await p.type('[name=email]', 'x')
        const cleared = await p.evaluate(() => document.querySelector('[name=email]').validationMessage)
        check('field error clears on edit', cleared === '', cleared)
        check('no page errors', errors.length === 0, errors)
        await p.close()
    }

    // Same form without script: native post, 303 to the project's own page
    {
        const p = await browser.newPage()
        await p.goto(`${BASE}/nojs`, { waitUntil: 'load' })
        await p.type('[name=name]', 'Ada')
        await p.type('[name=email]', 'ada@example.com')
        await Promise.all([p.waitForNavigation(), p.click('button')])
        check('no-JS post follows _redirect', p.url() === `${BASE}/thanks?sent=1`, p.url())
        await p.close()
    }
} finally {
    await browser.close()
    server.close()
}

if (failures.length) {
    console.log(`\n${failures.length} failed`)
    process.exit(1)
}
console.log('\nall passed')
