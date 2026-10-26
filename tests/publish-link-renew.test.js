/**
 * mnfst-publish keeps a connector upload link alive while a long render runs:
 * it POSTs <upload-url>/renew every few minutes and once more right before the
 * upload. An older server without the route (404) or a link it will not extend
 * (409) leaves the CLI behaving exactly as before. An expired link stops the
 * publish before the upload and says how to recover with --no-render.
 */
import { describe, it, expect } from 'vitest'
import { renewUrlFor, renewUploadLink, keepUploadLinkAlive, uploadBundle, expiredLinkAdvice } from '../packages/publish/manifest.publish.mjs'

const UPLOAD = 'https://mcp.example.dev/publish/put_abc123'
const RENEW = 'https://mcp.example.dev/publish/put_abc123/renew'

function res(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, ok: status >= 200 && status < 300, text: async () => text }
}

const pending = (s = 900) => res(200, { status: 'pending', expires_in_seconds: s, renewable_for_seconds: 10000 })

/** Scripted renew endpoint: responses (or Errors) consumed in order, the last repeats. */
function renewServer(queue) {
    const calls = []
    const fetchImpl = async (url, init) => {
        calls.push({ url, init })
        const r = queue[Math.min(calls.length - 1, queue.length - 1)]
        if (r instanceof Error) throw r
        return r
    }
    return { fetchImpl, calls }
}

/** Manual timers: fire() runs the pending callback, as if the interval elapsed. */
function timers() {
    let pendingFn = null
    let id = 0
    return {
        setTimer: (fn, ms) => { pendingFn = { fn, ms, id: ++id }; return pendingFn.id },
        clearTimer: (t) => { if (pendingFn && pendingFn.id === t) pendingFn = null },
        get scheduled() { return pendingFn },
        async fire() {
            const p = pendingFn
            pendingFn = null
            p.fn()
            // let the renew request and its rescheduling settle
            for (let i = 0; i < 10; i++) await Promise.resolve()
        },
    }
}

describe('renewUrlFor', () => {
    it('derives the renew URL from the upload URL, under either mount', () => {
        expect(renewUrlFor(UPLOAD)).toBe(RENEW)
        expect(renewUrlFor(UPLOAD + '/')).toBe(RENEW)
        expect(renewUrlFor('https://api.example.dev/v1/uploads/put_x')).toBe('https://api.example.dev/v1/uploads/put_x/renew')
    })
})

describe('renewUploadLink', () => {
    const one = async (r) => renewUploadLink(UPLOAD, { fetchImpl: renewServer([r]).fetchImpl })

    it('POSTs to <upload-url>/renew', async () => {
        const server = renewServer([pending()])
        await renewUploadLink(UPLOAD, { fetchImpl: server.fetchImpl })
        expect(server.calls[0].url).toBe(RENEW)
        expect(server.calls[0].init.method).toBe('POST')
    })

    it('gives each renewal a 15 second timeout', async () => {
        const server = renewServer([pending()])
        await renewUploadLink(UPLOAD, { fetchImpl: server.fetchImpl })
        const signal = server.calls[0].init.signal
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal.aborted).toBe(false)
    })

    it('treats a timed-out renewal as transient', async () => {
        const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
        expect((await one(timeout)).state).toBe('retry')
        // A body read that times out after the headers is transient too.
        const slowBody = { status: 200, ok: true, text: async () => { throw timeout } }
        expect((await one(slowBody)).state).toBe('retry')
    })

    it('reads each answer', async () => {
        expect((await one(pending())).state).toBe('renewed')
        expect((await one(res(410, { error: 'expired', message: 'Publish link expired or already used.' }))).state).toBe('expired')
        expect((await one(res(404, '404 Not Found'))).state).toBe('unsupported')
        expect((await one(res(409, { error: 'not_renewable' }))).state).toBe('unsupported')
        expect((await one(res(429, { error: 'rate_limited' }))).state).toBe('retry')
        expect((await one(res(503, 'busy'))).state).toBe('retry')
        expect((await one(new Error('ECONNRESET'))).state).toBe('retry')
    })
})

