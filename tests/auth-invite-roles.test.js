/**
 * An invite with no roles used to be sent as Appwrite `owner`. When the app or the team defines
 * any custom role (manifest roles or roles in team prefs), a role-less invite is refused before
 * anything reaches Appwrite. With no custom roles anywhere (plain Appwrite teams, every member
 * an owner) it is still sent as owner. duplicateTeam keeps a role-less member role-less.
 */
import { describe, it, expect } from 'vitest'
import { boot, until } from './helpers/auth-boot-harness.js'

const me = { $id: 'uA', email: 'a@x.test' }
const persisted = { isAuthenticated: true, isAnonymous: false, user: me }
const ROLES = { Admin: ['inviteMembers', 'updateMembers', 'removeMembers', 'renameTeam', 'deleteTeam', 'manageRoles'], Editor: ['inviteMembers'], Viewer: [] }

function start({ memberRoles = null, prefs = {}, members = null } = {}) {
    const srv = { invites: [] }
    const own = { $id: 'm-me', teamId: 't1', userId: 'uA', roles: memberRoles ? ['admin', 'owner'] : ['owner'], confirm: true }
    const p = boot({
        cfg: { teams: true, ...(memberRoles ? { memberRoles } : {}) }, persisted,
        responder: (name, arg, entry) => {
            switch (name) {
                case 'account.get': return me
                case 'account.listSessions': return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
                case 'teams.list': return { teams: [{ $id: 't1', name: 'One' }], total: 1 }
                case 'teams.getPrefs': return arg.teamId === 'dup' ? {} : JSON.parse(JSON.stringify(prefs))
                case 'teams.updatePrefs': return {}
                case 'teams.create': return { $id: 'dup', name: entry.args[1] }
                case 'teams.listMemberships': {
                    const rows = arg.teamId === 'dup' ? [] : (members || [own])
                    return { memberships: rows, total: rows.length }
                }
                case 'teams.createMembership': srv.invites.push(arg); return { $id: 'inv', ...arg }
            }
            return {}
        },
    })
    return { ...p, srv }
}
const loaded = p => until(() => p.events.some(e => e.type === 'teams-loaded'))

describe('role-less invites with custom roles defined', () => {
    it('manifest roles: inviteMember with no roles is refused and nothing is sent', async () => {
        const p = start({ memberRoles: ROLES })
        await loaded(p)
        const r = await p.store.inviteMember('t1', [], 'new@x.test')
        expect(r.success).toBe(false)
        expect(r.error).toMatch(/role/i)
        expect(p.store.error).toBe(r.error)
        expect(p.srv.invites).toEqual([])
    })

    it('manifest roles: inviteToCurrentTeam with nothing selected is refused and nothing is sent', async () => {
        const p = start({ memberRoles: ROLES })
        await loaded(p)
        p.store.inviteEmail = 'new@x.test'
        const r = await p.store.inviteToCurrentTeam()
        expect(r.success).toBe(false)
        expect(p.srv.invites).toEqual([])
        expect(p.store.inviteEmail).toBe('new@x.test')
    })

    it('roles only in team prefs: a role-less invite is refused', async () => {
        const p = start({ prefs: { roles: { Editor: ['inviteMembers'] } } })
        await loaded(p)
        const r = await p.store.inviteMember('t1', null, 'new@x.test')
        expect(r.success).toBe(false)
        expect(p.srv.invites).toEqual([])
    })

    it('an invite naming a role is sent as before', async () => {
        const p = start({ memberRoles: ROLES })
        await loaded(p)
        const r = await p.store.inviteMember('t1', ['Editor'], 'new@x.test')
        expect(r.success).toBe(true)
        expect(p.srv.invites[0].roles).toEqual(['editor', 'owner'])
    })
})

describe('role-less invites with no custom roles anywhere (unchanged)', () => {
    it('inviteMember with no roles is sent as owner', async () => {
        const p = start()
        await loaded(p)
        const r = await p.store.inviteMember('t1', [], 'new@x.test')
        expect(r.success).toBe(true)
        expect(p.srv.invites.map(i => i.roles)).toEqual([['owner']])
        expect(p.store.error).toBe(null)
    })
})

describe('duplicateTeam copying a member with no roles', () => {
    const members = [
        { $id: 'm-me', teamId: 't1', userId: 'uA', roles: ['owner'], confirm: true },
        { $id: 'm-b', teamId: 't1', userId: 'uB', userEmail: 'b@x.test', roles: [], confirm: true },
    ]

    it('custom roles: the copy keeps them role-less (not owner)', async () => {
        const p = start({ memberRoles: ROLES, members: members.map(m => m.userId === 'uA' ? { ...m, roles: ['admin', 'owner'] } : m) })
        await loaded(p)
        const r = await p.store.duplicateTeam('t1', { copyMembers: true })
        expect(r.success).toBe(true)
        expect(p.srv.invites.map(i => [i.email, i.roles])).toEqual([['b@x.test', []]])
    })

    it('no custom roles: the copy invites them as owner, as before', async () => {
        const p = start({ members })
        await loaded(p)
        const r = await p.store.duplicateTeam('t1', { copyMembers: true })
        expect(r.success).toBe(true)
        expect(p.srv.invites.map(i => [i.email, i.roles])).toEqual([['b@x.test', ['owner']]])
    })
})
