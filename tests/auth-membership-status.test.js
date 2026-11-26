/**
 * $auth.currentTeamMembershipStatus tells why currentTeamMembership is what it is: 'loading' while it is
 * being concluded, 'ready' with a membership, 'none' when concluded absent, 'error' after a failed or
 * timed-out lookup, null with no current team or signed out.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, offline } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const project = { endpoint: 'https://cloud.test/v1', projectId: 'p1' }
const parse = q => { try { return JSON.parse(q) } catch { return null } }

function start({ size = 30, myIndex = 29, hold = () => false, fail = () => false, config = {}, local = {}, wait, retry } = {}) {
    const srv = { myIndex, size }
    const members = teamId => Array.from({ length: teamId === 't2' ? 3 : srv.size }, (_, i) => ({
        $id: `${teamId}-m${i}`, teamId, userId: i === (teamId === 't2' ? 1 : srv.myIndex) ? 'uA' : `u${i}`, roles: ['owner'], confirm: true,
    }))
    const p = boot({
        cfg: { ...project, teams: true, ...config }, persisted, local,
        responder: (name, arg) => {
            if (name === 'account.get') return user
            if (name === 'account.listSessions') return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
            if (name === 'account.deleteSession') return {}
            if (name === 'teams.list') return { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 }
            if (name === 'teams.getPrefs') return {}
            if (name !== 'teams.listMemberships') return undefined
            const qs = (arg.queries || []).map(parse).filter(Boolean)
            const own = qs.some(q => q.method === 'equal')
            if (hold(arg, own)) return undefined
            if (fail(arg, own)) return offline()
            const all = members(arg.teamId)
            if (own) return { memberships: all.filter(m => m.userId === 'uA'), total: 1 }
            const rows = arg.search ? all.filter(m => m.userId.includes(arg.search)) : all
            const limit = qs.find(q => q.method === 'limit')?.values[0] ?? 25
            return { memberships: rows.slice(0, limit), total: rows.length }
        },
    })
    if (wait) p.store._prefetchWaitMs = wait
    if (retry) p.store._ownRetryDelays = retry
    return { ...p, srv }
}
const loaded = p => until(() => p.events.some(e => e.type === 'teams-loaded'))
const status = p => p.store.currentTeamMembershipStatus
const pendingOwn = p => p.fake.calls.find(c => !c.settled && c.args[0]?.queries?.some(q => q.includes('"equal"')))
const pendingPage = (p, teamId) => p.fake.calls.find(c => !c.settled && c.name === 'teams.listMemberships' && c.args[0].teamId === teamId && !c.args[0].queries?.some(q => q.includes('"equal"')))
const memberOf = (teamId, i) => ({ $id: `${teamId}-m${i}`, teamId, userId: 'uA', roles: ['owner'], confirm: true })

describe('currentTeamMembershipStatus', () => {
    it('null signed out and with no current team', async () => {
        const p = boot({ cfg: { teams: true }, responder: () => undefined })
        expect(p.store.currentTeamMembershipStatus).toBe(null)
        const q = start({ hold: (a, own) => !own })
        await until(() => q.events.some(e => e.type === 'initialized'))
        expect(q.store.currentTeam).toBe(null)
        expect(status(q)).toBe(null)
    })

    it('loading before the first listing answers, then ready with the user in the page', async () => {
        let held = true
        const p = start({ myIndex: 2, hold: (a, own) => held && !own })
        await until(() => p.store.currentTeam?.$id === 't1' && !!pendingPage(p, 't1'))
        expect(status(p)).toBe('loading')
        held = false
        pendingPage(p, 't1').resolve({ memberships: Array.from({ length: 25 }, (_, i) => i === 2 ? memberOf('t1', 2) : { $id: `t1-m${i}`, teamId: 't1', userId: `u${i}`, roles: ['owner'] }), total: 30 })
        await loaded(p)
        expect(status(p)).toBe('ready')
        expect(p.store.currentTeamMembership).not.toBe(null)
    })

    it('outside the page: loading while the own lookup runs, then ready', async () => {
        const p = start({ hold: (a, own) => own })
        await until(() => !!pendingOwn(p))
        expect(status(p)).toBe('loading')
        pendingOwn(p).resolve({ memberships: [memberOf('t1', 29)], total: 1 })
        await loaded(p)
        expect(status(p)).toBe('ready')
    })

    it('a complete page without the user: none, no lookup', async () => {
        const p = start({ size: 3, myIndex: 99 })
        await loaded(p)
        expect(status(p)).toBe('none')
        expect(pendingOwn(p)).toBeUndefined()
        expect(p.store.currentTeamMembership).toBe(null)
    })

    it('the lookup says not a member: loading, then none', async () => {
        const p = start({ myIndex: 99, hold: (a, own) => own })
        await until(() => !!pendingOwn(p))
        expect(status(p)).toBe('loading')
        pendingOwn(p).resolve({ memberships: [], total: 0 })
        await loaded(p)
        expect(status(p)).toBe('none')
    })

    it('a failed lookup: error while the retry waits, loading while it runs, ready when it succeeds', async () => {
        let ownCalls = 0
        let holdRetry = true
        const p = start({ hold: (a, own) => own && ++ownCalls > 1 && holdRetry, fail: (a, own) => own && ownCalls === 1, retry: [60] })
        await loaded(p)
        expect(status(p)).toBe('error')
        expect(p.store._ownRetryTimer).not.toBe(null)
        await until(() => !!pendingOwn(p))
        expect(status(p)).toBe('loading')
        holdRetry = false
        pendingOwn(p).resolve({ memberships: [memberOf('t1', 29)], total: 1 })
        await until(() => status(p) === 'ready')
    })

    it('a timed-out lookup: error, then ready when the late answer lands', async () => {
        const p = start({ hold: (a, own) => own, wait: 80 })
        await loaded(p)
        expect(status(p)).toBe('error')
        pendingOwn(p).resolve({ memberships: [memberOf('t1', 29)], total: 1 })
        await until(() => status(p) === 'ready')
    })

    it('a re-fetch with a known membership stays ready throughout', async () => {
        let held = false
        const p = start({ hold: (a, own) => own && held })
        await loaded(p)
        expect(status(p)).toBe('ready')
        held = true
        const search = p.store.listMemberships('t1', [], 'u1')
        await until(() => !!pendingOwn(p))
        expect(status(p)).toBe('ready')
        pendingOwn(p).resolve({ memberships: [memberOf('t1', 29)], total: 1 })
        await search
        expect(status(p)).toBe('ready')
    })

    it('after none, a lookup that could still find the user reads loading, never none', async () => {
        let held = false
        const p = start({ myIndex: 99, hold: (a, own) => own && held })
        await loaded(p)
        expect(status(p)).toBe('none')
        held = true
        p.srv.myIndex = 29 // the user has just joined
        const search = p.store.listMemberships('t1', [], 'u2')
        await until(() => !!pendingOwn(p))
        expect(status(p)).toBe('loading')
        pendingOwn(p).resolve({ memberships: [memberOf('t1', 29)], total: 1 })
        await search
        expect(status(p)).toBe('ready')
    })

    it("a team switch reads loading for the new team, never the previous team's status", async () => {
        let holdT2 = true
        const p = start({ size: 3, myIndex: 99, hold: (a, own) => holdT2 && a.teamId === 't2' })
        await loaded(p)
        expect(status(p)).toBe('none')
        const switching = p.store.viewTeam(p.store.teams[1])
        await until(() => !!pendingPage(p, 't2'))
        expect(status(p)).toBe('loading')
        holdT2 = false
        pendingPage(p, 't2').resolve({ memberships: [{ $id: 't2-m1', teamId: 't2', userId: 'uA', roles: ['owner'] }], total: 3 })
        await switching
        expect(status(p)).toBe('ready')
    })

    it('null after logout', async () => {
        const p = start({ myIndex: 2 })
        await loaded(p)
        expect(status(p)).toBe('ready')
        await p.store.logout()
        expect(status(p)).toBe(null)
    })
})

describe('boot with the starting-team prefetch', () => {
    it('remembered team, user outside the prefetched page: loading, then ready', async () => {
        const key = `manifest:auth:team:${project.endpoint}|${project.projectId}|uA`
        const p = start({ config: { rememberTeam: true }, local: { [key]: 't1' }, hold: (a, own) => own })
        await until(() => p.store.currentTeam?.$id === 't1' && !!pendingOwn(p))
        expect(status(p)).toBe('loading')
        pendingOwn(p).resolve({ memberships: [memberOf('t1', 29)], total: 1 })
        await loaded(p)
        expect(status(p)).toBe('ready')
        expect(p.store.currentTeamMembership.$id).toBe('t1-m29')
    })
})
