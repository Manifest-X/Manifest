/**
 * @vitest-environment happy-dom
 *
 * Appwrite queries: every documented operator reaches the SDK, named queries resolve against
 * the source's `queries` object, and scope is applied whatever shape the queries take.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const load = (f) => new Function(readFileSync(path.join(dir, '../src/scripts/data', f), 'utf8'))()

// Mirrors the SDK: each method serializes to {method, attribute, values}
const Query = new Proxy({}, {
    get: (_, method) => (...args) => {
        if (method === 'or' || method === 'and') return JSON.stringify({ method, values: args[0].map(q => JSON.parse(q)) })
        const [attribute, ...values] = args
        return JSON.stringify({ method, attribute, values })
    }
})
const methods = (qs) => qs.map(q => JSON.parse(q).method)

let source, loaded
beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    Alpine.store('auth', { _initialized: true, isAuthenticated: true, user: { $id: 'u1' }, userId: 'u1', teams: [] })
    window.Appwrite = { Query }
    window.ManifestDataConfig = {
        ensureManifest: async () => ({ data: { projects: source } }),
        isAppwriteCollection: () => true,
        getAppwriteConfig: async () => ({ databaseId: 'db' }),
        getAppwriteTableId: () => 'tid',
        getAppwriteBucketId: () => null,
        getScope: (d) => d.scope || null,
        getScopeColumns: () => ({}),
    }
    window.ManifestDataAppwrite = { loadTableRows: async (db, t, qs) => { loaded.push(qs); return [] } }
    load('appwrite/manifest.data.queries.js')
    load('shared/manifest.data.proxies.appwrite.js')
})
beforeEach(() => { loaded = []; Alpine.store('data', {}) })

const handler = () => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('projects', () => {})

describe('operators', () => {
    it('serializes every documented operator', async () => {
        const qs = await window.ManifestDataQueries.buildAppwriteQueries([
            ['between', 'price', 10, 50], ['isNull', 'deletedAt'], ['isNotNull', 'email'],
            ['startsWith', 'name', 'a'], ['endsWith', 'name', 'z'], ['orderRandom'],
            ['greaterThanEqual', 'p', 1], ['lessThanEqual', 'p', 9],
        ], null)
        expect(methods(qs)).toEqual(['between', 'isNull', 'isNotNull', 'startsWith', 'endsWith', 'orderRandom', 'greaterThanEqual', 'lessThanEqual'])
        expect(JSON.parse(qs[0]).values).toEqual([10, 50])
    })

    it('accepts the local-source spellings greaterThanOrEqual and lessThanOrEqual', async () => {
        const qs = await window.ManifestDataQueries.buildAppwriteQueries([['greaterThanOrEqual', 'p', 1], ['lessThanOrEqual', 'p', 9]], null)
        expect(methods(qs)).toEqual(['greaterThanEqual', 'lessThanEqual'])
        const { rowMatchesQueries } = window.ManifestDataQueries
        expect(rowMatchesQueries({ p: 10 }, [['lessThanOrEqual', 'p', 9]])).toBe(false)
        expect(rowMatchesQueries({ p: 9 }, [['lessThanOrEqual', 'p', 9]])).toBe(true)
    })

    it('the realtime matcher agrees with the load on serialized operators', () => {
        const { rowMatchesQueries } = window.ManifestDataQueries
        expect(rowMatchesQueries({ price: 70 }, [['between', 'price', 10, 50]])).toBe(false)
        expect(rowMatchesQueries({ name: 'x' }, [['orderRandom']])).toBe(true)
    })
})

describe('named queries and scope', () => {
    it('$query(name) loads the named query with scope', async () => {
        source = { scope: 'user', queries: { default: [['orderDesc', '$createdAt']], active: [['equal', 'status', 'active']] } }
        await handler()('$query', 'active')
        expect(loaded[0].map(q => JSON.parse(q))).toEqual([
            { method: 'equal', attribute: 'userId', values: ['u1'] },
            { method: 'equal', attribute: 'status', values: ['active'] },
        ])
    })

    it('$query with an unknown name throws instead of loading unfiltered', async () => {
        source = { scope: 'user', queries: { active: [['equal', 'status', 'active']] } }
        await expect(handler()('$query', 'missing')).rejects.toThrow(/missing/)
        expect(loaded).toEqual([])
    })

    it('a queries object without default still applies scope at load', async () => {
        const qs = await window.ManifestDataQueries.buildAppwriteQueries({ active: [['equal', 'status', 'active']] }, 'user')
        expect(qs.map(q => JSON.parse(q))).toEqual([{ method: 'equal', attribute: 'userId', values: ['u1'] }])
    })
})
