/**
 * @vitest-environment happy-dom
 *
 * $biometric / $secure native adapters against the real shapes Capacitor injects
 * for @aparajita/capacitor-biometric-auth, @capgo/capacitor-native-biometric and
 * @aparajita/capacitor-secure-storage (plain objects of native methods + headers),
 * and against a bundled registerPlugin Proxy (every property is a function).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.device.js'), 'utf8')

let magics
function boot(plugins, headers) {
    magics = {}
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: plugins, PluginHeaders: headers }
    window.Alpine = { magic: (n, fn) => { magics[n] = fn() }, store: () => {} }
    new Function(CODE)()
    window.ensureManifestNativeInitialized()
}
const header = (name, methods) => ({ name, methods: methods.map(m => ({ name: m, rtype: 'promise' })) })

// Capacitor's bundled proxy: any property is a callable that rejects if unimplemented.
function capProxy(impl) {
    return new Proxy({}, { get: (_, p) => impl[p] || (async () => { throw Object.assign(new Error(`"${String(p)}()" is not implemented on ios`), { code: 'UNIMPLEMENTED' }) }) })
}

function aparajitaSecure() {
    const store = new Map()
    return {
        store,
        internalGetItem: vi.fn(async ({ prefixedKey }) => ({ data: store.has(prefixedKey) ? store.get(prefixedKey) : null })),
        internalSetItem: vi.fn(async ({ prefixedKey, data }) => { store.set(prefixedKey, data) }),
        internalRemoveItem: vi.fn(async ({ prefixedKey }) => ({ success: store.delete(prefixedKey) })),
        internalClearItemsWithPrefix: vi.fn(async ({ prefix }) => { for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k) }),
        internalGetPrefixedKeys: vi.fn(async ({ prefix }) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)) }))
    }
}
const SECURE_METHODS = ['setSynchronizeKeychain', 'internalSetItem', 'internalGetItem', 'internalRemoveItem', 'internalClearItemsWithPrefix', 'internalGetPrefixedKeys']

beforeEach(() => {
    delete window.Capacitor
    delete window.Alpine
    vi.restoreAllMocks()
})

describe('$biometric', () => {
    it('finds @aparajita/capacitor-biometric-auth (BiometricAuthNative) and calls its native methods', async () => {
        const B = {
            checkBiometry: vi.fn(async () => ({ isAvailable: true, biometryType: 2 })),
            internalAuthenticate: vi.fn(async () => {})
        }
        boot({ BiometricAuthNative: B }, [header('BiometricAuthNative', ['checkBiometry', 'internalAuthenticate'])])
        expect(await magics.biometric.available()).toBe(true)
        expect(await magics.biometric.verify({ reason: 'Unlock', title: 'T', cancelTitle: 'No' })).toEqual({ verified: true })
        expect(B.internalAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Unlock', androidTitle: 'T', cancelTitle: 'No' }))
    })

    it('surfaces the aparajita rejection code', async () => {
        const B = { checkBiometry: async () => ({ isAvailable: true }), internalAuthenticate: async () => { throw Object.assign(new Error('Canceled'), { code: 'userCancel' }) } }
        boot({ BiometricAuthNative: B }, [header('BiometricAuthNative', ['checkBiometry', 'internalAuthenticate'])])
        expect(await magics.biometric.verify({ reason: 'x' })).toEqual({ verified: false, error: 'Canceled', code: 'userCancel' })
    })

    it('works with the bundled aparajita proxy (header decides, not typeof)', async () => {
        const B = capProxy({ checkBiometry: async () => ({ isAvailable: true }), internalAuthenticate: vi.fn(async () => {}) })
        boot({ BiometricAuthNative: B }, [header('BiometricAuthNative', ['checkBiometry', 'internalAuthenticate'])])
        expect(await magics.biometric.available()).toBe(true)
        expect(await magics.biometric.verify({})).toEqual({ verified: true })
    })

    it('finds @capgo/capacitor-native-biometric (NativeBiometric)', async () => {
        const B = { isAvailable: vi.fn(async () => ({ isAvailable: true })), verifyIdentity: vi.fn(async () => {}) }
        boot({ NativeBiometric: B }, [header('NativeBiometric', ['isAvailable', 'verifyIdentity'])])
        expect(await magics.biometric.available()).toBe(true)
        expect(await magics.biometric.verify({ reason: 'r', title: 't' })).toEqual({ verified: true })
        expect(B.verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ reason: 'r', title: 't' }))
    })

    it('reports unsupported with no plugin', async () => {
        boot({}, [])
        expect(await magics.biometric.available()).toBe(false)
        expect(await magics.biometric.verify()).toEqual({ verified: false, error: 'unsupported' })
    })

    it('warns instead of silently failing an availability check', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        boot({ NativeBiometric: { isAvailable: async () => { throw new Error('boom') } } })
        expect(await magics.biometric.available()).toBe(false)
        expect(warn).toHaveBeenCalled()
    })
})

describe('$secure', () => {
    it('stores and reads through @aparajita/capacitor-secure-storage native methods', async () => {
        const S = aparajitaSecure()
        boot({ SecureStorage: S }, [header('SecureStorage', SECURE_METHODS)])
        await magics.secure.set('token', 'abc')
        expect(S.store.get('capacitor-storage_token')).toBe('abc')
        expect(await magics.secure.get('token')).toBe('abc')
        expect(await magics.secure.get('missing')).toBe(null)
        expect(await magics.secure.keys()).toEqual(['token'])
        await magics.secure.remove('token')
        expect(await magics.secure.get('token')).toBe(null)
        await magics.secure.set('a', 1)
        await magics.secure.clear()
        expect(S.store.size).toBe(0)
    })

    it('uses the native methods behind a bundled proxy', async () => {
        const S = aparajitaSecure()
        boot({ SecureStorage: capProxy(S) }, [header('SecureStorage', SECURE_METHODS)])
        await magics.secure.set('k', 'v')
        expect(await magics.secure.get('k')).toBe('v')
    })

    it('surfaces native errors instead of swallowing them', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        const S = aparajitaSecure()
        S.internalSetItem = async () => { throw Object.assign(new Error('Keychain locked'), { code: 'osError' }) }
        boot({ SecureStorage: S }, [header('SecureStorage', SECURE_METHODS)])
        await expect(magics.secure.set('k', 'v')).rejects.toThrow('Keychain locked')
        expect(err).toHaveBeenCalled()
    })

    it('rejects on an unrecognised plugin shape', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        boot({ SecureStorage: { somethingElse() {} } }, [header('SecureStorage', ['somethingElse'])])
        await expect(magics.secure.get('k')).rejects.toThrow(/no supported API/)
    })

    it('still adapts getItem/setItem and get/set shapes', async () => {
        const m = new Map()
        boot({ SecureStorage: { getItem: async k => m.get(k) ?? null, setItem: async (k, v) => { m.set(k, v) }, removeItem: async k => { m.delete(k) } } })
        await magics.secure.set('a', 'b')
        expect(await magics.secure.get('a')).toBe('b')

        const o = new Map()
        boot({ SecureStorage: { get: async ({ key }) => ({ value: o.get(key) }), set: async ({ key, value }) => { o.set(key, value) }, remove: async ({ key }) => { o.delete(key) } } })
        await magics.secure.set('c', 'd')
        expect(o.get('c')).toBe('d')
    })
})
