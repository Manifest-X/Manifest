/**
 * Boot teams prefetch: teams.list goes out with the identity check when this browser last
 * mirrored a signed-in state, and is applied only once identity confirms that same user.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, noSession, offline } from './helpers/auth-boot-harness.js'

const userA = { $id: 'uA', email: 'a@x' }
const userB = { $id: 'uB', email: 'b@x' }
const emailSession = { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
const guestSession = { sessions: [{ $id: 'g1', current: true, provider: 'anonymous' }] }
const persistedA = { isAuthenticated: true, isAnonymous: false, user: userA }
const cfg = { teams: true, guestTeams: false, memberRoles: { Admin: ['inviteMembers', 'manageRoles'], Viewer: [] } }
const teamsA = { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 }
const teamsB = { teams: [{ $id: 'tB', name: 'Bee' }], total: 1 }

// Answers by name; `hold` names stay pending for the test to settle
function responder({ user = userA, sessions = emailSession, teams = teamsA, hold = [], over = {} } = {}) {
    return (name, arg) => {
        if (hold.includes(name)) return undefined
        if (name in over) return typeof over[name] === 'function' ? over[name](arg) : over[name]
        return {
            'account.get': user,
            'account.listSessions': sessions,
            'account.deleteSession': {},
            'teams.list': teams,
            'teams.listMemberships': { memberships: [{ $id: 'm1', userId: user.$id, roles: ['Admin', 'owner'], confirm: true }], total: 1 },
            'teams.getPrefs': { roles: { Custom: ['renameTeam'] } },
            'teams.create': { $id: 'new' },
        }[name]
    }
}

// Store state at teams-loaded for a signed-in boot on master (recorded from master's sources)
const MASTER_SIGNED_IN = {
    isAuthenticated: true, isAnonymous: false, user: 'uA', session: 's1',
    teams: ['t1', 't2'], currentTeam: 't1', memberships: [['m1', ['Admin']]],
    deletedTemplateRoles: [], deletedTemplateTeams: [],
    permissions: { inviteMembers: true, updateMembers: false, removeMembers: false, renameTeam: false, deleteTeam: false, manageRoles: true },
    userRole: 'Admin',
    allRoles: { Admin: ['inviteMembers', 'manageRoles'], Viewer: [], Custom: ['renameTeam'] },
}

const types = events => events.map(e => e.type)
const waitFor = (events, type) => until(() => events.some(e => e.type === type))
const count = (fake, name) => fake.names().filter(n => n === name).length

describe('boot teams prefetch', () => {
    it('account.get, listSessions and teams.list are all in flight before any resolves; events and state as on master', async () => {
        const { fake, events, store } = boot({ cfg, persisted: persistedA, responder: responder({ hold: ['account.get', 'account.listSessions', 'teams.list'] }) })
        await until(() => fake.names().includes('teams.list'))
        expect(fake.names().slice(0, 3).sort()).toEqual(['account.get', 'account.listSessions', 'teams.list'])
        expect(fake.calls.slice(0, 3).every(c => !c.settled)).toBe(true)
        fake.settle('teams.list', teamsA)
        fake.settle('account.listSessions', emailSession)
        fake.settle('account.get', userA)
        await waitFor(events, 'teams-loaded')
        await sleep(20)
        expect(types(events)).toEqual(['initialized', 'teams-loaded'])
        expect(events[0].store.teams).toEqual([])
        expect(events[1].store).toEqual(MASTER_SIGNED_IN)
        expect(count(fake, 'teams.list')).toBe(1)
        expect(store.teams.map(t => t.$id)).toEqual(['t1', 't2'])
    })

    it('a signed-out visitor with nothing persisted sends no teams.list', async () => {
        const { fake, events } = boot({ cfg, responder: responder({ over: { 'account.get': noSession() } }) })
        await waitFor(events, 'initialized')
        await sleep(150)
        expect(fake.names()).toEqual(['account.get'])
        expect(types(events)).toEqual(['initialized'])
    })

    it('persisted signed-in but the session is gone: the prefetched teams leave nothing behind and nothing is seeded', async () => {
        const seeding = { ...cfg, templateTeams: ['Acme'], permanentTeams: ['Home'] }
        const { fake, events, store, window } = boot({
            cfg: seeding, persisted: persistedA,
            responder: responder({ over: { 'account.get': noSession(), 'account.listSessions': noSession() } }),
        })
        await waitFor(events, 'initialized')
        await sleep(300)
        expect(fake.names().sort()).toEqual(['account.get', 'account.listSessions', 'teams.list'])
        expect(store.teams).toEqual([])
        expect(store.currentTeam).toBe(null)
        expect(store.currentTeamMemberships).toEqual([])
        expect(store.isAuthenticated).toBe(false)
        expect(JSON.parse(window.localStorage.getItem('manifest:auth:state')).isAuthenticated).toBe(false)
        expect(types(events)).toEqual(['initialized'])
    })

    it("persisted user A but the session is user B: A's prefetched teams are not applied and B's are listed", async () => {
        let lists = 0
        const { fake, events, store } = boot({
            cfg, persisted: persistedA,
            responder: responder({ user: userB, over: { 'teams.list': () => (++lists === 1 ? teamsA : teamsB) } }),
        })
        await waitFor(events, 'teams-loaded')
        expect(count(fake, 'teams.list')).toBe(2)
        // The second list goes out only after identity is known
        const second = fake.calls.filter(c => c.name === 'teams.list')[1]
        expect(second.inflightAtStart).not.toContain('account.get')
        expect(store.user.$id).toBe('uB')
        expect(store.teams.map(t => t.$id)).toEqual(['tB'])
        expect(store.currentTeam.$id).toBe('tB')
    })

    it('a guest with teams.guests prefetches; without it no teams.list is sent', async () => {
        const guestPersisted = { ...persistedA, isAnonymous: true }
        const withGate = boot({ cfg: { ...cfg, guestTeams: true, guestManual: true }, persisted: guestPersisted, responder: responder({ sessions: guestSession, hold: ['account.get'] }) })
        await until(() => withGate.fake.names().includes('teams.list'))
        expect(withGate.fake.calls.find(c => c.name === 'teams.list').inflightAtStart).toContain('account.get')
        withGate.fake.settle('account.get', userA)
        await waitFor(withGate.events, 'teams-loaded')
        expect(withGate.store.isAnonymous).toBe(true)
        expect(count(withGate.fake, 'teams.list')).toBe(1)
        expect(withGate.store.teams.map(t => t.$id)).toEqual(['t1', 't2'])

        const noGate = boot({ cfg: { ...cfg, guestTeams: false, guestManual: true }, persisted: guestPersisted, responder: responder({ sessions: guestSession }) })
        await waitFor(noGate.events, 'initialized')
        await sleep(150)
        expect(noGate.fake.names()).toEqual(['account.get', 'account.listSessions'])
        expect(noGate.store.isAnonymous).toBe(true)
        expect(noGate.store.teams).toEqual([])
    })

    it('a session that turns out to be a guest without teams.guests discards the prefetch', async () => {
        const { fake, events, store } = boot({ cfg: { ...cfg, guestManual: true }, persisted: persistedA, responder: responder({ sessions: guestSession }) })
        await waitFor(events, 'initialized')
        await sleep(150)
        expect(count(fake, 'teams.list')).toBe(1)
        expect(store.isAnonymous).toBe(true)
        expect(store.teams).toEqual([])
        expect(store.currentTeam).toBe(null)
        expect(types(events)).toEqual(['initialized'])
    })

    it('guests disabled: a persisted guest is not prefetched and its session is deleted', async () => {
        const { fake, events, store } = boot({ cfg, persisted: { ...persistedA, isAnonymous: true }, responder: responder({ sessions: guestSession }) })
        await waitFor(events, 'initialized')
        await sleep(150)
        expect(fake.names()).toEqual(['account.get', 'account.listSessions', 'account.deleteSession'])
        expect(store.isAuthenticated).toBe(false)
        expect(store.teams).toEqual([])
    })

    it('a failed prefetch falls back to a normal teams.list', async () => {
        let lists = 0
        const { fake, events, store } = boot({ cfg, persisted: persistedA, responder: responder({ over: { 'teams.list': () => (++lists === 1 ? offline() : teamsA) } }) })
        await waitFor(events, 'teams-loaded')
        expect(count(fake, 'teams.list')).toBe(2)
        expect(store.teams.map(t => t.$id)).toEqual(['t1', 't2'])
        expect(store.error).toBe(null)
    })

    it('logout while the prefetch is in flight discards it', async () => {
        const { fake, events, store } = boot({ cfg, persisted: persistedA, responder: responder({ hold: ['teams.list'] }) })
        await waitFor(events, 'initialized')
        await until(() => typeof store.listTeams === 'function' && store.isAuthenticated)
        await sleep(120)
        await store.logout()
        fake.settle('teams.list', teamsA)
        await sleep(150)
        expect(store.isAuthenticated).toBe(false)
        expect(store.teams).toEqual([])
        expect(store.currentTeam).toBe(null)
        expect(count(fake, 'teams.listMemberships')).toBe(0)
        expect(types(events)).not.toContain('teams-loaded')
    })

    it('a sign-in during the prefetch (auth epoch bump) refetches instead of using it', async () => {
        const { fake, events, store, window } = boot({ cfg, persisted: persistedA, responder: responder({ hold: ['teams.list'] }) })
        await waitFor(events, 'initialized')
        await sleep(120) // listTeams attached and awaiting the prefetch
        window.dispatchEvent(new window.CustomEvent('manifest:auth:login', { detail: { user: userA } }))
        fake.settle('teams.list', { teams: [{ $id: 'stale', name: 'Stale' }], total: 1 })
        await until(() => count(fake, 'teams.list') === 2)
        fake.settle('teams.list', teamsA)
        await waitFor(events, 'teams-loaded')
        expect(store.teams.map(t => t.$id)).toEqual(['t1', 't2'])
    })

    it('an identity change from another tab before identity resolves skips the prefetch', async () => {
        const { fake, events, store } = boot({ cfg, persisted: persistedA, responder: responder({ hold: ['account.get'] }) })
        await until(() => fake.names().includes('teams.list'))
        store._authEpoch++ // what the storage-event handler does
        fake.settle('account.get', userA)
        await waitFor(events, 'teams-loaded')
        expect(count(fake, 'teams.list')).toBe(2)
        expect(store.teams.map(t => t.$id)).toEqual(['t1', 't2'])
    })
})
