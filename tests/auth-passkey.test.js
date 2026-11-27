/**
 * Passkey (WebAuthn) sign-in, registration and management.
 *
 * Loads the real users.passkey.js subscript against a stubbed store, Appwrite
 * account and WebAuthn surface.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, vi } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = file => readFileSync(path.join(__dirname, '../src/scripts/auth', file), 'utf8')
const PASSKEY_SRC = read('manifest.appwrite.auth.users.passkey.js')
const CONFIG_SRC = read('manifest.appwrite.auth.config.js')
const STORE_SRC = read('manifest.appwrite.auth.store.js')

const domError = name => Object.assign(new Error(name), { name })
const appwriteError = (type, code = 400) => Object.assign(new Error(type), { type, code })

function fakeCredential(json) {
    return { toJSON: () => json }
}

function fullAccount(overrides = {}) {
    return {
        createPasskeyToken: vi.fn(async () => ({ $id: 'ch-1', publicKey: { challenge: 'abc', rpId: 'localhost' } })),
        updatePasskeyToken: vi.fn(async () => ({ userId: 'u-1', secret: 's-1' })),
        createSession: vi.fn(async () => ({ $id: 'sess-1', provider: 'passkey' })),
        get: vi.fn(async () => ({ $id: 'u-1', name: 'Ada' })),
        deleteSession: vi.fn(async () => ({})),
        createPasskey: vi.fn(async () => ({ $id: 'ch-2', passkeyId: 'pk-1', publicKey: { challenge: 'def', rp: { id: 'localhost' } } })),
        updatePasskeyVerification: vi.fn(async () => ({ $id: 'pk-1', name: 'Laptop', $createdAt: 't', accessedAt: '' })),
        listPasskeys: vi.fn(async () => ({ total: 1, passkeys: [{ $id: 'pk-1', name: 'Laptop', $createdAt: 't', accessedAt: '' }] })),
        updatePasskey: vi.fn(async ({ passkeyId, name }) => ({ $id: passkeyId, name, $createdAt: 't', accessedAt: '' })),
        deletePasskey: vi.fn(async () => ({})),
        ...overrides,
    }
}

function loadPasskey({ account = fullAccount(), appwriteConfig = { passkey: true }, store = {}, webauthn = true, credentials } = {}) {
    const fullStore = {
        user: null,
        session: null,
        isAuthenticated: false,
        isAnonymous: false,
        inProgress: false,
        error: null,
        passkeys: [],
        passkeySupported: false,
        _passkeyMigrationTicket: null,
        _syncStateToStorage: vi.fn(),
        _resetTeamsState: vi.fn(),
        _beforeSessionEnd: vi.fn(async () => {}),
        ...store,
    }

    const events = []
    const listeners = {}
    const creds = credentials || {
        get: vi.fn(async () => fakeCredential({ id: 'cred-1', type: 'public-key', response: { signature: 'sig' } })),
        create: vi.fn(async () => fakeCredential({ id: 'cred-1', type: 'public-key', response: { attestationObject: 'att' } })),
    }
    const ctx = {
        console: { ...console, warn: vi.fn() },
        Promise,
        Uint8Array,
        ArrayBuffer,
        atob: s => Buffer.from(s, 'base64').toString('binary'),
        btoa: s => Buffer.from(s, 'binary').toString('base64'),
        setTimeout: (fn) => { fn(); return 0 },
        CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail } },
        Alpine: { store: name => (name === 'auth' ? fullStore : null) },
        document: { readyState: 'complete', addEventListener: () => {} },
    }
    ctx.window = {
        Alpine: ctx.Alpine,
        Appwrite: {},
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
        dispatchEvent: e => { events.push(e); (listeners[e.type] || []).forEach(fn => fn(e)) },
        ManifestAppwriteAuthConfig: {
            getAppwriteClient: async () => ({ account }),
            getAppwriteConfig: async () => appwriteConfig,
        },
    }
    if (webauthn) {
        ctx.window.PublicKeyCredential = Object.assign(function PublicKeyCredential() {}, {
            parseCreationOptionsFromJSON: vi.fn(json => ({ parsed: 'creation', json })),
            parseRequestOptionsFromJSON: vi.fn(json => ({ parsed: 'request', json })),
        })
        ctx.window.navigator = { credentials: creds }
    } else {
        ctx.window.navigator = {}
    }
    ctx.global = ctx
    vm.createContext(ctx)
    vm.runInContext(PASSKEY_SRC, ctx)
    ctx.window.ManifestAppwriteAuthPasskey.initialize()

    return { store: fullStore, events, ctx, account, credentials: creds }
}

describe('passkey: wiring', () => {
    it('attaches the methods and reports browser support', () => {
        const { store } = loadPasskey()
        for (const name of ['loginPasskey', 'addPasskey', 'listPasskeys', 'renamePasskey', 'removePasskey']) {
            expect(typeof store[name]).toBe('function')
        }
        expect(store.passkeySupported).toBe(true)
    })

    it('reports no support without WebAuthn and refuses with code unsupported', async () => {
        const { store, account } = loadPasskey({ webauthn: false })
        expect(store.passkeySupported).toBe(false)
        const result = await store.loginPasskey()
        expect(result).toMatchObject({ success: false, code: 'unsupported' })
        expect(account.createPasskeyToken).not.toHaveBeenCalled()
    })

    it('refuses with code not-enabled when the method is off in manifest.json', async () => {
        const { store, account } = loadPasskey({ appwriteConfig: { passkey: false } })
        const result = await store.loginPasskey()
        expect(result).toMatchObject({ success: false, code: 'not-enabled' })
        expect(store.error).toMatch(/not enabled/)
        expect(account.createPasskeyToken).not.toHaveBeenCalled()
    })

    it('refuses with code unsupported when the loaded SDK has no passkey methods', async () => {
        const account = fullAccount()
        delete account.createPasskeyToken
        const { store } = loadPasskey({ account })
        const result = await store.loginPasskey()
        expect(result).toMatchObject({ success: false, code: 'unsupported' })
        expect(result.error).toMatch(/SDK/)
    })

    it('config parses the passkey method; getMethod reports passkey', () => {
        expect(CONFIG_SRC).toMatch(/passkey: authMethods\.includes\(["']passkey["']\)/)
        expect(STORE_SRC).toMatch(/case 'passkey':\s*return 'passkey'/)
    })
})

describe('passkey: sign in', () => {
    it('runs challenge, WebAuthn, token and session, then signs the user in', async () => {
        const { store, events, account, credentials, ctx } = loadPasskey()
        const result = await store.loginPasskey()

        expect(result).toMatchObject({ success: true, user: { $id: 'u-1' } })
        expect(ctx.window.PublicKeyCredential.parseRequestOptionsFromJSON).toHaveBeenCalledWith({ challenge: 'abc', rpId: 'localhost' })
        expect(credentials.get).toHaveBeenCalledWith({ publicKey: { parsed: 'request', json: { challenge: 'abc', rpId: 'localhost' } } })
        expect(account.updatePasskeyToken).toHaveBeenCalledWith({
            challengeId: 'ch-1',
            credential: { id: 'cred-1', type: 'public-key', response: { signature: 'sig' } },
        })
        expect(account.createSession).toHaveBeenCalledWith('u-1', 's-1')
        expect(store.isAuthenticated).toBe(true)
        expect(store.isAnonymous).toBe(false)
        expect(store.session.provider).toBe('passkey')
        expect(store.inProgress).toBe(false)
        expect(store.error).toBe(null)
        expect(store._syncStateToStorage).toHaveBeenCalled()
        expect(events.some(e => e.type === 'manifest:auth:login' && e.detail.user.$id === 'u-1')).toBe(true)
    })

    it('refuses when already signed in', async () => {
        const { store, account } = loadPasskey({ store: { isAuthenticated: true, user: { $id: 'u-9' } } })
        const result = await store.loginPasskey()
        expect(result).toMatchObject({ success: false, code: 'signed-in' })
        expect(account.createPasskeyToken).not.toHaveBeenCalled()
    })

    it('a dismissed prompt is code cancelled with no error shown', async () => {
        const credentials = { get: vi.fn(async () => { throw domError('NotAllowedError') }), create: vi.fn() }
        const { store, account } = loadPasskey({ credentials })
        const result = await store.loginPasskey()
        expect(result).toMatchObject({ success: false, code: 'cancelled' })
        expect(store.error).toBe(null)
        expect(store.inProgress).toBe(false)
        expect(account.updatePasskeyToken).not.toHaveBeenCalled()
    })

    it('a null credential is treated as cancelled', async () => {
        const credentials = { get: vi.fn(async () => null), create: vi.fn() }
        const { store } = loadPasskey({ credentials })
        expect(await store.loginPasskey()).toMatchObject({ success: false, code: 'cancelled' })
    })

    it('maps Appwrite errors to codes', async () => {
        const cases = [
            ['user_auth_method_unsupported', 'not-enabled'],
            ['user_passkey_invalid', 'invalid'],
            ['user_invalid_token', 'invalid'],
            ['general_rate_limit_exceeded', 'rate-limited'],
            ['user_blocked', 'failed'],
        ]
        for (const [type, code] of cases) {
            const account = fullAccount({ updatePasskeyToken: vi.fn(async () => { throw appwriteError(type) }) })
            const { store } = loadPasskey({ account })
            const result = await store.loginPasskey()
            expect(result, type).toMatchObject({ success: false, code })
            expect(store.error, type).toBeTruthy()
            expect(store.isAuthenticated, type).toBe(false)
        }
    })

    it('keeps a guest session until the passkey is verified, then replaces it', async () => {
        const order = []
        const account = fullAccount({
            updatePasskeyToken: vi.fn(async () => { order.push('token'); return { userId: 'u-1', secret: 's-1' } }),
            deleteSession: vi.fn(async () => { order.push('delete') }),
            createSession: vi.fn(async () => { order.push('session'); return { $id: 'sess-1', provider: 'passkey' } }),
        })
        const { store } = loadPasskey({
            account,
            store: { isAuthenticated: true, isAnonymous: true, user: { $id: 'guest-1' }, session: { $id: 'g-sess', provider: 'anonymous' } },
        })
        const result = await store.loginPasskey()
        expect(result.success).toBe(true)
        expect(order).toEqual(['token', 'delete', 'session'])
        expect(account.deleteSession).toHaveBeenCalledWith('g-sess')
        expect(store._beforeSessionEnd).toHaveBeenCalled()
        expect(store._resetTeamsState).toHaveBeenCalled()
        expect(store.isAnonymous).toBe(false)
        expect(store.user.$id).toBe('u-1')
    })

    it('a guest who cancels the prompt stays a guest', async () => {
        const credentials = { get: vi.fn(async () => { throw domError('NotAllowedError') }), create: vi.fn() }
        const { store, account } = loadPasskey({
            credentials,
            store: { isAuthenticated: true, isAnonymous: true, user: { $id: 'guest-1' }, session: { $id: 'g-sess', provider: 'anonymous' } },
        })
        await store.loginPasskey()
        expect(account.deleteSession).not.toHaveBeenCalled()
        expect(store.isAnonymous).toBe(true)
        expect(store.user.$id).toBe('guest-1')
    })

    it('guest ended but session exchange failed: signed out, session-cleared fired', async () => {
        const account = fullAccount({ createSession: vi.fn(async () => { throw appwriteError('user_invalid_token', 401) }) })
        const { store, events } = loadPasskey({
            account,
            store: { isAuthenticated: true, isAnonymous: true, user: { $id: 'guest-1' }, session: { $id: 'g-sess', provider: 'anonymous' } },
        })
        const result = await store.loginPasskey()
        expect(result).toMatchObject({ success: false, code: 'invalid', guestEnded: true })
        expect(store.isAuthenticated).toBe(false)
        expect(store.user).toBe(null)
        expect(events.some(e => e.type === 'manifest:auth:session-cleared')).toBe(true)
    })

    it('carries guest teams over when a migration function is configured', async () => {
        const migrate = vi.fn(async (path) => (path === '/prepare' ? { ok: true, ticket: 't-1' } : { ok: true }))
        const { store } = loadPasskey({
            appwriteConfig: { passkey: true, guestMigrationFunctionId: 'fn-1' },
            store: {
                isAuthenticated: true, isAnonymous: true, user: { $id: 'guest-1' }, session: { $id: 'g-sess', provider: 'anonymous' },
                _callGuestMigration: migrate,
            },
        })
        await store.loginPasskey()
        expect(migrate.mock.calls).toEqual([['/prepare', {}], ['/commit', { ticket: 't-1' }]])
    })

    it('loads teams after sign-in when teams are on', async () => {
        const loadTeams = vi.fn(async () => {})
        const { store } = loadPasskey({
            appwriteConfig: { passkey: true, teams: true },
            store: { listTeams: () => {}, _loadTeamsAndSeed: loadTeams },
        })
        await store.loginPasskey()
        expect(loadTeams).toHaveBeenCalled()
    })
})

describe('passkey: register', () => {
    const signedIn = { isAuthenticated: true, user: { $id: 'u-1' }, session: { $id: 's', provider: 'magic-url' } }

    it('registers a passkey for the signed-in user', async () => {
        const { store, events, account, credentials } = loadPasskey({ store: signedIn })
        const result = await store.addPasskey('  Laptop  ')

        expect(account.createPasskey).toHaveBeenCalledWith({ name: 'Laptop' })
        expect(credentials.create).toHaveBeenCalledWith({ publicKey: { parsed: 'creation', json: { challenge: 'def', rp: { id: 'localhost' } } } })
        expect(account.updatePasskeyVerification).toHaveBeenCalledWith({
            passkeyId: 'pk-1',
            credential: { id: 'cred-1', type: 'public-key', response: { attestationObject: 'att' } },
        })
        expect(result).toMatchObject({ success: true, passkey: { $id: 'pk-1' } })
        expect(store.passkeys.map(p => p.$id)).toEqual(['pk-1'])
        expect(store.inProgress).toBe(false)
        expect(events.some(e => e.type === 'manifest:auth:passkey-added' && e.detail.passkey.$id === 'pk-1')).toBe(true)
    })

    it('never sends a caller-chosen passkey id', async () => {
        const { store, account } = loadPasskey({ store: signedIn })
        await store.addPasskey()
        expect(account.createPasskey).toHaveBeenCalledWith({})
        await store.addPasskey({ passkeyId: 'mine', name: 'x' })
        expect(account.createPasskey.mock.calls[1][0]).toEqual({})
    })

    it('refuses when signed out and for guests', async () => {
        const out = loadPasskey()
        expect(await out.store.addPasskey()).toMatchObject({ success: false, code: 'not-signed-in' })
        const guest = loadPasskey({ store: { isAuthenticated: true, isAnonymous: true, user: { $id: 'g' } } })
        expect(await guest.store.addPasskey()).toMatchObject({ success: false, code: 'guest' })
        expect(guest.account.createPasskey).not.toHaveBeenCalled()
    })

    it('maps registration errors to codes', async () => {
        const cases = [
            ['user_reauthentication_required', 'reauth-required'],
            ['user_passkey_limit_exceeded', 'limit'],
            ['user_passkey_already_exists', 'exists'],
        ]
        for (const [type, code] of cases) {
            const account = fullAccount({ createPasskey: vi.fn(async () => { throw appwriteError(type) }) })
            const { store } = loadPasskey({ account, store: signedIn })
            expect(await store.addPasskey(), type).toMatchObject({ success: false, code })
        }
    })

    it('an authenticator that already holds a passkey for the account is code exists', async () => {
        const credentials = { get: vi.fn(), create: vi.fn(async () => { throw domError('InvalidStateError') }) }
        const { store } = loadPasskey({ credentials, store: signedIn })
        const result = await store.addPasskey()
        expect(result).toMatchObject({ success: false, code: 'exists' })
        expect(store.error).toBeTruthy()
    })

    it('a dismissed prompt is code cancelled with no error shown', async () => {
        const credentials = { get: vi.fn(), create: vi.fn(async () => { throw domError('NotAllowedError') }) }
        const { store, account } = loadPasskey({ credentials, store: signedIn })
        expect(await store.addPasskey()).toMatchObject({ success: false, code: 'cancelled' })
        expect(store.error).toBe(null)
        expect(account.updatePasskeyVerification).not.toHaveBeenCalled()
    })
})

describe('passkey: manage', () => {
    const signedIn = { isAuthenticated: true, user: { $id: 'u-1' }, session: { $id: 's', provider: 'passkey' } }

    it('lists into $auth.passkeys', async () => {
        const { store } = loadPasskey({ store: signedIn })
        const result = await store.listPasskeys()
        expect(result).toMatchObject({ success: true })
        expect(store.passkeys).toEqual([{ $id: 'pk-1', name: 'Laptop', $createdAt: 't', accessedAt: '' }])
    })

    it('a listing that lands after the identity changed is dropped', async () => {
        let release
        const account = fullAccount({ listPasskeys: vi.fn(() => new Promise(r => { release = r })) })
        const { store, ctx } = loadPasskey({ account, store: signedIn })
        const pending = store.listPasskeys()
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        ctx.window.dispatchEvent({ type: 'manifest:auth:logout' })
        store.user = null
        store.isAuthenticated = false
        release({ total: 1, passkeys: [{ $id: 'pk-1' }] })
        await pending
        expect(store.passkeys).toEqual([])
    })

    it('renames in place', async () => {
        const { store, account } = loadPasskey({ store: { ...signedIn, passkeys: [{ $id: 'pk-1', name: 'Laptop' }] } })
        const result = await store.renamePasskey('pk-1', 'Work laptop')
        expect(account.updatePasskey).toHaveBeenCalledWith({ passkeyId: 'pk-1', name: 'Work laptop' })
        expect(result.success).toBe(true)
        expect(store.passkeys[0].name).toBe('Work laptop')
    })

    it('removes and announces', async () => {
        const { store, account, events } = loadPasskey({ store: { ...signedIn, passkeys: [{ $id: 'pk-1' }, { $id: 'pk-2' }] } })
        const result = await store.removePasskey('pk-1')
        expect(account.deletePasskey).toHaveBeenCalledWith({ passkeyId: 'pk-1' })
        expect(result.success).toBe(true)
        expect(store.passkeys.map(p => p.$id)).toEqual(['pk-2'])
        expect(events.some(e => e.type === 'manifest:auth:passkey-removed' && e.detail.passkeyId === 'pk-1')).toBe(true)
    })

    it('accepts a passkey object as well as an id', async () => {
        const { store, account } = loadPasskey({ store: { ...signedIn, passkeys: [{ $id: 'pk-1' }] } })
        await store.removePasskey({ $id: 'pk-1' })
        expect(account.deletePasskey).toHaveBeenCalledWith({ passkeyId: 'pk-1' })
    })

    it('removal needing a recent sign-in is code reauth-required', async () => {
        const account = fullAccount({ deletePasskey: vi.fn(async () => { throw appwriteError('user_reauthentication_required', 401) }) })
        const { store } = loadPasskey({ account, store: { ...signedIn, passkeys: [{ $id: 'pk-1' }] } })
        expect(await store.removePasskey('pk-1')).toMatchObject({ success: false, code: 'reauth-required' })
        expect(store.passkeys.length).toBe(1)
    })

    it('management refuses when signed out or without an id', async () => {
        const out = loadPasskey()
        expect(await out.store.listPasskeys()).toMatchObject({ success: false, code: 'not-signed-in' })
        const { store } = loadPasskey({ store: signedIn })
        expect((await store.removePasskey()).success).toBe(false)
        expect((await store.renamePasskey('pk-1', '  ')).success).toBe(false)
    })

    it('clears the list when the session ends or changes', () => {
        const { store, ctx } = loadPasskey({ store: { ...signedIn, passkeys: [{ $id: 'pk-1' }] } })
        ctx.window.dispatchEvent({ type: 'manifest:auth:session-cleared' })
        expect(store.passkeys).toEqual([])
    })
})

describe('passkey: review regressions', () => {
    const signedIn = { isAuthenticated: true, user: { $id: 'u-1' }, session: { $id: 's', provider: 'magic-url' } }
    const guestStore = { isAuthenticated: true, isAnonymous: true, user: { $id: 'guest-1' }, session: { $id: 'g-sess', provider: 'anonymous' } }

    it('a second loginPasskey while the prompt is open is code busy and leaves inProgress alone', async () => {
        let release
        const credentials = { create: vi.fn(), get: vi.fn(() => new Promise(r => { release = r })) }
        const { store, account } = loadPasskey({ credentials })
        const first = store.loginPasskey()
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        const second = await store.loginPasskey()
        expect(second).toMatchObject({ success: false, code: 'busy' })
        expect(store.inProgress).toBe(true)
        expect(account.createPasskeyToken).toHaveBeenCalledTimes(1)
        release(fakeCredential({ id: 'cred-1' }))
        expect((await first).success).toBe(true)
        expect(store.inProgress).toBe(false)
        expect((await store.loginPasskey()).code).toBe('signed-in')
    })

    it('a second addPasskey while the prompt is open is code busy', async () => {
        let release
        const credentials = { get: vi.fn(), create: vi.fn(() => new Promise(r => { release = r })) }
        const { store, account } = loadPasskey({ credentials, store: signedIn })
        const first = store.addPasskey()
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        expect(await store.addPasskey()).toMatchObject({ success: false, code: 'busy' })
        expect(account.createPasskey).toHaveBeenCalledTimes(1)
        release(fakeCredential({ id: 'cred-1' }))
        expect((await first).success).toBe(true)
    })

    it('keeps the guest migration ticket across a failed session exchange and redeems it on retry', async () => {
        const migrate = vi.fn(async (path) => (path === '/prepare' ? { ok: true, ticket: 't-1' } : { ok: true }))
        let attempts = 0
        const account = fullAccount({
            createSession: vi.fn(async () => {
                if (++attempts === 1) throw Object.assign(new Error('boom'), { code: 503 })
                return { $id: 'sess-1', provider: 'passkey' }
            }),
        })
        const { store } = loadPasskey({
            account,
            appwriteConfig: { passkey: true, guestMigrationFunctionId: 'fn-1' },
            store: { ...guestStore, _callGuestMigration: migrate },
        })
        expect(await store.loginPasskey()).toMatchObject({ success: false, guestEnded: true })
        expect((await store.loginPasskey()).success).toBe(true)
        expect(migrate.mock.calls).toEqual([['/prepare', {}], ['/commit', { ticket: 't-1' }]])
        expect(store._passkeyMigrationTicket).toBe(null)
    })

    it('a kept ticket is not redeemed for a different account, and logout drops it', async () => {
        const migrate = vi.fn(async () => ({ ok: true }))
        const { store, ctx } = loadPasskey({
            appwriteConfig: { passkey: true, guestMigrationFunctionId: 'fn-1' },
            store: { _callGuestMigration: migrate, _passkeyMigrationTicket: { ticket: 't-9', userId: 'someone-else' } },
        })
        expect((await store.loginPasskey()).success).toBe(true)
        expect(migrate).not.toHaveBeenCalled()

        store._passkeyMigrationTicket = { ticket: 't-9', userId: 'u-1' }
        ctx.window.dispatchEvent({ type: 'manifest:auth:logout' })
        expect(store._passkeyMigrationTicket).toBe(null)
    })

    it('a registration that finishes after sign-out does not touch the list or announce', async () => {
        let release
        const credentials = { get: vi.fn(), create: vi.fn(() => new Promise(r => { release = r })) }
        const { store, ctx, events } = loadPasskey({ credentials, store: signedIn })
        const pending = store.addPasskey()
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        ctx.window.dispatchEvent({ type: 'manifest:auth:logout' })
        release(fakeCredential({ id: 'cred-1' }))
        await pending
        expect(store.passkeys).toEqual([])
        expect(events.some(e => e.type === 'manifest:auth:passkey-added')).toBe(false)
    })

    it('a successful listing clears a stale error', async () => {
        const { store } = loadPasskey({ store: { ...signedIn, error: 'old' } })
        await store.listPasskeys()
        expect(store.error).toBe(null)
    })

    it('guest session that cannot be ended: sign-in fails, guest stays', async () => {
        const account = fullAccount({
            deleteSession: vi.fn(async () => { throw Object.assign(new Error('down'), { code: 503 }) }),
            createSession: vi.fn(async () => { throw appwriteError('user_session_already_exists', 401) }),
        })
        const { store } = loadPasskey({ account, store: guestStore })
        const result = await store.loginPasskey()
        expect(result).toMatchObject({ success: false, guestEnded: false })
        expect(store.isAnonymous).toBe(true)
        expect(store.user.$id).toBe('guest-1')
    })
})

describe('passkey: browsers without the JSON helpers', () => {
    it('decodes options and encodes the credential by hand', async () => {
        const b64 = bytes => Buffer.from(bytes).toString('base64url')
        const account = fullAccount({
            createPasskeyToken: vi.fn(async () => ({
                $id: 'ch-1',
                publicKey: { challenge: b64([1, 2, 3]), rpId: 'localhost', allowCredentials: [{ id: b64([9, 9]), type: 'public-key' }] },
            })),
        })
        const raw = bytes => new Uint8Array(bytes).buffer
        const credentials = {
            create: vi.fn(),
            get: vi.fn(async () => ({
                id: 'cred-1', rawId: raw([7, 8]), type: 'public-key', authenticatorAttachment: 'platform',
                response: { clientDataJSON: raw([1]), authenticatorData: raw([2]), signature: raw([3]), userHandle: raw([4]) },
                getClientExtensionResults: () => ({}),
            })),
        }
        const { store, ctx } = loadPasskey({ account, credentials })
        delete ctx.window.PublicKeyCredential.parseRequestOptionsFromJSON

        const result = await store.loginPasskey()
        expect(result.success).toBe(true)
        const options = credentials.get.mock.calls[0][0].publicKey
        expect(Array.from(new Uint8Array(options.challenge))).toEqual([1, 2, 3])
        expect(Array.from(new Uint8Array(options.allowCredentials[0].id))).toEqual([9, 9])
        expect(account.updatePasskeyToken.mock.calls[0][0].credential).toEqual({
            id: 'cred-1', rawId: b64([7, 8]), type: 'public-key', authenticatorAttachment: 'platform',
            clientExtensionResults: {},
            response: { clientDataJSON: b64([1]), authenticatorData: b64([2]), signature: b64([3]), userHandle: b64([4]) },
        })
    })
})
