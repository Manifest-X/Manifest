// Loads the shipped auth subscripts (build order, one IIFE like the monolith) into a vm
// with a fake Alpine and a fake Appwrite whose calls are controllable deferreds.
import { readFileSync } from 'fs'
import path from 'path'
import vm from 'vm'
import { setMaxListeners } from 'events'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// AUTH_SRC_DIR points the harness at another checkout's sources (master comparison runs)
const SRC_DIR = process.env.AUTH_SRC_DIR || path.join(__dirname, '../../src/scripts/auth')
const FILES = [
    'manifest.appwrite.auth.store.js',
    'manifest.appwrite.auth.main.js',
    'manifest.appwrite.auth.frontend.js',
    'manifest.appwrite.auth.teams.core.js',
    'manifest.appwrite.auth.teams.defaults.js',
    'manifest.appwrite.auth.teams.roles.defaults.js',
    'manifest.appwrite.auth.teams.roles.js',
    'manifest.appwrite.auth.teams.userRoles.js',
    'manifest.appwrite.auth.teams.members.js',
    'manifest.appwrite.auth.teams.callbacks.js',
    'manifest.appwrite.auth.teams.convenience.js',
    'manifest.appwrite.auth.users.anonymous.js',
    'manifest.appwrite.auth.users.magic.js',
    'manifest.appwrite.auth.users.otp.js',
    'manifest.appwrite.auth.users.phone.js',
    'manifest.appwrite.auth.users.oauth.js',
    'manifest.appwrite.auth.users.callbacks.js',
]
const BUNDLE = `(function () {\n${FILES.map(f => readFileSync(path.join(SRC_DIR, f), 'utf8')).join('\n\n')}\n})();`

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms
    while (!fn()) {
        if (Date.now() > end) throw new Error('until: timed out')
        await sleep(2)
    }
}

export function noSession() { const e = new Error('User (role: guests) missing scope (account)'); e.code = 401; e.type = 'general_unauthorized_scope'; return e }
export function offline() { return new TypeError('Failed to fetch') }

// Fake Appwrite: every call is recorded with what else was in flight; `responder` answers it
// (value, Error, or undefined to leave it pending for the test to settle by hand)
export function fakeAppwrite(responder) {
    const calls = []
    const channels = {}
    const pending = () => calls.filter(c => !c.settled)
    const call = (name) => (...args) => {
        let resolve, reject
        const promise = new Promise((res, rej) => { resolve = res; reject = rej })
        const entry = { name, args, inflightAtStart: pending().map(c => c.name), settled: false }
        entry.resolve = v => { if (!entry.settled) { entry.settled = true; resolve(v) } }
        entry.reject = e => { if (!entry.settled) { entry.settled = true; reject(e) } }
        calls.push(entry)
        const answer = responder(name, args[0], entry)
        if (answer !== undefined) setTimeout(() => (answer instanceof Error ? entry.reject(answer) : entry.resolve(answer)), 1)
        return promise
    }
    const appwrite = {
        account: Object.fromEntries(['get', 'listSessions', 'deleteSession', 'createAnonymousSession', 'listIdentities', 'createSession', 'getSession'].map(n => [n, call(`account.${n}`)])),
        teams: Object.fromEntries(['list', 'listMemberships', 'getPrefs', 'updatePrefs', 'get', 'create', 'delete', 'updateMembership'].map(n => [n, call(`teams.${n}`)])),
        realtime: null,
    }
    // Opt-in realtime: subscribe records the handler per channel; emit() drives it
    const enableRealtime = () => { appwrite.realtime = { subscribe(channel, cb) { channels[channel] = cb; return () => { delete channels[channel] } } } }
    const emit = (channel, response) => channels[channel] && channels[channel](response)
    const settle = (name, value) => {
        const c = calls.find(x => x.name === name && !x.settled)
        if (!c) throw new Error(`settle: no pending ${name}`)
        value instanceof Error ? c.reject(value) : c.resolve(value)
    }
    return { appwrite, calls, names: () => calls.map(c => c.name), settle, pending, enableRealtime, emit, channels }
}

function storage(initial = {}) {
    const m = new Map(Object.entries(initial))
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _map: m }
}

// Boots a page: returns { store, events, fake, window }
// alpineInitAfter: page still loading, Alpine loads after this script; DOMContentLoaded fires first and
// alpine:init that many ms later (the early entry into auth main)
export function boot({ cfg, responder, persisted = null, search = '', realtime = false, alpineInitAfter = null }) {
    const fake = fakeAppwrite(responder)
    if (realtime) fake.enableRealtime()
    const target = new EventTarget()
    const docTarget = new EventTarget()
    setMaxListeners(100, target, docTarget)
    const events = []
    const stores = {}
    const ctx = {
        console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, Promise, URL, URLSearchParams, JSON, Date, Map, Set,
        CustomEvent, Event,
        localStorage: storage(persisted ? { 'manifest:auth:state': JSON.stringify(persisted) } : {}),
        sessionStorage: storage(),
        location: { href: `https://app.test/${search}`, search, pathname: '/', origin: 'https://app.test', hash: '' },
        history: { replaceState() {} },
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        dispatchEvent: target.dispatchEvent.bind(target),
        document: {
            readyState: alpineInitAfter == null ? 'complete' : 'loading', visibilityState: 'visible',
            addEventListener: docTarget.addEventListener.bind(docTarget),
            removeEventListener: docTarget.removeEventListener.bind(docTarget),
            dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
            querySelector: () => null,
        },
    }
    const alpine = {
        magic() {},
        store(name, val) {
            if (val === undefined) return stores[name]
            stores[name] = val
            // Alpine 3 runs a store's own init() on registration
            if (val && Object.prototype.hasOwnProperty.call(val, 'init') && typeof val.init === 'function') val.init()
        },
    }
    if (alpineInitAfter == null) ctx.Alpine = alpine
    ctx.window = ctx
    ctx.ManifestAppwriteAuthConfig = { getAppwriteConfig: async () => cfg, getAppwriteClient: async () => fake.appwrite, ensureManifest: async () => ({}) }
    for (const type of ['initialized', 'teams-loaded', 'login', 'logout', 'anonymous', 'session-cleared']) {
        target.addEventListener(`manifest:auth:${type}`, () => events.push({ type, store: stores.auth && snapshot(stores.auth) }))
    }
    vm.createContext(ctx)
    vm.runInContext(BUNDLE, ctx)
    if (alpineInitAfter == null) {
        docTarget.dispatchEvent(new Event('alpine:init'))
    } else {
        ctx.Alpine = alpine
        ctx.document.readyState = 'interactive'
        docTarget.dispatchEvent(new Event('DOMContentLoaded'))
        setTimeout(() => docTarget.dispatchEvent(new Event('alpine:init')), alpineInitAfter)
    }
    return { store: stores.auth, getStore: () => stores.auth, events, fake, window: ctx }
}

export function snapshot(s) {
    return JSON.parse(JSON.stringify({
        isAuthenticated: s.isAuthenticated,
        isAnonymous: s.isAnonymous,
        user: s.user?.$id || null,
        session: s.session?.$id || null,
        teams: (s.teams || []).map(t => t.$id),
        currentTeam: s.currentTeam?.$id || null,
        memberships: (s.currentTeamMemberships || []).map(m => [m.$id, m.displayRoles || null]),
        deletedTemplateRoles: s.deletedTemplateRoles,
        deletedTemplateTeams: s.deletedTemplateTeams,
        permissions: s._permissionCache,
        userRole: s._userRoleCache,
        allRoles: s._allRolesCache,
    }))
}
