/**
 * Permissions come from the current user's own membership. When the listed page of members does not
 * include it (larger teams), it is fetched directly; until it is known, and when there is none, every
 * permission is denied. Only Appwrite's owner role with no custom role grants everything.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, offline } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const cfg = { teams: true, memberRoles: { Admin: ['inviteMembers', 'manageRoles'], Viewer: [] } }
const NONE = { inviteMembers: false, updateMembers: false, removeMembers: false, renameTeam: false, deleteTeam: false, manageRoles: false }
const ALL = { inviteMembers: true, updateMembers: true, removeMembers: true, renameTeam: true, deleteTeam: true, manageRoles: true }
const PAGE = 25 // Appwrite's default page

// t1: 30 members, the user is the 30th; t2: 3 members including the user
function team(teamId, size, myRoles, myIndex) {
    return Array.from({ length: size }, (_, i) => i === myIndex
        ? { $id: `${teamId}-me`, teamId, userId: 'uA', roles: myRoles, confirm: true }
        : { $id: `${teamId}-m${i}`, teamId, userId: `u${i}`, roles: ['Viewer'], confirm: true })
}

function start({ t1Roles = ['Viewer'], t1Index = 29, hold = new Set(), fail = {}, persistedState = persisted, sessions, config = cfg, realtime = false } = {}) {
    const teams = { t1: team('t1', 30, t1Roles, t1Index), t2: team('t2', 3, ['Admin', 'owner'], 1) }
    const p = boot({
        cfg: config, persisted: persistedState, realtime,
        responder: (name, arg) => {
            if (name === 'account.get') return user
            if (name === 'account.listSessions') return sessions || { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
            if (name === 'teams.list') return { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 }
            if (name === 'teams.getPrefs') return {}
            if (name === 'teams.listMemberships') {
                const own = (arg.queries || []).some(q => q.includes('"equal"'))
                const kind = own ? 'own' : 'page'
                if (hold.has(`${kind}:${arg.teamId}`)) return undefined
                const failed = fail[`${kind}:${arg.teamId}`]?.()
                if (failed) return failed
                const all = teams[arg.teamId]
                if (own) return { memberships: all.filter(m => m.userId === 'uA'), total: 1 }
                return { memberships: all.slice(0, PAGE), total: all.length }
            }
        },
    })
    return { ...p, teams }
}
const loaded = p => until(() => p.events.some(e => e.type === 'teams-loaded'))
const memberCalls = p => p.fake.calls.filter(c => c.name === 'teams.listMemberships').map(c => `${c.args[0].teamId}:${(c.args[0].queries || []).some(q => q.includes('"equal"')) ? 'own' : 'page'}`)
const perms = store => ({ ...store._permissionCache })

describe('own membership outside the listed page', () => {
    it('a Viewer listed 30th of 30 gets no permissions and the Viewer role', async () => {
        const p = start()
        await loaded(p)
        expect(p.store.currentTeamMemberships).toHaveLength(25)
        expect(perms(p.store)).toEqual(NONE)
        expect(p.store.hasTeamPermissionSync('inviteMembers')).toBe(false)
        expect(p.store.canInviteMembers()).toBe(false)
        expect(p.store.canDeleteTeam()).toBe(false)
        expect(p.store.isCurrentTeamOwner()).toBe(false)
        expect(p.store._userRoleCache).toBe('Viewer')
        expect(p.store.getCurrentTeamRoles()).toEqual(['Viewer'])
        expect(memberCalls(p)).toEqual(['t1:page', 't1:own'])
        const own = p.fake.calls.find(c => c.name === 'teams.listMemberships' && c.args[0].queries.length)
        expect(own.args[0].queries).toEqual([JSON.stringify({ method: 'equal', attribute: 'userId', values: ['uA'] }), JSON.stringify({ method: 'limit', values: [1] })])
    })

    it("an owner with a custom role gets that role's permissions", async () => {
        const p = start({ t1Roles: ['Admin', 'owner'] })
        await loaded(p)
        expect(perms(p.store)).toEqual({ ...NONE, inviteMembers: true, manageRoles: true })
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(false)
        expect(p.store._userRoleCache).toBe('Admin')
    })

    it('a plain owner (no custom role) gets every permission', async () => {
        const p = start({ t1Roles: ['owner'] })
        await loaded(p)
        expect(perms(p.store)).toEqual(ALL)
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(true)
        expect(p.store.isCurrentTeamOwner()).toBe(true)
    })

    it('a user inside the page: no extra request', async () => {
        const p = start({ t1Index: 3 })
        await loaded(p)
        expect(memberCalls(p)).toEqual(['t1:page'])
        expect(perms(p.store)).toEqual(NONE)
        expect(p.store._userRoleCache).toBe('Viewer')
    })

    it('during the gap (own membership still loading) everything is denied', async () => {
        const p = start({ t1Roles: ['owner'], hold: new Set(['own:t1']) })
        await until(() => memberCalls(p).includes('t1:own'))
        expect(p.store.currentTeam.$id).toBe('t1')
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(false)
        expect(p.store.canDeleteTeam()).toBe(false)
        expect(await p.store.hasTeamPermission('deleteTeam')).toBe(false)
        p.fake.calls.find(c => !c.settled && c.args[0]?.queries?.length).resolve({ memberships: [p.teams.t1[29]], total: 1 })
        await loaded(p)
        expect(perms(p.store)).toEqual(ALL)
    })

    it('own fetch failing (offline): denied, and the next refresh recovers', async () => {
        let failOnce = true
        const p = start({ t1Roles: ['owner'], fail: { 'own:t1': () => (failOnce ? (failOnce = false, offline()) : undefined) } })
        await loaded(p)
        expect(perms(p.store)).toEqual(NONE)
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(false)
        await p.store.viewTeam(p.store.teams[0])
        expect(perms(p.store)).toEqual(ALL)
    })

    it('a team switch while the own fetch is in flight never applies it to the other team', async () => {
        const p = start({ t1Roles: ['owner'], hold: new Set(['own:t1']) })
        await until(() => memberCalls(p).includes('t1:own'))
        await p.store.viewTeam(p.store.teams[1])
        p.fake.calls.find(c => !c.settled && c.args[0]?.queries?.length).resolve({ memberships: [p.teams.t1[29]], total: 1 })
        await sleep(50)
        expect(p.store.currentTeam.$id).toBe('t2')
        expect(p.store._ownMembership?.teamId).not.toBe('t2')
        expect(perms(p.store)).toEqual({ ...NONE, inviteMembers: true, manageRoles: true })
        expect(p.store._userRoleCache).toBe('Admin')
    })

    it("switching teams: the previous team's listed membership is never used for the new one", async () => {
        const p = start({ t1Index: 3, t1Roles: ['owner'], hold: new Set(['page:t2']) })
        await loaded(p)
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(true)
        const switching = p.store.viewTeam(p.store.teams[1])
        await until(() => memberCalls(p).includes('t2:page'))
        expect(p.store.currentTeam.$id).toBe('t2')
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(false) // t1's list is still shown, but it is not t2's
        p.fake.calls.find(c => !c.settled && c.args[0]?.teamId === 't2').resolve({ memberships: p.teams.t2, total: 3 })
        await switching
        expect(p.store.hasTeamPermissionSync('inviteMembers')).toBe(true)
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(false)
    })

    it('a guest outside the page is resolved the same way', async () => {
        const guest = { ...persisted, isAnonymous: true }
        const p = start({ persistedState: guest, config: { ...cfg, guestTeams: true, guestManual: true }, sessions: { sessions: [{ $id: 'g', current: true, provider: 'anonymous' }] } })
        await loaded(p)
        expect(p.store.isAnonymous).toBe(true)
        expect(perms(p.store)).toEqual(NONE)
        expect(memberCalls(p)).toEqual(['t1:page', 't1:own'])
    })

    it('an app paging with its own queries keeps the known own membership without refetching', async () => {
        const p = start({ t1Roles: ['owner'] })
        await loaded(p)
        const before = memberCalls(p).length
        await p.store.listMemberships('t1', ['cursor-page-2'])
        expect(memberCalls(p).length).toBe(before + 1)
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(true)
    })

    it('a listed membership with no roles at all grants nothing', async () => {
        const p = start({ t1Index: 3, t1Roles: [] })
        await loaded(p)
        expect(perms(p.store)).toEqual(NONE)
        expect(p.store.hasTeamPermissionSync('inviteMembers')).toBe(false)
    })
})
