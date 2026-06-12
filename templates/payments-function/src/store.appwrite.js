/* Payments function — Appwrite-backed store (production)
 *
 * Implements the store interface against Appwrite Databases. Imported only by
 * main.js so the rest of the template stays testable without node-appwrite.
 * Requires a collection with attributes matching the entitlement shape
 * (workspace_id, plan, status, period_end, credits) and a ledger collection
 * (workspace_id, delta, reason, ref, orderId, ts).
 */

import { Client, Databases, Query, ID } from 'node-appwrite'

export function appwriteStore({ endpoint, projectId, apiKey, databaseId, entitlementsCollection, ledgerCollection }) {
    const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey)
    const db = new Databases(client)

    return {
        async getEntitlement(ws) {
            const r = await db.listDocuments(databaseId, entitlementsCollection, [Query.equal('workspace_id', ws), Query.limit(1)])
            return r.documents[0] || null
        },
        async putEntitlement(e) {
            const existing = await this.getEntitlement(e.workspace_id)
            const data = { workspace_id: e.workspace_id, plan: e.plan, status: e.status, period_end: e.period_end, credits: e.credits }
            if (existing) return db.updateDocument(databaseId, entitlementsCollection, existing.$id, data)
            return db.createDocument(databaseId, entitlementsCollection, ID.unique(), data)
        },
        async appendLedger(entry) {
            return db.createDocument(databaseId, ledgerCollection, ID.unique(), entry)
        },
        async hasLedger({ orderId, reason }) {
            const queries = [Query.equal('orderId', orderId), Query.limit(1)]
            if (reason) queries.unshift(Query.equal('reason', reason))
            const r = await db.listDocuments(databaseId, ledgerCollection, queries)
            return r.documents.length > 0
        }
    }
}
