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
