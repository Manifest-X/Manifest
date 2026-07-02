import { Client, TablesDB, Query } from 'node-appwrite'

// Deletes chat_messages rows older than CHAT_TTL_HOURS (default 24).
// Run on a schedule (e.g. hourly). A manual execution can pass
// { "ttlHours": N } in the body to override — { "ttlHours": 0 } empties the table.
export default async ({ req, res, log }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(req.headers['x-appwrite-key'] || process.env.APPWRITE_API_KEY)
    const db = new TablesDB(client)

    const databaseId = process.env.CHAT_DATABASE_ID
    const tableId = process.env.CHAT_TABLE_ID || 'chat_messages'
    let body = {}
    try { body = req.bodyJson || JSON.parse(req.bodyRaw || '{}') } catch (_) { }
    const ttlHours = Number(body.ttlHours ?? process.env.CHAT_TTL_HOURS ?? 24)
    const cutoff = new Date(Date.now() - ttlHours * 3600e3).toISOString()

    let deleted = 0
    for (; ;) {
        const r = await db.listRows({
            databaseId, tableId,
            queries: [Query.lessThan('$createdAt', cutoff), Query.limit(100)]
        })
        for (const row of r.rows) {
            await db.deleteRow({ databaseId, tableId, rowId: row.$id })
            deleted++
        }
        if (r.rows.length < 100) break
    }

    log(`pruned ${deleted} row(s) older than ${ttlHours}h`)
    return res.json({ deleted, cutoff })
}
