/**
 * Starting team: auth.teams.remember starts each signed-in user on their last current team, and
 * $auth.startTeamId lets an app name one; both only when the user still has that team. A returning
 * user's members and prefs are fetched alongside the identity check.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, noSession, snapshot } from './helpers/auth-boot-harness.js'

const userA = { $id: 'uA' }
const userB = { $id: 'uB' }
const persistedA = { isAuthenticated: true, isAnonymous: false, user: userA }
const project = { endpoint: 'https://cloud.test/v1', projectId: 'p1' }
const cfg = { ...project, teams: true, memberRoles: { Admin: ['inviteMembers'], Viewer: [] } }
const remember = { ...cfg, remember: true, rememberTeam: true } // harness bypasses config parsing: rememberTeam is the parsed flag
const keyFor = (userId, p = project) => `manifest:auth:team:${p.endpoint}|${p.projectId}|${userId}`
const TEAMS = { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 }
const rolesIn = { t1: ['Admin', 'owner'], t2: ['Viewer', 'owner'], t9: ['Admin'] }

function start({ config = remember, user = userA, persisted = persistedA, local = {}, hold = new Set(), over = {}, onAlpineInit } = {}) {
    const state = { signedIn: true }
    const p = boot({
        cfg: config, persisted, local, onAlpineInit,
        responder: (name, arg) => {
            const key = `${name}:${arg?.teamId}`
            if (hold.has(name) || hold.has(key)) return undefined
            if (over[key]) return over[key]()
            if (over[name]) return over[name](arg)
            switch (name) {
                case 'account.get': return state.signedIn ? user : noSession()
                case 'account.listSessions': return state.signedIn ? { sessions: [{ $id: 's1', current: true, provider: 'email' }] } : noSession()
                case 'account.deleteSession': state.signedIn = false; return {}
                case 'teams.list': return TEAMS
                case 'teams.listMemberships': return { memberships: [{ $id: `m-${arg.teamId}`, userId: user.$id, roles: rolesIn[arg.teamId], confirm: true }], total: 1 }
                case 'teams.getPrefs': return { roles: {} }
            }
        },
    })
    return { ...p, state, stored: id => p.window.localStorage.getItem(keyFor(id)) }
}
const loaded = p => until(() => p.events.some(e => e.type === 'teams-loaded'))
const reqs = p => p.fake.calls.map(c => c.args[0]?.teamId ? `${c.name}(${c.args[0].teamId})` : c.name)

describe('auth.teams.remember', () => {
    it('first boot: default pick is remembered; viewTeam updates it', async () => {
        const p = start()
        await loaded(p)
        expect(p.store.currentTeam.$id).toBe('t1')
        await until(() => p.stored('uA') === 't1')
        await p.store.viewTeam(p.store.teams[1])
        await until(() => p.stored('uA') === 't2')
    })

    it('returning user starts on the remembered team in one round trip', async () => {
        const p = start({ local: { [keyFor('uA')]: 't2' }, hold: new Set(['account.get']) })
        await until(() => reqs(p).includes('teams.getPrefs(t2)'))
        expect(reqs(p).slice(0, 5).sort()).toEqual(['account.get', 'account.listSessions', 'teams.getPrefs(t2)', 'teams.list', 'teams.listMemberships(t2)'])
        expect(p.fake.calls.slice(0, 5).every(c => c.name === 'account.get' || c.inflightAtStart.includes('account.get'))).toBe(true)
        p.fake.settle('account.get', userA)
        await loaded(p)
        await sleep(20)
        expect(reqs(p)).toEqual(['account.get', 'account.listSessions', 'teams.list', 'teams.listMemberships(t2)', 'teams.getPrefs(t2)'])
        const at = p.events.find(e => e.type === 'teams-loaded').store
        expect(at.currentTeam).toBe('t2')
        expect(at.memberships).toEqual([['m-t2', ['Viewer']]])
        expect(at.permissions.inviteMembers).toBe(false)
        expect(at.userRole).toBe('Viewer')
    })

    it("another user on the same device never gets the first user's team", async () => {
        const p = start({ user: userB, persisted: { ...persistedA, user: userB }, local: { [keyFor('uA')]: 't2' } })
        await loaded(p)
        expect(p.store.currentTeam.$id).toBe('t1')
        expect(reqs(p).filter(r => r.startsWith('teams.listMemberships'))).toEqual(['teams.listMemberships(t1)'])
        await until(() => p.stored('uB') === 't1')
        expect(p.stored('uA')).toBe('t2')
    })

    it("another project's remembered team for the same user is not used", async () => {
        const p = start({ local: { [keyFor('uA', { endpoint: 'https://cloud.test/v1', projectId: 'other' })]: 't2' } })
        await loaded(p)
        expect(p.store.currentTeam.$id).toBe('t1')
    })

    it('a remembered team the user no longer has: prefetch discarded, default picked, stored id replaced', async () => {
        const p = start({ local: { [keyFor('uA')]: 't9' } })
        await loaded(p)
        await sleep(20)
        expect(p.store.currentTeam.$id).toBe('t1')
        expect(p.store.currentTeamMemberships.map(m => m.$id)).toEqual(['m-t1'])
        expect(reqs(p)).toEqual(['account.get', 'account.listSessions', 'teams.list', 'teams.listMemberships(t9)', 'teams.getPrefs(t9)', 'teams.listMemberships(t1)', 'teams.getPrefs(t1)'])
        expect(Object.keys(p.store._allRolesCacheByTeam)).toEqual(['t1'])
        await until(() => p.stored('uA') === 't1')
    })

    it('persisted user A but the session is user B: A\'s prefetch is not used', async () => {
        const p = start({ user: userB, local: { [keyFor('uA')]: 't2' } })
        await loaded(p)
        await sleep(20)
        expect(p.store.user.$id).toBe('uB')
        expect(p.store.currentTeam.$id).toBe('t1')
        expect(reqs(p).filter(r => r.startsWith('teams.listMemberships')).at(-1)).toBe('teams.listMemberships(t1)')
        expect(p.stored('uA')).toBe('t2')
    })

    it('session gone (401): nothing applied, nothing stored', async () => {
        const p = start({ local: { [keyFor('uA')]: 't2' } })
        p.state.signedIn = false
        await until(() => p.events.some(e => e.type === 'initialized'))
        await sleep(200)
        expect(p.store.currentTeam).toBe(null)
        expect(p.store.currentTeamMemberships).toEqual([])
        expect(p.stored('uA')).toBe('t2')
    })

    it('logout while the prefetch is in flight: discarded, nothing written', async () => {
        const p = start({ local: { [keyFor('uA')]: 't2' }, hold: new Set(['teams.listMemberships:t2', 'teams.getPrefs:t2']) })
        await until(() => p.events.some(e => e.type === 'initialized'))
        await until(() => p.store.currentTeam?.$id === 't2')
        await p.store.logout()
        p.fake.calls.filter(c => !c.settled && c.args[0]?.teamId === 't2').forEach(c => c.resolve(c.name === 'teams.getPrefs' ? { roles: {} } : { memberships: [{ $id: 'm-t2', userId: 'uA', roles: ['Viewer'], confirm: true }], total: 1 }))
        await sleep(50)
        expect(p.store.currentTeam).toBe(null)
        expect(p.store.currentTeamMemberships).toEqual([])
        expect(p.store._permissionCache).toEqual({})
    })

    it('a hung members prefetch is abandoned after the bounded wait', async () => {
        const p = start({ local: { [keyFor('uA')]: 't2' }, hold: new Set(['teams.listMemberships:t2']) , onAlpineInit: s => { s._prefetchWaitMs = 150 } })
        let lists = 0
        await until(() => reqs(p).filter(r => r === 'teams.listMemberships(t2)').length === 1)
        // answer every later t2 listing
        const orig = p.fake.appwrite.teams.listMemberships
        p.fake.appwrite.teams.listMemberships = a => { lists++; return Promise.resolve({ memberships: [{ $id: 'm-t2', userId: 'uA', roles: ['Viewer', 'owner'], confirm: true }], total: 1 }) }
        await loaded(p)
        expect(lists).toBe(1)
        expect(p.store.currentTeamMemberships.map(m => m.$id)).toEqual(['m-t2'])
        p.fake.appwrite.teams.listMemberships = orig
    })

    it('guests are not remembered', async () => {
        const guest = { ...persistedA, isAnonymous: true }
        const p = start({ config: { ...remember, guestTeams: true, guestManual: true }, persisted: guest, local: { [keyFor('uA')]: 't2' },
            over: { 'account.listSessions': () => ({ sessions: [{ $id: 'g', current: true, provider: 'anonymous' }] }) } })
        await loaded(p)
        await sleep(30)
        expect(p.store.isAnonymous).toBe(true)
        expect(p.store.currentTeam.$id).toBe('t1')
        expect(reqs(p).filter(r => r.startsWith('teams.listMemberships'))).toEqual(['teams.listMemberships(t1)'])
        expect(p.stored('uA')).toBe('t2')
    })

    it('seeding is unchanged: the same team creations with a remembered team as without', async () => {
        const seeding = { ...remember, templateTeams: ['Three'] }
        const creates = async local => {
            const p = start({ config: seeding, local, over: { 'teams.create': a => ({ $id: 'new', name: 'Three' }), 'teams.updatePrefs': () => ({}) } })
            await loaded(p)
            await sleep(30)
            return p.fake.names().filter(n => n === 'teams.create').length
        }
        expect(await creates({ [keyFor('uA')]: 't2' })).toBe(await creates({}))
    })
})

describe('$auth.startTeamId', () => {
    it('an app-chosen team set in alpine:init starts the store there, prefetched', async () => {
        const p = start({ config: cfg, onAlpineInit: s => { s.startTeamId = 't2' } })
        await loaded(p)
        await sleep(20)
        expect(p.store.currentTeam.$id).toBe('t2')
        expect(reqs(p)).toEqual(['account.get', 'account.listSessions', 'teams.list', 'teams.listMemberships(t2)', 'teams.getPrefs(t2)'])
        expect(p.window.localStorage.getItem(keyFor('uA'))).toBe(null) // remember is off
    })

    it('a team the user does not have falls back to the default pick', async () => {
        const p = start({ config: cfg, onAlpineInit: s => { s.startTeamId = 't9' } })
        await loaded(p)
        expect(p.store.currentTeam.$id).toBe('t1')
    })
})

describe('off by default', () => {
    it('no setting, no startTeamId: same requests and state as before, nothing stored', async () => {
        const p = start({ config: cfg, local: { [keyFor('uA')]: 't2' } })
        await loaded(p)
        await sleep(20)
        expect(reqs(p)).toEqual(['account.get', 'account.listSessions', 'teams.list', 'teams.listMemberships(t1)', 'teams.getPrefs(t1)'])
        expect(snapshot(p.store).currentTeam).toBe('t1')
        expect(p.window.localStorage._map.size).toBe(2) // the mirrored auth state and the seeded entry only
    })
})

describe('$auth.startTeamId lifetime', () => {
    const started = async () => {
        const p = start({ config: cfg, onAlpineInit: s => { s.startTeamId = 't2' } })
        await loaded(p)
        expect(p.store.currentTeam.$id).toBe('t2')
        return p
    }

    it('is cleared on logout', async () => {
        const p = await started()
        await p.store.logout()
        expect(p.store.startTeamId).toBe(null)
    })

    it('is cleared when the session is cleared', async () => {
        const p = await started()
        p.window.dispatchEvent(new p.window.CustomEvent('manifest:auth:session-cleared'))
        expect(p.store.startTeamId).toBe(null)
    })

    it('is cleared when a different user signs in; kept for the same user', async () => {
        const p = await started()
        p.window.dispatchEvent(new p.window.CustomEvent('manifest:auth:login', { detail: { user: userA } }))
        expect(p.store.startTeamId).toBe('t2')
        p.store.user = userB
        p.window.dispatchEvent(new p.window.CustomEvent('manifest:auth:login', { detail: { user: userB } }))
        expect(p.store.startTeamId).toBe(null)
    })

    it('set before anyone signed in, it applies to the first user who does', async () => {
        const p = start({ config: cfg, onAlpineInit: s => { s.startTeamId = 't2' } })
        await loaded(p)
        expect(p.store.currentTeam.$id).toBe('t2')
        expect(p.store._startTeamUserId).toBe('uA')
    })
})
