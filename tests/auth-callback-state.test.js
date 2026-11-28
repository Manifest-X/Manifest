/**
 * A failed magic-link callback must not rewrite an identity whose session it did not end:
 * a signed-in user stays signed in (store and mirror), and with guestUpgrade a "session
 * exists" answer only clears isAnonymous once the current session is confirmed non-anonymous.
 * The success paths and a replaced guest's failure are unchanged. OTP is checked for the same.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const real = { $id: 'victim', email: 'v@x.test' }
const guest = { $id: 'guestV' }
const signedIn = { isAuthenticated: true, isAnonymous: false, user: real }
const asGuest = { isAuthenticated: true, isAnonymous: true, user: guest }
const prohibited = () => { const e = new Error('Creation of a session is prohibited when a session is active.'); e.code = 401; e.type = 'user_session_already_exists'; return e }
const invalid = () => { const e = new Error('Invalid token passed in the request.'); e.code = 401; e.type = 'user_invalid_token'; return e }

function start({ cfg, persisted, search = '?userId=u1&secret=s1', account = {} }) {
    const p = boot({
        cfg: { teams: false, magic: true, ...cfg }, persisted, search,
        // The link was requested in this browser
        local: { 'manifest:magic-link:requested': JSON.stringify([{ u: 'u1', t: Date.now() }, { u: 'guestV', t: Date.now() }]) },
        responder: (name, arg) => {
            if (account[name]) return account[name](arg)
            if (name === 'account.listSessions') return { sessions: [{ $id: 'sV', current: true, provider: 'email' }] }
            return {}
        },
    })
    const urls = []
    p.window.history.replaceState = (state, title, url) => urls.push(url)
    return { ...p, urls }
}
const mirror = p => JSON.parse(p.window.localStorage.getItem('manifest:auth:state'))
const done = async p => { await until(() => p.fake.calls.some(c => c.name === 'account.createSession') && !p.store.inProgress); await sleep(30) }

describe('signed-in (non-guest) visitor opens a magic link that fails', () => {
    it('stays signed in, in the store and the mirror; error surfaced; URL cleaned', async () => {
        const p = start({ persisted: signedIn, account: { 'account.get': () => real, 'account.createSession': prohibited } })
        await done(p)
        expect(p.store.isAuthenticated).toBe(true)
        expect(p.store.isAnonymous).toBe(false)
        expect(p.store.user.$id).toBe('victim')
        expect(mirror(p).isAuthenticated).toBe(true)
        expect(mirror(p).user.$id).toBe('victim')
        expect(p.store.error).toMatch(/prohibited/)
        expect(p.fake.calls.filter(c => c.name === 'account.deleteSession')).toEqual([])
        expect(p.urls).toEqual(['https://app.test/'])
    })

    it('an invalid token also leaves the identity alone', async () => {
        const p = start({ persisted: signedIn, account: { 'account.get': () => real, 'account.createSession': invalid } })
        await done(p)
        expect(p.store.isAuthenticated).toBe(true)
        expect(mirror(p).isAuthenticated).toBe(true)
        expect(p.store.magicLinkExpired).toBe(true)
    })
})

describe('guestUpgrade: Appwrite answers that a session already exists', () => {
    const cfg = { guestAuto: true, guestUpgrade: true }
    // An upgrade link is made for the guest's own id
    const ownLink = '?userId=guestV&secret=s1'

    it('the current session is still anonymous: guest state kept, error surfaced, no login', async () => {
        const p = start({
            cfg, persisted: asGuest, search: ownLink,
            account: {
                'account.get': () => guest,
                'account.listSessions': () => ({ sessions: [{ $id: 'sG', current: true, provider: 'anonymous' }] }),
                'account.createSession': prohibited,
                'account.getSession': () => ({ $id: 'sG', provider: 'anonymous' }),
            },
        })
        await done(p)
        expect(p.store.isAuthenticated).toBe(true)
        expect(p.store.isAnonymous).toBe(true)
        expect(p.store.user.$id).toBe('guestV')
        expect(mirror(p).isAnonymous).toBe(true)
        expect(p.store.error).toMatch(/prohibited/)
        expect(p.events.some(e => e.type === 'login')).toBe(false)
        expect(p.urls).toEqual(['https://app.test/'])
    })

    it('an invalid token keeps the guest (its session was never ended)', async () => {
        const p = start({
            cfg, persisted: asGuest, search: ownLink,
            account: {
                'account.get': () => guest,
                'account.listSessions': () => ({ sessions: [{ $id: 'sG', current: true, provider: 'anonymous' }] }),
                'account.createSession': invalid,
            },
        })
        await done(p)
        expect(p.store.isAuthenticated).toBe(true)
        expect(p.store.isAnonymous).toBe(true)
        expect(p.store.magicLinkExpired).toBe(true)
        expect(p.fake.calls.filter(c => c.name === 'account.deleteSession')).toEqual([])
    })

    it('the current session is no longer anonymous: treated as upgraded, as before', async () => {
        const upgraded = { $id: 'guestV', email: 'g@x.test' }
        const p = start({
            cfg, persisted: asGuest, search: ownLink,
            account: {
                'account.get': () => upgraded,
                'account.listSessions': () => ({ sessions: [{ $id: 'sG', current: true, provider: 'anonymous' }] }),
                'account.createSession': prohibited,
                'account.getSession': () => ({ $id: 'sM', provider: 'magic-url' }),
            },
        })
        await until(() => p.events.some(e => e.type === 'login'))
        expect(p.store.isAuthenticated).toBe(true)
        expect(p.store.isAnonymous).toBe(false)
        expect(p.store.session.$id).toBe('sM')
    })

    it('a successful createSession upgrades the guest with no extra request', async () => {
        const upgraded = { $id: 'guestV', email: 'g@x.test' }
        let who = guest
        const p = start({
            cfg, persisted: asGuest, search: ownLink,
            account: {
                'account.get': () => who,
                'account.listSessions': () => ({ sessions: [{ $id: 'sG', current: true, provider: 'anonymous' }] }),
                'account.createSession': () => { who = upgraded; return { $id: 'sM', provider: 'magic-url' } },
            },
        })
        await until(() => p.events.some(e => e.type === 'login'))
        expect(p.store.isAnonymous).toBe(false)
        expect(p.fake.calls.filter(c => c.name === 'account.getSession')).toEqual([])
    })
})

describe('unchanged paths', () => {
    it('signed-out visitor: a valid link signs them in', async () => {
        let who = null
        const p = start({
            persisted: null,
            account: {
                'account.get': () => who || Object.assign(new Error('missing scope'), { code: 401, type: 'general_unauthorized_scope' }),
                'account.listSessions': () => who ? { sessions: [{ $id: 'sM', current: true, provider: 'magic-url' }] } : Object.assign(new Error('missing scope'), { code: 401 }),
                'account.createSession': () => { who = real; return { $id: 'sM', provider: 'magic-url' } },
            },
        })
        await until(() => p.events.some(e => e.type === 'login'))
        expect(p.store.isAuthenticated).toBe(true)
        expect(p.store.isAnonymous).toBe(false)
        expect(mirror(p).isAuthenticated).toBe(true)
    })

    it('a guest replaced by the link (no guestUpgrade): its session is ended first, a failure leaves it signed out', async () => {
        const p = start({
            cfg: { guestAuto: true }, persisted: asGuest,
            account: {
                'account.get': () => guest,
                'account.listSessions': () => ({ sessions: [{ $id: 'sG', current: true, provider: 'anonymous' }] }),
                'account.deleteSession': () => ({}),
                'account.createSession': invalid,
                'account.createAnonymousSession': () => undefined,
            },
        })
        await done(p)
        expect(p.fake.calls.filter(c => c.name === 'account.deleteSession').length).toBe(1)
        expect(p.store.isAuthenticated).toBe(false)
        expect(p.store.isAnonymous).toBe(false)
    })
})

describe('OTP verify for a signed-in (non-guest) user', () => {
    it('a refused session leaves the identity untouched (no change needed)', async () => {
        const p = start({ cfg: { otp: true }, persisted: signedIn, search: '', account: { 'account.get': () => real, 'account.createSession': prohibited } })
        await until(() => p.store.isAuthenticated && typeof p.store.verifyOTP === 'function' && p.events.some(e => e.type === 'initialized'))
        p.store._otpUserId = 'u1'
        const r = await p.store.verifyOTP('123456')
        expect(r.success).toBe(false)
        expect(p.store.isAuthenticated).toBe(true)
        expect(p.store.isAnonymous).toBe(false)
        expect(mirror(p).isAuthenticated).toBe(true)
    })
})
