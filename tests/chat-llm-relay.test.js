/**
 * @vitest-environment happy-dom
 *
 * claude adapter: relay failures show the relay's JSON `message` when given, else a note
 * naming the endpoint and status, never a silent empty reply.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
let factory
beforeAll(() => {
    window.ManifestChatAdapters = { register: (name, f) => { factory = f } }
    new Function(readFileSync(path.join(dir, '../src/scripts/chat/manifest.chat.adapters.llm.js'), 'utf8'))()
})

const reply = async (fetchImpl, draft = { body: { text: 'hi' } }) => {
    window.fetch = vi.fn(fetchImpl)
    const adapter = factory({})
    const parts = []
    let done
    const finished = new Promise(r => { done = r })
    adapter.subscribe('c1', { onMessage: () => {}, onMessagePart: (id, p) => { parts.push(p.text); if (p.done) done() } })
    await adapter.send('c1', draft)
    await finished
    return parts.join('')
}

describe('claude adapter relay errors', () => {
    it('reports a non-OK relay response with its endpoint and status', async () => {
        localStorage.clear()
        const text = await reply(async () => new Response('Method Not Allowed', { status: 405 }))
        expect(text).toContain('/_ai/chat')
        expect(text).toContain('405')
    })

    it('an unreachable relay names the endpoint', async () => {
        localStorage.clear()
        const text = await reply(async () => { throw new TypeError('Failed to fetch') })
        expect(text).toContain('/_ai/chat')
    })

    it('shows the message from an SSE error body', async () => {
        localStorage.clear()
        const frame = 'event: error\ndata: ' + JSON.stringify({ type: 'error', error: { message: 'AI provider error 400: bad image' } }) + '\n\n'
        const text = await reply(async () => new Response(frame, { status: 400, headers: { 'content-type': 'text/event-stream' } }))
        expect(text).toContain('AI provider error 400: bad image')
    })

    it('falls back to `error` when a JSON body has no message', async () => {
        localStorage.clear()
        const text = await reply(async () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }))
        expect(text).toContain('rate_limited')
    })

    it('shows the message from a JSON error body', async () => {
        localStorage.clear()
        const message = 'AI chat needs an Anthropic API key: ask your agent to set it up with the Manifest connector.'
        const text = await reply(async () => new Response(JSON.stringify({ error: 'ai_not_configured', message }), { status: 503, headers: { 'content-type': 'application/json' } }))
        expect(text).toContain(message)
        expect(text).not.toContain('/_ai/chat')
    })
})

describe('claude adapter history', () => {
    it('sends at most 100 messages, starting on a user turn, without repeating the new one', async () => {
        localStorage.clear()
        const stored = Array.from({ length: 150 }, (_, i) => ({ id: 'r' + i, role: i % 2 ? 'assistant' : 'user', text: 'm' + i, ts: i }))
        localStorage.setItem('mnfst.chat.c1', JSON.stringify(stored))
        let body
        await reply(async (_url, init) => { body = JSON.parse(init.body); return new Response('', { status: 200 }) })
        const msgs = body.messages
        expect(msgs.length).toBeLessThanOrEqual(100)
        expect(msgs[0].role).toBe('user')
        expect(msgs.at(-1)).toEqual({ role: 'user', content: 'hi' })
        expect(msgs.at(-2).content).toBe('m149')
    })

    it('an attachment with no text sends no empty text block, and blank stored turns are skipped', async () => {
        localStorage.clear()
        localStorage.setItem('mnfst.chat.c1', JSON.stringify([
            { id: 'a', role: 'user', text: '', ts: 1 },
            { id: 'b', role: 'user', text: 'q', ts: 2 },
            { id: 'c', role: 'assistant', text: 'a', ts: 3 }
        ]))
        let body
        await reply(async (_url, init) => { body = JSON.parse(init.body); return new Response('', { status: 200 }) },
            { body: { text: '', media: [{ kind: 'image', mediaType: 'image/png', data: 'AAA' }] } })
        expect(body.messages).toEqual([
            { role: 'user', content: 'q' },
            { role: 'assistant', content: 'a' },
            { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }
        ])
    })
})

describe('claude adapter error notes', () => {
    const sse = (...evts) => evts.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('')
    const lastCall = () => JSON.parse(window.fetch.mock.calls.at(-1)[1].body).messages

    it('a failed reply shows its note but is not sent back to the model', async () => {
        localStorage.clear()
        const text = await reply(async () => new Response(JSON.stringify({ error: 'rate_limited', message: 'The AI provider is busy right now.' }), { status: 429 }))
        expect(text).toContain('busy')
        const stored = JSON.parse(localStorage.getItem('mnfst.chat.c1'))
        expect(stored.at(-1)).toMatchObject({ role: 'assistant', error: true })
        await reply(async () => new Response('', { status: 200 }), { body: { text: 'again' } })
        expect(lastCall()).toEqual([{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }])
    })

    it('partial text before an error is kept without the note', async () => {
        localStorage.clear()
        const body = sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial' } }, { type: 'error', error: { message: 'overloaded' } })
        const text = await reply(async () => new Response(body, { status: 200 }))
        expect(text).toContain('Partial')
        expect(text).toContain('error')
        const stored = JSON.parse(localStorage.getItem('mnfst.chat.c1'))
        expect(stored.at(-1)).toMatchObject({ role: 'assistant', text: 'Partial' })
        expect(stored.at(-1).error).toBeUndefined()
    })
})
