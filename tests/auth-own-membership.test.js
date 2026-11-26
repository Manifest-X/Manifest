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
        expect(p.store._ownMembership).toMatchObject({ teamId: 't2', membership: { $id: 't2-me' } }) // t2's own entry, never t1's late answer
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

    it('an app paging with its own queries re-fetches the own membership and keeps the role', async () => {
        const p = start({ t1Roles: ['owner'] })
        await loaded(p)
        const before = memberCalls(p).length
        await p.store.listMemberships('t1', ['cursor-page-2'])
        expect(memberCalls(p).slice(before)).toEqual(['t1:page', 't1:own'])
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(true)
    })

    it('a listed membership with no roles at all grants nothing', async () => {
        const p = start({ t1Index: 3, t1Roles: [] })
        await loaded(p)
        expect(perms(p.store)).toEqual(NONE)
        expect(p.store.hasTeamPermissionSync('inviteMembers')).toBe(false)
    })
})

describe('$auth.currentTeamMembership', () => {
    it('from the listed page, with display roles', async () => {
        const p = start({ t1Index: 3 })
        await loaded(p)
        expect(p.store.currentTeamMembership.$id).toBe('t1-me')
        expect(p.store.currentTeamMembership.roles).toEqual(['Viewer'])
        expect(p.store.currentTeamMembership.displayRoles).toEqual(['Viewer'])
    })

    it('from the direct fetch, with display roles; null while it loads', async () => {
        const p = start({ t1Roles: ['Admin', 'owner'], hold: new Set(['own:t1']) })
        await until(() => memberCalls(p).includes('t1:own'))
        expect(p.store.currentTeamMembership).toBe(null)
        p.fake.calls.find(c => !c.settled && c.args[0]?.queries?.length).resolve({ memberships: [{ ...p.teams.t1[29] }], total: 1 })
        await loaded(p)
        expect(p.store.currentTeamMembership.$id).toBe('t1-me')
        expect(p.store.currentTeamMembership.displayRoles).toEqual(['Admin'])
    })

    it('follows team switches, is null after logout, and cannot be assigned', async () => {
        const p = start({ t1Index: 3 })
        await loaded(p)
        await p.store.viewTeam(p.store.teams[1])
        expect(p.store.currentTeamMembership.$id).toBe('t2-me')
        try { p.store.currentTeamMembership = { $id: 'fake', roles: ['owner'] } } catch (e) { /* strict-mode TypeError */ }
        expect(p.store.currentTeamMembership.$id).toBe('t2-me')
        p.fake.appwrite.account.deleteSession = async () => ({})
        await p.store.logout()
        expect(p.store.currentTeamMembership).toBe(null)
    })

    it('null when the user has no membership in the listing', async () => {
        const p = start({ t1Index: 99 }) // not among the 30
        await loaded(p)
        expect(p.store.currentTeamMembership).toBe(null)
        expect(perms(p.store)).toEqual(NONE)
    })
})

// A server model: mutable roles and position, search, limit and the own lookup
function serverStart({ index = 29, roles = ['Admin', 'owner'], hold = () => false, fail = () => false, realtime = false, wait, retryMs } = {}) {
    const srv = { index, roles, ownCalls: 0 }
    const members = () => Array.from({ length: 30 }, (_, i) => i === srv.index
        ? { $id: 't1-me', teamId: 't1', userId: 'uA', roles: srv.roles, confirm: true }
        : { $id: `t1-m${i}`, teamId: 't1', userId: `u${i}`, roles: ['Viewer'], confirm: true })
    const t2 = [{ $id: 't2-me', teamId: 't2', userId: 'uA', roles: ['Viewer'], confirm: true }]
    const p = boot({
        cfg, persisted, realtime,
        responder: (name, arg, entry) => {
            if (name === 'account.get') return user
            if (name === 'account.listSessions') return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
            if (name === 'account.deleteSession') return {}
            if (name === 'teams.list') return { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 }
            if (name === 'teams.getPrefs') return {}
            if (name !== 'teams.listMemberships') return undefined
            const queries = arg.queries || []
            const own = queries.some(q => q.includes('"equal"'))
            if (own) srv.ownCalls++
            if (hold(arg, own)) return undefined
            if (fail(arg, own)) return offline()
            const all = arg.teamId === 't2' ? t2 : members()
            if (own) return { memberships: all.filter(m => m.userId === 'uA'), total: 1 }
            const matching = arg.search ? all.filter(m => m.userId.includes(arg.search)) : all
            const limitQ = queries.map(q => { try { return JSON.parse(q) } catch { return null } }).find(q => q?.method === 'limit')
            return { memberships: matching.slice(0, limitQ ? limitQ.values[0] : PAGE), total: matching.length }
        },
    })
    if (wait) p.store._prefetchWaitMs = wait
    if (retryMs) p.store._ownRetryDelays = [retryMs, retryMs * 2, retryMs * 3]
    return { ...p, srv }
}
const limit = n => JSON.stringify({ method: 'limit', values: [n] })
const ADMIN = { ...NONE, inviteMembers: true, manageRoles: true }
const pendingOwn = p => p.fake.calls.find(c => !c.settled && c.args[0]?.queries?.some(q => q.includes('"equal"')))

