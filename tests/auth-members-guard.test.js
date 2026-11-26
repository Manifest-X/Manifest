/**
 * A team the app views while a team load for another team is in flight keeps its own members,
 * deleted template roles and permissions: no write for team X lands while team Y is current.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA', email: 'a@x' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const baseCfg = { teams: true, memberRoles: { Admin: ['inviteMembers', 'manageRoles'], Viewer: [] } }
const templateCfg = { ...baseCfg, templateRoles: { Editor: ['inviteMembers'] } }
// Owner in t1 (every permission), restricted Viewer in t2 (none)
const rolesIn = { t1: ['owner'], t2: ['Viewer', 'owner'] }
const members = teamId => ({ memberships: [{ $id: `m-${teamId}`, userId: 'uA', roles: rolesIn[teamId], confirm: true }], total: 1 })
const prefsFor = teamId => ({ roles: {}, deletedTemplateRoles: teamId === 't1' ? ['Editor'] : [] })
const NONE = { inviteMembers: false, updateMembers: false, removeMembers: false, renameTeam: false, deleteTeam: false, manageRoles: false }

function start(cfg, { held = new Set(), fail = {}, realtime = false } = {}) {
    const page = boot({
        cfg, persisted, realtime,
        responder: (name, arg) => {
            const key = `${name}:${arg?.teamId}`
            if (held.has(key)) return undefined
            if (fail[key]) return fail[key]()
            switch (name) {
                case 'account.get': return user
                case 'account.listSessions': return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
                case 'teams.list': return { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 }
                case 'teams.listMemberships': return members(arg.teamId)
                case 'teams.getPrefs': return prefsFor(arg.teamId)
            }
        },
    })
    return page
}
const pending = (fake, name, teamId) => fake.calls.find(c => c.name === name && c.args[0]?.teamId === teamId && !c.settled)

// Calls viewTeam(t2) right after listTeams first picks t1 (its memberships request in flight)
function viewT2WhenT1Picked(page) {
    const store = page.store
    let current = store.currentTeam
    let viewing = null
    Object.defineProperty(store, 'currentTeam', {
        configurable: true,
        get: () => current,
        set: v => {
            const first = !current && v?.$id === 't1' && !viewing
            current = v
            if (first) viewing = new Promise(r => setTimeout(() => r(store.viewTeam(store.teams.find(t => t.$id === 't2'))), 0))
        },
    })
    return () => viewing
}

function expectOnT2(store, cfg) {
    expect(store.currentTeam.$id).toBe('t2')
    expect(store.currentTeamMemberships.map(m => m.$id)).toEqual(['m-t2'])
    expect(store.hasTeamPermissionSync('inviteMembers')).toBe(false)
    expect(store._permissionCache).toEqual(NONE)
    expect(store._userRoleCache).toBe('Viewer')
    if (cfg.templateRoles) expect(store.deletedTemplateRoles).toEqual([])
}

for (const [label, cfg] of [['without template roles', baseCfg], ['with template roles', templateCfg]]) {
    describe(`viewTeam during the boot team load, ${label}`, () => {
        it("t1's boot memberships answer after t2's view finished: t2 stays intact", async () => {
            const page = start(cfg, { held: new Set(['teams.listMemberships:t1']) })
            const viewing = viewT2WhenT1Picked(page)
            await until(() => viewing() && pending(page.fake, 'teams.listMemberships', 't1'))
            await viewing()
            expectOnT2(page.store, cfg)
            pending(page.fake, 'teams.listMemberships', 't1').resolve(members('t1'))
            await until(() => page.events.some(e => e.type === 'teams-loaded'))
            await sleep(30)
            expectOnT2(page.store, cfg)
        })

        it("t1's boot memberships answer before t2's: t2 ends intact", async () => {
            const page = start(cfg, { held: new Set(['teams.listMemberships:t1', 'teams.listMemberships:t2']) })
            const viewing = viewT2WhenT1Picked(page)
            await until(() => viewing() && pending(page.fake, 'teams.listMemberships', 't1') && pending(page.fake, 'teams.listMemberships', 't2'))
            pending(page.fake, 'teams.listMemberships', 't1').resolve(members('t1'))
            await until(() => page.events.some(e => e.type === 'teams-loaded'))
            pending(page.fake, 'teams.listMemberships', 't2').resolve(members('t2'))
            await viewing()
            await sleep(30)
            expectOnT2(page.store, cfg)
        })

        it("t1's boot memberships fail late (team not found): t2's list is not cleared", async () => {
            const page = start(cfg, { held: new Set(['teams.listMemberships:t1']) })
            const viewing = viewT2WhenT1Picked(page)
            await until(() => viewing() && pending(page.fake, 'teams.listMemberships', 't1'))
            await viewing()
            pending(page.fake, 'teams.listMemberships', 't1').reject(new Error('Team with the requested ID could not be found.'))
            await until(() => page.events.some(e => e.type === 'teams-loaded'))
            await sleep(30)
            expectOnT2(page.store, cfg)
        })

        it('stays on t2 through 20 polling cycles', async () => {
            const polled = { ...cfg, teamsPollInterval: 100 }
            const page = start(polled, { held: new Set(['teams.listMemberships:t1']) })
            const viewing = viewT2WhenT1Picked(page)
            await until(() => viewing() && pending(page.fake, 'teams.listMemberships', 't1'))
            await viewing()
            pending(page.fake, 'teams.listMemberships', 't1').resolve(members('t1'))
            await until(() => page.events.some(e => e.type === 'teams-loaded'))
            const before = page.fake.names().filter(n => n === 'teams.list').length
            await sleep(2100)
            expect(page.fake.names().filter(n => n === 'teams.list').length - before).toBeGreaterThanOrEqual(15)
            expectOnT2(page.store, cfg)
            page.store.stopTeamsPolling()
        }, 8000)
    })
}

describe('viewTeam on teams-loaded', () => {
    it('ends on t2 with t2-derived permissions', async () => {
        const page = start(templateCfg)
        page.window.addEventListener('manifest:auth:teams-loaded', () => page.store.viewTeam(page.store.teams[1]), { once: true })
        await until(() => page.store.currentTeam?.$id === 't2' && page.store.currentTeamMemberships[0]?.$id === 'm-t2')
        await sleep(50)
        expectOnT2(page.store, templateCfg)
    })
})

describe('a realtime team refresh racing viewTeam', () => {
    it("the refresh's memberships for the old team never land under the viewed one", async () => {
        const held = new Set()
        const page = start(templateCfg, { held, realtime: true })
        await until(() => page.events.some(e => e.type === 'teams-loaded') && !!page.fake.channels.teams)
        await sleep(20)
        expect(page.store.currentTeam.$id).toBe('t1')
        held.add('teams.listMemberships:t1')
        page.fake.emit('teams', { events: ['teams.t1abcdefghijk.update'], payload: {} })
        await until(() => !!pending(page.fake, 'teams.listMemberships', 't1'))
        await page.store.viewTeam(page.store.teams[1])
        expectOnT2(page.store, templateCfg)
        pending(page.fake, 'teams.listMemberships', 't1').resolve(members('t1'))
        await sleep(50)
        expectOnT2(page.store, templateCfg)
    })
})

describe('per-team state viewTeam replaces', () => {
    it("the previous team's deleted template roles do not stay under the viewed team", async () => {
        const page = start(templateCfg, { realtime: true })
        await until(() => page.events.some(e => e.type === 'teams-loaded') && !!page.fake.channels.teams)
        page.fake.emit('teams', { events: ['teams.t1abcdefghijk.update'], payload: {} })
        await until(() => page.store.deletedTemplateRoles.length === 1)
        expect(page.store.deletedTemplateRoles).toEqual(['Editor'])
        await page.store.viewTeam(page.store.teams[1])
        expect(page.store.deletedTemplateRoles).toEqual([])
        await page.store.viewTeam(page.store.teams[0])
        expect(page.store.deletedTemplateRoles).toEqual(['Editor'])
    })

    it('an optimistic membership edit for a team that is not current leaves the current list alone', async () => {
        const page = start(baseCfg)
        await until(() => page.events.some(e => e.type === 'teams-loaded'))
        await sleep(20)
        const shown = page.store.currentTeamMemberships
        page.store.updateMembership('t2', 'm-t1', ['Viewer']).catch(() => {})
        page.store.deleteMembership('t2', 'm-t1').catch(() => {})
        expect(page.store.currentTeamMemberships).toBe(shown)
        expect(page.store.currentTeamMemberships.map(m => [m.$id, m.roles])).toEqual([['m-t1', ['owner']]])
    })
})

describe('default team pick', () => {
    it('a team viewed while listTeams resolves its default team is not replaced by the default', async () => {
        const cfg = { ...baseCfg, templateTeams: ['One'] }
        const page = start(cfg, { held: new Set(['teams.list:undefined']) })
        let viewing = null
        await until(() => typeof page.store.getDefaultTeams === 'function' && !!pending(page.fake, 'teams.list', undefined))
        const original = page.store.getDefaultTeams
        page.store.getDefaultTeams = async function () {
            const result = await original.call(this)
            if (!viewing) viewing = this.viewTeam(this.teams.find(t => t.$id === 't2'))
            return result
        }
        pending(page.fake, 'teams.list', undefined).resolve({ teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 })
        await until(() => page.events.some(e => e.type === 'teams-loaded'))
        expect(viewing).toBeTruthy()
        await viewing
        await sleep(30)
        expectOnT2(page.store, cfg)
    })
})
