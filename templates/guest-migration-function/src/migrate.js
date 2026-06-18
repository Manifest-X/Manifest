/* Guest-team migration core. The privileged membership reassignment here is the
 * exact sequence validated against a live Appwrite project: add the new user to
 * each of the guest's teams with the guest's roles (server-side createMembership
 * is auto-confirmed — no invite email / accept step), drop the guest's membership,
 * then delete the guest. Team documents, prefs, and roles are untouched, so any
 * team-scoped data carries over intact. */
import { signTicket, verifyTicket } from './ticket.js'

function isGuestUser(user) {
    // Anonymous accounts have no email, phone, or password set.
    return !user.email && !user.phone && !user.passwordUpdate
}

// prepare: called WHILE the guest session is active. Returns a signed ticket
// binding this guest + the teams it owns, for redemption after sign-in.
export async function prepare({ users, callerId, secret, ttl }) {
    const user = await users.get(callerId)
    if (!isGuestUser(user)) {
        return { ok: false, status: 400, error: 'caller is not a guest account' }
    }
    const memberships = (await users.listMemberships(callerId)).memberships || []
    const teams = memberships.map(m => ({ teamId: m.teamId, roles: m.roles }))
    if (!teams.length) return { ok: true, ticket: null, teams: [] }
    return { ok: true, ticket: signTicket({ guestId: callerId, teams }, secret, ttl), teams: teams.map(t => t.teamId) }
}

// commit: called AFTER sign-in as the new account. Redeems the ticket and moves
// each team from the guest to the caller. Idempotent — teams already migrated
// (guest no longer a member) are skipped, so a retry is safe.
export async function commit({ users, teams: teamsSvc, callerId, ticket, secret, deleteGuest = true }) {
    const payload = verifyTicket(ticket, secret)
    if (!payload) return { ok: false, status: 401, error: 'invalid or expired ticket' }
    if (payload.guestId === callerId) return { ok: false, status: 400, error: 'caller is the guest itself' }

    const migrated = []
    for (const { teamId, roles } of payload.teams) {
        let members
        try { members = (await teamsSvc.listMemberships(teamId)).memberships || [] }
        catch { continue } // team gone — nothing to migrate
        const guestMembership = members.find(m => m.userId === payload.guestId)
        if (!guestMembership) continue // already migrated / removed — idempotent
        if (!members.some(m => m.userId === callerId)) {
            await teamsSvc.createMembership(teamId, (roles && roles.length) ? roles : guestMembership.roles, undefined, callerId)
        }
        await teamsSvc.deleteMembership(teamId, guestMembership.$id)
        migrated.push(teamId)
    }

    let guestDeleted = false
    if (deleteGuest) {
        try { await users.delete(payload.guestId); guestDeleted = true }
        catch { /* leave for GC to reap */ }
    }
    return { ok: true, migrated, guestDeleted }
}
