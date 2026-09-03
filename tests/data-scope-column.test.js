/**
 * scopeColumn — data sources can rename the team/user scope column
 * (e.g. `workspaceId` instead of `teamId`) and `$auth.` args interpolate
 * correctly (Alpine.store('auth') IS the auth object, so a path can't
 * start with another 'auth' segment).
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(
    path.join(__dirname, '../src/scripts/data/appwrite/manifest.data.queries.js'),
    'utf8'
)

function load(authStore) {
    const ctx = { console }
    ctx.window = {
        Appwrite: {
            Query: {
                equal: (field, value) => ({ method: 'equal', field, value }),
                or: (queries) => ({ method: 'or', queries }),
            }
        }
    }
    ctx.Alpine = { store: (name) => (name === 'auth' ? authStore : null) }
    ctx.global = ctx
    vm.createContext(ctx)
    vm.runInContext(SRC, ctx, { filename: 'manifest.data.queries.js' })
    return ctx.window.ManifestDataQueries
}

const authed = (overrides = {}) => ({
    _initialized: true,
    isAuthenticated: true,
    user: { $id: 'u1' },
    currentTeam: { $id: 't1' },
    teams: [],
    ...overrides,
})

describe('buildAppwriteQueries — scope column', () => {
    it('defaults to teamId/userId when no scopeColumns given', async () => {
        const api = load(authed())
        const teamQueries = await api.buildAppwriteQueries([], 'team')
        expect(teamQueries).toEqual([{ method: 'equal', field: 'teamId', value: 't1' }])

        const userQueries = await api.buildAppwriteQueries([], 'user')
        expect(userQueries).toEqual([{ method: 'equal', field: 'userId', value: 'u1' }])
    })

    it('uses a custom scopeColumn for team scope', async () => {
        const api = load(authed())
        const queries = await api.buildAppwriteQueries([], 'team', { team: 'workspaceId' })
        expect(queries).toEqual([{ method: 'equal', field: 'workspaceId', value: 't1' }])
    })

    it('uses independent custom columns for a dual user+team scope', async () => {
        const api = load(authed())
        const queries = await api.buildAppwriteQueries([], ['user', 'team'], { team: 'workspaceId', user: 'ownerId' })
        // Two matches -> Query.or([...])
        expect(queries).toEqual([{
            method: 'or',
            queries: [
                { method: 'equal', field: 'ownerId', value: 'u1' },
                { method: 'equal', field: 'workspaceId', value: 't1' },
            ],
        }])
    })

})

describe('ManifestDataConfig.getScopeColumns — resolves scopeColumn config into {team, user}', () => {
    const CONFIG_SRC = readFileSync(
        path.join(__dirname, '../src/scripts/data/core/manifest.data.config.js'),
        'utf8'
    )
    function loadConfig() {
        const ctx = { console, window: {}, fetch: async () => ({ json: async () => ({}) }), document: { querySelector: () => null } }
        ctx.global = ctx
        vm.createContext(ctx)
        vm.runInContext(CONFIG_SRC, ctx, { filename: 'manifest.data.config.js' })
        return ctx.window.ManifestDataConfig
    }

    it('defaults to teamId/userId when unset', () => {
        const { getScopeColumns } = loadConfig()
        expect(getScopeColumns({})).toEqual({ team: 'teamId', user: 'userId' })
        expect(getScopeColumns(undefined)).toEqual({ team: 'teamId', user: 'userId' })
    })

    it('a plain string scopeColumn sets both team and user columns', () => {
        const { getScopeColumns } = loadConfig()
        expect(getScopeColumns({ scopeColumn: 'workspaceId' })).toEqual({ team: 'workspaceId', user: 'workspaceId' })
    })

    it('an object scopeColumn sets team/user independently, falling back to defaults', () => {
        const { getScopeColumns } = loadConfig()
        expect(getScopeColumns({ scopeColumn: { team: 'workspaceId' } })).toEqual({ team: 'workspaceId', user: 'userId' })
        expect(getScopeColumns({ scopeColumn: { team: 'workspaceId', user: 'ownerId' } })).toEqual({ team: 'workspaceId', user: 'ownerId' })
    })
})

describe('$auth. variable interpolation', () => {
    it('"$auth.currentTeam.$id" resolves against the auth store directly (was broken: looked for store.auth)', async () => {
        const api = load(authed())
        const queries = await api.buildAppwriteQueries([['equal', 'workspaceId', '$auth.currentTeam.$id']], null)
        expect(queries).toEqual([{ method: 'equal', field: 'workspaceId', value: 't1' }])
    })

    it('"$auth.userId" resolves a top-level auth store field', async () => {
        const api = load(authed({ userId: 'raw-u1' }))
        const queries = await api.buildAppwriteQueries([['equal', 'ownerId', '$auth.userId']], null)
        expect(queries).toEqual([{ method: 'equal', field: 'ownerId', value: 'raw-u1' }])
    })

    it('interpolateVariable is the documented public entry point for this resolution', () => {
        const api = load(authed())
        expect(api.interpolateVariable('$auth.currentTeam.$id')).toBe('t1')
        expect(api.interpolateVariable('$auth.currentTeam.id')).toBeUndefined()
    })
})
