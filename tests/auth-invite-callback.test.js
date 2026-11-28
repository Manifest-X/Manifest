/**
 * Invite links (?teamId&membershipId&userId&secret) are accepted on page load. An invite whose
 * userId is not the signed-in user's is refused without calling Appwrite, and the URL is cleaned
 * as for any handled callback. A matching userId and a signed-out visitor behave as before.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, noSession } from './helpers/auth-boot-harness.js'

const victim = { $id: 'victim', email: 'v@x.test' }
const signedIn = { isAuthenticated: true, isAnonymous: false, user: victim }
const invite = who => `?teamId=t9&membershipId=m9&userId=${who}&secret=SECRET`

function start({ search, persisted = signedIn, signedOut = false }) {
    const p = boot({
        cfg: { teams: true }, persisted, search,
        responder: (name, arg) => {
            switch (name) {
                case 'account.get': return signedOut ? noSession() : victim
                case 'account.listSessions': return signedOut ? noSession() : { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
                case 'teams.list': return { teams: [], total: 0 }
                case 'teams.listMemberships': return { memberships: [], total: 0 }
                case 'teams.updateMembershipStatus': return { $id: arg.membershipId, teamId: arg.teamId, userId: arg.userId }
            }
            return {}
        },
    })
    const urls = []
    p.window.history.replaceState = (state, title, url) => urls.push(url)
    const accepted = []
    p.window.addEventListener('manifest:auth:team:invite-accepted', e => accepted.push(e.detail))
    return { ...p, urls, accepted }
}
const statusCalls = p => p.fake.calls.filter(c => c.name === 'teams.updateMembershipStatus')
const handled = async p => { await until(() => p.urls.length > 0 && !p.store.inProgress); await sleep(30) }

describe('invite callback for the signed-in account', () => {
    it('a matching userId is accepted as before', async () => {
        const p = start({ search: invite('victim') })
        await handled(p)
        // The harness loads the module with Alpine present, so the team callback listener is attached twice
        expect(statusCalls(p).length).toBeGreaterThan(0)
        for (const c of statusCalls(p)) expect(c.args[0]).toEqual({ teamId: 't9', membershipId: 'm9', userId: 'victim', secret: 'SECRET' })
        expect(p.accepted.length).toBe(statusCalls(p).length)
        expect(p.urls).toEqual(['https://app.test/'])
    })

    it('a different userId is refused without calling Appwrite; the URL is cleaned', async () => {
        const p = start({ search: invite('attacker') })
        await handled(p)
        expect(statusCalls(p)).toEqual([])
        expect(p.accepted).toEqual([])
        expect(p.store.error).toBe('This invite is for a different account.')
        expect(p.store.user.$id).toBe('victim')
        expect(p.urls).toEqual(['https://app.test/'])
    })

    it('acceptInvite called directly with no userId still goes to Appwrite', async () => {
        const p = start({ search: '' })
        await until(() => p.events.some(e => e.type === 'teams-loaded'))
        const r = await p.store.acceptInvite('t9', 'm9', undefined, 'SECRET')
        expect(r.success).toBe(true)
        expect(statusCalls(p).length).toBe(1)
    })

    it('a link without userId is not treated as an invite callback (unchanged)', async () => {
        const p = start({ search: '?teamId=t9&membershipId=m9&secret=SECRET' })
        await until(() => p.events.some(e => e.type === 'teams-loaded'))
        await sleep(30)
        expect(statusCalls(p)).toEqual([])
    })
})

describe('invite callback for a signed-out visitor (unchanged)', () => {
    it('is refused with the sign-in error and no Appwrite call', async () => {
        const p = start({ search: invite('someone'), persisted: null, signedOut: true })
        await handled(p)
        expect(statusCalls(p)).toEqual([])
        expect(p.store.error).toBe('You must be signed in to accept an invitation')
        expect(p.urls).toEqual(['https://app.test/'])
    })
})
