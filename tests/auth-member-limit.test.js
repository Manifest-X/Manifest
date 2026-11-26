/**
 * auth.teams.memberLimit sets the page size of the framework's own member listings; the store
 * exposes the listing's total and a cursor to continue from.
 */
import { readFileSync } from 'fs'
import path from 'path'
import vm from 'vm'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import { boot, until, sleep } from './helpers/auth-boot-harness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_SRC = readFileSync(path.join(process.env.AUTH_SRC_DIR || path.join(__dirname, '../src/scripts/auth'), 'manifest.appwrite.auth.config.js'), 'utf8')
const user = { $id: 'uA' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const limitQuery = n => JSON.stringify({ method: 'limit', values: [n] })
const manyMembers = (teamId, n) => Array.from({ length: n }, (_, i) => ({ $id: `${teamId}-m${i}`, userId: i ? `u${i}` : 'uA', roles: ['owner'], confirm: true }))

function start(cfg, opts = {}) {
    return boot({
        cfg, persisted, ...opts,
        responder: (name, arg) => ({
            'account.get': user,
            'account.listSessions': { sessions: [{ $id: 's1', current: true, provider: 'email' }] },
            'teams.list': { teams: [{ $id: 't1', name: 'One' }, { $id: 't2', name: 'Two' }], total: 2 },
            'teams.listMemberships': { memberships: manyMembers(arg?.teamId, 100), total: 250 },
            'teams.getPrefs': {},
        })[name],
    })
}
const memberCalls = fake => fake.calls.filter(c => c.name === 'teams.listMemberships').map(c => [c.args[0].teamId, c.args[0].queries])

async function configFor(teams) {
    const warnings = []
    const ctx = { console: { ...console, warn: (...a) => warnings.push(a.join(' ')), error() {} }, setTimeout, Promise, URL, JSON }
    ctx.window = ctx
    ctx.addEventListener = () => {}
    ctx.document = { querySelector: () => null, addEventListener() {} }
    ctx.__manifestLoaded = { appwrite: { endpoint: 'https://a.test/v1', projectId: 'p', auth: { teams } } }
    vm.createContext(ctx)
    vm.runInContext(CONFIG_SRC, ctx)
    const cfg = await ctx.ManifestAppwriteAuthConfig.getAppwriteConfig()
    return { memberLimit: cfg.memberLimit, rememberTeam: cfg.rememberTeam, warnings }
}

describe('auth.teams.remember parsing', () => {
    it('is a boolean, off when absent; interpolated strings read like other auth booleans', async () => {
        expect((await configFor({})).rememberTeam).toBe(false)
        expect((await configFor({ remember: true })).rememberTeam).toBe(true)
        expect((await configFor({ remember: 'true' })).rememberTeam).toBe(true)
        expect((await configFor({ remember: 'false' })).rememberTeam).toBe(false)
    })
})

describe('auth.teams.memberLimit', () => {
    it('validates: integers 1-100 (numeric strings from env interpolation too), else Appwrite\'s default with one warning', async () => {
        expect((await configFor({ memberLimit: 100 })).memberLimit).toBe(100)
        expect((await configFor({ memberLimit: '100' })).memberLimit).toBe(100)
        expect((await configFor({ memberLimit: 1 })).memberLimit).toBe(1)
        expect((await configFor({})).memberLimit).toBe(null)
        for (const bad of [0, 101, 5000, 1.5, 'abc', -3, true]) {
            const { memberLimit, warnings } = await configFor({ memberLimit: bad })
            expect(memberLimit).toBe(null)
            expect(warnings).toHaveLength(1)
        }
    })

    it('boot, viewTeam and framework re-lists use it; total and cursor are exposed', async () => {
        const p = start({ teams: true, memberLimit: 100 }, { realtime: true })
        await until(() => p.events.some(e => e.type === 'teams-loaded'))
        expect(memberCalls(p.fake)).toEqual([['t1', [limitQuery(100)]]])
        expect(p.store.currentTeamMemberships).toHaveLength(100)
        expect(p.store.currentTeamMembershipsTotal).toBe(250)
        expect(p.store.currentTeamMembershipsCursor).toBe('t1-m99')
        await p.store.viewTeam(p.store.teams[1])
        expect(memberCalls(p.fake).at(-1)).toEqual(['t2', [limitQuery(100)]])
        expect(p.store.currentTeamMembershipsCursor).toBe('t2-m99')
        await until(() => !!p.fake.channels.memberships)
        p.fake.emit('memberships', { events: ['teams.t2.memberships.m1.update'], payload: { teamId: 't2' } })
        await until(() => memberCalls(p.fake).length >= 3)
        await sleep(30)
        for (const call of memberCalls(p.fake).slice(2)) expect(call).toEqual(['t2', [limitQuery(100)]])
    })

    it('explicit queries are sent as given', async () => {
        const p = start({ teams: true, memberLimit: 100 })
        await until(() => p.events.some(e => e.type === 'teams-loaded'))
        await p.store.listMemberships('t1', ['custom'])
        expect(memberCalls(p.fake).at(-1)).toEqual(['t1', ['custom']])
    })

    it('absent: requests unchanged (no queries); cursor null once everything is listed', async () => {
        const p = boot({
            cfg: { teams: true }, persisted,
            responder: (name, arg) => ({
                'account.get': user,
                'account.listSessions': { sessions: [{ $id: 's1', current: true, provider: 'email' }] },
                'teams.list': { teams: [{ $id: 't1', name: 'One' }], total: 1 },
                'teams.listMemberships': { memberships: manyMembers(arg?.teamId, 3), total: 3 },
                'teams.getPrefs': {},
                'account.deleteSession': {},
            })[name],
        })
        await until(() => p.events.some(e => e.type === 'teams-loaded'))
        expect(memberCalls(p.fake)).toEqual([['t1', []]])
        expect(p.store.currentTeamMembershipsTotal).toBe(3)
        expect(p.store.currentTeamMembershipsCursor).toBe(null)
        await p.store.logout().catch(() => {})
        expect(p.store.currentTeamMembershipsTotal).toBe(0)
    })
})

describe('optimistic member removal', () => {
    it('lowers the total with the list, so the cursor never points past the end', async () => {
        const members = Array.from({ length: 5 }, (_, i) => ({ $id: `m${i}`, teamId: 't1', userId: i ? `u${i}` : 'uA', roles: ['owner'], confirm: true }))
        let remaining = members.length
        const p = boot({
            cfg: { teams: true, memberLimit: 4 }, persisted,
            responder: (name, arg, entry) => {
                if (name === 'account.get') return user
                if (name === 'account.listSessions') return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
                if (name === 'teams.list') return { teams: [{ $id: 't1', name: 'One' }], total: 1 }
                if (name === 'teams.getPrefs') return {}
                if (name === 'teams.deleteMembership') return undefined // held: the optimistic state is what is checked
                if (name === 'teams.listMemberships') return { memberships: members.slice(0, 4), total: remaining }
            },
        })
        p.fake.appwrite.teams.deleteMembership = () => new Promise(() => {})
        await until(() => p.events.some(e => e.type === 'teams-loaded'))
        expect(p.store.currentTeamMembershipsTotal).toBe(5)
        expect(p.store.currentTeamMembershipsCursor).toBe('m3')
        p.store.deleteMembership('t1', 'm3')
        await sleep(10)
        expect(p.store.currentTeamMemberships.map(m => m.$id)).toEqual(['m0', 'm1', 'm2'])
        expect(p.store.currentTeamMembershipsTotal).toBe(4)
        expect(p.store.currentTeamMembershipsCursor).toBe('m2')
        p.store.deleteMembership('t1', 'missing')
        await sleep(10)
        expect(p.store.currentTeamMembershipsTotal).toBe(4)
    })
})

describe('memberLimit absent: request order unchanged', () => {
    it('a realtime membership event issues its member listing before the team re-list, as in 0.5.340', async () => {
        const p = boot({
            cfg: { teams: true }, persisted, realtime: true,
            responder: (name, arg) => ({
                'account.get': user,
                'account.listSessions': { sessions: [{ $id: 's1', current: true, provider: 'email' }] },
                'teams.list': { teams: [{ $id: 't1', name: 'One' }], total: 1 },
                'teams.listMemberships': { memberships: manyMembers('t1', 3), total: 3 },
                'teams.getPrefs': {},
            })[name],
        })
        await until(() => p.events.some(e => e.type === 'teams-loaded') && !!p.fake.channels.memberships)
        const before = p.fake.calls.length
        p.fake.emit('memberships', { events: ['teams.t1.memberships.x.update'], payload: { teamId: 't1' } })
        await sleep(80)
        expect(p.fake.names().slice(before)).toEqual(['teams.listMemberships', 'teams.list', 'teams.listMemberships'])
    })
})
