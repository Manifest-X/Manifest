// @vitest-environment happy-dom
/**
 * currentTeamMembershipStatus is reactive in Alpine: an effect bound to it re-runs as the store changes.
 */
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE = readFileSync(path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.store.js'), 'utf8')

describe('currentTeamMembershipStatus in Alpine', () => {
    it('re-evaluates when the team, user and own membership change', async () => {
        window.Alpine = Alpine
        window.ManifestAppwriteAuthConfig = { getAppwriteClient: async () => null, getAppwriteConfig: async () => ({}) }
        new Function(STORE)()
        Alpine.start()
        const store = Alpine.store('auth')
        const seen = []
        Alpine.effect(() => { seen.push(store.currentTeamMembershipStatus) })
        const tick = () => new Promise(r => Alpine.nextTick(r))
        await tick()
        Object.assign(store, { isAuthenticated: true, user: { $id: 'uA' } })
        store.currentTeam = { $id: 't1' }
        await tick()
        store._ownMembership = { teamId: 't1', userId: 'uA', membership: null, status: 'none' }
        await tick()
        store.currentTeamMemberships = [{ $id: 'm1', teamId: 't1', userId: 'uA', roles: ['owner'] }]
        await tick()
        store.currentTeam = { $id: 't2' }
        await tick()
        expect(seen.filter((v, i) => v !== seen[i - 1])).toEqual([null, 'loading', 'none', 'ready', 'loading'])
    })
})
