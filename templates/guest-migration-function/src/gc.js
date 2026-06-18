/* Garbage collection for abandoned guests. Runs on a schedule (server-only).
 * Deletes anonymous users whose last activity is older than the cooldown, and
 * any team that was left with that guest as its sole member. Teams that gained
 * a real member (or were migrated) are left alone. Read-then-delete: candidates
 * are collected first so deletions don't disturb pagination. */
import { Query } from 'node-appwrite'

function isGuestUser(user) {
    return !user.email && !user.phone && !user.passwordUpdate
}

export async function gc({ users, teams: teamsSvc, cooldownDays = 30, max = 500, log = () => {} }) {
    const cutoff = new Date(Date.now() - cooldownDays * 86400000).toISOString()

    // 1. Collect stale-guest candidates (read-only paginate).
    const candidates = []
    let offset = 0
    for (;;) {
        const page = await users.list([Query.limit(100), Query.offset(offset)])
        if (!page.users.length) break
        for (const u of page.users) {
            if (!isGuestUser(u)) continue
            const lastSeen = u.accessedAt || u.$updatedAt || u.$createdAt
            if (lastSeen && lastSeen < cutoff) candidates.push(u.$id)
        }
        offset += page.users.length
        if (page.users.length < 100 || candidates.length >= max) break
    }

    log(`gc: ${candidates.length} stale guest(s) past ${cooldownDays}d cooldown`)

    // 2. Reap each: delete sole-member teams, then the user.
    let deletedUsers = 0, deletedTeams = 0
    for (const userId of candidates) {
        let memberships = []
        try { memberships = (await users.listMemberships(userId)).memberships || [] } catch { /* user vanished */ }
        for (const m of memberships) {
            let teamMembers
            try { teamMembers = (await teamsSvc.listMemberships(m.teamId)).memberships || [] } catch { continue }
            if (teamMembers.length === 1 && teamMembers[0].userId === userId) {
                try { await teamsSvc.delete(m.teamId); deletedTeams++ } catch { /* already gone */ }
            }
        }
        try { await users.delete(userId); deletedUsers++ } catch { /* already gone */ }
    }

    return { scanned: candidates.length, deletedUsers, deletedTeams }
}
