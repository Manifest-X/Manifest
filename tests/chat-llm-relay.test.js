/**
 * @vitest-environment happy-dom
 *
 * claude adapter: a relay that isn't there (published hosting answers 405) shows an error naming the endpoint,
 * never a silent empty reply or a file readers don't have.
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

    it('an unreachable relay names the endpoint, not a repo file', async () => {
        localStorage.clear()
        const text = await reply(async () => { throw new TypeError('Failed to fetch') })
        expect(text).toContain('/_ai/chat')
        expect(text).not.toContain('chat-llm-proxy')
    })
})
