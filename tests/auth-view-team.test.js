/**
 * viewTeam refreshes the permission cache once: listMemberships already refreshes it for the
 * current team, so the wrapper refreshes again only when that did not happen.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA', email: 'a@x' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const baseCfg = { teams: true, memberRoles: { Admin: ['inviteMembers', 'manageRoles'], Viewer: [] } }
const templateCfg = { ...baseCfg, templateRoles: { Editor: ['inviteMembers'] } }

function responder(over = {}) {
    return (name, arg) => {
        if (name in over && over[name](arg) !== undefined) return over[name](arg)
        if (name === 'teams.listMemberships') return { memberships: [{ $id: `m-${arg.teamId}`, userId: 'uA', roles: [arg.teamId === 't1' ? 'Admin' : 'Custom', 'owner'], confirm: true }], total: 1 }
        return {
            'account.get': user,
            'account.listSessions': { sessions: [{ $id: 's1', current: true, provider: 'email' }] },
            'teams.list': { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 },
            'teams.getPrefs': { roles: { Custom: ['renameTeam'] } },
        }[name]
    }
}

async function signedIn(cfg, over) {
    const page = boot({ cfg, persisted, responder: responder(over) })
    await until(() => page.events.some(e => e.type === 'teams-loaded'))
    await sleep(10)
    let checks = 0
    const hasPermission = page.store.hasPermission
    page.store.hasPermission = function (...a) { checks++; return hasPermission.apply(this, a) }
    const since = page.fake.calls.length
    return { ...page, checks: () => checks, requests: () => page.fake.names().slice(since) }
}

describe('viewTeam', () => {
    it('one listMemberships, one prefs read and one permission refresh (6 checks) for a team viewed', async () => {
        const { store, checks, requests } = await signedIn(baseCfg)
        await store.viewTeam(store.teams[1])
        expect(requests()).toEqual(['teams.listMemberships', 'teams.getPrefs'])
        expect(checks()).toBe(6)
        expect(store._permissionCache).toEqual({ inviteMembers: false, updateMembers: false, removeMembers: false, renameTeam: true, deleteTeam: false, manageRoles: false })
        expect(store._userRoleCache).toBe('Custom')
        expect(store.allAvailablePermissions).toContain('renameTeam')
    })

    it('with template roles the deleted-template lookups share that one prefs read', async () => {
        const { store, requests } = await signedIn(templateCfg)
        await store.viewTeam(store.teams[1])
        expect(requests()).toEqual(['teams.listMemberships', 'teams.getPrefs'])
    })

    it('still refreshes when listMemberships could not (failed list)', async () => {
        const { store, checks } = await signedIn(baseCfg, { 'teams.listMemberships': a => (a.teamId === 't2' ? new Error('Server error') : undefined) })
        await store.viewTeam(store.teams[1])
        expect(checks()).toBe(6)
    })

    it('viewing no team clears the permission cache as before', async () => {
        const { store } = await signedIn(baseCfg)
        await store.viewTeam(null)
        expect(store._permissionCache).toEqual({})
        expect(store._userRoleCache).toBe(null)
    })
})
