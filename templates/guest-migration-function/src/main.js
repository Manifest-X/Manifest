/* Guest-migration function — Appwrite entrypoint
 *
 * Routes (the client auth plugin speaks this contract):
 *   POST /prepare   (guest session)  → { ok, ticket, teams:[teamId…] }
 *   POST /commit    (new session)    { ticket } → { ok, migrated:[teamId…], guestDeleted }
 *   POST /gc        (schedule/key)   → { ok, scanned, deletedUsers, deletedTeams }
 *
 * Caller identity comes from Appwrite's forwarded `x-appwrite-user-id` header
 * (set for any execution invoked by an authenticated client). /gc is never a
 * user call — it runs on the function's schedule, or via a shared GC key header.
 *
 * Required env vars:
 *   APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_API_KEY   (key scopes: users.read/write, teams.read/write)
 *   MIGRATION_TICKET_SECRET     HMAC secret for prepare/commit tickets (random, server-only)
 *   MIGRATION_TICKET_TTL        ticket lifetime in seconds (default 600)
 *   GUEST_GC_COOLDOWN_DAYS      abandon-after window for GC (default 30)
 *   GUEST_GC_KEY                optional shared secret to trigger /gc via `x-guest-gc-key`
 */
import { appwrite } from './appwrite.js'
import { prepare, commit } from './migrate.js'
import { gc } from './gc.js'

function parseBody(req) {
    if (req.body && typeof req.body === 'object') return req.body
    try { return JSON.parse(req.bodyRaw || req.body || '{}') } catch { return {} }
}

export default async ({ req, res, log, error }) => {
    const env = {
        // Appwrite auto-injects APPWRITE_FUNCTION_* at runtime; fall back to those so
        // the dynamic-key path needs no manual endpoint/project vars.
        endpoint: process.env.APPWRITE_ENDPOINT || process.env.APPWRITE_FUNCTION_API_ENDPOINT,
        projectId: process.env.APPWRITE_PROJECT || process.env.APPWRITE_FUNCTION_PROJECT_ID,
        // Prefer Appwrite's per-execution dynamic key (granted via function Scopes);
        // fall back to a static APPWRITE_API_KEY env var if you'd rather manage one.
        apiKey: req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY,
        ticketSecret: process.env.MIGRATION_TICKET_SECRET,
        ttl: Number(process.env.MIGRATION_TICKET_TTL || 600),
        cooldownDays: Number(process.env.GUEST_GC_COOLDOWN_DAYS || 30),
        gcKey: process.env.GUEST_GC_KEY
    }
    if (!env.apiKey || !env.ticketSecret) {
        return res.json({ ok: false, error: 'function not configured (APPWRITE_API_KEY / MIGRATION_TICKET_SECRET)' }, 500)
    }

    const { users, teams } = appwrite(env)
    const callerId = req.headers['x-appwrite-user-id'] || null
    const path = (req.path || '/').replace(/\/+$/, '') || '/'

    try {
        if (req.method === 'POST' && path.endsWith('/prepare')) {
            if (!callerId) return res.json({ ok: false, error: 'unauthenticated' }, 401)
            const r = await prepare({ users, callerId, secret: env.ticketSecret, ttl: env.ttl })
            return res.json(r, r.status || 200)
        }

        if (req.method === 'POST' && path.endsWith('/commit')) {
            if (!callerId) return res.json({ ok: false, error: 'unauthenticated' }, 401)
            const r = await commit({ users, teams, callerId, ticket: parseBody(req).ticket, secret: env.ticketSecret })
            return res.json(r, r.status || 200)
        }

        if (path.endsWith('/gc')) {
            // Server-only: a real scheduled execution (no authenticated caller), or an
            // explicit shared-key trigger. The `!callerId` guard means even if a client
            // could spoof x-appwrite-trigger, its session's user id disqualifies it.
            const bySchedule = req.headers['x-appwrite-trigger'] === 'schedule' && !callerId
            const byKey = env.gcKey && req.headers['x-guest-gc-key'] === env.gcKey
            if (!bySchedule && !byKey) return res.json({ ok: false, error: 'forbidden' }, 403)
            const r = await gc({ users, teams, cooldownDays: env.cooldownDays, log })
            return res.json({ ok: true, ...r })
        }

        return res.json({ ok: false, error: 'not found' }, 404)
    } catch (e) {
        error?.(e.message)
        return res.json({ ok: false, error: e.message }, 500)
    }
}
