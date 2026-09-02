/**
 * manifest.sw.js against a fake ServiceWorkerGlobalScope: in-memory Cache API,
 * scripted fetch, captured respondWith/waitUntil. Covers every §13.3 caching
 * rule and every §13.4 fail-open guarantee.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CODE = readFileSync(path.join(__dirname, '../src/scripts/manifest.sw.js'), 'utf8')
const ORIGIN = 'https://app.example'

// ---- fake Cache API (insertion-ordered, put() re-appends like the spec) ----
const urlOf = (r) => typeof r === 'string' ? new URL(r, ORIGIN).href : r.url
const stripSearch = (u) => u.split('?')[0]
class FakeCache {
    constructor() { this.entries = [] }
    async match(req, opts = {}) {
        const url = urlOf(req)
        const hit = this.entries.find(e => opts.ignoreSearch ? stripSearch(e.key) === stripSearch(url) : e.key === url)
        return hit ? hit.response.clone() : undefined
    }
    async put(req, res) {
        const url = urlOf(req)
        this.entries = this.entries.filter(e => e.key !== url)
        this.entries.push({ key: url, response: res })
    }
    async delete(req) { const url = urlOf(req); const n = this.entries.length; this.entries = this.entries.filter(e => e.key !== url); return n !== this.entries.length }
    async keys() { return this.entries.map(e => new Request(e.key)) }
    urls() { return this.entries.map(e => e.key) }
}
function makeCaches() {
    const store = new Map()
    return {
        store,
        async open(name) { if (!store.has(name)) store.set(name, new FakeCache()); return store.get(name) },
        async keys() { return [...store.keys()] },
        async delete(name) { return store.delete(name) },
        async has(name) { return store.has(name) },
    }
}

// ---- fake scope ----
function makeScope({ href = `${ORIGIN}/sw.js?v=1.2.3&d=dep1`, manifest = null, precache = null, files = {} } = {}) {
    const listeners = {}
    const fetchLog = []
    const self = {
        location: new URL(href),
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
        registration: { unregister: vi.fn(async () => true) },
        skipWaiting: vi.fn(),
        clients: { claim: vi.fn(), matchAll: async () => [] },
    }
    const caches = makeCaches()
    let counter = 0
    const fetch = vi.fn(async (input, init) => {
        const url = typeof input === 'string' ? new URL(input, ORIGIN).href : input.url
        fetchLog.push({ url, input, init })
        const p = new URL(url).pathname
        if (p === '/manifest.json' && url.startsWith(ORIGIN)) {
            if (manifest === null) return new Response('nf', { status: 404 })
            return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } })
        }
        if (p === '/precache.json' && url.startsWith(ORIGIN)) {
            if (precache === null) return new Response('nf', { status: 404 })
            if (precache === 'throw') throw new TypeError('offline')
            return new Response(JSON.stringify(precache), { headers: { 'content-type': 'application/json' } })
        }
        const f = files[url] ?? files[p]
        if (f === 'throw') throw new TypeError('network down')
        if (typeof f === 'function') return f()
        if (f === undefined) return new Response('body:' + url + ':' + (++counter), { headers: { 'content-type': 'text/plain' } })
        return new Response(f, { headers: { 'content-type': 'text/plain' } })
    })
    const dispatch = (type, event) => { for (const fn of (listeners[type] || [])) fn(event) }
    const lifecycle = async (type) => {
        const waits = []
        dispatch(type, { waitUntil: (p) => waits.push(p) })
        await Promise.all(waits)
        await tick()
    }
    // Plain request objects: undici refuses mode 'navigate', and the worker only reads url/method/mode/destination/headers.
    const mkReq = (url, { method = 'GET', mode = 'no-cors', destination = '', headers = {} } = {}) =>
        ({ url: new URL(url, ORIGIN).href, method, mode, destination, headers: new Headers(headers) })
    const fetchEvent = async (url, opts) => {
        const request = mkReq(url, opts)
        const waits = []
        let responded = null
        dispatch('fetch', { request, respondWith: (p) => { responded = p }, waitUntil: (p) => waits.push(p) })
        const response = responded ? await responded : null
        return { response, waits, request, text: response ? await response.clone().text() : null, settle: () => Promise.all(waits) }
    }
    const message = async (data, source) => {
        const waits = []
        dispatch('message', { data, source, ports: [], waitUntil: (p) => waits.push(p) })
        await Promise.all(waits)
        await tick()
    }
    new Function('self', 'caches', 'fetch', CODE)(self, caches, fetch)
    return { self, caches, fetch, fetchLog, listeners, lifecycle, fetchEvent, message, mkReq }
}
const tick = () => new Promise(r => setTimeout(r, 0))
const fetchesTo = (scope, frag) => scope.fetchLog.filter(f => f.url.includes(frag)).length
const cacheNames = (scope) => [...scope.caches.store.keys()]

describe('registration & lifecycle', () => {
    it('exposes the module marker and registers all four handlers', () => {
        const s = makeScope()
        expect(s.self.__mnfstSw).toBeTruthy()
        expect(s.self.__mnfstSw.version).toBe('1.2.3')
        for (const t of ['install', 'activate', 'fetch', 'message']) expect(s.listeners[t]?.length).toBe(1)
    })

    it('never calls skipWaiting or clients.claim (activate on next navigation)', async () => {
        const s = makeScope()
        await s.lifecycle('install'); await s.lifecycle('activate')
        expect(s.self.skipWaiting).not.toHaveBeenCalled()
        expect(s.self.clients.claim).not.toHaveBeenCalled()
        expect(s.self.registration.unregister).not.toHaveBeenCalled()
    })

    it('keys caches by version + deployment hash from manifest.json when present', async () => {
        const s = makeScope({ manifest: { deployment: 'fromjson' } })
        await s.lifecycle('install'); await s.lifecycle('activate')
        await s.fetchEvent('/app.css')
        expect(cacheNames(s)).toContain('mnfst-sw:1.2.3:fromjson:swr')
    })

    it('falls back to the registration URL query for the deployment hash', async () => {
        const s = makeScope()
        await s.lifecycle('install'); await s.lifecycle('activate')
        await s.fetchEvent('/app.css')
        expect(cacheNames(s)).toContain('mnfst-sw:1.2.3:dep1:swr')
    })

    it('reads the version from the registration URL when unstamped, and survives a restart via the meta cache', async () => {
        const s = makeScope({ href: `${ORIGIN}/sw.js?v=9.9.9&d=zz` })
        await s.lifecycle('install')
        const meta = await (await s.caches.open('mnfst-sw:meta')).match('/__meta')
        expect(await meta.json()).toEqual({ version: '9.9.9', deployment: 'zz' })
        // restart: new module instance, same caches, no install
        const s2 = makeScope({ href: `${ORIGIN}/sw.js` })
        s2.caches.store.set('mnfst-sw:meta', s.caches.store.get('mnfst-sw:meta'))
        await s2.fetchEvent('/app.css')
        expect(cacheNames(s2)).toContain('mnfst-sw:9.9.9:zz:swr')
        expect(fetchesTo(s2, 'manifest.json')).toBe(0)
    })

    it('prunes caches from other versions/deployments on activate, keeps meta and foreign caches', async () => {
        const s = makeScope()
        await s.caches.open('mnfst-sw:0.0.1:old:assets')
        await s.caches.open('mnfst-sw:1.2.3:otherdep:swr')
        await s.caches.open('mnfst-sw:1.2.3:dep1:assets')
        await s.caches.open('someone-else')
        await s.lifecycle('install'); await s.lifecycle('activate')
        const names = cacheNames(s)
        expect(names).not.toContain('mnfst-sw:0.0.1:old:assets')
        expect(names).not.toContain('mnfst-sw:1.2.3:otherdep:swr')
        expect(names).toContain('mnfst-sw:1.2.3:dep1:assets')
        expect(names).toContain('mnfst-sw:meta')
        expect(names).toContain('someone-else')
    })

    it('self-check: unregisters on activate when the module marker is gone', async () => {
        const s = makeScope()
        s.self.__mnfstSw = null
        await s.lifecycle('install'); await s.lifecycle('activate')
        expect(s.self.registration.unregister).toHaveBeenCalledTimes(1)
    })

    it('install tolerates an unreachable manifest.json', async () => {
        const s = makeScope({ files: { '/manifest.json': 'throw' } })
        s.fetch.mockImplementationOnce(async () => { throw new TypeError('offline') })
        await s.lifecycle('install'); await s.lifecycle('activate')
        await s.fetchEvent('/app.css')
        expect(cacheNames(s)).toContain('mnfst-sw:1.2.3:dep1:swr')
    })
})

describe('documents and manifest.json: network first', () => {
    it('serves navigations from the network and caches them for offline', async () => {
        const s = makeScope({ files: { '/': 'v1' } })
        const a = await s.fetchEvent('/', { mode: 'navigate', destination: 'document' })
        expect(a.text).toBe('v1')
        s.fetch.mockImplementation(async () => { throw new TypeError('offline') })
        const b = await s.fetchEvent('/', { mode: 'navigate', destination: 'document' })
        expect(b.text).toBe('v1')
    })

    it('a publish is visible on the next navigation (no cache read while online)', async () => {
        let body = 'old'
        const s = makeScope({ files: { '/index.html': () => new Response(body) } })
        await s.fetchEvent('/index.html', { mode: 'navigate', destination: 'document' })
        body = 'new'
        const r = await s.fetchEvent('/index.html', { mode: 'navigate', destination: 'document' })
        expect(r.text).toBe('new')
        expect(fetchesTo(s, '/index.html')).toBe(2)
    })

    it('offline deep link falls back to the cached shell', async () => {
        const s = makeScope({ files: { '/index.html': 'shell' } })
        await s.fetchEvent('/index.html', { mode: 'navigate', destination: 'document' })
        s.fetch.mockImplementation(async () => { throw new TypeError('offline') })
        const r = await s.fetchEvent('/some/route?x=1', { mode: 'navigate', destination: 'document' })
        expect(r.text).toBe('shell')
    })

    it('unstamped component fragments (*.html via fetch) are network first too', async () => {
        let body = 'c1'
        const s = makeScope({ files: { '/components/card.html': () => new Response(body) } })
        await s.fetchEvent('/components/card.html', { mode: 'cors' })
        body = 'c2'
        expect((await s.fetchEvent('/components/card.html', { mode: 'cors' })).text).toBe('c2')
    })

    it('manifest.json is network first with cache fallback', async () => {
        const s = makeScope({ manifest: { name: 'x' } })
        const a = await s.fetchEvent('/manifest.json', { mode: 'cors' })
        expect(JSON.parse(a.text).name).toBe('x')
        s.fetch.mockImplementation(async () => { throw new TypeError('offline') })
        const b = await s.fetchEvent('/manifest.json', { mode: 'cors' })
        expect(JSON.parse(b.text).name).toBe('x')
    })

    it('an offline miss rejects (pass-through semantics) rather than fabricating a page', async () => {
        const s = makeScope()
        s.fetch.mockImplementation(async () => { throw new TypeError('offline') })
        const waits = []
        let p
        s.listeners.fetch[0]({ request: s.mkReq('/nothing', { mode: 'navigate', destination: 'document' }), respondWith: (x) => { p = x }, waitUntil: (w) => waits.push(w) })
        await expect(p).rejects.toThrow()
    })

    it('does not cache redirected or non-ok documents', async () => {
        const s = makeScope({ files: { '/gone': () => new Response('nf', { status: 404 }) } })
        await s.fetchEvent('/gone', { mode: 'navigate', destination: 'document' })
        const pages = await s.caches.open('mnfst-sw:1.2.3:dep1:pages')
        expect(pages.urls()).toEqual([])
    })
})

describe('content-addressed assets: cache first, immutable', () => {
    it('same-origin ?v= stamped URLs hit the network once', async () => {
        const s = makeScope()
        const a = await s.fetchEvent('/components/card.html?v=abc123', { mode: 'cors' })
        const b = await s.fetchEvent('/components/card.html?v=abc123', { mode: 'cors' })
        expect(a.text).toBe(b.text)
        expect(fetchesTo(s, 'card.html')).toBe(1)
        expect(cacheNames(s)).toContain('mnfst-sw:1.2.3:dep1:assets')
    })

    it('timestamp busters (t=) share one entry — the utilities compile refetch and dev reload', async () => {
        const s = makeScope()
        await s.fetchEvent('/styles/a.css?v=dep1&t=1700000000')
        await s.fetchEvent('/styles/a.css?v=dep1&t=1700000001')
        await s.fetchEvent('/styles/a.css?v=dep1?t=1700000002') // legacy malformed append
        await s.fetchEvent('/styles/a.css?v=dep1')
        expect(fetchesTo(s, '/styles/a.css')).toBe(1)
        const assets = await s.caches.open('mnfst-sw:1.2.3:dep1:assets')
        expect(assets.urls()).toEqual([`${ORIGIN}/styles/a.css?v=dep1`])
        await s.fetchEvent('/styles/b.css?t=1700000000')
        const b = await s.fetchEvent('/styles/b.css?t=1700000009')
        expect(b.waits.length).toBe(1)
        await b.settle()
        const swr = await s.caches.open('mnfst-sw:1.2.3:dep1:swr')
        expect(swr.urls()).toEqual([`${ORIGIN}/styles/b.css`])
    })

    it('a new stamp is a new entry (the stamp is the invalidation)', async () => {
        const s = makeScope()
        const a = await s.fetchEvent('/x.js?v=1')
        const b = await s.fetchEvent('/x.js?v=2')
        expect(a.text).not.toBe(b.text)
        expect(fetchesTo(s, '/x.js')).toBe(2)
    })

    it.each([
        'https://cdn.manifestx.dev/npm/mnfst@0.5.198/lib/manifest.min.js',
        'https://cdn.jsdelivr.net/npm/mnfst@0.5.198-next.4/lib/manifest.data.min.js',
        'https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js',
        'https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js',
        'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js',
        'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js',
        'https://unpkg.com/mnfst@0.5.198/lib/manifest.icons.js',
        'https://api.iconify.design/mdi.json?icons=home%2Cclose',
    ])('pinned framework URL is cache first: %s', async (url) => {
        const s = makeScope()
        await s.fetchEvent(url)
        await s.fetchEvent(url)
        expect(fetchesTo(s, new URL(url).pathname)).toBe(1)
        const assets = await s.caches.open('mnfst-sw:1.2.3:dep1:assets')
        expect(assets.urls()).toContain(url)
    })

    it('refetches no-cors script requests with CORS so only real 200s are cached', async () => {
        const s = makeScope()
        await s.fetchEvent('https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js', { mode: 'no-cors', destination: 'script' })
        const call = s.fetchLog.find(f => f.url.includes('alpinejs'))
        expect(call.input).toBeInstanceOf(Request)
        expect(call.input.mode).toBe('cors')
        expect(call.input.credentials).toBe('omit')
    })

    it('does not cache a CDN error response', async () => {
        const url = 'https://cdn.jsdelivr.net/npm/mnfst@0.5.198/lib/missing.min.js'
        const s = makeScope({ files: { [url]: () => new Response('nope', { status: 404 }) } })
        const r = await s.fetchEvent(url)
        expect(r.response.status).toBe(404)
        await s.fetchEvent(url)
        expect(fetchesTo(s, 'missing.min.js')).toBe(2)
    })
})

describe('other same-origin static assets: stale-while-revalidate', () => {
    it('miss → network; hit → cached copy now, revalidate in the background', async () => {
        let body = 'a1'
        const s = makeScope({ files: { '/scripts/app.js': () => new Response(body) } })
        const a = await s.fetchEvent('/scripts/app.js')
        expect(a.text).toBe('a1')
        expect(a.waits.length).toBe(0)
        body = 'a2'
        const b = await s.fetchEvent('/scripts/app.js')
        expect(b.text).toBe('a1')
        expect(b.waits.length).toBe(1)
        await b.settle()
        const c = await s.fetchEvent('/scripts/app.js')
        expect(c.text).toBe('a2')
        expect(fetchesTo(s, 'app.js')).toBe(3)
    })

    it('a failed revalidation keeps the cached copy', async () => {
        const s = makeScope({ files: { '/font.woff2': 'f1' } })
        await s.fetchEvent('/font.woff2')
        s.fetch.mockImplementation(async () => { throw new TypeError('offline') })
        const b = await s.fetchEvent('/font.woff2')
        expect(b.text).toBe('f1')
        await b.settle()
        expect((await s.fetchEvent('/font.woff2')).text).toBe('f1')
    })

    it('tag-pinned CDN URLs (mnfst@latest, alpinejs excepted) are stale-while-revalidate', async () => {
        const s = makeScope()
        for (const url of ['https://cdn.manifestx.dev/npm/mnfst@latest/lib/manifest.min.js', 'https://esm.run/d3-array@3', 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json']) {
            await s.fetchEvent(url, { mode: 'cors' })
            const b = await s.fetchEvent(url, { mode: 'cors' })
            expect(b.waits.length).toBe(1)
            await b.settle()
        }
        const swr = await s.caches.open('mnfst-sw:1.2.3:dep1:swr')
        expect(swr.urls().length).toBe(3)
    })

    it('caps the SWR cache at 200 entries, evicting the least recently refreshed', async () => {
        const s = makeScope()
        for (let i = 0; i < 200; i++) await s.fetchEvent(`/img/${i}.png`)
        const swr = await s.caches.open('mnfst-sw:1.2.3:dep1:swr')
        expect(swr.urls().length).toBe(200)
        const touch = await s.fetchEvent('/img/0.png') // hit → revalidate re-puts, moving it to the end
        await touch.settle()
        await s.fetchEvent('/img/200.png')
        expect(swr.urls().length).toBe(200)
        expect(swr.urls()).toContain(`${ORIGIN}/img/0.png`)
        expect(swr.urls()).not.toContain(`${ORIGIN}/img/1.png`)
        expect(swr.urls()).toContain(`${ORIGIN}/img/200.png`)
    })
})

describe('never intercepted', () => {
    it.each([
        ['POST', { url: '/data.json', method: 'POST' }],
        ['range request', { url: '/video.mp4', headers: { range: 'bytes=0-1' } }],
        ['event stream', { url: '/__mnfst_sse__', headers: { accept: 'text/event-stream' } }],
        ['Appwrite cloud', { url: 'https://cloud.appwrite.io/v1/account' }],
        ['same-origin /v1/ API', { url: '/v1/databases/x/documents' }],
        ['mnfst-run Appwrite proxy', { url: '/_appwrite/v1/account' }],
        ['mnfst-run AI relay', { url: '/_ai/chat' }],
        ['the stub itself', { url: '/sw.js' }],
        ['precache manifest', { url: '/precache.json' }],
        ['unknown cross-origin', { url: 'https://fonts.googleapis.com/css2?family=Inter' }],
        ['analytics', { url: 'https://plausible.io/api/event' }],
        ['same-origin extension-less path', { url: '/api/things' }],
        ['cross-origin navigation', { url: 'https://other.example/', mode: 'navigate', destination: 'document' }],
        ['CDN URL without a package pin', { url: 'https://cdn.jsdelivr.net/npm/' }],
        ['Iconify non-JSON', { url: 'https://api.iconify.design/mdi/home.svg' }],
        ['data: URL', { url: 'data:text/plain,hi' }],
    ])('%s passes through untouched', async (_name, { url, ...opts }) => {
        const s = makeScope()
        const r = await s.fetchEvent(url, opts)
        expect(r.response).toBeNull()
        expect(s.fetch).not.toHaveBeenCalled()
    })
})

describe('fail-open', () => {
    it('a handler exception degrades to a plain network fetch', async () => {
        const s = makeScope({ files: { '/x.js?v=1': 'plain' } })
        s.caches.open = async () => { throw new Error('storage broken') }
        const r = await s.fetchEvent('/x.js?v=1')
        expect(r.response.status).toBe(200)
        expect(s.fetch.mock.calls.at(-1)[0]).toBe(r.request)
    })

    it('a classifier exception leaves respondWith uncalled', async () => {
        const s = makeScope()
        const bad = { get url() { throw new Error('boom') }, method: 'GET', headers: new Headers() }
        let responded = false
        s.listeners.fetch[0]({ request: bad, respondWith: () => { responded = true }, waitUntil: () => { } })
        expect(responded).toBe(false)
    })

    it('a throwing respondWith does not escape the handler', () => {
        const s = makeScope()
        expect(() => s.listeners.fetch[0]({ request: s.mkReq('/a.css'), respondWith: () => { throw new Error('already responded') }, waitUntil: () => { } })).not.toThrow()
    })

    it('activate and install never reject even when storage throws', async () => {
        const s = makeScope()
        s.caches.keys = async () => { throw new Error('nope') }
        s.caches.open = async () => { throw new Error('nope') }
        await expect(s.lifecycle('install')).resolves.toBeUndefined()
        await expect(s.lifecycle('activate')).resolves.toBeUndefined()
    })
})

describe('precache.json warm-up', () => {
    const files = ['/index.html', '/components/card.html?v=dep1', '/scripts/app.js', '/v1/ignored', 'https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js']

    it('warms listed files into the right cache class after activation, tolerating failures', async () => {
        const s = makeScope({ precache: { deployment: 'dep1', files }, files: { '/scripts/app.js': 'throw' } })
        await s.lifecycle('install'); await s.lifecycle('activate')
        await tick(); await tick()
        const c = (cls) => s.caches.store.get('mnfst-sw:1.2.3:dep1:' + cls)?.urls() || []
        expect(c('pages')).toContain(`${ORIGIN}/index.html`)
        expect(c('assets')).toContain(`${ORIGIN}/components/card.html?v=dep1`)
        expect(c('assets')).toContain('https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js')
        expect(c('swr')).toEqual([])
        expect(fetchesTo(s, '/v1/ignored')).toBe(0)
    })

    it('does nothing without precache.json, when it is unreachable, or for another deployment', async () => {
        for (const precache of [null, 'throw', { deployment: 'other', files }]) {
            const s = makeScope({ precache })
            await s.lifecycle('install'); await s.lifecycle('activate')
            await tick(); await tick()
            expect(fetchesTo(s, '/index.html')).toBe(0)
        }
    })

    it('skips files already cached', async () => {
        const s = makeScope({ precache: { files: ['/scripts/app.js'] } })
        await s.fetchEvent('/scripts/app.js')
        await s.lifecycle('install'); await s.lifecycle('activate')
        await tick(); await tick()
        expect(fetchesTo(s, '/scripts/app.js')).toBe(1)
    })
})

describe('message API', () => {
    it('ping → pong, version → identity; other messages ignored', async () => {
        const s = makeScope()
        const source = { postMessage: vi.fn() }
        await s.message({ type: 'manifest:sw', action: 'ping' }, source)
        expect(source.postMessage).toHaveBeenCalledWith({ type: 'manifest:sw', action: 'pong' })
        await s.message({ type: 'manifest:sw', action: 'version' }, source)
        expect(source.postMessage).toHaveBeenLastCalledWith({ type: 'manifest:sw', action: 'version', version: '1.2.3', deployment: 'dep1', key: 'mnfst-sw:1.2.3:dep1:' })
        await s.message({ type: 'other' }, source)
        await s.message(null, source)
        expect(source.postMessage).toHaveBeenCalledTimes(2)
    })

    it('kill clears every Manifest cache and unregisters', async () => {
        const s = makeScope()
        await s.fetchEvent('/a.css')
        await s.fetchEvent('/b.js?v=1')
        await s.caches.open('someone-else')
        const source = { postMessage: vi.fn() }
        await s.message({ type: 'manifest:sw', action: 'kill' }, source)
        expect(cacheNames(s)).toEqual(['someone-else'])
        expect(s.self.registration.unregister).toHaveBeenCalledTimes(1)
        expect(source.postMessage).toHaveBeenCalledWith({ type: 'manifest:sw', action: 'killed' })
        // a killed worker neither intercepts nor writes again
        const r = await s.fetchEvent('/c.css')
        expect(r.response).toBeNull()
        expect(cacheNames(s)).toEqual(['someone-else'])
    })

    it('replies over a MessageChannel port when one is supplied', async () => {
        const s = makeScope()
        const port = { postMessage: vi.fn() }
        s.listeners.message[0]({ data: { type: 'manifest:sw', action: 'ping' }, source: null, ports: [port], waitUntil: () => { } })
        expect(port.postMessage).toHaveBeenCalledWith({ type: 'manifest:sw', action: 'pong' })
    })
})
