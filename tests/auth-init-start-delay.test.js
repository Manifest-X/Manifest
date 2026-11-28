/**
 * Auth main attaches its post-init work (callbacks, guest-auto) after a fixed start delay that
 * lets the other auth modules attach. An init that finishes inside that delay still gets it.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, noSession } from './helpers/auth-boot-harness.js'

describe('post-init work when init beats the start delay', () => {
    it('guest-auto still creates a guest after a fast 401', async () => {
        let first = true
        const { fake, store, events } = boot({
            cfg: { teams: false, guestAuto: true },
            responder: (name) => {
                if (name === 'account.get' && first) { first = false; return noSession() }
                if (name === 'account.createAnonymousSession') return { $id: 'g1', provider: 'anonymous' }
                if (name === 'account.get') return { $id: 'guest' }
            },
        })
        await until(() => events.some(e => e.type === 'initialized'))
        expect(store._initAnnounced).toBe(true)
        await until(() => store.isAnonymous, 2000)
        expect(fake.names()).toEqual(['account.get', 'account.createAnonymousSession', 'account.get'])
    })

    it('a callback in the URL is processed once after a fast signed-in init', async () => {
        const user = { $id: 'uA' }
        const page = boot({
            cfg: { teams: false },
            persisted: { isAuthenticated: true, isAnonymous: false, user },
            search: '?userId=uA&secret=s&teamId=t1&membershipId=m1',
            responder: (name) => ({ 'account.get': user, 'account.listSessions': { sessions: [{ $id: 's1', current: true, provider: 'email' }] } })[name],
        })
        const seen = []
        page.window.ManifestAppwriteAuthCallbacks.process = info => seen.push(info)
        await until(() => page.events.some(e => e.type === 'initialized'))
        await sleep(300)
        expect(seen).toHaveLength(1)
        expect(seen[0].isTeamInvite).toBe(true)
    })

    it('a slow init is handled once, as before', async () => {
        let first = true
        const { fake, store } = boot({
            cfg: { teams: false, guestAuto: true },
            responder: (name, arg, entry) => {
                if (name === 'account.get' && first) { first = false; setTimeout(() => entry.reject(noSession()), 250); return undefined }
                if (name === 'account.createAnonymousSession') return { $id: 'g1', provider: 'anonymous' }
                if (name === 'account.get') return { $id: 'guest' }
            },
        })
        await until(() => store.isAnonymous, 2000)
        await sleep(100)
        expect(fake.names().filter(n => n === 'account.createAnonymousSession')).toHaveLength(1)
    })
})

describe('early entry: DOMContentLoaded before alpine:init', () => {
    // Auth main is entered from DOMContentLoaded; alpine:init (store + init) lands 140 ms later, so main's
    // store poll finds a finished init before the other modules' 100 ms attach timers have run
    const unhandled = []
    const onUnhandled = e => unhandled.push(e)

    it('guest-auto waits for the anonymous module and creates the guest', async () => {
        let first = true
        const page = boot({
            alpineInitAfter: 140,
            cfg: { teams: false, guestAuto: true },
            responder: (name) => {
                if (name === 'account.get' && first) { first = false; return noSession() }
                if (name === 'account.createAnonymousSession') return { $id: 'g1', provider: 'anonymous' }
                if (name === 'account.get') return { $id: 'guest' }
            },
        })
        await until(() => page.getStore()?.isAnonymous, 2000)
        expect(page.fake.names()).toEqual(['account.get', 'account.createAnonymousSession', 'account.get'])
    })

    it('a magic-link callback waits for the magic module instead of calling an undefined method', async () => {
        process.on('unhandledRejection', onUnhandled)
        try {
            let signedIn = false
            const page = boot({
                alpineInitAfter: 140,
                cfg: { teams: false },
                search: '?userId=uA&secret=s3',
                local: { 'manifest:magic-link:requested': JSON.stringify([{ u: 'uA', t: Date.now() }]) },
                responder: (name) => {
                    if (name === 'account.get') return signedIn ? { $id: 'uA' } : noSession()
                    if (name === 'account.createSession') { signedIn = true; return { $id: 's1', provider: 'magic-url' } }
                    if (name === 'account.getSession') return { $id: 's1', provider: 'magic-url' }
                    if (name === 'account.listSessions') return { sessions: [{ $id: 's1', current: true, provider: 'magic-url' }] }
                },
            })
            await until(() => page.fake.names().includes('account.createSession'), 2000)
            expect(page.fake.calls.find(c => c.name === 'account.createSession').args).toEqual(['uA', 's3'])
            await sleep(50)
            expect(unhandled).toEqual([])
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('the normal path is not delayed: post-init work runs as soon as init is announced', async () => {
        let first = true
        let created = 0
        const page = boot({
            cfg: { teams: false, guestAuto: true },
            responder: (name, arg, entry) => {
                if (name === 'account.get' && first) { first = false; setTimeout(() => entry.reject(noSession()), 250); return undefined }
                if (name === 'account.createAnonymousSession') { created = Date.now(); return { $id: 'g1', provider: 'anonymous' } }
                if (name === 'account.get') return { $id: 'guest' }
            },
        })
        await until(() => page.events.some(e => e.type === 'initialized'))
        const announced = Date.now()
        await until(() => created > 0, 2000)
        expect(created - announced).toBeLessThan(30)
    })
})
