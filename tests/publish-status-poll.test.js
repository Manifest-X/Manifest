/**
 * mnfst-publish upload protocol: the server no longer holds the connection for
 * the ingest, so the CLI must (a) still handle an old synchronous {ok:true}
 * server unchanged, (b) poll <upload-url>/status after a 202, and (c) treat a
 * dead connection during upload as "find out whether it landed" rather than
 * "send the whole archive again".
 */
import { describe, it, expect } from 'vitest'
import { statusUrlFor, pollPublishStatus, uploadBundle } from '../packages/publish/manifest.publish.mjs'

const UPLOAD = 'https://mcp.example.dev/publish/put_abc123'
const STATUS = 'https://mcp.example.dev/publish/put_abc123/status'

function res(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, ok: status >= 200 && status < 300, text: async () => text }
}

/**
 * Scripted server. `upload` and `status` are arrays of responses (or Error
 * instances to throw) consumed in order; the last entry repeats.
 */
function fakeServer({ upload = [], status = [] } = {}) {
    const calls = { upload: 0, status: 0, uploadBodies: [] }
    const take = (queue, i) => queue[Math.min(i, queue.length - 1)]
    const fetchImpl = async (url, init) => {
        if (url === STATUS) {
            const r = take(status, calls.status++)
            if (r instanceof Error) throw r
            return r
        }
        expect(url).toBe(UPLOAD)
        expect(init.method).toBe('POST')
        calls.uploadBodies.push(init.body)
        const r = take(upload, calls.upload++)
        if (r instanceof Error) throw r
        return r
    }
    return { fetchImpl, calls }
}

// Virtual clock: sleeps advance time instantly, so backoff/deadline logic is
// exercised in full without the test actually waiting.
function clock() {
    let t = 0
    return {
        now: () => t,
        sleepImpl: async (ms) => { t += ms },
        slept: [],
    }
}

function harness(server, extra = {}) {
    const c = clock()
    const logs = []
    const sleepImpl = async (ms) => { c.slept.push(ms); await c.sleepImpl(ms) }
    return {
        c, logs,
        opts: { fetchImpl: server.fetchImpl, sleepImpl, now: c.now, log: (m) => logs.push(m), ...extra },
    }
}

describe('statusUrlFor', () => {
    it('derives the status URL from the already-validated upload URL', () => {
        expect(statusUrlFor(UPLOAD)).toBe(STATUS)
        expect(statusUrlFor(UPLOAD + '/')).toBe(STATUS)
    })
})

describe('uploadBundle — old synchronous server (unchanged behaviour)', () => {
    it('returns the upload response as the success payload, never touching /status', async () => {
        const server = fakeServer({
            upload: [res(200, { ok: true, deployment_id: 'dep_1', url: 'https://site.example', files: 3 })],
        })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)

        expect(out.url).toBe('https://site.example')
        expect(out.deployment_id).toBe('dep_1')
        expect(server.calls.upload).toBe(1)
        expect(server.calls.status).toBe(0) // no polling at all on the old path
    })

    it('still surfaces a synchronous rejection as a failure', async () => {
        const server = fakeServer({ upload: [res(413, { error: 'too_large', message: 'too big' })] })
        const h = harness(server)
        await expect(uploadBundle(UPLOAD, 'ZIP', h.opts)).rejects.toThrow(/HTTP 413/)
        expect(server.calls.status).toBe(0)
    })

    it('retries a 5xx exactly as before', async () => {
        const server = fakeServer({ upload: [res(500, 'boom'), res(200, { ok: true, url: 'https://s.example' })] })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(out.url).toBe('https://s.example')
        expect(server.calls.upload).toBe(2)
    })
})

