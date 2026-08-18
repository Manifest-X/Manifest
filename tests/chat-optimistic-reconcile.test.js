/**
 * Regression: a sent message must end up as ONE entry in `thread.messages`,
 * with the server echo reconciled onto the optimistic row.
 *
 * Reported by a downstream project (Playcom, Aug 2026): after a send,
 * `messages` held two entries carrying the same id — the optimistic row and
 * the echo. Only one bubble rendered (the x-for key collapsed the pair), so
 * the defect was invisible in the UI but doubled every send in the model:
 * counters, exports, "last message" logic and scroll anchoring all see two.
 *
 * The race is echo-before-ack. `send()` keys the optimistic row under a `tmp_`
 * id until the ack returns; a bus that echoes the sender's own message before
 * `adapter.send()` resolves arrives while the row is still tmp-keyed, so
 * `upsert()` finds nothing by the server id and appends.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE_SRC = readFileSync(path.join(__dirname, '../src/scripts/chat/manifest.chat.store.js'), 'utf8')

// Minimal Alpine stand-in: the store only needs `reactive` to hand back the object.
function loadStore() {
    const win = { Alpine: { reactive: (o) => o } }
    const ctx = { window: win, console, Promise, Object, Array, Map, Number, Date, JSON, setTimeout, queueMicrotask, isNaN, performance }
    ctx.globalThis = ctx
    vm.runInNewContext(STORE_SRC, ctx)
    return win.ManifestChatStore
}

/** Adapter whose bus echoes the sender's own message BEFORE the ack resolves. */
function echoBeforeAckAdapter(serverId) {
    let onMessage = null
    return {
        async load() { return { messages: [], participants: [], atStart: true, atEnd: true } },
        identity() { return { id: 'me' } },
        subscribe(_conversationId, handlers) { onMessage = handlers.onMessage; return () => {} },
        async send(conversationId, draft) {
            // Bus echo lands first — this is the ordering the report hit.
            onMessage({ id: serverId, conversationId, author: { id: 'me' }, body: draft.body, ts: 1000, seq: 3, meta: { via: 'bus' } })
            return { id: serverId, ts: 1000, conversationId }
        },
    }
}

/** Adapter whose echo is fired manually, so the test controls the ordering. */
function manualEchoAdapter(serverId) {
    let onMessage = null
    let sent = null
    return {
        async load() { return { messages: [], participants: [], atStart: true, atEnd: true } },
        identity() { return { id: 'me' } },
        subscribe(_conversationId, handlers) { onMessage = handlers.onMessage; return () => {} },
        async send(conversationId, draft) {
            sent = { conversationId, draft }
            return { id: serverId, ts: 1000, conversationId }
        },
        echo() {
            onMessage({ id: serverId, conversationId: sent.conversationId, author: { id: 'me' }, body: sent.draft.body, ts: 1000, seq: 3, meta: { via: 'bus' } })
        },
    }
}

async function sendOne(adapter, afterSend) {
    const Store = loadStore()
    const handle = Store.createHandle(adapter, 'conv1', {})
    await new Promise((r) => setTimeout(r, 0))    // let open() seed + subscribe
    await handle.send({ body: { text: 'hello' } })
    if (afterSend) afterSend()
    await new Promise((r) => setTimeout(r, 0))
    return handle
}

describe('$chat optimistic reconcile', () => {
    it('echo arriving BEFORE the ack yields one entry, not two', async () => {
        const id = '01M0AT7W2QCSAED5X60Q9KR8EK'
        const handle = await sendOne(echoBeforeAckAdapter(id))
        const mine = handle.messages.filter((m) => m.id === id)
        expect(mine).toHaveLength(1)
    })

    it('the surviving entry carries the echo fields and is no longer pending', async () => {
        const id = '01M0AT7W2QCSAED5X60Q9KR8EK'
        const handle = await sendOne(echoBeforeAckAdapter(id))
        const m = handle.messages.find((x) => x.id === id)
        expect(m.seq).toBe(3)
        expect(m.meta).toEqual({ via: 'bus' })
        expect(m.status).toBe('sent')
        expect(m._optimistic).toBeFalsy()
        expect(m.body.text).toBe('hello')
    })

    it('echo arriving AFTER the ack still yields one entry', async () => {
        const id = '01M0AT7W2QCSAED5X60Q9KR8EL'
        const adapter = manualEchoAdapter(id)
        const handle = await sendOne(adapter, () => adapter.echo())
        expect(handle.messages.filter((m) => m.id === id)).toHaveLength(1)
    })
})