describe('own membership freshness', () => {
    it('demoted and now on the first page, then a page without the user: the stale Admin never returns', async () => {
        const p = serverStart()
        await loaded(p)
        expect(perms(p.store)).toEqual(ADMIN)
        Object.assign(p.srv, { index: 10, roles: ['Viewer'] })
        await p.store.viewTeam(p.store.teams[0])
        expect(perms(p.store)).toEqual(NONE)
        const page = p.store.listMemberships('t1', [limit(5)])
        await sleep(5)
        expect(p.store.hasTeamPermissionSync('inviteMembers')).toBe(false)
        await page
        expect(p.store.hasTeamPermissionSync('inviteMembers')).toBe(false)
        expect(p.store.currentTeamMembership.roles).toEqual(['Viewer'])
    })

    it('a page without the user re-fetches; the known (fresh) membership is used meanwhile', async () => {
        let hold = false
        const p = serverStart({ index: 10, roles: ['Viewer'], hold: (a, own) => own && hold })
        await loaded(p)
        hold = true
        const page = p.store.listMemberships('t1', [limit(5)])
        await until(() => !!pendingOwn(p))
        expect(p.store.hasTeamPermissionSync('inviteMembers')).toBe(false)
        expect(p.store.currentTeamMembership.roles).toEqual(['Viewer'])
        pendingOwn(p).resolve({ memberships: [{ $id: 't1-me', teamId: 't1', userId: 'uA', roles: ['Viewer'], confirm: true }], total: 1 })
        await page
        expect(perms(p.store)).toEqual(NONE)
    })

    it('demotion while outside the page: the realtime re-list re-fetches and roles drop', async () => {
        const p = serverStart({ realtime: true })
        await loaded(p)
        await until(() => !!p.fake.channels.memberships)
        expect(perms(p.store)).toEqual(ADMIN)
        p.srv.roles = ['Viewer']
        p.fake.emit('memberships', { events: ['teams.t1.memberships.t1-me.update'], payload: { teamId: 't1' } })
        await until(() => p.store._permissionCache.inviteMembers === false)
        expect(perms(p.store)).toEqual(NONE)
        expect(p.store.currentTeamMembership.roles).toEqual(['Viewer'])
    })

    it('promotion while outside the page: roles rise after the re-list', async () => {
        const p = serverStart({ roles: ['Viewer'], realtime: true })
        await loaded(p)
        await until(() => !!p.fake.channels.memberships)
        expect(perms(p.store)).toEqual(NONE)
        p.srv.roles = ['Admin', 'owner']
        p.fake.emit('memberships', { events: ['teams.t1.memberships.t1-me.update'], payload: { teamId: 't1' } })
        await until(() => p.store._permissionCache.inviteMembers === true)
        expect(perms(p.store)).toEqual(ADMIN)
    })

    it('a member search by an Admin inside the page keeps Admin', async () => {
        const p = serverStart({ index: 3 })
        await loaded(p)
        const before = p.srv.ownCalls
        await p.store.listMemberships('t1', [], 'u1')
        expect(p.store.currentTeamMemberships.every(m => m.userId.includes('u1'))).toBe(true)
        expect(perms(p.store)).toEqual(ADMIN)
        expect(p.store.currentTeamMembership.roles).toEqual(['Admin', 'owner'])
        expect(p.srv.ownCalls - before).toBe(1)
    })

    it('a member search by an Admin outside the page keeps Admin', async () => {
        const p = serverStart()
        await loaded(p)
        await p.store.listMemberships('t1', [], 'u1')
        expect(perms(p.store)).toEqual(ADMIN)
    })

    it('a paged listing by a Viewer outside the page keeps Viewer and never elevates', async () => {
        const p = serverStart({ roles: ['Viewer'] })
        await loaded(p)
        const seen = []
        let done = false
        const page = p.store.listMemberships('t1', [limit(5)]).then(() => { done = true })
        while (!done) { seen.push(p.store.hasTeamPermissionSync('deleteTeam')); await sleep(1) }
        await page
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every(v => v === false)).toBe(true)
        expect(perms(p.store)).toEqual(NONE)
    })
})

