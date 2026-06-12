/* Payments function — storage interface
 *
 * A store exposes three methods the handler uses. memoryStore() is dependency-
 * free (used by tests/local). The Appwrite-backed production store lives in
 * store.appwrite.js so this file stays importable without node-appwrite.
 *
 *   getEntitlement(workspaceId)   -> record | null
 *   putEntitlement(record)        -> record       (upsert, keyed by workspace_id)
 *   appendLedger(entry)           -> entry        (append-only audit row)
 *   hasLedger({ orderId, reason }) -> boolean     (idempotency: was this order
 *                                                  already granted/refunded?)
 */

export function memoryStore() {
    const entitlements = new Map()
    const ledger = []
    return {
        async getEntitlement(ws) { return entitlements.get(ws) || null },
        async putEntitlement(e) { entitlements.set(e.workspace_id, { ...e }); return e },
        async appendLedger(entry) { ledger.push({ ...entry }); return entry },
        async hasLedger({ orderId, reason }) {
            return ledger.some((l) => l.orderId === orderId && (!reason || l.reason === reason))
        },
        _dump() { return { entitlements: [...entitlements.values()], ledger: [...ledger] } }
    }
}
