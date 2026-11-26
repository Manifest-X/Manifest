/**
 * The starting-team prefetch and memberLimit pages follow the own-membership rule: a page without the
 * user resolves their membership directly; $auth.currentTeamMembership and permissions come from it.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const project = { endpoint: 'https://cloud.test/v1', projectId: 'p1' }
const key = `manifest:auth:team:${project.endpoint}|${project.projectId}|uA`
const NONE = { inviteMembers: false, updateMembers: false, removeMembers: false, renameTeam: false, deleteTeam: false, manageRoles: false }
const parse = q => { try { return JSON.parse(q) } catch { return null } }

function start({ myIndex, myRoles = ['Viewer'], remember = true, memberLimit = null }) {
    const members = Array.from({ length: 30 }, (_, i) => i === myIndex
        ? { $id: 't2-me', teamId: 't2', userId: 'uA', roles: myRoles, confirm: true }
        : { $id: `t2-m${String(i).padStart(2, '0')}`, teamId: 't2', userId: `u${i}`, roles: ['Viewer'], confirm: true })
    const cfg = { ...project, teams: true, memberRoles: { Admin: ['inviteMembers', 'manageRoles'], Viewer: [] }, ...(remember ? { rememberTeam: true } : {}), ...(memberLimit ? { memberLimit } : {}) }
    const p = boot({
        cfg, persisted, local: remember ? { [key]: 't2' } : {},
        responder: (name, arg) => {
            if (name === 'account.get') return user
            if (name === 'account.listSessions') return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
            if (name === 'teams.list') return { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 }
            if (name === 'teams.getPrefs') return {}
            if (name === 'teams.listMemberships') {
                const qs = (arg.queries || []).map(parse).filter(Boolean)
                const eq = qs.find(q => q.method === 'equal')
                if (eq) return { memberships: members.filter(m => eq.values.includes(m.userId)), total: 1 }
                const limit = qs.find(q => q.method === 'limit')?.values[0] ?? 25
                return { memberships: members.slice(0, limit), total: members.length }
            }
        },
    })
    return p
}
const loaded = p => until(() => p.events.some(e => e.type === 'teams-loaded'))
const calls = p => p.fake.calls.filter(c => c.name === 'teams.listMemberships').map(c => (c.args[0].queries || []).some(q => q.includes('"equal"')) ? 'own' : 'page')

describe('starting-team prefetch and the own membership', () => {
    it('user outside the prefetched page: own membership fetched, permissions from it', async () => {
        const p = start({ myIndex: 29, myRoles: ['Admin', 'owner'] })
        await loaded(p)
        expect(p.store.currentTeam.$id).toBe('t2')
        expect(calls(p)).toEqual(['page', 'own'])
        expect(p.store.currentTeamMembership.$id).toBe('t2-me')
        expect(p.store._permissionCache).toEqual({ ...NONE, inviteMembers: true, manageRoles: true })
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(false)
    })

    it('a Viewer outside the prefetched page gets nothing', async () => {
        const p = start({ myIndex: 29 })
        await loaded(p)
        expect(p.store._permissionCache).toEqual(NONE)
        expect(p.store.currentTeamMembership.roles).toEqual(['Viewer'])
    })

    it('user inside the prefetched page: no own request', async () => {
        const p = start({ myIndex: 2, myRoles: ['owner'] })
        await loaded(p)
        expect(calls(p)).toEqual(['page'])
        expect(p.store.currentTeamMembership.$id).toBe('t2-me')
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(true)
    })
})

describe('memberLimit pages and the own membership', () => {
    it('memberLimit 10, user 15th: own fetched; total and cursor describe the page', async () => {
        const p = start({ myIndex: 14, myRoles: ['owner'], remember: false, memberLimit: 10 })
        p.store.startTeamId = 't2'
        await loaded(p)
        expect(p.store.currentTeamMemberships).toHaveLength(10)
        expect(p.store.currentTeamMembershipsTotal).toBe(30)
        expect(p.store.currentTeamMembershipsCursor).toBe('t2-m09')
        expect(calls(p)).toEqual(['page', 'own'])
        expect(p.store.currentTeamMembership.$id).toBe('t2-me')
        expect(p.store.hasTeamPermissionSync('deleteTeam')).toBe(true)
    })

    it('with remember and memberLimit: the prefetched limited page also resolves the own membership', async () => {
        const p = start({ myIndex: 20, myRoles: ['Admin', 'owner'], memberLimit: 10 })
        await loaded(p)
        expect(calls(p)).toEqual(['page', 'own'])
        expect(p.store._permissionCache.inviteMembers).toBe(true)
        expect(p.store._permissionCache.deleteTeam).toBe(false)
    })
})
