/**
 * @vitest-environment happy-dom
 *
 * x-submit: sends the form to its own action/method with Accept: application/json,
 * reflects data-state/aria-busy, dispatches the response, maps server field errors
 * onto controls and renders nothing.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/manifest.submissions.js'), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await tick() }

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let calls, reply

beforeAll(() => {
    window.happyDOM.setURL('https://site.example/contact/')
    new Function(SRC)()
})

beforeEach(() => {
    calls = []
    reply = () => json({ ok: true, id: 'sub_1' })
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { calls.push({ url: String(url), init }); return reply() }))
    delete window.turnstile
})

function mount(html) {
    document.body.innerHTML = html
    return document.querySelector('form')
}

function submit(form, submitter = null) {
    const e = new window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter })
    form.dispatchEvent(e)
    return e
}

const sentBody = (i = 0) => new URLSearchParams(calls[i].init.body)

describe('sending', () => {
    it('posts the fields to the action with Accept: application/json and prevents navigation', async () => {
        const form = mount('<form x-submit action="/_forms/contact" method="post"><input name="email" value="a@b.co"><textarea name="message">Hi</textarea></form>')
        const e = submit(form)
        expect(e.defaultPrevented).toBe(true)
        await settle()
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe('https://site.example/_forms/contact')
        expect(calls[0].init.method).toBe('POST')
        expect(calls[0].init.headers.Accept).toBe('application/json')
        expect(sentBody().get('email')).toBe('a@b.co')
        expect(sentBody().get('message')).toBe('Hi')
    })

    it('urlencodes by default and sends multipart when the form asks for it', async () => {
        const a = mount('<form x-submit action="/a" method="post"><input name="x" value="1"></form>')
        submit(a); await settle()
        expect(calls[0].init.body).toBeInstanceOf(URLSearchParams)
        const b = mount('<form x-submit action="/b" method="post" enctype="multipart/form-data"><input name="x" value="1"></form>')
        submit(b); await settle()
        expect(calls[1].init.body).toBeInstanceOf(FormData)
    })

    it('GET puts the fields in the query string, replacing any there', async () => {
        const form = mount('<form x-submit action="/search?old=1"><input name="q" value="solar panels"></form>')
        submit(form); await settle()
        expect(calls[0].init.method).toBe('GET')
        expect(calls[0].init.body).toBeUndefined()
        expect(calls[0].url).toBe('https://site.example/search?q=solar+panels')
    })

    it('uses the submitter formaction/formmethod and includes its name/value', async () => {
        const form = mount('<form x-submit action="/a" method="get"><input name="x" value="1"><button name="intent" value="quote" formaction="/_forms/estimate" formmethod="post">Go</button></form>')
        submit(form, form.querySelector('button')); await settle()
        expect(calls[0].url).toBe('https://site.example/_forms/estimate')
        expect(calls[0].init.method).toBe('POST')
        expect(sentBody().get('intent')).toBe('quote')
    })

    it('leaves forms without x-submit, method=dialog and author-prevented submits alone', async () => {
        const plain = mount('<form action="/a" method="post"></form>')
        expect(submit(plain).defaultPrevented).toBe(false)
        const dialog = mount('<form x-submit method="dialog"></form>')
        expect(submit(dialog).defaultPrevented).toBe(false)
        const own = mount('<form x-submit action="/a" method="post"></form>')
        own.addEventListener('submit', e => e.preventDefault())
        submit(own)
        await settle()
        expect(calls).toHaveLength(0)
    })
})

describe('state and events', () => {
    it('sets data-state and aria-busy while sending, ignores re-submits, then reports sent', async () => {
        let release
        reply = () => new Promise(r => { release = () => r(json({ ok: true, id: 'sub_9' })) })
        const form = mount('<form x-submit action="/a" method="post"></form>')
        const seen = []
        form.addEventListener('submit:sent', e => seen.push(e.detail))
        submit(form); await tick()
        expect(form.getAttribute('data-state')).toBe('sending')
        expect(form.getAttribute('aria-busy')).toBe('true')
        expect(submit(form).defaultPrevented).toBe(true)
        expect(calls).toHaveLength(1)
        release(); await settle()
        expect(form.getAttribute('data-state')).toBe('sent')
        expect(form.hasAttribute('aria-busy')).toBe(false)
        expect(seen).toHaveLength(1)
        expect(seen[0]).toMatchObject({ ok: true, status: 200, data: { ok: true, id: 'sub_9' }, error: null })
        expect(seen[0].response).toBeInstanceOf(Response)
    })

    it('reports an error status with the body code and message', async () => {
        reply = () => json({ ok: false, error: 'cap_reached', message: 'Monthly limit reached' }, 429)
        const form = mount('<form x-submit action="/a" method="post"></form>')
        const seen = []
        form.addEventListener('submit:error', e => seen.push(e.detail))
        submit(form); await settle()
        expect(form.getAttribute('data-state')).toBe('error')
        expect(seen[0]).toMatchObject({ ok: false, status: 429, error: 'cap_reached', message: 'Monthly limit reached' })
    })

    it('treats a 200 { ok: false } as an error', async () => {
        reply = () => json({ ok: false, error: 'rejected' })
        const form = mount('<form x-submit action="/a" method="post"></form>')
        let got
        form.addEventListener('submit:error', e => { got = e.detail })
        submit(form); await settle()
        expect(got.error).toBe('rejected')
    })

    it('reports a non-JSON failure as http_error with data null', async () => {
        reply = () => new Response('<h1>Oops</h1>', { status: 500, statusText: 'Server Error' })
        const form = mount('<form x-submit action="/a" method="post"></form>')
        let got
        form.addEventListener('submit:error', e => { got = e.detail })
        submit(form); await settle()
        expect(got).toMatchObject({ ok: false, status: 500, data: null, error: 'http_error' })
    })

    it('reports a network failure as network_error and status 0', async () => {
        reply = () => Promise.reject(new TypeError('Failed to fetch'))
        const form = mount('<form x-submit action="/a" method="post"></form>')
        let got
        form.addEventListener('submit:error', e => { got = e.detail })
        submit(form); await settle()
        expect(form.getAttribute('data-state')).toBe('error')
        expect(got).toMatchObject({ ok: false, status: 0, response: null, error: 'network_error', message: 'Failed to fetch' })
    })

    it('bubbles, so a wrapper can listen', async () => {
        const form = mount('<div id="w"><form x-submit action="/a" method="post"></form></div>')
        let n = 0
        document.getElementById('w').addEventListener('submit:sent', () => n++)
        submit(form); await settle()
        expect(n).toBe(1)
    })

    it('renders nothing into the form', async () => {
        const form = mount('<form x-submit action="/a" method="post"><input name="a"></form>')
        const before = form.innerHTML
        submit(form); await settle()
        expect(form.innerHTML).toBe(before)
    })

    it('keeps the event names in one constant', () => {
        expect(window.ManifestSubmissions.events).toEqual({ sent: 'submit:sent', error: 'submit:error' })
    })
})

describe('server field errors', () => {
    it('maps { fields } onto controls, reports the first, and clears on edit', async () => {
        reply = () => json({ ok: false, error: 'invalid', fields: { email: 'Use a work address', phone: 'Too short' } }, 422)
        const form = mount('<form x-submit action="/a" method="post"><input name="email" value="x@gmail.com"><input name="phone" value="1"></form>')
        const email = form.querySelector('[name=email]'), phone = form.querySelector('[name=phone]')
        const report = vi.spyOn(email, 'reportValidity')
        submit(form); await settle()
        expect(email.validationMessage).toBe('Use a work address')
        expect(phone.validationMessage).toBe('Too short')
        expect(report).toHaveBeenCalledTimes(1)
        email.dispatchEvent(new window.Event('input', { bubbles: true }))
        expect(email.validationMessage).toBe('')
        expect(phone.validationMessage).toBe('Too short')
    })

    it('maps Formspree-style { errors: [{ field, message }] } and uses its code', async () => {
        reply = () => json({ errors: [{ code: 'TYPE_EMAIL', field: 'email', message: 'should be an email' }] }, 422)
        const form = mount('<form x-submit action="/a" method="post"><input name="email" value="nope"></form>')
        let got
        form.addEventListener('submit:error', e => { got = e.detail })
        submit(form); await settle()
        expect(form.querySelector('[name=email]').validationMessage).toBe('should be an email')
        expect(got).toMatchObject({ error: 'TYPE_EMAIL', message: 'should be an email' })
    })

    it('clears earlier server errors when the form is sent again', async () => {
        reply = () => json({ fields: { email: 'Taken' } }, 422)
        const form = mount('<form x-submit novalidate action="/a" method="post"><input name="email" value="a@b.co"></form>')
        submit(form); await settle()
        expect(form.querySelector('[name=email]').validationMessage).toBe('Taken')
        reply = () => json({ ok: true, id: '1' })
        submit(form); await settle()
        expect(form.querySelector('[name=email]').validationMessage).toBe('')
    })
})

describe('turnstile', () => {
    it('resets a widget inside the form after a response', async () => {
        window.turnstile = { reset: vi.fn() }
        const form = mount('<form x-submit action="/a" method="post"><div class="cf-turnstile"></div></form>')
        submit(form); await settle()
        expect(window.turnstile.reset).toHaveBeenCalledWith(form.querySelector('.cf-turnstile'))
    })

    it('does nothing without a widget', async () => {
        window.turnstile = { reset: vi.fn() }
        const form = mount('<form x-submit action="/a" method="post"></form>')
        submit(form); await settle()
        expect(window.turnstile.reset).not.toHaveBeenCalled()
    })
})

describe('review fixes', () => {
    it('reads action, method and enctype from attributes when controls shadow them', async () => {
        const form = mount('<form x-submit action="/_forms/x" method="post" enctype="multipart/form-data"><input name="action" value="a"><input name="method" value="m"><input name="enctype" value="e"><input name="elements" value="el"><input name="target" value="t"></form>')
        expect(submit(form).defaultPrevented).toBe(true)
        await settle()
        expect(calls[0].url).toBe('https://site.example/_forms/x')
        expect(calls[0].init.method).toBe('POST')
        expect(calls[0].init.body).toBeInstanceOf(FormData)
        expect(calls[0].init.body.get('action')).toBe('a')
    })

    it('an empty or missing action posts to the document URL', async () => {
        window.happyDOM.setURL('https://site.example/contact/?ref=1')
        const form = mount('<form x-submit action="" method="post"><input name="a" value="1"></form>')
        submit(form); await settle()
        expect(calls[0].url).toBe('https://site.example/contact/?ref=1')
        window.happyDOM.setURL('https://site.example/contact/')
    })

    it('honours the submitter formenctype and an invalid method falls back to GET', async () => {
        const form = mount('<form x-submit action="/a" method="bogus"><input name="x" value="1"><button formmethod="post" formenctype="multipart/form-data">Go</button></form>')
        submit(form, form.querySelector('button')); await settle()
        expect(calls[0].init.method).toBe('POST')
        expect(calls[0].init.body).toBeInstanceOf(FormData)
        const get = mount('<form x-submit action="/a" method="bogus"><input name="x" value="1"></form>')
        submit(get); await settle()
        expect(calls[1].init.method).toBe('GET')
    })

    it('sends text/plain as text/plain lines', async () => {
        const form = mount('<form x-submit action="/a" method="post" enctype="text/plain"><input name="a" value="1"><input name="b" value="two words"></form>')
        submit(form); await settle()
        expect(calls[0].init.body).toBe('a=1\r\nb=two words\r\n')
    })

    it('leaves forms that target another browsing context to the browser', async () => {
        const blank = mount('<form x-submit action="/a" method="post" target="_blank"></form>')
        expect(submit(blank).defaultPrevented).toBe(false)
        const self = mount('<form x-submit action="/a" method="post" target="_self"></form>')
        expect(submit(self).defaultPrevented).toBe(true)
        const viaButton = mount('<form x-submit action="/a" method="post"><button formtarget="frame">Go</button></form>')
        expect(submit(viaButton, viaButton.querySelector('button')).defaultPrevented).toBe(false)
        document.head.innerHTML = '<base target="_blank">'
        const viaBase = mount('<form x-submit action="/a" method="post"></form>')
        expect(submit(viaBase).defaultPrevented).toBe(false)
        document.head.innerHTML = ''
        await settle()
        expect(calls).toHaveLength(1)
    })

    it('never sends a chosen file as text: non-multipart forms with a file go native', async () => {
        const form = mount('<form x-submit action="/a" method="post"><input type="file" name="f"></form>')
        const file = new File(['x'], 'cv.pdf')
        const RealFormData = globalThis.FormData
        vi.stubGlobal('FormData', class extends RealFormData { constructor(f, s) { super(f, s); if (f) this.set('f', file) } })
        try {
            expect(submit(form).defaultPrevented).toBe(false)
            const multi = mount('<form x-submit action="/a" method="post" enctype="multipart/form-data"><input type="file" name="f"></form>')
            expect(submit(multi).defaultPrevented).toBe(true)
        } finally { vi.stubGlobal('FormData', RealFormData) }
        await settle()
        expect(calls).toHaveLength(1)
    })

    it('an unchosen file input sends an empty value, not [object File]', async () => {
        const form = mount('<form x-submit action="/a" method="post"><input name="a" value="1"><input type="file" name="f"></form>')
        submit(form); await settle()
        expect(String(calls[0].init.body)).not.toContain('object')
    })

    it('maps field errors only onto controls the visitor can see and edit', async () => {
        reply = () => json({ fields: { v: 'bad', h: 'bad', d: 'bad', r: 'bad', n: 'bad', c: 'bad', a: 'bad', s: 'bad' } }, 422)
        const form = mount(`<form x-submit action="/a" method="post">
            <input name="v" value="1">
            <input type="hidden" name="h" value="1">
            <input name="d" value="1" disabled>
            <input name="r" value="1" readonly>
            <input name="n" value="1" style="display:none">
            <details><summary>More</summary><input name="c" value="1"></details>
            <div hidden><input name="a" value="1"></div>
            <fieldset disabled><input name="s" value="1"></fieldset>
        </form>`)
        submit(form); await settle()
        const msg = (n) => form.querySelector(`[name=${n}]`).validationMessage
        expect(msg('v')).toBe('bad')
        for (const n of ['h', 'd', 'r', 'n', 'c', 'a', 's']) expect([n, msg(n)]).toEqual([n, ''])
        expect(form.__mnfstSubmitErrors.map(c => c.name)).toEqual(['v'])
    })

    it('an error naming only unreachable fields leaves the form submittable', async () => {
        reply = () => json({ fields: { h: 'bad' } }, 422)
        const form = mount('<form x-submit action="/a" method="post"><input type="hidden" name="h" value="1"></form>')
        let got
        form.addEventListener('submit:error', e => { got = e.detail })
        submit(form); await settle()
        expect(got.status).toBe(422)
        expect(form.checkValidity()).toBe(true)
    })

    it('send() without a sendable request reports unsupported and sends nothing', async () => {
        const form = mount('<form action="/a" method="post" target="_blank"></form>')
        const d = await window.ManifestSubmissions.send(form)
        expect(d.error).toBe('unsupported')
        expect(calls).toHaveLength(0)
    })
})
