/**
 * logout() announces manifest:auth:before-logout and waits (bounded) for the
 * work listeners hand to waitUntil — e.g. the presence delete — before it
 * deletes the session, so that work still runs authenticated.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH = f => readFileSync(path.join(__dirname, '../src/scripts/auth', f), 'utf8')
const STORE_SRC = AUTH('manifest.appwrite.auth.store.js')
const OTP_SRC = AUTH('manifest.appwrite.auth.users.otp.js')

function load(account, { otp = false, state } = {}) {
    const listeners = {}
    const stores = {}
    const alpineInit = []
    const storage = new Map()
    const ctx = {
        console: { ...console, warn: vi.fn() }, Promise, setTimeout, clearTimeout, Date, JSON,
        CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail } },
        Event: class { constructor(type) { this.type = type } },
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
        sessionStorage: { getItem: () => null, setItem: () => { }, removeItem: () => { } },
        document: { readyState: 'complete', visibilityState: 'visible', addEventListener: (ev, cb) => { if (ev === 'alpine:init') alpineInit.push(cb) }, querySelector: () => null },
        Alpine: { store: (name, val) => { if (val !== undefined) stores[name] = val; return stores[name] } },
    }
    ctx.window = {
        Alpine: ctx.Alpine,
        Appwrite: { ID: { unique: () => 'id' } },
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
        dispatchEvent: e => { (listeners[e.type] || []).forEach(fn => fn(e)) },
        ManifestAppwriteAuthConfig: { getAppwriteClient: async () => ({ account }), getAppwriteConfig: async () => ({ otp: true }) },
    }
    vm.createContext(ctx)
    vm.runInContext(STORE_SRC, ctx)
    if (otp) vm.runInContext(OTP_SRC, ctx)
    alpineInit.forEach(cb => cb())
    const auth = stores.auth
    auth._appwrite = { account }
    Object.assign(auth, state || { isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, session: { $id: 's1' } })
    return { auth, on: (type, fn) => ctx.window.addEventListener(type, fn) }
}

describe('logout before-logout hook', () => {
    it('waits for waitUntil work before deleting the session', async () => {
        const order = []
        const account = { deleteSession: vi.fn(async () => { order.push('deleteSession') }) }
        const { auth, on } = load(account)
        on('manifest:auth:before-logout', e => e.detail.waitUntil(new Promise(r => setTimeout(() => { order.push('presence delete'); r() }, 50))))
        await auth.logout()
        expect(order).toEqual(['presence delete', 'deleteSession'])
    })

    it('a hung listener cannot hold logout past its bound', async () => {
        const account = { deleteSession: vi.fn(async () => ({})) }
        const { auth, on } = load(account)
        on('manifest:auth:before-logout', e => e.detail.waitUntil(new Promise(() => { })))
        const t0 = Date.now()
        await auth.logout()
        expect(account.deleteSession).toHaveBeenCalled()
        expect(Date.now() - t0).toBeLessThan(4000)
    }, 6000)

    const slowPresence = order => e => e.detail.waitUntil(new Promise(r => setTimeout(() => { order.push('presence delete'); r() }, 50)))

    it('clearSession() runs the hook before deleting the session', async () => {
        const order = []
        const account = { deleteSession: vi.fn(async () => { order.push('deleteSession') }) }
        const { auth, on } = load(account)
        on('manifest:auth:before-logout', slowPresence(order))
        await auth.clearSession()
        expect(order).toEqual(['presence delete', 'deleteSession'])
    })

    it('a guest ended by OTP sign-in runs the hook before its session is deleted', async () => {
        const order = []
        const account = {
            deleteSession: vi.fn(async () => { order.push('deleteSession') }),
            createSession: vi.fn(async () => ({ $id: 's2', userId: 'u-new' })),
            get: vi.fn(async () => ({ $id: 'u-new' })),
        }
        const { auth, on } = load(account, {
            otp: true,
            state: { isAuthenticated: true, isAnonymous: true, user: { $id: 'guest-1' }, session: { $id: 'guest-session', provider: 'anonymous' }, otpSent: true, _otpUserId: 'u-new', teams: [] },
        })
        on('manifest:auth:before-logout', slowPresence(order))
        await new Promise(r => setTimeout(r, 250)) // the OTP module attaches its methods on a timer
        await auth.verifyOTP('123456').catch(() => { })
        expect(order.slice(0, 2)).toEqual(['presence delete', 'deleteSession'])
    })
})
