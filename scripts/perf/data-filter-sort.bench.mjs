#!/usr/bin/env node
// Filtered+sorted view cost on a $x source (local and Appwrite-shaped), 1k/10k rows.
// Usage: node scripts/perf/data-filter-sort.bench.mjs [--json]
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = process.env.DATA_DIR || path.join(ROOT, 'src/scripts/data')
const SUBSCRIPTS = [
    'core/manifest.data.store.js',
    'shared/manifest.data.mutations.js',
    'shared/manifest.data.proxies.core.js',
    'shared/manifest.data.proxies.cache.js',
    'shared/proxies/creation/manifest.data.proxies.helpers.js',
    'shared/proxies/creation/manifest.data.proxies.array.js',
    'shared/proxies/creation/manifest.data.proxies.route.js',
    'shared/manifest.data.proxies.magic.state.js',
    'shared/manifest.data.proxies.magic.core.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const win = new Window()
for (const k of ['window', 'document', 'MutationObserver', 'CustomEvent', 'Event', 'Node', 'Element', 'HTMLElement']) {
    if (globalThis[k] === undefined) globalThis[k] = k === 'window' ? win : win[k]
}
const AlpineMod = await import('alpinejs'); const Alpine = AlpineMod.default?.store ? AlpineMod.default : (AlpineMod.default?.default || AlpineMod.Alpine)
window.Alpine = Alpine

function load(appwrite) {
    window.__manifestLoaded = appwrite ? { data: { rows: { appwriteTableId: 't' } } } : { data: {} }
    const ctx = {
        window, document, Alpine, console, setTimeout, clearTimeout, performance,
        requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: id => clearTimeout(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    const store = window.ManifestDataStore
    store.initializeStore()
    const loadDataSource = async () => null
    window.ManifestDataMain = { loadDataSource, _loadDataSource: loadDataSource, orderFor: () => null }
    window.ManifestDataProxies.registerXMagicMethod(loadDataSource)
    return { store, $x: () => window._$xProxyFactory() }
}

const STATUSES = ['open', 'closed', 'pending', null]
const row = (i, v = 0) => ({ $id: `r${i}`, name: `Name ${(i * 7919) % 100003} ${v}`, status: STATUSES[i % 4], n: (i * 31) % 997, tags: ['a', 'b'] })
const rows = (n) => Array.from({ length: n }, (_, i) => row(i))
const tick = () => new Promise(r => setTimeout(r, 0))

const QUERY = [['equal', 'status', 'open'], ['orderAsc', 'name']]
const byName = (a, b) => (a.name ?? '').localeCompare(b.name ?? '')
const views = {
    length: ($x) => $x().rows,
    query: ($x) => $x().rows.$query(QUERY),
    template: ($x) => $x().rows.filter(r => r.status === 'open').sort(byName),
    search: ($x) => $x().rows.$search('name 1', 'name'),
    idQuery: ($x) => $x().rows.$query([['equal', '$id', 'r500']]),
    idTemplate: ($x) => $x().rows.filter(r => r.$id === 'r500'),
}

const median = (t) => { t.sort((a, b) => a - b); return t[Math.floor(t.length / 2)] }
const REPS = 7, WARM = 2

// Each reader is one effect (an x-for expression); timings are page time for write + flush
async function measure(ctx, view, n) {
    let k = 0
    const bump = () => ctx.store.landRows('rows', [row(1 + 4 * (k++ % (n / 4 - 1)), k)], { mode: 'append' })
    const read = () => { void view(ctx.$x).length }
    const first = [], reread = []
    for (let i = 0; i < REPS + WARM; i++) {
        await bump(); await tick()
        let s = performance.now(); const a = Alpine.effect(read); const t1 = performance.now() - s
        s = performance.now(); const b = Alpine.effect(read); const t2 = performance.now() - s
        Alpine.release(a); Alpine.release(b)
        if (i >= WARM) { first.push(t1); reread.push(t2) }
    }
    const flush = async (readers, write) => {
        const effects = Array.from({ length: readers }, () => Alpine.effect(read))
        const t = []
        for (let i = 0; i < REPS + WARM; i++) {
            const s = performance.now(); await write(); await tick()
            if (i >= WARM) t.push(performance.now() - s)
        }
        effects.forEach(e => Alpine.release(e))
        return median(t)
    }
    const update = await flush(1, bump)
    const append = await flush(1, () => ctx.store.landRows('rows', [row(n + 100 + k++)], { mode: 'append' }))
    const update20 = await flush(20, bump)
    return { first: median(first), reread: median(reread), update, append, update20 }
}

// Per-row lookup: M readers, each an equal-$id $query with its own id (a related-row lookup in an x-for)
async function lookups(ctx, n, m, view) {
    let k = 0
    const bump = () => ctx.store.landRows('rows', [row(1 + 4 * (k++ % (n / 4 - 1)), k)], { mode: 'append' })
    const s0 = performance.now()
    const effects = Array.from({ length: m }, (_, i) => Alpine.effect(() => { void view(ctx.$x, `r${(i * 13) % n}`).length }))
    const first = performance.now() - s0
    const t = []
    for (let i = 0; i < REPS + WARM; i++) {
        const s = performance.now(); await bump(); await tick()
        if (i >= WARM) t.push(performance.now() - s)
    }
    effects.forEach(e => Alpine.release(e))
    return { first, update: median(t) }
}

const out = []
if (process.argv.includes('--lookups')) {
    for (const n of [1000, 10000]) {
        for (const m of [100, 500]) {
            for (const [name, view] of [['idQuery', ($x, id) => $x().rows.$query([['equal', '$id', id]])], ['idFind', ($x, id) => [$x().rows.find(r => r.$id === id)]]]) {
                const ctx = load(false)
                await ctx.store.landRows('rows', rows(n), { mode: 'replace' })
                out.push({ n, readers: m, view: name, ...(await lookups(ctx, n, m, view)) })
            }
        }
    }
}
else for (const appwrite of [false, true]) {
    for (const n of [1000, 10000]) {
        for (const [name, view] of Object.entries(views)) {
            if (appwrite && (name === 'query' || name === 'idQuery')) { out.push({ source: 'appwrite', n, view: name, note: 'server read; no client $query' }); continue }
            const ctx = load(appwrite)
            await ctx.store.landRows('rows', rows(n), { mode: 'replace' })
            out.push({ source: appwrite ? 'appwrite' : 'local', n, view: name, ...(await measure(ctx, view, n)) })
        }
    }
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out))
else console.table(out.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : v]))))
process.exit(0)
