// @vitest-environment happy-dom
/**
 * Fail-safe scoped reads: a team/user-scoped table load whose scope value
 * hasn't resolved yet (e.g. `currentTeam` not loaded) must not send Appwrite
 * a broken/empty query — it skips the network call, leaves the source
 * pending, and retries once auth settles further (manifest:auth:teams-loaded
 * / login / initialized). Regression: previously an unresolved `$auth.`
 * interpolation reached Appwrite as a literal `null`/empty equal, producing
 * a 400 and a source that landed empty-but-done until a manual reload.
 *
 * Same loader pattern as data-stale-first.test.js, but with the REAL
 * manifest.data.queries.js (not stubbed) so the null/"not ready" path is
 * genuinely exercised end to end.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, '../src/scripts/data')
const SUBSCRIPTS = [
    'core/manifest.data.config.js',
    'appwrite/manifest.data.queries.js',
    'core/manifest.data.store.js',
    'shared/manifest.data.mutations.js',
    'shared/manifest.data.proxies.core.js',
    'shared/manifest.data.proxies.cache.js',
    'shared/proxies/creation/manifest.data.proxies.helpers.js',
    'shared/proxies/creation/manifest.data.proxies.array.js',
    'shared/proxies/creation/manifest.data.proxies.route.js',
    'shared/manifest.data.proxies.appwrite.js',
    'shared/manifest.data.proxies.magic.state.js',
    'shared/manifest.data.proxies.magic.core.js',
    'shared/manifest.data.main.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const released = []
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ $id: `${prefix}${i}` }))

async function load() {
    window.Alpine = Alpine
    Alpine.store('auth', { _initialized: true, isAuthenticated: true, user: { $id: 'u1' }, currentTeam: null, teams: [] })

    const manifest = {
        appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db' },
        data: {
            projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', scope: 'team' },
        }
    }
    const net = { tableCalls: 0, tableRows: rows('t', 2) }
    window.ManifestDataAppwrite = {
        loadTableRows: async () => { net.tableCalls++; return net.tableRows.map(r => ({ ...r })) }
    }
    delete window.ManifestDataRealtime
    window.ManifestComponentsRegistry = { manifest }

    const ctx = {
        window, document, Alpine, console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
    return { net, main: window.ManifestDataMain, data: () => Alpine.store('data') }
}

afterEach(() => { released.splice(0).forEach(e => Alpine.release(e)); document.body.innerHTML = '' })

describe('scoped read fail-safe (auth not settled)', () => {
    it('a team scope with no currentTeam yet: no network call, source stays pending, then retries and lands on teams-loaded', async () => {
        const { net, main, data } = await load()

        await main.loadDataSource('projects')
        await settle(50)

        expect(net.tableCalls).toBe(0)
        expect(data().projects ?? null).toBeNull()
        expect(data()._projects_state?.ready).not.toBe(true)

        // Team now loaded — the pending read should retry on its own
        Alpine.store('auth').currentTeam = { $id: 't1' }
        window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded'))
        await settle(80)

        expect(net.tableCalls).toBe(1)
        expect(data().projects?.map(r => r.$id)).toEqual(['t0', 't1'])
    })

    it('an unrelated auth event (login) also triggers the retry', async () => {
        const { net, main } = await load()
        await main.loadDataSource('projects')
        await settle(50)
        expect(net.tableCalls).toBe(0)

        Alpine.store('auth').currentTeam = { $id: 't1' }
        window.dispatchEvent(new CustomEvent('manifest:auth:login'))
        await settle(80)

        expect(net.tableCalls).toBe(1)
    })
})