describe('keepUploadLinkAlive', () => {
    it('renews on every interval while the render runs, then once more before the upload', async () => {
        const server = renewServer([pending()])
        const t = timers()
        const keep = keepUploadLinkAlive(UPLOAD, { fetchImpl: server.fetchImpl, setTimer: t.setTimer, clearTimer: t.clearTimer, log: () => {} })
        expect(t.scheduled.ms).toBe(5 * 60 * 1000)
        expect(server.calls.length).toBe(0)
        await t.fire()
        await t.fire()
        await t.fire()
        expect(server.calls.length).toBe(3)
        expect(await keep.finish()).toBe('active')
        expect(server.calls.length).toBe(4)
        expect(t.scheduled).toBeNull()
    })

    it('carries on through transient failures', async () => {
        const server = renewServer([new Error('offline'), res(503, 'x'), pending()])
        const t = timers()
        const keep = keepUploadLinkAlive(UPLOAD, { fetchImpl: server.fetchImpl, setTimer: t.setTimer, clearTimer: t.clearTimer, log: () => {} })
        await t.fire()
        await t.fire()
        expect(t.scheduled).not.toBeNull()
        expect(await keep.finish()).toBe('active')
    })

    it('a final renewal that times out still lets the upload go ahead', async () => {
        const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
        const server = renewServer([timeout])
        const t = timers()
        const keep = keepUploadLinkAlive(UPLOAD, { fetchImpl: server.fetchImpl, setTimer: t.setTimer, clearTimer: t.clearTimer, log: () => {} })
        await t.fire()
        expect(t.scheduled).not.toBeNull()
        expect(await keep.finish()).toBe('active')
        expect(server.calls.length).toBe(2)
    })

    it('stops renewing against an older server and lets the upload go ahead as today', async () => {
        const server = renewServer([res(404, '404 Not Found')])
        const t = timers()
        const keep = keepUploadLinkAlive(UPLOAD, { fetchImpl: server.fetchImpl, setTimer: t.setTimer, clearTimer: t.clearTimer, log: () => {} })
        await t.fire()
        expect(t.scheduled).toBeNull()
        expect(await keep.finish()).toBe('unsupported')
        expect(server.calls.length).toBe(1)
    })

    it('reports an expired link and stops renewing', async () => {
        const logs = []
        const server = renewServer([res(410, { error: 'expired' })])
        const t = timers()
        const keep = keepUploadLinkAlive(UPLOAD, { fetchImpl: server.fetchImpl, setTimer: t.setTimer, clearTimer: t.clearTimer, log: (m) => logs.push(m) })
        await t.fire()
        expect(t.scheduled).toBeNull()
        expect(await keep.finish()).toBe('expired')
        expect(server.calls.length).toBe(1)
        expect(logs.some((l) => /expired/.test(l))).toBe(true)
    })

    it('finish waits for a renewal already in flight instead of racing the upload', async () => {
        let release
        const gate = new Promise((r) => { release = r })
        const calls = []
        const fetchImpl = async (url) => { calls.push(url); if (calls.length === 1) await gate; return pending() }
        const t = timers()
        const keep = keepUploadLinkAlive(UPLOAD, { fetchImpl, setTimer: t.setTimer, clearTimer: t.clearTimer, log: () => {} })
        t.scheduled.fn()
        let done = false
        const finished = keep.finish().then((s) => { done = true; return s })
        await Promise.resolve()
        expect(done).toBe(false)
        release()
        expect(await finished).toBe('active')
        expect(calls.length).toBe(2)
    })
})

describe('expired link recovery', () => {
    it('points a rendered site at --no-render', () => {
        const msg = expiredLinkAdvice({ rendered: true, outputDir: 'website' })
        expect(msg).toMatch(/manifest_publish again/)
        expect(msg).toMatch(/--no-render/)
        expect(msg).toMatch(/website/)
        expect(msg).not.toMatch(/—/)
    })

    it('needs no --no-render when nothing rendered', () => {
        expect(expiredLinkAdvice({ rendered: false })).not.toMatch(/--no-render/)
    })

    it('an upload 410 fails as an expired link, keeping the server message', async () => {
        const message = 'Publish link expired or already used. Run manifest_publish again for a new link.'
        const fetchImpl = async () => res(410, { error: 'expired', message })
        const err = await uploadBundle(UPLOAD, 'ZIP', { fetchImpl, sleepImpl: async () => {}, log: () => {} }).catch((e) => e)
        expect(err).toBeInstanceOf(Error)
        expect(err.code).toBe('link_expired')
        expect(err.message).toContain(message)
    })
})
