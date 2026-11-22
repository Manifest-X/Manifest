// @vitest-environment happy-dom
/**
 * Inline storage mapping ({ appwriteBucketId, column }) with no bucket source:
 * direct $files(id), $files(getter) and row.$files all list the entry's files.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { isolateVm } from './helpers/vm-isolation.js'

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
    'shared/manifest.data.proxies.files.js',
    'shared/manifest.data.proxies.appwrite.js',
    'shared/manifest.data.proxies.magic.state.js',
    'shared/manifest.data.proxies.magic.core.js',
    'shared/manifest.data.proxies.magic.files.js',
    'shared/manifest.data.proxies.magic.upload.js',
    'shared/manifest.data.main.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
let iso = null

// Mapping key, Appwrite bucket id and column all differ so a mix-up fails
const BUCKET_ID = 'inline-bucket-id'
let wrongBuckets = []
let bucketCalls = 0
const inBucket = (bucket) => { bucketCalls++; if (bucket !== BUCKET_ID) wrongBuckets.push(bucket) }

afterEach(() => {
    iso?.release()
    iso = null
    const seen = wrongBuckets
    wrongBuckets = []
    bucketCalls = 0
    expect(seen).toEqual([])
})

async function load() {
    window.Alpine = Alpine
    Alpine.store('auth', { _initialized: true, isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, currentTeam: null, teams: [] })
    window.__manifestRenderReady = false
    const rows = [{ $id: 'p1', attachmentIds: ['a', 'c'] }]
    const files = [{ $id: 'a' }, { $id: 'b' }, { $id: 'c' }]
    window.ManifestDataAppwrite = {
        loadTableRows: async () => rows.map(r => JSON.parse(JSON.stringify(r))),
        listBucketFiles: async (bucket) => (inBucket(bucket), files).map(f => ({ ...f })),
        getTableRow: async (db, table, id) => JSON.parse(JSON.stringify(rows.find(r => r.$id === id))),
        _getAppwriteDataServices: async () => ({ storage: { listFiles: async (bucket) => (inBucket(bucket), { files: files.map(f => ({ ...f })) }) } }),
    }
    delete window.ManifestDataRealtime
    delete window.__manifestLoaded
    window.ManifestComponentsRegistry = {
        manifest: {
            appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db' },
            data: {
                projects: {
                    appwriteTableId: 'projects', appwriteDatabaseId: 'db',
                    storage: { attachments: { appwriteBucketId: BUCKET_ID, column: 'attachmentIds' } },
                },
            }
        }
    }

    iso = isolateVm()
    const ctx = {
        window, document, Alpine, console, ...iso.timers, clearTimeout, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        File: window.File, Blob: window.Blob, queueMicrotask,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
    await settle(200)
    await window.ManifestDataMain.loadDataSource('projects')
    await settle(60)
}

const filesOf = (source) => window.ManifestDataProxiesMagic.createFilesMethod(source)
const ids = (arr) => Array.from({ length: arr.length }, (_, i) => arr[i]?.$id)
const until = async (arr, n) => { for (let i = 0; i < 40 && arr.length !== n; i++) await settle(10) }

describe('table $files with an inline storage mapping', () => {
    it('direct $files(id) lists the entry\'s linked files', async () => {
        await load()
        const linked = filesOf('projects')('p1')
        await until(linked, 2)
        expect(linked.$loading).toBe(false)
        expect(linked.$error).toBe(null)
        expect(ids(linked)).toEqual(['a', 'c'])
        expect(bucketCalls).toBeGreaterThan(0)
    })

    it('$files(getter) lists the entry\'s linked files', async () => {
        await load()
        const linked = filesOf('projects')(() => 'p1')
        await until(linked, 2)
        expect(linked.$loading).toBe(false)
        expect(ids(linked)).toEqual(['a', 'c'])
        expect(bucketCalls).toBeGreaterThan(0)
    })

    it('row.$files lists the row\'s linked files', async () => {
        await load()
        const row = Alpine.store('data').projects.find(r => r.$id === 'p1')
        for (let i = 0; i < 40 && !row.$files?.length; i++) await settle(10)
        expect(row.$filesError).toBe(null)
        expect(ids(row.$files)).toEqual(['a', 'c'])
        expect(bucketCalls).toBeGreaterThan(0)
    })
})
