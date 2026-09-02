// @vitest-environment happy-dom
/**
 * Persisted `$chat` windows (PERF-PRIMITIVES-DESIGN.md §12.2, primitive 3).
 *
 * Real subscripts on real Alpine in a vm context: the shared record store
 * (`data/core/manifest.data.persist.js`) plus the chat persist/store/main
 * subscripts, over the in-memory IndexedDB double.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { createIndexedDB } from './helpers/indexeddb-double.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.join(__dirname, '../src/scripts')
const read = f => [f, readFileSync(path.join(SCRIPTS, f), 'utf8')]
const SUBSCRIPTS = [
    'data/core/manifest.data.persist.js',
    'chat/manifest.chat.persist.js',
    'chat/manifest.chat.store.js',
    'chat/manifest.chat.main.js',
].map(read)

const VERSION = '0.5.195'
const DAY = 86400000
const idb = createIndexedDB()
const DB = () => `manifest:${window.location.origin}`
const released = []
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms))
const msg = (id, i, extra = {}) => ({ id, conversationId: 'c1', author: { id: 'ana', displayName: 'Ana' }, body: { text: `msg ${id}` }, ts: 1000 + i, status: 'delivered', ...extra })
const msgs = (prefix, n) => Array.from({ length: n }, (_, i) => msg(`${prefix}${i}`, i))
const ids = (list) => list.map(m => m.id)
const record = (scope, conversation, rows, extra = {}) => ({
    key: `${scope}|chat|${conversation}`, kind: 'chat', conversation, scope, rows, savedAt: Date.now(),
    frameworkVersion: VERSION, deployment: null, locale: 'en', ...extra
})

function makeNet() {
    const net = { loads: 0, byId: {}, gate: null, handlers: {}, rows: (cid) => msgs(cid + '-m', 2), acks: [] }
    net.adapter = {
        identity: () => ({ id: 'me', displayName: 'Me' }),
        async load(cid) {
            net.loads++
            net.byId[cid] = (net.byId[cid] || 0) + 1
            if (net.gate) await net.gate
            return { messages: net.rows(cid).map(m => ({ ...m, body: { ...m.body } })), participants: [], atStart: true, atEnd: true }
        },
        subscribe(cid, handlers) { net.handlers[cid] = handlers; return () => { delete net.handlers[cid] } },
        send(cid, draft) {
            return new Promise((resolve, reject) => { net.acks.push({ cid, draft, resolve, reject }) })
        },
    }
    net.gateOpen = () => { let open; net.gate = new Promise(r => { open = r }); return () => { net.gate = null; open() } }
    return net
}

async function load(opts = {}) {
    window.Alpine = Alpine
    for (const name of ['ManifestDataPersist', 'ManifestChatPersist']) {
        const prev = window[name]
        if (!prev) continue
        if (prev.state.pending) prev.state.pending.clear()
        if (prev.state.writeTimer) clearTimeout(prev.state.writeTimer)
        if (prev.state.timer) clearTimeout(prev.state.timer)
        prev.state.enabled = false; prev.state.scopeExpr = null; prev.state.config = null
        if (prev.state.handles) prev.state.handles.clear()
        delete window[name]
    }
    for (const name of ['ManifestChatStore', 'ManifestChatAdapters', 'ensureManifestChatInitialized', 'ManifestData']) delete window[name]
    Alpine.store('auth', { currentTeam: opts.team ? { $id: opts.team } : null })
    const manifest = {
        data: {},
        persistence: opts.scope === false ? undefined : { scope: '$auth.currentTeam?.$id' },
        chat: opts.persist === undefined ? { appwriteTableId: 'x' } : { persist: opts.persist },
    }
    window.ManifestDataConfig = { ensureManifest: async () => manifest }
    window.ManifestChatAdapters = { resolve: (ref) => ref, register() { }, sim: null }

    const ctx = {
        window, document, Alpine, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance,
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location,
        indexedDB: opts.noIndexedDB ? undefined : idb.indexedDB,
        MANIFEST_BUILD_VERSION: VERSION,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    const dp = window.ManifestDataPersist
    const cp = window.ManifestChatPersist
    dp.configure(manifest)
    await settle(5)
    window.ensureManifestChatInitialized()
    const chat = Alpine.evaluate(document.body, '$chat')
    const net = makeNet()
    const open = (cid, adapter = net.adapter) => chat.open(cid, { adapter })
    const effect = (fn) => { const e = Alpine.effect(fn); released.push(e); return e }
    const dispatch = (type) => window.dispatchEvent(new window.CustomEvent(type))
    return { dp, cp, chat, net, open, effect, dispatch, auth: () => Alpine.store('auth'), records: () => idb.records(DB()), keys: () => idb.records(DB()).map(r => r.key).sort() }
}

beforeEach(() => { idb.reset() })
afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = '' })

describe('off by default', () => {
    it('no chat.persist → never touches IndexedDB, handles behave as before', async () => {
        const { open, cp, chat, net } = await load()
        const h = open('c1')
        await settle()
        expect(ids(h.messages)).toEqual(['c1-m0', 'c1-m1'])
        expect(h.stale).toBe(false)
        expect(chat.stale).toBe(false)
        await cp.flushPending()
        await settle(600)
        expect(idb.opens).toBe(0)
        expect(chat.persistence()).toEqual({ enabled: false, conversations: [] })
        expect(net.loads).toBe(1)
    })
})

describe('snapshot (write path)', () => {
    it('after landing: last `messages` only, strip + always-on secret patterns applied, internals dropped', async () => {
        const { open, cp, records, net } = await load({ persist: { messages: 3, strip: ['meta.raw', 'internal*'] } })
        net.rows = () => msgs('m', 5).map((m, i) => ({ ...m, apiToken: 't', clientSecret: 's', internalNote: 'n', keep: i, meta: { externalId: `e${i}`, raw: { wire: true }, channel: 'wa' } }))
        const h = open('c1')
        await settle()
        expect(h.messages.length).toBe(5)
        await cp.flushPending()
        const rec = records().find(r => r.key === '|chat|c1')
        expect(rec).toMatchObject({ kind: 'chat', conversation: 'c1', scope: '', frameworkVersion: VERSION })
        expect(typeof rec.savedAt).toBe('number')
        expect(ids(rec.rows)).toEqual(['m2', 'm3', 'm4'])
        expect(Object.keys(rec.rows[0]).sort()).toEqual(['author', 'body', 'conversationId', 'id', 'keep', 'meta', 'status', 'ts'])
        expect(rec.rows[0].meta).toEqual({ externalId: 'e2', channel: 'wa' })
        const index = records().find(r => r.key === '|chat')
        expect(index).toMatchObject({ kind: 'chat-index', recent: ['c1'], scope: '' })
    })

    it('writes are debounced 500ms after the last change of that conversation', async () => {
        const { open, records } = await load({ persist: true })
        open('c1')
        await settle(300)
        expect(records()).toEqual([])
        await settle(400)
        expect(records().map(r => r.key).sort()).toEqual(['|chat', '|chat|c1'])
    })

    it('a realtime append and an optimistic ack re-snapshot; an un-acked row is never written', async () => {
        const { open, cp, records, net } = await load({ persist: true })
        const h = open('c1')
        await settle()
        await cp.flushPending()
        net.handlers.c1.onMessage(msg('rt1', 9))
        await cp.flushPending()
        expect(ids(records().find(r => r.key === '|chat|c1').rows)).toEqual(['c1-m0', 'c1-m1', 'rt1'])
        const sending = h.send({ text: 'hello' })
        await settle(5)
        await cp.flushPending()
        expect(ids(records().find(r => r.key === '|chat|c1').rows)).toEqual(['c1-m0', 'c1-m1', 'rt1'])
        net.acks[0].resolve({ id: 'srv1', ts: 2000, conversationId: 'c1' })
        await sending
        await cp.flushPending()
        const rows = records().find(r => r.key === '|chat|c1').rows
        expect(ids(rows)).toEqual(['c1-m0', 'c1-m1', 'rt1', 'srv1'])
        expect(rows[3]._optimistic).toBeUndefined()
        expect(rows[3]._clientId).toBeUndefined()
    })

    it('an empty window writes nothing and takes no index slot', async () => {
        const { open, cp, records, net } = await load({ persist: true })
        net.rows = () => []
        open('c1')
        await settle()
        await cp.flushPending()
        expect(records().map(r => r.key)).toEqual([])
        expect(cp.persistence().conversations.find(c => c.id === 'c1').savedAt).toBe(null)
    })

    it('an ephemeral conversation (no messages ever) never displaces a saved one', async () => {
        const { open, cp, keys, net } = await load({ persist: { conversations: 1 } })
        open('c1'); await settle()
        await cp.flushPending()
        net.rows = () => []
        open('copilot-_new:0-1'); await settle()
        await cp.flushPending()
        expect(keys()).toEqual(['|chat', '|chat|c1'])
    })

    it('open(id, { persistWindow: false }) neither hydrates nor writes', async () => {
        idb.seed(DB(), record('', 'c1', [msg('m1', 1)]))
        const { chat, cp, keys, net } = await load({ persist: true })
        const release = net.gateOpen()
        const h = chat.open('c1', { adapter: net.adapter, persistWindow: false })
        await settle()
        expect(h.messages.length).toBe(0)
        expect(h.stale).toBe(false)
        release(); await settle()
        await cp.flushPending()
        expect(keys()).toEqual(['|chat|c1'])   // the seeded record is untouched; no index, no new write
    })
})

describe('index', () => {
    it('most recently opened first, capped at `conversations`; eviction deletes the oldest records', async () => {
        const { open, cp, records, keys } = await load({ persist: { conversations: 2 } })
        open('c1'); await settle()
        open('c2'); await settle()
        await cp.flushPending()
        expect(keys()).toEqual(['|chat', '|chat|c1', '|chat|c2'])
        expect(records().find(r => r.key === '|chat').recent).toEqual(['c2', 'c1'])
        open('c3'); await settle()
        await cp.flushPending()
        expect(keys()).toEqual(['|chat', '|chat|c2', '|chat|c3'])
        expect(records().find(r => r.key === '|chat').recent).toEqual(['c3', 'c2'])
        open('c2'); await settle()
        await cp.flushPending()
        expect(records().find(r => r.key === '|chat').recent).toEqual(['c2', 'c3'])
    })

    it('an evicted conversation that is still open re-enters the index on its next message (activity is recency)', async () => {
        const { open, cp, keys, net } = await load({ persist: { conversations: 1 } })
        open('c1'); await settle()
        open('c2'); await settle()
        await cp.flushPending()
        expect(keys()).toEqual(['|chat', '|chat|c2'])
        net.handlers.c1.onMessage(msg('late', 9))
        await cp.flushPending()
        expect(keys()).toEqual(['|chat', '|chat|c1'])
    })

    it('a second handle for the same conversation hydrates synchronously from the window already in memory (handle swap)', async () => {
        idb.seed(DB(), record('', 'c1', [msg('m1', 1), msg('m2', 2)]))
        const { chat, net } = await load({ persist: true })
        const release = net.gateOpen()
        const a = chat.open('c1', { adapter: net.adapter })
        await settle()
        expect(ids(a.messages)).toEqual(['m1', 'm2'])
        // Instant adapter: without the in-memory window this handle would lose the race to IndexedDB
        const instant = { ...net.adapter, async load() { return { messages: [msg('m2', 2), msg('m3', 3)], participants: [], atStart: true, atEnd: true } } }
        const b = chat.open('c1', { adapter: instant })
        expect(ids(b.messages)).toEqual(['m1', 'm2'])
        expect(b.stale).toBe(true)
        await settle()
        expect(ids(b.messages)).toEqual(['m2', 'm3'])
        expect(b.stale).toBe(false)
        release()
    })
})

describe('open → hydrate → reconcile', () => {
    it('hydrates stale before the adapter, then reconciles by id + meta.externalId', async () => {
        idb.seed(DB(), record('', 'c1', [
            msg('m1', 1, { local: 'kept' }),
            msg('m2', 2, { meta: { externalId: 'e2' } }),
            msg('m3', 3),
        ]))
        idb.seed(DB(), { key: '|chat', kind: 'chat-index', scope: '', recent: ['c1'], savedAt: Date.now(), frameworkVersion: VERSION })
        const { open, chat, net, effect, cp } = await load({ persist: true })
        const release = net.gateOpen()
        const h = open('c1')
        const seen = []
        effect(() => { seen.push({ stale: h.stale, n: h.messages.length }) })
        await settle()
        expect(ids(h.messages)).toEqual(['m1', 'm2', 'm3'])
        expect(h.stale).toBe(true)
        expect(chat.stale).toBe(true)
        expect(h.status).toBe('loading')
        expect(h.participants.map(p => p.id)).toEqual(['me', 'ana'])
        expect(net.loads).toBe(1)
        expect(cp.persistence().conversations).toEqual([{ id: 'c1', messages: 3, savedAt: expect.any(Number), stale: true }])

        net.rows = () => [
            msg('m1', 1, { body: { text: 'fresh m1' } }),
            msg('m2-server', 2, { meta: { externalId: 'e2', channel: 'wa' } }),
            msg('m4', 4),
        ]
        release()
        await settle()
        expect(ids(h.messages)).toEqual(['m1', 'm2-server', 'm4'])
        expect(h.messages[0]).toMatchObject({ local: 'kept', body: { text: 'fresh m1' } }) // identity kept: merged, not replaced
        expect(h.messages[1].meta).toEqual({ externalId: 'e2', channel: 'wa' })
        expect(h.messages.some(m => '_hydrated' in m)).toBe(false)
        expect(h.stale).toBe(false)
        expect(chat.stale).toBe(false)
        expect(h.status).toBe('ready')
        const firstStale = seen.findIndex(s => s.stale)
        const firstFresh = seen.findIndex((s, i) => i > firstStale && !s.stale)
        expect(seen[firstStale]).toEqual({ stale: true, n: 3 })
        expect(seen.slice(firstStale, firstFresh).every(s => s.stale && s.n === 3)).toBe(true) // stale until the fresh landing, no flicker
        expect(seen.slice(firstFresh).every(s => !s.stale && s.n === 3)).toBe(true)
        expect(net.loads).toBe(1)
        await cp.flushPending()
        expect(ids(idb.records(DB()).find(r => r.key === '|chat|c1').rows)).toEqual(['m1', 'm2-server', 'm4'])
    })

    it('an externalId match re-keys a live row too (one entry, no duplicate)', async () => {
        const { open, net } = await load({ persist: true })
        net.rows = () => [msg('m1', 1, { meta: { externalId: 'wa-1' } })]
        const h = open('c1')
        await settle()
        net.handlers.c1.onMessage(msg('m1-canonical', 1, { meta: { externalId: 'wa-1' }, status: 'read' }))
        expect(ids(h.messages)).toEqual(['m1-canonical'])
        expect(h.messages[0].status).toBe('read')
    })

    it('externalId is scoped by channel: the same platform id on two channels stays two messages', async () => {
        const { open, net } = await load({ persist: true })
        net.rows = () => [msg('m1', 1, { meta: { externalId: '1001', channel: 'tg-bot-a' } })]
        const h = open('c1')
        await settle()
        net.handlers.c1.onMessage(msg('m2', 2, { meta: { externalId: '1001', channel: 'tg-bot-b' } }))
        expect(ids(h.messages)).toEqual(['m1', 'm2'])
        net.handlers.c1.onMessage(msg('m1-canonical', 1, { meta: { externalId: '1001', channel: 'tg-bot-a' }, status: 'read' }))
        expect(ids(h.messages)).toEqual(['m1-canonical', 'm2'])
        net.handlers.c1.onMessage(msg('m1-late', 3, { meta: { externalId: '1001' } }))   // channel-less never matches a channel row
        expect(ids(h.messages)).toEqual(['m1-canonical', 'm2', 'm1-late'])
    })

    it('a re-delivery of the same message merges meta instead of replacing it (translation fields survive an untranslated echo)', async () => {
        const { open, net } = await load({ persist: true })
        net.rows = () => [msg('m1', 1, { meta: { externalId: 'w1', channel: 'wa', tx: { lang: 'cs', text: 'Ahoj' } } })]
        const h = open('c1')
        await settle()
        const before = h.messages[0].meta
        net.handlers.c1.onMessage(msg('m1', 1, { meta: { externalId: 'w1', channel: 'wa' }, status: 'read' }))
        expect(h.messages[0].status).toBe('read')
        expect(h.messages[0].meta.tx).toEqual({ lang: 'cs', text: 'Ahoj' })
        expect(h.messages[0].meta).toBe(before)   // same meta object across commits
    })

    it('a send while stale survives the reconcile', async () => {
        idb.seed(DB(), record('', 'c1', [msg('m1', 1)]))
        const { open, net } = await load({ persist: true })
        const release = net.gateOpen()
        const h = open('c1')
        await settle()
        expect(h.stale).toBe(true)
        const sending = h.send({ text: 'while stale' })
        await settle(5)
        net.rows = () => [msg('m1', 1)]
        release()
        await settle()
        expect(h.stale).toBe(false)
        expect(h.messages.length).toBe(2)
        expect(h.messages[1].status).toBe('pending')
        net.acks[0].resolve({ id: 'srv', ts: 3000, conversationId: 'c1' })
        await sending
        expect(ids(h.messages)).toEqual(['m1', 'srv'])
    })

    it('a hydration resolving after the adapter landed is discarded', async () => {
        idb.seed(DB(), record('', 'c1', [msg('old1', 1), msg('old2', 2)]))
        idb.delayMs = 40
        const { open, effect } = await load({ persist: true })
        const h = open('c1')
        const seen = []
        effect(() => { seen.push(h.stale) })
        await settle(150)
        expect(ids(h.messages)).toEqual(['c1-m0', 'c1-m1'])
        expect(seen.every(s => s === false)).toBe(true)
        expect(h.status).toBe('ready')
    })

    it('a cold open (no record) behaves exactly as today', async () => {
        const { open, net, effect } = await load({ persist: true })
        const release = net.gateOpen()
        const h = open('c1')
        const seen = []
        effect(() => { seen.push({ stale: h.stale, n: h.messages.length, status: h.status }) })
        await settle()
        expect(h.messages).toEqual([])
        expect(h.status).toBe('loading')
        release()
        await settle()
        expect(ids(h.messages)).toEqual(['c1-m0', 'c1-m1'])
        expect(seen.every(s => s.stale === false)).toBe(true)
        expect(net.loads).toBe(1)
    })

    it('a failed adapter load keeps the hydrated window, still stale', async () => {
        idb.seed(DB(), record('', 'c1', [msg('m1', 1)]))
        const { open, net } = await load({ persist: true })
        net.adapter.load = async () => { throw new Error('offline') }
        const h = open('c1')
        await settle()
        expect(ids(h.messages)).toEqual(['m1'])
        expect(h.stale).toBe(true)
        expect(h.status).toBe('error')
    })
})

describe('validity', () => {
    it('an expired record is ignored and deleted', async () => {
        idb.seed(DB(), record('', 'c1', [msg('old', 1)], { savedAt: Date.now() - 8 * DAY }))
        const { open, net, effect, records } = await load({ persist: true })
        const release = net.gateOpen()
        const h = open('c1')
        const seen = []
        effect(() => { seen.push(h.stale) })
        await settle()
        expect(h.messages).toEqual([])
        release()
        await settle()
        expect(seen.every(s => s === false)).toBe(true)
        expect(records().find(r => r.key === '|chat|c1')).toBeUndefined()
    })

    it('ttl is configurable', async () => {
        idb.seed(DB(), record('', 'c1', [msg('old', 1)], { savedAt: Date.now() - 2 * 3600000 }))
        const { open, net, cp } = await load({ persist: { ttl: '1h' } })
        expect(cp.config().ttl).toBe(3600000)
        net.gateOpen()
        const h = open('c1')
        await settle()
        expect(h.messages).toEqual([])
    })

    it('a frameworkVersion major/minor mismatch is ignored and deleted', async () => {
        idb.seed(DB(), record('', 'c1', [msg('old', 1)], { frameworkVersion: '0.4.9' }))
        const { open, net, records } = await load({ persist: true })
        net.gateOpen()
        const h = open('c1')
        await settle()
        expect(h.messages).toEqual([])
        expect(h.stale).toBe(false)
        expect(records().find(r => r.key === '|chat|c1')).toBeUndefined()
    })

    it('a record from another scope never hydrates', async () => {
        idb.seed(DB(), record('B', 'c1', [msg('foreign', 1)]))
        const { open, net } = await load({ persist: true, team: 'A' })
        net.gateOpen()
        const h = open('c1')
        await settle()
        expect(h.messages).toEqual([])
    })
})

describe('scope', () => {
    it('records are keyed by scope; a scope change drops every window and the index', async () => {
        const { open, cp, keys, auth, dispatch, chat, records } = await load({ persist: true, team: 'A' })
        const h = open('c1')
        await settle()
        await cp.flushPending()
        expect(keys()).toEqual(['A|chat', 'A|chat|c1'])
        expect(records()[0].scope).toBe('A')
        auth().currentTeam = { $id: 'B' }
        dispatch('manifest:auth:teams-loaded')
        await settle(40)
        expect(h.messages).toEqual([])
        expect(h.status).toBe('idle')
        expect(h.live).toBe(false)
        expect(h.stale).toBe(false)
        expect(keys()).toEqual([])
        expect(cp.state.recent).toBe(null)
        expect(chat.persistence().conversations).toEqual([{ id: 'c1', messages: 0, savedAt: null, stale: false }])
        const h2 = open('c2')
        await settle()
        await cp.flushPending()
        expect(ids(h2.messages)).toEqual(['c2-m0', 'c2-m1'])
        expect(keys()).toEqual(['B|chat', 'B|chat|c2'])
        expect(records().find(r => r.key === 'B|chat').recent).toEqual(['c2'])
    })

    it('logout (single tenant) wipes the records, drops windows, and cancels pending writes', async () => {
        const { open, cp, keys, dispatch } = await load({ persist: true, scope: false })
        const h = open('c1')
        await settle()
        await cp.flushPending()
        expect(keys()).toEqual(['|chat', '|chat|c1'])
        open('c2')
        await settle()
        expect(cp.state.pending.size).toBeGreaterThan(0)
        dispatch('manifest:auth:session-cleared')
        await settle(40)
        expect(h.messages).toEqual([])
        expect(cp.state.pending.size).toBe(0)
        await settle(600)
        expect(keys()).toEqual([])
    })
})

describe('store disabled', () => {
    it('no IndexedDB → every call is a no-op and opens are unaffected', async () => {
        const { open, chat, cp, net } = await load({ persist: true, noIndexedDB: true })
        const h = open('c1')
        await settle()
        expect(ids(h.messages)).toEqual(['c1-m0', 'c1-m1'])
        expect(h.stale).toBe(false)
        await cp.flushPending()
        expect(chat.persistence().enabled).toBe(false)
        expect(net.loads).toBe(1)
    })

    it('a quota error disables the store for the session; later opens still work', async () => {
        const { open, cp, chat, records } = await load({ persist: true })
        idb.failPut = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' })
        open('c1')
        await settle()
        await cp.flushPending()
        expect(records()).toEqual([])
        expect(chat.persistence().enabled).toBe(false)
        const h2 = open('c2')
        await settle()
        expect(ids(h2.messages)).toEqual(['c2-m0', 'c2-m1'])
        await cp.flushPending()
        expect(records()).toEqual([])
    })
})

describe('diagnostics', () => {
    it('$chat.persistence() lists saved conversations with counts, savedAt and staleness', async () => {
        const { open, cp, chat } = await load({ persist: true })
        open('c1'); await settle()
        open('c2'); await settle()
        await cp.flushPending()
        const diag = chat.persistence()
        expect(diag.enabled).toBe(true)
        expect(diag.conversations).toEqual([
            { id: 'c2', messages: 2, savedAt: expect.any(Number), stale: false },
            { id: 'c1', messages: 2, savedAt: expect.any(Number), stale: false },
        ])
    })
})
