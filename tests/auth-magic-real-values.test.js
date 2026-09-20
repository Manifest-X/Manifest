/**
 * Regression: `$auth` must hand back real store values, never a stand-in object.
 *
 * The magic used to return a "loading proxy" for any null/undefined/missing
 * value. It stringified to '' so `x-text` looked right, but no object is falsy
 * — so `$auth.user?.name || $auth.user?.email` kept the proxy, and the ordinary
 * downstream `.split()` threw on every signed-out page load (reported by a
 * downstream project). `||`, `typeof` and truthiness all silently misbehaved.
 *
 * Loads the real frontend module and drives the registered magic.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_SRC = readFileSync(
    path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.frontend.js'),
    'utf8'
)

// Load the real module and return the $auth object the magic hands to templates.
function loadAuthMagic(store) {
    let magicFactory = null

    const ctx = {
        console,
        Promise,
        Alpine: {
            magic: (name, factory) => { if (name === 'auth') magicFactory = factory },
            store: name => (name === 'auth' ? store : null),
        },
        document: { readyState: 'complete', addEventListener: () => {} },
    }
    ctx.window = { Alpine: ctx.Alpine }
    ctx.global = ctx
    vm.createContext(ctx)
    vm.runInContext(FRONTEND_SRC, ctx)

    if (!magicFactory) throw new Error('frontend did not register the $auth magic')
    return magicFactory()
}

// A signed-out store: Appwrite resolved, nobody home.
const signedOut = () => ({
    user: null,
    userId: null,
    session: null,
    currentTeam: null,
    isAuthenticated: false,
    inProgress: false,
    getMethod: () => null,
    getProvider: () => null,
})

describe('$auth returns real values, not a placeholder object', () => {
    it('reports a signed-out user as null', () => {
        const $auth = loadAuthMagic(signedOut())
        expect($auth.user).toBe(null)
        expect($auth.session).toBe(null)
        expect($auth.currentTeam).toBe(null)
    })

    it('lets `?.` short-circuit instead of auto-vivifying', () => {
        const $auth = loadAuthMagic(signedOut())
        expect($auth.user?.name).toBeUndefined()
        expect(typeof $auth.user?.name).toBe('undefined')
        expect($auth.user?.zzz?.deeper).toBeUndefined()
    })

    it('lets `||` fall through to the caller fallback', () => {
        const $auth = loadAuthMagic(signedOut())
        expect($auth.user?.name || $auth.user?.email || 'a guest').toBe('a guest')
        expect(!!$auth.user).toBe(false)
    })

    // The exact idiom that threw "n.split is not a function".
    it('survives string work on the `||` result', () => {
        const $auth = loadAuthMagic(signedOut())
        const n = $auth.user?.name || $auth.user?.email || ''
        expect(typeof n).toBe('string')
        expect(() => n.split(/[\s@._-]+/)).not.toThrow()
    })

    // Same bug one level down: signed in, but the profile field is absent.
    it('reports a missing field on a real user as undefined', () => {
        const $auth = loadAuthMagic({
            ...signedOut(),
            user: { $id: 'u1', email: 'a@b.co' },
            isAuthenticated: true,
        })
        expect($auth.user.name).toBeUndefined()
        expect($auth.user?.name || $auth.user?.email).toBe('a@b.co')
        expect($auth.user.prefs?.theme).toBeUndefined()
    })

    it('reports an unknown property as undefined', () => {
        const $auth = loadAuthMagic(signedOut())
        expect($auth.noSuchThing).toBeUndefined()
        expect($auth.noSuchThing || 'fallback').toBe('fallback')
    })

    it('still passes real values through untouched', () => {
        const user = { $id: 'u1', email: 'a@b.co', prefs: { theme: 'dark' } }
        const $auth = loadAuthMagic({
            ...signedOut(),
            user,
            userId: 'u1',
            isAuthenticated: true,
            teams: [{ $id: 't1' }],
        })
        expect($auth.user).toEqual(user)
        expect($auth.user.prefs.theme).toBe('dark')
        expect($auth.userId).toBe('u1')
        expect($auth.isAuthenticated).toBe(true)
        expect(Array.isArray($auth.teams)).toBe(true)
    })

    it('still binds store methods to the store', () => {
        const store = { ...signedOut(), tag: 'me', whoAmI() { return this.tag } }
        const $auth = loadAuthMagic(store)
        expect($auth.whoAmI()).toBe('me')
    })

    // The convenience-method fallbacks are a separate path; keep them intact.
    it('still falls back for un-initialized team convenience methods', () => {
        const $auth = loadAuthMagic(signedOut())
        expect($auth.isCurrentTeamOwner()).toBe(false)
        expect($auth.getUserRole()).toBe(null)
    })
})
