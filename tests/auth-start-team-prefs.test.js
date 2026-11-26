/**
 * A prefetched prefs read for the starting team is used only when it succeeded: any failure gives way
 * to the normal read, so the boot state equals a boot without the prefetch for every prefs outcome.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, noSession, offline, snapshot } from './helpers/auth-boot-harness.js'

const user = { $id: 'uA' }
const persisted = { isAuthenticated: true, isAnonymous: false, user }
const project = { endpoint: 'https://cloud.test/v1', projectId: 'p1' }
const cfg = { ...project, teams: true, memberRoles: { Admin: ['inviteMembers'], Viewer: [] } }
const key = `manifest:auth:team:${project.endpoint}|${project.projectId}|uA`
const PREFS = { roles: { Custom: ['renameTeam', 'inviteMembers'] } }

// The first getPrefs (the prefetch when on) answers `first`; every later one succeeds
async function run({ prefetch, first }) {
    let reads = 0
    const p = boot({
        cfg: prefetch ? { ...cfg, rememberTeam: true } : cfg,
        persisted, local: prefetch ? { [key]: 't1' } : {},
        responder: (name, arg, entry) => {
            if (name === 'account.get') return user
            if (name === 'account.listSessions') return { sessions: [{ $id: 's1', current: true, provider: 'email' }] }
            if (name === 'teams.list') return { teams: [{ $id: 't1', name: 'One' }], total: 1 }
            if (name === 'teams.listMemberships') return { memberships: [{ $id: 'm1', teamId: 't1', userId: 'uA', roles: ['Custom', 'owner'], confirm: true }], total: 1 }
            if (name === 'teams.getPrefs') {
                if (reads++ === 0 && prefetch) {
                    if (first === 'hang') return undefined
                    if (first === 'throw') throw new Error('sync throw')
                    if (first !== 'ok') return first()
                }
                return PREFS
            }
        },
    })
    p.store._prefetchWaitMs = 100
    await until(() => p.events.some(e => e.type === 'teams-loaded'), 3000)
    await sleep(20)
    return { state: snapshot(p.store), sync: p.store.hasTeamPermissionSync('renameTeam') }
}

describe('prefetched prefs outcome never changes the boot result', () => {
    const outcomes = { ok: 'ok', '401': () => noSession(), offline: () => offline(), 'server error': () => new Error('Server error'), 'sync throw': 'throw', hang: 'hang' }
    for (const [label, first] of Object.entries(outcomes)) {
        it(`prefetch ${label}: same state as without the prefetch`, async () => {
            const off = await run({ prefetch: false })
            const on = await run({ prefetch: true, first })
            expect(on).toEqual(off)
            expect(on.state.permissions.renameTeam).toBe(true)
            expect(on.state.allRoles.Custom).toEqual(['renameTeam', 'inviteMembers'])
        })
    }
})
