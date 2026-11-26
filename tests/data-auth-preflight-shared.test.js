/**
 * The data module's auth pre-flight reuses the auth store's confirmed session instead of a second
 * account.get, and still checks when the store is absent, not initialised, unverified or signed out.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, noSession, offline } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA' }
const cfg = { teams: false }
const NOT_AUTHENTICATED = '[Manifest Data] User not authenticated. Please sign in to Appwrite first.'

function page({ signedIn = true, persisted = signedIn ? { isAuthenticated: true, isAnonymous: false, user } : null, account } = {}) {
    const state = { signedIn, account }
    const p = boot({
        cfg, persisted, data: true,
        responder: name => {
            if (name === 'account.get') return state.account ? state.account() : state.signedIn ? user : noSession()
            if (name === 'account.listSessions') return state.signedIn ? { sessions: [{ $id: 's1', current: true, provider: 'email' }] } : noSession()
            if (name === 'account.deleteSession') { state.signedIn = false; return {} }
            if (name === 'tables.listRows') return { rows: [{ $id: 'r1' }], total: 1 }
        },
    })
    return { ...p, state, gets: () => p.fake.names().filter(n => n === 'account.get').length, read: () => p.window.ManifestDataAppwrite.loadTableRows('db', 'items') }
}
const initialized = p => until(() => p.events.some(e => e.type === 'initialized'))

describe('data pre-flight after auth init', () => {
    it('signed-in boot: one account.get in total', async () => {
        const p = page()
        await initialized(p)
        expect((await p.read())[0].$id).toBe('r1')
        expect(p.gets()).toBe(1)
    })

    it('a guest session counts as confirmed too', async () => {
        const p = page({ persisted: { isAuthenticated: true, isAnonymous: true, user } })
        p.state.account = () => user
        await initialized(p)
        await p.read()
        expect(p.gets()).toBe(1)
    })

    it('signed out: still checks and throws the same error', async () => {
        const p = page({ signedIn: false })
        await initialized(p)
        await expect(p.read()).rejects.toThrow(NOT_AUTHENTICATED)
        expect(p.gets()).toBe(2)
    })

    it('unverified (offline at boot): still checks', async () => {
        const p = page({ account: () => offline() })
        await initialized(p)
        expect(p.store._sessionUnverified).toBe(true)
        p.state.account = () => user
        await p.read()
        expect(p.gets()).toBe(2)
    })

    it('before init is announced: still checks', async () => {
        const p = page({ account: () => undefined }) // every account.get waits for the test
        await until(() => p.fake.names().includes('account.get'))
        const read = p.read()
        await until(() => p.gets() === 2) // the pre-flight's own check went out while init was pending
        expect(p.store._initAnnounced).toBe(false)
        p.fake.calls.filter(c => c.name === 'account.get').forEach(c => c.resolve(user))
        await initialized(p)
        await read
        expect(p.gets()).toBe(2)
    })

    it('logout then read: checks and throws', async () => {
        const p = page()
        await initialized(p)
        await p.read()
        await p.store.logout()
        await expect(p.read()).rejects.toThrow(NOT_AUTHENTICATED)
        expect(p.gets()).toBe(2)
    })

    it('login then read: no extra account.get from the data module', async () => {
        const p = page({ signedIn: false })
        await initialized(p)
        // what a sign-in flow leaves behind before it announces
        p.state.signedIn = true
        Object.assign(p.store, { isAuthenticated: true, isAnonymous: false, user, session: { $id: 's1' } })
        p.window.dispatchEvent(new p.window.CustomEvent('manifest:auth:login', { detail: { user } }))
        const before = p.gets()
        await p.read()
        expect(p.gets()).toBe(before)
    })
})
