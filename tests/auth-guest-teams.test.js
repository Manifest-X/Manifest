/**
 * Regression: guest team auto-seed must survive the startup race where the auth
 * store's init/seed path runs before teams.core.js attaches `listTeams`.
 *
 * The real bug (reported by a downstream project): with
 *   auth.teams = { guests: true, template: ["Acme Games"] }
 * a restored/created guest ended up with EMPTY teams + no currentTeam, because the
 * seed gate skipped silently when `this.listTeams` wasn't attached yet.
 *
 * The fix lives in store.js `_loadTeamsAndSeed`: it now WAITS for the teams module
 * to wire up before loading/seeding. This test loads the real store.js, grabs the
 * real `_loadTeamsAndSeed`, and asserts it seeds even when `listTeams` attaches late.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORE_SRC = readFileSync(
    path.join(__dirname, '../src/scripts/auth/manifest.appwrite.auth.store.js'),
    'utf8'
)

// Build a vm context that loads the real store module and returns the live store.
function loadStore({ appwriteConfig, ensureDefaultTeams }) {
    let storeObj = null
    let alpineInitCb = null

    const ctx = {
        console,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        Promise,
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    }
    ctx.window = {
        addEventListener: () => {},
        dispatchEvent: () => {},
        CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d && d.detail } },
        localStorage: ctx.localStorage,
        // store.js captures `const config = window.ManifestAppwriteAuthConfig`
        ManifestAppwriteAuthConfig: { getAppwriteConfig: async () => appwriteConfig },
        // seeder lives on this global; supply a controllable mock
        ManifestAppwriteAuthTeamsDefaults: { ensureDefaultTeams },
    }
    ctx.document = {
        addEventListener: (ev, cb) => { if (ev === 'alpine:init') alpineInitCb = cb },
    }
    ctx.Alpine = {
        store: (name, val) => {
            if (val !== undefined) { storeObj = val; return }
            return name === 'auth' ? storeObj : null
        },
    }
    ctx.global = ctx
    vm.createContext(ctx)
    vm.runInContext(STORE_SRC, ctx)
    if (!alpineInitCb) throw new Error('store did not register alpine:init')
    alpineInitCb() // -> initializeAuthStore() -> Alpine.store('auth', authStore)
    return storeObj
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

describe('guest team auto-seed (startup race)', () => {
    const cfg = {
        teams: true,
        guestTeams: true,
        templateTeams: ['Acme Games'],
        permanentTeams: null,
    }

    it('_loadTeamsAndSeed waits for listTeams to attach, then loads + seeds', async () => {
        // Seeder mock: stands in for ensureDefaultTeams creating the template team.
        const ensureDefaultTeams = async (store) => {
            store.teams = [{ $id: 't1', name: 'Acme Games' }]
            store.currentTeam = store.teams[0]
        }
        const store = loadStore({ appwriteConfig: cfg, ensureDefaultTeams })
        store.isAuthenticated = true
        store.isAnonymous = true

        // Simulate the race: listTeams is NOT attached yet. Attach it 150ms late,
        // AFTER _loadTeamsAndSeed has already been called.
        expect(typeof store.listTeams).not.toBe('function')
        setTimeout(() => {
            store.listTeams = async function () { /* no existing teams to load yet */ }
        }, 150)

        await store._loadTeamsAndSeed(cfg)

        expect(store.teams.map(t => t.name)).toContain('Acme Games')
        expect(store.currentTeam).toBeTruthy()
        expect(store.currentTeam.name).toBe('Acme Games')
    })

    it('gives up gracefully (no throw) if the teams module never attaches', async () => {
        const ensureDefaultTeams = async () => { throw new Error('should not be called') }
        const store = loadStore({ appwriteConfig: cfg, ensureDefaultTeams })
        store.isAuthenticated = true
        store.isAnonymous = true
        // listTeams never attached -> _loadTeamsAndSeed should wait, then return quietly.
        await expect(store._loadTeamsAndSeed(cfg)).resolves.toBeUndefined()
        expect(store.teams).toEqual([])
    }, 5000)
})
