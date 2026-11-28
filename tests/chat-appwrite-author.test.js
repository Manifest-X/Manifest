/**
 * @vitest-environment happy-dom
 *
 * appwrite chat adapter: row author fields are untrusted. Colour is derived from
 * authorId (never read from the row) and no email is ever used as an author name.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const HOSTILE = 'red;position:fixed;inset:0;background:url(https://x)'
let factory, rows, written, rt
const derived = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 60% 45%)` }

beforeAll(() => {
    window.ManifestChatAdapters = { register: (name, f) => { factory = f } }
    window.Appwrite = { Query: { equal: () => 0, orderDesc: () => 0, limit: () => 0, greaterThan: () => 0 } }
    window.ManifestDataAppwrite = {
        getAppwriteDataServices: async () => ({
            tablesDB: { listRows: async () => ({ rows }) },
            realtime: { subscribe: (ch, cb) => { rt = cb; return () => {} } }
        }),
        createRow: async (db, t, data) => { written = data; return { $id: 'r1', $createdAt: 'now' } }
    }
    new Function(readFileSync(path.join(dir, '../src/scripts/chat/manifest.chat.adapters.appwrite.js'), 'utf8'))()
})

const setUser = (user) => { window.Alpine = { store: () => ({ user, isAuthenticated: !!user }) } }
const adapter = () => factory({ databaseId: 'db', tableId: 't' })
const row = (o) => ({ $id: 'm1', $createdAt: '2026-01-01', conversationId: 'c1', text: 'hi', ...o })

beforeEach(() => { rows = []; written = null; setUser(null) })

describe('appwrite chat adapter author fields', () => {
    it('ignores a hostile authorColor on load and derives it from authorId', async () => {
        rows = [row({ authorId: 'u_evil', authorName: 'Eve', authorColor: HOSTILE })]
        const { messages } = await adapter().load('c1')
        expect(messages[0].author.color).toBe(derived('u_evil'))
        expect(messages[0].author.color).not.toContain('position')
    })

    it('ignores a hostile authorColor on realtime create', async () => {
        const got = []
        adapter().subscribe('c1', { onMessage: (m) => got.push(m) })
        await new Promise(r => setTimeout(r, 0))
        rt({ events: ['databases.db.tables.t.rows.m1.create'], payload: row({ authorId: 'u_evil', authorName: 'Eve', authorColor: HOSTILE }) })
        expect(got[0].author.color).toBe(derived('u_evil'))
    })

    it('never writes the account email as the author name', async () => {
        setUser({ $id: 'u1', name: '', email: 'alice@example.com' })
        const a = adapter()
        expect(a.identity().displayName).toBe('Guest')
        await a.send('c1', { body: { text: 'hi' } })
        expect(written.authorName).toBe('Guest')
        expect(JSON.stringify(written)).not.toContain('alice@example.com')
        expect(written.authorColor).toBe(derived('u1'))
    })

    it('never shows an email-shaped author name from a row', async () => {
        rows = [row({ authorId: 'u2', authorName: 'bob@example.com', authorColor: 'blue' })]
        const { messages } = await adapter().load('c1')
        expect(messages[0].author.displayName).toBe('Guest')
    })

    it('keeps a real display name', async () => {
        setUser({ $id: 'u1', name: 'Alice', email: 'alice@example.com' })
        expect(adapter().identity().displayName).toBe('Alice')
        rows = [row({ authorId: 'u1', authorName: 'Alice' })]
        const { messages } = await adapter().load('c1')
        expect(messages[0].author.displayName).toBe('Alice')
    })

    it('coerces non-string author fields to safe values', async () => {
        rows = [row({ authorId: 42, authorName: { toString: () => 'x' } })]
        const { messages } = await adapter().load('c1')
        expect(messages[0].author.id).toBe('42')
        expect(messages[0].author.displayName).toBe('Guest')
    })
    it('does not throw on an object author id', async () => {
        rows = [row({ authorId: JSON.parse('{"toString":"x"}'), authorName: 'A' })]
        const { messages } = await adapter().load('c1')
        expect(messages[0].author.id).toBe('')
    })

    it('caps names without splitting a surrogate pair', async () => {
        rows = [row({ authorId: 'u3', authorName: 'A'.repeat(79) + '\u{1F600}x' })]
        const { messages } = await adapter().load('c1')
        expect(messages[0].author.displayName).toBe('A'.repeat(79) + '\u{1F600}')
    })
})
