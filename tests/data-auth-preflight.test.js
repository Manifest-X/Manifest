/**
 * Regression: the Appwrite data plugin's auth pre-flight must not fan out.
 *
 * Reported by Playcom: ~20 data sources booting produced 16 GET /v1/account
 * in one tick — loadTableRows ran `new Account(client).get()` per load. The
 * fix shares one in-flight check and caches a pass until an auth event fires.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(
    path.join(__dirname, '../src/scripts/data/appwrite/manifest.data.appwrite.js'),
    'utf8'
)

function load({ authPlugin = true, unauthorized = false } = {}) {
    const state = { accountGets: 0, unauthorized }
    const listeners = {}
    const ctx = { console, setTimeout, Promise }
    ctx.window = {
        addEventListener: (type, cb) => { (listeners[type] ||= []).push(cb) },
        dispatchEvent: (ev) => { (listeners[ev.type] || []).forEach(cb => cb(ev)) },
        CustomEvent: class { constructor(t) { this.type = t } },
        Appwrite: {
            Client: class { setEndpoint() { return this } setProject() { return this } },
            Account: class {
                async get() {
                    state.accountGets++
                    if (state.unauthorized) { const e = new Error('Unauthorized'); e.code = 401; throw e }
                    return { $id: 'u1' }
                }
            },
            TablesDB: class { async listRows() { return { rows: [{ $id: 'r1' }] } } },
        },
        ManifestDataConfig: {
            ensureManifest: async () => ({ appwrite: { projectId: 'p', endpoint: 'e' } }),
            interpolateEnvVars: v => v,
        },
    }
    if (authPlugin) ctx.window.ManifestAppwriteAuthConfig = { getAppwriteClient: async () => ({ client: {} }) }
    ctx.document = { addEventListener: () => {} }
    ctx.global = ctx
    vm.createContext(ctx)
    vm.runInContext(SRC, ctx)
    const api = ctx.window.ManifestDataAppwrite
    if (!api?.loadTableRows) throw new Error('loadTableRows not exported')
    return { api, state, fire: type => ctx.window.dispatchEvent(new ctx.window.CustomEvent(type)) }
}

describe('data plugin auth pre-flight dedupe', () => {
    it('16 concurrent table loads share ONE account.get()', async () => {
        const { api, state } = load()
        const rows = await Promise.all(Array.from({ length: 16 }, () => api.loadTableRows('db', 'chats')))
        expect(rows.every(r => r[0].$id === 'r1')).toBe(true)
        expect(state.accountGets).toBe(1)
    })

    it('a pass is cached across later loads until an auth event', async () => {
        const { api, state, fire } = load()
        await api.loadTableRows('db', 'a')
        await api.loadTableRows('db', 'b')
        expect(state.accountGets).toBe(1)
        fire('manifest:auth:logout')
        await api.loadTableRows('db', 'c')
        expect(state.accountGets).toBe(2)
    })

    it('401 rejects every concurrent load with one check, and is NOT cached', async () => {
        const { api, state } = load({ unauthorized: true })
        const results = await Promise.allSettled(Array.from({ length: 5 }, () => api.loadTableRows('db', 'x')))
        expect(results.every(r => r.status === 'rejected' && /not authenticated/.test(r.reason.message))).toBe(true)
        expect(state.accountGets).toBe(1)
        state.unauthorized = false
        await api.loadTableRows('db', 'x')
        expect(state.accountGets).toBe(2)
    })

    it('no auth plugin → no account.get() at all', async () => {
        const { api, state } = load({ authPlugin: false })
        await api.loadTableRows('db', 'x')
        expect(state.accountGets).toBe(0)
    })
})
