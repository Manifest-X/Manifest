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

const reply = async (fetchImpl) => {
    window.fetch = vi.fn(fetchImpl)
    const adapter = factory({})
    const parts = []
    let done
    const finished = new Promise(r => { done = r })
    adapter.subscribe('c1', { onMessage: () => {}, onMessagePart: (id, p) => { parts.push(p.text); if (p.done) done() } })
    await adapter.send('c1', { body: { text: 'hi' } })
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
})
