/**
 * Phone OTP (SMS passcode) sign-in.
 *
 * Loads the real users.phone.js + users.otp.js subscripts and drives the store
 * methods they attach: E.164 normalization/rejection, the config gate, the
 * unique-userId send (never the guest's $id — Appwrite 500s on it), the shared
 * verifyOTP completion path, and the actionable 501 message.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PHONE_SRC = readFileSync(
    path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.users.phone.js'),
    'utf8'
)
const OTP_SRC = readFileSync(
    path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.users.otp.js'),
    'utf8'
)

// Load the real subscripts against a stubbed Alpine store + Appwrite client.
function loadPhoneOTP({ account = {}, appwriteConfig = { phone: true }, store = {} } = {}) {
    const fullStore = {
        user: null,
        session: null,
        isAuthenticated: false,
        isAnonymous: false,
        inProgress: false,
        error: null,
        otpSent: false,
        otpExpired: false,
        otpPhrase: null,
        _otpUserId: null,
        ...store,
    }

    const events = []
    const ctx = {
        console: { ...console, warn: vi.fn() },
        Promise,
        setTimeout: (fn) => { fn(); return 0 },
        CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail } },
        Alpine: {
            store: name => (name === 'auth' ? fullStore : null),
        },
        document: {
            readyState: 'complete',
            addEventListener: () => {},
            querySelector: () => null,
        },
    }
    ctx.window = {
        Alpine: ctx.Alpine,
        Appwrite: { ID: { unique: () => 'unique-id' } },
        dispatchEvent: e => events.push(e),
        ManifestAppwriteAuthConfig: {
            getAppwriteClient: async () => ({ account }),
            getAppwriteConfig: async () => appwriteConfig,
        },
    }
    ctx.global = ctx
    vm.createContext(ctx)
    vm.runInContext(OTP_SRC, ctx)
    vm.runInContext(PHONE_SRC, ctx)
    ctx.window.ManifestAppwriteAuthPhoneOTP.initialize()
    ctx.window.ManifestAppwriteAuthEmailOTP.initialize()

    return { store: fullStore, events, ctx }
}

describe('phone OTP', () => {
    it('attaches createPhoneOTP and sendPhoneOTP to the store', () => {
        const { store } = loadPhoneOTP()
        expect(typeof store.createPhoneOTP).toBe('function')
        expect(typeof store.sendPhoneOTP).toBe('function')
    })

    it('refuses when the phone method is not enabled', async () => {
        const createPhoneToken = vi.fn()
        const { store } = loadPhoneOTP({ account: { createPhoneToken }, appwriteConfig: { phone: false } })
        const result = await store.createPhoneOTP('+14155550123')
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/not enabled/)
        expect(createPhoneToken).not.toHaveBeenCalled()
    })

    it('rejects numbers without a country code before calling Appwrite', async () => {
        const createPhoneToken = vi.fn()
        const { store } = loadPhoneOTP({ account: { createPhoneToken } })
        const result = await store.createPhoneOTP('4155550123')
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/international format/)
        expect(createPhoneToken).not.toHaveBeenCalled()
    })

    it('normalizes separators, sends with a fresh unique id, and stashes the userId', async () => {
        const createPhoneToken = vi.fn(async () => ({ userId: 'u-new' }))
        const { store, events } = loadPhoneOTP({
            account: { createPhoneToken },
            // A guest must never have its own $id passed to createPhoneToken.
            store: { isAuthenticated: true, isAnonymous: true, user: { $id: 'guest-1' } },
            appwriteConfig: { phone: true, guestUpgrade: true },
        })

        const result = await store.sendPhoneOTP('+1 (415) 555-0123')
        expect(result.success).toBe(true)
        expect(createPhoneToken).toHaveBeenCalledWith('unique-id', '+14155550123')
        expect(store._otpUserId).toBe('u-new')
        expect(store.otpSent).toBe(true)
        expect(store.otpPhrase).toBe(null)
        expect(events.some(e => e.type === 'manifest:auth:otp-sent' && e.detail.phone === '+14155550123')).toBe(true)
    })

    it('completes sign-in through the shared verifyOTP', async () => {
        const account = {
            createPhoneToken: async () => ({ userId: 'u-new' }),
            createSession: vi.fn(async () => ({ $id: 's1' })),
            get: async () => ({ $id: 'u-new', phone: '+14155550123' }),
        }
        const { store } = loadPhoneOTP({ account })

        await store.createPhoneOTP('+14155550123')
        const result = await store.verifyOTP('123456')

        expect(account.createSession).toHaveBeenCalledWith('u-new', '123456')
        expect(result.success).toBe(true)
        expect(store.isAuthenticated).toBe(true)
        expect(store.isAnonymous).toBe(false)
        expect(store.otpSent).toBe(false)
        expect(store._otpUserId).toBe(null)
    })

    it('surfaces an actionable message when Appwrite returns 501', async () => {
        const account = {
            createPhoneToken: async () => { const e = new Error('Not implemented'); e.code = 501; throw e },
        }
        const { store } = loadPhoneOTP({ account })
        const result = await store.createPhoneOTP('+14155550123')
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/SMS provider/)
        expect(store.otpSent).toBe(false)
    })

    it('refuses when already signed in non-anonymously', async () => {
        const createPhoneToken = vi.fn()
        const { store } = loadPhoneOTP({
            account: { createPhoneToken },
            store: { isAuthenticated: true, isAnonymous: false },
        })
        const result = await store.createPhoneOTP('+14155550123')
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/Already signed in/)
        expect(createPhoneToken).not.toHaveBeenCalled()
    })
})
