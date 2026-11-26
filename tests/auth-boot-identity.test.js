/**
 * Boot identity: account.get and account.listSessions go out together when this browser
 * last mirrored a signed-in state, with the same outcome as the sequential pair.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, noSession, offline } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA', email: 'a@x' }
const emailSession = { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
const guestSession = { sessions: [{ $id: 'g1', current: true, provider: 'anonymous' }] }
const signedIn = { isAuthenticated: true, isAnonymous: false, user }
const cfg = { teams: false }

const initialized = (events) => until(() => events.some(e => e.type === 'initialized'))
const outcome = (store, window) => ({
    isAuthenticated: store.isAuthenticated,
    isAnonymous: store.isAnonymous,
    user: store.user?.$id || null,
    session: store.session?.$id || null,
    unverified: store._sessionUnverified,
    mirrored: JSON.parse(window.localStorage.getItem('manifest:auth:state') || 'null')?.isAuthenticated ?? null,
})

describe('boot identity requests', () => {
    it('issues account.get and listSessions together for a persisted signed-in state', async () => {
        const { fake, events, store, window } = boot({ cfg, persisted: signedIn, responder: () => undefined })
        await until(() => fake.names().includes('account.listSessions'))
        expect(fake.names()).toEqual(['account.get', 'account.listSessions'])
        expect(fake.calls.every(c => !c.settled)).toBe(true)
        fake.settle('account.listSessions', emailSession)
        fake.settle('account.get', user)
        await initialized(events)
        expect(outcome(store, window)).toEqual({ isAuthenticated: true, isAnonymous: false, user: 'uA', session: 's1', unverified: false, mirrored: true })
    })

    it('a signed-out visitor with nothing persisted makes only the account.get it makes today', async () => {
        const { fake, events, store, window } = boot({ cfg, responder: n => (n === 'account.get' ? noSession() : undefined) })
        await initialized(events)
        await sleep(20)
        expect(fake.names()).toEqual(['account.get'])
        expect(outcome(store, window)).toEqual({ isAuthenticated: false, isAnonymous: false, user: null, session: null, unverified: false, mirrored: false })
    })

    it('persisted signed-in but the session is gone: signed out and mirrored as signed out', async () => {
        const { events, store, window } = boot({ cfg, persisted: signedIn, responder: n => (n === 'account.get' ? noSession() : n === 'account.listSessions' ? noSession() : undefined) })
        await initialized(events)
        expect(outcome(store, window)).toEqual({ isAuthenticated: false, isAnonymous: false, user: null, session: null, unverified: false, mirrored: false })
    })

    it('account.get 401 decides even when listSessions fails first with a network error', async () => {
        const { fake, events, store, window } = boot({ cfg, persisted: signedIn, responder: () => undefined })
        await until(() => fake.names().includes('account.listSessions'))
        fake.settle('account.listSessions', offline())
        await sleep(5)
        fake.settle('account.get', noSession())
        await initialized(events)
        expect(outcome(store, window)).toEqual({ isAuthenticated: false, isAnonymous: false, user: null, session: null, unverified: false, mirrored: false })
    })

    it('account.get offline, listSessions ok: unverified, nothing mirrored', async () => {
        const { events, store, window } = boot({ cfg, persisted: signedIn, responder: n => (n === 'account.get' ? offline() : n === 'account.listSessions' ? emailSession : undefined) })
        await initialized(events)
        expect(outcome(store, window)).toEqual({ isAuthenticated: false, isAnonymous: false, user: null, session: null, unverified: true, mirrored: true })
    })

    it('account.get ok, listSessions offline: unverified as today', async () => {
        const { events, store, window } = boot({ cfg, persisted: signedIn, responder: n => (n === 'account.get' ? user : n === 'account.listSessions' ? offline() : undefined) })
        await initialized(events)
        expect(outcome(store, window)).toEqual({ isAuthenticated: false, isAnonymous: false, user: null, session: null, unverified: true, mirrored: true })
    })

    it('account.get ok, listSessions 401: signed out as today', async () => {
        const { events, store, window } = boot({ cfg, persisted: signedIn, responder: n => (n === 'account.get' ? user : n === 'account.listSessions' ? noSession() : undefined) })
        await initialized(events)
        expect(outcome(store, window)).toEqual({ isAuthenticated: false, isAnonymous: false, user: null, session: null, unverified: false, mirrored: false })
    })

    it('restores a guest session', async () => {
        const guest = { ...signedIn, isAnonymous: true }
        const { events, store, window } = boot({ cfg: { ...cfg, guestManual: true }, persisted: guest, responder: n => (n === 'account.get' ? user : n === 'account.listSessions' ? guestSession : undefined) })
        await initialized(events)
        expect(outcome(store, window)).toEqual({ isAuthenticated: true, isAnonymous: true, user: 'uA', session: 'g1', unverified: false, mirrored: true })
    })

    it('deletes a guest session when guests are disabled', async () => {
        const guest = { ...signedIn, isAnonymous: true }
        const { fake, events, store, window } = boot({ cfg, persisted: guest, responder: n => (n === 'account.get' ? user : n === 'account.listSessions' ? guestSession : n === 'account.deleteSession' ? {} : undefined) })
        await initialized(events)
        expect(fake.names()).toEqual(['account.get', 'account.listSessions', 'account.deleteSession'])
        expect(fake.calls[2].args[0]).toBe('g1')
        expect(outcome(store, window)).toEqual({ isAuthenticated: false, isAnonymous: false, user: null, session: null, unverified: false, mirrored: false })
    })

    it('an identity change during the requests drops the stale restore (recheck epoch)', async () => {
        let manual = false
        const { fake, events, store } = boot({ cfg, persisted: signedIn, responder: n => (manual ? undefined : n === 'account.get' ? offline() : n === 'account.listSessions' ? emailSession : undefined) })
        await initialized(events)
        manual = true
        expect(store._sessionUnverified).toBe(true)
        const before = fake.calls.length
        const recheck = store._recheckSession()
        await until(() => fake.calls.length >= before + 2)
        store._authEpoch++ // a sign-in elsewhere lands mid-recheck
        fake.settle('account.get', user)
        fake.settle('account.listSessions', emailSession)
        await recheck
        expect(store.isAuthenticated).toBe(false)
        expect(store.user).toBe(null)
    })
})
