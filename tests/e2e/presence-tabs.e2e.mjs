/**
 * $presence across many tabs in real Chromium (one browser context, real Web
 * Locks, BroadcastChannel and page visibility). A mock Appwrite server counts
 * presence writes per tab and realtime deliveries per tab (one SSE stream per
 * subscribe). Proves: one writer per browser, leader re-election on close and
 * freeze, status follows the most-active tab, incoming bursts coalesce.
 *
 * Run: node tests/e2e/presence-tabs.e2e.mjs
 * Baseline: PRESENCE_PLUGIN=/path/to/old/manifest.appwrite.presences.js runs
 * the load scenario only, against that file, and prints its counts.
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE = process.env.PRESENCE_PLUGIN || null
const PLUGIN = fs.readFileSync(BASELINE || path.join(ROOT, 'src/scripts/manifest.appwrite.presences.js'), 'utf8')
const ALPINE = fs.readFileSync(path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js'), 'utf8')

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Mock Appwrite backend
let record = null          // the user's presence record (null = absent)
let log = []               // { op, tab, status, t }
const streams = new Set()  // { tab, res }
let deliveries = {}        // tab → realtime messages received
let slow = null            // { tab, ms }: delay that tab's upsert responses
const reset = () => { record = null; log = []; deliveries = {}; slow = null; for (const s of streams) s.res.end(); streams.clear() }
const emit = (action, rec) => {
    const msg = JSON.stringify({ events: [`presences.${rec.$id}.${action}`, `presences.${action}`, 'presences'], payload: rec })
    for (const s of streams) { s.res.write(`data: ${msg}\n\n`); deliveries[s.tab] = (deliveries[s.tab] || 0) + 1 }
}
const writes = (from = 0) => log.slice(from).filter(e => e.op === 'upsert')

const MOCK = `
window.__flushes = 0;
class Client { constructor() { this.config = { endpoint: 'http://mock/v1', project: 'p' }; this.headers = {} } }
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tab: window.__tab, ...body }) }).then(r => r.json());
window.Appwrite = {
    Client,
    Presences: class {
        async list() { return fetch('/api/list').then(r => r.json()) }
        async upsert(args) { return post('/api/upsert', args) }
        async delete(args) { return post('/api/delete', args) }
    },
    Realtime: class {
        subscribe(channel, cb) {
            const es = new EventSource('/api/sse?tab=' + window.__tab);
            es.onmessage = e => cb(JSON.parse(e.data));
            return Promise.resolve({ unsubscribe: () => es.close() });
        }
    },
    Channel: { presences: () => 'presences' },
    Permission: { read: r => 'read("' + r + '")', update: r => 'update("' + r + '")', delete: r => 'delete("' + r + '")' },
    Role: { user: id => 'user:' + id, team: id => 'team:' + id, users: () => 'users' },
};
const client = new Client();
window.ManifestAppwriteAuthConfig = {
    getAppwriteClient: async () => ({ client }),
    getAppwriteConfig: async () => ({ teams: false }),
    ensureManifest: async () => ({ appwrite: { presences: { scope: 'global' } } }),
};
document.addEventListener('alpine:init', () => {
    Alpine.store('auth', { user: { $id: 'me', name: 'Me' }, currentTeam: null, teams: [] });
});
`
// Registered after the plugin's alpine:init, so the store exists: counts reactive roster flushes
const COUNTER = `document.addEventListener('alpine:init', () => {
    Alpine.effect(() => { Alpine.store('presence').records; window.__flushes++ });
});`

const html = tab => `<!doctype html><html><head>
<script>window.__tab = ${JSON.stringify(tab)};</script>
<script>${MOCK}</script>
<script>${PLUGIN}</script>
<script>${COUNTER}</script>
<script>${ALPINE}</script>
</head><body><p>tab ${tab}</p></body></html>`

const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c }); req.on('end', () => r(b ? JSON.parse(b) : {})) })
const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/tab') { res.setHeader('content-type', 'text/html'); return res.end(html(u.searchParams.get('id'))) }
    if (u.pathname === '/blank') return res.end('<!doctype html><p>other</p>')
    if (u.pathname === '/api/list') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ presences: record ? [record] : [] })) }
    if (u.pathname === '/api/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        res.write(': open\n\n')
        const s = { tab: u.searchParams.get('tab'), res }
        streams.add(s)
        req.on('close', () => streams.delete(s))
        return
    }
    if (u.pathname === '/api/upsert' && req.method === 'POST') {
        const b = await readBody(req)
        record = { $id: b.presenceId, userId: b.presenceId, status: b.status, metadata: b.metadata, $permissions: b.permissions, $updatedAt: new Date().toISOString() }
        log.push({ op: 'upsert', tab: b.tab, status: b.status, t: Date.now() })
        emit('upsert', record)
        if (slow && slow.tab === b.tab) await sleep(slow.ms)
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(record))
    }
    if (u.pathname === '/api/delete' && req.method === 'POST') {
        const b = await readBody(req)
        log.push({ op: 'delete', tab: b.tab, t: Date.now() })
        if (record) emit('delete', record)
        record = null
        res.setHeader('content-type', 'application/json'); return res.end('{}')
    }
    // Other users' burst: n upserts in one tick
    if (u.pathname === '/api/burst') {
        const n = +u.searchParams.get('n') || 20
        for (let i = 0; i < n; i++) emit('upsert', { $id: 'u' + i, userId: 'u' + i, status: 'online', $permissions: ['read("users")'], $updatedAt: new Date().toISOString() })
        return res.end('{}')
    }
    res.writeHead(404); res.end()
})
await new Promise(r => server.listen(0, r))
const BASE = `http://localhost:${server.address().port}`

const errors = []
async function openTabs(browser, ids, startOpts) {
    const pages = {}
    for (const id of ids) {
        const p = await browser.newPage()
        p.on('pageerror', e => errors.push(`${id}: ${e.message}`))
        await p.goto(`${BASE}/tab?id=${id}`, { waitUntil: 'load' })
        await p.evaluate(o => window.ManifestPresence.start(o), startOpts)
        pages[id] = p
    }
    return pages
}
const leaders = async pages => {
    const out = []
    for (const [id, p] of Object.entries(pages)) { try { if (await p.evaluate(() => window.ManifestPresence.leader)) out.push(id) } catch (e) { } }
    return out
}
const flushes = async pages => Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([id, p]) => [id, await p.evaluate(() => window.__flushes)])))
const sum = o => Object.values(o).reduce((a, b) => a + b, 0)
const byTab = list => list.reduce((m, e) => (m[e.tab] = (m[e.tab] || 0) + 1, m), {})
async function waitFor(fn, ms = 5000, step = 20) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (await fn()) return Date.now() - t0; await sleep(step) }
    return -1
}

const N = 5
const TABS = Array.from({ length: N }, (_, i) => 'T' + i)
// Production cadences scaled 25x down: old heartbeat 25 s → 1 s, new keep-alive 300 s → 12 s
const WINDOW = 24000
const KEEP = BASELINE ? { heartbeatMs: 1000 } : { keepAliveMs: 12000 }

// Load: writes and deliveries over a fixed window, then a burst from other users
{
    reset()
    const browser = await puppeteer.launch({ headless: true })
    const pages = await openTabs(browser, TABS, KEEP)
    await sleep(500)
    const w0 = log.length
    const d0 = { ...deliveries }
    await sleep(WINDOW)
    const w = writes(w0)
    const del = Object.fromEntries(Object.entries(deliveries).map(([k, v]) => [k, v - (d0[k] || 0)]))
    const perHourWrites = Math.round(w.length * 3600000 / WINDOW / 25)
    const f0 = await flushes(pages)
    await fetch(`${BASE}/api/burst?n=50`)
    await sleep(1000)
    const f1 = await flushes(pages)
    const burst = Object.fromEntries(Object.keys(f1).map(k => [k, f1[k] - f0[k]]))
    const result = {
        plugin: BASELINE ? 'baseline' : 'current', tabs: N, windowMs: WINDOW,
        writes: w.length, writesByTab: byTab(w), deliveries: sum(del), deliveriesByTab: del,
        writesPerHourAtProductionCadence: perHourWrites,
        burst50FlushesByTab: burst, burst50Flushes: sum(burst),
    }
    console.log('LOAD', JSON.stringify(result))
    if (!BASELINE) {
        check('only one tab writes', Object.keys(byTab(w)).length === 1, byTab(w))
        check('exactly one leader', (await leaders(pages)).length === 1, await leaders(pages))
        check('keep-alive cadence, not a 25 s beat (≤3 writes in 24 s at 12 s keep-alive)', w.length >= 1 && w.length <= 3, w.length)
        check('only the leader receives realtime deliveries', Object.keys(del).filter(k => del[k] > 0).length <= 1, del)
        check('a 50-event burst flushes each tab at most twice', Object.values(burst).every(n => n <= 2), burst)
        const rosters = await Promise.all(Object.values(pages).map(p => p.evaluate(() => Object.keys(window.Alpine.store('presence').records).length)))
        check('every tab holds the full roster (50 others + me)', rosters.every(n => n === 51), rosters)
    }
    await browser.close()
}

if (!BASELINE) {
    // Re-election: close the leader, then freeze the next one
    {
        reset()
        const browser = await puppeteer.launch({ headless: true })
        const pages = await openTabs(browser, ['A', 'B', 'C'], { keepAliveMs: 60000 })
        await sleep(300)
        const [first] = await leaders(pages)
        check('first tab leads', first === 'A', first)
        const mark = log.length
        await pages[first].close()
        delete pages[first]
        const closeMs = await waitFor(async () => (await leaders(pages)).length === 1, 3000)
        check('closing the leader re-elects within 1 s', closeMs >= 0 && closeMs < 1000, closeMs)
        await sleep(1500)
        check('handover deletes nothing (no offline flicker)', !log.slice(mark).some(e => e.op === 'delete') && record?.status === 'online', log.slice(mark))
        check('the new leader rewrites once (the row may have been deleted)', writes(mark).length === 1 && writes(mark)[0].status === 'online', writes(mark))

        // A predecessor deleted the row (thought it was alone): the promoted tab restores it
        {
            const [cur] = await leaders(pages)
            record = null
            const m = log.length
            await pages[cur].close()
            delete pages[cur]
            const back = await waitFor(() => record?.status === 'online', 2000)
            check('promoted leader rewrites a deleted row within 1 s', back >= 0 && back < 1000, { back, log: log.slice(m) })
            const p = await browser.newPage()
            p.on('pageerror', e => errors.push(`D: ${e.message}`))
            await p.goto(`${BASE}/tab?id=D`, { waitUntil: 'load' })
            await p.evaluate(() => window.ManifestPresence.start({ keepAliveMs: 60000 }))
            pages.D = p
            await sleep(300)
        }

        const [second] = await leaders(pages)
        const cdp = await pages[second].createCDPSession()
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
        const rest = Object.fromEntries(Object.entries(pages).filter(([k]) => k !== second))
        const freezeMs = await waitFor(async () => (await leaders(rest)).length === 1, 3000)
        check('freezing the leader re-elects within 1 s', freezeMs >= 0 && freezeMs < 1000, freezeMs)
        await cdp.send('Page.setWebLifecycleState', { state: 'active' })
        await sleep(500)
        check('one leader after the frozen tab resumes', (await leaders(pages)).length === 1, await leaders(pages))

        // Last tab out removes the record
        for (const p of Object.values(pages)) await p.close()
        await waitFor(() => record === null, 2000)
        check('closing the last tab deletes the record', record === null, record)
        await browser.close()
    }

    // Follower clear(): deleted from the calling tab before it resolves; nobody rewrites
    {
        reset()
        const browser = await puppeteer.launch({ headless: true })
        const pages = await openTabs(browser, ['A', 'B'], { keepAliveMs: 60000 })
        await sleep(300)
        const m = log.length
        const resolvedAfterDelete = await pages.B.evaluate(async () => { await window.ManifestPresence.clear(); return true })
        const del = log.slice(m).filter(e => e.op === 'delete')
        check('follower clear() resolves after its own delete', resolvedAfterDelete && del.length >= 1 && del[0].tab === 'B' && record === null, log.slice(m))
        await sleep(1500)
        check('the leader does not rewrite a cleared row', record === null && writes(m).length === 0, log.slice(m))
        const mes = await Promise.all(Object.values(pages).map(p => p.evaluate(() => window.Alpine.store('presence').me)))
        check('cleared in every tab', mes.every(x => x === null), mes)
        await browser.close()
    }

    // Suspended leader (Safari has no freeze event): followers take over
    {
        reset()
        const browser = await puppeteer.launch({ headless: true })
        const pages = await openTabs(browser, ['A', 'B', 'C'], { keepAliveMs: 2000 })
        await sleep(300)
        const cdp = await pages.A.createCDPSession()
        await cdp.send('Debugger.enable')
        await cdp.send('Debugger.pause')
        const m = log.length
        await pages.B.evaluate(() => window.ManifestPresence.set('busy'))
        const busyMs = await waitFor(() => record?.status === 'busy', 5000)
        const w = writes(m).filter(e => e.status === 'busy')
        check('set() against a suspended leader lands within 3 s via takeover', busyMs >= 0 && busyMs < 3000 && w.length >= 1 && w[0].tab !== 'A', { busyMs, w })
        const rest = { B: pages.B, C: pages.C }
        check('one leader among the live tabs', (await leaders(rest)).length === 1, await leaders(rest))
        await cdp.send('Debugger.resume')
        await sleep(800)
        check('the resumed tab steps down: still one leader', (await leaders(pages)).length === 1, await leaders(pages))
        // Idle watchdog: suspend the current leader, nobody calls set()
        const [cur] = await leaders(pages)
        const cdp2 = await pages[cur].createCDPSession()
        await cdp2.send('Debugger.enable')
        await cdp2.send('Debugger.pause')
        const others = Object.fromEntries(Object.entries(pages).filter(([k]) => k !== cur))
        const idleMs = await waitFor(async () => (await leaders(others)).length === 1, 6000, 100)
        check('watchdog takes over from an idle suspended leader within keep-alive + grace', idleMs >= 0 && idleMs < 4500, idleMs)
        await cdp2.send('Debugger.resume')
        await browser.close()
    }

    // No-op sets never move leadership (Playcom: start({status}) + set(status) in every tab)
    {
        reset()
        const browser = await puppeteer.launch({ headless: true })
        const pages = await openTabs(browser, ['A', 'B', 'C'], { auto: false, status: 'available', keepAliveMs: 60000 })
        await sleep(300)
        for (const p of Object.values(pages)) await p.evaluate(() => window.ManifestPresence.set('available'))
        await sleep(3000)
        check('every tab start({status}) + same set(): one leader, unchanged', JSON.stringify(await leaders(pages)) === '["A"]', await leaders(pages))
        check('…and one write in total', writes().length === 1 && writes()[0].tab === 'A', writes())
        await browser.close()
    }
    {
        reset()
        const browser = await puppeteer.launch({ headless: true })
        const pages = await openTabs(browser, ['A', 'B'], { keepAliveMs: 60000 })
        const other = await browser.newPage()
        await other.goto(`${BASE}/blank`)
        await other.bringToFront()
        await waitFor(() => record?.status === 'away', 4000)
        const m = log.length
        await pages.B.evaluate(() => window.ManifestPresence.set('busy'))
        await sleep(3000)
        check('a status change while every tab is hidden is acked: no takeover, no write', JSON.stringify(await leaders(pages)) === '["A"]' && writes(m).length === 0, { leaders: await leaders(pages), w: writes(m) })
        await pages.B.bringToFront()
        await waitFor(() => record?.status === 'busy', 2000)
        check('…and lands from the leader once a tab is visible', record?.status === 'busy' && writes(m).length === 1 && writes(m)[0].tab === 'A', writes(m))
        await browser.close()
    }

    // A demoted leader never finishes a queued write
    {
        reset()
        const browser = await puppeteer.launch({ headless: true })
        const pages = await openTabs(browser, ['A', 'B'], { keepAliveMs: 60000 })
        await sleep(300)
        slow = { tab: 'A', ms: 4000 }
        // A: one write in flight (response held 4 s), a second queued behind it
        await pages.A.evaluate(() => { window.ManifestPresence.set('one'); window.ManifestPresence.set('two') })
        await sleep(100)
        const cdp = await pages.A.createCDPSession()
        await cdp.send('Debugger.enable')
        await cdp.send('Debugger.pause')
        await pages.B.evaluate(() => window.ManifestPresence.set('three'))
        await waitFor(() => record?.status === 'three', 5000)
        const m = log.length
        await cdp.send('Debugger.resume')
        await sleep(5000)
        check('the stolen-from tab writes nothing after the takeover', writes(m).filter(e => e.tab === 'A').length === 0 && record?.status === 'three', log.slice(m))
        check('one leader: B', JSON.stringify(await leaders(pages)) === '["B"]', await leaders(pages))
        await browser.close()
    }

    // Most-active tab: hidden tabs never mark away while one is visible
    {
        reset()
        const browser = await puppeteer.launch({ headless: true })
        const pages = await openTabs(browser, ['A', 'B', 'C'], { keepAliveMs: 60000 })
        const other = await browser.newPage()
        await other.goto(`${BASE}/blank`)
        await pages.B.bringToFront()
        await sleep(1800)
        const vis = await Promise.all(Object.values(pages).map(p => p.evaluate(() => document.visibilityState)))
        check('leader A hidden, B visible', vis.join() === 'hidden,visible,hidden', vis)
        check('status stays online while one tab is visible', record?.status === 'online' && !log.some(e => e.status === 'away'), { status: record?.status, log: log.map(e => e.status || e.op) })
        const mark = log.length
        await other.bringToFront()
        const awayMs = await waitFor(() => record?.status === 'away', 4000)
        check('every tab hidden → away (after the settle debounce)', awayMs >= 0, record?.status)
        const awayWrites = writes(mark).length
        await pages.C.bringToFront()
        const backMs = await waitFor(() => record?.status === 'online', 2000)
        check('a tab visible again → online fast', backMs >= 0 && backMs < 1000, backMs)
        check('away + back = two writes', writes(mark).length === 2 && awayWrites === 1, log.slice(mark))
        // Tab switch inside the browser: no away blip
        const m2 = log.length
        await pages.A.bringToFront()
        await sleep(300)
        await pages.B.bringToFront()
        await sleep(1800)
        check('switching tabs writes nothing', log.length === m2, log.slice(m2))
        // set() from a follower lands browser-wide through the leader
        await pages.C.evaluate(() => window.ManifestPresence.set('busy', { page: 'x' }))
        const setMs = await waitFor(() => record?.status === 'busy', 2000)
        const mes = await Promise.all(Object.values(pages).map(p => p.evaluate(() => window.Alpine.store('presence').me)))
        check('follower set() is written once by the leader and mirrored to every tab', setMs >= 0 && writes(m2).length === 1 && writes(m2)[0].tab === 'A' && mes.every(m => m === 'busy'), { setMs, mes, w: writes(m2) })
        await browser.close()
    }
}

check('no page errors', errors.length === 0, errors)
server.close()
for (const s of streams) s.res.end()
if (failures.length) { console.log(`\n${failures.length} failure(s)`); process.exit(1) }
console.log('\nAll presence tab checks passed')
process.exit(0)
