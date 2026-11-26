/**
 * Team prefs: boot reads each team's prefs once (roles and deleted template roles share the
 * read), every prefs write path leaves the next read fresh, and a realtime team update drops it.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA', email: 'a@x' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const baseCfg = { teams: true, guestTeams: false, memberRoles: { Admin: ['inviteMembers', 'manageRoles'], Viewer: [] } }
const templateCfg = { ...baseCfg, templateRoles: { Editor: ['inviteMembers'], Reviewer: ['renameTeam'] } }
const clone = v => JSON.parse(JSON.stringify(v))

function server(initialPrefs = { roles: { Custom: ['renameTeam'] } }) {
    const state = { prefs: clone(initialPrefs), hold: new Set() }
    state.responder = (name, arg) => {
        if (state.hold.has(name)) return undefined
        switch (name) {
            case 'account.get': return user
            case 'account.listSessions': return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
            case 'teams.list': return { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 }
            case 'teams.listMemberships': return { memberships: [{ $id: 'm1', userId: 'uA', roles: ['Admin', 'owner'], confirm: true }], total: 1 }
            case 'teams.getPrefs': return clone(state.prefs)
            case 'teams.updatePrefs': state.prefs = clone(arg.prefs); return clone(state.prefs)
            case 'teams.updateMembership': return { membership: { userId: 'other' } }
        }
    }
    return state
}

async function bootSignedIn(cfg, srv = server(), opts = {}) {
    const page = boot({ cfg, persisted, responder: srv.responder, ...opts })
    await until(() => page.events.some(e => e.type === 'teams-loaded'))
    await sleep(10)
    return { ...page, srv, prefsReads: () => page.fake.names().filter(n => n === 'teams.getPrefs').length }
}

describe('boot prefs reads', () => {
    it('one teams.getPrefs and one listMemberships without template roles', async () => {
        const { fake, prefsReads } = await bootSignedIn(baseCfg)
        expect(prefsReads()).toBe(1)
        expect(fake.names().filter(n => n === 'teams.listMemberships')).toHaveLength(1)
    })

    it('one teams.getPrefs with template roles (deleted-template lookup shares the read)', async () => {
        const { fake, prefsReads, store } = await bootSignedIn(templateCfg, server({ roles: { Custom: ['renameTeam'] }, deletedTemplateRoles: ['Reviewer'] }))
        expect(prefsReads()).toBe(1)
        expect(fake.names().filter(n => n === 'teams.listMemberships')).toHaveLength(1)
        // getAllRoles drops the deleted template role, as before
        expect(Object.keys(store._allRolesCache).sort()).toEqual(['Admin', 'Custom', 'Viewer'])
    })

    it('a permission check right after teams-loaded does not re-read prefs', async () => {
        const { store, prefsReads } = await bootSignedIn(templateCfg)
        expect(await store.hasTeamPermission('inviteMembers')).toBe(true)
        await store.getAllRoles('t1')
        expect(prefsReads()).toBe(1)
    })

    it('a non-404 cached failure is retried by the deleted-template lookup, as an uncached read would be', async () => {
        const srv = server({ roles: {}, deletedTemplateRoles: ['Reviewer'] })
        let reads = 0
        const responder = (name, arg) => (name === 'teams.getPrefs' && ++reads === 1 ? new Error('Server error') : srv.responder(name, arg))
        const page = boot({ cfg: templateCfg, persisted, responder })
        await until(() => page.events.some(e => e.type === 'teams-loaded'))
        expect(reads).toBe(2)
        expect(await page.store.getDeletedTemplateRoles('t1')).toEqual(['Reviewer'])
    })
})

describe('prefs write paths leave the next read fresh', () => {
    it('createUserRole', async () => {
        const { store } = await bootSignedIn(baseCfg)
        expect((await store.createUserRole('t1', 'Writer', ['inviteMembers'])).success).toBe(true)
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ Custom: ['renameTeam'], Writer: ['inviteMembers'] })
    })

    it('updateUserRole', async () => {
        const { store } = await bootSignedIn(baseCfg)
        expect((await store.updateUserRole('t1', 'Custom', ['deleteTeam'])).success).toBe(true)
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ Custom: ['deleteTeam'] })
    })

    it('renameUserRole', async () => {
        const { store } = await bootSignedIn(baseCfg)
        expect((await store.renameUserRole('t1', 'Custom', 'Renamed')).success).toBe(true)
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ Renamed: ['renameTeam'] })
    })

    it('deleteUserRole (custom role)', async () => {
        const { store } = await bootSignedIn(baseCfg)
        expect((await store.deleteUserRole('t1', 'Custom')).success).toBe(true)
        expect(await store.getUserGeneratedRoles('t1')).toEqual({})
    })

    it('deleteUserRole (template role records the deletion)', async () => {
        const { store } = await bootSignedIn(templateCfg, server({ roles: {} }))
        expect(await store.getDeletedTemplateRoles('t1')).toEqual([])
        expect((await store.deleteUserRole('t1', 'Editor')).success).toBe(true)
        expect(await store.getDeletedTemplateRoles('t1')).toEqual(['Editor'])
    })

    it('reapplyTemplateRole', async () => {
        const { store } = await bootSignedIn(templateCfg, server({ roles: {}, deletedTemplateRoles: ['Editor'] }))
        expect(await store.getDeletedTemplateRoles('t1')).toEqual(['Editor'])
        expect((await store.reapplyTemplateRole('t1', 'Editor')).success).toBe(true)
        expect(await store.getDeletedTemplateRoles('t1')).toEqual([])
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ Editor: ['inviteMembers'] })
    })

    it('ensureDefaultRoles', async () => {
        const { store } = await bootSignedIn(templateCfg, server({ roles: {} }))
        expect(await store.getUserGeneratedRoles('t1')).toEqual({})
        expect((await store.ensureDefaultRoles('t1')).applied).toBe(true)
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ Editor: ['inviteMembers'], Reviewer: ['renameTeam'] })
    })

    it('updateTeamPrefs', async () => {
        const { store } = await bootSignedIn(templateCfg)
        expect((await store.updateTeamPrefs('t1', { roles: { X: [] }, deletedTemplateRoles: ['Editor'] })).success).toBe(true)
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ X: [] })
        expect(await store.getDeletedTemplateRoles('t1')).toEqual(['Editor'])
    })

    it('a read that starts while a write is in flight is not kept past the write', async () => {
        const { store, fake, srv } = await bootSignedIn(baseCfg)
        srv.hold.add('teams.updatePrefs')
        const write = store.updateTeamPrefs('t1', { roles: { New: [] } })
        await until(() => fake.pending().some(c => c.name === 'teams.updatePrefs'))
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ Custom: ['renameTeam'] }) // server not yet updated
        srv.prefs = { roles: { New: [] } }
        fake.settle('teams.updatePrefs', clone(srv.prefs))
        await write
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ New: [] })
    })
})

describe('realtime', () => {
    it('a team update from elsewhere drops cached prefs before the refresh', async () => {
        const { store, fake, srv, prefsReads } = await bootSignedIn(templateCfg, server({ roles: {}, deletedTemplateRoles: [] }), { realtime: true })
        await until(() => !!fake.channels.teams)
        const before = prefsReads()
        srv.prefs = { roles: { Remote: ['renameTeam'] }, deletedTemplateRoles: ['Editor'] }
        fake.emit('teams', { events: ['teams.t1abcdefghijk.update.prefs'], payload: {} })
        await until(() => store.deletedTemplateRoles.length === 1)
        expect(store.deletedTemplateRoles).toEqual(['Editor'])
        expect(prefsReads()).toBeGreaterThan(before)
        expect(await store.getUserGeneratedRoles('t1')).toEqual({ Remote: ['renameTeam'] })
    })
})
