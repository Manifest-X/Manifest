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

describe('rapid team switches', () => {
    const roleFor = { t1: 'Admin', tX: 'Admin', tY: 'Custom' }
    const Y_PERMISSIONS = { inviteMembers: false, updateMembers: false, removeMembers: false, renameTeam: true, deleteTeam: false, manageRoles: false }
    // Every call for a team in `held` waits for the test; the rest answer at once
    async function page(held) {
        const p = boot({
            cfg: baseCfg, persisted,
            responder: (name, arg) => {
                if (arg?.teamId && held.has(`${name}:${arg.teamId}`)) return undefined
                if (name === 'teams.list') return { teams: [{ $id: 't1', name: 'One' }, { $id: 'tX', name: 'X' }, { $id: 'tY', name: 'Y' }], total: 3 }
                if (name === 'teams.listMemberships') return members(arg.teamId)
                return responder()(name, arg)
            },
        })
        await until(() => p.events.some(e => e.type === 'teams-loaded'))
        await sleep(10)
        return p
    }
    const members = teamId => ({ memberships: [{ $id: `m-${teamId}`, userId: 'uA', roles: [roleFor[teamId], 'owner'], confirm: true }], total: 1 })
    const pendingFor = (fake, name, teamId) => fake.calls.find(c => c.name === name && c.args[0]?.teamId === teamId && !c.settled)
    const release = (fake, name, teamId, value) => pendingFor(fake, name, teamId).resolve(value)

    it("X then Y with Y's members answering first (and Y's prefs read mid-refresh) ends on Y's members and permissions", async () => {
        const held = new Set(['teams.listMemberships:tX', 'teams.listMemberships:tY', 'teams.getPrefs:tY'])
        const { store, fake } = await page(held)
        const toX = store.viewTeam(store.teams.find(t => t.$id === 'tX'))
        const toY = store.viewTeam(store.teams.find(t => t.$id === 'tY'))
        await until(() => pendingFor(fake, 'teams.listMemberships', 'tX') && pendingFor(fake, 'teams.listMemberships', 'tY'))
        release(fake, 'teams.listMemberships', 'tY', members('tY'))
        await until(() => !!pendingFor(fake, 'teams.getPrefs', 'tY'))
        release(fake, 'teams.listMemberships', 'tX', members('tX'))
        await sleep(20)
        release(fake, 'teams.getPrefs', 'tY', { roles: { Custom: ['renameTeam'] } })
        await Promise.all([toX, toY])
        expect(store.currentTeam.$id).toBe('tY')
        expect(store.currentTeamMemberships.map(m => m.$id)).toEqual(['m-tY'])
        expect(store._permissionCache).toEqual(Y_PERMISSIONS)
        expect(store._userRoleCache).toBe('Custom')
    })

    it("X then Y with Y finished before X's members answer: X's members never land under Y", async () => {
        const held = new Set(['teams.listMemberships:tX', 'teams.listMemberships:tY', 'teams.getPrefs:tY'])
        const { store, fake } = await page(held)
        const toX = store.viewTeam(store.teams.find(t => t.$id === 'tX'))
        const toY = store.viewTeam(store.teams.find(t => t.$id === 'tY'))
        await until(() => pendingFor(fake, 'teams.listMemberships', 'tX') && pendingFor(fake, 'teams.listMemberships', 'tY'))
        release(fake, 'teams.listMemberships', 'tY', members('tY'))
        await until(() => !!pendingFor(fake, 'teams.getPrefs', 'tY'))
        release(fake, 'teams.getPrefs', 'tY', { roles: { Custom: ['renameTeam'] } })
        await toY
        release(fake, 'teams.listMemberships', 'tX', members('tX'))
        await toX
        await sleep(20)
        expect(store.currentTeam.$id).toBe('tY')
        expect(store.currentTeamMemberships.map(m => m.$id)).toEqual(['m-tY'])
        expect(store._permissionCache).toEqual(Y_PERMISSIONS)
        expect(store._userRoleCache).toBe('Custom')
    })

    it("a refresh for X still in flight when Y's lands never overwrites Y's permissions", async () => {
        const held = new Set(['teams.getPrefs:tX'])
        const { store, fake } = await page(held)
        const toX = store.viewTeam(store.teams.find(t => t.$id === 'tX'))
        await until(() => !!pendingFor(fake, 'teams.getPrefs', 'tX')) // X's refresh is waiting on X's prefs
        const toY = store.viewTeam(store.teams.find(t => t.$id === 'tY'))
        await toY
        expect(store._permissionCache).toEqual(Y_PERMISSIONS)
        release(fake, 'teams.getPrefs', 'tX', { roles: { Custom: ['renameTeam'] } })
        await toX
        await sleep(20)
        expect(store.currentTeam.$id).toBe('tY')
        expect(store.currentTeamMemberships.map(m => m.$id)).toEqual(['m-tY'])
        expect(store._permissionCache).toEqual(Y_PERMISSIONS)
        expect(store._userRoleCache).toBe('Custom')
    })
})