describe('uploadBundle — async server: ingesting → done', () => {
    it('polls the status URL until done and returns the success payload', async () => {
        const server = fakeServer({
            upload: [res(202, { status: 'ingesting', deployment_id: 'dep_9', status_url: STATUS })],
            status: [
                res(200, { status: 'ingesting' }),
                res(200, { status: 'ingesting' }),
                res(200, { status: 'done', ok: true, deployment_id: 'dep_9', url: 'https://live.example', files: 42 }),
            ],
        })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)

        expect(out.url).toBe('https://live.example')
        expect(out.files).toBe(42)
        expect(server.calls.upload).toBe(1)     // the archive is sent exactly once
        expect(server.calls.status).toBe(3)
        expect(h.c.slept).toEqual([1000, 2000]) // 1s → 2s backoff between polls
    })

    it('backs off 1s → 2s → 4s and caps at 5s', async () => {
        const server = fakeServer({
            upload: [res(202, { status: 'ingesting' })],
            status: [...Array(6).fill(res(200, { status: 'ingesting' })), res(200, { status: 'done', ok: true, url: 'u' })],
        })
        const h = harness(server)
        await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(h.c.slept).toEqual([1000, 2000, 4000, 5000, 5000, 5000])
    })

    it('tolerates a blip and a 429 while polling', async () => {
        const server = fakeServer({
            upload: [res(202, { status: 'ingesting' })],
            status: [
                new Error('ECONNRESET'),
                res(429, { error: 'rate_limited' }),
                res(200, { status: 'done', ok: true, url: 'https://ok.example' }),
            ],
        })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(out.url).toBe('https://ok.example')
    })

    it('reports progress while the ingest runs', async () => {
        const server = fakeServer({
            upload: [res(202, { status: 'ingesting' })],
            status: [...Array(8).fill(res(200, { status: 'ingesting' })), res(200, { status: 'done', ok: true, url: 'u' })],
        })
        const h = harness(server)
        await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(h.logs.some((l) => /upload received/i.test(l))).toBe(true)
        expect(h.logs.some((l) => /still publishing/.test(l))).toBe(true)
    })
})

describe('uploadBundle — async server: ingesting → error', () => {
    it('fails with the server error code and message, and does not re-upload', async () => {
        const server = fakeServer({
            upload: [res(202, { status: 'ingesting' })],
            status: [
                res(200, { status: 'ingesting' }),
                res(200, { status: 'error', error: 'no_files', message: 'The archive contained no servable files.', http_status: 400 }),
            ],
        })
        const h = harness(server)
        await expect(uploadBundle(UPLOAD, 'ZIP', h.opts)).rejects.toThrow(/no_files.*no servable files/s)
        expect(server.calls.upload).toBe(1)
    })

    it('gives up cleanly when the publish never settles inside the overall cap', async () => {
        const server = fakeServer({
            upload: [res(202, { status: 'ingesting' })],
            status: [res(200, { status: 'ingesting' })],
        })
        const h = harness(server, { totalMs: 60_000 })
        await expect(uploadBundle(UPLOAD, 'ZIP', h.opts)).rejects.toThrow(/still running/)
    })
})

describe('uploadBundle — connection died during upload', () => {
    it('polls the status instead of re-sending the archive when the bundle landed', async () => {
        const server = fakeServer({
            upload: [new Error('fetch failed')],
            status: [
                res(200, { status: 'ingesting' }),
                res(200, { status: 'done', ok: true, url: 'https://landed.example', files: 7 }),
            ],
        })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)

        expect(out.url).toBe('https://landed.example')
        expect(server.calls.upload).toBe(1) // NOT retried — it had already landed
        expect(h.logs.some((l) => /lost the connection/.test(l))).toBe(true)
    })

    it('retries the upload when the status stays pending past the grace (it never landed)', async () => {
        const server = fakeServer({
            upload: [new Error('fetch failed'), res(200, { ok: true, url: 'https://second.example' })],
            status: [res(200, { status: 'pending' })],
        })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(out.url).toBe('https://second.example')
        expect(server.calls.upload).toBe(2)
    })

    it('falls back to plain upload retries when the server has no status route', async () => {
        const server = fakeServer({
            upload: [new Error('fetch failed'), res(200, { ok: true, url: 'https://old.example' })],
            status: [res(404, '404 Not Found')], // Hono's plain-text default — untagged
        })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(out.url).toBe('https://old.example')
        expect(server.calls.upload).toBe(2)
        expect(server.calls.status).toBe(1) // probed once, then gave up on polling
    })

    it('reports an expired token rather than retrying, when the server tags the 404', async () => {
        const server = fakeServer({
            upload: [new Error('fetch failed')],
            status: [res(404, { status: 'unknown', error: 'unknown_token' })],
        })
        const h = harness(server)
        await expect(uploadBundle(UPLOAD, 'ZIP', h.opts)).rejects.toThrow(/expired/)
        expect(server.calls.upload).toBe(1)
    })
})

describe('uploadBundle — retry meets an ingest already in flight', () => {
    it('waits for the in-flight ingest instead of re-uploading', async () => {
        const server = fakeServer({
            upload: [res(409, { error: 'ingest_in_progress', message: 'still processing' })],
            status: [res(200, { status: 'done', ok: true, url: 'https://inflight.example' })],
        })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(out.url).toBe('https://inflight.example')
        expect(server.calls.upload).toBe(1)
    })
})

