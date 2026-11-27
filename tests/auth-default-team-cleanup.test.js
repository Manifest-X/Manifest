/**
 * Duplicate default-team cleanup runs inside every listTeams. It may only delete a team this
 * browser seeded as a default, and only in favour of another team this browser seeded: a team
 * the user merely joined (an older or newer foreign team with the default's name) is never
 * deleted and never kept in place of the user's own. Seeds are recorded per user under
 * manifest:default-teams:<userId>; with no record the cleanup does nothing.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const victim = { $id: 'victim', email: 'v@x.test' }
const persisted = { isAuthenticated: true, isAnonymous: false, user: victim }
const KEY = 'manifest:default-teams:victim'
const OLD = '2026-01-01T00:00:00Z'
const MID = '2026-06-01T00:00:00Z'
const NEW = '2026-11-20T00:00:00Z'

function start({ teams, seeded = null, cfg = { teams: true, templateTeams: ['Personal'] } }) {
    const srv = { teams: teams.map(t => ({ ...t })), deleted: [], created: [] }
    const p = boot({
        cfg, persisted,
        local: seeded ? { [KEY]: JSON.stringify(seeded) } : {},
        responder: (name, arg, entry) => {
            switch (name) {
                case 'account.get': return victim
                case 'account.listSessions': return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
                case 'teams.list': return { teams: srv.teams.map(t => ({ ...t })), total: srv.teams.length }
                case 'teams.getPrefs': return {}
                case 'teams.updatePrefs': return {}
                case 'teams.listMemberships': return { memberships: [], total: 0 }
                case 'teams.delete':
                    srv.deleted.push(arg.teamId)
                    srv.teams = srv.teams.filter(t => t.$id !== arg.teamId)
                    return {}
                case 'teams.create': {
                    const team = { $id: entry.args[0], name: entry.args[1], $createdAt: NEW }
                    srv.created.push(team.$id)
                    srv.teams.push(team)
                    return team
                }
            }
            return {}
        },
    })
    return { ...p, srv }
}
const settled = async p => { await until(() => p.events.some(e => e.type === 'teams-loaded')); await sleep(60) }
const record = p => JSON.parse(p.window.localStorage.getItem(KEY) || 'null')

describe('duplicate default-team cleanup only touches this browser\'s seeds', () => {
    it('a genuine two-tab duplicate (both seeded here) keeps the oldest and deletes the other', async () => {
        const p = start({
            teams: [{ $id: 'tA', name: 'Personal', $createdAt: OLD }, { $id: 'tB', name: 'Personal', $createdAt: NEW }],
            seeded: ['tA', 'tB'],
        })
        await settled(p)
        expect(p.srv.deleted).toEqual(['tB'])
        expect(record(p)).toEqual(['tA'])
    })

    it('an older foreign team named like the default never deletes the user\'s own seeded team', async () => {
        const p = start({
            teams: [{ $id: 'tVictim', name: 'Personal', $createdAt: NEW }, { $id: 'tAttacker', name: 'Personal', $createdAt: OLD }],
            seeded: ['tVictim'],
        })
        await settled(p)
        expect(p.srv.deleted).toEqual([])
    })

    it('a newer foreign team named like the default is never deleted', async () => {
        const p = start({
            teams: [{ $id: 'tVictim', name: 'Personal', $createdAt: OLD }, { $id: 'tAttacker', name: 'Personal', $createdAt: NEW }],
            seeded: ['tVictim'],
        })
        await settled(p)
        expect(p.srv.deleted).toEqual([])
    })

    it('a foreign team the user now solely holds is not kept in place of their seeds, nor deleted', async () => {
        // tAttacker: older, created elsewhere; the victim is its only remaining member (owner)
        const p = start({
            teams: [
                { $id: 'tAttacker', name: 'Personal', $createdAt: OLD, total: 1 },
                { $id: 'tA', name: 'Personal', $createdAt: MID },
                { $id: 'tB', name: 'Personal', $createdAt: NEW },
            ],
            seeded: ['tA', 'tB'],
        })
        await settled(p)
        expect(p.srv.deleted).toEqual(['tB'])
        expect(record(p)).toEqual(['tA'])
    })

    it('with no seed record (other device, cleared storage, legacy teams) nothing is deleted', async () => {
        const p = start({
            teams: [{ $id: 'tVictim', name: 'Personal', $createdAt: NEW }, { $id: 'tAttacker', name: 'Personal', $createdAt: OLD }],
        })
        await settled(p)
        expect(p.srv.deleted).toEqual([])
    })

    it('a permanent-team duplicate with no record is not deleted either', async () => {
        const p = start({
            cfg: { teams: true, permanentTeams: ['Personal'] },
            teams: [{ $id: 'tVictim', name: 'Personal', $createdAt: NEW }, { $id: 'tAttacker', name: 'Personal', $createdAt: OLD }],
        })
        await settled(p)
        expect(p.srv.deleted).toEqual([])
    })
})

describe('seeding records the teams it creates', () => {
    it('a brand-new user gets the same default team as before, recorded as a seed', async () => {
        const p = start({ teams: [] })
        await until(() => p.srv.created.length > 0)
        await sleep(60)
        expect(p.srv.created.length).toBe(1)
        expect(p.srv.teams.map(t => t.name)).toEqual(['Personal'])
        expect(record(p)).toEqual(p.srv.created)
        expect(p.srv.deleted).toEqual([])
    })

    it('reapplying a deleted template team records it as a seed', async () => {
        const p = start({ teams: [], seeded: [], cfg: { teams: true, templateTeams: ['Personal', 'Work'] } })
        await until(() => p.srv.created.length === 2)
        await sleep(60)
        const work = p.srv.teams.find(t => t.name === 'Work')
        p.srv.teams = p.srv.teams.filter(t => t !== work)
        await p.store.listTeams()
        const r = await p.store.reapplyTemplateTeam('Work')
        expect(r.success).toBe(true)
        expect(record(p)).toContain(r.team.$id)
    })
})

describe('the user\'s own seeded default is preferred over a same-name foreign team', () => {
    it('the current team is the recorded seed, not a foreign team listed first', async () => {
        const p = start({
            teams: [{ $id: 'tAttacker', name: 'Personal', $createdAt: OLD }, { $id: 'tVictim', name: 'Personal', $createdAt: NEW }],
            seeded: ['tVictim'],
        })
        await settled(p)
        expect(p.store.currentTeam?.$id).toBe('tVictim')
        expect(p.srv.deleted).toEqual([])
    })
})
