/**
 * OTP verify (shared by email + phone OTP) against the real auth store.
 *
 * Appwrite refuses createSession while a session is active — before it checks
 * the code — so a guest's session must be deleted ahead of every attempt. A
 * wrong code therefore ends the guest: the store must drop the dead identity,
 * keep the code entry live, and keep the guest-migration ticket so a retry with
 * the right code still carries the guest's teams over.
 *
 * Cross-tab: otpSent is mirrored to other tabs via localStorage; the code's
 * userId must travel with it or the other tab's code row can't verify.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = f => readFileSync(path.join(__dirname, '../src/scripts/auth', f), 'utf8')
const STORE_SRC = read('manifest.appwrite.auth.store.js')
const OTP_SRC = read('manifest.appwrite.auth.users.otp.js')

const STORAGE_KEY = 'manifest:auth:state'

function appwriteError(message, code, type) {
    const e = new Error(message)
    e.code = code
    if (type) e.type = type
    return e
}

function load({ account = {}, appwriteConfig = { otp: true }, store = {}, migration = null } = {}) {
    const listeners = {}
    const events = []
    const storage = new Map()
    const stores = {}
    const alpineInit = []

    const ctx = {
        console: { ...console, warn: vi.fn() },
        Promise,
        setTimeout: (fn) => { fn(); return 0 },
        clearTimeout: () => {},
        Date,
        JSON,
        CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail } },
        Event: class { constructor(type) { this.type = type } },
        localStorage: {
            getItem: k => (storage.has(k) ? storage.get(k) : null),
            setItem: (k, v) => storage.set(k, String(v)),
            removeItem: k => storage.delete(k),
        },
        sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        document: {
            readyState: 'complete',
            visibilityState: 'visible',
            addEventListener: (ev, cb) => { if (ev === 'alpine:init') alpineInit.push(cb) },
            querySelector: () => null,
        },
        Alpine: {
            store: (name, val) => {
                if (val !== undefined) stores[name] = val
                return stores[name]
            },
        },
    }
    ctx.window = {
        Alpine: ctx.Alpine,
        Appwrite: { ID: { unique: () => 'unique-id' } },
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
        dispatchEvent: e => { events.push(e); (listeners[e.type] || []).forEach(fn => fn(e)) },
        ManifestAppwriteAuthConfig: {
            getAppwriteClient: async () => ({ account }),
            getAppwriteConfig: async () => appwriteConfig,
        },
    }
    ctx.global = ctx
    vm.createContext(ctx)
    vm.runInContext(STORE_SRC, ctx)
    vm.runInContext(OTP_SRC, ctx)
    alpineInit.forEach(cb => cb()) // store, then OTP methods onto it

    const auth = stores.auth
    auth._appwrite = { account }
    Object.assign(auth, store)
    if (migration) auth._callGuestMigration = migration

    // Another tab writes the shared state key
    const fromOtherTab = state => (listeners.storage || []).forEach(fn => fn({ key: STORAGE_KEY, newValue: JSON.stringify(state) }))
    const persisted = () => JSON.parse(storage.get(STORAGE_KEY) || 'null')

    return { auth, events, fromOtherTab, persisted }
}

const GUEST = {
    isAuthenticated: true,
    isAnonymous: true,
    user: { $id: 'guest-1' },
    session: { $id: 'guest-session', provider: 'anonymous' },
    teams: [{ $id: 'guest-team' }],
    currentTeam: { $id: 'guest-team' },
    otpSent: true,
    _otpUserId: 'u-new',
}

describe('verifyOTP: failed code from a guest', () => {
    it('drops the dead guest identity and teams but keeps the code entry live', async () => {
        const account = {
            deleteSession: vi.fn(async () => ({})),
            createSession: vi.fn(async () => { throw appwriteError('Invalid token passed in the request.', 401, 'user_invalid_token') }),
        }
        const { auth, events, persisted } = load({ account, store: { ...GUEST } })

        const result = await auth.verifyOTP('000000')

        expect(account.deleteSession).toHaveBeenCalledWith('guest-session')
        expect(result.success).toBe(false)
        expect(result.guestEnded).toBe(true)
        expect(auth.isAuthenticated).toBe(false)
        expect(auth.isAnonymous).toBe(false)
        expect(auth.user).toBe(null)
        expect(auth.session).toBe(null)
        expect(auth.teams).toEqual([])
        expect(auth.currentTeam).toBe(null)
        // Still in the code step: the token is still valid for a retry
        expect(auth.otpSent).toBe(true)
        expect(auth.otpExpired).toBe(true)
        expect(auth._otpUserId).toBe('u-new')
        expect(events.some(e => e.type === 'manifest:auth:session-cleared')).toBe(true)
        expect(persisted()).toMatchObject({ isAuthenticated: false, user: null, otpSent: true })
    })

    it('keeps the migration ticket so a retry with the right code carries the guest teams over', async () => {
        let attempt = 0
        const account = {
            deleteSession: vi.fn(async () => ({})),
            createSession: vi.fn(async () => {
                if (attempt++ === 0) throw appwriteError('Invalid token passed in the request.', 401, 'user_invalid_token')
                return { $id: 'new-session', provider: 'email' }
            }),
            get: async () => ({ $id: 'u-new', email: 'a@b.co' }),
        }
        const migration = vi.fn(async (p) => (p === '/prepare' ? { ok: true, ticket: 'T1' } : { ok: true }))
        const { auth } = load({
            account,
            store: { ...GUEST },
            appwriteConfig: { otp: true, guestMigrationFunctionId: 'fn' },
            migration,
        })

        const first = await auth.verifyOTP('000000')
        expect(first.success).toBe(false)
        expect(migration).toHaveBeenCalledWith('/prepare', {})
        expect(auth._otpMigrationTicket).toEqual({ ticket: 'T1', userId: 'u-new' })

        // Signed out now: no guest session to prepare from, the kept ticket is redeemed
        const second = await auth.verifyOTP('123456')
        expect(second.success).toBe(true)
        expect(account.deleteSession).toHaveBeenCalledTimes(1)
        expect(migration.mock.calls.filter(c => c[0] === '/prepare')).toHaveLength(1)
        expect(migration).toHaveBeenCalledWith('/commit', { ticket: 'T1' })
        expect(auth._otpMigrationTicket).toBe(null)
        expect(auth.isAuthenticated).toBe(true)
        expect(auth.isAnonymous).toBe(false)
        expect(auth.otpSent).toBe(false)
        expect(auth._otpUserId).toBe(null)
    })

    it('leaves a guest signed in when its session could not be deleted', async () => {
        const account = {
            deleteSession: vi.fn(async () => { throw new TypeError('Failed to fetch') }),
            createSession: vi.fn(async () => {
                throw appwriteError('Creation of a session is prohibited when a session is active.', 401, 'user_session_already_exists')
            }),
        }
        const { auth, events } = load({ account, store: { ...GUEST } })

        const result = await auth.verifyOTP('123456')

        expect(result.success).toBe(false)
        expect(result.guestEnded).toBe(false)
        expect(auth.isAuthenticated).toBe(true)
        expect(auth.isAnonymous).toBe(true)
        expect(auth.session).toEqual(GUEST.session)
        expect(auth.teams).toEqual(GUEST.teams)
        // Not a bad code: surface the conflict instead of "invalid or expired"
        expect(auth.otpExpired).toBe(false)
        expect(auth.error).toMatch(/prohibited/)
        expect(events.some(e => e.type === 'manifest:auth:session-cleared')).toBe(false)
    })

    it('treats an already-gone guest session (404 on delete) as ended', async () => {
        const account = {
            deleteSession: vi.fn(async () => { throw appwriteError('Session not found', 404, 'user_session_not_found') }),
            createSession: vi.fn(async () => { throw appwriteError('Invalid token passed in the request.', 401, 'user_invalid_token') }),
        }
        const { auth } = load({ account, store: { ...GUEST } })

        const result = await auth.verifyOTP('000000')

        expect(result.guestEnded).toBe(true)
        expect(auth.isAuthenticated).toBe(false)
        expect(auth.session).toBe(null)
    })

    it('does not touch sessions or announce a cleared session for a signed-out user', async () => {
        const account = {
            deleteSession: vi.fn(),
            createSession: vi.fn(async () => { throw appwriteError('Invalid token passed in the request.', 401, 'user_invalid_token') }),
        }
        const { auth, events } = load({ account, store: { otpSent: true, _otpUserId: 'u-new' } })

        const result = await auth.verifyOTP('000000')

        expect(result.guestEnded).toBe(false)
        expect(account.deleteSession).not.toHaveBeenCalled()
        expect(auth.otpExpired).toBe(true)
        expect(events.some(e => e.type === 'manifest:auth:session-cleared')).toBe(false)
    })

    it('a kept ticket is never redeemed by a sign-in for a different account', async () => {
        const account = {
            createSession: vi.fn(async () => ({ $id: 'other-session', provider: 'email' })),
            get: async () => ({ $id: 'u-other', email: 'other@b.co' }),
        }
        const migration = vi.fn(async () => ({ ok: true }))
        // Guest's wrong code left a ticket bound to u-new; someone else then requested a code
        const { auth } = load({
            account,
            store: { otpSent: true, _otpUserId: 'u-other', _otpMigrationTicket: { ticket: 'T1', userId: 'u-new' } },
            appwriteConfig: { otp: true, guestMigrationFunctionId: 'fn' },
            migration,
        })

        const result = await auth.verifyOTP('123456')

        expect(result.success).toBe(true)
        expect(migration).not.toHaveBeenCalledWith('/commit', expect.anything())
        expect(auth._otpMigrationTicket).toBe(null)
    })

    it('a failed or empty prepare on a later guest attempt keeps the existing ticket', async () => {
        const account = {
            deleteSession: vi.fn(async () => ({})),
            createSession: vi.fn(async () => { throw appwriteError('Invalid token passed in the request.', 401, 'user_invalid_token') }),
        }
        const migration = vi.fn(async () => null)
        const { auth } = load({
            account,
            store: { ...GUEST, _otpMigrationTicket: { ticket: 'T1', userId: 'u-new' } },
            appwriteConfig: { otp: true, guestMigrationFunctionId: 'fn' },
            migration,
        })

        await auth.verifyOTP('000000')

        expect(migration).toHaveBeenCalledWith('/prepare', {})
        expect(auth._otpMigrationTicket).toEqual({ ticket: 'T1', userId: 'u-new' })
    })

    it('logout clears a kept migration ticket, including from the signed-out state a failed code leaves', async () => {
        const { auth } = load({ store: { _otpMigrationTicket: { ticket: 'T1', userId: 'u-new' } } })
        expect(auth.isAuthenticated).toBe(false)
        await auth.logout()
        expect(auth._otpMigrationTicket).toBe(null)

        const account = { deleteSession: vi.fn(async () => ({})) }
        const { auth: a2 } = load({
            account,
            store: { isAuthenticated: true, isAnonymous: false, session: { $id: 's1' }, _otpMigrationTicket: { ticket: 'T1', userId: 'u-new' } },
        })
        await a2.logout()
        expect(a2._otpMigrationTicket).toBe(null)
    })
})

describe('OTP state across tabs', () => {
    it('persists the code userId alongside otpSent, and nothing once the flow ends', () => {
        const { auth, persisted } = load({ store: { otpSent: true, _otpUserId: 'u-new' } })
        auth._syncStateToStorage(auth)
        expect(persisted()).toMatchObject({ otpSent: true, otpUserId: 'u-new' })

        auth.otpSent = false
        auth._syncStateToStorage(auth)
        expect(persisted().otpUserId).toBe(null)
    })

    it('a tab that learns otpSent from another tab can verify the code', async () => {
        const account = {
            createSession: vi.fn(async () => ({ $id: 'new-session', provider: 'email' })),
            get: async () => ({ $id: 'u-new', email: 'a@b.co' }),
        }
        const { auth, fromOtherTab } = load({ account })
        expect(auth._otpUserId).toBe(null)

        fromOtherTab({ isAuthenticated: false, isAnonymous: false, user: null, session: null, otpSent: true, otpExpired: true, otpUserId: 'u-new' })

        expect(auth.otpSent).toBe(true)
        const result = await auth.verifyOTP('123456')
        expect(result.success).toBe(true)
        expect(account.createSession).toHaveBeenCalledWith('u-new', '123456')
    })

    it('a sync without a live code does not clobber this tab\'s pending userId', () => {
        const { auth, fromOtherTab } = load({ store: { otpSent: true, _otpUserId: 'u-mine' } })
        fromOtherTab({ isAuthenticated: false, isAnonymous: false, user: null, session: null, otpSent: false, otpUserId: null })
        expect(auth._otpUserId).toBe('u-mine')
    })
})
