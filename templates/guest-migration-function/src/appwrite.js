/* Server-side Appwrite clients (API key). Kept tiny so the rest stays testable. */
import { Client, Users, Teams } from 'node-appwrite'

export function appwrite({ endpoint, projectId, apiKey }) {
    const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey)
    return { users: new Users(client), teams: new Teams(client) }
}
