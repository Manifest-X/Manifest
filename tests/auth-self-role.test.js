/**
 * A member without updateMembers may drop roles from their own membership but never add one.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA', email: 'a@x' }
const cfg = { teams: true, memberRoles: { Admin: ['updateMembers', 'manageRoles'], Editor: ['inviteMembers'], Billing: [], Viewer: [] } }

async function start(roles) {
    const page = boot({
        cfg, persisted: { isAuthenticated: true, isAnonymous: false, user },
        responder: (name, arg) => {
            switch (name) {
                case 'account.get': return user
                case 'account.listSessions': return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
                case 'teams.list': return { teams: [{ $id: 't1', name: 'One' }], total: 1 }
                case 'teams.listMemberships': return { memberships: [{ $id: 'm-me', userId: 'uA', roles, confirm: true }, { $id: 'm-b', userId: 'uB', roles: ['viewer'], confirm: true }], total: 2 }
                case 'teams.getPrefs': return { roles: {} }
                case 'teams.getMembership': if (arg.membershipId === 'm-gone') { const e = new Error('Membership not found'); e.code = 404; return e } return arg.membershipId === 'm-me-t2' ? { $id: 'm-me-t2', teamId: 't2', userId: 'uA', roles: ['viewer'] } : { $id: arg.membershipId, teamId: arg.teamId, userId: 'uB', roles: ['viewer'] }
                case 'teams.updateMembership': return { membership: { $id: arg.membershipId, userId: arg.membershipId === 'm-me' ? 'uA' : 'uB', roles: arg.roles } }
            }
        },
    })
    await until(() => page.events.some(e => e.type === 'teams-loaded'))
    await sleep(20)
    return page
}
const sent = page => page.fake.calls.filter(c => c.name === 'teams.updateMembership').map(c => c.args[0].roles)

describe('own membership', () => {
    it('an Editor cannot make themself Admin', async () => {
        const page = await start(['editor', 'owner'])
        const result = await page.store.updateMembership('t1', 'm-me', ['Admin'])
        expect(result).toEqual({ success: false, error: 'You do not have permission to change your own roles' })
        expect(sent(page)).toEqual([])
        expect(page.store.currentTeamMemberships.find(m => m.$id === 'm-me').roles).toEqual(['editor', 'owner'])
    })

    it('a Viewer cannot add a role, even a powerless one', async () => {
        const page = await start(['viewer'])
        expect((await page.store.updateMembership('t1', 'm-me', ['Viewer', 'Billing'])).success).toBe(false)
        expect(sent(page)).toEqual([])
    })

    it('a member may drop one of their own roles (legacy display-name tokens included)', async () => {
        const page = await start(['Viewer', 'billing'])
        expect((await page.store.updateMembership('t1', 'm-me', ['Billing'])).success).toBe(true)
        expect(sent(page)).toEqual([['billing']])
    })

    it('an Admin (updateMembers) can still change their own and others\' roles', async () => {
        const page = await start(['admin', 'owner'])
        expect((await page.store.updateMembership('t1', 'm-me', ['Admin', 'Billing'])).success).toBe(true)
        expect((await page.store.updateMembership('t1', 'm-b', ['Editor'])).success).toBe(true)
        expect(sent(page).length).toBe(2)
    })

    it('an Editor still cannot change someone else', async () => {
        const page = await start(['editor', 'owner'])
        expect((await page.store.updateMembership('t1', 'm-b', ['Admin'])).error).toBe('You do not have permission to update member roles')
        expect(sent(page)).toEqual([])
    })

    it('permission in the current team does not let an Admin add roles to themself in another team', async () => {
        const page = await start(['admin', 'owner'])
        const result = await page.store.updateMembership('t2', 'm-me-t2', ['Admin'])
        expect(result.error).toBe('You do not have permission to change your own roles')
        expect(sent(page)).toEqual([])
        expect((await page.store.updateMembership('t2', 'm-me-t2', [])).success).toBe(true)
    })

    it('a membership in another team that cannot be looked up is refused', async () => {
        const page = await start(['admin', 'owner'])
        expect((await page.store.updateMembership('t2', 'm-gone', ['Admin'])).success).toBe(false)
        expect(sent(page)).toEqual([])
    })
})
