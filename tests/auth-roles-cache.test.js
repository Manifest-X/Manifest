/**
 * @vitest-environment happy-dom
 *
 * Team prefs are read once per team for every permission check in a window,
 * not once per check; a prefs write or any auth change drops the cache.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.teams.roles.js'), 'utf8')
const api = new Function('window', 'document', `${SRC}\nreturn { getUserGeneratedRoles, invalidateRolesCache };`)(window, document)

let reads
const appwrite = { teams: { getPrefs: async ({ teamId }) => { reads.push(teamId); return teamId === 'none' ? {} : { roles: { editor: ['inviteMembers'] } } } } }
beforeEach(() => { reads = []; api.invalidateRolesCache() })

describe('user-generated roles cache', () => {
    it('shares one read per team across concurrent and repeated checks', async () => {
        const [a, b, c] = await Promise.all([api.getUserGeneratedRoles('t1', appwrite), api.getUserGeneratedRoles('t1', appwrite), api.getUserGeneratedRoles('t2', appwrite)])
        expect(a).toEqual(b)
        expect(c).toBeTruthy()
        await api.getUserGeneratedRoles('t1', appwrite)
        expect(reads).toEqual(['t1', 't2'])
    })

    it('caches "no custom roles" too', async () => {
        expect(await api.getUserGeneratedRoles('none', appwrite)).toBe(null)
        expect(await api.getUserGeneratedRoles('none', appwrite)).toBe(null)
        expect(reads).toEqual(['none'])
    })

    it('drops the cache on a prefs write for that team and on any auth change', async () => {
        await api.getUserGeneratedRoles('t1', appwrite)
        api.invalidateRolesCache('t1')
        await api.getUserGeneratedRoles('t1', appwrite)
        window.dispatchEvent(new window.CustomEvent('manifest:auth:teams-loaded'))
        await api.getUserGeneratedRoles('t1', appwrite)
        expect(reads).toEqual(['t1', 't1', 't1'])
    })
})
