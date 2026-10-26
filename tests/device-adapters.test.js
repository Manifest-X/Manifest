/**
 * @vitest-environment happy-dom
 *
 * $biometric / $secure native adapters against the real shapes Capacitor injects
 * for @aparajita/capacitor-biometric-auth, @capgo/capacitor-native-biometric and
 * @aparajita/capacitor-secure-storage (plain objects of native methods + headers),
 * and against a bundled registerPlugin Proxy (every property is a function).
 * The other adapters: native plugin only inside the container; bundled web
 * builds use Manifest's web fallbacks, never the plugin's web stub.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.device.js'), 'utf8')

let magics
function boot(plugins, headers, native = true) {
    magics = {}
    window.Capacitor = { isNativePlatform: () => native, getPlatform: () => 'ios', Plugins: plugins, PluginHeaders: headers }
    const stores = {}
    window.Alpine = { magic: (n, fn) => { magics[n] = fn() }, store: (n, v) => { if (v === undefined) return stores[n]; stores[n] = v } }
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
        expect(B.verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ reason: 'r', description: 'r', title: 't' }))
    })

    it('picks the natively installed plugin when several are JS-registered', async () => {
        const A = capProxy({})
        const C = { isAvailable: vi.fn(async () => ({ isAvailable: true })), verifyIdentity: vi.fn(async () => {}) }
        boot({ BiometricAuthNative: A, NativeBiometric: C }, [header('NativeBiometric', ['isAvailable', 'verifyIdentity'])])
        expect(await magics.biometric.available()).toBe(true)
        expect(await magics.biometric.verify({ reason: 'r' })).toEqual({ verified: true })
        expect(C.verifyIdentity).toHaveBeenCalled()
    })

    it('reports unavailable when no registered plugin is native', async () => {
        const A = capProxy({}), C = capProxy({})
        boot({ BiometricAuthNative: A, NativeBiometric: C }, [header('App', ['getState'])])
        expect(await magics.biometric.available()).toBe(false)
        expect(await magics.biometric.verify({})).toEqual({ verified: false, error: 'unsupported' })
    })

    it('keeps the first registered plugin without a header list', async () => {
        const A = { checkBiometry: vi.fn(async () => ({ isAvailable: true })), internalAuthenticate: vi.fn(async () => {}) }
        const C = { isAvailable: vi.fn(async () => ({ isAvailable: true })), verifyIdentity: vi.fn(async () => {}) }
        boot({ BiometricAuthNative: A, NativeBiometric: C })
        expect(await magics.biometric.available()).toBe(true)
        expect(A.checkBiometry).toHaveBeenCalled()
        expect(C.isAvailable).not.toHaveBeenCalled()
    })

    it('ignores plugin web stubs in a bundled web build (no native verify off-device)', async () => {
        const B = { isAvailable: vi.fn(async () => ({ isAvailable: true })), verifyIdentity: vi.fn(async () => {}) }
        boot({ NativeBiometric: B }, undefined, false)
        expect(await magics.biometric.available()).toBe(false)
        expect(await magics.biometric.verify({ reason: 'r' })).toEqual({ verified: false, error: 'unsupported' })
        expect(B.isAvailable).not.toHaveBeenCalled()
        expect(B.verifyIdentity).not.toHaveBeenCalled()
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

    it('uses the localStorage fallback in a bundled web build, not the plugin', async () => {
        const S = aparajitaSecure()
        localStorage.clear()
        boot({ SecureStorage: S }, [header('SecureStorage', SECURE_METHODS)], false)
        await magics.secure.set('k', 'v')
        expect(localStorage.getItem('mnfst:k')).toBe('v')
        expect(S.internalSetItem).not.toHaveBeenCalled()
    })

    it('handles an empty key without calling native', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const S = aparajitaSecure()
        boot({ SecureStorage: S }, [header('SecureStorage', SECURE_METHODS)])
        expect(await magics.secure.get('')).toBe(null)
        await magics.secure.remove('')
        await expect(magics.secure.set('', 'v')).rejects.toThrow(/No key/)
        expect(S.internalGetItem).not.toHaveBeenCalled()
        expect(S.internalRemoveItem).not.toHaveBeenCalled()
        expect(S.internalSetItem).not.toHaveBeenCalled()
    })

    it('rejects remove() on an item-shaped plugin without removeItem', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const remove = vi.fn()
        boot({ SecureStorage: { getItem: async () => null, setItem: async () => {}, remove } })
        await expect(magics.secure.remove('a')).rejects.toThrow(/removeItem/)
        expect(remove).not.toHaveBeenCalled()
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

// Bundled web build: registerPlugin proxy whose calls are recorded.
function webProxy() {
    const calls = []
    const proxy = new Proxy({}, { get: (_, p) => (...a) => { calls.push(String(p)); return Promise.reject(Object.assign(new Error('not implemented on web'), { code: 'UNIMPLEMENTED' })) } })
    return { proxy, calls }
}
const flush = () => new Promise(r => setTimeout(r, 0))

describe('$share', () => {
    it('uses the native sheet in the container', async () => {
        const S = { share: vi.fn(async () => ({})) }
        boot({ Share: S }, [header('Share', ['canShare', 'share'])])
        expect(await magics.share({ url: 'https://x.test' })).toEqual({ shared: true, method: 'native' })
        expect(S.share).toHaveBeenCalled()
    })

    it('falls back to web share / clipboard in a bundled web build', async () => {
        const { proxy, calls } = webProxy()
        const writeText = vi.fn(async () => {})
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
        boot({ Share: proxy }, undefined, false)
        expect(await magics.share({ url: 'https://x.test' })).toEqual({ shared: true, method: 'clipboard' })
        expect(writeText).toHaveBeenCalledWith('https://x.test')
        expect(calls).toEqual([])
    })
})

describe('$haptics', () => {
    it('calls native Haptics in the container', async () => {
        const H = { impact: vi.fn(async () => {}), selectionChanged: vi.fn(async () => {}) }
        boot({ Haptics: H }, [header('Haptics', ['impact', 'notification', 'vibrate', 'selectionStart', 'selectionChanged', 'selectionEnd'])])
        await magics.haptics.impact('LIGHT')
        await magics.haptics.selection()
        expect(H.impact).toHaveBeenCalledWith({ style: 'LIGHT' })
        expect(H.selectionChanged).toHaveBeenCalled()
    })

    it('vibrates (or no-ops) in a bundled web build without rejecting', async () => {
        const { proxy, calls } = webProxy()
        const vibrate = vi.fn(() => true)
        Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
        boot({ Haptics: proxy }, undefined, false)
        await expect(magics.haptics.impact()).resolves.toBeUndefined()
        expect(vibrate).toHaveBeenCalled()
        Object.defineProperty(navigator, 'vibrate', { value: undefined, configurable: true })
        await expect(magics.haptics.notification()).resolves.toBeUndefined()
        expect(calls).toEqual([])
    })

    it('skips a JS-registered plugin with no native header', async () => {
        const { proxy, calls } = webProxy()
        boot({ Haptics: proxy }, [header('App', ['getState'])])
        await expect(magics.haptics.vibrate(20)).resolves.toBeUndefined()
        expect(calls).toEqual([])
    })
})

describe('$camera', () => {
    it('calls native getPhoto in the container', async () => {
        const C = { getPhoto: vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,x', format: 'jpeg' })) }
        boot({ Camera: C }, [header('Camera', ['getPhoto', 'pickImages'])])
        expect(await magics.camera.pick()).toEqual({ dataUrl: 'data:image/jpeg;base64,x', format: 'jpeg' })
        expect(C.getPhoto).toHaveBeenCalledWith(expect.objectContaining({ source: 'PHOTOS', resultType: 'dataUrl' }))
    })

    it('uses the file-input fallback in a bundled web build', async () => {
        const { proxy, calls } = webProxy()
        boot({ Camera: proxy }, undefined, false)
        magics.camera.photo()
        const input = document.querySelector('input[type=file]')
        expect(input).toBeTruthy()
        expect(input.getAttribute('capture')).toBe('environment')
        expect(calls).toEqual([])
        input.remove()
    })
})

describe('$push', () => {
    it('requests permission and listens natively in the container', async () => {
        const P = { addListener: vi.fn(), requestPermissions: vi.fn(async () => ({ receive: 'granted' })), register: vi.fn(async () => {}) }
        boot({ PushNotifications: P }, [header('PushNotifications', ['register', 'requestPermissions', 'checkPermissions'])])
        expect(await magics.push.request()).toBe('granted')
        await magics.push.register()
        expect(P.register).toHaveBeenCalled()
        expect(P.addListener.mock.calls.map(c => c[0])).toEqual(['registration', 'pushNotificationReceived', 'pushNotificationActionPerformed'])
    })

    it('uses the Notification API in a bundled web build (plugin has no web impl)', async () => {
        const { proxy, calls } = webProxy()
        window.Notification = { permission: 'default', requestPermission: vi.fn(async () => 'granted') }
        boot({ PushNotifications: proxy }, undefined, false)
        expect(magics.push.permission).toBe('prompt')
        expect(await magics.push.request()).toBe('granted')
        await magics.push.register()
        expect(calls).toEqual([])
        delete window.Notification
    })
})

describe('$app / $links', () => {
    it('listens to native App events in the container', async () => {
        let onState
        const A = { addListener: vi.fn((e, fn) => { if (e === 'appStateChange') onState = fn }), getLaunchUrl: vi.fn(async () => ({ url: '' })) }
        boot({ App: A }, [header('App', ['getState', 'getLaunchUrl', 'getInfo'])])
        expect(A.addListener.mock.calls.map(c => c[0])).toEqual(['appUrlOpen', 'appStateChange'])
        expect(A.getLaunchUrl).toHaveBeenCalled()
        onState({ isActive: false })
        expect(magics.app.active).toBe(false)
    })

    it('uses document visibility in a bundled web build', async () => {
        const { proxy, calls } = webProxy()
        boot({ App: proxy }, undefined, false)
        const changes = []
        magics.app.onChange(a => changes.push(a))
        window.dispatchEvent(new Event('pagehide'))
        expect(magics.app.active).toBe(false)
        expect(changes).toEqual([false])
        expect(calls).toEqual([])
    })
})

describe('network', () => {
    it('reads native Network status in the container', async () => {
        const N = { getStatus: vi.fn(async () => ({ connected: false })), addListener: vi.fn() }
        boot({ Network: N }, [header('Network', ['getStatus'])])
        await flush()
        expect(document.documentElement.getAttribute('data-online')).toBe('false')
        expect(N.addListener).toHaveBeenCalledWith('networkStatusChange', expect.any(Function))
    })

    it('leaves the web build to the base $device signal', async () => {
        const { proxy, calls } = webProxy()
        document.documentElement.removeAttribute('data-online')
        boot({ Network: proxy }, undefined, false)
        await flush()
        expect(calls).toEqual([])
        expect(document.documentElement.getAttribute('data-online')).toBe(null)
    })
})