describe('a hung or failed own-membership fetch', () => {
    it('hung: the load finishes after the bounded wait with everything denied; a late answer for the right team applies', async () => {
        const p = serverStart({ hold: (a, own) => own, wait: 150 })
        await loaded(p)
        expect(perms(p.store)).toEqual(NONE)
        expect(p.store.currentTeamMembership).toBe(null)
        pendingOwn(p).resolve({ memberships: [{ $id: 't1-me', teamId: 't1', userId: 'uA', roles: ['Admin', 'owner'], confirm: true }], total: 1 })
        await until(() => p.store._permissionCache.inviteMembers === true)
        expect(perms(p.store)).toEqual(ADMIN)
    })

    it('hung: a late answer after switching team is not applied', async () => {
        const p = serverStart({ hold: (a, own) => own && a.teamId === 't1', wait: 150 })
        await loaded(p)
        await p.store.viewTeam(p.store.teams[1])
        pendingOwn(p).resolve({ memberships: [{ $id: 't1-me', teamId: 't1', userId: 'uA', roles: ['owner'], confirm: true }], total: 1 })
        await sleep(30)
        expect(p.store.currentTeam.$id).toBe('t2')
        expect(p.store.currentTeamMembership.$id).toBe('t2-me')
        expect(perms(p.store)).toEqual(NONE)
    })

    it('failed: denied, then a delayed retry recovers without the app doing anything', async () => {
        let failures = 1
        const p = serverStart({ fail: (a, own) => own && failures-- > 0, retryMs: 100 })
        await loaded(p)
        expect(perms(p.store)).toEqual(NONE)
        await until(() => p.store._permissionCache.inviteMembers === true, 2000)
        expect(perms(p.store)).toEqual(ADMIN)
        expect(p.srv.ownCalls).toBe(2)
    })

    it('failed twice: the second retry recovers', async () => {
        let failures = 2
        const p = serverStart({ fail: (a, own) => own && failures-- > 0, retryMs: 40 })
        await loaded(p)
        await until(() => p.store._permissionCache.inviteMembers === true, 2000)
        expect(p.srv.ownCalls).toBe(3)
    })

    it('failing every time: three retries on a growing delay, then the next listing tries again', async () => {
        let failures = 4
        const p = serverStart({ fail: (a, own) => own && failures-- > 0, retryMs: 30 })
        await loaded(p)
        await sleep(400)
        expect(p.srv.ownCalls).toBe(4)
        expect(p.store._ownRetryTimer).toBe(null)
        expect(p.store.currentTeamMembershipStatus).toBe('error')
        await p.store.viewTeam(p.store.teams[0])
        expect(perms(p.store)).toEqual(ADMIN)
    })

    it('logout cancels a pending retry', async () => {
        let failures = 1
        const p = serverStart({ fail: (a, own) => own && failures-- > 0, retryMs: 80 })
        await loaded(p)
        await p.store.logout()
        await sleep(150)
        expect(p.srv.ownCalls).toBe(1)
        expect(p.store._ownRetryTimer).toBe(null)
    })
})
