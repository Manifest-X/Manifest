/**
 * The current team's memberships and prefs are read together; the permission cache is still
 * computed after both.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA', email: 'a@x' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const cfg = { teams: true, memberRoles: { Admin: ['inviteMembers', 'manageRoles'], Viewer: [] }, templateRoles: { Editor: ['inviteMembers'] } }

function responder(hold) {
    return (name, arg) => {
        if (hold.has(name)) return undefined
        return {
            'account.get': user,
            'account.listSessions': { sessions: [{ $id: 's1', current: true, provider: 'email' }] },
            'teams.list': { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 },
            'teams.listMemberships': { memberships: [{ $id: `m-${arg?.teamId}`, userId: 'uA', roles: ['Custom', 'owner'], confirm: true }], total: 1 },
            'teams.getPrefs': { roles: { Custom: ['renameTeam'] } },
        }[name]
    }
}

describe('memberships and prefs together', () => {
    it('boot: getPrefs goes out while listMemberships is in flight; permissions are computed after both', async () => {
        const hold = new Set(['teams.listMemberships', 'teams.getPrefs'])
        const { fake, events, store } = boot({ cfg, persisted, responder: responder(hold) })
        await until(() => fake.names().includes('teams.getPrefs'))
        const prefs = fake.calls.find(c => c.name === 'teams.getPrefs')
        expect(prefs.inflightAtStart).toContain('teams.listMemberships')
        expect(prefs.args[0]).toEqual({ teamId: 't1' })
        // Neither answered yet: no permissions, no teams-loaded
        expect(store._permissionCache).toEqual({})
        fake.settle('teams.getPrefs', { roles: { Custom: ['renameTeam'] } })
        await sleep(20)
        expect(events.map(e => e.type)).toEqual(['initialized'])
        fake.settle('teams.listMemberships', { memberships: [{ $id: 'm1', userId: 'uA', roles: ['Custom', 'owner'], confirm: true }], total: 1 })
        await until(() => events.some(e => e.type === 'teams-loaded'))
        const at = events.at(-1).store
        expect(at.memberships).toEqual([['m1', ['Custom']]])
        expect(at.permissions).toEqual({ inviteMembers: false, updateMembers: false, removeMembers: false, renameTeam: true, deleteTeam: false, manageRoles: false })
        expect(at.userRole).toBe('Custom')
        expect(fake.names().filter(n => n === 'teams.getPrefs')).toHaveLength(1)
        expect(fake.names().filter(n => n === 'teams.listMemberships')).toHaveLength(1)
    })

    it('listing another team’s memberships does not read its prefs early', async () => {
        const { fake, events, store } = boot({ cfg, persisted, responder: responder(new Set()) })
        await until(() => events.some(e => e.type === 'teams-loaded'))
        const before = fake.names().length
        await store.listMemberships('t2')
        const after = fake.names().slice(before)
        expect(after[0]).toBe('teams.listMemberships')
        // display roles still resolve against t2's prefs, read after the list as before
        expect(after.filter(n => n === 'teams.getPrefs')).toHaveLength(1)
        expect(fake.calls.slice(before).find(c => c.name === 'teams.getPrefs').inflightAtStart).not.toContain('teams.listMemberships')
    })
})
