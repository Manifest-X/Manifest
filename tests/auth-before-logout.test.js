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
const STORE_SRC = readFileSync(path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.store.js'), 'utf8')

function load(account) {
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
        ManifestAppwriteAuthConfig: { getAppwriteClient: async () => ({ account }), getAppwriteConfig: async () => ({}) },
    }
    vm.createContext(ctx)
    vm.runInContext(STORE_SRC, ctx)
    alpineInit.forEach(cb => cb())
    const auth = stores.auth
    auth._appwrite = { account }
    Object.assign(auth, { isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, session: { $id: 's1' } })
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
})