describe('pollPublishStatus states', () => {
    const poll = (status, extra = {}) => {
        const server = fakeServer({ status })
        const h = harness(server, extra)
        return pollPublishStatus(STATUS, h.opts)
    }

    it('distinguishes a tagged 404 (token gone) from an untagged one (no route)', async () => {
        expect((await poll([res(404, { status: 'unknown', error: 'unknown_token' })])).state).toBe('unknown')
        expect((await poll([res(404, '404 Not Found')])).state).toBe('unsupported')
    })

    it('treats pending inside the grace as still waiting, and past it as never-landed', async () => {
        expect((await poll([res(200, { status: 'pending' }), res(200, { status: 'done', ok: true })],
            { pendingGraceMs: 15_000 })).state).toBe('done')
        expect((await poll([res(200, { status: 'pending' })], { pendingGraceMs: 15_000 })).state).toBe('pending')
    })

    it('never treats pending as never-landed when no grace is set (post-202 polling)', async () => {
        const r = await poll([...Array(4).fill(res(200, { status: 'pending' })), res(200, { status: 'done', ok: true })])
        expect(r.state).toBe('done')
    })
})

// Payloads captured verbatim from the Manifest-MCP publish route's own
// integration tests (commit c41250f). These pin the cross-repo contract: if the
// server's shapes drift, this fails here rather than in a user's publish.
const SERVER = {
    pending: { status: 200, body: { status: 'pending', deployment_id: 'dep_76', env: 'production' } },
    ack: {
        status: 202,
        body: {
            status: 'ingesting',
            deployment_id: 'dep_76',
            env: 'production',
            status_url: STATUS,
            poll_after_ms: 1000,
            message: 'Upload received — publishing is finishing in the background. Poll status_url until status is "done". (Seeing this as a failure? Update the CLI: npm i mnfst-publish@latest.)',
        },
    },
    done: {
        status: 200,
        body: { status: 'done', ok: true, deployment_id: 'dep_76', env: 'production', files: 1, bytes: 11, url: 'https://p-dump.manifestx.ai' },
    },
    // A POST retried after the ingest already finished: the replay path, which
    // looks exactly like an old synchronous success (200 + ok, no `status`).
    retryAfterDone: {
        status: 200,
        body: { ok: true, deployment_id: 'dep_76', env: 'production', files: 1, bytes: 11, url: 'https://p-dump.manifestx.ai' },
    },
    error: {
        status: 200,
        body: { status: 'error', error: 'no_files', message: 'The archive contained no servable files.', http_status: 400 },
    },
    unknown: {
        status: 404,
        body: { status: 'unknown', error: 'unknown_token', message: 'Publish link expired or already used. Run manifest_publish again.' },
    },
}

const asRes = (r) => res(r.status, r.body)

describe('against the real server payloads', () => {
    it('drives a full publish from the server\'s own ack + status bodies', async () => {
        const server = fakeServer({
            upload: [asRes(SERVER.ack)],
            status: [asRes(SERVER.pending), asRes(SERVER.done)],
        })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(out.url).toBe('https://p-dump.manifestx.ai')
        expect(out.files).toBe(1)
        // The ack's own status_url is what the CLI derives independently.
        expect(statusUrlFor(UPLOAD)).toBe(SERVER.ack.body.status_url)
    })

    it('surfaces the server\'s real error payload', async () => {
        const server = fakeServer({ upload: [asRes(SERVER.ack)], status: [asRes(SERVER.error)] })
        const h = harness(server)
        await expect(uploadBundle(UPLOAD, 'ZIP', h.opts)).rejects.toThrow(/no_files/)
    })

    it('takes the replay of an already-finished publish as a synchronous success', async () => {
        const server = fakeServer({ upload: [asRes(SERVER.retryAfterDone)] })
        const h = harness(server)
        const out = await uploadBundle(UPLOAD, 'ZIP', h.opts)
        expect(out.url).toBe('https://p-dump.manifestx.ai')
        expect(server.calls.status).toBe(0)
    })

    it('reads the server\'s real 404 as an expired token, not a missing route', async () => {
        const server = fakeServer({ upload: [new Error('fetch failed')], status: [asRes(SERVER.unknown)] })
        const h = harness(server)
        await expect(uploadBundle(UPLOAD, 'ZIP', h.opts)).rejects.toThrow(/expired/)
        expect(server.calls.upload).toBe(1)
    })
})
