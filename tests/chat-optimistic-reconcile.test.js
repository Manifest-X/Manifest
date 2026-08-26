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
 *
 * Follow-up (Playcom, Aug 2026): on slow acks the appended echo also RENDERED
 * as a second bubble until the ack merged it. Every send now passes a
 * `clientId` on the draft; an own-authored echo carrying `meta.clientId`
 * claims the pending row immediately. Echoes without it (legacy adapters)
 * still dedup at ack time.
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

/** Adapter with a held-open ack, so mid-flight state is observable. */
function heldAckAdapter(serverId, { clientIdInEcho }) {
    const ids = Array.isArray(serverId) ? serverId.slice() : [serverId]
    let onMessage = null
    let resolveAck = null
    let draft = null
    let current = null
    return {
        async load() { return { messages: [], participants: [], atStart: true, atEnd: true } },
        identity() { return { id: 'me' } },
        subscribe(_conversationId, handlers) { onMessage = handlers.onMessage; return () => {} },
        send(conversationId, d) {
            draft = d
            current = ids.length > 1 ? ids.shift() : ids[0]
            const meta = clientIdInEcho ? { via: 'bus', clientId: d.clientId } : { via: 'bus' }
            onMessage({ id: current, conversationId, author: { id: 'me' }, body: d.body, ts: 1000, seq: 3, status: 'delivered', meta })
            return new Promise((r) => { resolveAck = r })
        },
        emit(msg) { onMessage(msg) },
        lastDraft() { return draft },
        ack() { resolveAck({ id: current, ts: 1000, conversationId: 'conv1', clientId: draft.clientId }) },
    }
}

async function openHandle(adapter) {
    const Store = loadStore()
    const handle = Store.createHandle(adapter, 'conv1', {})
    await new Promise((r) => setTimeout(r, 0))    // let open() seed + subscribe
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

describe('$chat clientId echo claim (echo beats a slow ack)', () => {
    const id = '01M0AT7W2QCSAED5X60Q9KR8EM'

    it('echo carrying meta.clientId claims the pending bubble immediately — one entry at all times', async () => {
        const adapter = heldAckAdapter(id, { clientIdInEcho: true })
        const handle = await openHandle(adapter)
        const sending = handle.send({ body: { text: 'hello' } })
        // echo landed, ack still pending — must already be a single settled row
        expect(handle.messages).toHaveLength(1)
        expect(handle.messages[0].id).toBe(id)
        expect(handle.messages[0]._optimistic).toBeFalsy()
        expect(handle.messages[0].status).toBe('delivered')
        adapter.ack()
        await sending
        expect(handle.messages).toHaveLength(1)
        expect(handle.messages[0].id).toBe(id)
        expect(handle.messages[0].body.text).toBe('hello')
    })

    it('the ack landing after the claim is a no-op — echo fields survive', async () => {
        const adapter = heldAckAdapter(id, { clientIdInEcho: true })
        const handle = await openHandle(adapter)
        const sending = handle.send({ body: { text: 'hello' } })
        adapter.ack()
        await sending
        const m = handle.messages[0]
        expect(m.seq).toBe(3)
        expect(m.meta.via).toBe('bus')
        expect(m.status).toBe('delivered')
        expect(m.ts).toBe(1000)
    })

    it('send passes the minted clientId to the adapter, and it round-trips', async () => {
        const adapter = heldAckAdapter(id, { clientIdInEcho: true })
        const handle = await openHandle(adapter)
        const sending = handle.send({ body: { text: 'hello' } })
        expect(adapter.lastDraft().clientId).toBeTruthy()
        expect(handle.messages[0].meta.clientId).toBe(adapter.lastDraft().clientId)
        adapter.ack()
        await sending
    })

    it('an inbound from a DIFFERENT author appends normally, even carrying a matching clientId', async () => {
        const adapter = heldAckAdapter(id, { clientIdInEcho: true })
        const handle = await openHandle(adapter)
        const sending = handle.send({ body: { text: 'hello' } })
        adapter.emit({ id: 'm_ana_1', conversationId: 'conv1', author: { id: 'u_ana' }, body: { text: 'hi from ana' }, ts: 1001, status: 'delivered', meta: { clientId: adapter.lastDraft().clientId } })
        expect(handle.messages).toHaveLength(2)
        adapter.ack()
        await sending
        expect(handle.messages).toHaveLength(2)
        expect(handle.messages.filter((m) => m.id === id)).toHaveLength(1)
        expect(handle.messages.filter((m) => m.id === 'm_ana_1')).toHaveLength(1)
    })

    it('own echo WITHOUT meta.clientId (legacy adapter) falls through to the ack-time merge', async () => {
        const adapter = heldAckAdapter(id, { clientIdInEcho: false })
        const handle = await openHandle(adapter)
        const sending = handle.send({ body: { text: 'hello' } })
        // no clientId to claim by — two rows until the ack merges (pre-existing behavior)
        expect(handle.messages).toHaveLength(2)
        adapter.ack()
        await sending
        expect(handle.messages).toHaveLength(1)
        expect(handle.messages[0].id).toBe(id)
        expect(handle.messages[0]._optimistic).toBeFalsy()
    })

    it('sequential sends each claim their own pending row', async () => {
        const adapter = heldAckAdapter(['m_a', 'm_b'], { clientIdInEcho: true })
        const handle = await openHandle(adapter)
        const first = handle.send({ body: { text: 'one' } })
        adapter.ack()
        await first
        const second = handle.send({ body: { text: 'two' } })
        // second echo claims the second pending row, not the settled first
        expect(handle.messages).toHaveLength(2)
        expect(handle.messages.every((m) => !m._optimistic)).toBe(true)
        adapter.ack()
        await second
        expect(handle.messages.map((m) => m.id).sort()).toEqual(['m_a', 'm_b'])
    })
})
