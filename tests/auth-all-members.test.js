/**
 * Internal checks and copies that must see every member (deleteUserRole's role-in-use check, renaming a
 * role, duplicateTeam) page through all members at 100 per page, whatever the shown page size, and never
 * replace the shown list or the user's own membership.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA', email: 'a@x' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const parse = q => { try { return JSON.parse(q) } catch { return null } }

function start({ size = 30, memberLimit = null, rareAt = null, writers = false } = {}) {
    const srv = { prefs: { roles: { rare: ['renameTeam'], writer: ['renameTeam'] } }, members: [], updates: [], invites: [], created: 0, pages: [] }
    srv.members = Array.from({ length: size }, (_, i) => ({
        $id: `m${String(i).padStart(3, '0')}`, teamId: 't1', userId: i === 0 ? 'uA' : `u${i}`, userEmail: `u${i}@x`, confirm: true,
        roles: i === 0 ? ['owner'] : i === rareAt ? ['rare'] : writers ? ['writer'] : ['viewer'],
    }))
    const cfg = { teams: true, memberRoles: { viewer: [] }, ...(memberLimit ? { memberLimit } : {}) }
    const p = boot({
        cfg, persisted,
        responder: (name, arg) => {
            switch (name) {
                case 'account.get': return user
                case 'account.listSessions': return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
                case 'teams.list': return { teams: [{ $id: 't1', name: 'One' }], total: 1 }
                case 'teams.getPrefs': return JSON.parse(JSON.stringify(srv.prefs))
                case 'teams.updatePrefs': srv.prefs = JSON.parse(JSON.stringify(arg.prefs)); return srv.prefs
                case 'teams.create': srv.created++; return { $id: 'dup', name: 'One copy' }
                case 'teams.updateMembership': {
                    srv.updates.push(arg.membershipId)
                    const m = srv.members.find(x => x.$id === arg.membershipId)
                    if (m) m.roles = arg.roles
                    return { ...m, membership: m }
                }
                case 'teams.listMemberships': {
                    const qs = (arg.queries || []).map(parse).filter(Boolean)
                    const limit = qs.find(q => q.method === 'limit')?.values[0] ?? 25
                    const after = qs.find(q => q.method === 'cursorAfter')?.values[0]
                    const eq = qs.find(q => q.method === 'equal')
                    let rows = arg.teamId === 'dup' ? [] : srv.members
                    if (eq) rows = rows.filter(m => eq.values.includes(m[eq.attribute]))
                    const start = after ? rows.findIndex(m => m.$id === after) + 1 : 0
                    if (!eq) srv.pages.push(limit)
                    return { memberships: rows.slice(start, start + limit), total: rows.length }
                }
            }
        },
    })
    p.fake.appwrite.teams.createMembership = async a => { srv.invites.push(a.email || a.userId); return { $id: 'inv' } }
    return { ...p, srv }
}
const loaded = p => until(() => p.events.some(e => e.type === 'teams-loaded'))

for (const memberLimit of [null, 10]) {
    describe(`every member is seen ${memberLimit ? `with memberLimit ${memberLimit}` : 'with the default page'}`, () => {
        it('a role held only by member 30 of 30 cannot be deleted; the shown list is untouched', async () => {
            const p = start({ rareAt: 29, memberLimit })
            await loaded(p)
            const shown = p.store.currentTeamMemberships
            const own = p.store.currentTeamMembership
            const result = await p.store.deleteUserRole('t1', 'rare')
            expect(result.success).toBe(false)
            expect(result.error).toMatch(/assigned/)
            expect(p.srv.prefs.roles.rare).toBeTruthy()
            expect(p.store.currentTeamMemberships).toBe(shown)
            expect(p.store.currentTeamMembership).toBe(own)
        })

        it('renaming a role updates all 30 holders', async () => {
            const p = start({ writers: true, memberLimit })
            await loaded(p)
            expect((await p.store.renameUserRole('t1', 'writer', 'author')).success).toBe(true)
            expect(p.srv.updates).toHaveLength(29)
            expect(p.srv.members.slice(1).every(m => m.roles.includes('author'))).toBe(true)
        })

        it('duplicating a team copies all members', async () => {
            const p = start({ memberLimit })
            await loaded(p)
            expect((await p.store.duplicateTeam('t1', { copyMembers: true, copyRoles: true })).success).toBe(true)
            expect(p.srv.invites).toHaveLength(29)
            expect(new Set(p.srv.invites).size).toBe(29)
        })
    })
}

describe('paging', () => {
    it('pages at 100 through a team of 250', async () => {
        const p = start({ size: 250, rareAt: 249 })
        await loaded(p)
        p.srv.pages.length = 0
        expect((await p.store.deleteUserRole('t1', 'rare')).success).toBe(false)
        expect(p.srv.pages).toEqual([100, 100, 100])
    })

    it('a failed full listing keeps the role (cannot prove it unused)', async () => {
        const p = start({ rareAt: 29 })
        await loaded(p)
        p.fake.appwrite.teams.listMemberships = async () => { throw new Error('offline') }
        const result = await p.store.deleteUserRole('t1', 'viewer2')
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/Could not check/)
    })
})
